import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../src/server/http.js';
import { editableTextBytes } from '../src/shared/content-types.js';
import type { Asset } from '../src/shared/types.js';

test('notes and Markdown keep their asset id when text is replaced', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'acanvas-text-content-'));
  const server = await startServer({ root, port: 0 });
  t.after(async () => { await server.close(); await rm(root, { recursive: true, force: true }); });
  const token = (await (await fetch(`${server.url}/api/bootstrap`)).json()).token;
  const call = async (path: string, method: string, body?: BodyInit, mime?: string) => {
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
  const note = await upload('Note', 'text/x-acanvas-note', '');
  assert.equal(note.mime, 'text/x-acanvas-note');
  assert.equal(note.kind, 'file');
  assert.equal(note.size, 0);
  const saved = await call(`/api/assets/${note.id}/content`, 'PUT', '第一行\nSecond line', 'text/plain');
  assert.equal(saved.status, 200);
  assert.equal(saved.json.id, note.id);
  assert.equal(saved.json.mime, 'text/x-acanvas-note');
  assert.equal(saved.json.size, Buffer.byteLength('第一行\nSecond line'));
  const read = await call(`/api/assets/${note.id}/content`, 'GET');
  assert.equal(read.status, 200);
  assert.equal(read.text, '第一行\nSecond line');
  const emptied = await call(`/api/assets/${note.id}/content`, 'PUT', '');
  assert.equal(emptied.status, 200);
  assert.equal(emptied.json.size, 0);

  const markdown = await upload('Notes.md', 'text/markdown', '# Old\n');
  const edited = await call(`/api/assets/${markdown.id}/content`, 'PUT', '# New\n\nEdited.');
  assert.equal(edited.status, 200);
  assert.equal(edited.json.id, markdown.id);
  assert.equal((await call(`/api/assets/${markdown.id}/content`, 'GET')).text, '# New\n\nEdited.');

  const image = await upload('pixel.png', 'image/png', 'png');
  assert.equal((await call(`/api/assets/${image.id}/content`, 'PUT', 'nope')).status, 400);
  assert.equal((await call(`/api/assets/${image.id}/content`, 'GET')).text, 'png');
  const plain = await upload('memo.txt', 'text/plain', 'plain');
  assert.equal((await call(`/api/assets/${plain.id}/content`, 'PUT', 'changed')).status, 400);
  assert.equal((await call(`/api/assets/${plain.id}/content`, 'GET')).text, 'plain');
  assert.equal((await call('/api/assets/missing/content', 'PUT', 'x')).status, 404);
  assert.equal((await call(`/api/assets/${note.id}/content`, 'PUT', 'x'.repeat(editableTextBytes + 1))).status, 413);
  assert.equal((await call(`/api/assets/${note.id}/content`, 'GET')).text, '');
});
