// Read the actual completed scratch receipt again after normal service shutdown.
// No model connection, new user request, attachment or queue operation is created.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const evidence = dirname(fileURLToPath(import.meta.url));
const actual = JSON.parse(await readFile(join(evidence, 'integration-result.json'), 'utf8'));
assert.equal(actual.result, 'PASS'); assert(actual.cleanup.serviceStopped && actual.cleanup.originalOwnerStopped);
const require = createRequire(join(actual.candidate, 'package.json'));
const { chromium } = require('playwright-core');
const node = join(actual.candidate, '.runtime/node_modules/node/bin/node');
const environment = { ...process.env }; delete environment.CODEX_THREAD_ID;
const cli = args => { const result = spawnSync(node, [join(actual.candidate, 'scripts/runtime.mjs'), 'cli', ...args, '--project', actual.project], { cwd: actual.candidate, env: environment, encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout); };
const record = { purpose: 'Actual completed receipt persists across normal scratch service restart and is scrolled into the visible browser history.', candidate: actual.candidate, projectId: actual.projectId, sessionId: actual.sessionId, taskId: actual.taskId, modelStarted: false, newTaskSent: false, hostAttached: false };
let browser, context, page, opened;
try {
  opened = cli(['project', 'open', '--session', actual.sessionId, '--port', '0']); assert.equal(opened.project.id, actual.projectId); assert.equal(opened.sessionId, actual.sessionId); record.service = opened.service;
  browser = await chromium.launch({ channel: 'chrome', headless: true, chromiumSandbox: true }); context = await browser.newContext({ viewport: { width: 1440, height: 1000 } }); page = await context.newPage();
  await page.goto(opened.openUrl); await page.locator('#whiteboard').waitFor({ state: 'visible' });
  await page.getByRole('button', { name: 'More request actions', exact: true }).click(); await page.getByRole('menuitem', { name: 'Request history', exact: true }).click();
  const receipt = page.getByText(actual.persistedTask.receipt.summary, { exact: true }); await receipt.waitFor({ state: 'visible' }); await receipt.scrollIntoViewIfNeeded();
  const clip = await page.locator('#request-history').boundingBox(), bounds = await receipt.boundingBox(); assert(clip && bounds); assert(bounds.y >= clip.y && bounds.y + bounds.height <= clip.y + clip.height + 1);
  const persisted = await page.evaluate(async path => { const response = await fetch(path); return { status: response.status, result: await response.json() }; }, `/api/sessions/${actual.sessionId}/tasks/${actual.taskId}/context`);
  assert.equal(persisted.status, 200); assert.equal(persisted.result.task.status, 'completed'); assert.deepEqual(persisted.result.task.receipt, actual.persistedTask.receipt); assert.equal(persisted.result.task.currentRunId, actual.runId); assert.equal(persisted.result.task.hostDelivery.state, 'observed');
  await rename(join(evidence, 'ui-history.png'), join(evidence, 'ui-history-top.png'));
  await page.locator('#request-history').screenshot({ path: join(evidence, 'ui-history.png') });
  Object.assign(record, { result: 'PASS', receipt: persisted.result.task.receipt, currentRunId: persisted.result.task.currentRunId, viewportContainsActualReceipt: true, bounds, clip, text: await page.locator('#request-history').innerText(), screenshot: 'ui-history.png' });
} catch (error) { record.result = 'FAIL'; record.failure = { name: error.name, message: error.message }; process.exitCode = 1; }
finally {
  await context?.close(); await browser?.close();
  if (opened) record.serviceStopped = cli(['project', 'stop', '--url', new URL(opened.openUrl).origin]).status === 'stopped';
  record.browserClosed = !browser || !browser.isConnected(); await writeFile(join(evidence, 'ui-receipt-persistence.json'), `${JSON.stringify(record, null, 2)}\n`); console.log(JSON.stringify(record));
}
