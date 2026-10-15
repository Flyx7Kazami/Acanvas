import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect } from '@playwright/test';
import type { Page } from 'playwright-core';
import { startServer } from '../src/server/http.js';
import type { AnnotationInput, Asset, BoardObject, RequestReference } from '../src/shared/types.js';

async function enteredStage(stage: Promise<void>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([stage, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('The expected project capture stage was not reached.')), 15_000); })]); }
  finally { clearTimeout(timer); }
}
function installSceneOracle() {
  const draw = CanvasRenderingContext2D.prototype.drawImage;
  CanvasRenderingContext2D.prototype.drawImage = function (this: CanvasRenderingContext2D, ...args: any[]) {
    const source = args[0];
    if (source instanceof HTMLCanvasElement && source.classList.contains('scene-evidence-canvas') && args.length === 9 && this.canvas !== source) {
      (window as any).sceneCopyOracle = { frameSeq: Number(source.dataset.frameSeq), width: args[7], height: args[8], pixels: source.getContext('2d')!.getImageData(args[1], args[2], args[3], args[4]).data };
    }
    return (draw as any).apply(this, args);
  } as typeof draw;
}
async function assertSceneCopy(page: Page, annotation: AnnotationInput) {
  assert.equal(annotation.capture?.sourceMode, 'scene-bitmap'); assert.equal(annotation.captureState?.version, annotation.capture?.version);
  const pixels = await page.evaluate(async capture => {
    const response = await fetch(`/api/assets/${capture.screenshotAssetId}/content?sessionId=${capture.sessionId}`); if (!response.ok) throw new Error('The captured PNG is unavailable.');
    const image = await createImageBitmap(await response.blob()), canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height; canvas.getContext('2d')!.drawImage(image, 0, 0); image.close();
    const actual = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data, oracle = (window as any).sceneCopyOracle;
    if (!oracle || actual.length !== oracle.pixels.length || canvas.width !== oracle.width || canvas.height !== oracle.height) throw new Error('The saved PNG dimensions differ from the copied evidence frame.');
    let mismatches = 0; for (let index = 0; index < actual.length; index++) if (actual[index] !== oracle.pixels[index]) mismatches++;
    return { mismatches, frameSeq: oracle.frameSeq };
  }, annotation.capture!);
  assert.equal(pixels.mismatches, 0); assert.equal(pixels.frameSeq, annotation.capture!.presentation!.frameSeq); assert.equal(annotation.capture!.sceneSource!.frameSeq, pixels.frameSeq);
}

type Box = { left: number; top: number; right: number; bottom: number };
type Area = { x: number; y: number; width: number; height: number };
type Region = { window: Area; kind: 'red' | 'pin' | 'ink' | 'bright' | 'color'; color?: number[] };
type Point = { x: number; y: number };
type Pixel = readonly [number, number, number];
/** Pixel extents of one color class inside each CSS window, mapped back to CSS pixels. */
async function colorBoxes(page: Page, image: { capture: { screenshotAssetId: string; sessionId: string; mapping: { crop: Area; scaleX: number; scaleY: number } } } | { screenshot: Buffer }, regions: Region[]): Promise<(Box | null)[]> {
  return page.evaluate(async ({ image, regions }) => {
    const blob = 'capture' in image ? await (await fetch(`/api/assets/${image.capture.screenshotAssetId}/content?sessionId=${image.capture.sessionId}`)).blob() : new Blob([new Uint8Array(image.screenshot)], { type: 'image/png' });
    const bitmap = await createImageBitmap(blob), canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height;
    const context = canvas.getContext('2d')!; context.drawImage(bitmap, 0, 0); const data = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
    const origin = 'capture' in image ? { x: image.capture.mapping.crop.x, y: image.capture.mapping.crop.y, scaleX: image.capture.mapping.scaleX, scaleY: image.capture.mapping.scaleY } : { x: 0, y: 0, scaleX: bitmap.width / innerWidth, scaleY: bitmap.height / innerHeight };
    return regions.map(({ window, kind, color }) => {
      const matches = { red: (r: number, g: number, b: number) => r > 180 && g < 100 && b < 100, pin: (r: number, g: number, b: number) => b - r > 45 && g - r > 20, ink: (r: number, g: number, b: number) => Math.max(r, g, b) < 200, bright: (r: number, g: number, b: number) => Math.min(r, g, b) > 100, color: (r: number, g: number, b: number) => [r, g, b].every((channel, index) => Math.abs(channel - color![index]) <= 2) };
      const left = Math.max(0, Math.floor((window.x - origin.x) * origin.scaleX)), top = Math.max(0, Math.floor((window.y - origin.y) * origin.scaleY));
      const right = Math.min(bitmap.width, Math.ceil((window.x + window.width - origin.x) * origin.scaleX)), bottom = Math.min(bitmap.height, Math.ceil((window.y + window.height - origin.y) * origin.scaleY));
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (let y = top; y < bottom; y++) for (let x = left; x < right; x++) { const offset = (y * bitmap.width + x) * 4; if (matches[kind](data[offset], data[offset + 1], data[offset + 2])) { minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); } }
      return Number.isFinite(minX) ? { left: origin.x + minX / origin.scaleX, top: origin.y + minY / origin.scaleY, right: origin.x + (maxX + 1) / origin.scaleX, bottom: origin.y + (maxY + 1) / origin.scaleY } : null;
    });
  }, { image: 'capture' in image ? image : { screenshot: Array.from(image.screenshot) }, regions });
}

function annotationBubblePolygon(anchor: Point, scaleX: number, scaleY: number): Point[] {
  const sizeX = 28 * scaleX, sizeY = 28 * scaleY, left = anchor.x - 4 * sizeX / 24, top = anchor.y - 21 * sizeY / 24;
  const points: Point[] = [], add = (x: number, y: number) => points.push({ x: left + x * sizeX / 24, y: top + y * sizeY / 24 });
  add(7, 3); add(17, 3);
  for (let index = 1; index <= 8; index++) { const angle = -Math.PI / 2 + index * Math.PI / 16; add(17 + 4 * Math.cos(angle), 7 + 4 * Math.sin(angle)); }
  add(21, 14);
  for (let index = 1; index <= 8; index++) { const angle = index * Math.PI / 16; add(17 + 4 * Math.cos(angle), 14 + 4 * Math.sin(angle)); }
  add(9, 18); add(4, 21); add(4, 7);
  for (let index = 1; index <= 8; index++) { const angle = Math.PI + index * Math.PI / 16; add(7 + 4 * Math.cos(angle), 7 + 4 * Math.sin(angle)); }
  return points;
}

function pointInPolygon(point: Point, polygon: Point[]) {
  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index++) {
    const current = polygon[index], prior = polygon[previous];
    if ((current.y > point.y) !== (prior.y > point.y) && point.x < (prior.x - current.x) * (point.y - current.y) / (prior.y - current.y) + current.x) inside = !inside;
  }
  return inside;
}

function distanceToSegmentSquared(point: Point, start: Point, end: Point) {
  const dx = end.x - start.x, dy = end.y - start.y, length = dx * dx + dy * dy;
  if (length === 0) return (point.x - start.x) ** 2 + (point.y - start.y) ** 2;
  const ratio = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / length));
  const nearest = { x: start.x + ratio * dx, y: start.y + ratio * dy };
  return (point.x - nearest.x) ** 2 + (point.y - nearest.y) ** 2;
}

/** The scene renderer paints this exact 28px bubble path; the edge allowance covers its 1.5px stroke and one raster fringe. */
function annotationBubblePixel(anchor: Point, scaleX: number, scaleY: number, column: number, row: number) {
  const polygon = annotationBubblePolygon(anchor, scaleX, scaleY), point = { x: column + .5, y: row + .5 };
  if (pointInPolygon(point, polygon)) return true;
  const edgeAllowance = (1.5 * (28 / 24) / 2 + .5) * Math.max(scaleX, scaleY);
  return polygon.some((start, index) => distanceToSegmentSquared(point, start, polygon[(index + 1) % polygon.length]) <= edgeAllowance ** 2);
}

function isCanvasBackground(pixel: Pixel) {
  return Math.abs(pixel[0] - 252) <= 3 && Math.abs(pixel[1] - 252) <= 3 && Math.abs(pixel[2] - 250) <= 3;
}

function isBlueAnnotationPixel(pixel: Pixel) {
  return pixel[2] - pixel[0] > 45 && pixel[1] - pixel[0] > 20;
}

function scenePixelStats(pixels: ArrayLike<number>, width: number, height: number, anchor: Point, scaleX: number, scaleY: number) {
  let blue = 0, outside = 0;
  for (let row = 0; row < height; row++) for (let column = 0; column < width; column++) {
    const offset = (row * width + column) * 4, pixel = [pixels[offset], pixels[offset + 1], pixels[offset + 2]] as Pixel;
    const bubble = annotationBubblePixel(anchor, scaleX, scaleY, column, row);
    if (bubble && isBlueAnnotationPixel(pixel)) blue++;
    if (!isCanvasBackground(pixel) && !bubble) outside++;
  }
  return { blue, outside };
}

test('point bubble mask follows the tail anchor and rejects stray control pixels', () => {
  const anchor = { x: 96, y: 96 }, mask = (column: number, row: number) => annotationBubblePixel(anchor, 1, 1, column, row);
  assert.equal(mask(105, 80), true); assert.equal(mask(96, 96), true);
  assert.equal(mask(90, 80), false); assert.equal(mask(116, 96), false);
  const pixels = new Uint8ClampedArray(121 * 126 * 4); for (let offset = 0; offset < pixels.length; offset += 4) pixels.set([252, 252, 250, 255], offset);
  pixels.set([123, 188, 255, 255], (80 * 121 + 105) * 4); pixels.set([123, 188, 255, 255], (96 * 121 + 96) * 4); pixels.set([32, 32, 32, 255], (20 * 121 + 20) * 4);
  assert.deepEqual(scenePixelStats(pixels, 121, 126, anchor, 1, 1), { blue: 2, outside: 1 });
});
/** Counts 2D canvas drawing and presentation confirms; displaying, hovering and panning the board need neither. */
async function boardWork(page: Page) {
  const presented: string[] = []; page.on('request', request => { if (request.method() === 'PUT' && new URL(request.url()).pathname.endsWith('/presented')) presented.push(request.url()); });
  await page.evaluate(() => {
    const scope = window as any; scope.boardDraws = 0;
    for (const method of ['drawImage', 'putImageData', 'fillRect', 'strokeRect', 'clearRect', 'fill', 'stroke', 'fillText', 'strokeText'] as const) {
      const original = CanvasRenderingContext2D.prototype[method] as (...args: unknown[]) => unknown;
      Object.defineProperty(CanvasRenderingContext2D.prototype, method, { configurable: true, writable: true, value(this: CanvasRenderingContext2D, ...args: unknown[]) { scope.boardDraws++; return original.apply(this, args); } });
    }
  });
  return async () => ({ draws: await page.evaluate(() => (window as any).boardDraws as number), presented: presented.length });
}
const grown = (area: Area, by: number): Area => ({ x: area.x - by, y: area.y - by, width: area.width + by * 2, height: area.height + by * 2 });
function sameBox(actual: Box | null, expected: Box | null, label: string, tolerance = 1) {
  assert(actual && expected, `${label}: ${JSON.stringify({ actual, expected })}`);
  for (const edge of ['left', 'top', 'right', 'bottom'] as const) assert(Math.abs(actual[edge] - expected[edge]) <= tolerance, `${label} ${edge}: ${JSON.stringify({ actual, expected })}`);
}
/** Base scene responses can be marked near expiry, and the next request can be held after the service created it. */
async function sceneRoute(page: Page) {
  const state = { nearExpiry: false, armed: undefined as undefined | { entered: () => void; gate: Promise<void> }, snapshots: [] as { id: string; held: boolean }[] };
  await page.route('**/capture-views/*/scenes', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    const response = await route.fetch(), body = await response.json(), held = state.armed; state.armed = undefined;
    if (state.nearExpiry && response.ok()) body.expiresAt = new Date(Date.now() + 30_000).toISOString();
    state.snapshots.push({ id: body.id, held: !!held });
    if (held) { held.entered(); await held.gate; }
    await route.fulfill({ response, json: body }).catch(() => undefined);
  });
  return { state, hold: () => { let entered!: () => void, release!: () => void; const reached = new Promise<void>(resolve => entered = resolve), gate = new Promise<void>(resolve => release = resolve); state.armed = { entered, gate }; return { entered: reached, release }; } };
}

