import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../src/server/http.js';
import { cli } from '../src/cli.js';
import type { Asset, BoardObject, BoardState } from '../src/shared/types.js';

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'acanvas-board-history-'));
  let running = await startServer({ root, port: 0 });
  let bootstrap = await (await fetch(`${running.url}/api/bootstrap`)).json() as { token: string };
  const raw = (path: string, method = 'GET', body?: unknown) => fetch(`${running.url}${path}`, {
    method,
    headers: { Authorization: `Bearer ${bootstrap.token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const call = async <T = any>(path: string, method = 'GET', body?: unknown, expected = 200) => {
    const response = await raw(path, method, body), value = await response.json() as T;
    assert.equal(response.status, expected, JSON.stringify(value));
    return value;
  };
  const session = (name: string) => call<{ id: string }>('/api/sessions', 'POST', { name }, 201);
  const state = (id: string) => call<BoardState>(`/api/state?sessionId=${encodeURIComponent(id)}`);
  const upload = async (name = 'note.txt', mime = 'text/x-acanvas-note', query = '') => {
    const response = await fetch(`${running.url}/api/assets?name=${encodeURIComponent(name)}&mime=${encodeURIComponent(mime)}${query}`, { method: 'POST', headers: { Authorization: `Bearer ${bootstrap.token}` }, body: 'A note' });
    assert.equal(response.status, 201);
    return await response.json() as Asset;
  };
  const sendTask = async (sessionId: string) => {
    const draft = (await state(sessionId)).draft;
    const saved = await call<{ revision: number }>(`/api/sessions/${encodeURIComponent(sessionId)}/draft`, 'PUT', { ...draft, text: 'Publish these board outputs.' });
    return call<{ task: { id: string } }>(`/api/sessions/${encodeURIComponent(sessionId)}/tasks`, 'POST', { draftId: draft.id, expectedRevision: saved.revision });
  };
  const operations = (sessionId: string, value: unknown, expected = 200) => call<{ objects: BoardObject[]; history: BoardState['history'] }>('/api/board/operations', 'POST', { sessionId, operations: value }, expected);
  const undo = (sessionId: string) => call<{ objects: BoardObject[]; history: BoardState['history'] }>('/api/board/undo', 'POST', { sessionId });
  const redo = (sessionId: string) => call<{ objects: BoardObject[]; history: BoardState['history'] }>('/api/board/redo', 'POST', { sessionId });
  t.after(async () => { await running.close(); await rm(root, { recursive: true, force: true }); });
  return {
    root, raw, call, session, state, upload, sendTask, operations, undo, redo,
    get url() { return running.url; },
    async restart() { await running.close(); running = await startServer({ root, port: 0 }); bootstrap = await (await fetch(`${running.url}/api/bootstrap`)).json() as { token: string }; },
  };
}

test('board history keeps IDs and fill through continuous undo/redo', async t => {
  const f = await fixture(t), a = await f.session('A'), asset = await f.upload();
  const created = (await f.operations(a.id, [{ type: 'create', object: { id: 'stable-note', assetId: asset.id, x: 10, y: 20, width: 100, height: 80 } }])).objects.find(object => object.id === 'stable-note')!;
  const moved = (await f.operations(a.id, [{ type: 'update', objectId: created.id, expectedVersion: created.version, changes: { x: 40, y: 60 } }])).objects.find(object => object.id === created.id)!;
  const colored = (await f.operations(a.id, [{ type: 'update', objectId: created.id, expectedVersion: moved.version, changes: { fill: 'sage' } }])).objects.find(object => object.id === created.id)!;
  assert.equal(colored.id, created.id);
  assert.equal(colored.fill, 'sage');
  assert.ok(colored.version > moved.version);
  assert.deepEqual((await f.state(a.id)).history, { canUndo: true, canRedo: false });

  const afterColorUndo = await f.undo(a.id), undoColor = afterColorUndo.objects.find(object => object.id === created.id)!;
  assert.equal(undoColor.x, 40); assert.equal(undoColor.fill, undefined); assert.ok(undoColor.version > colored.version);
  const afterMoveUndo = await f.undo(a.id), undoMove = afterMoveUndo.objects.find(object => object.id === created.id)!;
  assert.equal(undoMove.x, 10); assert.equal(undoMove.y, 20); assert.equal(undoMove.version > undoColor.version, true);
  const afterCreateUndo = await f.undo(a.id);
  assert.equal(afterCreateUndo.objects.some(object => object.id === created.id), false);
  assert.deepEqual(afterCreateUndo.history, { canUndo: false, canRedo: true });
  const restored = (await f.redo(a.id)).objects.find(object => object.id === created.id)!;
  assert.equal(restored.id, created.id); assert.equal(restored.x, 10); assert.equal(restored.fill, undefined); assert.ok(restored.version > created.version);
  const restoredMoved = (await f.redo(a.id)).objects.find(object => object.id === created.id)!;
  assert.equal(restoredMoved.x, 40); assert.ok(restoredMoved.version > restored.version);
  const restoredColored = (await f.redo(a.id)).objects.find(object => object.id === created.id)!;
  assert.equal(restoredColored.fill, 'sage'); assert.ok(restoredColored.version > restoredMoved.version);
  assert.deepEqual((await f.state(a.id)).history, { canUndo: true, canRedo: false });
});

test('delete undo redo preserves monotonic versions and rejects stale writes', async t => {
  const f = await fixture(t), a = await f.session('A'), asset = await f.upload();
  const created = (await f.operations(a.id, [{ type: 'create', object: { assetId: asset.id, x: 0, y: 0, width: 40, height: 40 } }])).objects[0];
  await f.operations(a.id, [{ type: 'delete', objectId: created.id, expectedVersion: created.version }]);
  const restored = (await f.undo(a.id)).objects.find(object => object.id === created.id)!;
  assert.ok(restored.version > created.version);
  await f.operations(a.id, [{ type: 'update', objectId: restored.id, expectedVersion: created.version, changes: { x: 10 } }], 409);
  const afterRedo = await f.redo(a.id);
  assert.equal(afterRedo.objects.some(object => object.id === created.id), false);
  const afterFinalUndo = await f.undo(a.id), final = afterFinalUndo.objects.find(object => object.id === created.id)!;
  assert.ok(final.version > restored.version);
  await f.operations(a.id, [{ type: 'update', objectId: final.id, expectedVersion: created.version, changes: { x: 20 } }], 409);
});

test('history is session scoped, conflict atomic, persists across restart, and clears redo only on a write', async t => {
  const f = await fixture(t), a = await f.session('A'), b = await f.session('B'), asset = await f.upload();
  const first = (await f.operations(a.id, [{ type: 'create', object: { assetId: asset.id, x: 0, y: 0, width: 50, height: 50 } }])).objects[0];
  const second = (await f.operations(b.id, [{ type: 'create', object: { assetId: asset.id, x: 100, y: 0, width: 50, height: 50 } }])).objects.find(object => object.id !== first.id)!;
  assert.equal((await f.undo(a.id)).objects.some(object => object.id === first.id), false);
  assert.equal((await f.state(b.id)).objects.some(object => object.id === second.id), true);
  await f.redo(a.id);
  const moved = (await f.operations(a.id, [{ type: 'update', objectId: first.id, expectedVersion: first.version + 1, changes: { x: 20 } }])).objects.find(object => object.id === first.id)!;
  await f.operations(b.id, [{ type: 'update', objectId: first.id, expectedVersion: moved.version, changes: { x: 30 } }]);
  const conflict = await f.raw('/api/board/undo', 'POST', { sessionId: a.id });
  assert.equal(conflict.status, 409);
  assert.equal((await f.state(a.id)).history.canUndo, true);
  const failedState = await f.state(a.id);
  await f.operations(a.id, [{ type: 'update', objectId: first.id, expectedVersion: moved.version, changes: { x: 20 } }], 409);
  assert.equal((await f.state(a.id)).history.canUndo, failedState.history.canUndo);

  const revertedForeignMove = await f.undo(b.id);
  assert.equal(revertedForeignMove.objects.find(object => object.id === first.id)?.x, 20);
  assert.equal(revertedForeignMove.objects.some(object => object.id === second.id), true);
  const clean = await f.undo(b.id); // B's own create remains independently undoable.
  assert.equal(clean.objects.some(object => object.id === second.id), false);
  await f.restart();
  const persisted = await f.state(a.id);
  assert.equal(persisted.history.canUndo, true);
  assert.equal(persisted.history.canRedo, false);
  const beforeNoop = persisted.objects.find(object => object.id === first.id)!;
  await f.operations(a.id, [{ type: 'update', objectId: first.id, expectedVersion: beforeNoop.version, changes: { x: beforeNoop.x } }]);
  assert.deepEqual((await f.state(a.id)).history, { canUndo: true, canRedo: false });
});

test('an external same-value write remains a conflict after the session undoes its later write', async t => {
  const f = await fixture(t), a = await f.session('A'), b = await f.session('B'), asset = await f.upload();
  const created = (await f.operations(a.id, [{ type: 'create', object: { assetId: asset.id, x: 0, y: 0, width: 40, height: 40 } }])).objects[0];
  const movedAway = (await f.operations(b.id, [{ type: 'update', objectId: created.id, expectedVersion: created.version, changes: { x: 10 } }])).objects[0];
  const external = (await f.operations(b.id, [{ type: 'update', objectId: created.id, expectedVersion: movedAway.version, changes: { x: created.x } }])).objects[0];
  const changed = (await f.operations(a.id, [{ type: 'update', objectId: created.id, expectedVersion: external.version, changes: { x: 25 } }])).objects[0];
  const afterOwnUndo = await f.undo(a.id), restored = afterOwnUndo.objects.find(object => object.id === created.id)!;
  assert.equal(restored.x, created.x); assert.ok(restored.version > changed.version);
  const conflict = await f.raw('/api/board/undo', 'POST', { sessionId: a.id });
  assert.equal(conflict.status, 409);
  assert.equal((await f.state(a.id)).objects.find(object => object.id === created.id)?.id, created.id);
});

test('a multi-object history step rejects one external touch atomically', async t => {
  const f = await fixture(t), a = await f.session('A'), b = await f.session('B'), asset = await f.upload();
  const created = (await f.operations(a.id, ['left', 'right'].map((id, index) => ({ type: 'create', object: { id, assetId: asset.id, x: index * 120, y: 10, width: 80, height: 60 } })))).objects.filter(object => ['left', 'right'].includes(object.id));
  const moved = (await f.operations(a.id, created.map(object => ({ type: 'update', objectId: object.id, expectedVersion: object.version, changes: { x: object.x + 300, y: 220 } })))).objects.filter(object => created.some(value => value.id === object.id));
  await f.operations(b.id, [{ type: 'update', objectId: moved[0].id, expectedVersion: moved[0].version, changes: { x: 999 } }]);
  const conflict = await f.raw('/api/board/undo', 'POST', { sessionId: a.id }), after = await f.state(a.id);
  assert.equal(conflict.status, 409);
  const current = after.objects.filter(object => moved.some(value => value.id === object.id)).sort((left, right) => left.id.localeCompare(right.id));
  const expected = [moved.find(object => object.id === moved[0].id)!, moved.find(object => object.id === moved[1].id)!].sort((left, right) => left.id.localeCompare(right.id));
  assert.equal(current.find(object => object.id === moved[0].id)?.x, 999);
  assert.equal(current.find(object => object.id === moved[1].id)?.x, expected.find(object => object.id === moved[1].id)?.x);
  assert.equal(current.find(object => object.id === moved[1].id)?.y, expected.find(object => object.id === moved[1].id)?.y);
  assert.deepEqual(after.history, { canUndo: true, canRedo: false });
});

test('an alignment-style multi-object update undoes and redoes as one step', async t => {
  const f = await fixture(t), a = await f.session('Align'), asset = await f.upload();
  const created = (await f.operations(a.id, [0, 1, 2].map((index) => ({ type: 'create', object: { id: `align-${index}`, assetId: asset.id, x: 40 + index * 110, y: 80 + index * 35, width: 80 + index * 10, height: 50 + index * 5 } })))).objects.filter(object => object.id.startsWith('align-'));
  const aligned = (await f.operations(a.id, created.map(object => ({ type: 'update', objectId: object.id, expectedVersion: object.version, changes: { y: 420 } })))).objects.filter(object => object.id.startsWith('align-'));
  assert.equal(new Set(aligned.map(object => object.y)).size, 1);
  const undone = (await f.undo(a.id)).objects.filter(object => object.id.startsWith('align-')).sort((left, right) => left.id.localeCompare(right.id));
  const original = created.sort((left, right) => left.id.localeCompare(right.id));
  assert.deepEqual(undone.map(object => [object.id, object.x, object.y, object.width, object.height]), original.map(object => [object.id, object.x, object.y, object.width, object.height]));
  assert.deepEqual((await f.state(a.id)).history, { canUndo: true, canRedo: true });
  const redone = (await f.redo(a.id)).objects.filter(object => object.id.startsWith('align-')).sort((left, right) => left.id.localeCompare(right.id));
  assert.deepEqual(redone.map(object => [object.id, object.x, object.y, object.width, object.height]), aligned.sort((left, right) => left.id.localeCompare(right.id)).map(object => [object.id, object.x, object.y, object.width, object.height]));
});

test('published source and creation order survive delete undo and publication redo', async t => {
  const f = await fixture(t), a = await f.session('Published'), task = await f.sendTask(a.id), claim = await f.call<{ run: { id: string } }>(`/api/sessions/${a.id}/claim`, 'POST', { consumerId: 'history-agent' });
  const asset = await f.upload('published.png', 'image/png', `&sessionId=${a.id}&taskId=${task.task.id}&runId=${claim.run.id}&consumerId=history-agent`);
  await f.call(`/api/sessions/${a.id}/tasks/${task.task.id}/complete`, 'POST', { runId: claim.run.id, consumerId: 'history-agent', summary: 'Published two outputs.', assetIds: [asset.id], validation: [], operations: [
    { type: 'create', object: { id: 'z-published', assetId: asset.id, x: 10, y: 20, width: 100, height: 80 } },
    { type: 'create', object: { id: 'a-published', assetId: asset.id, x: 150, y: 20, width: 100, height: 80 } },
  ] });
  const published = (await f.state(a.id)).objects.filter(object => object.sourceTaskId === task.task.id);
  assert.equal(published.length, 2);
  const order = published.map(object => object.id), createdAt = new Map(published.map(object => [object.id, object.createdAt]));
  for (const object of published) { assert.equal(object.sourceTaskId, task.task.id); assert.equal(object.sourceRunId, claim.run.id); assert.equal(object.assetId, asset.id); }
  await f.operations(a.id, published.map(object => ({ type: 'delete', objectId: object.id, expectedVersion: object.version })));
  assert.equal((await f.state(a.id)).objects.some(object => object.sourceTaskId === task.task.id), false);
  const restoredDelete = (await f.undo(a.id)).objects.filter(object => object.sourceTaskId === task.task.id);
  assert.deepEqual(restoredDelete.map(object => object.id), order);
  assert.deepEqual(new Map(restoredDelete.map(object => [object.id, object.createdAt])), createdAt);
  assert.equal((await f.redo(a.id)).objects.some(object => object.sourceTaskId === task.task.id), false);
  await f.undo(a.id);
  await f.undo(a.id);
  const restoredPublication = (await f.redo(a.id)).objects.filter(object => object.sourceTaskId === task.task.id);
  assert.deepEqual(restoredPublication.map(object => object.id), order);
  for (const object of restoredPublication) { assert.equal(object.sourceTaskId, task.task.id); assert.equal(object.sourceRunId, claim.run.id); assert.equal(object.assetId, asset.id); assert.equal(object.createdAt, createdAt.get(object.id)); }
});

test('history undo and redo are available through the CLI', async t => {
  const f = await fixture(t), a = await f.session('CLI'), asset = await f.upload();
  const created = (await f.operations(a.id, [{ type: 'create', object: { assetId: asset.id, x: 1, y: 2, width: 30, height: 30 } }])).objects[0];
  const args = ['--project', f.root, '--url', f.url, '--session', a.id];
  assert.deepEqual(await cli(['board', 'history', ...args]), { canUndo: true, canRedo: false });
  const undone = await cli(['board', 'undo', ...args]) as { objects: BoardObject[]; history: BoardState['history'] };
  assert.equal(undone.objects.some(object => object.id === created.id), false);
  assert.deepEqual(undone.history, { canUndo: false, canRedo: true });
  const redone = await cli(['board', 'redo', ...args]) as { objects: BoardObject[]; history: BoardState['history'] };
  assert.equal(redone.objects.some(object => object.id === created.id), true);
  assert.deepEqual(redone.history, { canUndo: true, canRedo: false });
});
