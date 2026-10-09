import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { sceneCrop, boundsToCSS, immutableCopy } from '../src/web/scene-renderer/geometry.js';

test('scene crop maps an offset CSS viewport to actual bitmap edges', () => {
  const result = sceneCrop({ x: 31, y: 23, width: 320, height: 240 }, { width: 641, height: 479 }, { x: 21, y: 47.25, width: 100.2, height: 80.5 });
  assert.deepEqual(result.sourcePixels, { x: 0, y: 48, width: 181, height: 162 });
  assert.deepEqual(result.bitmap, { width: 181, height: 162 });
  assert.equal(result.cropCSS.x, 31); assert.equal(result.scaleX, 641 / 320); assert.equal(result.scaleY, 479 / 240);
  assert.equal(result.cropCSS.y, 23 + 48 * 240 / 479);
  assert.deepEqual(boundsToCSS({ x: 10, y: 20, width: 30, height: 40 }, { x: -5, y: 8, zoom: 2 }, { x: 31, y: 23 }), { x: 46, y: 71, width: 60, height: 80 });
});

test('scene crop rejects unavailable pixels and metadata copies keep their frame state', () => {
  const viewport = { x: 31, y: 23, width: 320, height: 240 }, bitmap = { width: 640, height: 480 };
  assert.throws(() => sceneCrop(viewport, bitmap, { x: -80, y: -80, width: 20, height: 20 }), /intersect/);
  assert.throws(() => sceneCrop(viewport, { width: 0, height: 480 }), /dimensions/);
  assert.throws(() => sceneCrop(viewport, bitmap, { x: NaN, y: 0, width: 20, height: 20 }), /finite/);
  assert.throws(() => sceneCrop({ ...viewport, x: NaN }, bitmap), /finite/);
  const metadata = { camera: { x: 5 }, media: [{ time: 2 }] }, copied = immutableCopy(metadata);
  metadata.camera.x = 99; metadata.media[0].time = 99;
  assert.equal(copied.camera.x, 5); assert.equal(copied.media[0].time, 2); assert.ok(Object.isFrozen(copied.media[0]));
});