async function fixture(t: test.TestContext, narrow = false) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'acanvas-chatbox-ui-')));
  const evidence = await realpath(await mkdtemp(join(tmpdir(), 'acanvas-chatbox-evidence-'))); t.diagnostic(`Evidence: ${evidence}`);
  const running = await startServer({ root, port: 0, webRoot: resolve(process.env.ACANVAS_TEST_WEB_ROOT || 'dist/web'), browser: { headless: true } });
  const session = running.service.createSession('Chatbox acceptance');
  const observation: { page?: Page } = {};
  t.after(async () => {
    try {
      const page = observation.page;
      if (page && !page.isClosed()) await page.screenshot({ path: join(evidence, 'final-ui.png'), timeout: 5_000 });
      const state = running.service.state(session.id);
      await writeFile(join(evidence, 'state.json'), JSON.stringify(state, null, 2));
      const annotations = [...state.draft.annotations, ...state.tasks.flatMap(task => task.snapshot.annotations)];
      for (const [index, annotation] of annotations.entries()) if (annotation.capture) { const bytes = await readFile(running.service.assetPath(annotation.capture.screenshotAssetId)).catch(() => undefined); if (bytes) await writeFile(join(evidence, `capture-${index + 1}.png`), bytes); }
    } finally { try { await running.close(); } finally { await rm(root, { recursive: true, force: true }); } }
  });
  await running.browser.open(session.id);
  const page = running.browser.page(session.id)!;
  observation.page = page;
  await page.context().addInitScript(installSceneOracle); await page.evaluate(installSceneOracle);
  if (narrow) await page.setViewportSize({ width: 320, height: 700 });
  await expect(page.locator('#whiteboard')).toBeVisible();
  await expect(page.locator('.composer')).toHaveAttribute('data-save-state', 'saved');
  const bootstrap = await (await fetch(`${running.url}/api/bootstrap`)).json();
  const call = async (path: string, method = 'GET', body?: unknown) => {
    const response = await fetch(`${running.url}${path}`, { method, headers: { Authorization: `Bearer ${bootstrap.token}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const result = await response.json(); assert(response.ok, JSON.stringify(result)); return result;
  };
  const importAsset = async (name: string, mime: string, data: Uint8Array) => {
    const response = await fetch(`${running.url}/api/assets?name=${encodeURIComponent(name)}&mime=${encodeURIComponent(mime)}`, { method: 'POST', headers: { Authorization: `Bearer ${bootstrap.token}` }, body: data as BodyInit });
    assert(response.ok); return response.json() as Promise<Asset>;
  };
  const image = async (name = 'Reference.png') => {
    const data = await page.evaluate(() => { const canvas = document.createElement('canvas'); canvas.width = 400; canvas.height = 240; const context = canvas.getContext('2d')!; context.fillStyle = '#e4e7ee'; context.fillRect(0, 0, 400, 240); context.fillStyle = '#24456d'; context.fillRect(50, 40, 300, 160); return canvas.toDataURL('image/png').split(',')[1]; });
    return importAsset(name, 'image/png', Buffer.from(data, 'base64'));
  };
  const object = async (asset: Asset, bounds = { x: 400, y: 300, width: 300, height: 180 }) => {
    const before = running.service.objects().map(value => value.id);
    await call('/api/board/operations', 'POST', { sessionId: session.id, operations: [{ type: 'create', object: { assetId: asset.id, ...bounds } }] });
    const value = running.service.objects().find(item => !before.includes(item.id))!;
    await expect(page.locator(`[data-object-id="${value.id}"]`)).toBeVisible(); return value;
  };
  const saved = async () => { await expect(page.locator('.composer')).toHaveAttribute('data-save-state', 'saved'); return running.service.draft(session.id); };
  const select = async (value: BoardObject) => { await page.locator(`[data-object-id="${value.id}"]`).focus(); await page.keyboard.press('Enter'); };
  const mark = async (start: { x: number; y: number }, end?: { x: number; y: number }) => {
    await page.getByRole('button', { name: 'Mark canvas', exact: true }).click();
    await page.mouse.move(start.x, start.y); await page.mouse.down(); if (end) await page.mouse.move(end.x, end.y); await page.mouse.up();
    await expect(page.getByRole('textbox', { name: 'Add a comment', exact: true })).toBeVisible();
  };
  const done = async (text: string, beforeDone?: () => Promise<void>) => {
    const editor = page.getByRole('textbox', { name: 'Add a comment', exact: true });
    const annotationId = await editor.locator('xpath=ancestor::*[@data-annotation-id][1]').getAttribute('data-annotation-id');
    assert(annotationId);
    await editor.fill(text); await expect(editor).toHaveValue(text);
    await beforeDone?.();
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    try { await expect.poll(() => {
      const annotation = running.service.draft(session.id).annotations.find(value => value.id === annotationId);
      return annotation?.captureState?.status === 'complete' && annotation.capture?.version === annotation.captureState.version;
    }, { timeout: 15_000 }).toBe(true); }
    catch (cause) { t.diagnostic(JSON.stringify(running.service.draft(session.id).annotations.find(value => value.id === annotationId))); throw cause; }
    await expect(page.locator('.capture-progress')).toHaveCount(0); const annotation = (await saved()).annotations.find(value => value.id === annotationId)!; await assertSceneCopy(page, annotation); return annotation;
  };

  return { root, evidence, running, session, page, call, importAsset, image, object, saved, select, mark, done, state: () => running.service.state(session.id) };
}

test('chatbox selection previews are consumed by real input focus, Escape and direct reference-only Send', async t => {
  const app = await fixture(t), { page } = app;
  const asset = await app.image(), first = await app.object(asset), second = await app.object(asset, { x: 770, y: 300, width: 300, height: 180 });
  await app.select(first); await expect(page.locator('[data-reference-preview]')).toBeVisible();
  assert.deepEqual((await app.saved()).references.objectIds, []);
  await page.locator('#instruction').evaluate(element => (element as HTMLTextAreaElement).focus());
  assert.deepEqual((await app.saved()).references.objectIds, []);
  await page.locator('#instruction').evaluate(element => { (element as HTMLTextAreaElement).blur(); window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab' })); (element as HTMLTextAreaElement).focus(); });
  assert.deepEqual((await app.saved()).references.objectIds, []);
  await page.locator('#instruction').click(); await expect(page.locator('.chatbox-reference')).toHaveCount(1);
  await page.getByRole('button', { name: 'Remove reference Reference.png', exact: true }).click();
  await expect(page.locator('[data-reference-preview]')).toHaveCount(0); await expect(page.locator('.chatbox-reference')).toHaveCount(0);
  await app.select(first); await page.locator('#whiteboard').focus(); await page.keyboard.press('Escape');
  await expect(page.locator('[data-reference-preview]')).toHaveCount(0);
  await app.select(first); await app.select(second); await page.getByRole('button', { name: 'Send request', exact: true }).click();
  await expect(page.locator('.queue-item')).toHaveCount(1);
  const task = app.state().tasks[0]; assert.deepEqual(task.snapshot.requestReferences?.objectIds, [second.id]); assert.deepEqual(task.snapshot.requestReferences?.attachmentIds, []);
  assert.equal(task.snapshot.userRequest.text, ''); assert.match(task.requirementText, /Reference\.png/);
  await app.select(first); await page.locator('.composer-more').focus(); await page.keyboard.press('Tab');
  await expect(page.locator('.chatbox-reference')).toHaveCount(1);
});

test('chatbox @ search orders object and task identities and keeps IME, paste and attachment semantics', async t => {
  const app = await fixture(t), { page } = app;
  const asset = await app.image('Shared asset.png'), first = await app.object(asset), second = await app.object(asset, { x: 780, y: 300, width: 300, height: 180 });
  await page.locator('#instruction').fill('Earlier request'); await page.getByRole('button', { name: 'Send request', exact: true }).click(); await expect(page.locator('.queue-item')).toHaveCount(1);
  await page.locator('#instruction').fill('@Request'); await page.keyboard.press('Enter');
  await page.keyboard.type('@Shared'); await page.keyboard.press('Enter');
  await page.keyboard.type('@Shared'); await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter');
  const draft = await app.saved(); assert.deepEqual(draft.references.order, [{ kind: 'task', id: app.state().tasks[0].id, textOffset: 0 }, { kind: 'object', id: first.id, textOffset: 0 }, { kind: 'object', id: second.id, textOffset: 0 }]);
  assert.deepEqual(draft.attachments, []); assert.equal(draft.text, '');
  await page.keyboard.type('Literal @unknown name'); await page.keyboard.press('Escape');
  await page.locator('#instruction').dispatchEvent('compositionstart'); await page.locator('#instruction').dispatchEvent('keydown', { key: 'Enter', keyCode: 229, isComposing: true });
  assert.equal(app.state().tasks.length, 1); await page.locator('#instruction').dispatchEvent('compositionend');
  await page.locator('#instruction').dispatchEvent('paste'); await page.keyboard.press('Escape'); await page.getByRole('button', { name: 'Send request', exact: true }).click();
  await expect(page.locator('.queue-item')).toHaveCount(2); assert.equal(app.state().tasks[1].snapshot.userRequest.text, 'Literal @unknown name');
  assert.deepEqual(app.state().tasks[1].snapshot.requestReferences?.order?.map(value => `${value.kind}:${value.id}`), draft.references.order?.map(value => `${value.kind}:${value.id}`));
});

async function editorSelection(page: Page, start: number, end = start) {
  await page.locator('#instruction').evaluate((element, selection) => {
    const root = element as HTMLElement; root.focus();
    const point = (position: number): [Node, number] => {
      let cursor = 0;
      for (const node of Array.from(root.childNodes)) {
        const length = node.nodeType === Node.TEXT_NODE ? node.textContent?.length || 0 : 1;
        if (node.nodeType === Node.TEXT_NODE && position <= cursor + length) return [node, position - cursor];
        if (position <= cursor) return [root, Array.from(root.childNodes).indexOf(node)];
        cursor += length;
      }
      return [root, root.childNodes.length];
    };
    const range = document.createRange(); range.setStart(...point(selection.start)); range.setEnd(...point(selection.end));
    window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range); document.dispatchEvent(new Event('selectionchange'));
  }, { start, end });
}

async function editorParts(page: Page) {
  return page.locator('#instruction').evaluate(element => Array.from(element.childNodes).flatMap<{ text: string } | { kind?: string; id?: string; preview: boolean }>(node => node.nodeType === Node.TEXT_NODE ? node.textContent ? [{ text: node.textContent }] : [] : (node as HTMLElement).dataset.editorReference ? [{ kind: (node as HTMLElement).dataset.editorKind, id: (node as HTMLElement).dataset.editorReference, preview: (node as HTMLElement).dataset.editorPreview === 'true' }] : []));
}

test('chatbox inline previews insert two independent objects at the last caret and restore send, refresh and queue edit positions', async t => {
  const app = await fixture(t), { page } = app;
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const asset = await app.image('Two instances.png'), first = await app.object(asset), second = await app.object(asset, { x: 770, y: 300, width: 300, height: 180 });
  await page.locator('#instruction').fill('before after'); await editorSelection(page, 7);
  await app.select(first); await page.locator(`[data-object-id="${second.id}"]`).focus(); await page.keyboard.press('Shift+Enter');
  await expect(page.locator('[data-reference-preview]')).toHaveCount(2);
  assert.deepEqual(await editorParts(page), [{ text: 'before ' }, { kind: 'object', id: first.id, preview: true }, { kind: 'object', id: second.id, preview: true }, { text: 'after' }]);
  await page.locator('.composer').screenshot({ path: join(app.evidence, 'inline-previews.png') });
  await page.locator('#instruction').focus(); assert.deepEqual((await app.saved()).references.objectIds, []);
  await page.locator('.composer-more').focus(); await page.keyboard.press('Tab');
  await expect(page.locator('#instruction .chatbox-reference')).toHaveCount(2);
  const expected: RequestReference[] = [{ kind: 'object', id: first.id, textOffset: 7 }, { kind: 'object', id: second.id, textOffset: 7 }];
  assert.deepEqual((await app.saved()).references.order, expected);
  assert.deepEqual(await editorParts(page), [{ text: 'before ' }, { kind: 'object', id: first.id, preview: false }, { kind: 'object', id: second.id, preview: false }, { text: 'after' }]);
  await page.locator('.composer').screenshot({ path: join(app.evidence, 'inline-confirmed.png') });
  await page.reload(); await expect(page.locator('#instruction .chatbox-reference')).toHaveCount(2); assert.deepEqual((await app.saved()).references.order, expected);
  await page.getByRole('button', { name: 'Send request', exact: true }).click(); await expect(page.locator('.queue-item')).toHaveCount(1);
  const task = app.state().tasks[0]; assert.equal(task.snapshot.userRequest.text, 'before after'); assert.deepEqual(task.snapshot.requestReferences?.order?.map(({ kind, id, textOffset }) => ({ kind, id, textOffset })), expected);
  assert(task.requirementText.indexOf('before ') < task.requirementText.indexOf(first.id)); assert(task.requirementText.indexOf(second.id) < task.requirementText.indexOf('after'));
  await page.getByRole('button', { name: /View request 1:/ }).click(); await expect(page.locator('.task-instruction .task-inline-reference')).toHaveCount(2);
  const rendered = await page.locator('.task-instruction').innerText(); assert.match(rendered, /^before .*Two instances\.png.*Two instances\.png.*after$/s);
  await page.getByRole('button', { name: 'Edit request 1', exact: true }).click(); await expect(page.getByRole('button', { name: 'Save edit', exact: true })).toBeVisible();
  assert.deepEqual((await app.saved()).references.order, expected);
  await editorSelection(page, 0); await page.keyboard.type('new '); await page.getByRole('button', { name: 'Save edit', exact: true }).click();
  await expect(page.locator('.composer-editing')).toHaveCount(0);
  const changed = app.state().tasks[0]; assert.equal(changed.id, task.id); assert.equal(changed.snapshot.userRequest.text, 'new before after'); assert.deepEqual(changed.snapshot.requestReferences?.order?.map(entry => entry.textOffset), [11, 11]);
  assert.deepEqual(errors, []);
});

test('chatbox inline atoms support native caret movement, both delete keys, cross selection, Unicode, IME and plaintext paste', async t => {
  const app = await fixture(t), { page } = app;
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const first = await app.object(await app.image('Left.png')), second = await app.object(await app.image('Right.png'), { x: 770, y: 300, width: 300, height: 180 });
  await page.locator('#instruction').fill('😀left right'); await editorSelection(page, 7);
  await app.select(first); await page.getByRole('button', { name: 'Add selected Left.png to request', exact: true }).click();
  assert.deepEqual((await app.saved()).references.order?.map(entry => entry.textOffset), [7]);
  await editorSelection(page, 8); await page.keyboard.press('ArrowLeft'); await page.keyboard.type('X');
  assert.equal((await app.saved()).text, '😀left Xright'); assert.equal((await app.saved()).references.order?.[0].textOffset, 8);
  await page.keyboard.press('Delete'); assert.deepEqual((await app.saved()).references.objectIds, []); assert.equal((await app.saved()).text, '😀left Xright');
  await editorSelection(page, 7); await page.keyboard.type('@Left'); await page.keyboard.press('Enter');
  assert.equal((await app.saved()).references.order?.[0].textOffset, 7); await page.keyboard.press('Backspace'); assert.deepEqual((await app.saved()).references.objectIds, []);
  await editorSelection(page, 7); await page.keyboard.type('@Left'); await page.keyboard.press('Enter'); await page.keyboard.type('@Right'); await page.keyboard.press('Enter');
  assert.deepEqual((await app.saved()).references.objectIds, [first.id, second.id]);
  await editorSelection(page, 7, 12); await page.keyboard.press('Backspace');
  assert.equal((await app.saved()).text, '😀left ght'); assert.deepEqual((await app.saved()).references.objectIds, []);
  await editorSelection(page, 2); await page.keyboard.press('Shift+Enter'); await page.keyboard.type('中文');
  await page.locator('#instruction').evaluate(element => {
    const data = new DataTransfer(); data.setData('text/plain', '<b>plain</b>\nnext'); data.setData('text/html', '<strong>rich</strong>');
    element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }));
  });
  assert.equal((await app.saved()).text, '😀\n中文<b>plain</b>\nnextleft ght'); assert.equal(await page.locator('#instruction strong,#instruction b').count(), 0);
  await page.locator('#instruction').dispatchEvent('compositionstart'); await page.locator('#instruction').dispatchEvent('keydown', { key: 'Enter', keyCode: 229, isComposing: true });
  assert.equal(app.state().tasks.length, 0); await page.locator('#instruction').dispatchEvent('compositionend');
  await editorSelection(page, 0); await page.keyboard.type('@Right'); await page.keyboard.press('Enter');
  assert.equal((await app.saved()).references.order?.[0].textOffset, 0);
  await page.reload(); await expect(page.locator('#instruction .chatbox-reference')).toHaveCount(1); assert.equal((await app.saved()).references.order?.[0].textOffset, 0);
  assert.deepEqual(errors, []);
});

test('chatbox native composition, backward keyboard selection and delayed rerenders keep the caret and independent atoms', async t => {
  const app = await fixture(t), { page } = app;
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const object = await app.object(await app.image('Native reference.png'));
  await page.locator('#instruction').fill('left right'); await editorSelection(page, 5);
  await app.select(object); await page.getByRole('button', { name: 'Add selected Native reference.png to request', exact: true }).click();
  await editorSelection(page, 0);
  const cdp = await page.context().newCDPSession(page);
  await page.locator('#instruction').evaluate(element => { (window as any).editorCompositionEvents = []; ['compositionstart', 'compositionend'].forEach(name => element.addEventListener(name, () => (window as any).editorCompositionEvents.push(name))); });
  await cdp.send('Input.imeSetComposition', { text: '你', selectionStart: 1, selectionEnd: 1 });
  await page.locator('#instruction').dispatchEvent('keydown', { key: 'Enter', keyCode: 229, isComposing: true }); assert.equal(app.state().tasks.length, 0);
  await cdp.send('Input.insertText', { text: '你好' }); await cdp.detach();
  const composed = await app.saved(); assert.equal(composed.text, '你好left right'); assert.equal(composed.references.order?.[0].textOffset, 7);
  assert.deepEqual(await page.evaluate(() => (window as any).editorCompositionEvents), ['compositionstart', 'compositionend']);
  await editorSelection(page, 8); await page.keyboard.press('Shift+ArrowLeft'); await page.keyboard.press('Shift+ArrowLeft'); await page.keyboard.press('Backspace');
  const removed = await app.saved(); assert.equal(removed.text, '你好leftright'); assert.deepEqual(removed.references.objectIds, []);
  await editorSelection(page, 2); await page.keyboard.type(' X');
  await app.saved(); await page.keyboard.type('Y'); assert.equal((await app.saved()).text, '你好 XYleftright');
  await editorSelection(page, 5); await app.select(object); await page.locator('.composer-more').focus(); await page.locator('#instruction').focus();
  assert.deepEqual((await app.saved()).references.objectIds, []);
  await page.getByRole('button', { name: 'Add selected Native reference.png to request', exact: true }).click(); assert.equal((await app.saved()).references.order?.[0].textOffset, 5);
  await page.locator('#instruction').fill('@Native'); await page.keyboard.press('Enter'); await page.keyboard.press('Shift+Enter'); await page.locator('#instruction').pressSequentially('After reference');
  assert.equal((await app.saved()).text, '\nAfter reference'); assert.equal((await app.saved()).references.order?.[0].textOffset, 0);
  await page.locator('#instruction').fill('First line'); await page.keyboard.press('Shift+Enter'); await page.locator('#instruction').pressSequentially('Second line');
  assert.equal((await app.saved()).text, 'First line\nSecond line');
  await page.keyboard.press('Shift+Enter'); await page.keyboard.press('Shift+Enter'); await page.keyboard.type('Final');
  assert.equal((await app.saved()).text, 'First line\nSecond line\n\nFinal');
  await page.locator('#instruction').fill('');
  await page.keyboard.insertText('Native first\nNative second'); assert.equal((await app.saved()).text, 'Native first\nNative second');
  await page.locator('#instruction').fill(''); await page.keyboard.insertText('\nLeading\n\n'); assert.equal((await app.saved()).text, '\nLeading\n\n');
  assert.deepEqual(errors, []);
});

test('chatbox independent inline previews and formal atoms wrap within 320px light and dark themes', async t => {
  const app = await fixture(t, true), { page } = app;
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const first = await app.object(await app.image('A longer independent source name.png')), second = await app.object(await app.image('Another independent source name.png'), { x: 770, y: 300, width: 300, height: 180 });
  await page.locator('#instruction').fill('Before after'); await editorSelection(page, 7);
  await app.select(first); await page.locator(`[data-object-id="${second.id}"]`).focus(); await page.keyboard.press('Shift+Enter');
  for (const theme of ['light', 'dark']) {
    if (theme === 'dark') { await page.getByRole('button', { name: 'Theme', exact: true }).click(); await page.getByRole('menuitemradio', { name: 'Dark', exact: true }).click(); }
    await expect(page.locator('[data-reference-preview]')).toHaveCount(2);
    const rects = await page.locator('[data-reference-preview]').evaluateAll(elements => elements.map(element => { const box = element.getBoundingClientRect(); return { x: box.x, right: box.right, width: box.width }; }));
    rects.forEach(rect => { assert(rect.x >= 0 && rect.right <= 321 && rect.width > 80); });
    await page.locator('.composer').screenshot({ path: join(app.evidence, `inline-320-${theme}-preview.png`) });
  }
  await page.locator('.composer-more').focus(); await page.keyboard.press('Tab'); await expect(page.locator('#instruction .chatbox-reference')).toHaveCount(2);
  const form = await page.locator('.composer').boundingBox(); assert(form && form.x >= 0 && form.x + form.width <= 321);
  await page.locator('.composer').screenshot({ path: join(app.evidence, 'inline-320-dark-confirmed.png') });
  assert.equal(await page.locator('#instruction').evaluate(element => element.scrollWidth <= element.clientWidth + 1), true);
});

test('chatbox legacy grouped draft and snapshot references use the shared body-tail fallback', async t => {
  const app = await fixture(t), { page } = app;
  await page.locator('#instruction').fill('Earlier source'); await page.keyboard.press('Enter'); await expect(page.locator('.queue-item')).toHaveCount(1);
  const earlier = app.state().tasks[0], asset = await app.image('Legacy shared.png'), first = await app.object(asset), second = await app.object(asset, { x: 770, y: 300, width: 300, height: 180 });
  await app.call(`/api/sessions/${app.session.id}/draft`, 'PUT', { ...await app.saved(), text: 'Legacy words', references: { objectIds: [first.id, second.id], taskIds: [earlier.id] } });
  await page.reload(); await expect(page.locator('#instruction .chatbox-reference')).toHaveCount(3);
  assert.deepEqual(await editorParts(page), [{ text: 'Legacy words' }, { kind: 'object', id: first.id, preview: false }, { kind: 'object', id: second.id, preview: false }, { kind: 'task', id: earlier.id, preview: false }]);
  assert((await app.saved()).references.order?.every(reference => reference.textOffset === undefined));
  await page.getByRole('button', { name: 'Send request', exact: true }).click(); await expect(page.locator('.queue-item')).toHaveCount(2);
  const task = app.state().tasks[1];
  await page.route('**/api/state?*', async route => {
    const response = await route.fetch(), value = await response.json();
    const legacy = value.tasks.find((item: { id: string }) => item.id === task.id); delete legacy.snapshot.requestReferences.order;
    await route.fulfill({ response, json: value });
  });
  await page.reload(); await page.locator('.queue-expand').click(); await page.getByRole('button', { name: /View request 2:/ }).click();
  await expect(page.locator(`.task-card[data-task-id="${task.id}"] .task-inline-reference`)).toHaveCount(3);
  assert.deepEqual(await page.locator(`.task-card[data-task-id="${task.id}"] .task-inline-reference`).evaluateAll(elements => elements.map(element => element.getAttribute('data-reference-id'))), [first.id, second.id, earlier.id]);
  assert.match(await page.locator(`.task-card[data-task-id="${task.id}"] .task-instruction`).innerText(), /^Legacy words.*Legacy shared\.png.*Legacy shared\.png.*Request /s);
  await page.unroute('**/api/state?*');
  await page.route('**/api/state?*', async route => {
    const response = await route.fetch(), value = await response.json(); delete value.tasks.find((item: { id: string }) => item.id === task.id).snapshot.requestReferences;
    await route.fulfill({ response, json: value });
  });
  await page.reload(); await page.locator('.queue-expand').click(); await page.getByRole('button', { name: /View request 2:/ }).click(); await expect(page.locator(`.task-card[data-task-id="${task.id}"] .task-inline-reference`)).toHaveCount(3);
});

test('chatbox nonempty inline references reconcile held saves and SSE by business fields independently of JSON key order', async t => {
  const app = await fixture(t), { page } = app;
  const object = await app.object(await app.image('Ordered source.png'));
  await page.locator('#instruction').fill('Body tail'); await editorSelection(page, 5); await app.select(object);
  await page.getByRole('button', { name: 'Add selected Ordered source.png to request', exact: true }).click(); await app.saved();
  await page.route('**/api/state?*', async route => {
    const response = await route.fetch(), value = await response.json();
    value.draft.references = { order: value.draft.references.order?.map(({ kind, id, textOffset }: RequestReference) => ({ id, ...(textOffset === undefined ? {} : { textOffset }), kind })), taskIds: value.draft.references.taskIds, objectIds: value.draft.references.objectIds };
    await route.fulfill({ response, json: value });
  });
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>(resolve => release = resolve), saving = new Promise<void>(resolve => entered = resolve);
  let delay = true;
  await page.route('**/api/sessions/*/draft', async route => {
    if (route.request().method() === 'PUT' && delay) { delay = false; const response = await route.fetch(); entered(); await held; await route.fulfill({ response }); }
    else await route.continue();
  });
  await editorSelection(page, 0); await page.keyboard.type('first '); await saving;
  await expect(page.locator('.composer')).toHaveAttribute('data-save-state', 'saved'); await expect(page.locator('.draft-conflict')).toHaveCount(0);
  await page.keyboard.type('later '); release();
  const value = await app.saved(); assert.equal(value.text, 'first later Body tail'); assert.deepEqual(value.references.order, [{ kind: 'object', id: object.id, textOffset: 17 }]);
  await expect(page.locator('.draft-conflict')).toHaveCount(0); assert.equal(await page.locator('#instruction .chatbox-reference').count(), 1);
  await page.reload(); await expect(page.locator('#instruction .chatbox-reference')).toHaveCount(1); assert.equal((await app.saved()).text, value.text);
});

test('chatbox native text replacement preserves two atoms, exact multiline text and empty-body offsets through refresh and Send', async t => {
  const app = await fixture(t), { page } = app;
  const first = await app.object(await app.image('First kept source.png')), second = await app.object(await app.image('Second kept source.png'), { x: 770, y: 300, width: 300, height: 180 }), third = await app.object(await app.image('Third inserted source.png'), { x: 1100, y: 300, width: 200, height: 120 });
  const entries = [first, second].map(object => ({ kind: 'object' as const, id: object.id, textOffset: 0 }));
  await app.call(`/api/sessions/${app.session.id}/draft`, 'PUT', { ...await app.saved(), references: { objectIds: [first.id, second.id], taskIds: [], order: entries } });
  await page.reload(); await expect(page.locator('#instruction .chatbox-reference')).toHaveCount(2);
  await page.locator('#instruction').evaluate(element => {
    (element as HTMLElement).focus(); const range = document.createRange(); range.setStart(element, 0); range.collapse(true); window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range);
  });
  const body = '保持主体的轮廓与比例。\n留出标题空间。\n使用现有参考中的色彩。';
  await page.keyboard.insertText(body);
  assert.equal((await app.saved()).text, body); assert.deepEqual((await app.saved()).references.order?.map(reference => reference.textOffset), [body.length, body.length]);
  let currentBody = body;
  for (const key of ['Backspace', 'Delete']) {
    await editorSelection(page, 0, currentBody.length); await page.keyboard.press(key);
    const empty = await app.saved(); assert.equal(empty.text, ''); assert.deepEqual(empty.references.order, entries); await expect(page.locator('#instruction .chatbox-reference')).toHaveCount(2);
    await page.keyboard.type('X'); await page.keyboard.press('Backspace'); assert.equal((await app.saved()).text, ''); assert.deepEqual((await app.saved()).references.order, entries);
    currentBody = key === 'Backspace' ? '\n' + body + '\n\n' : body;
    await page.keyboard.insertText(currentBody); const current = await app.saved(); assert.equal(current.text, currentBody); assert.deepEqual(current.references.order?.map(reference => reference.textOffset), [currentBody.length, currentBody.length]);
  }
  await editorSelection(page, body.length); await page.keyboard.press('Shift+Enter'); assert.deepEqual((await app.saved()).references.order?.map(reference => reference.textOffset), [body.length + 1, body.length + 1]);
  await page.keyboard.press('Shift+Enter'); assert.deepEqual((await app.saved()).references.order?.map(reference => reference.textOffset), [body.length + 2, body.length + 2]);
  await page.locator('#instruction').evaluate(element => { const data = new DataTransfer(); data.setData('text/plain', 'Pasted line\n'); element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data })); });
  assert.equal((await app.saved()).text, body + '\n\nPasted line\n');
  await page.keyboard.type('After newline @Third'); await page.keyboard.press('Enter');
  const value = await app.saved(); assert.equal(value.text, body + '\n\nPasted line\nAfter newline '); assert.deepEqual(value.references.order?.map(reference => reference.id), [third.id, first.id, second.id]);
  await page.reload(); await expect(page.locator('#instruction .chatbox-reference')).toHaveCount(3); assert.equal((await app.saved()).text, value.text);
  await page.getByRole('button', { name: 'Send request', exact: true }).click(); await expect(page.locator('.queue-item')).toHaveCount(1);
  const task = app.state().tasks[0]; assert.equal(task.snapshot.userRequest.text, value.text); assert.deepEqual(task.snapshot.requestReferences?.order?.map(({ kind, id, textOffset }) => ({ kind, id, textOffset })), value.references.order);
});

test('managed React Done captures blank points, cross-object regions and historical scenes with separate current locate', async t => {
  const app = await fixture(t), { page } = app;
  const object = await app.object(await app.image());
  await app.mark({ x: 950, y: 450 }); const blank = await app.done('Blank space');
  assert.equal(blank.scope, 'region'); assert.equal(blank.geometry, 'point'); assert.equal(blank.bounds.width, 0); assert(blank.capture); assert.equal(blank.capture.scene.objects.length, 0);
  await app.mark({ x: 380, y: 340 }, { x: 520, y: 410 }); const cross = await app.done('Across one boundary');
  assert.equal(cross.scope, 'region'); assert.deepEqual(cross.objectIds, []); assert(cross.capture?.scene.objects.some(value => value.object.id === object.id)); assert.deepEqual((await app.saved()).references.objectIds, []);
  await app.mark({ x: 520, y: 360 }); const target = await app.done('On the image'); assert.equal(target.objectId, object.id); assert.equal(target.geometry, 'point');
  const png = await fetch(`${app.running.url}/api/assets/${target.capture!.screenshotAssetId}/content?sessionId=${app.session.id}`, { headers: { Authorization: `Bearer ${(await (await fetch(`${app.running.url}/api/bootstrap`)).json()).token}` } });
  assert(png.ok); assert.equal(png.headers.get('content-type'), 'image/png'); assert((await png.arrayBuffer()).byteLength > 500);
  await page.getByRole('button', { name: 'Send request', exact: true }).click(); await expect(page.locator('.queue-item')).toHaveCount(1); await expect(page.locator('.annotation-outline')).toHaveCount(0);
  await page.getByRole('button', { name: /View request 1:/ }).click();
  await page.getByRole('button', { name: 'View annotation 3: On the image', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Captured annotation', exact: true })).toBeVisible(); await expect(page.locator('.annotation-outline')).toHaveCount(0);
  await page.getByRole('button', { name: 'Locate current target', exact: true }).click();
  assert.equal(app.state().tasks[0].snapshot.annotations[2].capture?.id, target.capture?.id);
});

async function redrawAt(page: Page, x: number, y: number) {
  await page.getByRole('button', { name: 'Mark canvas', exact: true }).click();
  await page.mouse.click(x, y);
  await expect(page.getByRole('button', { name: 'Mark canvas', exact: true })).toHaveAttribute('aria-pressed', 'false');
}

test('managed React target edits require a new capture while text edits preserve the original image', async t => {
  const app = await fixture(t), { page } = app;
  const object = await app.object(await app.image()); await app.mark({ x: 520, y: 360 }); const original = await app.done('Original comment');
  await page.locator('.draft-annotation .annotation-content').click(); await page.getByRole('textbox', { name: 'Annotation text', exact: true }).fill('Edited words');
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  const textOnly = (await app.saved()).annotations[0]; assert.equal(textOnly.capture?.id, original.capture?.id); assert.equal(textOnly.captureState?.version, 1);
  await page.locator('.draft-annotation .annotation-content').click();
  await redrawAt(page, 730, 360);
  await expect(page.locator('.draft-annotation')).toHaveAttribute('data-capture-state', 'incomplete'); await expect(page.getByRole('button', { name: 'Send request', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Done', exact: true }).click(); await expect(page.locator('.draft-annotation')).toHaveAttribute('data-capture-state', 'complete');
  const retargeted = (await app.saved()).annotations[0]; assert.equal(retargeted.captureState?.version, 2); assert.notEqual(retargeted.capture?.id, original.capture?.id); assert.equal(retargeted.scope, 'region'); assert.deepEqual(retargeted.objectIds, []);
  assert(retargeted.capture?.scene.objects.some(value => value.object.id === object.id));
  await page.reload(); await expect(page.locator('.draft-annotation')).toHaveAttribute('data-capture-state', 'complete'); assert.equal((await app.saved()).annotations[0].text, 'Edited words');
});

test('managed React delayed saves retain the newer target and capture cancellation invalidates late uploads', { timeout: 90_000 }, async t => {
  const app = await fixture(t), { page } = app;
  const asset = await app.image(); const first = await app.object(asset), second = await app.object(asset, { x: 760, y: 300, width: 300, height: 180 });
  await app.mark({ x: 520, y: 360 }); await app.done('Stable words');
  let releaseSave!: () => void, enteredSave!: () => void;
  const held = new Promise<void>(resolve => releaseSave = resolve), entered = new Promise<void>(resolve => enteredSave = resolve);
  let delayed = false;
  await page.route('**/api/sessions/*/draft', async route => {
    if (route.request().method() === 'PUT' && !delayed) { delayed = true; const response = await route.fetch(); enteredSave(); await held; await route.fulfill({ response }); }
    else await route.continue();
  });
  await page.locator('.draft-annotation .annotation-content').click(); await redrawAt(page, 730, 360); await enteredStage(entered);
  await redrawAt(page, 520, 360);
  await expect(page.locator('.draft-annotation')).toHaveAttribute('data-capture-state', 'incomplete'); releaseSave();
  const changed = (await app.saved()).annotations[0]; assert.equal(changed.objectId, first.id); assert.equal(changed.captureState?.status, 'incomplete'); assert.equal(changed.capture, undefined); assert(changed.captureState!.version >= 2);
  await page.unroute('**/api/sessions/*/draft');
  let releaseCapture!: () => void, enteredCapture!: () => void;
  const heldCapture = new Promise<void>(resolve => releaseCapture = resolve), enteredCapturePromise = new Promise<void>(resolve => enteredCapture = resolve);
  await page.route('**/captures/*/content', async route => { if (route.request().method() !== 'PUT') return route.continue(); enteredCapture(); await heldCapture; await route.continue().catch(() => undefined); });
  await page.getByRole('button', { name: 'Done', exact: true }).click(); await enteredStage(enteredCapturePromise);
  await expect(page.locator('.app-shell')).toHaveAttribute('data-capturing', 'true'); await expect(page.getByText(/Capturing|Capture required|Retry/, { exact: false })).toHaveCount(0);
  await page.getByRole('combobox', { name: 'Request', exact: true }).focus(); await page.keyboard.press('ControlOrMeta+A'); await page.keyboard.press('Backspace'); await page.keyboard.insertText('The newer request survives capture cancellation.');
  await page.keyboard.press('Escape'); releaseCapture(); await page.unroute('**/captures/*/content');
  await expect(page.locator('.capture-progress')).toHaveCount(0);
  const cancelled = (await app.saved()).annotations[0]; assert.equal(cancelled.text, 'Stable words'); assert.equal(cancelled.captureState?.status, 'incomplete'); assert(cancelled.captureState!.version > changed.captureState!.version); assert.equal((await app.saved()).text, 'The newer request survives capture cancellation.');
  await page.locator('.draft-annotation .annotation-content').click(); await redrawAt(page, 820, 360);
  await page.getByRole('button', { name: 'Done', exact: true }).click(); await expect(page.locator('.draft-annotation')).toHaveAttribute('data-capture-state', 'complete');
  assert.equal((await app.saved()).annotations[0].objectId, second.id);
});

test('ordinary pages complete Done and Send through the project API on the same page', { timeout: 60_000 }, async t => {
  const app = await fixture(t), { page } = app;
  const ordinary = await page.context().newPage(), originalURL = `${app.running.url}/?session=${app.session.id}`; await ordinary.goto(originalURL);
  await expect(ordinary.locator('#whiteboard')).toBeVisible(); assert.equal(await ordinary.evaluate(() => !!window.acanvasCaptureProvider), false);
  await ordinary.getByRole('button', { name: 'Mark canvas', exact: true }).click(); await ordinary.mouse.click(900, 400);
  await ordinary.getByRole('textbox', { name: 'Add a comment', exact: true }).fill('Keep this ordinary page scene.'); await ordinary.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(ordinary.locator('.draft-annotation')).toHaveAttribute('data-capture-state', 'complete'); await expect(ordinary.locator('.draft-annotation img')).toBeVisible();
  const annotation = (await app.saved()).annotations[0]; assert.equal(annotation.text, 'Keep this ordinary page scene.'); await assertSceneCopy(ordinary, annotation);
  await expect(ordinary.getByRole('button', { name: 'Open capture window', exact: true })).toHaveCount(0); assert.equal(page.context().pages().length, 2);
  await ordinary.getByRole('combobox', { name: 'Request', exact: true }).fill('Use the saved page scene.'); await ordinary.getByRole('button', { name: 'Send request', exact: true }).click();
  await expect(ordinary.locator('.queue-item')).toHaveCount(1); const task = app.state().tasks[0]; assert.equal(task.snapshot.annotations[0].capture!.id, annotation.capture!.id); assert.equal(ordinary.url(), originalURL); await ordinary.close();
});

test('managed React refresh exposes a lost captured image and explicitly recaptures a new version', async t => {
  const app = await fixture(t), { page } = app;
  await app.mark({ x: 900, y: 400 }); const original = await app.done('Preserve this comment');
  await rm(app.running.service.assetPath(original.capture!.screenshotAssetId));
  let releaseQuery!: () => void, enteredQuery!: () => void;
  const heldQuery = new Promise<void>(resolve => releaseQuery = resolve), queryEntered = new Promise<void>(resolve => enteredQuery = resolve);
  let delayed = false;
  await page.route('**/captures/1', async route => {
    if (route.request().method() === 'GET' && !delayed) { delayed = true; const response = await route.fetch(); assert.equal(response.status(), 404); enteredQuery(); await heldQuery; await route.fulfill({ response }); }
    else await route.continue();
  });
  await page.reload(); await expect(page.locator('.draft-annotation')).toHaveAttribute('data-capture-state', 'unavailable');
  await queryEntered;
  await expect(page.getByRole('button', { name: 'Send request', exact: true })).toBeDisabled();
  await page.locator('.draft-annotation .annotation-content').click(); await page.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(page.locator('.draft-annotation')).toHaveAttribute('data-capture-state', 'complete');
  const replacement = (await app.saved()).annotations[0]; assert.equal(replacement.text, 'Preserve this comment'); assert.equal(replacement.captureState?.version, 2); assert.notEqual(replacement.capture?.screenshotAssetId, original.capture?.screenshotAssetId);
  await expect(page.getByRole('button', { name: 'Send request', exact: true })).toBeEnabled();
  const lateResponse = page.waitForResponse(response => response.url().endsWith('/captures/1') && response.status() === 404);
  releaseQuery(); await (await lateResponse).finished();
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(page.locator('.draft-annotation')).toHaveAttribute('data-capture-state', 'complete'); await expect(page.getByRole('button', { name: 'Send request', exact: true })).toBeEnabled();
  assert.equal((await app.saved()).annotations[0].capture?.id, replacement.capture?.id);
  await writeFile(join(app.evidence, 'late-query-owner.json'), JSON.stringify({ delayedRealResponse: 404, oldVersion: 1, currentVersion: replacement.captureState?.version, currentCaptureId: replacement.capture?.id, statusAfterOldError: 'complete', sendEnabled: true }, null, 2));
  await page.unroute('**/captures/1');
});

test('visible Canvas evidence excludes native controls while capture cancellation stays usable', { timeout: 60_000 }, async t => {
  const app = await fixture(t), { page } = app;
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => release = resolve), captureEntered = new Promise<void>(resolve => entered = resolve);
  await page.route('**/captures/*/content', async route => { if (route.request().method() !== 'PUT') return route.continue(); entered(); await gate; await route.continue(); });
  await app.mark({ x: 1415, y: 970 }); await page.getByRole('textbox', { name: 'Add a comment', exact: true }).fill('Bottom-right point'); await page.getByRole('button', { name: 'Done', exact: true }).click(); await enteredStage(captureEntered);
  await expect(page.locator('.app-shell')).toHaveAttribute('data-capturing', 'true'); await expect(page.getByText(/Capturing|Capture required|Retry/, { exact: false })).toHaveCount(0); await expect(page.locator('.project-identity')).toBeVisible(); await expect(page.getByRole('button', { name: 'Zoom in', exact: true })).toBeEnabled();
  assert.equal(await page.locator('.app-shell').getAttribute('data-sampling'), null);
  const uploaded = page.waitForResponse(response => response.request().method() === 'PUT' && /\/captures\/[^/]+\/content$/.test(new URL(response.url()).pathname) && response.ok()); release(); await (await uploaded).finished(); await page.unroute('**/captures/*/content'); await expect(page.locator('.draft-annotation')).toHaveAttribute('data-capture-state', 'complete'); const corner = (await app.saved()).annotations[0]; await assertSceneCopy(page, corner);
  const capture = corner.capture!, anchor = { x: (capture.worldBounds.x * capture.viewport.zoom + capture.viewport.x - capture.mapping.crop.x) * capture.mapping.scaleX, y: (capture.worldBounds.y * capture.viewport.zoom + capture.viewport.y - capture.mapping.crop.y) * capture.mapping.scaleY }, cssScale = capture.presentation!.camera.zoom / capture.viewport.zoom;
  const bitmap = await page.evaluate(async value => {
    const response = await fetch(`/api/assets/${value.screenshotAssetId}/content?sessionId=${value.sessionId}`); const image = await createImageBitmap(await response.blob());
    const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height; canvas.getContext('2d')!.drawImage(image, 0, 0); image.close();
    return { width: canvas.width, height: canvas.height, pixels: Array.from(canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data) };
  }, capture);
  const stats = scenePixelStats(bitmap.pixels, bitmap.width, bitmap.height, anchor, cssScale * capture.mapping.scaleX, cssScale * capture.mapping.scaleY);
  assert(stats.blue > 15); assert.equal(stats.outside, 0);
  await app.mark({ x: 8, y: 8 }, { x: 1432, y: 992 }); const full = await app.done('Whole visible scene');
  const pixels = await page.evaluate(async capture => {
    const response = await fetch(`/api/assets/${capture.screenshotAssetId}/content?sessionId=${capture.sessionId}`), bitmap = await createImageBitmap(await response.blob());
    const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height; const context = canvas.getContext('2d')!; context.drawImage(bitmap, 0, 0);
    return [[24, 24], [1390, 960], [500, 500]].map(([x, y]) => [...context.getImageData(Math.floor((x - capture.mapping.crop.x) * capture.mapping.scaleX), Math.floor((y - capture.mapping.crop.y) * capture.mapping.scaleY), 1, 1).data]);
  }, full.capture!);
  assert.deepEqual(pixels[0], pixels[2]); assert.deepEqual(pixels[1], pixels[2]);
});

test('managed React records Markdown intent and displayed anchors and keeps the native HTML source instance and form', { timeout: 90_000 }, async t => {
  const app = await fixture(t), { page } = app;
  const md = await app.importAsset('Notes.md', 'text/markdown', Buffer.from(Array.from({ length: 30 }, (_, i) => `## Block ${i}\n\nObserved paragraph ${i} with stable text.\n`).join('\n')));
  const mdObject = await app.object(md, { x: 220, y: 250, width: 340, height: 300 });
  const scroller = page.locator(`[data-object-id="${mdObject.id}"] .markdown-content`);
  await expect(scroller.locator('p').first()).toBeVisible();
  await scroller.evaluate(element => { element.scrollTop = 210; const paragraph = element.querySelectorAll('p')[2].firstChild!; const range = document.createRange(); range.setStart(paragraph, 0); range.setEnd(paragraph, 18); const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range); });
  await app.mark({ x: 300, y: 380 }); const annotated = await app.done('Selected document text');
  assert.equal(annotated.contentAnchor?.kind, 'text'); assert.equal(annotated.contentAnchor?.scroll?.y, 210); assert(annotated.contentAnchor?.quote); assert(annotated.contentAnchor?.path?.startsWith('rendered-dom:'));
  assert.equal(annotated.capture?.scene.objects.find(value => value.object.id === mdObject.id)?.scroll?.y, 210);
  const surfaces: string[] = [];
  page.on('request', request => { if (request.method() === 'POST' && /\/html-surfaces$/.test(new URL(request.url()).pathname)) surfaces.push(request.url()); });
  const html = await app.importAsset('Live.html', 'text/html', Buffer.from('<!doctype html><style>body{margin:0;background:#cff0e8;font:20px sans-serif}input{font:20px sans-serif}</style><input id="value" aria-label="Live value" value="initial"><p id="identity"></p><p id="clock">Live scene</p><script>window.identity=Math.random();document.querySelector("#identity").textContent="Instance "+window.identity;setInterval(()=>document.querySelector("#clock").style.color=["red","blue"][Math.floor(Date.now()/100)%2],100)</script>'));
  const htmlObject = await app.object(html, { x: 730, y: 250, width: 350, height: 240 }), htmlContent = page.locator(`[data-object-id="${htmlObject.id}"] .html-content`);
  await expect(htmlContent.locator('iframe, .html-snapshot').first()).toBeVisible({ timeout: 20_000 });
  await htmlContent.hover();
  await expect(htmlContent).toHaveAttribute('data-preview-state', 'live');
  const frame = htmlContent.frameLocator('iframe'), liveInput = frame.getByRole('textbox', { name: 'Live value', exact: true });
  await expect(liveInput).toHaveValue('initial');
  const source = await htmlContent.locator('iframe').getAttribute('src');
  await liveInput.click(); await liveInput.press('ControlOrMeta+A'); await liveInput.press('Backspace'); await liveInput.pressSequentially('Saved live input');
  await expect(liveInput).toHaveValue('Saved live input');
  await app.mark({ x: 830, y: 280 });
  const comment = page.getByRole('textbox', { name: 'Add a comment', exact: true });
  await comment.fill('Keep the native HTML state');
  await expect(comment).toBeFocused(); await expect(comment).toHaveValue('Keep the native HTML state');
  const captured = await app.done('Keep the native HTML state'); assert.equal(captured.objectId, htmlObject.id);
  const htmlLayer = captured.capture!.presentation!.layers.find(value => value.objectId === htmlObject.id); assert(htmlLayer); assert.equal(htmlLayer.surface, undefined);
  assert.equal(captured.capture!.presentation!.layers.filter(value => value.surface).length, 0);
  assert.deepEqual(captured.capture!.scene.objects.find(value => value.object.id === htmlObject.id)?.scroll, { x: 0, y: 0 });
  const htmlPixel = await page.evaluate(async capture => { const image = await createImageBitmap(await (await fetch(`/api/assets/${capture.screenshotAssetId}/content?sessionId=${capture.sessionId}`)).blob()), canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height; canvas.getContext('2d')!.drawImage(image, 0, 0); return [...canvas.getContext('2d')!.getImageData(Math.floor((1000 - capture.mapping.crop.x) * capture.mapping.scaleX), Math.floor((450 - capture.mapping.crop.y) * capture.mapping.scaleY), 1, 1).data]; }, captured.capture!);
  for (const [index, channel] of [0xcf, 0xf0, 0xe8].entries()) assert(Math.abs(htmlPixel[index] - channel) <= 3, JSON.stringify(htmlPixel));
  await expect(liveInput).toHaveValue('Saved live input'); assert.equal(await htmlContent.locator('iframe').getAttribute('src'), source); assert.equal(surfaces.length, 0);
  const composer = page.locator('#instruction');
  await composer.click(); await composer.pressSequentially('Composer keeps focus');
  await expect(composer).toBeFocused(); assert.equal((await app.saved()).text, 'Composer keeps focus');
  await expect(liveInput).toHaveValue('Saved live input');
  await liveInput.click({ position: { x: 12, y: 10 } }); await expect(liveInput).toBeFocused();
  await liveInput.press('ControlOrMeta+A');
  await expect.poll(() => liveInput.evaluate((input: HTMLInputElement) => [input.selectionStart, input.selectionEnd])).toEqual([0, 'Saved live input'.length]);
  await liveInput.press('ArrowRight');
  await expect.poll(() => liveInput.evaluate((input: HTMLInputElement) => [input.selectionStart, input.selectionEnd])).toEqual(['Saved live input'.length, 'Saved live input'.length]);
  await liveInput.pressSequentially(' again');
  await expect(liveInput).toHaveValue('Saved live input again');
  await expect(liveInput).toBeFocused(); assert.equal(await htmlContent.locator('iframe').getAttribute('src'), source);
});

test('managed React saves independent video/audio selections and actual playback positions', async t => {
  const app = await fixture(t), { page } = app;
  const video = await app.importAsset('Clip.mp4', 'video/mp4', await readFile(resolve('app/tests/fixtures/frontend-video.mp4')));
  const audio = await app.importAsset('Sound.mp3', 'audio/mpeg', await readFile(resolve('app/tests/fixtures/reference-tone.mp3')));
  const videoObject = await app.object(video, { x: 300, y: 280, width: 300, height: 180 }), audioObject = await app.object(audio, { x: 760, y: 300, width: 480, height: 100 });
  await page.locator(`[data-object-id="${videoObject.id}"] video`).evaluate(async element => { const video = element as HTMLVideoElement; await new Promise<void>(resolve => { if (video.readyState > 0) resolve(); else video.addEventListener('loadedmetadata', () => resolve(), { once: true }); }); video.currentTime = Math.min(.4, video.duration / 2); await video.play(); });
  await app.mark({ x: 440, y: 360 }); const videoNote = await app.done('Video interval');
  assert.equal(videoNote.timeStart, 0); assert(videoNote.timeEnd && videoNote.timeEnd > 0); assert(videoNote.capture?.scene.objects.find(value => value.object.id === videoObject.id)?.media?.playbackTime! > 0);
  await page.locator(`[data-object-id="${audioObject.id}"] audio`).evaluate(element => { (element as HTMLAudioElement).currentTime = .2; });
  await app.mark({ x: 950, y: 340 }); const audioNote = await app.done('Audio whole selection');
  assert.equal(audioNote.timeStart, undefined); assert.equal(audioNote.snapshotAssetId, undefined); assert(audioNote.capture?.scene.objects.find(value => value.object.id === audioObject.id)?.media?.playbackTime! >= .2);
  const phases: Record<string, unknown>[] = [];
  const record = async (name: string, annotation: AnnotationInput, objectId: string) => {
    await writeFile(join(app.evidence, `${name}.png`), await readFile(app.running.service.assetPath(annotation.capture!.screenshotAssetId)));
    phases.push({ name, annotationId: annotation.id, timeStart: annotation.timeStart, timeEnd: annotation.timeEnd, temporalSelection: annotation.timeStart === undefined ? 'whole' : annotation.timeEnd === undefined ? 'point' : 'interval', version: annotation.captureState?.version, captureId: annotation.capture?.id, screenshotAssetId: annotation.capture?.screenshotAssetId, representativeFrameAssetId: annotation.snapshotAssetId, actualPlaybackTime: annotation.capture?.scene.objects.find(value => value.object.id === objectId)?.media?.playbackTime, target: annotation.capture?.target });
  };
  await record('video-whole', videoNote, videoObject.id); await record('audio-whole', audioNote, audioObject.id);
  const videoPlayer = page.locator(`[data-object-id="${videoObject.id}"] video`);
  await videoPlayer.evaluate(element => { const media = element as HTMLVideoElement; media.pause(); media.currentTime = .35; });
  await expect.poll(() => videoPlayer.evaluate(element => (element as HTMLVideoElement).readyState)).toBeGreaterThanOrEqual(2);
  await page.locator('.draft-annotation .annotation-content').nth(0).click();
  await expect(page.locator('.annotation-time-range')).toHaveAttribute('data-ready', 'true');
  const start = page.getByRole('slider', { name: 'Start point', exact: true }), end = page.getByRole('slider', { name: 'End point', exact: true });
  await start.press('ArrowRight'); await start.press('ArrowRight'); await end.press('ArrowLeft'); await end.press('ArrowLeft');
  await expect(page.locator('.draft-annotation').nth(0)).toHaveAttribute('data-capture-state', 'incomplete');
  await expect(page.getByRole('button', { name: 'Send request', exact: true })).toBeDisabled();
  const videoDuration = await videoPlayer.evaluate(element => (element as HTMLVideoElement).duration);
  await expect(start).toHaveAttribute('aria-valuenow', '0.2');
  const selectedVideoEnd = Number(await end.getAttribute('aria-valuenow')); assert(selectedVideoEnd > .2 && selectedVideoEnd < videoDuration);
  assert(Math.abs(await videoPlayer.evaluate(element => (element as HTMLVideoElement).currentTime) - .35) < .01);
  await page.locator('.annotation-full').screenshot({ path: join(app.evidence, 'video-partial-editor.png') });
  await page.getByRole('button', { name: 'Done', exact: true }).click(); await expect(page.locator('.draft-annotation').nth(0)).toHaveAttribute('data-capture-state', 'complete');
  const partialVideo = (await app.saved()).annotations[0];
  assert.equal(partialVideo.text, videoNote.text); assert.equal(partialVideo.timeStart, .2); assert.equal(partialVideo.timeEnd, selectedVideoEnd); assert(partialVideo.captureState!.version > videoNote.captureState!.version);
  assert.notEqual(partialVideo.capture?.id, videoNote.capture?.id); assert.notEqual(partialVideo.snapshotAssetId, videoNote.snapshotAssetId); assert.notEqual(partialVideo.snapshotAssetId, partialVideo.capture?.screenshotAssetId);
  assert.equal(partialVideo.capture?.target.timeStart, .2); assert.equal(partialVideo.capture?.target.timeEnd, selectedVideoEnd);
  assert(Math.abs(partialVideo.capture!.scene.objects.find(value => value.object.id === videoObject.id)!.media!.playbackTime! - .35) < .01);
  await record('video-partial', partialVideo, videoObject.id);
  await writeFile(join(app.evidence, 'video-partial-representative-frame.png'), await readFile(app.running.service.assetPath(partialVideo.snapshotAssetId!)));
  await expect(page.locator('.capture-progress')).toHaveCount(0); await page.locator('.draft-annotation .annotation-content').nth(0).click(); await expect(page.getByRole('textbox', { name: 'Annotation text', exact: true })).toBeFocused(); await end.press('Home');
  await expect(page.locator('.annotation-range-selection')).toHaveAttribute('data-point', 'true'); await expect(end).toHaveAttribute('aria-valuenow', '0.2');
  await page.getByRole('button', { name: 'Done', exact: true }).click(); await expect(page.locator('.draft-annotation').nth(0)).toHaveAttribute('data-capture-state', 'complete');
  const videoPoint = (await app.saved()).annotations[0]; assert.equal(videoPoint.timeStart, .2); assert.equal(videoPoint.timeEnd, undefined); assert(videoPoint.captureState!.version > partialVideo.captureState!.version); assert.notEqual(videoPoint.capture?.id, partialVideo.capture?.id); assert.equal(videoPoint.snapshotAssetId, partialVideo.snapshotAssetId);
  assert(Math.abs(videoPoint.capture!.scene.objects.find(value => value.object.id === videoObject.id)!.media!.playbackTime! - .35) < .01); await record('video-point', videoPoint, videoObject.id);
  const audioPlayer = page.locator(`[data-object-id="${audioObject.id}"] audio`);
  const audioHead = await audioPlayer.evaluate(element => { const media = element as HTMLAudioElement; media.pause(); const head = Math.min(.12, media.duration * .05); media.currentTime = head; return head; });
  await page.locator('.draft-annotation .annotation-content').nth(1).click(); await expect(page.locator('.annotation-time-range')).toHaveAttribute('data-ready', 'true');
  await page.locator('.annotation-full').evaluate(async element => { await Promise.all(element.getAnimations({ subtree: true }).map(animation => animation.finished.catch(() => {}))); });
  const track = (await page.locator('.annotation-range-timeline').boundingBox())!;
  await page.mouse.move(track.x + track.width * .25, track.y + track.height / 2); await page.mouse.down(); await page.mouse.move(track.x + track.width * .75, track.y + track.height / 2, { steps: 5 }); await page.mouse.up();
  const selectedAudioStart = Number(await start.getAttribute('aria-valuenow')), selectedAudioEnd = Number(await end.getAttribute('aria-valuenow'));
  const audioDuration = await audioPlayer.evaluate(element => (element as HTMLAudioElement).duration);
  assert(selectedAudioStart > 0 && selectedAudioEnd > selectedAudioStart); assert(selectedAudioEnd < audioDuration);
  assert(Math.abs(selectedAudioStart - Math.round(audioDuration * .25 * 100) / 100) < .011); assert(Math.abs(selectedAudioEnd - Math.round(audioDuration * .75 * 100) / 100) < .011);
  assert(Math.abs(await audioPlayer.evaluate(element => (element as HTMLAudioElement).currentTime) - audioHead) < .01); assert(Math.abs(selectedAudioStart - audioHead) > .01);
  await page.locator('.annotation-full').screenshot({ path: join(app.evidence, 'audio-partial-editor.png') });
  await page.getByRole('button', { name: 'Done', exact: true }).click(); await expect(page.locator('.draft-annotation').nth(1)).toHaveAttribute('data-capture-state', 'complete');
  const partialAudio = (await app.saved()).annotations[1]; assert.equal(partialAudio.text, audioNote.text); assert.equal(partialAudio.timeStart, selectedAudioStart); assert.equal(partialAudio.timeEnd, selectedAudioEnd); assert(partialAudio.captureState!.version > audioNote.captureState!.version); assert.notEqual(partialAudio.capture?.id, audioNote.capture?.id); assert.equal(partialAudio.snapshotAssetId, undefined);
  assert(Math.abs(partialAudio.capture!.scene.objects.find(value => value.object.id === audioObject.id)!.media!.playbackTime! - audioHead) < .01); await record('audio-partial', partialAudio, audioObject.id);
  await expect(page.locator('.capture-progress')).toHaveCount(0); await page.locator('.draft-annotation .annotation-content').nth(1).click(); await expect(page.getByRole('textbox', { name: 'Annotation text', exact: true })).toBeFocused(); await end.press('Home'); await expect(page.locator('.annotation-range-selection')).toHaveAttribute('data-point', 'true');
  let releaseUpload!: () => void, enteredUpload!: () => void;
  const uploadGate = new Promise<void>(resolve => releaseUpload = resolve), uploaded = new Promise<void>(resolve => enteredUpload = resolve); let responseHeld = false;
  await page.route('**/captures/*/content', async route => {
    if (route.request().method() !== 'PUT' || responseHeld) return route.continue(); responseHeld = true;
    const response = await route.fetch(); assert.equal(response.status(), 200); enteredUpload(); await uploadGate; await route.fulfill({ response });
  });
  await page.getByRole('button', { name: 'Done', exact: true }).click(); await enteredStage(uploaded); await expect(page.locator('.draft-annotation').nth(1)).toHaveAttribute('data-capture-state', 'complete');
  await expect(page.locator('.draft-annotation .annotation-content').nth(1)).toBeDisabled(); await expect(page.locator('.draft-annotation .annotation-content').nth(1)).toHaveAttribute('aria-busy', 'true');
  const committedDuringResponseHold = app.running.service.draft(app.session.id).annotations[1]; assert.equal(committedDuringResponseHold.captureState?.status, 'complete'); assert.equal(committedDuringResponseHold.timeEnd, undefined);
  releaseUpload(); await expect(page.locator('.capture-progress')).toHaveCount(0); await expect(page.locator('.draft-annotation .annotation-content').nth(1)).toBeEnabled(); await page.unroute('**/captures/*/content');
  const audioPoint = (await app.saved()).annotations[1]; assert.equal(audioPoint.timeStart, selectedAudioStart); assert.equal(audioPoint.timeEnd, undefined); assert(audioPoint.captureState!.version > partialAudio.captureState!.version); assert.notEqual(audioPoint.capture?.id, partialAudio.capture?.id); assert.equal(audioPoint.snapshotAssetId, undefined);
  assert(Math.abs(audioPoint.capture!.scene.objects.find(value => value.object.id === audioObject.id)!.media!.playbackTime! - audioHead) < .01); await record('audio-point', audioPoint, audioObject.id);
  await writeFile(join(app.evidence, 'media-time-phases.json'), JSON.stringify({ interaction: { videoPartial: 'native keyboard ArrowRight / ArrowLeft', audioPartial: 'native pointer drag 25% to 75%', temporalPoints: 'End handle Home clamps end to chosen start' }, committedUiVisibleBeforeUploadResponse: true, phases }, null, 2));
});

test('managed React captures GIF, file cards, mixed scenes and the actual overlapping target', async t => {
  const app = await fixture(t), { page } = app;
  const gif = await app.importAsset('Animation.gif', 'image/gif', await readFile(resolve('app/tests/fixtures/animated-reference.gif')));
  const file = await app.importAsset('Source.bin', 'application/octet-stream', Buffer.from('Generic source document'));
  const gifObject = await app.object(gif, { x: 350, y: 290, width: 300, height: 180 }), fileObject = await app.object(file, { x: 790, y: 310, width: 280, height: 150 });
  await expect(page.locator(`[data-object-id="${gifObject.id}"] [data-scene-media="gif"]`)).toBeVisible(); await expect(page.locator(`[data-object-id="${gifObject.id}"] [data-scene-media="gif"]`)).toHaveAttribute('data-frame-index', /\d+/);
  await app.mark({ x: 470, y: 380 }); const gifNote = await app.done('The visible GIF frame'); assert.equal(gifNote.assetId, gif.id); assert(gifNote.capture?.screenshotAssetId);
  await app.mark({ x: 920, y: 390 }); const fileNote = await app.done('The visible file card'); assert.equal(fileNote.assetId, file.id); assert(fileNote.capture?.scene.objects.some(value => value.object.id === fileObject.id));
  await app.mark({ x: 330, y: 270 }, { x: 1100, y: 490 }); const mixed = await app.done('Across media boundaries');
  assert.equal(mixed.scope, 'region'); assert.deepEqual(mixed.objectIds, []); assert.equal(mixed.timeStart, undefined); assert.deepEqual(mixed.capture?.scene.objects.map(value => value.object.id), [gifObject.id, fileObject.id]);
  const back = await app.object(await app.image('Overlapping image.png'), { x: 350, y: 290, width: 300, height: 180 });
  await page.locator(`[data-object-id="${gifObject.id}"]`).evaluate(element => (element as HTMLElement).style.zIndex = '5');
  await app.mark({ x: 560, y: 430 }); const top = await app.done('Top painted target'); assert.equal(top.objectId, back.id);
  await app.call('/api/board/operations', 'POST', { sessionId: app.session.id, operations: [{ type: 'update', objectId: back.id, expectedVersion: back.version, changes: { x: 1200 } }] });
  await expect(page.locator(`[data-object-id="${back.id}"]`)).toHaveCSS('left', '1200px');
  await page.locator('.draft-annotation .annotation-content').last().click(); await redrawAt(page, 520, 360);
  await page.getByRole('button', { name: 'Done', exact: true }).click(); await expect(page.locator('.draft-annotation').last()).toHaveAttribute('data-capture-state', 'complete');
  assert.equal((await app.saved()).annotations.at(-1)?.objectId, gifObject.id);
  const movedBack = app.running.service.objects().find(value => value.id === back.id)!;
  await app.call('/api/board/operations', 'POST', { sessionId: app.session.id, operations: [{ type: 'update', objectId: back.id, expectedVersion: movedBack.version, changes: { x: 350 } }] });
  await expect(page.locator(`[data-object-id="${back.id}"]`)).toHaveCSS('left', '350px');
  await page.locator(`[data-object-id="${gifObject.id}"]`).evaluate(element => { const object = element as HTMLElement; object.style.borderRadius = '32px'; const media = object.querySelector<HTMLElement>('.object-media')!; media.style.backgroundColor = 'transparent'; });
  await app.mark({ x: 380, y: 350 }); const rounded = await app.done('Visible lower corners');
  assert(rounded.capture?.scene.objects.some(value => value.object.id === back.id)); assert.deepEqual((await app.saved()).references.objectIds, []);
});

test('managed marks use the top painted media owner and keep letterbox points and crossing regions in world space', async t => {
  const app = await fixture(t), { page } = app;
  const sources = await page.evaluate(() => [[400, 400, '#d93232'], [400, 200, '#254ed1']].map(([width, height, color]) => { const canvas = document.createElement('canvas'); canvas.width = Number(width); canvas.height = Number(height); const context = canvas.getContext('2d')!; context.fillStyle = String(color); context.fillRect(0, 0, canvas.width, canvas.height); return canvas.toDataURL('image/png').split(',')[1]; }));
  const red = await app.importAsset('Underlying red.png', 'image/png', Buffer.from(sources[0], 'base64')), blue = await app.importAsset('Letterboxed blue.png', 'image/png', Buffer.from(sources[1], 'base64'));
  const lower = await app.object(red, { x: 350, y: 220, width: 400, height: 400 }), upper = await app.object(blue, { x: 350, y: 220, width: 400, height: 400 });
  await expect.poll(() => page.locator(`[data-object-id="${upper.id}"] img`).evaluate(image => (image as HTMLImageElement).naturalHeight)).toBe(200);
  const visiblePNG = async () => Array.from(new Uint8Array(await page.screenshot({ caret: 'hide' })));
  const wholeWithLower = await visiblePNG(), stable = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, theme: document.documentElement.dataset.theme, focusedTag: document.activeElement?.tagName }));
  await app.call('/api/board/operations', 'POST', { sessionId: app.session.id, operations: [{ type: 'update', objectId: lower.id, expectedVersion: lower.version, changes: { x: 5000, y: 5000 } }] });
  await expect(page.locator(`[data-object-id="${lower.id}"]`)).toHaveCSS('left', '5000px'); await page.evaluate(() => new Promise(requestAnimationFrame));
  const wholeWithoutVisibleLower = await visiblePNG(); assert.deepEqual(await page.evaluate(() => ({ width: innerWidth, height: innerHeight, theme: document.documentElement.dataset.theme, focusedTag: document.activeElement?.tagName })), stable);
  const contribution = await page.evaluate(async ({ before, after }) => {
    const read = async (bytes: number[]) => { const image = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: 'image/png' })), canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height; canvas.getContext('2d')!.drawImage(image, 0, 0); image.close(); return { width: canvas.width, height: canvas.height, pixels: canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data }; };
    const a = await read(before), b = await read(after); if (a.width !== b.width || a.height !== b.height) throw new Error('The measured Canvas viewport changed.'); let wholeChannels = 0, shadowChannels = 0;
    for (let index = 0; index < a.pixels.length; index++) if (a.pixels[index] !== b.pixels[index]) { wholeChannels++; const pixel = Math.floor(index / 4), x = pixel % a.width, y = Math.floor(pixel / a.width); if (x >= 420 && x < 680 && y >= 185 && y < 220) shadowChannels++; }
    return { wholeChannels, shadowChannels, width: a.width, height: a.height, comparedShadowRegion: { x: 420, y: 185, width: 260, height: 35 } };
  }, { before: wholeWithLower, after: wholeWithoutVisibleLower });
  assert(contribution.shadowChannels > 0, JSON.stringify(contribution)); await writeFile(join(app.evidence, 'with-lower.png'), Buffer.from(wholeWithLower)); await writeFile(join(app.evidence, 'without-visible-lower.png'), Buffer.from(wholeWithoutVisibleLower)); await writeFile(join(app.evidence, 'lower-paint-contribution.json'), JSON.stringify(contribution, null, 2));
  const moved = app.running.service.objects().find(value => value.id === lower.id)!; await app.call('/api/board/operations', 'POST', { sessionId: app.session.id, operations: [{ type: 'update', objectId: lower.id, expectedVersion: moved.version, changes: { x: 350, y: 220 } }] });
  await expect(page.locator(`[data-object-id="${lower.id}"]`)).toHaveCSS('left', '350px'); await page.evaluate(() => new Promise(requestAnimationFrame));
  await app.mark({ x: 500, y: 250 }); const letterbox = await app.done('The visible white margin');
  assert.equal(letterbox.scope, 'region'); assert.deepEqual(letterbox.objectIds, []); assert.equal(letterbox.objectId, undefined);
  assert(letterbox.capture?.scene.objects.some(value => value.object.id === upper.id)); assert(letterbox.capture?.scene.objects.some(value => value.object.id === lower.id)); assert(letterbox.capture?.presentation?.layers.some(value => value.objectId === lower.id));
  await app.mark({ x: 500, y: 400 }); const content = await app.done('The visible blue image'); assert.equal(content.objectId, upper.id); assert.equal(content.assetId, blue.id);
  await app.mark({ x: 480, y: 310 }, { x: 540, y: 350 }); const cross = await app.done('Across the content boundary'); assert.equal(cross.scope, 'region'); assert.deepEqual(cross.objectIds, []);
  await app.mark({ x: 480, y: 330 }, { x: 540, y: 350 }); const contained = await app.done('Inside the visible content'); assert.equal(contained.objectId, upper.id); assert.equal(contained.coordinateSpace, 'normalized');
  assert.deepEqual((await app.saved()).references.objectIds, []);
});

