import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../src/server/http.js';
import { editableTextBytes } from '../src/shared/content-types.js';
import type { Asset, BoardObject } from '../src/shared/types.js';

test('text assets are read-only and board content operations publish new assets', async t => {
  const root = await mkdtemp(join(tmpdir(), 'acanvas-text-content-'));
  const server = await startServer({ root, port: 0 });
  t.after(async () => { await server.close(); await rm(root, { recursive: true, force: true }); });
  const token = (await (await fetch(`${server.url}/api/bootstrap`)).json()).token;
  const call = async (path: string, method = 'GET', body?: BodyInit, mime?: string) => {
    const headers = new Headers({ Authorization: `Bearer ${token}` });
    if (mime) headers.set('Content-Type', mime);
    const response = await fetch(`${server.url}${path}`, { method, headers, body });
    const bytes = Buffer.from(await response.arrayBuffer());
    const json = response.headers.get('content-type')?.includes('json') ? JSON.parse(bytes.toString() || '{}') : undefined;
    return { status: response.status, json, text: bytes.toString() };
  };
  const upload = async (name: string, mime: string, body: string) => {
    const created = await call(`/api/assets?name=${encodeURIComponent(name)}&mime=${encodeURIComponent(mime)}`, 'POST', body, mime);
    assert.equal(created.status, 201);
    return created.json as Asset;
  };
  const note = await upload('Note', 'text/x-acanvas-note', 'Original note');
  assert.equal(note.mime, 'text/x-acanvas-note');
  assert.equal(note.kind, 'file');
  assert.equal(note.size, Buffer.byteLength('Original note'));
  const rejected = await call(`/api/assets/${note.id}/content`, 'PUT', 'Changed note', 'text/plain');
  assert.equal(rejected.status, 400);
  assert.equal(rejected.json.error.code, 'content_readonly');
  assert.equal((await call(`/api/assets/${note.id}/content`, 'GET')).text, 'Original note');

  const markdown = await upload('Notes.md', 'text/markdown', '# Old\n');
  assert.equal((await call(`/api/assets/${markdown.id}/content`, 'PUT', '# New\n')).status, 400);
  assert.equal((await call(`/api/assets/${markdown.id}/content`, 'GET')).text, '# Old\n');
  const image = await upload('pixel.png', 'image/png', 'png');
  assert.equal((await call(`/api/assets/${image.id}/content`, 'PUT', 'nope')).status, 400);
  assert.equal((await call(`/api/assets/${image.id}/content`, 'GET')).text, 'png');
  const plain = await upload('memo.txt', 'text/plain', 'plain');
  assert.equal((await call(`/api/assets/${plain.id}/content`, 'PUT', 'changed')).status, 400);
  assert.equal((await call(`/api/assets/${plain.id}/content`, 'GET')).text, 'plain');
  assert.equal((await call('/api/assets/missing/content', 'PUT', 'x')).status, 404);

  const session = (await call('/api/sessions', 'POST', JSON.stringify({ name: 'Content' }), 'application/json')).json as { id: string };
  const place = async (operations: unknown) => call('/api/board/operations', 'POST', JSON.stringify({ sessionId: session.id, operations }), 'application/json');
  const placed = await place([{ type: 'create', object: { assetId: note.id, x: 10, y: 20, width: 240, height: 128 } }]);
  assert.equal(placed.status, 200);
  const object = placed.json.objects.find((item: BoardObject) => item.assetId === note.id) as BoardObject;
  const changed = await place([{ type: 'content', objectId: object.id, expectedVersion: object.version, text: '第一行\nSecond line' }]);
  assert.equal(changed.status, 200);
  const updated = changed.json.objects.find((item: BoardObject) => item.id === object.id) as BoardObject;
  assert.notEqual(updated.assetId, object.assetId);
  assert.equal(updated.id, object.id);
  assert.deepEqual({ x: updated.x, y: updated.y, width: updated.width, height: updated.height, fill: updated.fill }, { x: object.x, y: object.y, width: object.width, height: object.height, fill: object.fill });
  assert.ok(updated.version > object.version);
  assert.equal((await call(`/api/assets/${note.id}/content`, 'GET')).text, 'Original note');
  assert.equal((await call(`/api/assets/${updated.assetId}/content`, 'GET')).text, '第一行\nSecond line');
  assert.equal((await place([{ type: 'content', objectId: object.id, expectedVersion: updated.version, text: 'x'.repeat(editableTextBytes + 1) }])).status, 413);
});
