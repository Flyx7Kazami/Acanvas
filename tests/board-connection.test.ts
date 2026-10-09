import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WebSocket } from 'ws';
import { startServer } from '../src/server/http.js';
import type { BoardConnectionMessage } from '../src/shared/board-connection.js';
import type { CaptureView } from '../src/shared/types.js';

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'acanvas-connection-')), server = await startServer({ root, port: 0 });
  const response = await fetch(server.url + '/api/bootstrap'), bootstrap = await response.json(), cookie = response.headers.get('set-cookie')!.split(';')[0];
  const call = async (path: string, method = 'GET', body?: object) => {
    const response = await fetch(server.url + path, { method, headers: { Authorization: `Bearer ${bootstrap.token}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const value = await response.json(); assert(response.ok, JSON.stringify(value)); return value;
  };
  const session = await call('/api/sessions', 'POST', { name: 'Owned connection fixture' });
  const register = (documentId: string): Promise<CaptureView> => call(`/api/sessions/${session.id}/capture-views`, 'POST', { documentId });
  const clients: WebSocket[] = [];
  const open = async (headers: Record<string, string> = {}) => {
    const socket = new WebSocket(server.url.replace('http:', 'ws:') + '/api/connection', { origin: server.url, headers: { Cookie: cookie, ...headers } }); clients.push(socket);
    const messages: BoardConnectionMessage[] = []; socket.on('message', bytes => messages.push(JSON.parse(bytes.toString())));
    await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    const receive = async (id: number, type?: string) => {
      const until = Date.now() + 3000;
      while (Date.now() < until) { const index = messages.findIndex(message => message.id === id && (!type || message.type === type)); if (index >= 0) return messages.splice(index, 1)[0]; await delay(5); }
      throw new Error(`Expected ${type || 'message'} for ${id}`);
    };
    return { socket, messages, receive, send(value: unknown) { socket.send(JSON.stringify(value)); } };
  };
  t.after(async () => { for (const client of clients) client.terminate(); await server.close(); await rm(root, { recursive: true, force: true }); });
  return { server, bootstrap, cookie, session, call, register, open };
}

test('board connection authenticates its upgrade with the same origin and bootstrap cookie', async t => {
  const f = await fixture(t);
  const rejected = async (headers: Record<string, string>, path = '/api/connection') => {
    const socket = new WebSocket(f.server.url.replace('http:', 'ws:') + path, { headers });
    return new Promise<number>((resolve, reject) => {
      socket.once('unexpected-response', (_request, response) => { const status = response.statusCode!; response.destroy(); socket.terminate(); resolve(status); });
      socket.once('open', () => { socket.terminate(); reject(new Error('Upgrade accepted')); }); socket.once('error', () => undefined);
    });
  };
  assert.equal(await rejected({ Origin: f.server.url }), 401);
  assert.equal(await rejected({ Origin: f.server.url, Authorization: `Bearer ${f.bootstrap.token}` }), 401);
  assert.equal(await rejected({ Origin: f.server.url, Cookie: 'acanvas_auth_' + new URL(f.server.url).port + '=forged' }), 401);
  assert.equal(await rejected({ Cookie: f.cookie }), 403);
  assert.equal(await rejected({ Origin: 'null', Cookie: f.cookie }), 403);
  assert.equal(await rejected({ Origin: f.server.url.replace('127.0.0.1', 'localhost'), Cookie: f.cookie }), 403);
  assert.equal(await rejected({ Origin: 'https://example.com', Cookie: f.cookie }), 403);
  assert.equal(await rejected({ Origin: f.server.url, Cookie: f.cookie, Host: 'example.com' }), 403);
  assert.equal(await rejected({ Origin: f.server.url, Cookie: f.cookie }, '/api/connection?token=forged'), 404);
  const client = await f.open(); client.send({ type: 'events', id: 1 });
  assert.deepEqual(await client.receive(1), { type: 'ready', id: 1, instanceId: f.bootstrap.service.instanceId });
  await f.call('/api/sessions', 'POST', { name: 'Owned change' }); assert.equal((await client.receive(1)).type, 'change');
});

test('typed view acknowledgements preserve ownership and operation sequence for invalid identities', async t => {
  const f = await fixture(t), view = await f.register('owned-connection-document'), client = await f.open();
  const operation = () => (f.server.service.db.prepare('SELECT operation_seq FROM capture_views WHERE id=?').get(view.viewId) as { operation_seq: number }).operation_seq;
  client.send({ type: 'watch-view', id: 1, view }); assert.deepEqual(await client.receive(1), { type: 'view-ready', id: 1, view });
  const other = await f.call('/api/sessions', 'POST', { name: 'Other owned task scope' });
  for (const [index, candidate] of [{ ...view, projectId: 'other-project' }, { ...view, sessionId: other.id }, { ...view, documentId: 'other-document' }, { ...view, viewGeneration: view.viewGeneration + 1 }].entries()) {
    const id = index + 2; client.send({ type: 'watch-view', id, view: candidate }); const message = await client.receive(id); assert.equal(message.type, 'error');
  }
  client.send({ type: 'events', id: 1 }); const duplicate = await client.receive(1, 'error'); assert.equal(duplicate.type, 'error');
  if (duplicate.type === 'error') assert.equal(duplicate.code, 'connection_subscription_conflict');
  client.send({ type: 'unwatch', id: 999 }); assert.equal(operation(), 0);
  await f.call(`/api/sessions/${view.sessionId}/capture-views/${view.viewId}`, 'DELETE', { documentId: view.documentId, viewGeneration: view.viewGeneration, operationSeq: 1 });
  const closed = await client.receive(1); assert.equal(closed.type, 'error');
  const next = await f.register(view.documentId); assert.equal(next.viewGeneration, view.viewGeneration + 1);
  client.send({ type: 'watch-view', id: 20, view }); assert.equal((await client.receive(20)).type, 'error');
  client.send({ type: 'watch-view', id: 21, view: next }); assert.equal((await client.receive(21)).type, 'view-ready');
});

test('board connection rejects malformed, binary and oversized messages', async t => {
  const f = await fixture(t);
  for (const value of ['invalid json', JSON.stringify({ type: 'unknown', id: 1 }), JSON.stringify({ type: 'events', id: -1 }), JSON.stringify({ type: 'events', id: 1, token: 'forged' }), JSON.stringify({ type: 'watch-view', id: 1, view: {} }), Buffer.from([1, 2]), 'x'.repeat(16 * 1024 + 1)]) {
    const client = await f.open(), closed = new Promise<number>(resolve => client.socket.once('close', code => resolve(code)));
    client.socket.send(value); assert([1008, 1009].includes(await closed));
  }
});

test('shared websocket view owners preserve the five second disconnect grace and isolate new generations', { timeout: 25_000 }, async t => {
  const f = await fixture(t), view = await f.register('owned-grace-document'), a = await f.open(), b = await f.open();
  for (const client of [a, b]) { client.send({ type: 'watch-view', id: 1, view }); assert.equal((await client.receive(1)).type, 'view-ready'); }
  a.socket.terminate(); await delay(5200); assert.deepEqual(f.server.service.captureView(view.sessionId, view.viewId), view);
  b.socket.terminate(); await delay(500);
  const c = await f.open(); c.send({ type: 'watch-view', id: 1, view }); assert.equal((await c.receive(1)).type, 'view-ready');
  await delay(4700); assert.deepEqual(f.server.service.captureView(view.sessionId, view.viewId), view);
  c.send({ type: 'unwatch', id: 1 }); await delay(5200);
  assert.throws(() => f.server.service.captureView(view.sessionId, view.viewId), { code: 'scene_view_closed' });
  const next = await f.register(view.documentId); c.send({ type: 'watch-view', id: 2, view: next }); assert.equal((await c.receive(2)).type, 'view-ready');
  c.send({ type: 'unwatch', id: 1 }); assert.deepEqual(f.server.service.captureView(next.sessionId, next.viewId), next);
  const closed = new Promise<void>(resolve => c.socket.once('close', () => resolve())); await f.server.close(); await closed;
});
