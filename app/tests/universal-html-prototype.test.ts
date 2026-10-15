import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AddressInfo } from 'node:net';
import { CanvasService } from '../src/server/service.js';
import { startHtmlPreview } from '../src/server/html-preview.js';
import { ProjectHtmlSurfaces, type HtmlSurfaceInfo, type HtmlSurfaceInput, type HtmlSurfaceFrame } from '../src/server/render-surface/html.js';
import { launchRenderEngine, renderEngineInfo } from '../src/server/render-surface/engine.js';

const execute = promisify(execFile);
const enabled = process.env.ACANVAS_HTML_SURFACE_TESTS === '1';
const fixtureHtml = `<!doctype html><style>body{margin:0;background:#152a39;color:white;font:16px sans-serif}#field{position:absolute;left:16px;top:12px;width:180px;height:26px}#button{position:absolute;left:212px;top:12px;width:80px;height:30px}canvas{position:absolute;top:60px}#random{left:16px}#gl{left:200px}#scroll{position:absolute;left:320px;top:12px;width:120px;height:210px;overflow:auto;background:#40546a}#inside{height:1100px;background:linear-gradient(#ffc94a,#673eac)}#moving{position:absolute;top:210px;left:16px;width:240px;height:20px;background:#ea693b}</style><input id="field" value="initial"><button id="button">Strike</button><canvas id="random" width="160" height="120"></canvas><canvas id="gl" width="100" height="120"></canvas><div id="scroll"><div id="inside"></div></div><div id="moving"></div><script>
const state=window.fixtureState={seed:Math.random(),ticks:0,clicks:0,inputs:[],wheel:0};
document.querySelector('#field').addEventListener('input',e=>state.inputs.push({value:e.target.value,trusted:e.isTrusted}));
document.querySelector('#button').addEventListener('click',e=>{state.clicks++;state.clickTrusted=e.isTrusted});
document.querySelector('#scroll').addEventListener('wheel',e=>state.wheel++);
const g=document.querySelector('#random').getContext('2d');g.fillStyle='rgb('+Math.floor(70+state.seed*150)+',180,60)';g.fillRect(0,0,160,120);g.fillStyle='#ffcf52';g.fillRect(20,20,60,40);
const gl=document.querySelector('#gl').getContext('webgl');state.webgl=!!gl;state.preserveDrawingBuffer=gl?.getContextAttributes().preserveDrawingBuffer;
function draw(){state.ticks++;if(gl){gl.clearColor(.12,(state.ticks%60)/60,.65,1);gl.clear(gl.COLOR_BUFFER_BIT)}document.querySelector('#moving').style.transform='translateX('+(state.ticks%120)+'px)';requestAnimationFrame(draw)}draw();
window.securityState={};for(const key of ['parent','storage','cookie']){try{if(key==='parent')parent.document.body.innerHTML='escaped';if(key==='storage')localStorage.setItem('escape','yes');if(key==='cookie')document.cookie='escape=yes';window.securityState[key]='allowed'}catch(e){window.securityState[key]=e.name}}
</script>`;

