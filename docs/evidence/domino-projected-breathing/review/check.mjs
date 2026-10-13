import {chromium} from 'playwright-core';
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import * as m from '../../../../assets/brand/domino/model.mjs';
import * as k from '../../../../assets/brand/domino/vendor/anatomy/iso-kit.mjs';
const out=resolve('docs/evidence/domino-projected-breathing/review');
const report={node:process.version};
const browser=await chromium.launch({channel:'chrome',headless:true});const page=await browser.newPage({viewport:{width:1500,height:720},deviceScaleFactor:1});report.browser=browser.version();report.errors=[];page.on('pageerror',e=>report.errors.push(String(e)));
await page.goto('file://'+resolve('assets/brand/domino/index.html'));
const paintOrders={};for(let t=0;t<650;t+=10){paintOrders[t]=await page.evaluate(t=>{document.getAnimations().forEach(a=>{a.pause();a.currentTime=t});return [...document.querySelectorAll('.domino-layer')].map(e=>+getComputedStyle(e).zIndex)},t);}
const p=m.dominoProject([0,0,0]),q=m.dominoProject([1,0,0]);
report.forward=q.map((v,i)=>v-p[i]);report.screenSpeed=Math.hypot(...report.forward)*m.DOMINO_SPEED*1000;
const old={origin:[36,54],scale:1.1,azimuth:-145,elevation:28};
const op=k.iso([0,0,0],old),oq=k.iso([1,0,0],old);
report.oldScreenSpeed=Math.hypot(...oq.map((v,i)=>v-op[i]))*24/300*1000;
report.speedRatio=report.screenSpeed/report.oldScreenSpeed;
report.areas=[];for(let age=0;age<=2000;age+=100){const a=m.dominoMatrix(0,m.DOMINO_TIMING.fallAt+age);report.areas.push({age,det:a[0]*a[3]-a[1]*a[2]});}
let overlaps=0,mismatches=0;const examples=[];
for(let t=0;t<650;t+=10){const faces=m.DOMINO_CARDS.map(i=>{const s=m.dominoState(i,t),a=m.dominoMatrix(i,t);return {i,s,a,det:a[0]*a[3]-a[1]*a[2],center:paintOrders[t][i]}});
for(let x=.5;x<72;x+=1)for(let y=.5;y<64;y+=1){const hits=[];for(const f of faces){if(Math.abs(f.det)<1e-6)continue;const dx=x-f.a[4],dy=y-f.a[5],u=(f.a[3]*dx-f.a[2]*dy)/f.det,v=(-f.a[1]*dx+f.a[0]*dy)/f.det;if(Math.abs(u)<9&&v>3&&v<31)hits.push({...f,depth:k.depthOf(m.dominoPoint(f.s.relativeX,u,v,f.s.angle),m.DOMINO_CAMERA)});}if(hits.length>1){overlaps++;const actual=[...hits].sort((a,b)=>b.depth-a.depth)[0],paint=[...hits].sort((a,b)=>b.center-a.center||b.i-a.i)[0];if(actual.i!==paint.i){mismatches++;if(examples.length<8)examples.push({t,x,y,actual:actual.i,paint:paint.i,gap:actual.depth-paint.depth});}}}}
report.occlusion={overlaps,mismatches,examples};
let seam=0;for(const i of m.DOMINO_CARDS){m.dominoMatrix(i,0).forEach((v,j)=>seam=Math.max(seam,Math.abs(v-m.dominoMatrix(i,m.DOMINO_DURATION)[j])))}report.seamMatrixError=seam;
report.offscreenRecycle=[];for(const i of m.DOMINO_CARDS){const t=m.DOMINO_DURATION-i*m.DOMINO_CADENCE;for(const delta of [-.001,.001]){const a=m.dominoMatrix(i,t+delta),pts=[[-12,0],[12,0],[-12,34],[12,34]].map(([u,v])=>[a[0]*u+a[2]*v+a[4],a[1]*u+a[3]*v+a[5]]),xs=pts.map(p=>p[0]),ys=pts.map(p=>p[1]);report.offscreenRecycle.push(Math.max(...xs)<0||Math.min(...xs)>72||Math.max(...ys)<0||Math.min(...ys)>64);}}
const svg=readFileSync('assets/brand/domino/domino.svg','utf8');
for(const theme of ['light','dark']){await page.emulateMedia({colorScheme:theme});await page.setContent(`<body style="margin:16px;background:${theme==='light'?'#fcfcfa':'#111'};color:${theme==='light'?'#222':'#eee'};font:12px sans-serif">${[32,64,160].map(size=>`<section style="display:flex;gap:15px;margin-bottom:16px;align-items:center"><span>${size}px</span>${[0,100,200,300,400,500,600,650].map(time=>`<div><div class="pose" data-time="${time}" style="width:${size}px;height:${size}px">${svg.replace('width="64" height="64"',`width="${size}" height="${size}"`)}</div><span>${time}ms</span></div>`).join('')}</section>`).join('')}</body>`);await page.evaluate(()=>document.querySelectorAll('.pose').forEach(e=>e.getAnimations({subtree:true}).forEach(a=>{a.pause();a.currentTime=+e.dataset.time})));await page.screenshot({path:out+`/poses-${theme}.png`,fullPage:true});}
await page.goto('file://'+resolve('assets/brand/domino/index.html'));let maxMatrixError=0;for(const t of [0,112.5,650,4745,7000,9737.5,9750]){const actual=await page.evaluate(t=>{document.getAnimations().forEach(a=>{a.pause();a.currentTime=t});return [...document.querySelectorAll('.domino-layer')].map(e=>{const a=new DOMMatrix(getComputedStyle(e).transform);return[a.a,a.b,a.c,a.d,a.e,a.f]})},t);actual.forEach((a,i)=>a.forEach((v,j)=>maxMatrixError=Math.max(maxMatrixError,Math.abs(v-m.dominoMatrix(i,t)[j]))));}report.maxMatrixError=maxMatrixError;
report.generatedCssMatches=readFileSync('src/web/domino-loader.generated.css','utf8').split('\n').slice(1).join('\n')===m.dominoCss()+'\n';report.previewMatches=readFileSync('assets/brand/domino/index.html','utf8')===readFileSync('assets/brand/domino/comparison/refined.html','utf8');
const ts=readFileSync('src/web/domino-loader.generated.ts','utf8');report.generatedTsMatches=ts.includes(JSON.stringify(m.DOMINO_PATH))&&ts.includes(JSON.stringify(m.DOMINO_CARDS.map(i=>m.dominoTransform(i,0))))&&ts.includes(`DOMINO_DURATION = ${m.DOMINO_DURATION}`);
await page.emulateMedia({reducedMotion:'reduce'});await page.reload();report.reducedAnimations=await page.evaluate(()=>document.getAnimations().length);
writeFileSync(out+'/results.json',JSON.stringify(report,null,2));await browser.close();console.log(JSON.stringify(report,null,2));
