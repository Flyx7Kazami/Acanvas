import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CanvasService } from '../src/server/service.js';
import { ProjectHtmlSurfaces, type HtmlSurfacesOptions } from '../src/server/render-surface/html.js';
import { NativeHtmlRuntime, collectNativeWorkerPids } from '../src/server/render-surface/cef.js';
import type { HtmlPreviewRuntime } from '../src/server/html-preview.js';

function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function fixture(t: test.TestContext, options: HtmlSurfacesOptions = {}) {
  const root = await mkdtemp(join(tmpdir(), 'acanvas-html-admission-')), service = new CanvasService(root), session = service.createSession('Admission');
  const assetId = randomUUID(), path = `assets/${assetId}.html`, source = '<!doctype html><input>'; await writeFile(join(service.dataDir, path), source);
  service.registerAsset({ id: assetId, name: 'Owned.html', kind: 'file', mime: 'text/html', size: Buffer.byteLength(source), createdAt: new Date().toISOString() }, path);
  const object = service.boardOperations(session.id, [{ type: 'create', object: { assetId, x: 0, y: 0, width: 100, height: 60 } }]).objects[0];
  const held = new Set<string>(), released = new Set<string>(), revoked = new Set<string>(), opened: NativeHtmlRuntime[] = [], closed = new Set<NativeHtmlRuntime>();
  const preview: HtmlPreviewRuntime = { originFor: () => 'http://localhost:1', issue: () => { const id = randomUUID(); return { id, url: `http://localhost:1/${id}`, origin: 'http://localhost:1', expiresAt: new Date().toISOString() }; }, hold: id => { held.add(id); let active = true; return () => { if (active) released.add(id); active = false; }; }, revoke: id => { revoked.add(id); }, close: async () => {} };
  const manager = new ProjectHtmlSurfaces(service, preview, options), start = deferred(), open = deferred(), entered = deferred();
  t.mock.method(manager as any, 'start', async () => { await start.promise; (manager as any).origin = 'http://127.0.0.1:1'; });
  const openMock=t.mock.method(NativeHtmlRuntime.prototype, 'open', async function (this: NativeHtmlRuntime) { opened.push(this); entered.resolve(); await open.promise; });
  t.mock.method(NativeHtmlRuntime.prototype, 'directory', () => root);
  t.mock.method(NativeHtmlRuntime.prototype, 'close', async function (this: NativeHtmlRuntime) { closed.add(this); });
  const owner = { sessionId: session.id, documentId: randomUUID(), viewId: randomUUID(), viewGeneration: 1, objectId: object.id, assetId };
  const create = (viewId = owner.viewId) => manager.create({ ...owner, viewId }, { width: 100, height: 60 });
  t.after(async () => { start.resolve(); open.resolve(); await manager.close(); service.close(); await rm(root, { recursive: true, force: true }); });
  return { root, service, session, object, manager, owner, create, start, open, entered, opened, closed, held, released, revoked, openMock };
}

test('HTML startup admits parallel sources while opening entries reserve view and project capacity', async t => {
  const f = await fixture(t, { maxSurfaces: 3, maxSurfacesPerView: 2 }); f.start.resolve();
  const first = f.create(), second = f.create(), peer = f.create(randomUUID());
  await assert.rejects(f.create(), (error: any) => error.code === 'surface_limit');
  await f.entered.promise; await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal((f.manager as any).entries.size, 3); assert.equal((f.manager as any).creating.size, 3);
  // Each admitted native open is independently waiting, rather than waiting on a previous create.
  const deadline = Date.now() + 1000; while (f.opened.length < 3 && Date.now() < deadline) await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(f.opened.length, 3); f.open.resolve(); await Promise.all([first, second, peer]);
});

test('opening sources reserve the complete view quota', async t => {
  const f = await fixture(t, { maxSurfaces: 4, maxSurfacesPerView: 1 }); f.start.resolve();
  const held = f.create(); await assert.rejects(f.create(), (error: any) => error.code === 'surface_view_limit');
  f.open.resolve(); await held;
});

test('closing a view during shared startup cancels its admission and preserves another view', async t => {
  const f = await fixture(t), cancelled = f.create(), peer = f.create(randomUUID());
  const rejection = assert.rejects(cancelled, (error: any) => error.code === 'surface_closed');
  await f.manager.closeView(f.owner.viewId); f.start.resolve(); f.open.resolve(); await rejection; await peer;
  assert.equal(f.opened.length, 1); assert.equal(f.held.size, 1); assert.equal((f.manager as any).creating.size, 0);
});

test('admission rechecks the source object after shared startup', async t => {
  const f = await fixture(t), creating = f.create(), rejected = assert.rejects(creating, (error: any) => error.code === 'surface_object');
  f.service.boardOperations(f.session.id, [{ type: 'delete', objectId: f.object.id, expectedVersion: f.object.version }]);
  f.start.resolve(); await rejected; assert.equal(f.opened.length, 0); assert.equal(f.held.size, 0);
});

