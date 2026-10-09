import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {chromium} from 'playwright-core';
const build=process.env.ACANVAS_CONNECTION_REVIEW_BUILD;if(!build)throw new Error('Set ACANVAS_CONNECTION_REVIEW_BUILD to a private compiled tree with node_modules symlink.');
const {startServer}=await import(build+'/src/server/http.js');
const report={status:'incomplete',scope:'Owned empty real App; functional lifecycle, no timing conclusion; Chromium actual BFCache eligibility recorded separately from persisted-event branch',measuredAt:new Date().toISOString(),webRoot:process.env.ACANVAS_CONNECTION_REVIEW_WEB_ROOT||'/private/tmp/acanvas-cold-transport-20261009/web',errors:[],streams:[],acks:[],lifecycle:[]};
const root=await mkdtemp('/private/tmp/acanvas-ws-browser-review-');let server,browser,page;
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const viewOf=()=>page.evaluate(()=>({viewId:document.querySelector('canvas.scene-canvas')?.dataset.viewId,viewGeneration:Number(document.querySelector('canvas.scene-canvas')?.dataset.viewGeneration)}));
const waitView=()=>page.waitForFunction(()=>!!document.querySelector('canvas.scene-canvas')?.dataset.viewId,undefined,{timeout:10000});
const viewActive=view=>{try{server.service.captureView(session.id,view.viewId);return true;}catch{return false;}};
let session;
try{
 server=await startServer({root,port:0,webRoot:report.webRoot});const boot=await(await fetch(server.url+'/api/bootstrap')).json();
 session=server.service.createSession('Owned lifecycle');
 browser=await chromium.launch({channel:'chrome',headless:true,chromiumSandbox:true,ignoreDefaultArgs:['--disable-back-forward-cache']});report.browser=browser.version();const context=await browser.newContext();
 await context.addInitScript(()=>{window.reviewerLife=[];for(const type of ['pagehide','pageshow'])window.addEventListener(type,event=>window.reviewerLife.push({type,persisted:event.persisted}));});
 page=await context.newPage();page.on('pageerror',error=>report.errors.push(error.message));page.on('request',req=>{const path=new URL(req.url()).pathname;if(path==='/api/events'||path.endsWith('/presence'))report.streams.push(path);});
 const cdp=await context.newCDPSession(page);await cdp.send('Network.enable');cdp.on('Network.webSocketFrameReceived',event=>{try{const value=JSON.parse(event.response.payloadData);if(value.type==='ready')report.acks.push({type:value.type,instanceId:value.instanceId});if(value.type==='view-ready')report.acks.push({type:value.type,view:value.view});}catch{}});
 const url=server.url+'/?session='+session.id;await page.goto(url);await waitView();const first=await viewOf();assert(viewActive(first));
 await page.evaluate(()=>{window.dispatchEvent(new PageTransitionEvent('pagehide',{persisted:true}));window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true}));});await delay(100);assert.deepEqual(await viewOf(),first);assert(viewActive(first));report.persistedBranchKeepsSameView=true;
 await page.goto('about:blank');await delay(250);report.oldViewActiveAfterNavigation=viewActive(first);await page.goBack({waitUntil:'commit',timeout:5000});await waitView();const returned=await viewOf();report.actualNavigation={sameView:returned.viewId===first.viewId,lifecycle:await page.evaluate(()=>window.reviewerLife),notRestoredReasons:await page.evaluate(()=>performance.getEntriesByType('navigation')[0]?.notRestoredReasons?.toJSON?.()??null)};
 if(returned.viewId!==first.viewId){const deadline=Date.now()+5500;while(viewActive(first)&&Date.now()<deadline)await delay(25);assert.equal(viewActive(first),false);}
 assert(viewActive(returned));report.navigationRestoresActiveDocument=true;
 const oldCookie=(await context.cookies()).find(cookie=>cookie.name.startsWith('acanvas_auth_'));const previous=server.service.identity().instanceId,port=Number(new URL(server.url).port);await server.close();server=await startServer({root,port,webRoot:report.webRoot});assert.notEqual(server.service.identity().instanceId,previous);await page.waitForFunction(old=>document.querySelector('canvas.scene-canvas')?.dataset.viewId&&document.querySelector('canvas.scene-canvas')?.dataset.viewId!==old,returned.viewId,{timeout:12000});
 const replaced=await viewOf();assert(viewActive(replaced));assert(report.acks.some(ack=>ack.type==='ready'&&ack.instanceId===server.service.identity().instanceId));assert(report.acks.some(ack=>ack.type==='view-ready'&&ack.view.viewId===replaced.viewId));const newCookie=(await context.cookies()).find(cookie=>cookie.name===oldCookie.name);assert.notEqual(newCookie.value,oldCookie.value);report.samePortRestart={instanceReplaced:true,cookieRenewed:true,newViewAcknowledged:true,oldViewReplaced:true};
 await page.close();const deadline=Date.now()+5500;while(viewActive(replaced)&&Date.now()<deadline)await delay(25);assert.equal(viewActive(replaced),false);report.pageCloseRetiresOwnedView=true;assert.equal(report.streams.length,0);assert.deepEqual(report.errors,[]);report.status='passed';
} catch(error){report.failure={message:error.message,stack:error.stack};throw error;}finally{await browser?.close();await server?.close();await writeFile('/Users/yingbowu/Documents/Projects/acanvas/docs/evidence/interactive-media-performance/transport/reviewer-browser-lifecycle.json',JSON.stringify(report,null,2)+'\n');await rm(root,{recursive:true,force:true});}
