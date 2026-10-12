import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { CanvasService, ApiFailure } from '../src/server/service.js';
import { startServer } from '../src/server/http.js';
import { cli } from '../src/cli.js';
import { annotationTarget, sameAnnotationTarget } from '../src/server/annotation-capture.js';
import { GROUP_CAPTION_SPACE, GROUP_FOLDER_ART_HEIGHT, GROUP_FOLDER_HEIGHT, GROUP_PADDING, groupDisplayBounds, groupFrameBounds, layoutGroupTransition } from '../src/shared/groups.js';
import type { AnnotationInput, BoardOperation, Bounds, ScenePresentation } from '../src/shared/types.js';

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'acanvas-groups-'));
  let service = new CanvasService(root), open = true;
  t.after(async () => { if (open) service.close(); await rm(root, { recursive: true, force: true }); });
  const session = service.createSession('Groups');
  const bytes = Buffer.from('group member source');
  await writeFile(join(service.dataDir, 'assets/source.png'), bytes);
  const asset = service.registerAsset({ id: 'source', name: 'Source', mime: 'image/png', size: bytes.length, kind: 'image', createdAt: '2026-01-01T00:00:00Z' }, 'assets/source.png');
  const operations = (input: BoardOperation[]) => service.boardOperations(session.id, input);
  const create = (id: string, x: number, y: number, width = 100, height = 100, groupId?: string) => operations([{ type: 'create', object: { id, assetId: asset.id, x, y, width, height, ...(groupId ? { groupId } : {}) } }]);
  const group = (objectIds: string[], id = 'group') => operations([{ type: 'group.create', group: { id, objectIds, texture: 'rays' }, expectedVersions: Object.fromEntries(objectIds.map(id => [id, service.object(id).version])) }]);
  const update = (changes: Extract<BoardOperation, { type: 'group.update' }>['changes'], id = 'group') => operations([{ type: 'group.update', groupId: id, expectedVersion: service.group(id).version, changes }]);
  return { root, session, asset, operations, create, group, update, get service() { return service; }, close() { service.close(); open = false; }, restart() { if (open) service.close(); service = new CanvasService(root); open = true; } };
}
const apiError = (status: number, code: string) => (error: unknown) => error instanceof ApiFailure && error.status === status && error.code === code;
const bounds = (x: number, y: number, width: number, height: number): Bounds => ({ x, y, width, height });

test('frame bounds include title and caption space, negative coordinates, and an empty fallback', () => {
  assert.deepEqual(groupFrameBounds([bounds(-100, -50, 30, 40), bounds(20, 80, 100, 20)]), bounds(-124, -90, 268, 246));
  const framed = groupFrameBounds([bounds(0, 0, 100, 100)]);
  assert.equal(framed.y + framed.height - 100, GROUP_CAPTION_SPACE + GROUP_PADDING);
  assert.deepEqual(groupFrameBounds([], bounds(9, 8, 7, 6)), bounds(9, 8, 7, 6));
  assert.deepEqual(groupFrameBounds([]), bounds(0, 0, 240, GROUP_FOLDER_ART_HEIGHT));
  assert.deepEqual(groupDisplayBounds({ ...bounds(-124, -90, 268, 246), mode: 'folder' }), bounds(-124, -90, 240, GROUP_FOLDER_HEIGHT));
});

test('folding moves the right band first, then the lower band, with obstacles and distance limits', () => {
  const units = [
    { id: 'g', ...bounds(-100, -100, 500, 400) },
    { id: 'right', ...bounds(424, -50, 100, 80) },
    { id: 'far-right', ...bounds(724, -50, 100, 80) },
    { id: 'below', ...bounds(-50, 324, 100, 100) },
    { id: 'obstacle', ...bounds(170, 100, 60, 50) },
    { id: 'blocked', ...bounds(424, 100, 100, 40) },
    { id: 'left', ...bounds(-300, 0, 100, 100) },
    { id: 'far', ...bounds(1000, 1000, 100, 100) },
  ];
  const result = layoutGroupTransition(units, 'g', bounds(-100, -100, 240, GROUP_FOLDER_HEIGHT));
  assert.equal(result.get('right')!.x, 164);
  assert.equal(result.get('far-right')!.x, 464);
  assert.equal(result.get('below')!.y, 136);
  assert.equal(result.get('blocked')!.x, 254);
  assert.equal(result.has('left'), false); assert.equal(result.has('far'), false);
});

