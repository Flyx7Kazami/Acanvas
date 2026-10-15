import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const compile = (path: string) => ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext } }).outputText.replace(/^export /gm, '');
const bridge = compile('../src/shared/html-preview-snapshot.ts');
const rasterizer = compile('../src/web/html-preview-snapshot.ts');

test('isolated rendered content becomes a frozen PNG including canvas and current form state', async ({ page }) => {
  await page.route('http://127.0.0.1:39991/**', route => route.fulfill({ contentType: 'text/html', body: '<body></body>' }));
  await page.goto('http://127.0.0.1:39991/');
  await page.addScriptTag({ content: rasterizer });
  const result = await page.evaluate(async bridgeSource => {
    const frame = document.createElement('iframe'); frame.sandbox.add('allow-scripts'); frame.style.cssText = 'width:400px;height:300px';
    frame.srcdoc = `<script>${bridgeSource};installHtmlSnapshotBridge('test-instance',location.ancestorOrigins[0]);<\/script><style>body{margin:0;background:white}#title{height:50px;background:rgb(255,0,0);color:white;font:20px sans-serif}canvas{display:block}input{font:20px sans-serif;width:250px}</style><div id="title"></div><canvas width="100" height="80"></canvas><input value="old"><script>document.querySelector('#title').textContent='Rendered blog';const c=document.querySelector('canvas').getContext('2d');c.fillStyle='rgb(0,255,0)';c.fillRect(0,0,100,80);document.querySelector('input').value='Edited current value';<\/script>`;
    const loaded = new Promise<void>(resolve => { frame.onload = () => resolve(); }); document.body.append(frame); await loaded;
    const snapshot: any = await new Promise(resolve => {
      const receive = (event: MessageEvent) => { if (event.source === frame.contentWindow && event.origin === 'null' && event.data.instanceId === 'test-instance' && event.data.requestId === 'capture-1') { window.removeEventListener('message', receive); resolve(event.data); } };
      window.addEventListener('message', receive); frame.contentWindow!.postMessage({ type: 'acanvas:preview-snapshot', instanceId: 'test-instance', requestId: 'capture-1' }, '*');
    });
    const png = await (window as any).rasterizeHtmlSnapshot(snapshot); frame.remove();
    const image = new Image(); image.src = png.url; await image.decode(); document.body.append(image);
    const canvas = document.createElement('canvas'); canvas.width = 400; canvas.height = 300; const ctx = canvas.getContext('2d')!; ctx.drawImage(image, 0, 0);
    const pixel = (x: number, y: number) => [...ctx.getImageData(x, y, 1, 1).data];
    const pixels = ctx.getImageData(3, 132, 240, 23).data; let formInk = 0; for (let i = 0; i < pixels.length; i += 4) if (pixels[i] < 100 && pixels[i + 1] < 100 && pixels[i + 2] < 100 && pixels[i + 3] > 200) formInk++;
    return { type: snapshot.type, currentValue: snapshot.svg.includes('Edited current value'), oldValue: snapshot.svg.includes('value="old"'), red: pixel(300, 30), green: pixel(50, 100), formInk, prefix: png.url.slice(0, 22) };
  }, bridge);
  expect(result).toMatchObject({ type: 'acanvas:preview-snapshot', currentValue: true, oldValue: false, red: [255, 0, 0, 255], green: [0, 255, 0, 255], prefix: 'data:image/png;base64,' });
  expect(result.formInk).toBeGreaterThan(150);
});

