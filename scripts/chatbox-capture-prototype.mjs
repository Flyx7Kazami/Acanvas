import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { chromium } from 'playwright';
import { startServer } from '../dist/src/server/http.js';
import { runBackgroundCapture } from './chatbox-background-host.mjs';

// Isolated feasibility experiment. CDP and auto-selected getDisplayMedia are
// automation transports, not the acanvas product's host screenshot channel.
const directory = resolve(process.env.ACANVAS_CAPTURE_EVIDENCE || 'docs/evidence/chatbox-capture');
const mode = process.argv[2] || 'background';
const runStarted = performance.now();
const root = await mkdtemp(join(tmpdir(), 'acanvas-capture-lab-'));
const webRoot = join(root, 'web');
await cp(resolve('dist/web'), webRoot, { recursive: true });
await cp(resolve('scripts/chatbox-capture-probe.js'), join(webRoot, 'capture-probe.js'));
const index = await readFile(join(webRoot, 'index.html'), 'utf8');
await writeFile(join(webRoot, 'index.html'), index.replace('</body>', '<script src="/capture-probe.js"></script></body>'));
const server = await startServer({ root, port: 0, webRoot });
const { token } = await (await fetch(`${server.url}/api/bootstrap`)).json();
const call = async (path, method = 'GET', body) => {
  const response = await fetch(`${server.url}${path}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  assert(response.ok, `${method} ${path}: ${response.status}`); return response.json();
};
const session = await call('/api/sessions', 'POST', { name: 'Capture media laboratory' });
const fixtures = [
  ['Reference.svg', 'image/svg+xml', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="340" height="200"><rect width="340" height="200" fill="#cbd5df"/><circle cx="150" cy="100" r="65" fill="#456477"/><path d="M20 170L310 35" stroke="#f2a45d" stroke-width="14"/></svg>'), { x: 120, y: 100, width: 340, height: 200 }],
  ['Playing.mp4', 'video/mp4', await readFile(resolve('tests/fixtures/frontend-video.mp4')), { x: 500, y: 100, width: 400, height: 225 }],
  ['Motion.gif', 'image/gif', await readFile(resolve('tests/fixtures/animated-reference.gif')), { x: 950, y: 100, width: 250, height: 210 }],
  ['Waveform.m4a', 'audio/mp4', await readFile(resolve('tests/fixtures/amplitude-cover.m4a')), { x: 120, y: 410, width: 390, height: 100 }],
  ['Field-notes.md', 'text/markdown', Buffer.from('# Field notes\n\n' + Array.from({ length: 30 }, (_, index) => `## Observation ${index + 1}\n\nThe visible horizon shifts as the text scrolls.\n\n`).join('')), { x: 560, y: 410, width: 350, height: 340 }],
  ['Dynamic.html', 'text/html', Buffer.from('<style>body{margin:0;padding:20px;background:#cfdace;font:18px sans-serif}canvas{display:block}button{margin-top:12px}</style><h2>Dynamic scene</h2><canvas width="300" height="130"></canvas><button onclick="this.textContent=\'Selected\'">Choose</button><script>let tick=0;const canvas=document.querySelector("canvas"),ctx=canvas.getContext("2d");function paint(){tick++;ctx.fillStyle="#6b806b";ctx.fillRect(0,0,300,130);ctx.fillStyle="#eeaf5a";ctx.fillRect((tick*3)%260,24,40,70);ctx.fillStyle="#fff";ctx.font="20px monospace";ctx.fillText("Frame "+tick,15,120);requestAnimationFrame(paint)}paint();</script>'), { x: 950, y: 410, width: 360, height: 310 }],
  ['Archive.zip', 'application/zip', Buffer.from('Capture laboratory fixture, downloadable as a file.'), { x: 120, y: 600, width: 310, height: 140 }],
];
for (const [name, mime, bytes, bounds] of fixtures) {
  const response = await fetch(`${server.url}/api/assets?name=${encodeURIComponent(name)}&mime=${encodeURIComponent(mime)}`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: bytes });
  assert(response.ok, `Upload ${name}: ${response.status}`); const asset = await response.json();
  await call('/api/board/operations', 'POST', { sessionId: session.id, operations: [{ type: 'create', object: { assetId: asset.id, ...bounds } }] });
}
const url = `${server.url}/?session=${session.id}`;
const cleanup = async () => { await server.close(); await rm(root, { recursive: true, force: true }); };
if (mode === 'serve') {
  console.log(JSON.stringify({ url, isolated: true, title: 'Capture laboratory', note: 'Only this disposable project is modified. Stop with Ctrl+C.' }));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await cleanup(); process.exit(0); });
} else {
  await mkdir(directory, { recursive: true });
  const report = { generatedAt: new Date().toISOString(), environment: { node: process.version, os: process.platform, isolatedProject: true }, automationTransport: 'Playwright/CDP on the same live page; product host capture is not integrated', checks: [], metrics: [] };
  let browser, page;
  try {
    browser = await chromium.launch({ channel: 'chrome', headless: mode === 'background' || process.env.ACANVAS_CAPTURE_HEADLESS === '1', args: mode === 'background' ? [] : ['--auto-select-tab-capture-source-by-title=acanvas capture laboratory', '--allow-http-screen-capture'] });
    report.environment.headless = mode === 'background' || process.env.ACANVAS_CAPTURE_HEADLESS === '1';
    report.environment.chrome = browser.version();
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2 });
    page = await context.newPage();
    await page.goto(url);
    await page.waitForSelector('.board-object[data-content-kind="markdown"] h2');
    await page.evaluate(() => { document.title = 'acanvas capture laboratory'; document.querySelector('.markdown-content').scrollTop = 260; });
    await page.locator('.html-content').focus();
    await page.waitForSelector('.html-live-frame');
    const iframe = page.frames().find(frame => frame.url().includes('/preview/'));
    assert(iframe, 'Live isolated HTML frame');
    await iframe.waitForSelector('canvas');
    await iframe.locator('button').click();
    await page.evaluate(async () => { const audio = document.querySelector('.board-object audio'); audio.currentTime = .6; const video = document.querySelector('.board-object video'); video.muted = true; video.loop = true; await video.play(); });
    await page.waitForFunction(() => document.querySelector('.board-object video').currentTime > .1);
    await page.waitForSelector('.audio-player-waveform canvas[data-ready="true"]');
    report.checks.push({ name: 'same-page-live-media', passed: true, state: await scene(page) });
    report.checks.push({ name: 'parent-cross-origin-read', ...await page.evaluate(() => { try { return { passed: false, readable: !!document.querySelector('iframe').contentWindow.document }; } catch (error) { return { passed: error.name === 'SecurityError', error: error.name }; } }) });
    // Experimental mark and editor, separate from the real annotation system.
    // Their pixels test visibility/mapping without changing product behavior.
    await page.evaluate(() => {
      const mark = document.createElement('div'); mark.id = 'laboratory-mark'; mark.style.cssText = 'position:absolute;left:365px;top:245px;width:385px;height:260px;border:4px solid #ff6b00;z-index:900;pointer-events:none'; document.querySelector('.canvas-world').append(mark);
      const editor = document.createElement('div'); editor.dataset.labEditor = 'true'; editor.style.cssText = 'position:fixed;left:430px;top:280px;width:300px;height:100px;background:#00ff00;z-index:999'; editor.textContent = 'Editing controls'; document.body.append(editor);
      const selection = document.createElement('div'); selection.id = 'laboratory-audio-range'; selection.style.cssText = 'position:absolute;left:25%;top:0;width:45%;height:100%;border:2px solid #ff6b00;pointer-events:none'; const waveform = document.querySelector('.audio-player-waveform'); waveform.style.position = 'relative'; waveform.append(selection);
    });
    const cdp = await context.newCDPSession(page);
    for (const [label, zoom, clicks] of [['dpr2-zoom1', 1, 0], ['dpr2-zoom0833', 1 / 1.2, -1], ['dpr2-zoom144', 1.44, 2]]) {
      await page.getByRole('button', { name: 'Reset zoom to 100%', exact: true }).click();
      for (let index = 0; index < Math.abs(clicks); index++) await page.getByRole('button', { name: clicks < 0 ? 'Zoom out' : 'Zoom in', exact: true }).click();
      await page.waitForFunction(value => Math.abs(Number(document.querySelector('.canvas-world').style.transform.match(/scale\(([^)]+)\)/)[1]) - value) < .001, zoom);
      const result = await compositorCapture(page, cdp, label, directory);
      report.metrics.push(result); report.checks.push({ name: `${label}-mapping`, passed: result.mapping.verified });
    }
    await page.getByRole('button', { name: 'Reset zoom to 100%', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.canvas-world').style.transform.includes('scale(1)'));
    report.metrics.push(await compositorCapture(page, cdp, 'dpr2-playwright', directory, 'Playwright-compositor'));
    const staticHtml = await captureHtmlReconstruction(page);
    await writeFile(join(directory, 'html-dom-reconstruction.png'), Buffer.from(staticHtml.base64, 'base64'));
    report.htmlStatic = { width: staticHtml.width, height: staticHtml.height, route: 'Existing DOM reconstruction snapshot; independent image of HTML preview, not live whole canvas' };
    const htmlBefore = await page.locator('.html-live-frame').screenshot();
    await page.waitForTimeout(90);
    const htmlAfter = await page.locator('.html-live-frame').screenshot();
    assert(!htmlBefore.equals(htmlAfter), 'Dynamic HTML pixels change');
    await writeFile(join(directory, 'dynamic-html-a.png'), htmlBefore); await writeFile(join(directory, 'dynamic-html-b.png'), htmlAfter);
    const gifBefore = await page.locator('.board-object[data-content-kind="gif"] img').screenshot();
    const gifPixelsBefore = await capturedPixels(page, gifBefore), gifBegan = performance.now();
    let gifAfter = gifBefore, gifDifferent = false, gifSamples = 0;
    for (const interval of [23, 41, 67, 97, 139, 191, 251]) {
      const remaining = 1800 - (performance.now() - gifBegan);
      if (remaining <= interval) break;
      await page.waitForTimeout(interval);
      try { gifAfter = await page.locator('.board-object[data-content-kind="gif"] img').screenshot({ timeout: Math.max(1, 1800 - (performance.now() - gifBegan)) }); } catch (error) { if (error.name === 'TimeoutError') break; throw error; }
      gifSamples++;
      gifDifferent = gifPixelsBefore !== await capturedPixels(page, gifAfter);
      if (gifDifferent) break;
    }
    await writeFile(join(directory, 'animated-gif-a.png'), gifBefore); await writeFile(join(directory, 'animated-gif-b.png'), gifAfter);
    report.checks.push({ name: 'dynamic-html-and-gif-pixels', passed: !htmlBefore.equals(htmlAfter) && gifDifferent, gifDifferent, htmlDifferent: true, gifSamples, gifElapsedMs: performance.now() - gifBegan, gifMaxSamples: 7, gifTimeoutMs: 1800 });
    if (mode === 'background') {
      await page.locator('.board-object[data-content-kind="audio"] .object-caption').click();
      await page.getByRole('button', { name: 'Annotate', exact: true }).click();
      await page.waitForSelector('.annotation-time-range[data-ready="true"]');
      await page.getByRole('slider', { name: 'Start point', exact: true }).press('ArrowRight');
      await page.getByRole('slider', { name: 'End point', exact: true }).press('ArrowLeft');
      await page.evaluate(() => { document.querySelectorAll('[data-lab-editor],#capture-laboratory').forEach(element => element.style.visibility = 'hidden'); });
      await page.evaluate(() => new Promise(accept => requestAnimationFrame(() => requestAnimationFrame(accept))));
      const rangeAt = performance.now(), actualRange = await page.locator('.annotation-time-range').screenshot();
      await writeFile(join(directory, 'actual-audio-range-control.png'), actualRange);
      report.actualAudioRange = { captureAndEncodeMs: performance.now() - rangeAt, bytes: actualRange.length, ...await page.locator('.annotation-time-range').evaluate(element => ({ rect: element.getBoundingClientRect().toJSON(), start: element.querySelector('[aria-label="Start point"]').getAttribute('aria-valuenow'), end: element.querySelector('[aria-label="End point"]').getAttribute('aria-valuenow') })) };
      await page.evaluate(() => { document.querySelectorAll('[data-lab-editor],#capture-laboratory').forEach(element => element.style.visibility = 'visible'); });
      await page.getByLabel('Add a comment', { exact: true }).press('Escape');
      await page.locator('.html-content').focus();
      await page.evaluate(() => document.querySelector('.board-object video').play());
      report.background = await runBackgroundCapture({ page, context, url, sessionId: session.id, call, token, directory });
      report.checks.push(...report.background.tests);
      report.mediaMatrix = ['image', 'playing-video', 'audio-waveform-with-experimental-range', 'scrolled-markdown', 'cross-origin-dynamic-html', 'animated-gif', 'generic-file', 'mark-layer'].map(media => ({ media, compositorOriginalPage: true, backgroundHostPrototype: true, productIntegrated: false }));
    } else {
    await page.evaluate(() => document.querySelectorAll('[data-lab-editor],#capture-laboratory').forEach(element => element.style.visibility = 'visible'));
    // A separate native viewport context avoids device metrics emulation. The
    // shared source is this newly operated live page, not a renderer replay.
    await page.evaluate(() => document.title = 'acanvas compositor laboratory');
    const nativeContext = await browser.newContext({ viewport: null });
    page = await nativeContext.newPage();
    await page.goto(url);
    await page.waitForSelector('.board-object[data-content-kind="markdown"] h2');
    await page.evaluate(() => document.title = 'acanvas capture laboratory');
    await page.locator('#lab-media').click();
    await page.waitForSelector('.html-live-frame');
    await page.getByRole('button', { name: 'Fit all files', exact: true }).click();
    await page.waitForTimeout(400);
    report.nativeSharingScene = await scene(page);
    await page.evaluate(() => {
      const mark = document.createElement('div'); mark.id = 'laboratory-mark'; mark.style.cssText = 'position:absolute;left:365px;top:245px;width:385px;height:260px;border:4px solid #ff6b00;z-index:900;pointer-events:none'; document.querySelector('.canvas-world').append(mark);
      const editor = document.createElement('div'); editor.dataset.labEditor = 'true'; editor.style.cssText = 'position:fixed;left:430px;top:280px;width:300px;height:100px;background:#00ff00;z-index:999'; editor.textContent = 'Editing controls'; document.body.append(editor);
    });
    // Automation auto-selects a tab by title. No native source-picker result
    // or real user consent is implied by this branch.
    await page.locator('#lab-share').click();
    await page.waitForFunction(() => window.captureLaboratory.logs.some(value => value.event === 'sharing' || value.event === 'share-error'), { timeout: 5000 });
    report.screenCapture = await page.evaluate(() => window.captureLaboratory.logs);
    if (report.screenCapture.some(value => value.event === 'sharing')) {
      for (let index = 0; index < 3; index++) {
        const captured = await page.evaluate(async () => {
          const result = await window.captureLaboratory.capture({ x: 70, y: 70, width: innerWidth - 100, height: innerHeight - 120 });
          return { ...result, blob: undefined, base64: await new Promise(accept => { const reader = new FileReader(); reader.onload = () => accept(reader.result.split(',')[1]); reader.readAsDataURL(result.blob); }) };
        });
        const bytes = Buffer.from(captured.base64, 'base64'); delete captured.base64;
        await writeFile(join(directory, `tab-stream-${index}.png`), bytes);
        report.metrics.push({ route: 'getDisplayMedia-auto-selected-own-tab', index, ...captured });
      }
      report.checks.push({ name: 'layout-change-recovers-with-one-retry', ...await page.evaluate(async () => {
        let count = 0; const began = performance.now();
        const result = await window.captureLaboratory.capture(undefined, { afterDraw: () => { if (++count === 1) document.querySelector('.markdown-content').scrollTop += 1; } });
        return { passed: result.attempts === 2, attempts: result.attempts, elapsedMs: performance.now() - began };
      }) });
      report.checks.push({ name: 'persistent-layout-change-bounded', ...await page.evaluate(async () => {
        let count = 0; const began = performance.now();
        try { await window.captureLaboratory.capture(undefined, { afterDraw: () => { count++; document.querySelector('.markdown-content').scrollTop += 1; }, maxAttempts: 2, totalTimeoutMs: 1200 }); return { passed: false }; }
        catch (error) { return { passed: error.message === 'layout_changed' && count === 2 && performance.now() - began < 1200, error: error.message, attempts: count, elapsedMs: performance.now() - began }; }
      }) });
      report.checks.push({ name: 'monitor-rejection-unit-simulation', ...await page.evaluate(() => { try { window.captureLaboratory.checkSource({ getSettings: () => ({ displaySurface: 'monitor' }) }); return { passed: false }; } catch (error) { return { passed: error.message === 'source_not_browser', error: error.message, simulated: true }; } }) });
      // Real track, intentionally changed identity; browser surface alone is
      // insufficient to establish that the selected source is this document.
      report.checks.push({ name: 'capture-handle-mismatch', ...await page.evaluate(async () => {
        navigator.mediaDevices.setCaptureHandleConfig({ handle: crypto.randomUUID(), exposeOrigin: true, permittedOrigins: [location.origin] });
        await new Promise(accept => setTimeout(accept, 80));
        try { window.captureLaboratory.checkSource(window.captureLaboratory.stream.getVideoTracks()[0]); return { passed: false }; } catch (error) { return { passed: window.captureLaboratory.logs.some(value => value.event === 'identity-changed' && value.error === 'source_identity_unverified') && window.captureLaboratory.stream.getVideoTracks()[0].readyState === 'ended', error: error.message, observedIdentityChangeStopped: true }; }
      }) });
      await page.locator('#lab-stop').click();
      report.checks.push({ name: 'app-track-stop', ...await page.evaluate(() => ({ passed: window.captureLaboratory.stream.getVideoTracks()[0].readyState === 'ended', readyState: window.captureLaboratory.stream.getVideoTracks()[0].readyState })) });
    }
    // Timeouts and cancellation use real requestVideoFrameCallback behavior.
    // A paused video has no newly presented frames, so no synthetic media mock
    // is needed to exercise the bound.
    await page.evaluate(() => document.querySelector('.board-object video').pause());
    await page.waitForTimeout(100);
    report.checks.push({ name: 'paused-frame-timeout', ...await page.evaluate(async () => { const began = performance.now(); try { await window.captureLaboratory.freshFrame(document.querySelector('.board-object video'), undefined, 120); return { passed: false }; } catch (error) { return { passed: error.message === 'frame_timeout', error: error.message, elapsedMs: performance.now() - began }; } }) });
    report.checks.push({ name: 'frame-abort', ...await page.evaluate(async () => { const controller = new AbortController(), began = performance.now(); const promise = window.captureLaboratory.freshFrame(document.querySelector('.board-object video'), controller.signal); controller.abort(); try { await promise; return { passed: false }; } catch (error) { return { passed: error.name === 'AbortError', error: error.name, elapsedMs: performance.now() - began }; } }) });
    // Capture the delivered product's actual audio range control independently
    // of the experimental mark laid over the overview waveform.
    await page.locator('.board-object[data-content-kind="audio"] .object-caption').click();
    await page.getByRole('button', { name: 'Annotate', exact: true }).click();
    await page.waitForSelector('.annotation-time-range[data-ready="true"]');
    await page.getByRole('slider', { name: 'Start point', exact: true }).press('ArrowRight');
    await page.getByRole('slider', { name: 'End point', exact: true }).press('ArrowLeft');
    await page.screenshot({ path: join(directory, 'actual-audio-range.png') });
    report.actualAudioRange = await page.locator('.annotation-time-range').evaluate(element => ({ rect: element.getBoundingClientRect().toJSON(), start: element.querySelector('[aria-label="Start point"]').getAttribute('aria-valuenow'), end: element.querySelector('[aria-label="End point"]').getAttribute('aria-valuenow') }));
    await page.getByLabel('Add a comment', { exact: true }).press('Escape');
    const payload = await readFile(join(directory, 'dpr2-zoom1-crop.png'));
    const upload = async name => { const began = performance.now(); const response = await fetch(`${server.url}/api/assets?name=${encodeURIComponent(name)}&mime=image/png`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: payload }); assert(response.ok); const asset = await response.json(); return { id: asset.id, elapsedMs: performance.now() - began, bytes: asset.size }; };
    const first = await upload('capture-upload.png'), retry = await upload('capture-upload-retry.png');
    report.upload = { route: 'current-ordinary-asset-api', first, retry, duplicateOnRetry: first.id !== retry.id, note: 'Two complete uploads model a retry after a committed response is lost. This endpoint has no capture identity deduplication.' };
    await page.reload();
    await page.waitForFunction(() => !!window.captureLaboratory);
    report.checks.push({ name: 'reload-loses-stream', ...await page.evaluate(() => ({ passed: window.captureLaboratory.stream === undefined, captureHandleReissued: true, streamPresent: !!window.captureLaboratory.stream })) });
    report.mediaMatrix = ['image', 'playing-video', 'audio-waveform-with-experimental-range', 'scrolled-markdown', 'cross-origin-dynamic-html', 'animated-gif', 'generic-file', 'mark-layer'].map(media => ({ media, compositorOriginalPage: true, tabStream: report.screenCapture.some(value => value.event === 'sharing'), productIntegrated: false }));
    }
    report.elapsedMs = performance.now() - runStarted;
    await writeFile(join(directory, mode === 'background' ? 'background-report.json' : 'automated-report.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ evidence: directory, checks: report.checks.map(check => ({ name: check.name, passed: check.passed })), screenCapture: report.screenCapture?.map(value => ({ event: value.event, name: value.name, message: value.message })), metrics: report.metrics.map(value => ({ route: value.route, label: value.label, bytes: value.bytes, captureAndEncodeMs: value.captureAndEncodeMs, encodeMs: value.encodeMs })), upload: report.upload, background: report.background }));
    assert(report.checks.every(check => check.passed), 'All executed laboratory checks');
  } catch (error) {
    report.error = { name: error.name, message: error.message };
    if (page && !page.isClosed()) { report.failureScene = await scene(page).catch(() => undefined); await page.screenshot({ path: join(directory, 'failure-page.png') }).catch(() => {}); }
    await writeFile(join(directory, mode === 'background' ? 'background-report.json' : 'automated-report.json'), JSON.stringify(report, null, 2) + '\n');
    throw error;
  } finally { await browser?.close(); await cleanup(); }
}

async function scene(page) {
  return page.evaluate(() => ({ viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio }, transform: document.querySelector('.canvas-world').style.transform, video: [...document.querySelectorAll('.board-object video')].map(media => ({ currentTime: media.currentTime, paused: media.paused, readyState: media.readyState })), audio: [...document.querySelectorAll('.board-object audio')].map(media => ({ currentTime: media.currentTime, paused: media.paused, duration: media.duration })), markdownScroll: document.querySelector('.markdown-content').scrollTop, html: { frameUrlOrigin: new URL(document.querySelector('iframe').src).origin, parentOrigin: location.origin, sandbox: document.querySelector('iframe').getAttribute('sandbox') }, objects: [...document.querySelectorAll('.board-object')].map(element => ({ id: element.dataset.objectId, kind: element.dataset.contentKind, version: element.dataset.objectVersion, rect: element.getBoundingClientRect().toJSON() })) }));
}