test('CSS zoom keeps edge annotation controls visible and copies only the presented pixels within the page', { timeout: 60_000 }, async t => {
  const app = await fixture(t), { page } = app; await page.setViewportSize({ width: 1200, height: 850 }); await page.addStyleTag({ content: '.app-shell{zoom:1.25}' });
  const results = [];
  for (const point of [{ x: 950, y: 830 }, { x: 8, y: 8 }]) {
    await app.mark(point); const done = await page.getByRole('button', { name: 'Done', exact: true }).boundingBox(); assert(done); assert(done.x >= 0 && done.y >= 0 && done.x + done.width <= 1200 && done.y + done.height <= 850);
    const annotation = await app.done(`Keep the visible edge at ${point.x}, ${point.y}.`), capture = annotation.capture!, crop = capture.mapping.crop;
    assert(crop.x >= 0 && crop.y >= 0 && crop.x + crop.width <= 1200 + .000001 && crop.y + crop.height <= 850 + .000001);
    const mapped = { x: capture.worldBounds.x * capture.viewport.zoom + capture.viewport.x, y: capture.worldBounds.y * capture.viewport.zoom + capture.viewport.y };
    assert(Math.abs(mapped.x - point.x) < .001 && Math.abs(mapped.y - point.y) < .001); assert.equal(capture.viewport.zoom, 1.25);
    results.push({ point, done, mapped, crop, bitmap: capture.presentation!.bitmap, cssViewport: capture.presentation!.cssViewport, png: capture.image });
  }
  await page.addStyleTag({ content: '.canvas-main{left:-17.5px;top:-11.25px;width:calc(100% + 14px);height:calc(100% + 9px)}' });
  const keyboardPoint = { x: 20, y: 800 }; await app.mark(keyboardPoint); await page.getByRole('textbox', { name: 'Add a comment', exact: true }).fill('Keep the negative-origin keyboard edge.'); await page.getByRole('textbox', { name: 'Add a comment', exact: true }).press('ControlOrMeta+Enter');
  await expect(page.locator('.capture-progress')).toHaveCount(0); await expect(page.locator('.draft-annotation').last()).toHaveAttribute('data-capture-state', 'complete'); const keyboard = (await app.saved()).annotations.at(-1)!; await assertSceneCopy(page, keyboard);
  assert(keyboard.capture!.presentation!.cssViewport.x < 0 && keyboard.capture!.presentation!.cssViewport.y < 0); assert(keyboard.capture!.mapping.crop.x >= 0 && keyboard.capture!.mapping.crop.y >= 0); assert(keyboard.capture!.mapping.crop.y + keyboard.capture!.mapping.crop.height <= 850 + .000001);
  const keyboardMapped = { x: keyboard.capture!.worldBounds.x * keyboard.capture!.viewport.zoom + keyboard.capture!.viewport.x, y: keyboard.capture!.worldBounds.y * keyboard.capture!.viewport.zoom + keyboard.capture!.viewport.y }; assert(Math.abs(keyboardMapped.x - keyboardPoint.x) < .001 && Math.abs(keyboardMapped.y - keyboardPoint.y) < .001); results.push({ keyboardPoint, keyboardMapped, crop: keyboard.capture!.mapping.crop, bitmap: keyboard.capture!.presentation!.bitmap, cssViewport: keyboard.capture!.presentation!.cssViewport });
  await page.addStyleTag({ content: '.canvas-main{left:0;top:0;width:100%;height:100%}' }); await page.setViewportSize({ width: 320, height: 740 }); await app.mark({ x: 160, y: 700 }); const narrow = await app.done('Keep the resized visible edge.'); assert(narrow.capture!.mapping.crop.y + narrow.capture!.mapping.crop.height <= 740 + .000001); results.push({ narrowViewport: { width: 320, height: 740 }, crop: narrow.capture!.mapping.crop, bitmap: narrow.capture!.presentation!.bitmap, cssViewport: narrow.capture!.presentation!.cssViewport });
  await page.getByRole('combobox', { name: 'Request', exact: true }).fill('Use these exact visible edge scenes.'); await page.getByRole('button', { name: 'Send request', exact: true }).click(); await expect(page.locator('.queue-item')).toHaveCount(1); assert.equal(app.state().tasks[0].snapshot.annotations.length, 4);
  assert.equal(await page.locator('#whiteboard').evaluate(element => element.scrollTop), 0); await writeFile(join(app.evidence, 'csszoom-edges.json'), JSON.stringify(results, null, 2));
});

