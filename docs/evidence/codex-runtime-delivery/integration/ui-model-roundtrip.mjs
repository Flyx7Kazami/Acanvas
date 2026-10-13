// Actual production UI -> candidate service -> attached original scratch runtime -> model CLI.
// The optional byte-for-byte Unix relay is an observational test instrument, never a product adapter.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, writeFile, lstat, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const evidence = dirname(fileURLToPath(import.meta.url));
const repository = resolve(evidence, '../../../..');
const require = createRequire(join(repository, 'package.json'));
const { WebSocket, WebSocketServer } = require('ws');
const { chromium } = require('playwright-core');
const candidate = process.argv[2];
assert(candidate?.startsWith('/'), 'Supply a frozen, privately built candidate.');
const ownership = JSON.parse(await readFile(join(candidate, 'candidate-owner.json'), 'utf8'));
assert.equal(ownership.kind, 'acanvas-host-delivery-candidate');
assert.equal(ownership.source, repository);
assert.equal(ownership.output, candidate);
const sourceManifestBytes = await readFile(join(candidate, 'source-manifest.json'));
const buildManifestBytes = await readFile(join(candidate, 'build-manifest.json'));
const sha256 = value => createHash('sha256').update(value).digest('hex');
const node = join(candidate, '.runtime/node_modules/node/bin/node');
const runtimeScript = join(candidate, 'scripts/runtime.mjs');
const binary = '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex';
// macOS sockaddr_un paths are limited to 104 bytes; create this owned fixture under the short canonical /tmp root.
const scratch = await realpath(await mkdtemp(join(await realpath('/tmp'), 'acanvas-ui-model-')));
const project = join(scratch, 'project');
await mkdir(project, { mode: 0o700 });
await writeFile(join(scratch, 'OWNERSHIP.json'), JSON.stringify({ kind: 'acanvas-owned-ui-runtime-integration', owner: randomUUID(), repository, candidate, purpose: 'Explicit isolated original test host, project and browser. No existing user host/project.', createdAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
const record = { version: 1, experiment: 'actual-ui-send-model-cli-original-runtime', startedAt: new Date().toISOString(), repository, candidate, scratch, project, nodeVersion: execFileSync(node, ['--version'], { encoding: 'utf8' }).trim(), runtimeBinary: binary, runtimeVersion: execFileSync(binary, ['--version'], { encoding: 'utf8' }).trim(), candidateSourceManifestSha256: sha256(sourceManifestBytes), candidateBuildManifestSha256: sha256(buildManifestBytes), configOverrides: false, defaultDesktopTouched: false, existingThreadsTouched: false, existingUserProjectTouched: false, events: [], browserRequests: [], productWire: [], modelCommands: [], approvals: [], checks: {} };
const emit = (kind, data = {}) => { record.events.push({ at: new Date().toISOString(), kind, ...data }); console.log(JSON.stringify({ kind, ...data })); };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const bounded = async (work, timeout, message) => { let timer; try { return await Promise.race([work, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), timeout); })]); } finally { clearTimeout(timer); } };
let owner, original, browser, context, page, serverUrl, sessionId, projectId, taskId, runId, consumerId, relayServer, relayWss;
let ownerStderrBytes = 0, serviceStarted = false, runtimeTurnId, finalTurn, initialReadyTurnId;
let approvalWaitMs = 0, approvalStarted, fatal;
const relaySockets = new Set();
const completionPath = join(scratch, 'completion.json');
const completion = { summary: 'Actual model acknowledged the request sent from the isolated production Canvas UI.', assetIds: [], validation: ['Read the saved request, recorded scoped progress, completed the receipt and released the queue.'], operations: [] };
const completionBytes = Buffer.from(`${JSON.stringify(completion, null, 2)}\n`);
await writeFile(completionPath, completionBytes, { flag: 'wx', mode: 0o600 });
record.completion = { path: completionPath, sha256: sha256(completionBytes), body: completion };
const progressMessage = 'Actual model read the isolated UI request and acknowledges it.';