async function fixture(t: test.TestContext, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'acanvas-html-surface-'));
  const service = new CanvasService(root), session = service.createSession('HTML surface prototype');
  const preview = await startHtmlPreview(service), manager = new ProjectHtmlSurfaces(service, preview, {engine:'chromium',...options});
  const id = randomUUID(), bytes = Buffer.from(fixtureHtml), path = `assets/${id}.html`;
  await writeFile(join(service.dataDir, path), bytes);
  const asset = service.registerAsset({ id, name: 'interactive.html', mime: 'text/html', size: bytes.length, kind: 'file', createdAt: new Date().toISOString() }, path);
  const object = service.boardOperations(session.id, [{ type: 'create', object: { assetId: asset.id, x: 0, y: 0, width: 480, height: 260 } }]).objects[0];
  t.after(async () => { await manager.close(); await preview.close(); service.close(); await rm(root, { recursive: true, force: true }); });
  return { service, session, asset, object, manager, create: (viewId: string = randomUUID(), deviceScaleFactor = 1) => manager.create({ sessionId: session.id, viewId, documentId: `document-${viewId}`, viewGeneration: 1, objectId: object.id, assetId: asset.id }, { width: 480, height: 260, deviceScaleFactor }) };
}
const internalPage = (manager: ProjectHtmlSurfaces, info: HtmlSurfaceInfo) => (manager as any).entries.get(info.surfaceId).page as import('playwright-core').Page;
const originalFrame = (manager: ProjectHtmlSurfaces, info: HtmlSurfaceInfo) => internalPage(manager, info).frames().find(frame => frame.parentFrame())!;
async function frontApplication() { return process.platform === 'darwin' ? (await execute('/usr/bin/lsappinfo', ['front'])).stdout.trim() : 'unmeasured'; }
async function pixels(page: import('playwright-core').Page, png: Buffer) {
  return page.evaluate(async base64 => { const image = new Image(); image.src = `data:image/png;base64,${base64}`; await image.decode(); const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height; const context = canvas.getContext('2d')!; context.drawImage(image, 0, 0); return [...context.getImageData(0, 0, canvas.width, canvas.height).data]; }, png.toString('base64'));
}

