import { test as base, expect, type Page } from '@playwright/test';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import type { BoardState, Claim, Asset } from '../src/shared/types.js';

const runtime = resolve('.runtime/node_modules/node/bin/node');
const execute = promisify(execFile);
async function cli(args: string[]): Promise<any> {
  const { stdout } = await execute(runtime, [resolve('dist/src/cli.js'), ...args], { maxBuffer: 2 * 1024 * 1024 });
  return JSON.parse(stdout);
}
async function startAppProcess(root: string, port = 0) {
  const child = spawn(runtime, [resolve('dist/src/server/main.js'), '--project', root, '--port', String(port)], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', errors = '';
  child.stderr.on('data', chunk => { errors += chunk.toString(); });
  const url = await new Promise<string>((resolveReady, reject) => {
    const timer = setTimeout(() => reject(new Error('The isolated service did not start.')), 10_000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', (code, signal) => { clearTimeout(timer); reject(new Error(`Service exited during startup: ${code}/${signal}`)); });
    child.stdout.on('data', chunk => { output += chunk.toString(); const address = output.match(/acanvas: (http:\/\/127\.0\.0\.1:\d+)/)?.[1]; if (address) { clearTimeout(timer); resolveReady(address); } });
  });
  return { url, close: async () => {
    if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited; }
    expect(child.signalCode, errors).toBeNull(); expect(child.exitCode, errors).toBe(0);
    expect(errors).not.toContain('Assertion failed');
  } };
}
type AppFixture = { root: string; server: { url: string }; restart: (samePort?: boolean) => Promise<void>; replaceProject: () => Promise<string>; call: (path: string, method?: string, body?: unknown) => Promise<any>; state: (sessionId?: string) => Promise<BoardState> };
const test = base.extend<{ app: AppFixture }>({
  app: async ({}, use) => {
    const root = await mkdtemp(join(tmpdir(), 'acanvas-browser-project-'));
    const additionalRoots: string[] = [];
    let running = await startAppProcess(root);
    const server = { url: running.url };
    let token = (await (await fetch(`${server.url}/api/bootstrap`)).json()).token;
    const call = async (path: string, method = 'GET', body?: unknown) => {
      const response = await fetch(`${server.url}${path}`, { method, headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      expect(response.ok, `API ${method} ${path}`).toBeTruthy();
      return response.json();
    };
    const state = async (sessionId?: string) => call(`/api/state?sessionId=${sessionId || (await call('/api/sessions'))[0].id}`) as Promise<BoardState>;
    const restart = async (samePort = false) => { const port = samePort ? Number(new URL(server.url).port) : 0; await running.close(); running = await startAppProcess(root, port); server.url = running.url; token = (await (await fetch(`${server.url}/api/bootstrap`)).json()).token; };
    const replaceProject = async () => { const nextRoot = await mkdtemp(join(tmpdir(), 'acanvas-other-project-')); additionalRoots.push(nextRoot); const port = Number(new URL(server.url).port); await running.close(); running = await startAppProcess(nextRoot, port); server.url = running.url; token = (await (await fetch(`${server.url}/api/bootstrap`)).json()).token; return nextRoot; };
    try { await use({ root, server, restart, replaceProject, call, state }); }
    finally { await running.close(); await rm(root, { recursive: true, force: true }); for (const directory of additionalRoots) await rm(directory, { recursive: true, force: true }); }
  },
});

async function open(page: Page, app: AppFixture) {
  await page.goto(app.server.url);
  await expect(page.getByRole('heading', { name: 'Drop files to start' })).toBeVisible();
  await expect(page.locator('.composer')).toHaveAttribute('data-save-state', 'saved'); await expect(page.locator('.connection-feedback')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.lang)).toBe('en');
  expect(await page.locator('body').innerText()).not.toMatch(/[\p{Script=Han}]/u);
  expect(await page.locator('dialog:not([open])').evaluateAll(elements => elements.every(element => getComputedStyle(element).display === 'none'))).toBeTruthy();
}

async function png(page: Page) {
  const encoded = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 600; canvas.height = 300;
    const context = canvas.getContext('2d')!;
    context.fillStyle = '#e2e2e0'; context.fillRect(0, 0, 600, 300);
    context.fillStyle = '#252525'; context.fillRect(120, 60, 360, 180);
    context.fillStyle = '#fff'; context.font = '32px sans-serif'; context.fillText('Canvas reference', 155, 162);
    return canvas.toDataURL('image/png').split(',')[1];
  });
  return { name: 'reference.png', mimeType: 'image/png', buffer: Buffer.from(encoded, 'base64') };
}

async function beginAnnotating(page: Page) {
  const comment = page.getByRole('textbox', { name: 'Add a comment', exact: true });
  if (!await comment.count()) await page.getByRole('button', { name: 'Annotate', exact: true }).click();
  await expect(comment).toBeVisible();
  return comment;
}

test('annotation levels retain clipped regions and sent task markings follow explicit inspection only', async ({ page, app }, info) => {
  await page.addInitScript(() => localStorage.setItem('acanvas-snapping', 'off'));
  await open(page, app); await page.getByLabel('Import files into canvas', { exact: true }).setInputFiles(await png(page));
  const object = page.locator('.board-object'); await expect(object).toBeVisible();
  const initial = await app.state(); await app.call('/api/board/operations', 'POST', { sessionId: initial.session.id, operations: [{ type: 'update', objectId: initial.objects[0].id, expectedVersion: initial.objects[0].version, changes: { x: 550, y: 250, width: 300, height: 300 } }] });
  await expect(object).toHaveAttribute('data-object-version', '2'); await object.focus(); await page.keyboard.press('Enter');
  await expect(page.locator('.selection-primary-tools button')).toHaveCount(3); await expect(page.getByRole('textbox', { name: 'Add a comment', exact: true })).toHaveCount(0); await expect(page.getByRole('button', { name: 'Snap to objects', exact: true })).toHaveCount(0);
  const comment = await beginAnnotating(page), frame = (await object.boundingBox())!;
  await page.mouse.move(frame.x + 60, frame.y + 105); await page.mouse.down(); await page.mouse.move(frame.x + 350, frame.y + 275, { steps: 4 }); await page.mouse.up();
  await beginAnnotating(page); await comment.fill('Refine the lower-right detail.');
  const region = page.locator('[data-annotation-source=editing]');
  expect(await region.evaluate(element => ({ x: Number.parseFloat((element as HTMLElement).style.left), y: Number.parseFloat((element as HTMLElement).style.top), width: Number.parseFloat((element as HTMLElement).style.width), height: Number.parseFloat((element as HTMLElement).style.height), color: getComputedStyle(element).borderColor }))).toEqual({ x: 610, y: 355, width: 240, height: 120, color: 'rgb(123, 188, 255)' });
  expect((await app.state()).objects[0].version).toBe(2); await expect(page.locator('.alignment-guides')).toHaveCount(0);
  await page.getByRole('button', { name: 'Back to selection tools', exact: true }).click(); await expect(comment).toHaveCount(0); await beginAnnotating(page); await expect(comment).toHaveValue('Refine the lower-right detail.');
  await comment.press('Escape'); await expect(comment).toHaveCount(0); await beginAnnotating(page); await expect(region).toHaveCSS('width', '240px');
  await page.screenshot({ path: info.outputPath('annotation-region-blue.png') });
  await page.getByRole('button', { name: 'Save comment', exact: true }).click(); await expect(page.getByRole('button', { name: 'Annotate', exact: true })).toBeVisible(); await expect(page.locator('[data-annotation-source=draft]')).toHaveCount(1);
  const draft = (await app.state()).draft; expect(draft.annotations[0].bounds).toEqual({ x: .2, y: .2, width: .8, height: .8 });
  await page.locator('#instruction').fill('Use this annotated detail.'); await page.locator('#instruction').press('Enter'); await expect(page.locator('.queue-item')).toHaveCount(1); await expect(page.locator('.annotation-outline')).toHaveCount(0);
  const sent = await app.state(), snapshot = JSON.stringify(sent.tasks[0].snapshot); expect(sent.annotations).toHaveLength(1);
  await beginAnnotating(page); await comment.fill('Keep this new draft separate.'); await page.getByRole('button', { name: 'Save comment', exact: true }).click(); await expect(page.locator('[data-annotation-source=draft]')).toHaveCount(1);
  const row = page.locator('.queue-task').first(); await row.click(); await expect(page.locator('[data-annotation-source=task]')).toHaveCount(1); await expect(page.locator('[data-annotation-source=draft]')).toHaveCount(0);
  await row.click(); await expect(page.locator('[data-annotation-source=task]')).toHaveCount(0); await expect(page.locator('[data-annotation-source=draft]')).toHaveCount(1);
  await row.click(); await page.getByRole('button', { name: 'Cancel request 1', exact: true }).click(); await expect(page.locator('.queue-item')).toHaveCount(0); await expect(page.locator('[data-annotation-source=task]')).toHaveCount(0);
  expect(JSON.stringify((await app.state()).tasks[0].snapshot)).toBe(snapshot); expect((await app.state()).annotations).toHaveLength(1);
  await page.getByRole('button', { name: 'Remove annotation 1', exact: true }).click(); await expect(page.locator('.annotation-outline')).toHaveCount(0);
  await page.getByRole('button', { name: 'Request history', exact: true }).click(); await expect(page.locator('[data-annotation-source=task]')).toHaveCount(0);
  await page.locator('.task-annotation-text').first().click(); await expect(page.locator('[data-annotation-source=task]')).toHaveCount(1); await page.getByRole('button', { name: 'Close request history', exact: true }).click(); await expect(page.locator('.annotation-outline')).toHaveCount(0);
  await page.getByRole('button', { name: 'Remove selected files from canvas', exact: true }).click(); await expect(object).toHaveCount(0); await page.getByRole('button', { name: 'Request history', exact: true }).click(); await page.locator('.task-annotation-text').first().click(); await expect(page.locator('.annotation-outline')).toHaveCount(0); await expect(page.locator('.task-annotation-text')).toContainText('Refine the lower-right detail.'); await expect(page.locator('.task-annotation-text')).toBeVisible();
  expect(JSON.stringify((await app.state()).tasks[0].snapshot)).toBe(snapshot);
});

test('second-level video annotation preserves time frame and pending target when leaving or switching', async ({ page, app }) => {
  await open(page, app); await page.getByLabel('Import files into canvas', { exact: true }).setInputFiles(resolve('tests/fixtures/frontend-video.mp4')); await page.getByLabel('Import files into canvas', { exact: true }).setInputFiles(await png(page)); await expect(page.locator('.board-object')).toHaveCount(2);
  const state = await app.state(); await app.call('/api/board/operations', 'POST', { sessionId: state.session.id, operations: state.objects.map((object, index) => ({ type: 'update', objectId: object.id, expectedVersion: object.version, changes: { x: index ? 850 : 450, y: 250 } })) });
  const videoObject = page.locator('.object-video'), video = videoObject.locator('video'); await expect(video).toHaveJSProperty('videoWidth', 320); await videoObject.focus(); await page.keyboard.press('Enter'); await video.evaluate(element => { (element as HTMLVideoElement).currentTime = .7; }); await expect.poll(async () => video.evaluate(element => (element as HTMLVideoElement).readyState)).toBeGreaterThanOrEqual(2);
  const comment = await beginAnnotating(page); await comment.fill('Keep this exact moment.'); await expect(page.getByRole('button', { name: 'Play video', exact: true })).toBeDisabled(); await expect(page.getByRole('slider', { name: 'Video timeline', exact: true })).toBeDisabled();
  const box = (await videoObject.boundingBox())!; await page.mouse.move(box.x + box.width * .2, box.y + box.height * .2); await page.mouse.down(); await page.mouse.move(box.x + box.width * .7, box.y + box.height * .7, { steps: 3 }); await page.mouse.up();
  await page.getByRole('button', { name: 'Back to selection tools', exact: true }).click(); await expect(page.getByRole('button', { name: 'Play video', exact: true })).toBeEnabled(); await video.evaluate(element => { (element as HTMLVideoElement).currentTime = 1.2; }); await beginAnnotating(page); await expect(video).toHaveJSProperty('currentTime', .7); await expect(comment).toHaveValue('Keep this exact moment.');
  await page.locator('.object-image').click({ position: { x: 60, y: 60 } }); await expect(page.locator('.object-image')).toHaveAttribute('data-selected', 'true'); await expect(comment).toHaveCount(0); await videoObject.click({ position: { x: 60, y: 60 } }); await beginAnnotating(page); await expect(comment).toHaveValue('Keep this exact moment.');
  await comment.press('Escape'); await page.locator('#instruction').press('Enter'); await expect(page.locator('.queue-item')).toHaveCount(1); await expect(page.locator('.annotation-outline')).toHaveCount(0);
  const saved = await app.state(), annotation = saved.tasks[0].snapshot.annotations[0]; expect(annotation.timeStart).toBeCloseTo(.7, 4); expect(annotation.snapshotAssetId).toBeTruthy(); expect(annotation.bounds.x).toBeCloseTo(.2, 2); expect(annotation.bounds.width).toBeCloseTo(.5, 2);
  await page.locator('.queue-task').click(); await expect(page.locator('[data-annotation-source=task]')).toHaveCount(1); await page.locator('.task-annotation-text').first().click(); await expect(page.locator('.task-annotation-frame')).toHaveJSProperty('naturalWidth', 320);
});

test('drag snapping preserves its preview at release, group offsets and bypass controls', async ({ page, app }, info) => {
  await page.addInitScript(() => localStorage.setItem('acanvas-snapping', 'off'));
  await open(page, app); const image = await png(page);
  await page.getByLabel('Import files into canvas', { exact: true }).setInputFiles(['Cover study.png', 'Color study.png', 'Type study.png'].map(name => ({ ...image, name })));
  await expect(page.locator('.board-object')).toHaveCount(3);
  const initial = await app.state(), ids = initial.objects.map(object => object.id);
  const place = async (zoom = 1, group = false) => {
    const state = await app.state();
    const positions = group ? [{ x: 200, y: 200, width: 80, height: 80 }, { x: 350, y: 250, width: 100, height: 60 }, { x: 600, y: 420, width: 120, height: 80 }] : [{ x: 250, y: 250, width: 100, height: 80 }, { x: 450, y: 450, width: 80, height: 60 }, { x: 900, y: 700, width: 60, height: 60 }];
    await app.call('/api/board/operations', 'POST', { sessionId: state.session.id, operations: state.objects.map((object, index) => ({ type: 'update', objectId: object.id, expectedVersion: object.version, changes: positions[index] })) });
    await app.call(`/api/sessions/${state.session.id}/view`, 'PUT', { x: zoom === 2 ? -200 : 0, y: zoom === 2 ? -250 : 0, zoom, selectedObjectIds: group ? ids.slice(0, 2) : [ids[0]] });
    await page.reload(); await expect(page.locator('.board-object')).toHaveCount(3); await expect(page.getByRole('button', { name: 'Select files', exact: true })).toBeEnabled();
  };
  const object = () => page.locator(`[data-object-id="${ids[0]}"]`);
  const begin = async () => { const rect = (await object().boundingBox())!; await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2); await page.mouse.down(); return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }; };
  for (const zoom of [1, 2]) {
    await place(zoom); const before = (await app.state()).objects[0];
    const start = await begin(); await page.mouse.move(start.x + 97 * zoom, start.y + 120 * zoom, { steps: 4 });
    await expect(page.locator('[data-snap-axis=x]')).toHaveAttribute('x1', '450');
    expect(await page.locator('.alignment-guides').evaluate(element => getComputedStyle(element).pointerEvents)).toBe('none');
    await expect.poll(async () => object().evaluate(element => Number.parseFloat((element as HTMLElement).style.left))).toBe(350);
    const preview = (await object().boundingBox())!; await page.mouse.up();
    await expect(object()).toHaveAttribute('data-object-version', String(before.version + 1));
    const saved = (await app.state()).objects[0]; expect(saved.x).toBe(350); expect(saved.y).toBe(370);
    expect((await object().boundingBox())!).toEqual(preview); await expect(page.locator('.alignment-guides')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Select files', exact: true })).toBeEnabled();
  }
  await place();
  let start = await begin(); await page.mouse.move(start.x + 97, start.y + 120); await expect(page.locator('.alignment-guides')).toBeVisible();
  await page.keyboard.down('Alt'); await expect(page.locator('.alignment-guides')).toHaveCount(0); expect(await object().evaluate(element => Number.parseFloat((element as HTMLElement).style.left))).toBe(347);
  await page.mouse.up(); await page.keyboard.up('Alt'); await expect.poll(async () => (await app.state()).objects[0].x).toBe(347);
  await expect(page.getByRole('button', { name: 'Snap to objects', exact: true })).toHaveCount(0);
  await place(1, true); const groupBefore = await app.state(); start = await begin(); await page.mouse.move(start.x + 147, start.y + 40, { steps: 4 }); await expect(page.locator('[data-snap-axis=x]')).toHaveAttribute('x1', '600');
  await page.screenshot({ path: info.outputPath('snap-group-guides.png') }); await page.mouse.up();
  await expect.poll(async () => (await app.state()).objects[0].x).toBe(350); const groupAfter = await app.state();
  expect(groupAfter.objects[1].x).toBe(500); expect(groupAfter.objects[1].x - groupAfter.objects[0].x).toBe(groupBefore.objects[1].x - groupBefore.objects[0].x); expect(groupAfter.objects[2]).toEqual(groupBefore.objects[2]);
  await expect(page.getByRole('button', { name: 'Select files', exact: true })).toBeEnabled();
  const version = groupAfter.objects[0].version; await object().click(); expect((await app.state()).objects[0].version).toBe(version); await expect(page.locator('.alignment-guides')).toHaveCount(0);
});