test('growing dimensions push same-direction chains while other strips stay fixed', () => {
  const units = [
    { id: 'g', ...bounds(0, 0, 240, GROUP_FOLDER_HEIGHT) },
    { id: 'right', ...bounds(264, 20, 100, 80) },
    { id: 'chain', ...bounds(388, 20, 100, 80) },
    { id: 'below', ...bounds(30, 236, 100, 100) },
    { id: 'top', ...bounds(264, -120, 100, 80) },
    { id: 'left', ...bounds(-124, 236, 100, 100) },
  ];
  const result = layoutGroupTransition(units, 'g', bounds(0, 0, 500, 400));
  assert.equal(result.get('right')!.x, 524); assert.equal(result.get('chain')!.x, 648);
  assert.equal(result.get('below')!.y, 424);
  assert.equal(result.has('top'), false); assert.equal(result.has('left'), false);
});

test('a folder larger than its frame makes space in both dimensions', () => {
  const result = layoutGroupTransition([
    { id: 'g', ...bounds(-50, -80, 100, 100) },
    { id: 'right', ...bounds(74, -40, 40, 40) },
    { id: 'below', ...bounds(-10, 44, 40, 40) },
  ], 'g', bounds(-50, -80, 240, GROUP_FOLDER_HEIGHT));
  assert.equal(result.get('right')!.x, 214);
  assert.equal(result.get('below')!.y, 156);
});

test('existing overlapping items stay in place during compaction', () => {
  const result = layoutGroupTransition([
    { id: 'g', ...bounds(0, 0, 500, 400) },
    { id: 'obstacle', ...bounds(490, 20, 100, 100) },
    { id: 'right', ...bounds(524, 20, 100, 100) },
  ], 'g', bounds(0, 0, 240, GROUP_FOLDER_HEIGHT));
  assert.equal(result.has('right'), false);
});

test('groups share member identity, ordered previews, source assets and histories across sessions', async t => {
  const f = await fixture(t);
  f.create('b', 10, 20); f.create('a', 210, 20);
  const initial = f.service.object('b');
  f.group(['a', 'b']);
  const group = f.service.group('group');
  assert.deepEqual(group.objectIds, ['b', 'a']); assert.equal(group.mode, 'frame'); assert.equal(group.texture, 'rays');
  assert.deepEqual(groupFrameBounds(f.service.objects()), bounds(-14, -20, 348, 196));
  assert.equal(f.service.object('b').assetId, initial.assetId); assert.equal(f.service.object('b').groupId, group.id); assert.equal(f.service.object('b').version, 2);
  const other = f.service.createSession('Other'); assert.deepEqual(f.service.state(other.id).groups, [group]);
  let draft = f.service.draft(f.session.id);
  draft = f.service.saveDraft(f.session.id, { ...draft, text: 'Keep these references', references: { objectIds: ['a', 'b'], taskIds: [] } });
  const task = f.service.sendDraft(f.session.id, draft.id, draft.revision).task;
  f.update({ mode: 'folder' });
  assert.equal(f.service.task(f.session.id, task.id).snapshot.referenceContent.objects[0].id, 'a');
  assert.equal(f.service.task(f.session.id, task.id).snapshot.referenceContent.objects[0].groupId, group.id);
  f.operations([{ type: 'group.ungroup', groupId: group.id, expectedVersion: f.service.group(group.id).version }]);
  assert.equal(f.service.object('a').groupId, undefined); assert.equal(f.service.task(f.session.id, task.id).snapshot.referenceContent.objects[0].groupId, group.id);
  assert.equal(f.service.assetPath(initial.assetId).endsWith('source.png'), true);
});

