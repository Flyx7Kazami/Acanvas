import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,writeFile,rm,stat,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {CanvasService} from '../src/server/service.js';
import {startHtmlPreview} from '../src/server/html-preview.js';
import {ProjectHtmlSurfaces,type HtmlSurfaceInput} from '../src/server/render-surface/html.js';
import type {NativeHtmlRuntime} from '../src/server/render-surface/cef.js';

const enabled=process.env.ACANVAS_HTML_NATIVE_TESTS==='1';
type InputAction<T=HtmlSurfaceInput>=T extends unknown?Omit<T,'instanceId'|'inputSeq'|'viewport'|'frameSeq'>:never;
const source=`<!doctype html><style>body{margin:0;font:13px sans-serif}input,select,textarea,button{display:block;width:170px;margin:2px;height:22px}h1,p{margin:0}#edit{height:24px}#anim{position:absolute;left:300px;top:20px;width:60px;height:60px;background:#a76}</style><h1>Document heading</h1><p>Visible text <a id="link" href="javascript:window.linkClicks++">Link</a></p><input id="field"><input id="secret" type="password"><textarea id="area"></textarea><div id="edit" contenteditable="true">Editable</div><select id="options"><option value="a">A</option><option value="b">B</option></select><input id="date" type="date"><input id="color" type="color" value="#123456"><input id="files" type="file"><button id="tone">Tone</button><div id="anim"></div><script>window.events=[];window.linkClicks=0;document.querySelector('#link').addEventListener('click',e=>{window.linkClicks++;window.linkTrusted=e.isTrusted;e.preventDefault()});window.ticks=0;for(const type of ['keydown','keyup','beforeinput','input','change','compositionstart','compositionupdate','compositionend'])document.addEventListener(type,e=>{window.events.push({id:e.target.id,type,key:e.key,data:e.data,trusted:e.isTrusted});if(type==='keydown'&&e.key==='q')e.preventDefault()},true);function tick(){window.ticks++;document.querySelector('#anim').style.transform='translateX('+(window.ticks%90)+'px)';requestAnimationFrame(tick)}tick();document.querySelector('#tone').onclick=()=>{const a=new AudioContext(),o=a.createOscillator(),g=a.createGain();o.frequency.value=440;g.gain.value=.25;o.connect(g).connect(a.destination);o.start();a.resume()}</script>`;
async function fixture(t:test.TestContext){
  const root=await mkdtemp(join(tmpdir(),'acanvas-native-matrix-')),service=new CanvasService(root),session=service.createSession('Native surface'),preview=await startHtmlPreview(service),manager=new ProjectHtmlSurfaces(service,preview);
  const id=randomUUID(),bytes=Buffer.from(source),path=`assets/${id}.html`;await writeFile(join(service.dataDir,path),bytes);service.registerAsset({id,name:'native.html',mime:'text/html',size:bytes.length,kind:'file',createdAt:new Date().toISOString()},path);const object=service.boardOperations(session.id,[{type:'create',object:{assetId:id,x:0,y:0,width:480,height:430}}]).objects[0];
  t.after(async()=>{await manager.close();await preview.close();service.close();await rm(root,{recursive:true,force:true})});
  const create=()=>manager.create({sessionId:session.id,viewId:randomUUID(),documentId:randomUUID(),viewGeneration:1,objectId:object.id,assetId:id},{width:480,height:430});
  const info=await create();let frame=await manager.sample(info.surfaceId),inputSeq=0;
  const runtime=(manager as any).entries.get(info.surfaceId).native as NativeHtmlRuntime;
  const send=async(action:InputAction)=>manager.input(info.surfaceId,{...action,instanceId:info.instanceId,inputSeq:++inputSeq,viewport:info.viewport,frameSeq:frame.frameSeq} as HtmlSurfaceInput);
  const sample=async()=>{frame=await manager.sample(info.surfaceId);return frame};
  return{root,manager,info,runtime,send,sample,create};
}
test('production native HTML keeps trusted character cancellation, controls and immutable displayed pixels',{skip:!enabled},async t=>{
  const f=await fixture(t);assert.equal(f.info.engine,'cef');
  const flags=await f.runtime.protocol('Browser.getBrowserCommandLine');assert(flags.arguments.includes('--headless=new'));assert(!flags.arguments.includes('--no-sandbox'));assert.equal((await f.runtime.protocol('Surface.instrumentation')).clipboardTripwire,false);
  await f.send({type:'focus',controlId:'#field'});await f.send({type:'key',action:'press',key:'KeyQ',character:'q'});await f.send({type:'key',action:'press',key:'KeyB',character:'b'});
  assert.equal(await f.runtime.documentEvaluate('document.querySelector("#field").value'),'b');
  const ordinary=await f.runtime.documentEvaluate('window.events',false);assert(ordinary.some((e:any)=>e.type==='keydown'&&e.key==='q'&&e.trusted));assert(ordinary.some((e:any)=>e.type==='keyup'&&e.key==='q'&&e.trusted));assert.equal(ordinary.filter((e:any)=>e.type==='beforeinput'&&e.data==='b'&&e.trusted).length,1);assert(!ordinary.some((e:any)=>e.type==='beforeinput'&&e.data==='q'));
  await f.send({type:'focus',controlId:'#secret'});for(const key of ['KeyA','KeyB','KeyC'])await f.send({type:'key',action:'press',key});await f.send({type:'key',action:'press',key:'ArrowLeft'});await f.send({type:'key',action:'press',key:'KeyD'});
  assert.equal(await f.runtime.documentEvaluate('document.querySelector("#secret").value'),'abdc');const secretFrame=await f.sample();assert.equal(secretFrame.semantics.controls.find(control=>control.id==='#secret')?.value,undefined);assert(!JSON.stringify(secretFrame.semantics).includes('abdc'));
  await f.send({type:'focus',controlId:'#edit'});await f.send({type:'text-selection',controlId:'#edit',start:0,end:8});await f.send({type:'composition',action:'update',text:'に',selectionStart:1,selectionEnd:1});await f.send({type:'composition',action:'update',text:'日本',selectionStart:2,selectionEnd:2});await f.send({type:'composition',action:'commit',text:'日本'});
  assert.equal(await f.runtime.documentEvaluate('document.querySelector("#edit").textContent'),'日本');let ime:any[]=[],deadline=Date.now()+1000;do{ime=await f.runtime.documentEvaluate('window.events.filter(e=>e.id==="edit"&&e.type.startsWith("composition"))',false);if(ime.some((e:any)=>e.type==='compositionend'))break;await new Promise(resolve=>setTimeout(resolve,5))}while(Date.now()<deadline);for(const type of ['compositionstart','compositionupdate'])assert(ime.some((e:any)=>e.type===type&&e.trusted),`${type}: ${JSON.stringify(ime)}`);assert(ime.some((e:any)=>e.type==='compositionend'&&e.trusted===false&&e.data==='日本'));
  for(const [controlId,value] of [['#options','b'],['#date','2027-01-02'],['#color','#abcdef']])await f.send({type:'control',controlId,value});
  const values=await f.runtime.documentEvaluate('Object.fromEntries(["options","date","color"].map(id=>[id,document.getElementById(id).value]))');assert.deepEqual(values,{options:'b',date:'2027-01-02',color:'#abcdef'});
  const valueEvents=await f.runtime.documentEvaluate('window.events.filter(e=>["options","date","color"].includes(e.id)&&e.type==="change")',false);assert(valueEvents.every((e:any)=>e.trusted===false));
  await f.send({type:'files',controlId:'#files',files:[{name:'chosen.txt',mime:'text/plain',bytesBase64:Buffer.from('Owned chosen bytes 世界').toString('base64'),lastModified:1_700_000_000_123}]});assert.equal(await f.runtime.documentEvaluate('document.querySelector("#files").files[0].text()'),'Owned chosen bytes 世界');
  const fileEvents=await f.runtime.documentEvaluate('window.events.filter(e=>e.id==="files"&&e.type==="change")',false);assert(fileEvents.some((e:any)=>e.trusted));
  const presented=await f.sample();f.manager.retainSurface(presented.owner,presented);for(let i=0;i<5;i++)await f.sample();assert.equal(f.manager.frame(f.info.surfaceId,presented.frameSeq).png.equals(presented.png),true);
  const link=presented.semantics.controls.find(control=>control.id==='#link')!;await f.send({type:'pointer',action:'click',x:link.bounds.x+link.bounds.width/2,y:link.bounds.y+link.bounds.height/2});assert.equal(await f.runtime.documentEvaluate('window.linkClicks',false),1);assert.equal(await f.runtime.documentEvaluate('self.origin'),'null');
  assert(presented.semantics.readingOrder.some(item=>item.role==='heading'&&item.text==='Document heading'));f.manager.releaseSurface(presented.owner,presented);
});
test('production native surface closes, force-exits and starts with fresh private profiles',{skip:!enabled},async t=>{
  const f=await fixture(t),first=f.runtime.directory();assert.equal((await stat(first)).mode&0o777,0o700);await f.runtime.protocol('Network.setCookie',{name:'fixture-cookie',value:'owned-cookie',url:'http://127.0.0.1/'});
  await f.manager.closeSurface(f.info.surfaceId);await assert.rejects(stat(first),{code:'ENOENT'});
  const next=await f.create(),runtime=(f.manager as any).entries.get(next.surfaceId).native as NativeHtmlRuntime,second=runtime.directory();assert.notEqual(first,second);assert(!(await runtime.protocol('Network.getCookies',{urls:['http://127.0.0.1/']})).cookies.some((cookie:any)=>cookie.name==='fixture-cookie'));
  const closed=new Promise<void>(resolve=>runtime.once('closed',()=>resolve()));(runtime as any).process.kill('SIGKILL');await closed;await runtime.close();await assert.rejects(stat(second),{code:'ENOENT'});
  const final=await f.create();assert.notEqual(final.instanceId,next.instanceId);assert((await f.manager.sample(final.surfaceId)).png.length>100);await f.manager.closeSurface(final.surfaceId);
  const directories=await readdir(join(f.root,'.acanvas','runtime','html-surfaces'));assert.equal(directories.length,0);
});
