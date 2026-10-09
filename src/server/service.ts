import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { Annotation, AnnotationCapture, AnnotationCaptureInput, AnnotationInput, AnnotationTarget, Asset, BaseSceneSnapshot, BoardObject, BoardOperation, BoardState, CaptureResult, CaptureRetryResult, CaptureView, CaptureViewOperation, Claim, CompleteInput, ContentAnchor, Draft, DraftReferences, HostBinding, HtmlBundle, HtmlSurfaceReference, Project, ResolvedRequestReference, Run, RunIdentity, ScenePresentation, ScenePresentationOperation, SceneSource, ServiceIdentity, Session, SessionView, Task, TaskSnapshot } from '../shared/types.js';
import { bundleLimits, bundleMime, validBundlePath } from '../shared/html-bundle.js';
import { contentCapabilities, resolveContentKind } from '../shared/content-types.js';
import { annotationTarget, sameAnnotationTarget, rasterDimensions } from './annotation-capture.js';
import { generateRequirementText, referenceOrder } from '../shared/task-message.js';

type Row = Record<string, any>;
interface SceneSourceContext { source: SceneSource; snapshot: BaseSceneSnapshot; presentation: ScenePresentation; target?: AnnotationTarget; auxiliaryAssets?: Asset[] }
const sceneLifetimeMs = 10 * 60 * 1000;
export class ApiFailure extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) { super(message); }
}
const fail = (status: number, code: string, message: string, details?: unknown): never => { throw new ApiFailure(status, code, message, details); };
const now = () => new Date().toISOString();
const json = (value: unknown) => JSON.stringify(value);
const parse = <T>(value: string): T => JSON.parse(value) as T;
const text = (value: unknown, label: string, maximum = 100_000) => typeof value === 'string' && value.length <= maximum ? value : fail(400, 'invalid_input', `${label} must be text, up to ${maximum} characters.`);
const nonempty = (value: unknown, label: string, maximum = 100_000) => { const result = text(value, label, maximum).trim(); return result || fail(400, 'invalid_input', `${label} is required.`); };
const ids = (value: unknown, label: string): string[] => Array.isArray(value) && value.length <= 1000 && value.every((id) => typeof id === 'string' && id.length < 200) ? [...new Set(value)] : fail(400, 'invalid_input', `${label} must contain IDs.`);
const finite = (value: unknown, label: string): number => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1e9 ? value : fail(400, 'invalid_input', `${label} must be a finite number.`);
const validContentAnchor = (anchor: ContentAnchor, code: string) => {
  if (!anchor || !['visual', 'text'].includes(anchor.kind)) fail(400, code, 'Use a visual or text content anchor.');
  if (anchor.scroll) { finite(anchor.scroll.x, 'Scroll x'); finite(anchor.scroll.y, 'Scroll y'); }
  for (const key of ['quote', 'context', 'path'] as const) if (anchor[key] !== undefined) text(anchor[key], `Anchor ${key}`, 10_000);
  for (const key of ['start', 'end'] as const) if (anchor[key] !== undefined && (!Number.isSafeInteger(anchor[key]) || anchor[key]! < 0)) fail(400, code, 'Text offsets use positive integers.');
  if (anchor.end !== undefined && anchor.end < (anchor.start ?? 0)) fail(400, code, 'Text offsets follow their start.');
};
const draftReferences = (input: DraftReferences, requestText: string): DraftReferences => {
  const objectIds = ids(input?.objectIds, 'Object references'), taskIds = ids(input?.taskIds, 'Task references');
  if (objectIds.length !== input.objectIds.length || taskIds.length !== input.taskIds.length) fail(400, 'invalid_references', 'Each reference source appears once in its source list.');
  if (input.order !== undefined && (!Array.isArray(input.order) || input.order.length > 2000)) fail(400, 'invalid_references', 'Reference order must be a list.');
  const order = referenceOrder({ objectIds, taskIds, ...(input.order === undefined ? {} : { order: input.order }) });
  const seen = new Set<string>();
  let previousOffset = 0;
  for (const reference of order) {
    if (!reference || !['object', 'task'].includes(reference.kind) || typeof reference.id !== 'string' || !reference.id || reference.id.length >= 200) fail(400, 'invalid_references', 'References require a kind and stable ID.');
    const key = `${reference.kind}:${reference.id}`;
    if (!(reference.kind === 'object' ? objectIds : taskIds).includes(reference.id)) fail(400, 'invalid_references', 'Each reference occurrence points to a listed source.');
    const offset = reference.textOffset ?? requestText.length;
    if (reference.textOffset !== undefined && (!Number.isSafeInteger(reference.textOffset) || reference.textOffset < 0 || reference.textOffset > requestText.length)) fail(400, 'invalid_references', 'Reference positions use integer UTF-16 offsets within the request text.');
    if (offset > 0 && offset < requestText.length && requestText.charCodeAt(offset - 1) >= 0xD800 && requestText.charCodeAt(offset - 1) <= 0xDBFF && requestText.charCodeAt(offset) >= 0xDC00 && requestText.charCodeAt(offset) <= 0xDFFF) fail(400, 'invalid_references', 'Reference positions use complete Unicode code points.');
    if (offset < previousOffset) fail(400, 'invalid_references', 'References follow their positions in the request text.');
    previousOffset = offset;
    seen.add(key);
  }
  if (seen.size !== objectIds.length + taskIds.length) fail(400, 'invalid_references', 'Reference order contains every grouped identity.');
  return { objectIds, taskIds, order: order.map(({ kind, id, textOffset }) => ({ kind, id, ...(textOffset === undefined ? {} : { textOffset }) })) };
};
export const within = (root: string, path: string) => { const rel = relative(root, path); return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`)); };

export class CanvasService {
  readonly db: Database.Database;
  readonly root: string;
  readonly dataDir: string;
  readonly project: Project;
  private readonly instanceId = randomUUID();
  onChange: () => void = () => {};
  validateSurface: (owner: CaptureView & { objectId: string; assetId: string }, surface: HtmlSurfaceReference) => void = () => fail(409, 'surface_unavailable', 'Initialize the project HTML surface before presenting its frame.');
  retainSurface: (owner: CaptureView & { objectId: string; assetId: string }, surface: HtmlSurfaceReference) => void = () => {};
  releaseSurface: (owner: CaptureView & { objectId: string; assetId: string }, surface: HtmlSurfaceReference) => void = () => {};

  constructor(root: string) {
    mkdirSync(root, { recursive: true });
    this.root = realpathSync(root);
    const requestedData = resolve(this.root, '.acanvas');
    mkdirSync(requestedData, { recursive: true, mode: 0o700 });
    this.dataDir = realpathSync(requestedData);
    if (!within(this.root, this.dataDir)) fail(403, 'path_boundary', 'The project data directory must remain inside the project.');
    for (const folder of ['assets', 'outputs', 'tmp', 'evidence']) {
      const path = resolve(this.dataDir, folder);
      mkdirSync(path, { recursive: true, mode: 0o700 });
      if (!within(this.dataDir, realpathSync(path))) fail(403, 'path_boundary', 'Project storage must remain inside the data directory.');
    }
    const databasePath = resolve(this.dataDir, 'board.sqlite');
    try { if (!within(this.dataDir, realpathSync(databasePath))) fail(403, 'path_boundary', 'The project database must remain inside its data directory.'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    this.db = new Database(databasePath);
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL, view_json TEXT NOT NULL, consumer_id TEXT);
      CREATE TABLE IF NOT EXISTS host_bindings(host TEXT NOT NULL, thread_id TEXT NOT NULL, session_id TEXT NOT NULL REFERENCES sessions(id), PRIMARY KEY(host,thread_id));
      CREATE TABLE IF NOT EXISTS consumers(session_id TEXT NOT NULL REFERENCES sessions(id), id TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, retired_at TEXT, PRIMARY KEY(session_id,id));
      CREATE TABLE IF NOT EXISTS drafts(id TEXT PRIMARY KEY, session_id TEXT NOT NULL UNIQUE REFERENCES sessions(id), revision INTEGER NOT NULL DEFAULT 1, text TEXT NOT NULL, attachments_json TEXT NOT NULL, annotations_json TEXT NOT NULL, references_json TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS assets(id TEXT PRIMARY KEY, name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, kind TEXT NOT NULL, path TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, source_task_id TEXT, source_run_id TEXT);
      CREATE TABLE IF NOT EXISTS html_bundles(asset_id TEXT PRIMARY KEY REFERENCES assets(id), manifest_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS objects(id TEXT PRIMARY KEY, asset_id TEXT NOT NULL REFERENCES assets(id), x REAL NOT NULL, y REAL NOT NULL, width REAL NOT NULL, height REAL NOT NULL, version INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, source_task_id TEXT, source_run_id TEXT);
      CREATE TABLE IF NOT EXISTS annotations(id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), task_id TEXT NOT NULL, data_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), draft_id TEXT NOT NULL UNIQUE, sequence INTEGER NOT NULL, status TEXT NOT NULL, snapshot_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, current_run_id TEXT, reason TEXT, receipt_json TEXT, replies_json TEXT NOT NULL DEFAULT '[]', UNIQUE(session_id, sequence));
      CREATE TABLE IF NOT EXISTS task_edits(draft_id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), task_id TEXT NOT NULL REFERENCES tasks(id), previous_draft_json TEXT NOT NULL, state TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS annotation_captures(id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), draft_id TEXT NOT NULL, annotation_id TEXT NOT NULL, version INTEGER NOT NULL, asset_id TEXT NOT NULL UNIQUE, path TEXT NOT NULL UNIQUE, data_json TEXT NOT NULL, state TEXT NOT NULL, UNIQUE(session_id,draft_id,annotation_id,version));
      CREATE TABLE IF NOT EXISTS evidence_assets(asset_id TEXT PRIMARY KEY REFERENCES assets(id), session_id TEXT NOT NULL REFERENCES sessions(id), draft_id TEXT NOT NULL, capture_id TEXT NOT NULL UNIQUE REFERENCES annotation_captures(id));
      CREATE TABLE IF NOT EXISTS annotation_identities(session_id TEXT NOT NULL REFERENCES sessions(id), draft_id TEXT NOT NULL, annotation_id TEXT NOT NULL, data_json TEXT NOT NULL, PRIMARY KEY(session_id,draft_id,annotation_id));
      CREATE TABLE IF NOT EXISTS capture_retries(session_id TEXT NOT NULL REFERENCES sessions(id), draft_id TEXT NOT NULL, annotation_id TEXT NOT NULL, version INTEGER NOT NULL, next_version INTEGER NOT NULL, PRIMARY KEY(session_id,draft_id,annotation_id,version));
      CREATE TABLE IF NOT EXISTS capture_views(id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), document_id TEXT NOT NULL, generation INTEGER NOT NULL, active INTEGER NOT NULL, operation_seq INTEGER NOT NULL, last_operation_json TEXT, presented_json TEXT, presented_base_id TEXT, UNIQUE(session_id,document_id,generation));
      CREATE TABLE IF NOT EXISTS capture_scenes(id TEXT PRIMARY KEY, view_id TEXT NOT NULL REFERENCES capture_views(id), operation_seq INTEGER NOT NULL, expires_at INTEGER NOT NULL, data_json TEXT NOT NULL, UNIQUE(view_id,operation_seq));
      CREATE TABLE IF NOT EXISTS scene_sources(id TEXT PRIMARY KEY, view_id TEXT NOT NULL REFERENCES capture_views(id), operation_seq INTEGER NOT NULL, expires_at INTEGER NOT NULL, data_json TEXT NOT NULL, UNIQUE(view_id,operation_seq));
      CREATE TABLE IF NOT EXISTS annotation_sources(session_id TEXT NOT NULL REFERENCES sessions(id), draft_id TEXT NOT NULL, annotation_id TEXT NOT NULL, version INTEGER NOT NULL, data_json TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'bound', PRIMARY KEY(session_id,draft_id,annotation_id,version));
      CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), consumer_id TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, progress_json TEXT NOT NULL DEFAULT '[]', output_asset_ids_json TEXT NOT NULL DEFAULT '[]', recovery_resolution TEXT);
      CREATE TABLE IF NOT EXISTS late_results(id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), run_id TEXT NOT NULL REFERENCES runs(id), consumer_id TEXT NOT NULL, received_at TEXT NOT NULL, payload_json TEXT NOT NULL);
    `);
    if (!(this.db.pragma('table_info(drafts)') as Row[]).some((column) => column.name === 'revision')) this.db.exec('ALTER TABLE drafts ADD COLUMN revision INTEGER NOT NULL DEFAULT 1');
    if (!(this.db.pragma('table_info(annotation_sources)') as Row[]).some((column) => column.name === 'state')) this.db.exec("ALTER TABLE annotation_sources ADD COLUMN state TEXT NOT NULL DEFAULT 'bound'");
    if (!(this.db.pragma('table_info(drafts)') as Row[]).some((column) => column.name === 'editing_task_id')) this.db.exec('ALTER TABLE drafts ADD COLUMN editing_task_id TEXT REFERENCES tasks(id)');
    let projectId = this.db.prepare("SELECT value FROM metadata WHERE key='project_id'").get() as Row | undefined;
    if (!projectId) { this.db.prepare("INSERT INTO metadata(key,value) VALUES('project_id',?)").run(randomUUID()); projectId = this.db.prepare("SELECT value FROM metadata WHERE key='project_id'").get() as Row; }
    this.project = { id: projectId.value, name: basename(this.root), root: this.root };
    try { this.db.transaction(() => {
      const ownerRow = this.db.prepare("SELECT value FROM metadata WHERE key='active_service'").get() as Row | undefined;
      if (ownerRow) {
        const owner = parse<{ pid: number; instanceId: string }>(ownerRow.value);
        let active = true;
        try { process.kill(owner.pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') active = false; }
        if (active) fail(409, 'service_active', 'This project already has an active local service. Connect to its existing port.');
      }
      this.db.prepare("INSERT INTO metadata(key,value) VALUES('active_service',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(json({ pid: process.pid, instanceId: this.instanceId }));
      const time = now();
      this.db.prepare("UPDATE tasks SET status='interrupted',reason='The local service restarted. Review saved progress and external jobs before resuming.',updated_at=? WHERE status='running'").run(time);
      this.db.prepare("UPDATE runs SET status='interrupted',updated_at=? WHERE status='running'").run(time);
      this.db.prepare("UPDATE consumers SET status='retired',retired_at=? WHERE status='active'").run(time);
      this.db.prepare('UPDATE sessions SET consumer_id=NULL').run();
    }).immediate(); } catch (error) { this.db.close(); throw error; }
  }

  close() {
    this.db.prepare("DELETE FROM metadata WHERE key='active_service' AND value=?").run(json({ pid: process.pid, instanceId: this.instanceId }));
    this.db.close();
  }
  identity(): ServiceIdentity { return { pid: process.pid, instanceId: this.instanceId }; }
  private transaction<T>(operation: () => T): T { const value = this.db.transaction(operation).immediate(); this.onChange(); return value; }
  private sessionRow(id: string): Row { nonempty(id, 'Session ID', 200); return this.db.prepare('SELECT * FROM sessions WHERE id=?').get(id) as Row || fail(404, 'session_missing', 'Select a session belonging to this project.'); }
  private sessionFrom(row: Row): Session { return { id: row.id, name: row.name, createdAt: row.created_at, view: parse(row.view_json), consumerId: row.consumer_id }; }
  sessions(): Session[] { return (this.db.prepare('SELECT * FROM sessions ORDER BY created_at,id').all() as Row[]).map((row) => this.sessionFrom(row)); }
  session(id: string): Session { return this.sessionFrom(this.sessionRow(id)); }
  createSession(name: unknown): Session {
    return this.transaction(() => this.insertSession(nonempty(name, 'Session name', 200)));
  }
  private insertSession(name: string): Session {
    const id = randomUUID(), time = now();
    this.db.prepare('INSERT INTO sessions VALUES(?,?,?,?,NULL)').run(id, name, time, json({ x: 0, y: 0, zoom: 1, selectedObjectIds: [] }));
    this.newDraft(id);
    return this.session(id);
  }
  bindHost(input: { host?: unknown; threadId?: unknown; sessionId?: unknown }): HostBinding {
    const host = nonempty(input.host, 'Host', 200), threadId = nonempty(input.threadId, 'Thread ID', 200);
    const requested = input.sessionId === undefined ? undefined : nonempty(input.sessionId, 'Session ID', 200);
    return this.transaction(() => {
      const saved = this.db.prepare('SELECT session_id FROM host_bindings WHERE host=? AND thread_id=?').get(host, threadId) as Row | undefined;
      if (saved) {
        if (requested && requested !== saved.session_id) fail(409, 'host_binding_conflict', 'This host conversation is already connected to another task context.');
        return { host, threadId, sessionId: saved.session_id };
      }
      const sessionId = requested ? this.session(requested).id : this.insertSession(`${host} creative tasks`).id;
      this.db.prepare('INSERT INTO host_bindings(host,thread_id,session_id) VALUES(?,?,?)').run(host, threadId, sessionId);
      return { host, threadId, sessionId };
    });
  }
  private newDraft(sessionId: string): Draft {
    this.db.prepare('INSERT INTO drafts(id,session_id,revision,text,attachments_json,annotations_json,references_json,updated_at) VALUES(?,?,1,?,?,?,?,?)').run(randomUUID(), sessionId, '', '[]', '[]', json({ objectIds: [], taskIds: [] }), now());
    return this.draft(sessionId);
  }
  private captureViewFrom(row: Row): CaptureView { return { projectId: this.project.id, sessionId: row.session_id, documentId: row.document_id, viewId: row.id, viewGeneration: row.generation }; }
  private captureViewRow(sessionId: string, viewId: string, active = true): Row {
    this.sessionRow(sessionId); nonempty(viewId, 'Capture view ID', 200);
    const row = this.db.prepare('SELECT * FROM capture_views WHERE id=? AND session_id=?').get(viewId, sessionId) as Row | undefined;
    if (!row) fail(403, 'scene_scope', 'Use a capture view belonging to this project and session.');
    if (active && !row!.active) fail(409, 'scene_view_closed', 'Register the current document before presenting a scene.');
    return row!;
  }
  captureView(sessionId: string, viewId: string): CaptureView { return this.captureViewFrom(this.captureViewRow(sessionId, viewId)); }
  registerCaptureView(sessionId: string, input: { documentId: string }): CaptureView {
    return this.db.transaction(() => {
      this.sessionRow(sessionId); const documentId = nonempty(input?.documentId, 'Document ID', 200);
      const existing = this.db.prepare('SELECT * FROM capture_views WHERE session_id=? AND document_id=? AND active=1').get(sessionId, documentId) as Row | undefined;
      if (existing) return this.captureViewFrom(existing);
      const generation = (this.db.prepare('SELECT COALESCE(MAX(generation),0)+1 AS next FROM capture_views WHERE session_id=? AND document_id=?').get(sessionId, documentId) as Row).next;
      const id = randomUUID(); this.db.prepare('INSERT INTO capture_views VALUES(?,?,?,?,1,0,NULL,NULL,NULL)').run(id, sessionId, documentId, generation);
      return this.captureView(sessionId, id);
    }).immediate();
  }
  private viewOperation(sessionId: string, viewId: string, input: CaptureViewOperation): Row {
    const row = this.captureViewRow(sessionId, viewId);
    if (input?.documentId !== row.document_id || input.viewGeneration !== row.generation) fail(409, 'scene_view_conflict', 'Use the current document and view generation.');
    if (!Number.isSafeInteger(input.operationSeq) || input.operationSeq < 1) fail(400, 'invalid_scene', 'View operations use positive integer sequence numbers.');
    return row;
  }
  private advanceView(row: Row, input: CaptureViewOperation, operation: unknown) {
    if (input.operationSeq <= row.operation_seq) fail(409, 'scene_operation_conflict', 'Apply view operations in their document order.');
    this.db.prepare('UPDATE capture_views SET operation_seq=?,last_operation_json=? WHERE id=?').run(input.operationSeq, json(operation), row.id);
  }
  private pruneScenes(viewId: string) {
    const time = Date.now();
    this.db.prepare('DELETE FROM scene_sources WHERE view_id=? AND expires_at<?').run(viewId, time);
    this.db.prepare('DELETE FROM scene_sources WHERE id IN (SELECT id FROM scene_sources WHERE view_id=? ORDER BY operation_seq DESC LIMIT -1 OFFSET 8)').run(viewId);
    const candidates = `view_id=? AND id<>COALESCE((SELECT presented_base_id FROM capture_views WHERE id=?),'') AND id NOT IN (SELECT json_extract(data_json,'$.source.baseSceneId') FROM scene_sources WHERE view_id=?)`;
    this.db.prepare(`DELETE FROM capture_scenes WHERE ${candidates} AND expires_at<?`).run(viewId, viewId, viewId, time);
    this.db.prepare(`DELETE FROM capture_scenes WHERE id IN (SELECT id FROM capture_scenes WHERE ${candidates} ORDER BY operation_seq DESC LIMIT -1 OFFSET 8)`).run(viewId, viewId, viewId);
  }
  sceneSnapshot(sessionId: string, viewId: string, input: CaptureViewOperation): BaseSceneSnapshot {
    return this.db.transaction(() => {
      const row = this.viewOperation(sessionId, viewId, input); this.pruneScenes(viewId);
      const saved = this.db.prepare('SELECT data_json FROM capture_scenes WHERE view_id=? AND operation_seq=?').get(viewId, input.operationSeq) as Row | undefined;
      if (saved) return parse<BaseSceneSnapshot>(saved.data_json);
      this.advanceView(row, input, { kind: 'scene', input });
      const objects = this.objects();
      if (objects.length > 10_000) fail(413, 'scene_limit', 'Project scene delivery supports 10000 objects.');
      const assets = this.expandAssetIds([...new Set(objects.map(object => object.assetId))]).map(id => this.sharedAsset(id));
      const createdAt = now(), expiry = Date.now() + sceneLifetimeMs;
      const snapshot: BaseSceneSnapshot = { id: randomUUID(), view: this.captureViewFrom(row), operationSeq: input.operationSeq, createdAt, expiresAt: new Date(expiry).toISOString(), objects, assets };
      this.db.prepare('INSERT INTO capture_scenes VALUES(?,?,?,?,?)').run(snapshot.id, viewId, input.operationSeq, expiry, json(snapshot));
      this.pruneScenes(viewId); return snapshot;
    }).immediate();
  }
  private sceneSnapshotFor(row: Row, baseSceneId: string): BaseSceneSnapshot {
    const saved = this.db.prepare('SELECT * FROM capture_scenes WHERE id=? AND view_id=?').get(baseSceneId, row.id) as Row | undefined;
    if (!saved) fail(409, 'scene_source_missing', 'Present a scene delivered to this capture view.');
    const held = this.db.prepare("SELECT id FROM scene_sources WHERE view_id=? AND expires_at>=? AND json_extract(data_json,'$.source.baseSceneId')=?").get(row.id, Date.now(), baseSceneId);
    if (saved!.expires_at < Date.now() && row.presented_base_id !== baseSceneId && !held) fail(409, 'scene_source_expired', 'Load the current scene before presenting a new frame.');
    return parse<BaseSceneSnapshot>(saved!.data_json);
  }
  private validatePresentation(row: Row, value: ScenePresentation, snapshot: BaseSceneSnapshot): ScenePresentation {
    if (!value || value.documentId !== row.document_id || value.viewId !== row.id || value.baseSceneId !== snapshot.id || !Number.isSafeInteger(value.frameSeq) || value.frameSeq < 1) fail(400, 'invalid_scene', 'Present the current document, view and delivered scene.');
    const bounds = (value: any) => { if (!value || typeof value !== 'object') fail(400, 'invalid_scene', 'Presented layers require bounds.'); for (const key of ['x', 'y', 'width', 'height']) finite(value[key], `Scene ${key}`); if (value.width <= 0 || value.height <= 0) fail(400, 'invalid_scene', 'Presented bounds use positive dimensions.'); };
    bounds(value.cssViewport);
    if (!value.camera) fail(400, 'invalid_scene', 'Present the actual scene camera.');
    for (const key of ['x', 'y', 'zoom'] as const) finite(value.camera[key], `Camera ${key}`);
    if (value.camera.zoom <= 0 || !value.bitmap || !Number.isSafeInteger(value.bitmap.width) || !Number.isSafeInteger(value.bitmap.height) || value.bitmap.width < 1 || value.bitmap.height < 1 || value.bitmap.width * value.bitmap.height > 16_000_000) fail(400, 'invalid_scene', 'Present a positive camera scale and bitmap up to 16 million pixels.');
    if (!Array.isArray(value.layers) || value.layers.length > 10_000 || !Array.isArray(value.media) || value.media.length > value.layers.length) fail(400, 'invalid_scene', 'Present bounded layers and their media positions.');
    const seen = new Set<string>();
    for (const layer of value.layers) {
      const object = snapshot.objects.find(object => object.id === layer?.objectId) ?? fail(409, 'scene_object_conflict', 'Present each object using its delivered identity and version.');
      if (seen.has(object.id) || layer.objectVersion !== object.version || layer.assetId !== undefined && layer.assetId !== object.assetId) fail(409, 'scene_object_conflict', 'Present each object using its delivered identity and version.');
      seen.add(object.id); bounds(layer.worldBounds); bounds(layer.renderedBounds); if (layer.clipCSS) bounds(layer.clipCSS);
      if (layer.contentWorldBounds) { bounds(layer.contentWorldBounds); const inner = layer.contentWorldBounds, outer = layer.worldBounds; if (inner.x < outer.x - .000001 || inner.y < outer.y - .000001 || inner.x + inner.width > outer.x + outer.width + .000001 || inner.y + inner.height > outer.y + outer.height + .000001) fail(400, 'invalid_scene', 'Presented content bounds remain within their layer.'); }
      if (layer.contentAnchor) validContentAnchor(layer.contentAnchor, 'invalid_scene');
      if (!Number.isSafeInteger(layer.layer) || Math.abs(layer.layer) > 1e9) fail(400, 'invalid_scene', 'Presented layer order uses integers.');
      if (layer.surface) this.validateSurface({ ...this.captureViewFrom(row), objectId: object.id, assetId: object.assetId }, layer.surface);
    }
    const mediaIds = new Set<string>();
    for (const media of value.media) {
      const object = snapshot.objects.find(object => object.id === media?.objectId) ?? fail(400, 'invalid_scene', 'Media positions identify distinct presented objects.');
      if (!seen.has(object.id) || mediaIds.has(object.id)) fail(400, 'invalid_scene', 'Media positions identify distinct presented objects.');
      mediaIds.add(object.id);
      for (const key of ['selectedTime', 'playbackTime', 'presentedTime', 'representativeTime'] as const) if (media[key] !== undefined && finite(media[key], `Presented ${key}`) < 0) fail(400, 'invalid_scene', 'Media times use positive seconds.');
      if (media.timePrecision !== undefined && !['decoded-pts', 'rvfc-observed', 'playback-sampled'].includes(media.timePrecision) || media.frameIndex !== undefined && (!Number.isSafeInteger(media.frameIndex) || media.frameIndex < 0)) fail(400, 'invalid_scene', 'Media frames use an explicit time precision and nonnegative frame index.');
      if (media.selectedRange && (finite(media.selectedRange.start, 'Range start') < 0 || finite(media.selectedRange.end, 'Range end') < media.selectedRange.start)) fail(400, 'invalid_scene', 'Presented media ranges follow their start.');
      if (media.surfaceFrameSeq !== undefined && (!Number.isSafeInteger(media.surfaceFrameSeq) || media.surfaceFrameSeq < 1 || value.layers.find(layer => layer.objectId === object.id)?.surface?.frameSeq !== media.surfaceFrameSeq)) fail(400, 'invalid_scene', 'Presented surface media identifies its displayed frame.');
    }
    return structuredClone(value);
  }
  confirmScenePresentation(sessionId: string, viewId: string, input: ScenePresentationOperation): ScenePresentation {
    return this.db.transaction(() => {
      const row = this.viewOperation(sessionId, viewId, input), operation = { kind: 'presented', input };
      if (row.operation_seq === input.operationSeq && row.last_operation_json === json(operation)) return parse<ScenePresentation>(row.presented_json);
      if (!input.presentation) fail(400, 'invalid_scene', 'Confirm the presentation paired with the displayed pixels.');
      const snapshot = this.sceneSnapshotFor(row, input?.presentation?.baseSceneId);
      const presentation = this.validatePresentation(row, input.presentation, snapshot), prior = row.presented_json ? parse<ScenePresentation>(row.presented_json) : undefined;
      if (prior && presentation.frameSeq <= prior.frameSeq) fail(409, 'scene_frame_conflict', 'Confirm a newly displayed frame in presentation order.');
      this.advanceView(row, input, operation);
      this.db.prepare('UPDATE capture_views SET presented_json=?,presented_base_id=? WHERE id=?').run(json(presentation), snapshot.id, viewId);
      for (const layer of presentation.layers) if (layer.surface) this.retainSurface({ ...this.captureViewFrom(row), objectId: layer.objectId, assetId: snapshot.objects.find(object => object.id === layer.objectId)!.assetId }, layer.surface);
      const priorSnapshot = prior ? this.sceneSnapshotFor(row, prior.baseSceneId) : undefined;
      for (const layer of prior?.layers ?? []) if (layer.surface && !presentation.layers.some(next => next.objectId === layer.objectId && isDeepStrictEqual(next.surface, layer.surface))) this.releaseSurface({ ...this.captureViewFrom(row), objectId: layer.objectId, assetId: priorSnapshot!.objects.find(object => object.id === layer.objectId)!.assetId }, layer.surface);
      this.pruneScenes(viewId); return presentation;
    }).immediate();
  }
  holdScenePresentation(sessionId: string, viewId: string, input: ScenePresentationOperation): SceneSource {
    return this.db.transaction(() => {
      const row = this.viewOperation(sessionId, viewId, input); this.pruneScenes(viewId);
      const existing = this.db.prepare('SELECT data_json FROM scene_sources WHERE view_id=? AND operation_seq=?').get(viewId, input.operationSeq) as Row | undefined;
      if (existing) { const saved = parse<SceneSourceContext>(existing.data_json); if (!isDeepStrictEqual(saved.presentation, input.presentation)) fail(409, 'scene_operation_conflict', 'Replay the same Done presentation.'); return saved.source; }
      if (!row.presented_json || !isDeepStrictEqual(parse<ScenePresentation>(row.presented_json), input.presentation)) fail(409, 'scene_frame_conflict', 'Hold the frame confirmed as visible in this capture view.');
      const snapshot = this.sceneSnapshotFor(row, input.presentation.baseSceneId);
      for (const layer of input.presentation.layers) if (layer.surface) this.validateSurface({ ...this.captureViewFrom(row), objectId: layer.objectId, assetId: snapshot.objects.find(object => object.id === layer.objectId)!.assetId }, layer.surface);
      this.advanceView(row, input, { kind: 'hold', input });
      const source: SceneSource = { ...this.captureViewFrom(row), id: randomUUID(), baseSceneId: snapshot.id, frameSeq: input.presentation.frameSeq, operationSeq: input.operationSeq, sourceMode: 'scene-bitmap', createdAt: now() };
      this.db.prepare('INSERT INTO scene_sources VALUES(?,?,?,?,?)').run(source.id, viewId, input.operationSeq, Date.now() + sceneLifetimeMs, json({ source, snapshot, presentation: input.presentation } satisfies SceneSourceContext));
      this.pruneScenes(viewId); return source;
    }).immediate();
  }
  closeCaptureView(sessionId: string, viewId: string, input: CaptureViewOperation): { closed: true } {
    return this.db.transaction(() => {
      const row = this.captureViewRow(sessionId, viewId, false);
      if (!row.active && row.document_id === input.documentId && row.generation === input.viewGeneration && row.operation_seq === input.operationSeq && row.last_operation_json === json({ kind: 'close', input })) return { closed: true as const };
      this.viewOperation(sessionId, viewId, input); this.advanceView(row, input, { kind: 'close', input });
      this.retireCaptureViewRow(row);
      return { closed: true as const };
    }).immediate();
  }
  retireCaptureView(sessionId: string, viewId: string, identity: Pick<CaptureView, 'documentId' | 'viewGeneration'>): { closed: true } {
    return this.db.transaction(() => {
      const row = this.captureViewRow(sessionId, viewId, false);
      if (identity.documentId !== row.document_id || identity.viewGeneration !== row.generation) fail(409, 'scene_view_conflict', 'Use the current document and view generation.');
      if (row.active) this.retireCaptureViewRow(row);
      return { closed: true as const };
    }).immediate();
  }
  private retireCaptureViewRow(row: Row): void {
    const presented = row.presented_json ? parse<ScenePresentation>(row.presented_json) : undefined, snapshot = presented ? this.sceneSnapshotFor(row, presented.baseSceneId) : undefined;
    for (const layer of presented?.layers ?? []) if (layer.surface) this.releaseSurface({ ...this.captureViewFrom(row), objectId: layer.objectId, assetId: snapshot!.objects.find(object => object.id === layer.objectId)!.assetId }, layer.surface);
    this.db.prepare('UPDATE capture_views SET active=0,presented_json=NULL,presented_base_id=NULL WHERE id=?').run(row.id);
    this.db.prepare('DELETE FROM scene_sources WHERE view_id=?').run(row.id); this.db.prepare('DELETE FROM capture_scenes WHERE view_id=?').run(row.id);
  }
  private annotationSource(sessionId: string, draftId: string, annotation: AnnotationInput): SceneSourceContext | undefined {
    const row = annotation.captureState ? this.db.prepare('SELECT data_json,state FROM annotation_sources WHERE session_id=? AND draft_id=? AND annotation_id=? AND version=?').get(sessionId, draftId, annotation.id, annotation.captureState.version) as Row | undefined : undefined;
    if (!annotation.sceneSource) {
      if (row?.state === 'awaiting') {
        if (annotation.capture || annotation.captureState?.status !== 'incomplete' || !sameAnnotationTarget(parse<AnnotationTarget>(row.data_json), annotation)) fail(409, 'scene_source_conflict', 'Keep the saved target while its scene source is awaiting capture.');
        return;
      }
      if (annotation.capture?.sourceMode === 'scene-bitmap' || row) fail(409, 'scene_source_conflict', 'Keep the scene source saved with this annotation version.');
      return;
    }
    if (!row || row.state !== 'bound') fail(409, 'scene_source_missing', 'Save this annotation with a service-confirmed Done source.');
    const context = parse<SceneSourceContext>(row!.data_json);
    if (!isDeepStrictEqual(context.source, annotation.sceneSource) || !context.target || !sameAnnotationTarget(context.target, annotation)) fail(409, 'scene_source_conflict', 'Use the saved annotation source and target.');
    return context;
  }
  private sourceSnapshot(context: SceneSourceContext): TaskSnapshot { return { userRequest: { source: 'user_instruction', text: '' }, annotations: [], referenceContent: { source: 'reference_content', objects: context.snapshot.objects, assets: [...context.snapshot.assets, ...(context.auxiliaryAssets ?? [])], taskIds: [] } }; }
  private bindAnnotationSource(sessionId: string, draftId: string, annotation: AnnotationInput, prior?: SceneSourceContext): SceneSourceContext {
    const source = annotation.sceneSource!;
    let context = prior && isDeepStrictEqual(prior.source, source) ? structuredClone(prior) : undefined;
    if (!context) {
      if (this.db.prepare("SELECT version FROM annotation_sources WHERE session_id=? AND draft_id=? AND annotation_id=? AND version<>? AND state='bound' AND json_extract(data_json,'$.source.id')=?").get(sessionId, draftId, annotation.id, annotation.captureState!.version, source.id)) fail(409, 'scene_source_conflict', 'Hold a new displayed scene for this annotation version.');
      const view = this.captureViewRow(sessionId, source.viewId);
      const row = this.db.prepare('SELECT data_json,expires_at FROM scene_sources WHERE id=? AND view_id=?').get(source.id, view.id) as Row | undefined;
      if (!row) fail(409, 'scene_source_missing', 'Hold the displayed frame before saving this annotation.');
      if (row!.expires_at < Date.now()) fail(409, 'scene_source_expired', 'Hold a current displayed frame before saving this annotation.');
      context = parse<SceneSourceContext>(row!.data_json);
      if (!isDeepStrictEqual(context.source, source) || source.projectId !== this.project.id || source.sessionId !== sessionId) fail(403, 'scene_scope', 'Use the Done source belonging to this project, session and view.');
    }
    if (annotation.snapshotAssetId && !context.snapshot.assets.some(asset => asset.id === annotation.snapshotAssetId)) { const asset = this.sharedAsset(annotation.snapshotAssetId); this.assetPath(asset.id); context.auxiliaryAssets = [asset]; }
    const available = this.sourceSnapshot(context);
    for (const id of [...annotation.objectIds, ...(annotation.objectId ? [annotation.objectId] : [])]) if (!available.referenceContent.objects.some(object => object.id === id) || !context.presentation.layers.some(layer => layer.objectId === id)) fail(409, 'scene_object_conflict', 'Annotate an object delivered and presented in this scene.');
    if (annotation.assetId && !available.referenceContent.assets.some(asset => asset.id === annotation.assetId)) fail(409, 'scene_object_conflict', 'Annotate an asset delivered in this scene.');
    this.validateAnnotation(annotation, available); context.target = annotationTarget(annotation);
    this.db.prepare("INSERT INTO annotation_sources(session_id,draft_id,annotation_id,version,data_json,state) VALUES(?,?,?,?,?,'bound') ON CONFLICT(session_id,draft_id,annotation_id,version) DO UPDATE SET data_json=excluded.data_json,state='bound'").run(sessionId, draftId, annotation.id, annotation.captureState!.version, json(context));
    return context;
  }
  draft(sessionId: string): Draft {
    this.sessionRow(sessionId);
    const row = this.db.prepare('SELECT * FROM drafts WHERE session_id=?').get(sessionId) as Row;
    const annotations = parse<AnnotationInput[]>(row.annotations_json); for (const annotation of annotations) this.annotationSource(sessionId, row.id, annotation);
    return { ...(row.editing_task_id ? { editingTaskId: row.editing_task_id } : {}), id: row.id, sessionId, revision: row.revision, text: row.text, attachments: parse(row.attachments_json), annotations, references: draftReferences(parse(row.references_json), row.text), updatedAt: row.updated_at };
  }
  private assetFrom(row: Row): Asset { const bundle = this.db.prepare('SELECT manifest_json FROM html_bundles WHERE asset_id=?').get(row.id) as Row | undefined; const evidence = this.db.prepare('SELECT * FROM evidence_assets WHERE asset_id=?').get(row.id) as Row | undefined; return { ...(bundle ? { htmlBundle: parse<HtmlBundle>(bundle.manifest_json) } : {}), ...(evidence ? { evidence: { sessionId: evidence.session_id, draftId: evidence.draft_id, captureId: evidence.capture_id } } : {}), id: row.id, name: row.name, mime: row.mime, size: row.size, kind: row.kind, createdAt: row.created_at, ...(row.source_task_id ? { sourceTaskId: row.source_task_id, sourceRunId: row.source_run_id } : {}) }; }
  asset(id: string): Asset { nonempty(id, 'Asset ID', 200); const row = this.db.prepare('SELECT * FROM assets WHERE id=?').get(id) as Row; return row ? this.assetFrom(row) : fail(404, 'asset_missing', 'The referenced asset is unavailable.'); }
  assets(): Asset[] { return (this.db.prepare('SELECT * FROM assets ORDER BY created_at,id').all() as Row[]).map((row) => this.assetFrom(row)); }
  sharedAsset(id: string): Asset { const asset = this.asset(id); if (asset.evidence) fail(403, 'evidence_usage', 'Capture evidence belongs to its annotation.'); return asset; }
  readableAsset(id: string, sessionId?: string): Asset { const asset = this.asset(id); if (asset.evidence) { if (!sessionId || asset.evidence.sessionId !== sessionId) fail(403, 'evidence_scope', 'Read capture evidence in its session.'); this.sessionRow(sessionId!); } return asset; }
  registerHtmlBundle(input: HtmlBundle & { source?: { sessionId: string; taskId: string } & RunIdentity }): Asset {
    return this.transaction(() => {
      if (!input || !validBundlePath(input.entryPath) || !/\.html?$/i.test(input.entryPath) || !input.files || typeof input.files !== 'object' || Array.isArray(input.files)) fail(400, 'bundle_invalid', 'Choose an HTML entry and a relative resource mapping.');
      const files = Object.entries(input.files);
      if (!files.length || files.length > bundleLimits.files) fail(400, 'bundle_limit', 'HTML bundles support up to 128 files.');
      const entryId = Object.hasOwn(input.files, input.entryPath) ? input.files[input.entryPath] : '';
      const entry = this.sharedAsset(entryId);
      if (entry.sourceTaskId) {
        if (!input.source || input.source.taskId !== entry.sourceTaskId || input.source.runId !== entry.sourceRunId) fail(409, 'bundle_source', 'Output bundles require their task and execution identity.');
        this.requireCurrent(input.source!.sessionId, input.source!.taskId, input.source!);
      } else if (input.source) fail(409, 'bundle_source', 'The bundle entry does not belong to this task.');
      if (resolveContentKind(entry) !== 'html') fail(400, 'bundle_entry', 'The bundle entry must be HTML.');
      if (entry.htmlBundle || this.db.prepare('SELECT id FROM objects WHERE asset_id=?').get(entryId) || (this.db.prepare('SELECT snapshot_json FROM tasks').all() as Row[]).some(row => parse<TaskSnapshot>(row.snapshot_json).referenceContent.assets.some(asset => asset.id === entryId))) fail(409, 'bundle_immutable', 'Create a new HTML import before publishing its bundle.');
      let total = 0;
      for (const [path, id] of files) {
        if (!validBundlePath(path) || !bundleMime(path)) fail(400, 'bundle_path', 'Bundle files must use supported non-hidden relative paths.');
        const asset = this.sharedAsset(id); this.assetPath(id);
        if (asset.htmlBundle || asset.sourceTaskId !== entry.sourceTaskId || asset.sourceRunId !== entry.sourceRunId) fail(400, 'bundle_source', 'Bundle resources must belong to the same import source.');
        if (asset.size > bundleLimits.fileBytes || (total += asset.size) > bundleLimits.totalBytes) fail(413, 'bundle_limit', 'HTML bundles support 10 MiB per file and 32 MiB total.');
      }
      this.db.prepare('INSERT INTO html_bundles VALUES(?,?)').run(entryId, json({ entryPath: input.entryPath, files: input.files }));
      return this.asset(entryId);
    });
  }
  private expandAssetIds(input: string[]): string[] {
    return [...new Set(input.flatMap(id => { const asset = this.asset(id); return [id, ...Object.values(asset.htmlBundle?.files ?? {})]; }))];
  }
  assetPath(id: string): string {
    const row = this.db.prepare('SELECT path,size FROM assets WHERE id=?').get(id) as Row || fail(404, 'asset_missing', 'The asset is unavailable.');
    const path = resolve(this.dataDir, row.path);
    if (!within(this.dataDir, path)) fail(403, 'path_boundary', 'The asset path is outside project storage.');
    let actual: string;
    try { actual = realpathSync(path); } catch { return fail(404, 'asset_file_missing', 'The asset file is unavailable.'); }
    if (!within(this.dataDir, actual)) fail(403, 'path_boundary', 'The asset file is outside project storage.');
    const info = statSync(actual);
    if (!info.isFile() || info.size !== row.size) fail(409, 'asset_integrity', 'The asset file differs from its saved metadata.');
    return actual;
  }
  registerAsset(asset: Asset, relativePath: string, source?: { sessionId: string; taskId: string } & RunIdentity): Asset {
    let stale = false;
    this.transaction(() => {
      if (asset.evidence || within(resolve(this.dataDir, 'evidence'), resolve(this.dataDir, relativePath)) || this.db.prepare('SELECT id FROM annotation_captures WHERE asset_id=? OR path=?').get(asset.id, relativePath)) fail(403, 'evidence_usage', 'Register capture evidence through its capture operation.');
      if (source) {
        this.taskRow(source.sessionId, source.taskId);
        const run = this.runRow(source.runId);
        if (run.task_id !== source.taskId || run.consumer_id !== source.consumerId) fail(409, 'run_conflict', 'The output belongs to another execution attempt.');
        stale = !this.isCurrent(source.sessionId, source.taskId, source);
      }
      this.db.prepare('INSERT INTO assets VALUES(?,?,?,?,?,?,?,?,?)').run(asset.id, asset.name, asset.mime, asset.size, asset.kind, relativePath, asset.createdAt, source?.taskId ?? null, source?.runId ?? null);
      if (source) {
        const run = this.runRow(source.runId);
        const outputs = parse<string[]>(run.output_asset_ids_json);
        this.db.prepare('UPDATE runs SET output_asset_ids_json=?,updated_at=? WHERE id=?').run(json([...outputs, asset.id]), now(), source.runId);
        if (stale) this.recordLate(source.taskId, source, { action: 'asset_import', assetId: asset.id });
      }
    });
    if (stale) fail(409, 'stale_run', 'The output has been retained for review. Resume with the current execution attempt.', { assetId: asset.id });
    return this.asset(asset.id);
  }
  private objectFrom(row: Row): BoardObject { return { id: row.id, assetId: row.asset_id, type: this.asset(row.asset_id).kind, x: row.x, y: row.y, width: row.width, height: row.height, version: row.version, createdAt: row.created_at, updatedAt: row.updated_at, ...(row.source_task_id ? { sourceTaskId: row.source_task_id, sourceRunId: row.source_run_id } : {}) }; }
  object(id: string): BoardObject { nonempty(id, 'Object ID', 200); const row = this.db.prepare('SELECT * FROM objects WHERE id=?').get(id) as Row; return row ? this.objectFrom(row) : fail(404, 'object_missing', 'The referenced object is unavailable.'); }
  objects(): BoardObject[] { return (this.db.prepare('SELECT * FROM objects ORDER BY created_at,id').all() as Row[]).map((row) => this.objectFrom(row)); }
  annotations(): Annotation[] { return (this.db.prepare('SELECT data_json FROM annotations ORDER BY rowid').all() as Row[]).map((row) => parse(row.data_json)); }
  private validateAnnotation(value: AnnotationInput, source?: TaskSnapshot): AnnotationInput {
    if (!value || !['object', 'group', 'region'].includes(value.scope) || !['normalized', 'world'].includes(value.coordinateSpace)) fail(400, 'invalid_annotation', 'Annotation scope and coordinate space are required.');
    nonempty(value.id, 'Annotation ID', 200);
    nonempty(value.text, 'Annotation text');
    const objectIds = ids(value.objectIds, 'Annotation object IDs');
    for (const objectId of objectIds) if (!source?.referenceContent.objects.some(object => object.id === objectId)) this.object(objectId);
    if (value.objectId && !source?.referenceContent.objects.some(object => object.id === value.objectId)) this.object(value.objectId);
    if (value.assetId) this.sharedAsset(value.assetId);
    if (value.snapshotAssetId) this.sharedAsset(value.snapshotAssetId);
    if (!value.bounds || typeof value.bounds !== 'object') fail(400, 'invalid_annotation', 'Annotation bounds are required.');
    for (const key of ['x', 'y', 'width', 'height'] as const) finite(value.bounds[key], `Annotation ${key}`);
    if (value.geometry !== undefined && !['point', 'rect'].includes(value.geometry)) fail(400, 'invalid_annotation', 'Choose point or rect geometry.');
    if (value.captureState && value.geometry === 'point' ? value.bounds.width !== 0 || value.bounds.height !== 0 : value.bounds.width <= 0 || value.bounds.height <= 0) fail(400, 'invalid_annotation', 'Points use zero dimensions and regions use positive dimensions.');
    if (value.coordinateSpace === 'normalized' && (value.bounds.x < 0 || value.bounds.y < 0 || value.bounds.x + value.bounds.width > 1.000001 || value.bounds.y + value.bounds.height > 1.000001)) fail(400, 'invalid_annotation', 'Object annotations must fit within normalized object coordinates.');
    if (value.scope === 'object' && (!value.objectId || value.coordinateSpace !== 'normalized')) fail(400, 'invalid_annotation', 'Object annotations require an object and normalized coordinates.');
    if (value.scope === 'region' && value.coordinateSpace !== 'world') fail(400, 'invalid_annotation', 'Canvas regions require world coordinates.');
    if (value.scope === 'group' && (value.coordinateSpace !== 'world' || objectIds.length < 2 || value.objectId || value.assetId || value.timeStart !== undefined || value.timeEnd !== undefined || value.snapshotAssetId)) fail(400, 'invalid_annotation', 'A group annotation references two or more whole objects and a world display anchor.');
    if (value.timeStart !== undefined && finite(value.timeStart, 'Media time') < 0) fail(400, 'invalid_annotation', 'Media time must be positive.');
    if (value.timeEnd !== undefined && finite(value.timeEnd, 'Media end time') < (value.timeStart ?? 0)) fail(400, 'invalid_annotation', 'The media interval must follow its start time.');
    if (value.contentAnchor) validContentAnchor(value.contentAnchor, 'invalid_annotation');
    const preserved = source?.annotations.some(annotation => annotation.id === value.id && sameAnnotationTarget(annotation, value));
    const referenced = [...new Set([...objectIds, ...(value.objectId ? [value.objectId] : [])])].map(id => source?.referenceContent.objects.find(object => object.id === id) || this.object(id));
    const targetObject = referenced.find(object => object.id === value.objectId);
    const targetId = targetObject?.assetId ?? value.assetId;
    const target = targetId ? source?.referenceContent.assets.find(asset => asset.id === targetId) || this.asset(targetId) : undefined;
    const kind = resolveContentKind(target);
    if (!preserved) {
      if (!value.captureState && value.scope === 'object' && !contentCapabilities[kind].region && (value.bounds.x !== 0 || value.bounds.y !== 0 || value.bounds.width !== 1 || value.bounds.height !== 1)) fail(400, 'invalid_annotation', 'This content uses whole-file annotations.');
      if (!value.captureState && value.scope === 'region' && referenced.some(object => !contentCapabilities[resolveContentKind(source?.referenceContent.assets.find(asset => asset.id === object.assetId) || this.asset(object.assetId))].region)) fail(400, 'invalid_annotation', 'Canvas regions reference image or video content.');
      if ((value.timeStart !== undefined || value.timeEnd !== undefined) && (value.scope !== 'object' || !contentCapabilities[kind].time)) fail(400, 'invalid_annotation', 'Time annotations reference audio or video content.');
      if (value.timeEnd !== undefined && value.timeStart === undefined) fail(400, 'invalid_annotation', 'A media interval requires its start time.');
      if (kind === 'audio' && value.snapshotAssetId) fail(400, 'invalid_annotation', 'Audio annotations reference the original audio and its time.');
      if (value.scope === 'object' && value.assetId && targetObject?.assetId !== value.assetId) fail(400, 'invalid_annotation', 'The annotation asset must match its object.');
    }
    return structuredClone(value);
  }
  saveDraft(sessionId: string, input: Draft): Draft {
    return this.transaction(() => {
      const draft = this.draft(sessionId);
      if (input?.id !== draft.id || (input.sessionId && input.sessionId !== sessionId)) fail(409, 'draft_conflict', 'This draft has already been sent or replaced. Read the current draft.');
      if (!Number.isSafeInteger(input.revision) || input.revision !== draft.revision) fail(409, 'draft_revision_conflict', 'The saved draft changed. Review both versions before saving.', { currentRevision: draft.revision });
      if (input.editingTaskId !== draft.editingTaskId) fail(409, 'draft_conflict', 'The request editing target has changed. Read the current draft.');
      const requestText = text(input.text, 'Draft text');
      const source = draft.editingTaskId ? this.task(sessionId, draft.editingTaskId).snapshot : undefined;
      const attachments = ids(input.attachments, 'Attachments');
      attachments.forEach((id) => this.sharedAsset(id));
      if (!Array.isArray(input.annotations) || input.annotations.length > 1000) fail(400, 'invalid_annotation', 'Annotations must be a list.');
      const annotations = input.annotations.map((annotation) => {
        const identity = this.db.prepare('SELECT data_json FROM annotation_identities WHERE session_id=? AND draft_id=? AND annotation_id=?').get(sessionId, draft.id, annotation?.id) as Row | undefined;
        const prior = identity ? parse<AnnotationInput>(identity.data_json) : draft.annotations.find(value => value.id === annotation?.id);
        if (prior?.captureState && !annotation.captureState) fail(409, 'annotation_version_conflict', 'Keep the saved capture state when editing this annotation.');
        if (!annotation.captureState) { if (annotation.capture || annotation.sceneSource) fail(400, 'invalid_annotation', 'Capture records and scene sources require capture state.'); return this.validateAnnotation(annotation, source); }
        const state = annotation.captureState;
        if (!Number.isSafeInteger(state.version) || state.version < 1 || !['incomplete', 'complete'].includes(state.status)) fail(400, 'invalid_annotation', 'Capture state requires an integer version and completion status.');
        if (prior?.captureState) {
          if (json(state) !== json(prior.captureState) || json(annotation.capture) !== json(prior.capture)) fail(409, 'annotation_version_conflict', 'Use the capture state returned by the service.');
        } else if (state.version !== 1 || state.status !== 'incomplete' || state.captureId || annotation.capture) fail(409, 'annotation_version_conflict', 'New capture annotations start at version 1 and incomplete.');
        const previousSource = prior?.sceneSource ? this.annotationSource(sessionId, draft.id, prior) : undefined;
        const changedTarget = !!prior?.captureState && !sameAnnotationTarget(prior, annotation);
        const changedSource = !!prior?.captureState && !isDeepStrictEqual(prior.sceneSource, annotation.sceneSource);
        const sourceRow = prior?.captureState ? this.db.prepare('SELECT state FROM annotation_sources WHERE session_id=? AND draft_id=? AND annotation_id=? AND version=?').get(sessionId, draft.id, prior.id, prior.captureState.version) as Row | undefined : undefined;
        if (previousSource && !annotation.sceneSource && !changedTarget) fail(409, 'scene_source_conflict', 'Keep the saved scene source when editing this annotation.');
        const firstBinding = sourceRow?.state === 'awaiting' && !changedTarget && !!annotation.sceneSource;
        const changed = changedTarget || changedSource && !firstBinding;
        let managed: AnnotationInput = { ...structuredClone(annotation), captureState: changed ? { version: prior!.captureState!.version + 1, status: 'incomplete' } : structuredClone(prior?.captureState ?? state) };
        if (changed) delete managed.capture;
        if (changedTarget && (!annotation.sceneSource || isDeepStrictEqual(annotation.sceneSource, prior?.sceneSource))) delete managed.sceneSource;
        if (managed.sceneSource) {
          const context = this.bindAnnotationSource(sessionId, draft.id, managed, previousSource);
          managed = this.validateAnnotation(managed, this.sourceSnapshot(context));
        } else {
          const savedCapture = changedTarget ? undefined : prior?.capture;
          const validationSource = savedCapture ? { ...(source ?? { userRequest: { source: 'user_instruction' as const, text: '' }, annotations: [], referenceContent: { source: 'reference_content' as const, objects: [], assets: [], taskIds: [] } }), annotations: [prior!], referenceContent: { source: 'reference_content' as const, objects: savedCapture.scene.objects.map(value => value.object), assets: savedCapture.scene.assets, taskIds: [] } } : source;
          managed = this.validateAnnotation(managed, changedTarget ? undefined : validationSource);
          if (changedTarget && (previousSource || sourceRow)) this.db.prepare("INSERT INTO annotation_sources(session_id,draft_id,annotation_id,version,data_json,state) VALUES(?,?,?,?,?,'awaiting')").run(sessionId, draft.id, managed.id, managed.captureState!.version, json(annotationTarget(managed)));
        }
        this.db.prepare('INSERT INTO annotation_identities VALUES(?,?,?,?) ON CONFLICT(session_id,draft_id,annotation_id) DO UPDATE SET data_json=excluded.data_json').run(sessionId, draft.id, managed.id, json(managed));
        return managed;
      });
      if (new Set(annotations.map((annotation) => annotation.id)).size !== annotations.length) fail(400, 'invalid_annotation', 'Each annotation needs a distinct ID.');
      const references = draftReferences(input.references, requestText);
      references.objectIds.forEach((id) => { if (!draft.references.objectIds.includes(id)) this.object(id); });
      references.taskIds.forEach((id) => { const row = this.db.prepare('SELECT session_id FROM tasks WHERE id=?').get(id) as Row | undefined; if (!row) fail(404, 'task_missing', 'The referenced task is unavailable.'); if (row!.session_id !== sessionId && !draft.references.taskIds.includes(id)) fail(403, 'task_reference_scope', 'Add tasks from the current session. Saved historical references remain available.'); });
      const updated = this.db.prepare('UPDATE drafts SET text=?,attachments_json=?,annotations_json=?,references_json=?,updated_at=?,revision=revision+1 WHERE id=? AND revision=?').run(requestText, json(attachments), json(annotations), json(references), now(), draft.id, input.revision);
      if (updated.changes !== 1) fail(409, 'draft_revision_conflict', 'The saved draft changed. Review both versions before saving.');
      return this.draft(sessionId);
    });
  }
  private captureRow(sessionId: string, draftId: string, annotationId: string, version: number): Row {
    this.sessionRow(sessionId);
    if (!Number.isSafeInteger(version) || version < 1) fail(400, 'invalid_capture', 'Capture versions use positive integers.');
    return this.db.prepare('SELECT * FROM annotation_captures WHERE session_id=? AND draft_id=? AND annotation_id=? AND version=?').get(sessionId, draftId, annotationId, version) as Row || fail(404, 'capture_missing', 'Prepare this annotation capture first.');
  }
  private captureAnnotation(sessionId: string, draftId: string, annotationId: string, version: number): { draft: Draft; annotation: AnnotationInput } {
    const draft = this.draft(sessionId), annotation = draft.annotations.find(value => value.id === annotationId);
    if (draft.id !== draftId || !annotation?.captureState || annotation.captureState.version !== version) fail(409, 'capture_version_conflict', 'This capture belongs to another draft or annotation version.');
    this.annotationSource(sessionId, draftId, annotation!);
    return { draft, annotation: annotation! };
  }
  prepareCapture(sessionId: string, draftId: string, annotationId: string, version: number, input: AnnotationCaptureInput): CaptureResult {
    return this.transaction(() => {
      this.sessionRow(sessionId);
      const existing = this.db.prepare('SELECT * FROM annotation_captures WHERE session_id=? AND draft_id=? AND annotation_id=? AND version=?').get(sessionId, draftId, annotationId, version) as Row | undefined;
      if (existing) {
        const capture = parse<AnnotationCapture>(existing.data_json);
        const { id, sessionId: savedSession, draftId: savedDraft, annotationId: savedAnnotation, version: savedVersion, screenshotAssetId, source, ...savedInput } = capture;
        if (!input?.target?.bounds || !Array.isArray(input.target.objectIds) || !Array.isArray(input.scene?.objects) || !Array.isArray(input.scene?.assets)) fail(400, 'invalid_capture', 'Save the capture target and scene.');
        const replay = { ...input, target: annotationTarget(input.target), scene: { ...input.scene, objects: [...input.scene.objects].sort((a, b) => a.layer - b.layer || a.object.id.localeCompare(b.object.id)), assets: savedInput.scene.assets.map(asset => input.scene.assets.find(value => value.id === asset.id)) } };
        if (input.scene.assets.length !== savedInput.scene.assets.length || !isDeepStrictEqual(savedInput, replay)) fail(409, 'capture_conflict', 'This annotation version already has a prepared capture. Query its saved result.');
        if (existing.state !== 'committed') this.captureAnnotation(sessionId, draftId, annotationId, version);
        return { status: existing.state, capture, ...(this.draft(sessionId).id === draftId ? { draft: this.draft(sessionId) } : {}) };
      }
      const { annotation } = this.captureAnnotation(sessionId, draftId, annotationId, version);
      const sceneSource = this.annotationSource(sessionId, draftId, annotation);
      if (this.db.prepare("SELECT version FROM annotation_sources WHERE session_id=? AND draft_id=? AND annotation_id=? AND version=? AND state='awaiting'").get(sessionId, draftId, annotationId, version)) fail(409, 'scene_source_missing', 'Bind the displayed scene to this saved target before preparing its capture.');
      if (sceneSource ? input?.sourceMode !== 'scene-bitmap' || !isDeepStrictEqual(input.sceneSource, sceneSource.source) || !isDeepStrictEqual(input.presentation, sceneSource.presentation) : input?.sourceMode !== undefined || input?.sceneSource !== undefined || input?.presentation !== undefined) fail(409, 'scene_source_conflict', 'Prepare the scene and presentation saved with this annotation.');
      if (!input?.target?.bounds || !Array.isArray(input.target.objectIds) || !sameAnnotationTarget(annotation, input.target)) fail(409, 'capture_target_conflict', 'Capture the saved annotation target and position.');
      const image = input.image;
      if (!image || image.mime !== 'image/png' || !Number.isSafeInteger(image.width) || !Number.isSafeInteger(image.height) || image.width < 1 || image.height < 1 || image.width > 16_384 || image.height > 16_384 || image.width * image.height > 16_000_000 || !Number.isSafeInteger(image.bytes) || image.bytes < 1 || image.bytes > 20 * 1024 * 1024) fail(400, 'invalid_capture', 'Capture images support PNG, 16 million pixels and 20 MiB.');
      if (typeof input.capturedAt !== 'string' || !Number.isFinite(Date.parse(input.capturedAt)) || new Date(input.capturedAt).toISOString() !== input.capturedAt) fail(400, 'invalid_capture', 'Save the ISO capture time.');
      const bounds = (value: any, label: string, point = false) => {
        if (!value || typeof value !== 'object') fail(400, 'invalid_capture', `${label} requires bounds.`);
        for (const key of ['x', 'y', 'width', 'height'] as const) finite(value[key], `${label} ${key}`);
        if (point ? value.width < 0 || value.height < 0 : value.width <= 0 || value.height <= 0) fail(400, 'invalid_capture', `${label} requires valid dimensions.`);
        return { x: value.x, y: value.y, width: value.width, height: value.height };
      };
      const worldBounds = bounds(input.worldBounds, 'World geometry', annotation.geometry === 'point');
      if (annotation.geometry === 'point' && (worldBounds.width !== 0 || worldBounds.height !== 0)) fail(400, 'invalid_capture', 'World point geometry uses zero dimensions.');
      const view = input.viewport;
      if (!view) fail(400, 'invalid_capture', 'Save the capture viewport.');
      for (const key of ['x', 'y', 'zoom', 'width', 'height', 'devicePixelRatio'] as const) finite(view[key], `Viewport ${key}`);
      if ((sceneSource ? view.zoom <= 0 : view.zoom < .05 || view.zoom > 10) || view.width <= 0 || view.height <= 0 || view.devicePixelRatio <= 0 || view.devicePixelRatio > 8) fail(400, 'invalid_capture', 'Save a valid viewport scale and dimensions.');
      const mapping = input.mapping;
      if (!mapping) fail(400, 'invalid_capture', 'Save the screenshot mapping.');
      const crop = bounds(mapping.crop, 'Screenshot crop');
      if (crop.x < 0 || crop.y < 0 || crop.x + crop.width > view.width + .000001 || crop.y + crop.height > view.height + .000001 || mapping.pixelWidth !== image.width || mapping.pixelHeight !== image.height || Math.abs(finite(mapping.scaleX, 'Mapping scale x') - image.width / crop.width) > .000001 || Math.abs(finite(mapping.scaleY, 'Mapping scale y') - image.height / crop.height) > .000001) fail(400, 'invalid_capture', 'Map the actual image dimensions to its viewport crop.');
      if (sceneSource) {
        const presentation = sceneSource.presentation, area = presentation.cssViewport;
        if (view.x !== presentation.camera.x + area.x || view.y !== presentation.camera.y + area.y || view.zoom !== presentation.camera.zoom || crop.x < area.x || crop.y < area.y || crop.x + crop.width > area.x + area.width + .000001 || crop.y + crop.height > area.y + area.height + .000001 || Math.abs(mapping.scaleX - presentation.bitmap.width / area.width) > .000001 || Math.abs(mapping.scaleY - presentation.bitmap.height / area.height) > .000001) fail(400, 'invalid_capture', 'Map the copied pixels using the saved presentation camera and bitmap.');
        const layer = presentation.layers.find(layer => layer.objectId === annotation.objectId);
        const content = layer?.contentWorldBounds ?? layer?.worldBounds;
        const expected = annotation.coordinateSpace === 'normalized' && content ? { x: content.x + annotation.bounds.x * content.width, y: content.y + annotation.bounds.y * content.height, width: annotation.bounds.width * content.width, height: annotation.bounds.height * content.height } : annotation.bounds;
        if (Object.keys(expected).some(key => Math.abs(expected[key as keyof typeof expected] - worldBounds[key as keyof typeof worldBounds]) > .000001)) fail(400, 'invalid_capture', 'Save world geometry from the presented annotation target.');
      }
      const scene = input.scene;
      if (!scene || !Array.isArray(scene.objects) || scene.objects.length > 64 || !Array.isArray(scene.assets) || scene.assets.length > 256 || !Number.isSafeInteger(scene.omittedCount) || scene.omittedCount < 0) fail(400, 'invalid_capture', 'Capture scenes support 64 visible objects and a saved omitted count.');
      const seen = new Set<string>();
      const objects = scene.objects.map(value => {
        if (!value?.object || seen.has(value.object.id)) fail(400, 'invalid_capture', 'Scene objects have distinct IDs.');
        const object = sceneSource ? sceneSource.snapshot.objects.find(object => object.id === value.object.id) ?? fail(409, 'scene_object_conflict', 'Use a scene object from the saved Done source.') : this.object(value.object.id); seen.add(object.id);
        if (!isDeepStrictEqual(object, value.object)) fail(409, 'capture_scene_conflict', 'The scene object changed before capture preparation.');
        if (sceneSource) { const layer = sceneSource.presentation.layers.find(layer => layer.objectId === object.id); if (!layer || layer.layer !== value.layer || !isDeepStrictEqual(layer.worldBounds, value.renderedBounds)) fail(409, 'scene_source_conflict', 'Capture reference geometry from the saved presentation.'); }
        if (!Number.isSafeInteger(value.layer) || Math.abs(value.layer) > 1e9) fail(400, 'invalid_capture', 'Save an integer scene layer.');
        if (value.media) { const kind = resolveContentKind(this.sharedAsset(object.assetId)); if (!contentCapabilities[kind].time && kind !== 'gif') fail(400, 'invalid_capture', 'Media positions belong to audio, video or decoded GIF frames.'); for (const key of ['playbackTime', 'presentedTime', 'representativeTime'] as const) if (value.media[key] !== undefined && finite(value.media[key], `Media ${key}`) < 0) fail(400, 'invalid_capture', 'Media positions use positive seconds.'); }
        if (value.media && (value.media.timePrecision !== undefined && !['decoded-pts', 'rvfc-observed', 'playback-sampled'].includes(value.media.timePrecision) || value.media.frameIndex !== undefined && (!Number.isSafeInteger(value.media.frameIndex) || value.media.frameIndex < 0))) fail(400, 'invalid_capture', 'Capture media frames use an explicit precision and nonnegative frame index.');
        if (sceneSource && value.media) { const media = sceneSource.presentation.media.find(media => media.objectId === object.id); for (const key of ['playbackTime', 'presentedTime', 'representativeTime', 'timePrecision', 'frameIndex'] as const) if (value.media[key] !== undefined && value.media[key] !== media?.[key]) fail(409, 'scene_source_conflict', 'Capture media positions from the saved presentation.'); }
        if (value.scroll) { finite(value.scroll.x, 'Scene scroll x'); finite(value.scroll.y, 'Scene scroll y'); }
        if (value.contentAnchor) validContentAnchor(value.contentAnchor, 'invalid_capture');
        if (sceneSource) { const anchor = sceneSource.presentation.layers.find(layer => layer.objectId === object.id)?.contentAnchor; if (!isDeepStrictEqual(value.contentAnchor, anchor) || anchor?.scroll && !isDeepStrictEqual(value.scroll, anchor.scroll)) fail(409, 'scene_source_conflict', 'Capture the content anchor and scroll from the saved presented frame.'); }
        return { object, renderedBounds: bounds(value.renderedBounds, 'Rendered object'), layer: value.layer, ...(value.visibleBounds ? { visibleBounds: bounds(value.visibleBounds, 'Visible object') } : {}), ...(value.media ? { media: structuredClone(value.media) } : {}), ...(value.scroll ? { scroll: structuredClone(value.scroll) } : {}), ...(value.contentAnchor ? { contentAnchor: structuredClone(value.contentAnchor) } : {}) };
      }).sort((a, b) => a.layer - b.layer || a.object.id.localeCompare(b.object.id));
      const targetIds = [...annotation.objectIds, ...(annotation.objectId ? [annotation.objectId] : [])];
      if (targetIds.some(id => !seen.has(id))) fail(400, 'invalid_capture', 'Capture scenes include each explicit target object.');
      const needed = this.expandAssetIds([...new Set([...objects.map(value => value.object.assetId), ...[annotation.assetId, annotation.snapshotAssetId].filter((id): id is string => !!id)])]);
      const supplied = ids(scene.assets.map(value => value?.id), 'Scene assets');
      if (needed.length !== supplied.length || needed.some(id => !supplied.includes(id))) fail(400, 'invalid_capture', 'Save all scene assets and bundle resources.');
      const assets = needed.map(id => { const asset = this.sharedAsset(id); this.assetPath(id); return asset; });
      const normalized: AnnotationCaptureInput = { capturedAt: input.capturedAt, target: annotationTarget(annotation), worldBounds, viewport: structuredClone(view), mapping: { crop, pixelWidth: image.width, pixelHeight: image.height, scaleX: mapping.scaleX, scaleY: mapping.scaleY }, scene: { objects, assets, omittedCount: scene.omittedCount }, image: structuredClone(image), ...(sceneSource ? { sourceMode: 'scene-bitmap', sceneSource: structuredClone(sceneSource.source), presentation: structuredClone(sceneSource.presentation) } : {}) };
      const id = randomUUID(), screenshotAssetId = randomUUID();
      const capture: AnnotationCapture = { ...normalized, id, sessionId, draftId, annotationId, version, screenshotAssetId, source: 'reference_content' };
      this.db.prepare('INSERT INTO annotation_captures VALUES(?,?,?,?,?,?,?,?,?)').run(id, sessionId, draftId, annotationId, version, screenshotAssetId, `evidence/${id}.png`, json(capture), 'prepared');
      return { status: 'prepared', capture, draft: this.draft(sessionId) };
    });
  }
  retryCapture(sessionId: string, draftId: string, annotationId: string, version: number): CaptureRetryResult {
    return this.transaction(() => {
      this.sessionRow(sessionId);
      const saved = this.db.prepare('SELECT next_version FROM capture_retries WHERE session_id=? AND draft_id=? AND annotation_id=? AND version=?').get(sessionId, draftId, annotationId, version) as Row | undefined;
      if (saved) { const draft = this.draft(sessionId); if (draft.id !== draftId) fail(409, 'capture_version_conflict', 'Read the current draft after this capture retry.'); return { version: saved.next_version, draft }; }
      const { draft, annotation } = this.captureAnnotation(sessionId, draftId, annotationId, version);
      const nextVersion = version + 1;
      const replacement: AnnotationInput = { ...annotation, captureState: { version: nextVersion, status: 'incomplete' } }; delete replacement.capture;
      this.annotationSource(sessionId, draftId, annotation);
      this.db.prepare('INSERT INTO annotation_sources(session_id,draft_id,annotation_id,version,data_json,state) SELECT session_id,draft_id,annotation_id,?,data_json,state FROM annotation_sources WHERE session_id=? AND draft_id=? AND annotation_id=? AND version=?').run(nextVersion, sessionId, draftId, annotationId, version);
      const annotations = draft.annotations.map(value => value.id === annotationId ? replacement : value);
      this.db.prepare('INSERT INTO capture_retries VALUES(?,?,?,?,?)').run(sessionId, draftId, annotationId, version, nextVersion);
      this.db.prepare('UPDATE drafts SET annotations_json=?,revision=revision+1,updated_at=? WHERE id=?').run(json(annotations), now(), draftId);
      this.db.prepare('UPDATE annotation_identities SET data_json=? WHERE session_id=? AND draft_id=? AND annotation_id=?').run(json(replacement), sessionId, draftId, annotationId);
      return { version: nextVersion, draft: this.draft(sessionId) };
    });
  }
  captureUpload(sessionId: string, draftId: string, annotationId: string, version: number) {
    const row = this.captureRow(sessionId, draftId, annotationId, version), capture = parse<AnnotationCapture>(row.data_json);
    if (row.state !== 'committed') this.captureAnnotation(sessionId, draftId, annotationId, version);
    return { capture, committed: row.state === 'committed', temporary: resolve(this.dataDir, 'tmp', `${row.id}.capture-upload`), destination: resolve(this.dataDir, row.path) };
  }
  captureResult(sessionId: string, draftId: string, annotationId: string, version: number): CaptureResult {
    const row = this.captureRow(sessionId, draftId, annotationId, version), capture = parse<AnnotationCapture>(row.data_json);
    if (row.state === 'committed') { this.assetPath(capture.screenshotAssetId); return { status: 'committed', capture, ...(this.draft(sessionId).id === draftId ? { draft: this.draft(sessionId) } : {}) }; }
    const current = this.captureAnnotation(sessionId, draftId, annotationId, version);
    const destination = resolve(this.dataDir, row.path);
    let actual: string;
    try { actual = realpathSync(destination); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'prepared', capture, draft: current.draft }; throw error; }
    if (!within(this.dataDir, actual)) fail(403, 'path_boundary', 'Capture evidence remains inside project storage.');
    const info = statSync(actual);
    if (!info.isFile() || info.size !== capture.image.bytes) fail(409, 'capture_file_invalid', 'Upload the complete capture image.');
    const dimensions = rasterDimensions(readFileSync(actual), capture.image.mime);
    if (!dimensions || dimensions.width !== capture.image.width || dimensions.height !== capture.image.height) fail(409, 'capture_file_invalid', 'Upload the PNG matching the capture dimensions.');
    return this.transaction(() => {
      const { draft, annotation } = this.captureAnnotation(sessionId, draftId, annotationId, version);
      if (!sameAnnotationTarget(annotation, capture.target)) fail(409, 'capture_target_conflict', 'Capture the current annotation target.');
      this.db.prepare('INSERT INTO assets VALUES(?,?,?,?,?,?,?,?,?)').run(capture.screenshotAssetId, `capture-${annotationId}.png`, capture.image.mime, info.size, 'image', row.path, now(), null, null);
      this.db.prepare('INSERT INTO evidence_assets VALUES(?,?,?,?)').run(capture.screenshotAssetId, sessionId, draftId, capture.id);
      this.db.prepare("UPDATE annotation_captures SET state='committed' WHERE id=?").run(capture.id);
      const annotations = draft.annotations.map(value => value.id === annotationId ? { ...value, captureState: { version, status: 'complete' as const, captureId: capture.id }, capture } : value);
      this.db.prepare('UPDATE drafts SET annotations_json=?,revision=revision+1,updated_at=? WHERE id=?').run(json(annotations), now(), draftId);
      this.db.prepare('UPDATE annotation_identities SET data_json=? WHERE session_id=? AND draft_id=? AND annotation_id=?').run(json(annotations.find(value => value.id === annotationId)), sessionId, draftId, annotationId);
      return { status: 'committed', capture, draft: this.draft(sessionId) };
    });
  }
  saveView(sessionId: string, view: SessionView): Session {
    return this.transaction(() => {
      this.sessionRow(sessionId);
      finite(view?.x, 'View x'); finite(view?.y, 'View y');
      if (finite(view?.zoom, 'View zoom') < .05 || view.zoom > 10) fail(400, 'invalid_view', 'Zoom must be between 0.05 and 10.');
      const selectedObjectIds = ids(view.selectedObjectIds, 'Selected objects');
      this.db.prepare('UPDATE sessions SET view_json=? WHERE id=?').run(json({ x: view.x, y: view.y, zoom: view.zoom, selectedObjectIds }), sessionId);
      return this.session(sessionId);
    });
  }
  beginTaskEdit(sessionId: string, taskId: string, input: { draftId: string; expectedRevision: number }): { task: Task; draft: Draft } {
    return this.transaction(() => {
      const task = this.task(sessionId, taskId), previous = this.draft(sessionId);
      if (previous.editingTaskId === taskId && task.status === 'editing') return { task, draft: previous };
      if (task.status !== 'queued') fail(409, 'task_edit_conflict', 'Edit a waiting request. This request has already changed state.');
      if (previous.editingTaskId) fail(409, 'task_edit_conflict', 'Save or cancel the current edit before editing another request.');
      if (previous.id !== input.draftId || previous.revision !== input.expectedRevision) fail(409, 'draft_revision_conflict', 'The draft changed. Read the current draft before editing a request.');
      const id = randomUUID(), snapshot = task.snapshot;
      // Explicit request references preserve the composer; snapshot content also contains annotation dependencies.
      // Earlier snapshots retain their available references because their attachment provenance is unknown.
      const attachments = snapshot.requestReferences?.attachmentIds ?? snapshot.referenceContent.assets.map(asset => asset.id);
      const objectIds = snapshot.requestReferences?.objectIds ?? snapshot.referenceContent.objects.map(object => object.id);
      this.db.prepare('INSERT INTO task_edits VALUES(?,?,?,?,?)').run(id, sessionId, taskId, json(previous), 'active');
      this.db.prepare("UPDATE tasks SET status='editing',updated_at=? WHERE id=? AND status='queued'").run(now(), taskId);
      this.db.prepare('DELETE FROM drafts WHERE id=?').run(previous.id);
      const references = draftReferences({ objectIds, taskIds: snapshot.requestReferences?.taskIds ?? snapshot.referenceContent.taskIds, ...(snapshot.requestReferences?.order ? { order: snapshot.requestReferences.order } : {}) }, snapshot.userRequest.text);
      this.db.prepare('INSERT INTO drafts(id,session_id,revision,text,attachments_json,annotations_json,references_json,updated_at,editing_task_id) VALUES(?,?,1,?,?,?,?,?,?)').run(id, sessionId, snapshot.userRequest.text, json(attachments), json(snapshot.annotations), json(references), now(), taskId);
      for (const annotation of snapshot.annotations) if (annotation.captureState) {
        this.db.prepare('INSERT INTO annotation_identities VALUES(?,?,?,?)').run(sessionId, id, annotation.id, json(annotation));
        if (annotation.sceneSource) {
          const context = this.annotationSource(sessionId, annotation.capture!.draftId, annotation)!;
          this.db.prepare("INSERT INTO annotation_sources(session_id,draft_id,annotation_id,version,data_json,state) VALUES(?,?,?,?,?,'bound')").run(sessionId, id, annotation.id, annotation.captureState.version, json(context));
        }
      }
      return { task: this.task(sessionId, taskId), draft: this.draft(sessionId) };
    });
  }
  private restorePreviousDraft(edit: Row) {
    const previous = parse<Draft>(edit.previous_draft_json);
    this.db.prepare('DELETE FROM drafts WHERE session_id=?').run(edit.session_id);
    this.db.prepare('INSERT INTO drafts(id,session_id,revision,text,attachments_json,annotations_json,references_json,updated_at) VALUES(?,?,?,?,?,?,?,?)').run(previous.id, edit.session_id, previous.revision + 1, previous.text, json(previous.attachments), json(previous.annotations), json(previous.references), now());
  }
  cancelTaskEdit(sessionId: string, taskId: string, input: { draftId: string; expectedRevision: number }): { task: Task; draft: Draft } {
    return this.transaction(() => {
      this.taskRow(sessionId, taskId);
      const edit = this.db.prepare('SELECT * FROM task_edits WHERE draft_id=? AND session_id=? AND task_id=?').get(input.draftId, sessionId, taskId) as Row;
      if (edit?.state === 'cancelled') return { task: this.task(sessionId, taskId), draft: this.draft(sessionId) };
      const draft = this.draft(sessionId);
      if (!edit || edit.state !== 'active' || draft.id !== input.draftId || draft.editingTaskId !== taskId || draft.revision !== input.expectedRevision) fail(409, 'draft_revision_conflict', 'The request edit changed. Read the current draft before cancelling.');
      this.db.prepare("UPDATE tasks SET status='queued',updated_at=? WHERE id=? AND status='editing'").run(now(), taskId);
      this.db.prepare("UPDATE task_edits SET state='cancelled' WHERE draft_id=?").run(edit.draft_id);
      this.restorePreviousDraft(edit);
      return { task: this.task(sessionId, taskId), draft: this.draft(sessionId) };
    });
  }
  private resolveRequestReferences(draft: Draft, source?: TaskSnapshot): ResolvedRequestReference[] {
    return referenceOrder(draft.references).map(reference => {
      const position = reference.textOffset === undefined ? {} : { textOffset: reference.textOffset };
      const saved = source?.requestReferences?.order?.find(value => value.kind === reference.kind && value.id === reference.id);
      if (saved) {
        const { textOffset, ...content } = structuredClone(saved);
        return { ...content, ...position };
      }
      if (reference.kind === 'object') {
        const sourceIds = source?.requestReferences?.objectIds ?? source?.referenceContent.objects.map(value => value.id) ?? [];
        let object = sourceIds.includes(reference.id) ? source?.referenceContent.objects.find(value => value.id === reference.id) : undefined;
        if (!object) {
          const row = this.db.prepare('SELECT * FROM objects WHERE id=?').get(reference.id) as Row | undefined;
          if (!row) fail(409, 'object_reference_unavailable', 'Remove or replace the unavailable object reference before sending.', { objectId: reference.id, action: 'remove_or_replace' });
          object = this.objectFrom(row!);
        }
        const asset = source?.referenceContent.assets.find(value => value.id === object!.assetId) ?? this.sharedAsset(object.assetId);
        const sourceRow = object.sourceTaskId ? this.db.prepare('SELECT session_id FROM tasks WHERE id=?').get(object.sourceTaskId) as Row | undefined : undefined;
        return { kind: 'object', id: reference.id, ...position, label: asset.name, source: 'reference_content', object: structuredClone(object), asset: structuredClone(asset), ...(sourceRow ? { sourceSessionId: sourceRow.session_id } : {}), ...(object.sourceTaskId ? { sourceTaskId: object.sourceTaskId } : {}), ...(object.sourceRunId ? { sourceRunId: object.sourceRunId } : {}) };
      }
      const row = this.db.prepare('SELECT session_id,sequence,snapshot_json FROM tasks WHERE id=?').get(reference.id) as Row | undefined;
      if (!row) fail(404, 'task_missing', 'The referenced task is unavailable.');
      const snapshot = parse<TaskSnapshot>(row!.snapshot_json);
      return { kind: 'task', id: reference.id, ...position, label: `Request ${row!.sequence}`, source: 'reference_content', task: { sessionId: row!.session_id, sequence: row!.sequence, text: snapshot.userRequest.text }, sourceSessionId: row!.session_id, sourceTaskId: reference.id };
    });
  }
  sendDraft(sessionId: string, draftId: string, expectedRevision: number): { task: Task; draft: Draft } {
    return this.transaction(() => {
      this.sessionRow(sessionId);
      const submittedEdit = this.db.prepare("SELECT * FROM task_edits WHERE draft_id=? AND state='submitted'").get(draftId) as Row;
      if (submittedEdit) { if (submittedEdit.session_id !== sessionId) fail(409, 'draft_conflict', 'The draft belongs to another session.'); return { task: this.task(sessionId, submittedEdit.task_id), draft: this.draft(sessionId) }; }
      const existing = this.db.prepare('SELECT id,session_id FROM tasks WHERE draft_id=?').get(draftId) as Row;
      if (existing) { if (existing.session_id !== sessionId) fail(409, 'draft_conflict', 'The draft belongs to another session.'); return { task: this.task(sessionId, existing.id), draft: this.draft(sessionId) }; }
      const draft = this.draft(sessionId);
      if (draft.id !== draftId) fail(409, 'draft_conflict', 'Send the current saved draft.');
      if (!Number.isSafeInteger(expectedRevision) || draft.revision !== expectedRevision) fail(409, 'draft_revision_conflict', 'The draft changed before sending. Review the saved version.', { currentRevision: draft.revision });
      if (!draft.text.trim() && !draft.attachments.length && !draft.annotations.length && !draft.references.objectIds.length && !draft.references.taskIds.length) fail(400, 'empty_request', 'Add a request or attachment.');
      const source = draft.editingTaskId ? this.task(sessionId, draft.editingTaskId) : undefined;
      if (source && source.status !== 'editing') fail(409, 'task_edit_conflict', 'The request changed state. Read the current request.');
      const edit = source ? this.db.prepare("SELECT * FROM task_edits WHERE draft_id=? AND state='active'").get(draftId) as Row : undefined;
      if (source && !edit) fail(409, 'task_edit_conflict', 'The request edit is unavailable. Read the current draft.');
      for (const annotation of draft.annotations) if (annotation.captureState) {
        const sceneSource = this.annotationSource(sessionId, draftId, annotation);
        const capture = annotation.capture ?? fail(409, 'annotation_incomplete', 'Complete each annotation capture before sending.');
        if (annotation.captureState.status !== 'complete') fail(409, 'annotation_incomplete', 'Complete each annotation capture before sending.');
        if (capture.sessionId !== sessionId || capture.annotationId !== annotation.id || capture.version !== annotation.captureState.version || capture.id !== annotation.captureState.captureId || !sameAnnotationTarget(annotation, capture.target)) fail(409, 'capture_version_conflict', 'Send the capture matching this annotation version.');
        if (sceneSource && (capture.sourceMode !== 'scene-bitmap' || !isDeepStrictEqual(sceneSource.source, capture.sceneSource) || !isDeepStrictEqual(sceneSource.presentation, capture.presentation))) fail(409, 'scene_source_conflict', 'Send evidence from the annotation source saved in this draft.');
        const row = this.captureRow(sessionId, capture.draftId, annotation.id, capture.version);
        if (row.state !== 'committed' || json(capture) !== row.data_json || capture.draftId !== draftId && !source?.snapshot.annotations.some(value => value.id === annotation.id && value.capture?.id === capture.id)) fail(409, 'capture_version_conflict', 'The capture belongs to this draft or its original queued request.');
        this.readableAsset(capture.screenshotAssetId, sessionId); this.assetPath(capture.screenshotAssetId);
        for (const asset of capture.scene.assets) { this.sharedAsset(asset.id); this.assetPath(asset.id); }
      }
      const order = this.resolveRequestReferences(draft, source?.snapshot);
      const legacyAnnotations = draft.annotations.filter(annotation => !annotation.captureState);
      const objectIds = [...new Set([...draft.references.objectIds, ...legacyAnnotations.flatMap((annotation) => [...annotation.objectIds, ...(annotation.objectId ? [annotation.objectId] : [])])])];
      const objects = objectIds.map((id) => order.find((value): value is Extract<ResolvedRequestReference, { kind: 'object' }> => value.kind === 'object' && value.id === id)?.object ?? source?.snapshot.referenceContent.objects.find(object => object.id === id) ?? this.object(id));
      const assetIds = this.expandAssetIds([...new Set([...draft.attachments, ...objects.map((object) => object.assetId), ...legacyAnnotations.flatMap((annotation) => [annotation.assetId, annotation.snapshotAssetId].filter((id): id is string => !!id)), ...draft.annotations.flatMap(annotation => annotation.capture ? [annotation.capture.screenshotAssetId, ...annotation.capture.scene.assets.map(asset => asset.id)] : [])])]);
      const snapshot: TaskSnapshot = { userRequest: { source: 'user_instruction', text: draft.text }, requestReferences: { attachmentIds: [...draft.attachments], objectIds: [...draft.references.objectIds], taskIds: [...draft.references.taskIds], order }, annotations: structuredClone(draft.annotations), referenceContent: { source: 'reference_content', assets: assetIds.map((id) => { this.assetPath(id); return source?.snapshot.referenceContent.assets.find(asset => asset.id === id) || this.asset(id); }), objects, taskIds: [...draft.references.taskIds] } };
      snapshot.requirementText = generateRequirementText(snapshot);
      const id = source?.id || randomUUID(), time = now();
      if (source) {
        this.db.prepare("UPDATE tasks SET status='queued',snapshot_json=?,updated_at=? WHERE id=? AND status='editing'").run(json(snapshot), time, id);
        this.db.prepare("UPDATE task_edits SET state='submitted' WHERE draft_id=?").run(draftId);
      } else {
        const sequence = (this.db.prepare('SELECT COALESCE(MAX(sequence),0)+1 AS next FROM tasks WHERE session_id=?').get(sessionId) as Row).next;
        this.db.prepare("INSERT INTO tasks(id,session_id,draft_id,sequence,status,snapshot_json,created_at,updated_at) VALUES(?,?,?,?,'queued',?,?,?)").run(id, sessionId, draftId, sequence, json(snapshot), time, time);
      }
      for (const input of draft.annotations) {
        if (input.captureState) continue;
        const annotation: Annotation = { ...input, id: randomUUID(), source: 'user_annotation', createdAt: time, sourceTaskId: id, sessionId };
        this.db.prepare('INSERT INTO annotations VALUES(?,?,?,?)').run(annotation.id, sessionId, id, json(annotation));
      }
      if (edit) this.restorePreviousDraft(edit);
      else { this.db.prepare('DELETE FROM drafts WHERE id=?').run(draftId); this.newDraft(sessionId); }
      return { task: this.task(sessionId, id), draft: this.draft(sessionId) };
    });
  }
  private taskRow(sessionId: string, id: string): Row { this.sessionRow(sessionId); return this.db.prepare('SELECT * FROM tasks WHERE id=? AND session_id=?').get(id, sessionId) as Row || fail(404, 'task_missing', 'The task belongs to a different session or is unavailable.'); }
  private runRow(id: string): Row { return this.db.prepare('SELECT * FROM runs WHERE id=?').get(id) as Row || fail(404, 'run_missing', 'The execution attempt is unavailable.'); }
  private runFrom(row: Row): Run { return { id: row.id, taskId: row.task_id, consumerId: row.consumer_id, status: row.status, createdAt: row.created_at, updatedAt: row.updated_at, progress: parse(row.progress_json), outputAssetIds: parse(row.output_asset_ids_json), ...(row.recovery_resolution ? { recoveryResolution: row.recovery_resolution } : {}) }; }
  task(sessionId: string, id: string): Task {
    const row = this.taskRow(sessionId, id);
    const lastEdit = this.db.prepare("SELECT draft_id FROM task_edits WHERE task_id=? AND state='submitted' ORDER BY rowid DESC LIMIT 1").get(id) as Row | undefined;
    const snapshot = parse<TaskSnapshot>(row.snapshot_json), requirementText = generateRequirementText(snapshot);
    snapshot.requirementText = requirementText;
    return { ...(lastEdit ? { lastEditDraftId: lastEdit.draft_id } : {}), id: row.id, sessionId, draftId: row.draft_id, sequence: row.sequence, status: row.status, snapshot, requirementText, createdAt: row.created_at, updatedAt: row.updated_at, currentRunId: row.current_run_id, reason: row.reason, receipt: row.receipt_json ? parse(row.receipt_json) : null, replies: parse(row.replies_json), runs: (this.db.prepare('SELECT * FROM runs WHERE task_id=? ORDER BY created_at,rowid').all(id) as Row[]).map((run) => this.runFrom(run)), lateResults: (this.db.prepare('SELECT * FROM late_results WHERE task_id=? ORDER BY rowid').all(id) as Row[]).map((late) => ({ runId: late.run_id, consumerId: late.consumer_id, receivedAt: late.received_at, payload: parse(late.payload_json) })) };
  }
  tasks(sessionId: string): Task[] { this.sessionRow(sessionId); return (this.db.prepare('SELECT id FROM tasks WHERE session_id=? ORDER BY sequence').all(sessionId) as Row[]).map((row) => this.task(sessionId, row.id)); }
  context(sessionId: string, taskId: string) {
    const task = this.task(sessionId, taskId);
    const referencedTasks = task.snapshot.referenceContent.taskIds.map((id) => {
      const row = this.db.prepare('SELECT session_id FROM tasks WHERE id=?').get(id) as Row;
      const referenced = this.task(row.session_id, id);
      if (row.session_id === sessionId) return referenced;
      const snapshot = { ...referenced.snapshot, annotations: referenced.snapshot.annotations.filter(annotation => !annotation.captureState), referenceContent: { ...referenced.snapshot.referenceContent, assets: referenced.snapshot.referenceContent.assets.filter(asset => !asset.evidence) } };
      const requirementText = generateRequirementText(snapshot);
      return { ...referenced, snapshot: { ...snapshot, requirementText }, requirementText };
    });
    const recentReceipts = this.tasks(sessionId).filter((prior) => prior.sequence < task.sequence && prior.receipt).slice(-3).map((prior) => ({ taskId: prior.id, receipt: prior.receipt }));
    return { task, context: { referencedTasks, recentReceipts } };
  }
  state(sessionId: string): BoardState { return { project: this.project, sessions: this.sessions(), session: this.session(sessionId), draft: this.draft(sessionId), assets: this.assets().filter(asset => !asset.evidence || asset.evidence.sessionId === sessionId), objects: this.objects(), annotations: this.annotations(), tasks: this.tasks(sessionId) }; }
  private newRun(taskId: string, consumerId: string, recovery?: string): Run {
    const id = randomUUID(), time = now();
    this.db.prepare("INSERT INTO runs(id,task_id,consumer_id,status,created_at,updated_at,recovery_resolution) VALUES(?,?,?,'running',?,?,?)").run(id, taskId, consumerId, time, time, recovery ?? null);
    this.db.prepare("UPDATE tasks SET status='running',current_run_id=?,reason=NULL,updated_at=? WHERE id=?").run(id, time, taskId);
    return this.runFrom(this.runRow(id));
  }
  private activateConsumer(sessionId: string, consumerId: string) {
    const existing = this.db.prepare('SELECT status FROM consumers WHERE session_id=? AND id=?').get(sessionId, consumerId) as Row | undefined;
    if (existing?.status === 'retired') fail(409, 'consumer_retired', 'This consumer activation has ended. Start or explicitly resume with a new consumer ID.');
    if (!existing) this.db.prepare("INSERT INTO consumers(session_id,id,status,created_at) VALUES(?,?,'active',?)").run(sessionId, consumerId, now());
  }
  private retireConsumer(sessionId: string, consumerId: string) { this.db.prepare("UPDATE consumers SET status='retired',retired_at=? WHERE session_id=? AND id=? AND status='active'").run(now(), sessionId, consumerId); }
  claim(sessionId: string, consumerInput: unknown): Claim {
    const consumerId = nonempty(consumerInput, 'Consumer ID', 200);
    return this.transaction(() => {
      const session = this.sessionRow(sessionId);
      if (session.consumer_id && session.consumer_id !== consumerId) fail(409, 'consumer_conflict', 'This session belongs to another consumer activation. Read the session and explicitly resume its settled queue.', { consumerId: session.consumer_id });
      this.activateConsumer(sessionId, consumerId);
      const active = this.db.prepare("SELECT * FROM tasks WHERE session_id=? AND status IN ('queued','editing','running','blocked','interrupted') ORDER BY sequence LIMIT 1").get(sessionId) as Row;
      if (!active) { this.retireConsumer(sessionId, consumerId); this.db.prepare('UPDATE sessions SET consumer_id=NULL WHERE id=?').run(sessionId); return { task: null, run: null, consumerId, projectId: this.project.id, sessionId }; }
      if (active.status !== 'queued') fail(409, 'queue_paused', 'Save the current request edit, or review the running, blocked or interrupted task before claiming another.', { taskId: active.id, status: active.status });
      this.db.prepare('UPDATE sessions SET consumer_id=? WHERE id=?').run(consumerId, sessionId);
      const run = this.newRun(active.id, consumerId);
      return { task: this.task(sessionId, active.id), run, consumerId, projectId: this.project.id, sessionId };
    });
  }
  resumeSession(sessionId: string, input: { consumerId: string; expectedConsumerId: string | null; resolution: string }): Session {
    return this.transaction(() => {
      const session = this.sessionRow(sessionId);
      const consumerId = nonempty(input.consumerId, 'Consumer ID', 200);
      nonempty(input.resolution, 'Recovery decision');
      if (input.expectedConsumerId !== session.consumer_id) fail(409, 'consumer_conflict', 'The session consumer changed. Read the current execution owner.');
      const active = this.db.prepare("SELECT id,status FROM tasks WHERE session_id=? AND status IN ('running','blocked','interrupted') ORDER BY sequence LIMIT 1").get(sessionId) as Row | undefined;
      if (active) fail(409, 'queue_paused', 'Review and resume the current task attempt before transferring this session.', { taskId: active.id, status: active.status });
      this.activateConsumer(sessionId, consumerId);
      if (session.consumer_id && session.consumer_id !== consumerId) this.retireConsumer(sessionId, session.consumer_id);
      this.db.prepare('UPDATE sessions SET consumer_id=? WHERE id=? AND consumer_id IS ?').run(consumerId, sessionId, input.expectedConsumerId);
      return this.session(sessionId);
    });
  }
  private isCurrent(sessionId: string, taskId: string, identity: RunIdentity): boolean {
    const task = this.taskRow(sessionId, taskId), session = this.sessionRow(sessionId), run = this.runRow(identity.runId);
    return task.status === 'running' && task.current_run_id === identity.runId && session.consumer_id === identity.consumerId && run.task_id === taskId && run.consumer_id === identity.consumerId && run.status === 'running';
  }
  private recordLate(taskId: string, identity: RunIdentity, payload: unknown) {
    this.db.prepare('INSERT INTO late_results VALUES(?,?,?,?,?,?)').run(randomUUID(), taskId, identity.runId, identity.consumerId, now(), json(payload));
  }
  private requireCurrent(sessionId: string, taskId: string, identity: RunIdentity, payload?: unknown) {
    nonempty(identity?.consumerId, 'Consumer ID', 200); nonempty(identity?.runId, 'Run ID', 200);
    const task = this.taskRow(sessionId, taskId), run = this.runRow(identity.runId);
    if (run.task_id !== taskId || run.consumer_id !== identity.consumerId) fail(409, 'run_conflict', 'The task and execution identity must match.');
    if (!this.isCurrent(sessionId, taskId, identity)) {
      if (payload !== undefined) { this.recordLate(taskId, identity, payload); this.onChange(); }
      fail(409, 'stale_run', 'This execution attempt has ended. Its result is retained for review.', { currentRunId: task.current_run_id, status: task.status });
    }
  }
  progress(sessionId: string, taskId: string, input: RunIdentity & { message: string; externalJobId?: string; assetIds?: string[] }): Task {
    this.requireCurrent(sessionId, taskId, input, { action: 'progress', input });
    return this.transaction(() => {
      const run = this.runRow(input.runId);
      const assetIds = input.assetIds ? ids(input.assetIds, 'Progress assets') : [];
      assetIds.forEach((id) => this.sharedAsset(id));
      const progress = parse<Run['progress']>(run.progress_json);
      progress.push({ message: nonempty(input.message, 'Progress message'), ...(input.externalJobId ? { externalJobId: nonempty(input.externalJobId, 'External job ID', 1000) } : {}), ...(assetIds.length ? { assetIds } : {}), createdAt: now() });
      this.db.prepare('UPDATE runs SET progress_json=?,updated_at=? WHERE id=?').run(json(progress), now(), input.runId);
      return this.task(sessionId, taskId);
    });
  }
  pause(sessionId: string, taskId: string, input: RunIdentity & { reason: string }, status: 'blocked' | 'interrupted'): Task {
    this.requireCurrent(sessionId, taskId, input, { action: status, input });
    return this.transaction(() => {
      const time = now();
      const reason = nonempty(input.reason, 'Reason');
      const progress = parse<Run['progress']>(this.runRow(input.runId).progress_json);
      progress.push({ message: reason, createdAt: time });
      this.db.prepare('UPDATE tasks SET status=?,reason=?,updated_at=? WHERE id=?').run(status, reason, time, taskId);
      this.db.prepare('UPDATE runs SET status=?,progress_json=?,updated_at=? WHERE id=?').run(status, json(progress), time, input.runId);
      return this.task(sessionId, taskId);
    });
  }
  reply(sessionId: string, taskId: string, input: { text: string }): Task {
    return this.transaction(() => {
      const task = this.taskRow(sessionId, taskId);
      const replies = parse<Task['replies']>(task.replies_json);
      replies.push({ text: nonempty(input.text, 'Reply'), source: 'user_instruction', createdAt: now() });
      this.db.prepare('UPDATE tasks SET replies_json=?,updated_at=? WHERE id=?').run(json(replies), now(), taskId);
      return this.task(sessionId, taskId);
    });
  }
  resume(sessionId: string, taskId: string, input: { consumerId: string; expectedRunId: string; resolution: string }): Claim {
    return this.transaction(() => {
      const task = this.taskRow(sessionId, taskId);
      if (!['blocked', 'interrupted'].includes(task.status) || task.current_run_id !== input.expectedRunId) fail(409, 'resume_conflict', 'Resume the current blocked or interrupted attempt after reviewing its saved results.');
      const first = this.db.prepare("SELECT id FROM tasks WHERE session_id=? AND status IN ('queued','editing','running','blocked','interrupted') ORDER BY sequence LIMIT 1").get(sessionId) as Row;
      if (first?.id !== taskId) fail(409, 'queue_order', 'Resume the earliest unfinished task.');
      const consumerId = nonempty(input.consumerId, 'Consumer ID', 200);
      const resolution = nonempty(input.resolution, 'Recovery decision');
      this.activateConsumer(sessionId, consumerId);
      const oldConsumer = this.runRow(input.expectedRunId).consumer_id;
      if (oldConsumer !== consumerId) this.retireConsumer(sessionId, oldConsumer);
      this.db.prepare("UPDATE runs SET status='interrupted',updated_at=? WHERE id=?").run(now(), input.expectedRunId);
      this.db.prepare('UPDATE sessions SET consumer_id=? WHERE id=?').run(consumerId, sessionId);
      const run = this.newRun(taskId, consumerId, resolution);
      return { task: this.task(sessionId, taskId), run, consumerId, projectId: this.project.id, sessionId };
    });
  }
  cancel(sessionId: string, taskId: string, reason: string): Task {
    return this.transaction(() => {
      const task = this.taskRow(sessionId, taskId);
      if (!['queued', 'blocked', 'interrupted'].includes(task.status)) fail(409, 'cancel_conflict', 'Pause the running attempt before cancelling it.');
      this.db.prepare("UPDATE tasks SET status='cancelled',reason=?,updated_at=? WHERE id=?").run(nonempty(reason, 'Cancellation reason'), now(), taskId);
      if (task.current_run_id) this.db.prepare("UPDATE runs SET status='interrupted',updated_at=? WHERE id=?").run(now(), task.current_run_id);
      if (task.current_run_id) {
        const owner = this.sessionRow(sessionId).consumer_id;
        if (owner) this.retireConsumer(sessionId, owner);
        this.db.prepare('UPDATE sessions SET consumer_id=NULL WHERE id=?').run(sessionId);
      }
      return this.task(sessionId, taskId);
    });
  }
  private applyOperations(operations: BoardOperation[], source?: { taskId: string; runId: string }): string[] {
    if (!Array.isArray(operations) || operations.length > 1000) fail(400, 'invalid_operations', 'Board operations must be a list.');
    const objectIds: string[] = [], touched = new Set<string>(), time = now();
    for (const operation of operations) {
      if (operation?.type === 'create') {
        const object = operation.object;
        const asset = this.sharedAsset(object?.assetId); this.assetPath(asset.id);
        const id = object.id ? nonempty(object.id, 'Object ID', 200) : randomUUID();
        for (const key of ['x', 'y', 'width', 'height'] as const) finite(object[key], `Object ${key}`);
        if (object.width <= 0 || object.height <= 0) fail(400, 'invalid_object', 'Objects require positive dimensions.');
        if (touched.has(id) || this.db.prepare('SELECT id FROM objects WHERE id=?').get(id)) fail(409, 'object_conflict', 'The object ID already exists.');
        this.db.prepare('INSERT INTO objects VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(id, asset.id, object.x, object.y, object.width, object.height, 1, time, time, source?.taskId ?? null, source?.runId ?? null);
        touched.add(id); objectIds.push(id);
      } else if (operation?.type === 'update' || operation?.type === 'delete') {
        const id = nonempty(operation.objectId, 'Object ID', 200);
        if (touched.has(id)) fail(400, 'duplicate_operation', 'Submit one operation for each object.');
        const object = this.object(id);
        if (!Number.isSafeInteger(operation.expectedVersion) || object.version !== operation.expectedVersion) fail(409, 'object_conflict', 'The object changed. Read its current version before updating.', { objectId: id, currentVersion: object.version });
        if (operation.type === 'delete') this.db.prepare('DELETE FROM objects WHERE id=? AND version=?').run(id, operation.expectedVersion);
        else {
          if (!operation.changes || Object.keys(operation.changes).some((key) => !['x', 'y', 'width', 'height'].includes(key))) fail(400, 'invalid_object', 'Object changes support position and dimensions.');
          const changed = { ...object, ...operation.changes };
          for (const key of ['x', 'y', 'width', 'height'] as const) finite(changed[key], `Object ${key}`);
          if (changed.width <= 0 || changed.height <= 0) fail(400, 'invalid_object', 'Objects require positive dimensions.');
          this.db.prepare('UPDATE objects SET x=?,y=?,width=?,height=?,version=version+1,updated_at=? WHERE id=? AND version=?').run(changed.x, changed.y, changed.width, changed.height, time, id, operation.expectedVersion);
        }
        touched.add(id); objectIds.push(id);
      } else fail(400, 'invalid_operation', 'Choose create, update or delete.');
    }
    return objectIds;
  }
  boardOperations(sessionId: string, operations: BoardOperation[]): { objects: BoardObject[] } { return this.transaction(() => { this.sessionRow(sessionId); this.applyOperations(operations); return { objects: this.objects() }; }); }
  complete(sessionId: string, taskId: string, input: CompleteInput): Task {
    const prior = this.taskRow(sessionId, taskId);
    if (prior.status === 'completed' && prior.current_run_id === input.runId && this.runRow(input.runId).consumer_id === input.consumerId) return this.task(sessionId, taskId);
    this.requireCurrent(sessionId, taskId, input, { action: 'complete', input });
    return this.transaction(() => {
      const summary = nonempty(input.summary, 'Completion summary');
      const assetIds = this.expandAssetIds(ids(input.assetIds, 'Result assets'));
      for (const assetId of assetIds) { const asset = this.asset(assetId); if (asset.sourceTaskId !== taskId) fail(409, 'output_ownership', 'Result assets must belong to this task.'); this.assetPath(assetId); }
      if (!Array.isArray(input.operations)) fail(400, 'invalid_operations', 'Board operations must be a list.');
      for (const operation of input.operations) if (operation?.type === 'create') {
        const asset = this.asset(operation.object?.assetId);
        if (asset.sourceTaskId !== taskId) fail(409, 'output_ownership', 'Published result assets must belong to this task.');
        if (!assetIds.includes(asset.id)) fail(409, 'receipt_assets_missing', 'The completion receipt must include every published result asset.', { assetId: asset.id });
      }
      if (!Array.isArray(input.validation) || input.validation.length > 100) fail(400, 'invalid_validation', 'Supply the applicable validation records.');
      const validation = input.validation.map((value) => nonempty(value, 'Validation record'));
      const objectIds = this.applyOperations(input.operations, { taskId, runId: input.runId });
      const receipt = { summary, assetIds, objectIds, validation, createdAt: now() };
      this.db.prepare("UPDATE tasks SET status='completed',receipt_json=?,reason=NULL,updated_at=? WHERE id=?").run(json(receipt), now(), taskId);
      this.db.prepare("UPDATE runs SET status='completed',updated_at=? WHERE id=?").run(now(), input.runId);
      return this.task(sessionId, taskId);
    });
  }
}