test('managed React 320px themes, keyboard point marking and reduced motion retain usable composer', async t => {
  const app = await fixture(t, true), { page } = app;
  await page.emulateMedia({ reducedMotion: 'reduce' });
  let count = 0;
  for (const theme of ['light', 'dark'] as const) {
    if (theme === 'dark') { await page.getByRole('button', { name: 'Theme', exact: true }).click(); await page.getByRole('menuitemradio', { name: 'Dark', exact: true }).click(); }
    await page.getByRole('button', { name: 'Mark canvas', exact: true }).click();
    if (theme === 'light') { await page.locator('#whiteboard').focus(); await page.keyboard.press('Enter'); }
    else {
      const cdp = await page.context().newCDPSession(page); await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 160, y: 350 }] }); await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await cdp.detach();
    }
    const note = await app.done(`${theme} blank point`); assert.equal(note.geometry, 'point'); assert.equal(note.bounds.width, 0);
    await expect(page.locator('.draft-annotation')).toHaveCount(++count);
    assert.equal(await page.locator('#whiteboard').evaluate(element => element.scrollLeft), 0);
    const bounds = await page.locator('.composer').boundingBox(); assert(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 321);
    await expect(page.getByRole('button', { name: 'Send request', exact: true })).toBeVisible();
    assert.equal(await page.locator('.annotation-outline.point-annotation').count(), 0);
    const pin = await page.locator('.canvas-annotation-group[data-geometry="point"]>.annotation-pin').last().boundingBox(); assert(pin && Math.abs(pin.width - 28) < 1);
  }
});

