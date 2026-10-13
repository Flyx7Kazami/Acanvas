import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { expect } from '@playwright/test';
import { startServer } from '../../../dist/src/server/http.js';

const evidence = new URL('.', import.meta.url).pathname;
const root = await realpath(await mkdtemp('/private/tmp/acanvas-history-independent-'));
const webRoot = process.env.ACANVAS_REVIEW_WEBROOT || '/private/tmp/acanvas-request-history-web';
const report = { project: root, webRoot, checks: [], measurements: {}, errors: [] };
let running, page;
const check = async (name, run) => { await run(); report.checks.push(name); console.log(`PASS ${name}`); };
const sample = () => page.evaluate(() => {
  const panel = document.querySelector('#request-history');
  if (!panel) return { exists: false };
  const shell = panel.closest('.history-stack'), css = getComputedStyle(shell), bounds = panel.getBoundingClientRect();
  return { exists: true, opacity: Number(css.opacity), transform: css.transform, inert: shell.inert, hidden: shell.getAttribute('aria-hidden'), state: shell.dataset.motion, bounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height }, animations: shell.getAnimations().map(a => ({ playState: a.playState, duration: a.effect?.getTiming().duration })) };
});
try {
  await mkdir(evidence, { recursive: true });
  running = await startServer({ root, port: 0, webRoot, browser: { headless: true } });
  report.base = running.url;
  const session = running.service.createSession('Independent history review');
  const bootstrap = await (await fetch(`${running.url}/api/bootstrap`)).json();
  const call = async (path, method = 'GET', body) => {
    const response = await fetch(`${running.url}${path}`, { method, headers: { Authorization: `Bearer ${bootstrap.token}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const result = await response.json(); assert(response.ok, JSON.stringify(result)); return result;
  };
  const importAsset = async (name, mime, data) => {
    const response = await fetch(`${running.url}/api/assets?name=${encodeURIComponent(name)}&mime=${encodeURIComponent(mime)}`, { method: 'POST', headers: { Authorization: `Bearer ${bootstrap.token}` }, body: data });
    const result = await response.json(); assert(response.ok, JSON.stringify(result)); return result;
  };
  const image = await importAsset('History reference.png', 'image/png', Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2XWQAAAAASUVORK5CYII=', 'base64'));
  const annotation = { id: 'history-review-annotation', scope: 'region', objectIds: [], coordinateSpace: 'world', bounds: { x: 200, y: 180, width: 100, height: 80 }, text: 'Review this composition', geometry: 'rect' };
  const send = (text, extra = {}) => {
    const current = running.service.draft(session.id);
    const draft = running.service.saveDraft(session.id, { ...current, text, ...extra });
    return running.service.sendDraft(session.id, draft.id, draft.revision).task;
  };
  const completed = send('Arrange the reference', { attachments: [image.id], annotations: [annotation] });
  const claim = running.service.claim(session.id, 'independent-review-consumer');
  running.service.complete(session.id, completed.id, { consumerId: claim.consumerId, runId: claim.run.id, summary: 'Composition ready', assetIds: [], operations: [], validation: ['Reviewed reference layout'] });
  const cancelled = send('Cancelled request');
  running.service.cancel(session.id, cancelled.id, 'User cancelled the request');
  const customCancelled = send('Cancelled custom request');
  running.service.cancel(session.id, customCancelled.id, 'A custom cancellation detail');
  const initialTasks = structuredClone(running.service.tasks(session.id));

  await running.browser.open(session.id);
  page = running.browser.page(session.id);
  await page.setViewportSize({ width: 1280, height: 900 });
  page.on('pageerror', error => report.errors.push(error.message));
  await expect(page.locator('#whiteboard')).toBeVisible();
  await expect(page.locator('.composer')).toHaveAttribute('data-save-state', 'saved');
  const openHistory = async () => {
    await page.getByRole('button', { name: 'More request actions', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Request history', exact: true }).click();
    await expect(page.locator('#request-history')).toBeVisible();
  };
  const closeHistory = async () => {
    await page.getByRole('button', { name: 'Close request history', exact: true }).click();
    await expect(page.locator('#request-history')).toHaveCount(0);
  };
  await check('cancelled reasons hidden, user title / annotation / attachment / receipt retained, raw detail removed', async () => {
    await openHistory();
    await expect(page.locator('#request-history .task-card')).toHaveCount(3);
    await expect(page.locator('#request-history .task-reason')).toHaveCount(0);
    await expect(page.locator('#request-history .task-requirement-text')).toHaveCount(0);
    await expect(page.locator('#request-history').getByText('User cancelled the request', { exact: true })).toHaveCount(0);
    await expect(page.locator('#request-history').getByText('A custom cancellation detail', { exact: true })).toHaveCount(0);
    await expect(page.locator('#request-history').getByText('Arrange the reference', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'View annotation 1: Review this composition', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'View History reference.png', exact: true })).toBeVisible();
    await expect(page.locator('#request-history').getByText('Composition ready', { exact: true })).toBeVisible();
    await page.locator('#request-history').getByText('Validation', { exact: true }).click();
    await expect(page.locator('#request-history').getByText('Reviewed reference layout', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'View History reference.png', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Preview History reference.png', exact: true })).toBeVisible();
    await expect(page.locator('#request-history')).toBeVisible();
    await page.getByRole('button', { name: 'Close media preview', exact: true }).click();
    await page.getByRole('button', { name: 'View annotation 1: Review this composition', exact: true }).click();
    await expect(page.locator('#request-history')).toBeVisible();
    await closeHistory();
    await expect(page.getByRole('button', { name: 'More request actions', exact: true })).toBeFocused();
  });
  await check('pending=0 exit is rendered, inert, then unmounted within 250ms', async () => {
    await openHistory(); const enterStart = await sample(); await page.waitForTimeout(45); const enterMiddle = await sample();
    assert(enterStart.exists && enterMiddle.exists && enterMiddle.opacity > enterStart.opacity && enterMiddle.opacity < 1, JSON.stringify({ enterStart, enterMiddle }));
    report.measurements.enter = { start: enterStart, middle: enterMiddle }; await page.waitForTimeout(250);
    const close = await page.getByRole('button', { name: 'Close request history', exact: true }).boundingBox();
    await page.mouse.click(close.x + close.width / 2, close.y + close.height / 2);
    const zero = await sample(); await page.waitForTimeout(45); const middle = await sample();
    assert(zero.exists && middle.exists, 'History must persist while exit runs');
    assert(zero.inert && zero.hidden === 'true');
    assert(middle.opacity < 1 && middle.opacity > 0, JSON.stringify(middle));
    await page.waitForTimeout(210); const end = await sample(); assert.equal(end.exists, false);
    report.measurements.zeroPendingExit = { zero, middle, end };
  });
  await check('outside composer click closes history and preserves clicked input focus', async () => {
    await openHistory(); await page.locator('#instruction').click();
    await expect(page.locator('#instruction')).toBeFocused();
    await expect(page.locator('#request-history')).toHaveCount(0);
  });
  await check('outside canvas, toolbar and theme actions continue on the closing click', async () => {
    await openHistory(); await page.locator('#whiteboard').click({ position: { x: 900, y: 120 } });
    await expect(page.locator('#request-history')).toHaveCount(0);
    await openHistory(); await page.getByRole('button', { name: 'Pan canvas', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Pan canvas', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#request-history')).toHaveCount(0);
    await page.getByRole('button', { name: 'Select files', exact: true }).click();
    await openHistory(); await page.getByRole('button', { name: 'Theme', exact: true }).click();
    await expect(page.getByRole('menu', { name: 'Theme', exact: true })).toBeVisible();
    await expect(page.locator('#request-history')).toHaveCount(0);
    await page.getByRole('menuitemradio', { name: 'Dark', exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  });
  await check('Escape closes and returns focus; reduced motion closes immediately', async () => {
    await openHistory(); await page.getByRole('button', { name: 'Close request history', exact: true }).focus(); await page.keyboard.press('Escape');
    await expect(page.locator('#request-history')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'More request actions', exact: true })).toBeFocused();
    await page.emulateMedia({ reducedMotion: 'reduce' }); await openHistory();
    await page.getByRole('button', { name: 'Close request history', exact: true }).click();
    report.measurements.reducedMotionClosed = await sample(); assert.equal(report.measurements.reducedMotionClosed.exists, false);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
  });
  await check('rapid close and reopen leaves a stable interactive panel', async () => {
    await openHistory(); await page.waitForTimeout(250);
    const more = await page.getByRole('button', { name: 'More request actions', exact: true }).boundingBox();
    await page.mouse.click(more.x + more.width / 2, more.y + more.height / 2);
    const reversing = await sample(); assert(reversing.exists && reversing.inert, JSON.stringify(reversing));
    await page.getByRole('menuitem', { name: 'Request history', exact: true }).evaluate(button => button.click());
    await page.waitForTimeout(280);
    const reopened = await sample(); assert(reopened.exists && !reopened.inert && reopened.opacity === 1, JSON.stringify(reopened));
    report.measurements.rapidReopen = { reversing, reopened };
    await closeHistory();
  });
  const blocked = send('Check unavailable input');
  const blockedClaim = running.service.claim(session.id, claim.consumerId);
  running.service.pause(session.id, blocked.id, { consumerId: blockedClaim.consumerId, runId: blockedClaim.run.id, reason: 'Source input is unavailable' }, 'blocked');
  await check('blocked reason retained; closing returns to a compact queue', async () => {
    await expect(page.locator('.queue-item')).toHaveCount(1); await openHistory();
    await expect(page.locator(`#request-history .task-card[data-task-id="${blocked.id}"] .task-reason`)).toHaveText('Source input is unavailable');
    await closeHistory(); await page.mouse.move(900, 120); await page.waitForTimeout(400);
    await expect(page.locator('.queue-item')).toHaveCount(1);
    await expect(page.locator('.queue-stack[data-pending]')).not.toHaveClass(/expanded/);
  });
  const resumed = running.service.resume(session.id, blocked.id, { consumerId: blockedClaim.consumerId, expectedRunId: blockedClaim.run.id, resolution: 'Inspect restored source' });
  running.service.pause(session.id, blocked.id, { consumerId: resumed.consumerId, runId: resumed.run.id, reason: 'Execution needs to resume' }, 'interrupted');
  await check('interrupted reason retained and API task text / snapshots / reasons unchanged', async () => {
    await openHistory();
    await expect(page.locator(`#request-history .task-card[data-task-id="${blocked.id}"] .task-reason`)).toHaveText('Execution needs to resume');
    assert.deepEqual(running.service.tasks(session.id).slice(0, 3), initialTasks);
    const current = await call(`/api/state?sessionId=${session.id}`);
    assert.deepEqual(current.tasks.slice(0, 3), initialTasks);
    assert(initialTasks.every(task => task.requirementText && task.snapshot.requirementText));
    await closeHistory();
  });
  send('Additional queued request');
  await check('multiple pending requests return to the compact queue with hidden extras inert', async () => {
    await expect(page.locator('.queue-item')).toHaveCount(2); await openHistory(); await closeHistory(); await page.mouse.move(900, 120); await page.waitForTimeout(400);
    await expect(page.locator('.queue-stack[data-pending]')).not.toHaveClass(/expanded/);
    await expect(page.locator('.queue-extra')).toHaveAttribute('inert', '');
    await expect(page.locator('.queue-extra')).toHaveAttribute('aria-hidden', 'true');
  });
  await check('click and scroll within history preserve the panel on a narrow viewport', async () => {
    await page.setViewportSize({ width: 390, height: 844 }); await openHistory();
    const panel = page.locator('#request-history'); await panel.click({ position: { x: 30, y: 30 } });
    await panel.hover(); await page.mouse.wheel(0, 420); await page.waitForTimeout(100);
    await expect(panel).toBeVisible();
    report.measurements.narrowHistory = await panel.evaluate(node => ({ scrollTop: node.scrollTop, scrollHeight: node.scrollHeight, clientHeight: node.clientHeight, radius: getComputedStyle(node).borderRadius }));
    assert(report.measurements.narrowHistory.scrollTop > 0);
    await page.screenshot({ path: join(evidence, 'independent-history-dark-390.png') }); await closeHistory();
    await page.setViewportSize({ width: 1280, height: 900 });
  });
  await check('outside interactive HTML iframe click dismisses history and activates its control', async () => {
    const html = await importAsset('History outside control.html', 'text/html', Buffer.from('<!doctype html><html><body style="margin:0;padding:30px;background:#eee"><button id="outside" onclick="this.textContent=\'Activated\'">Activate</button></body></html>'));
    const before = running.service.objects().map(o => o.id);
    running.service.boardOperations(session.id, [{ type: 'create', object: { assetId: html.id, x: 200, y: 100, width: 400, height: 280 } }]);
    const object = running.service.objects().find(o => !before.includes(o.id));
    const host = page.locator(`[data-object-id="${object.id}"]`); await expect(host).toBeVisible(); await host.hover();
    const frame = host.frameLocator('iframe'); await expect(frame.locator('#outside')).toBeVisible({ timeout: 15000 });
    await openHistory(); await frame.locator('#outside').click();
    await expect(frame.locator('#outside')).toHaveText('Activated');
    await expect(page.locator('#request-history')).toHaveCount(0);
  });
  assert.deepEqual(report.errors, []);
  report.status = 'PASS';
} catch (error) {
  report.status = 'FAIL'; report.failure = { message: error.message, stack: error.stack }; throw error;
} finally {
  report.completedAt = new Date().toISOString();
  if (page && !page.isClosed()) await page.screenshot({ path: join(evidence, 'independent-final.png'), timeout: 5000 }).catch(() => {});
  await writeFile(join(evidence, 'independent-result.json'), JSON.stringify(report, null, 2));
  await running?.close();
  console.log(JSON.stringify({ status: report.status, checks: report.checks.length, evidence, project: root, errors: report.errors }));
}