test('shared annotation bubbles and static queue previews preserve snapshot references', async ({ page, app }, info) => {
  await open(page, app); const image = await png(page);
  await page.getByLabel('Import files into canvas', { exact: true }).setInputFiles(['Cover study.png', 'Palette study.png', 'Texture study.png'].map(name => ({ ...image, name })));
  await page.getByLabel('Import files into canvas', { exact: true }).setInputFiles(resolve('tests/fixtures/frontend-video.mp4'));
  await page.getByLabel('Import files into canvas', { exact: true }).setInputFiles({ name: 'Creative direction.txt', mimeType: 'text/plain', buffer: Buffer.from('Keep the composition quiet and balanced.') });
  await expect(page.locator('.board-object')).toHaveCount(5);
  const video = page.locator('.object-video video'); await expect(video).toHaveJSProperty('videoWidth', 320); await expect.poll(async () => video.evaluate(element => (element as HTMLVideoElement).readyState)).toBeGreaterThanOrEqual(2);
  const firstFrame = await video.evaluate(element => { const media = element as HTMLVideoElement, frame = document.createElement('canvas'); frame.width = 128; frame.height = 72; frame.getContext('2d')!.drawImage(media, 0, 0, 128, 72); return frame.toDataURL('image/jpeg', .75); });
  await video.evaluate(element => { (element as HTMLVideoElement).currentTime = .9; }); await expect(video).toHaveJSProperty('currentTime', .9);
  await page.locator('.object-video').focus(); await page.keyboard.press('Enter');
  const bubblePath = await page.getByRole('button', { name: 'Annotate', exact: true }).locator('.annotation-bubble path').getAttribute('d');
  for (const object of await page.locator('.object-image').all()) { await object.focus(); await page.keyboard.press('Shift+Enter'); }
  await page.getByRole('button', { name: 'Attach to request', exact: true }).click();
  const thumb = page.locator('.draft-asset .asset-thumb[data-kind=video] img'); await expect(thumb).toHaveAttribute('src', firstFrame); await expect(video).toHaveJSProperty('currentTime', .9); await expect(video).toHaveJSProperty('paused', true);
  await page.locator('#instruction').fill('Create a quiet cover using these visual references.'); await page.locator('#instruction').press('Enter'); await expect(page.locator('.queue-item')).toHaveCount(1);
  const row = page.locator('.queue-item').first(); await expect(row.locator('.queue-preview')).toHaveCount(3); await expect(row.locator('.queue-preview-overflow')).toHaveText('+1'); await expect(row.locator('.asset-thumb[data-kind=video] img')).toHaveAttribute('src', firstFrame); expect(await row.locator('.queue-row').evaluate(element => element.getBoundingClientRect().height)).toBe(36);
  for (const [index, object] of (await page.locator('.board-object').all()).entries()) { await object.focus(); await page.keyboard.press(index ? 'Shift+Enter' : 'Enter'); }
  await page.getByRole('button', { name: 'Attach to request', exact: true }).click();
  await page.locator('.object-image').first().focus(); await page.keyboard.press('Enter');
  for (const text of ['Give the focal detail more breathing room.', 'Keep the quiet palette and soft contrast.']) { const comment = await beginAnnotating(page); await comment.fill(text); await comment.press('Enter'); await expect(page.getByRole('button', { name: 'Annotate', exact: true })).toBeEnabled(); }
  await expect(page.locator('.annotation-pin')).toHaveCount(2); await expect(page.locator('.draft-annotation .annotation-bubble text')).toHaveText(['1', '2']);
  const paths = await page.locator('.annotation-pin .annotation-bubble path,.draft-annotation .annotation-bubble path').evaluateAll(elements => elements.map(element => element.getAttribute('d'))); expect(paths.every(path => path === bubblePath)).toBeTruthy();
  await page.screenshot({ path: info.outputPath('compact-references-and-queue.png') });
  await page.locator('#instruction').fill('Refine the cover around these two annotated details.'); await page.locator('#instruction').press('Enter'); await expect(page.locator('.queue-item')).toHaveCount(2);
  const second = page.locator('.queue-item').nth(1); await expect(second.locator('.queue-preview')).toHaveCount(3); await expect(second.locator('.queue-preview-overflow')).toHaveText('+3'); await expect(second.locator('.queue-previews')).toHaveAttribute('aria-label', '6 references');
  const immutable = JSON.stringify((await app.state()).tasks[1].snapshot);
  await page.locator('.object-video').focus(); await page.keyboard.press('Enter'); const comment = await beginAnnotating(page); await comment.fill('Use this exact motion frame.'); await comment.press('Enter'); await expect(page.getByRole('button', { name: 'Annotate', exact: true })).toBeEnabled();
  await page.locator('#instruction').press('Enter'); await expect(page.locator('.queue-item')).toHaveCount(3); const third = page.locator('.queue-item').nth(2); await expect(third.locator('.queue-preview')).toHaveCount(1); await expect(third.locator('.queue-preview-overflow')).toHaveCount(0); await expect(third.locator('.annotation-bubble text')).toHaveText('1');
  await expect(third.locator('.queue-preview img')).toHaveJSProperty('naturalWidth', 320);
  for (const width of [390, 320]) { await page.setViewportSize({ width, height: 480 }); await expect.poll(async () => row.locator('.queue-title').evaluate(element => element.getBoundingClientRect().width)).toBeGreaterThan(20); expect(await row.locator('.queue-row').evaluate(element => element.getBoundingClientRect().height)).toBe(36); await row.locator('.queue-task').click(); await expect(row.locator('.queue-task')).toHaveAttribute('aria-expanded', 'true'); await row.locator('.queue-task').click(); await expect(row.locator('.queue-task')).toHaveAttribute('aria-expanded', 'false'); }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.reload(); await expect(page.locator('.queue-item')).toHaveCount(3); expect(JSON.stringify((await app.state()).tasks[1].snapshot)).toBe(immutable); await expect(page.locator('.queue-item').nth(1).locator('.queue-preview-overflow')).toHaveText('+3');
  await page.locator('.queue-task').first().click(); await expect(page.locator('.inline-task-detail .asset-thumb[data-kind=video] img')).toHaveAttribute('src', firstFrame); await page.getByRole('button', { name: 'Cancel request 1', exact: true }).click(); await page.getByRole('button', { name: 'Request history', exact: true }).click(); await expect(page.locator('.history-list .asset-thumb[data-kind=video] img').first()).toHaveAttribute('src', firstFrame);
});

test('six inline alignment commands batch positions without changing sizes or unselected files', async ({ page, app }, info) => {
  await open(page, app); const image = await png(page);
  await page.getByLabel('Import files into canvas', { exact: true }).setInputFiles(['Cover.png', 'Palette.png', 'Type.png'].map(name => ({ ...image, name }))); await expect(page.locator('.board-object')).toHaveCount(3);
  const requests: { operations: { objectId: string; expectedVersion: number; changes: { x: number; y: number } }[] }[] = [];
  page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/api/board/operations')) requests.push(request.postDataJSON()); });
  const reset = async () => { const state = await app.state(); await app.call('/api/board/operations', 'POST', { sessionId: state.session.id, operations: state.objects.map((object, index) => ({ type: 'update', objectId: object.id, expectedVersion: object.version, changes: [{ x: 220, y: 200, width: 120, height: 80 }, { x: 410, y: 310, width: 80, height: 120 }, { x: 900, y: 200, width: 60, height: 60 }][index] })) }); await app.call(`/api/sessions/${state.session.id}/view`, 'PUT', { x: 0, y: 0, zoom: 1, selectedObjectIds: state.objects.slice(0, 2).map(object => object.id) }); await page.reload(); await expect(page.getByRole('button', { name: 'Align', exact: true })).toBeVisible(); await expect(page.getByRole('button', { name: 'Align left', exact: true })).toHaveCount(0); await page.getByRole('button', { name: 'Align', exact: true }).click(); await expect(page.getByRole('button', { name: 'Align left', exact: true })).toBeVisible(); return app.state(); };
  const commands = [{ name: 'Align left', expected: [[220, 200], [220, 310]] }, { name: 'Align horizontal centers', expected: [[295, 200], [315, 310]] }, { name: 'Align right', expected: [[370, 200], [410, 310]] }, { name: 'Align top', expected: [[220, 200], [410, 200]] }, { name: 'Align vertical centers', expected: [[220, 275], [410, 255]] }, { name: 'Align bottom', expected: [[220, 350], [410, 310]] }];
  for (const command of commands) { const before = await reset(), count = requests.length; const button = page.getByRole('button', { name: command.name, exact: true }); await button.focus(); await button.press('Enter'); await expect(page.getByRole('button', { name: 'Align', exact: true })).toBeEnabled(); await expect(button).toHaveCount(0); await expect.poll(async () => (await app.state()).objects.slice(0, 2).map(object => [object.x, object.y])).toEqual(command.expected); const after = await app.state(); expect(requests.length).toBe(count + 1); for (let index = 0; index < 2; index++) { expect(after.objects[index].width).toBe(before.objects[index].width); expect(after.objects[index].height).toBe(before.objects[index].height); } expect(after.objects[2]).toEqual(before.objects[2]); const versions = after.objects.map(object => object.version); await page.getByRole('button', { name: 'Align', exact: true }).click(); await button.press('Enter'); await page.evaluate(() => new Promise(requestAnimationFrame)); expect((await app.state()).objects.map(object => object.version)).toEqual(versions); expect(requests.length).toBe(count + 1); }
  await reset();
  for (const width of [390, 320]) { await page.setViewportSize({ width, height: 480 }); await page.getByRole('button', { name: 'Fit all files', exact: true }).click(); await expect.poll(async () => page.locator('.alignment-actions button,.canvas-toolbar button').evaluateAll(elements => elements.every(element => { const bounds = element.getBoundingClientRect(); return document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)?.closest('button') === element; }))).toBeTruthy(); await expect(page.getByRole('button', { name: 'Annotate', exact: true })).toHaveCount(0); await page.getByRole('button', { name: 'Back to selection tools', exact: true }).click(); await expect(page.getByRole('button', { name: 'Align', exact: true })).toBeFocused(); await page.getByRole('button', { name: 'Align', exact: true }).press('Enter'); if (width === 390) await page.screenshot({ path: info.outputPath('alignment-controls-390.png') }); }
  await page.getByRole('button', { name: 'Align left', exact: true }).press('Escape'); await expect(page.getByRole('button', { name: 'Align', exact: true })).toBeFocused(); await page.getByRole('button', { name: 'Align', exact: true }).press('Enter');
  const before = await app.state(); await page.route('**/api/board/operations', route => route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: { code: 'object_conflict', message: 'Updated layout' } }) })); await page.getByRole('button', { name: 'Align right', exact: true }).click(); await expect(page.getByRole('alert')).toBeVisible(); expect((await app.state()).objects).toEqual(before.objects); await expect(page.getByRole('button', { name: 'Align', exact: true })).toBeEnabled(); await expect(page.locator('.alignment-actions')).toHaveCount(0);
});

test('alignment command restores keyboard focus after its confirmed layout write', async ({ page, app }) => {
  await open(page, app); const image = await png(page);
  await page.getByLabel('Import files into canvas', { exact: true }).setInputFiles(['Cover.png', 'Palette.png'].map(name => ({ ...image, name }))); await expect(page.locator('.board-object')).toHaveCount(2);
  for (const [index, object] of (await page.locator('.board-object').all()).entries()) { await object.focus(); await page.keyboard.press(index ? 'Shift+Enter' : 'Enter'); }
  await page.route('**/api/board/operations', async route => { const response = await route.fetch(); await new Promise(resolve => setTimeout(resolve, 180)); await route.fulfill({ response }); });
  const align = page.getByRole('button', { name: 'Align', exact: true }); await align.focus(); await align.press('Enter');
  const command = page.getByRole('button', { name: 'Align left', exact: true }); await expect(command).toBeFocused(); await command.press('Enter');
  await expect(align).toBeEnabled(); await expect(align).toBeFocused(); await expect(page.locator('.alignment-actions')).toHaveCount(0);
  const positions = (await app.state()).objects.map(object => object.x); expect(positions[0]).toBe(positions[1]);
});

test('each confirmed local send animates once including SSE-first and recovered responses', async ({ page, app }, info) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.addInitScript(() => {
    const record = { starts: [] as string[], ends: [] as string[] };
    (window as unknown as Window & { queueMotion: typeof record }).queueMotion = record;
    document.addEventListener('animationstart', event => { const animation = event as AnimationEvent; if (animation.animationName === 'queue-send') record.starts.push((animation.target as HTMLElement).dataset.taskId!); });
    document.addEventListener('animationend', event => { const animation = event as AnimationEvent; if (animation.animationName === 'queue-send') record.ends.push((animation.target as HTMLElement).dataset.taskId!); });
  });
  await open(page, app);
  const motions = () => page.evaluate(() => (window as unknown as Window & { queueMotion: { starts: string[]; ends: string[] } }).queueMotion);
  const input = page.locator('#instruction'), sessionId = (await app.state()).session.id;
  for (let index = 1; index <= 3; index++) {
    let release = () => {}, arrived: Promise<void> | undefined;
    if (index === 2) {
      let entered!: () => void; arrived = new Promise(resolve => { entered = resolve; }); const delayed = new Promise<void>(resolve => { release = resolve; });
      await page.route(`**/api/sessions/${sessionId}/tasks`, async route => { const response = await route.fetch(); entered(); await delayed; await route.fulfill({ response }); });
    }
    await input.fill(`Motion direction ${index}`); await input.press('Enter'); if (index === 1) await page.locator('.queue-stack').hover();
    if (arrived) { await arrived; await expect(page.locator('.queue-item')).toHaveCount(2); expect((await motions()).starts).toHaveLength(1); release(); }
    await expect(input).toBeEnabled(); await expect.poll(async () => (await motions()).starts.length).toBe(index);
    if (index === 2) await page.unroute(`**/api/sessions/${sessionId}/tasks`);
  }
  await expect.poll(async () => (await motions()).ends.length).toBe(3);
  await input.fill('Visible fourth direction'); await input.press('Enter'); await expect(input).toBeEnabled(); await expect.poll(async () => (await motions()).starts.length).toBe(4);
  await page.locator('.queue-stack').hover(); await expect(page.locator('.queue-expand')).toHaveAttribute('aria-expanded', 'true'); await expect(page.locator('.queue-item').last()).toBeInViewport();
  await page.locator('#whiteboard').click({ position: { x: 1200, y: 100 } }); await page.locator('.queue-stack').hover();
  await expect.poll(async () => page.locator('.queue-entering').count()).toBe(0); expect((await motions()).starts).toHaveLength(4);
  const state = await app.state(); await app.call(`/api/sessions/${sessionId}/tasks/${state.tasks[0].id}/cancel`, 'POST', { reason: 'Updated direction' }); await expect(page.locator('.queue-item')).toHaveCount(3);
  await page.getByRole('button', { name: 'Request history', exact: true }).click(); await page.getByRole('button', { name: 'Close request history', exact: true }).click(); expect((await motions()).starts).toHaveLength(4);
  await page.route(`**/api/sessions/${sessionId}/tasks`, route => route.fulfill({ status: 500, contentType: 'application/json', body: '{}' }));
  await input.fill('Failed direction'); await input.press('Enter'); await expect(input).toBeEnabled(); await expect(page.getByRole('alert')).toContainText('(500)'); expect((await motions()).starts).toHaveLength(4); expect((await app.state()).tasks).toHaveLength(4);
  await page.unroute(`**/api/sessions/${sessionId}/tasks`);
  await page.emulateMedia({ reducedMotion: 'reduce' }); await input.fill('Immediate reduced motion result'); await input.press('Enter'); await expect(input).toBeEnabled(); await expect(page.locator('.queue-item')).toHaveCount(4); expect((await motions()).starts).toHaveLength(4); await expect(page.locator('.queue-entering')).toHaveCount(0);
  await page.emulateMedia({ reducedMotion: 'no-preference' }); expect((await motions()).starts).toHaveLength(4);
  await page.route(`**/api/sessions/${sessionId}/tasks`, async route => { await route.fetch(); await route.abort('failed'); });
  await input.fill('Recovered response direction'); await input.press('Enter'); await expect(input).toBeEnabled(); await page.locator('.queue-stack').hover(); await expect.poll(async () => (await motions()).starts.length).toBe(5); await page.unroute(`**/api/sessions/${sessionId}/tasks`);
  const ids = (await motions()).starts; expect(new Set(ids).size).toBe(ids.length);
  const second = await app.call('/api/sessions', 'POST', { name: 'Independent motion scope' }); const other = await page.context().newPage();
  await other.goto(`${app.server.url}/?session=${second.id}`); await expect(other.locator('#instruction')).toBeEnabled(); await other.locator('#instruction').fill('Other scope direction'); await other.locator('#instruction').press('Enter'); await expect(other.locator('.queue-item')).toHaveCount(1); expect((await motions()).starts).toHaveLength(5); await other.close();
  await expect.poll(async () => page.locator('.queue-entering').count()).toBe(0); await writeFile(info.outputPath('queue-motion-events.json'), JSON.stringify(await motions(), null, 2));
  await page.reload(); await expect(page.locator('.queue-item')).toHaveCount(5); expect((await motions()).starts).toHaveLength(0);
});