test('closing an admitted opening source reaps its runtime, releases its grant, and rejects its late return', async t => {
  const f = await fixture(t), creating = f.create(), rejected = assert.rejects(creating, (error: any) => error.code === 'surface_closed');
  f.start.resolve(); await f.entered.promise; await f.manager.closeView(f.owner.viewId);
  assert.equal(f.closed.size, 1); assert.equal(f.released.size, 1); assert.equal(f.revoked.size, 1);
  f.open.resolve(); await rejected; assert.equal(f.closed.size, 1); assert.equal(f.released.size, 1);
});

test('shutdown cancels pre-admission startup and drains its tracked creation promise', async t => {
  const f = await fixture(t), creating = f.create(), rejected = assert.rejects(creating, (error: any) => error.code === 'surface_stopped');
  let stopped = false; const shutdown = f.manager.close().then(() => { stopped = true; });
  await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(stopped, false);
  f.start.resolve(); await Promise.all([shutdown, rejected]); assert.equal(f.opened.length, 0); assert.equal(f.held.size, 0); assert.equal((f.manager as any).creating.size, 0);
});

test('native creation failure releases reserved project and retained capacity', async t => {
  const f = await fixture(t, { maxSurfaces: 1, maxRetainedSurfaces: 1 }); f.start.resolve();
  f.openMock.mock.mockImplementation(async () => { throw new Error('owned opening failure'); });
  await assert.rejects(f.create(), /owned opening failure/); assert.equal(f.released.size, 1); assert.equal(f.closed.size, 1);
  f.openMock.mock.mockImplementation(async function (this: NativeHtmlRuntime) { f.opened.push(this); });
  await f.create(); assert.equal((f.manager as any).entries.size, 1); assert.equal(f.held.size, 2);
});

test('native close during asynchronous preparation prevents process spawn and drains opening', { skip: process.platform !== 'darwin' || process.arch !== 'arm64', timeout: 3000 }, async t => {
  const root=await mkdtemp(join(tmpdir(),'acanvas-native-preparation-')),runtime=new NativeHtmlRuntime();t.after(async()=>{await runtime.close();await rm(root,{recursive:true,force:true})});
  const opening=runtime.open('http://127.0.0.1:1/',root,{width:100,height:60}),rejected=assert.rejects(opening,/native_surface_closed/),closing=runtime.close();
  assert.equal(runtime.close(),closing);await Promise.all([rejected,closing]);assert.equal((runtime as any).process,undefined);assert.deepEqual(await readdir(root),[]);
});

test('failed native preparation and repeated close complete without awaiting their own opening', { timeout: 3000 }, async t => {
  const runtime=new NativeHtmlRuntime();t.mock.method(runtime as any,'openNative',async()=>{throw new Error('owned preparation failure')});
  await assert.rejects(runtime.open('http://127.0.0.1:1/','/private/tmp',{width:100,height:60}),/owned preparation failure/);
  const closing=runtime.close();assert.equal(runtime.close(),closing);await closing;await assert.rejects(runtime.open('http://127.0.0.1:1/','/private/tmp',{width:100,height:60}),/native_surface_closed/);
});

test('native worker collection batches trusted layers and stops at foreign or reparented branches', async () => {
  const prefix='/owned/acanvas-surface Helper',calls:{file:string;args:string[]}[]=[];
  const query=async(file:string,args:string[])=>{
    calls.push({file,args});
    if(file==='/usr/bin/pgrep')return{stdout:args[1]==='100'?'101 102 103 -1 malformed':args[1]==='101'?'201 202':'100'};
    return{stdout:args[1]==='101,102,103'?`101 100 ${prefix} (Renderer)\n102 100 /foreign/helper\n103 999 ${prefix} (GPU)\n999 100 ${prefix}`:`201 101 ${prefix} (Utility)\n202 102 ${prefix}\n100 201 ${prefix}`};
  };
  assert.deepEqual(await collectNativeWorkerPids(100,prefix,query),[101,201]);
  assert.deepEqual(calls.filter(call=>call.file==='/usr/bin/pgrep').map(call=>call.args),[['-P','100'],['-P','101'],['-P','201']]);
  assert.deepEqual(calls.filter(call=>call.file==='/bin/ps').map(call=>call.args),[['-p','101,102,103','-o','pid=,ppid=,command='],['-p','201,202','-o','pid=,ppid=,command='],['-p','100','-o','pid=,ppid=,command=']]);
});

test('native worker collection preserves valid partial ps output when a requested sibling exits', async () => {
  const prefix='/owned/acanvas-surface Helper';
  const query=async(file:string,args:string[])=>{
    if(file==='/usr/bin/pgrep')return{stdout:args[1]==='100'?'101 102':''};
    throw Object.assign(new Error('one requested process exited'),{stdout:`101 100 ${prefix} (Renderer)\n`});
  };
  assert.deepEqual(await collectNativeWorkerPids(100,prefix,query),[101]);
});

test('native worker collection finishes without querying commands after an empty child layer', async () => {
  const calls:string[]=[];
  const query=async(file:string)=>{calls.push(file);return{stdout:''}};
  assert.deepEqual(await collectNativeWorkerPids(100,'/owned/helper',query),[]);
  assert.deepEqual(calls,['/usr/bin/pgrep']);
});
