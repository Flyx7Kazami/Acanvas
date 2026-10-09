import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const dist = process.env.ACANVAS_HTML_RESPONSE_DIST;
assert(dist, 'Set the private compiled distribution.');
const output = process.env.ACANVAS_HTML_RESPONSE_OUTPUT || await mkdtemp(join(tmpdir(), 'acanvas-html-response-output-'));
await mkdir(output, { recursive: true });
const load = file => import(pathToFileURL(join(dist, file)).href);
const { startServer } = await load('src/server/http.js');
const { ProjectHtmlSurfaces } = await load('src/server/render-surface/html.js');
const { NativeHtmlRuntime } = await load('src/server/render-surface/cef.js');
const { launchRenderEngine } = await load('src/server/render-surface/engine.js');
const root = await mkdtemp(join(tmpdir(), 'acanvas-html-response-project-'));
const created = [], inputs = [], samples = [], pairs = [], protocols = [];
const original = { create: ProjectHtmlSurfaces.prototype.create, input: ProjectHtmlSurfaces.prototype.input, sample: ProjectHtmlSurfaces.prototype.sample, pair: NativeHtmlRuntime.prototype.samplePair, protocol: NativeHtmlRuntime.prototype.protocol, open: NativeHtmlRuntime.prototype.open };
const now = () => Date.now();
const execute = promisify(execFile);
async function processSample() { return { at: now(), note: 'Independent functionality run omits broad process enumeration; lifecycle checks use only owned parent/PID lists.', processes: [] }; }

