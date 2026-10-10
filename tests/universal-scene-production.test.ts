import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { AnnotationCapture, BoardState } from '../src/shared/types.js';
import { startServer } from '../src/server/http.js';

test('production ordinary browser captures the visible SceneCanvas through the project API', { skip: process.env.ACANVAS_SCENE_PRODUCTION_TEST !== '1', timeout: 180_000 }, async t => {
  const { chromium } = await import('playwright-core');
  const root = await mkdtemp(join(tmpdir(), 'acanvas-scene-production-')), output = process.env.ACANVAS_SCENE_PRODUCTION_OUTPUT || await mkdtemp(join(tmpdir(), 'acanvas-scene-production-output-'));
  await mkdir(output, { recursive: true });
  let server = await startServer({ root, port: 0, webRoot: resolve(process.env.ACANVAS_SCENE_WEB_ROOT || 'dist/web') });
  let bootstrap = await (await fetch(server.url + '/api/bootstrap')).json();
  const call = async (path: string, method = 'GET', body?: unknown) => {
    const response = await fetch(server.url + path, { method, headers: { Authorization: 'Bearer ' + bootstrap.token, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const value = await response.json(); assert.ok(response.ok, method + ' ' + path + ': ' + JSON.stringify(value)); return value;
  };
  const session = await call('/api/sessions', 'POST', { name: 'Scene rendering acceptance' });
  const upload = async (name: string, mime: string, bytes: Buffer) => {
    const response = await fetch(server.url + '/api/assets?name=' + encodeURIComponent(name) + '&mime=' + encodeURIComponent(mime), { method: 'POST', headers: { Authorization: 'Bearer ' + bootstrap.token }, body: new Uint8Array(bytes) });
    assert.ok(response.ok); return response.json();
  };
  const image = await upload('Landscape.svg', 'image/svg+xml', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="340" height="200"><rect width="340" height="200" fill="#cbd5df"/><circle cx="270" cy="120" r="40" fill="#456477"/></svg>'));
  const file = await upload('Archive.zip', 'application/zip', Buffer.from('Isolated file-card fixture'));
  const markdown = await upload('Notes.md', 'text/markdown', Buffer.from('# Scene notes\n\nThe original light remains in the evidence.\n\n[Reference](https://example.com/)'));
  await call('/api/board/operations', 'POST', { sessionId: session.id, operations: [
    { type: 'create', object: { assetId: image.id, x: 120, y: 100, width: 340, height: 200 } },
    { type: 'create', object: { assetId: file.id, x: 570, y: 100, width: 300, height: 180 } },
    { type: 'create', object: { assetId: markdown.id, x: 120, y: 390, width: 340, height: 220 } },
  ] });
  const browser = await chromium.launch({ channel: 'chrome', headless: true }), context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2 }), page = await context.newPage();
  let markIndex = 0;
  const markObject = async (objectId: string) => {
    await page.getByRole('button', { name: 'Mark canvas', exact: true }).click();
    const box = await page.locator('[data-object-id="' + objectId + '"] .object-media').boundingBox(); assert.ok(box);
    const fraction = .2 + markIndex++ % 4 * .12;
    await page.mouse.click(box.x + box.width * fraction, box.y + box.height * fraction);
  };
  await context.tracing.start({ screenshots: true, snapshots: true });
  const errors: string[] = [], failedResponses: string[] = [];
  let presentedRequests = 0; page.on('request', request => { if (request.method() === 'PUT' && new URL(request.url()).pathname.endsWith('/presented')) presentedRequests++; });
  page.on('pageerror', error => errors.push(error.message)); page.on('response', response => { if (response.status() >= 400 && response.url().includes('/api/')) failedResponses.push(response.status() + ' ' + new URL(response.url()).pathname); });
  t.after(async () => { await context.tracing.stop({ path: join(output, 'trace.zip') }); await browser.close(); await server.close(); await rm(root, { recursive: true, force: true }); });
  await page.addInitScript(() => {
    const original = CanvasRenderingContext2D.prototype.drawImage;
    CanvasRenderingContext2D.prototype.drawImage = function (this: CanvasRenderingContext2D, ...args: any[]) {
      const source = args[0];
      if (source instanceof HTMLCanvasElement && source.classList.contains('scene-evidence-canvas') && args.length === 9 && this.canvas !== source) {
        (window as any).sceneCaptureOracle = { seq: Number(source.dataset.frameSeq), bitmap: { width: source.width, height: source.height }, width: args[7], height: args[8], pixels: source.getContext('2d')!.getImageData(args[1], args[2], args[3], args[4]).data };
      }
      return (original as any).apply(this, args);
    } as typeof original;
  });
  await page.goto(server.url + '/?session=' + session.id);
  await page.waitForFunction(() => Boolean(document.querySelector('#whiteboard')?.getAttribute('data-view-id')));
  await page.waitForFunction(() => { const image = document.querySelector<HTMLImageElement>('[data-object-id] img'); return Boolean(image?.complete && image.naturalWidth); });
  assert.equal(await page.evaluate(() => Boolean(window.acanvasCaptureProvider)), false);
  assert.equal(await page.locator('.object-media').first().evaluate(element => getComputedStyle(element).opacity), '1'); assert.equal(presentedRequests, 0, 'Displaying the board confirms no presented frames before Done.');
  const initial = await call('/api/state?sessionId=' + session.id) as BoardState, object = initial.objects.find(value => value.assetId === image.id)!;
  await page.locator('[data-object-id="' + object.id + '"]').focus(); await page.keyboard.press('Enter');
  await markObject(object.id);
  await page.getByRole('textbox', { name: 'Add a comment', exact: true }).fill('Keep this exact view.');
  await page.evaluate(() => new Promise(requestAnimationFrame));
  // Hold the source-save response so the page can continue changing after its synchronous copy.
  let release!: () => void, held!: () => void;
  const capturedIntent = new Promise<void>(resolve => { held = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/capture-views/*/presentations', async route => { held(); await gate; await route.continue(); });
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await capturedIntent;
  const expected = await page.evaluate(() => { const oracle = (window as any).sceneCaptureOracle; (window as any).sceneExpectedPixels = oracle.pixels; return { ...oracle.bitmap, seq: oracle.seq }; });
  await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
  await page.getByRole('combobox', { name: 'Request', exact: true }).fill('A later local edit survives the saved frame.');
  release();
  await page.waitForFunction(() => Boolean(document.querySelector('.draft-annotation img')));
  const saved = await call('/api/state?sessionId=' + session.id) as BoardState, annotation = saved.draft.annotations[0];
  assert.equal(annotation.captureState?.status, 'complete'); assert.equal(annotation.capture?.sourceMode, 'scene-bitmap');
  assert.equal(saved.draft.text, 'A later local edit survives the saved frame.');
  const capture = annotation.capture as AnnotationCapture; assert.equal(capture.presentation!.frameSeq, expected.seq); assert.equal(capture.presentation!.bitmap.width, expected.width);
  assert.deepEqual(capture.presentation!.layers.find(value => value.objectId === object.id)!.contentWorldBounds, { x: 120, y: 100, width: 340, height: 200 });
  const pngResponse = await fetch(server.url + '/api/assets/' + capture.screenshotAssetId + '/content?sessionId=' + session.id, { headers: { Authorization: 'Bearer ' + bootstrap.token } });
  assert.ok(pngResponse.ok); const png = Buffer.from(await pngResponse.arrayBuffer()); await writeFile(join(output, 'captured.png'), png);
  const comparison = await page.evaluate(async bytes => {
    const image = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: 'image/png' })), canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height; canvas.getContext('2d')!.drawImage(image, 0, 0); image.close();
    const actual = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
    let mismatches = 0;
    const original = (window as any).sceneExpectedPixels as Uint8ClampedArray;
    if (actual.length !== original.length) throw new Error('The captured crop dimensions differ from the copied display.');
    for (let index = 0; index < actual.length; index++) if (actual[index] !== original[index]) mismatches++;
    return { mismatches, width: canvas.width, height: canvas.height, channels: actual.length };
  }, Array.from(png));
  assert.equal(comparison.mismatches, 0); assert.equal(context.pages().length, 1);
  await page.reload(); await page.waitForFunction(() => Boolean(document.querySelector('.draft-annotation img')));
  assert.equal((await call('/api/state?sessionId=' + session.id)).draft.annotations[0].capture.id, capture.id);
  await page.unroute('**/capture-views/*/presentations');
  await page.locator('[data-object-id="' + object.id + '"]').focus(); await page.keyboard.press('Enter');
  await markObject(object.id);
  await page.getByRole('textbox', { name: 'Add a comment', exact: true }).fill('Preserve the old scene across reload.');
  await page.evaluate(() => new Promise(requestAnimationFrame));
  let uploadHeld!: () => void, releaseUpload!: () => void;
  const uploadIntent = new Promise<void>(resolve => { uploadHeld = resolve; }), uploadGate = new Promise<void>(resolve => { releaseUpload = resolve; });
  await page.route('**/captures/*/content', async route => { if (route.request().method() !== 'PUT') return route.continue(); uploadHeld(); await uploadGate; await route.continue().catch(() => undefined); });
  await page.getByRole('button', { name: 'Done', exact: true }).click(); await uploadIntent;
  const preparedState = await call('/api/state?sessionId=' + session.id) as BoardState, pendingAnnotation = preparedState.draft.annotations[1];
  assert.equal(pendingAnnotation.captureState?.status, 'incomplete');
  const prepared = await call('/api/sessions/' + session.id + '/drafts/' + preparedState.draft.id + '/annotations/' + pendingAnnotation.id + '/captures/' + pendingAnnotation.captureState!.version);
  assert.equal(prepared.status, 'prepared');
  const oraclePNG = await page.evaluate(async () => {
    const original = (window as any).sceneCaptureOracle, canvas = document.createElement('canvas'); canvas.width = original.width; canvas.height = original.height;
    canvas.getContext('2d')!.putImageData(new ImageData(original.pixels, canvas.width, canvas.height), 0, 0);
    const blob = await new Promise<Blob>(resolve => canvas.toBlob(blob => resolve(blob!), 'image/png')); return Array.from(new Uint8Array(await blob.arrayBuffer()));
  });
  await page.waitForFunction(() => new Promise<boolean>(resolve => { const request = indexedDB.open('acanvas-scene-evidence', 1); request.onsuccess = () => { const database = request.result, read = database.transaction('pending').objectStore('pending').getAll(); read.onsuccess = () => { database.close(); resolve(read.result.length === 1); }; }; request.onerror = () => resolve(false); }));
  await call('/api/board/operations', 'POST', { sessionId: session.id, operations: [{ type: 'delete', objectId: object.id, expectedVersion: object.version }] });
  await page.unroute('**/captures/*/content'); await page.reload(); releaseUpload();
  await page.waitForFunction(() => document.querySelectorAll('.draft-annotation img').length === 2);
  const restored = await call('/api/state?sessionId=' + session.id) as BoardState, restoredAnnotation = restored.draft.annotations.find(value => value.id === pendingAnnotation.id)!;
  assert.equal(restoredAnnotation.captureState?.status, 'complete'); assert.equal(restored.objects.some(value => value.id === object.id), false);
  assert.equal(restoredAnnotation.capture!.presentation!.frameSeq, prepared.capture.presentation.frameSeq);
  assert.equal(restoredAnnotation.capture!.sceneSource!.id, prepared.capture.sceneSource.id);
  const restoredPNGResponse = await fetch(server.url + '/api/assets/' + restoredAnnotation.capture!.screenshotAssetId + '/content?sessionId=' + session.id, { headers: { Authorization: 'Bearer ' + bootstrap.token } });
  assert.ok(restoredPNGResponse.ok); const restoredPNG = Buffer.from(await restoredPNGResponse.arrayBuffer()); await writeFile(join(output, 'restored-old-scene.png'), restoredPNG);
  const restoredComparison = await page.evaluate(async ({ original, saved }) => {
    const read = async (bytes: number[]) => { const image = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: 'image/png' })), canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height; canvas.getContext('2d')!.drawImage(image, 0, 0); image.close(); return canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data; };
    const a = await read(original), b = await read(saved); let mismatches = 0; for (let index = 0; index < a.length; index++) if (a[index] !== b[index]) mismatches++; return { mismatches, channels: a.length };
  }, { original: oraclePNG, saved: Array.from(restoredPNG) });
  assert.equal(restoredComparison.mismatches, 0);
  const fileObject = restored.objects.find(value => value.assetId === file.id)!;
  await page.locator('[data-object-id="' + fileObject.id + '"]').focus(); await page.keyboard.press('Enter');
  await markObject(fileObject.id); await page.getByRole('textbox', { name: 'Add a comment', exact: true }).fill('Keep the comment after cancellation.');
  let cancelHeld!: () => void, releaseCancelled!: () => void;
  const cancelIntent = new Promise<void>(resolve => { cancelHeld = resolve; }), cancelledGate = new Promise<void>(resolve => { releaseCancelled = resolve; });
  await page.route('**/capture-views/*/presentations', async route => { cancelHeld(); await cancelledGate; await route.continue().catch(() => undefined); });
  await page.getByRole('button', { name: 'Done', exact: true }).click(); await cancelIntent;
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('.app-shell')?.hasAttribute('data-capturing'));
  await page.unroute('**/capture-views/*/presentations'); releaseCancelled(); await page.evaluate(() => new Promise(requestAnimationFrame));
  await page.getByRole('combobox', { name: 'Request', exact: true }).focus(); await page.keyboard.press('ControlOrMeta+A'); await page.keyboard.press('Backspace');
  await page.keyboard.insertText('A later edit remains after cancelling the capture.');
  await page.waitForFunction(() => document.querySelector('.composer')?.getAttribute('data-save-state') === 'saved');
  const cancelled = await call('/api/state?sessionId=' + session.id) as BoardState, cancelledAnnotation = cancelled.draft.annotations.find(value => value.text === 'Keep the comment after cancellation.')!;
  assert.ok(cancelledAnnotation); assert.equal(cancelledAnnotation.captureState?.status, 'incomplete'); assert.equal(cancelledAnnotation.capture, undefined);
  assert.equal(cancelled.draft.text, 'A later edit remains after cancelling the capture.');
  await page.locator('[data-object-id="' + fileObject.id + '"]').focus(); await page.keyboard.press('Enter');
  await markObject(fileObject.id); await page.getByRole('textbox', { name: 'Add a comment', exact: true }).fill('Keep this source-save cancellation.');
  let sourceSaved!: () => void, releaseSaved!: () => void, savedVersion = 0;
  const saveIntent = new Promise<void>(resolve => { sourceSaved = resolve; }), savedGate = new Promise<void>(resolve => { releaseSaved = resolve; });
  await page.route('**/sessions/*/draft', async route => {
    const input = route.request().postDataJSON();
    if (route.request().method() !== 'PUT' || !input.annotations?.some((value: any) => value.text === 'Keep this source-save cancellation.' && value.sceneSource)) return route.continue();
    const response = await route.fetch(), savedDraft = await response.json(); savedVersion = savedDraft.annotations.find((value: any) => value.text === 'Keep this source-save cancellation.').captureState.version;
    sourceSaved(); await savedGate; await route.fulfill({ response }).catch(() => undefined);
  });
  await page.getByRole('button', { name: 'Done', exact: true }).click(); await saveIntent;
  await page.keyboard.press('Escape'); await page.waitForFunction(() => !document.querySelector('.app-shell')?.hasAttribute('data-capturing'));
  await page.unroute('**/sessions/*/draft'); releaseSaved();
  await page.waitForFunction(() => !document.querySelector('.app-shell')?.hasAttribute('data-capturing'));
  // Cancellation reconciles the committed source save asynchronously after the held response is released.
  let cancelledAfterSave = (await call('/api/state?sessionId=' + session.id) as BoardState).draft.annotations.find(value => value.text === 'Keep this source-save cancellation.')!;
  for (let attempt = 0; attempt < 40 && cancelledAfterSave?.captureState && cancelledAfterSave.captureState.version <= savedVersion; attempt++) { await new Promise(resolve => setTimeout(resolve, 50)); cancelledAfterSave = (await call('/api/state?sessionId=' + session.id) as BoardState).draft.annotations.find(value => value.text === 'Keep this source-save cancellation.')!; }
  assert.ok(cancelledAfterSave); assert.equal(cancelledAfterSave.captureState?.status, 'incomplete'); assert.equal(cancelledAfterSave.capture, undefined); assert.ok(cancelledAfterSave.captureState!.version > savedVersion);
  const beforeRestart = bootstrap.service.instanceId, port = Number(new URL(server.url).port), currentURL = page.url(), priorGeneration = Number(await page.locator('#whiteboard').getAttribute('data-view-generation'));
  await server.close(); server = await startServer({ root, port, webRoot: resolve(process.env.ACANVAS_SCENE_WEB_ROOT || 'dist/web') }); bootstrap = await (await fetch(server.url + '/api/bootstrap')).json();
  assert.notEqual(bootstrap.service.instanceId, beforeRestart);
  await page.waitForFunction(previous => Number(document.querySelector<HTMLElement>('#whiteboard')?.dataset.viewGeneration) > previous, priorGeneration);
  const documentObject = (await call('/api/state?sessionId=' + session.id) as BoardState).objects.find(value => value.assetId === markdown.id)!;
  await page.locator('[data-object-id="' + documentObject.id + '"]').focus(); await page.keyboard.press('Enter');
  await markObject(documentObject.id); await page.getByRole('textbox', { name: 'Add a comment', exact: true }).fill('The same page captures after service restart.');
  await page.getByRole('button', { name: 'Done', exact: true }).click(); await page.waitForFunction(() => !document.querySelector('.app-shell')?.hasAttribute('data-capturing'));
  const restarted = await call('/api/state?sessionId=' + session.id) as BoardState, restartedAnnotation = restarted.draft.annotations.find(value => value.text === 'The same page captures after service restart.')!;
  assert.equal(restartedAnnotation.captureState?.status, 'complete'); assert.equal(page.url(), currentURL);
  assert.deepEqual(errors, []);
  await page.screenshot({ path: join(output, 'final.png') });
  const facts = { measuredAt: new Date().toISOString(), status: 'static-production-flow-passed', browser: browser.version(), dpr: 2, visibleSource: 'dom', evidenceSource: 'scene-evidence-canvas', nativeProvider: false,
    sourceSnapshot: capture.presentation!.baseSceneId, savedFrame: capture.presentation!.frameSeq, bitmap: capture.presentation!.bitmap, comparison, reloadSameCapture: true, samePage: true, sourceDOMOpacity: 1,
    pendingBlobRecovery: { storedBeforeUpload: true, objectDeletedAfterDone: true, sameSource: true, savedOldFrame: restoredAnnotation.capture!.presentation!.frameSeq, comparison: restoredComparison },
    cancelBeforeSourceHold: { lateResponseReleased: true, commentRetained: true, laterBodyRetained: true, captureComplete: false }, failedResponses, output,
    cancelAfterSourceSave: { lateResponseReleased: true, savedVersion, invalidatedVersion: cancelledAfterSave.captureState!.version, commentRetained: true, captureComplete: false },
    serviceRestart: { sameURL: true, instanceChanged: true, captureComplete: true, viewGeneration: restartedAnnotation.sceneSource!.viewGeneration },
    limitations: ['actual Safari/Edge coverage and native HTML interaction acceptance are pending', 'CPU and RAM percentiles are pending'] };
  await writeFile(join(output, 'scene-production-execution.json'), JSON.stringify(facts, null, 2) + '\n');
  if (process.env.ACANVAS_SCENE_PRODUCTION_FACTS) await writeFile(process.env.ACANVAS_SCENE_PRODUCTION_FACTS, JSON.stringify(facts, null, 2) + '\n');
});
