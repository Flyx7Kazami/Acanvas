import { chromium } from '@playwright/test';
import ts from 'typescript';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { installHtmlSnapshotBridge } from '../../../dist/src/shared/html-preview-snapshot.js';
const dir=path.dirname(fileURLToPath(import.meta.url));
const source=await fs.readFile(path.join(dir,'../../../src/web/html-preview-snapshot.ts'),'utf8');
const renderer=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText.replace(/export /g,'');
const browser=await chromium.launch({channel:'chrome',headless:true});
const page=await browser.newPage({viewport:{width:740,height:600}});const results=[];
for(const option of ['a','b','c']){
 await page.goto('file://'+path.join(dir,`option-${option}.html`));
 const result=await page.evaluate(async ({bridge,renderer})=>{
  const payload=await new Promise(resolve=>{const send=window.postMessage;window.postMessage=data=>{resolve(data);window.postMessage=send};eval('('+bridge+')')('diagnose','null');window.dispatchEvent(new MessageEvent('message',{source:window,origin:'null',data:{type:'acanvas:preview-snapshot',instanceId:'diagnose',requestId:'diagnose'}}));});
  if(payload.error)return {error:payload.error};
  const rasterize=eval('(()=>{'+renderer+';return rasterizeHtmlSnapshot})()');
  const image=await rasterize(payload);
  return {nodes:document.querySelectorAll('*').length,svgBytes:payload.svg.length,pngBytes:image.bytes,width:image.width,height:image.height};
 },{bridge:installHtmlSnapshotBridge.toString(),renderer});
 results.push({option,...result});
}
console.log(JSON.stringify(results,null,2));await fs.writeFile(path.join(dir,'snapshot-results.json'),JSON.stringify(results,null,2));await browser.close();if(results.some(r=>r.error))process.exitCode=1;
