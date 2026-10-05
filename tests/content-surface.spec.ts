import { test, expect } from '@playwright/test';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startServer } from '../src/server/http.js';

test('text and HTML controls stay interactive while blank content drags; documents have eight handles', async ({ page }, info) => {
  const root = await mkdtemp(join(tmpdir(), 'acanvas-content-drag-')), server = await startServer({ root, port: 0, webRoot: resolve('dist/web') });
  try {
    const { token } = await (await fetch(`${server.url}/api/bootstrap`)).json();
    const call = async (path: string, method = 'GET', body?: unknown) => { const response = await fetch(`${server.url}${path}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); expect(response.ok).toBeTruthy(); return response.json(); };
    const session = await call('/api/sessions', 'POST', { name: 'Content gestures' });
    for (const [index, name, mime, source] of [
      [0, 'Notes.md', 'text/markdown', '# Editable text\n\nA paragraph that can be selected and copied.'],
      [1, 'Buttons.html', 'text/html', '<style>body{margin:0;padding:24px;font:18px sans-serif}button{margin-top:16px}</style><h1>Editable words</h1><button onclick="this.textContent=\'Clicked\'">Choose</button>'],
    ] as const) {
      const upload = await fetch(`${server.url}/api/assets?name=${name}&mime=${mime}`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: source }); const asset = await upload.json();
      await call('/api/board/operations', 'POST', { sessionId: session.id, operations: [{ type: 'create', object: { assetId: asset.id, x: 100 + index * 520, y: 200, width: 400, height: 320 } }] });
    }
    await page.goto(`${server.url}/?session=${session.id}`);
    const state = () => call(`/api/state?sessionId=${session.id}`), md = page.getByRole('group', { name: 'Notes.md', exact: true }), html = page.locator('.board-object[data-content-kind="html"]');
    await expect(md.locator('h1')).toHaveText('Editable text'); await expect(page.locator('.object-drag-edge')).toHaveCount(0);
    const text = (await md.locator('h1').boundingBox())!, initial = await state();
    await page.mouse.move(text.x + 3, text.y + 12); await page.mouse.down(); await page.mouse.move(text.x + 150, text.y + 12, { steps: 6 }); await page.mouse.up();
    expect(await page.evaluate(() => getSelection()?.toString())).toContain('Editable'); expect((await state()).objects).toEqual(initial.objects);
    const drag = async (x: number, y: number, dx: number, dy: number, fromFrame = false) => { await page.keyboard.down('Alt'); await page.mouse.move(x, y); await page.mouse.down(); if (fromFrame) await expect(html.locator('.html-drag-capture')).toBeVisible(); await page.mouse.move(x + dx, y + dy, { steps: 10 }); await page.mouse.up(); await page.keyboard.up('Alt'); };
    let original = (await state()).objects[0]; const box = (await md.boundingBox())!;
    await drag(box.x + 10, box.y + 180, 45, 25);
    await expect.poll(async () => (await state()).objects[0].x).toBe(original.x + 45);
    const selectedMd = page.locator('.board-object[data-content-kind="markdown"]'); await expect(selectedMd.locator('.resize-handle')).toHaveCount(8);
    for (const handle of ['n', 'e', 's', 'w']) {
      original = (await state()).objects[0]; const h = (await selectedMd.locator(`[data-resize-corner="${handle}"]`).boundingBox())!;
      await drag(h.x + h.width / 2, h.y + h.height / 2, handle === 'w' ? -22 : 22, handle === 'n' ? -18 : 18);
      await expect.poll(async () => (await state()).objects[0].version).toBe(original.version + 1);
      const changed = (await state()).objects[0]; expect(changed.width).toBe(original.width + (['e','w'].includes(handle) ? 22 : 0)); expect(changed.height).toBe(original.height + (['n','s'].includes(handle) ? 18 : 0));
    }
    await expect(html.locator('.html-snapshot')).toHaveCount(1); await html.getByRole('button', { name: 'Interact with Buttons.html', exact: true }).click();
    await html.frameLocator('iframe').getByRole('button', { name: 'Choose', exact: true }).click(); await expect(html.frameLocator('iframe').getByRole('button', { name: 'Clicked', exact: true })).toBeVisible();
    const htmlWords = (await html.frameLocator('iframe').getByRole('heading').boundingBox())!;
    await page.mouse.move(htmlWords.x + 3, htmlWords.y + 12); await page.mouse.down(); await page.mouse.move(htmlWords.x + 230, htmlWords.y + 12, { steps: 6 }); await page.mouse.up();
    const contentFrame = page.frames().find(value => value.url().includes('/preview/'))!;
    expect(await contentFrame.evaluate(() => getSelection()?.toString())).toContain('Editable');
    expect((await state()).objects[1]).toEqual(initial.objects[1]);
    original = (await state()).objects[1]; const iframe = (await html.locator('iframe').boundingBox())!;
    await drag(iframe.x + 320, iframe.y + 260, 42, 26, true);
    await expect.poll(async () => (await state()).objects[1].x).toBe(original.x + 42);
    expect((await state()).objects[1].y).toBe(original.y + 26);
    await expect(page.locator('.board-object[data-content-kind="html"] .resize-handle')).toHaveCount(8);
    const frame = page.frames().find(value => value.url().includes('/preview/'))!; await html.frameLocator('iframe').getByRole('button', { name: 'Clicked', exact: true }).focus(); const beforeFake = await state();
    await frame.evaluate(() => parent.postMessage({ type: 'acanvas:preview-drag', instanceId: location.pathname.split('/').at(-1), pointerId: 1, x: .3, y: .3 }, '*'));
    await page.mouse.move(iframe.x + 250, iframe.y + 240); await page.waitForTimeout(80); expect((await state()).objects).toEqual(beforeFake.objects);
    await page.screenshot({ path: info.outputPath('content-drag-eight-handles.png') });
  } finally { await server.close(); await rm(root, { recursive: true, force: true }); }
});

test('standalone player draws the complete file before play and waveform clicks seek globally', async ({ page }, info) => {
  const root = await mkdtemp(join(tmpdir(), 'acanvas-audio-review-')), server = await startServer({ root, port: 0, webRoot: resolve('dist/web') });
  try {
    const { token } = await (await fetch(`${server.url}/api/bootstrap`)).json();
    const session = await (await fetch(`${server.url}/api/sessions`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Audio' }) })).json();
    const bytes = await readFile(resolve('tests/fixtures/amplitude-cover.m4a'));
    await fetch(`${server.url}/api/assets?name=Haze%20study.m4a&mime=audio/mp4`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: new Uint8Array(bytes) });
    await page.goto(`${server.url}/audio-review.html?session=${session.id}`);
    await expect(page.locator('.audio-player-waveform canvas')).toHaveAttribute('data-ready', 'true');
    await expect(page.locator('.audio-player-cover')).toBeVisible();
    const range = page.getByRole('slider', { name: 'Audio timeline' });
    const box = (await range.boundingBox())!;
    await page.mouse.click(box.x + box.width * .75, box.y + box.height / 2);
    await expect.poll(() => page.locator('audio').evaluate((media: HTMLAudioElement) => media.currentTime)).toBeGreaterThan(17.8);
    expect(await page.locator('audio').evaluate((media: HTMLAudioElement) => media.currentTime)).toBeLessThan(18.2);
    expect(await page.locator('audio').evaluate((media: HTMLAudioElement) => media.paused)).toBe(true);
    await range.press('Home'); await expect.poll(() => page.locator('audio').evaluate((media: HTMLAudioElement) => media.currentTime)).toBe(0);
    await page.locator('.audio-player-heading').click(); await page.locator('.audio-canvas-player').screenshot({ path: info.outputPath('audio-review-full-waveform.png') });
    await page.setViewportSize({ width: 390, height: 760 }); await expect(page.locator('.audio-canvas-player')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
    await expect(page.getByRole('button', { name: 'Close audio', exact: true })).toHaveCount(0);
  } finally { await server.close(); await rm(root, { recursive: true, force: true }); }
});