test('composer contains asset and annotation chips with quiet success feedback across viewports', async ({ page, browser, app }, info) => {
  await open(page, app);
  const input = page.locator('#instruction'), composer = page.locator('.composer');
  expect((await composer.boundingBox())!.height).toBe(52);
  await input.fill('Initial direction'); await input.press('Enter'); await expect(page.locator('.queue-item')).toHaveCount(1);
  const image = await png(page);
  const names = ['Product reference with a long descriptive file name one.png', 'Product reference with a long descriptive file name two.png', 'Product reference with a long descriptive file name three.png'];
  await page.getByLabel('Import files into canvas', { exact: true }).setInputFiles(names.map(name => ({ ...image, name })));
  await expect(page.locator('.board-object')).toHaveCount(3);
  for (let index = 0; index < 3; index++) { await page.locator('.board-object').nth(index).focus(); await page.keyboard.press(index ? 'Shift+Enter' : 'Enter'); }
  await page.getByRole('button', { name: 'Attach to request', exact: true }).click();
  await expect(page.locator('.composer .draft-asset')).toHaveCount(3); await expect(page.locator('.toast')).toHaveCount(0);
  const comment = page.getByRole('textbox', { name: 'Add a comment', exact: true });
  for (const text of ['Keep these proportions and the breathing room around the subject.', 'Use the reference colors across the composition.']) { await beginAnnotating(page); await comment.fill(text); await comment.press('Enter'); await expect(page.getByRole('button', { name: 'Annotate', exact: true })).toBeEnabled(); await expect(page.locator('.toast')).toHaveCount(0); }
  await expect(page.locator('.composer .draft-annotation')).toHaveCount(2);
  await input.fill('Use these references.\nKeep the visual hierarchy.');
  await expect(composer).toHaveAttribute('data-save-state', 'saved');
  for (const { width, height } of [{ width: 1440, height: 1000 }, { width: 390, height: 480 }, { width: 320, height: 480 }]) {
    await page.setViewportSize({ width, height });
    await expect.poll(async () => composer.evaluate(element => {
      const form = element.getBoundingClientRect(), refs = element.querySelector('.draft-attachments')!.getBoundingClientRect(), row = element.querySelector('.composer-input-row')!.getBoundingClientRect();
      return refs.left > form.left && refs.right < form.right && refs.top > form.top && refs.bottom <= row.top && row.bottom < form.bottom && form.left >= 16 && form.right <= innerWidth - 16 && form.bottom <= innerHeight;
    })).toBeTruthy();
    expect(await page.locator('.composer button').evaluateAll(elements => elements.filter(element => element !== document.querySelector('.send-button')).every(element => (element as HTMLButtonElement).type === 'button'))).toBeTruthy();
    expect(await page.locator('.draft-asset>span:nth-child(2)').first().evaluate(element => getComputedStyle(element).textOverflow)).toBe('ellipsis');
    expect(await page.locator('.draft-asset').first().evaluate(element => element.getBoundingClientRect().height)).toBe(32); expect(await page.locator('.draft-asset .asset-thumb').first().evaluate(element => element.getBoundingClientRect().width)).toBe(24); expect(await page.locator('.draft-asset').first().evaluate(element => getComputedStyle(element).borderRadius)).toBe('10px'); expect(await page.locator('.draft-asset .asset-thumb').first().evaluate(element => getComputedStyle(element).borderRadius)).toBe('6px');
    expect(await page.locator('.queue-item').last().evaluate(element => element.getBoundingClientRect().bottom <= document.querySelector('.composer')!.getBoundingClientRect().top)).toBeTruthy();
    expect(await page.locator('.canvas-toolbar button,.send-button').evaluateAll(elements => elements.every(element => { const rect = element.getBoundingClientRect(); return document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)?.closest('button') === element; }))).toBeTruthy();
    if (width < 500) expect(await page.locator('.draft-attachments').evaluate(element => element.scrollWidth > element.clientWidth)).toBeTruthy();
    if (width === 390) await page.screenshot({ path: info.outputPath('composer-reference-chips-390.png') });
  }
  const touchContext = await browser.newContext({ hasTouch: true, viewport: { width: 320, height: 480 } }); try { const touch = await touchContext.newPage(); await touch.goto(page.url()); await expect(touch.locator('.draft-asset')).toHaveCount(3); expect(await touch.locator('.draft-asset').first().evaluate(element => element.getBoundingClientRect().height)).toBe(36); expect(await touch.locator('.draft-asset .asset-thumb').first().evaluate(element => element.getBoundingClientRect().width)).toBe(24); } finally { await touchContext.close(); }
  const refs = page.locator('.draft-attachments'); await refs.evaluate(element => { element.scrollLeft = 0; });
  await page.getByRole('button', { name: `Remove attachment ${names[0]}`, exact: true }).click();
  await expect(page.locator('.draft-asset')).toHaveCount(2); expect((await app.state()).tasks).toHaveLength(1);
  await refs.evaluate(element => { element.scrollLeft = element.scrollWidth; });
  await page.getByRole('button', { name: 'Remove annotation 2', exact: true }).click();
  await expect(page.locator('.draft-annotation')).toHaveCount(1); expect((await app.state()).tasks).toHaveLength(1);
  await page.locator('.annotation-content').click(); await expect(page.getByRole('region', { name: 'Annotation', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Close annotation', exact: true }).click(); expect((await app.state()).tasks).toHaveLength(1);
  await input.press('Enter'); await expect(page.locator('.queue-item')).toHaveCount(2);
  const sent = await app.state(); expect(sent.tasks[1].snapshot.userRequest.text).toBe('Use these references.\nKeep the visual hierarchy.'); expect(sent.tasks[1].snapshot.annotations).toHaveLength(1);
  await expect(page.locator('.draft-attachments')).toHaveCount(0); await expect.poll(async () => (await composer.boundingBox())!.height).toBe(52);
  await page.locator('.board-object').first().focus(); await page.keyboard.press('Enter');
  await page.route('**/api/sessions/*/draft', route => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: { code: 'test_save_failure', message: 'The reference could not be saved.' } }) }));
  await page.getByRole('button', { name: 'Attach to request', exact: true }).click(); await expect(page.getByRole('alert')).toContainText('The action could not be completed (500).'); await expect(page.locator('.toast')).toHaveCount(0);
});

test('inline comments retain their targets through delayed snapshots and submit pending-only requests', async ({ page, app }, info) => {
  await open(page, app);
  await page.getByLabel('Import files into canvas', { exact: true }).setInputFiles(await png(page));
  await page.getByLabel('Import files into canvas', { exact: true }).setInputFiles(resolve('tests/fixtures/frontend-video.mp4'));
  await expect(page.locator('.board-object')).toHaveCount(2);
  const videoObject = page.locator('.object-video'), video = videoObject.locator('video'), comment = page.getByRole('textbox', { name: 'Add a comment', exact: true });
  await expect(video).toHaveJSProperty('videoWidth', 320);
  await videoObject.focus(); await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: 'Annotate', exact: true })).toBeVisible(); await expect(comment).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Add annotation', exact: true })).toHaveCount(0);
  await expect(page.locator('dialog,[aria-modal=true]')).toHaveCount(0);
  await video.evaluate(element => { (element as HTMLVideoElement).currentTime = .7; });
  await expect.poll(async () => video.evaluate(element => (element as HTMLVideoElement).readyState)).toBeGreaterThanOrEqual(2);
  await page.evaluate(() => { const original = HTMLCanvasElement.prototype.toBlob; HTMLCanvasElement.prototype.toBlob = function(callback, type, quality) { setTimeout(() => original.call(this, callback, type, quality), 350); }; });
  await beginAnnotating(page); await comment.fill('Keep this video moment');
  await page.getByLabel('End time', { exact: true }).fill('1.2');
  await page.locator('.object-image').focus(); await page.keyboard.press('Enter');
  await beginAnnotating(page); await expect(comment).toHaveValue(''); await comment.fill('Keep this image shape');
  await videoObject.focus(); await page.keyboard.press('Enter');
  await beginAnnotating(page); await expect(comment).toHaveValue('Keep this video moment');
  await expect(page.getByLabel('End time', { exact: true })).toHaveValue('1.2');
  await comment.evaluate(element => { element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })); element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })); element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 229, bubbles: true, cancelable: true })); });
  expect((await app.state()).draft.annotations).toHaveLength(0);
  await comment.press('End'); await comment.press('Shift+Enter'); await comment.pressSequentially('Keep its colors');
  await expect(comment).toHaveValue('Keep this video moment\nKeep its colors');
  await expect(page.getByRole('button', { name: 'Send request', exact: true })).toBeEnabled();
  await page.screenshot({ path: info.outputPath('inline-comment-video.png') });
  await page.locator('#instruction').press('Enter');
  await expect(page.locator('.queue-item')).toHaveCount(1);
  const saved = await app.state(), annotations = saved.tasks[0].snapshot.annotations;
  expect(saved.tasks[0].snapshot.userRequest.text).toBe(''); expect(annotations).toHaveLength(2);
  const frame = annotations.find(annotation => annotation.objectId === saved.objects.find(object => object.type === 'video')!.id)!;
  expect(frame.text).toBe('Keep this video moment\nKeep its colors'); expect(frame.timeStart).toBeCloseTo(.7, 1); expect(frame.timeEnd).toBe(1.2); expect(frame.snapshotAssetId).toBeTruthy();
  expect(annotations.find(annotation => annotation.objectId === saved.objects.find(object => object.type === 'image')!.id)!.text).toBe('Keep this image shape');
  await expect(page.getByRole('button', { name: 'Annotate', exact: true })).toBeVisible(); await expect(comment).toHaveCount(0); await expect(page.locator('#instruction')).toHaveValue('');
  const imageObject = saved.objects.find(object => object.type === 'image')!, savedVideo = saved.objects.find(object => object.type === 'video')!;
  await app.call('/api/board/operations', 'POST', { sessionId: saved.session.id, operations: [{ type: 'update', objectId: imageObject.id, expectedVersion: imageObject.version, changes: { x: savedVideo.x - 420 } }] });
  await expect(page.locator('.object-image')).toHaveAttribute('data-object-version', '2');
  await page.setViewportSize({ width: 320, height: 480 });
  await page.getByRole('button', { name: 'Fit all files', exact: true }).click();
  await page.locator('.object-image').focus(); await page.keyboard.press('Enter'); await beginAnnotating(page); await comment.fill('Preserve this other unsent comment');
  await page.locator('.queue-task').first().click(); await page.getByRole('button', { name: /Annotation 1:/ }).click();
  const reader = page.getByRole('region', { name: 'Annotation', exact: true });
  await expect(reader).toBeVisible(); await expect(comment).toHaveCount(0);
  const close = page.getByRole('button', { name: 'Close annotation', exact: true });
  expect(await close.evaluate(element => { const rect = element.getBoundingClientRect(); return document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)?.closest('button') === element; })).toBeTruthy();
  await expect(reader.locator('img')).toHaveJSProperty('naturalWidth', 320);
  await expect.poll(async () => (await app.state()).session.view.selectedObjectIds).toEqual([frame.objectId!]);
  const readerView = await page.locator('.canvas-world').evaluate(element => (element as HTMLElement).style.transform);
  await reader.hover(); await page.mouse.wheel(0, 100);
  await expect.poll(async () => reader.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
  expect(await page.locator('.canvas-world').evaluate(element => (element as HTMLElement).style.transform)).toBe(readerView);
  expect(await close.evaluate(element => { const rect = element.getBoundingClientRect(); return document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)?.closest('button') === element; })).toBeTruthy();
  await page.screenshot({ path: info.outputPath('inline-reader-video-320.png') });
  await close.click(); await expect(page.getByRole('button', { name: 'Annotate', exact: true })).toBeVisible();
  await page.locator('.object-image').focus(); await page.keyboard.press('Enter'); await beginAnnotating(page); await expect(comment).toHaveValue('Preserve this other unsent comment');
});

test('inline details history media and resume fallback keep short-screen canvas controls available', async ({ page, app }, info) => {
  await open(page, app);
  await page.getByLabel('Import files into canvas', { exact: true }).setInputFiles(await png(page));
  await page.locator('.board-object').focus(); await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'Attach to request', exact: true }).click();
  await page.locator('#instruction').fill('Explore this reference'); await page.locator('#instruction').press('Enter');
  const row = page.locator('.queue-task').first(); await row.click();
  await expect(row).toHaveAttribute('aria-expanded', 'true');
  const details = page.getByRole('region', { name: 'Request 1', exact: true }); await expect(details).toBeVisible();
  await row.click(); await expect(row).toHaveAttribute('aria-expanded', 'false'); await expect(details).not.toBeVisible();
  await row.click(); await expect(row).toHaveAttribute('aria-expanded', 'true'); await expect(details).toBeVisible();
  await details.getByRole('button', { name: 'View reference.png', exact: true }).click();
  await expect(page.locator('.board-object')).toHaveAttribute('data-selected', 'true');
  await page.getByRole('button', { name: 'Collapse request details', exact: true }).click(); await expect(row).toBeFocused();
  await page.setViewportSize({ width: 390, height: 480 }); await page.getByRole('button', { name: 'Fit all files', exact: true }).click();
  await page.getByRole('button', { name: 'Remove selected files from canvas', exact: true }).click(); await expect(page.locator('.board-object')).toHaveCount(0);
  await page.getByRole('button', { name: 'Request history', exact: true }).click();
  const history = page.getByRole('region', { name: 'Request history', exact: true });
  await history.getByRole('button', { name: 'View reference.png', exact: true }).click();
  await expect(history.getByRole('region', { name: 'Preview reference.png', exact: true }).locator('img')).toBeVisible();
  await expect(page.locator('a[target=_blank],dialog,[aria-modal=true]')).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('inline-history-media-390.png') });
  await page.getByRole('button', { name: 'Request history', exact: true }).click(); await expect(history).not.toBeVisible();
  await page.evaluate(() => { Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true, value: () => Promise.reject(new DOMException('Clipboard unavailable', 'NotAllowedError')) }); });
  await page.getByRole('button', { name: 'Copy resume prompt', exact: true }).click();
  const resume = page.getByRole('region', { name: 'Resume prompt', exact: true }); await expect(resume).toBeVisible();
  expect(await resume.getByRole('textbox').inputValue()).toContain(`Project: ${(await app.state()).project.root}`);
  await page.getByRole('button', { name: 'Pan canvas', exact: true }).click();
  const initial = (await app.state()).session.view;
  await page.locator('#whiteboard').hover({ position: { x: 230, y: 110 } }); await page.mouse.wheel(0, 40);
  await expect.poll(async () => (await app.state()).session.view.y).toBe(initial.y - 40);
  await page.getByRole('button', { name: 'Close resume prompt', exact: true }).click(); await expect(resume).not.toBeVisible();
  await page.screenshot({ path: info.outputPath('inline-controls-390.png') });
});

test('removing a file clears only its pending comment and external removal preserves a discard path', async ({ page, app }) => {
  await open(page, app);
  await page.getByLabel('Import files into canvas', { exact: true }).setInputFiles(await png(page));
  await expect(page.locator('.board-object')).toHaveCount(1);
  await page.getByLabel('Import files into canvas', { exact: true }).setInputFiles(await png(page));
  await expect(page.locator('.board-object')).toHaveCount(2);
  const comment = page.getByRole('textbox', { name: 'Add a comment', exact: true });
  await page.locator('.board-object').first().focus(); await page.keyboard.press('Enter'); await beginAnnotating(page); await comment.fill('Comment for removed file');
  await page.locator('.board-object').last().focus(); await page.keyboard.press('Enter'); await beginAnnotating(page); await comment.fill('Keep this other file');
  await page.locator('.board-object').first().focus(); await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'Remove selected files from canvas', exact: true }).click(); await expect(page.locator('.board-object')).toHaveCount(1);
  await page.locator('#instruction').fill('Create with the remaining file'); await page.locator('#instruction').press('Enter');
  await expect(page.locator('.queue-item')).toHaveCount(1);
  const sent = await app.state(); expect(sent.tasks[0].snapshot.annotations.map(annotation => annotation.text)).toEqual(['Keep this other file']);
  await page.locator('.board-object').focus(); await page.keyboard.press('Enter'); await beginAnnotating(page); await comment.fill('Keep this unsent text');
  await page.route('**/api/board/operations', route => route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: { code: 'object_conflict', message: 'This file was updated. Read its current layout.' } }) }));
  await page.getByRole('button', { name: 'Back to selection tools', exact: true }).click();
  await page.getByRole('button', { name: 'Remove selected files from canvas', exact: true }).click();
  await beginAnnotating(page); await expect(comment).toHaveValue('Keep this unsent text'); await expect(page.locator('.board-object')).toHaveCount(1);
  await page.unroute('**/api/board/operations');
  const current = await app.state();
  await app.call('/api/board/operations', 'POST', { sessionId: current.session.id, operations: [{ type: 'delete', objectId: current.objects[0].id, expectedVersion: current.objects[0].version }] });
  await expect(page.locator('.board-object')).toHaveCount(0);
  await expect(page.getByLabel('Unavailable comments')).toContainText('Keep this unsent text');
  await page.locator('#instruction').fill('Continue with a new direction'); await page.locator('#instruction').press('Enter');
  await expect(page.getByRole('alert')).toContainText('Discard it from the draft to continue');
  expect((await app.state()).draft.annotations).toHaveLength(0); expect((await app.state()).tasks).toHaveLength(1);
  await page.getByRole('button', { name: 'Discard unavailable comment', exact: true }).click();
  await page.locator('#instruction').press('Enter'); await expect(page.locator('.queue-item')).toHaveCount(2);
  expect((await app.state()).tasks[1].snapshot.userRequest.text).toBe('Continue with a new direction');
});

