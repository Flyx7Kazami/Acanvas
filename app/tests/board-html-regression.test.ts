import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { startServer } from '../src/server/http.js';
import { ProjectHtmlSurfaces, type HtmlSurfaceInfo } from '../src/server/render-surface/html.js';
import { NativeHtmlRuntime } from '../src/server/render-surface/cef.js';
import { launchRenderEngine } from '../src/server/render-surface/engine.js';
import { nativeRetirementSnapshot, waitNativeRetired } from './helpers/native-retirement.js';

const enabled = process.env.ACANVAS_BOARD_HTML_TESTS === '1';
const source = `<!doctype html><title>Owned audio card</title><style>body{margin:0;background:#edf1f2;font:16px sans-serif}main{padding:16px}input,button{font:inherit}input{display:block;width:240px;margin:8px 0}#meter{height:28px;background:#b9cddd;width:65%}</style><main><h2>Owned notebook</h2><input id="field" aria-label="Note" value="Fresh note"><button id="tone">Play tone</button><div id="meter"></div></main><script>window.sourceSeed=Math.random();document.querySelector('#tone').onclick=()=>{const a=new AudioContext(),o=a.createOscillator(),g=a.createGain();o.frequency.value=440;g.gain.value=.15;o.connect(g).connect(a.destination);o.start();o.stop(a.currentTime+.4);a.resume()}</script><!--${'owned fixture '.repeat(12_500)}-->`;

