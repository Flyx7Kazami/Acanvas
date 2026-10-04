import { test as base, expect } from '@playwright/test';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startServer } from '../src/server/http.js';
import type { HtmlPreviewGrant } from '../src/server/html-preview.js';

const test = base.extend<{ preview: { url: string; sink: string; hits: string[]; issue: (source: string, parent?: string) => Promise<HtmlPreviewGrant>; state: () => Promise<unknown> } }>({
  preview: async ({}, use) => {
    const root = await mkdtemp(join(tmpdir(), 'acanvas-preview-browser-'));
    const web = await mkdtemp(join(tmpdir(), 'acanvas-preview-parent-'));
    await writeFile(join(web, 'index.html'), '<!doctype html><html><head><title>Preview security fixture</title><script src="/controls.js" defer></script></head><body><button id="stop">Stop preview</button><button id="exit">Exit interaction</button><output id="status"></output><div id="frames"></div></body></html>');
    await writeFile(join(web, 'controls.js'), `let active;window.openPreview=grant=>{active?.frame.remove();const frame=document.createElement('iframe');frame.id='preview';frame.title='Isolated preview';frame.sandbox='allow-scripts';frame.referrerPolicy='no-referrer';frame.src=grant.url;active={frame,grant};document.querySelector('#frames').append(frame);};window.addEventListener('message',event=>{if(event.source!==active?.frame.contentWindow||event.origin!=='null'||event.data?.instanceId!==active.grant.id)return;if(event.data.type==='acanvas:preview-ready')document.querySelector('#status').textContent='Ready';if(event.data.type==='acanvas:preview-exit')document.querySelector('#status').textContent='Exited';});document.querySelector('#stop').onclick=()=>{active?.frame.remove();active=undefined;document.querySelector('#status').textContent='Stopped';};document.querySelector('#exit').onclick=()=>document.querySelector('#status').textContent='Exited';`);
    const running = await startServer({ root, port: 0, webRoot: web });
    const hits: string[] = [], sinkServer = createServer((request, response) => { hits.push(request.url ?? ''); response.end('untrusted network target'); });
    await new Promise<void>(resolvePromise => sinkServer.listen(0, '127.0.0.1', resolvePromise));
    const sink = `http://127.0.0.1:${(sinkServer.address() as AddressInfo).port}`;
    const token = (await (await fetch(`${running.url}/api/bootstrap`)).json()).token;
    const issue = async (source: string, parent = running.url): Promise<HtmlPreviewGrant> => {
      const upload = await fetch(`${running.url}/api/assets?name=widget.html&mime=text/html`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: source });
      expect(upload.status).toBe(201); const asset = await upload.json();
      const response = await fetch(`${parent}/api/assets/${asset.id}/html-preview`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: '{}' });
      expect(response.status).toBe(201); return response.json();
    };
    const state = async () => {
      const sessions = await (await fetch(`${running.url}/api/sessions`, { headers: { Authorization: `Bearer ${token}` } })).json();
      return sessions.length ? (await fetch(`${running.url}/api/state?sessionId=${sessions[0].id}`, { headers: { Authorization: `Bearer ${token}` } })).json() : sessions;
    };
    try { await use({ url: running.url, sink, hits, issue, state }); }
    finally { await running.close(); const stopped = new Promise<void>(resolvePromise => sinkServer.close(() => resolvePromise())); sinkServer.closeAllConnections(); await stopped; await rm(root, { recursive: true, force: true }); await rm(web, { recursive: true, force: true }); }
  },
});

