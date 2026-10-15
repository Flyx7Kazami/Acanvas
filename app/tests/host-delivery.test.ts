import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { join } from 'node:path';
import { CanvasService } from '../src/server/service.js';
import { HostDeliveryManager, type HostRuntimeTransport } from '../src/server/host-delivery.js';
import { RuntimeDeliveryError, validateRuntimeEndpoint, type CodexRuntimeOptions, type RuntimeTargetState } from '../src/server/codex-runtime.js';
import { startServer } from '../src/server/http.js';

async function eventually(check: () => boolean, message = 'condition was not observed') {
  const deadline = Date.now() + 2500;
  while (!check()) { if (Date.now() > deadline) assert.fail(message); await new Promise(resolve => setTimeout(resolve, 10)); }
}
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
class FakeClient implements HostRuntimeTransport {
  closed = false;
  target: RuntimeTargetState = { loaded: true, status: 'idle' };
  input: { text: string; messageId: string }[] = [];
  checkHook?: () => void | Promise<void>;
  inputHook?: (input: { text: string; messageId: string }) => Promise<{ turnId: string }>;
  constructor(readonly options: CodexRuntimeOptions) {}
  async connect() { const endpoint = await validateRuntimeEndpoint(this.options.endpoint, this.options.expectedFingerprint); return { ...endpoint, threadId: this.options.threadId }; }
  async checkTarget() { await this.checkHook?.(); return { ...this.target }; }
  startUserInput(input: { text: string; messageId: string }) { this.input.push(input); return this.inputHook?.(input) ?? Promise.resolve({ turnId: `turn-${input.messageId}` }); }
  close() { this.closed = true; }
}
async function socket(root: string, name = 'runtime.sock'): Promise<{ server: Server; endpoint: string }> {
  const server = createServer(connection => connection.destroy()), path = join(root, name);
  await new Promise<void>((yes, no) => { server.once('error', no); server.listen(path, () => { server.off('error', no); yes(); }); });
  return { server, endpoint: `unix://${path}` };
}
function save(service: CanvasService, sessionId: string, text = 'saved user request') {
  const draft = service.saveDraft(sessionId, { ...service.draft(sessionId), text });
  return { draft, task: service.sendDraft(sessionId, draft.id, draft.revision).task };
}
async function fixture(t: test.TestContext) {
  const root = await mkdtemp('/tmp/acanvas-host-delivery-test-'); await writeFile(join(root, 'test-owner.txt'), 'host-delivery.test.ts');
  const endpoint = await socket(root), clients: FakeClient[] = [];
  let newClientHook: ((client: FakeClient) => void) | undefined;
  const createClient = (options: CodexRuntimeOptions) => { const client = new FakeClient(options); newClientHook?.(client); clients.push(client); return client; };
  let service = new CanvasService(root), manager = new HostDeliveryManager(service, { pollIntervalMs: 60_000, createClient });
  service.onChange = () => manager.schedule();
  const session = service.bindHost({ host: 'codex', threadId: 'original-thread' }).sessionId;
  t.after(async () => { await manager.close(); service.close(); await new Promise<void>(yes => endpoint.server.close(() => yes())); await rm(root, { recursive: true, force: true }); });
  return { root, endpoint: endpoint.endpoint, clients, session, set newClientHook(hook: ((client: FakeClient) => void) | undefined) { newClientHook = hook; }, get service() { return service; }, get manager() { return manager; }, async attach(threadId = 'original-thread') { const result = await manager.attach(session, { host: 'codex', threadId, endpoint: endpoint.endpoint }); await new Promise(resolve => setTimeout(resolve, 20)); return result; }, async restart() {
    await manager.close(); service.close(); service = new CanvasService(root);
    manager = new HostDeliveryManager(service, { pollIntervalMs: 60_000, createClient });
    service.onChange = () => manager.schedule(); manager.start();
  } };
}