test('project identity and contextual actions follow selection, pan, zoom, resize and viewport edges', async ({ page, app }, info) => {
  await open(page, app);
  const initial = await app.state();
  await expect(page.locator('.project-name')).toHaveText(initial.project.name);
  await expect(page.locator('.project-identity')).toHaveAttribute('aria-label', `acanvas project: ${initial.project.name}`);
  await expect(page.locator('header')).toHaveCount(0);
  await page.getByLabel('Import files into canvas', { exact: true }).setInputFiles(await png(page));
  const object = page.locator('.board-object'), actions = page.locator('.selection-actions');
  await object.focus(); await page.keyboard.press('Enter');
  const anchorGap = async () => { const item = (await object.boundingBox())!, bar = (await actions.boundingBox())!; return item.y - bar.y - bar.height; };
  await expect.poll(anchorGap).toBeCloseTo(8, 1);
  const original = (await actions.boundingBox())!;
  await page.locator('#whiteboard').hover({ position: { x: 1100, y: 250 } });
  await page.mouse.wheel(50, 70);
  await expect.poll(anchorGap).toBeCloseTo(8, 1);
  await expect.poll(async () => (await actions.boundingBox())!.y).toBeCloseTo(original.y - 70, 1);
  await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
  await expect.poll(anchorGap).toBeCloseTo(8, 1);
  expect((await actions.boundingBox())!.width).toBeCloseTo(original.width, 1);
  await page.getByRole('button', { name: 'Resize reference.png bottom right', exact: true }).press('ArrowRight');
  await expect.poll(async () => (await app.state()).objects[0].version).toBe(2);
  await expect.poll(anchorGap).toBeCloseTo(8, 1);
  const current = await app.state();
  await app.call('/api/board/operations', 'POST', { sessionId: current.session.id, operations: [{ type: 'create', object: { assetId: current.assets[0].id, x: current.objects[0].x + 420, y: current.objects[0].y - 80, width: 200, height: 100 } }] });
  await expect(page.locator('.board-object')).toHaveCount(2);
  await page.locator('.board-object').nth(1).focus(); await page.keyboard.press('Shift+Enter');
  await expect(page.locator('.board-object[data-selected=true]')).toHaveCount(2);
  await expect.poll(async () => { const items = await page.locator('.board-object').evaluateAll(elements => elements.map(element => { const rect = element.getBoundingClientRect(); return { x: rect.x, y: rect.y, right: rect.right }; })); const bar = (await actions.boundingBox())!; return Math.abs(Math.min(...items.map(item => item.y)) - bar.y - bar.height - 8) < 1 && Math.abs(bar.x + bar.width / 2 - (Math.min(...items.map(item => item.x)) + Math.max(...items.map(item => item.right))) / 2) < 1; }).toBeTruthy();
  await page.locator('.board-object').first().focus(); await page.keyboard.press('Enter');
  await expect.poll(async () => (await app.state()).session.view.selectedObjectIds).toEqual([current.objects[0].id]);
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 480 });
    const state = await app.state();
    await app.call(`/api/sessions/${state.session.id}/view`, 'PUT', { ...state.session.view, selectedObjectIds: [state.objects[0].id], x: 70 - state.objects[0].x * .5, y: 180 - state.objects[0].y * .5, zoom: .5 });
    await page.reload();
    await expect.poll(async () => (await page.locator('.board-object').first().boundingBox())!.y).toBeCloseTo(180, 1);
    await expect.poll(async () => actions.evaluate(element => { const rect = element.getBoundingClientRect(); return rect.left >= 12 && rect.right <= innerWidth - 12 && rect.top >= 12 && rect.bottom <= innerHeight - 12; })).toBeTruthy();
    expect(await page.locator('.selection-actions button,.canvas-toolbar button,.canvas-actions button').evaluateAll(elements => elements.every(element => { const rect = element.getBoundingClientRect(); return document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)?.closest('button') === element; }))).toBeTruthy();
    await page.screenshot({ path: info.outputPath(`context-actions-${width}x480.png`) });
    await app.call(`/api/sessions/${state.session.id}/view`, 'PUT', { ...state.session.view, x: -state.objects[0].x * .5 - 1000, y: 180 - state.objects[0].y * .5, zoom: .5 });
    await page.reload();
    await expect(actions).not.toBeVisible();
  }
});

test('composer grows with wrap and newlines, restores height, sends Enter and protects IME confirmation', async ({ page, app }, info) => {
  await page.setViewportSize({ width: 390, height: 480 });
  await open(page, app);
  const input = page.locator('#instruction'), composer = page.locator('.composer');
  expect((await composer.boundingBox())!.height).toBe(52);
  const wrapped = 'Keep the subject in the center with enough space for a title and retain the shapes and colors from this reference.';
  await input.fill(wrapped);
  await expect.poll(async () => (await composer.boundingBox())!.height).toBeGreaterThan(52);
  expect((await input.boundingBox())!.height).toBeGreaterThan(24);
  await expect(composer).toHaveAttribute('data-save-state', 'saved');
  const grown = (await composer.boundingBox())!.height;
  await page.reload(); await expect(input).toHaveValue(wrapped);
  await expect.poll(async () => (await composer.boundingBox())!.height).toBe(grown);
  await input.fill('First line'); await input.press('Shift+Enter'); await input.pressSequentially('Second line');
  await expect(input).toHaveValue('First line\nSecond line');
  await expect.poll(async () => (await composer.boundingBox())!.height).toBe(76);
  expect((await app.state()).tasks).toHaveLength(0);
  await input.evaluate(element => {
    element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '候选' }));
    element.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Enter', code: 'Enter' }));
    element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '候选' }));
    element.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Enter', code: 'Enter', isComposing: true }));
    element.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Enter', code: 'Enter', keyCode: 229 }));
  });
  await expect(composer).toHaveAttribute('data-save-state', 'saved');
  expect((await app.state()).tasks).toHaveLength(0);
  await expect(input).toHaveValue('First line\nSecond line');
  await input.press('Enter'); await expect(input).toHaveValue('');
  await expect.poll(async () => (await composer.boundingBox())!.height).toBe(52);
  expect((await app.state()).tasks[0].snapshot.userRequest.text).toBe('First line\nSecond line');
  for (let index = 2; index <= 6; index++) { await input.fill(`Request ${index}`); await input.press('Enter'); await expect(page.locator('.queue-item')).toHaveCount(index); }
  const long = Array.from({ length: 12 }, (_, index) => `Line ${index + 1}`).join('\n');
  await input.fill(long);
  await expect.poll(async () => input.evaluate(element => element.scrollHeight > element.clientHeight)).toBeTruthy();
  await page.locator('.queue-expand').click();
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 480 });
    await expect.poll(async () => page.locator('.queue-list').evaluate(element => element.getBoundingClientRect().top)).toBeGreaterThanOrEqual(64);
    const queue = page.locator('.queue-list');
    await expect.poll(async () => page.locator('.queue-extra').last().evaluate(element => element.getBoundingClientRect().height)).toBeGreaterThan(36); await queue.evaluate(element => { element.scrollTop = element.scrollHeight; });
    await expect(page.locator('.queue-item').last()).toBeInViewport();
    await expect.poll(async () => page.locator('.canvas-toolbar button,.canvas-actions button,.send-button,.queue-list>.queue-extra:last-child .queue-item button').evaluateAll(elements => elements.filter(element => { const rect = element.getBoundingClientRect(); return document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)?.closest('button') !== element; }).map(element => element.getAttribute('aria-label')))).toEqual([]);
    await page.screenshot({ path: info.outputPath(`growing-composer-${width}x480.png`) });
  }
  await page.emulateMedia({ reducedMotion: 'reduce' });
  expect(await composer.evaluate(element => getComputedStyle(element).transitionDuration)).toBe('0s');
  expect(await page.locator('.queue-list').evaluate(element => getComputedStyle(element).animationName)).toBe('none');
  await input.press('Enter'); await expect(input).toHaveValue('');
  await expect.poll(async () => (await composer.boundingBox())!.height).toBe(52);
  expect((await app.state()).tasks.at(-1)!.snapshot.userRequest.text).toBe(long);
});

test('short-screen contextual video controls stay reachable beside a clipped selection and long queued draft', async ({ page, app }, info) => {
  await page.setViewportSize({ width: 390, height: 480 });
  await open(page, app);
  await page.getByLabel('Import files into canvas', { exact: true }).setInputFiles(resolve('tests/fixtures/frontend-video.mp4'));
  const object = page.locator('.board-object'), video = object.locator('video'), input = page.locator('#instruction');
  await expect(video).toHaveJSProperty('videoWidth', 320);
  await object.focus(); await page.keyboard.press('Enter');
  for (let index = 1; index <= 2; index++) { await input.fill(`Queued direction ${index}`); await input.press('Enter'); await expect(page.locator('.queue-item')).toHaveCount(index); }
  await beginAnnotating(page);
  await page.getByRole('textbox', { name: 'Add a comment', exact: true }).fill('Keep this moment.');
  await page.getByRole('button', { name: 'Save comment', exact: true }).click();
  await expect(page.locator('.draft-annotation')).toHaveCount(1);
  await input.fill(Array.from({ length: 50 }, (_, index) => `Draft line ${index + 1}`).join('\n'));
  await expect(page.locator('.composer')).toHaveAttribute('data-save-state', 'saved');
  const current = await app.state();
  await app.call('/api/board/operations', 'POST', { sessionId: current.session.id, operations: [{ type: 'update', objectId: current.objects[0].id, expectedVersion: current.objects[0].version, changes: { x: 0, y: 0, width: 160 / 1.7, height: 90 / 1.7 } }] });
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 480 });
    const state = await app.state();
    await app.call(`/api/sessions/${state.session.id}/view`, 'PUT', { ...state.session.view, x: width - 130, y: 85, zoom: 1.7 });
    await page.reload();
    await expect.poll(async () => (await object.boundingBox())!.x).toBeCloseTo(width - 130, 1);
    await expect.poll(async () => page.locator('.selection-actions button,.video-playback button,.video-playback input,.canvas-toolbar button,.canvas-actions button,.send-button').evaluateAll(elements => elements.every(element => { const rect = element.getBoundingClientRect(); const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2); return element instanceof HTMLInputElement ? hit === element : hit?.closest('button') === element; }))).toBeTruthy();
    const mediaIdentity = await video.evaluate(element => { (element as HTMLVideoElement & { retained?: string }).retained ||= crypto.randomUUID(); return (element as HTMLVideoElement & { retained: string }).retained; });
    await page.getByRole('button', { name: 'Play video', exact: true }).click(); await expect(video).toHaveJSProperty('paused', false);
    await page.getByRole('button', { name: 'Pause video', exact: true }).click(); await expect(video).toHaveJSProperty('paused', true);
    const timeline = page.getByRole('slider', { name: 'Video timeline', exact: true });
    await timeline.click(); await expect.poll(async () => video.evaluate(element => (element as HTMLVideoElement).currentTime)).toBeGreaterThan(.5);
    expect(await video.evaluate(element => (element as HTMLVideoElement & { retained: string }).retained)).toBe(mediaIdentity);
    await expect(page.getByRole('dialog', { name: /Request [12]/ })).not.toBeVisible();
    const queue = page.locator('.queue-list'); await expect.poll(async () => page.locator('.queue-extra').last().evaluate(element => element.getBoundingClientRect().height)).toBeGreaterThan(36); await queue.evaluate(element => { element.scrollTop = element.scrollHeight; });
    expect(await page.locator('.queue-item').last().getByRole('button').first().evaluate(element => { const rect = element.getBoundingClientRect(); return document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)?.closest('button') === element; })).toBeTruthy();
    await page.screenshot({ path: info.outputPath(`context-video-queued-${width}x480.png`) });
  }
  await input.press('Enter'); await expect(input).toHaveValue(''); await expect(page.locator('.queue-item')).toHaveCount(3);
  for (let index = 4; index <= 6; index++) { await input.fill(`Queued direction ${index}`); await input.press('Enter'); await expect(page.locator('.queue-item')).toHaveCount(index); }
  await input.fill(Array.from({ length: 50 }, (_, index) => `Draft line ${index + 1}`).join('\n'));
  await expect(page.locator('.composer')).toHaveAttribute('data-save-state', 'saved');
  const six = await app.state();
  await app.call('/api/board/operations', 'POST', { sessionId: six.session.id, operations: [{ type: 'update', objectId: six.objects[0].id, expectedVersion: six.objects[0].version, changes: { width: 150, height: 84 } }] });
  await app.call(`/api/sessions/${six.session.id}/view`, 'PUT', { ...six.session.view, x: 130, y: 140, zoom: 1 });
  await page.reload(); await expect(input).toHaveValue(Array.from({ length: 50 }, (_, index) => `Draft line ${index + 1}`).join('\n'));
  await page.locator('.queue-expand').click();
  await expect.poll(async () => page.locator('.selection-actions button,.video-playback button,.video-playback input,.canvas-toolbar button,.canvas-actions button,.send-button').evaluateAll(elements => elements.every(element => { const rect = element.getBoundingClientRect(); const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2); return element instanceof HTMLInputElement ? hit === element : hit?.closest('button') === element; }))).toBeTruthy();
  await page.getByRole('button', { name: 'Play video', exact: true }).click(); await expect(video).toHaveJSProperty('paused', false);
  await page.getByRole('button', { name: 'Pause video', exact: true }).click(); await expect(video).toHaveJSProperty('paused', true);
  await page.getByRole('slider', { name: 'Video timeline', exact: true }).click();
  await expect.poll(async () => video.evaluate(element => (element as HTMLVideoElement).currentTime)).toBeGreaterThan(.5);
  await page.locator('.queue-list').evaluate(element => { element.scrollTop = element.scrollHeight; });
  await expect(page.locator('.queue-item').last()).toBeInViewport();
  await page.screenshot({ path: info.outputPath('context-video-six-queue-320x480.png') });
});

test('real image import, zoomed media annotation, move/resize, CLI publication and refresh', async ({ page, app }, info) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await open(page, app);
  const image = await png(page);
  await page.getByLabel('Import files into canvas', { exact: true }).setInputFiles(image);
  const object = page.locator('.board-object').first();
  await expect(object).toBeVisible();
  await expect(object.locator('img')).toHaveJSProperty('naturalWidth', 600);
  await object.click({ position: { x: 80, y: 40 } });
  await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
  await beginAnnotating(page);
  await expect(page.getByRole('textbox', { name: 'Add a comment', exact: true })).toBeVisible();
  await page.getByRole('textbox', { name: 'Add a comment', exact: true }).fill('保留中部构图，增加呼吸感。');
  await page.screenshot({ path: info.outputPath('inline-comment.png') });
  await page.getByRole('button', { name: 'Save comment', exact: true }).click();
  await expect(page.locator('.draft-annotation')).toHaveCount(1);
  const before = await app.state();
  const annotation = before.draft.annotations[0];
  expect(annotation.bounds.x).toBe(0); expect(annotation.bounds.y).toBe(0);
  expect(annotation.bounds.width).toBe(1); expect(annotation.bounds.height).toBe(1);
  await page.getByRole('button', { name: 'Select files', exact: true }).click();
  const box = (await object.boundingBox())!;
  await page.mouse.move(box.x + box.width * .8, box.y + box.height * .8); await page.mouse.down();
  await page.mouse.move(box.x + box.width * .8 + 60, box.y + box.height * .8 + 30, { steps: 5 }); await page.mouse.up();
  await expect.poll(async () => (await app.state()).objects[0].version).toBe(2);
  await expect(object).toHaveAttribute('data-object-version', '2');
  const handle = page.getByRole('button', { name: 'Resize reference.png bottom right', exact: true });
  await handle.focus(); await handle.press('ArrowRight');
  await expect.poll(async () => (await app.state()).objects[0].version).toBe(3);
  const currentBox = (await object.locator('img').boundingBox())!;
  const annotationBox = (await page.locator('.annotation-outline').boundingBox())!;
  expect((annotationBox.x - currentBox.x) / currentBox.width).toBeCloseTo(0, 1);
  expect((annotationBox.y - currentBox.y) / currentBox.height).toBeCloseTo(0, 1);
  await page.getByLabel('Request', { exact: true }).fill('根据参考和批注生成一个新版本。');
  await page.getByRole('button', { name: 'Send request', exact: true }).click();
  await expect(page.locator('.queue-item[data-status="queued"]')).toHaveCount(1);
  await expect(page.locator('.draft-annotation')).toHaveCount(0);
  const taskState = await app.state(), sessionId = taskState.session.id;
  const args = ['--project', app.root, '--url', app.server.url, '--session', sessionId];
  const claimed = await cli(['task', 'next', ...args, '--consumer', 'browser-agent']) as Claim;
  expect(claimed.task?.snapshot.annotations[0].text).toBe(annotation.text);
  const inputFile = join(app.root, 'input.png');
  await cli(['asset', 'read', ...args, '--asset', claimed.task!.snapshot.referenceContent.assets[0].id, '--out', inputFile]);
  const outputFile = join(app.root, 'output.png'); await writeFile(outputFile, image.buffer);
  const output = await cli(['asset', 'import', ...args, '--file', outputFile, '--mime', 'image/png', '--task', claimed.task!.id, '--run', claimed.run!.id, '--consumer', 'browser-agent']) as Asset;
  const completionFile = join(app.root, 'completion.json');
  await writeFile(completionFile, JSON.stringify({ summary: '参考图已回填到共享白板。', assetIds: [output.id], validation: ['读取了原图与发送时批注', '产物文件已保存'], operations: [{ type: 'create', object: { assetId: output.id, x: 800, y: 250, width: 300, height: 150 } }] }));
  await cli(['task', 'complete', ...args, '--task', claimed.task!.id, '--run', claimed.run!.id, '--consumer', 'browser-agent', '--input', completionFile]);
  await expect(page.locator('.board-object')).toHaveCount(2);
  await page.getByRole('button', { name: /Request history/ }).click();
  await expect(page.locator('.task-card[data-status="completed"]')).toHaveCount(1);
  await expect(page.getByText('参考图已回填到共享白板。', { exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath('inline-history.png') });
  await page.getByRole('button', { name: 'Close request history', exact: true }).click();
  await page.getByRole('button', { name: 'Fit all files', exact: true }).click();
  await expect.poll(async () => (await app.state()).session.view.zoom).not.toBe(1.2);
  await expect(page.locator('.board-object img')).toHaveCount(2);
  await expect.poll(async () => page.locator('.board-object img').evaluateAll(images => images.every(image => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth === 600))).toBeTruthy();
  await page.locator('.board-object').first().focus(); await page.keyboard.press('Enter');
  await page.locator('.board-object').nth(1).focus(); await page.keyboard.press('Shift+Enter');
  await expect(page.locator('.board-object[data-selected=true]')).toHaveCount(2);
  await page.getByRole('button', { name: 'Attach to request', exact: true }).click();
  await expect(page.locator('.draft-asset')).toHaveCount(2);
  await expect(page.locator('.composer')).toHaveAttribute('data-save-state', 'saved');
  await expect(page.locator('.toast')).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('light-board.png') });
  await page.getByRole('button', { name: 'Switch to dark theme', exact: true }).click();
  await expect.poll(async () => page.locator('.composer').evaluate(element => getComputedStyle(element).backgroundColor)).toBe('rgb(34, 34, 34)');
  await page.locator('.board-object img').evaluateAll(images => Promise.all(images.map(image => (image as HTMLImageElement).decode())));
  const pixels = await page.locator('.board-object img').evaluateAll(images => images.map(image => { const frame = document.createElement('canvas'); frame.width = 600; frame.height = 300; const context = frame.getContext('2d')!; context.drawImage(image as HTMLImageElement, 0, 0); return [...context.getImageData(130, 80, 1, 1).data]; }));
  expect(pixels).toEqual([[37,37,37,255], [37,37,37,255]]);
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await page.screenshot({ path: info.outputPath('dark-board.png') });
  await page.reload(); await expect(page.locator('.board-object')).toHaveCount(2);
  await page.getByRole('button', { name: /Request history/ }).click();
  await expect(page.locator('.task-card[data-status="completed"]')).toHaveCount(1);
  await page.getByRole('button', { name: 'Close request history', exact: true }).click();
  expect(errors).toEqual([]);
});