test('folding moves adjacent groups as atomic units, with member and group versions', async t => {
  const f = await fixture(t);
  f.create('a', 24, 40, 200, 200); f.create('b', 300, 280, 176, 96); f.group(['a', 'b']);
  assert.deepEqual(groupDisplayBounds(f.service.group('group')), bounds(0, 0, 500, 432));
  f.create('n1', 548, 70, 80, 80); f.create('n2', 648, 70, 80, 80); f.group(['n1', 'n2'], 'neighbor');
  const before = f.service.group('neighbor'), member = f.service.object('n1');
  f.update({ mode: 'folder' });
  const after = f.service.group('neighbor');
  assert.equal(after.x, 264); assert.equal(after.y, before.y); assert.equal(after.version, before.version + 1);
  assert.equal(f.service.object('n1').x, member.x - 260); assert.equal(f.service.object('n2').x - f.service.object('n1').x, 100);
  assert.equal(f.service.object('n1').version, member.version + 1);
  f.update({ mode: 'frame' });
  assert.equal(f.service.group('neighbor').x, 524);
});

test('folding places items below the folder caption with a full layout gap', async t => {
  const f = await fixture(t);
  f.create('a', 24, 40, 200, 200); f.create('b', 300, 280, 176, 96); f.group(['a', 'b']);
  const frame = f.service.group('group');
  f.create('below', 30, frame.y + frame.height + GROUP_PADDING, 100, 100);
  f.update({ mode: 'folder' });
  const folder = f.service.group('group'), below = f.service.object('below');
  assert.equal(groupDisplayBounds(folder).height, GROUP_FOLDER_ART_HEIGHT + GROUP_CAPTION_SPACE);
  assert.equal(below.y, folder.y + GROUP_FOLDER_ART_HEIGHT + GROUP_CAPTION_SPACE + GROUP_PADDING);
});

test('folder member edits preserve its anchor and expansion aligns current geometry', async t => {
  const f = await fixture(t);
  f.create('a', 24, 40); f.create('b', 300, 200); f.group(['a', 'b']); f.update({ mode: 'folder' });
  const original = f.service.group('group'), current = f.service.object('a');
  f.operations([{ type: 'update', objectId: 'a', expectedVersion: current.version, changes: { x: -200, y: -300 } }]);
  const edited = f.service.group('group');
  assert.equal(edited.x, original.x); assert.equal(edited.y, original.y); assert.equal(edited.version, original.version + 1);
  const separation = f.service.object('b').x - f.service.object('a').x;
  f.update({ x: 100, y: 120 });
  assert.equal(f.service.group('group').x, 100); assert.equal(f.service.object('a').x, -100);
  f.update({ mode: 'frame' });
  assert.deepEqual(groupFrameBounds(f.service.objects()), bounds(100, 120, 648, 696));
  assert.equal(f.service.object('b').x - f.service.object('a').x, separation);
});

test('group versions detect member edits and transaction conflicts roll back all changes', async t => {
  const f = await fixture(t);
  f.create('a', 0, 0); f.create('b', 200, 0);
  assert.throws(() => f.operations([{ type: 'group.create', group: { id: 'group', objectIds: ['a', 'b'] }, expectedVersions: { a: 1, b: 0 } }]), apiError(409, 'object_conflict'));
  assert.equal(f.service.groups().length, 0); assert.equal(f.service.object('a').version, 1);
  f.group(['a', 'b']); const version = f.service.group('group').version;
  f.operations([{ type: 'update', objectId: 'a', expectedVersion: 2, changes: { x: 40 } }]);
  assert.throws(() => f.operations([{ type: 'group.update', groupId: 'group', expectedVersion: version, changes: { mode: 'folder' } }]), apiError(409, 'group_conflict'));
  const group = f.service.group('group'), before = f.service.object('a');
  assert.throws(() => f.operations([
    { type: 'group.update', groupId: 'group', expectedVersion: group.version, changes: { x: 500 } },
    { type: 'delete', objectId: 'b', expectedVersion: 0 },
  ]), apiError(409, 'object_conflict'));
  assert.deepEqual(f.service.group('group'), group); assert.deepEqual(f.service.object('a'), before);
  assert.throws(() => f.group(['a', 'b'], 'other'), apiError(409, 'group_membership_conflict'));
  assert.throws(() => f.create('missing-group', 0, 0, 100, 100, 'missing'), apiError(404, 'group_missing'));
});

