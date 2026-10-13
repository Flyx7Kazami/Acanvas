import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, realpath, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { WebSocketServer } from 'ws';
import { startServer } from './dist/src/server/http.js';

const root = await realpath(await mkdtemp('/tmp/acanvas-independent-review-oldqueue-'));
await writeFile(join(root, 'review-owner.json'), JSON.stringify({ purpose: 'Independent oldqueue UI reproduction', pid: process.pid }));
const owner = createServer(), runtime = new WebSocketServer({ server: owner });
const threadId = 'isolated-original-review-thread', socketPath = join(root, 'runtime.sock'), methods = [];
runtime.on('connection', socket => socket.on('message', bytes => {
  const request = JSON.parse(bytes.toString()); methods.push(request.method);
  if (request.id === undefined) return;
  const result = request.method === 'initialize' ? { userAgent: 'independent-review-fixture' }
    : request.method === 'thread/loaded/list' ? { data: [threadId], nextCursor: null }
    : request.method === 'thread/read' ? { thread: { id: threadId, status: { type: 'idle' } } }
    : { turn: { id: 'review-unexpected-turn' } };
  socket.send(JSON.stringify({ id: request.id, result }));
}));
await new Promise((yes, no) => { owner.once('error', no); owner.listen(socketPath, yes); });
let server;
try {
  server = await startServer({ root, port: 0, webRoot: resolve('dist/web'), browser: { headless: true } });
  const service = server.service;
  const session = service.bindHost({ host: 'codex', threadId }).sessionId;
  const draft = service.saveDraft(session, { ...service.draft(session), text: 'A saved request created before attach' });
  const oldTask = service.sendDraft(session, draft.id, draft.revision).task;
  await server.hostDelivery.attach(session, { host: 'codex', threadId, endpoint: `unix://${socketPath}` });
  await server.browser.open(session);
  const page = server.browser.page(session);
  await page.locator('#whiteboard').waitFor();
  await page.locator('#instruction').fill('A new UI request after explicit attach');
  await page.getByRole('button', { name: 'Send request', exact: true }).click();
  await page.getByRole('status', { name: 'Agent connection' }).waitFor();
  await page.waitForFunction(() => document.querySelector('.host-runtime-status')?.textContent === 'Waiting for agent');
  const summary = service.hostRuntimeSummary(session);
  const result = {
    summary,
    oldTaskHasOutbox: !!service.task(session, oldTask.id).hostDelivery,
    tasks: service.tasks(session).map(task => ({ status: task.status, deliveryState: task.hostDelivery?.state ?? null })),
    statusText: await page.getByRole('status', { name: 'Agent connection' }).innerText(),
    visibleContinueCount: await page.getByRole('button', { name: 'Continue', exact: true }).count(),
    turnStartCount: methods.filter(method => method === 'turn/start').length,
  };
  assert.equal(summary.connection, 'ready'); assert.equal(summary.reason, 'earlier-request');
  assert.equal(result.oldTaskHasOutbox, false); assert.equal(result.tasks[1].deliveryState, 'pending');
  assert.equal(result.statusText, 'Waiting for agent'); assert.equal(result.visibleContinueCount, 0); assert.equal(result.turnStartCount, 0);
  await page.screenshot({ path: resolve('review-oldqueue.png') });
  await writeFile(resolve('review-oldqueue-result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  if (server) await server.close();
  for (const socket of runtime.clients) socket.terminate();
  await new Promise(yes => runtime.close(yes));
  await new Promise(yes => owner.close(yes));
  await rm(root, { recursive: true, force: true });
}