test('two URL task contexts keep drafts and sends isolated through delayed saves and refresh', async ({ page, app }) => {
  await open(page, app);
  const initial = await app.state(), firstId = initial.session.id;
  const second = await app.call('/api/sessions', 'POST', { name: '另一条探索' });
  const secondPage = await page.context().newPage();
  await secondPage.goto(`${app.server.url}/?session=${second.id}`);
  await expect(secondPage.locator('#instruction')).toHaveValue('');
  await expect(page.locator('.session-list,.session-panel')).toHaveCount(0);
  let release!: () => void, entered!: () => void;
  const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
  const delayed = new Promise<void>(resolve => { release = resolve; });
  let held = false;
  await page.route(`**/api/sessions/${firstId}/draft`, async route => {
    if (held) return route.continue(); held = true;
    const response = await route.fetch(); entered(); await delayed; await route.fulfill({ response });
  });
  await page.locator('#instruction').fill('第一个上下文的草稿'); await enteredPromise;
  await secondPage.locator('#instruction').fill('第二个上下文的新想法');
  release();
  await expect.poll(async () => (await app.state(second.id)).draft.text).toBe('第二个上下文的新想法');
  await expect(secondPage.locator('#instruction')).toHaveValue('第二个上下文的新想法');
  await expect(page.locator('#instruction')).toHaveValue('第一个上下文的草稿');
  await page.unroute(`**/api/sessions/${firstId}/draft`);
  let releaseSend!: () => void, saving!: () => void;
  const savingPromise = new Promise<void>(resolve => { saving = resolve; });
  const sendDelay = new Promise<void>(resolve => { releaseSend = resolve; });
  await page.route(`**/api/sessions/${firstId}/draft`, async route => { const response = await route.fetch(); saving(); await sendDelay; await route.fulfill({ response }); });
  await page.locator('#instruction').fill('发送这条完整需求');
  await page.getByRole('button', { name: 'Send request', exact: true }).click(); await savingPromise;
  await expect(page.locator('#instruction')).toBeDisabled();
  releaseSend(); await expect(page.locator('#instruction')).toBeEnabled(); await expect(page.locator('#instruction')).toHaveValue('');
  await expect.poll(async () => (await app.state(firstId)).draft.id).not.toBe(initial.draft.id);
  expect((await app.state(firstId)).tasks[0].snapshot.userRequest.text).toBe('发送这条完整需求');
  await expect(secondPage.locator('.queue-item')).toHaveCount(0);
  await page.locator('#instruction').fill('发送后的下一条草稿');
  await expect.poll(async () => (await app.state(firstId)).draft.text).toBe('发送后的下一条草稿');
  await expect(page.locator('.composer')).toHaveAttribute('data-save-state', 'saved');
  await page.reload(); await expect(page.locator('#instruction')).toHaveValue('发送后的下一条草稿');
  await secondPage.reload(); await expect(secondPage.locator('#instruction')).toHaveValue('第二个上下文的新想法');
  expect((await app.state(second.id)).draft.text).toBe('第二个上下文的新想法');
  await secondPage.close();
});

test('video surface selects and moves at zoom/pan, with explicit keyboard playback and persisted layout', async ({ page, app }, info) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await open(page, app);
  await page.getByLabel('Import files into canvas', { exact: true }).setInputFiles(resolve('tests/fixtures/frontend-video.mp4'));
  const object = page.locator('.board-object.object-video'), surface = object.locator('.object-media'), video = object.locator('video');
  await expect(video).toHaveJSProperty('videoWidth', 320);
  await expect.poll(async () => video.evaluate(element => (element as HTMLVideoElement).readyState)).toBeGreaterThanOrEqual(2);
  await expect(video).toHaveJSProperty('controls', false);
  const original = (await app.state()).objects[0];
  await surface.click({ position: { x: 90, y: 70 } });
  await expect(object).toHaveAttribute('data-selected', 'true');
  await expect(video).toHaveJSProperty('paused', true);
  await expect(video).toHaveJSProperty('currentTime', 0);
  await expect(page.getByRole('button', { name: 'Play video', exact: true })).toBeEnabled();
  expect((await app.state()).objects[0].version).toBe(original.version);

  await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
  await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
  await expect.poll(async () => (await app.state()).session.view.zoom).toBeCloseTo(1.44, 4);
  const beforePan = (await app.state()).session.view;
  await page.getByRole('button', { name: 'Pan canvas', exact: true }).click();
  let box = (await surface.boundingBox())!;
  await page.mouse.move(box.x + box.width * .7, box.y + box.height * .7); await page.mouse.down();
  await page.mouse.move(box.x + box.width * .7 - 80, box.y + box.height * .7 - 50, { steps: 5 }); await page.mouse.up();
  await expect.poll(async () => (await app.state()).session.view.x).toBeCloseTo(beforePan.x - 80, 2);
  await expect.poll(async () => (await app.state()).session.view.y).toBeCloseTo(beforePan.y - 50, 2);
  expect((await app.state()).objects[0]).toEqual(original);
  await expect(video).toHaveJSProperty('paused', true);

  await page.getByRole('button', { name: 'Select files', exact: true }).click();
  await page.locator('#whiteboard').click({ position: { x: 280, y: 180 } });
  await expect(object).not.toHaveAttribute('data-selected');
  box = (await surface.boundingBox())!;
  await page.mouse.move(box.x + box.width * .7, box.y + box.height * .7); await page.mouse.down();
  await page.mouse.move(box.x + box.width * .7 + 72, box.y + box.height * .7 + 43.2, { steps: 5 }); await page.mouse.up();
  await expect.poll(async () => (await app.state()).objects[0].version).toBe(original.version + 1);
  let moved = (await app.state()).objects[0];
  expect(moved.x).toBeCloseTo(original.x + 50, 1); expect(moved.y).toBeCloseTo(original.y + 30, 1);
  await expect(object).toHaveAttribute('data-selected', 'true');
  await expect(video).toHaveJSProperty('paused', true);
  await expect(video).toHaveJSProperty('currentTime', 0);
  box = (await surface.boundingBox())!;
  await page.mouse.move(box.x + box.width * .5, box.y + box.height * .5); await page.mouse.down();
  await page.mouse.move(box.x + box.width * .5 + 36, box.y + box.height * .5 + 28.8, { steps: 5 }); await page.mouse.up();
  await expect.poll(async () => (await app.state()).objects[0].version).toBe(original.version + 2);
  moved = (await app.state()).objects[0];
  expect(moved.x).toBeCloseTo(original.x + 75, 1); expect(moved.y).toBeCloseTo(original.y + 50, 1);
  await expect(video).toHaveJSProperty('paused', true);

  await page.getByRole('button', { name: 'Play video', exact: true }).focus(); await page.keyboard.press('Enter');
  await expect(video).toHaveJSProperty('paused', false);
  await expect.poll(async () => video.evaluate(element => (element as HTMLVideoElement).currentTime)).toBeGreaterThan(.05);
  await surface.click({ position: { x: 90, y: 70 } });
  await expect(video).toHaveJSProperty('paused', false);
  await page.getByRole('button', { name: 'Pause video', exact: true }).click();
  await expect(video).toHaveJSProperty('paused', true);
  const timeline = page.getByRole('slider', { name: 'Video timeline', exact: true });
  await timeline.focus(); await page.keyboard.press('Home'); await page.keyboard.press('ArrowRight');
  await expect.poll(async () => video.evaluate(element => (element as HTMLVideoElement).currentTime)).toBeCloseTo(.1, 4);
  await expect(timeline).toBeFocused();
  await page.keyboard.press('End');
  await expect.poll(async () => video.evaluate(element => Math.abs((element as HTMLVideoElement).currentTime - (element as HTMLVideoElement).duration))).toBeLessThan(.1);
  await page.keyboard.press('Home');
  expect((await app.state()).objects[0]).toEqual(moved);

  for (const { width, height } of [{ width: 1440, height: 900 }, { width: 390, height: 900 }, { width: 390, height: 480 }]) {
    await page.setViewportSize({ width, height });
    await page.getByRole('button', { name: 'Fit all files', exact: true }).click();
    const playbackBox = (await page.getByRole('group', { name: 'Video playback', exact: true }).boundingBox())!;
    const actionsBox = (await page.locator('.selection-actions').boundingBox())!, importsBox = (await page.locator('.canvas-actions').boundingBox())!, toolsBox = (await page.locator('.canvas-toolbar').boundingBox())!;
    expect(playbackBox.x).toBeGreaterThanOrEqual(0); expect(playbackBox.x + playbackBox.width).toBeLessThanOrEqual(width);
    expect(playbackBox.x >= toolsBox.x + toolsBox.width + 8 || playbackBox.y + playbackBox.height <= toolsBox.y - 8 || playbackBox.y >= toolsBox.y + toolsBox.height + 8).toBeTruthy();
    const mediaBox = (await surface.boundingBox())!;
    if (height > 480) expect(playbackBox.y >= mediaBox.y + mediaBox.height || playbackBox.y + playbackBox.height <= mediaBox.y).toBeTruthy();
    expect(playbackBox.y + playbackBox.height <= actionsBox.y || playbackBox.y >= actionsBox.y + actionsBox.height).toBeTruthy();
    expect(playbackBox.y + playbackBox.height <= importsBox.y || playbackBox.y >= importsBox.y + importsBox.height).toBeTruthy();
    expect(await page.locator('.canvas-toolbar button, .video-playback button').evaluateAll(buttons => buttons.every(button => { const bounds = button.getBoundingClientRect(); return document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)?.closest('button') === button; }))).toBeTruthy();
    const timelineBox = (await timeline.boundingBox())!;
    expect(timelineBox.width).toBeGreaterThanOrEqual(100);
    expect(await timeline.evaluate(element => { const bounds = element.getBoundingClientRect(); return document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2) === element; })).toBeTruthy();
    await page.getByRole('button', { name: 'Play video', exact: true }).click();
    await expect(video).toHaveJSProperty('paused', false);
    await page.getByRole('button', { name: 'Pause video', exact: true }).click();
    await expect(video).toHaveJSProperty('paused', true);
    await timeline.click({ position: { x: timelineBox.width / 2, y: timelineBox.height / 2 } });
    await expect.poll(async () => video.evaluate(element => (element as HTMLVideoElement).currentTime / (element as HTMLVideoElement).duration)).toBeGreaterThan(.4);
    await timeline.focus(); await page.keyboard.press('Home');
    await page.screenshot({ path: info.outputPath(`video-controls-${width}${height === 480 ? 'x480' : ''}.png`) });
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await expect.poll(async () => (await app.state()).session.view.selectedObjectIds).toEqual([moved.id]);
  await page.reload();
  await expect(object).toHaveAttribute('data-selected', 'true');
  await expect(page.getByRole('button', { name: 'Play video', exact: true })).toBeEnabled();
  expect((await app.state()).objects[0]).toEqual(moved);
  const restoredBox = (await surface.boundingBox())!, restoredView = (await app.state()).session.view;
  expect(restoredBox.x).toBeCloseTo(moved.x * restoredView.zoom + restoredView.x, 1);
  expect(restoredBox.y).toBeCloseTo(moved.y * restoredView.zoom + restoredView.y, 1);
  expect(errors).toEqual([]);
});

test('video playback controls handle loading and rejected playback', async ({ page, app }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await open(page, app);
  let releaseMedia!: () => void;
  const mediaReady = new Promise<void>(resolve => { releaseMedia = resolve; });
  await page.route('**/api/assets/*/content', async route => { await mediaReady; await route.continue(); });
  await page.getByLabel('Import files into canvas', { exact: true }).setInputFiles(resolve('tests/fixtures/frontend-video.mp4'));
  const object = page.locator('.board-object.object-video'), video = object.locator('video');
  await object.locator('.object-media').click({ position: { x: 90, y: 70 } });
  await expect(page.getByRole('button', { name: 'Play video', exact: true })).toBeDisabled();
  await expect(page.getByRole('slider', { name: 'Video timeline', exact: true })).toBeDisabled();
  await expect(page.getByRole('slider', { name: 'Video timeline', exact: true })).toHaveAttribute('aria-valuetext', '0:00 of 0:00');
  releaseMedia();
  await expect(video).toHaveJSProperty('videoWidth', 320);
  await expect(page.getByRole('button', { name: 'Play video', exact: true })).toBeEnabled();
  await video.evaluate(element => { (element as HTMLVideoElement).play = () => Promise.reject(new DOMException('Playback permission is required.', 'NotAllowedError')); });
  await page.getByRole('button', { name: 'Play video', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Playback permission is required.');
  await expect(page.getByRole('button', { name: 'Play video', exact: true })).toBeEnabled();
  await expect(video).toHaveJSProperty('paused', true);
  expect(errors).toEqual([]);
});

test('real video and file imports, time/frame annotations and decode fallback', async ({ page, app }) => {
  await open(page, app);
  await page.getByLabel('Import files into canvas', { exact: true }).setInputFiles(resolve('tests/fixtures/frontend-video.mp4'));
  const video = page.locator('video'); await expect(video).toHaveJSProperty('videoWidth', 320);
  await page.locator('.object-media').first().click({ position: { x: 90, y: 70 } });
  const timeline = page.getByRole('slider', { name: 'Video timeline', exact: true });
  await timeline.focus(); await page.keyboard.press('Home');
  for (let index = 0; index < 7; index++) await page.keyboard.press('ArrowRight');
  await expect.poll(async () => video.evaluate(element => (element as HTMLVideoElement).currentTime)).toBeCloseTo(.7, 4);
  await expect.poll(async () => video.evaluate(element => (element as HTMLVideoElement).readyState)).toBeGreaterThanOrEqual(2);
  await page.locator('.object-caption').first().click();
  await beginAnnotating(page);
  await expect(page.locator('.comment-video-meta')).toContainText('0:00');
  await page.getByRole('textbox', { name: 'Add a comment', exact: true }).fill('在这个时间点保留主体。');
  await page.getByRole('button', { name: 'Save comment', exact: true }).click();
  await expect.poll(async () => (await app.state()).draft.annotations.length).toBe(1);
  const annotation = (await app.state()).draft.annotations[0]; expect(annotation.timeStart).toBeCloseTo(.7, 1); expect(annotation.snapshotAssetId).toBeTruthy();
  await video.evaluate(element => { (element as HTMLVideoElement).currentTime = 1.5; });
  await page.getByRole('button', { name: /Annotation 1:/ }).click();
  await expect(video).toHaveJSProperty('currentTime', annotation.timeStart!);
  await expect(page.getByRole('region', { name: 'Annotation', exact: true }).locator('img')).toBeVisible();
  await page.getByRole('button', { name: 'Close annotation', exact: true }).click();
  await page.getByLabel('Import files into canvas', { exact: true }).setInputFiles([{ name: 'brief.txt', mimeType: 'text/plain', buffer: Buffer.from('Project reference material') }, { name: 'unsupported.mp4', mimeType: 'video/mp4', buffer: Buffer.from('Undecodable video fixture') }]);
  await expect(page.locator('.board-object')).toHaveCount(3);
  await expect(page.getByText('Preview unavailable in this browser', { exact: true })).toBeVisible();
  await expect(page.getByText('brief.txt', { exact: true }).first()).toBeVisible();
  await page.getByLabel('Import files into canvas', { exact: true }).setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('Keep the existing design') });
  await expect(page.locator('.board-object')).toHaveCount(4);
  await page.locator('.board-object').last().focus(); await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'Attach to request', exact: true }).click();
  await expect(page.locator('.draft-asset')).toHaveCount(1);
  expect((await app.state()).objects).toHaveLength(4);
  await expect.poll(async () => (await app.state()).draft.attachments.length).toBe(1);
});

test('file paste and drop add canvas objects from every input while text remains editable', async ({ page, app }) => {
  await open(page, app); const image = await png(page); const data = [...image.buffer];
  const unprevented = await page.locator('#instruction').evaluate(element => { const data = new DataTransfer(); data.setData('text/plain', '普通文字'); const event = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }); element.dispatchEvent(event); return !event.defaultPrevented; });
  expect(unprevented).toBeTruthy();
  await page.locator('#instruction').fill('保留这段文字');
  await page.locator('#instruction').evaluate((element, data) => { const transfer = new DataTransfer(); transfer.items.add(new File([new Uint8Array(data)], 'pasted.png', { type: 'image/png' })); element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer })); }, data);
  await expect(page.locator('.board-object')).toHaveCount(1);
  await expect(page.locator('.draft-asset')).toHaveCount(0); await expect(page.locator('#instruction')).toHaveValue('保留这段文字');
  const first = await app.state(), bounds = (await page.locator('#whiteboard').boundingBox())!;
  expect(first.objects[0].x + first.objects[0].width / 2).toBeCloseTo((bounds.width / 2 - first.session.view.x) / first.session.view.zoom, 1);
  expect(first.objects[0].y + first.objects[0].height / 2).toBeCloseTo((bounds.height / 2 - first.session.view.y) / first.session.view.zoom, 1);
  await page.locator('#whiteboard').evaluate((element, data) => { const transfer = new DataTransfer(); transfer.items.add(new File([new Uint8Array(data)], 'dropped.png', { type: 'image/png' })); const bounds = element.getBoundingClientRect(); element.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, clientX: bounds.left + 300, clientY: bounds.top + 210, dataTransfer: transfer })); }, data);
  await expect(page.locator('.board-object')).toHaveCount(2);
  const dropped = await app.state();
  expect(dropped.objects[1].x + dropped.objects[1].width / 2).toBeCloseTo((300 - dropped.session.view.x) / dropped.session.view.zoom, 1);
  expect(dropped.objects[1].y + dropped.objects[1].height / 2).toBeCloseTo((210 - dropped.session.view.y) / dropped.session.view.zoom, 1);
  await page.locator('.composer').evaluate((element, data) => { const transfer = new DataTransfer(); transfer.items.add(new File([new Uint8Array(data)], 'composer-drop.png', { type: 'image/png' })); element.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer })); }, data);
  await expect(page.locator('.board-object')).toHaveCount(3);
  expect((await app.state()).draft.attachments).toEqual([]);
  await expect(page.locator('#instruction')).toHaveValue('保留这段文字');
});

