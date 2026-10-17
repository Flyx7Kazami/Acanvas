// Measure complete content readiness after navigation, using an isolated copy of a local board.
// SOURCE_URL=http://127.0.0.1:PORT/?session=ID WEB_ROOT=dist/web node app/tests/load-performance.mjs
import { mkdtemp, writeFile, rm, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { startServer } from '../../dist/src/server/http.js';

const source = new URL(process.env.SOURCE_URL), sessionId = source.searchParams.get('session');
const { token } = await (await fetch(new URL('/api/bootstrap', source))).json();
const headers = { Authorization: `Bearer ${token}` };
const state = await (await fetch(new URL(`/api/state?sessionId=${sessionId}`, source), { headers })).json();
const root = await mkdtemp(join(tmpdir(), 'acanvas-load-study-'));
const server = await startServer({ root, port: 0, webRoot: resolve(process.env.WEB_ROOT || 'dist/web') });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const results = [];
try {
  for (const [index, asset] of state.assets.entries()) {
    const bytes = Buffer.from(await (await fetch(new URL(`/api/assets/${asset.id}/content`, source), { headers })).arrayBuffer()), path = `assets/${index}`;
    await writeFile(join(server.service.dataDir, path), bytes); server.service.registerAsset(asset, path);
  }
  const objects = [];
  for (const [index, object] of state.objects.entries()) {
    if (process.env.UNIQUE_ASSETS === '1') {
      const original = state.assets.find(asset => asset.id === object.assetId), asset = { ...original, id: `load-study-${index}` };
      const path = `assets/unique-${index}`;
      await copyFile(join(server.service.dataDir, `assets/${state.assets.indexOf(original)}`), join(server.service.dataDir, path));
      server.service.registerAsset(asset, path);
      objects.push({ ...object, assetId: asset.id });
    } else objects.push(object);
  }
  const session = server.service.createSession('Load study');
  server.service.boardOperations(session.id, objects.map(({ id, assetId, x, y, width, height }) => ({ type: 'create', object: { id, assetId, x, y, width, height } })));
  server.service.saveView(session.id, { x: 70, y: 120, zoom: .08, selectedObjectIds: [] });
  for (let run = 0; run < Number(process.env.RUNS || 3); run++) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 2 });
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(({ count }) => {
      performance.setResourceTimingBufferSize(4000);
      const result = window.loadStudy = { firstItems: 0, complete: 0, peakNodes: 0, peakLoaders: 0, longTasks: [] };
      new PerformanceObserver(list => { for (const entry of list.getEntries()) result.longTasks.push({ start: entry.startTime, duration: entry.duration }); }).observe({ type: 'longtask', buffered: true });
      function frame() {
        const objects = document.querySelectorAll('.board-object'), loaders = document.querySelectorAll('.content-loading');
        if (objects.length && !result.firstItems) result.firstItems = performance.now();
        result.peakLoaders = Math.max(result.peakLoaders, loaders.length);
        result.peakNodes = Math.max(result.peakNodes, document.getElementsByTagName('*').length);
        if (objects.length === count && !loaders.length && [...document.querySelectorAll('.object-media img')].every(image => image.complete && image.naturalWidth)) result.complete = performance.now();
        else requestAnimationFrame(frame);
      }
      requestAnimationFrame(frame);
    }, { count: state.objects.length });
    const cdp = process.env.PROFILE ? await context.newCDPSession(page) : undefined;
    if (cdp) { await cdp.send('Profiler.enable'); await cdp.send('Profiler.start'); }
    await page.goto(`${server.url}/?session=${session.id}`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.loadStudy.complete > 0, undefined, { timeout: 90000 });
    await page.waitForTimeout(100);
    const result = await page.evaluate(() => ({ ...window.loadStudy, resources: performance.getEntriesByType('resource').map(entry => ({ name: new URL(entry.name).pathname, start: entry.startTime, end: entry.responseEnd, duration: entry.duration, bytes: entry.transferSize })), nodes: document.getElementsByTagName('*').length }));
    if (cdp) await writeFile(`${process.env.OUTPUT || '/tmp/acanvas-load'}-${run}.cpuprofile`, JSON.stringify((await cdp.send('Profiler.stop')).profile));
    results.push({ run, ...result, errors });
    const content = result.resources.filter(entry => entry.name.endsWith('/content'));
    console.log(JSON.stringify({ run, firstItems: result.firstItems, complete: result.complete, peakNodes: result.peakNodes, peakLoaders: result.peakLoaders, nodes: result.nodes, longTasks: result.longTasks.length, longestTask: Math.max(0, ...result.longTasks.map(entry => entry.duration)), contentRequests: content.length, uniqueContent: new Set(content.map(entry => entry.name)).size, api: result.resources.filter(entry => entry.name.startsWith('/api/') && !entry.name.endsWith('/content')), errors }));
    await context.close();
  }
} finally { await browser.close(); await server.close(); await rm(root, { recursive: true, force: true }); }
await writeFile(process.env.OUTPUT || '/tmp/acanvas-load-results.json', JSON.stringify(results, null, 2));
