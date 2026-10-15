import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm, symlink, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import { CodexRuntimeClient, RuntimeDeliveryError, validateRuntimeEndpoint, type RuntimeState } from '../src/server/codex-runtime.js';

const target = 'owned-original-thread';
type Message = { id?: number | string; method?: string; params?: any; result?: any; error?: any };
type Handler = (message: Message, socket: WebSocket) => boolean | void;
async function owner(t: test.TestContext, handler?: Handler, path?: string, route = '/rpc') {
  const root = await mkdtemp(join(tmpdir(), 'acanvas-runtime-protocol-'));
  await writeFile(join(root, 'OWNERSHIP.json'), JSON.stringify({ purpose: 'Isolated Codex runtime protocol test', pid: process.pid }));
  const socketPath = path ?? join(root, 'owner.sock');
  const server = createServer(), sockets = new WebSocketServer({ noServer: true }), requests: Message[] = [], connected = new Set<WebSocket>();
  server.on('upgrade', (request, socket, head) => {
    if (request.url !== route) { socket.end('HTTP/1.1 404 Missing\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); return; }
    sockets.handleUpgrade(request, socket, head, client => sockets.emit('connection', client));
  });
  sockets.on('connection', socket => {
    connected.add(socket); socket.once('close', () => connected.delete(socket));
    socket.on('message', data => {
      const message = JSON.parse(data.toString()) as Message; requests.push(message);
      if (handler?.(message, socket) || message.id === undefined) return;
      const result = message.method === 'initialize' ? { userAgent: 'isolated-public-protocol-fixture', codexHome: 'PRIVATE_VALUE_MUST_NOT_ESCAPE' }
        : message.method === 'thread/loaded/list' ? { data: [target], nextCursor: null }
          : message.method === 'thread/read' ? { thread: { id: target, status: { type: 'idle' } } }
            : { turn: { id: 'accepted-turn', status: 'inProgress' } };
      socket.send(JSON.stringify({ id: message.id, result }));
    });
  });
  t.after(async () => { for (const socket of connected) socket.terminate(); sockets.close(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socketPath, () => resolve()); });
  return { socketPath, endpoint: `unix://${socketPath}`, requests, connected, notify(message: Message) { for (const socket of connected) socket.send(JSON.stringify(message)); } };
}
async function connectedClient(t: test.TestContext, fixture: Awaited<ReturnType<typeof owner>>, options: { rpcTimeoutMs?: number; onState?(state: RuntimeState): void; onApprovalRequest?(request: unknown): void } = {}) {
  const client = new CodexRuntimeClient({ endpoint: fixture.endpoint, threadId: target, ...options }); t.after(() => client.close()); await client.connect(); return client;
}
function failure(certainty: RuntimeDeliveryError['certainty'], code?: string) { return (error: unknown) => error instanceof RuntimeDeliveryError && error.certainty === certainty && (!code || error.code === code); }

test('existing target validation pages loaded IDs, reads metadata only and submits original identity', async t => {
  const fixture = await owner(t, (message, socket) => {
    if (message.method !== 'thread/loaded/list') return;
    socket.send(JSON.stringify({ id: message.id, result: message.params.cursor ? { data: [target], nextCursor: null } : { data: ['another-thread'], nextCursor: 'next-page' } })); return true;
  });
  const client = await connectedClient(t, fixture);
  const identity = await client.connect();
  assert.equal(identity.threadId, target); assert.match(identity.fingerprint, /^\d+:\d+:\d+$/); assert.ok(!JSON.stringify(identity).includes('PRIVATE_VALUE'));
  assert.equal(fixture.requests[0].params.clientInfo.name, 'acanvas'); assert.equal(fixture.requests[0].params.capabilities.experimentalApi, true);
  assert.equal(fixture.requests[1].method, 'initialized');
  assert.deepEqual(fixture.requests.filter(message => message.method === 'thread/loaded/list').map(message => message.params), [{ limit: 100 }, { limit: 100, cursor: 'next-page' }]);
  assert.deepEqual(fixture.requests.find(message => message.method === 'thread/read')!.params, { threadId: target, includeTurns: false });
  assert.deepEqual(await client.checkTarget(), { loaded: true, status: 'idle' });
  let submitted = false;
  const originalSend = WebSocket.prototype.send;
  t.mock.method(WebSocket.prototype, 'send', function (this: WebSocket, ...args: any[]) { if (JSON.parse(String(args[0])).method === 'turn/start') submitted = true; return Reflect.apply(originalSend, this, args); });
  const result = client.startUserInput({ text: 'Preserve this saved request.', messageId: 'saved-task-id' });
  assert.equal(submitted, true, 'turn/start write is invoked before startUserInput returns');
  assert.deepEqual(await result, { turnId: 'accepted-turn' }); t.mock.restoreAll();
  assert.deepEqual(fixture.requests.find(message => message.method === 'turn/start')!.params, { threadId: target, clientUserMessageId: 'saved-task-id', input: [{ type: 'text', text: 'Preserve this saved request.' }] });
  assert.ok(fixture.requests.every(message => !['thread/start', 'thread/resume', 'turn/steer', 'turn/interrupt'].includes(message.method!)));
});

test('unloaded targets and wrong-thread metadata never become deliverable', async t => {
  const unloaded = await owner(t, (message, socket) => { if (message.method !== 'thread/loaded/list') return; socket.send(JSON.stringify({ id: message.id, result: { data: ['other-thread'], nextCursor: null } })); return true; });
  const a = new CodexRuntimeClient({ endpoint: unloaded.endpoint, threadId: target }); t.after(() => a.close());
  await assert.rejects(a.connect(), failure('not_sent', 'runtime_thread_unloaded')); assert.ok(!unloaded.requests.some(message => message.method === 'thread/read' || message.method === 'turn/start'));
  const wrong = await owner(t, (message, socket) => { if (message.method !== 'thread/read') return; socket.send(JSON.stringify({ id: message.id, result: { thread: { id: 'other-thread', status: { type: 'idle' } } } })); return true; });
  const b = new CodexRuntimeClient({ endpoint: wrong.endpoint, threadId: target }); t.after(() => b.close());
  await assert.rejects(b.connect(), failure('not_sent', 'runtime_thread_mismatch')); assert.ok(!wrong.requests.some(message => message.method === 'turn/start'));
});

test('endpoint validation rejects remote routes, non-sockets, symlinks and another uid', async t => {
  const fixture = await owner(t);
  for (const endpoint of ['ws://localhost/rpc', 'unix://relative.sock', 'unix:///tmp/owner.sock?route=/other', 'unix:///tmp/owner.sock#other']) await assert.rejects(validateRuntimeEndpoint(endpoint), failure('not_sent', 'runtime_endpoint_invalid'));
  const file = join(fixture.socketPath, '../plain.txt'), link = join(fixture.socketPath, '../linked.sock');
  await writeFile(file, 'Owned plain file'); await symlink(fixture.socketPath, link);
  await assert.rejects(validateRuntimeEndpoint(`unix://${file}`), failure('not_sent', 'runtime_endpoint_invalid'));
  await assert.rejects(validateRuntimeEndpoint(`unix://${link}`), failure('not_sent', 'runtime_endpoint_invalid'));
  const uid = process.getuid!(); t.mock.method(process as NodeJS.Process & { getuid(): number }, 'getuid', () => uid + 1);
  await assert.rejects(validateRuntimeEndpoint(fixture.endpoint), failure('not_sent', 'runtime_endpoint_owner')); t.mock.restoreAll();
  const badRoute = await owner(t, undefined, undefined, '/other');
  const client = new CodexRuntimeClient({ endpoint: badRoute.endpoint, threadId: target, rpcTimeoutMs: 200 }); t.after(() => client.close()); await assert.rejects(client.connect(), failure('not_sent', 'runtime_unavailable'));
});

test('socket replacement is pinned before reconnect, recheck and delivery', async t => {
  const fixture = await owner(t), client = await connectedClient(t, fixture), original = await client.connect();
  await unlink(fixture.socketPath); const replacement = await owner(t, undefined, fixture.socketPath);
  assert.notEqual((await validateRuntimeEndpoint(replacement.endpoint)).fingerprint, original.fingerprint);
  await assert.rejects(validateRuntimeEndpoint(fixture.endpoint, original.fingerprint), failure('not_sent', 'runtime_endpoint_replaced'));
  await assert.rejects(client.checkTarget(), failure('not_sent', 'runtime_endpoint_replaced'));
  await assert.rejects(client.startUserInput({ text: 'Never send to a replacement.', messageId: 'replace' }), failure('not_sent', 'runtime_endpoint_replaced'));
  assert.ok(!fixture.requests.some(message => message.method === 'turn/start')); assert.equal(replacement.requests.length, 0);
});

test('disconnect before write is not_sent; disconnect after submission remains unknown', async t => {
  let disconnected!: () => void; const closed = new Promise<void>(resolve => { disconnected = resolve; });
  const before = await owner(t), a = await connectedClient(t, before, { onState(state) { if (state === 'disconnected') disconnected(); } });
  for (const socket of before.connected) socket.terminate(); await closed;
  await assert.rejects(a.startUserInput({ text: 'Before.', messageId: 'before' }), failure('not_sent')); assert.ok(!before.requests.some(message => message.method === 'turn/start'));
  const after = await owner(t, (message, socket) => { if (message.method !== 'turn/start') return; socket.terminate(); return true; }), b = await connectedClient(t, after);
  await assert.rejects(b.startUserInput({ text: 'After.', messageId: 'after' }), failure('unknown', 'runtime_disconnected')); assert.equal(after.requests.filter(message => message.method === 'turn/start').length, 1);
});

test('explicit rejection, internal error, invalid acceptance and missing response have distinct certainty', async t => {
  const fixture = await owner(t, (message, socket) => {
    if (message.method !== 'turn/start') return;
    const marker = message.params.clientUserMessageId;
    if (marker !== 'timeout') socket.send(JSON.stringify(marker === 'invalid' ? { id: message.id, result: { turn: {} } } : { id: message.id, error: { code: marker === 'rejected' ? -32600 : -32603, message: 'PRIVATE_RUNTIME_ERROR_CONTENT' } }));
    return true;
  });
  const client = await connectedClient(t, fixture, { rpcTimeoutMs: 80 });
  for (const [messageId, certainty, code] of [['rejected', 'rejected', 'runtime_rpc_error'], ['internal', 'unknown', 'runtime_rpc_error'], ['invalid', 'unknown', 'runtime_response_invalid'], ['timeout', 'unknown', 'runtime_timeout']] as const) {
    await client.checkTarget();
    await assert.rejects(client.startUserInput({ text: 'Saved request.', messageId }), error => { assert.ok(failure(certainty, code)(error)); assert.ok(!String(error).includes('PRIVATE_RUNTIME_ERROR_CONTENT')); return true; });
  }
  assert.equal(fixture.requests.filter(message => message.method === 'turn/start').length, 4);
});

test('only target state and approval metadata are exposed; no approval decisions are sent', async t => {
  const states: RuntimeState[] = [], approvals: unknown[] = [];
  let approved!: () => void; const approvalObserved = new Promise<void>(resolve => { approved = resolve; });
  let busy!: () => void; const busyObserved = new Promise<void>(resolve => { busy = resolve; });
  const fixture = await owner(t), client = await connectedClient(t, fixture, { onState(state) { states.push(state); if (state === 'busy') busy(); }, onApprovalRequest(request) { approvals.push(request); approved(); } });
  const count = states.length;
  fixture.notify({ method: 'thread/status/changed', params: { threadId: 'another-thread', status: { type: 'active' } } });
  fixture.notify({ id: 'unrelated-approval', method: 'item/commandExecution/requestApproval', params: { threadId: 'another-thread', command: 'PRIVATE_UNRELATED_COMMAND' } });
  fixture.notify({ id: 'target-approval', method: 'item/commandExecution/requestApproval', params: { threadId: target, command: 'PRIVATE_TARGET_COMMAND' } });
  await approvalObserved; assert.equal(states.length, count);
  assert.deepEqual(approvals, [{ method: 'item/commandExecution/requestApproval', requestId: 'target-approval', threadId: target }]);
  fixture.notify({ method: 'thread/status/changed', params: { threadId: target, status: { type: 'active', activeFlags: ['waitingOnApproval'] } } });
  await busyObserved;
  assert.equal(states.at(-1), 'busy');
  await assert.rejects(client.startUserInput({ text: 'Defer known busy.', messageId: 'busy' }), failure('not_sent', 'runtime_busy'));
  assert.ok(fixture.requests.every(message => message.method && !Object.hasOwn(message, 'result') && !Object.hasOwn(message, 'error')));
});

test('unknown status and repeated loaded-list cursor fail closed; close releases pending delivery', async t => {
  const fixture = await owner(t, (message, socket) => { if (message.method !== 'turn/start') return; return true; }), client = await connectedClient(t, fixture);
  const pending = client.startUserInput({ text: 'Preserve unknown.', messageId: 'close' }); client.close(); await assert.rejects(pending, failure('unknown', 'runtime_disconnected'));
  const unknown = await owner(t, (message, socket) => { if (message.method !== 'thread/read') return; socket.send(JSON.stringify({ id: message.id, result: { thread: { id: target, status: { type: 'systemError' } } } })); return true; });
  const a = await connectedClient(t, unknown); assert.deepEqual(await a.checkTarget(), { loaded: true, status: 'unknown' }); await assert.rejects(a.startUserInput({ text: 'Do not start.', messageId: 'unknown' }), failure('not_sent', 'runtime_thread_unavailable'));
  const repeated = await owner(t, (message, socket) => { if (message.method !== 'thread/loaded/list') return; socket.send(JSON.stringify({ id: message.id, result: { data: [], nextCursor: 'same-cursor' } })); return true; });
  const b = new CodexRuntimeClient({ endpoint: repeated.endpoint, threadId: target }); t.after(() => b.close()); await assert.rejects(b.connect(), failure('not_sent', 'runtime_protocol_invalid'));
});