test('explicit host binding is required; first attach does not wake old queued work', async t => {
  const f = await fixture(t), old = save(f.service, f.session).task;
  const other = f.service.createSession('unbound scope');
  await assert.rejects(f.manager.attach(other.id, { host: 'codex', threadId: 'original-thread', endpoint: f.endpoint }), { code: 'host_binding_required' });
  await assert.rejects(f.manager.attach(f.session, { host: 'other-host', threadId: 'original-thread', endpoint: f.endpoint }), { code: 'unsupported_host' });
  await f.attach(); f.manager.schedule(); await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(f.clients[0].input.length, 0); assert.equal(f.service.task(f.session, old.id).hostDelivery, undefined);
  const next = save(f.service, f.session).task;
  await new Promise(resolve => setTimeout(resolve, 30)); assert.equal(f.clients[0].input.length, 0);
  assert.equal(f.service.hostRuntimeSummary(f.session).reason, 'earlier-request');
  f.service.cancel(f.session, old.id, 'explicit user cancellation');
  await eventually(() => f.service.task(f.session, next.id).hostDelivery?.state === 'accepted');
  assert.equal(f.clients[0].input.length, 1);
});

test('send and outbox are one idempotent transaction; acceptance is separate from claim and receipt', async t => {
  const f = await fixture(t); await f.attach();
  const { draft, task } = save(f.service, f.session, 'new request');
  assert.equal(f.service.sendDraft(f.session, draft.id, draft.revision).task.id, task.id);
  await eventually(() => f.service.task(f.session, task.id).hostDelivery?.state === 'accepted');
  assert.equal(f.clients[0].input.length, 1); assert.equal(f.clients[0].input[0].messageId, task.id);
  assert.match(f.clients[0].input[0].text, /Preserve any current work/); assert.match(f.clients[0].input[0].text, /task boundary/);
  assert.ok(f.clients[0].input[0].text.includes(f.session)); assert.ok(f.clients[0].input[0].text.includes(task.id));
  let current = f.service.task(f.session, task.id);
  assert.equal(current.status, 'queued'); assert.equal(current.currentRunId, null); assert.equal(current.receipt, null);
  const claim = f.service.claim(f.session, 'original-agent');
  assert.equal(claim.task?.hostDelivery?.state, 'observed');
  current = f.service.complete(f.session, task.id, { runId: claim.run!.id, consumerId: claim.consumerId, summary: 'delivered', assetIds: [], validation: ['verified'], operations: [] });
  assert.equal(current.hostDelivery?.state, 'observed'); assert.equal(current.receipt?.summary, 'delivered');
  const receipt = current.receipt;
  assert.deepEqual(f.service.complete(f.session, task.id, { runId: claim.run!.id, consumerId: claim.consumerId, summary: 'retry', assetIds: [], validation: [], operations: [] }).receipt, receipt);
  const publicState = JSON.stringify(f.service.state(f.session));
  assert.ok(!publicState.includes(f.endpoint)); assert.ok(!publicState.includes('fingerprint')); assert.ok(!publicState.includes('targetKey'));
  assert.equal((await stat(join(f.root, '.acanvas/board.sqlite'))).mode & 0o777, 0o600);
});