test('image-only conversion blocks script/network effects and rejects forged dimensions', async ({ page }) => {
  const requests: string[] = [];
  await page.route('http://127.0.0.1:39991/**', route => route.fulfill({ contentType: 'text/html', body: '<body></body>' }));
  await page.goto('http://127.0.0.1:39991/');
  page.on('request', request => requests.push(request.url()));
  await page.addScriptTag({ content: rasterizer });
  const result = await page.evaluate(async () => {
    const raster = (window as any).rasterizeHtmlSnapshot;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><script>parent.compromised=true;fetch('https://example.invalid/script')</script><foreignObject width="100" height="100"><div xmlns="http://www.w3.org/1999/xhtml" style="background:red;width:100px;height:100px"><img src="https://example.invalid/image" onerror="parent.compromised=true"/><style>@import url('https://example.invalid/style');</style></div></foreignObject></svg>`;
    const image = await raster({ svg, width: 100, height: 100 });
    const outcomes = [];
    for (const source of [svg.replace('width="100"', 'width="999999999"'), svg.replace('width="100"', 'viewBox="0 0 99999 99999" width="100"'), svg.replace('width="100"', 'style="width:999999px" width="100"')]) {
      try { await raster({ svg: source, width: 100, height: 100 }); outcomes.push('accepted'); } catch { outcomes.push('rejected'); }
    }
    const control = new AbortController(); control.abort();
    let aborted = false; try { await raster({ svg, width: 100, height: 100 }, control.signal); } catch (error) { aborted = (error as Error).name === 'AbortError'; }
    return { png: image.url.startsWith('data:image/png;base64,'), compromised: !!(window as any).compromised, outcomes, aborted };
  });
  expect(result).toEqual({ png: true, compromised: false, outcomes: ['rejected', 'rejected', 'rejected'], aborted: true });
  expect(requests).toEqual([]);
});

test('short HTML backgrounds fill the snapshot viewport without changing body layout', async ({ page }) => {
  await page.route('http://127.0.0.1:39991/**', route => route.fulfill({ contentType: 'text/html', body: '<body></body>' }));
  await page.goto('http://127.0.0.1:39991/');
  await page.addScriptTag({ content: rasterizer });
  const result = await page.evaluate(async bridgeSource => {
    const outputs = [];
    for (const rootBackground of ['html{background:rgba(255,255,255,0)}', 'html{background:rgb(0,200,50)}']) {
      const frame = document.createElement('iframe'); frame.sandbox.add('allow-scripts'); frame.style.cssText = 'width:400px;height:300px';
      frame.srcdoc = `<script>${bridgeSource};installHtmlSnapshotBridge('background-instance',location.ancestorOrigins[0]);<\/script><style>${rootBackground}body{margin:0;display:flex;align-items:center;justify-content:center;background-color:rgb(240,40,80);background-image:linear-gradient(rgb(20,120,200),rgb(20,120,200))}button{height:25px;width:80px;background:rgb(255,255,0);border:0}</style><button></button>`;
      const loaded = new Promise<void>(resolve => { frame.onload = () => resolve(); }); document.body.append(frame); await loaded;
      const snapshot: any = await new Promise(resolve => {
        const receive = (event: MessageEvent) => { if (event.source === frame.contentWindow && event.origin === 'null' && event.data.requestId === 'background-1') { window.removeEventListener('message', receive); resolve(event.data); } };
        window.addEventListener('message', receive); frame.contentWindow!.postMessage({ type: 'acanvas:preview-snapshot', instanceId: 'background-instance', requestId: 'background-1' }, '*');
      });
      const png = await (window as any).rasterizeHtmlSnapshot(snapshot); frame.remove();
      const image = new Image(); image.src = png.url; await image.decode();
      const canvas = document.createElement('canvas'); canvas.width = 400; canvas.height = 300; const ctx = canvas.getContext('2d')!; ctx.drawImage(image, 0, 0);
      const pixel = (x: number, y: number) => [...ctx.getImageData(x, y, 1, 1).data];
      outputs.push({ viewport: pixel(50, 100), body: pixel(50, 10), button: pixel(200, 10) });
    }
    return outputs;
  }, bridge);
  expect(result).toEqual([
    { viewport: [20, 120, 200, 255], body: [20, 120, 200, 255], button: [255, 255, 0, 255] },
    { viewport: [0, 200, 50, 255], body: [20, 120, 200, 255], button: [255, 255, 0, 255] },
  ]);
});
