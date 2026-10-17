// Compare the shared SVG with its original geometry at DPR 2. Run after building.
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startServer } from '../../dist/src/server/http.js';
import { DOMINO_BOUNDS, DOMINO_PATH, DOMINO_TRANSFORMS, DOMINO_VIEWBOX } from '../src/web/domino-loader.generated.ts';
const root=await mkdtemp(join(tmpdir(),'acanvas-domino-quality-')); const output=process.env.OUTPUT || root; await mkdir(output,{recursive:true});
const css=await readFile(new URL('../src/web/domino-loader.generated.css', import.meta.url),'utf8');
const server=await startServer({root,port:0,webRoot:resolve('dist/web')});
const browser=await chromium.launch({channel:'chrome',headless:true}),context=await browser.newContext({deviceScaleFactor:2,viewport:{width:700,height:700},reducedMotion:'reduce'}),page=await context.newPage();
const results=[];
try{
 await page.route('**/quality.html',route=>route.fulfill({contentType:'text/html',body:'<!doctype html>'})); await page.goto(server.url+'/quality.html');
 const cards=DOMINO_TRANSFORMS.map((_,i)=>`<div class="domino-layer domino-card-${i}"><svg width="1" height="1" viewBox="0 0 1 1"><path d="${DOMINO_PATH}"/></svg></div>`).join('');
 await page.setContent(`<style>${css}body{margin:0;background:white}.row{display:flex;gap:8px}img{display:block}</style>${[16,32,36,48,192].map(size=>`<div class="row"><svg class="domino-loader original" width="${size}" height="${size}" viewBox="${DOMINO_VIEWBOX}" fill="none" stroke="none"><foreignObject width="${DOMINO_BOUNDS[0]}" height="${DOMINO_BOUNDS[1]}"><div xmlns="http://www.w3.org/1999/xhtml" class="domino-stage">${cards}</div></foreignObject></svg><picture><source media="(prefers-reduced-motion: reduce)" srcset="${server.url}/domino-loader-still.svg"/><img class="candidate" src="${server.url}/domino-loader.svg" width="${size}" height="${size}"/></picture></div>`).join('')}`);
 await page.waitForFunction(()=>[...document.images].every(i=>i.complete&&i.naturalWidth));
 for(const theme of ['light','dark']){
  await page.evaluate(theme=>{document.documentElement.dataset.theme=theme;document.documentElement.style.colorScheme=theme},theme);
  await page.waitForTimeout(100);
  for(let i=0;i<5;i++){
   const a=await page.locator('.original').nth(i).screenshot(),b=await page.locator('.candidate').nth(i).screenshot();
   const diff=await page.evaluate(async({a,b})=>{const decode=async p=>{const img=await createImageBitmap(new Blob([new Uint8Array(p)],{type:'image/png'})),c=document.createElement('canvas');c.width=img.width;c.height=img.height;const ctx=c.getContext('2d');ctx.drawImage(img,0,0);return ctx.getImageData(0,0,c.width,c.height).data};const x=await decode(a),y=await decode(b);let sum=0,max=0,ink=0;for(let i=0;i<x.length;i+=4){for(let c=0;c<3;c++){sum+=Math.abs(x[i+c]-y[i+c]);max=Math.max(max,Math.abs(x[i+c]-y[i+c]));if(y[i+c]<240)ink++}}return{mean:sum/(x.length/4*3),max,ink}}, {a:[...a],b:[...b]});results.push({theme,size:[16,32,36,48,192][i],...diff});
  }
 }
 await page.emulateMedia({reducedMotion:'no-preference'}); await page.waitForTimeout(150);
 await page.screenshot({path:output+'/comparison.png'});
 const before=await page.locator('.candidate').last().screenshot();await page.waitForTimeout(200);const after=await page.locator('.candidate').last().screenshot();
 results.push({animating:!before.equals(after)}); assert(!before.equals(after),'Normal motion advances the shared image'); assert(results.filter(value=>'mean' in value).every(value=>value.mean===0 && value.ink>0),'Reduced motion preserves the vector pixels and theme');
 console.log(JSON.stringify(results));await writeFile(output+'/results.json',JSON.stringify(results,null,2));
}finally{await browser.close();await server.close(); if(process.env.OUTPUT)await rm(root,{recursive:true,force:true})}
