// Exercise native folder controls on a fixed 500-item board.
// WEB_ROOT=dist/web MEMBERS=200 ROUNDS=3 OUTPUT=/tmp/folders.json node app/tests/folder-performance.mjs
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { startServer } from '../../dist/src/server/http.js';

const count = 500, members = Number(process.env.MEMBERS || 200), rounds = Number(process.env.ROUNDS || 3);
const root = await mkdtemp(join(tmpdir(), 'acanvas-folder-performance-'));
const server = await startServer({ root, port: 0, webRoot: resolve(process.env.WEB_ROOT || 'dist/web') });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 });
const page = await context.newPage(), results = [];
try {
  for (const [id, mime, text] of [
    ['image', 'image/svg+xml', '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="210"><rect width="300" height="210" fill="#9aab9e"/><circle cx="200" cy="70" r="50" fill="#f0e5cb"/><text x="20" y="175" font-size="20">Light and proportion</text></svg>'],
    ['note', 'text/x-acanvas-note', 'Working notes\nExplore shape, rhythm, colour and composition.\nKeep the next iteration focused.'],
    ['markdown', 'text/markdown', '# Design brief\n\nA collection of ideas and references.\n\n- Shape and space\n- Rhythm and proportion\n- Colour and contrast'],
  ]) {
    let bytes = Buffer.from(text), sourceMime = mime;
    if (id === 'image' && process.env.PNG === '1') {
      bytes = Buffer.from(await page.evaluate(async svg => { const image = new Image(); image.src = 'data:image/svg+xml,' + encodeURIComponent(svg); await image.decode(); const canvas = document.createElement('canvas'); canvas.width = 300; canvas.height = 210; canvas.getContext('2d').drawImage(image, 0, 0); return canvas.toDataURL().split(',')[1]; }, text), 'base64'); sourceMime = 'image/png';
    }
    const path = `assets/${id}`;
    await writeFile(join(server.service.dataDir, path), bytes);
    server.service.registerAsset({ id, name: id, mime: sourceMime, kind: id === 'image' ? 'image' : 'file', size: bytes.length, createdAt: '2026-10-17T00:00:00.000Z' }, path);
  }
  const session = server.service.createSession('Folder performance');
  server.service.boardOperations(session.id, Array.from({ length: count }, (_, index) => ({ type: 'create', object: { id: `item-${index}`, assetId: ['image', 'note', 'markdown'][index % 3], x: (index % 20) * 340, y: Math.floor(index / 20) * 260, width: 300, height: 210 } })));
  server.service.boardOperations(session.id, [{ type: 'group.create', group: { id: 'study', name: 'Collection', objectIds: Array.from({ length: members }, (_, i) => `item-${i}`) }, expectedVersions: Object.fromEntries(server.service.objects().filter(object => Number(object.id.slice(5)) < members).map(object => [object.id, object.version])) }]);
  server.service.saveView(session.id, { x: 100, y: 110, zoom: .11, selectedObjectIds: [] });
  const cdp = await context.newCDPSession(page); await cdp.send('Performance.enable');
  await page.goto(`${server.url}/?session=${session.id}`);
  await page.waitForFunction(n => document.querySelectorAll('.board-object').length === n && !document.querySelector('.content-loading'), count);
  await page.evaluate(() => document.fonts.ready);
  for (let round = 0; round < rounds; round++) for (const action of ['collapse', 'enter', 'leave', 'expand']) {
    if (action === 'collapse' || action === 'expand') await page.getByRole('button', { name: 'Select group Collection', exact: true }).click();
    const button = page.getByRole('button', { name: { collapse: 'Store in folder', enter: 'Open folder Collection', leave: 'Back to board', expand: 'Expand on board' }[action], exact: true });
    await button.waitFor({ state: 'visible' }); await page.waitForTimeout(100);
    await page.evaluate(() => {
      const s = window.folderStudy = { start: performance.now(), frames: [], longTasks: [], running: true, firstMutation: 0, mounted: 0 };
      let last;
      function frame(now) { if (!s.running) return; if (last !== undefined) s.frames.push(now - last); last = now; requestAnimationFrame(frame); }
      requestAnimationFrame(frame);
      s.observer = new MutationObserver(() => { if (!s.firstMutation) s.firstMutation = performance.now() - s.start; s.mounted = Math.max(s.mounted, document.querySelectorAll('.board-object').length); });
      s.observer.observe(document.querySelector('.canvas-world'), { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class'] });
      s.tasks = new PerformanceObserver(list => s.longTasks.push(...list.getEntries().map(e => ({ start: e.startTime - s.start, duration: e.duration })))); s.tasks.observe({ type: 'longtask' });
    });
    const before = (await cdp.send('Performance.getMetrics')).metrics;
    if (process.env.TRACE === action) await cdp.send('Tracing.start', { categories: 'devtools.timeline,blink.user_timing', transferMode: 'ReturnAsStream' });
    if (process.env.PROFILE) { await cdp.send('Profiler.enable'); await cdp.send('Profiler.start'); }
    if (action === 'enter') { await button.focus(); await button.press('Enter'); }
    else await button.click();
    await page.waitForTimeout(1100);
    const after = (await cdp.send('Performance.getMetrics')).metrics;
    if (process.env.TRACE === action) {
      const completion = new Promise(resolve => cdp.once('Tracing.tracingComplete', resolve));
      await cdp.send('Tracing.end'); const { stream } = await completion; let data = '';
      for (;;) { const chunk = await cdp.send('IO.read', { handle: stream }); data += chunk.data; if (chunk.eof) break; }
      await cdp.send('IO.close', { handle: stream }); await writeFile(`${process.env.OUTPUT || '/tmp/folders'}-${round}-${action}.trace.json`, data);
    }
    if (process.env.PROFILE) await writeFile(`${process.env.OUTPUT || '/tmp/folders'}-${round}-${action}.cpuprofile`, JSON.stringify((await cdp.send('Profiler.stop')).profile));
    const value = await page.evaluate(() => { const s = window.folderStudy; s.running = false; s.observer.disconnect(); s.tasks.disconnect(); const frames = [...s.frames].sort((a,b)=>a-b); return { frameCount: frames.length, p95: frames[Math.floor(frames.length*.95)], longest: Math.max(...frames), over50: frames.filter(n=>n>50).length, longTasks: s.longTasks, firstMutation: s.firstMutation, peakItems: s.mounted, finalItems: document.querySelectorAll('.board-object').length, loading: document.querySelectorAll('.content-loading').length }; });
    const metrics = Object.fromEntries(after.filter(e => ['ScriptDuration', 'TaskDuration', 'LayoutDuration', 'RecalcStyleDuration'].includes(e.name)).map(e => [e.name, (e.value - before.find(b => b.name === e.name).value) * 1000]));
    const result = { round, action, members, ...metrics, ...value }; results.push(result); console.log(JSON.stringify(result));
  }
} finally { await browser.close(); await server.close(); await rm(root, { recursive: true, force: true }); await writeFile(process.env.OUTPUT || '/tmp/acanvas-folder-results.json', JSON.stringify(results, null, 2)); }
