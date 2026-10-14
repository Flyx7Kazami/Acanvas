import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { chromium } from '../../../node_modules/playwright-core/index.mjs';
import { expect } from '../../../node_modules/@playwright/test/index.mjs';
const candidate=resolve(process.env.ACANVAS_MOTION_CANDIDATE), label=process.env.ACANVAS_MOTION_LABEL || 'final', dir=new URL('.',import.meta.url).pathname;
const {startServer}=await import(pathToFileURL(join(candidate,'dist/src/server/http.js')));
const project=await mkdtemp(join(tmpdir(),'acanvas-history-bottom-'));
const server=await startServer({root:project,port:0,webRoot:join(candidate,'dist/web')});
const browser=await chromium.launch({channel:'chrome',headless:true});
const {token}=await(await fetch(server.url+'/api/bootstrap')).json();
const call=async(path,method='GET',body)=>{const r=await fetch(server.url+path,{method,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});assert(r.ok,`${method} ${path}: ${r.status} ${await r.clone().text()}`);return r.json()};
const session=await call('/api/sessions','POST',{name:'History motion'}), state=()=>call(`/api/state?sessionId=${session.id}`);
const upload=async(name,mime,body)=>{const r=await fetch(`${server.url}/api/assets?${new URLSearchParams({name,mime})}`,{method:'POST',headers:{Authorization:`Bearer ${token}`},body});assert(r.ok);return r.json()};
const md=await upload('Direction.md','text/markdown','# Direction\n\nCalm movement and clear hierarchy.'), file=await upload('Brief.txt','text/plain','A concise creative brief.');
const send=async(text,attachments=[])=>{const {draft}=await state();const d=await call(`/api/sessions/${session.id}/draft`,'PUT',{...draft,text,attachments});return(await call(`/api/sessions/${session.id}/tasks`,'POST',{draftId:d.id,expectedRevision:d.revision})).task};
for(let i=0;i<8;i++){const task=await send(`Explore layout ${i+1}`,[file.id,md.id]);await call(`/api/sessions/${session.id}/tasks/${task.id}/cancel`,'POST',{reason:'User cancelled the request.'})}
const page=await browser.newPage({viewport:{width:1440,height:1000}}), errors=[],checks=[],runs=[];page.on('pageerror',e=>errors.push(e.message));
const record=async(name,action,wait=320)=>{
 await page.evaluate(({name,wait})=>{
  const rect=n=>{if(!n)return null;const r=n.getBoundingClientRect();return{x:r.x,y:r.y,top:r.top,bottom:r.bottom,width:r.width,height:r.height}};
  window.__motionFrames=[];window.__motionDone=false;let start;let observer;
  const frame=()=>{const stack=document.querySelector('.history-stack'),clip=document.querySelector('.history-content'),panel=document.querySelector('#request-history'),head=panel?.querySelector('.inline-heading'),r=rect(clip),s=getComputedStyle(stack);window.__motionFrames.push({t:performance.now()-start,stack:rect(stack),clip:r,panel:rect(panel),head:rect(head),opacity:+s.opacity,transform:s.transform,grid:s.gridTemplateRows,inert:stack.inert,hidden:stack.getAttribute('aria-hidden'),motion:stack.dataset.motion,clipOverflow:clip?getComputedStyle(clip).overflow:null,visiblePanel:panel&&r?{top:Math.max(r.top,panel.getBoundingClientRect().top),bottom:Math.min(r.bottom,panel.getBoundingClientRect().bottom)}:null});if(performance.now()-start<wait)requestAnimationFrame(frame);else window.__motionDone=true};observer=new MutationObserver(()=>{observer.disconnect();start=performance.now();frame()});observer.observe(document.querySelector('.history-stack'),{attributes:true,attributeFilter:['data-motion']});
 },{name,wait});
 await action();await page.waitForFunction(()=>window.__motionDone);
 const frames=await page.evaluate(()=>window.__motionFrames);runs.push({name,frames});return frames;
};
const menu=()=>page.getByRole('button',{name:'More request actions',exact:true});
const chooseHistory=()=>page.getByRole('menuitem',{name:'Request history',exact:true});
const open=async()=>{await menu().click();await chooseHistory().click();await expect(page.locator('#request-history')).toBeVisible();await page.waitForTimeout(250)};
const close=async()=>{await page.getByRole('button',{name:'Close request history',exact:true}).click();await expect(page.locator('#request-history')).toHaveCount(0)};
const check=name=>{checks.push(name);console.log('PASS '+name)};
try{
 await page.goto(`${server.url}/?session=${session.id}`);await expect(page.locator('#whiteboard')).toBeVisible();await expect(page.locator('.composer')).toHaveAttribute('data-save-state','saved');await expect(page.locator('.connection-feedback')).toHaveCount(0);
 await menu().click();await record('desktop-zero-opening',()=>chooseHistory().evaluate(e=>e.click()));
 await record('desktop-zero-closing',()=>page.getByRole('button',{name:'Close request history',exact:true}).evaluate(e=>e.click()));
 if(label==='baseline'){console.log(JSON.stringify(runs.map(({name,frames})=>({name,frames:frames.filter(f=>f.panel&&f.opacity>0).map(f=>({t:Math.round(f.t),stack:f.stack,clip:f.clip,panel:f.panel,opacity:f.opacity}))})),null,2));}
 else {
  for(const width of [1440,390]){
   await page.setViewportSize({width,height:width===1440?1000:760});
   for(const pending of [0,1]){
    let queued;if(pending){queued=await send(`Create a precise composition at ${width}`);await expect(page.locator('.queue-item')).toHaveCount(1)}
    await menu().click();await record(`${width}-${pending}-opening`,()=>chooseHistory().evaluate(e=>e.click()));
    await page.screenshot({path:join(dir,`${label}-${width}-${pending}-open.png`)});
    await record(`${width}-${pending}-closing`,()=>page.getByRole('button',{name:'Close request history',exact:true}).evaluate(e=>e.click()));await expect(page.locator('#request-history')).toHaveCount(0);
    if(pending){await expect(page.locator('.queue-stack:not(.history-stack)')).toBeVisible();await expect(page.locator('.queue-task')).toBeVisible();await call(`/api/sessions/${session.id}/tasks/${queued.id}/cancel`,'POST',{reason:'User cancelled the request.'});await expect(page.locator('.queue-item')).toHaveCount(0)}
   }
  }
  for(const run of runs){
   const active=run.frames.filter(f=>f.panel && f.stack.height>18.1),opening=run.name.endsWith('opening');assert(active.length>=4,run.name+' has multiple frames');
   const spread=key=>Math.max(...active.map(f=>f[key]))-Math.min(...active.map(f=>f[key]));
   for(const field of ['bottom','x','width'])assert(Math.max(...active.map(f=>f.stack[field]))-Math.min(...active.map(f=>f.stack[field]))<.1,run.name+' fixed stack '+field);
   assert(Math.max(...active.map(f=>f.panel.bottom))-Math.min(...active.map(f=>f.panel.bottom))<.1,run.name+' content bottom fixed');
   assert(active.every(f=>Math.abs(f.panel.bottom-f.clip.bottom)<.1),run.name+' content bottom meets clip');
   assert(active.every(f=>f.clipOverflow==='hidden'&&Math.abs(f.visiblePanel.bottom-f.clip.bottom)<.1),run.name+' bottom anchored visible crop');
   const moving=active.filter(f=>f.motion===(opening?'open':'closing'));
   for(let i=1;i<moving.length;i++)assert(opening?moving[i].clip.top<=moving[i-1].clip.top+.1:moving[i].clip.top>=moving[i-1].clip.top-.1,run.name+' top edge direction');
   assert(active.some(f=>f.opacity>0&&f.opacity<1),run.name+' soft opacity frames');
   if(!opening)assert(moving.every(f=>f.inert&&f.hidden==='true'),run.name+' inert exit');
   check(run.name+' fixed bottom/x/width, bottom crop, top edge and opacity');
  }
  await open();await page.locator('#request-history').getByRole('button',{name:'View Direction.md',exact:true}).first().click();await expect(page.locator('.history-stack')).toHaveAttribute('data-motion','open');const download=page.waitForEvent('download');await page.locator('#request-history').getByRole('link',{name:'Download Brief.txt',exact:true}).first().click();await download;await expect(page.locator('.history-stack')).toHaveAttribute('data-motion','open');await page.locator('#request-history').evaluate(e=>e.scrollTop=e.scrollHeight);assert(await page.locator('#request-history').evaluate(e=>e.scrollTop)>0);check('inside reference, download and scroll remain interactive');
  await page.locator('.chatbox-editor').click();await expect(page.locator('#request-history')).toHaveCount(0);assert(await page.locator('.chatbox-editor').evaluate(e=>e.contains(document.activeElement)));check('outside composer closes and preserves target focus');
  await open();await page.keyboard.press('Escape');await expect(page.locator('#request-history')).toHaveCount(0);await expect(menu()).toBeFocused();check('Escape closes and returns focus');
  await open();await record('rapid-reversal',()=>page.evaluate(async()=>{document.querySelector('[aria-label="Close request history"]').click();await new Promise(r=>setTimeout(r,50));document.querySelector('[aria-label="More request actions"]').click();await new Promise(requestAnimationFrame);[...document.querySelectorAll('[role=menuitem]')].find(e=>e.textContent==='Request history').click()}),440);await expect(page.locator('#request-history')).toHaveCount(1);assert.equal(await page.locator('.history-stack').evaluate(e=>+getComputedStyle(e).opacity),1);const reversal=runs.at(-1).frames,firstClose=reversal.find(f=>f.motion==='closing'),reopened=reversal.find(f=>firstClose&&f.t>firstClose.t&&f.motion==='open');assert(firstClose&&reopened&&reopened.t-firstClose.t<150,'rapid reversal occurs within exit');assert(reversal.every(f=>f.panel),'rapid reversal retains the mounted panel');for(const f of reversal)assert(Math.abs(f.stack.bottom-reversal[0].stack.bottom)<.1&&Math.abs(f.panel.bottom-reversal[0].panel.bottom)<.1&&Math.abs(f.stack.x-reversal[0].stack.x)<.1&&Math.abs(f.stack.width-reversal[0].stack.width)<.1,'rapid reversal anchored geometry');check('rapid close and reopen within 150ms retains panel and fixed geometry');await close();
  await page.emulateMedia({reducedMotion:'reduce'});await open();assert.equal(await page.locator('.history-stack').evaluate(e=>e.getAnimations().length),0);await close();check('reduced motion reaches final geometry and unmounts immediately');
  await expect(page.getByRole('button',{name:'Undo',exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'Redo',exact:true})).toBeVisible();await call('/api/board/operations','POST',{sessionId:session.id,operations:[{type:'create',object:{assetId:md.id,x:110,y:100,width:160,height:100}},{type:'create',object:{assetId:md.id,x:290,y:100,width:160,height:100}}]});await expect(page.locator('.board-object')).toHaveCount(2);await page.setViewportSize({width:1440,height:1000});await page.locator('.board-object').first().focus();await page.locator('.board-object').first().press('Enter');await page.locator('.board-object').last().focus();await page.locator('.board-object').last().press('Shift+Enter');await expect(page.locator('.board-object.selected')).toHaveCount(2);await expect(page.getByRole('button',{name:'Group',exact:true})).toBeVisible();check('final full build shows Undo, Redo, and Group for a two-item selection');await page.screenshot({path:join(dir,`${label}-toolbar-group.png`)});const queuedA=await send('Queue detail check A',[md.id]),queuedB=await send('Queue detail check B',[file.id]);await expect(page.locator('.queue-item')).toHaveCount(2);await page.locator('.queue-expand').click();await expect(page.locator('.queue-stack:not(.history-stack)')).toHaveClass(/expanded/);await page.locator('.queue-task').first().click();await expect(page.locator('.inline-task-detail').first()).toHaveAttribute('data-motion','open');await page.getByRole('button',{name:'Collapse request details',exact:true}).click();await expect(page.locator('.inline-task-detail').first()).toHaveAttribute('aria-hidden','true');for(const task of [queuedA,queuedB])await call(`/api/sessions/${session.id}/tasks/${task.id}/cancel`,'POST',{reason:'User cancelled the request.'});await expect(page.locator('.queue-item')).toHaveCount(0);check('two-item queue expansion and shared detail disclosure remain operational');const videoContext=await browser.newContext({viewport:{width:390,height:760}});const vp=await videoContext.newPage();vp.on('pageerror',e=>errors.push(e.message));await vp.goto(`${server.url}/?session=${session.id}`);await expect(vp.locator('#whiteboard')).toBeVisible();await expect(vp.locator('.composer')).toHaveAttribute('data-save-state','saved');await vp.waitForTimeout(300);await vp.getByRole('button',{name:'More request actions',exact:true}).click();const cdp=await videoContext.newCDPSession(vp),shots=[];cdp.on('Page.screencastFrame',frame=>{shots.push({bytes:Buffer.from(frame.data,'base64'),t:frame.metadata.timestamp});void cdp.send('Page.screencastFrameAck',{sessionId:frame.sessionId})});await cdp.send('Page.startScreencast',{format:'png',everyNthFrame:1});await vp.getByRole('menuitem',{name:'Request history',exact:true}).evaluate(e=>e.click());await vp.waitForTimeout(500);await vp.getByRole('button',{name:'Close request history',exact:true}).evaluate(e=>e.click());await vp.waitForTimeout(400);await cdp.send('Page.stopScreencast');const framesDir=join(dir,'motion-frames');await mkdir(framesDir,{recursive:true});const lines=['ffconcat version 1.0'];for(let i=0;i<shots.length;i++){const name=`frame-${String(i).padStart(3,'0')}.png`;await writeFile(join(framesDir,name),shots[i].bytes);lines.push(`file '${name}'`);if(i+1<shots.length)lines.push(`duration ${Math.max(.001,shots[i+1].t-shots[i].t).toFixed(6)}`)}await writeFile(join(framesDir,'frames.ffconcat'),lines.join('\n')+'\n');await writeFile(join(dir,'capture-frames.json'),JSON.stringify(shots.map(({t},i)=>({frame:i,t:t-shots[0].t})),null,2));await videoContext.close();check('actual Chrome screencast frames captured for opening and closing');assert.equal(errors.length,0);check('zero browser exceptions');
 }
} finally {await writeFile(join(dir,`${label}-results.json`),JSON.stringify({candidate,project,base:server.url,session:session.id,label,checks,errors,runs},null,2));await browser.close();await server.close();console.log('Closed isolated browser and service '+server.url)}