test('refinement Mark hover and clicks share displayed content ownership and clear their guides', async t => {
  const app = await fixture(t), { page } = app;
  const bottom = await app.object(await app.image('Bottom.png'), { x: 350, y: 240, width: 400, height: 400 });
  const top = await app.object(await app.image('Letterbox.png'), { x: 400, y: 280, width: 320, height: 320 });
  await expect.poll(() => page.locator(`[data-object-id="${top.id}"] img`).evaluate(image => (image as HTMLImageElement).naturalWidth)).toBe(400);
  await app.select(top);
  await expect(page.getByRole('button', { name: 'Attach to request', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Annotate', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Remove selected files from canvas', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Mark canvas', exact: true }).click();
  await page.mouse.move(550, 440); await expect(page.locator('.canvas-mark-guide')).toHaveAttribute('data-mark-target', top.id);
  await page.screenshot({ path: join(app.evidence, 'mark-hover-content.png') });
  const guide = await page.locator('.canvas-mark-guide').boundingBox(); assert(guide); assert(Math.abs(guide.y - 344) < .5); assert(Math.abs(guide.height - 192) < .5);
  await page.mouse.move(550, 300); await expect(page.locator('.canvas-mark-guide')).toHaveCount(0);
  await page.mouse.move(360, 450); await expect(page.locator('.canvas-mark-guide')).toHaveAttribute('data-mark-target', bottom.id);
  await page.mouse.move(550, 440); await page.mouse.click(550, 440);
  await expect(page.locator('.canvas-mark-guide')).toHaveCount(0); await expect(page.getByRole('combobox', { name: 'Annotation target', exact: true })).toHaveCount(0);
  assert.equal((await app.saved()).annotations.length, 0);
  const locked = await app.done('Top visible content'); assert.equal(locked.objectId, top.id);
  await page.locator('.draft-annotation .annotation-content').click(); await redrawAt(page, 550, 300);
  await page.getByRole('button', { name: 'Done', exact: true }).click(); await expect(page.locator('.draft-annotation')).toHaveAttribute('data-capture-state', 'complete'); assert.equal((await app.saved()).annotations[0].scope, 'region');
  await page.getByRole('button', { name: 'Mark canvas', exact: true }).click(); await page.mouse.move(550, 440); await expect(page.locator('.canvas-mark-guide')).toHaveCount(1);
  await page.getByRole('button', { name: 'Zoom in', exact: true }).click(); await page.mouse.move(15, 70); await expect(page.locator('.canvas-mark-guide')).toHaveCount(0);
  await page.locator('#whiteboard').focus(); await page.mouse.move(550, 440); await page.keyboard.down('Space'); await expect(page.locator('.canvas-mark-guide')).toHaveCount(0); await page.keyboard.up('Space');
  await page.mouse.move(550, 440); await page.mouse.move(-5, -5); await expect(page.locator('.canvas-mark-guide')).toHaveCount(0);
  const shown = await page.locator(`[data-object-id="${top.id}"]`).boundingBox(); assert(shown); await page.mouse.move(shown.x + shown.width / 2, shown.y + shown.height / 2); await expect(page.locator('.canvas-mark-guide')).toHaveAttribute('data-mark-target', top.id);
  await app.call('/api/board/operations', 'POST', { sessionId: app.session.id, operations: [{ type: 'delete', objectId: top.id, expectedVersion: top.version }] });
  await expect(page.locator(`[data-object-id="${top.id}"]`)).toHaveCount(0); await expect(page.locator('.canvas-mark-guide')).toHaveAttribute('data-mark-target', bottom.id);
  await page.screenshot({ path: join(app.evidence, 'mark-letterbox-ownership.png') });
});

test('Mark stationary hover follows committed deletion, overlap, camera and resize ownership', async t => {
  const app = await fixture(t), { page } = app;
  const bounds = { x: 350, y: 300, width: 250, height: 180 };
  const bottom = await app.object(await app.image('Bottom.png'), bounds);
  const top = await app.object(await app.image('Top.png'), bounds), nextAsset = await app.image('New top.png');
  const work = await boardWork(page);
  await page.getByRole('button', { name: 'Mark canvas', exact: true }).click();
  await page.mouse.move(470, 390);
  const guide = page.locator('.canvas-mark-guide');
  await expect(guide).toHaveAttribute('data-mark-target', top.id);
  await app.call('/api/board/operations', 'POST', { sessionId: app.session.id, operations: [{ type: 'delete', objectId: top.id, expectedVersion: top.version }] });
  await expect(page.locator(`[data-object-id="${top.id}"]`)).toHaveCount(0);
  await expect(guide).toHaveAttribute('data-mark-target', bottom.id);
  const next = await app.object(nextAsset, bounds);
  await expect(guide).toHaveAttribute('data-mark-target', next.id);
  await app.call('/api/board/operations', 'POST', { sessionId: app.session.id, operations: [{ type: 'update', objectId: next.id, expectedVersion: next.version, changes: { x: 900 } }] });
  await expect(guide).toHaveAttribute('data-mark-target', bottom.id);
  await page.mouse.wheel(0, 100); await expect(guide).toHaveCount(0);
  await page.mouse.wheel(0, -100); await expect(guide).toHaveAttribute('data-mark-target', bottom.id);
  await app.call('/api/board/operations', 'POST', { sessionId: app.session.id, operations: [{ type: 'update', objectId: bottom.id, expectedVersion: bottom.version, changes: { height: 80 } }] });
  await expect(guide).toHaveCount(0);
  assert.deepEqual(await work(), { draws: 0, presented: 0 });
});

test('annotation focus follows the active editor when a pending reader is closed or replaced', async t => {
  const app = await fixture(t), { page } = app;
  await app.mark({ x: 400, y: 300 }); const first = await app.done('First owner');
  await app.mark({ x: 800, y: 300 }); const second = await app.done('Second owner');
  await page.evaluate(() => {
    const buttons = document.querySelectorAll<HTMLButtonElement>('.draft-annotation .annotation-content');
    buttons[0].click(); buttons[1].click();
  });
  const editor = page.getByRole('textbox', { name: 'Annotation text', exact: true });
  await expect(editor).toHaveValue('Second owner'); await expect(editor).toBeFocused();
  await editor.press('ControlOrMeta+A'); await editor.press('ArrowRight'); await editor.pressSequentially('Z');
  await expect(editor).toHaveValue('Second ownerZ');
  await page.evaluate(() => {
    document.querySelector('.annotation-full')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    document.querySelectorAll<HTMLButtonElement>('.draft-annotation .annotation-content')[0].click();
  });
  await expect(editor).toHaveValue('First owner'); await expect(editor).toBeFocused();
  await editor.press('ControlOrMeta+A'); await editor.press('ArrowRight'); await editor.pressSequentially('Y'); await expect(editor).toHaveValue('First ownerY');
  const saved = await app.saved();
  assert.equal(saved.annotations.find(annotation => annotation.id === first.id)?.text, 'First ownerY');
  assert.equal(saved.annotations.find(annotation => annotation.id === second.id)?.text, 'Second ownerZ');
});

test('refinement collapsed comment surfaces are displayed by the DOM and keep their displayed pixels in PNG', async t => {
  const app = await fixture(t), { page } = app;
  for (const theme of ['light', 'dark']) {
    if (theme === 'dark') { await page.getByRole('button', { name: 'Theme', exact: true }).click(); await page.getByRole('menuitemradio', { name: 'Dark', exact: true }).click(); }
    const previousAnnotations = (await app.saved()).annotations;
    await app.mark({ x: 900, y: theme === 'light' ? 350 : 550 }); const first = await app.done(`${theme} short comment`);
    const currentAnnotations = (await app.saved()).annotations;
    assert.equal(currentAnnotations.length, previousAnnotations.length + 1);
    for (const previous of previousAnnotations) assert.deepEqual(currentAnnotations.find(annotation => annotation.id === previous.id), previous);
    const note = page.locator(`.canvas-annotation-comment[data-annotation-id="${first.id}"]`);
    await expect(note).toHaveCSS('opacity', '1'); assert.equal(await note.getAttribute('data-scene-drawn'), null);
    await note.evaluate(async element => { await Promise.all(element.getAnimations({ subtree: true }).map(animation => animation.finished.catch(() => {}))); });
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const surface = await note.evaluate(element => { const rect = element.getBoundingClientRect(), style = getComputedStyle(element); return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, padding: style.padding, radius: style.borderRadius, background: style.backgroundColor }; });
    assert.equal(surface.padding, '4px 8px'); assert.equal(surface.radius, '7px'); assert(surface.background.endsWith('0.84)'));
    const sample = { x: surface.x + 10, y: surface.y + 2 };
    const shown = await page.evaluate(async ({ bytes, sample }) => { const image = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: 'image/png' })), canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height; canvas.getContext('2d')!.drawImage(image, 0, 0); return [...canvas.getContext('2d')!.getImageData(Math.floor(sample.x * image.width / innerWidth), Math.floor(sample.y * image.height / innerHeight), 1, 1).data]; }, { bytes: Array.from(new Uint8Array(await page.screenshot({ caret: 'hide' }))), sample });
    for (const [index, channel] of (theme === 'light' ? [255, 255, 254] : [31, 31, 31]).entries()) assert(Math.abs(shown[index] - channel) <= 1, JSON.stringify(shown));
    await app.mark({ x: 930, y: theme === 'light' ? 410 : 610 }); const next = await app.done(`${theme} saved surface`);
    const captured = await page.evaluate(async ({ capture, sample }) => { const image = await createImageBitmap(await (await fetch(`/api/assets/${capture.screenshotAssetId}/content?sessionId=${capture.sessionId}`)).blob()); const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height; canvas.getContext('2d')!.drawImage(image, 0, 0); return [...canvas.getContext('2d')!.getImageData(Math.floor((sample.x - capture.mapping.crop.x) * capture.mapping.scaleX), Math.floor((sample.y - capture.mapping.crop.y) * capture.mapping.scaleY), 1, 1).data]; }, { capture: next.capture!, sample });
    for (let index = 0; index < 4; index++) assert(Math.abs(captured[index] - shown[index]) <= 1, JSON.stringify({ captured, shown }));
    await note.locator('button').focus(); await expect(page.getByRole('button', { name: `Comment ${theme === 'light' ? 1 : 3}: ${theme} short comment`, exact: true })).toBeFocused();
    await page.keyboard.press('Enter');
    const reopened = page.getByRole('textbox', { name: 'Annotation text', exact: true });
    await expect(reopened).toBeVisible(); await reopened.press('Escape');
    await expect(page.locator('.annotation-full')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Mark canvas', exact: true })).toHaveAttribute('aria-pressed', 'false');
    await page.screenshot({ path: join(app.evidence, `collapsed-comment-${theme}.png`) });
  }
});

