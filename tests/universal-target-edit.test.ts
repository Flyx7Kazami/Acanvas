import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { startServer } from '../src/server/http.js';
import type { BoardState } from '../src/shared/types.js';

test('completed annotation target edits save an awaiting version and normal Done captures it through Send', { skip: process.env.ACANVAS_TARGET_EDIT_TEST !== '1', timeout: 120_000 }, async t => {
  const { chromium, firefox } = await import('playwright-core');
  const output = process.env.ACANVAS_TARGET_EDIT_OUTPUT || await mkdtemp(join(tmpdir(), 'acanvas-target-edit-output-')); await mkdir(output, { recursive: true });
  const root = await mkdtemp(join(tmpdir(), 'acanvas-target-edit-project-')), server = await startServer({ root, port: 0, webRoot: resolve(process.env.ACANVAS_TARGET_WEB_ROOT!) });
  const bootstrap = await (await fetch(server.url + '/api/bootstrap')).json();
  const call = async (path: string, method = 'GET', body?: unknown) => { const response = await fetch(server.url + path, { method, headers: { Authorization: 'Bearer ' + bootstrap.token, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); const value = await response.json(); assert.ok(response.ok, JSON.stringify(value)); return value; };
  const session = await call('/api/sessions', 'POST', { name: 'Target edit test' });
  const image = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="300" height="180"><rect width="300" height="180" fill="#85aec4"/><circle cx="80" cy="80" r="40" fill="#eac06a"/></svg>');
  const uploaded = await fetch(server.url + '/api/assets?name=Image.svg&mime=image/svg+xml', { method: 'POST', headers: { Authorization: 'Bearer ' + bootstrap.token }, body: image }); assert.equal(uploaded.status, 201); const asset = await uploaded.json();
  await call('/api/board/operations', 'POST', { sessionId: session.id, operations: [{ type: 'create', object: { assetId: asset.id, x: 120, y: 100, width: 300, height: 180 } }] });
  const engine = process.env.ACANVAS_TARGET_EDIT_ENGINE || 'chromium', browser = engine === 'firefox' ? await firefox.launch({ headless: true, executablePath: process.env.ACANVAS_SCENE_FIREFOX || '/private/tmp/acanvas-scene-browser-runtime/firefox-1490/firefox/Nightly.app/Contents/MacOS/firefox' }) : await chromium.launch({ headless: true, chromiumSandbox: true, executablePath: resolve('.runtime/browsers/chromium-1193/chrome-mac/Chromium.app/Contents/MacOS/Chromium') });
  const context = await browser.newContext({ viewport: { width: 1100, height: 760 }, deviceScaleFactor: 1 }), page = await context.newPage(), failures: unknown[] = [], errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message)); page.on('response', response => { if (response.url().includes('/api/') && response.status() >= 400 && response.status() !== 404) failures.push({ status: response.status(), path: new URL(response.url()).pathname }); });
  await context.tracing.start({ screenshots: true, snapshots: true });
  t.after(async () => { await context.tracing.stop({ path: join(output, 'trace.zip') }).catch(() => {}); await browser.close(); await server.close(); await rm(root, { recursive: true, force: true }); });
  const state = () => call('/api/state?sessionId=' + session.id) as Promise<BoardState>;
  const note = async () => (await state()).draft.annotations[0];
  const open = () => page.locator('.draft-annotation .annotation-content').first().click();
  const done = async () => { await page.getByRole('button', { name: 'Done', exact: true }).click(); await page.waitForFunction(() => document.querySelector('.draft-annotation')?.getAttribute('data-capture-state') === 'complete' && !document.querySelector('.capture-progress')); return note(); };
  await page.goto(server.url + '/?session=' + session.id); await page.waitForFunction(() => Boolean(document.querySelector('.scene-canvas')?.getAttribute('data-frame-seq')));
  await page.getByRole('button', { name: 'Mark canvas', exact: true }).click(); await page.locator('.whiteboard').click({ position: { x: 263, y: 177 } });
  await page.getByRole('textbox', { name: 'Add a comment', exact: true }).fill('Exact point scene.');
  const original = await done(), originalVersion = original.captureState!.version, originalCapture = original.capture!;
  assert.equal(original.scope, 'object'); assert.equal(original.captureState!.status, 'complete');
  // A comment-only edit preserves the completed evidence and version.
  await open(); await page.getByRole('textbox', { name: 'Annotation text', exact: true }).fill('The revised point comment.');
  const commentOnly = await done(); assert.equal(commentOnly.capture!.id, originalCapture.id); assert.equal(commentOnly.captureState!.version, originalVersion);
  // This is the exact reviewed action: completed chip -> Canvas region -> 600 ms -> Done.
  await open(); await page.getByRole('combobox', { name: 'Annotation target', exact: true }).selectOption(''); await page.waitForTimeout(600);
  let pending = await note(); assert.equal(pending.scope, 'region'); assert.equal(pending.captureState!.status, 'incomplete'); assert.equal(pending.captureState!.version, originalVersion + 1); assert.equal(pending.sceneSource, undefined); assert.equal(pending.capture, undefined);
  assert.equal(await page.locator('.draft-annotation img').count(), 0); assert.equal(await page.locator('.composer').getAttribute('data-save-state'), 'saved');
  const regional = await done(); assert.equal(regional.scope, 'region'); assert.equal(regional.captureState!.version, originalVersion + 1); assert.notEqual(regional.capture!.id, originalCapture.id); assert.notEqual(regional.sceneSource!.id, original.sceneSource!.id);
  await page.locator('.draft-annotation img').waitFor();
  // Hold a target-save response after the service commits, change back, then deliver the old response.
  let committed!: () => void, release!: () => void, used = false;
  const held = new Promise<void>(resolve => { committed = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/sessions/' + session.id + '/draft', async route => {
    if (route.request().method() !== 'PUT' || used) return route.continue(); const body = route.request().postDataJSON();
    if (!body.annotations.some((value: { id: string; scope: string }) => value.id === regional.id && value.scope === 'object')) return route.continue();
    used = true; const response = await route.fetch(); assert.ok(response.ok()); committed(); await gate; await route.fulfill({ response });
  });
  await open(); await page.getByRole('combobox', { name: 'Annotation target', exact: true }).selectOption(original.objectId!); await held;
  const intermediate = await note(); assert.equal(intermediate.captureState!.version, originalVersion + 2); assert.equal(intermediate.captureState!.status, 'incomplete');
  await page.getByRole('combobox', { name: 'Annotation target', exact: true }).selectOption(''); release();
  await page.waitForFunction(() => document.querySelector('.composer')?.getAttribute('data-save-state') === 'saved');
  pending = await note(); assert.equal(pending.scope, 'region'); assert.equal(pending.captureState!.status, 'incomplete'); assert.equal(pending.captureState!.version, originalVersion + 3); assert.equal(pending.capture, undefined);
  const latest = await done(); assert.equal(latest.captureState!.version, originalVersion + 3); assert.equal(latest.scope, 'region'); assert.notEqual(latest.capture!.id, regional.capture!.id);
  await page.unroute('**/api/sessions/' + session.id + '/draft');
  await page.getByRole('combobox', { name: 'Request', exact: true }).fill('Use the newly saved target scene.'); await page.getByRole('button', { name: 'Send request', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.queue-item').length === 1); const final = await state(); assert.equal(final.tasks[0].snapshot.annotations[0].capture!.id, latest.capture!.id); assert.equal(context.pages().length, 1);
  assert.deepEqual(errors, []); assert.deepEqual(failures, []);
  await page.screenshot({ path: join(output, 'final.png') });
  const facts = { measuredAt: new Date().toISOString(), result: 'passed', engine, version: browser.version(), source: 'isolated built production App and local service', captureWindowsOpened: 0, ordinaryAutosaveTargetVersion: regional.captureState!.version, commentOnlyPreservedCapture: true, lateSavedTargetResponseRejected: true, targetBackRetainsIncompleteNewVersion: true, finalVersion: latest.captureState!.version, newThumbnailAndSend: true, apiFailures: failures, errors, output };
  await writeFile(join(output, 'target-edit-execution.json'), JSON.stringify(facts, null, 2)); if (process.env.ACANVAS_TARGET_EDIT_FACTS) await writeFile(process.env.ACANVAS_TARGET_EDIT_FACTS, JSON.stringify(facts, null, 2));
});
