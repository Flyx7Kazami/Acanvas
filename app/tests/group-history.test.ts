import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { CanvasService, ApiFailure } from '../src/server/service.js';
import type { BoardOperation, BoardObject, BoardGroup } from '../src/shared/types.js';

function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'acanvas-group-history-'));
  let service = new CanvasService(root);
  const session = service.createSession('A'), other = service.createSession('B');
  writeFileSync(join(service.dataDir, 'assets/note.txt'), 'Original');
  const asset = service.registerAsset({ id: 'note', name: 'Note', mime: 'text/x-acanvas-note', size: 8, kind: 'file', createdAt: '2026-01-01T00:00:00Z' }, 'assets/note.txt');
  t.after(() => { service.close(); rmSync(root, { recursive: true, force: true }); });
  const operations = (ops: BoardOperation[], sessionId = session.id) => service.boardOperations(sessionId, ops);
  const create = (id: string, x: number, y = 0, groupId?: string) => operations([{ type: 'create', object: { id, assetId: asset.id, x, y, width: 100, height: 100, groupId } }]);
  const group = (id = 'g', members = ['a', 'b']) => operations([{ type: 'group.create', group: { id, objectIds: members, color: 'coral' }, expectedVersions: Object.fromEntries(members.map(id => [id, service.object(id).version])) }]);
  const update = (changes: Extract<BoardOperation, { type: 'group.update' }>['changes'], id = 'g', sessionId = session.id) => operations([{ type: 'group.update', groupId: id, expectedVersion: service.group(id).version, changes }], sessionId);
  const undo = () => service.boardUndo(session.id), redo = () => service.boardRedo(session.id);
  const shape = () => ({ objects: service.objects().map(clean), groups: service.groups().map(clean) });
  return { root, session, other, asset, operations, create, group, update, undo, redo, shape, get service() { return service; }, restart() { service.close(); service = new CanvasService(root); }, closeForMigration(fn: (db: Database.Database) => void) { service.close(); const db = new Database(join(root, '.acanvas/board.sqlite')); fn(db); db.close(); service = new CanvasService(root); } };
}
function clean(value: BoardObject | BoardGroup) { const { version, updatedAt, ...shape } = value; return shape; }
const conflict = (error: unknown) => error instanceof ApiFailure && error.status === 409;

test('group create, rename, move, fold and ungroup replay exact board deltas including adjacent groups', t => {
  const f = fixture(t); f.create('a', 0); f.create('b', 350); f.create('c', 600); f.create('d', 750); f.group('neighbor', ['c', 'd']);
  const before = f.shape(); f.group(); const grouped = f.shape();
  f.undo(); assert.deepEqual(f.shape(), before); f.redo(); assert.deepEqual(f.shape(), grouped);
  for (const changes of [{ name: 'References' }, { x: 100, y: 50 }, { mode: 'folder' as const }, { mode: 'frame' as const }]) {
    const previous = f.shape(); f.update(changes); const next = f.shape();
    f.undo(); assert.deepEqual(f.shape(), previous); f.redo(); assert.deepEqual(f.shape(), next);
  }
  f.update({ mode: 'folder' });
  const folder = f.shape(), neighbor = f.service.group('neighbor');
  f.operations([{ type: 'group.ungroup', groupId: 'g', expectedVersion: f.service.group('g').version }]);
  const ungrouped = f.shape(); assert.ok(f.service.group('neighbor').version >= neighbor.version);
  f.undo(); assert.deepEqual(f.shape(), folder); f.redo(); assert.deepEqual(f.shape(), ungrouped);
  f.restart(); f.undo(); assert.deepEqual(f.shape(), folder);
});

test('membership create, put and delete restore groups with stable member order and content interleaving', t => {
  const f = fixture(t); f.operations(['a', 'b'].map((id, index) => ({ type: 'create', object: { id, assetId: f.asset.id, x: index * 150, y: 0, width: 100, height: 100 } }))); f.create('loose', 400); f.group(); f.update({ mode: 'folder' });
  for (const op of [
    () => f.create('inserted', 220, 40, 'g'),
    () => f.operations([{ type: 'update', objectId: 'loose', expectedVersion: f.service.object('loose').version, changes: { groupId: 'g' } }]),
    () => f.operations([{ type: 'delete', objectId: 'a', expectedVersion: f.service.object('a').version }]),
  ]) {
    const before = f.shape(); op(); const after = f.shape(); f.undo(); assert.deepEqual(f.shape(), before); f.redo(); assert.deepEqual(f.shape(), after);
  }
  const grouped = f.shape(), object = f.service.object('b');
  f.operations([{ type: 'content', objectId: object.id, expectedVersion: object.version, text: 'Revised' }]);
  const content = f.shape(); f.update({ name: 'Edited notes' }); f.undo(); assert.deepEqual(f.shape(), content); f.undo(); assert.deepEqual(f.shape(), grouped); f.redo(); assert.deepEqual(f.shape(), content);
});