test('refinement media editors separate text media and footer across narrow themes and zoom', { timeout: 90_000 }, async t => {
  const app = await fixture(t, true), { page } = app;
  const media = [await app.importAsset('Audio.mp3', 'audio/mpeg', await readFile(resolve('app/tests/fixtures/reference-tone.mp3'))), await app.importAsset('Video.mp4', 'video/mp4', await readFile(resolve('app/tests/fixtures/frontend-video.mp4')))];
  const geometry: unknown[] = [];
  for (const [index, asset] of media.entries()) {
    const object = await app.object(asset, { x: 35, y: 350, width: 250, height: index === 0 ? 190 : 160 });
    await page.locator(`[data-object-id="${object.id}"] ${index === 0 ? 'audio' : 'video'}`).evaluate(async element => { const media = element as HTMLMediaElement; if (!Number.isFinite(media.duration)) await new Promise<void>(resolve => media.addEventListener('loadedmetadata', () => resolve(), { once: true })); });
    for (const theme of ['light', 'dark']) {
      if (await page.locator('html').getAttribute('data-theme') !== theme) { await page.getByRole('button', { name: 'Theme', exact: true }).click(); await page.getByRole('menuitemradio', { name: theme === 'dark' ? 'Dark' : 'Light', exact: true }).click(); }
      await app.mark({ x: 160, y: 430 }); const input = page.getByRole('textbox', { name: 'Add a comment', exact: true }); await input.fill('Readable editable text.\n'.repeat(24));
      await expect(page.locator('.annotation-time-range')).toHaveAttribute('data-ready', 'true');
      await page.locator('.annotation-full').evaluate(async element => { await Promise.all(element.getAnimations({ subtree: true }).map(animation => animation.finished.catch(() => {}))); });
      const layout = await page.locator('.annotation-full').evaluate(element => { const rect = (selector: string) => { const r = element.querySelector(selector)!.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, bottom: r.bottom, right: r.right }; }; const text = rect('.annotation-fulltext'), media = rect('.annotation-media-control'), footer = rect('.annotation-footer'), done = rect('.annotation-done'); return { text, media, footer, done, doneHit: document.elementFromPoint(done.x + done.width / 2, done.y + done.height / 2)?.closest('button') === element.querySelector('.annotation-done') }; });
      assert(layout.text.height >= 64); assert(layout.text.bottom <= layout.media.y); assert(layout.media.bottom <= layout.footer.y); assert(layout.footer.bottom <= 700); assert(layout.done.right <= 320); assert(layout.doneHit);
      const start = page.getByRole('slider', { name: 'Start point', exact: true }); await start.press('ArrowRight'); await page.getByRole('slider', { name: 'End point', exact: true }).press('ArrowLeft');
      await input.press('End'); await page.screenshot({ path: join(app.evidence, `editor-${index === 0 ? 'audio' : 'video'}-${theme}-320.png`) });
      geometry.push({ kind: index === 0 ? 'audio' : 'video', theme, width: 320, ...layout });
      await page.getByRole('button', { name: 'Done', exact: true }).click(); await expect(page.locator('.draft-annotation').last()).toHaveAttribute('data-capture-state', 'complete');
      await page.getByRole('button', { name: 'Zoom out', exact: true }).click(); await page.getByRole('button', { name: 'Reset zoom to 100%', exact: true }).click();
    }
    await app.call('/api/board/operations', 'POST', { sessionId: app.session.id, operations: [{ type: 'delete', objectId: object.id, expectedVersion: object.version }] });
  }
  await writeFile(join(app.evidence, 'media-editor-geometry.json'), JSON.stringify(geometry, null, 2));
});

