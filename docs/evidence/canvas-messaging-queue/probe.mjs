#!/usr/bin/env node
// Bounded feasibility probe. All persistent writes use the built CLI/local HTTP API.
// Run from the repository: .runtime/node_modules/node/bin/node docs/evidence/canvas-messaging-queue/probe.mjs
// Add --hold-candidate only when a parent will consume the final task and stop this owned service.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const evidencePath = join(repository, 'docs/evidence/canvas-messaging-queue/result.json');
const runtime = join(repository, '.runtime/node_modules/node/bin/node');
const cliScript = join(repository, 'scripts/runtime.mjs');
const scratch = await mkdtemp(join(tmpdir(), 'acanvas-messaging-queue-'));
const ownership = { owner: 'canvas-messaging-queue probe', probeId: randomUUID(), repository, scratch, createdAt: new Date().toISOString() };
await writeFile(join(scratch, 'PROBE-OWNERSHIP.json'), JSON.stringify(ownership, null, 2));
const env = { ...process.env };
for (const name of Object.keys(env)) if (name === 'CODEX_THREAD_ID' || name.startsWith('ACANVAS_')) delete env[name];
const holdCandidate = process.argv.includes('--hold-candidate');
let url, running = false, serviceId, counter = 0;
const result = {
  schemaVersion: 1, startedAt: ownership.createdAt, probeId: ownership.probeId,
  scope: 'isolated scratch project; experimental host bindings; no real host message ingress',
  repositoryHead: (await execute('git', ['rev-parse', 'HEAD'], { cwd: repository })).stdout.trim(),
  gitStatusAtHarnessStart: (await execute('git', ['status', '--short'], { cwd: repository })).stdout.trim(),
  acanvasVersion: JSON.parse(await readFile(join(repository, 'package.json'), 'utf8')).version,
  nodeVersion: (await execute(runtime, ['--version'])).stdout.trim(),
  builtFiles: {}, checks: [], commands: [], ids: {}, cleanup: { scratch, ownershipMarker: join(scratch, 'PROBE-OWNERSHIP.json'), scratchRemoved: false },
  limits: ['Canvas UI Send was not operated; CLI uses the same HTTP draft/task business endpoints.', 'Experimental binding names prove local scope resolution only; they do not prove a host wakeup or message injection.', 'No provider job, external paid operation, or user artwork was involved.', 'The continuation in this harness is explicit CLI activation; actual originating-model continuation requires separate host evidence.']
};
for (const file of ['dist/src/cli.js', 'dist/src/server/service.js', 'dist/src/server/http.js']) result.builtFiles[file] = createHash('sha256').update(await readFile(join(repository, file))).digest('hex');
const sanitize = value => JSON.parse(JSON.stringify(value).replaceAll(scratch, '<SCRATCH_PROJECT>'));
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const taskSummary = task => task && ({ id: task.id, sessionId: task.sessionId, draftId: task.draftId, sequence: task.sequence, status: task.status, currentRunId: task.currentRunId, receipt: task.receipt, runs: task.runs?.map(run => ({ id: run.id, consumerId: run.consumerId, status: run.status, progress: run.progress, outputAssetIds: run.outputAssetIds })), lateResultsCount: task.lateResults?.length });
function boundedResponse(value) {
  if (!value || typeof value !== 'object' || value.error) return value;
  if (Array.isArray(value.tasks) && value.session) return {
    projectId: value.project.id, session: { id: value.session.id, consumerId: value.session.consumerId },
    draft: { id: value.draft.id, revision: value.draft.revision, text: value.draft.text },
    tasks: value.tasks.map(task => ({ id: task.id, draftId: task.draftId, status: task.status, currentRunId: task.currentRunId, runs: task.runs.map(run => ({ id: run.id, consumerId: run.consumerId, status: run.status, progressCount: run.progress.length })), receiptSha256: task.receipt ? digest(task.receipt) : null, lateResultsCount: task.lateResults.length })),
    objects: value.objects.map(object => ({ id: object.id, assetId: object.assetId, version: object.version, sourceTaskId: object.sourceTaskId, sourceRunId: object.sourceRunId })),
    tasksSha256: digest(value.tasks), objectsSha256: digest(value.objects)
  };
  if ('task' in value) return { task: taskSummary(value.task), ...(value.run ? { run: { id: value.run.id, taskId: value.run.taskId, consumerId: value.run.consumerId, status: value.run.status } } : {}), ...(value.consumerId ? { consumerId: value.consumerId, projectId: value.projectId, sessionId: value.sessionId } : {}), ...(value.draft ? { draft: { id: value.draft.id, revision: value.draft.revision } } : {}) };
  if (value.snapshot && value.runs) return taskSummary(value);
  return value;
}
function evidenceJson(value) {
  const { commands, ...metadata } = value;
  const prefix = JSON.stringify(metadata, null, 2).slice(0, -2);
  return `${prefix},\n  "commands": [\n${commands.map(command => `    ${JSON.stringify(command)}`).join(',\n')}\n  ]\n}\n`;
}
const fullCommandTrace = [];
const check = (name, details = {}) => { result.checks.push({ name, status: 'PASS', ...sanitize(details) }); console.log(`PASS ${name}`); };
async function cli(label, args, { expectedError, selectedUrl = url } = {}) {
  const full = ['cli', ...args, '--project', scratch, ...(selectedUrl ? ['--url', selectedUrl] : [])];
  let stdout = '', stderr = '', code = 0;
  try { ({ stdout, stderr } = await execute(runtime, [cliScript, ...full], { cwd: repository, env, maxBuffer: 4 * 1024 * 1024, timeout: 15_000 })); }
  catch (error) { stdout = error.stdout ?? ''; stderr = error.stderr ?? ''; code = error.code ?? 1; }
  let value;
  try { value = JSON.parse(code ? stderr.trim() : stdout.trim()); } catch { value = (code ? stderr : stdout).trim(); }
  const trace = { label, argv: sanitize(['.runtime/node_modules/node/bin/node', 'scripts/runtime.mjs', ...full]), exitCode: code, response: sanitize(value) };
  fullCommandTrace.push(trace);
  const entry = { ...trace, response: sanitize(boundedResponse(value)) };
  result.commands.push(entry);
  if (expectedError) { assert.notEqual(code, 0, label); if (expectedError !== '*') assert.equal(value?.error?.code, expectedError, label); }
  else assert.equal(code, 0, `${label}: ${stderr}`);
  return value;
}
async function input(name, value) { const path = join(scratch, `${++counter}-${name}.json`); await writeFile(path, JSON.stringify(value, null, 2)); return path; }
const state = session => cli(`read session ${session}`, ['session', 'read', '--session', session]);
async function send(session, text, label) {
  const before = await state(session);
  const draft = await cli(`save ${label}`, ['draft', 'save', '--session', session, '--input', await input('draft', { ...before.draft, text })]);
  const sent = await cli(`send ${label}`, ['draft', 'send', '--session', session, '--draft', draft.id, '--revision', String(draft.revision)]);
  assert.equal(sent.task.status, 'queued');
  assert.equal(sent.task.draftId, draft.id);
  result.ids[label] = { sessionId: session, draftId: draft.id, revision: draft.revision, taskId: sent.task.id, sequence: sent.task.sequence };
  return { draft, sent };
}
async function complete(session, claim, label, completion, options) {
  return cli(label, ['task', 'complete', '--session', session, '--task', claim.task.id, '--run', claim.run.id, '--consumer', claim.consumerId, '--input', await input('completion', completion)], options);
}
async function stop(label) {
  const response = await cli(label, ['project', 'stop']);
  assert.equal(response.status, 'stopped'); running = false;
}
async function open(session) {
  const response = await cli('open owned service', ['project', 'open', '--port', '0', ...(session ? ['--session', session] : ['--host', 'queue-probe-experimental', '--thread', `probe:${ownership.probeId}:A`])], { selectedUrl: null });
  url = new URL(response.openUrl).origin; running = true; serviceId = response.service.instanceId;
  assert.notEqual(new URL(url).port, '4317');
  return response;
}