test('member insertion and deletion refresh dimensions, preserve empty groups and preview order', async t => {
  const f = await fixture(t);
  f.create('first', 0, 0); f.create('second', 200, 0); f.group(['first', 'second']); f.update({ mode: 'folder' });
  const before = f.service.group('group'); f.create('third', 800, 900, 100, 100, 'group');
  assert.equal(f.service.group('group').version, before.version + 1);
  assert.deepEqual(f.service.group('group').objectIds, ['first', 'second', 'third']);
  f.operations(f.service.objects().map(object => ({ type: 'delete', objectId: object.id, expectedVersion: object.version })));
  const empty = f.service.group('group'); assert.deepEqual(empty.objectIds, []); assert.equal(empty.mode, 'folder');
  assert.equal(empty.width, 948); assert.equal(empty.height, 1096);
  f.create('new', -100, -200, 100, 100, 'group');
  assert.deepEqual(f.service.group('group').objectIds, ['new']); assert.equal(f.service.group('group').x, before.x);
});

test('folder ungroup expands and makes space, then restores session cameras', async t => {
  const f = await fixture(t);
  f.create('a', 24, 40, 200, 200); f.create('b', 300, 280, 176, 96); f.group(['a', 'b']); f.update({ mode: 'folder' });
  f.create('right', 264, 20, 100, 100);
  f.service.saveView(f.session.id, { x: -300, y: 200, zoom: .5, selectedObjectIds: ['a'], activeGroupId: 'group', parentView: { x: 52, y: 84, zoom: 1.5 } });
  f.operations([{ type: 'group.ungroup', groupId: 'group', expectedVersion: f.service.group('group').version }]);
  assert.equal(f.service.groups().length, 0); assert.equal(f.service.object('right').x, 524); assert.equal(f.service.object('a').groupId, undefined);
  assert.deepEqual(f.service.session(f.session.id).view, { x: 52, y: 84, zoom: 1.5, selectedObjectIds: ['a'] });
});

test('folder views and group snapshots persist across restart and complete directory restoration', async t => {
  const f = await fixture(t);
  f.create('a', 10, 20); f.create('b', 210, 20); f.group(['a', 'b']); f.update({ name: 'Research', mode: 'folder' });
  const group = f.service.group('group');
  f.service.saveView(f.session.id, { x: 100, y: 200, zoom: .75, selectedObjectIds: ['a'], activeGroupId: group.id, parentView: { x: -10, y: -20, zoom: .8 } });
  const view = f.service.registerCaptureView(f.session.id, { documentId: 'document' });
  const scene = f.service.sceneSnapshot(f.session.id, view.viewId, { documentId: view.documentId, viewGeneration: view.viewGeneration, operationSeq: 1 });
  assert.deepEqual(scene.groups, [group]); assert.equal(scene.objects.length, 2);
  f.restart(); assert.deepEqual(f.service.group('group'), group); assert.equal(f.service.session(f.session.id).view.activeGroupId, 'group');
  f.close();
  const restoredRoot = await mkdtemp(join(tmpdir(), 'acanvas-groups-restored-'));
  t.after(() => rm(restoredRoot, { recursive: true, force: true }));
  await cp(join(f.root, '.acanvas'), join(restoredRoot, '.acanvas'), { recursive: true });
  const restored = new CanvasService(restoredRoot);
  try { assert.deepEqual(restored.group('group'), group); assert.equal(restored.object('a').assetId, f.asset.id); assert.equal(restored.session(f.session.id).view.parentView!.zoom, .8); assert.equal(restored.assetPath(f.asset.id).startsWith(restored.root), true); }
  finally { restored.close(); }
});