async function capturedPixels(page, bytes) {
  return page.evaluate(async base64 => {
    const image = new Image(); image.src = `data:image/png;base64,${base64}`; await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight; const context = canvas.getContext('2d'); context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let binary = ''; for (let offset = 0; offset < pixels.length; offset += 8192) binary += String.fromCharCode(...pixels.subarray(offset, offset + 8192));
    return btoa(binary);
  }, bytes.toString('base64'));
}

async function captureHtmlReconstruction(page) {
  return page.evaluate(async () => {
    const frame = document.querySelector('.html-live-frame'), instanceId = new URL(frame.src).pathname.split('/')[2], requestId = `laboratory_${Date.now()}`;
    const snapshot = await new Promise((accept, reject) => {
      const timer = setTimeout(() => { window.removeEventListener('message', receive); reject(new Error('html_reconstruction_timeout')); }, 2000);
      function receive(event) {
        if (event.source !== frame.contentWindow || event.origin !== 'null' || event.data?.instanceId !== instanceId || event.data?.requestId !== requestId) return;
        clearTimeout(timer); window.removeEventListener('message', receive);
        if (event.data.type === 'acanvas:preview-snapshot-error') reject(new Error(event.data.error)); else accept(event.data);
      }
      window.addEventListener('message', receive);
      frame.contentWindow.postMessage({ type: 'acanvas:preview-snapshot', instanceId, requestId }, '*');
    });
    const image = new Image(); image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(snapshot.svg)}`;
    try {
      await image.decode(); const canvas = document.createElement('canvas'); canvas.width = snapshot.width; canvas.height = snapshot.height; canvas.getContext('2d').drawImage(image, 0, 0);
      return { width: canvas.width, height: canvas.height, base64: canvas.toDataURL('image/png').split(',')[1] };
    } finally { image.src = ''; }
  });
}

async function compositorCapture(page, cdp, label, directory, route = 'CDP-compositor') {
  await page.evaluate(() => { document.querySelectorAll('[data-lab-editor],#capture-laboratory').forEach(element => element.style.visibility = 'hidden'); });
  await page.evaluate(() => new Promise(accept => requestAnimationFrame(() => requestAnimationFrame(accept))));
  const before = await scene(page), began = performance.now();
  const { data } = route === 'CDP-compositor' ? await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false }) : { data: (await page.screenshot()).toString('base64') };
  const captureAndEncodeMs = performance.now() - began, bytes = Buffer.from(data, 'base64');
  const after = await scene(page);
  await writeFile(join(directory, `${label}-viewport.png`), bytes);
  const cropped = await page.evaluate(async source => {
    const began = performance.now(), image = new Image(); image.src = `data:image/png;base64,${source}`; await image.decode();
    const imageDecodeMs = performance.now() - began, mark = document.querySelector('#laboratory-mark').getBoundingClientRect(), rect = { x: Math.max(0, mark.x - 160), y: Math.max(0, mark.y - 150), width: Math.min(innerWidth - Math.max(0, mark.x - 160), mark.width + 650), height: Math.min(innerHeight - Math.max(0, mark.y - 150), mark.height + 380) };
    const mapping = window.captureLaboratory.cropMapping(rect, image.naturalWidth, image.naturalHeight), pixel = mapping.pixelRect;
    const canvas = document.createElement('canvas'); canvas.width = pixel.width; canvas.height = pixel.height;
    const drawAt = performance.now(); canvas.getContext('2d').drawImage(image, pixel.x, pixel.y, pixel.width, pixel.height, 0, 0, pixel.width, pixel.height); const cropDrawMs = performance.now() - drawAt;
    const encodeAt = performance.now(), blob = await new Promise(accept => canvas.toBlob(accept, 'image/png')); const cropEncodeMs = performance.now() - encodeAt;
    const markPixel = { x: (mark.left - rect.x) * mapping.scale.x, y: (mark.top - rect.y) * mapping.scale.y };
    const color = [...canvas.getContext('2d').getImageData(Math.round(markPixel.x + mapping.scale.x), Math.round(markPixel.y + mapping.scale.y), 1, 1).data];
    mapping.mark = { css: mark.toJSON(), pixel: markPixel, sampledColor: color }; mapping.verified = color[0] === 255 && color[1] === 107 && color[2] === 0;
    return { mapping, imageDecodeMs, cropDrawMs, cropEncodeMs, bytes: blob.size, base64: await new Promise(accept => { const reader = new FileReader(); reader.onload = () => accept(reader.result.split(',')[1]); reader.readAsDataURL(blob); }) };
  }, data);
  await writeFile(join(directory, `${label}-crop.png`), Buffer.from(cropped.base64, 'base64')); delete cropped.base64;
  await page.evaluate(() => { document.querySelectorAll('[data-lab-editor],#capture-laboratory').forEach(element => element.style.visibility = 'visible'); });
  return { route, label, captureAndEncodeMs, viewportBytes: bytes.length, ...cropped, before, after, note: 'The compositor capture and its PNG encoding are one measured operation. Crop decoding/draw/re-encoding are measured separately. Continuous media pixels represent the captured frame; before/after times are an interval, not an exact synchronized media time.' };
}