test('group versions survive recreation and history replay, while external same-value changes conflict atomically', t => {
  const f = fixture(t); f.create('a', 0); f.create('b', 200); f.group(); const version = f.service.group('g').version;
  f.undo(); f.group(); assert.ok(f.service.group('g').version > version);
  assert.throws(() => f.operations([{ type: 'group.update', groupId: 'g', expectedVersion: version, changes: { name: 'Stale' } }]), conflict);
  f.update({ name: 'Own' }); f.update({ name: 'External' }, 'g', f.other.id); f.update({ name: 'Own' }, 'g', f.other.id); const prior = f.shape();
  assert.throws(f.undo, conflict); assert.deepEqual(f.shape(), prior);
  f.update({ name: 'New own' }); f.undo(); assert.throws(f.undo, conflict);
  const a = f.service.object('a'); f.operations([{ type: 'delete', objectId: a.id, expectedVersion: a.version }], f.other.id);
  f.create('a', 0); assert.ok(f.service.object('a').version > a.version);
});

test('no-op group, membership and content writes preserve redo, versions and history rows', t => {
  const f = fixture(t); f.create('a', 0); f.create('b', 200); f.group(); f.update({ name: 'Later' }); f.undo();
  const before = f.service.state(f.session.id), rows = f.service.db.prepare('SELECT * FROM board_history').all();
  f.update({ name: f.service.group('g').name, mode: 'frame', x: f.service.group('g').x });
  f.operations([{ type: 'update', objectId: 'a', expectedVersion: f.service.object('a').version, changes: { groupId: 'g' } }]);
  f.operations([{ type: 'content', objectId: 'a', expectedVersion: f.service.object('a').version, text: 'Original' }]);
  assert.deepEqual(f.service.state(f.session.id), before); assert.deepEqual(f.service.db.prepare('SELECT * FROM board_history').all(), rows); f.redo(); assert.equal(f.service.group('g').name, 'Later');
});

test('failed content and group batches roll back assets, history, versions and automatic names', t => {
  const f = fixture(t); f.create('a', 0); f.create('b', 200); const before = f.shape(), files = readdirSync(join(f.service.dataDir, 'assets')), rows = f.service.db.prepare('SELECT * FROM board_history').all();
  assert.throws(() => f.operations([
    { type: 'content', objectId: 'a', expectedVersion: f.service.object('a').version, text: 'Temporary' },
    { type: 'group.create', group: { id: 'g', objectIds: ['a', 'b'] }, expectedVersions: { a: f.service.object('a').version + 1, b: f.service.object('b').version } },
    { type: 'update', objectId: 'b', expectedVersion: -1, changes: { x: 9 } },
  ]), conflict);
  assert.deepEqual(f.shape(), before); assert.deepEqual(readdirSync(join(f.service.dataDir, 'assets')), files); assert.deepEqual(f.service.db.prepare('SELECT * FROM board_history').all(), rows);
  f.group(); assert.equal(f.service.group('g').name, 'Group 1');
});

test('legacy object history rows migrate transactionally and remain usable across restart', t => {
  const f = fixture(t); f.create('a', 0); const created = f.service.object('a');
  f.operations([{ type: 'update', objectId: 'a', expectedVersion: created.version, changes: { x: 25 } }]);
  const rows = f.service.db.prepare('SELECT * FROM board_history').all() as any[];
  f.closeForMigration(db => { for (const row of rows) db.prepare('UPDATE board_history SET before_json=?,after_json=? WHERE session_id=? AND position=?').run(JSON.stringify(JSON.parse(row.before_json).objects), JSON.stringify(JSON.parse(row.after_json).objects), row.session_id, row.position); });
  f.undo(); assert.equal(f.service.object('a').x, 0); f.undo(); assert.equal(f.service.objects().length, 0); f.redo(); f.redo(); assert.equal(f.service.object('a').x, 25);
  f.restart(); f.undo(); assert.equal(f.service.object('a').x, 0); assert.equal((f.service.db.prepare('SELECT COUNT(*) AS count FROM board_history').get() as any).count, rows.length);
});


