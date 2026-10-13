import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readdir, realpath, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { WebSocketServer } from 'ws';
import { expect } from '@playwright/test';
import { cli } from '../src/cli.js';
import { startServer } from '../src/server/http.js';
import type { HostRuntimeStatus, HostRuntimeSummary } from '../src/shared/types.js';

const scopeArguments = (root: string, url: string, sessionId: string) => ['--project', root, '--url', url, '--session', sessionId];
const until = async (condition: () => boolean | Promise<boolean>) => {
  const deadline = Date.now() + 5_000;
  while (!await condition()) { if (Date.now() > deadline) throw new Error('The expected host state did not arrive.'); await new Promise(resolve => setTimeout(resolve, 25)); }
};

async function runtimeFixture(t: test.TestContext, browser = false) {
  const root = await realpath(await mkdtemp('/tmp/acanvas-host-cli-'));
  const owner = createServer(), runtime = new WebSocketServer({ server: owner });
  const messages: { method: string; params?: any; id?: number }[] = [];
  const threadId = 'original-owned-thread', socketPath = join(root, 'runtime.sock');
  runtime.on('connection', socket => socket.on('message', bytes => {
    const request = JSON.parse(bytes.toString()); messages.push(request);
    if (request.id === undefined) return;
    const results: Record<string, unknown> = {
      initialize: { userAgent: 'owned-cli-fixture' },
      'thread/loaded/list': { data: [threadId], nextCursor: null },
      'thread/read': { thread: { id: threadId, status: { type: 'idle' } } },
      'turn/start': { turn: { id: 'owned-cli-turn', status: 'inProgress' } },
    };
    socket.send(JSON.stringify({ id: request.id, ...(request.method in results ? { result: results[request.method] } : { error: { code: -32601, message: 'Fixture method unavailable.' } }) }));
  }));
  await new Promise<void>((resolve, reject) => { owner.once('error', reject); owner.listen(socketPath, resolve); });
  const server = await startServer({ root, port: 0, ...(browser ? { webRoot: resolve(process.env.ACANVAS_TEST_WEB_ROOT || 'dist/web'), browser: { headless: true } } : {}) });
  t.after(async () => {
    await server.close();
    for (const client of runtime.clients) client.terminate();
    await new Promise<void>(resolve => runtime.close(() => resolve()));
    await new Promise<void>(resolve => owner.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });
  return { root, server, endpoint: `unix://${socketPath}`, threadId, messages };
}

test('host CLI requires explicit scope and target before discovering or starting any service', async t => {
  const root = await realpath(await mkdtemp('/tmp/acanvas-host-cli-validation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = ['--project', root];
  for (const action of ['attach', 'status', 'detach']) await assert.rejects(cli(['host', action, ...project]), /--session is required/);
  const attach = ['host', 'attach', ...project, '--session', 'explicit-scope'];
  await assert.rejects(cli(attach), /--host is required/);
  await assert.rejects(cli([...attach, '--host', 'desktop']), /explicitly selected Codex runtime/);
  await assert.rejects(cli([...attach, '--host', 'codex']), /--thread is required/);
  await assert.rejects(cli([...attach, '--host', 'codex', '--thread', 'original']), /--endpoint is required/);
  for (const endpoint of ['runtime.sock', 'ws://127.0.0.1:1234', 'unix://other-host/runtime.sock', 'unix:///runtime.sock?token=secret', 'unix:///']) {
    await assert.rejects(cli([...attach, '--host', 'codex', '--thread', 'original', '--endpoint', endpoint]), /--endpoint must be unix/);
  }
  await assert.rejects(cli(['host', 'status', ...project, '--session', '   ']), /--session is required/);
  assert.deepEqual(await readdir(root), [], 'Invalid host commands must not create project data or launch a service.');
  const help = await cli(['--help']) as { help: string };
  assert.match(help.help, /host attach --session ID --host codex --thread ORIGINAL_ID --endpoint unix:\/\/\/absolute/);
  assert.match(help.help, /existing project open/);
});

test('host CLI attaches only the original bound scope and keeps runtime detail out of board state', async t => {
  const app = await runtimeFixture(t), { server, root, threadId, endpoint, messages } = app;
  const session = server.service.createSession('Selected task scope'), other = server.service.createSession('Other task scope');
  const args = scopeArguments(root, server.url, session.id), otherArgs = scopeArguments(root, server.url, other.id);
  const before = await cli(['host', 'status', ...args]) as HostRuntimeStatus;
  assert.equal(before.summary.mode, 'queue'); assert.equal(before.attachment, null);
  const count = server.service.sessions().length;
  await assert.rejects(cli(['host', 'attach', '--host', 'codex', '--thread', threadId, '--endpoint', endpoint, ...args]), /binding/i);
  assert.equal(server.service.sessions().length, count); assert.equal(messages.length, 0);
  const opened = await cli(['project', 'open', '--host', 'codex', '--thread', threadId, ...args]) as any;
  assert.equal(opened.sessionId, session.id); assert.equal(opened.capabilities.hostWakeup, 'explicit-codex-unix');
  await assert.rejects(cli(['host', 'attach', '--host', 'codex', '--thread', 'wrong-original-thread', '--endpoint', endpoint, ...args]), /binding|thread/i);
  assert.equal(messages.length, 0);
  await cli(['host', 'attach', '--host', 'codex', '--thread', threadId, '--endpoint', endpoint, ...args]);
  await until(async () => (await cli(['host', 'status', ...args]) as HostRuntimeStatus).summary.connection === 'ready');
  const status = await cli(['host', 'status', ...args]) as HostRuntimeStatus;
  assert.equal(status.projectId, server.service.project.id); assert.equal(status.sessionId, session.id);
  assert.equal(status.attachment?.threadId, threadId); assert.equal(status.attachment?.endpoint, endpoint); assert.equal(status.attachment?.enabled, true);
  assert.equal((await cli(['host', 'status', ...otherArgs]) as HostRuntimeStatus).summary.mode, 'queue');
  const state = await cli(['session', 'read', ...args]) as any, publicJson = JSON.stringify(state);
  assert.equal(state.hostRuntime.mode, 'codex-runtime'); assert(!publicJson.includes(endpoint)); assert(!publicJson.includes(threadId));
  assert(!publicJson.includes(status.attachment!.fingerprint));
  assert(!messages.some(message => ['thread/start', 'thread/resume', 'turn/start'].includes(message.method)));
  assert.equal(messages.find(message => message.method === 'initialize')?.params?.clientInfo?.name, 'acanvas');
  await cli(['host', 'detach', ...args]);
  const detached = await cli(['host', 'status', ...args]) as HostRuntimeStatus;
  assert.equal(detached.summary.mode, 'queue'); assert.equal(detached.attachment?.enabled, false); assert.equal(detached.attachment?.threadId, threadId);
  assert.equal(server.service.sessions().length, count);
});

test('host delivery preserves queued execution and menu continuation without an agent footer', { skip: process.env.ACANVAS_HOST_DELIVERY_UI_TESTS !== '1', timeout: 45_000 }, async t => {
  const root = await realpath(await mkdtemp('/tmp/acanvas-host-ui-'));
  const server = await startServer({ root, port: 0, webRoot: resolve(process.env.ACANVAS_TEST_WEB_ROOT || 'dist/web'), browser: { headless: true } });
  t.after(async () => { await server.close(); await rm(root, { recursive: true, force: true }); });
  const session = server.service.createSession('Host status presentation'), args = scopeArguments(root, server.url, session.id);
  await server.browser.open(session.id);
  const page = server.browser.page(session.id)!;
  let summary: HostRuntimeSummary = { mode: 'queue', connection: 'none', pendingCount: 0, unknownCount: 0 };
  let delivery: 'accepted' | 'unknown' | undefined;
  await page.route('**/api/state?*', async route => {
    const response = await route.fetch(), state = await response.json();
    state.hostRuntime = summary;
    if (delivery) for (const task of state.tasks) if (task.status === 'queued') task.hostDelivery = { state: delivery, updatedAt: task.updatedAt, ...(delivery === 'accepted' ? { turnId: 'accepted-ui-fixture' } : {}) };
    await route.fulfill({ response, json: state });
  });
  await page.reload(); await expect(page.locator('#whiteboard')).toBeVisible();
  await expect(page.locator('.host-runtime-status')).toHaveCount(0);
  await page.locator('#instruction').fill('Verify the actual queue and receipt');
  await page.getByRole('button', { name: 'Send request', exact: true }).click();
  await expect(page.getByRole('status', { name: 'Agent connection' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Continue', exact: true })).toHaveCount(0);
  summary = { mode: 'codex-runtime', connection: 'ready', pendingCount: 0, unknownCount: 0 }; delivery = 'accepted';
  await page.reload(); await expect(page.locator('#whiteboard')).toBeVisible(); await expect(page.getByRole('status', { name: 'Agent connection' })).toHaveCount(0);
  await expect(page.locator('.queue-task')).toHaveAttribute('aria-label', /Queued/);
  assert.equal(server.service.tasks(session.id)[0].status, 'queued');
  summary = { ...summary, unknownCount: 1, reason: 'delivery-unknown' }; delivery = 'unknown';
  await page.reload(); await expect(page.getByRole('status', { name: 'Agent connection' })).toHaveCount(0);
  await page.evaluate(() => { Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: () => Promise.reject(new Error('Fixture clipboard unavailable.')) } }); });
  await page.getByRole('button', { name: 'More request actions', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Copy resume prompt', exact: true }).click();
  const prompt = page.getByRole('textbox', { name: 'Resume prompt text', exact: true });
  await expect(prompt).toBeVisible(); await expect(prompt).toHaveValue(new RegExp(`session=${session.id}`));
  assert((await prompt.inputValue()).includes(root));
  const claim = await cli(['task', 'next', '--consumer', 'host-ui-consumer', ...args]) as any;
  const task = server.service.tasks(session.id)[0];
  server.service.complete(session.id, task.id, { runId: claim.run.id, consumerId: claim.consumerId, summary: 'Verified receipt', assetIds: [], validation: ['Queue executed through its existing interface.'], operations: [] });
  summary = { mode: 'codex-runtime', connection: 'ready', pendingCount: 0, unknownCount: 0 }; delivery = undefined;
  await page.reload(); await expect(page.locator('#whiteboard')).toBeVisible(); await expect(page.getByRole('status', { name: 'Agent connection' })).toHaveCount(0);
  await page.getByRole('button', { name: 'More request actions', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Request history', exact: true }).click();
  await expect(page.getByText('Verified receipt', { exact: true })).toBeVisible();
  assert.equal(server.service.tasks(session.id)[0].status, 'completed');
});

test('a request queued before first attachment keeps menu continuation and blocks automatic delivery', { skip: process.env.ACANVAS_HOST_DELIVERY_UI_TESTS !== '1', timeout: 30_000 }, async t => {
  const { server, root, threadId, endpoint, messages } = await runtimeFixture(t, true);
  const session = server.service.createSession('Existing queued request'), args = scopeArguments(root, server.url, session.id);
  await cli(['project', 'open', '--host', 'codex', '--thread', threadId, ...args]);
  await server.browser.open(session.id);
  const page = server.browser.page(session.id)!;
  await expect(page.locator('#whiteboard')).toBeVisible();
  await page.locator('#instruction').fill('Saved before the runtime was attached');
  await page.getByRole('button', { name: 'Send request', exact: true }).click();
  await until(() => server.service.tasks(session.id).length === 1);
  const oldTask = server.service.tasks(session.id)[0];
  assert.equal(oldTask.hostDelivery, undefined);
  await cli(['host', 'attach', '--host', 'codex', '--thread', threadId, '--endpoint', endpoint, ...args]);
  await until(() => server.service.state(session.id).hostRuntime.reason === 'earlier-request');
  await page.reload();
  await expect(page.getByRole('status', { name: 'Agent connection' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Continue', exact: true })).toHaveCount(0);
  assert.equal(server.service.task(session.id, oldTask.id).hostDelivery, undefined);
  assert.equal((server.service.db.prepare('SELECT COUNT(*) AS count FROM host_deliveries WHERE task_id=?').get(oldTask.id) as { count: number }).count, 0);
  assert(!messages.some(message => message.method === 'turn/start'));
  await page.evaluate(() => { Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: () => Promise.reject(new Error('Fixture clipboard unavailable.')) } }); });
  await page.getByRole('button', { name: 'More request actions', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Copy resume prompt', exact: true }).click();
  const prompt = page.getByRole('textbox', { name: 'Resume prompt text', exact: true });
  await expect(prompt).toBeVisible();
  const command = await prompt.inputValue();
  assert(command.includes(`Project: ${root};`)); assert(command.includes(`session=${session.id}`));
  // A new eligible delivery still cannot pass the older request without its explicit continuation.
  const reads = messages.filter(message => message.method === 'thread/read').length;
  await page.locator('#instruction').fill('Saved after the runtime was attached');
  await page.getByRole('button', { name: 'Send request', exact: true }).click();
  await until(() => server.service.tasks(session.id).length === 2 && messages.filter(message => message.method === 'thread/read').length > reads);
  const tasks = server.service.tasks(session.id);
  assert.equal(tasks[0].hostDelivery, undefined); assert.equal(tasks[0].status, 'queued');
  assert.equal(tasks[1].hostDelivery?.state, 'pending'); assert.equal(tasks[1].status, 'queued');
  assert.equal(server.service.state(session.id).hostRuntime.reason, 'earlier-request');
  assert(!messages.some(message => message.method === 'turn/start'));
  await page.reload();
  await expect(page.getByRole('status', { name: 'Agent connection' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Continue', exact: true })).toHaveCount(0);
});
