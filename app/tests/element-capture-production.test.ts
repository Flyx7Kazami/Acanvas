import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect } from '@playwright/test';
import { startServer } from '../src/server/http.js';
import type { AnnotationCapture, Asset, BoardObject, BoardState } from '../src/shared/types.js';

test('production full element captures keep copied image audio GIF video and HTML pixels', { skip: process.env.ACANVAS_ELEMENT_CAPTURE_TEST !== '1', timeout: 150_000 }, async t => {
  const { chromium } = await import('playwright-core');
  const root = await mkdtemp(join(tmpdir(), 'acanvas-element-project-'));
  const outputBase = process.env.ACANVAS_ELEMENT_CAPTURE_OUTPUT || join(tmpdir(), 'acanvas-element-output');
  await mkdir(outputBase, { recursive: true });
  const output = await mkdtemp(join(outputBase, 'run-'));
  const server = await startServer({ root, port: 0, webRoot: resolve(process.env.ACANVAS_ELEMENT_CAPTURE_WEB_ROOT || 'dist/web'), htmlSurfaces: { engine: 'chromium' } });
  const bootstrap = await (await fetch(server.url + '/api/bootstrap')).json();
  const call = async (path: string, method = 'GET', body?: unknown): Promise<any> => {
    const response = await fetch(server.url + path, { method, headers: { Authorization: 'Bearer ' + bootstrap.token, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const value = await response.json(); assert(response.ok, `${method} ${path}: ${JSON.stringify(value)}`); return value;
  };
  const upload = async (name: string, mime: string, bytes: Buffer): Promise<Asset> => {
    const response = await fetch(`${server.url}/api/assets?name=${encodeURIComponent(name)}&mime=${encodeURIComponent(mime)}`, { method: 'POST', headers: { Authorization: 'Bearer ' + bootstrap.token }, body: new Uint8Array(bytes) });
    assert(response.ok); return response.json();
  };
  const image = await upload('Four edges.svg', 'image/svg+xml', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="500" height="300"><rect width="500" height="300" fill="#f5eddc"/><path d="M0 0h500v12H0Z" fill="#cc3020"/><path d="M488 0h12v300h-12Z" fill="#307b28"/><path d="M0 288h500v12H0Z" fill="#253bcc"/><path d="M0 0h12v300H0Z" fill="#e39c28"/></svg>'));
  const audio = await upload('Night drive.mp3', 'audio/mpeg', await readFile(resolve('app/tests/fixtures/reference-tone.mp3')));
  const gif = await upload('Animated reference.gif', 'image/gif', await readFile(resolve('app/tests/fixtures/animated-reference.gif')));
  const video = await upload('Reference video.mp4', 'video/mp4', await readFile(resolve('app/tests/fixtures/frontend-video.mp4')));
  const html = await upload('Live panel.html', 'text/html', Buffer.from('<!doctype html><style>body{margin:0;background:#203746;color:#fff;font:24px Arial}canvas{display:block;width:100%;height:180px}input{margin:12px}</style><input value="Retained form"><canvas width="500" height="180"></canvas><script>const c=document.querySelector("canvas").getContext("2d");let n=0;const seed=Math.random();function paint(){n++;c.fillStyle="rgb("+(30+n%120)+",110,140)";c.fillRect(0,0,500,180);c.fillStyle="#ffe28a";c.fillRect(20+n%400,20,40,80);c.fillStyle="white";c.fillText("Frame "+n+" / "+seed.toFixed(3),20,145);requestAnimationFrame(paint)}paint()</script>'));
  const occluder = await upload('Overlap.svg', 'image/svg+xml', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120"><rect width="120" height="120" fill="#e828b7"/></svg>'));
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const samples: unknown[] = [];
  t.after(async () => { await browser.close(); await server.close(); await rm(root, { recursive: true, force: true }); });
  const scenarios = [
    { kind: 'image', asset: image, dpr: 1, zoom: 1, cssZoom: 1, x: 180, y: 110, deleteAfterCopy: true },
    { kind: 'audio', asset: audio, dpr: 2, zoom: 1, cssZoom: 1, x: 180, y: 110 },
    { kind: 'gif', asset: gif, dpr: 2, zoom: 1, cssZoom: 1, x: 180, y: 110 },
    { kind: 'video', asset: video, dpr: 1, zoom: 1, cssZoom: 1, x: 180, y: 110 },
    { kind: 'html', asset: html, dpr: 2, zoom: 1, cssZoom: 1, x: 180, y: 110 },
    { kind: 'image-partial', asset: image, dpr: 2, zoom: 1.25, cssZoom: 1.25, x: -130.5, y: 100.25 },
  ];
  for (const scenario of scenarios) {
    const session = await call('/api/sessions', 'POST', { name: `Complete ${scenario.kind}` });
    if (scenario.zoom !== 1) await call(`/api/sessions/${session.id}/view`, 'PUT', { ...session.view, zoom: scenario.zoom });
    const created = await call('/api/board/operations', 'POST', { sessionId: session.id, operations: [
      { type: 'create', object: { assetId: scenario.asset.id, x: scenario.x, y: scenario.y, width: 500, height: 300 } },
    ] });
    const object: BoardObject = created.objects.find((value: BoardObject) => value.assetId === scenario.asset.id);
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: scenario.dpr });
    await context.tracing.start({ screenshots: true, snapshots: true });
    const page = await context.newPage(), errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      const original = CanvasRenderingContext2D.prototype.drawImage;
      CanvasRenderingContext2D.prototype.drawImage = function (this: CanvasRenderingContext2D, ...args: any[]) {
        const source = args[0];
        if (source instanceof HTMLCanvasElement && source.classList.contains('scene-evidence-canvas') && args.length === 9 && this.canvas !== source) {
          (window as any).elementCaptureOracle = { seq: Number(source.dataset.frameSeq), sourcePixels: { x: args[1], y: args[2], width: args[3], height: args[4] }, width: args[7], height: args[8], pixels: source.getContext('2d')!.getImageData(args[1], args[2], args[3], args[4]).data };
        }
        return (original as any).apply(this, args);
      } as typeof original;
    });
    try {
      await page.goto(server.url + '/?session=' + session.id);
      await expect(page.locator('.composer')).toHaveAttribute('data-save-state', 'saved');
      await expect(page.locator('#whiteboard')).toHaveAttribute('data-view-id', /.+/);
      if (scenario.cssZoom !== 1) { await page.evaluate(zoom => { document.body.style.zoom = String(zoom); }, scenario.cssZoom); await page.evaluate(() => new Promise(requestAnimationFrame)); }
      const target = page.locator(`[data-object-id="${object.id}"]`).first();
      const rect = await target.boundingBox(); assert(rect);
      if (scenario.kind === 'audio') await page.waitForFunction(id => document.querySelector<HTMLAudioElement>(`[data-object-id="${id}"] audio`)!.readyState >= 1, object.id);
      if (scenario.kind === 'gif') await page.waitForFunction(id => Boolean(document.querySelector<HTMLCanvasElement>(`[data-object-id="${id}"] canvas[data-scene-media="gif"]`)?.dataset.frameIndex), object.id);
      if (scenario.kind === 'video') await page.waitForFunction(id => document.querySelector<HTMLVideoElement>(`[data-object-id="${id}"] video`)!.readyState >= 2, object.id);
      if (scenario.kind === 'html') await page.waitForFunction(id => {
        const image = document.querySelector<HTMLImageElement>(`[data-object-id="${id}"] .html-snapshot`);
        return Boolean(image?.complete && image.naturalWidth);
      }, object.id, { timeout: 15_000 });
      const overlapState = await call('/api/board/operations', 'POST', { sessionId: session.id, operations: [{ type: 'create', object: { assetId: occluder.id, x: 430, y: 160, width: 120, height: 120 } }] });
      const overlap: BoardObject = overlapState.objects.filter((value: BoardObject) => value.assetId === occluder.id).at(-1);
      await page.waitForFunction(id => { const image = document.querySelector<HTMLImageElement>(`[data-object-id="${id}"] img`); return Boolean(image?.complete && image.naturalWidth); }, overlap.id);
      await page.evaluate(() => new Promise(requestAnimationFrame));
      await page.getByRole('button', { name: 'Mark canvas', exact: true }).click();
      const point = { x: Math.max(80, rect.x + rect.width * .32), y: rect.y + rect.height * .65 };
      await page.mouse.click(point.x, point.y);
      await expect(page.getByRole('textbox', { name: 'Add a comment', exact: true })).toBeVisible();
      await page.getByRole('textbox', { name: 'Add a comment', exact: true }).fill(`Keep complete ${scenario.kind}.`);
      if (scenario.kind === 'audio' || scenario.kind === 'video') {
        await expect(page.locator('.annotation-time-range')).toHaveAttribute('data-ready', 'true');
        await page.getByRole('slider', { name: 'Start point', exact: true }).press('ArrowRight');
      }
      await page.evaluate(() => new Promise(requestAnimationFrame));
      let held!: () => void, release!: () => void;
      const uploadStarted = new Promise<void>(resolve => { held = resolve; }), uploadGate = new Promise<void>(resolve => { release = resolve; });
      await page.route('**/captures/*/content', async route => { if (route.request().method() !== 'PUT') return route.continue(); held(); await uploadGate; await route.continue().catch(() => undefined); });
      await page.getByRole('button', { name: 'Done', exact: true }).click();
      await uploadStarted;
      await expect(page.getByRole('textbox', { name: 'Add a comment', exact: true })).toBeHidden();
      const oracle = await page.evaluate(() => { const value = (window as any).elementCaptureOracle; return { seq: value.seq, width: value.width, height: value.height, sourcePixels: value.sourcePixels }; });
      for (let step = 0; step < 5; step++) {
        const previous = await page.locator('.zoom-label').textContent();
        await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
        await expect(page.locator('.zoom-label')).not.toHaveText(previous!);
      }
      if (scenario.deleteAfterCopy) {
        await call('/api/board/operations', 'POST', { sessionId: session.id, operations: [{ type: 'update', objectId: object.id, expectedVersion: object.version, changes: { x: object.x + 190, y: object.y + 160 } }] });
        const moved = (await call(`/api/state?sessionId=${session.id}`) as BoardState).objects.find(value => value.id === object.id)!;
        await call('/api/board/operations', 'POST', { sessionId: session.id, operations: [{ type: 'delete', objectId: object.id, expectedVersion: moved.version }] });
      }
      release();
      await expect(page.locator('.draft-annotation').last()).toHaveAttribute('data-capture-state', 'complete', { timeout: 15_000 });
      const saved = await call(`/api/state?sessionId=${session.id}`) as BoardState, annotation = saved.draft.annotations.at(-1)!;
      assert.equal(annotation.objectId, object.id); assert.equal(annotation.geometry, 'point'); assert.equal(annotation.coordinateSpace, 'normalized');
      const capture = annotation.capture as AnnotationCapture, presentedLayer = capture.presentation!.layers.find(layer => layer.objectId === object.id)!;
      assert(presentedLayer); assert.equal(capture.presentation!.frameSeq, oracle.seq);
      assert(capture.presentation!.layers.find(layer => layer.objectId === overlap.id)!.layer > presentedLayer.layer);
      const canvasViewport = capture.presentation!.cssViewport, pageClip = { x: 0, y: 0, width: 1440, height: 1000 }, crop = capture.mapping.crop;
      const left = Math.max(pageClip.x, canvasViewport.x, presentedLayer.renderedBounds.x), top = Math.max(pageClip.y, canvasViewport.y, presentedLayer.renderedBounds.y);
      const right = Math.min(pageClip.width, canvasViewport.x + canvasViewport.width, presentedLayer.renderedBounds.x + presentedLayer.renderedBounds.width), bottom = Math.min(pageClip.height, canvasViewport.y + canvasViewport.height, presentedLayer.renderedBounds.y + presentedLayer.renderedBounds.height);
      const tolerance = 1 / Math.min(capture.mapping.scaleX, capture.mapping.scaleY);
      assert(crop.x <= left + tolerance && crop.y <= top + tolerance && crop.x + crop.width >= right - tolerance && crop.y + crop.height >= bottom - tolerance, JSON.stringify({ crop, layer: presentedLayer.renderedBounds }));
      assert(crop.x >= 0 && crop.y >= 0); assert(crop.x + crop.width <= 1440 + 1e-8 && crop.y + crop.height <= 1000 + 1e-8);
      const png = await readFile(server.service.assetPath(capture.screenshotAssetId));
      const comparison = await page.evaluate(async ({ bytes, capture, point }) => {
        const image = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: 'image/png' })), output = document.createElement('canvas'); output.width = image.width; output.height = image.height; output.getContext('2d')!.drawImage(image, 0, 0); image.close();
        const data = output.getContext('2d')!.getImageData(0, 0, output.width, output.height).data, original = (window as any).elementCaptureOracle.pixels as Uint8ClampedArray;
        if (data.length !== original.length) throw new Error('The saved crop dimensions differ from the synchronous display copy.');
        let mismatches = 0, occluderPixels = 0;
        for (let index = 0; index < data.length; index++) if (data[index] !== original[index]) mismatches++;
        for (let index = 0; index < data.length; index += 4) if (data[index] > 210 && data[index + 1] < 60 && data[index + 2] > 160) occluderPixels++;
        const x = Math.round((point.x - capture.mapping.crop.x) * capture.mapping.scaleX), y = Math.round((point.y - capture.mapping.crop.y) * capture.mapping.scaleY);
        let pinPixels = 0;
        for (let row = Math.max(0, y - 14 * capture.mapping.scaleY); row < Math.min(output.height, y + 14 * capture.mapping.scaleY); row++) for (let column = Math.max(0, x - 14 * capture.mapping.scaleX); column < Math.min(output.width, x + 14 * capture.mapping.scaleX); column++) { const offset = (Math.floor(row) * output.width + Math.floor(column)) * 4; if (data[offset + 2] - data[offset] > 30 && data[offset + 1] - data[offset] > 10) pinPixels++; }
        return { mismatches, pinPixels, occluderPixels, channels: data.length, width: output.width, height: output.height };
      }, { bytes: Array.from(png), capture, point });
      assert.equal(comparison.mismatches, 0); assert(comparison.pinPixels > 15, JSON.stringify(comparison));
      if (scenario.kind !== 'image-partial') assert(comparison.occluderPixels > 500, JSON.stringify(comparison));
      if (scenario.kind === 'html') assert.equal(presentedLayer.surface, undefined);
      if (scenario.kind === 'gif' || scenario.kind === 'video') assert(capture.presentation!.media.some(media => media.objectId === object.id && media.presentedTime !== undefined));
      if (scenario.kind === 'audio' || scenario.kind === 'video') { assert(capture.presentation!.media.some(media => media.objectId === object.id)); assert(annotation.timeStart! > 0); assert(annotation.timeEnd! > annotation.timeStart!); }
      assert.deepEqual(errors, []);
      await writeFile(join(output, `${scenario.kind}-capture.png`), png); await page.screenshot({ path: join(output, `${scenario.kind}-display.png`) });
      samples.push({ kind: scenario.kind, dpr: scenario.dpr, camera: capture.presentation!.camera, cssViewport: canvasViewport, bitmap: capture.presentation!.bitmap, crop, paintBounds: presentedLayer.renderedBounds, point, copiedFrame: oracle.seq, finalZoom: await page.locator('.zoom-label').textContent(), comparison, originalMovedAndDeleted: Boolean(scenario.deleteAfterCopy), editorClosedDuringUpload: true, surface: presentedLayer.surface, media: capture.presentation!.media.filter(media => media.objectId === object.id) });
    } finally { await context.tracing.stop({ path: join(output, `${scenario.kind}-trace.zip`) }); await context.close(); }
  }
  const facts = { measuredAt: new Date().toISOString(), result: 'passed', node: process.version, browser: browser.version(), source: 'production offscreen evidence composition at Done', samples, output,
    validationScope: ['complete element paint context', 'actual point marker', 'image and audio complete application capture', 'overlap kept in original display copy', 'GIF video HTML actual presented producers', 'DPR1/2 and page/canvas zoom', 'partly offscreen clipping', 'PNG equals the copied evidence frame while the displayed camera keeps changing', 'source move and deletion after Done'],
    limitations: ['one isolated Chromium application; existing cross-browser engine matrix was not repeated', 'HTML uses explicit isolated Chromium surface engine; CEF matrix remains covered by existing capture validation'] };
  await writeFile(join(output, 'element-capture-production.json'), JSON.stringify(facts, null, 2) + '\n');
  if (process.env.ACANVAS_ELEMENT_CAPTURE_FACTS) await writeFile(resolve(process.env.ACANVAS_ELEMENT_CAPTURE_FACTS), JSON.stringify(facts, null, 2) + '\n');
});