test('known busy, editing and existing consumer ownership defer the original serial queue', async t => {
  const f = await fixture(t); await f.attach(); const client = f.clients[0]; client.target.status = 'active';
  const task = save(f.service, f.session).task; await eventually(() => f.service.hostRuntimeSummary(f.session).reason === 'target-busy');
  assert.equal(client.input.length, 0); assert.equal(f.service.task(f.session, task.id).hostDelivery?.state, 'pending');
  const draft = f.service.draft(f.session), edit = f.service.beginTaskEdit(f.session, task.id, { draftId: draft.id, expectedRevision: draft.revision });
  client.target.status = 'idle'; await new Promise(resolve => setTimeout(resolve, 520)); f.manager.schedule(); await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(client.input.length, 0); assert.equal(f.service.hostRuntimeSummary(f.session).reason, 'queue-editing');
  f.service.cancelTaskEdit(f.session, task.id, { draftId: edit.draft.id, expectedRevision: edit.draft.revision });
  const claim = f.service.claim(f.session, 'foreign-agent');
  f.service.pause(f.session, task.id, { consumerId: claim.consumerId, runId: claim.run!.id, reason: 'waiting' }, 'blocked');
  f.manager.schedule(); await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(client.input.length, 0); assert.equal(f.service.hostRuntimeSummary(f.session).reason, 'queue-paused');
  f.service.cancel(f.session, task.id, 'cancelled blocked task');
  const fresh = save(f.service, f.session).task;
  f.service.resumeSession(f.session, { consumerId: 'reserved-agent', expectedConsumerId: null, resolution: 'explicit owner' });
  f.manager.schedule(); await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(client.input.length, 0); assert.equal(f.service.hostRuntimeSummary(f.session).reason, 'consumer-active');
  assert.equal(f.service.task(f.session, fresh.id).hostDelivery?.state, 'pending');
});

test('preflight cancellation and claim win the business CAS; an in-flight claim wins late acceptance', async t => {
  const f = await fixture(t); await f.attach(); const client = f.clients[0];
  const first = save(f.service, f.session).task;
  client.checkHook = () => { client.checkHook = undefined; f.service.cancel(f.session, first.id, 'cancel during preflight'); };
  await eventually(() => f.service.task(f.session, first.id).hostDelivery?.state === 'skipped'); assert.equal(client.input.length, 0);
  const second = save(f.service, f.session).task;
  client.checkHook = () => { client.checkHook = undefined; f.service.claim(f.session, 'manual-agent'); };
  await eventually(() => f.service.task(f.session, second.id).hostDelivery?.state === 'observed'); assert.equal(client.input.length, 0);
  const secondClaim = f.service.task(f.session, second.id);
  f.service.complete(f.session, second.id, { runId: secondClaim.currentRunId!, consumerId: 'manual-agent', summary: 'manual result', assetIds: [], operations: [], validation: [] });
  f.service.claim(f.session, 'manual-agent');
  const accepted = deferred<{ turnId: string }>(); client.inputHook = () => accepted.promise;
  const third = save(f.service, f.session).task;
  await eventually(() => f.service.task(f.session, third.id).hostDelivery?.state === 'sending');
  const claim = f.service.claim(f.session, 'actual-original-agent');
  accepted.resolve({ turnId: 'late-turn' }); await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(f.service.task(f.session, third.id).hostDelivery?.state, 'observed'); assert.equal(claim.task?.id, third.id);
  assert.equal(f.service.task(f.session, third.id).hostDelivery?.turnId, undefined);
});

test('lost response is unknown and never replayed; persisted sending becomes unknown on restart', async t => {
  const f = await fixture(t); await f.attach(); const client = f.clients[0];
  client.inputHook = () => Promise.reject(new RuntimeDeliveryError('unknown', 'runtime_disconnected', 'private socket detail must not leak'));
  const lost = save(f.service, f.session).task;
  await eventually(() => f.service.task(f.session, lost.id).hostDelivery?.state === 'unknown');
  assert.equal(client.input.length, 1); f.manager.schedule(); await new Promise(resolve => setTimeout(resolve, 30)); assert.equal(client.input.length, 1);
  assert.ok(!JSON.stringify(f.service.state(f.session)).includes('private socket detail'));
  f.service.cancel(f.session, lost.id, 'explicit review');
  await f.manager.close();
  const pending = save(f.service, f.session).task, attachment = f.service.runtimeAttachment(f.session)!;
  assert.ok(f.service.beginHostDelivery(attachment)); assert.equal(f.service.task(f.session, pending.id).hostDelivery?.state, 'sending');
  await f.restart(); await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(f.service.task(f.session, pending.id).hostDelivery?.state, 'unknown');
  assert.equal(f.clients.at(-1)?.input.length, 0); assert.equal(f.service.hostRuntimeSummary(f.session).unknownCount, 2);
});

