import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const repo=resolve(process.env.ACANVAS_PERFORMANCE_BUILD_ROOT||process.cwd());
const {startServer}=await import(pathToFileURL(join(repo,'dist/src/server/http.js')));
const {chromium}=await import(pathToFileURL(join(repo,'node_modules/playwright-core/index.mjs')));
const output=process.env.PERF_OUTPUT || await mkdtemp('/private/tmp/acanvas-dom-perf-output-');
await mkdir(output,{recursive:true});
const results=[];
const browser=await chromium.launch({channel:'chrome',headless:true});
try {
const scenarios=(process.env.PERF_ANNOTATIONS||'0,5,15').split(',').map(Number).map(annotations=>({annotations,activeMedia:false}));
if(process.env.PERF_MEDIA!=='0')scenarios.push({annotations:5,activeMedia:true});
for(const {annotations,activeMedia} of scenarios) {
const root=await mkdtemp('/private/tmp/acanvas-dom-perf-project-');
const server=await startServer({root,port:0,webRoot:process.env.PERF_WEB_ROOT||join(repo,'dist/web')});
const context=await browser.newContext({viewport:{width:1440,height:1000},deviceScaleFactor:2});
const page=await context.newPage();
const errors=[];page.on('pageerror',error=>errors.push(error.message));
try {
const token=(await (await fetch(server.url+'/api/bootstrap')).json()).token;
const call=async(path,method='GET',body)=>{const response=await fetch(server.url+path,{method,headers:{Authorization:'Bearer '+token,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});const v=await response.json();assert(response.ok,JSON.stringify(v));return v;};
const upload=async(name,mime,body)=>{const response=await fetch(server.url+'/api/assets?name='+encodeURIComponent(name)+'&mime='+encodeURIComponent(mime),{method:'POST',headers:{Authorization:'Bearer '+token},body});const v=await response.json();assert(response.ok,JSON.stringify(v));return v;};
const session=await call('/api/sessions','POST',{name:'Isolated DOM performance'});
const assets=[];const count=Number(process.env.PERF_OBJECTS||12);
for(let i=0;i<count;i++)assets.push(activeMedia&&i===count-2?await upload('Video.mp4','video/mp4',await readFile(join(repo,'tests/fixtures/frontend-video.mp4'))):await upload('Image '+i+'.svg','image/svg+xml','<svg xmlns="http://www.w3.org/2000/svg" width="250" height="140"><rect width="250" height="140" fill="#aac4df"/><circle cx="120" cy="70" r="45" fill="#456477"/></svg>'));
const fixture=assets.map((asset,i)=>({id:'perf-object-'+String(i).padStart(2,'0'),assetId:asset.id,assetName:asset.name,fixturePosition:{x:70+(i%4)*320,y:100+Math.floor(i/4)*245,width:250,height:160}}));
for(const entry of fixture){await call('/api/board/operations','POST',{sessionId:session.id,operations:[{type:'create',object:{id:entry.id,assetId:entry.assetId,...entry.fixturePosition}}]});await new Promise(resolve=>setTimeout(resolve,2));}
let state=await call('/api/state?sessionId='+session.id);
assert.deepEqual(state.objects.map(object=>object.id),fixture.map(entry=>entry.id));
for(const entry of fixture){const object=state.objects.find(object=>object.id===entry.id);for(const key of ['x','y','width','height'])assert.equal(object[key],entry.fixturePosition[key]);}
const targetId=fixture[0].id,target=page.locator('[data-object-id="'+targetId+'"]');
assert.equal(fixture[0].assetName,'Image 0.svg');assert.deepEqual(fixture[0].fixturePosition,{x:70,y:100,width:250,height:160});
await call('/api/sessions/'+session.id+'/draft','PUT',{...state.draft,annotations:Array.from({length:annotations},(_,i)=>({id:crypto.randomUUID(),scope:'region',objectIds:[],bounds:{x:120+(i%5)*220,y:160+Math.floor(i/5)*140,width:i%2?80:0,height:i%2?50:0},coordinateSpace:'world',geometry:i%2?'rect':'point',text:'Comment '+(i+1)+' measured label',captureState:{version:1,status:'incomplete'}}))});
await page.addInitScript(()=>{
  const perf=window.domPerf={phase:'warmup',phases:{},pending:[],seq:0,longTasks:[]};
  const sample=()=>perf.phases[perf.phase]??={bounds:0,boundsMs:0,computed:0,computedMs:0,observers:0,observerCallbacks:0,mutations:0,frames:[],longTasks:[],latencies:[],starts:{},inputCount:0,supersededInputs:0,matchedInputs:0};
  const enqueue=expected=>{const event={at:performance.now(),seq:++perf.seq,...expected};sample().inputCount++;sample().lastInput=event;perf.pending.push(event)};
  const pose=()=>{const world=document.querySelector('.canvas-world'),matrix=new DOMMatrix(world?.style.transform);return{x:matrix.e,y:matrix.f,zoom:matrix.a}};
  const matches=event=>{if(!event)return false;const camera=pose(),object=event.objectId&&document.querySelector('[data-object-id="'+event.objectId+'"]');return event.objectId?Math.abs(parseFloat(object?.style.left)-event.objectX)<.01&&Math.abs(parseFloat(object?.style.top)-event.objectY)<.01:Math.abs(camera.x-event.x)<.01&&Math.abs(camera.y-event.y)<.01&&Math.abs(camera.zoom-event.zoom)<.0001};
  perf.snapshot=()=>({camera:pose(),pendingInputs:perf.pending.length,lastInputMatched:matches(sample().lastInput),objects:Array.from(document.querySelectorAll('.board-object')).map(object=>({id:object.dataset.objectId,x:parseFloat(object.style.left),y:parseFloat(object.style.top),width:parseFloat(object.style.width),height:parseFloat(object.style.height)}))});
  const originalBounds=Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect=function(...args){const s=sample(),start=performance.now();try{return originalBounds.apply(this,args)}finally{s.bounds++;s.boundsMs+=performance.now()-start; if(perf.stackSampling){const line=new Error().stack?.split('\n').slice(2,5).join('\n')||'';s.starts[line]=(s.starts[line]||0)+1;}}};
  const computed=window.getComputedStyle;window.getComputedStyle=function(...args){const s=sample(),start=performance.now();try{return computed.apply(this,args)}finally{s.computed++;s.computedMs+=performance.now()-start;}};
  const Observer=ResizeObserver;window.ResizeObserver=class extends Observer{constructor(callback){sample().observers++;super((...args)=>{sample().observerCallbacks++;callback(...args)});}};
  new MutationObserver(entries=>{sample().mutations+=entries.length}).observe(document,{subtree:true,attributes:true,attributeFilter:['style']});
  new PerformanceObserver(list=>{perf.longTasks.push(...list.getEntries().map(entry=>({at:entry.startTime,duration:entry.duration})))}).observe({type:'longtask',buffered:false});
  let prev=performance.now();const tick=at=>{const s=sample();s.frames.push(at-prev);prev=at;const matched=perf.pending.filter(matches);if(matched.length){const now=performance.now(),lastSeq=Math.max(...matched.map(event=>event.seq));s.latencies.push(...matched.map(event=>now-event.at));s.matchedInputs+=matched.length;s.supersededInputs+=perf.pending.filter(event=>event.seq<=lastSeq&&!matched.includes(event)).length;perf.pending=perf.pending.filter(event=>event.seq>lastSeq);}requestAnimationFrame(tick)};requestAnimationFrame(tick);
  const camera=()=>{const world=document.querySelector('.canvas-world'),m=new DOMMatrix(world?.style.transform);return {x:m.e,y:m.f,zoom:m.a};};
  document.addEventListener('pointerdown',event=>{if(!event.target.closest('.whiteboard'))return;const world=camera(),object=event.target.closest('.board-object');perf.gesture={world,start:{x:event.clientX,y:event.clientY},pan:document.querySelector('.whiteboard').classList.contains('mode-pan')||event.button===1,objectId:object?.dataset.objectId,objectX:parseFloat(object?.style.left),objectY:parseFloat(object?.style.top)};},true);
  document.addEventListener('pointermove',event=>{const g=perf.gesture;if(!g||!event.buttons)return;const dx=event.clientX-g.start.x,dy=event.clientY-g.start.y;enqueue(g.pan?{...g.world,x:g.world.x+dx,y:g.world.y+dy}:{objectId:g.objectId,objectX:g.objectX+dx/g.world.zoom,objectY:g.objectY+dy/g.world.zoom});},true);
  document.addEventListener('pointerup',()=>{perf.gesture=null},true);
  document.addEventListener('wheel',event=>{if(!event.target.closest('.whiteboard'))return;const v=perf.wheel||camera();const z=event.ctrlKey||event.metaKey?Math.min(4,Math.max(.05,v.zoom*Math.exp(-event.deltaY*.005))):v.zoom;const rect=document.querySelector('.whiteboard').getBoundingClientRect(),x=event.clientX-rect.left,y=event.clientY-rect.top;perf.wheel={x:z!==v.zoom?x-(x-v.x)/v.zoom*z:v.x-event.deltaX,y:z!==v.zoom?y-(y-v.y)/v.zoom*z:v.y-event.deltaY,zoom:z};enqueue(perf.wheel);},true);
});
const cdp=await context.newCDPSession(page);await cdp.send('Performance.enable');
await page.goto(server.url+'/?session='+session.id);await target.waitFor();await page.waitForFunction(n=>document.querySelectorAll('.board-object').length===n,count);await page.evaluate(()=>document.fonts.ready);await page.waitForTimeout(500);
if(activeMedia)await page.locator('video').evaluate(video=>{video.muted=true;video.loop=true;return video.play()});
// Warm the same selection and drag path before collecting gesture samples.
let warm=await target.boundingBox();await page.keyboard.down('Alt');await page.mouse.move(warm.x+80,warm.y+80);await page.mouse.down();await page.mouse.move(warm.x+90,warm.y+85);await page.mouse.up();await page.keyboard.up('Alt');await page.waitForTimeout(600);
const diagnostic=process.env.PERF_TRACE==='1';
if(diagnostic){await cdp.send('Profiler.enable');await cdp.send('Profiler.setSamplingInterval',{interval:1000});await cdp.send('Profiler.start');await cdp.send('Tracing.start',{categories:'devtools.timeline,v8,disabled-by-default-v8.gc,disabled-by-default-devtools.timeline,blink.user_timing',transferMode:'ReturnAsStream'});}
const measured=[];
const phase=async(name,action)=>{
const mediaFrameStart=await page.evaluate(name=>{const perf=window.domPerf;perf.phase=name;perf.pending=[];perf.wheel=undefined;perf.gesture=undefined;perf.phaseStartedAt=performance.now();return Array.from(document.querySelectorAll('video')).map(video=>({totalVideoFrames:video.getVideoPlaybackQuality().totalVideoFrames,currentTime:video.currentTime}))},name);
if(diagnostic)await page.evaluate(name=>performance.mark('acanvas-start:'+name),name);
const before=await cdp.send('Performance.getMetrics'),start=performance.now();await action();await page.waitForTimeout(150);const after=await cdp.send('Performance.getMetrics');
const facts=await page.evaluate(()=>{const perf=window.domPerf,endedAt=performance.now();return {...perf.phases[perf.phase],startedAt:perf.phaseStartedAt,endedAt,longTasks:perf.longTasks.filter(entry=>entry.at>=perf.phaseStartedAt&&entry.at<=endedAt),finalPose:perf.snapshot(),media:Array.from(document.querySelectorAll('video')).map(video=>({paused:video.paused,currentTime:video.currentTime,readyState:video.readyState,totalVideoFrames:video.getVideoPlaybackQuality().totalVideoFrames}))}});facts.mediaFrameStart=mediaFrameStart;
if(diagnostic)await page.evaluate(name=>performance.mark('acanvas-end:'+name),name);
if(activeMedia){assert(facts.media.length>0);facts.media.forEach((video,index)=>{assert.equal(video.paused,false);assert(video.readyState>=2);assert(video.totalVideoFrames>mediaFrameStart[index].totalVideoFrames,'active video must continue producing frames in '+name)});}
facts.elapsed=performance.now()-start;facts.metrics=Object.fromEntries(after.metrics.filter(value=>/Duration|Count|Heap/.test(value.name)).map(value=>[value.name,value.value-(before.metrics.find(other=>value.name===other.name)?.value||0)]));
for(const key of ['frames','latencies']){const sorted=[...facts[key]].sort((a,b)=>a-b);facts[key+'Summary']={count:sorted.length,p50:sorted[Math.floor(sorted.length*.5)],p95:sorted[Math.floor(sorted.length*.95)],max:sorted.at(-1)};}
assert.equal(facts.finalPose.lastInputMatched,true,name+' final input must reach DOM');assert.equal(facts.finalPose.pendingInputs,0,name+' inputs must be matched or superseded');assert.equal(facts.inputCount,facts.matchedInputs+facts.supersededInputs,name+' input accounting');
let persisted;for(let attempt=0;attempt<50;attempt++){persisted=await call('/api/state?sessionId='+session.id);if(['x','y','zoom'].every(key=>Math.abs(persisted.session.view[key]-facts.finalPose.camera[key])<.0001)&&facts.finalPose.objects.every(object=>{const saved=persisted.objects.find(value=>value.id===object.id);return saved&&['x','y','width','height'].every(key=>Math.abs(saved[key]-object[key])<.0001)}))break;await page.waitForTimeout(50);}
facts.persistence={camera:['x','y','zoom'].every(key=>Math.abs(persisted.session.view[key]-facts.finalPose.camera[key])<.0001),objects:facts.finalPose.objects.every(object=>{const saved=persisted.objects.find(value=>value.id===object.id);return saved&&['x','y','width','height'].every(key=>Math.abs(saved[key]-object[key])<.0001)})};assert.deepEqual(facts.persistence,{camera:true,objects:true});
measured.push({name,...facts});console.log(JSON.stringify({annotations,activeMedia,objects:count,name,inputCount:facts.inputCount,matched:facts.matchedInputs,superseded:facts.supersededInputs,pending:facts.finalPose.pendingInputs,persistence:facts.persistence,bounds:facts.bounds,observers:facts.observers,observerCallbacks:facts.observerCallbacks,longTasks:facts.longTasks,latencies:facts.latenciesSummary,metrics:facts.metrics}));};
const b=await target.boundingBox();
await phase('drag-alt',async()=>{await page.keyboard.down('Alt');await page.mouse.move(b.x+80,b.y+80);await page.mouse.down();for(let i=1;i<=60;i++){await page.mouse.move(b.x+80+i*1.5,b.y+80+Math.sin(i/8)*20);await page.waitForTimeout(8);}await page.mouse.up();await page.keyboard.up('Alt');});
await page.mouse.move(1370,720);await page.keyboard.down('Space');
await phase('pan-selected',async()=>{await page.mouse.down();for(let i=1;i<=60;i++){await page.mouse.move(1370-i*1.5,720+Math.sin(i/8)*20);await page.waitForTimeout(8);}await page.mouse.up();});await page.keyboard.up('Space');
await page.mouse.move(1380,730);
await phase('zoom-selected',async()=>{await page.keyboard.down('Control');for(let i=0;i<40;i++){await page.mouse.wheel(0,i<20?-3:3);await page.waitForTimeout(8);}await page.keyboard.up('Control');});
await page.mouse.click(1380,730);await page.keyboard.down('Space');
await phase('pan-unselected',async()=>{await page.mouse.move(1370,720);await page.mouse.down();for(let i=1;i<=60;i++){await page.mouse.move(1370-i*1.5,720+Math.sin(i/8)*20);await page.waitForTimeout(8);}await page.mouse.up();});await page.keyboard.up('Space');
if(diagnostic){const {profile}=await cdp.send('Profiler.stop');await writeFile(join(output,'cpu-profile-'+annotations+'-'+(activeMedia?'media':'static')+'.json'),JSON.stringify(profile));const complete=new Promise(resolve=>cdp.once('Tracing.tracingComplete',resolve));await cdp.send('Tracing.end');const {stream}=await complete;let trace='';while(true){const part=await cdp.send('IO.read',{handle:stream});trace+=part.data;if(part.eof)break}await cdp.send('IO.close',{handle:stream});await writeFile(join(output,'chrome-trace-'+annotations+'-'+(activeMedia?'media':'static')+'.json'),trace);}
const beforeCancel=await call('/api/state?sessionId='+session.id),cancelBox=await target.boundingBox();
await page.keyboard.down('Alt');await page.mouse.move(cancelBox.x+130,cancelBox.y+80);await page.mouse.down();await page.mouse.move(cancelBox.x+170,cancelBox.y+95);await page.locator('.whiteboard').dispatchEvent('pointercancel',{pointerId:1,pointerType:'mouse'});await page.mouse.up();await page.keyboard.up('Alt');await page.waitForTimeout(300);
const afterCancel=await call('/api/state?sessionId='+session.id),cancelPose=await page.evaluate(()=>window.domPerf.snapshot());
const cancelled={input:'Real pointer drag followed by a synthetic pointercancel lifecycle event',displayedRollback:cancelPose.objects.every(object=>{const saved=beforeCancel.objects.find(value=>value.id===object.id);return saved&&['x','y','width','height'].every(key=>Math.abs(saved[key]-object[key])<.0001)}),persistedUnchanged:JSON.stringify(afterCancel.objects)===JSON.stringify(beforeCancel.objects)};assert.equal(cancelled.displayedRollback,true);assert.equal(cancelled.persistedUnchanged,true);
const beforeReload=await page.evaluate(()=>window.domPerf.snapshot());await page.reload();await target.waitFor();await page.waitForTimeout(300);const afterReload=await page.evaluate(()=>window.domPerf.snapshot());assert.deepEqual(afterReload.camera,beforeReload.camera);assert.deepEqual(afterReload.objects,beforeReload.objects);
assert.deepEqual(errors,[]);
results.push({annotations,activeMedia,objects:count,root,fixture,targetId,initialObjectOrder:state.objects.map(object=>object.id),diagnostic,errors,measured,cancelled,reload:{camera:true,objects:true}});
} finally {await context.close();await server.close();}
}
} finally {await browser.close()}
await writeFile(join(output,'performance.json'),JSON.stringify({measuredAt:new Date().toISOString(),browser:browser.version(),dpr:2,viewport:{width:1440,height:1000},webRoot:process.env.PERF_WEB_ROOT||join(repo,'dist/web'),diagnostic:process.env.PERF_TRACE==='1',instrumentation:'Isolated projects, system Chrome headless and real Playwright pointer/wheel input. Canvas bounds/computed-style wrappers add equal microtiming overhead. Latency ends at the first requestAnimationFrame observation of the exact DOM camera or object pose; it excludes compositor presentation delay. Inputs are counted as matched, superseded by a later committed pose, or pending, and final input plus persisted/reloaded state are asserted. CDP durations cover gesture plus 150ms settling; persistence polling is excluded. Fixture assets are synthetic and fixture media. Optional PERF_TRACE=1 records tracing and a CPU profile as a separate diagnostic round, and those timings are excluded from untraced comparisons. These figures describe the measured scenes and input cadence.',results},null,2));console.log('OUTPUT',output);