async function cli(args, allowFailure = false) {
  const argv = [runtimeScript, 'cli', ...args, '--project', project];
  const child = spawn(node, argv, { cwd: candidate, env: { ...process.env, PATH: `${join(candidate, '.runtime/node_modules/node/bin')}:${process.env.PATH ?? ''}` }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', bytes => stdout += bytes.toString()); child.stderr.on('data', bytes => stderr += bytes.toString());
  const exitCode = await bounded(new Promise((resolveExit, reject) => { child.once('error', reject); child.once('exit', resolveExit); }), 20_000, 'Scoped candidate CLI timeout');
  let result; try { result = JSON.parse(stdout); } catch { result = { error: stderr.trim().slice(0, 1000), stdout: stdout.slice(0, 1000) }; }
  emit('harness_cli', { argv: [node, ...argv], exitCode, result });
  if (!allowFailure) assert.equal(exitCode, 0, `Candidate CLI failed: ${stderr.slice(0, 1000)}`);
  return { exitCode, result };
}
async function api(path, { method = 'GET', body, headers = {} } = {}) {
  const bootstrapResponse = await fetch(`${serverUrl}/api/bootstrap`);
  const bootstrap = await bootstrapResponse.json();
  // Credentials exist only in this function's in-memory authenticated channel.
  const response = await fetch(`${serverUrl}${path}`, { method, headers: { Authorization: `Bearer ${bootstrap.token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const result = await response.json();
  return { status: response.status, result };
}
function shellWords(text) {
  const words = []; let word = '', quote, escaped = false, started = false;
  for (const character of text) {
    if (escaped) { word += character; escaped = false; started = true; continue; }
    if (quote === "'") { if (character === "'") quote = undefined; else word += character; continue; }
    if (character === '\\') { escaped = true; started = true; continue; }
    if (quote === '"') { if (character === '"') quote = undefined; else word += character; continue; }
    if (character === "'" || character === '"') { quote = character; started = true; continue; }
    if (/\s/.test(character)) { if (started) { words.push(word); word = ''; started = false; } continue; }
    word += character; started = true;
  }
  assert(!quote && !escaped, 'Unfinished shell quoting'); if (started) words.push(word); return words;
}
function validateCommand(command, cwd) {
  assert([candidate, scratch, project].includes(cwd), 'Model command workdir must be an owned experiment directory');
  const outer = shellWords(command);
  assert(outer.length === 3 && ['/bin/zsh', '/bin/bash', '/bin/sh'].includes(outer[0]) && ['-lc', '-c'].includes(outer[1]), 'Unexpected model shell wrapper');
  assert(!/[\n;<>`]/.test(outer[2]) && !outer[2].includes('$(') && !outer[2].includes('&&') && !outer[2].includes('||'), 'One scoped command only');
  const argv = shellWords(outer[2]);
  const isNode = argv[0] === node || argv[0] === 'node' || argv[0] === join(repository, '.runtime/node_modules/node/bin/node');
  assert(isNode, 'Only declared Node runtime');
  let offset;
  if (argv[1] === runtimeScript && argv[2] === 'cli') offset = 3;
  else if ([join(candidate, 'skill/acanvas/scripts/acanvas.mjs'), join(candidate, 'dist/src/cli.js')].includes(argv[1])) offset = 2;
  else throw new Error('Only candidate bundled CLI');
  assert.equal(argv[offset], 'task'); const operation = argv[offset + 1];
  assert(['read', 'next', 'progress', 'complete'].includes(operation), 'Only authorized task operations');
  const help = argv.includes('--help'), fields = argv.slice(offset + 2).filter(field => field !== '--help'); assert.equal(fields.length % 2, 0);
  const flags = Object.fromEntries(Array.from({ length: fields.length / 2 }, (_, index) => fields.slice(index * 2, index * 2 + 2)));
  assert.equal(Object.keys(flags).length * 2, fields.length, 'Duplicate flags forbidden');
  assert.equal(flags['--project'], project); assert.equal(flags['--session'], sessionId);
  if (flags['--url']) assert.equal(flags['--url'], serverUrl);
  const common = ['--project', '--session', '--url'];
  // The declared CLI exits with help before connection discovery or business access.
  // This explicitly authorized inspection cannot inherit permission for any write.
  if (help) { assert(Object.keys(flags).every(key => common.includes(key)), 'Help inspection carries only its explicit scope'); return { operation: 'help', requestedOperation: operation, flags, argv }; }
  const allowed = { read: [...common, '--task', '--format'], next: [...common, '--consumer'], progress: [...common, '--task', '--run', '--consumer', '--message'], complete: [...common, '--task', '--run', '--consumer', '--input'] }[operation];
  assert(Object.keys(flags).every(key => allowed.includes(key)), 'Unknown CLI flag');
  if (operation !== 'next') assert.equal(flags['--task'], taskId);
  if (flags['--format']) assert.equal(flags['--format'], 'text');
  if (operation === 'progress' || operation === 'complete') { assert(runId && consumerId, 'Actual next must produce execution identity first'); assert.equal(flags['--run'], runId); assert.equal(flags['--consumer'], consumerId); }
  if (operation === 'next' && consumerId) assert.equal(flags['--consumer'], consumerId);
  if (operation === 'next' && !consumerId && flags['--consumer']) assert(/^[A-Za-z0-9._-]{1,128}$/.test(flags['--consumer']));
  if (operation === 'progress') assert.equal(flags['--message'], progressMessage);
  if (operation === 'complete') assert.equal(flags['--input'], completionPath);
  return { operation, flags, argv };
}

class OriginalHost {
  constructor(socket) {
    this.socket = socket; this.counter = 0; this.pending = new Map(); this.messages = []; this.waiters = [];
    socket.on('message', bytes => { void this.message(JSON.parse(bytes.toString())).catch(error => { fatal ??= error; emit('host_observer_failure', { message: error.message }); }); });
  }
  async message(message) {
    if (Object.hasOwn(message, 'id') && (Object.hasOwn(message, 'result') || Object.hasOwn(message, 'error'))) { const pending = this.pending.get(message.id); if (pending) { this.pending.delete(message.id); pending.resolve(message); } return; }
    const params = message.params ?? {};
    if (params.threadId !== record.threadId) return;
    if (Object.hasOwn(message, 'id')) { await this.approve(message); return; }
    if (message.method === 'item/completed') {
      const item = params.item;
      if (item?.type === 'userMessage') {
        const texts = item.content?.filter(content => content.type === 'text').map(content => content.text) ?? [];
        emit('original_host_user_message', { ownerPid: owner.pid, threadId: params.threadId, turnId: params.turnId, itemId: item.id, texts });
      } else if (item?.type === 'agentMessage') emit('original_host_agent_message', { ownerPid: owner.pid, threadId: params.threadId, turnId: params.turnId, itemId: item.id, text: item.text });
      else if (item?.type === 'commandExecution') {
        const command = { threadId: params.threadId, turnId: params.turnId, itemId: item.id, command: item.command, cwd: item.cwd, status: item.status, exitCode: item.exitCode, output: item.aggregatedOutput };
        let parsed;
        if (item.command?.includes('acanvas')) try { parsed = validateCommand(item.command, item.cwd); } catch { /* A permitted skill read is not a task command. */ }
        if (parsed) {
          command.operation = parsed.operation; command.flags = parsed.flags;
          if (item.exitCode === 0) {
            let output; try { output = JSON.parse(item.aggregatedOutput); } catch { output = undefined; }
            command.result = output;
            if (parsed.operation === 'next' && output?.task) { assert.equal(output.task.id, taskId); assert.equal(output.projectId, projectId); assert.equal(output.sessionId, sessionId); runId = output.run.id; consumerId = output.consumerId; record.runId = runId; record.consumerId = consumerId; }
          }
        }
        record.modelCommands.push(command);
        emit('original_host_model_command', { itemId: item.id, operation: command.operation, exitCode: item.exitCode, status: item.status, outputSha256: sha256(item.aggregatedOutput ?? '') });
      } else if (item) emit('original_host_other_completed_item', { itemId: item.id, type: item.type, ...(item.type === 'mcpToolCall' ? { server: item.server, tool: item.tool } : {}) });
    } else if (['turn/started', 'turn/completed', 'thread/status/changed'].includes(message.method)) emit('original_host_notification', { ownerPid: owner.pid, method: message.method, threadId: params.threadId, turn: params.turn && { id: params.turn.id, status: params.turn.status, error: params.turn.error }, status: params.status });
    this.messages.push(message);
    for (const waiter of [...this.waiters]) if (waiter.test(message)) { this.waiters.splice(this.waiters.indexOf(waiter), 1); waiter.resolve(message); }
  }
  async approve(message) {
    const started = Date.now(); approvalStarted = started;
    const params = message.params ?? {}; let decision = 'cancel', validated;
    try {
      assert.equal(message.method, 'item/commandExecution/requestApproval');
      validated = validateCommand(params.command, params.cwd);
      if (validated.operation === 'complete') assert.equal(sha256(await readFile(completionPath)), record.completion.sha256);
      decision = 'accept';
    } catch (error) { fatal ??= new Error(`Unexpected original-host approval: ${error.message}`); }
    const approval = { requestId: message.id, method: message.method, threadId: params.threadId, turnId: params.turnId, itemId: params.itemId, command: params.command, cwd: params.cwd, operation: validated?.operation, decision, policyAmendment: false, acceptedForSession: false };
    record.approvals.push(approval); emit('individual_original_host_approval', approval);
    this.socket.send(JSON.stringify({ id: message.id, result: { decision } }));
    approvalWaitMs += Date.now() - started; approvalStarted = undefined;
  }
  request(method, params) {
    const id = ++this.counter;
    emit('original_host_request', { method, threadId: params.threadId });
    return bounded(new Promise((resolveRpc, reject) => { this.pending.set(id, { resolve: message => { if (message.error) reject(new Error(`${method}: ${message.error.message}`)); else resolveRpc(message.result); } }); this.socket.send(JSON.stringify({ id, method, params })); }), 20_000, `Original host ${method} timeout`);
  }
  wait(test, timeout = 60_000) {
    const existing = this.messages.find(test); if (existing) return Promise.resolve(existing);
    return bounded(new Promise(resolveWait => this.waiters.push({ test, resolve: resolveWait })), timeout, 'Original host notification timeout');
  }
}
async function createRelay(socketPath, relayPath) {
  relayServer = createServer(); relayWss = new WebSocketServer({ server: relayServer });
  relayWss.on('error', error => { fatal ??= error; });
  relayWss.on('connection', client => {
    const upstream = new WebSocket(`ws+unix://${socketPath}:/rpc`, { perMessageDeflate: false, handshakeTimeout: 5000 });
    relaySockets.add(client); relaySockets.add(upstream); let ready = false, queue = [];
    const copy = (bytes, direction) => {
      const message = JSON.parse(bytes.toString()), params = message.params ?? {};
      if (direction === 'product-to-runtime') {
        const event = { at: new Date().toISOString(), direction, id: message.id, method: message.method, reply: Object.hasOwn(message, 'result') || Object.hasOwn(message, 'error'), threadId: params.threadId };
        if (message.method === 'initialize') event.clientInfo = params.clientInfo;
        if (message.method === 'turn/start') { event.clientUserMessageId = params.clientUserMessageId; event.input = params.input; runtimeTurnId = undefined; }
        record.productWire.push(event);
      } else if (message.method?.endsWith('/requestApproval')) record.productWire.push({ at: new Date().toISOString(), direction, id: message.id, method: message.method, threadId: params.threadId, turnId: params.turnId });
      else if (Object.hasOwn(message, 'result') && message.result?.turn) { runtimeTurnId = message.result.turn.id; record.productWire.push({ at: new Date().toISOString(), direction, id: message.id, acceptedTurn: { id: runtimeTurnId, status: message.result.turn.status } }); }
    };
    client.on('message', (bytes, binaryFrame) => { copy(bytes, 'product-to-runtime'); if (ready) upstream.send(bytes, { binary: binaryFrame }); else queue.push([bytes, binaryFrame]); });
    upstream.on('open', () => { ready = true; for (const [bytes, binaryFrame] of queue) upstream.send(bytes, { binary: binaryFrame }); queue = []; });
    upstream.on('message', (bytes, binaryFrame) => { copy(bytes, 'runtime-to-product'); if (client.readyState === WebSocket.OPEN) client.send(bytes, { binary: binaryFrame }); });
    for (const socket of [client, upstream]) { socket.on('error', () => {}); socket.on('close', () => { relaySockets.delete(socket); const other = socket === client ? upstream : client; if (other.readyState === WebSocket.OPEN) other.close(); }); }
  });
  await new Promise((resolveListen, reject) => { relayServer.once('error', reject); relayServer.listen(relayPath, resolveListen); });
  record.instrumentation = { kind: 'owned-passive-websocket-unix-relay', relayPath, upstreamSocketPath: socketPath, forwardsMessagesUnchanged: true, responsesInjected: false, purpose: 'Observe actual product requests and prove no product approval responses.' };
}

try {
  const listenPath = join(scratch, 'owner.sock'), relayPath = join(scratch, 'observed-owner.sock');
  owner = spawn(binary, ['app-server', '--listen', `unix://${listenPath}`], { cwd: scratch, env: { ...process.env, PATH: `${join(candidate, '.runtime/node_modules/node/bin')}:${process.env.PATH ?? ''}` }, stdio: ['pipe', 'ignore', 'pipe'] });
  record.ownerPid = owner.pid; owner.stderr.on('data', bytes => ownerStderrBytes += bytes.length);
  for (let index = 0; index < 100; index++) { if (await realpath(listenPath).then(path => lstat(path)).then(stat => stat.isSocket(), () => false)) break; assert.equal(owner.exitCode, null, 'Owned runtime exited during startup'); await delay(100); }
  // Resolve only the explicitly created listener, never scan or select an existing daemon.
  const socketPath = await realpath(listenPath), socketStat = await lstat(socketPath), aliasStat = await lstat(listenPath);
  assert(socketStat.isSocket() && !socketStat.isSymbolicLink()); assert.equal(socketStat.uid, process.getuid());
  record.originalEndpoint = { requestedListenPath: listenPath, listenPathIsSymlink: aliasStat.isSymbolicLink(), canonicalSocketPath: socketPath, uid: socketStat.uid, dev: socketStat.dev, ino: socketStat.ino };
  const originalSocket = new WebSocket(`ws+unix://${socketPath}:/rpc`, { perMessageDeflate: false, handshakeTimeout: 5000 });
  await new Promise((resolveOpen, reject) => { originalSocket.once('open', resolveOpen); originalSocket.once('error', reject); });
  original = new OriginalHost(originalSocket);
  await original.request('initialize', { clientInfo: { name: 'acanvas_integration_original_test_host', title: 'Original isolated integration test host', version: '0.1.0' }, capabilities: { experimentalApi: true } });
  originalSocket.send(JSON.stringify({ method: 'initialized', params: {} }));
  const created = await original.request('thread/start', { cwd: scratch, ephemeral: true, serviceName: 'acanvas-explicit-ui-runtime-test' });
  record.threadId = created.thread.id;
  record.inherited = { model: created.model, approvalPolicy: created.approvalPolicy, approvalsReviewer: created.approvalsReviewer, sandbox: created.sandbox, cwd: created.cwd, reasoningEffort: created.reasoningEffort };
  assert.equal(created.approvalPolicy, 'on-request'); assert.equal(created.approvalsReviewer, 'user'); assert.deepEqual(created.sandbox, { type: 'readOnly', networkAccess: false });
  emit('owned_original_thread_started', { ownerPid: owner.pid, threadId: record.threadId, inherited: record.inherited });
  const ready = await original.request('turn/start', { threadId: record.threadId, clientUserMessageId: 'acanvas-owned-integration-ready', input: [{ type: 'text', text: 'Explicit isolated original test host. Do not use tools or read files. Reply exactly ACANVAS_INTEGRATION_READY. Later saved Canvas requests may authorize only their scoped scratch CLI operations. Preserve all inherited policies and request individual approval when needed.' }] });
  initialReadyTurnId = ready.turn.id;
  const readyDone = await original.wait(message => message.method === 'turn/completed' && message.params.turn.id === initialReadyTurnId);
  assert.equal(readyDone.params.turn.status, 'completed');
  assert(original.messages.some(message => message.method === 'item/completed' && message.params.turnId === initialReadyTurnId && message.params.item?.type === 'agentMessage' && message.params.item.text === 'ACANVAS_INTEGRATION_READY'));
  record.initialReadyTurnId = initialReadyTurnId;
  const opened = (await cli(['project', 'open', '--port', '0', '--host', 'codex', '--thread', record.threadId])).result;
  serviceStarted = true; serverUrl = new URL(opened.openUrl).origin; sessionId = opened.sessionId; projectId = opened.project.id;
  Object.assign(record, { serverUrl, sessionId, projectId, service: opened.service });
  assert.equal(opened.binding.threadId, record.threadId); assert.equal(opened.binding.sessionId, sessionId);
  await createRelay(socketPath, relayPath);
  const attachment = (await cli(['host', 'attach', '--session', sessionId, '--host', 'codex', '--thread', record.threadId, '--endpoint', `unix://${relayPath}`, '--url', serverUrl])).result;
  assert.equal(attachment.projectId, projectId); assert.equal(attachment.sessionId, sessionId); assert.equal(attachment.attachment.threadId, record.threadId); assert.equal(attachment.summary.connection, 'ready');
  record.attachment = attachment;
  const other = (await cli(['session', 'create', '--name', 'Unattached isolated scope', '--url', serverUrl])).result;
  record.otherSessionId = other.id;
  const invalidThread = await cli(['host', 'attach', '--session', sessionId, '--host', 'codex', '--thread', 'wrong-owned-target', '--endpoint', `unix://${relayPath}`, '--url', serverUrl], true);
  assert.equal(invalidThread.exitCode, 1);
  const unboundScope = await cli(['host', 'attach', '--session', other.id, '--host', 'codex', '--thread', record.threadId, '--endpoint', `unix://${relayPath}`, '--url', serverUrl], true);
  assert.equal(unboundScope.exitCode, 1);
  const browserLike = await api(`/api/sessions/${sessionId}/host-runtime`, { headers: { Origin: serverUrl } });
  assert.equal(browserLike.status, 403); record.checks.httpOriginWithBearerRejected = browserLike;
  const otherStatus = (await cli(['host', 'status', '--session', other.id, '--url', serverUrl])).result;
  assert.equal(otherStatus.summary.mode, 'queue');
  const stateBefore = await api(`/api/state?sessionId=${sessionId}`); assert.equal(stateBefore.status, 200);
  assert(!JSON.stringify(stateBefore.result).includes(relayPath)); assert(!JSON.stringify(stateBefore.result).includes(record.threadId));
  browser = await chromium.launch({ channel: 'chrome', headless: true, chromiumSandbox: true });
  context = await browser.newContext({ viewport: { width: 1440, height: 1000 } }); page = await context.newPage();
  page.on('response', response => { const url = new URL(response.url()); if (url.origin === serverUrl && url.pathname.startsWith('/api/')) record.browserRequests.push({ at: new Date().toISOString(), method: response.request().method(), path: `${url.pathname}${url.search}`, status: response.status() }); });
  await page.goto(opened.openUrl); await page.locator('#whiteboard').waitFor({ state: 'visible' });
  const cookieRead = await page.evaluate(async path => { const response = await fetch(path); return { status: response.status, body: await response.json() }; }, `/api/sessions/${sessionId}/host-runtime`);
  assert.equal(cookieRead.status, 401); record.checks.browserCookieRuntimeRejected = cookieRead;
  const request = `This is the explicitly authorized isolated Canvas UI integration request in this new original test session. Acknowledge this saved request through actual Canvas CLI tools, with no new artifacts or external jobs. Use workdir ${candidate}. The declared Node 24 executable is ${node}; use ${node} ${runtimeScript} cli task <operation> --project ${project} --session ${sessionId} --url ${serverUrl}.\nRead this exact saved task (task ID from the incoming adapter message), claim it with task next and a fresh consumer activation, then use its returned run and consumer. Record task progress with exactly this message: ${progressMessage}\nComplete using the owned precreated JSON at ${completionPath}; it has assetIds [] and operations []. Then task next with the same consumer to release idle, and task read to confirm the persisted receipt. The completion JSON SHA256 is ${record.completion.sha256}.\nOnly task read/next/progress/complete in this project and session are authorized. Read-only scoped CLI --help inspection of those four operations is also explicitly authorized; it must use this same CLI, project and session, with no business writes. Read the exact candidate acanvas skill when instructed. Use individual normal approval for each exact localhost command if needed; do not change policies or grant session permissions. No shell chains, redirects, files created, other projects, external jobs, app controls or person-directed messages. After actual success reply ACANVAS_UI_MODEL_OK with task ID, run, consumer and receipt. Preserve any current work and process this at the task boundary.`;
  record.requestFixture = request; await writeFile(join(evidence, 'ui-request-fixture.txt'), `${request}\n`);
  await page.locator('#instruction').fill(request);
  const sent = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === `/api/sessions/${sessionId}/tasks`);
  const modelStartedAt = Date.now(); await page.getByRole('button', { name: 'Send request', exact: true }).click();
  const sendResponse = await sent; assert.equal(sendResponse.status(), 200); const sentResult = await sendResponse.json(), sentTask = sentResult.task; taskId = sentTask.id; record.taskId = taskId;
  assert.equal(sentTask.sessionId, sessionId); assert.equal(sentTask.snapshot.userRequest.text, request); assert.equal(sentTask.hostDelivery?.state, 'pending');
  record.sentTask = sentTask;
  emit('actual_ui_send_persisted', { taskId, projectId, sessionId, status: sentTask.status, hostDelivery: sentTask.hostDelivery });
  while (true) {
    if (fatal) throw fatal;
    const wallMs = Date.now() - modelStartedAt, currentApprovalWait = approvalStarted ? Date.now() - approvalStarted : 0;
    const activeMs = wallMs - approvalWaitMs - currentApprovalWait;
    assert(activeMs < 240_000 && wallMs < 300_000, `Model budget exceeded (${Math.round(activeMs / 1000)} active / ${Math.round(wallMs / 1000)} wall seconds)`);
    const done = original.messages.find(message => message.method === 'turn/completed' && message.params.turn.id !== initialReadyTurnId);
    if (done) { finalTurn = done.params.turn; record.modelTiming = { activeMs, wallMs, approvalWaitMs }; break; }
    await delay(500);
  }
  assert.equal(finalTurn.status, 'completed'); assert.equal(finalTurn.id, runtimeTurnId); assert(owner.exitCode === null, 'Same original runtime remains alive until verification');
  const finalSocketStat = await lstat(record.originalEndpoint.canonicalSocketPath);
  assert.equal(finalSocketStat.dev, record.originalEndpoint.dev); assert.equal(finalSocketStat.ino, record.originalEndpoint.ino); assert.equal(finalSocketStat.uid, record.originalEndpoint.uid);
  assert.equal(record.events.filter(event => event.kind === 'original_host_request' && event.method === 'turn/start').length, 1, 'Only Ready was manually started by the original host');
  record.finalTurn = { id: finalTurn.id, status: finalTurn.status };
  const productInputs = record.productWire.filter(message => message.direction === 'product-to-runtime' && message.method === 'turn/start');
  assert.equal(productInputs.length, 1); assert.equal(productInputs[0].threadId, record.threadId); assert.equal(productInputs[0].clientUserMessageId, taskId);
  assert(productInputs[0].input.every(input => input.type === 'text' && input.text.includes(taskId) && input.text.includes(sessionId) && input.text.includes(project)));
  assert(!record.productWire.some(message => message.direction === 'product-to-runtime' && message.reply));
  assert(!record.productWire.some(message => ['thread/start', 'thread/resume', 'turn/steer', 'turn/interrupt'].includes(message.method)));
  const originalInputs = record.events.filter(event => event.kind === 'original_host_user_message' && event.turnId === finalTurn.id);
  assert.equal(originalInputs.length, 1); assert.equal(originalInputs[0].threadId, record.threadId); assert.deepEqual(originalInputs[0].texts, productInputs[0].input.map(input => input.text));
  const successful = record.modelCommands.filter(command => command.exitCode === 0 && command.operation);
  for (const operation of ['read', 'next', 'progress', 'complete']) assert(successful.some(command => command.operation === operation), `Actual successful model CLI ${operation} missing`);
  assert(successful.some(command => command.operation === 'next' && command.result?.task === null && command.result.consumerId === consumerId));
  assert(successful.some(command => command.operation === 'read' && command.result?.task?.status === 'completed' && command.result.task.receipt?.summary === completion.summary));
  assert(record.approvals.length >= 4); assert(record.approvals.every(approval => approval.decision === 'accept' && !approval.policyAmendment && !approval.acceptedForSession));
  const persisted = await api(`/api/sessions/${sessionId}/tasks/${taskId}/context`); assert.equal(persisted.status, 200);
  const task = persisted.result.task;
  assert.equal(task.status, 'completed'); assert.equal(task.currentRunId, runId); assert.equal(task.sessionId, sessionId); assert.equal(task.receipt.summary, completion.summary); assert.deepEqual(task.receipt.assetIds, []); assert.deepEqual(task.receipt.objectIds, []);
  assert.equal(task.runs.length, 1); assert.equal(task.runs[0].id, runId); assert.equal(task.runs[0].consumerId, consumerId); assert.equal(task.runs[0].status, 'completed'); assert(task.runs[0].progress.some(progress => progress.message === progressMessage)); assert.equal(task.hostDelivery.state, 'observed'); assert.equal(task.hostDelivery.turnId, finalTurn.id);
  record.persistedTask = task;
  const finalState = await api(`/api/state?sessionId=${sessionId}`); assert.equal(finalState.result.session.consumerId, null); assert.equal(finalState.result.tasks.length, 1); assert.equal(finalState.result.assets.length, 0); assert.equal(finalState.result.objects.length, 0);
  const otherState = await api(`/api/state?sessionId=${other.id}`); assert.equal(otherState.result.tasks.length, 0); assert.equal(otherState.result.hostRuntime.mode, 'queue');
  const wrongScopeTask = await api(`/api/sessions/${other.id}/tasks/${taskId}/context`); assert.equal(wrongScopeTask.status, 404); record.checks.wrongScopeTaskReadRejected = wrongScopeTask;
  await page.getByRole('button', { name: 'More request actions', exact: true }).click(); await page.getByRole('menuitem', { name: 'Request history', exact: true }).click();
  await page.getByText(completion.summary, { exact: true }).waitFor({ state: 'visible' });
  assert((await page.locator('#request-history').innerText()).includes('Completed'));
  record.browserHistory = { url: page.url(), text: await page.locator('#request-history').innerText(), receiptVisible: true };
  await page.locator('#request-history').screenshot({ path: join(evidence, 'ui-history.png') });
  const finalMessages = record.events.filter(event => event.kind === 'original_host_agent_message' && event.turnId === finalTurn.id);
  const finalReply = finalMessages.findLast(message => message.text.includes('ACANVAS_UI_MODEL_OK'));
  assert(finalReply?.text.includes(taskId)); record.modelFinal = finalReply;
  Object.assign(record.checks, { actualProductionUiSend: true, candidateServicePersistedSend: true, exactlyOneProductUserInput: true, noManualUserInputAfterReady: true, sameCanonicalRuntimeSocketFingerprint: true, sameOriginalOwnerPid: owner.pid, sameOriginalLoadedThread: record.threadId, actualModelCliReadNextProgressComplete: true, scopedRunConsumerPersisted: true, completedModelTurn: true, persistedReceipt: true, browserRequestHistoryReceipt: true, otherScopeHasNoTasksOrAttachment: true, productApprovalResponses: 0, productThreadStartResumeSteerInterrupt: 0, originalHostIndividualApprovals: record.approvals.length, userProjectUntouched: true });
  record.result = 'PASS'; emit('integration_pass', { taskId, runId, consumerId, threadId: record.threadId, turnId: finalTurn.id, approvals: record.approvals.length });
} catch (error) {
  record.result = 'FAIL'; record.failure = { name: error.name, message: error.message, stack: error.stack }; emit('integration_failure', record.failure); process.exitCode = 1;
} finally {
  let serviceStopped = false;
  if (page) await page.close().catch(() => {});
  if (context) await context.close().catch(() => {});
  if (browser) await browser.close().catch(() => {});
  if (serviceStarted) {
    try { const stopped = await cli(['project', 'stop', ...(serverUrl ? ['--url', serverUrl] : [])]); serviceStopped = stopped.result.status === 'stopped'; } catch (error) { record.cleanupServiceError = error.message; }
  }
  original?.socket.close();
  for (const socket of relaySockets) socket.close();
  if (relayWss) await bounded(new Promise(resolveClose => relayWss.close(resolveClose)), 5000, 'Relay close timeout').catch(() => {});
  if (relayServer) await bounded(new Promise(resolveClose => relayServer.close(resolveClose)), 5000, 'Relay HTTP close timeout').catch(() => {});
  if (owner && owner.exitCode === null && owner.signalCode === null) { owner.stdin.end(); owner.kill('SIGTERM'); await bounded(new Promise(resolveExit => owner.once('exit', resolveExit)), 5000, 'Owned runtime normal stop timeout').catch(() => {}); }
  record.cleanup = { scratchPreserved: true, candidatePreserved: true, browserClosed: !!browser && !browser.isConnected(), serviceStopped, originalOwnerStopped: !owner || owner.exitCode !== null || owner.signalCode !== null, ownerExitCode: owner?.exitCode, ownerSignal: owner?.signalCode, ownerStderrBytes, noUnknownMaterialDeleted: true };
  record.finishedAt = new Date().toISOString();
  await writeFile(join(evidence, 'integration-result.json'), `${JSON.stringify(record, null, 2)}\n`);
  await writeFile(join(evidence, 'candidate-source-manifest.json'), sourceManifestBytes);
  await writeFile(join(evidence, 'candidate-build-manifest.json'), buildManifestBytes);
  emit('cleanup', record.cleanup);
}