test('member fill history leaves unchanged group geometry available for earlier rename undo', t => {
  const f = fixture(t); f.create('a', 0); f.create('b', 200); f.group(); const originalName = f.service.group('g').name;
  f.update({ name: 'Renamed' }); const groupVersion = f.service.group('g').version;
  const result = f.operations([{ type: 'update', objectId: 'a', expectedVersion: f.service.object('a').version, changes: { fill: 'sage' } }]);
  assert.equal(f.service.group('g').version, groupVersion); assert.deepEqual(result.versionChanges.groups, []);
  assert.equal(result.versionChanges.objects.length, 1); f.undo(); f.undo(); assert.equal(f.service.group('g').name, originalName);
});

test('collateral move followed by deletion keeps object versions monotonic through recreation', t => {
  const f = fixture(t); f.create('a', 0); f.create('b', 200); f.group(); const prior = f.service.object('a');
  f.operations([
    { type: 'group.update', groupId: 'g', expectedVersion: f.service.group('g').version, changes: { x: 100 } },
    { type: 'delete', objectId: 'a', expectedVersion: prior.version + 1 },
  ]);
  f.create('a', 0); assert.ok(f.service.object('a').version > prior.version + 1);
});

test('completion publishes immutable content and groups in one history step with an atomic receipt', t => {
  const f = fixture(t); f.create('a', 0); f.create('b', 200);
  const draft = f.service.draft(f.session.id), saved = f.service.saveDraft(f.session.id, { ...draft, text: 'Publish notes' });
  const submitted = f.service.sendDraft(f.session.id, saved.id, saved.revision);
  const claim = f.service.claim(f.session.id, 'publisher'), before = f.shape();
  const input = { consumerId: 'publisher', runId: claim.run!.id, summary: 'Published notes', assetIds: [], validation: [], operations: [
    { type: 'content' as const, objectId: 'a', expectedVersion: f.service.object('a').version, text: 'Published' },
    { type: 'group.create' as const, group: { id: 'g', objectIds: ['a', 'b'] }, expectedVersions: { a: f.service.object('a').version + 1, b: f.service.object('b').version } },
  ] };
  const files = readdirSync(join(f.service.dataDir, 'assets'));
  assert.throws(() => f.service.complete(f.session.id, submitted.task.id, { ...input, operations: [...input.operations, { type: 'delete', objectId: 'b', expectedVersion: -1 }] }), conflict);
  assert.deepEqual(f.shape(), before); assert.deepEqual(readdirSync(join(f.service.dataDir, 'assets')), files); assert.equal(f.service.task(f.session.id, submitted.task.id).receipt, null);
  const completed = f.service.complete(f.session.id, submitted.task.id, input), published = f.shape();
  assert.deepEqual(new Set(completed.receipt!.objectIds), new Set(['a', 'b'])); assert.ok(completed.receipt!.assetIds.includes(f.service.object('a').assetId));
  f.undo(); assert.deepEqual(f.shape(), before); f.redo(); assert.deepEqual(f.shape(), published); assert.deepEqual(f.service.task(f.session.id, submitted.task.id).receipt, completed.receipt);
});


test('interior member geometry increments the group version while its outer bounds stay fixed', t => {
  const f = fixture(t); f.create('a', 0); f.create('b', 400); f.create('inner', 200); f.group('g', ['a', 'inner', 'b']);
  const before = f.service.group('g'); f.operations([{ type: 'update', objectId: 'inner', expectedVersion: f.service.object('inner').version, changes: { x: 220 } }]);
  const after = f.service.group('g'); assert.deepEqual([after.x, after.y, after.width, after.height], [before.x, before.y, before.width, before.height]); assert.ok(after.version > before.version);
  assert.throws(() => f.operations([{ type: 'group.update', groupId: 'g', expectedVersion: before.version, changes: { x: 800 } }]), conflict); f.undo(); assert.equal(f.service.object('inner').x, 200); f.undo(); assert.equal(f.service.groups().length, 0);
});
