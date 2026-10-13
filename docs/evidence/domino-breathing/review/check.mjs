import {chromium} from 'playwright-core';
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import * as m from '../../../../assets/brand/domino/model.mjs';
const out=resolve('docs/evidence/domino-breathing/review');
const browser=await chromium.launch({channel:'chrome',headless:true});
const page=await browser.newPage({viewport:{width:900,height:580},deviceScaleFactor:2});
let errors=[];page.on('pageerror',e=>errors.push(String(e)));const report={node:process.version,browser:browser.version(),errors};
await page.goto('file://'+resolve('assets/brand/domino/comparison/comparison.html'));
const state=()=>page.evaluate(()=>[...document.querySelectorAll('iframe')].map(f=>({time:f.contentDocument.getAnimations()[0]?.currentTime,matrix:getComputedStyle(f.contentDocument.querySelector('.domino-card-7')).transform})));
const before=await state();await page.waitForTimeout(500);const after=await state();report.comparison={before,after,columns:await page.locator('iframe').count()};await page.screenshot({path:out+'/comparison-live.png'});
await page.setViewportSize({width:390,height:300});await page.screenshot({path:out+'/comparison-mobile.png'});
await page.goto('file://'+resolve('assets/brand/domino/index.html'));
const initial=await page.locator('.domino-card-7').evaluate(e=>getComputedStyle(e).transform);await page.waitForTimeout(500);report.live={initial,after:await page.locator('.domino-card-7').evaluate(e=>getComputedStyle(e).transform)};
const svg=readFileSync('assets/brand/domino/domino.svg','utf8');
const times=[0,75,150,225,300,375,450,525];
await page.setViewportSize({width:1000,height:510});
for(const theme of ['light','dark']){
 await page.emulateMedia({colorScheme:theme});
 await page.setContent(`<body style="margin:0;padding:15px;background:${theme==='light'?'#fcfcfa':'#111'};color:${theme==='light'?'#242424':'#eee'};font:12px sans-serif">${[32,48,64,192].map(size=>`<section style="display:flex;align-items:center;gap:18px;margin-bottom:15px"><span style="width:32px">${size}</span>${times.map(time=>`<div><div class="pose" data-time="${time}" style="width:${size}px;height:${size}px">${svg.replace('width="64" height="64"',`width="${size}" height="${size}"`)}</div><span>${time}ms</span></div>`).join('')}</section>`).join('')}</body>`);
 await page.evaluate(()=>document.querySelectorAll('.pose').forEach(e=>e.getAnimations({subtree:true}).forEach(a=>{a.pause();a.currentTime=Number(e.dataset.time)})));
 await page.screenshot({path:out+`/poses-${theme}.png`,fullPage:true});
}
await page.setViewportSize({width:500,height:350});await page.emulateMedia({reducedMotion:'reduce',colorScheme:'light'});await page.goto('file://'+resolve('assets/brand/domino/index.html'));report.reduced={animations:await page.evaluate(()=>document.getAnimations().length)};await page.screenshot({path:out+'/reduced.png'});
await page.goto('file://'+resolve('assets/brand/domino/comparison/comparison.html'));report.reduced.comparisonAnimations=await page.evaluate(()=>[...document.querySelectorAll('iframe')].map(f=>f.contentDocument.getAnimations().length));
// Check browser matrix agrees with source at keyframes, including exact cycle seam.
await page.emulateMedia({reducedMotion:'no-preference'});await page.goto('file://'+resolve('assets/brand/domino/index.html'));
let maxMatrixError=0;
for(const t of [0,12.5,150,2225,3000,4487.5,4500]){
const actual=await page.evaluate(t=>{document.getAnimations().forEach(a=>{a.pause();a.currentTime=t});return [...document.querySelectorAll('.domino-layer')].map(e=>{let a=new DOMMatrix(getComputedStyle(e).transform);return [a.a,a.b,a.c,a.d,a.e,a.f]})},t);
actual.forEach((a,i)=>a.forEach((v,j)=>maxMatrixError=Math.max(maxMatrixError,Math.abs(v-m.dominoMatrix(i,t)[j]))));}
report.maxMatrixError=maxMatrixError;
report.generatedCssMatches=readFileSync('src/web/domino-loader.generated.css','utf8').split('\n').slice(1).join('\n')===m.dominoCss()+'\n';report.refinedMatches=readFileSync('assets/brand/domino/index.html','utf8')===readFileSync('assets/brand/domino/comparison/refined.html','utf8');
writeFileSync(out+'/browser.json',JSON.stringify(report,null,2));await browser.close();console.log(JSON.stringify(report,null,2));
