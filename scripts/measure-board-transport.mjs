import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { chromium } from 'playwright-core';
import { loadavg } from 'node:os';

const dist = resolve(process.env.ACANVAS_TRANSPORT_DIST || 'dist');
const webRoot = resolve(process.env.ACANVAS_TRANSPORT_WEB_ROOT || join(dist, 'web'));
const output = process.env.ACANVAS_TRANSPORT_OUTPUT || await mkdtemp('/private/tmp/acanvas-board-transport-output-');
await mkdir(output, { recursive: true });
const load = path => import(pathToFileURL(join(dist, path)).href);
const { startServer } = await load('src/server/http.js');
const { launchRenderEngine } = await load('src/server/render-surface/engine.js');
const { ProjectHtmlSurfaces } = await load('src/server/render-surface/html.js');
const { NativeHtmlRuntime } = await load('src/server/render-surface/cef.js');
const mixed = process.env.ACANVAS_TRANSPORT_MIXED === '1', pagesCount = Number(process.env.ACANVAS_TRANSPORT_PAGES || (mixed ? 3 : 6));
const root = await mkdtemp('/private/tmp/acanvas-board-transport-project-');
const report = { systemLoadAverageAtStart: loadavg(), status: 'incomplete', measuredAt: new Date().toISOString(), version: process.env.ACANVAS_TRANSPORT_VERSION || 'working-tree', root, dist, webRoot, output, scope: mixed ? 'Owned 12-object synthetic media / normal CEF' : 'Owned six-object PNG and Markdown / no CEF', pageCount: pagesCount, cefOpen: [], surfaceCreate: [], pages: [], boundaries: ['Same browser context and network partition; loopback HTTP/1.1 origin.', 'First navigation, warmed HTTP reads and first-page reload are reported separately.', 'PNG fetch queue and image decode elapsed intervals are separate; decode intervals include asynchronous wait and CPU, rather than measuring decoder CPU alone.', 'Audio/video duration and codecs are synthetic; actual user media metadata was outside the non-content read scope.', 'No foreground browser or user canvas operations.'] };
let phase = 'setup';
const originalCreate = ProjectHtmlSurfaces.prototype.create, originalOpen = NativeHtmlRuntime.prototype.open,originalSample=ProjectHtmlSurfaces.prototype.sample;
report.surfaceFirstSample=[];
ProjectHtmlSurfaces.prototype.sample=async function(...args){const at=performance.now();const frame=await originalSample.apply(this,args);if(frame.frameSeq===1)report.surfaceFirstSample.push({phase,startMs:at,endMs:performance.now(),elapsedMs:performance.now()-at,surfaceId:frame.surfaceId,viewId:frame.owner.viewId,bitmap:frame.bitmap});return frame;};
ProjectHtmlSurfaces.prototype.create = async function (...args) { const at = performance.now(); try { const value = await originalCreate.apply(this, args); report.surfaceCreate.push({ phase, startMs: at, endMs: performance.now(), elapsedMs: performance.now() - at, engine: value.engine }); return value; } catch (error) { report.surfaceCreate.push({ phase, startMs: at, endMs: performance.now(), elapsedMs: performance.now() - at, code: error.code }); throw error; } };
NativeHtmlRuntime.prototype.open = async function (...args) {
  if (process.env.ACANVAS_TRANSPORT_NATIVE_EXECUTABLE) { this.executable = resolve(process.env.ACANVAS_TRANSPORT_NATIVE_EXECUTABLE); this.helperPrefix = join(this.executable, '..', '..', 'Frameworks', 'acanvas-surface Helper'); }
  const at = performance.now(); try { const value = await originalOpen.apply(this, args); report.cefOpen.push({ phase, startMs: at, endMs: performance.now(), elapsedMs: performance.now() - at }); return value; } catch (error) { report.cefOpen.push({ phase, startMs: at, endMs: performance.now(), elapsedMs: performance.now() - at, failed: true }); throw error; }
};
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let server, browser;
try {
  server = await startServer({ root, port: 0, webRoot });
  const bootstrap = await (await fetch(server.url + '/api/bootstrap')).json();
  const call = async (path, method = 'GET', body) => { const response = await fetch(server.url + path, { method, headers: { Authorization: 'Bearer ' + bootstrap.token, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }); const value = await response.json(); assert(response.ok, JSON.stringify(value)); return value; };
  const upload = async (name, mime, body) => { const response = await fetch(server.url + '/api/assets?name=' + encodeURIComponent(name) + '&mime=' + encodeURIComponent(mime), { method: 'POST', headers: { Authorization: 'Bearer ' + bootstrap.token }, body }); assert(response.ok); return response.json(); };
  const sessions = [await call('/api/sessions', 'POST', { name: 'Owned transport A' }), await call('/api/sessions', 'POST', { name: 'Owned transport B' })];
  const assets = [], tinyPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/kWQAAAAASUVORK5CYII=', 'base64');
  for (let index = 0; index < 5; index++) assets.push(await upload(`Owned image ${index}.png`, 'image/png', mixed ? await readFile(join(process.env.ACANVAS_TRANSPORT_FIXTURES, `image-${index}.png`)) : Buffer.concat([tinyPng, Buffer.alloc(200_000 + index)])));
  if (mixed) {
    assets.push(await upload('Owned video.mp4', 'video/mp4', await readFile(join(process.env.ACANVAS_TRANSPORT_FIXTURES, 'video.mp4'))));
    assets.push(await upload('Owned audio.m4a', 'audio/x-m4a', await readFile(join(process.env.ACANVAS_TRANSPORT_FIXTURES, 'audio.m4a'))));
    assets.push(await upload('Owned audio.mp3', 'audio/mpeg', await readFile(join(process.env.ACANVAS_TRANSPORT_FIXTURES, 'audio.mp3'))));
    for (let index = 0; index < 3; index++) assets.push(await upload(`Owned HTML ${index}.html`, 'text/html', '<!doctype html><style>body{margin:0;background:#edf1f2;font:16px sans-serif}input{font:inherit;margin:12px}</style><input aria-label="Owned field" value="Ready"><!--' + 'owned fixture '.repeat(12_500) + '-->'));
  }
  assets.push(await upload('Owned notes.md', 'text/markdown', '# Owned notebook\n\n' + 'Generated reference paragraph.\n\n'.repeat(90)));
  const bounds = [[-40.482,313.279,280.617,280.617],[276.866,313.279,280,280],[597.15,313.279,280,280],[920.818,313.279,210,280],[1184.866,313.279,616.54,411.027],[-40.482,654.192,597.347,797.855],[624.792,832.663,1087.465,134.966],[624.792,1012.416,1087.465,439.632],[-40.482,1534.71,740,247.882],[779.518,1534.71,740,247.882],[1599.518,1534.71,740,247.882],[1866.222,313.279,868.563,878.889]];
  await call('/api/board/operations', 'POST', { sessionId: sessions[0].id, operations: assets.map((asset, index) => { const [x, y, width, height] = bounds[mixed || index < 5 ? index : 11]; return { type: 'create', object: { assetId: asset.id, x, y, width, height } }; }) });
  for (const session of sessions) await call(`/api/sessions/${session.id}/view`, 'PUT', { x: 59.3354, y: 151.3372, zoom: .2306084356, selectedObjectIds: [] });
  report.materials = assets.map(({ mime, size }) => ({ mime, bytes: size }));
  browser = process.env.ACANVAS_TRANSPORT_CLIENT === 'chrome' ? await chromium.launch({ channel: 'chrome', headless: true, chromiumSandbox: true }) : await launchRenderEngine(process.env.ACANVAS_TRANSPORT_ENGINE_DIRECTORY);
  report.browser = browser.version();
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2 });
  await context.addInitScript(() => {
    performance.setResourceTimingBufferSize(10_000);
    window.transportFacts = { imageDecode: [], audioDecode: [], longTasks: [], lifecycle: [] };
    const imageDecode = HTMLImageElement.prototype.decode;
    HTMLImageElement.prototype.decode = async function (...args) { const at = performance.now(); try { return await imageDecode.apply(this, args); } finally { window.transportFacts.imageDecode.push(performance.now() - at); } };
    const audioDecode = BaseAudioContext.prototype.decodeAudioData;
    BaseAudioContext.prototype.decodeAudioData = function (...args) { const at = performance.now(), promise = audioDecode.apply(this, args); promise.then(() => window.transportFacts.audioDecode.push(performance.now() - at), () => undefined); return promise; };
    new PerformanceObserver(list => { for (const entry of list.getEntries()) window.transportFacts.longTasks.push(entry.duration); }).observe({ type: 'longtask' });
    for (const type of ['pagehide', 'pageshow']) window.addEventListener(type, event => window.transportFacts.lifecycle.push({ type, persisted: event.persisted }));
  });
  const targets = [];
  for (let index = 0; index < pagesCount; index++) {
    const page = await context.newPage(), cdp = await context.newCDPSession(page), pending = new Map(), row = { index, websocketCreated: 0, ready: 0, viewReady: 0, streams: [], errors: [],registration:[] };
    await cdp.send('Network.enable');
    cdp.on('Network.requestWillBeSent', event => { const path = new URL(event.request.url).pathname; if (path.startsWith('/api/')) pending.set(event.requestId, { kind: path === '/api/events' ? 'events' : path.endsWith('/presence') ? 'presence' : path.includes('/html-surfaces') ? 'html' : path.includes('/content') ? 'asset' : 'business', at: performance.now(), responseStarted: false }); });
    cdp.on('Network.responseReceived', event => { const value = pending.get(event.requestId); if (value) value.responseStarted = true; });
    for (const event of ['Network.loadingFinished', 'Network.loadingFailed']) cdp.on(event, info => pending.delete(info.requestId));
    cdp.on('Network.webSocketCreated', () => row.websocketCreated++);
    cdp.on('Network.webSocketFrameReceived', event => { try { const value = JSON.parse(event.response.payloadData); if (value.type === 'ready') row.ready++; if (value.type === 'view-ready') row.viewReady++;if(value.type==='ready'||value.type==='view-ready')row.registration.push({phase,type:value.type,atMs:performance.now()}); } catch {} });
    page.on('request', request => { const path = new URL(request.url()).pathname; if (path === '/api/events' || path.endsWith('/presence')) row.streams.push(path === '/api/events' ? 'events' : 'presence'); });
    page.on('pageerror', error => row.errors.push(error.message));
    report.pages.push(row); targets.push({ page, row, pending });
  }
  phase = 'cold-navigation';
  const navigationStart = performance.now();
  await Promise.all(targets.map(async ({ page, row }, index) => {
    const at = performance.now(); await page.goto(server.url + '/?session=' + sessions[index % sessions.length].id, { waitUntil: 'domcontentloaded' }); row.domContentLoadedMs = performance.now() - at;
    const ready = await page.waitForFunction(({ mixed, count }) => document.querySelectorAll('.board-object img').length >= 5 && [...document.querySelectorAll('.board-object img')].slice(0, 5).every(image => image.complete && image.naturalWidth > 0) && document.querySelectorAll('.board-object').length === count && document.querySelector('.markdown-content p') && (!mixed || (document.querySelectorAll('[data-preview-ready="true"]').length === 3 && document.querySelector('.board-object video')?.readyState >= 2 && ![...document.querySelectorAll('.audio-player-waveform [role="status"]')].some(node => node.textContent.includes('Loading')))), { mixed, count: assets.length }, { timeout: 25_000 }).then(() => true, () => false);
    row.allResourcesReady = ready; row.allResourcesReadyMs = performance.now() - at;
    row.readiness = await page.evaluate(() => ({ images: [...document.querySelectorAll('.board-object img')].slice(0, 5).map(image => ({ complete: image.complete, width: image.naturalWidth, height: image.naturalHeight })), htmlReady: document.querySelectorAll('[data-preview-ready="true"]').length, video: [...document.querySelectorAll('.board-object video')].map(video => ({ readyState: video.readyState, error: video.error?.code })), audio: [...document.querySelectorAll('.board-object audio')].map(audio => ({ readyState: audio.readyState, error: audio.error?.code })), waveformLoading: [...document.querySelectorAll('.audio-player-waveform [role="status"]')].some(node => node.textContent.includes('Loading')), markdownReady: !!document.querySelector('.markdown-body p') }));
  }));
  report.coldNavigationMs = performance.now() - navigationStart;
  phase = 'warm-http';
  report.directNodeStateProbeMs = await (async () => { const at = performance.now(); await call('/api/state?sessionId=' + sessions[0].id); return performance.now() - at; })();
  for (const { page, row, pending } of targets) {
    row.pending = [...pending.values()].map(({ kind, at, responseStarted }) => ({ kind, responseStarted, elapsedMs: performance.now() - at }));
    row.coldWebsocketCreated = row.websocketCreated;
    row.browserFacts = await page.evaluate(mimes => ({ ...window.transportFacts, resources: performance.getEntriesByType('resource').filter(entry => entry.name.includes('/api/')).map(entry => ({ kind: entry.name.includes('/html-surfaces') ? 'html' : entry.name.includes('/content') ? 'asset:' + (mimes[new URL(entry.name).pathname.split('/')[3]] || 'frame') : entry.name.includes('/state') ? 'state' : 'business', queuedMs: Math.max(0, entry.requestStart - entry.startTime), responseWaitMs: Math.max(0, entry.responseStart - entry.requestStart), bodyMs: Math.max(0, entry.responseEnd - entry.responseStart) })) }), Object.fromEntries(assets.map(asset => [asset.id, asset.mime])));
    row.warmProbe = await Promise.race([page.evaluate(async sessionId => { const at = performance.now(); await (await fetch('/api/state?sessionId=' + sessionId + '&ownedProbe=1')).arrayBuffer(); const entry = performance.getEntriesByType('resource').filter(entry => entry.name.includes('ownedProbe=1')).at(-1); return { elapsedMs: performance.now() - at, queuedMs: entry ? Math.max(0, entry.requestStart - entry.startTime) : undefined, responseWaitMs: entry ? entry.responseStart - entry.requestStart : undefined, bodyMs: entry ? entry.responseEnd - entry.responseStart : undefined, resourceTimingAvailable: !!entry }; }, sessions[row.index % sessions.length].id), delay(1500).then(() => ({ timeout: true }))]);
  }
  const first = targets[0];
  if (report.pages.every(page => page.allResourcesReady && !page.warmProbe.timeout)) {
    phase = 'reload-first-page';
    const at = performance.now(); await first.page.reload({ waitUntil: 'domcontentloaded' });
    const ready = await first.page.waitForFunction(mixed => document.querySelectorAll('.board-object img').length >= 5 && [...document.querySelectorAll('.board-object img')].slice(0, 5).every(image => image.complete && image.naturalWidth > 0) && (!mixed || document.querySelectorAll('[data-preview-ready="true"]').length === 3), mixed, { timeout: 25_000 }).then(() => true, () => false);
    report.reloadFirstPage = { ready, elapsedMs: performance.now() - at };
    await first.page.evaluate(() => { window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })); window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })); });
    report.syntheticPersistedLifecycle = await first.page.evaluate(() => window.transportFacts.lifecycle);
    report.status = ready ? 'passed' : 'incomplete';
  } else {
    report.status = 'reproduced-stall';
    await targets[0].page.close();
    report.afterFirstPageClosedProbe = await Promise.race([targets[1].page.evaluate(async sessionId => { const at = performance.now(); await (await fetch('/api/state?sessionId=' + sessionId)).arrayBuffer(); return { elapsedMs: performance.now() - at }; }, sessions[1].id), delay(5000).then(() => ({ timeout: true }))]);
  }
  await context.close();
} catch (error) { report.error = String(error); throw error; }
finally {
  await browser?.close(); await server?.close(); ProjectHtmlSurfaces.prototype.create = originalCreate; NativeHtmlRuntime.prototype.open = originalOpen;ProjectHtmlSurfaces.prototype.sample=originalSample;
  report.systemLoadAverageAtEnd = loadavg();
  await writeFile(join(output, 'transport.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ status: report.status, output, coldNavigationMs: report.coldNavigationMs, pages: report.pages.map(({ index, allResourcesReady, allResourcesReadyMs, websocketCreated, warmProbe }) => ({ index, allResourcesReady, allResourcesReadyMs, websocketCreated, warmProbe })), reload: report.reloadFirstPage }, null, 2));
}