ProjectHtmlSurfaces.prototype.create = async function (...args) { const info = await original.create.apply(this, args); if (this.service.project.root === root) created.push({ info, runtime: this.entries.get(info.surfaceId).native }); return info; };
ProjectHtmlSurfaces.prototype.input = async function (...args) { const row = { at: now(), input: args[1] }; inputs.push(row); try { const value = await original.input.apply(this, args); row.end = now(); return value; } catch (error) { row.error = String(error); throw error; } };
ProjectHtmlSurfaces.prototype.sample = async function (...args) { const row = { at: now() }; samples.push(row); try { const value = await original.sample.apply(this, args); Object.assign(row, { end: now(), frameSeq: value.frameSeq, inputSeq: value.inputSeq, count: value.semantics.controls.find(item => item.id === '#counter')?.value }); return value; } catch (error) { row.error = String(error); throw error; } };
NativeHtmlRuntime.prototype.samplePair = async function (...args) { const row = { at: now() }; pairs.push(row); try { const value = await original.pair.apply(this, args); Object.assign(row, { end: now(), ...value.timing }); return value; } catch (error) { row.error = String(error); throw error; } };
NativeHtmlRuntime.prototype.protocol = async function (...args) { const row = { at: now(), method: args[0] }; protocols.push(row); try { const value = await original.protocol.apply(this, args); row.end = now(); return value; } catch (error) { row.error = String(error); throw error; } };
if (process.env.ACANVAS_HTML_RESPONSE_NATIVE_EXECUTABLE) NativeHtmlRuntime.prototype.open = async function (...args) { this.executable = resolve(process.env.ACANVAS_HTML_RESPONSE_NATIVE_EXECUTABLE); this.helperPrefix = join(this.executable, '..', '..', 'Frameworks', 'acanvas-surface Helper'); return original.open.apply(this, args); };
const source = `<!doctype html><title>Counter</title><style>body{margin:0;background:#edf1f2;font:16px sans-serif}main{padding:16px}button,input{font:inherit;display:block;margin:8px 0}#counter{width:230px}#field{width:230px}canvas{position:absolute;top:16px;left:350px;width:240px;height:150px}</style><main><button id="advance">Advance</button><input id="counter" value="0" readonly aria-label="Count"><input id="field" value="Fresh" aria-label="Note"><canvas id="motion" width="240" height="150"></canvas><div style="height:900px">End</div></main><script>window.clicks=[];let count=0;advance.onclick=e=>{counter.value=String(++count);clicks.push({count,at:Date.now(),trusted:e.isTrusted});document.body.style.backgroundColor=count%2?'rgb(224,235,242)':'rgb(237,241,242)'};let tick=0;const c=motion.getContext('2d');function paint(){c.fillStyle='#8496a5';c.fillRect(0,0,240,150);c.fillStyle='#e1ad68';c.fillRect(tick++%200,20,35,90);requestAnimationFrame(paint)}paint();</script><!--${'owned fixture '.repeat(12_500)}-->`;
let server, browser, context;
const report = { status: 'incomplete', version: process.env.ACANVAS_HTML_RESPONSE_VERSION || 'working-tree', measuredAt: new Date().toISOString(), viewport: { width: 1440, height: 1000, dpr: 2 }, surface: { width: 740, height: 248, dpr: 2 }, root, output, inputs, samples, pairs, protocols, boundaries: 'Isolated production App / loopback port 0 / real normal CEF. Native handler and client timestamps use Date.now at millisecond resolution. Display means committed scene Canvas drawImage after its semantic frame has been installed, excluding compositor/display and physical trackpad. Wrappers add microtiming overhead. Dynamic source rAF remains active.' };
try {
  server = await startServer({ root, port: 0, webRoot: resolve(process.env.ACANVAS_HTML_RESPONSE_WEB_ROOT || join(dist, 'web')) });
  const bootstrap = await (await fetch(server.url + '/api/bootstrap')).json();
  const call = async (path, method = 'GET', body) => { const response = await fetch(server.url + path, { method, headers: { Authorization: 'Bearer ' + bootstrap.token, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }); const value = await response.json(); assert(response.ok, JSON.stringify(value)); return value; };
  const session = await call('/api/sessions', 'POST', { name: 'Isolated HTML response' });
  const upload = await fetch(server.url + '/api/assets?name=Owned.html&mime=text%2Fhtml', { method: 'POST', headers: { Authorization: 'Bearer ' + bootstrap.token }, body: source }); assert(upload.ok); const asset = await upload.json();
  const board = await call('/api/board/operations', 'POST', { sessionId: session.id, operations: [{ type: 'create', object: { assetId: asset.id, x: 220, y: 140, width: 740, height: 248 } }] });
  const objectId = board.objects[0].id;
  browser = await launchRenderEngine(); context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2 });
  await context.addInitScript(() => {
    Object.defineProperty(window, 'ongesturestart', { configurable: true, value: null });
    const facts = window.ownedHtmlResponse = { clicks: [], frameRequests: [], metadataRequests: [], decodes: [], commits: [], wheels: [], touches: [] };
    const fetchOriginal = window.fetch.bind(window);
    window.fetch = async (...args) => { const url = typeof args[0] === 'string' ? args[0] : args[0].url, at = Date.now(); const result = await fetchOriginal(...args); if (/\/html-surfaces\//.test(url)) { const row = { at, end: Date.now(), url }; if (/\/sample$/.test(url)) { const frame = await result.clone().json(); facts.metadataRequests.push({ ...row, frameSeq: frame.frameSeq, inputSeq: frame.inputSeq, count: frame.semantics?.controls.find(item => item.id === '#counter')?.value }); } else if (/\/frames\//.test(url)) facts.frameRequests.push(row); } return result; };
    const decode = HTMLImageElement.prototype.decode;
    HTMLImageElement.prototype.decode = async function (...args) { const at = Date.now(); await decode.apply(this, args); facts.decodes.push({ at, end: Date.now() }); };
    const draw = CanvasRenderingContext2D.prototype.drawImage;
    CanvasRenderingContext2D.prototype.drawImage = function (...args) { const value = draw.apply(this, args); if (this.canvas.classList.contains('scene-canvas')) { const control = document.querySelector('[data-html-semantics]'); const counter = control?.querySelector('[data-html-control="#counter"]'); if (control) facts.commits.push({ at: Date.now(), frameSeq: Number(control.dataset.frameSeq), count: counter?.value }); } return value; };
    document.addEventListener('click', event => { if (event.target?.closest('[data-html-control="#advance"]')) facts.clicks.push({ at: Date.now(), trusted: event.isTrusted }); }, true);
    document.addEventListener('wheel', event => facts.wheels.push({ at: Date.now(), ctrlKey: event.ctrlKey, metaKey: event.metaKey, deltaX: event.deltaX, deltaY: event.deltaY }), true);
    for (const type of ['pointerdown', 'pointermove', 'pointerup']) document.addEventListener(type, event => { if (event.pointerType === 'touch') facts.touches.push({ type, at: Date.now(), id: event.pointerId, x: event.clientX, y: event.clientY, target: event.target.tagName + '.' + event.target.className, control: event.target.closest('[data-canvas-control]')?.outerHTML.slice(0, 300) }); }, true);
  });
  const page = await context.newPage(), errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(server.url + '/?session=' + session.id);
  const panel = page.locator(`[data-object-id="${objectId}"] .html-content`), controls = panel.locator('[data-html-semantics]'); await controls.waitFor({ timeout: 30_000 });
  assert.equal(created[0].info.engine, 'cef');
  report.processSamples = [await processSample()];
  const flags = await created[0].runtime.protocol('Browser.getBrowserCommandLine'); assert(flags.arguments.includes('--headless=new')); assert(!flags.arguments.includes('--no-sandbox')); assert(flags.arguments.some(value => value.includes('UseKeychainKeyProvider')));
  const rounds = Number(process.env.ACANVAS_HTML_RESPONSE_ROUNDS || 12);
  for (let index = 1; index <= rounds; index++) {
    await controls.locator('[data-html-control="#advance"]').click();
    await page.waitForFunction(count => window.ownedHtmlResponse.commits.some(item => item.count === String(count)), index, { timeout: 10_000 });
    await page.waitForTimeout((index * 79) % 260);
  }
  report.nativeClicks = await created[0].runtime.documentEvaluate('window.clicks', false);
  report.processSamples.push(await processSample());
  report.client = await page.evaluate(() => window.ownedHtmlResponse);
  report.response = report.nativeClicks.map((native, index) => {
    const click = report.client.clicks[index], pair = samples.find(item => item.count === String(native.count)), display = report.client.commits.find(item => item.frameSeq === pair?.frameSeq);
    return { count: native.count, clickAt: click.at, nativeProcessedAt: native.at, consistentPairAt: pair?.end, displayAt: display?.at, clickToNativeMs: native.at - click.at, nativeToPairMs: pair?.end - native.at, pairToDisplayMs: display?.at - pair?.end, clickToDisplayMs: display?.at - click.at, inputTrusted: native.trusted, clientTrusted: click.trusted };
  });
  report.security = { normalCef: true, headless: true, rendererSandbox: true, keychainProviderDisabled: true, clipboardTripwire: (await created[0].runtime.protocol('Surface.instrumentation')).clipboardTripwire };
  report.errors = errors; assert.deepEqual(errors, []);
  if (process.env.ACANVAS_HTML_RESPONSE_STRESS === '1') {
    await created[0].runtime.documentEvaluate(`advance.addEventListener('click',()=>{if(window.ownedAudio)return;const audio=window.ownedAudio=new AudioContext(),o=audio.createOscillator(),g=audio.createGain();g.gain.value=.12;o.connect(g).connect(audio.destination);o.start();audio.resume()})`, false);
    let release, entered; const held = new Promise(resolve => release = resolve), intercepted = new Promise(resolve => entered = resolve); let waiting = true;
    await page.route(/\/html-surfaces\/[^/]+\/frames\/\d+\/content\?/, async route => { const response = await route.fetch(); if (waiting) { waiting = false; entered(); await held; } await route.fulfill({ response }); });
    await intercepted;
    const started = now(), tickBefore = await created[0].runtime.documentEvaluate('tick', false), nativeBefore = rounds;
    for (let index = 0; index < 10; index++) await controls.locator('[data-html-control="#advance"]').click();
    release();
    const deadline = now() + 10_000;
    while (now() < deadline && await created[0].runtime.documentEvaluate('counter.value') !== String(nativeBefore + 10)) await page.waitForTimeout(10);
    assert.equal(await created[0].runtime.documentEvaluate('counter.value'), String(nativeBefore + 10));
    await page.waitForFunction(count => { const facts = window.ownedHtmlResponse, frame = facts.metadataRequests.find(item => item.count === String(count)); return frame && facts.commits.some(item => item.frameSeq === frame.frameSeq); }, nativeBefore + 10, { timeout: 10_000 });
    const tickAfter = await created[0].runtime.documentEvaluate('tick', false), audioDeadline = now() + 3000;
    while (now() < audioDeadline && created[0].runtime.audioSince(0).length < 3) await page.waitForTimeout(20);
    const packets = created[0].runtime.audioSince(0), gaps = packets.slice(1).map((packet, index) => packet.pts - packets[index].pts);
    assert(tickAfter > tickBefore); assert(packets.length > 1); assert.equal(await created[0].runtime.documentEvaluate('ownedAudio.state', false), 'running');
    const display = await page.evaluate(count => { const facts = window.ownedHtmlResponse, frame = facts.metadataRequests.find(item => item.count === String(count)); return { frame, commit: facts.commits.find(item => item.frameSeq === frame.frameSeq) }; }, nativeBefore + 10);
    const acceptedSeq = Math.max(...inputs.filter(row => row.end).map(row => row.input.inputSeq)); assert(display.frame.inputSeq >= acceptedSeq);
    const intervals = samples.filter(item => item.end).flatMap(item => [{ at: item.at, change: 1 }, { at: item.end, change: -1 }]).sort((a, b) => a.at - b.at || a.change - b.change); let active = 0, peak = 0; for (const item of intervals) peak = Math.max(peak, active += item.change); assert.equal(peak, 1);
    report.stress = { inputsDuringInFlightFrameDelivery: 10, acceptedInputSeq: acceptedSeq, displayedInputSeq: display.frame.inputSeq, displayedCount: display.frame.count, count: nativeBefore + 10, elapsedMs: now() - started, rAfTicksDuringBurst: tickAfter - tickBefore, maxConcurrentSampleRequests: peak, nativeAudioRunning: true, pcmPackets: packets.length, maxPcmPtsGapMs: Math.max(...gaps), finalDisplay: { at: display.commit.at, frameSeq: display.commit.frameSeq }, invisibleTextProxyValueAtCommit: display.commit.count };
    await page.unroute(/\/html-surfaces\/[^/]+\/frames\/\d+\/content\?/);
  }
  const field = controls.locator('[data-html-control="#field"]'); await field.focus(); await page.keyboard.press('Meta+A'); await page.keyboard.type('Edited note');
  const textDeadline = Date.now() + 10_000;
  while (Date.now() < textDeadline && await created[0].runtime.documentEvaluate('field.value') !== 'Edited note') await page.waitForTimeout(20);
  assert.equal(await created[0].runtime.documentEvaluate('field.value'), 'Edited note'); report.nativeTextInput = true;
  const camera = () => page.locator('.canvas-world').evaluate(element => { const matrix = new DOMMatrix(getComputedStyle(element).transform); return { x: matrix.e, y: matrix.f, zoom: matrix.a }; });
  report.wheel = { before: await camera(), targets: [] };
  for (const [index, target] of [panel.locator('canvas'), controls.locator('[data-html-control="#advance"]'), controls.locator('[data-html-control="#field"]')].entries()) {
    await target.hover({ position: index === 0 ? { x: 600, y: 200 } : undefined });
    const before = await camera(); await page.mouse.wheel(7, 11); await page.waitForTimeout(100);
    const after = await camera(), event = await page.evaluate(() => window.ownedHtmlResponse.wheels.at(-1)); report.wheel.targets.push({ before, after, event });
    if (process.env.ACANVAS_HTML_RESPONSE_ASSERT === '1') assert.deepEqual(after, { ...before, x: before.x - event.deltaX, y: before.y - event.deltaY });
  }
  report.wheel.sourceScrollY = await created[0].runtime.documentEvaluate('scrollY');
  if (process.env.ACANVAS_HTML_RESPONSE_ASSERT === '1') {
    assert.equal(report.wheel.sourceScrollY, 0); assert.equal(inputs.filter(row => row.input.type === 'wheel').length, 0);
    for (const modifier of ['Control', 'Meta']) {
      await controls.locator('[data-html-control="#advance"]').hover(); const before = await camera();
      await page.keyboard.down(modifier); await page.mouse.wheel(0, -20); await page.keyboard.up(modifier);
      const event = await page.evaluate(() => window.ownedHtmlResponse.wheels.at(-1));
      await page.waitForFunction(zoom => Math.abs(new DOMMatrix(getComputedStyle(document.querySelector('.canvas-world')).transform).a - zoom) < .0001, before.zoom * Math.exp(-event.deltaY * .005));
      report.wheel[modifier] = { before, after: await camera(), event };
    }
    const before = await camera(), rect = await panel.locator('canvas').boundingBox(), cdp = await context.newCDPSession(page);
    const point = { x: rect.x + rect.width * .7, y: rect.y + rect.height * .7 }, spread = 35;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...point, x: point.x - spread, id: 1 }, { ...point, x: point.x + spread, id: 2 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ ...point, x: point.x - spread * 1.5, id: 1 }, { ...point, x: point.x + spread * 1.5, id: 2 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.waitForTimeout(150);
    report.wheel.touchPinch = { before, after: await camera(), point, touches: await page.evaluate(() => window.ownedHtmlResponse.touches), via: 'Chrome CDP touch pointer events on HTML canvas' }; await cdp.detach();
    report.wheel.touchPinch.passed = Math.abs(report.wheel.touchPinch.after.zoom - before.zoom * 1.5) < .0001;
    if (process.env.ACANVAS_HTML_RESPONSE_TOUCH_ASSERT === '1') assert(report.wheel.touchPinch.passed, JSON.stringify(report.wheel.touchPinch));
    const nativeBefore = await camera();
    await panel.locator('canvas').evaluate(element => { const rect = element.getBoundingClientRect(); for (const [type, scale] of [['gesturestart', 1], ['gesturechange', 1.25], ['gestureend', 1.25]]) { const event = new Event(type, { bubbles: true, cancelable: true }); Object.defineProperties(event, { scale: { value: scale }, clientX: { value: rect.x + rect.width * .7 }, clientY: { value: rect.y + rect.height * .7 } }); element.dispatchEvent(event); } });
    await page.waitForFunction(zoom => Math.abs(new DOMMatrix(getComputedStyle(document.querySelector('.canvas-world')).transform).a - zoom) < .0001, nativeBefore.zoom * 1.25);
    report.wheel.webkitGesture = { before: nativeBefore, after: await camera(), via: 'Synthetic WebKit gesture capability path on HTML canvas; physical Safari/trackpad remains outside this automation.' };
  }
  report.status = 'passed';
  console.log(JSON.stringify({ output, status: report.status, response: report.response, pairTimings: pairs.map(item => ({ prepareMs: item.prepareMs, pauseMs: item.pauseMs, totalMs: item.totalMs })), wheel: report.wheel }));
} catch (error) { report.error = String(error); console.error(error); process.exitCode = 1; }
finally {
  await browser?.close(); await server?.close();
  for (const [key, method] of Object.entries(original)) { if (key === 'pair') NativeHtmlRuntime.prototype.samplePair = method; else if (key === 'protocol') NativeHtmlRuntime.prototype.protocol = method; else if (key === 'open') NativeHtmlRuntime.prototype.open = method; else ProjectHtmlSurfaces.prototype[key] = method; }
  await writeFile(join(output, 'measurement.json'), JSON.stringify(report, null, 2) + '\n');
  await rm(root, { recursive: true, force: true });
}