try {
  const opened = await open();
  const a = opened.sessionId;
  const bOpened = await cli('bind experimental B', ['project', 'open', '--host', 'queue-probe-experimental', '--thread', `probe:${ownership.probeId}:B`]);
  const b = bOpened.sessionId;
  assert.notEqual(a, b);
  const aReopened = await cli('resolve experimental A again', ['project', 'open', '--host', 'queue-probe-experimental', '--thread', `probe:${ownership.probeId}:A`]);
  assert.equal(aReopened.sessionId, a);
  result.ids.scopes = { projectId: opened.project.id, a, b, experimentalHost: 'queue-probe-experimental' };
  check('experimental binding stable and scopes distinct', { a, b });

  const first = await send(a, 'Message 1: create a local text output and publish one canvas card.', 'message1');
  const retry = await cli('retry same submission ID/revision', ['draft', 'send', '--session', a, '--draft', first.draft.id, '--revision', String(first.draft.revision)]);
  assert.equal(retry.task.id, first.sent.task.id);
  assert.equal((await state(a)).tasks.length, 1);
  check('duplicate send returned one original task', { taskId: retry.task.id, draftId: first.draft.id });

  const consumers = [`probe-${ownership.probeId}-first`, `probe-${ownership.probeId}-competitor`];
  const race = await Promise.allSettled(consumers.map(consumer => cli(`competing claim ${consumer}`, ['task', 'next', '--session', a, '--consumer', consumer], { expectedError: undefined })));
  const successes = race.filter(item => item.status === 'fulfilled');
  assert.equal(successes.length, 1);
  assert.equal(race.filter(item => item.status === 'rejected').length, 1);
  const firstClaim = successes[0].value;
  assert.equal(firstClaim.task.id, first.sent.task.id);
  const rejected = result.commands.filter(item => item.label.startsWith('competing claim') && item.exitCode !== 0);
  assert.equal(rejected[0].response.error.code, 'consumer_conflict');
  result.ids.firstConsumer = firstClaim.consumerId;
  result.ids.firstRun = firstClaim.run.id;
  check('same-scope concurrent claims elected exactly one consumer', { consumerId: firstClaim.consumerId, runId: firstClaim.run.id, competitorError: rejected[0].response });

  const second = await send(a, 'Message 2: acknowledge this follow-up independently.', 'message2');
  assert.equal(second.sent.task.sequence, 2);
  assert.notEqual(second.sent.task.id, first.sent.task.id);
  assert.notEqual(second.draft.id, first.draft.id);
  const other = await send(b, 'Other scope: return an isolated textual acknowledgment.', 'otherScope');
  const bClaim = await cli('claim isolated B while A running', ['task', 'next', '--session', b]);
  assert.equal(bClaim.task.id, other.sent.task.id);
  await cli('cross-scope read is rejected', ['task', 'read', '--session', b, '--task', first.sent.task.id], { expectedError: 'task_missing' });
  await cli('record message 1 progress', ['task', 'progress', '--session', a, '--task', firstClaim.task.id, '--run', firstClaim.run.id, '--consumer', firstClaim.consumerId, '--message', 'Read message 1 and generated its owned local text output.']);
  const aRunning = await state(a), bRunning = await state(b);
  assert.equal(aRunning.tasks.find(task => task.id === firstClaim.task.id).runs[0].progress.length, 1);
  assert.equal(aRunning.tasks.find(task => task.id === second.sent.task.id).runs.length, 0);
  assert.equal(bRunning.tasks[0].runs[0].progress.length, 0);
  check('per-message progress and parallel scope isolation', { aTaskIds: aRunning.tasks.map(task => task.id), bTaskIds: bRunning.tasks.map(task => task.id) });

  const output = join(scratch, 'message-1-output.txt');
  const outputText = `Owned feasibility output for ${firstClaim.task.id}.\n`;
  await writeFile(output, outputText);
  const asset = await cli('register real owned output', ['asset', 'import', '--session', a, '--task', firstClaim.task.id, '--run', firstClaim.run.id, '--consumer', firstClaim.consumerId, '--file', output]);
  const delivery = { summary: 'Published the owned local text output.', assetIds: [asset.id], validation: ['Actual bytes saved and imported; source task/run identity verified.'], operations: [{ type: 'create', object: { assetId: asset.id, x: 0, y: 0, width: 320, height: 160 } }] };
  const delivered = await complete(a, firstClaim, 'complete message 1 with receipt', delivery);
  assert.equal(delivered.status, 'completed'); assert.equal(delivered.receipt.assetIds[0], asset.id);
  const afterDelivery = await state(a);
  const object = afterDelivery.objects.find(object => object.id === delivered.receipt.objectIds[0]);
  assert.equal(object.sourceTaskId, firstClaim.task.id); assert.equal(object.sourceRunId, firstClaim.run.id);
  const outputRead = join(scratch, 'message-1-readback.txt');
  await cli('read back delivered bytes', ['asset', 'read', '--session', a, '--asset', asset.id, '--out', outputRead]);
  assert.equal(await readFile(outputRead, 'utf8'), outputText);
  const completedAgain = await complete(a, firstClaim, 'retry exact completion identity', delivery);
  assert.deepEqual(completedAgain.receipt, delivered.receipt);
  assert.equal((await state(a)).objects.length, 1);
  result.ids.delivery = { assetId: asset.id, objectId: object.id, outputSha256: createHash('sha256').update(outputText).digest('hex'), receipt: delivered.receipt };
  check('real output, atomic receipt, and same-identity completion retry', result.ids.delivery);
  await cli('stale completed-run progress rejected', ['task', 'progress', '--session', a, '--task', firstClaim.task.id, '--run', firstClaim.run.id, '--consumer', firstClaim.consumerId, '--message', 'Deliberately late progress probe.'], { expectedError: 'stale_run' });
  const oldContext = await cli('query completed message with late result', ['task', 'read', '--session', a, '--task', firstClaim.task.id]);
  assert.equal(oldContext.task.status, 'completed'); assert.equal(oldContext.task.lateResults.length, 1);
  check('late completed-run write retained for review and rejected');

  const secondClaim = await cli('FIFO next under stable consumer', ['task', 'next', '--session', a, '--consumer', firstClaim.consumerId]);
  assert.equal(secondClaim.task.id, second.sent.task.id);
  await cli('record message 2 progress', ['task', 'progress', '--session', a, '--task', secondClaim.task.id, '--run', secondClaim.run.id, '--consumer', secondClaim.consumerId, '--message', 'Read and acknowledged message 2 separately.']);
  // A private one-shot loopback relay commits the API request, then destroys the
  // client connection. It forwards only bootstrap and this exact task completion.
  const completionPath = `/api/sessions/${a}/tasks/${secondClaim.task.id}/complete`;
  let commitWitness;
  const relay = createServer(async (request, response) => {
    try {
      if (!['/api/bootstrap', completionPath].includes(request.url)) { response.writeHead(404); response.end(); return; }
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const upstream = await fetch(`${url}${request.url}`, { method: request.method, headers: { ...(request.headers.authorization ? { Authorization: request.headers.authorization } : {}), 'Content-Type': 'application/json' }, ...(request.method === 'POST' ? { body: Buffer.concat(chunks) } : {}) });
      const value = await upstream.json();
      if (request.url === completionPath && upstream.ok) { commitWitness = value; response.destroy(); return; }
      response.writeHead(upstream.status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value));
    } catch { response.destroy(); }
  });
  await new Promise(resolveReady => relay.listen(0, '127.0.0.1', resolveReady));
  const relayUrl = `http://127.0.0.1:${relay.address().port}`;
  try {
    await complete(a, secondClaim, 'complete with injected lost acknowledgment', { summary: 'Message 2 acknowledged.', assetIds: [], validation: ['Text-only acknowledgment.'], operations: [] }, { expectedError: '*', selectedUrl: relayUrl });
  } finally { await new Promise(resolveClosed => relay.close(resolveClosed)); }
  assert.equal(commitWitness.status, 'completed');
  const recovered = await cli('query after lost completion response', ['task', 'read', '--session', a, '--task', secondClaim.task.id]);
  assert.deepEqual(recovered.task.receipt, commitWitness.receipt);
  const retryAfterLost = await complete(a, secondClaim, 'retry after persisted receipt query', { summary: 'Message 2 acknowledged.', assetIds: [], validation: ['Text-only acknowledgment.'], operations: [] });
  assert.deepEqual(retryAfterLost.receipt, recovered.task.receipt);
  check('lost completion response recovered by task/run receipt query', { runId: secondClaim.run.id, receipt: recovered.task.receipt });

  await complete(b, bClaim, 'complete isolated B', { summary: 'Other scope acknowledged.', assetIds: [], validation: ['No A task changed.'], operations: [] });
  await cli('release B idle', ['task', 'next', '--session', b, '--consumer', bClaim.consumerId]);
  const idle = await cli('release A idle', ['task', 'next', '--session', a, '--consumer', firstClaim.consumerId]);
  assert.equal(idle.task, null); assert.equal((await state(a)).session.consumerId, null);
  const late = await send(a, 'Message 3: this arrived after idle; handle only on explicit continuation.', 'afterIdle');
  const beforeRestart = await state(a);
  assert.equal(beforeRestart.tasks.find(task => task.id === late.sent.task.id).status, 'queued');
  assert.equal(beforeRestart.session.consumerId, null);
  await cli('retired consumer cannot wake queued request', ['task', 'next', '--session', a, '--consumer', firstClaim.consumerId], { expectedError: 'consumer_retired' });
  const originalService = serviceId;
  await stop('stop owned service for durability test');
  const restarted = await open(a);
  assert.notEqual(restarted.service.instanceId, originalService);
  const afterRestart = await state(a);
  assert.deepEqual(afterRestart.tasks, beforeRestart.tasks);
  assert.deepEqual(afterRestart.objects, beforeRestart.objects);
  assert.equal(afterRestart.session.consumerId, null);
  check('idle request and completed receipts persist through real service restart', { previousInstanceId: originalService, instanceId: serviceId, queuedTaskId: late.sent.task.id });
  const newClaim = await cli('explicit continuation allocates fresh consumer', ['task', 'next', '--session', a]);
  assert.notEqual(newClaim.consumerId, firstClaim.consumerId);
  assert.equal(newClaim.task.id, late.sent.task.id);
  await complete(a, newClaim, 'complete explicit continuation', { summary: 'Message 3 processed after explicit CLI continuation.', assetIds: [], validation: ['Fresh activation; saved queued task and history read.'], operations: [] });
  await cli('release continued queue idle', ['task', 'next', '--session', a, '--consumer', newClaim.consumerId]);
  check('post-idle continuation uses fresh consumer and processes saved task', { consumerId: newClaim.consumerId, taskId: newClaim.task.id, runId: newClaim.run.id });

  if (holdCandidate) {
    const candidate = await send(a, 'Host feasibility candidate: read this queued request, record one progress message, and complete it with a textual receipt. Do not create external jobs or contact other people.', 'hostCandidate');
    result.ids.hostCandidate = { project: scratch, url, openUrl: `${url}/?session=${a}`, sessionId: a, taskId: candidate.sent.task.id, draftId: candidate.draft.id, instanceId: serviceId };
    result.cleanup.serviceStopped = false;
    result.cleanup.handoff = 'Owned service deliberately left running for parent-authorized fresh host continuation; parent must stop this exact project afterwards.';
  } else { await stop('final stop owned service'); result.cleanup.serviceStopped = true; }
  result.status = 'PASS';
} catch (error) {
  result.status = 'FAIL'; result.failure = { message: error.message, stack: error.stack };
  if (running) { try { await stop('stop owned service after failure'); result.cleanup.serviceStopped = true; } catch (stopError) { result.cleanup.stopFailure = stopError.message; } }
  process.exitCode = 1;
} finally {
  result.finishedAt = new Date().toISOString();
  await writeFile(join(scratch, 'full-command-trace.json'), JSON.stringify(fullCommandTrace, null, 2) + '\n');
  result.cleanup.fullCommandTrace = join(scratch, 'full-command-trace.json');
  await mkdir(dirname(evidencePath), { recursive: true });
  // Scratch paths are intentionally retained as ownership/cleanup evidence; other
  // command payloads are sanitized and no bootstrap token is persisted.
  await writeFile(evidencePath, evidenceJson(result));
  console.log(JSON.stringify({ status: result.status, checks: result.checks.length, evidencePath, candidate: result.ids.hostCandidate, cleanup: result.cleanup }, null, 2));
}
