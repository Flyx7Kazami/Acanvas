// Compare settled native pixels after zooming through multiple raster scales.
// ORIGINAL_WEB_ROOT=/path/to/original/web node app/tests/camera-quality.mjs
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { startServer } from '../../dist/src/server/http.js';
const original = process.env.ORIGINAL_WEB_ROOT;
const motion = process.env.MOTION === '1';
if (!original) throw new Error('Supply ORIGINAL_WEB_ROOT with a built comparison revision.');
const output = process.env.OUTPUT || await mkdtemp(join(tmpdir(), 'acanvas-camera-quality-'));
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext({ viewport: { width: 1600, height: 1200 }, deviceScaleFactor: 2 });
const decoder = await context.newPage();
const assets = [
  { id: 'image', name: 'Fine detail.svg', mime: 'image/svg+xml', kind: 'image', text: '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="420"><rect width="600" height="420" fill="#f9f5ee"/>' + Array.from({length:80},(_,i)=>`<path d="M${20+i*7} 20v300" stroke="${i%2?'#151515':'#385a98'}" stroke-width="1"/>`).join('') + '<text x="20" y="355" font-size="13">Fine image detail — 1234567890</text><text x="20" y="390" font-size="26">Geometry / Light / Space</text></svg>' },
  { id: 'note', name: 'Notes', mime: 'text/x-acanvas-note', kind: 'file', text: 'Small details remain clear.\nABCDEFGHIJKLMNOPQRSTUVWXYZ\n0123456789 / 画面清晰度\nComposition and proportion.' },
  { id: 'markdown', name: 'Brief.md', mime: 'text/markdown', kind: 'file', text: '# Clear typography\n\n**Bold** and *italic* text.\n\n- Geometry and rhythm\n- Fine detail at every scale\n\n`const zoom = 1.25;`\n\n[Source](https://example.com)' },
];
const captures = new Map(), results = [];
try {
  for (const [variant, webRoot] of [['original', original], ['candidate', process.env.WEB_ROOT || 'dist/web']]) {
    const root = await mkdtemp(join(tmpdir(), 'acanvas-camera-quality-board-'));
    const server = await startServer({ root, port: 0, webRoot: resolve(webRoot) });
    const page = await context.newPage();
    try {
      for (const asset of assets) { const bytes = Buffer.from(asset.text), path = `assets/${asset.id}`; await writeFile(join(server.service.dataDir, path), bytes); server.service.registerAsset({ ...asset, size: bytes.length, createdAt: '2026-10-17T00:00:00.000Z' }, path); }
      const session = server.service.createSession('Image quality');
      server.service.boardOperations(session.id, assets.map((asset,index)=>({type:'create',object:{id:asset.id,assetId:asset.id,x:index*600,y:0,width:300,height:210}})));
      server.service.saveView(session.id, { x: 300, y: 200, zoom: 1, selectedObjectIds: [] });
      await page.goto(`${server.url}/?session=${session.id}`);
      await page.waitForFunction(()=>document.querySelectorAll('.board-object').length===3 && !document.querySelector('.content-loading'));
      await page.evaluate(()=>document.fonts.ready);
      let sample = 0;
      for (const zoom of (motion ? [.6, 1.2, 3.5] : [.05, .25, 1, 2, 4, 1])) for (const [index, asset] of assets.entries()) {
        await page.evaluate(async({zoom,worldX})=>{
          const board=document.querySelector('#whiteboard'), world=document.querySelector('.canvas-world'), m=new DOMMatrix(getComputedStyle(world).transform);
          const cx=innerWidth/2,cy=innerHeight/2, anchorX=(cx-m.e)/m.a, anchorY=(cy-m.f)/m.a;
          let previous=m.a;
          await new Promise(resolve=>{let step=0;function frame(){const next=m.a*Math.exp(Math.log(zoom/m.a)*++step/12);board.dispatchEvent(new WheelEvent('wheel',{bubbles:true,cancelable:true,ctrlKey:true,clientX:cx,clientY:cy,deltaY:-Math.log(next/previous)/.005}));previous=next;if(step<12)requestAnimationFrame(frame);else resolve();}requestAnimationFrame(frame)});
          board.dispatchEvent(new WheelEvent('wheel',{bubbles:true,cancelable:true,deltaX:(worldX-anchorX)*zoom,deltaY:(105-anchorY)*zoom}));
        },{zoom,worldX:index*600+150});
        if (motion) {
          await page.evaluate(() => { const motion = { sign: 1, timer: 0 }; window.qualityMotion = motion; motion.timer = setInterval(() => { document.querySelector('#whiteboard').dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaX: motion.sign * .125, deltaY: 0 })); motion.sign = -motion.sign; }, 32); });
          await page.waitForTimeout(100);
        } else await page.waitForTimeout(350);
        if (motion) await page.evaluate(async () => { const motion = window.qualityMotion; clearInterval(motion.timer); if (motion.sign === -1) document.querySelector('#whiteboard').dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaX: -.125, deltaY: 0 })); await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); });
        const media=page.locator(`[data-object-id="${asset.id}"] .object-media`);
        const bounds=await media.boundingBox();
        const presentation=await page.locator('.canvas-world').evaluate(element=>({transform:element.style.transform,willChange:getComputedStyle(element).willChange,moving:element.dataset.cameraMoving}));
        const pixels=await page.screenshot({clip:bounds,caret:'hide'});
        const key=`${asset.id}-${zoom}-${sample++}`;
        const path=join(output,`${variant}-${key}.png`);await writeFile(path,pixels);

        if(variant==='original') captures.set(key,{pixels,bounds});
        else {
          const expected=captures.get(key);
          for(const dimension of ['width','height','x','y']) assert(Math.abs(bounds[dimension]-expected.bounds[dimension])<.01,`${key} ${dimension}`);
          const comparison=await decoder.evaluate(async({a,b})=>{
            const decode=async bytes=>{const image=await createImageBitmap(new Blob([new Uint8Array(bytes)],{type:'image/png'}));const canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;const context=canvas.getContext('2d');context.drawImage(image,0,0);return {width:canvas.width,height:canvas.height,data:context.getImageData(0,0,canvas.width,canvas.height).data}};
            const left=await decode(a),right=await decode(b);if(left.width!==right.width||left.height!==right.height)throw new Error('Screenshot dimensions changed');
            let changed=0,total=0,max=0,leftEdges=0,rightEdges=0;for(let i=0;i<left.data.length;i+=4){let diff=0;for(let c=0;c<3;c++){const d=Math.abs(left.data[i+c]-right.data[i+c]);diff=Math.max(diff,d);total+=d;max=Math.max(max,d)}if(diff>0)changed++}
            for(let y=0;y<left.height;y++)for(let x=0;x<left.width-1;x++){const i=(y*left.width+x)*4;for(let c=0;c<3;c++){leftEdges+=Math.abs(left.data[i+c]-left.data[i+4+c]);rightEdges+=Math.abs(right.data[i+c]-right.data[i+4+c]);}}
            return {edgeRatio:leftEdges?rightEdges/leftEdges:1,width:left.width,height:left.height,changed,changedRatio:changed/(left.width*left.height),meanChannelDifference:total/(left.width*left.height*3),max};
          },{a:[...expected.pixels],b:[...pixels]});
          const result={key,...comparison,presentation};results.push(result);console.log(JSON.stringify(result));
          assert.equal(presentation.willChange,'auto',`${key} uses current-scale native raster`);
          if (motion) assert.equal(presentation.moving, 'true', `${key} is sampled during camera motion`);
        }
      }
    } finally {await page.close();await server.close();await rm(root,{recursive:true,force:true})}
  }
} finally {await browser.close();await writeFile(join(output,'results.json'),JSON.stringify(results,null,2));console.log(`Quality evidence: ${output}`)}
assert(results.every(value=>value.meanChannelDifference <= .1 && value.edgeRatio >= .995),'Inspect differences in contrast and edge detail before accepting rendering quality.');