test('existing databases gain a nullable group membership column and preserve their objects', async t => {
  const f = await fixture(t); f.create('old', -20, -30); const before = f.service.object('old'); f.close();
  const db = new Database(join(f.root, '.acanvas/board.sqlite'));
  db.exec('DROP INDEX objects_group_id; ALTER TABLE objects DROP COLUMN group_id; DROP TABLE groups'); db.close();
  f.restart(); assert.deepEqual(f.service.object('old'), before); assert.deepEqual(f.service.groups(), []);
  f.create('new', 100, 200); f.group(['old', 'new']); assert.equal(f.service.group('group').objectIds.length, 2);
});

test('folder region annotation context survives target normalization, history and ungroup', async t => {
  const f = await fixture(t); f.create('a', 0, 0); f.create('b', 200, 0); f.group(['a', 'b']); f.update({ mode: 'folder' });
  const annotation: AnnotationInput = { id: 'blank', boardGroupId: 'group', scope: 'region', coordinateSpace: 'world', objectIds: [], bounds: bounds(50, 50, 30, 30), text: 'Keep this spacing' };
  assert.equal(annotationTarget(annotation).boardGroupId, 'group'); assert.equal(sameAnnotationTarget(annotation, { ...annotation, boardGroupId: undefined }), false);
  let draft = f.service.draft(f.session.id); draft = f.service.saveDraft(f.session.id, { ...draft, annotations: [annotation] });
  const task = f.service.sendDraft(f.session.id, draft.id, draft.revision).task;
  f.operations([{ type: 'group.ungroup', groupId: 'group', expectedVersion: f.service.group('group').version }]);
  assert.equal(f.service.task(f.session.id, task.id).snapshot.annotations[0].boardGroupId, 'group');
  assert.match(f.service.task(f.session.id, task.id).requirementText, /boardGroupId.*group/);
});

test('fresh annotation contexts require an existing folder while saved contexts remain readable', async t => {
  const f = await fixture(t); f.create('a', 0, 0); f.create('b', 200, 0); f.group(['a', 'b']);
  const base: AnnotationInput = { id: 'blank', boardGroupId: 'missing', scope: 'region', coordinateSpace: 'world', objectIds: [], bounds: bounds(50, 50, 30, 30), text: 'Spacing' };
  let draft = f.service.draft(f.session.id);
  assert.throws(() => f.service.saveDraft(f.session.id, { ...draft, annotations: [base] }), apiError(400, 'invalid_annotation'));
  assert.throws(() => f.service.saveDraft(f.session.id, { ...draft, annotations: [{ ...base, boardGroupId: 'group' }] }), apiError(400, 'invalid_annotation'));
  f.update({ mode: 'folder' });
  assert.throws(() => f.service.saveDraft(f.session.id, { ...draft, annotations: [{ ...base, boardGroupId: ' group ' }] }), apiError(400, 'invalid_annotation'));
  draft = f.service.saveDraft(f.session.id, { ...draft, annotations: [{ ...base, boardGroupId: 'group' }] });
  f.operations([{ type: 'group.ungroup', groupId: 'group', expectedVersion: f.service.group('group').version }]);
  draft = f.service.saveDraft(f.session.id, { ...draft, text: 'Keep the saved annotation' });
  assert.equal(draft.annotations[0].boardGroupId, 'group');
  assert.throws(() => f.service.saveDraft(f.session.id, { ...draft, annotations: [{ ...draft.annotations[0], id: 'new' }] }), apiError(400, 'invalid_annotation'));
});

