import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { mkdirSync, realpathSync, statSync } from 'node:fs';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import type { Annotation, AnnotationInput, Asset, BoardObject, BoardOperation, BoardState, Claim, CompleteInput, Draft, HostBinding, Project, Run, RunIdentity, ServiceIdentity, Session, SessionView, Task, TaskSnapshot } from '../shared/types.js';

type Row = Record<string, any>;
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
export const within = (root: string, path: string) => { const rel = relative(root, path); return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`)); };

export class CanvasService {
  readonly db: Database.Database;
  readonly root: string;
  readonly dataDir: string;
  readonly project: Project;
  private readonly instanceId = randomUUID();
  onChange: () => void = () => {};

  constructor(root: string) {
    mkdirSync(root, { recursive: true });
    this.root = realpathSync(root);
    const requestedData = resolve(this.root, '.acanvas');
    mkdirSync(requestedData, { recursive: true, mode: 0o700 });
    this.dataDir = realpathSync(requestedData);
    if (!within(this.root, this.dataDir)) fail(403, 'path_boundary', 'The project data directory must remain inside the project.');
    for (const folder of ['assets', 'outputs', 'tmp']) {
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
      CREATE TABLE IF NOT EXISTS objects(id TEXT PRIMARY KEY, asset_id TEXT NOT NULL REFERENCES assets(id), x REAL NOT NULL, y REAL NOT NULL, width REAL NOT NULL, height REAL NOT NULL, version INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, source_task_id TEXT, source_run_id TEXT);
      CREATE TABLE IF NOT EXISTS annotations(id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), task_id TEXT NOT NULL, data_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), draft_id TEXT NOT NULL UNIQUE, sequence INTEGER NOT NULL, status TEXT NOT NULL, snapshot_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, current_run_id TEXT, reason TEXT, receipt_json TEXT, replies_json TEXT NOT NULL DEFAULT '[]', UNIQUE(session_id, sequence));
      CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), consumer_id TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, progress_json TEXT NOT NULL DEFAULT '[]', output_asset_ids_json TEXT NOT NULL DEFAULT '[]', recovery_resolution TEXT);
      CREATE TABLE IF NOT EXISTS late_results(id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), run_id TEXT NOT NULL REFERENCES runs(id), consumer_id TEXT NOT NULL, received_at TEXT NOT NULL, payload_json TEXT NOT NULL);
    `);
    if (!(this.db.pragma('table_info(drafts)') as Row[]).some((column) => column.name === 'revision')) this.db.exec('ALTER TABLE drafts ADD COLUMN revision INTEGER NOT NULL DEFAULT 1');
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
  draft(sessionId: string): Draft {
    this.sessionRow(sessionId);
    const row = this.db.prepare('SELECT * FROM drafts WHERE session_id=?').get(sessionId) as Row;
    return { id: row.id, sessionId, revision: row.revision, text: row.text, attachments: parse(row.attachments_json), annotations: parse(row.annotations_json), references: parse(row.references_json), updatedAt: row.updated_at };
  }
  private assetFrom(row: Row): Asset { return { id: row.id, name: row.name, mime: row.mime, size: row.size, kind: row.kind, createdAt: row.created_at, ...(row.source_task_id ? { sourceTaskId: row.source_task_id, sourceRunId: row.source_run_id } : {}) }; }
  asset(id: string): Asset { nonempty(id, 'Asset ID', 200); const row = this.db.prepare('SELECT * FROM assets WHERE id=?').get(id) as Row; return row ? this.assetFrom(row) : fail(404, 'asset_missing', 'The referenced asset is unavailable.'); }
  assets(): Asset[] { return (this.db.prepare('SELECT * FROM assets ORDER BY created_at,id').all() as Row[]).map((row) => this.assetFrom(row)); }
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
  private validateAnnotation(value: AnnotationInput): AnnotationInput {
    if (!value || !['object', 'region'].includes(value.scope) || !['normalized', 'world'].includes(value.coordinateSpace)) fail(400, 'invalid_annotation', 'Annotation scope and coordinate space are required.');
    nonempty(value.id, 'Annotation ID', 200);
    nonempty(value.text, 'Annotation text');
    const objectIds = ids(value.objectIds, 'Annotation object IDs');
    for (const objectId of objectIds) this.object(objectId);
    if (value.objectId) this.object(value.objectId);
    if (value.assetId) this.asset(value.assetId);
    if (value.snapshotAssetId) this.asset(value.snapshotAssetId);
    if (!value.bounds || typeof value.bounds !== 'object') fail(400, 'invalid_annotation', 'Annotation bounds are required.');
    for (const key of ['x', 'y', 'width', 'height'] as const) finite(value.bounds[key], `Annotation ${key}`);
    if (value.bounds.width <= 0 || value.bounds.height <= 0) fail(400, 'invalid_annotation', 'Annotation bounds must have positive dimensions.');
    if (value.coordinateSpace === 'normalized' && (value.bounds.x < 0 || value.bounds.y < 0 || value.bounds.x + value.bounds.width > 1.000001 || value.bounds.y + value.bounds.height > 1.000001)) fail(400, 'invalid_annotation', 'Object annotations must fit within normalized object coordinates.');
    if (value.scope === 'object' && (!value.objectId || value.coordinateSpace !== 'normalized')) fail(400, 'invalid_annotation', 'Object annotations require an object and normalized coordinates.');
    if (value.scope === 'region' && value.coordinateSpace !== 'world') fail(400, 'invalid_annotation', 'Canvas regions require world coordinates.');
    if (value.timeStart !== undefined && finite(value.timeStart, 'Video time') < 0) fail(400, 'invalid_annotation', 'Video time must be positive.');
    if (value.timeEnd !== undefined && (finite(value.timeEnd, 'Video end time') < (value.timeStart ?? 0))) fail(400, 'invalid_annotation', 'The video interval must follow its start time.');
    return structuredClone(value);
  }
  saveDraft(sessionId: string, input: Draft): Draft {
    return this.transaction(() => {
      const draft = this.draft(sessionId);
      if (input?.id !== draft.id || (input.sessionId && input.sessionId !== sessionId)) fail(409, 'draft_conflict', 'This draft has already been sent or replaced. Read the current draft.');
      if (!Number.isSafeInteger(input.revision) || input.revision !== draft.revision) fail(409, 'draft_revision_conflict', 'The saved draft changed. Review both versions before saving.', { currentRevision: draft.revision });
      const attachments = ids(input.attachments, 'Attachments');
      attachments.forEach((id) => this.asset(id));
      if (!Array.isArray(input.annotations) || input.annotations.length > 1000) fail(400, 'invalid_annotation', 'Annotations must be a list.');
      const annotations = input.annotations.map((annotation) => this.validateAnnotation(annotation));
      if (new Set(annotations.map((annotation) => annotation.id)).size !== annotations.length) fail(400, 'invalid_annotation', 'Each annotation needs a distinct ID.');
      const references = { objectIds: ids(input.references?.objectIds, 'Object references'), taskIds: ids(input.references?.taskIds, 'Task references') };
      references.objectIds.forEach((id) => this.object(id));
      references.taskIds.forEach((id) => { if (!this.db.prepare('SELECT id FROM tasks WHERE id=?').get(id)) fail(404, 'task_missing', 'The referenced task is unavailable.'); });
      const updated = this.db.prepare('UPDATE drafts SET text=?,attachments_json=?,annotations_json=?,references_json=?,updated_at=?,revision=revision+1 WHERE id=? AND revision=?').run(text(input.text, 'Draft text'), json(attachments), json(annotations), json(references), now(), draft.id, input.revision);
      if (updated.changes !== 1) fail(409, 'draft_revision_conflict', 'The saved draft changed. Review both versions before saving.');
      return this.draft(sessionId);
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
  sendDraft(sessionId: string, draftId: string, expectedRevision: number): { task: Task; draft: Draft } {
    return this.transaction(() => {
      this.sessionRow(sessionId);
      const existing = this.db.prepare('SELECT id,session_id FROM tasks WHERE draft_id=?').get(draftId) as Row;
      if (existing) { if (existing.session_id !== sessionId) fail(409, 'draft_conflict', 'The draft belongs to another session.'); return { task: this.task(sessionId, existing.id), draft: this.draft(sessionId) }; }
      const draft = this.draft(sessionId);
      if (draft.id !== draftId) fail(409, 'draft_conflict', 'Send the current saved draft.');
      if (!Number.isSafeInteger(expectedRevision) || draft.revision !== expectedRevision) fail(409, 'draft_revision_conflict', 'The draft changed before sending. Review the saved version.', { currentRevision: draft.revision });
      if (!draft.text.trim() && !draft.attachments.length && !draft.annotations.length && !draft.references.objectIds.length && !draft.references.taskIds.length) fail(400, 'empty_request', 'Add a request or attachment.');
      const objectIds = [...new Set([...draft.references.objectIds, ...draft.annotations.flatMap((annotation) => [...annotation.objectIds, ...(annotation.objectId ? [annotation.objectId] : [])])])];
      const objects = objectIds.map((id) => this.object(id));
      const assetIds = [...new Set([...draft.attachments, ...objects.map((object) => object.assetId), ...draft.annotations.flatMap((annotation) => [annotation.assetId, annotation.snapshotAssetId].filter((id): id is string => !!id))])];
      const snapshot: TaskSnapshot = { userRequest: { source: 'user_instruction', text: draft.text }, annotations: structuredClone(draft.annotations), referenceContent: { source: 'reference_content', assets: assetIds.map((id) => { this.assetPath(id); return this.asset(id); }), objects, taskIds: draft.references.taskIds } };
      const id = randomUUID(), time = now();
      const sequence = (this.db.prepare('SELECT COALESCE(MAX(sequence),0)+1 AS next FROM tasks WHERE session_id=?').get(sessionId) as Row).next;
      this.db.prepare("INSERT INTO tasks(id,session_id,draft_id,sequence,status,snapshot_json,created_at,updated_at) VALUES(?,?,?,?,'queued',?,?,?)").run(id, sessionId, draftId, sequence, json(snapshot), time, time);
      for (const input of draft.annotations) {
        const annotation: Annotation = { ...input, id: randomUUID(), source: 'user_annotation', createdAt: time, sourceTaskId: id, sessionId };
        this.db.prepare('INSERT INTO annotations VALUES(?,?,?,?)').run(annotation.id, sessionId, id, json(annotation));
      }
      this.db.prepare('DELETE FROM drafts WHERE id=?').run(draftId);
      this.newDraft(sessionId);
      return { task: this.task(sessionId, id), draft: this.draft(sessionId) };
    });
  }
  private taskRow(sessionId: string, id: string): Row { this.sessionRow(sessionId); return this.db.prepare('SELECT * FROM tasks WHERE id=? AND session_id=?').get(id, sessionId) as Row || fail(404, 'task_missing', 'The task belongs to a different session or is unavailable.'); }
  private runRow(id: string): Row { return this.db.prepare('SELECT * FROM runs WHERE id=?').get(id) as Row || fail(404, 'run_missing', 'The execution attempt is unavailable.'); }
  private runFrom(row: Row): Run { return { id: row.id, taskId: row.task_id, consumerId: row.consumer_id, status: row.status, createdAt: row.created_at, updatedAt: row.updated_at, progress: parse(row.progress_json), outputAssetIds: parse(row.output_asset_ids_json), ...(row.recovery_resolution ? { recoveryResolution: row.recovery_resolution } : {}) }; }
  task(sessionId: string, id: string): Task {
    const row = this.taskRow(sessionId, id);
    return { id: row.id, sessionId, draftId: row.draft_id, sequence: row.sequence, status: row.status, snapshot: parse(row.snapshot_json), createdAt: row.created_at, updatedAt: row.updated_at, currentRunId: row.current_run_id, reason: row.reason, receipt: row.receipt_json ? parse(row.receipt_json) : null, replies: parse(row.replies_json), runs: (this.db.prepare('SELECT * FROM runs WHERE task_id=? ORDER BY created_at,rowid').all(id) as Row[]).map((run) => this.runFrom(run)), lateResults: (this.db.prepare('SELECT * FROM late_results WHERE task_id=? ORDER BY rowid').all(id) as Row[]).map((late) => ({ runId: late.run_id, consumerId: late.consumer_id, receivedAt: late.received_at, payload: parse(late.payload_json) })) };
  }
  tasks(sessionId: string): Task[] { this.sessionRow(sessionId); return (this.db.prepare('SELECT id FROM tasks WHERE session_id=? ORDER BY sequence').all(sessionId) as Row[]).map((row) => this.task(sessionId, row.id)); }
  context(sessionId: string, taskId: string) {
    const task = this.task(sessionId, taskId);
    const referencedTasks = task.snapshot.referenceContent.taskIds.map((id) => {
      const row = this.db.prepare('SELECT session_id FROM tasks WHERE id=?').get(id) as Row;
      return this.task(row.session_id, id);
    });
    const recentReceipts = this.tasks(sessionId).filter((prior) => prior.sequence < task.sequence && prior.receipt).slice(-3).map((prior) => ({ taskId: prior.id, receipt: prior.receipt }));
    return { task, context: { referencedTasks, recentReceipts } };
  }
  state(sessionId: string): BoardState { return { project: this.project, sessions: this.sessions(), session: this.session(sessionId), draft: this.draft(sessionId), assets: this.assets(), objects: this.objects(), annotations: this.annotations(), tasks: this.tasks(sessionId) }; }
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
      const active = this.db.prepare("SELECT * FROM tasks WHERE session_id=? AND status IN ('queued','running','blocked','interrupted') ORDER BY sequence LIMIT 1").get(sessionId) as Row;
      if (!active) { this.retireConsumer(sessionId, consumerId); this.db.prepare('UPDATE sessions SET consumer_id=NULL WHERE id=?').run(sessionId); return { task: null, run: null, consumerId, projectId: this.project.id, sessionId }; }
      if (active.status !== 'queued') fail(409, 'queue_paused', 'Review the current running, blocked or interrupted task before claiming another.', { taskId: active.id, status: active.status });
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
      assetIds.forEach((id) => this.asset(id));
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
      const first = this.db.prepare("SELECT id FROM tasks WHERE session_id=? AND status IN ('queued','running','blocked','interrupted') ORDER BY sequence LIMIT 1").get(sessionId) as Row;
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
        const asset = this.asset(object?.assetId); this.assetPath(asset.id);
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
      const assetIds = ids(input.assetIds, 'Result assets');
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