test('headless isolated persistent HTML delivers immutable pixels to an ordinary client and accepts trusted input', { skip: !enabled }, async t => {
  const frontBefore = await frontApplication(), f = await fixture(t), info = await f.create(), original = originalFrame(f.manager, info);
  const clientServer = createServer((_request, response) => { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><style>body{margin:0}</style><canvas id="surface" width="480" height="260" tabindex="0"></canvas>'); });
  await new Promise<void>(resolve => clientServer.listen(0, '127.0.0.1', resolve));
  const clientBrowser = await launchRenderEngine(), client = await clientBrowser.newPage({ viewport: { width: 480, height: 260 } });
  t.after(async () => { await clientBrowser.close(); await new Promise<void>(resolve => { clientServer.close(() => resolve()); clientServer.closeAllConnections(); }); });
  await client.goto(`http://127.0.0.1:${(clientServer.address() as AddressInfo).port}`);
  const errors: string[] = []; client.on('pageerror', error => errors.push(error.message));
  let inputSeq = 0;
  await client.exposeBinding('sendSurfaceInput', (_source, event: any) => f.manager.input(info.surfaceId, { ...event, instanceId: info.instanceId, inputSeq: ++inputSeq, viewport: info.viewport }));
  await client.evaluate(() => { const canvas = document.querySelector('canvas')!; const w = window as any; w.inputJobs=[]; canvas.addEventListener('click',event=>{canvas.focus();w.inputJobs.push(w.sendSurfaceInput({type:'pointer',action:'click',x:event.offsetX,y:event.offsetY}))}); canvas.addEventListener('wheel',event=>{event.preventDefault();w.inputJobs.push(w.sendSurfaceInput({type:'wheel',x:event.offsetX,y:event.offsetY,deltaX:event.deltaX,deltaY:event.deltaY}))},{passive:false}); canvas.addEventListener('keydown',event=>{event.preventDefault();w.inputJobs.push(w.sendSurfaceInput({type:'key',action:'press',key:event.key}))}); w.commitText=(text: string)=>w.inputJobs.push(w.sendSurfaceInput({type:'text',text})); });
  await client.mouse.click(35, 25); await client.evaluate(() => Promise.all((window as any).inputJobs));
  await client.evaluate(() => (window as any).commitText('持续输入🌊')); await client.evaluate(() => Promise.all((window as any).inputJobs));
  await client.mouse.click(245, 25); await client.evaluate(() => Promise.all((window as any).inputJobs));
  await client.mouse.move(370, 95); await client.mouse.wheel(0, 180); await client.evaluate(() => Promise.all((window as any).inputJobs));
  await original.waitForFunction(() => document.querySelector('#scroll')!.scrollTop > 0);
  const stateBefore = await original.evaluate(() => ({ ...(window as any).fixtureState, value: (document.querySelector('#field') as HTMLInputElement).value, scroll: document.querySelector('#scroll')!.scrollTop, origin: self.origin, security: (window as any).securityState }));
  assert(stateBefore.value.includes('持续输入🌊')); assert.equal(stateBefore.clicks, 1); assert(stateBefore.clickTrusted); assert(stateBefore.inputs.every((event: any) => event.trusted)); assert(stateBefore.scroll > 0);
  assert.equal(stateBefore.webgl, true); assert.equal(stateBefore.preserveDrawingBuffer, false); assert.equal(stateBefore.origin, 'null'); assert.deepEqual(stateBefore.security, { parent: 'SecurityError', storage: 'SecurityError', cookie: 'SecurityError' });
  const displayed = await f.manager.sample(info.surfaceId);
  await client.evaluate(async ({ png, frame }) => { const image = new Image(); image.src=`data:image/png;base64,${png}`; await image.decode(); const canvas=document.querySelector('canvas')!, context=canvas.getContext('2d')!; context.drawImage(image,0,0); (window as any).presentedFrame=frame; }, { png: displayed.png.toString('base64'), frame: { ...displayed, png: undefined } });
  const displayedPixels = await client.evaluate(() => [...document.querySelector('canvas')!.getContext('2d')!.getImageData(0,0,480,260).data]);
  const latest: HtmlSurfaceFrame[] = [];
  for (let i = 0; i < 5; i++) latest.push(await f.manager.sample(info.surfaceId));
  assert.equal(latest.at(-1)!.frameSeq, displayed.frameSeq + 5); assert(latest.some(frame => !frame.png.equals(displayed.png)));
  const saved = await client.evaluate(async () => { const original=document.querySelector('canvas')!, evidence=document.createElement('canvas'); evidence.width=original.width;evidence.height=original.height;evidence.getContext('2d')!.drawImage(original,0,0); const blob=await new Promise<Blob>(resolve=>evidence.toBlob(blob=>resolve(blob!),'image/png'));return {png:[...new Uint8Array(await blob.arrayBuffer())],frame:(window as any).presentedFrame}; });
  assert.deepEqual(await pixels(client, Buffer.from(saved.png)), displayedPixels);
  assert.deepEqual(await pixels(client, displayed.png), displayedPixels);
  assert.equal(saved.frame.frameSeq, displayed.frameSeq); assert.equal(saved.frame.inputSeq, inputSeq);
  const untouched = Buffer.from(displayed.png); displayed.png.fill(0); displayed.viewport.width=1;
  assert.deepEqual(f.manager.frame(info.surfaceId, displayed.frameSeq).png, untouched);
  const stateAfter = await original.evaluate(() => ({ ...(window as any).fixtureState, value:(document.querySelector('#field') as HTMLInputElement).value,scroll:document.querySelector('#scroll')!.scrollTop }));
  assert.equal(stateAfter.seed, stateBefore.seed); assert(stateAfter.ticks > stateBefore.ticks); assert.equal(stateAfter.value, stateBefore.value); assert.equal(stateAfter.scroll, stateBefore.scroll);
  const glPixels = displayedPixels.slice((90 * 480 + 230) * 4, (90 * 480 + 230) * 4 + 4); assert(glPixels[2] > 130, `default-buffer WebGL pixel: ${glPixels}`);
  const cdp = await internalPage(f.manager, info).context().newCDPSession(internalPage(f.manager, info));
  const browserCommand = await cdp.send('Browser.getBrowserCommandLine');
  assert(browserCommand.arguments.some((arg: string) => arg.startsWith('--headless'))); assert(browserCommand.arguments.includes('--mute-audio')); assert(!browserCommand.arguments.includes('--no-sandbox'));
  const frontAfter = await frontApplication(); assert.equal(frontAfter, frontBefore); assert.deepEqual(errors, []);
  const evidencePath = process.env.ACANVAS_HTML_SURFACE_EVIDENCE;
  if (evidencePath) {
    await mkdir(resolve(evidencePath, '..'), { recursive: true });
    await writeFile(evidencePath, JSON.stringify({ measuredAt:new Date().toISOString(), status:'visual-prototype-passed',engine:await renderEngineInfo().then(({executablePath,directory,...info})=>info),isolation:{opaqueOrigin:stateBefore.origin,sandbox:'allow-scripts',parentAccess:stateBefore.security.parent,storageAccess:stateBefore.security.storage,cookieAccess:stateBefore.security.cookie,chromiumSandbox:true},inputs:{pointerTrusted:stateBefore.clickTrusted,textTrusted:stateBefore.inputs.every((event:any)=>event.trusted),scrollPixels:stateBefore.scroll,processedInputSeq:inputSeq},frames:{displayedFrame:1,latestFrame:latest.at(-1)!.frameSeq,evidenceFrame:saved.frame.frameSeq,actualPixelEquality:true,formRetained:true,randomCanvasInstanceRetained:stateAfter.seed===stateBefore.seed,webglDefaultPreserveDrawingBuffer:stateBefore.preserveDrawingBuffer,webglPixel:[...glPixels],animationAdvanced:stateAfter.ticks>stateBefore.ticks},window:{headlessArgument:true,foregroundAppStable:frontAfter===frontBefore,bringToFrontCalls:0},limitations:['client measured in project Chromium; other client engines and actual in-app browser are separate acceptance','HTML audio PCM output, IME, native widgets, file selection, text selection and accessibility remain P2','visual frames use PNG snapshots; throughput and audio/video synchronization require P2 measurement']}, null, 2)+'\n');
  }
});

test('surface references enforce owner and frame identity across views and preserve old viewport frames', { skip: !enabled }, async t => {
  const f = await fixture(t), a = await f.create('view-a', 2), b = await f.create('view-b');
  const frame = await f.manager.sample(a.surfaceId); assert.deepEqual(frame.bitmap, { width: 960, height: 520 });
  f.manager.validateSurface(frame.owner, frame);
  for (const owner of [{...frame.owner,viewId:b.viewId},{...frame.owner,sessionId:randomUUID()},{...frame.owner,projectId:randomUUID()},{...frame.owner,objectId:randomUUID()},{...frame.owner,assetId:randomUUID()}]) assert.throws(()=>f.manager.validateSurface(owner,frame),/Use the HTML frame/);
  assert.throws(()=>f.manager.validateSurface(frame.owner,{...frame,instanceId:b.instanceId}),/Use the HTML frame/);
  assert.throws(()=>f.manager.validateSurface(frame.owner,{...frame,inputSeq:1}),/Use the HTML frame/);
  const input = { type:'pointer',action:'click',x:245,y:25,instanceId:a.instanceId,inputSeq:1,viewport:a.viewport } as HtmlSurfaceInput;
  await f.manager.input(a.surfaceId,input); await assert.rejects(f.manager.input(a.surfaceId,input),/next input/);
  assert.equal(await originalFrame(f.manager,b).evaluate(()=>(window as any).fixtureState.clicks),0);
  await f.manager.resize(a.surfaceId,{width:400,height:240});
  await assert.rejects(f.manager.input(a.surfaceId,{...input,inputSeq:2}),/next input/);
  f.manager.validateSurface(frame.owner,frame); assert.deepEqual(f.manager.frame(a.surfaceId,frame.frameSeq).bitmap,frame.bitmap);
  await f.manager.closeView(a.viewId); assert.deepEqual(f.manager.frame(a.surfaceId,frame.frameSeq).png,frame.png); await assert.rejects(async()=>f.manager.sample(a.surfaceId),/Reconnect/);
  assert.equal((await f.manager.sample(b.surfaceId)).frameSeq,1);
});

test('bounded frame retention and typed input reject oversized or unsupported requests', { skip: !enabled }, async t => {
  const f = await fixture(t,{maxSurfaces:1,maxFrames:2}),info=await f.create();
  await assert.rejects(f.create('second'),/Close an HTML surface/);
  for(let i=0;i<3;i++) await f.manager.sample(info.surfaceId);
  assert.throws(()=>f.manager.frame(info.surfaceId,1),/Keep the displayed HTML pixels/);assert.equal(f.manager.frame(info.surfaceId,2).frameSeq,2);
  await assert.rejects(f.manager.input(info.surfaceId,{instanceId:info.instanceId,inputSeq:1,viewport:info.viewport,type:'text',text:'a'.repeat(65_537)}),/supported text/);
  await assert.rejects(f.manager.input(info.surfaceId,{instanceId:info.instanceId,inputSeq:1,viewport:info.viewport,type:'pointer',action:'click',x:-1,y:0}),/point within/);
  await assert.rejects(async()=>f.manager.resize(info.surfaceId,{width:5000,height:2}),/supported pixel/);
  const shown=f.manager.frame(info.surfaceId,2);f.manager.retainSurface(shown.owner,shown);
  for(let i=0;i<20;i++)await f.manager.sample(info.surfaceId);
  f.manager.validateSurface(shown.owner,shown);assert.deepEqual(f.manager.frame(info.surfaceId,2).png,shown.png);
  f.manager.releaseSurface(shown.owner,shown);assert.throws(()=>f.manager.frame(info.surfaceId,2),/Keep the displayed HTML pixels/);
});

test('renderer reconnects after owned browser exit and bounds closed surface retention', { skip: !enabled }, async t => {
  const f=await fixture(t,{maxSurfaces:1,maxRetainedSurfaces:2,maxFrames:1});
  const a=await f.create('view-a'),shown=await f.manager.sample(a.surfaceId);f.manager.retainSurface(shown.owner,shown);
  await f.manager.closeSurface(a.surfaceId);
  const b=await f.create('view-b');await f.manager.sample(b.surfaceId);await f.manager.closeSurface(b.surfaceId);
  const c=await f.create('view-c');assert.throws(()=>f.manager.frame(b.surfaceId,1),/Reconnect/);f.manager.validateSurface(shown.owner,shown);
  await (f.manager as any).browser.close();
  const d=await f.create('view-d');assert.notEqual(d.instanceId,c.instanceId);assert.equal((await f.manager.sample(d.surfaceId)).frameSeq,1);
  f.manager.releaseSurface(shown.owner,shown);await f.manager.closeSurface(d.surfaceId);
  await f.create('view-e');assert.throws(()=>f.manager.frame(a.surfaceId,shown.frameSeq),/Reconnect/);
});

test('frame semantics retain displayed form state, ordered text and password privacy', {skip:!enabled},async t=>{
  const f=await fixture(t),info=await f.create(),source=originalFrame(f.manager,info);
  await source.evaluate(()=>{document.body.innerHTML='<h1>Heading</h1><p>Visible paragraph <a id="link" href="javascript:void(0)">Link label</a></p><label>Secret<input id="own-password" type="password" value="OWNED_FIXTURE_SECRET"></label><input id="displayed" value="frame N"><select id="options" multiple><option selected value="a">A</option><option value="b">B</option></select>';document.querySelector('style')!.textContent='body{margin:0;font:14px sans-serif}h1{margin:0;font-size:18px}p{margin:0}input,select{display:block;height:22px;width:120px}';});
  const displayed=await f.manager.sample(info.surfaceId);
  assert.equal(displayed.semantics.controls.find(control=>control.id==='#own-password')?.value,undefined);
  assert(!JSON.stringify(displayed.semantics).includes('OWNED_FIXTURE_SECRET'));
  assert.deepEqual(displayed.semantics.readingOrder.slice(0,3).map(item=>[item.role,item.text]),[['heading','Heading'],['text','Visible paragraph'],['link','Link label']]);
  assert.equal(displayed.semantics.controls.find(control=>control.id==='#options')?.options?.[0].selected,true);
  await source.evaluate(()=>{(document.querySelector('#displayed') as HTMLInputElement).value='latest state';});
  const latest=await f.manager.sample(info.surfaceId);
  assert.equal(latest.semantics.controls.find(control=>control.id==='#displayed')?.value,'latest state');
  assert.equal(f.manager.frame(info.surfaceId,displayed.frameSeq).semantics.controls.find(control=>control.id==='#displayed')?.value,'frame N');
  displayed.semantics.controls.length=0;assert(f.manager.frame(info.surfaceId,displayed.frameSeq).semantics.controls.length>0);
  await assert.rejects(f.manager.input(info.surfaceId,{type:'focus',controlId:'#unpublished',instanceId:info.instanceId,inputSeq:1,viewport:info.viewport,frameSeq:latest.frameSeq}),/control from the displayed/);
});
