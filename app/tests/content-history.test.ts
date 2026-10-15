import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cli } from '../src/cli.js';
import { startServer } from '../src/server/http.js';
import { editableTextBytes } from '../src/shared/content-types.js';
import type { Asset, BoardObject, BoardState } from '../src/shared/types.js';

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'acanvas-content-history-'));
  const server = await startServer({ root, port: 0 });
  const bootstrap = await (await fetch(`${server.url}/api/bootstrap`)).json() as { token: string };
  const call = async <T = any>(path: string, method = 'GET', body?: unknown, expected = 200): Promise<T> => {
    const response = await fetch(`${server.url}${path}`, { method, headers: { Authorization: `Bearer ${bootstrap.token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const value = await response.json();
    assert.equal(response.status, expected, JSON.stringify(value));
    return value as T;
  };
  const session = (name: string) => call<{ id: string }>('/api/sessions', 'POST', { name }, 201);
  const upload = async (name: string, mime: string, text: string) => {
    const response = await fetch(`${server.url}/api/assets?name=${encodeURIComponent(name)}&mime=${encodeURIComponent(mime)}`, { method: 'POST', headers: { Authorization: `Bearer ${bootstrap.token}`, 'Content-Type': mime }, body: text });
    const value = await response.json();
    assert.equal(response.status, 201, JSON.stringify(value));
    return value as Asset;
  };
  const state = (sessionId: string) => call<BoardState>(`/api/state?sessionId=${encodeURIComponent(sessionId)}`);
  const readContent = async (assetId: string) => {
    const response = await fetch(`${server.url}/api/assets/${encodeURIComponent(assetId)}/content`, { headers: { Authorization: `Bearer ${bootstrap.token}` } });
    assert.equal(response.status, 200);
    return response.text();
  };
  const operations = (sessionId: string, value: unknown, expected = 200) => call<{ objects: BoardObject[]; history: BoardState['history'] }>('/api/board/operations', 'POST', { sessionId, operations: value }, expected);
  const undo = (sessionId: string, expected = 200) => call<{ objects: BoardObject[]; history: BoardState['history'] }>('/api/board/undo', 'POST', { sessionId }, expected);
  const redo = (sessionId: string, expected = 200) => call<{ objects: BoardObject[]; history: BoardState['history'] }>('/api/board/redo', 'POST', { sessionId }, expected);
  t.after(async () => { await server.close(); await rm(root, { recursive: true, force: true }); });
  return { root, server, call, session, upload, state, readContent, operations, undo, redo };
}

test('content history preserves immutable bytes and supports undo redo and CLI JSON', async t => {
  const f = await fixture(t), board = await f.session('Content history'), original = await f.upload('note.txt', 'text/x-acanvas-note', 'A');
  const created = (await f.operations(board.id, [{ type: 'create', object: { id: 'content-note', assetId: original.id, x: 12, y: 24, width: 240, height: 128 } }])).objects[0];
  const colored = (await f.operations(board.id, [{ type: 'update', objectId: created.id, expectedVersion: created.version, changes: { fill: 'sage' } }])).objects[0];
  const firstText = 'B\n世界 "quoted"';
  const first = (await f.operations(board.id, [{ type: 'content', objectId: colored.id, expectedVersion: colored.version, text: firstText }])).objects.find(object => object.id === colored.id)!;
  assert.notEqual(first.assetId, original.id);
  assert.equal(first.id, colored.id);
  assert.deepEqual({ x: first.x, y: first.y, width: first.width, height: first.height, fill: first.fill, sourceTaskId: first.sourceTaskId, sourceRunId: first.sourceRunId }, { x: colored.x, y: colored.y, width: colored.width, height: colored.height, fill: colored.fill, sourceTaskId: colored.sourceTaskId, sourceRunId: colored.sourceRunId });
  assert.ok(first.version > colored.version);
  assert.equal(await f.readContent(original.id), 'A');
  const originalBytes = await readFile(join(f.root, '.acanvas', 'assets', `${original.id}.txt`));
  assert.equal(originalBytes.toString(), 'A');
  assert.equal(await f.readContent(first.assetId), firstText);
  const assetCount = (await f.state(board.id)).assets.length;
  const noop = await f.operations(board.id, [{ type: 'content', objectId: first.id, expectedVersion: first.version, text: firstText }]);
  const noopObject = noop.objects.find(object => object.id === first.id)!;
  assert.equal(noopObject.assetId, first.assetId);
  assert.equal(noopObject.version, first.version);
  assert.equal((await f.state(board.id)).assets.length, assetCount);
  assert.deepEqual(noop.history, { canUndo: true, canRedo: false });

  const secondText = 'C';
  const second = (await f.operations(board.id, [{ type: 'content', objectId: first.id, expectedVersion: first.version, text: secondText }])).objects.find(object => object.id === first.id)!;
  const undone = (await f.undo(board.id)).objects.find(object => object.id === first.id)!;
  assert.equal(undone.assetId, first.assetId);
  assert.equal(undone.fill, 'sage');
  assert.ok(undone.version > second.version);
  assert.deepEqual((await f.state(board.id)).history, { canUndo: true, canRedo: true });
  const redone = (await f.redo(board.id)).objects.find(object => object.id === first.id)!;
  assert.equal(redone.assetId, second.assetId);
  assert.ok(redone.version > undone.version);
  await f.undo(board.id);
  const branchText = 'D';
  const branch = (await f.operations(board.id, [{ type: 'content', objectId: first.id, expectedVersion: (await f.state(board.id)).objects.find(object => object.id === first.id)!.version, text: branchText }])).objects.find(object => object.id === first.id)!;
  assert.notEqual(branch.assetId, second.assetId);
  assert.deepEqual((await f.state(board.id)).history, { canUndo: true, canRedo: false });
  assert.equal((await f.redo(board.id)).history.canRedo, false);

  const jsonPath = join(f.root, 'content-operation.json');
  await writeFile(jsonPath, JSON.stringify({ operations: [{ type: 'content', objectId: first.id, expectedVersion: branch.version, text: 'CLI\n"escaped"' }] }));
  const cliResult = await cli(['board', 'operations', '--project', f.root, '--url', f.server.url, '--session', board.id, '--input', jsonPath]) as { objects: BoardObject[] };
  assert.equal(cliResult.objects.find(object => object.id === first.id)?.assetId === branch.assetId, false);
});

test('content steps compose with object updates, shared assets and external conflicts', async t => {
  const f = await fixture(t), a = await f.session('A'), b = await f.session('B'), original = await f.upload('shared.txt', 'text/x-acanvas-note', 'shared');
  const created = (await f.operations(a.id, [
    { type: 'create', object: { id: 'left', assetId: original.id, x: 0, y: 0, width: 160, height: 90 } },
    { type: 'create', object: { id: 'right', assetId: original.id, x: 220, y: 0, width: 160, height: 90 } },
  ])).objects.filter(object => object.id === 'left' || object.id === 'right');
  const left = created.find(object => object.id === 'left')!, right = created.find(object => object.id === 'right')!;
  const mixed = await f.operations(a.id, [
    { type: 'content', objectId: left.id, expectedVersion: left.version, text: 'left content' },
    { type: 'update', objectId: right.id, expectedVersion: right.version, changes: { x: 420 } },
  ]);
  const mixedLeft = mixed.objects.find(object => object.id === left.id)!, mixedRight = mixed.objects.find(object => object.id === right.id)!;
  assert.equal(mixedLeft.x, left.x); assert.equal(mixedLeft.assetId === original.id, false);
  assert.equal(mixedRight.x, 420); assert.equal(mixedRight.assetId, original.id);
  assert.deepEqual((await f.undo(a.id)).objects.filter(object => object.id === left.id || object.id === right.id).map(object => [object.id, object.assetId, object.x]).sort(), [[left.id, original.id, left.x], [right.id, original.id, right.x]].sort());
  const redone = (await f.redo(a.id)).objects;
  assert.equal(redone.find(object => object.id === left.id)?.assetId === original.id, false);
  assert.equal(redone.find(object => object.id === right.id)?.x, 420);
  assert.equal(await f.readContent(original.id), 'shared');
  assert.equal((await f.state(a.id)).objects.find(object => object.id === right.id)?.assetId, original.id);

  const current = (await f.state(a.id)).objects.find(object => object.id === left.id)!;
  const foreign = (await f.operations(b.id, [{ type: 'content', objectId: current.id, expectedVersion: current.version, text: 'foreign' }])).objects.find(object => object.id === current.id)!;
  assert.notEqual(foreign.assetId, current.assetId);
  const conflict = await f.call<{ error: { code: string } }>('/api/board/undo', 'POST', { sessionId: a.id }, 409);
  assert.equal(conflict.error.code, 'history_conflict');
  assert.deepEqual((await f.state(a.id)).history, { canUndo: true, canRedo: false });
});

test('content validation counts UTF-8 bytes and failed multi-object writes are atomic', async t => {
  const f = await fixture(t), board = await f.session('Boundaries'), note = await f.upload('note.txt', 'text/x-acanvas-note', 'start'), image = await f.upload('image.png', 'image/png', 'image');
  const created = (await f.operations(board.id, [
    { type: 'create', object: { id: 'note', assetId: note.id, x: 0, y: 0, width: 100, height: 80 } },
    { type: 'create', object: { id: 'image', assetId: image.id, x: 120, y: 0, width: 100, height: 80 } },
  ])).objects;
  const noteObject = created.find(object => object.id === 'note')!;
  const escaped = 'line\n"quoted"\\slash\t中文';
  const escapedResult = (await f.operations(board.id, [{ type: 'content', objectId: noteObject.id, expectedVersion: noteObject.version, text: escaped }])).objects.find(object => object.id === noteObject.id)!;
  assert.equal(await f.readContent(escapedResult.assetId), escaped);

  const maxText = 'é'.repeat(editableTextBytes / 2);
  assert.equal(Buffer.byteLength(maxText), editableTextBytes);
  const beforeMax = await f.state(board.id);
  const maxResult = (await f.operations(board.id, [{ type: 'content', objectId: noteObject.id, expectedVersion: escapedResult.version, text: maxText }])).objects.find(object => object.id === noteObject.id)!;
  const maxBytes = Buffer.from(await f.readContent(maxResult.assetId));
  assert.equal(maxBytes.byteLength, editableTextBytes);
  const tooLarge = await f.operations(board.id, [{ type: 'content', objectId: noteObject.id, expectedVersion: maxResult.version, text: `${maxText}x` }], 413) as unknown as { error: { code: string } };
  assert.equal(tooLarge.error.code, 'content_too_large');
  const afterTooLarge = await f.state(board.id);
  assert.equal(afterTooLarge.objects.find(object => object.id === noteObject.id)?.assetId, maxResult.assetId);
  assert.equal(afterTooLarge.assets.length, beforeMax.assets.length + 1);

  const filesBefore = await readdir(join(f.root, '.acanvas', 'assets'));
  const atomicBefore = await f.state(board.id);
  await f.operations(board.id, [
    { type: 'content', objectId: noteObject.id, expectedVersion: maxResult.version, text: 'must rollback' },
    { type: 'content', objectId: 'image', expectedVersion: created.find(object => object.id === 'image')!.version, text: 'not editable' },
  ], 400);
  const atomicAfter = await f.state(board.id);
  assert.deepEqual(atomicAfter.objects, atomicBefore.objects);
  assert.deepEqual(atomicAfter.history, atomicBefore.history);
  assert.deepEqual(await readdir(join(f.root, '.acanvas', 'assets')), filesBefore);
});