test('refinement an open editor measures its visible size again across resize and CSS zoom', async t => {
  const app = await fixture(t), { page } = app;
  await page.setViewportSize({ width: 1200, height: 740 }); await app.mark({ x: 200, y: 300 });
  await page.getByRole('textbox', { name: 'Add a comment', exact: true }).fill('Keep this editor reachable.\n'.repeat(18));
  const facts = [];
  for (const [width, height, cssZoom] of [[320, 700, 1], [320, 700, 1.25], [320, 480, .8], [1200, 740, 1]]) {
    await page.setViewportSize({ width, height }); await page.locator('.app-shell').evaluate((element, zoom) => { (element as HTMLElement).style.zoom = String(zoom); }, cssZoom);
    await expect.poll(async () => page.getByRole('button', { name: 'Done', exact: true }).evaluate(element => { const rect = element.getBoundingClientRect(); return rect.right <= innerWidth + .1 && rect.bottom <= innerHeight + .1 && document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)?.closest('button') === element; })).toBeTruthy();
    const geometry = await page.locator('.annotation-full').evaluate(element => { const note = element.getBoundingClientRect(), text = element.querySelector('.annotation-fulltext')!.getBoundingClientRect(); return { note: { x: note.x, y: note.y, width: note.width, height: note.height, right: note.right }, textHeight: text.height }; });
    assert(geometry.textHeight >= 64 * cssZoom - .1); facts.push({ width, height, cssZoom, ...geometry });
    await page.screenshot({ path: join(app.evidence, `open-editor-${width}-${height}-${cssZoom}.png`) });
  }
  await page.getByRole('button', { name: 'Done', exact: true }).click(); await expect(page.locator('.draft-annotation')).toHaveAttribute('data-capture-state', 'complete');
  await writeFile(join(app.evidence, 'open-editor-resize-geometry.json'), JSON.stringify(facts, null, 2));
});

