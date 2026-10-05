import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
const compile = (path: string) => ts.transpileModule(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext } }).outputText.replace(/^export /gm, '');
const bridge = compile('src/shared/html-preview-snapshot.ts');
const rasterizer = compile('src/web/html-preview-snapshot.ts');
const origin = 'http://127.0.0.1:39991';
const prefix = `/preview/${'a'.repeat(43)}/files/`;
async function fixture(page: any, oversized = false, pseudo = false) {
  const fetches: string[] = [];
  const headers = { 'Access-Control-Allow-Origin': '*' };
  await page.route(`${origin}/**`, async (route: any) => {
    const url = new URL(route.request().url());
    if (route.request().resourceType() === 'fetch') fetches.push(url.pathname);
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<body></body>' });
    if (url.pathname.endsWith('red.svg')) return route.fulfill({ contentType: 'image/svg+xml', headers, body: '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" fill="red"/></svg>' });
    if (url.pathname.endsWith('green.svg')) return route.fulfill({ contentType: 'image/svg+xml', headers, body: '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" fill="lime"/></svg>' });
    if (url.pathname.endsWith('large.png')) return route.fulfill({ contentType: 'image/png', headers, body: Buffer.alloc(1024 * 1024 + 1, 32) });
    if (url.pathname.endsWith('pseudos.css')) return route.fulfill({ contentType: 'text/css', headers, body: '#pseudo{position:absolute;left:200px;top:100px;width:100px;height:50px;background:blue}#pseudo::before,#pseudo::after{content:"";position:absolute;top:0;width:50px;height:50px}#pseudo::before{left:0;background:red}#pseudo::after{left:50px;background:url(green.svg)}' });
    const body = `<script>${bridge};installHtmlSnapshotBridge('bundle','${origin}');</script>${pseudo ? '<link rel="stylesheet" href="pseudos.css">' : ''}<style>body{margin:0;background:url(red.svg)}img{display:block;width:100px;height:100px}#css{width:100px;height:100px;background:url(green.svg)}#outside{width:100px;height:100px;background:url(/preview/${'b'.repeat(43)}/files/secret.png)}</style><img src="${oversized ? 'large.png' : 'green.svg'}"><div id="css"></div><div id="outside"></div>${pseudo ? '<div id="pseudo"></div>' : ''}`;
    return route.fulfill({ contentType: 'text/html', body, headers: { 'Content-Security-Policy': `sandbox allow-scripts;default-src 'none';script-src 'unsafe-inline';style-src 'unsafe-inline' ${origin}${prefix};img-src data: ${origin}${prefix};connect-src ${origin}${prefix};` } });
  });
  await page.goto(`${origin}/`);
  await page.addScriptTag({ content: rasterizer });
  return fetches;
}
async function capture(page: any, pseudo = false) {
  return page.evaluate(async ({ url, pseudo }: { url: string; pseudo: boolean }) => {
    const frame = document.createElement('iframe'); frame.sandbox.add('allow-scripts'); frame.style.cssText = 'width:400px;height:300px'; frame.src = url;
    const loaded = new Promise<void>(resolve => { frame.onload = () => resolve(); }); document.body.append(frame); await loaded;
    const snapshot: any = await new Promise(resolve => {
      const receive = (event: MessageEvent) => { if (event.source === frame.contentWindow && event.origin === 'null' && event.data.requestId === 'capture-1') { window.removeEventListener('message', receive); resolve(event.data); } };
      window.addEventListener('message', receive); frame.contentWindow!.postMessage({ type: 'acanvas:preview-snapshot', instanceId: 'bundle', requestId: 'capture-1' }, '*');
    });
    if (snapshot.type.endsWith('-error')) { frame.remove(); return snapshot; }
    const png = await (window as any).rasterizeHtmlSnapshot(snapshot); frame.remove();
    const image = new Image(); image.src = png.url; await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = 400; canvas.height = 300; const ctx = canvas.getContext('2d')!; ctx.drawImage(image, 0, 0);
    const pixel = (x: number, y: number) => [...ctx.getImageData(x, y, 1, 1).data];
    return { type: snapshot.type, image: pixel(50, 50), background: pixel(200, 200), css: pixel(50, 150), leaks: snapshot.svg.includes('secret.png'), ...(pseudo ? { before: pixel(220, 120), after: pixel(270, 120) } : {}) };
  }, { url: `${origin}${prefix}index.html`, pseudo });
}
test('bundle images and CSS backgrounds survive rasterization without fetching other grants', async ({ page }) => {
  const fetches = await fixture(page);
  expect(await capture(page)).toEqual({ type: 'acanvas:preview-snapshot', image: [0,255,0,255], background: [255,0,0,255], css: [0,255,0,255], leaks: false });
  expect(fetches.sort()).toEqual([`${prefix}green.svg`, `${prefix}red.svg`]);
});
test('bundle image bytes are bounded', async ({ page }) => {
  await fixture(page, true);
  expect(await capture(page)).toMatchObject({ type: 'acanvas:preview-snapshot-error', error: 'Preview snapshot images are too large.' });
});
test('external stylesheet pseudo-elements retain their layout and image backgrounds in snapshots', async ({ page }) => {
  await fixture(page, false, true);
  expect(await capture(page, true)).toMatchObject({ type: 'acanvas:preview-snapshot', before: [255, 0, 0, 255], after: [0, 255, 0, 255] });
});
