import { test, expect } from '@playwright/test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { startServer } from '../src/server/http.js';
const execute = promisify(execFile);

test('CLI bundle appears without reload with nested CSS, module JS and snapshot images, then survives source removal and restart', async ({ page }) => {
  const root = await mkdtemp(join(tmpdir(), 'acanvas-bundle-ui-')), source = await mkdtemp(join(tmpdir(), 'acanvas-bundle-ui-source-'));
  let server = await startServer({ root, port: 0, webRoot: resolve('dist/web') });
  const cli = async (args: string[]) => JSON.parse((await execute(resolve('.runtime/node_modules/node/bin/node'), [resolve('dist/src/cli.js'), ...args, '--project', root, '--url', server.url])).stdout);
  try {
    const session = await cli(['session', 'create', '--name', 'Bundle']);
    await page.goto(`${server.url}/?session=${session.id}`);
    await expect(page.locator('.composer')).toBeVisible();
    let navigations = 0; page.on('request', request => { if (request.isNavigationRequest() && request.frame() === page.mainFrame()) navigations++; });
    const png = await page.evaluate(() => { const c = document.createElement('canvas'); c.width = c.height = 8; const context = c.getContext('2d')!; context.fillStyle = 'rgb(240,30,50)'; context.fillRect(0, 0, 8, 8); return c.toDataURL().split(',')[1]; });
    await mkdir(join(source, 'css')); await mkdir(join(source, 'images')); await mkdir(join(source, 'js'));
    await writeFile(join(source, 'images/tile.png'), Buffer.from(png, 'base64'));
    await writeFile(join(source, 'index.html'), '<!doctype html><link rel="stylesheet" href="css/main.css"><img src="images/tile.png"><div id="background"></div><p id="result">Pending</p><script type="module" src="js/main.mjs"></script>');
    await writeFile(join(source, 'css/main.css'), '@import "nested.css"; body{margin:0;background:rgb(10,20,30)}img,#background{display:block;width:50px;height:50px}#background{background:url(../images/tile.png)}');
    await writeFile(join(source, 'css/nested.css'), '#result{color:rgb(1,120,230)}');
    await writeFile(join(source, 'js/main.mjs'), 'import {message} from "./message.mjs";document.querySelector("#result").textContent=message;');
    await writeFile(join(source, 'js/message.mjs'), 'export const message="Module ready";');
    const imported = await cli(['asset', 'import', '--file', join(source, 'index.html'), '--bundle-root', source]);
    await writeFile(join(root, 'ops.json'), JSON.stringify({ operations: [{ type: 'create', object: { assetId: imported.id, x: 50, y: 50, width: 320, height: 240 } }] }));
    const start = Date.now(); await cli(['board', 'operations', '--session', session.id, '--input', join(root, 'ops.json')]);
    await expect(page.locator('.board-object')).toHaveCount(1); const appearedMs = Date.now() - start;
    await expect(page.locator('.html-snapshot')).toBeVisible(); expect(navigations).toBe(0);
    const pixels = await page.locator('.html-snapshot').evaluate(async element => { const image = element as HTMLImageElement; await image.decode(); const c = document.createElement('canvas'); c.width = image.naturalWidth; c.height = image.naturalHeight; const context = c.getContext('2d')!; context.drawImage(image, 0, 0); return [context.getImageData(20, 20, 1, 1).data, context.getImageData(20, 70, 1, 1).data, context.getImageData(200, 150, 1, 1).data].map(value => [...value]); });
    expect(pixels).toEqual([[240, 30, 50, 255], [240, 30, 50, 255], [10, 20, 30, 255]]);
    await page.getByRole('button', { name: 'Interact with index.html' }).click();
    const frame = page.frameLocator('.html-live-frame');
    await expect(frame.locator('#result')).toHaveText('Module ready'); await expect(frame.locator('#result')).toHaveCSS('color', 'rgb(1, 120, 230)');
    await rm(source, { recursive: true, force: true });
    await server.close(); server = await startServer({ root, port: 0, webRoot: resolve('dist/web') });
    await page.goto(`${server.url}/?session=${session.id}`); await expect(page.locator('.html-snapshot')).toBeVisible();
    await page.getByRole('button', { name: 'Interact with index.html' }).click(); await expect(page.frameLocator('.html-live-frame').locator('#result')).toHaveText('Module ready');
    const evidence = process.env.HTML_BUNDLE_EVIDENCE_DIR;
    const metrics = { appearedMs, navigationsBeforeRestart: 0, bundleFiles: Object.keys(imported.htmlBundle.files).length, pixels, persistedAfterSourceRemoval: true };
    if (evidence) { await mkdir(evidence, { recursive: true }); await page.screenshot({ path: join(evidence, 'bundle-after-restart.png') }); await writeFile(join(evidence, 'bundle-validation.json'), JSON.stringify(metrics, null, 2) + '\n'); }
    console.log(JSON.stringify(metrics));
  } finally { await server.close(); await rm(root, { recursive: true, force: true }); await rm(source, { recursive: true, force: true }); }
});