test('refinement collapsed region text keeps its padding inside a narrow scaled surface', async t => {
  const app = await fixture(t, true), { page } = app;
  await page.locator('.app-shell').evaluate(element => { (element as HTMLElement).style.zoom = '1.25'; });
  await app.mark({ x: 2, y: 200 }, { x: 90, y: 240 }); const annotation = await app.done('A long region comment stays inside its own translucent surface and preserves a readable edge.');
  const note = page.locator(`.canvas-annotation-comment[data-annotation-id="${annotation.id}"]`);
  await note.evaluate(async element => { await Promise.all(element.getAnimations({ subtree: true }).map(animation => animation.finished.catch(() => {}))); });
  const facts = await note.evaluate(element => { const note = element.getBoundingClientRect(), summary = element.querySelector('.canvas-annotation-summary')!.getBoundingClientRect(), style = getComputedStyle(element); return { note: { x: note.x, width: note.width, right: note.right }, summary: { x: summary.x, width: summary.width, right: summary.right }, padding: { left: Number.parseFloat(style.paddingLeft) * 1.25, right: Number.parseFloat(style.paddingRight) * 1.25 } }; });
  assert(facts.summary.x >= facts.note.x + facts.padding.left - .1); assert(facts.summary.right <= facts.note.right - facts.padding.right + .1); assert(facts.note.right <= 320);
  await page.screenshot({ path: join(app.evidence, 'collapsed-region-csszoom-320.png') });
  await writeFile(join(app.evidence, 'collapsed-region-csszoom-geometry.json'), JSON.stringify(facts, null, 2));
});

test('Done composes pins, content, captions and comments at their displayed DOM positions', { timeout: 120_000 }, async t => {
  for (const config of [{ theme: 'light', view: { x: 0, y: 0, zoom: 1 } }, { theme: 'dark', view: { x: 0, y: -60, zoom: 1.25 } }] as const) {
    const app = await fixture(t), { page } = app;
    await page.evaluate(theme => localStorage.setItem('acanvas-theme', theme), config.theme);
    await app.call(`/api/sessions/${app.session.id}/view`, 'PUT', { ...config.view, selectedObjectIds: [] }); await page.reload();
    await expect(page.locator('.zoom-label')).toHaveText(`${config.view.zoom * 100}%`); await expect(page.locator('.composer')).toHaveAttribute('data-save-state', 'saved');
    const screen = (x: number, y: number) => ({ x: x * config.view.zoom + config.view.x, y: y * config.view.zoom + config.view.y });
    const encoded = await page.evaluate(() => { const canvas = document.createElement('canvas'); canvas.width = 400; canvas.height = 240; const context = canvas.getContext('2d')!; context.fillStyle = '#d93232'; context.fillRect(0, 0, 400, 240); return canvas.toDataURL('image/png').split(',')[1]; });
    const object = await app.object(await app.importAsset('Geometry.png', 'image/png', Buffer.from(encoded, 'base64')));
    await expect.poll(() => page.locator(`[data-object-id="${object.id}"] img`).evaluate(image => (image as HTMLImageElement).naturalWidth)).toBe(400);
    await app.mark(screen(450, 350), screen(550, 420)); const inner = await app.done('Region inside the image'); assert.equal(inner.objectId, object.id);
    // The outer region keeps the inner comment on the bare board while its crop still contains that comment.
    await app.mark(screen(100, 300), screen(760, 560));
    const rect = (selector: string) => page.locator(selector).evaluate(element => { const { x, y, width, height } = element.getBoundingClientRect(); return { x, y, width, height }; });
    const settled = () => page.waitForFunction(() => document.getAnimations().every(animation => animation.playState !== 'running'));
    let dom!: Record<'image' | 'innerPin' | 'outerPin' | 'caption' | 'comment', Area>, commentColor!: number[];
    const outer = await app.done('Region around the image', async () => {
      const outerId = await page.locator('.canvas-annotation-group[data-active="true"]').getAttribute('data-annotation-id'); await settled();
      dom = { image: await rect(`[data-object-id="${object.id}"] img`), innerPin: await rect(`.canvas-annotation-group[data-annotation-id="${inner.id}"]>.annotation-pin`), outerPin: await rect(`.canvas-annotation-group[data-annotation-id="${outerId}"]>.annotation-pin`), caption: await rect(`[data-object-id="${object.id}"] .object-caption`), comment: await rect(`.canvas-annotation-comment[data-annotation-id="${inner.id}"]`) };
      commentColor = await page.locator(`.canvas-annotation-comment[data-annotation-id="${inner.id}"]`).evaluate(element => {
        const channels = (value: string) => value.match(/[\d.]+/g)!.map(Number), [r, g, b, alpha = 1] = channels(getComputedStyle(element).backgroundColor), board = channels(getComputedStyle(document.querySelector('#whiteboard')!).backgroundColor);
        return [r, g, b].map((channel, index) => channel * alpha + board[index] * (1 - alpha));
      });
    });
    assert.equal(outer.scope, 'region'); await page.mouse.move(1, 1); await settled();
    const text = config.theme === 'light' ? 'ink' : 'bright';
    const regions: Region[] = [{ window: grown(dom.image, 4), kind: 'red' }, { window: grown(dom.innerPin, 4), kind: 'pin' }, { window: grown(dom.outerPin, 4), kind: 'pin' }, { window: grown(dom.caption, 2), kind: text }, { window: grown(dom.comment, 4), kind: 'color', color: commentColor }, { window: dom.comment, kind: text }];
    const captured = await colorBoxes(page, { capture: outer.capture! }, regions), displayed = await colorBoxes(page, { screenshot: await page.screenshot({ caret: 'hide' }) }, regions);
    const box = (area: Area): Box => ({ left: area.x, top: area.y, right: area.x + area.width, bottom: area.y + area.height });
    await writeFile(join(app.evidence, `done-geometry-${config.theme}-${config.view.zoom}.json`), JSON.stringify({ config, dom, commentColor, captured, displayed }, null, 2));
    sameBox(captured[0], box(dom.image), 'image content');
    for (const [index, name] of [[1, 'innerPin'], [2, 'outerPin']] as const) {
      sameBox(captured[index], displayed[index], `${name} pixels`);
      const pin = dom[name], found = captured[index]!;
      assert(Math.abs((found.left + found.right) / 2 - (pin.x + 12.5 * 28 / 24)) <= 1 && Math.abs((found.top + found.bottom) / 2 - (pin.y + 14)) <= 1, `${name} center: ${JSON.stringify({ found, pin })}`);
    }
    sameBox(captured[3], displayed[3], 'caption text'); sameBox(captured[4], box(dom.comment), 'comment surface'); sameBox(displayed[4], box(dom.comment), 'displayed comment surface'); sameBox(captured[5], displayed[5], 'comment text');
  }
});

test('Done validates near-expiry and expired base scenes against its frozen objects while the board changes', { timeout: 90_000 }, async t => {
  const app = await fixture(t), { page } = app, scenes = await sceneRoute(page);
  scenes.state.nearExpiry = true;
  const asset = await app.image(), target = await app.object(asset), other = await app.object(asset, { x: 800, y: 300, width: 300, height: 180 });
  const confirms: number[] = []; page.on('response', response => { if (response.request().method() === 'PUT' && /\/capture-views\/[^/]+\/presented$/.test(new URL(response.url()).pathname)) confirms.push(response.status()); });
  await app.mark({ x: 520, y: 360 });
  const held = scenes.hold(), frozen = app.done('Frozen while the board changes');
  await enteredStage(held.entered);
  await app.call('/api/board/operations', 'POST', { sessionId: app.session.id, operations: [{ type: 'update', objectId: other.id, expectedVersion: other.version, changes: { x: 820 } }] });
  held.release(); const first = await frozen;
  const refreshed = scenes.state.snapshots.find(value => value.held); assert(refreshed);
  assert.equal(first.capture!.presentation!.baseSceneId, refreshed.id); assert.equal(first.capture!.sceneSource!.baseSceneId, refreshed.id);
  assert.equal(first.capture!.scene.objects.find(value => value.object.id === target.id)?.object.version, target.version); assert.deepEqual(confirms, [200]);
  await expect(page.locator(`[data-object-id="${other.id}"]`)).toHaveCSS('left', '820px');
  scenes.state.nearExpiry = false;
  const moved = app.running.service.objects().find(value => value.id === other.id)!;
  await app.call('/api/board/operations', 'POST', { sessionId: app.session.id, operations: [{ type: 'update', objectId: other.id, expectedVersion: moved.version, changes: { x: 800 } }] });
  await expect(page.locator(`[data-object-id="${other.id}"]`)).toHaveCSS('left', '800px'); await expect.poll(() => scenes.state.snapshots.length).toBeGreaterThanOrEqual(4);
  const expired = scenes.state.snapshots.at(-1)!.id; app.running.service.db.prepare('UPDATE capture_scenes SET expires_at=0').run();
  await app.mark({ x: 560, y: 400 }); const second = await app.done('After the base scene expired');
  assert.deepEqual(confirms.slice(1), [409, 200]); assert.notEqual(second.capture!.presentation!.baseSceneId, expired); assert.equal(second.capture!.presentation!.baseSceneId, scenes.state.snapshots.at(-1)!.id);
  assert(second.capture!.presentation!.frameSeq > first.capture!.presentation!.frameSeq, JSON.stringify([first.capture!.presentation!.frameSeq, second.capture!.presentation!.frameSeq]));
});

test('Escape and pagehide during the asynchronous Done phase leave no hold, source or pending evidence', { timeout: 90_000 }, async t => {
  const app = await fixture(t), { page } = app, scenes = await sceneRoute(page);
  scenes.state.nearExpiry = true; await app.object(await app.image());
  const holds: string[] = []; page.on('request', request => { const path = new URL(request.url()).pathname; if (/\/capture-views\/[^/]+\/(presented|presentations)$/.test(path)) holds.push(`${request.method()} ${path}`); });
  const pending = () => page.evaluate(() => new Promise<number>((resolve, reject) => {
    const request = indexedDB.open('acanvas-scene-evidence', 1);
    request.onupgradeneeded = () => { request.result.createObjectStore('pending', { keyPath: 'id' }).createIndex('session', 'sessionId'); };
    request.onsuccess = () => { const database = request.result, count = database.transaction('pending').objectStore('pending').count(); count.onsuccess = () => { database.close(); resolve(count.result); }; count.onerror = () => reject(count.error); };
    request.onerror = () => reject(request.error);
  }));
  const text = 'Cancelled during the scene check';
  const unchanged = async () => {
    await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 500)));
    const annotation = (await app.saved()).annotations[0]; assert.equal(annotation.text, text); assert.equal(annotation.captureState?.status, 'incomplete'); assert.equal(annotation.sceneSource, undefined); assert.equal(annotation.capture, undefined);
    assert.deepEqual(holds, []); assert.equal((app.running.service.db.prepare('SELECT COUNT(*) AS count FROM scene_sources').get() as { count: number }).count, 0); assert.equal(await pending(), 0);
  };
  // Each cancellation must end the capture while the base scene renewal is still held.
  const stopped = () => expect(page.locator('.app-shell')).not.toHaveAttribute('data-capturing', 'true');
  await app.mark({ x: 520, y: 360 }); await page.getByRole('textbox', { name: 'Add a comment', exact: true }).fill(text);
  let held = scenes.hold(); await page.getByRole('button', { name: 'Done', exact: true }).click(); await enteredStage(held.entered);
  await expect(page.locator('.app-shell')).toHaveAttribute('data-capturing', 'true');
  await page.keyboard.press('Escape'); await stopped(); held.release(); await unchanged();
  await expect(page.locator('.draft-annotation')).toHaveAttribute('data-capture-state', 'incomplete');
  await page.locator('.draft-annotation .annotation-content').click(); await expect(page.getByRole('textbox', { name: 'Annotation text', exact: true })).toBeVisible();
  held = scenes.hold(); await page.getByRole('button', { name: 'Done', exact: true }).click(); await enteredStage(held.entered);
  await expect(page.locator('.app-shell')).toHaveAttribute('data-capturing', 'true');
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false }))); await stopped(); held.release(); await unchanged();
});

test('Done reports content it cannot copy and still completes with that object\'s placeholder', async t => {
  const app = await fixture(t), { page } = app;
  const list = await app.importAsset('Long list.md', 'text/markdown', Buffer.from(Array.from({ length: 6000 }, (_, index) => `- Item ${index}`).join('\n')));
  const object = await app.object(list, { x: 300, y: 250, width: 340, height: 300 });
  await expect(page.locator(`[data-object-id="${object.id}"] .markdown-body li`).first()).toBeVisible();
  await app.mark({ x: 470, y: 400 }); const note = await app.done('Placeholder for an oversized panel');
  assert.equal(note.objectId, object.id); assert.equal(note.capture!.scene.objects.find(value => value.object.id === object.id)?.contentAnchor, undefined);
  await expect(page.getByText('Long list.md appears as a placeholder in the annotation image: The content layout exceeds the supported node count.')).toBeVisible();
});

test('consecutive Done frame sequences advance by one when the clock does not', async t => {
  const app = await fixture(t), { page } = app;
  await app.object(await app.image());
  const fixed = await page.evaluate(() => { const now = Date.now() + 60_000; Date.now = () => now; return now; });
  await app.mark({ x: 520, y: 360 }); const first = await app.done('First evidence frame');
  await app.mark({ x: 560, y: 400 }); const second = await app.done('Next evidence frame');
  assert.equal(first.capture!.presentation!.frameSeq, fixed); assert.equal(second.capture!.presentation!.frameSeq, fixed + 1);
});