test('inline HTML works while sandbox blocks parent, cookies, API, files, network, forms, popup and navigation', async ({ page, preview }, info) => {
  await page.goto(preview.url); await page.request.get(`${preview.url}/api/bootstrap`);
  await page.evaluate(() => localStorage.setItem('preview-test-private', 'trusted-parent'));
  const grant = await preview.issue(`<style>body{font:16px sans-serif}button{padding:12px}</style><button id="count">Count</button><output id="value">0</output><button id="navigate">Navigate</button><script>
    document.querySelector('#count').onclick=()=>document.querySelector('#value').textContent=Number(document.querySelector('#value').textContent)+1;
    document.querySelector('#navigate').onclick=()=>location.href=${JSON.stringify(`${preview.sink}/frame-navigation`)};
    const result={};const blocked=(name,action)=>{try{action();result[name]=false;}catch{result[name]=true;}};
    blocked('parentDOM',()=>parent.document.body.innerHTML='changed');blocked('parentStorage',()=>parent.localStorage.getItem('preview-test-private'));blocked('cookie',()=>document.cookie);blocked('topNavigation',()=>top.location.href=${JSON.stringify(`${preview.sink}/top-navigation`)});
    result.popup=window.open(${JSON.stringify(`${preview.sink}/popup`)})===null;
    const image=new Image();image.src=${JSON.stringify(`${preview.sink}/image`)};document.body.append(image);
    const form=document.createElement('form');form.method='post';form.action=${JSON.stringify(`${preview.sink}/form`)};document.body.append(form);form.submit();
    const download=document.createElement('a');download.href='data:text/plain,private';download.download='sandbox-test.txt';document.body.append(download);download.click();
    Promise.all([['mainAPI',${JSON.stringify(`${preview.url}/api/bootstrap`)}],['mainWrite',${JSON.stringify(`${preview.url}/api/sessions`)}],['network',${JSON.stringify(`${preview.sink}/fetch`)}],['files','file:///etc/passwd']].map(async([name,url])=>{try{await fetch(url,{credentials:'include',...(name==='mainWrite'?{method:'POST',body:'{}'}:{})});result[name]=false;}catch{result[name]=true;}})).then(()=>window.attackResults=result);
  </script>`);
  expect(await page.context().cookies(grant.url)).toEqual([]);
  const before = await preview.state(), downloads: string[] = []; page.on('download', download => downloads.push(download.suggestedFilename()));
  await page.evaluate(value => (window as any).openPreview(value), grant); await expect(page.locator('#status')).toHaveText('Ready');
  const frame = page.frameLocator('#preview'); await frame.locator('#count').click(); await expect(frame.locator('#value')).toHaveText('1');
  const content = page.frames().find(value => value.url() === grant.url)!;
  await expect.poll(() => content.evaluate(() => (window as any).attackResults)).toEqual({ parentDOM: true, parentStorage: true, cookie: true, topNavigation: true, popup: true, mainAPI: true, mainWrite: true, network: true, files: true });
  await frame.locator('#count').focus(); await page.keyboard.press('Escape'); await expect(page.locator('#status')).toHaveText('Exited');
  await page.screenshot({ path: info.outputPath('html-isolated-script-and-external-controls.png') });
  await frame.locator('#navigate').click(); await page.waitForTimeout(250);
  expect(content.url()).toBe('chrome-error://chromewebdata/'); expect(preview.hits).toEqual([]); expect(downloads).toEqual([]); expect(await preview.state()).toEqual(before);
  await page.getByRole('button', { name: 'Stop preview', exact: true }).click(); await expect(page.locator('#preview')).toHaveCount(0);
  const topLevel = await page.context().newPage(); const response = await topLevel.goto(grant.url); expect(response?.status()).toBe(403); await expect(topLevel.locator('body')).not.toContainText('Count'); await topLevel.close();
});

test('main page metadata and CSP pin the exact preview origin, including the localhost parent', async ({ page, preview }) => {
  const main = preview.url.replace('127.0.0.1', 'localhost');
  const response = await page.goto(main); const metadata = await page.locator('meta[name=acanvas-html-preview-origin]').getAttribute('content');
  expect(metadata).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/); expect(response?.headers()['content-security-policy']).toContain(`frame-src ${metadata};`);
  const grant = await preview.issue('<button id="works">Works</button>');
  // This grant belongs to the 127.0.0.1 parent and its frame-ancestors policy excludes the localhost parent.
  expect(grant.origin).not.toBe(metadata);
  await page.evaluate(value => (window as any).openPreview(value), grant); await page.waitForTimeout(150);
  await expect(page.locator('#status')).not.toHaveText('Ready');
  const correct = await preview.issue('<button id="works">Works</button>', main); expect(correct.origin).toBe(metadata);
  await page.evaluate(value => (window as any).openPreview(value), correct); await expect(page.locator('#status')).toHaveText('Ready');
  await expect(page.frameLocator('#preview').getByRole('button', { name: 'Works' })).toBeVisible();
});

test.describe('runaway script responsiveness', () => {
test('external Stop stays responsive to an isolated script loop', async ({ page, preview }, info) => {
  await page.goto(preview.url);
  const grant = await preview.issue('<p>Running local script</p><script>setTimeout(()=>{while(true){}},100)</script>');
  await page.evaluate(value => (window as any).openPreview(value), grant); await expect(page.locator('#status')).toHaveText('Ready');
  await new Promise(resolvePromise => setTimeout(resolvePromise, 250));
  const start = performance.now(); await page.getByRole('button', { name: 'Stop preview', exact: true }).click({ timeout: 5000 }); await expect(page.locator('#preview')).toHaveCount(0);
  const elapsed = performance.now() - start; expect(elapsed).toBeLessThan(5000);
  await writeFile(info.outputPath('html-stop-responsiveness.json'), JSON.stringify({ elapsedMs: elapsed, browser: 'Chrome', result: 'PASS', trace: 'off to measure parent controls without child snapshot instrumentation', securityFlags: 'standard Chrome channel defaults', scope: 'one isolated synchronous loop; no general CPU or memory quota' }, null, 2));
});
});