test('detach invalidates in-flight acceptance and old callbacks; another target never receives old pending work', async t => {
  const f = await fixture(t); await f.attach(); const old = f.clients[0], response = deferred<{ turnId: string }>(); old.inputHook = () => response.promise;
  const sent = save(f.service, f.session).task; await eventually(() => f.service.task(f.session, sent.id).hostDelivery?.state === 'sending');
  const pending = save(f.service, f.session).task;
  const detached = await f.manager.detach(f.session); assert.equal(detached.summary.mode, 'queue'); assert.equal(detached.attachment?.enabled, false);
  assert.equal(f.service.task(f.session, sent.id).hostDelivery?.state, 'unknown');
  old.options.onState?.('ready'); response.resolve({ turnId: 'too-late' }); await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(f.service.task(f.session, sent.id).hostDelivery?.state, 'unknown');
  f.service.bindHost({ host: 'codex', threadId: 'replacement-thread', sessionId: f.session });
  await f.attach('replacement-thread');
  assert.equal(f.service.task(f.session, pending.id).hostDelivery?.state, 'skipped');
  assert.equal(f.clients.at(-1)?.input.length, 0); old.options.onState?.('disconnected');
  assert.notEqual(f.service.hostRuntimeSummary(f.session).connection, 'disconnected');
  await assert.rejects(f.attach('original-thread'), { code: 'host_runtime_conflict' });
});

test('unloaded or disconnected before write stays pending; rejected write can retry without losing the task', async t => {
  const f = await fixture(t); await f.attach(); const client = f.clients[0]; client.target.loaded = false;
  const task = save(f.service, f.session).task; await eventually(() => f.service.hostRuntimeSummary(f.session).reason === 'target-not-loaded');
  assert.equal(client.input.length, 0); assert.equal(f.service.task(f.session, task.id).hostDelivery?.state, 'pending');
  client.target.loaded = true; client.inputHook = () => Promise.reject(new RuntimeDeliveryError('not_sent', 'runtime_busy', 'busy'));
  await new Promise(resolve => setTimeout(resolve, 2020)); f.manager.schedule();
  await eventually(() => client.input.length === 1); assert.equal(f.service.task(f.session, task.id).hostDelivery?.state, 'pending');
  client.inputHook = undefined; await f.attach();
  await eventually(() => f.service.task(f.session, task.id).hostDelivery?.state === 'accepted');
  assert.equal(f.clients.at(-1)?.input.length, 1);
});

test('attachment races are rejected and approvals remain metadata for the original host', async t => {
  const f = await fixture(t), gate = deferred<void>();
  f.newClientHook = client => { client.checkHook = () => gate.promise; };
  // The first attachment has no persisted row until both connection and target have been verified.
  const original = f.manager.attach(f.session, { host: 'codex', threadId: 'original-thread', endpoint: f.endpoint });
  await eventually(() => f.clients.length === 1);
  await assert.rejects(f.attach(), { code: 'host_runtime_conflict' });
  await f.manager.detach(f.session); gate.resolve();
  await assert.rejects(original, { code: 'host_runtime_conflict' }); assert.equal(f.service.runtimeAttachment(f.session), null);
  f.newClientHook = undefined;
  await f.attach(); const client = f.clients.at(-1)!;
  client.options.onApprovalRequest?.({ method: 'item/commandExecution/requestApproval', requestId: 'approval-1', threadId: 'original-thread' });
  assert.equal(f.service.hostRuntimeSummary(f.session).reason, 'approval-required');
  assert.equal(client.input.length, 0); assert.equal(client.closed, false);
});

