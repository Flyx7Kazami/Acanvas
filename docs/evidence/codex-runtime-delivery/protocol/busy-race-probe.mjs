// This expressly created scratch owner is separate from any existing host.
// Its original host client creates one ephemeral thread. No policy overrides.
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, lstat, realpath } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

const binary = '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex';
const evidence = dirname(fileURLToPath(import.meta.url));
const scratch = await mkdtemp(join(tmpdir(), 'acanvas-busy-race-'));
await writeFile(join(scratch, 'OWNERSHIP.json'), JSON.stringify({ purpose: 'Explicitly owned isolated acanvas busy turn/start race probe', createdAt: new Date().toISOString(), repository: resolve(evidence, '../../../..') }));
const socketPath = join(scratch, 'owner.sock');
const record = { binary, version: execFileSync(binary, ['--version'], { encoding: 'utf8' }).trim(), scratch, socketPath, configOverrides: false, productThreadCreation: false, events: [] };
const emit = (kind, data = {}) => { record.events.push({ at: new Date().toISOString(), kind, ...data }); console.log(JSON.stringify({ kind, ...data })); };
let child, host, sender, product;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
class Rpc {
  constructor(socket, label) {
    this.socket = socket; this.label = label; this.counter = 0; this.pending = new Map(); this.waiters = [];
    socket.on('message', data => {
      const message = JSON.parse(data.toString());
      if (Object.hasOwn(message, 'id') && (Object.hasOwn(message, 'result') || Object.hasOwn(message, 'error'))) {
        const pending = this.pending.get(message.id); this.pending.delete(message.id); pending?.(message); return;
      }
      const params = message.params ?? {};
      if (message.method === 'thread/status/changed' || message.method === 'turn/started' || message.method === 'turn/completed') emit('notification', { client: label, method: message.method, threadId: params.threadId, status: params.status, turn: params.turn && { id: params.turn.id, status: params.turn.status } });
      if (label === 'original_host' && params.threadId === record.threadId && message.method === 'item/completed' && params.item?.type === 'userMessage') emit('owned_target_user_message', { threadId: params.threadId, turnId: params.turnId, itemId: params.item.id, marker: params.item.content?.some(item => item.text?.includes('second explicitly authorized')) ? 'second' : 'first' });
      if (label === 'original_host' && params.threadId === record.threadId && message.method === 'item/completed' && params.item?.type === 'agentMessage') emit('owned_target_model_reply', { threadId: params.threadId, turnId: params.turnId, text: params.item.text });
      if (Object.hasOwn(message, 'id')) emit('unanswered_server_request', { client: label, method: message.method });
      for (const waiter of [...this.waiters]) if (waiter.test(message)) { this.waiters.splice(this.waiters.indexOf(waiter), 1); waiter.resolve(message); }
    });
  }
  request(method, params) { const id = ++this.counter; return new Promise((resolve, reject) => { const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Timeout: ${method}`)); }, 20_000); this.pending.set(id, value => { clearTimeout(timer); resolve(value); }); this.socket.send(JSON.stringify({ id, method, params })); }); }
  wait(test, timeout = 60_000) { return new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('Notification timeout')), timeout); this.waiters.push({ test, resolve: value => { clearTimeout(timer); resolve(value); } }); }); }
  async initialize() { const value = await this.request('initialize', { clientInfo: { name: `acanvas_busy_probe_${this.label}`, version: '0.1.0' }, capabilities: { experimentalApi: true } }); emit('initialize', { client: this.label, userAgent: value.result?.userAgent }); this.socket.send(JSON.stringify({ method: 'initialized', params: {} })); }
}
async function connect(label) {
  const socket = new WebSocket(`ws+unix://${socketPath}:/rpc`, { perMessageDeflate: false, handshakeTimeout: 5000 });
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  const rpc = new Rpc(socket, label); await rpc.initialize(); return rpc;
}
try {
  child = spawn(binary, ['app-server', '--listen', `unix://${socketPath}`], { cwd: scratch, stdio: ['pipe', 'ignore', 'pipe'] });
  record.ownerPid = child.pid;
  let stderr = ''; child.stderr.on('data', bytes => { stderr += bytes.toString(); });
  for (let i = 0; i < 100; i++) { if (await lstat(socketPath).then(value => value.isSocket(), () => false)) break; if (child.exitCode !== null) throw new Error(`Owned listener failed (${child.exitCode}): ${stderr.includes('Operation not permitted') ? 'Operation not permitted' : 'see scratch owner startup'}`); await delay(100); }
  host = await connect('original_host');
  const created = await host.request('thread/start', { cwd: scratch, ephemeral: true, serviceName: 'acanvas-explicit-busy-race' });
  if (created.error) throw new Error(created.error.message);
  const threadId = created.result.thread.id; record.threadId = threadId;
  record.inherited = { model: created.result.model, approvalPolicy: created.result.approvalPolicy, approvalsReviewer: created.result.approvalsReviewer, sandbox: created.result.sandbox };
  emit('scratch_thread_created', { threadId, inherited: record.inherited });
  sender = await connect('second_client');
  const loaded = await sender.request('thread/loaded/list', { limit: 100 }); if (!loaded.result.data.includes(threadId)) throw new Error('Scratch target not loaded');
  const active = host.wait(message => message.method === 'thread/status/changed' && message.params?.threadId === threadId && message.params?.status?.type === 'active');
  const completed = host.wait(message => message.method === 'turn/completed' && message.params?.threadId === threadId);
  const first = await host.request('turn/start', { threadId, clientUserMessageId: 'acanvas-busy-race-first', input: [{ type: 'text', text: 'This is an explicitly authorized isolated protocol busy race experiment. Do not use tools or read files. Reply exactly ACANVAS_BUSY_FIRST_OK.' }] });
  record.firstResponse = first; emit('first_turn_start', { result: first.result, error: first.error });
  await active;
  const before = await sender.request('thread/read', { threadId, includeTurns: false });
  record.beforeStatus = before.result?.thread?.status;
  emit('target_metadata_before_race', { threadId: before.result?.thread?.id, status: record.beforeStatus });
  const raced = await sender.request('turn/start', { threadId, clientUserMessageId: 'acanvas-busy-race-second', input: [{ type: 'text', text: 'This is the second explicitly authorized isolated protocol message sent while the first turn is active. Do not use tools or read files. Reply exactly ACANVAS_BUSY_SECOND_OK.' }] });
  record.racedResponse = raced; emit('busy_turn_start_response', { result: raced.result, error: raced.error });
  const done = await completed; record.completion = { turnId: done.params.turn.id, status: done.params.turn.status };
  record.result = raced.error ? 'rejected' : raced.result?.turn?.id === first.result?.turn?.id ? 'active-turn-input-accepted-same-turn' : 'accepted-another-turn';
  emit('result', { result: record.result, completion: record.completion });
  const moduleIndex = process.argv.indexOf('--client-module');
  if (moduleIndex !== -1) {
    const modulePath = process.argv[moduleIndex + 1];
    if (!modulePath?.startsWith('/')) throw new Error('Pass the absolute owned candidate client module.');
    const { CodexRuntimeClient } = await import(modulePath);
    const beforeConnect = await lstat(socketPath, { bigint: true }), canonicalPath = await realpath(socketPath), canonicalStat = await lstat(canonicalPath, { bigint: true });
    emit('owned_socket_metadata', { socket: beforeConnect.isSocket(), symlink: beforeConnect.isSymbolicLink(), canonicalSocket: canonicalStat.isSocket(), canonicalSymlink: canonicalStat.isSymbolicLink(), canonicalPath });
    // Bundled app-server may publish a file-symlink alias. Product attachments
    // explicitly use its owned actual socket; the product rejects the alias.
    product = new CodexRuntimeClient({ endpoint: `unix://${canonicalPath}`, threadId });
    const identity = await product.connect();
    record.productClient = { modulePath, identity, checkedTarget: await product.checkTarget() };
    const finished = host.wait(message => message.method === 'turn/completed' && message.params?.threadId === threadId);
    record.productClient.accepted = await product.startUserInput({ text: 'This is an explicitly authorized isolated product protocol client smoke test on this same existing scratch thread. Do not use tools or read files. Reply exactly ACANVAS_PRODUCT_CLIENT_OK.', messageId: 'acanvas-product-client-idle' });
    const completion = await finished;
    record.productClient.completion = { turnId: completion.params.turn.id, status: completion.params.turn.status };
    if (record.productClient.completion.turnId !== record.productClient.accepted.turnId || record.productClient.completion.status !== 'completed') throw new Error('Product client completion mismatch');
    emit('product_client_same_existing_thread_pass', record.productClient);
  }
} catch (error) { record.failure = { name: error.name, message: error.message, stack: error.stack }; emit('failure', record.failure); process.exitCode = 1; }
finally {
  for (const rpc of [sender, host]) rpc?.socket.terminate();
  product?.close();
  if (child && child.exitCode === null) { child.kill('SIGTERM'); await Promise.race([new Promise(resolve => child.once('exit', resolve)), delay(5000)]); if (child.exitCode === null) { child.kill('SIGKILL'); await new Promise(resolve => child.once('exit', resolve)); } }
  record.cleanup = { scratchPreserved: true, ownerStopped: !child || child.exitCode !== null || child.signalCode !== null, ownerExitCode: child?.exitCode, ownerSignal: child?.signalCode };
  await writeFile(join(evidence, 'busy-race-result.json'), JSON.stringify(record, null, 2) + '\n');
}
