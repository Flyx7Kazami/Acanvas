import { test as base, expect, type Page, type Locator } from '@playwright/test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import type { AnnotationInput, BoardObject, BoardState, Claim, Task } from '../src/shared/types.js';

const runtime = resolve('.runtime/node_modules/node/bin/node');
type App = {
  url: string;
  call: <T = any>(path: string, method?: string, body?: unknown) => Promise<T>;
  state: () => Promise<BoardState>;
};

const test = base.extend<{ app: App }>({
  app: async ({}, use) => {
    const root = await mkdtemp(join(tmpdir(), 'acanvas-annotation-project-'));
    const child = spawn(runtime, [resolve('dist/src/server/main.js'), '--project', root, '--port', '0'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', errors = '';
    child.stderr.on('data', chunk => { errors += chunk.toString(); });
    const url = await new Promise<string>((ready, reject) => {
      const timer = setTimeout(() => reject(new Error('The isolated annotation service did not start.')), 10_000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', (code, signal) => { clearTimeout(timer); reject(new Error(`Service exited during startup: ${code}/${signal}`)); });
      child.stdout.on('data', chunk => {
        output += chunk.toString();
        const address = output.match(/acanvas: (http:\/\/127\.0\.0\.1:\d+)/)?.[1];
        if (address) { clearTimeout(timer); ready(address); }
      });
    });
    const token = (await (await fetch(`${url}/api/bootstrap`)).json()).token;
    const call: App['call'] = async (path, method = 'GET', body) => {
      const response = await fetch(`${url}${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      expect(response.ok, `API ${method} ${path}`).toBeTruthy();
      return response.json();
    };
    const state = async () => call<BoardState>(`/api/state?sessionId=${(await call('/api/sessions'))[0].id}`);
    try { await use({ url, call, state }); }
    finally {
      if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited; }
      expect(child.signalCode, errors).toBeNull(); expect(child.exitCode, errors).toBe(0);
      expect(errors).not.toContain('Assertion failed');
      await rm(root, { recursive: true, force: true });
    }
  },
});

async function open(page: Page, app: App) {
  await page.goto(app.url);
  await expect(page.locator('#whiteboard')).toBeVisible();
  await expect(page.locator('.composer')).toHaveAttribute('data-save-state', 'saved');
}

async function image(page: Page, name = 'Annotation source.png') {
  const encoded = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 600; canvas.height = 300;
    const context = canvas.getContext('2d')!;
    context.fillStyle = '#e2e2e0'; context.fillRect(0, 0, 600, 300);
    context.fillStyle = '#252525'; context.fillRect(100, 50, 400, 200);
    return canvas.toDataURL('image/png').split(',')[1];
  });
  return { name, mimeType: 'image/png', buffer: Buffer.from(encoded, 'base64') };
}

async function importImages(page: Page, app: App, count = 1) {
  const file = await image(page);
  await page.getByLabel('Import files into canvas', { exact: true }).setInputFiles(Array.from({ length: count }, (_, index) => ({ ...file, name: `Source ${index + 1}.png` })));
  await expect(page.locator('.board-object')).toHaveCount(count);
  const state = await app.state();
  await app.call('/api/board/operations', 'POST', {
    sessionId: state.session.id,
    operations: state.objects.map((object, index) => ({ type: 'update', objectId: object.id, expectedVersion: object.version, changes: { x: 400 + index * 330, y: 330, width: 300, height: 150 } })),
  });
  await app.call(`/api/sessions/${state.session.id}/view`, 'PUT', { x: 0, y: 0, zoom: 1, selectedObjectIds: [] });
  await page.reload();
  return (await app.state()).objects;
}

function annotation(object: BoardObject, id: string, text: string): AnnotationInput {
  return { id, scope: 'object', objectId: object.id, objectIds: [object.id], assetId: object.assetId, coordinateSpace: 'normalized', bounds: { x: 0, y: 0, width: 1, height: 1 }, text };
}

async function seedDraft(app: App, annotations: AnnotationInput[], text = '') {
  const state = await app.state();
  return app.call(`/api/sessions/${state.session.id}/draft`, 'PUT', { ...state.draft, text, annotations });
}

async function submitDraft(app: App): Promise<Task> {
  const { session, draft } = await app.state();
  return (await app.call(`/api/sessions/${session.id}/tasks`, 'POST', { draftId: draft.id, expectedRevision: draft.revision })).task;
}

const full = (page: Page) => page.getByRole('region', { name: 'Annotation', exact: true });
const group = (page: Page, id: string) => page.locator(`.canvas-annotation-group[data-annotation-id="${id}"]`);
const editInput = (page: Page) => page.getByRole('textbox', { name: 'Annotation text', exact: true });
const saveEdit = (page: Page) => page.getByRole('button', { name: 'Save edit', exact: true });

async function select(page: Page, object: BoardObject) {
  await page.locator(`[data-object-id="${object.id}"]`).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: 'Annotate', exact: true })).toBeVisible();
}

async function chooseVideoPoint(page: Page, seconds: number) {
  await expect(page.locator('.annotation-time-range')).toHaveAttribute('data-ready', 'true');
  const duration = await page.locator('.object-video video').evaluate(element => (element as HTMLVideoElement).duration);
  const track = (await page.locator('.annotation-range-track').boundingBox())!;
  await page.mouse.click(track.x + track.width * seconds / duration, track.y + track.height / 2);
}

async function appearance(locator: Locator) {
  return locator.evaluate(element => {
    const style = getComputedStyle(element);
    return { background: style.backgroundColor, border: style.border, shadow: style.boxShadow, outline: style.outlineStyle === 'none' ? 'none' : style.outline };
  });
}

async function settleNote(locator: Locator) {
  await locator.evaluate(async element => { await Promise.all(element.getAnimations({ subtree: true }).map(animation => animation.finished.catch(() => {}))); });
}

test('draft comments autosave, restore and share one editor across numbered canvas and composer entries', async ({ page, app }) => {
  await open(page, app); const [object] = await importImages(page, app);
  await select(page, object);
  const bubble = await page.getByRole('button', { name: 'Annotate', exact: true }).locator('.annotation-bubble path').getAttribute('d');
  await page.getByRole('button', { name: 'Annotate', exact: true }).click();
  const input = page.getByRole('textbox', { name: 'Add a comment', exact: true });
  await expect(input).toBeFocused(); await expect(page.locator('.annotation-full')).toHaveCount(1);
  const originalInput = await input.elementHandle();
  await input.fill('Keep the quiet light.');
  await expect.poll(async () => (await app.state()).draft.annotations.map(value => value.text)).toEqual(['Keep the quiet light.']);
  expect(await originalInput!.evaluate(element => element.isConnected && document.activeElement === element)).toBeTruthy();
  const id = (await app.state()).draft.annotations[0].id;
  await expect(full(page)).toHaveAttribute('data-annotation-id', id); await expect(full(page)).toHaveAttribute('data-comment-mode', 'edit');
  await input.evaluate(element => {
    element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, isComposing: true, bubbles: true, cancelable: true }));
    element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true, cancelable: true }));
  });
  await expect(input).toHaveCount(1); await expect(input).toHaveValue('Keep the quiet light.');
  await input.evaluate(element => {
    element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
    element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 229, ctrlKey: true, bubbles: true, cancelable: true }));
  });
  await expect(input).toHaveCount(1);
  await input.press('End'); await input.press('Enter'); await input.pressSequentially('Preserve the palette.');
  await expect(input).toHaveValue('Keep the quiet light.\nPreserve the palette.');
  await input.press('Control+Enter'); await expect(page.locator('.annotation-full')).toHaveCount(0);
  await expect.poll(async () => (await app.state()).draft.annotations[0].text).toBe('Keep the quiet light.\nPreserve the palette.');
  const summary = group(page, id).locator('.canvas-annotation-summary'), pin = group(page, id).locator('.annotation-pin');
  await expect(summary).toHaveCount(1); await expect(summary.locator('textarea')).toHaveCount(0);
  await expect(summary).toHaveCSS('white-space', 'nowrap');
  expect(await pin.locator('.annotation-bubble path').getAttribute('d')).toBe(bubble);
  await expect(pin.locator('.annotation-bubble')).toHaveAttribute('data-numbered', 'true'); await expect(pin.locator('text')).toHaveText('1');
  const camera = await page.locator('.canvas-world').getAttribute('style');
  await pin.click(); await expect(editInput(page)).toBeFocused(); await expect(full(page)).toHaveAttribute('data-annotation-id', id);
  expect(await page.locator('.canvas-world').getAttribute('style')).toBe(camera);
  await editInput(page).press('Escape'); await expect(pin).toBeFocused();
  await page.reload();
  const chip = page.locator('.annotation-content').first(); await expect(chip).toContainText('Keep the quiet light.');
  await chip.click(); await expect(editInput(page)).toHaveValue('Keep the quiet light.\nPreserve the palette.');
  await expect(full(page)).toHaveAttribute('data-annotation-id', id); await expect(page.locator('.annotation-full')).toHaveCount(1);
  await page.getByRole('button', { name: 'Done', exact: true }).click(); await expect(chip).toBeFocused();
  await summary.click(); await expect(full(page)).toHaveAttribute('data-annotation-id', id); await editInput(page).press('Meta+Enter');
  await expect(page.locator('#instruction')).toBeFocused();
  expect((await app.state()).draft.annotations).toHaveLength(1); expect((await app.state()).tasks).toHaveLength(0);
  await select(page, object); await page.getByRole('button', { name: 'Annotate', exact: true }).click();
  await page.getByRole('textbox', { name: 'Add a comment', exact: true }).press('Escape');
  expect((await app.state()).draft.annotations.map(value => value.id)).toEqual([id]);
});

test('main Send captures the latest active video comment after asynchronous frame preparation', async ({ page, app }) => {
  await open(page, app);
  await page.getByLabel('Import files into canvas', { exact: true }).setInputFiles(resolve('tests/fixtures/frontend-video.mp4'));
  const video = page.locator('.object-video video'); await expect(video).toHaveJSProperty('videoWidth', 320);
  await expect.poll(async () => video.evaluate(element => (element as HTMLVideoElement).readyState)).toBeGreaterThanOrEqual(2);
  const object = (await app.state()).objects[0]; await select(page, object);
  await video.evaluate(element => { (element as HTMLVideoElement).currentTime = .7; });
  await expect(video).toHaveJSProperty('currentTime', .7);
  await page.evaluate(() => {
    const callbacks: (() => void)[] = [], original = HTMLCanvasElement.prototype.toBlob;
    (window as any).annotationCapture = { callbacks, release: () => callbacks.splice(0).forEach(callback => callback()) };
    HTMLCanvasElement.prototype.toBlob = function(callback, type, quality) {
      original.call(this, blob => callbacks.push(() => callback(blob)), type, quality);
    };
  });
  await page.getByRole('button', { name: 'Annotate', exact: true }).click();
  await chooseVideoPoint(page, .7);
  const input = page.getByRole('textbox', { name: 'Add a comment', exact: true });
  await input.fill('Keep the first idea.'); await expect(page.locator('.annotation-range-times')).toContainText('0:00');
  const endPoint = page.getByRole('slider', { name: 'End point' }); await endPoint.focus(); for (let index = 0; index < 5; index++) await endPoint.press('ArrowRight');
  await input.fill('Keep the final video moment.\nRetain the soft colors.');
  const send = page.getByRole('button', { name: 'Send request', exact: true }).click();
  await expect.poll(async () => page.evaluate(() => (window as any).annotationCapture.callbacks.length)).toBeGreaterThan(0);
  expect((await app.state()).tasks).toHaveLength(0);
  await page.evaluate(() => (window as any).annotationCapture.release()); await send;
  await expect(page.locator('.queue-item')).toHaveCount(1);
  const state = await app.state(), saved = state.tasks[0].snapshot.annotations;
  expect(saved).toHaveLength(1); expect(saved[0].text).toBe('Keep the final video moment.\nRetain the soft colors.');
  expect(saved[0].timeStart).toBeCloseTo(.7, 4); expect(saved[0].timeEnd).toBe(1.2);
  expect(state.assets.find(asset => asset.id === saved[0].snapshotAssetId)?.kind).toBe('image');
  expect(state.tasks[0].snapshot.referenceContent.assets.map(asset => asset.id)).toContain(saved[0].snapshotAssetId);
  await expect(page.locator('.annotation-full')).toHaveCount(0); await expect(page.locator('.annotation-content')).toHaveCount(0);
  expect(state.draft.annotations).toEqual([]); expect(state.tasks[0].snapshot.userRequest.text).toBe('');
});

test('video range selection keeps playback position and replaces its representative frame', async ({ page, app }, info) => {
  await open(page, app);
  await page.getByLabel('Import files into canvas', { exact: true }).setInputFiles(resolve('tests/fixtures/frontend-video.mp4'));
  const video = page.locator('.object-video video'); await expect(video).toHaveJSProperty('videoWidth', 320);
  const object = (await app.state()).objects[0]; await select(page, object);
  await video.evaluate(element => { (element as HTMLVideoElement).currentTime = .3; });
  await expect.poll(() => video.evaluate(element => (element as HTMLVideoElement).readyState)).toBeGreaterThanOrEqual(2);
  await page.getByRole('button', { name: 'Annotate', exact: true }).click();
  await expect(page.getByRole('slider', { name: 'Start point' })).toHaveAttribute('aria-valuenow', '0');
  await expect(page.getByRole('slider', { name: 'End point' })).toHaveAttribute('aria-valuenow', String(await video.evaluate(element => (element as HTMLVideoElement).duration)));
  await page.getByRole('textbox', { name: 'Add a comment', exact: true }).fill('Use this moving interval.');
  await expect.poll(async () => (await app.state()).draft.annotations[0]?.timeStart).toBe(0);
  await expect.poll(async () => (await app.state()).draft.annotations[0]?.timeEnd).toBeGreaterThan(1);
  await expect(page.locator('.annotation-time-range')).toHaveAttribute('data-ready', 'true');
  await expect.poll(async () => (await app.state()).draft.annotations[0]?.snapshotAssetId).toBeTruthy();
  const originalFrame = (await app.state()).draft.annotations[0].snapshotAssetId;
  await expect.poll(() => page.locator('.annotation-range-frame').evaluateAll(elements => elements.filter(element => (element as HTMLElement).style.backgroundImage.includes('blob:')).length)).toBeGreaterThanOrEqual(2);
  const track = page.locator('.annotation-range-track'), box = (await track.boundingBox())!;
  await page.mouse.move(box.x + box.width * .25, box.y + box.height / 2); await page.mouse.down();
  await page.mouse.move(box.x + box.width * .75, box.y + box.height / 2, { steps: 6 }); await page.mouse.up();
  await expect.poll(async () => (await app.state()).draft.annotations[0]?.timeStart).toBeGreaterThan(.3);
  await expect.poll(async () => (await app.state()).draft.annotations[0]?.timeEnd).toBeGreaterThan(1);
  await expect.poll(async () => (await app.state()).draft.annotations[0]?.snapshotAssetId).not.toBe(originalFrame);
  await expect.poll(async () => (await app.state()).draft.annotations[0]?.snapshotAssetId).toBeTruthy();
  expect(await video.evaluate(element => (element as HTMLVideoElement).currentTime)).toBeCloseTo(.3, 1);
  await page.getByRole('button', { name: 'Play range preview' }).click();
  await expect.poll(() => video.evaluate(element => !(element as HTMLVideoElement).paused)).toBeTruthy();
  await expect.poll(() => video.evaluate(element => (element as HTMLVideoElement).paused), { timeout: 5000 }).toBeTruthy();
  expect(await video.evaluate(element => (element as HTMLVideoElement).currentTime)).toBeCloseTo((await app.state()).draft.annotations[0].timeEnd!, 1);
  const lightShot = info.outputPath('video-range-light.png'); await page.locator('.annotation-full').screenshot({ path: lightShot }); console.log(`MEDIA_RANGE_SHOT ${lightShot}`);
  await page.getByRole('button', { name: 'Switch to dark theme' }).click(); const darkShot = info.outputPath('video-range-dark.png'); await page.locator('.annotation-full').screenshot({ path: darkShot }); console.log(`MEDIA_RANGE_SHOT ${darkShot}`);
  await page.getByRole('slider', { name: 'Start point' }).focus(); await page.getByRole('slider', { name: 'Start point' }).press('ArrowRight');
  await expect.poll(async () => (await app.state()).draft.annotations[0]?.snapshotAssetId).toBeTruthy();
  await page.getByRole('button', { name: 'Send request', exact: true }).click();
  await expect.poll(async () => (await app.state()).tasks.length).toBe(1);
  const saved = (await app.state()).tasks[0].snapshot.annotations[0];
  expect(saved.timeStart).toBeGreaterThan(.4); expect(saved.timeEnd).toBeGreaterThan(saved.timeStart!); expect(saved.snapshotAssetId).toBeTruthy(); expect(saved.snapshotAssetId).not.toBe(originalFrame);
  await select(page, object); await page.getByRole('button', { name: 'Annotate', exact: true }).click();
  await expect(page.getByRole('slider', { name: 'Start point' })).toHaveAttribute('aria-valuenow', '0');
  await expect(page.getByRole('slider', { name: 'End point' })).toHaveAttribute('aria-valuenow', String(await video.evaluate(element => (element as HTMLVideoElement).duration)));
});

test('a superseded video frame upload cannot attach to the next start point', async ({ page, app }) => {
  await open(page, app);
  await page.getByLabel('Import files into canvas', { exact: true }).setInputFiles(resolve('tests/fixtures/frontend-video.mp4'));
  const video = page.locator('.object-video video'); await expect(video).toHaveJSProperty('videoWidth', 320);
  await select(page, (await app.state()).objects[0]); await video.evaluate(element => { (element as HTMLVideoElement).currentTime = .3; });
  await expect.poll(() => video.evaluate(element => (element as HTMLVideoElement).readyState)).toBeGreaterThanOrEqual(2);
  await page.getByRole('button', { name: 'Annotate', exact: true }).click(); await page.getByRole('textbox', { name: 'Add a comment' }).fill('Use the later frame.');
  await expect.poll(async () => (await app.state()).draft.annotations[0]?.snapshotAssetId).toBeTruthy();
  let release!: () => void, entered!: () => void, staleId = '', uploads = 0;
  const gate = new Promise<void>(resolve => { release = resolve; }), first = new Promise<void>(resolve => { entered = resolve; });
  await page.route('**/api/assets?*', async route => {
    const name = new URL(route.request().url()).searchParams.get('name');
    if (route.request().method() !== 'POST' || !name?.startsWith('video-frame-') || ++uploads !== 1) { await route.continue(); return; }
    const response = await route.fetch(); staleId = (await response.json()).id; entered(); await gate; await route.fulfill({ response });
  });
  try {
    const track = (await page.locator('.annotation-range-track').boundingBox())!;
    await page.mouse.move(track.x + track.width * .25, track.y + track.height / 2); await page.mouse.down(); await page.mouse.move(track.x + track.width * .7, track.y + track.height / 2, { steps: 4 }); await page.mouse.up();
    await first;
    const start = page.getByRole('slider', { name: 'Start point' }); await start.focus(); await start.press('ArrowRight');
    await expect.poll(async () => (await app.state()).draft.annotations[0]?.snapshotAssetId).toBeUndefined();
    release();
    await expect.poll(async () => (await app.state()).draft.annotations[0]?.snapshotAssetId).toBeTruthy();
    const current = (await app.state()).draft.annotations[0]; expect(current.snapshotAssetId).not.toBe(staleId); expect(uploads).toBeGreaterThanOrEqual(2);
    await page.getByRole('button', { name: 'Send request', exact: true }).click(); await expect.poll(async () => (await app.state()).tasks.length).toBe(1);
    const saved = (await app.state()).tasks[0].snapshot.annotations[0]; expect(saved.timeStart).toBeCloseTo(current.timeStart!, 2); expect(saved.snapshotAssetId).toBe(current.snapshotAssetId);
  } finally { release(); await page.unroute('**/api/assets?*'); }
});

test('removing an active new video comment preserves selection and late frame completion stays with its original identity', async ({ page, app }) => {
  await open(page, app);
  await page.getByLabel('Import files into canvas', { exact: true }).setInputFiles(resolve('tests/fixtures/frontend-video.mp4'));
  const video = page.locator('.object-video video'); await expect(video).toHaveJSProperty('videoWidth', 320);
  const object = (await app.state()).objects[0]; await select(page, object);
  await expect.poll(async () => (await app.state()).session.view.selectedObjectIds).toEqual([object.id]);
  await video.evaluate(element => { (element as HTMLVideoElement).currentTime = .7; });
  await expect(video).toHaveJSProperty('currentTime', .7);
  await expect.poll(async () => video.evaluate(element => (element as HTMLVideoElement).readyState)).toBeGreaterThanOrEqual(2);
  await page.evaluate(() => {
    const original = HTMLCanvasElement.prototype.toBlob; let calls = 0, release: (() => void) | undefined;
    (window as any).removedAnnotationCapture = { ready: false, release: () => release?.() };
    HTMLCanvasElement.prototype.toBlob = function(callback, type, quality) {
      if (++calls !== 1) { original.call(this, callback, type, quality); return; }
      original.call(this, blob => {
        release = () => callback(blob); (window as any).removedAnnotationCapture.ready = true;
      }, type, quality);
    };
  });
  let releaseUpload!: () => void, uploadEntered!: () => void, oldAssetId = '', uploads = 0;
  const uploadGate = new Promise<void>(resolveGate => { releaseUpload = resolveGate; });
  const firstUpload = new Promise<void>(resolveStarted => { uploadEntered = resolveStarted; });
  await page.route('**/api/assets?*', async route => {
    const name = new URL(route.request().url()).searchParams.get('name');
    if (route.request().method() !== 'POST' || !name?.startsWith('video-frame-') || ++uploads !== 1) { await route.continue(); return; }
    const response = await route.fetch(); oldAssetId = (await response.json()).id; uploadEntered();
    await uploadGate; await route.fulfill({ response });
  });
  try {
    const annotate = page.getByRole('button', { name: 'Annotate', exact: true });
    await annotate.click();
    const oldId = (await full(page).getAttribute('data-annotation-id'))!;
    await page.getByRole('textbox', { name: 'Add a comment', exact: true }).fill('The removed video comment.');
    await expect.poll(async () => (await app.state()).draft.annotations.map(value => value.id)).toEqual([oldId]);
    await expect.poll(async () => page.evaluate(() => (window as any).removedAnnotationCapture.ready)).toBeTruthy();
    await page.evaluate(() => (window as any).removedAnnotationCapture.release()); await firstUpload;
    const selectedView = (await app.state()).session.view;
    await page.getByRole('button', { name: 'Remove annotation 1', exact: true }).click();
    expect(await page.locator('.annotation-full,.canvas-annotation-group,.annotation-outline').count()).toBe(0);
    expect(await annotate.isVisible()).toBeTruthy(); expect(await annotate.isEnabled()).toBeTruthy();
    await expect(page.locator(`[data-object-id="${object.id}"]`)).toHaveAttribute('data-selected', 'true');
    await expect.poll(async () => (await app.state()).draft.annotations).toEqual([]);
    expect((await app.state()).session.view).toEqual(selectedView); expect((await app.state()).objects).toEqual([object]);
    await video.evaluate(element => { (element as HTMLVideoElement).currentTime = 1.4; });
    await expect(video).toHaveJSProperty('currentTime', 1.4);
    await expect.poll(async () => video.evaluate(element => (element as HTMLVideoElement).readyState)).toBeGreaterThanOrEqual(2);
    await annotate.click();
    const currentId = (await full(page).getAttribute('data-annotation-id'))!; expect(currentId).not.toBe(oldId);
    await chooseVideoPoint(page, 1.4);
    const currentText = 'Keep the current video moment and its soft light.';
    await page.getByRole('textbox', { name: 'Add a comment', exact: true }).fill(currentText);
    await page.getByRole('button', { name: 'Send request', exact: true }).click(); await expect(page.locator('.queue-item')).toHaveCount(1);
    const sent = await app.state(), snapshot = sent.tasks[0].snapshot;
    expect(snapshot.annotations.map(value => [value.id, value.text])).toEqual([[currentId, currentText]]);
    expect(snapshot.annotations[0].timeStart).toBeCloseTo(1.4, 4); expect(snapshot.annotations[0].snapshotAssetId).not.toBe(oldAssetId);
    expect(snapshot.referenceContent.assets.map(asset => asset.id)).not.toContain(oldAssetId);
    expect(sent.annotations.map(value => [value.text, value.timeStart, value.sourceTaskId])).toEqual([[currentText, snapshot.annotations[0].timeStart, sent.tasks[0].id]]);
    expect(sent.draft.annotations).toEqual([]);
    const oldResponse = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).searchParams.get('name')?.startsWith('video-frame-') === true);
    releaseUpload(); await (await oldResponse).finished();
    await page.evaluate(() => new Promise<void>(resolveFrame => requestAnimationFrame(() => requestAnimationFrame(() => resolveFrame()))));
    const completed = await app.state();
    expect(completed.tasks).toHaveLength(1); expect(completed.tasks[0].snapshot).toEqual(snapshot);
    expect(completed.draft.annotations).toEqual([]); expect(completed.annotations).toEqual(sent.annotations);
    expect(completed.session.view.selectedObjectIds).toEqual([object.id]);
    await expect(page.locator('.annotation-full,.canvas-annotation-group,.annotation-outline')).toHaveCount(0);
  } finally { releaseUpload(); await page.unrouteAll({ behavior: 'wait' }); }
});

test('TaskEdit autosaves its comments while Save edit and Cancel edit preserve task order and the ordinary draft', async ({ page, app }) => {
  await open(page, app); const objects = await importImages(page, app, 2);
  const annotations = objects.map((object, index) => annotation(object, `task-note-${index}`, `Original comment ${index + 1}`));
  annotations.push(annotation(objects[0], 'task-note-2', 'Original comment 3'));
  await seedDraft(app, annotations, 'First request'); const original = await submitDraft(app);
  await seedDraft(app, [], 'Second request'); const second = await submitDraft(app);
  const ordinaryAnnotation = annotation(objects[0], 'ordinary-note', 'The next draft comment.');
  const ordinary = await seedDraft(app, [ordinaryAnnotation], 'The next unsent request.'); await page.reload();
  const originalRecords = (await app.state()).annotations;
  await page.getByRole('button', { name: 'Edit request 1', exact: true }).click();
  const camera = await page.locator('.canvas-world').getAttribute('style');
  await page.locator('.annotation-content').first().click();
  await expect(editInput(page)).toHaveValue(annotations[0].text); await expect(full(page)).toHaveAttribute('data-annotation-id', annotations[0].id);
  await editInput(page).fill('Revised first comment.');
  await expect.poll(async () => (await app.state()).draft.annotations[0].text).toBe('Revised first comment.');
  let state = await app.state(); expect(state.tasks[0].snapshot).toEqual(original.snapshot); expect(state.annotations).toEqual(originalRecords);
  expect(state.draft.annotations.map(value => value.id)).toEqual(annotations.map(value => value.id));
  await page.locator('.annotation-content').nth(1).click(); await expect(page.locator('.annotation-full')).toHaveCount(1);
  await expect(full(page)).toHaveAttribute('data-annotation-id', annotations[1].id); await editInput(page).fill('Latest second comment.');
  expect(await page.locator('.canvas-world').getAttribute('style')).toBe(camera);
  await saveEdit(page).click(); await expect(page.locator('#instruction')).toHaveValue('The next unsent request.');
  await expect(page.locator('#instruction')).toBeFocused(); await expect(page.locator('.annotation-full')).toHaveCount(0);
  state = await app.state();
  expect(state.tasks.map(task => [task.id, task.sequence])).toEqual([[original.id, original.sequence], [second.id, second.sequence]]);
  expect(state.tasks[0].snapshot.annotations.map(value => value.text)).toEqual(['Revised first comment.', 'Latest second comment.', 'Original comment 3']);
  expect(state.tasks[0].snapshot.annotations.map(value => ({ ...value, text: '' }))).toEqual(annotations.map(value => ({ ...value, text: '' })));
  expect(state.tasks[1].snapshot).toEqual(second.snapshot); expect(state.draft.annotations).toEqual([ordinaryAnnotation]); expect(state.draft.id).toBe(ordinary.id);
  const savedSnapshot = state.tasks[0].snapshot;
  await page.getByRole('button', { name: 'Edit request 1', exact: true }).click(); await page.locator('.annotation-content').first().click();
  await editInput(page).fill('Discard this task edit.');
  await expect.poll(async () => (await app.state()).draft.annotations[0].text).toBe('Discard this task edit.');
  await page.locator('.annotation-content').nth(1).click(); await expect(full(page)).toHaveAttribute('data-annotation-id', annotations[1].id);
  await page.getByRole('button', { name: 'Remove annotation 1', exact: true }).click();
  await editInput(page).fill('Discard this second task edit.');
  await expect.poll(async () => (await app.state()).draft.annotations.map(value => [value.id, value.text])).toEqual([[annotations[1].id, 'Discard this second task edit.'], [annotations[2].id, annotations[2].text]]);
  expect((await app.state()).tasks[0].snapshot).toEqual(savedSnapshot);
  await page.getByRole('button', { name: 'Cancel edit', exact: true }).click();
  await expect(page.locator('#instruction')).toHaveValue('The next unsent request.'); await expect(page.locator('#instruction')).toBeFocused();
  state = await app.state(); expect(state.tasks[0].snapshot).toEqual(savedSnapshot); expect(state.tasks[0].status).toBe('queued');
  expect(state.draft.annotations).toEqual([ordinaryAnnotation]); expect(state.draft.id).toBe(ordinary.id); expect(state.draft.editingTaskId).toBeUndefined();
});

test('running and history annotations render real text without writes and seek video only through Jump to frame', async ({ page, app }) => {
  await open(page, app);
  await page.getByLabel('Import files into canvas', { exact: true }).setInputFiles([await image(page), { name: 'Motion.mp4', mimeType: 'video/mp4', buffer: await readFile(resolve('tests/fixtures/frontend-video.mp4')) }]);
  await expect(page.locator('.board-object')).toHaveCount(2);
  const initial = await app.state(), videoObject = initial.objects.find(object => object.type === 'video')!, source = initial.objects.find(object => object.type === 'image')!;
  const note = { ...annotation(videoObject, 'readonly-video', 'Keep the motion and original light.\nRetain this frame.'), timeStart: .7, timeEnd: 1.2, snapshotAssetId: source.assetId };
  await seedDraft(app, [note]); const original = await submitDraft(app);
  const claim = await app.call<Claim>(`/api/sessions/${initial.session.id}/claim`, 'POST', { consumerId: 'annotation-readonly-test' });
  await page.reload();
  const video = page.locator('.object-video video'); await expect(video).toHaveJSProperty('videoWidth', 320);
  await video.evaluate(element => { const media = element as HTMLVideoElement; media.pause(); media.currentTime = 1.5; });
  await expect(video).toHaveJSProperty('currentTime', 1.5);
  const before = await app.state(); await page.locator('.queue-task').click();
  const camera = await page.locator('.canvas-world').getAttribute('style'), pin = group(page, note.id).locator('.annotation-pin');
  await pin.click(); await expect(full(page)).toHaveAttribute('data-comment-mode', 'view');
  await expect(full(page).locator('textarea')).toHaveCount(0); await expect(full(page).locator('.annotation-fulltext')).toHaveText(note.text);
  await expect(full(page).locator('.comment-video-meta')).toContainText('0:00'); await expect(page.getByRole('slider', { name: 'End point' })).toHaveCount(0);
  await expect(video).toHaveJSProperty('currentTime', 1.5); await expect(video).toHaveJSProperty('paused', true);
  expect(await page.locator('.canvas-world').getAttribute('style')).toBe(camera);
  await page.getByRole('button', { name: 'Jump to frame', exact: true }).click(); await expect(video).toHaveJSProperty('currentTime', .7);
  await page.getByRole('button', { name: 'Close annotation', exact: true }).click(); await expect(pin).toBeFocused();
  expect((await app.state()).draft).toEqual(before.draft); expect((await app.state()).tasks[0].snapshot).toEqual(original.snapshot);
  await video.evaluate(element => { (element as HTMLVideoElement).currentTime = 1.5; }); await expect(video).toHaveJSProperty('currentTime', 1.5);
  await app.call(`/api/sessions/${initial.session.id}/tasks/${claim.task!.id}/complete`, 'POST', { runId: claim.run!.id, consumerId: claim.consumerId, summary: 'Frame direction retained.', assetIds: [], validation: [], operations: [] });
  await expect(page.locator('.queue-item')).toHaveCount(0);
  await page.getByRole('button', { name: 'More request actions', exact: true }).click(); await page.getByRole('menuitem', { name: 'Request history', exact: true }).click();
  await page.getByRole('region', { name: 'Request history', exact: true }).locator('.task-annotation-text').first().click();
  await expect(full(page)).toHaveAttribute('data-comment-mode', 'view'); await expect(full(page).locator('textarea')).toHaveCount(0);
  await expect(full(page).locator('.annotation-fulltext')).toHaveText(note.text); await expect(page.getByRole('button', { name: 'Done', exact: true })).toHaveCount(0);
  await expect(video).toHaveJSProperty('currentTime', 1.5);
  expect((await app.state()).draft).toEqual(before.draft); expect((await app.state()).tasks[0].snapshot).toEqual(original.snapshot);
});

test('the annotation range shows bounded neutral grips, an outside mask, a compact height and a restored span', async ({ page, app }, info) => {
  const shadeOf = (value: string) => value.match(/\d+/g)!.slice(0, 3).reduce((sum, part) => sum + Number(part), 0) / 3;
  await open(page, app);
  await page.getByLabel('Import files into canvas', { exact: true }).setInputFiles(resolve('tests/fixtures/frontend-video.mp4'));
  const video = page.locator('.object-video video'); await expect(video).toHaveJSProperty('videoWidth', 320);
  const duration = await video.evaluate(element => (element as HTMLVideoElement).duration);
  // Move the board playhead away from zero: a new annotation must not inherit it.
  await video.evaluate(element => { (element as HTMLVideoElement).currentTime = (element as HTMLVideoElement).duration * .6; });
  await expect.poll(() => video.evaluate(element => (element as HTMLVideoElement).readyState)).toBeGreaterThanOrEqual(2);
  await select(page, (await app.state()).objects[0]);
  await page.getByRole('button', { name: 'Annotate', exact: true }).click();
  await expect(page.locator('.annotation-time-range')).toHaveAttribute('data-ready', 'true');

  // The removed dropdown and End time input stay gone, and a new comment spans the whole clip.
  await expect(page.getByLabel('End time', { exact: true })).toHaveCount(0); await expect(page.getByLabel('Audio annotation target', { exact: true })).toHaveCount(0);
  const start = page.getByRole('slider', { name: 'Start point' }), end = page.getByRole('slider', { name: 'End point' });
  await expect(start).toHaveAttribute('aria-valuenow', '0'); await expect(end).toHaveAttribute('aria-valuenow', String(duration));

  // Each grip is a dark slot set into a light side rail of the single selection rectangle.
  const surface = () => page.evaluate(() => {
    const box = document.querySelector('.annotation-range-selection') as HTMLElement;
    const rail = document.querySelector('.annotation-range-rail') as HTMLElement;
    const notch = document.querySelector('.annotation-range-handle span') as HTMLElement;
    const rect = notch.getBoundingClientRect();
    const shade = (value: string) => value.match(/\d+/g)!.slice(0, 3).reduce((sum, part) => sum + Number(part), 0) / 3;
    const style = getComputedStyle(box);
    const alpha = Number((style.backgroundColor.match(/[\d.]+\s*\)$/) || ['1)'])[0].replace(')', '')) || 1;
    const railStyle = getComputedStyle(rail), notchStyle = getComputedStyle(notch);
    return { fill: style.backgroundColor, border: style.borderTopColor, borderWidth: style.borderTopWidth, fillAlpha: alpha, insideShade: shade(style.backgroundColor), rail: railStyle.backgroundColor, railShade: shade(railStyle.backgroundColor), notch: notchStyle.backgroundColor, width: rect.width, height: rect.height, notchShade: shade(notchStyle.backgroundColor) };
  });
  const light = await surface();
  // One rectangle: a light rail on each side of it, with a dark grip set into each rail.
  expect(await page.locator('.annotation-range-selection > .annotation-range-rail').count()).toBe(2);
  expect(light.borderWidth).toBe('2px');
  // The sides are solidly light and the grips are dark, so a grip never disappears into its rail.
  expect(light.railShade).toBeGreaterThan(230); expect(light.notchShade).toBeLessThan(120); expect(light.railShade - light.notchShade).toBeGreaterThan(120);
  // The selected interior is washed light but stays translucent, so the frames and waveform still read through it.
  expect(light.fillAlpha).toBeGreaterThan(0.5); expect(light.fillAlpha).toBeLessThan(0.8);
  expect(light.insideShade).toBeGreaterThan(200);
  expect(shadeOf(light.border)).toBeLessThan(120);
  expect(light.width).toBeGreaterThanOrEqual(10); expect(light.width).toBeLessThanOrEqual(13);
  expect(light.height).toBeGreaterThanOrEqual(20); expect(light.height).toBeLessThanOrEqual(24);
  expect(light.height / light.width).toBeGreaterThan(1.6); expect(light.height / light.width).toBeLessThan(2.4);
  // The frame holds two grips inside one rectangle.
  expect(await page.locator('.annotation-range-selection > .annotation-range-handle').count()).toBe(2);
  const heights = await page.evaluate(() => ({ card: document.querySelector('.annotation-full')!.getBoundingClientRect().height, track: document.querySelector('.annotation-range-track')!.getBoundingClientRect().height, range: document.querySelector('.annotation-time-range')!.getBoundingClientRect().height }));
  expect(heights.range).toBeLessThan(60); expect(heights.track).toBeLessThan(30); expect(heights.card).toBeLessThan(200);
  // Hovering a grip must not resize it; only its colour may change.
  await page.locator('.annotation-range-handle').first().hover();
  const hovered = await surface();
  expect(hovered.width).toBe(light.width); expect(hovered.height).toBe(light.height);
  // Both themes draw the identical range, so the mask never inverts its emphasis.
  const lightShot = info.outputPath('range-annotation-light.png'); await page.locator('.annotation-full').screenshot({ path: lightShot }); console.log(`MEDIA_RANGE_SHOT ${lightShot}`);
  await page.getByRole('button', { name: 'Switch to dark theme' }).click();
  const dark = await surface();
  // The same rails, grips, wash and outline hold in the dark theme instead of inverting.
  expect(dark.rail).toBe(light.rail); expect(dark.railShade).toBeGreaterThan(230);
  expect(dark.notch).toBe(light.notch); expect(dark.notchShade).toBeLessThan(120);
  expect(dark.border).toBe(light.border); expect(dark.fill).toBe(light.fill);
  const darkShot = info.outputPath('range-annotation-dark.png'); await page.locator('.annotation-full').screenshot({ path: darkShot }); console.log(`MEDIA_RANGE_SHOT ${darkShot}`);
  await page.getByRole('button', { name: 'Switch to light theme' }).click();

  // The mask covers only the two sides, so the selected span keeps the original material colours.
  const track = (await page.locator('.annotation-range-track').boundingBox())!;
  await page.mouse.move(track.x + track.width * .3, track.y + track.height / 2); await page.mouse.down();
  await page.mouse.move(track.x + track.width * .8, track.y + track.height / 2, { steps: 5 }); await page.mouse.up();
  const mask = await page.evaluate(() => {
    const box = (selector: string) => { const rect = (document.querySelector(selector) as HTMLElement).getBoundingClientRect(); return { left: Math.round(rect.left), right: Math.round(rect.right), width: Math.round(rect.width) }; };
    return {
      track: box('.annotation-range-track'), selection: box('.annotation-range-selection'),
      grips: Array.from(document.querySelectorAll('.annotation-range-handle span')).map(element => { const rect = element.getBoundingClientRect(); return { left: Math.round(rect.left), right: Math.round(rect.right) }; }),
      widths: Array.from(document.querySelectorAll('.annotation-range-outside')).map(element => Math.round((element as HTMLElement).getBoundingClientRect().width)),
      rail: Math.round((document.querySelector('.annotation-range-rail') as HTMLElement).getBoundingClientRect().width),
      colour: getComputedStyle(document.querySelector('.annotation-range-outside') as HTMLElement).backgroundColor,
    };
  });
  expect(mask.colour).toBe('rgb(74, 74, 74)');
  expect(mask.widths[0]).toBe(mask.selection.left - mask.track.left);
  expect(mask.widths[1]).toBe(mask.track.width - (mask.selection.left - mask.track.left) - mask.selection.width);
  // Each grip stays within its own side rail and never overhangs the outside of the rectangle.
  expect(mask.grips[0].left).toBeGreaterThanOrEqual(mask.selection.left); expect(mask.grips[0].right).toBeLessThanOrEqual(mask.selection.left + mask.rail);
  expect(mask.grips[1].right).toBeLessThanOrEqual(mask.selection.right); expect(mask.grips[1].left).toBeGreaterThanOrEqual(mask.selection.right - mask.rail);
  const selected = { start: Number(await start.getAttribute('aria-valuenow')), end: Number(await end.getAttribute('aria-valuenow')) };
  expect(selected.start).toBeGreaterThan(0); expect(selected.end).toBeLessThanOrEqual(duration); expect(selected.end).toBeGreaterThan(selected.start);
  const shot = info.outputPath('range-card.png'); await page.locator('.annotation-full').screenshot({ path: shot }); console.log(`MEDIA_RANGE_SHOT ${shot}`);

  // The excerpt plays from the start point and stops itself at the end point.
  await page.getByRole('button', { name: 'Play range preview' }).click();
  await expect.poll(() => video.evaluate(element => !(element as HTMLVideoElement).paused)).toBeTruthy();
  const playbackStart = await video.evaluate(element => (element as HTMLVideoElement).currentTime);
  expect(playbackStart).toBeGreaterThanOrEqual(selected.start - .02); expect(playbackStart).toBeLessThan(selected.end);
  await expect.poll(() => video.evaluate(element => (element as HTMLVideoElement).paused), { timeout: 6000 }).toBeTruthy();
  const playbackEnd = await video.evaluate(element => (element as HTMLVideoElement).currentTime);
  expect(playbackEnd).toBeGreaterThan(selected.start); expect(playbackEnd).toBeLessThanOrEqual(selected.end + .02);

  // The saved draft comment reopens with its committed span rather than the whole clip.
  await page.getByRole('textbox', { name: 'Add a comment', exact: true }).fill('Use this moving interval.');
  await expect.poll(async () => (await app.state()).draft.annotations[0]?.timeStart).toBeCloseTo(selected.start, 2);
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await page.locator('.draft-annotation .annotation-content').first().click();
  await expect(start).toHaveAttribute('aria-valuenow', String(selected.start)); await expect(end).toHaveAttribute('aria-valuenow', String(selected.end));
});

test('annotation text, bubble and full panel keep screen sizes while anchors follow zoom and focus stays stable', async ({ page, app }, info) => {
  await open(page, app); const [object] = await importImages(page, app);
  const text = 'Keep the relationships clear and preserve the quiet light. '.repeat(36), note = annotation(object, 'scale-note', text);
  await seedDraft(app, [note]); await page.reload();
  const toolbar = page.getByRole('toolbar', { name: 'Board tools', exact: true });
  const toolbarSize = await toolbar.evaluate(element => ({ width: element.getBoundingClientRect().width, height: element.getBoundingClientRect().height }));
  const samples: unknown[] = []; let textHeight: number | undefined, inputFont: string | undefined;
  const worldZoom = () => page.locator('.canvas-world').evaluate(element => new DOMMatrix(getComputedStyle(element).transform).a);
  for (const theme of ['light', 'dark']) {
    const switchTheme = page.getByRole('button', { name: theme === 'dark' ? 'Switch to dark theme' : 'Switch to light theme', exact: true });
    if (await switchTheme.count()) await switchTheme.click();
    for (const width of [1440, 390, 320]) {
      await page.setViewportSize({ width, height: 760 });
      for (const target of [.5, 1, 1.5, 2]) {
        const current = await worldZoom();
        await page.locator('#whiteboard').dispatchEvent('wheel', { deltaY: -Math.log(target / current) / .005, ctrlKey: true, clientX: width / 2, clientY: 400, bubbles: true, cancelable: true });
        await expect.poll(worldZoom).toBeCloseTo(target, 5); await expect(page.locator('.zoom-label')).toHaveText(`${target * 100}%`);
        const summary = group(page, note.id).locator('.canvas-annotation-summary');
        const metrics = await group(page, note.id).evaluate(element => {
          const pin = element.querySelector('.annotation-pin')!.getBoundingClientRect(), summary = element.querySelector('.canvas-annotation-summary')!, rect = summary.getBoundingClientRect(), object = document.querySelector('.board-object')!.getBoundingClientRect(), range = document.createRange();
          range.selectNodeContents(summary.querySelector('span') || summary);
          return { pin, summary: rect, textHeight: range.getBoundingClientRect().height, object, cssWidth: getComputedStyle(summary).width, inWorld: !!element.closest('.canvas-world'), overflow: document.documentElement.scrollWidth - innerWidth };
        });
        expect(metrics.inWorld).toBeFalsy(); expect(metrics.cssWidth).toBe('220px'); expect(metrics.summary.width).toBeCloseTo(220, 3);
        expect(metrics.pin.width).toBeCloseTo(28, 3); expect(metrics.object.width).toBeCloseTo(300 * target, 3); expect(metrics.overflow).toBe(0);
        expect(metrics.summary.x - metrics.pin.right).toBeCloseTo(8, 3); expect(metrics.pin.x).toBeCloseTo(metrics.object.x, 3); expect(metrics.object.y - metrics.summary.bottom).toBeCloseTo(8, 3);
        textHeight ??= metrics.textHeight; expect(metrics.textHeight).toBeCloseTo(textHeight, 1);
        const camera = await page.locator('.canvas-world').getAttribute('style'); await page.locator('.annotation-content').click();
        const panel = full(page), input = editInput(page); await expect(panel).toHaveAttribute('data-comment-mode', 'edit'); await settleNote(group(page, note.id));
        const panelBounds = (await panel.boundingBox())!; expect(panelBounds.width).toBeCloseTo(Math.min(360, width - 80), 3); expect(panelBounds.height).toBeCloseTo(160, 3); expect(panelBounds.x - metrics.object.x).toBeCloseTo(36, 3); expect(metrics.object.y - (panelBounds.y + panelBounds.height)).toBeCloseTo(8, 3);
        const font = await input.evaluate(element => getComputedStyle(element).fontSize); inputFont ??= font; expect(font).toBe(inputFont);
        await input.evaluate(element => (element as HTMLTextAreaElement).blur());
        const unfocused = { panel: await appearance(panel), input: await appearance(input) };
        await input.evaluate(element => element.focus({ preventScroll: true })); expect({ panel: await appearance(panel), input: await appearance(input) }).toEqual(unfocused);
        expect(await page.locator('.canvas-world').getAttribute('style')).toBe(camera);
        const scroll = await input.evaluate(element => { const field = element as HTMLTextAreaElement; field.scrollTop = field.scrollHeight; return { max: field.scrollHeight - field.clientHeight, top: field.scrollTop }; });
        expect(scroll.max).toBeGreaterThan(0); expect(scroll.top).toBeGreaterThan(0);
        const size = await toolbar.evaluate(element => ({ width: element.getBoundingClientRect().width, height: element.getBoundingClientRect().height })); expect(size).toEqual(toolbarSize);
        await expect(page.getByRole('button', { name: /Locate/i })).toHaveCount(0);
        samples.push({ theme, width, target, metrics, panelBounds, font, toolbar: size });
        if (target === 1) await page.screenshot({ path: info.outputPath(`annotation-full-${theme}-${width}.png`) });
        await input.press('Escape'); await expect(page.locator('.annotation-full')).toHaveCount(0); await expect(summary).toHaveCount(1); await settleNote(group(page, note.id));
      }
      await page.screenshot({ path: info.outputPath(`annotation-screen-${theme}-${width}.png`) });
    }
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole('button', { name: 'Reset zoom to 100%', exact: true }).click(); await expect.poll(worldZoom).toBeCloseTo(1, 5);
  await page.getByRole('button', { name: 'Zoom in', exact: true }).click(); await expect.poll(worldZoom).toBeCloseTo(1.2, 5);
  await page.getByRole('button', { name: 'Zoom out', exact: true }).click(); await expect.poll(worldZoom).toBeCloseTo(1, 5);
  await page.locator('.annotation-content').click();
  await settleNote(group(page, note.id));
  const done = page.getByRole('button', { name: 'Done', exact: true }); await done.evaluate(element => (element as HTMLElement).blur());
  const idle = await appearance(done); await page.keyboard.press('Tab'); await done.focus(); await expect(done).toBeFocused();
  expect(await appearance(done)).not.toEqual(idle);
  const retainedInput = await editInput(page).elementHandle();
  const beforePan = await full(page).boundingBox(), sourceBeforePan = await page.locator('.board-object').boundingBox();
  await page.locator('#whiteboard').dispatchEvent('wheel', { deltaX: 35, deltaY: 45, clientX: 1000, clientY: 100, bubbles: true, cancelable: true });
  await expect.poll(async () => (await full(page).boundingBox())!.x).toBeCloseTo(beforePan!.x - 35, 3);
  const afterPan = (await full(page).boundingBox())!, sourceAfterPan = (await page.locator('.board-object').boundingBox())!;
  expect(afterPan.width).toBeCloseTo(beforePan!.width, 3); expect(afterPan.height).toBeCloseTo(beforePan!.height, 3);
  expect(afterPan.y).toBeCloseTo(beforePan!.y - 45, 3); expect(sourceAfterPan.x).toBeCloseTo(sourceBeforePan!.x - 35, 3); expect(sourceAfterPan.y).toBeCloseTo(sourceBeforePan!.y - 45, 3);
  for (const target of [.5, 1, 1.5, 2]) {
    const current = await worldZoom();
    await page.locator('#whiteboard').dispatchEvent('wheel', { deltaY: -Math.log(target / current) / .005, ctrlKey: true, clientX: 720, clientY: 400, bubbles: true, cancelable: true });
    await expect.poll(worldZoom).toBeCloseTo(target, 5);
    const panel = (await full(page).boundingBox())!, source = (await page.locator('.board-object').boundingBox())!;
    expect(panel.width).toBeCloseTo(360, 3); expect(panel.height).toBeCloseTo(160, 3); expect(source.y - (panel.y + panel.height)).toBeCloseTo(8, 3); expect(panel.x - source.x).toBeCloseTo(36, 3);
    expect(await retainedInput!.evaluate(element => element.isConnected)).toBeTruthy(); await expect(editInput(page)).toHaveValue(text);
  }
  expect((await app.state()).draft.annotations).toEqual([note]);
  await writeFile(info.outputPath('annotation-screen-geometry.json'), JSON.stringify(samples, null, 2));
});

test('annotation expansion and retraction keep continuous screen bounds and support interruption and reduced motion', async ({ page, app }, info) => {
  await open(page, app); const [object, other] = await importImages(page, app, 2);
  const notes = [annotation(object, 'motion-first', 'Keep the quiet light.\nRetain the soft palette.'), annotation(object, 'motion-second', 'Preserve the spacing.'), annotation(object, 'motion-third', 'Keep this relationship.'), annotation(other, 'motion-other', 'Retain the contrast.')];
  await seedDraft(app, notes); await page.reload();
  await page.locator('#whiteboard').dispatchEvent('wheel', { deltaX: 320, deltaY: 0, bubbles: true, cancelable: true });
  await page.evaluate(() => {
    const original = Element.prototype.animate;
    (window as any).noteMotionStarts = 0;
    Element.prototype.animate = function(...args) {
      if (this.classList.contains('canvas-annotation-note') || this.classList.contains('canvas-annotation-group')) (window as any).noteMotionStarts++;
      return original.apply(this, args);
    };
  });
  const first = group(page, notes[0].id), pin = first.locator('.annotation-pin');
  const geometry = () => page.evaluate(() => {
    const rect = (element: Element) => { const { x, y, width, height } = element.getBoundingClientRect(); return { x, y, width, height }; };
    return { notes: Array.from(document.querySelectorAll('.canvas-annotation-group')).map(element => ({ group: rect(element), box: rect(element.querySelector('.canvas-annotation-note')!), pin: rect(element.querySelector('.annotation-pin')!) })), sources: Array.from(document.querySelectorAll('.board-object')).map(rect), camera: (document.querySelector('.canvas-world') as HTMLElement).style.transform };
  });
  const frames = async () => first.evaluate(async element => {
    const animations = element.getAnimations({ subtree: true });
    if (animations.length !== 2) throw new Error(`Expected two note geometry animations, received ${animations.length}.`);
    const rect = (element: Element) => { const { x, y, width, height } = element.getBoundingClientRect(); return { x, y, width, height }; };
    animations.forEach(animation => animation.pause());
    const samples = [];
    for (const time of [0, 65, 130, 195, 260]) {
      animations.forEach(animation => { animation.currentTime = time; });
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      const field = element.querySelector<HTMLElement>('.annotation-fulltext'), footer = element.querySelector('.annotation-footer');
      samples.push({ time, box: rect(element.querySelector('.canvas-annotation-note')!), pin: rect(element.querySelector('.annotation-pin')!), groups: Array.from(document.querySelectorAll('.canvas-annotation-group')).map(rect), source: rect(document.querySelector('.board-object')!), background: getComputedStyle(element.querySelector('.canvas-annotation-note')!).backgroundColor, field: field && { ...rect(field), lineHeight: parseFloat(getComputedStyle(field).lineHeight) }, footer: footer && rect(footer) });
    }
    animations.forEach(animation => animation.finish());
    return samples;
  });
  const compare = (actual: { x: number; y: number; width: number; height: number }, expected: typeof actual, tolerance = .1) => {
    for (const key of ['x', 'y', 'width', 'height'] as const) expect(Math.abs(actual[key] - expected[key]), key).toBeLessThan(tolerance);
  };
  const evidence = [];
  for (const width of [1440, 320]) {
    await page.setViewportSize({ width, height: 760 });
    for (const zoom of [.5, 1, 1.5, 2]) {
      const current = await page.locator('.canvas-world').evaluate(element => new DOMMatrix(getComputedStyle(element).transform).a);
      await page.locator('#whiteboard').dispatchEvent('wheel', { deltaY: -Math.log(zoom / current) / .005, ctrlKey: true, clientX: 80, clientY: 330, bubbles: true, cancelable: true });
      const before = await geometry();
      await pin.evaluate(element => (element as HTMLButtonElement).click()); await expect(editInput(page)).toBeFocused();
      const opened = await frames();
      compare(opened[0].box, before.notes[0].box); compare(opened[0].pin, before.notes[0].pin);
      expect(opened[0].field!.height).toBeGreaterThan(22); expect(opened[0].field!.y + opened[0].field!.lineHeight).toBeLessThanOrEqual(opened[0].box.y + opened[0].box.height);
      expect(opened[0].footer!.y).toBeGreaterThanOrEqual(opened[0].box.y + opened[0].box.height);
      for (const sample of opened) {
        expect(sample.source.y - sample.box.y - sample.box.height).toBeCloseTo(8, 1); expect(sample.pin.width).toBe(28);
        expect(sample.box.x - sample.pin.x - sample.pin.width).toBeCloseTo(8, 2);
        expect(Math.abs(sample.groups[0].y - sample.groups[1].y - sample.groups[1].height - 8)).toBeLessThan(1);
        expect(Math.abs(sample.groups[1].y - sample.groups[2].y - sample.groups[2].height - 8)).toBeLessThan(1);
        compare(sample.groups[3], before.notes[3].group); compare(sample.source, before.sources[0]);
      }
      expect(opened[1].box.height).toBeGreaterThan(28 + 132 * .5); expect(opened[1].box.height).toBeLessThan(160);
      expect(opened.at(-1)!.box.width).toBe(Math.min(360, width - 80)); expect(opened.at(-1)!.box.height).toBe(160);
      expect((await geometry()).camera).toBe(before.camera);
      const expanded = await geometry(); await editInput(page).dispatchEvent('keydown', { key: 'Escape', bubbles: true });
      const closed = await frames(); compare(closed[0].box, expanded.notes[0].box); compare(closed[0].pin, expanded.notes[0].pin);
      for (const sample of closed) expect(sample.source.y - sample.box.y - sample.box.height).toBeCloseTo(8, 1);
      expect(closed[1].box.height).toBeLessThan(160 - 132 * .5); expect(closed.at(-1)!.box.height).toBe(28); expect(closed.at(-1)!.box.width).toBe(220);
      evidence.push({ width, zoom, opened, closed });
    }
  }
  await page.setViewportSize({ width: 1440, height: 760 });
  await pin.evaluate(element => (element as HTMLButtonElement).click());
  await first.evaluate(element => { element.getAnimations({ subtree: true }).forEach(animation => { animation.pause(); animation.currentTime = 65; }); });
  const interrupted = await geometry(); await editInput(page).dispatchEvent('keydown', { key: 'Escape', bubbles: true });
  const reversed = await frames(); compare(reversed[0].box, interrupted.notes[0].box); compare(reversed[0].pin, interrupted.notes[0].pin);
  await pin.evaluate(element => (element as HTMLButtonElement).click()); await settleNote(first);
  const sharedBefore = await geometry();
  await group(page, notes[1].id).locator('.annotation-pin').evaluate(element => (element as HTMLButtonElement).click());
  const shared = await page.evaluate(async () => {
    const animations = document.getAnimations().filter(animation => (animation.effect as KeyframeEffect).target instanceof Element && ((animation.effect as KeyframeEffect).target as Element).closest('.canvas-annotation-group'));
    if (animations.length !== 4) throw new Error(`Expected four shared-anchor animations, received ${animations.length}.`);
    const rect = (element: Element) => { const { x, y, width, height } = element.getBoundingClientRect(); return { x, y, width, height }; };
    animations.forEach(animation => animation.pause()); const samples = [];
    for (const time of [0, 65, 130, 195, 260]) {
      animations.forEach(animation => { animation.currentTime = time; });
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      samples.push(Array.from(document.querySelectorAll('.canvas-annotation-group')).map(element => ({ group: rect(element), box: rect(element.querySelector('.canvas-annotation-note')!), pin: rect(element.querySelector('.annotation-pin')!) })));
    }
    animations.forEach(animation => animation.finish()); return samples;
  });
  for (let index = 0; index < sharedBefore.notes.length; index++) { compare(shared[0][index].box, sharedBefore.notes[index].box); compare(shared[0][index].pin, sharedBefore.notes[index].pin); }
  for (const sample of shared) for (let index = 1; index < 3; index++) expect(Math.abs(sample[index - 1].group.y - sample[index].group.y - sample[index].group.height - 8)).toBeLessThan(1);
  await editInput(page).press('Escape'); await settleNote(group(page, notes[1].id)); await pin.evaluate(element => (element as HTMLButtonElement).click()); await settleNote(first);
  const input = editInput(page), retained = await input.elementHandle(), starts = await page.evaluate(() => (window as any).noteMotionStarts);
  await pin.evaluate(element => (element as HTMLButtonElement).click()); expect(await page.evaluate(() => (window as any).noteMotionStarts)).toBe(starts);
  await input.evaluate(element => (element as HTMLTextAreaElement).blur()); const idleAppearance = await appearance(input); await input.focus(); expect(await appearance(input)).toEqual(idleAppearance);
  await input.fill('Keep the focused text stable.'); await input.press('End'); const selection = await input.evaluate(element => (element as HTMLTextAreaElement).selectionStart);
  await input.evaluate(element => { element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })); element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true })); });
  await expect(input).toBeFocused(); expect(await input.evaluate(element => (element as HTMLTextAreaElement).selectionStart)).toBe(selection);
  await input.evaluate(element => { element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })); });
  await page.locator('#whiteboard').dispatchEvent('wheel', { deltaX: 15, deltaY: 25, bubbles: true, cancelable: true });
  await page.locator('#whiteboard').dispatchEvent('wheel', { deltaY: 15, ctrlKey: true, clientX: 80, clientY: 330, bubbles: true, cancelable: true });
  expect(await retained!.evaluate(element => element.isConnected)).toBeTruthy(); expect(await page.evaluate(() => (window as any).noteMotionStarts)).toBe(starts);
  await expect(input).toHaveValue('Keep the focused text stable.');
  await page.emulateMedia({ reducedMotion: 'reduce' }); await input.press('Escape'); await expect(first.locator('.canvas-annotation-note')).toHaveCSS('height', '28px');
  await first.locator('.canvas-annotation-summary').focus(); await expect(first.locator('.canvas-annotation-note')).toHaveCSS('overflow', 'visible');
  await pin.evaluate(element => (element as HTMLButtonElement).click()); await expect(first.locator('.canvas-annotation-note')).toHaveCSS('height', '160px');
  expect(await first.evaluate(element => element.getAnimations({ subtree: true }).length)).toBe(0); expect(await page.evaluate(() => (window as any).noteMotionStarts)).toBe(starts);
  await page.screenshot({ path: info.outputPath('annotation-motion-light-1440.png') });
  await writeFile(info.outputPath('annotation-motion-geometry.json'), JSON.stringify({ evidence, reversed, shared, starts }, null, 2));
});

test('Cancel edit has theme-aware hover and keyboard feedback with stable bounds and restores the ordinary draft', async ({ page, app }, info) => {
  await open(page, app); await seedDraft(app, [], 'Original queued request.'); const task = await submitDraft(app);
  await seedDraft(app, [], 'Keep the ordinary draft.'); await page.reload();
  const samples = [];
  for (const theme of ['light', 'dark']) for (const width of [1440, 320]) {
    await page.setViewportSize({ width, height: 760 });
    const switchTheme = page.getByRole('button', { name: theme === 'dark' ? 'Switch to dark theme' : 'Switch to light theme', exact: true });
    if (await switchTheme.count()) await switchTheme.click();
    await page.getByRole('button', { name: 'Edit request 1', exact: true }).click(); await expect(page.locator('#instruction')).toHaveValue('Original queued request.');
    const cancel = page.getByRole('button', { name: 'Cancel edit', exact: true }); await page.mouse.move(0, 0); await settleNote(page.locator('.composer'));
    const style = () => cancel.evaluate(element => { const value = getComputedStyle(element), { x, y, width, height } = element.getBoundingClientRect(); return { background: value.backgroundColor, color: value.color, outline: value.outlineStyle, rect: { x, y, width, height } }; });
    const idle = await style(); await cancel.hover(); await expect.poll(async () => (await style()).background).not.toBe(idle.background);
    await expect.poll(async () => (await style()).color).not.toBe(idle.color); const hover = await style(); expect(hover.rect).toEqual(idle.rect);
    await page.mouse.move(0, 0); await page.keyboard.press('Tab'); await cancel.focus(); await expect(cancel).toBeFocused();
    await expect.poll(async () => (await style()).background).not.toBe(idle.background); const focus = await style(); expect(focus.outline).toBe('solid'); expect(focus.rect).toEqual(idle.rect);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0);
    if (theme === 'dark' && width === 320) await page.screenshot({ path: info.outputPath('cancel-edit-dark-320.png') });
    samples.push({ theme, width, idle, hover, focus });
    await page.locator('#instruction').fill('Discard this edit.'); await cancel.click();
    await expect(page.locator('#instruction')).toHaveValue('Keep the ordinary draft.'); await expect(cancel).toHaveCount(0);
    expect((await app.state()).tasks[0].snapshot).toEqual(task.snapshot); expect((await app.state()).tasks[0].status).toBe('queued');
  }
  await writeFile(info.outputPath('cancel-edit-feedback.json'), JSON.stringify(samples, null, 2));
});

test('an open task annotation keeps its full box while ownership changes to the task edit draft', async ({ page, app }) => {
  await open(page, app); const [object] = await importImages(page, app);
  const note = annotation(object, 'owner-transition', 'Keep the first comment line.\nRetain its context.');
  await seedDraft(app, [note], 'Original request.'); const task = await submitDraft(app);
  await seedDraft(app, [], 'Ordinary draft.'); await page.reload(); await page.locator('.queue-task').click();
  const ownerNote = group(page, note.id); await ownerNote.locator('.annotation-pin').click(); await expect(full(page)).toHaveAttribute('data-comment-mode', 'view'); await settleNote(ownerNote);
  const before = await full(page).boundingBox(), retained = await ownerNote.elementHandle();
  await page.evaluate(() => { const original = Element.prototype.animate; (window as any).ownerTransitionStarts = 0; Element.prototype.animate = function(...args) { if (this.classList.contains('canvas-annotation-note') || this.classList.contains('canvas-annotation-group')) (window as any).ownerTransitionStarts++; return original.apply(this, args); }; });
  let releaseState!: () => void, enteredState!: () => void;
  const heldState = new Promise<void>(resolve => { enteredState = resolve; }), stateBarrier = new Promise<void>(resolve => { releaseState = resolve; });
  await page.route('**/api/state?**', async route => { enteredState(); await stateBarrier; await route.continue(); });
  try {
    await page.getByRole('button', { name: 'Edit request 1', exact: true }).click(); await heldState;
    await expect(full(page)).toHaveAttribute('data-comment-mode', 'view'); expect(await full(page).boundingBox()).toEqual(before); expect(await retained!.evaluate(element => element.isConnected)).toBeTruthy();
    releaseState(); await expect(editInput(page)).toHaveValue(note.text); await expect(editInput(page)).toBeFocused();
    expect(await full(page).boundingBox()).toEqual(before); expect(await retained!.evaluate(element => element.isConnected)).toBeTruthy(); expect(await page.evaluate(() => (window as any).ownerTransitionStarts)).toBe(0);
    expect((await app.state()).tasks[0].snapshot).toEqual(task.snapshot);
    await page.getByRole('button', { name: 'Cancel edit', exact: true }).click(); await expect(page.locator('#instruction')).toHaveValue('Ordinary draft.');
  } finally { releaseState(); await page.unrouteAll({ behavior: 'wait' }); }
});

test('TaskEdit keeps removed-source and multi-source snapshot references while editing the existing annotation identity', async ({ page, app }) => {
  await open(page, app); const objects = await importImages(page, app, 2);
  const notes: AnnotationInput[] = [
    annotation(objects[0], 'removed-detail', 'Retain this source detail.'),
    { id: 'removed-pair', scope: 'region', objectIds: objects.map(object => object.id), coordinateSpace: 'world', bounds: { x: 400, y: 330, width: 630, height: 150 }, text: 'Keep the two sources together.' },
  ];
  await seedDraft(app, notes, 'Use the recorded sources.'); const original = await submitDraft(app);
  const state = await app.state();
  await app.call('/api/board/operations', 'POST', { sessionId: state.session.id, operations: state.objects.map(object => ({ type: 'delete', objectId: object.id, expectedVersion: object.version })) });
  await page.reload(); await expect(page.locator('.board-object')).toHaveCount(0);
  await page.getByRole('button', { name: 'Edit request 1', exact: true }).click(); await expect(page.locator('.annotation-outline[data-source-removed=true]')).toHaveCount(2);
  const camera = await page.locator('.canvas-world').getAttribute('style');
  for (let index = 0; index < notes.length; index++) {
    await page.locator('.annotation-content').nth(index).click(); await expect(full(page)).toHaveAttribute('data-annotation-id', notes[index].id);
    await expect(editInput(page)).toHaveValue(notes[index].text); await editInput(page).fill(`Revised recorded source ${index + 1}.`); await editInput(page).press('Escape');
  }
  await expect.poll(async () => (await app.state()).draft.annotations.map(value => value.text)).toEqual(['Revised recorded source 1.', 'Revised recorded source 2.']);
  expect(await page.locator('.canvas-world').getAttribute('style')).toBe(camera); expect((await app.state()).tasks[0].snapshot).toEqual(original.snapshot);
  await saveEdit(page).click(); await expect(page.locator('.composer-editing')).toHaveCount(0);
  const result = await app.state(), task = result.tasks[0];
  expect(result.objects).toEqual([]); expect(task.id).toBe(original.id); expect(task.sequence).toBe(original.sequence);
  expect(task.snapshot.referenceContent).toEqual(original.snapshot.referenceContent);
  expect(task.snapshot.annotations.map(value => ({ ...value, text: '' }))).toEqual(notes.map(value => ({ ...value, text: '' })));
  expect(task.snapshot.annotations.map(value => value.text)).toEqual(['Revised recorded source 1.', 'Revised recorded source 2.']);
});
