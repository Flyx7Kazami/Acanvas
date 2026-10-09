import test from 'node:test';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { startServer } from '../src/server/http.js';
import type { BoardState } from '../src/shared/types.js';
import { gifFixture } from './fixtures/universal-media/gif-fixture.js';

test('ordinary production clients export the actual visible material frames through Done', { skip: process.env.ACANVAS_SCENE_TYPES_TEST !== '1', timeout: 180_000 }, async t => {
  const { chromium, firefox } = await import('playwright-core');
  const output = process.env.ACANVAS_SCENE_TYPES_OUTPUT || await mkdtemp(join(tmpdir(), 'acanvas-scene-types-output-')); await mkdir(output, { recursive: true });
  const results: object[] = [], performanceResults: object[] = [];
  const htmlEngine = process.env.ACANVAS_SCENE_TYPES_HTML_ENGINE === 'cef' ? 'cef' : 'chromium';
  const percentiles = (values: number[]) => { const sorted = [...values].sort((a, b) => a - b); return { samples: sorted.length, p50: sorted[Math.floor((sorted.length - 1) * .5)], p95: sorted[Math.ceil((sorted.length - 1) * .95)] }; };
  for (const engine of ['chromium', 'firefox'] as const) {
    const root = await mkdtemp(join(tmpdir(), 'acanvas-scene-types-')), server = await startServer({ root, port: 0, webRoot: resolve(process.env.ACANVAS_SCENE_WEB_ROOT || 'dist/web'), htmlSurfaces: { engine: htmlEngine } });
    const bootstrap = await (await fetch(server.url + '/api/bootstrap')).json();
    const call = async (path: string, method = 'GET', body?: unknown) => { const response = await fetch(server.url + path, { method, headers: { Authorization: 'Bearer ' + bootstrap.token, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); const result = await response.json(); assert.ok(response.ok, JSON.stringify(result)); return result; };
    const session = await call('/api/sessions', 'POST', { name: 'Material scene validation' });
    const materials = [
      { kind: 'image', name: 'Image.svg', mime: 'image/svg+xml', bytes: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="300" height="180"><rect width="300" height="180" fill="#83adc4"/><circle cx="80" cy="90" r="40" fill="#e8bf65"/></svg>'), bounds: { x: 100, y: 100, width: 300, height: 180 } },
      { kind: 'file', name: 'File.zip', mime: 'application/zip', bytes: Buffer.from('Controlled file scene'), bounds: { x: 470, y: 100, width: 300, height: 180 } },
      { kind: 'markdown', name: 'Document.md', mime: 'text/markdown', bytes: Buffer.from('# Notebook\n\nOriginal text and **visible marks**.\n\n' + Array.from({ length: 12 }, (_, index) => 'Line ' + index + ' continues.\n\n').join('')), bounds: { x: 840, y: 100, width: 300, height: 240 } },
      { kind: 'audio', name: 'Audio.mp3', mime: 'audio/mpeg', bytes: await readFile(resolve('tests/fixtures/amplitude-cover.mp3')), bounds: { x: 100, y: 430, width: 340, height: 100 } },
      { kind: 'gif', name: 'Motion.gif', mime: 'image/gif', bytes: Buffer.from(gifFixture({ repeat: 0, frames: [{ color: 1, left: 0, top: 0, width: 3, height: 3, disposal: 1, delay: 5 }, { color: 2, left: 0, top: 0, width: 3, height: 3, disposal: 1, delay: 200 }] })), bounds: { x: 500, y: 430, width: 240, height: 180 } },
      ...(process.env.ACANVAS_SCENE_TYPES_VIDEO === '1' ? [{ kind: 'video', name: 'Movie.mp4', mime: 'video/mp4', bytes: await readFile(resolve('tests/fixtures/frontend-video.mp4')), bounds: { x: 850, y: 430, width: 300, height: 170 } }] : []),
      ...(process.env.ACANVAS_SCENE_TYPES_HTML === '1' ? [{ kind: 'html', name: 'Surface.html', mime: 'text/html', bytes: Buffer.from('<!doctype html><style>body{margin:0;background:#233f5a;color:white;font:16px sans-serif}canvas{display:block}</style><p>Persistent surface</p><canvas width="260" height="130"></canvas><script>let n=0;const c=document.querySelector("canvas").getContext("2d");function paint(){n++;c.fillStyle="#28785a";c.fillRect(0,0,260,130);c.fillStyle="#f4c356";c.fillRect(n%210,15,40,60);requestAnimationFrame(paint)}paint()</script>'), bounds: { x: 850, y: 680, width: 300, height: 200 } }] : []),
    ];
    for (const material of materials) {
      const response = await fetch(server.url + '/api/assets?name=' + encodeURIComponent(material.name) + '&mime=' + encodeURIComponent(material.mime), { method: 'POST', headers: { Authorization: 'Bearer ' + bootstrap.token }, body: new Uint8Array(material.bytes) }); assert.ok(response.ok); const asset = await response.json();
      await call('/api/board/operations', 'POST', { sessionId: session.id, operations: [{ type: 'create', object: { assetId: asset.id, ...material.bounds } }] });
    }
    const browser = engine === 'chromium' ? await chromium.launch({ channel: 'chrome', headless: true }) : await firefox.launch({ headless: true, executablePath: process.env.ACANVAS_SCENE_FIREFOX });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 }), page = await context.newPage();
    const uploads: number[] = []; page.on('requestfinished', request => { if (request.method() === 'PUT' && /\/captures\/[^/]+\/content$/.test(new URL(request.url()).pathname)) { const elapsed = request.timing().responseEnd; if (elapsed >= 0) uploads.push(elapsed); } });
    const pageCDP = engine === 'chromium' ? await context.newCDPSession(page) : undefined, browserCDP = engine === 'chromium' ? await browser.newBrowserCDPSession() : undefined;
    if (pageCDP) await pageCDP.send('Performance.enable');
    const commandLine = browserCDP ? (await browserCDP.send('Browser.getBrowserCommandLine')).arguments as string[] : [];
    const profile = commandLine.find(value => value.startsWith('--user-data-dir='))?.slice('--user-data-dir='.length);
    const client = engine === 'chromium' ? { brand: 'Google Chrome', executable: commandLine[0], headless: commandLine.some(value => value.startsWith('--headless')), isolatedProfile: !!profile?.includes('playwright_chromiumdev_profile-'), profileDirectory: profile } : { brand: 'project Firefox engine', executable: process.env.ACANVAS_SCENE_FIREFOX, headless: true, isolatedContext: true };
    if (engine === 'chromium') { assert.equal(client.isolatedProfile, true); assert.equal(client.headless, true); }
    const heapSamples: number[] = [], rssSamples: number[] = [], cpuSamples: number[] = []; let priorCPU: { task: number; timestamp: number } | undefined;
    const sampleResources = async () => {
      if (!pageCDP || !browserCDP) return;
      const metrics = new Map((await pageCDP.send('Performance.getMetrics')).metrics.map((metric: any) => [metric.name, metric.value])) as Map<string, number>;
      const task = metrics.get('TaskDuration')!, timestamp = metrics.get('Timestamp')!; heapSamples.push(metrics.get('JSHeapUsedSize')! / 1048576);
      if (priorCPU && timestamp > priorCPU.timestamp) cpuSamples.push(Math.max(0, task - priorCPU.task) / (timestamp - priorCPU.timestamp) * 100); priorCPU = { task, timestamp };
      const processes = (await browserCDP.send('SystemInfo.getProcessInfo')).processInfo as { id: number }[];
      const rss = execFileSync('/bin/ps', ['-o', 'rss=', '-p', processes.map(value => String(value.id)).join(',')], { encoding: 'utf8' }).trim().split(/\s+/).reduce((sum, value) => sum + Number(value), 0); rssSamples.push(rss / 1024);
    };
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message)); await context.tracing.start({ screenshots: true, snapshots: true });
    t.after(async () => { await context.tracing.stop({ path: join(output, engine + '-trace.zip') }).catch(() => undefined); await browser.close(); await server.close(); await rm(root, { recursive: true, force: true }); });
    await page.addInitScript(() => {
      const original = CanvasRenderingContext2D.prototype.drawImage, copied = new WeakSet<HTMLCanvasElement>(), metrics = { copyMs: [] as number[], encodeMs: [] as number[], inputToAnimationFrameMs: [] as number[] };
      (window as any).sceneMeasurements = metrics;
      document.addEventListener('pointerdown', () => { const start = performance.now(); requestAnimationFrame(() => metrics.inputToAnimationFrameMs.push(performance.now() - start)); }, true);
      CanvasRenderingContext2D.prototype.drawImage = function (this: CanvasRenderingContext2D, ...args: any[]) {
        const source = args[0];
        if (source instanceof HTMLCanvasElement && source.classList.contains('scene-canvas') && args.length === 9 && this.canvas !== source) {
          const start = performance.now(), result = (original as any).apply(this, args); metrics.copyMs.push(performance.now() - start); copied.add(this.canvas);
          (window as any).sceneCaptureOracle = { seq: Number(source.dataset.frameSeq), width: args[7], height: args[8], pixels: source.getContext('2d')!.getImageData(args[1], args[2], args[3], args[4]).data }; return result;
        }
        return (original as any).apply(this, args);
      } as typeof original;
      const toBlob = HTMLCanvasElement.prototype.toBlob;
      HTMLCanvasElement.prototype.toBlob = function (this: HTMLCanvasElement, callback: BlobCallback, type?: string, quality?: number) { if (!copied.has(this)) return toBlob.call(this, callback, type, quality); const start = performance.now(); return toBlob.call(this, blob => { metrics.encodeMs.push(performance.now() - start); callback(blob); }, type, quality); };
    });
    await page.goto(server.url + '/?session=' + session.id); await page.waitForFunction(() => Boolean(document.querySelector('.scene-canvas')?.getAttribute('data-frame-seq')));
    await page.evaluate(() => document.fonts.ready);
    await sampleResources();
    const state = await call('/api/state?sessionId=' + session.id) as BoardState;
    for (const material of materials) {
      await sampleResources();
      const asset = state.assets.find(value => value.name === material.name)!, object = state.objects.find(value => value.assetId === asset.id)!;
      if (material.kind === 'gif') await page.waitForFunction(id => document.querySelector<HTMLElement>('[data-object-id="' + id + '"] [data-scene-media="gif"]')?.dataset.frameIndex === '1', object.id);
      if (material.kind === 'video') await page.locator('[data-object-id="' + object.id + '"] video').evaluate(async element => { const video = element as HTMLVideoElement; await new Promise<void>(resolve => { if (video.readyState >= 2) resolve(); else video.addEventListener('loadeddata', () => resolve(), { once: true }); }); video.currentTime = .7; await new Promise<void>(resolve => video.addEventListener('seeked', () => resolve(), { once: true })); });
      await page.locator('[data-object-id="' + object.id + '"]').focus(); await page.keyboard.press('Enter'); await page.getByRole('button', { name: 'Annotate', exact: true }).click();
      await page.getByRole('textbox', { name: 'Add a comment', exact: true }).fill('Retain the visible ' + material.kind + ' frame.');
      await page.getByRole('button', { name: 'Done', exact: true }).click();
      await page.waitForFunction(() => !document.querySelector('.capture-progress'));
      const saved = await call('/api/state?sessionId=' + session.id) as BoardState, annotation = saved.draft.annotations.find(value => value.text === 'Retain the visible ' + material.kind + ' frame.')!;
      assert.equal(annotation.captureState?.status, 'complete', engine + '/' + material.kind + ': ' + await page.locator('.draft-annotations').textContent().catch(() => ''));
      const capture = annotation.capture!, response = await fetch(server.url + '/api/assets/' + capture.screenshotAssetId + '/content?sessionId=' + session.id, { headers: { Authorization: 'Bearer ' + bootstrap.token } }); assert.ok(response.ok); const png = Buffer.from(await response.arrayBuffer()); await writeFile(join(output, engine + '-' + material.kind + '.png'), png);
      const comparison = await page.evaluate(async bytes => { const oracle = (window as any).sceneCaptureOracle, image = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: 'image/png' })), canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height; canvas.getContext('2d')!.drawImage(image, 0, 0); image.close(); const actual = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data; let mismatches = 0; for (let index = 0; index < actual.length; index++) if (actual[index] !== oracle.pixels[index]) mismatches++; return { seq: oracle.seq, width: canvas.width, height: canvas.height, channels: actual.length, mismatches }; }, Array.from(png));
      assert.equal(comparison.mismatches, 0); assert.equal(capture.presentation!.frameSeq, comparison.seq);
      const media = capture.presentation!.media.find(value => value.objectId === object.id);
      if (material.kind === 'gif') { assert.equal(media?.frameIndex, 1); assert.equal(media?.timePrecision, 'decoded-pts'); }
      if (material.kind === 'video') assert.ok(media?.presentedTime !== undefined && Math.abs(media.presentedTime - .7) < .12);
      if (material.kind === 'html') assert.ok(capture.presentation!.layers.find(value => value.objectId === object.id)?.surface);
      await sampleResources();
      results.push({ engine, browser: browser.version(), client, kind: material.kind, sourceMode: capture.sourceMode, frame: capture.presentation!.frameSeq, comparison, media });
    }
    await page.getByRole('combobox', { name: 'Request', exact: true }).fill('Use these saved material scenes.'); await page.getByRole('button', { name: 'Send request', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('.queue-item').length === 1); assert.equal((await call('/api/state?sessionId=' + session.id)).tasks.length, 1); assert.equal(context.pages().length, 1); assert.deepEqual(errors, []);
    const measurements = await page.evaluate(() => (window as any).sceneMeasurements as { copyMs: number[]; encodeMs: number[]; inputToAnimationFrameMs: number[] });
    performanceResults.push({ engine, viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1, copyMilliseconds: percentiles(measurements.copyMs), pngEncodeMilliseconds: percentiles(measurements.encodeMs), pointerdownToNextAnimationFrameMilliseconds: percentiles(measurements.inputToAnimationFrameMs), captureUploadHTTPMilliseconds: percentiles(uploads), ...(engine === 'chromium' ? { rendererTaskCPUPercent: percentiles(cpuSamples), rendererJSHeapMiB: percentiles(heapSamples), ownedFrontendBrowserProcessRSSMiB: percentiles(rssSamples) } : {}), measurementScope: 'short isolated seven-material production capture run; copy drawImage call duration excludes pixel-oracle readback; CPU is frontend page TaskDuration/wall interval; RSS sums only PIDs reported by its owned Chrome CDP; backend render process and service memory excluded; screenshot tracing and pixel-oracle readback are active, so these are instrumented-run samples rather than steady-state product measurements' });
    await page.screenshot({ path: join(output, engine + '-final.png') }); await context.tracing.stop({ path: join(output, engine + '-trace.zip') }); await browser.close(); await server.close(); await rm(root, { recursive: true, force: true });
  }
  const facts = { measuredAt: new Date().toISOString(), status: 'material-production-flow-passed', engines: ['Chrome channel', 'project Firefox engine'], results, htmlSurfaceEngine: htmlEngine, performance: performanceResults, defaultDoneToThumbnailToSend: true, nativeProvider: false, openedCaptureWindows: 0, output, pending: ['actual Safari/Edge and embedded App matrix', 'native HTML widget/audio/clipboard policy', 'sustained workload and native HTML backend performance'] };
  await writeFile(join(output, 'scene-types-execution.json'), JSON.stringify(facts, null, 2) + '\n'); if (process.env.ACANVAS_SCENE_TYPES_FACTS) await writeFile(process.env.ACANVAS_SCENE_TYPES_FACTS, JSON.stringify(facts, null, 2) + '\n');
});
