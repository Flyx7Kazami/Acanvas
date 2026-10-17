// Build first, then run with Node 24. WEB_ROOT selects a production build.
// ITEMS=100,500,1000 ROUNDS=3 OUTPUT=/tmp/zoom.json node app/tests/zoom-performance.mjs
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import { startServer } from '../../dist/src/server/http.js';

const counts = (process.env.ITEMS || '100,500').split(',').map(Number);
const content = process.env.CONTENT || 'mixed';
const rounds = Number(process.env.ROUNDS || 3);
const output = process.env.OUTPUT || '/tmp/acanvas-zoom.json';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const results = [];
const percentile = (values, p) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * p))] ?? 0;
try {
  for (const count of counts) {
    const root = await mkdtemp(join(tmpdir(), 'acanvas-zoom-'));
    const server = await startServer({ root, port: 0, webRoot: resolve(process.env.WEB_ROOT || 'dist/web') });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage();
    try {
      const image = await page.evaluate(() => {
        const canvas = document.createElement('canvas'); canvas.width = 960; canvas.height = 640;
        const ctx = canvas.getContext('2d'); ctx.fillStyle = '#dae3d7'; ctx.fillRect(0, 0, 960, 640);
        for (let i = 0; i < 16; i++) { ctx.fillStyle = `hsl(${i * 23} 35% 55%)`; ctx.fillRect((i % 4) * 240 + 20, Math.floor(i / 4) * 160 + 20, 200, 120); }
        return canvas.toDataURL().split(',')[1];
      });
      const assets = [
        ['image', 'Reference.png', 'image/png', Buffer.from(image, 'base64')],
        ['file', 'Notes.note', 'text/x-acanvas-note', Buffer.from('Working notes\nExplore shape, rhythm, colour and composition.\nKeep the next iteration focused.')],
        ['file', 'Brief.md', 'text/markdown', Buffer.from('# Design brief\n\nA collection of ideas and references.\n\n- Shape and space\n- Rhythm and proportion\n- Colour and contrast\n\n## Next edition\nReview the collection together.')],
      ];
      for (const [index, [kind, name, mime, data]] of assets.entries()) {
        const path = `assets/fixture-${index}`; await writeFile(join(server.service.dataDir, path), data);
        server.service.registerAsset({ id: `fixture-${index}`, kind, name, mime, size: data.length, createdAt: '2026-10-17T00:00:00.000Z' }, path);
      }
      const session = server.service.createSession('Zoom study');
      server.service.boardOperations(session.id, Array.from({ length: count }, (_, index) => ({ type: 'create', object: { id: `item-${String(index).padStart(4, '0')}`, assetId: `fixture-${content === 'images' ? 0 : index % 3}`, x: (index % 25) * 340, y: Math.floor(index / 25) * 260, width: 300, height: 210 } })));
      const startView = { x: 80, y: 70, zoom: .16, selectedObjectIds: [] };
      const cdp = await context.newCDPSession(page); await cdp.send('Performance.enable');
      for (let round = 0; round < rounds; round++) {
        server.service.saveView(session.id, startView);
        await page.goto(`${server.url}/?session=${session.id}`);
        await page.waitForFunction(n => document.querySelectorAll('.board-object').length === n && !document.querySelector('.content-loading'), count);
        await page.waitForTimeout(1200);
        await page.evaluate(() => {
          window.zoomStudy = { frames: [], latencies: [], inputs: 0, updates: 0, longTasks: [], pending: 0 };
          const study = window.zoomStudy;
          document.querySelector('#whiteboard').addEventListener('wheel', () => { study.inputs++; study.pending = performance.now(); }, { capture: true });
          study.observer = new MutationObserver(() => { study.updates++; if (study.pending) study.latencies.push(performance.now() - study.pending); study.pending = 0; });
          study.observer.observe(document.querySelector('.canvas-world'), { attributes: true, attributeFilter: ['style'] });
          study.longObserver = new PerformanceObserver(list => study.longTasks.push(...list.getEntries().map(entry => entry.duration)));
          study.longObserver.observe({ type: 'longtask' });
          study.running = true; let last;
          function frame(now) { if (!study.running) return; if (last) study.frames.push(now - last); last = now; requestAnimationFrame(frame); } requestAnimationFrame(frame);
        });
        const before = (await cdp.send('Performance.getMetrics')).metrics;
        if (process.env.PROFILE) { await cdp.send('Profiler.enable'); await cdp.send('Profiler.start'); }
        for (let i = 0; i < 180; i++) {
          await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 720, y: 430, deltaX: 0, deltaY: i < 90 ? -2.5 : 2.5, modifiers: 2 });
          await new Promise(resolve => setTimeout(resolve, 8));
        }
        if (process.env.PROFILE) { const { profile } = await cdp.send('Profiler.stop'); await writeFile(`${output}.${count}.${round}.cpuprofile`, JSON.stringify(profile)); }
        const after = (await cdp.send('Performance.getMetrics')).metrics;
        const measured = await page.evaluate(() => { const s = window.zoomStudy; s.running = false; s.observer.disconnect(); s.longObserver.disconnect(); return { frames: s.frames, latencies: s.latencies, inputs: s.inputs, updates: s.updates, longTasks: s.longTasks, transform: document.querySelector('.canvas-world').style.transform }; });
        const metrics = Object.fromEntries(after.filter(value => ['ScriptDuration', 'TaskDuration', 'LayoutDuration', 'RecalcStyleDuration'].includes(value.name)).map(value => [value.name, (value.value - before.find(entry => entry.name === value.name).value) * 1000]));
        const result = { count, content, round, ...metrics, frames: measured.frames.length, frameP95: percentile(measured.frames, .95), inputP95: percentile(measured.latencies, .95), inputs: measured.inputs, updates: measured.updates, longTasks: measured.longTasks, transform: measured.transform };
        results.push(result); console.log(JSON.stringify(result));
        await page.waitForTimeout(350);
        const saved = server.service.state(session.id).session.view;
        for (const key of ['x', 'y', 'zoom']) assert(Math.abs(saved[key] - startView[key]) < .0001, `Persisted ${key}: ${saved[key]}`);
        assert.equal(measured.inputs, 180); assert.equal(server.service.objects().length, count);
        await writeFile(output, JSON.stringify(results, null, 2));
      }
    } finally { await context.close(); await server.close(); await rm(root, { recursive: true, force: true }); }
  }
} finally { await browser.close(); await writeFile(output, JSON.stringify(results, null, 2)); }