test('full-screen canvas and floating controls preserve multiline drafts and references', async ({ page, app }, info) => {
  await open(page, app);
  const measurements: object[] = [];
  const image = await png(page);
  await page.getByLabel('Import files into canvas', { exact: true }).setInputFiles(image);
  await page.locator('.board-object').focus(); await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'Attach to request', exact: true }).click();
  const text = '保持主体的轮廓与比例。\n留出标题空间。\n使用现有参考中的色彩。';
  await page.locator('#instruction').fill(text);
  await expect.poll(async () => (await app.state()).draft.text).toBe(text);
  await page.reload(); await expect(page.locator('#instruction')).toHaveValue(text);
  await expect(page.locator('.draft-asset')).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Add attachment to request', exact: true })).toHaveCount(0);
  await expect(page.getByLabel('Select request attachments', { exact: true })).toHaveCount(0);
  await expect(page.locator('.composer .lucide-plus')).toHaveCount(0);
  for (const [name, width, height, dark] of [['light', 1440, 1000, false], ['dark', 1440, 1000, true], ['narrow', 390, 844, true]] as const) {
    await page.setViewportSize({ width, height });
    if (width <= 1160) await page.getByRole('button', { name: 'Fit all files', exact: true }).click();
    if (dark && await page.getByRole('button', { name: 'Switch to dark theme', exact: true }).count()) await page.getByRole('button', { name: 'Switch to dark theme', exact: true }).click();
    const input = page.locator('#instruction'); await input.focus();
    const composer = (await page.locator('.composer').boundingBox())!, box = (await input.boundingBox())!, send = (await page.getByRole('button', { name: 'Send request', exact: true }).boundingBox())!;
    const canvas = (await page.locator('#whiteboard').boundingBox())!, tools = (await page.getByRole('toolbar', { name: 'Board tools', exact: true }).boundingBox())!;
    expect(canvas).toEqual({ x: 0, y: 0, width, height });
    await expect.poll(async () => (await page.locator('.composer').boundingBox())!.height).toBe(152);
    expect(composer.width).toBeLessThanOrEqual(720);
    expect(Math.abs(box.y + box.height - 12 - send.y - send.height / 2)).toBeLessThan(1);
    expect(tools.x - canvas.x).toBe(16); expect(tools.height).toBeGreaterThan(tools.width);
    expect(tools.y + tools.height / 2).toBeCloseTo(canvas.y + canvas.height / 2, 1);
    expect(tools.y).toBeGreaterThan(canvas.y); expect(tools.y + tools.height).toBeLessThan(composer.y);
    expect(tools.width).toBe(40);
    const floating = page.locator('.canvas-actions .floating-control');
    await expect(floating).toHaveCount(2);
    expect(await floating.evaluateAll(buttons => buttons.every(button => { const bounds = button.getBoundingClientRect(); return bounds.top >= 14 && bounds.right <= innerWidth - 14 && document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)?.closest('button') === button; }))).toBeTruthy();
    const actions = (await page.locator('.selection-actions').boundingBox())!, imports = (await page.locator('.canvas-actions').boundingBox())!;
    expect(actions.x + actions.width <= imports.x || actions.y >= imports.y + imports.height).toBeTruthy();
    await expect(page.locator('.canvas-toolbar button')).toHaveCount(6);
    await expect(page.locator('.canvas-zoom')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Draw region annotation', exact: true })).toHaveCount(0);
    await expect(page.locator('header,.canvas-heading,.draft-save,.send-hint')).toHaveCount(0);
    expect(await input.evaluate(element => ({ rows: (element as HTMLTextAreaElement).rows, overflow: element.scrollHeight > element.clientHeight, outline: getComputedStyle(element).outlineStyle, border: getComputedStyle(element).borderWidth, shadow: getComputedStyle(element).boxShadow, surface: getComputedStyle(element).backgroundColor }))).toEqual({ rows: 1, overflow: false, outline: 'none', border: '0px', shadow: 'none', surface: 'rgba(0, 0, 0, 0)' });
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBeFalsy();
    measurements.push({ name, viewport: { width, height }, composer, input: box, send, canvas, tools, references: await page.locator('.draft-attachments').boundingBox() });
    await page.locator('.board-object img').evaluateAll(images => Promise.all(images.map(image => (image as HTMLImageElement).decode())));
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await page.screenshot({ path: info.outputPath(`floating-${name}.png`) });
  }
  await page.locator('#instruction').press(process.platform === 'darwin' ? 'Meta+Enter' : 'Control+Enter');
  await expect(page.locator('.queue-item')).toHaveCount(1);
  const sent = await app.state(); expect(sent.tasks[0].snapshot.userRequest.text).toBe(text); expect(sent.tasks[0].snapshot.referenceContent.assets).toHaveLength(1);
  for (let index = 2; index <= 6; index++) {
    await page.locator('#instruction').fill(`构图探索 ${index}`);
    await page.getByRole('button', { name: 'Send request', exact: true }).click();
    await expect(page.locator('.queue-item')).toHaveCount(index);
  }
  await page.locator('.board-object').focus(); await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'Attach to request', exact: true }).click();
  await page.locator('#instruction').fill(text);
  await expect(page.locator('.composer')).toHaveAttribute('data-save-state', 'saved');
  await expect(page.locator('.toast')).toHaveCount(0);
  await page.locator('.queue-expand').click(); await expect(page.locator('.queue-item:visible')).toHaveCount(6);
  for (const width of [390, 560, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 844 });
    const queue = (await page.locator('.queue-list').boundingBox())!, tools = (await page.locator('.canvas-toolbar').boundingBox())!, composer = (await page.locator('.composer').boundingBox())!, references = (await page.locator('.draft-attachments').boundingBox())!;
    expect(queue.x).toBeGreaterThanOrEqual(tools.x + tools.width + 4);
    expect(references.x).toBeGreaterThan(composer.x);
    expect(references.height).toBeLessThanOrEqual(44); expect(references.y).toBeGreaterThan(composer.y); expect(references.y + references.height).toBeLessThan(composer.y + composer.height);
    expect((await page.locator('.queue-item').last().boundingBox())!.y + (await page.locator('.queue-item').last().boundingBox())!.height).toBeLessThanOrEqual(references.y);
    expect(composer.height).toBe(152);
    expect(await page.locator('.canvas-toolbar button').evaluateAll(buttons => buttons.every(button => { const bounds = button.getBoundingClientRect(); return document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)?.closest('button') === button; }))).toBeTruthy();
    measurements.push({ name: `expanded-queue-${width}`, viewport: { width, height: 844 }, queue, tools, composer, references });
    await page.screenshot({ path: info.outputPath(`floating-queue-${width}.png`) });
  }
  await writeFile(info.outputPath('floating-geometry.json'), JSON.stringify(measurements, null, 2));
});

test('dark narrow composer keeps text styling stable, restores inline focus and respects reduced motion', async ({ page, app }, info) => {
  await page.setViewportSize({ width: 390, height: 844 }); await page.emulateMedia({ reducedMotion: 'reduce' });
  await open(page, app);
  await page.getByRole('button', { name: 'Switch to dark theme', exact: true }).click();
  const composer = page.locator('.composer'), input = page.locator('#instruction');
  const before = await composer.evaluate(element => ({ border: getComputedStyle(element).borderColor, surface: getComputedStyle(element).backgroundColor }));
  await input.focus(); await expect(input).toBeFocused();
  await input.fill('窄屏中的真实草稿');
  await expect.poll(async () => (await app.state()).draft.text).toBe('窄屏中的真实草稿');
  const styling = await input.evaluate(element => ({ outline: getComputedStyle(element).outlineStyle, border: getComputedStyle(element).borderWidth, background: getComputedStyle(element).backgroundColor, shadow: getComputedStyle(element).boxShadow, animation: getComputedStyle(element).animationName, overflow: document.documentElement.scrollWidth > innerWidth }));
  expect(styling).toEqual({ outline: 'none', border: '0px', background: 'rgba(0, 0, 0, 0)', shadow: 'none', animation: 'none', overflow: false });
  expect(await composer.evaluate(element => ({ border: getComputedStyle(element).borderColor, surface: getComputedStyle(element).backgroundColor }))).toEqual(before);
  const box = (await composer.boundingBox())!; expect(box.x).toBeGreaterThanOrEqual(16); expect(box.x + box.width).toBeLessThanOrEqual(374);
  await page.screenshot({ path: info.outputPath('dark-narrow-composer.png') });
  await page.getByRole('button', { name: 'Request history', exact: true }).click();
  const dialog = page.getByRole('region', { name: 'Request history', exact: true }); await expect(dialog).toBeVisible();
  await page.getByRole('button', { name: 'Close request history', exact: true }).click(); await expect(dialog).not.toBeVisible();
  await expect(page.getByRole('button', { name: 'Request history', exact: true })).toBeFocused();
  await page.screenshot({ path: info.outputPath('dark-narrow-board.png') });
});

