import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm, writeFile, mkdir, readdir, stat, lstat, readlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import type { Page } from 'playwright-core';
import { startServer, type RunningServer } from '../src/server/http.js';
import { cli } from '../src/cli.js';
import { readRuntime } from '../src/server/runtime.js';
import type { BrowserCaptureFrame, BrowserCaptureResult, BrowserPage, BrowserStatus } from '../src/shared/browser-capture.js';
import type { AnnotationInput, AnnotationTarget, Asset, BoardObject, Draft } from '../src/shared/types.js';

const execute = promisify(execFile);
const note = (id = 'note'): AnnotationInput => ({ id, scope: 'region', objectIds: [], coordinateSpace: 'world', bounds: { x: 80, y: 60, width: 430, height: 290 }, geometry: 'rect', text: 'Keep this visible moment.', captureState: { version: 1, status: 'incomplete' } });
const targetOf = ({ id: _id, text: _text, captureState: _state, capture: _capture, ...target }: AnnotationInput): AnnotationTarget => target;

async function fixture(t: test.TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'acanvas-browser-capture-'))), webRoot = join(root, 'web');
  await mkdir(webRoot);
  await writeFile(join(webRoot, 'index.html'), '<!doctype html><meta charset="utf-8"><title>Scene</title><style>body{margin:0;background:#f2efe8}#marker{position:absolute;left:80px;top:60px;width:430px;height:290px;border:4px solid #ff6b00;pointer-events:none}#editor{position:absolute;left:140px;top:90px;width:140px;height:70px;background:#00ff00}#markdown{position:absolute;left:520px;top:40px;width:280px;height:270px;overflow:auto}iframe{position:absolute;left:30px;top:40px;width:300px;height:220px;border:0}video{position:absolute;left:350px;top:60px;width:160px;height:100px}</style><div id="marker"></div><div id="editor">Comment</div><div id="markdown"></div>');
  let running = await startServer({ root, port: 0, webRoot, browser: { headless: true } });
  let bootstrap = await (await fetch(`${running.url}/api/bootstrap`)).json();
  const call = async (path: string, method = 'GET', body?: unknown, status = 200) => {
    const response = await fetch(`${running.url}${path}`, { method, headers: { Authorization: `Bearer ${bootstrap.token}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const result = await response.json(); assert.equal(response.status, status, JSON.stringify(result)); return result;
  };
  const importAsset = async (name: string, mime: string, bytes: Buffer) => {
    const response = await fetch(`${running.url}/api/assets?name=${encodeURIComponent(name)}&mime=${encodeURIComponent(mime)}`, { method: 'POST', headers: { Authorization: `Bearer ${bootstrap.token}` }, body: new Uint8Array(bytes) }); assert.equal(response.status, 201); return response.json() as Promise<Asset>;
  };
  const session = () => call('/api/sessions', 'POST', { name: 'Canvas scene' }, 201);
  const args = (sessionId: string) => ['--project', root, '--session', sessionId];
  const draft = async (sessionId: string, annotation = note()) => {
    const original = running.service.draft(sessionId);
    return running.service.saveDraft(sessionId, { ...original, annotations: [annotation], text: 'Use the marked scene.' });
  };
  const open = async (sessionId: string) => {
    const info = await cli(['browser', 'open', ...args(sessionId)]) as BrowserPage;
    const page = running.browser.page(sessionId)!; assert(page); await page.waitForFunction(() => !!window.acanvasCaptureProvider); return { page, info };
  };
  t.after(async () => { await running.close(); await rm(root, { force: true, recursive: true }); });
  return { root, webRoot, call, importAsset, session, args, draft, open, get running() { return running; }, async restart() { await running.close(); running = await startServer({ root, port: 0, webRoot, browser: { headless: true } }); bootstrap = await (await fetch(`${running.url}/api/bootstrap`)).json(); } };
}

async function install(page: Page, draft: Draft, objects: BoardObject[] = [], assets: Asset[] = []) {
  const frame: BrowserCaptureFrame = {
    identity: { documentId: '', generation: 1, sessionId: draft.sessionId, draftId: draft.id, annotationId: draft.annotations[0].id, version: draft.annotations[0].captureState!.version },
    target: targetOf(draft.annotations[0]), worldBounds: draft.annotations[0].bounds,
    viewport: { x: 0, y: 0, zoom: 1, width: 1440, height: 1000, devicePixelRatio: 1 },
    crop: { x: 20, y: 20, width: 800, height: 400 },
    scene: { objects: objects.map((object, layer) => ({ object, renderedBounds: { x: object.x, y: object.y, width: object.width, height: object.height }, layer })), assets, omittedCount: 0 },
  };
  await page.evaluate(value => {
    value.identity.documentId = window.acanvasCaptureProvider!.documentId;
    value.viewport.width = innerWidth; value.viewport.height = innerHeight; value.viewport.devicePixelRatio = devicePixelRatio;
    const state = { frame: value, active: true, reads: 0, mutateAt: 0, alwaysMutate: false, sampling: false, prepares: 0, restores: 0 };
    (window as any).testCapture = state;
    const markdown = document.querySelector('#markdown')!; markdown.innerHTML = Array.from({ length: 30 }, (_, index) => `<p>Observed paragraph ${index}</p>`).join(''); markdown.scrollTop = 180;
    (document.querySelector('#editor') as HTMLElement).style.visibility = 'hidden';
    const matches = (identity: typeof value.identity) => Object.keys(state.frame.identity).every(key => (state.frame.identity as any)[key] === (identity as any)[key]);
    window.acanvasCaptureController = {
      read() {
        state.reads++;
        if (!state.active) return;
        if (state.alwaysMutate || state.mutateAt === state.reads) state.frame.crop.x++;
        return structuredClone(state.frame);
      },
      async prepare(identity) {
        if (!matches(identity) || !state.active) return;
        state.sampling = true; state.prepares++;
        (document.querySelector('#editor') as HTMLElement).style.visibility = 'hidden';
        const controls = document.querySelector('#sampling-controls') as HTMLElement | null; if (controls) controls.style.visibility = 'hidden';
        await new Promise<void>(accept => requestAnimationFrame(() => requestAnimationFrame(() => accept())));
        return window.acanvasCaptureController!.read();
      },
      restore(identity) {
        if (!matches(identity)) return;
        state.sampling = false; state.restores++;
        const controls = document.querySelector('#sampling-controls') as HTMLElement | null; if (controls) controls.style.visibility = 'visible';
      },
    };
  }, frame);
  return page.evaluate(() => window.acanvasCaptureController!.read()!);
}

async function capture(page: Page): Promise<BrowserCaptureResult> {
  return page.evaluate(async () => window.acanvasCaptureProvider!.capture(window.acanvasCaptureController!.read()!));
}

test('project browser CLI reuses original pages, isolates sessions and closes owned runtime resources', async t => {
  const f = await fixture(t), a = await f.session(), b = await f.session();
  assert.equal((await cli(['browser', 'status', ...f.args(a.id)]) as BrowserStatus).running, false);
  const first = await f.open(a.id), again = await f.open(a.id); assert.equal(first.info.pageId, again.info.pageId); assert.equal(first.page, again.page);
  const second = await f.open(b.id); assert.notEqual(first.info.pageId, second.info.pageId); assert.notEqual(first.page, second.page);
  assert.equal((await cli(['browser', 'status', ...f.args(a.id)]) as BrowserStatus).pages.length, 1);
  await f.call('/api/browser/pages', 'POST', { sessionId: a.id, instanceId: 'another-service' }, 409);
  assert.equal((await f.call('/api/browser/pages')).pages.length, 2);
  const profile = await realpath(join(f.root, '.acanvas/runtime/browser-profile')); assert(profile.startsWith(f.root));
  if (process.platform === 'darwin') {
    const lock = await readlink(join(profile, 'SingletonLock')), chromePid = Number(lock.slice(lock.lastIndexOf('-') + 1));
    const browserArgs = (await execute('ps', ['-p', String(chromePid), '-o', 'command='])).stdout;
    assert(!browserArgs.includes('--no-sandbox'));
    const childIds = (await execute('pgrep', ['-P', String(chromePid)])).stdout.trim().split(/\s+/).filter(Boolean);
    const workers = await Promise.all(childIds.map(async pid => ({ pid, args: (await execute('ps', ['-p', pid, '-o', 'command='])).stdout })));
    const renderers = workers.filter(worker => worker.args.includes('--type=renderer'));
    assert(renderers.length > 0); assert(renderers.every(worker => !worker.args.includes('--no-sandbox')));
  }
  await cli(['browser', 'close', ...f.args(a.id)]); assert(first.page.isClosed()); assert(!second.page.isClosed());
  const openedAgain = await f.open(a.id); assert.notEqual(first.info.pageId, openedAgain.info.pageId);
  await f.running.close(); assert(openedAgain.page.isClosed()); assert(second.page.isClosed()); assert.equal(await readRuntime(f.root), undefined);
});

test('background capture records live dynamic iframe, playing video, scroll and marker on the original page', async t => {
  const f = await fixture(t), a = await f.session(), draft = await f.draft(a.id), { page, info } = await f.open(a.id);
  const html = await f.importAsset('scene.html', 'text/html', Buffer.from('<style>body{margin:0;background:#51647a}canvas{display:block}</style><canvas width="300" height="220"></canvas><script>let frame=0;const c=document.querySelector("canvas"),g=c.getContext("2d");function draw(){frame++;g.fillStyle=frame%2?"#51647a":"#293a52";g.fillRect(0,0,300,220);g.fillStyle="#efb44a";g.fillRect(frame%240,40,60,100);requestAnimationFrame(draw)}draw();</script>'));
  const video = await f.importAsset('playing.mp4', 'video/mp4', await readFile(resolve('tests/fixtures/frontend-video.mp4')));
  f.running.service.boardOperations(a.id, [{ type: 'create', object: { assetId: html.id, x: 30, y: 40, width: 300, height: 220 } }, { type: 'create', object: { assetId: video.id, x: 350, y: 60, width: 160, height: 100 } }]);
  const state = f.running.service.state(a.id), objects = state.objects;
  const preview = await f.call(`/api/assets/${html.id}/html-preview`, 'POST', {}, 201);
  await page.evaluate(async ({ preview, videoId }) => {
    await fetch('/api/bootstrap');
    const iframe = document.createElement('iframe'); iframe.src = preview.url; iframe.setAttribute('sandbox', 'allow-scripts'); document.body.prepend(iframe);
    const video = document.createElement('video'); video.src = `/api/assets/${videoId}/content`; video.muted = true; video.loop = true; document.body.append(video); await video.play();
  }, { preview, videoId: video.id });
  await page.frames().find(frame => frame.url().includes('/preview/'))?.waitForSelector('canvas');
  await page.waitForFunction(() => document.querySelector('video')!.currentTime > .1);
  await install(page, draft, objects, [html, video]);
  await page.evaluate(({ videoId, htmlId }) => { const s = (window as any).testCapture; s.frame.scene.objects.find((value: any) => value.object.assetId === videoId).media = { playbackTime: document.querySelector('video')!.currentTime }; s.frame.scene.objects.find((value: any) => value.object.assetId === htmlId).scroll = { x: 0, y: (document.querySelector('#markdown') as HTMLElement).scrollTop }; }, { videoId: video.id, htmlId: html.id });
  const result = await capture(page); assert.equal(result.status, 'complete', JSON.stringify(result));
  if (result.status !== 'complete') return;
  assert.equal(result.result.status, 'committed'); assert.equal(page, f.running.browser.page(a.id)); assert.equal(info.pageId, (await f.open(a.id)).info.pageId);
  const saved = result.result.capture; assert.equal(saved.scene.objects.length, 2); assert.equal(saved.scene.objects.find(value => value.object.assetId === html.id)!.scroll!.y, 180); assert(saved.scene.objects.find(value => value.object.assetId === video.id)!.media!.playbackTime! > .1);
  assert.equal(saved.image.width, 800); assert.equal(saved.image.height, 400); assert.equal(saved.mapping.scaleX, 1);
  const pixels = await page.evaluate(async assetId => {
    const image = new Image(); image.src = `/api/assets/${assetId}/content?sessionId=${window.acanvasCaptureProvider!.sessionId}`; await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height; const g = canvas.getContext('2d')!; g.drawImage(image, 0, 0);
    return { marker: [...g.getImageData(61, 41, 1, 1).data], editor: [...g.getImageData(140, 90, 1, 1).data], iframe: [...g.getImageData(20, 25, 1, 1).data] };
  }, saved.screenshotAssetId);
  assert.deepEqual(pixels.marker, [255, 107, 0, 255]); assert.notDeepEqual(pixels.editor, [0, 255, 0, 255]); assert(pixels.iframe[0] < 100);
  const body = await readFile(f.running.service.assetPath(saved.screenshotAssetId)); assert.equal(body.readUInt32BE(16), 800); assert.equal(body.readUInt32BE(20), 400);
  const sent = f.running.service.sendDraft(a.id, result.result.draft!.id, result.result.draft!.revision).task; assert.equal(sent.snapshot.annotations[0].capture!.id, saved.id);
});

test('provider rejects child frames, foreign sessions and replaced documents before persistent writes', async t => {
  const f = await fixture(t), a = await f.session(), b = await f.session(), draft = await f.draft(a.id), { page } = await f.open(a.id);
  const frame = await install(page, draft);
  const foreign = await page.evaluate(frame => window.acanvasCaptureProvider!.capture(frame), { ...frame, identity: { ...frame.identity, sessionId: b.id } }); assert.equal(foreign.status, 'incomplete');
  await page.evaluate(() => { const frame = document.createElement('iframe'); frame.src = 'about:blank'; document.body.append(frame); });
  const child = page.frames().find(frame => frame !== page.mainFrame())!;
  const fromChild = await child.evaluate(frame => (window as any).__acanvasBrowserCapture(frame), frame); assert.deepEqual(fromChild, { status: 'incomplete', code: 'capture_source' });
  const stale = await page.evaluate(frame => window.acanvasCaptureProvider!.capture(frame), { ...frame, identity: { ...frame.identity, documentId: 'old-document' } }); assert.equal(stale.status, 'incomplete');
  assert.equal(f.running.service.state(a.id).assets.filter(asset => asset.evidence).length, 0);
});

test('layout changes retry once, continuous changes retain input and invalidate the capture version', async t => {
  const f = await fixture(t), a = await f.session(), { page } = await f.open(a.id);
  let draft = await f.draft(a.id); await install(page, draft);
  await page.evaluate(() => { const s = (window as any).testCapture; s.reads = 0; s.mutateAt = 5; });
  const once = await capture(page); assert.equal(once.status, 'complete', JSON.stringify(once)); if (once.status === 'complete') assert.equal(once.attempts, 2);
  draft = await f.draft(a.id, note('another')); await install(page, draft);
  await page.evaluate(() => (window as any).testCapture.alwaysMutate = true);
  const changed = await capture(page); assert.equal(changed.status, 'incomplete', JSON.stringify(changed));
  const saved = f.running.service.draft(a.id); assert.equal(saved.annotations[0].text, 'Keep this visible moment.'); assert.equal(saved.annotations[0].captureState!.status, 'incomplete'); assert.equal(saved.annotations[0].captureState!.version, 2);
});

test('sampling hides overlapping corner controls and restores them before crop upload', async t => {
  const f = await fixture(t), a = await f.session();
  const annotation = { ...note(), bounds: { x: 1400, y: 960, width: 24, height: 24 } };
  const draft = await f.draft(a.id, annotation), { page } = await f.open(a.id);
  await install(page, draft);
  await page.evaluate(() => {
    const state = (window as any).testCapture;
    state.frame.crop = { x: 0, y: 0, width: innerWidth, height: innerHeight };
    Object.assign((document.querySelector('#marker') as HTMLElement).style, { left: '1400px', top: '960px', width: '24px', height: '24px' });
    const controls = document.createElement('button'); controls.id = 'sampling-controls'; controls.textContent = 'Cancel'; controls.style.cssText = 'position:fixed;right:0;bottom:0;width:100px;height:100px;background:#00ff00;z-index:9999'; document.body.append(controls);
  });
  let restoredBeforeUpload = false;
  const manager = f.running.browser as any, originalApi = manager.api.bind(manager);
  manager.api = async (...args: any[]) => {
    if (args[2] === 'POST') restoredBeforeUpload = await page.evaluate(() => !(window as any).testCapture.sampling && getComputedStyle(document.querySelector('#sampling-controls')!).visibility === 'visible');
    return originalApi(...args);
  };
  const result = await capture(page); assert.equal(result.status, 'complete', JSON.stringify(result)); assert(restoredBeforeUpload);
  if (result.status !== 'complete') return;
  const pixels = await page.evaluate(async assetId => {
    await fetch('/api/bootstrap'); const image = new Image(); image.src = `/api/assets/${assetId}/content?sessionId=${window.acanvasCaptureProvider!.sessionId}`; await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height; const g = canvas.getContext('2d')!; g.drawImage(image, 0, 0);
    const x = Math.round(1402 * image.width / innerWidth), y = Math.round(970 * image.height / innerHeight);
    return { marker: [...g.getImageData(x, y, 1, 1).data], sampling: (window as any).testCapture.sampling, prepares: (window as any).testCapture.prepares, restores: (window as any).testCapture.restores, controls: getComputedStyle(document.querySelector('#sampling-controls')!).visibility };
  }, result.result.capture.screenshotAssetId);
  assert(pixels.marker[0] > 220 && pixels.marker[1] > 60 && pixels.marker[1] < 160 && pixels.marker[2] < 80, JSON.stringify(pixels));
  assert.equal(pixels.sampling, false); assert.equal(pixels.prepares, 1); assert.equal(pixels.restores, 1); assert.equal(pixels.controls, 'visible');
});

test('sampling preparation cancellation and native failure restore controls and invalidate the version', async t => {
  const f = await fixture(t), a = await f.session(), { page } = await f.open(a.id);
  let draft = await f.draft(a.id); const frame = await install(page, draft);
  let began!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => began = resolve), held = new Promise<void>(resolve => release = resolve);
  await page.exposeBinding('holdSamplingPreparation', async () => { began(); await held; });
  await page.evaluate(() => {
    const original = window.acanvasCaptureController!.prepare;
    window.acanvasCaptureController!.prepare = async identity => { await original(identity); await (window as any).holdSamplingPreparation(); return window.acanvasCaptureController!.read(); };
  });
  const pending = capture(page); await started;
  await page.evaluate(identity => { (window as any).testCapture.active = false; return window.acanvasCaptureProvider!.cancel(identity); }, frame.identity);
  assert.equal(await page.evaluate(() => (window as any).testCapture.sampling), false);
  release(); assert.equal((await pending).status, 'incomplete'); assert.equal(f.running.service.draft(a.id).annotations[0].captureState!.version, 2);
  draft = await f.draft(a.id, note('failed-native')); await install(page, draft);
  page.screenshot = async () => { assert(await page.evaluate(() => (window as any).testCapture.sampling)); throw new Error('capture_native_failed'); };
  const failed = await capture(page); assert.equal(failed.status, 'incomplete'); assert.equal(await page.evaluate(() => (window as any).testCapture.sampling), false); assert.equal(f.running.service.draft(a.id).annotations[0].captureState!.version, 2);
});

for (const scenario of ['cancel', 'resize', 'target', 'navigation', 'timeout', 'page-close', 'browser-disconnect'] as const) {
  test(`in-flight ${scenario} preserves input and refuses old capture completion`, async t => {
    const f = await fixture(t), a = await f.session(), draft = await f.draft(a.id), { page } = await f.open(a.id), frame = await install(page, draft);
    const original = page.screenshot.bind(page);
    let release!: () => void, began!: () => void;
    const started = new Promise<void>(resolve => began = resolve), held = new Promise<void>(resolve => release = resolve);
    page.screenshot = async options => { began(); await held; return original(options); };
    const pending = capture(page).catch(error => ({ status: 'incomplete', code: String(error) } as BrowserCaptureResult));
    await started;
    if (scenario === 'cancel') await page.evaluate(identity => { (window as any).testCapture.active = false; return window.acanvasCaptureProvider!.cancel(identity); }, frame.identity);
    if (scenario === 'resize') await page.setViewportSize({ width: 1280, height: 900 });
    if (scenario === 'target') {
      const current = f.running.service.draft(a.id); f.running.service.saveDraft(a.id, { ...current, annotations: [{ ...current.annotations[0], bounds: { ...current.annotations[0].bounds, x: 90 } }] });
    }
    if (scenario === 'navigation') await page.reload();
    if (scenario === 'timeout') await page.waitForTimeout(8200);
    if (scenario === 'page-close') await page.close();
    if (scenario === 'browser-disconnect') await page.context().close();
    release(); const result = await pending; assert.equal(result.status, 'incomplete', JSON.stringify(result));
    if (scenario === 'navigation') {
      const deadline = Date.now() + 2000;
      while (f.running.service.draft(a.id).annotations[0].captureState!.version === 1 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    }
    const saved = f.running.service.draft(a.id); assert.equal(saved.annotations[0].text, draft.annotations[0].text); assert.equal(saved.annotations[0].captureState!.status, 'incomplete'); assert.equal(saved.annotations[0].captureState!.version, 2);
    assert.equal(f.running.service.state(a.id).assets.filter(asset => asset.evidence).length, 0);
    if (scenario === 'browser-disconnect') { assert.equal(f.running.browser.status().running, false); const replacement = await f.open(a.id); assert.notEqual(replacement.page, page); }
  });
}

test('same-document history updates keep capture identity while reload restores saved evidence', async t => {
  const f = await fixture(t), a = await f.session(), draft = await f.draft(a.id), { page } = await f.open(a.id);
  await install(page, draft); const original = page.screenshot.bind(page);
  page.screenshot = async options => { await page.evaluate(() => history.replaceState({}, '', `${location.pathname}${location.search}#scene`)); return original(options); };
  const result = await capture(page); assert.equal(result.status, 'complete', JSON.stringify(result)); if (result.status !== 'complete') return;
  const documentId = await page.evaluate(() => window.acanvasCaptureProvider!.documentId); await page.reload(); assert.notEqual(await page.evaluate(() => window.acanvasCaptureProvider!.documentId), documentId);
  await f.restart(); const savedCapture = f.running.service.captureResult(a.id, draft.id, draft.annotations[0].id, 1); assert.equal(savedCapture.capture.screenshotAssetId, result.result.capture.screenshotAssetId); assert.equal(savedCapture.status, 'committed');
});

for (const scenario of ['prepared-cancel', 'prepared-navigation', 'prepared-stop', 'upload-cancel', 'upload-response-loss'] as const) {
  test(`${scenario} reconciles or invalidates the complete capture job`, async t => {
    const f = await fixture(t), a = await f.session(), draft = await f.draft(a.id), { page } = await f.open(a.id), frame = await install(page, draft);
    const manager = f.running.browser as any, originalApi = manager.api.bind(manager);
    let release!: () => void, began!: () => void;
    const started = new Promise<void>(resolve => began = resolve), held = new Promise<void>(resolve => release = resolve);
    const originalFetch = globalThis.fetch;
    t.after(() => { globalThis.fetch = originalFetch; release?.(); });
    let partialBytes = 0;
    if (scenario.startsWith('prepared')) manager.api = async (...args: any[]) => {
      const result = await originalApi(...args);
      if (args[2] === 'POST') { began(); await held; }
      return result;
    };
    if (scenario === 'upload-response-loss') manager.api = async (...args: any[]) => {
      const result = await originalApi(...args);
      if (args[2] === 'PUT') throw new Error('response_lost');
      return result;
    };
    if (scenario === 'upload-cancel') globalThis.fetch = ((input: URL | RequestInfo, options?: RequestInit) => {
      if (options?.method !== 'PUT' || !String(input).endsWith('/content') || !(options.body instanceof ArrayBuffer)) return originalFetch(input, options);
      const bytes = new Uint8Array(options.body);
      const stream = new ReadableStream<Uint8Array>({ async start(controller) {
        controller.enqueue(bytes.subarray(0, Math.floor(bytes.length / 2)));
        const directory = join(f.root, '.acanvas/tmp'), deadline = Date.now() + 2000;
        while (Date.now() < deadline && partialBytes < 1) {
          for (const name of await readdir(directory)) if (name.includes('.capture-upload.')) partialBytes = Math.max(partialBytes, (await stat(join(directory, name))).size);
          if (!partialBytes) await new Promise(resolve => setTimeout(resolve, 10));
        }
        began(); await held;
        if (options.signal?.aborted) return;
        controller.enqueue(bytes.subarray(Math.floor(bytes.length / 2))); controller.close();
      } });
      return originalFetch(input, { ...options, body: stream, duplex: 'half' } as RequestInit);
    }) as typeof fetch;
    const pending = capture(page).catch(error => ({ status: 'incomplete', code: String(error) } as BrowserCaptureResult));
    if (scenario !== 'upload-response-loss') {
      await started;
      if (scenario === 'prepared-stop') {
        const stopping = f.running.close(); release(); await stopping; await f.restart();
      } else if (scenario === 'prepared-navigation') await page.reload();
      else await page.evaluate(identity => { (window as any).testCapture.active = false; return window.acanvasCaptureProvider!.cancel(identity); }, frame.identity);
      release();
    }
    const result = await pending;
    if (scenario === 'upload-response-loss') {
      assert.equal(result.status, 'complete', JSON.stringify(result));
      assert.equal(f.running.service.draft(a.id).annotations[0].captureState!.status, 'complete');
      assert.equal(f.running.service.state(a.id).assets.filter(asset => asset.evidence).length, 1);
    } else {
      assert.equal(result.status, 'incomplete', JSON.stringify(result));
      const deadline = Date.now() + 2000; while (f.running.service.draft(a.id).annotations[0].captureState!.version === 1 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
      const saved = f.running.service.draft(a.id); assert.equal(saved.annotations[0].captureState!.version, 2); assert.equal(saved.annotations[0].captureState!.status, 'incomplete'); assert.equal(saved.annotations[0].text, draft.annotations[0].text);
      if (scenario === 'upload-cancel') assert(partialBytes > 0, 'Actual PNG bytes reached the isolated service before cancellation.');
    }
  });
}

test('detached service and Chrome survive CLI exit and project stop closes the owned browser', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'acanvas-browser-detached-'))), webRoot = join(root, 'web');
  await mkdir(webRoot); await writeFile(join(webRoot, 'index.html'), '<!doctype html><title>Canvas</title>Canvas');
  const runner = join(root, 'service.mjs');
  await writeFile(runner, `import { startServer } from ${JSON.stringify(new URL(`file://${resolve('dist/src/server/http.js')}`).href)};const running=await startServer({root:${JSON.stringify(root)},port:0,webRoot:${JSON.stringify(webRoot)},browser:{headless:true}});process.on('SIGTERM',()=>void running.close().then(()=>process.exit(0)));console.log('ready');`);
  const child = spawn(process.execPath, [runner], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', chunk => output += chunk);
  t.after(async () => { child.kill('SIGTERM'); if (child.exitCode === null) await once(child, 'exit'); await rm(root, { recursive: true, force: true }); });
  const deadline = Date.now() + 5000; while (!output.includes('ready') && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20)); assert(output.includes('ready'));
  const run = async (args: string[]) => JSON.parse((await execute(process.execPath, [resolve('dist/src/cli.js'), ...args, '--project', root], { timeout: 20_000 })).stdout);
  const session = await run(['session', 'create', '--name', 'Detached canvas']);
  const first = await run(['browser', 'open', '--session', session.id]);
  const later = await run(['browser', 'status', '--session', session.id]); assert.equal(later.pages[0].pageId, first.pageId); assert(later.running);
  const profile = join(root, '.acanvas/runtime/browser-profile'); assert((await lstat(join(profile, 'SingletonLock'))).isSymbolicLink());
  await run(['project', 'stop']); assert.equal(await readRuntime(root), undefined);
  await assert.rejects(lstat(join(profile, 'SingletonLock')), (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT');
  assert.equal((await run(['project', 'status'])).status, 'stopped');
});