test('reattach holds an old preflight before write and restores pending only to the verified same owner', async t => {
  const f = await fixture(t); await f.attach();
  const old = f.clients[0], oldGate = deferred<void>(), newGate = deferred<void>(); let oldChecking = false;
  old.checkHook = () => { oldChecking = true; return oldGate.promise; };
  const task = save(f.service, f.session).task; await eventually(() => oldChecking);
  f.newClientHook = client => { client.checkHook = () => newGate.promise; };
  const reattach = f.manager.attach(f.session, { host: 'codex', threadId: 'original-thread', endpoint: f.endpoint });
  await eventually(() => f.clients.length === 2); oldGate.resolve(); await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(old.input.length, 0); assert.equal(f.service.task(f.session, task.id).hostDelivery?.state, 'pending');
  newGate.resolve(); await reattach;
  await eventually(() => f.service.task(f.session, task.id).hostDelivery?.state === 'accepted');
  assert.equal(old.input.length, 0); assert.equal(f.clients[1].input.length, 1); assert.equal(old.closed, true);
});

test('runtime metadata requires CLI Bearer without browser Origin or Cookie and remains scope-bound', async t => {
  const root = await mkdtemp('/tmp/acanvas-host-http-test-'); await writeFile(join(root, 'test-owner.txt'), 'host-delivery.test.ts');
  const endpoint = await socket(root), running = await startServer({ root, port: 0, hostRuntime: { pollIntervalMs: 60_000, createClient: options => new FakeClient(options) } });
  t.after(async () => { await running.close(); await new Promise<void>(yes => endpoint.server.close(() => yes())); await rm(root, { recursive: true, force: true }); });
  const bootstrapResponse = await fetch(`${running.url}/api/bootstrap`), cookie = bootstrapResponse.headers.get('set-cookie')!.split(';')[0], bootstrap = await bootstrapResponse.json();
  const session = running.service.bindHost({ host: 'codex', threadId: 'http-original' }).sessionId, path = `/api/sessions/${session}/host-runtime`;
  const call = async (headers: Record<string, string>, method = 'GET', body?: unknown) => fetch(`${running.url}${path}`, { method, headers: { ...headers, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  assert.equal((await call({ Cookie: cookie })).status, 401);
  assert.equal((await call({ Authorization: `Bearer ${bootstrap.token}`, Origin: running.url })).status, 403);
  assert.equal((await call({ Authorization: `Bearer ${bootstrap.token}`, Cookie: cookie })).status, 403);
  assert.equal((await call({ Authorization: 'Bearer wrong' }, 'POST', { host: 'codex', threadId: 'http-original', endpoint: endpoint.endpoint })).status, 401);
  const attached = await call({ Authorization: `Bearer ${bootstrap.token}` }, 'POST', { host: 'codex', threadId: 'http-original', endpoint: endpoint.endpoint });
  assert.equal(attached.status, 200); const detail = await attached.json(); assert.equal(detail.projectId, bootstrap.project.id); assert.equal(detail.sessionId, session); assert.equal(detail.attachment.endpoint, (await validateRuntimeEndpoint(endpoint.endpoint)).endpoint);
  const state = await fetch(`${running.url}/api/state?sessionId=${session}`, { headers: { Cookie: cookie } }); assert.equal(state.status, 200);
  assert.ok(!(await state.text()).includes(detail.attachment.endpoint)); assert.equal(bootstrap.capabilities.hostWakeup, 'explicit-codex-unix');
  const foreign = running.service.createSession('foreign');
  const wrong = await fetch(`${running.url}/api/sessions/${foreign.id}/host-runtime`, { method: 'POST', headers: { Authorization: `Bearer ${bootstrap.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ host: 'codex', threadId: 'http-original', endpoint: endpoint.endpoint }) });
  assert.equal(wrong.status, 409); assert.equal(running.service.sessions().length, 2);
  const detached = await call({ Authorization: `Bearer ${bootstrap.token}` }, 'DELETE', {}); assert.equal(detached.status, 200); assert.equal((await detached.json()).summary.mode, 'queue');
});