test('scene prototype preserves the visible frame in configured browsers', { skip: !process.env.ACANVAS_SCENE_BROWSER_TEST, timeout: 180_000 }, async t => {
  const { createServer } = await import('vite');
  const { chromium, firefox } = await import('playwright-core');
  const { CanvasService } = await import('../src/server/service.js');
  const { startHtmlPreview } = await import('../src/server/html-preview.js');
  const { ProjectHtmlSurfaces } = await import('../src/server/render-surface/html.js');
  const output = process.env.ACANVAS_SCENE_OUTPUT ?? await mkdtemp(join(tmpdir(), 'acanvas-scene-prototype-'));
  await mkdir(output, { recursive: true });
  const server = await createServer({ configFile: false, root: process.cwd(), server: { host: '127.0.0.1', port: 0, watch: null }, logLevel: 'error' });
  await server.listen(); t.after(() => server.close());
  const url = `${server.resolvedUrls!.local[0]}tests/fixtures/universal-scene/index.html`;
  const measurements: Record<string, unknown>[] = [];
  const htmlRoot = await mkdtemp(join(tmpdir(), 'acanvas-scene-html-combined-')), service = new CanvasService(htmlRoot), session = service.createSession('Scene surface fixture');
  const htmlBytes = Buffer.from('<!doctype html><style>body{margin:0;background:#173948;color:white}canvas{display:inline-block}input{height:22px;width:180px}#motion{position:absolute;left:20px;top:200px;width:30px;height:30px;background:#f8b633}</style><input value="retained form"><canvas id="random" width="180" height="160"></canvas><canvas id="gl" width="160" height="160"></canvas><div id="motion"></div><script>window.sceneFixture={seed:Math.random(),tick:0};const c=document.querySelector("#random").getContext("2d");c.fillStyle="rgb("+Math.floor(50+sceneFixture.seed*150)+",150,70)";c.fillRect(0,0,180,160);const g=document.querySelector("#gl").getContext("webgl");sceneFixture.webgl=!!g;sceneFixture.preserveDrawingBuffer=g?.getContextAttributes().preserveDrawingBuffer;function paint(){sceneFixture.tick++;if(g){g.clearColor(.12,(sceneFixture.tick%50)/50,.6,1);g.clear(g.COLOR_BUFFER_BIT)}document.querySelector("#motion").style.left=(20+sceneFixture.tick%200)+"px";requestAnimationFrame(paint)}paint()</script>');
  await writeFile(join(service.dataDir, 'assets/scene-lab.html'), htmlBytes);
  const htmlAsset = service.registerAsset({ id: 'scene-lab', name: 'scene-lab.html', mime: 'text/html', size: htmlBytes.length, kind: 'file', createdAt: new Date().toISOString() }, 'assets/scene-lab.html');
  const htmlObject = service.boardOperations(session.id, [{ type: 'create', object: { assetId: htmlAsset.id, x: 12, y: 16, width: 288, height: 156 } }]).objects[0];
  const preview = await startHtmlPreview(service), manager = new ProjectHtmlSurfaces(service, preview, { engine: 'chromium' });
  const html = await manager.create({ sessionId: session.id, documentId: 'laboratory-document', viewId: 'laboratory-view', viewGeneration: 1, objectId: htmlObject.id, assetId: htmlAsset.id }, { width: 480, height: 260 });
  const htmlPage = (manager as any).entries.get(html.surfaceId).page as import('playwright-core').Page;
  const htmlContent = htmlPage.frames().find(frame => frame.parentFrame())!;
  t.after(async () => { await manager.close(); await preview.close(); service.close(); await rm(htmlRoot, { recursive: true, force: true }); });
  for (const engine of (process.env.ACANVAS_SCENE_BROWSERS === 'chromium' ? ['chromium'] as const : ['chromium', 'firefox'] as const)) {
    const browser = engine === 'chromium' ? await chromium.launch({ channel: 'chrome', headless: true })
      : await firefox.launch({ headless: true, ...(process.env.ACANVAS_SCENE_FIREFOX ? { executablePath: process.env.ACANVAS_SCENE_FIREFOX } : {}) });
    t.after(() => browser.close());
    for (const dpr of [1, 2]) {
      const context = await browser.newContext({ viewport: { width: 880, height: 640 }, deviceScaleFactor: dpr });
      await context.tracing.start({ screenshots: true, snapshots: true });
      const page = await context.newPage();
      const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
      try {
        await page.goto(url); await page.waitForFunction(() => Boolean((window as any).sceneLab));
        await page.locator('#comment').focus();
        const initialPages = context.pages().length, initialURL = page.url();
        const call = <R>(method: string, ...args: unknown[]): Promise<R> => page.evaluate(({ method, args }) => (window as any).sceneLab[method](...args), { method, args });
        await call('render', 10, { count: 70 }); await call('present', 10);
        await page.evaluate(() => new Promise(requestAnimationFrame));
        const frozen = await call<any>('capture');
        assert.equal(frozen.presentation.frameSeq, 10); assert.equal(frozen.presentation.layers.length, 71);
        assert.deepEqual(frozen.presentation.cssViewport, { x: 31, y: 23, width: 320, height: 240 });
        assert.equal(frozen.presentation.camera.x, 0); assert.equal(frozen.presentation.media[0].presentedTime, 1);
        assert.equal(frozen.presentation.layers[0].worldBounds.x, 12); assert.equal(frozen.presentation.layers[0].renderedBounds.x, 43);
        assert.deepEqual(await call('visiblePixel', 148 * dpr, 75 * dpr), [123, 188, 255, 255]);
        const frame10Pixels = await call<number[]>('currentPixels');
        // The worker has generated N+5 while the main thread still displays N.
        await call('worker', 15, { dark: true, zoom: 1.5, changed: true });
        const ahead = await call<any>('capture'); assert.equal(ahead.presentation.frameSeq, 10);
        assert.equal(await call('present', 15), true);
        const frame15Pixels = await call<number[]>('currentPixels');
        assert.ok(frame10Pixels.some((value, index) => value !== frame15Pixels[index]), 'N and N+5 must contain different actual pixels');
        await call('worker', 12); assert.equal(await call('present', 12), false);
        assert.equal((await call<any>('presented')).frameSeq, 15);
        const encoded = await call<any>('encode', frozen.id), encodedAhead = await call<any>('encode', ahead.id);
        assert.equal(encoded.frameSeq, 10); assert.equal(encoded.mismatchedChannels, 0); assert.equal(encodedAhead.mismatchedChannels, 0);
        assert.deepEqual([encoded.width, encoded.height], [320 * dpr, 240 * dpr]);
        await writeFile(join(output, `${engine}-dpr${dpr}-frame10.png`), Buffer.from(encoded.png));
        // Crop a partly offscreen region, then resize/pan/zoom/theme while encoding is pending.
        await call('render', 20, { width: 320, height: 260, zoom: 1.75, x: -90, y: 15, dark: true, scale: dpr + .003 }); await call('present', 20);
        const cropped = await call<any>('capture', { x: 21, y: 47.25, width: 100.2, height: 80.5 });
        const pending = call<any>('encode', cropped.id);
        await call('render', 21, { width: 220, height: 180, x: 30, zoom: .75 }); await call('present', 21);
        const encodedCrop = await pending; assert.equal(encodedCrop.mismatchedChannels, 0); assert.equal(encodedCrop.frameSeq, 20);
        assert.deepEqual([encodedCrop.width, encodedCrop.height], [cropped.crop.bitmap.width, cropped.crop.bitmap.height]);
        await writeFile(join(output, `${engine}-dpr${dpr}-crop20.png`), Buffer.from(encodedCrop.png));
        // Page CSS zoom and canvas zoom have independent effects on the actual CSS mapping.
        await call('cssZoom', 1.25); await call('render', 30, { zoom: 2, x: -25 }); await call('present', 30);
        const zoomed = await call<any>('capture'); assert.equal(zoomed.presentation.cssViewport.width, 400);
        assert.equal(zoomed.presentation.cssViewport.x, 38.75); assert.equal(zoomed.presentation.camera.zoom, 2.5);
        assert.equal((await call<any>('encode', zoomed.id)).mismatchedChannels, 0);
        // A real requestAnimationFrame animation advances five displayed frames after Done.
        await call('cssZoom', 1); await call('render', 40); await call('present', 40); const animation = await call<any>('capture');
        await call('animateUntil', 45); const encodedAnimation = await call<any>('encode', animation.id);
        assert.equal((await call<any>('presented')).frameSeq, 45); assert.equal(encodedAnimation.frameSeq, 40); assert.equal(encodedAnimation.mismatchedChannels, 0);
        await page.locator('#scene').screenshot({ path: join(output, `${engine}-dpr${dpr}-display45.png`) });
        assert.deepEqual(await call('sourceMutation', 50), [219, 61, 69, 255]);
        const crossOriginTexture = new URL('tests/fixtures/universal-scene/texture.svg', server.resolvedUrls!.local[0]); crossOriginTexture.hostname = 'localhost';
        assert.equal(await call('taintedExport', 51, crossOriginTexture.href), 'SecurityError');
        assert.equal((await call<any>('presented')).frameSeq, 50);
        assert.deepEqual(await call('visiblePixel', 8 * dpr, 8 * dpr), [219, 61, 69, 255]);
        const htmlState = await htmlContent.evaluate(() => ({ ...(window as any).sceneFixture, form: (document.querySelector('input') as HTMLInputElement).value }));
        assert.equal(htmlState.webgl, true); assert.equal(htmlState.preserveDrawingBuffer, false);
        const htmlFrame = await manager.sample(html.surfaceId);
        await call('surface', 60, { ...htmlFrame, png: Array.from(htmlFrame.png) }); await call('present', 60); const htmlEvidence = await call<any>('capture');
        let htmlLatest = htmlFrame;
        for (let index = 0; index < 5; index++) {
          const tick = await htmlContent.evaluate(() => (window as any).sceneFixture.tick);
          await htmlContent.waitForFunction(previous => (window as any).sceneFixture.tick > previous, tick, { timeout: 5_000 });
          htmlLatest = await manager.sample(html.surfaceId);
        }
        assert.equal(htmlLatest.frameSeq, htmlFrame.frameSeq + 5); assert.ok(!htmlLatest.png.equals(htmlFrame.png), 'persistent HTML animation must advance actual pixels');
        const encodedHTML = await call<any>('encode', htmlEvidence.id);
        assert.equal(encodedHTML.mismatchedChannels, 0); assert.equal(htmlEvidence.presentation.layers[0].surface.frameSeq, htmlFrame.frameSeq);
        assert.equal(htmlEvidence.presentation.layers[0].surface.instanceId, htmlLatest.instanceId);
        const htmlAfter = await htmlContent.evaluate(() => ({ ...(window as any).sceneFixture, form: (document.querySelector('input') as HTMLInputElement).value }));
        assert.equal(htmlAfter.seed, htmlState.seed); assert.equal(htmlAfter.form, htmlState.form); assert.ok(htmlAfter.tick > htmlState.tick);
        await writeFile(join(output, `${engine}-dpr${dpr}-html-surface.png`), Buffer.from(encodedHTML.png));
        const board = await call<any>('boardContent', 70, { count: 70 });
        assert.equal(board.accepted, true); assert.equal(board.frozen, true); assert.deepEqual(board.pixel, [219, 61, 69, 255]);
        assert.equal(board.presentation.layers.length, 72); assert.equal(board.presentation.camera.x, 0); assert.equal(board.presentation.media[0].presentedTime, 7);
        const boardEvidence = await call<any>('capture'), boardPixels = await call<number[]>('currentPixels');
        for (const kind of ['texture', 'image', 'dimensions', 'draw']) {
          const rejected = await call<any>('rejectContent', 71, kind);
          assert.equal(rejected.callbackCalled, false); assert.equal(rejected.frameSeq, 70); assert.notEqual(rejected.error, 'accepted');
          assert.deepEqual(await call('currentPixels'), boardPixels);
        }
        assert.equal(await call('taintedContent', 71, crossOriginTexture.href), 'SecurityError');
        assert.equal((await call<any>('presented')).frameSeq, 70); assert.deepEqual(await call('currentPixels'), boardPixels);
        await call('render', 74, { dark: true });
        assert.equal((await call<any>('boardContent', 75, { count: 70, changed: true, zoom: 1.25, x: -20 })).accepted, true);
        assert.equal(await call('present', 74), false); assert.equal((await call<any>('presented')).frameSeq, 75);
        assert.equal((await call<any>('boardContent', 73)).accepted, false);
        const encodedBoard = await call<any>('encode', boardEvidence.id);
        assert.equal(encodedBoard.frameSeq, 70); assert.equal(encodedBoard.mismatchedChannels, 0);
        await writeFile(join(output, `${engine}-dpr${dpr}-board70.png`), Buffer.from(encodedBoard.png));
        assert.equal(context.pages().length, initialPages); assert.equal(page.url(), initialURL);
        assert.equal(await page.evaluate(() => document.activeElement?.id), 'comment'); assert.deepEqual(errors, []);
        measurements.push({ engine, browserVersion: browser.version(), dpr, displayedFrame: 45, savedFrame: 40, workerAheadFrame: 15, capturedWhileWorkerAhead: 10,
          workerStaleFrame: 12, staleAccepted: false, fullBitmap: [encoded.width, encoded.height], cropBitmap: [encodedCrop.width, encodedCrop.height],
          comparedChannels: encoded.comparedChannels + encodedAhead.comparedChannels + encodedCrop.comparedChannels + encodedAnimation.comparedChannels + encodedHTML.comparedChannels,
          mismatchedChannels: 0, mutableSourcePixel: [219, 61, 69, 255], taintedCandidate: 'SecurityError', previousExportableFrameRetained: 50,
          htmlSurface: { presentedFrame: htmlFrame.frameSeq, latestFrame: htmlLatest.frameSeq, savedFrame: htmlEvidence.presentation.layers[0].surface.frameSeq, instanceId: htmlFrame.instanceId, mismatchedChannels: encodedHTML.mismatchedChannels, actualBitmap: htmlFrame.bitmap, animationAdvanced: true, randomInstanceRetained: true, formRetained: true, webglDefaultPreserveDrawingBuffer: false },
          boardContent: { savedFrame: 70, currentFrame: 75, completeLayers: 72, sourceCopyImmutable: true, invalidInputRetainsPixels: ['texture', 'image', 'dimensions', 'draw', 'taint'], mismatchedChannels: encodedBoard.mismatchedChannels, comparedChannels: encodedBoard.comparedChannels },
          encodeMs: [encoded.encodedMs, encodedCrop.encodedMs, encodedAnimation.encodedMs], pageCount: initialPages, focus: 'comment', output });
      } finally {
        await context.tracing.stop({ path: join(output, `${engine}-dpr${dpr}-trace.zip`) }); await context.close();
      }
    }
    await browser.close();
  }
  const report = { generatedAt: new Date().toISOString(), stage: 'P1 scene prototype', node: process.version, result: 'passed', measurements,
    verified: ['visible Canvas uses candidate pixels', 'paired immutable presentation', 'Done synchronous copy before encoding', 'worker ahead and stale candidates', 'DPR1/2 actual dimensions', 'offset viewport and partial crop', 'resize/pan/canvas zoom/page CSS zoom/theme/marks', '70 objects', 'animation N to N+5', 'mutable texture source isolation', 'cross-origin canvas export failure', 'persistent HTML surface into actual SceneRenderer', 'same page and focus'],
    pending: ['production App integration', 'video/GIF/Markdown/HTML semantics', 'actual embedded browser', 'upload and persisted recovery', 'p50/p95 CPU/RAM'], output };
  await writeFile(join(output, 'scene-prototype-execution.json'), `${JSON.stringify(report, null, 2)}\n`);
  if (process.env.ACANVAS_SCENE_FACTS) await writeFile(resolve(process.env.ACANVAS_SCENE_FACTS), `${JSON.stringify(report, null, 2)}\n`);
});