test('clean drafts absorb CLI edits; conflicting unsaved drafts keep both copies', async ({ page, app }, info) => {
  await open(page, app);
  const first = await app.state();
  const args = ['--project', app.root, '--url', app.server.url, '--session', first.session.id];
  const externalFile = join(app.root, 'external-draft.json');
  await writeFile(externalFile, JSON.stringify({ ...first.draft, text: 'CLI 保存的草稿' }));
  await cli(['draft', 'save', ...args, '--input', externalFile]);
  await expect(page.locator('#instruction')).toHaveValue('CLI 保存的草稿');
  let release!: () => void, entered!: () => void;
  const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
  const delayed = new Promise<void>(resolve => { release = resolve; });
  await page.route(`**/api/sessions/${first.session.id}/draft`, async route => { entered(); await delayed; await route.continue(); });
  await page.locator('#instruction').fill('本地尚未保存的想法');
  await enteredPromise;
  const current = await app.state();
  await writeFile(externalFile, JSON.stringify({ ...current.draft, text: '服务端新增的完整想法' }));
  await cli(['draft', 'save', ...args, '--input', externalFile]);
  await expect(page.getByText('Draft updated elsewhere', { exact: true })).toBeVisible();
  await expect(page.locator('#instruction')).toHaveValue('本地尚未保存的想法');
  const dialog = page.getByRole('region', { name: 'Resolve draft update', exact: true });
  await expect(dialog.getByText('本地尚未保存的想法', { exact: true })).toBeVisible();
  await expect(dialog.getByText('服务端新增的完整想法', { exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath('draft-conflict.png') });
  release();
  await expect(page.getByRole('button', { name: 'Send request', exact: true })).toBeDisabled();
  expect((await app.state()).draft.text).toBe('服务端新增的完整想法');
  await page.getByRole('button', { name: 'Keep your draft', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect.poll(async () => (await app.state()).draft.text).toBe('本地尚未保存的想法');
  await expect(page.locator('.composer')).toHaveAttribute('data-save-state', 'saved');
  await page.unroute(`**/api/sessions/${first.session.id}/draft`);
  await page.locator('#instruction').fill('第二次本地输入');
  const latest = await app.state();
  await app.call(`/api/sessions/${first.session.id}/draft`, 'PUT', { ...latest.draft, text: '第二次服务端更新' });
  await expect(page.getByText('Draft updated elsewhere', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Use saved draft', exact: true }).click();
  await expect(page.locator('#instruction')).toHaveValue('第二次服务端更新');
});

test('two URL task contexts preserve their independent viewport during a delayed load', async ({ page, app }) => {
  await open(page, app);
  const first = await app.state();
  const second = await app.call('/api/sessions', 'POST', { name: '独立视口' });
  const secondView = { x: 740, y: 220, zoom: .5, selectedObjectIds: [] };
  await app.call(`/api/sessions/${second.id}/view`, 'PUT', secondView);
  let release!: () => void, entered!: () => void;
  const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
  const delayed = new Promise<void>(resolve => { release = resolve; });
  const secondPage = await page.context().newPage();
  await secondPage.route(`**/api/state?sessionId=${second.id}`, async route => { const response = await route.fetch(); entered(); await delayed; await route.fulfill({ response }); });
  const navigation = secondPage.goto(`${app.server.url}/?session=${second.id}`); await enteredPromise;
  await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
  release(); await navigation; await expect(secondPage.locator('.zoom-label')).toHaveText('50%');
  expect((await app.state(second.id)).session.view).toEqual(secondView);
  await expect.poll(async () => (await app.state(first.session.id)).session.view.zoom).toBe(1.2);
  await secondPage.close();
});

test('committed saves converge after lost responses before or after SSE confirmation', async ({ page, app }) => {
  await open(page, app);
  const sessionId = (await app.state()).session.id;
  for (const delay of [0, 180]) {
    let handled!: () => void;
    const handledPromise = new Promise<void>(resolve => { handled = resolve; });
    await page.route(`**/api/sessions/${sessionId}/draft`, async route => {
      await route.fetch();
      if (delay) await new Promise(resolve => setTimeout(resolve, delay));
      await route.abort('failed'); handled();
    });
    const text = `已持久保存但响应丢失 ${delay}`;
    await page.locator('#instruction').fill(text);
    await expect.poll(async () => (await app.state()).draft.text).toBe(text);
    await expect(page.locator('.composer')).toHaveAttribute('data-save-state', 'saved');
    await expect(page.locator('.draft-conflict')).toHaveCount(0);
    await expect(page.locator('#instruction')).toHaveValue(text);
    await handledPromise;
    await expect(page.locator('.composer')).toHaveAttribute('data-save-state', 'saved');
    await page.unroute(`**/api/sessions/${sessionId}/draft`);
  }
  await page.getByRole('button', { name: 'Send request', exact: true }).click();
  await expect(page.locator('.queue-item[data-status="queued"]')).toHaveCount(1);
  expect((await app.state()).tasks[0].snapshot.userRequest.text).toBe('已持久保存但响应丢失 180');
});

test('isolated production processes repeatedly restart, claim and publish without native lifecycle failures', async ({ page, app }) => {
  await open(page, app);
  const sessionId = (await app.state()).session.id;
  for (let index = 0; index < 3; index++) {
    await page.locator('#instruction').fill(`生产生命周期需求 ${index + 1}`);
    await page.getByRole('button', { name: 'Send request', exact: true }).click();
    await expect(page.locator('.queue-item[data-status="queued"]')).toHaveCount(1);
    const args = ['--project', app.root, '--url', app.server.url, '--session', sessionId];
    const claimed = await cli(['task', 'next', ...args, '--consumer', `lifecycle-agent-${index}`]) as Claim;
    const outputFile = join(app.root, `result-${index}.txt`); await writeFile(outputFile, `Published result ${index}`);
    const output = await cli(['asset', 'import', ...args, '--file', outputFile, '--mime', 'text/plain', '--task', claimed.task!.id, '--run', claimed.run!.id, '--consumer', `lifecycle-agent-${index}`]) as Asset;
    const completionFile = join(app.root, `completion-${index}.json`);
    await writeFile(completionFile, JSON.stringify({ summary: `已完成第 ${index + 1} 次交付`, assetIds: [output.id], validation: ['产物文件已保存'], operations: [{ type: 'create', object: { assetId: output.id, x: 20 + index * 290, y: 120, width: 250, height: 150 } }] }));
    await cli(['task', 'complete', ...args, '--task', claimed.task!.id, '--run', claimed.run!.id, '--consumer', `lifecycle-agent-${index}`, '--input', completionFile]);
    expect((await cli(['task', 'next', ...args, '--consumer', `lifecycle-agent-${index}`])).task).toBeNull();
    await expect(page.locator('.board-object')).toHaveCount(index + 1);
    await app.restart(); await page.goto(`${app.server.url}/?session=${sessionId}`);
    await expect(page.locator('.board-object')).toHaveCount(index + 1);
    await page.getByRole('button', { name: /Request history/ }).click();
    await expect(page.locator('.task-card[data-status="completed"]')).toHaveCount(index + 1);
    await page.getByRole('button', { name: 'Close request history', exact: true }).click();
  }
});

test('same-port service restart refreshes authentication and SSE while the browser stays open', async ({ page, app }) => {
  await open(page, app);
  await page.locator('#instruction').fill('重启前已入队的需求');
  await page.getByRole('button', { name: 'Send request', exact: true }).click();
  await expect(page.locator('.queue-item[data-status="queued"]')).toHaveCount(1);
  await page.locator('#instruction').fill('重启前的持久草稿');
  await expect(page.locator('.composer')).toHaveAttribute('data-save-state', 'saved');
  const url = page.url();
  let bootstrapResponses = 0;
  page.on('response', response => { if (response.url().endsWith('/api/bootstrap') && response.status() === 200) bootstrapResponses++; });
  await app.restart(true);
  await expect.poll(() => bootstrapResponses, { timeout: 15_000 }).toBeGreaterThan(0);
  await expect(page.locator('.connection-feedback')).toHaveCount(0, { timeout: 15_000 });
  expect(page.url()).toBe(url);
  await expect(page.locator('#instruction')).toHaveValue('重启前的持久草稿');
  await expect(page.locator('.queue-item[data-status="queued"]')).toHaveCount(1);
  await page.locator('#instruction').fill('自动重连后的新草稿');
  await expect.poll(async () => (await app.state()).draft.text).toBe('自动重连后的新草稿');
  await page.getByRole('button', { name: 'Send request', exact: true }).click();
  await expect(page.locator('.queue-item[data-status="queued"]')).toHaveCount(2);
});

test('a different project on the same port keeps dirty content and blocks asset/session/draft writes', async ({ page, app }) => {
  await open(page, app);
  const sessionId = (await app.state()).session.id;
  const image = await png(page);
  let release!: () => void, entered!: () => void;
  const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
  const delayed = new Promise<void>(resolve => { release = resolve; });
  let assetWrites = 0, sessionWrites = 0, draftWrites = 0, failedAssetWrites = 0;
  const assetStatuses: number[] = [], successfulWrites: string[] = [];
  page.on('response', response => {
    const request = response.request();
    if (request.method() === 'POST' && request.url().includes('/api/assets?')) assetStatuses.push(response.status());
    if (['POST', 'PUT', 'DELETE'].includes(request.method()) && response.ok()) successfulWrites.push(request.url());
  });
  page.on('requestfailed', request => { if (request.method() === 'POST' && request.url().includes('/api/assets?')) failedAssetWrites++; });
  page.on('request', request => {
    if (request.method() === 'POST' && request.url().includes('/api/assets?')) assetWrites++;
    if (request.method() === 'POST' && request.url().endsWith('/api/sessions')) sessionWrites++;
    if (request.method() === 'PUT' && request.url().endsWith(`/api/sessions/${sessionId}/draft`)) draftWrites++;
  });
  await page.route(`**/api/sessions/${sessionId}/draft`, async route => { entered(); await delayed; await route.continue(); });
  await page.locator('#instruction').fill('旧项目尚未保存的完整输入'); await enteredPromise;
  const nextRoot = await app.replaceProject();
  await page.getByLabel('Import files into canvas', { exact: true }).setInputFiles(image);
  await expect(page.getByRole('alert')).toContainText('This address now serves another project');
  release();
  await expect(page.locator('#instruction')).toHaveValue('旧项目尚未保存的完整输入');
  await expect(page.locator('#instruction')).toHaveAttribute('readonly', '');
  await expect(page.getByRole('button', { name: 'Send request', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Reopen board', exact: true })).toBeVisible();
  expect(await app.call('/api/sessions')).toEqual([]);
  expect(await readdir(join(nextRoot, '.acanvas', 'assets'))).toEqual([]);
  expect(await readdir(join(nextRoot, '.acanvas', 'tmp'))).toEqual([]);
  expect(assetWrites).toBeLessThanOrEqual(1);
  await expect.poll(() => assetStatuses.length + failedAssetWrites).toBe(assetWrites);
  expect(assetStatuses.every(status => status >= 400)).toBeTruthy();
  expect(successfulWrites).toEqual([]);
  expect(sessionWrites).toBe(0); expect(draftWrites).toBe(1);
});

test('lost send responses query the persisted draft association and keep one task', async ({ page, app }) => {
  await open(page, app);
  const sessionId = (await app.state()).session.id;
  let handled!: () => void;
  const handledPromise = new Promise<void>(resolve => { handled = resolve; });
  await page.route(`**/api/sessions/${sessionId}/tasks`, async route => { await route.fetch(); await route.abort('failed'); handled(); });
  await page.locator('#instruction').fill('响应丢失仍保留的一次需求');
  await page.getByRole('button', { name: 'Send request', exact: true }).click(); await handledPromise;
  await expect(page.locator('.queue-item[data-status="queued"]')).toHaveCount(1);
  await expect(page.locator('#instruction')).toHaveValue('');
  await expect(page.locator('.error-banner')).toHaveCount(0);
  await page.unroute(`**/api/sessions/${sessionId}/tasks`);
  await page.locator('#instruction').fill('后续独立需求');
  await page.getByRole('button', { name: 'Send request', exact: true }).click();
  await expect(page.locator('.queue-item[data-status="queued"]')).toHaveCount(2);
  expect((await app.state()).tasks.map(task => task.snapshot.userRequest.text)).toEqual(['响应丢失仍保留的一次需求', '后续独立需求']);
});

test('queue accessible statuses and symmetric insets stay usable across viewport widths', async ({ page, browser, app }, info) => {
  await open(page, app); const image = await png(page);
  await page.getByLabel('Import files into canvas', { exact: true }).setInputFiles(['Cover study.png', 'Palette study.png', 'Light study.png', 'Texture study.png'].map(name => ({ ...image, name }))); await expect(page.locator('.board-object')).toHaveCount(4);
  for (const [index, object] of (await page.locator('.board-object').all()).entries()) { await object.focus(); await page.keyboard.press(index ? 'Shift+Enter' : 'Enter'); }
  await page.getByRole('button', { name: 'Attach to request', exact: true }).click(); await page.locator('#instruction').fill('Compose a quiet cover from these references.'); await page.locator('#instruction').press('Enter'); await expect(page.locator('.queue-item')).toHaveCount(1);
  await page.locator('#instruction').fill('Refine the title spacing and hierarchy.'); await page.locator('#instruction').press('Enter'); await expect(page.locator('.queue-item')).toHaveCount(2);
  const first = page.locator('.queue-item').first(), second = page.locator('.queue-item').nth(1), measurements: unknown[] = [];
  for (const row of [first, second]) { await expect(row.locator('.queue-task-mark')).toHaveCount(0); await expect(row.locator('.queue-row>.status-badge')).toHaveCount(0); await expect(row.locator('.queue-task')).toHaveAttribute('aria-label', /Queued$/); }
  await expect(first.locator('.queue-preview')).toHaveCount(3); await expect(first.locator('.queue-preview-overflow')).toHaveText('+1');
  for (const width of [320, 390, 560, 768, 1440]) {
    await page.setViewportSize({ width, height: width > 1000 ? 900 : 480 }); await page.locator('.queue-stack').hover();
    await expect.poll(async () => page.locator('.queue-stack').evaluate(element => { const queue = element.getBoundingClientRect(), form = document.querySelector('.composer')!.getBoundingClientRect(); return Math.abs(queue.x + queue.width / 2 - form.x - form.width / 2); })).toBeLessThan(.5);
    const measurement = await first.evaluate(element => { const queue = document.querySelector('.queue-list')!.getBoundingClientRect(), rail = document.querySelector('.canvas-toolbar')!.getBoundingClientRect(), title = element.querySelector('.queue-title')!.getBoundingClientRect(); return { viewport: innerWidth, queue: queue.toJSON(), rail: rail.toJSON(), titleWidth: title.width }; });
    expect(measurement.titleWidth).toBeGreaterThanOrEqual(width <= 360 ? 60 : 20); if (width <= 360) { await expect(first.locator('.queue-preview')).toHaveCount(1); await expect(first.locator('.queue-preview-overflow')).toHaveText('+3'); } else { await expect(first.locator('.queue-preview')).toHaveCount(3); await expect(first.locator('.queue-preview-overflow')).toHaveText('+1'); } expect(measurement.queue.x).toBeGreaterThanOrEqual(measurement.rail.x + measurement.rail.width + 8); measurements.push(measurement);
    expect(await first.locator('.queue-row').evaluate(element => element.getBoundingClientRect().height)).toBe(36);
    await first.locator('.queue-task').click(); await expect(first.locator('.queue-task')).toHaveAttribute('aria-expanded', 'true'); await first.locator('.queue-task').click(); await expect(first.locator('.queue-task')).toHaveAttribute('aria-expanded', 'false');
  }
  const state = await app.state(), session = state.session.id, claim = await app.call(`/api/sessions/${session}/claim`, 'POST', { consumerId: 'queue-status-fixture' }) as Claim;
  await expect(first).toHaveAttribute('data-status', 'running'); await expect(first.locator('.queue-task')).toHaveAttribute('aria-label', /Running$/); await expect(first.locator('.queue-task svg.lucide-loader-circle')).toHaveCount(0); await expect(first.getByRole('button', { name: 'Edit request 1', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Request history', exact: true }).click(); await expect(page.locator('.history-list .status-running')).toHaveText('Running'); await page.getByRole('button', { name: 'Close request history', exact: true }).click();
  await app.call(`/api/sessions/${session}/tasks/${claim.task!.id}/complete`, 'POST', { runId: claim.run!.id, consumerId: claim.consumerId, summary: 'Cover direction prepared.', assetIds: [], validation: [], operations: [] });
  const textClaim = await app.call(`/api/sessions/${session}/claim`, 'POST', { consumerId: claim.consumerId }) as Claim;
  await app.call(`/api/sessions/${session}/tasks/${textClaim.task!.id}/block`, 'POST', { runId: textClaim.run!.id, consumerId: textClaim.consumerId, reason: 'Choose the final title.' }); await expect(page.locator('.queue-row>.status-blocked')).toHaveText('Needs input');
  await page.screenshot({ path: info.outputPath('queue-status-centered-390.png') }); await writeFile(info.outputPath('queue-status-geometry.json'), JSON.stringify(measurements, null, 2));
  const context = await browser.newContext({ hasTouch: true, viewport: { width: 320, height: 480 } }); try { const touch = await context.newPage(); await touch.goto(page.url()); await expect(touch.locator('.queue-item')).toHaveCount(1); expect(await touch.locator('.queue-row').evaluate(element => element.getBoundingClientRect().height)).toBe(40); } finally { await context.close(); }
});

test('compact queue opens on hover with nonlinear motion and supports keyboard and touch access', async ({ page, browser, app }, info) => {
  await open(page, app);
  for (let index = 1; index <= 6; index++) { await page.locator('#instruction').fill(`Composition ${index}`); await page.locator('#instruction').press('Enter'); await expect(page.locator('.queue-item')).toHaveCount(index); await expect(page.locator('#instruction')).toBeEnabled(); }
  const toggle = page.locator('.queue-expand'); await page.locator('#whiteboard').click({ position: { x: 1100, y: 100 } }); await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect.poll(async () => page.locator('.queue-extra').first().evaluate(element => element.getBoundingClientRect().height)).toBe(0);
  await page.evaluate(() => { const motion: number[] = []; (window as any).hoverMotion = motion; const started = performance.now(); const sample = () => { motion.push(new DOMMatrix(getComputedStyle(document.querySelector('.queue-extra')!).transform).m42); if (performance.now() - started < 600) requestAnimationFrame(sample); }; requestAnimationFrame(sample); });
  await page.locator('.queue-stack').hover(); await expect(toggle).toHaveAttribute('aria-expanded', 'true'); await expect.poll(async () => page.locator('.queue-extra').last().evaluate(element => element.getBoundingClientRect().height)).toBeGreaterThan(30);
  await expect.poll(async () => page.evaluate(() => Math.min(...(window as any).hoverMotion))).toBeLessThan(0); await writeFile(info.outputPath('hover-motion.json'), JSON.stringify(await page.evaluate(() => (window as any).hoverMotion), null, 2));
  await page.locator('#instruction').hover(); await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await page.locator('#whiteboard').hover({ position: { x: 1100, y: 100 } }); await expect(toggle).toHaveAttribute('aria-expanded', 'false'); await expect.poll(async () => page.locator('.queue-extra').first().evaluate(element => element.getBoundingClientRect().height)).toBe(0);
  await toggle.focus(); await toggle.press('Enter'); await expect(toggle).toHaveAttribute('aria-expanded', 'true'); await expect(page.getByRole('button', { name: 'Cancel request 4', exact: true })).toBeInViewport();
  await toggle.press('Escape'); await expect(page.locator('#instruction')).toBeFocused(); await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await page.setViewportSize({ width: 390, height: 480 }); await page.screenshot({ path: info.outputPath('compact-queue-390.png') });
  const touchContext = await browser.newContext({ viewport: { width: 390, height: 480 }, hasTouch: true, isMobile: true });
  try { const touch = await touchContext.newPage(); await touch.goto(page.url()); await expect(touch.locator('.queue-extra').first()).toHaveAttribute('aria-hidden', 'true'); await touch.locator('.queue-expand').tap(); await expect(touch.locator('.queue-expand')).toHaveAttribute('aria-expanded', 'true'); await expect(touch.getByRole('button', { name: 'Cancel request 4', exact: true })).toBeInViewport(); expect(await touch.locator('.queue-row').first().evaluate(element => element.getBoundingClientRect().height)).toBe(40); await touch.locator('#whiteboard').tap({ position: { x: 250, y: 100 } }); await expect(touch.locator('.queue-expand')).toHaveAttribute('aria-expanded', 'false'); } finally { await touchContext.close(); }
});

test('spring queue and composer keep compact references, editable FIFO slots and balanced controls', async ({ page, app }, info) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' }); await open(page, app);
  const composer = page.locator('.composer'), input = page.locator('#instruction');
  const narrow = (await composer.boundingBox())!.width; await input.click(); await expect(composer).toHaveAttribute('data-compact', 'false');
  await expect.poll(async () => (await composer.boundingBox())!.width).toBeGreaterThan(narrow + 100);
  await input.fill('One line\nSecond line\nThird line');
  await expect.poll(async () => composer.evaluate(form => { const outer = form.getBoundingClientRect(), send = form.querySelector('.send-button')!.getBoundingClientRect(); return Math.abs((outer.right - send.right) - (outer.bottom - send.bottom)); })).toBeLessThan(.1);
  expect((await page.locator('.send-button').boundingBox())!.width).toBe(32);
  await input.fill(''); await page.locator('#whiteboard').click({ position: { x: 1000, y: 150 } }); await expect(composer).toHaveAttribute('data-compact', 'true');
  const springImage = await png(page); await page.getByLabel('Import files into canvas', { exact: true }).setInputFiles(['Cover.png', 'Palette.png'].map(name => ({ ...springImage, name })));
  await expect(page.locator('.board-object')).toHaveCount(2);
  const initial = await app.state(), objectA = initial.objects[0], objectB = initial.objects[1];
  let saved = await app.call(`/api/sessions/${initial.session.id}/draft`, 'PUT', { ...initial.draft, text: 'Create from each reference.', attachments: initial.assets.map(asset => asset.id), references: { objectIds: initial.objects.map(object => object.id), taskIds: [] }, annotations: [objectA, objectA, objectB].map((object, index) => ({ id: `spring-note-${index}`, scope: 'object', objectId: object.id, objectIds: [object.id], assetId: object.assetId, bounds: { x: 0, y: 0, width: 1, height: 1 }, coordinateSpace: 'normalized', text: `Comment ${index + 1}` })) });
  await app.call(`/api/sessions/${initial.session.id}/tasks`, 'POST', { draftId: saved.id, expectedRevision: saved.revision });
  for (const text of ['Second queued request', 'Third queued request']) { const state = await app.state(); saved = await app.call(`/api/sessions/${initial.session.id}/draft`, 'PUT', { ...state.draft, text }); await app.call(`/api/sessions/${initial.session.id}/tasks`, 'POST', { draftId: saved.id, expectedRevision: saved.revision }); }
  await page.reload(); await expect(page.locator('.queue-item')).toHaveCount(3); await expect(page.locator('.queue-stack')).not.toHaveClass(/expanded/);
  await input.fill(''); await page.locator('#whiteboard').click({ position: { x: 1000, y: 150 } }); await expect(composer).toHaveAttribute('data-compact', 'false'); expect((await composer.boundingBox())!.width).toBe(720);
  await expect.poll(async () => page.locator('.queue-extra').first().evaluate(element => element.getBoundingClientRect().height)).toBe(0);
  await page.locator('.queue-stack').hover(); await expect(page.locator('.queue-stack')).toHaveClass(/expanded/); await expect.poll(async () => page.locator('.queue-extra').first().evaluate(element => element.getBoundingClientRect().height)).toBeGreaterThan(30);
  await expect(page.locator('.queue-task-mark,.queue-task .lucide-circle,.queue-task .lucide-loader-circle')).toHaveCount(0); await expect(page.getByRole('button', { name: 'Collapse queue', exact: true })).toHaveCount(0);
  const first = page.locator('.queue-item').first(); await first.locator('.queue-task').click(); await expect(first.locator('.motion-disclosure')).toHaveAttribute('data-motion', 'open');
  await expect(first.locator('.task-instruction,.task-heading')).toHaveCount(0); await expect(first.locator('.task-reference-group[data-annotation-id]')).toHaveCount(3); await expect(first.locator(`[data-reference-item="${objectA.id}"]`)).toHaveCount(2); await expect(first.locator(`[data-reference-item="${objectB.id}"]`)).toHaveCount(1); await expect(first.locator('.task-item-annotation')).toHaveCount(3);
  expect(await first.getByRole('button', { name: 'Collapse request details', exact: true }).locator('svg').getAttribute('class')).toContain('chevron-down');
  await page.screenshot({ path: info.outputPath('spring-queue-wide.png') });
  await first.getByRole('button', { name: 'Collapse request details', exact: true }).click(); await expect(first.locator('.motion-disclosure')).toHaveAttribute('data-motion', 'closing'); await expect(first.locator('.motion-disclosure')).toHaveCount(0);
  const queued = await app.state(), ids = queued.tasks.map(task => task.id); saved = await app.call(`/api/sessions/${initial.session.id}/draft`, 'PUT', { ...queued.draft, text: 'Next unsent idea' }); await expect(input).toHaveValue('Next unsent idea');
  await page.getByRole('button', { name: 'Edit request 1', exact: true }).click(); await expect(input).toHaveValue('Create from each reference.'); await expect(page.locator('.draft-annotation')).toHaveCount(3); await expect(page.locator('.composer-editing')).toBeVisible();
  await input.fill('Revised request'); await expect(composer).toHaveAttribute('data-save-state', 'saved'); await page.reload(); await expect(input).toHaveValue('Revised request'); await expect(page.getByRole('button', { name: 'Cancel edit', exact: true })).toBeVisible();
  await page.locator('.annotation-content').first().click(); const annotationText = page.getByRole('textbox', { name: 'Annotation text', exact: true }); await annotationText.fill('Revised first comment'); await page.getByRole('button', { name: 'Close annotation', exact: true }).click();
  await page.route(`**/api/sessions/${initial.session.id}/tasks`, async route => { await route.fetch(); await route.abort('failed'); });
  await page.getByRole('button', { name: 'Save request', exact: true }).click(); await expect(input).toHaveValue('Next unsent idea'); await expect(page.getByRole('alert')).toHaveCount(0); await page.unroute(`**/api/sessions/${initial.session.id}/tasks`);
  const result = await app.state(); expect(result.tasks.map(task => task.id)).toEqual(ids); expect(result.tasks[0].snapshot.userRequest.text).toBe('Revised request'); expect(result.tasks[0].snapshot.annotations[0].text).toBe('Revised first comment'); expect(result.tasks[0].sequence).toBe(1);
  for (const width of [390, 320]) { await page.setViewportSize({ width, height: 480 }); await expect.poll(async () => page.locator('.dock-footer').evaluate(element => { const box = element.getBoundingClientRect(), button = element.querySelector('button')!.getBoundingClientRect(); return button.left - box.left; })).toBeLessThan(16); await page.locator('.queue-stack').hover(); await expect(page.getByRole('button', { name: 'Edit request 1', exact: true })).toBeInViewport(); await page.screenshot({ path: info.outputPath(`spring-queue-${width}.png`) }); }
  await page.getByRole('button', { name: 'Edit request 1', exact: true }).click(); await expect(input).toHaveValue('Revised request'); await input.fill('Discarded edit'); await page.getByRole('button', { name: 'Cancel edit', exact: true }).click(); await expect(input).toHaveValue('Next unsent idea'); expect((await app.state()).tasks[0].snapshot.userRequest.text).toBe('Revised request');
  await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'dark' }); await page.getByRole('button', { name: 'Switch to dark theme', exact: true }).click(); await first.locator('.queue-task').click(); await expect(first.locator('.motion-disclosure')).toHaveAttribute('data-motion', 'open'); expect(await first.locator('.motion-disclosure').evaluate(element => getComputedStyle(element).transitionDuration)).toBe('0s'); await first.getByRole('button', { name: 'Collapse request details', exact: true }).click(); await expect(first.locator('.motion-disclosure')).toHaveCount(0); await page.screenshot({ path: info.outputPath('spring-queue-dark-reduced.png') });
});

test('request details group each annotation once with all snapshot targets in one horizontal row', async ({ page, app }, info) => {
  await open(page, app);
  const image = await png(page);
  await page.getByLabel('Import files into canvas', { exact: true }).setInputFiles(Array.from({ length: 6 }, (_, index) => ({ ...image, name: `Reference ${index + 1}.png` })));
  await expect(page.locator('.board-object')).toHaveCount(6);
  const initial = await app.state(), objects = initial.objects;
  const annotations = [
    { id: 'group-three', scope: 'region', objectIds: objects.slice(0, 3).map(object => object.id), bounds: { x: 0, y: 0, width: 1200, height: 400 }, coordinateSpace: 'world', text: 'abc' },
    { id: 'group-one', scope: 'object', objectId: objects[3].id, objectIds: [objects[3].id], assetId: objects[3].assetId, bounds: { x: 0, y: 0, width: 1, height: 1 }, coordinateSpace: 'normalized', text: 'g' },
    { id: 'group-shared', scope: 'object', objectId: objects[0].id, objectIds: [objects[0].id], assetId: objects[0].assetId, bounds: { x: 0, y: 0, width: 1, height: 1 }, coordinateSpace: 'normalized', text: 'A separate comment on the first source' },
  ];
  const saved = await app.call(`/api/sessions/${initial.session.id}/draft`, 'PUT', { ...initial.draft, text: 'Study these references', attachments: initial.assets.map(asset => asset.id), references: { objectIds: objects.map(object => object.id), taskIds: [] }, annotations });
  const task = await app.call(`/api/sessions/${initial.session.id}/tasks`, 'POST', { draftId: saved.id, expectedRevision: saved.revision });
  await app.call('/api/board/operations', 'POST', { sessionId: initial.session.id, operations: [{ type: 'delete', objectId: objects[0].id, expectedVersion: objects[0].version }] });
  await page.reload();
  const composer = page.locator('.composer');
  await page.locator('#whiteboard').click({ position: { x: 1000, y: 150 } }); await expect(page.locator('#instruction')).toHaveValue(''); await expect(composer).toHaveAttribute('data-compact', 'false'); expect((await composer.boundingBox())!.width).toBe(720);
  await page.locator('.queue-task').click();
  const details = page.getByRole('region', { name: 'Request 1', exact: true }), groups = details.locator('.task-reference-group[data-annotation-id]');
  await expect(groups).toHaveCount(3); await expect(details.locator('.task-item-annotation')).toHaveCount(3);
  for (const [index, annotation] of annotations.entries()) {
    const group = groups.nth(index); await expect(group).toHaveAttribute('data-annotation-id', annotation.id); await expect(group.locator('.task-annotation-text>span')).toHaveText(annotation.text);
    expect(await group.locator('[data-reference-item]').evaluateAll(elements => elements.map(element => element.getAttribute('data-reference-item')))).toEqual(annotation.objectIds);
  }
  const loose = details.locator('[data-unannotated-attachments]'); await expect(loose).toHaveCount(1); await expect(loose.locator('[data-reference-item]')).toHaveCount(2); expect(await loose.locator('[data-reference-item]').evaluateAll(elements => elements.map(element => element.getAttribute('data-reference-item')))).toEqual(initial.assets.filter(asset => objects.slice(4).some(object => object.assetId === asset.id)).map(asset => asset.id));
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: width === 1440 ? 1000 : 480 });
    await expect(composer).toHaveAttribute('data-compact', 'false');
    const row = groups.first().locator('.task-reference-row');
    expect(await row.locator('[data-reference-item]').evaluateAll(elements => { const tops = elements.map(element => element.getBoundingClientRect().top); return Math.max(...tops) - Math.min(...tops); })).toBeLessThan(.1);
    if (width < 400) { expect(await row.evaluate(element => element.scrollWidth > element.clientWidth)).toBeTruthy(); await row.evaluate(element => { element.scrollLeft = element.scrollWidth; }); expect(await row.evaluate(element => element.scrollLeft)).toBeGreaterThan(0); }
    await page.screenshot({ path: info.outputPath(`annotation-groups-${width}.png`) });
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await groups.first().getByRole('button', { name: `View ${initial.assets.find(asset => asset.id === objects[0].assetId)!.name}`, exact: true }).click(); await expect(details.getByRole('region', { name: /^Preview Reference/ })).toBeVisible();
  expect((await app.state()).tasks[0].snapshot).toEqual(task.task.snapshot);
});

test('global notices stack at bottom right and remain reachable beside or above the dock', async ({ page, app }, info) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => undefined } });
    const Native = window.EventSource;
    (window as any).noticeEventSources = [];
    window.EventSource = class extends Native { constructor(url: string | URL, configuration?: EventSourceInit) { super(url, configuration); (window as any).noticeEventSources.push(this); } };
  });
  await open(page, app);
  const initial = await app.state();
  for (const text of ['Queued for notice checks', 'Second notice check', 'Third notice check']) { const current = await app.state(); const saved = await app.call(`/api/sessions/${initial.session.id}/draft`, 'PUT', { ...current.draft, text }); await app.call(`/api/sessions/${initial.session.id}/tasks`, 'POST', { draftId: saved.id, expectedRevision: saved.revision }); }
  await expect(page.locator('.queue-item')).toHaveCount(3);
  await page.route('**/api/sessions/*/tasks/*/edit', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'notice-test', message: 'Please retry this request.' } }) }));
  let releaseUpload!: () => void; const uploadHeld = new Promise<void>(resolve => { releaseUpload = resolve; });
  await page.route('**/api/assets?*', async route => { await uploadHeld; await route.abort('aborted'); });
  await page.getByLabel('Import files into canvas', { exact: true }).setInputFiles({ name: 'Notice upload.txt', mimeType: 'text/plain', buffer: Buffer.from('isolated notice test') });
  await expect(page.locator('.upload-list')).toBeVisible();
  await page.getByRole('button', { name: 'Edit request 1', exact: true }).click(); await expect(page.getByRole('alert')).toBeVisible();
  await page.route('**/api/bootstrap', route => route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }));
  await page.evaluate(() => { (window as any).noticeEventSources.at(-1).dispatchEvent(new Event('error')); });
  await expect(page.locator('.connection-feedback')).toBeVisible();
  const stack = page.getByRole('complementary', { name: 'Notifications', exact: true }), measurements: unknown[] = [];
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: width === 1440 ? 1000 : 480 }); await page.emulateMedia({ reducedMotion: width === 320 ? 'reduce' : 'no-preference' });
    if (width === 320) await page.getByRole('button', { name: 'Switch to dark theme', exact: true }).click();
    for (const expanded of [false, true]) {
      if (expanded) await page.locator('.queue-stack').hover(); else { await page.locator('#whiteboard').focus(); await page.mouse.move(width - 10, 80); await expect(page.locator('.queue-stack')).not.toHaveClass(/expanded/); }
      await page.getByRole('button', { name: 'Copy resume prompt', exact: true }).click(); await expect(stack.locator('.toast')).toBeVisible();
      await expect(stack.locator('.error-banner,.connection-feedback,.upload-list,.toast')).toHaveCount(4);
      const geometry = () => stack.evaluate(element => { const bounds = element.getBoundingClientRect(), controls = Array.from(document.querySelectorAll('.creation-dock,.queue-stack,.queue-expand')).map(control => control.getBoundingClientRect()); return { right: innerWidth - bounds.right, clear: controls.every(control => bounds.left >= control.right + 12 || bounds.right <= control.left - 12 || bounds.bottom <= control.top - 11.9), inViewport: bounds.top >= 15.9 && bounds.bottom <= innerHeight - 15.9 }; });
      await expect.poll(geometry).toEqual({ right: 16, clear: true, inViewport: true }); measurements.push({ width, expanded, ...await geometry() });
      if (width === 1440) expect(await stack.evaluate(element => innerHeight - element.getBoundingClientRect().bottom)).toBe(16);
      await page.screenshot({ path: info.outputPath(`notifications-${width}-${expanded ? 'expanded' : 'collapsed'}.png`) });
    }
  }
  await writeFile(info.outputPath('notification-geometry.json'), JSON.stringify(measurements, null, 2));
  const dismiss = page.getByRole('button', { name: 'Dismiss error', exact: true }); await dismiss.scrollIntoViewIfNeeded(); const dismissBounds = (await dismiss.boundingBox())!; await page.mouse.move(dismissBounds.x + dismissBounds.width / 2, dismissBounds.y + dismissBounds.height / 2); await page.waitForTimeout(250); expect(await dismiss.boundingBox()).toEqual(dismissBounds); await dismiss.click(); await expect(page.getByRole('alert')).toHaveCount(0);
  const cancel = page.getByRole('button', { name: 'Cancel import Notice upload.txt', exact: true }); await cancel.scrollIntoViewIfNeeded(); await cancel.click(); await expect(page.locator('.upload-list')).toHaveCount(0); releaseUpload();
  await page.unroute('**/api/bootstrap'); await expect(page.locator('.connection-feedback')).toHaveCount(0, { timeout: 15_000 });
  expect((await app.state()).tasks[0].status).toBe('queued'); expect((await app.state()).assets).toHaveLength(0);
});

