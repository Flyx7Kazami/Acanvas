import assert from 'node:assert/strict';
import { mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';
import { startServer } from '../../../dist/src/server/http.js';

const evidence = new URL('.', import.meta.url).pathname;
const root = await realpath(await mkdtemp('/private/tmp/acanvas-notification-independent-'));
const webRoot = '/private/tmp/acanvas-notification-motion-web';
const report = { project: root, webRoot, checks: [], measurements: {}, errors: [] };
let running, browser, context, page;
const check = async (name, action) => { await action(); report.checks.push(name); console.log(`PASS ${name}`); };
const sample = async (selector = '.notification-transients') => page.locator(selector).evaluateAll(elements => elements.map(element => {
  const visual = element.querySelector('.notification-motion'), style = getComputedStyle(visual), rect = element.getBoundingClientRect(), pixels = visual.getBoundingClientRect();
  const stack = element.closest('.notification-stack'), outer = stack.getBoundingClientRect();
  return { state: element.dataset.notificationState, inert: element.inert, ariaHidden: element.getAttribute('aria-hidden'), opacity: Number(style.opacity), y: new DOMMatrixReadOnly(style.transform).m42, count: element.dataset.count, rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, pixels: { x: pixels.x, y: pixels.y, width: pixels.width, height: pixels.height }, corner: { right: innerWidth - outer.right, bottom: innerHeight - outer.bottom }, animations: visual.getAnimations().map(animation => ({ playState: animation.playState, currentTime: animation.currentTime, duration: animation.effect.getTiming().duration, keyframes: animation.effect.getKeyframes().map(frame => ({ opacity: frame.opacity, transform: frame.transform })) })) };
}));
const copy = async () => {
  await page.getByRole('button', { name: 'More request actions', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Copy resume prompt', exact: true }).evaluate(element => { window.reviewNoticeStart = Date.now(); element.click(); });
  await expect(page.locator('.toast')).toHaveCount(1);
};
const armExit = selector => page.evaluate(selector => {
  window.reviewLeaving = new Promise(resolve => {
    const observer = new MutationObserver(() => {
      const element = document.querySelector(selector);
      if (element?.dataset.notificationState !== 'leaving') return;
      observer.disconnect(); window.reviewExitAt = Date.now();
      element.querySelector('.notification-motion').getAnimations().forEach(animation => { animation.pause(); animation.currentTime = 0; });
      resolve();
    });
    observer.observe(document.querySelector('.notification-stack'), { childList: true, subtree: true, attributes: true, attributeFilter: ['data-notification-state'] });
  });
}, selector);
const waitExit = () => page.evaluate(() => window.reviewLeaving);
const pose = async (selector, time, screenshot) => {
  await page.locator(`${selector} .notification-motion`).evaluate((element, time) => { for (const animation of element.getAnimations()) { animation.pause(); animation.currentTime = time; } }, time);
  const result = await sample(selector);
  if (screenshot) await page.screenshot({ path: `${evidence}${screenshot}` });
  return result[0];
};
const finish = selector => page.locator(`${selector} .notification-motion`).evaluateAll(elements => elements.forEach(element => element.getAnimations().forEach(animation => animation.finish())));
try {
  running = await startServer({ root, port: 0, webRoot, browser: { headless: true } });
  report.base = running.url;
  browser = await chromium.launch({ channel: 'chrome', headless: true, chromiumSandbox: true });
  context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.addInitScript(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => undefined } }));
  page = await context.newPage(); page.on('pageerror', error => report.errors.push(error.message));
  await page.goto(running.url);
  await expect(page.locator('#whiteboard')).toBeVisible(); await expect(page.locator('.composer')).toHaveAttribute('data-save-state', 'saved'); await expect(page.locator('.connection-feedback')).toHaveCount(0);
  const bootstrap = await (await fetch(`${running.url}/api/bootstrap`)).json();
  const state = async () => {
    const response = await fetch(`${running.url}/api/state?sessionId=${new URL(page.url()).searchParams.get('session')}`, { headers: { Authorization: `Bearer ${bootstrap.token}` } }); assert(response.ok); return response.json();
  };

  await check('success entry travels 8px upward over 190ms; fixed aside and ordinary focus/pointer behavior retained', async () => {
    await copy(); const start = await pose('.notification-transients', 0);
    assert.equal(start.opacity, 0); assert.equal(start.y, 8); assert.equal(start.animations[0].duration, 190);
    const middle = await pose('.notification-transients', 95, 'independent-entry-middle-light.png');
    assert(middle.opacity > 0 && middle.opacity < 1 && middle.y > 0 && middle.y < 8); assert.deepEqual(middle.corner, { right: 16, bottom: 16 });
    await finish('.notification-transients'); await page.waitForTimeout(35); const end = (await sample())[0];
    assert.equal(end.opacity, 1); assert.equal(end.y, 0);
    await expect(page.getByRole('button', { name: 'More request actions', exact: true })).toBeFocused();
    assert.equal(await page.locator('.toast').evaluate(element => getComputedStyle(element).pointerEvents), 'none');
    assert.equal(await page.locator('.notification-stack button').count(), 0);
    report.measurements.entry = { start, middle, end };
    await armExit('.notification-transients');
  });
  await check('2800ms expiry retains upward exit paint for 180ms and immediately removes live semantics', async () => {
    await waitExit();
    const start = await pose('.notification-transients', 0), middle = await pose('.notification-transients', 90, 'independent-exit-middle-light.png');
    assert(start.inert && start.ariaHidden === 'true'); assert.equal(start.opacity, 1); assert.equal(start.y, 0); assert.equal(start.animations[0].duration, 180);
    assert(middle.opacity > 0 && middle.opacity < 1 && middle.y < 0 && middle.y > -8);
    assert.deepEqual(middle.corner, { right: 16, bottom: 16 }); assert.equal(await page.locator('.notification-stack').evaluate(element => element.hidden), false);
    await finish('.notification-transients'); await expect(page.locator('.notification-transients')).toHaveCount(0); await expect(page.locator('.notification-stack')).toBeHidden();
    report.measurements.exit = { start, middle };
    report.measurements.expiryMs = await page.evaluate(() => window.reviewExitAt - window.reviewNoticeStart);
    assert(report.measurements.expiryMs >= 2800 && report.measurements.expiryMs < 2870);
  });
  await check('rapid replacements keep exactly one full toast and two thin peeks, and older expiry preserves latest', async () => {
    for (let index = 0; index < 7; index++) await copy();
    await expect(page.locator('.toast')).toHaveCount(1); await expect(page.locator('.notification-peeks>span')).toHaveCount(2); await expect(page.locator('.notification-transients')).toHaveAttribute('data-count', '5');
    await page.waitForTimeout(3000); await expect(page.locator('.notification-stack')).toBeHidden();
    await copy(); await page.waitForTimeout(1000); await copy(); await page.waitForTimeout(1900);
    await expect(page.locator('.notification-transients')).toHaveAttribute('data-count', '1'); await expect(page.locator('.toast')).toHaveCount(1); await expect(page.locator('.notification-peeks')).toHaveCount(0);
    const current = (await sample())[0]; assert.equal(current.opacity, 1); assert.equal(current.y, 0); assert.equal(current.animations.length, 0);
    report.measurements.olderExpiry = current;
    await page.waitForTimeout(1200); await expect(page.locator('.notification-stack')).toBeHidden();
  });
  await check('identical ordinary upload errors each animate and expire', async () => {
    await page.route('**/api/assets?*', route => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: { code: 'server_error', message: 'Review upload failure.' } }) }));
    for (let index = 0; index < 2; index++) {
      await page.getByLabel('Import files into canvas', { exact: true }).setInputFiles({ name: `Review failure ${index}.txt`, mimeType: 'text/plain', buffer: Buffer.from('Owned review fixture') });
      await expect(page.locator('.transient-error')).toContainText('The local service could not complete this action.');
      await expect(page.locator('.notification-transients')).toHaveAttribute('data-notification-state', 'active');
      await page.waitForTimeout(3100); await expect(page.locator('.notification-stack')).toBeHidden();
    }
    await page.unroute('**/api/assets?*');
  });
  await check('active upload stays actionable, ordinary expiry preserves upload focus, Cancel immediately inerts its exiting row', async () => {
    let release; const held = new Promise(resolve => { release = resolve; });
    await page.route('**/api/assets?*', async route => { await held; await route.abort('aborted').catch(() => undefined); });
    try {
      await page.getByLabel('Import files into canvas', { exact: true }).setInputFiles({ name: 'Review active.txt', mimeType: 'text/plain', buffer: Buffer.from('Owned active fixture') });
      const cancel = page.getByRole('button', { name: 'Cancel import Review active.txt', exact: true }); await expect(cancel).toBeVisible(); await page.waitForTimeout(210);
      await copy(); await cancel.focus(); await page.waitForTimeout(3100); await expect(cancel).toBeFocused(); await expect(page.locator('.notification-transients')).toHaveCount(0);
      await armExit('.notification-status'); await cancel.evaluate(element => element.click()); await waitExit();
      const start = await pose('.notification-status', 0), middle = await pose('.notification-status', 90, 'independent-upload-exit-middle-light.png');
      assert(start.inert && start.ariaHidden === 'true'); assert(middle.y < 0 && middle.y > -8); await expect(page.getByRole('button', { name: 'Cancel import Review active.txt', exact: true })).toHaveCount(0);
      await finish('.notification-status'); await expect(page.locator('.notification-stack')).toBeHidden(); report.measurements.uploadExit = { start, middle };
    } finally { release(); await page.unroute('**/api/assets?*'); }
    assert.equal((await state()).assets.length, 0);
  });
  await check('persistent error updates preserve motion identity; Retry can reverse pending exit; Dismiss remains usable', async () => {
    let delay = 0;
    await page.route('**/api/sessions/*/draft', async route => { if (route.request().method() !== 'PUT') return route.continue(); if (delay) await new Promise(resolve => setTimeout(resolve, delay)); await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: { code: 'server_error', message: 'Review save failure.' } }) }); });
    await page.locator('#instruction').fill('Owned unsaved review draft');
    const error = page.locator('.notification-status').filter({ has: page.getByRole('button', { name: 'Retry saving', exact: true }) }); await expect(error).toHaveCount(1); await page.waitForTimeout(220);
    await error.evaluate(element => { element.reviewIdentity = 'persistent-error'; });
    await page.getByRole('button', { name: 'Theme', exact: true }).click(); await page.getByRole('menuitemradio', { name: 'Dark', exact: true }).click();
    assert.equal(await error.evaluate(element => element.reviewIdentity), 'persistent-error'); assert.equal((await sample('.notification-status'))[0].animations.length, 0);
    delay = 70; await armExit('.notification-status'); await page.getByRole('button', { name: 'Retry saving', exact: true }).evaluate(element => element.click());
    await waitExit();
    await expect(page.locator('.notification-status')).toHaveAttribute('data-notification-state', 'active'); await page.waitForTimeout(250);
    assert.equal(await page.locator('.notification-status').evaluate(element => element.reviewIdentity), 'persistent-error');
    const reversed = (await sample('.notification-status'))[0]; assert.equal(reversed.opacity, 1); assert.equal(reversed.y, 0); report.measurements.retryReversal = reversed;
    await armExit('.notification-status'); await page.getByRole('button', { name: 'Dismiss error', exact: true }).evaluate(element => element.click()); await waitExit();
    const middle = await pose('.notification-status', 90, 'independent-error-exit-middle-dark.png'); assert(middle.inert); await finish('.notification-status'); await expect(page.locator('.notification-stack')).toBeHidden();
    await page.unroute('**/api/sessions/*/draft'); await page.reload(); await expect(page.locator('.composer')).toHaveAttribute('data-save-state', 'saved');
  });
  await check('320px and 390px light/dark keep 16px corner and narrow truncation; reduced motion enters and expires immediately', async () => {
    const geometry = [];
    await page.emulateMedia({ reducedMotion: 'reduce' });
    for (const width of [320, 390]) for (const theme of ['light', 'dark']) {
      await page.setViewportSize({ width, height: 480 });
      if (await page.locator('html').getAttribute('data-theme') !== theme) { await page.getByRole('button', { name: 'Theme', exact: true }).click(); await page.getByRole('menuitemradio', { name: theme === 'light' ? 'Light' : 'Dark', exact: true }).click(); }
      await copy(); const current = (await sample())[0]; assert.deepEqual(current.corner, { right: 16, bottom: 16 }); assert.equal(current.rect.width, 44); assert.equal(current.animations.length, 0); assert.equal(current.opacity, 1); assert.equal(current.y, 0);
      assert(await page.locator('.toast>span').evaluate(element => element.scrollWidth > element.clientWidth));
      assert(await page.locator('.send-button').evaluate(element => { const box = element.getBoundingClientRect(); return document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)?.closest('.send-button') === element; }));
      await page.screenshot({ path: `${evidence}independent-${width}-${theme}.png` }); geometry.push({ width, theme, current });
      await page.waitForTimeout(2850); await expect(page.locator('.notification-transients')).toHaveCount(0); await expect(page.locator('.notification-stack')).toBeHidden();
    }
    report.measurements.narrow = geometry;
  });
  await check('switching reduced motion on during pending exit immediately removes painted row', async () => {
    await page.setViewportSize({ width: 1280, height: 900 }); await page.emulateMedia({ reducedMotion: 'no-preference' });
    await copy(); await armExit('.notification-transients'); await waitExit();
    await pose('.notification-transients', 70); await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect(page.locator('.notification-transients')).toHaveCount(0); await expect(page.locator('.notification-stack')).toBeHidden();
  });
  await check('real connection ready removes Connecting status through inert upward exit', async () => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    let release, queued = [], gate = true;
    const secondary = await context.newPage(); secondary.on('pageerror', error => report.errors.push(error.message));
    await secondary.routeWebSocket('**/api/connection', socket => {
      const server = socket.connectToServer();
      server.onMessage(message => { if (gate) queued.push(message); else socket.send(message); });
      release = () => { gate = false; queued.forEach(message => socket.send(message)); queued = []; };
    });
    await secondary.goto(page.url()); await expect(secondary.locator('.connection-feedback')).toContainText('Connecting'); await secondary.waitForTimeout(220);
    const original = page; page = secondary;
    const active = (await sample('.notification-status'))[0]; assert.equal(active.opacity, 1); assert.equal(active.y, 0);
    assert(queued.length > 0); await armExit('.notification-status'); release(); await waitExit();
    const middle = await pose('.notification-status', 90, 'independent-connection-exit-middle-dark.png'); assert(middle.inert && middle.ariaHidden === 'true'); assert(middle.y < 0 && middle.y > -8);
    await finish('.notification-status'); await expect(page.locator('.notification-stack')).toBeHidden(); report.measurements.connection = { active, middle };
    await secondary.close(); page = original;
  });
  assert.deepEqual(report.errors, []); report.status = 'PASS';
} catch (error) { report.status = 'FAIL'; report.failure = { message: error.message, stack: error.stack }; console.error(error); process.exitCode = 1; }
finally {
  await writeFile(`${evidence}independent-result.json`, JSON.stringify(report, null, 2));
  await browser?.close(); await running?.close();
}