test('default HTML previews retain independent sources across canvas documents and close departed views', { skip: !enabled, timeout: 120_000 }, async t => {
  const began = Date.now(), directory = await mkdtemp(join(tmpdir(), 'acanvas-board-html-')), root = join(directory, 'project');
  await mkdir(root);
  const created: Array<{ info: HtmlSurfaceInfo; manager: ProjectHtmlSurfaces; runtime: NativeHtmlRuntime }> = [];
  const createErrors: Array<{ status?: number; code?: string }> = [], report: Record<string, unknown> = { status: 'incomplete', sourceBytes: Buffer.byteLength(source), viewport: { width: 740, height: 248, deviceScaleFactor: 2 } };
  const original = ProjectHtmlSurfaces.prototype.create;
  ProjectHtmlSurfaces.prototype.create = async function (...args) {
    try {
      const info = await original.apply(this, args);
      if (this['service'].project.root === root) created.push({ info, manager: this, runtime: (this as any).entries.get(info.surfaceId).native });
      return info;
    } catch (error) {
      if (this['service'].project.root === root) createErrors.push({ status: (error as any).status, code: (error as any).code });
      throw error;
    }
  };
  const server = await startServer({ root, port: 0, webRoot: resolve(process.env.ACANVAS_BOARD_HTML_WEB_ROOT || 'dist/web') });
  const bootstrap = await (await fetch(server.url + '/api/bootstrap')).json();
  const request = async (path: string, method = 'GET', body?: object) => {
    const response = await fetch(server.url + path, { method, headers: { Authorization: `Bearer ${bootstrap.token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { response, value: await response.json() };
  };
  const call = async (path: string, method = 'GET', body?: object) => { const result = await request(path, method, body); assert(result.response.ok, JSON.stringify(result.value)); return result.value; };
  const session = await call('/api/sessions', 'POST', { name: 'Owned HTML regression' }), assets: string[] = [];
  for (let index = 0; index < 3; index++) {
    const upload = await fetch(server.url + `/api/assets?name=Owned-${index}.html&mime=text%2Fhtml`, { method: 'POST', headers: { Authorization: `Bearer ${bootstrap.token}` }, body: source });
    assert(upload.ok); assets.push((await upload.json()).id);
  }
  const board = await call('/api/board/operations', 'POST', { sessionId: session.id, operations: assets.map((assetId, index) => ({ type: 'create', object: { assetId, x: 30, y: 30 + index * 280, width: 740, height: 247.8823083343793 } })) });
  const browser = await launchRenderEngine(), context = await browser.newContext({ viewport: { width: 1280, height: 1000 }, deviceScaleFactor: 2 });
  t.after(async () => {
    await browser.close(); await server.close(); ProjectHtmlSurfaces.prototype.create = original;
    report.created = created.length; report.createErrors = createErrors; report.elapsedMs = Date.now() - began;
    if (process.env.ACANVAS_BOARD_HTML_EVIDENCE) await writeFile(process.env.ACANVAS_BOARD_HTML_EVIDENCE, JSON.stringify(report, null, 2) + '\n');
    await rm(directory, { recursive: true, force: true });
  });
  const page = await context.newPage(), second = await context.newPage(), errors: string[] = []; let normalCloseRequests = 0;
  page.on('request', request => { if (request.method() === 'DELETE' && /\/capture-views\/[^/]+$/.test(new URL(request.url()).pathname)) normalCloseRequests++; });
  for (const target of [page, second]) target.on('pageerror', error => errors.push(error.message));
  await page.goto(server.url + '/?session=' + session.id);
  await page.waitForFunction(() => document.querySelectorAll('[data-preview-ready="true"]').length === 3, undefined, { timeout: 30_000 });
  await second.goto(server.url + '/?session=' + session.id);
  const secondReady = await second.waitForFunction(() => document.querySelectorAll('[data-preview-ready="true"]').length === 3, undefined, { timeout: 12_000 }).then(() => true, () => false);
  report.secondDocumentReady = await second.locator('[data-preview-ready="true"]').count();
  report.secondDocumentErrors = await second.locator('.html-preview-error').allTextContents();
  assert(secondReady, `Second document previews: ${JSON.stringify(report)}`);
  assert.equal(created.length, 6); assert.equal(createErrors.length, 0);
  const first = created.find(entry => entry.info.viewId === created[0].info.viewId && entry.info.assetId === assets[0])!;
  const peer = created.find(entry => entry.info.viewId !== first.info.viewId && entry.info.assetId === first.info.assetId)!;
  const viewPath = `/api/sessions/${session.id}/capture-views/${first.info.viewId}/html-surfaces`, ownership = { documentId: first.info.documentId, viewGeneration: first.info.viewGeneration };
  const fourth = await call(viewPath, 'POST', { ...ownership, objectId: first.info.objectId, assetId: first.info.assetId, viewport: { ...first.info.viewport, deviceScaleFactor: 2 } });
  const overflow = await request(viewPath, 'POST', { ...ownership, objectId: first.info.objectId, assetId: first.info.assetId, viewport: first.info.viewport });
  assert.equal(overflow.response.status, 429); assert.equal(overflow.value.error.code, 'surface_view_limit');
  await call(viewPath + '/' + fourth.surfaceId, 'DELETE', ownership);
  report.perViewLimit = 4;
  assert.equal(first.info.engine, 'cef'); assert.notEqual(first.info.instanceId, peer.info.instanceId);
  const flags = await first.runtime.protocol('Browser.getBrowserCommandLine');
  assert(flags.arguments.includes('--headless=new')); assert(!flags.arguments.includes('--no-sandbox'));
  assert(flags.arguments.some((value: string) => value.startsWith('--disable-features=') && value.includes('UseKeychainKeyProvider')));
  assert.equal((await first.runtime.protocol('Surface.instrumentation')).clipboardTripwire, false);
  assert.equal((await stat(first.runtime.directory())).mode & 0o777, 0o700);
  const object = board.objects.find((item: any) => item.assetId === assets[0]);
  const panel = page.locator(`[data-object-id="${object.id}"] .html-content`), controls = panel.locator('[data-html-semantics]'), field = controls.locator('[data-html-control="#field"]');
  await field.focus(); await page.keyboard.press('Meta+A'); await page.keyboard.type('Selected source note');
  const inputDeadline = Date.now() + 7000;
  while (Date.now() < inputDeadline) {
    const current = Number(await controls.getAttribute('data-frame-seq'));
    if (first.manager.frame(first.info.surfaceId, current).semantics.controls.find(control => control.id === '#field')?.value === 'Selected source note') break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(await first.runtime.documentEvaluate('document.querySelector("#field").value'), 'Selected source note');
  assert.equal(await peer.runtime.documentEvaluate('document.querySelector("#field").value'), 'Fresh note');
  const seq = Number(await controls.getAttribute('data-frame-seq')), shown = first.manager.frame(first.info.surfaceId, seq);
  assert.equal(shown.semantics.controls.find(control => control.id === '#field')?.value, 'Selected source note');
  first.manager.retainSurface(shown.owner, shown);
  await controls.getByRole('button', { name: 'Play tone', exact: true }).click();
  const audioDeadline = Date.now() + 4000;
  const peak = () => Math.max(0, ...first.runtime.audioSince(0).flatMap(packet => { let value = 0; for (let index = 0; index < packet.pcm.length; index += 4) value = Math.max(value, Math.abs(packet.pcm.readFloatLE(index))); return [value]; }));
  while (peak() < .005 && Date.now() < audioDeadline) await new Promise(resolve => setTimeout(resolve, 20));
  const packets = first.runtime.audioSince(0), signalPeak = peak(); assert(packets.length > 0);
  assert(signalPeak > .005);
  assert.equal(packets[0].sampleRate, 48_000); assert.equal(packets[0].channels, 2);
  const contentPath = `/api/sessions/${session.id}/capture-views/${peer.info.viewId}/html-surfaces/${first.info.surfaceId}/frames/${seq}?documentId=${peer.info.documentId}&viewGeneration=${peer.info.viewGeneration}`;
  assert.equal((await request(contentPath)).response.status, 403);
  const seed = await first.runtime.documentEvaluate('window.sourceSeed', false), peerRetirement = await nativeRetirementSnapshot(peer.runtime);
  await page.evaluate(() => { window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })); window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })); });
  assert.equal(await first.runtime.documentEvaluate('window.sourceSeed', false), seed);
  report.persistedPagehidePreservedSource = true;
  const peerSeed = await peer.runtime.documentEvaluate('window.sourceSeed', false), oldProfiles = await Promise.all(created.filter(entry => entry.info.viewId === first.info.viewId && !(entry.manager as any).entries.get(entry.info.surfaceId).closed).map(entry => nativeRetirementSnapshot(entry.runtime)));
  await call(`/api/sessions/${session.id}/capture-views/${first.info.viewId}`, 'DELETE', { ...ownership, operationSeq: 1_000_000 });
  await page.waitForFunction(() => document.querySelectorAll('[data-preview-ready="true"]').length === 3, undefined, { timeout: 25_000 });
  const registrationDeadline = Date.now() + 15_000;
  while (!created.some(entry => entry.info.documentId === first.info.documentId && entry.info.viewGeneration > first.info.viewGeneration) && Date.now() < registrationDeadline) await new Promise(resolve => setTimeout(resolve, 20));
  await page.waitForFunction(() => document.querySelectorAll('[data-preview-ready="true"]').length === 3, undefined, { timeout: 25_000 });
  const activeFirst = created.find(entry => entry.info.documentId === first.info.documentId && entry.info.viewGeneration > first.info.viewGeneration && entry.info.assetId === first.info.assetId)!;
  assert(activeFirst); assert.notEqual(activeFirst.info.viewId, first.info.viewId);
  assert.equal(await activeFirst.runtime.documentEvaluate('document.querySelector("#field").value'), 'Fresh note');
  assert.equal(await peer.runtime.documentEvaluate('window.sourceSeed', false), peerSeed);
  await Promise.all(oldProfiles.map(waitNativeRetired));
  const activeSeed = await activeFirst.runtime.documentEvaluate('window.sourceSeed', false);
  report.invalidViewReRegistered = true; report.peerSourcePreservedAcrossRegistration = true;
  await second.goto('about:blank');
  await waitNativeRetired(peerRetirement);
  assert.equal(await activeFirst.runtime.documentEvaluate('window.sourceSeed', false), activeSeed);
  assert.equal(await activeFirst.runtime.documentEvaluate('document.querySelector("#field").value'), 'Fresh note');
  assert(first.manager.frame(first.info.surfaceId, seq).png.equals(shown.png)); first.manager.releaseSurface(shown.owner, shown);
  for (let reload = 0; reload < 3; reload++) {
    const active = created.filter(entry => !(entry.manager as any).entries.get(entry.info.surfaceId).closed), profiles = await Promise.all(active.map(entry => nativeRetirementSnapshot(entry.runtime)));
    await page.reload();
    await page.waitForFunction(() => document.querySelectorAll('[data-preview-ready="true"]').length === 3, undefined, { timeout: 25_000 });
    await Promise.all(profiles.map(waitNativeRetired));
    assert.equal(created.filter(entry => !(entry.manager as any).entries.get(entry.info.surfaceId).closed).length, 3);
  }
  report.normalReloads = 3; report.liveNativeAfterEachReload = 3;
  assert.deepEqual(errors, []);
  report.productionCef = true; report.independentSources = true; report.inputAndSnapshotSameN = true; report.departedProfileRemoved = true; report.remainingSourceStatePreserved = true; report.crossViewRead = 403; report.pcm = { packets: packets.length, sampleRate: packets[0].sampleRate, channels: packets[0].channels, peak: signalPeak };
  const live = created.filter(entry => !(entry.manager as any).entries.get(entry.info.surfaceId).closed), profiles = await Promise.all(live.map(entry => nativeRetirementSnapshot(entry.runtime))), beforeClose = normalCloseRequests;
  await browser.close();
  const graceDeadline = Date.now() + 8000;
  while (Date.now() < graceDeadline && created.some(entry => !(entry.manager as any).entries.get(entry.info.surfaceId).closed)) await new Promise(resolve => setTimeout(resolve, 20));
  const retirements = await Promise.all(profiles.map(waitNativeRetired));
  assert.equal(created.filter(entry => !(entry.manager as any).entries.get(entry.info.surfaceId).closed).length, 0);
  assert.equal(normalCloseRequests, beforeClose);
  report.browserCloseWithoutPagehide = true; report.abruptClientCloseNativeAfterGrace = 0; report.actualNativeProcessesGone = true; report.nativeCompletionAfterLogicalCloseMs = retirements; report.nativeCompletionBudgetMs = 18_000; report.status = 'passed';
});

test('a waiting HTML document opens automatically when temporary project capacity is released', { skip: !enabled, timeout: 45_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'acanvas-board-html-capacity-'));
  const server = await startServer({ root, port: 0, webRoot: resolve(process.env.ACANVAS_BOARD_HTML_WEB_ROOT || 'dist/web'), htmlSurfaces: { maxSurfaces: 1 } });
  const bootstrap = await (await fetch(server.url + '/api/bootstrap')).json();
  const call = async (path: string, method: string, body: object) => {
    const response = await fetch(server.url + path, { method, headers: { Authorization: `Bearer ${bootstrap.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const value = await response.json(); assert(response.ok, JSON.stringify(value)); return value;
  };
  const session = await call('/api/sessions', 'POST', { name: 'Owned project capacity' });
  const upload = await fetch(server.url + '/api/assets?name=Owned-capacity.html&mime=text%2Fhtml', { method: 'POST', headers: { Authorization: `Bearer ${bootstrap.token}` }, body: source });
  assert(upload.ok); const asset = await upload.json();
  await call('/api/board/operations', 'POST', { sessionId: session.id, operations: [{ type: 'create', object: { assetId: asset.id, x: 40, y: 50, width: 740, height: 248 } }] });
  const browser = await launchRenderEngine(), first = await browser.newPage(), second = await browser.newPage();
  t.after(async () => { await browser.close(); await server.close(); await rm(root, { recursive: true, force: true }); });
  await first.goto(server.url + '/?session=' + session.id);
  await first.locator('[data-preview-ready="true"]').waitFor({ timeout: 25_000 });
  const rejected = second.waitForResponse(response => response.status() === 429 && /\/html-surfaces$/.test(new URL(response.url()).pathname));
  await second.goto(server.url + '/?session=' + session.id);
  assert.equal((await (await rejected).json()).error.code, 'surface_limit');
  await first.goto('about:blank');
  await second.locator('[data-preview-ready="true"]').waitFor({ timeout: 12_000 });
  assert.equal(await second.locator('.html-preview-error').count(), 0);
});

test('closing a capture view during native creation releases its private source and project capacity', { skip: !enabled, timeout: 45_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'acanvas-board-html-opening-'));
  const server = await startServer({ root, port: 0, htmlSurfaces: { maxSurfaces: 1 } });
  const bootstrap = await (await fetch(server.url + '/api/bootstrap')).json();
  const request = async (path: string, method: string, body: object) => {
    const response = await fetch(server.url + path, { method, headers: { Authorization: `Bearer ${bootstrap.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { response, value: await response.json() };
  };
  const call = async (path: string, method: string, body: object) => { const value = await request(path, method, body); assert(value.response.ok, JSON.stringify(value.value)); return value.value; };
  const session = await call('/api/sessions', 'POST', { name: 'Owned opening lifecycle' });
  const upload = await fetch(server.url + '/api/assets?name=Owned-opening.html&mime=text%2Fhtml', { method: 'POST', headers: { Authorization: `Bearer ${bootstrap.token}` }, body: source });
  assert(upload.ok); const asset = await upload.json();
  const board = await call('/api/board/operations', 'POST', { sessionId: session.id, operations: [{ type: 'create', object: { assetId: asset.id, x: 0, y: 0, width: 740, height: 248 } }] });
  const views = `/api/sessions/${session.id}/capture-views`, view = await call(views, 'POST', { documentId: 'owned-opening-document' });
  const ownership = { documentId: view.documentId, viewGeneration: view.viewGeneration }, body = { ...ownership, objectId: board.objects[0].id, assetId: asset.id, viewport: { width: 740, height: 248 } };
  let release!: () => void, entered!: () => void, retirement: Awaited<ReturnType<typeof nativeRetirementSnapshot>>;
  const held = new Promise<void>(resolve => { release = resolve; }), opened = new Promise<void>(resolve => { entered = resolve; }), original = NativeHtmlRuntime.prototype.open;
  NativeHtmlRuntime.prototype.open = async function (...args) { await original.apply(this, args); if (args[1].startsWith(root)) { retirement = await nativeRetirementSnapshot(this); entered(); await held; } };
  t.after(async () => { release(); NativeHtmlRuntime.prototype.open = original; await server.close(); await rm(root, { recursive: true, force: true }); });
  const creating = request(views + '/' + view.viewId + '/html-surfaces', 'POST', body);
  await opened;
  await call(views + '/' + view.viewId, 'DELETE', { ...ownership, operationSeq: 1 });
  await waitNativeRetired(retirement!); release();
  const closed = await creating; assert.equal(closed.response.status, 410); assert.equal(closed.value.error.code, 'surface_closed');
  NativeHtmlRuntime.prototype.open = original;
  const next = await call(views, 'POST', { documentId: view.documentId });
  const fresh = await call(views + '/' + next.viewId + '/html-surfaces', 'POST', { ...body, documentId: next.documentId, viewGeneration: next.viewGeneration });
  assert.equal(fresh.engine, 'cef'); assert.notEqual(fresh.viewId, view.viewId);
});