test('four square file corners preserve opposite anchors and commit snapped resize previews', async ({ page, app }, info) => {
  await open(page, app); const resizeImage = await png(page); await page.getByLabel('Import files into canvas', { exact: true }).setInputFiles(['Resize.png', 'Target.png'].map(name => ({ ...resizeImage, name })));
  await expect(page.locator('.board-object')).toHaveCount(2); const initial = await app.state(), id = initial.objects[0].id, targetId = initial.objects[1].id;
  const place = async (zoom = 1) => { const state = await app.state(); await app.call('/api/board/operations', 'POST', { sessionId: state.session.id, operations: state.objects.map(object => ({ type: 'update', objectId: object.id, expectedVersion: object.version, changes: object.id === id ? { x: 400, y: 200, width: 200, height: 100 } : { x: 700, y: 350, width: 80, height: 80 } })) }); await app.call(`/api/sessions/${state.session.id}/view`, 'PUT', { x: zoom === 2 ? -500 : 0, y: zoom === 2 ? -160 : 0, zoom, selectedObjectIds: [id] }); await page.reload(); await expect(page.locator(`[data-object-id="${id}"] .resize-handle`)).toHaveCount(4); };
  await place(); const object = page.locator(`[data-object-id="${id}"]`); expect(await object.evaluate(element => getComputedStyle(element).borderRadius)).toBe('0px');
  for (const corner of ['nw', 'ne', 'sw', 'se']) { await place(); const box = (await object.locator(`[data-resize-corner="${corner}"]`).boundingBox())!; const signX = corner.endsWith('w') ? -1 : 1, signY = corner.startsWith('n') ? -1 : 1; await page.keyboard.down('Alt'); await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down(); await page.mouse.move(box.x + box.width / 2 + signX * 40, box.y + box.height / 2 + signY * 20, { steps: 4 }); await page.mouse.up(); await page.keyboard.up('Alt'); await expect.poll(async () => (await app.state()).objects.find(value => value.id === id)!.width).toBeCloseTo(240, 3); const result = (await app.state()).objects.find(value => value.id === id)!; expect(result.width / result.height).toBe(2); expect(corner.endsWith('w') ? result.x + result.width : result.x).toBe(corner.endsWith('w') ? 600 : 400); expect(corner.startsWith('n') ? result.y + result.height : result.y).toBe(corner.startsWith('n') ? 300 : 200); }
  for (const zoom of [1, 2]) { await place(zoom); const handle = (await object.locator('[data-resize-corner="se"]').boundingBox())!, start = { x: handle.x + handle.width / 2, y: handle.y + handle.height / 2 }; await page.mouse.move(start.x, start.y); await page.mouse.down(); await page.mouse.move(start.x + 97 * zoom, start.y + 48.5 * zoom, { steps: 4 }); await expect(page.locator('[data-snap-axis="x"]')).toHaveAttribute('x1', '700'); await expect(page.locator('[data-snap-axis="y"]')).toHaveAttribute('y1', '350'); const preview = await object.evaluate(element => ({ width: parseFloat((element as HTMLElement).style.width), height: parseFloat((element as HTMLElement).style.height) })); expect(preview).toEqual({ width: 300, height: 150 }); await page.screenshot({ path: info.outputPath(`resize-snap-${zoom}x.png`) }); await page.mouse.up(); await expect.poll(async () => (await app.state()).objects.find(value => value.id === id)!.width).toBe(300); }
  await page.reload(); await expect.poll(async () => object.evaluate(element => parseFloat((element as HTMLElement).style.width))).toBe(300); expect((await app.state()).objects.find(value => value.id === targetId)!.width).toBe(80);
});

test('explicit draft conflict choices adopt the current editing scope in both directions', async ({ page, app }) => {
  await open(page, app); const input = page.locator('#instruction'); await input.fill('Queued original'); await input.press('Enter'); await expect(page.locator('.queue-item')).toHaveCount(1);
  const first = await app.state(), sessionId = first.session.id, task = first.tasks[0];
  const conflict = page.getByRole('region', { name: 'Resolve draft update', exact: true });
  for (const entering of [true, false]) {
    let release!: () => void, entered!: () => void; const enteredPromise = new Promise<void>(resolve => { entered = resolve; }), delayed = new Promise<void>(resolve => { release = resolve; });
    await page.route(`**/api/sessions/${sessionId}/draft`, async route => { entered(); await delayed; await route.continue(); });
    const localText = entering ? 'Local ordinary draft' : 'Local editing draft'; await input.fill(localText); await enteredPromise;
    const current = await app.state(); await app.call(`/api/sessions/${sessionId}/tasks/${task.id}/${entering ? 'edit' : 'cancel-edit'}`, 'POST', { draftId: current.draft.id, expectedRevision: current.draft.revision });
    await expect(conflict).toBeVisible(); await expect(input).toHaveValue(localText); release();
    await page.getByRole('button', { name: 'Keep your draft', exact: true }).click(); await expect(conflict).not.toBeVisible(); await expect(page.locator('.composer')).toHaveAttribute('data-save-state', 'saved');
    const result = await app.state(); expect(result.draft.text).toBe(localText); expect(result.draft.editingTaskId).toBe(entering ? task.id : undefined); expect(result.tasks[0].snapshot.userRequest.text).toBe('Queued original'); await expect(page.getByRole('alert')).toHaveCount(0);
    await page.unroute(`**/api/sessions/${sessionId}/draft`);
  }
});

test('editing one removed source attachment preserves the other original object reference', async ({ page, app }) => {
  await open(page, app); await page.getByLabel('Import files into canvas', { exact: true }).setInputFiles(['A.txt', 'B.txt'].map(name => ({ name, mimeType: 'text/plain', buffer: Buffer.from(`Reference ${name}`) }))); await expect(page.locator('.board-object')).toHaveCount(2);
  const initial = await app.state(), sessionId = initial.session.id, sourceA = initial.objects.find(object => initial.assets.find(asset => asset.id === object.assetId)?.name === 'A.txt')!, sourceB = initial.objects.find(object => initial.assets.find(asset => asset.id === object.assetId)?.name === 'B.txt')!;
  const saved = await app.call(`/api/sessions/${sessionId}/draft`, 'PUT', { ...initial.draft, text: 'Use these sources', attachments: initial.assets.map(asset => asset.id), references: { objectIds: [sourceA.id, sourceB.id], taskIds: [] } });
  await app.call(`/api/sessions/${sessionId}/tasks`, 'POST', { draftId: saved.id, expectedRevision: saved.revision });
  await app.call('/api/board/operations', 'POST', { sessionId, operations: initial.objects.map(object => ({ type: 'delete', objectId: object.id, expectedVersion: object.version })) }); await expect(page.locator('.board-object')).toHaveCount(0);
  await page.getByRole('button', { name: 'Edit request 1', exact: true }).click(); await expect(page.locator('#instruction')).toHaveValue('Use these sources'); await page.getByRole('button', { name: 'Remove attachment A.txt', exact: true }).click(); await page.getByRole('button', { name: 'Save request', exact: true }).click(); await expect(page.locator('.composer-editing')).toHaveCount(0);
  const task = (await app.state()).tasks[0]; expect(task.snapshot.referenceContent.objects).toEqual([sourceB]); expect(task.snapshot.referenceContent.assets.map(asset => asset.id)).toEqual([sourceB.assetId]);
});