test('a held folder scene retains region context after its live group is removed', async t => {
  const f = await fixture(t); f.create('a', 0, 0); f.create('b', 200, 0); f.group(['a', 'b']); f.update({ mode: 'folder' });
  const view = f.service.registerCaptureView(f.session.id, { documentId: 'folder-scene' });
  const operation = { documentId: view.documentId, viewGeneration: view.viewGeneration };
  const scene = f.service.sceneSnapshot(f.session.id, view.viewId, { ...operation, operationSeq: 1 });
  const presentation: ScenePresentation = { documentId: view.documentId, viewId: view.viewId, frameSeq: 1, baseSceneId: scene.id, camera: { x: 0, y: 0, zoom: 1 }, cssViewport: bounds(0, 0, 800, 600), bitmap: { width: 800, height: 600 }, layers: [], media: [] };
  f.service.confirmScenePresentation(f.session.id, view.viewId, { ...operation, operationSeq: 2, presentation });
  const source = f.service.holdScenePresentation(f.session.id, view.viewId, { ...operation, operationSeq: 3, presentation });
  f.operations([{ type: 'group.ungroup', groupId: 'group', expectedVersion: f.service.group('group').version }]);
  const annotation: AnnotationInput = { id: 'frozen', boardGroupId: 'group', scope: 'region', coordinateSpace: 'world', objectIds: [], bounds: bounds(50, 50, 30, 30), text: 'Keep this spacing', captureState: { version: 1, status: 'incomplete' }, sceneSource: source };
  let draft = f.service.draft(f.session.id); draft = f.service.saveDraft(f.session.id, { ...draft, annotations: [annotation] });
  assert.equal(draft.annotations[0].boardGroupId, 'group');
  draft = f.service.saveDraft(f.session.id, { ...draft, annotations: [{ ...draft.annotations[0], text: 'Edited historical comment' }] });
  assert.equal(draft.annotations[0].captureState!.version, 1);
});

test('group changes require a plain object and reject array payloads without incrementing versions', async t => {
  const f = await fixture(t); f.create('a', 0, 0); f.create('b', 200, 0); f.group(['a', 'b']);
  const before = f.service.group('group');
  assert.throws(() => f.operations([{ type: 'group.update', groupId: 'group', expectedVersion: before.version, changes: [] as any }]), apiError(400, 'invalid_group'));
  assert.deepEqual(f.service.group('group'), before);
});

test('CLI and authenticated HTTP expose the same group operations', async t => {
  const root = await mkdtemp(join(tmpdir(), 'acanvas-groups-cli-')), running = await startServer({ root, port: 0 });
  t.after(async () => { await running.close(); await rm(root, { recursive: true, force: true }); });
  const bootstrap = await (await fetch(`${running.url}/api/bootstrap`)).json();
  const headers = { Authorization: `Bearer ${bootstrap.token}`, 'Content-Type': 'application/json' };
  const session = await (await fetch(`${running.url}/api/sessions`, { method: 'POST', headers, body: JSON.stringify({ name: 'CLI' }) })).json();
  const upload = await (await fetch(`${running.url}/api/assets?name=source.png&mime=image/png`, { method: 'POST', headers: { Authorization: headers.Authorization }, body: 'source' })).json();
  const input = join(root, 'operations.json');
  await writeFile(input, JSON.stringify({ operations: ['a', 'b'].map((id, index) => ({ type: 'create', object: { id, assetId: upload.id, x: index * 200, y: 0, width: 100, height: 100 } })) }));
  await cli(['board', 'operations', '--project', root, '--url', running.url, '--session', session.id, '--input', input]);
  await writeFile(input, JSON.stringify({ operations: [{ type: 'group.create', group: { id: 'group', objectIds: ['a', 'b'] }, expectedVersions: { a: 1, b: 1 } }] }));
  const result = await cli(['board', 'operations', '--project', root, '--url', running.url, '--session', session.id, '--input', input]) as any;
  assert.equal(result.groups[0].id, 'group'); assert.equal(result.objects[0].groupId, 'group');
  const stale = await fetch(`${running.url}/api/board/operations`, { method: 'POST', headers, body: JSON.stringify({ sessionId: session.id, operations: [{ type: 'group.update', groupId: 'group', expectedVersion: 0, changes: { mode: 'folder' } }] }) });
  assert.equal(stale.status, 409);
});
