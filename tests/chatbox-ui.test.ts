import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect } from '@playwright/test';
import type { Page } from 'playwright-core';
import { startServer } from '../src/server/http.js';
import type { AnnotationInput, Asset, BoardObject } from '../src/shared/types.js';

async function fixture(t: test.TestContext, narrow = false) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'acanvas-chatbox-ui-')));
  const evidence = await realpath(await mkdtemp(join(tmpdir(), 'acanvas-chatbox-evidence-'))); t.diagnostic(`Evidence: ${evidence}`);
  const running = await startServer({ root, port: 0, webRoot: resolve('dist/web'), browser: { headless: true } });
  const session = running.service.createSession('Chatbox acceptance');
  await running.browser.open(session.id);
  const page = running.browser.page(session.id)!;
  if (narrow) await page.setViewportSize({ width: 320, height: 700 });
  await expect(page.locator('#whiteboard')).toBeVisible();
  await expect(page.locator('.composer')).toHaveAttribute('data-save-state', 'saved');
  const bootstrap = await (await fetch(`${running.url}/api/bootstrap`)).json();
  const call = async (path: string, method = 'GET', body?: unknown) => {
    const response = await fetch(`${running.url}${path}`, { method, headers: { Authorization: `Bearer ${bootstrap.token}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const result = await response.json(); assert(response.ok, JSON.stringify(result)); return result;
  };
  const importAsset = async (name: string, mime: string, data: Uint8Array) => {
    const response = await fetch(`${running.url}/api/assets?name=${encodeURIComponent(name)}&mime=${encodeURIComponent(mime)}`, { method: 'POST', headers: { Authorization: `Bearer ${bootstrap.token}` }, body: data as BodyInit });
    assert(response.ok); return response.json() as Promise<Asset>;
  };
  const image = async (name = 'Reference.png') => {
    const data = await page.evaluate(() => { const canvas = document.createElement('canvas'); canvas.width = 400; canvas.height = 240; const context = canvas.getContext('2d')!; context.fillStyle = '#e4e7ee'; context.fillRect(0, 0, 400, 240); context.fillStyle = '#24456d'; context.fillRect(50, 40, 300, 160); return canvas.toDataURL('image/png').split(',')[1]; });
    return importAsset(name, 'image/png', Buffer.from(data, 'base64'));
  };
  const object = async (asset: Asset, bounds = { x: 400, y: 300, width: 300, height: 180 }) => {
    const before = running.service.objects().map(value => value.id);
    await call('/api/board/operations', 'POST', { sessionId: session.id, operations: [{ type: 'create', object: { assetId: asset.id, ...bounds } }] });
    const value = running.service.objects().find(item => !before.includes(item.id))!;
    await expect(page.locator(`[data-object-id="${value.id}"]`)).toBeVisible(); return value;
  };
  const saved = async () => { await expect(page.locator('.composer')).toHaveAttribute('data-save-state', 'saved'); return running.service.draft(session.id); };
  const select = async (value: BoardObject) => { await page.locator(`[data-object-id="${value.id}"]`).focus(); await page.keyboard.press('Enter'); };
  const mark = async (start: { x: number; y: number }, end?: { x: number; y: number }) => {
    await page.getByRole('button', { name: 'Mark canvas', exact: true }).click();
    await page.mouse.move(start.x, start.y); await page.mouse.down(); if (end) await page.mouse.move(end.x, end.y); await page.mouse.up();
    await expect(page.getByRole('textbox', { name: 'Add a comment', exact: true })).toBeVisible();
  };
  const done = async (text: string) => {
    await page.getByRole('textbox', { name: 'Add a comment', exact: true }).fill(text);
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    try { await expect(page.locator('.draft-annotation').last()).toHaveAttribute('data-capture-state', 'complete', { timeout: 15_000 }); }
    catch (cause) { t.diagnostic(await page.locator('.draft-annotation').last().innerText()); throw cause; }
    return (await saved()).annotations.at(-1)!;
  };
  t.after(async () => {
    if (!page.isClosed()) {
      await page.screenshot({ path: join(evidence, 'final-ui.png') }); const state = running.service.state(session.id);
      await writeFile(join(evidence, 'state.json'), JSON.stringify(state, null, 2));
      const annotations = [...state.draft.annotations, ...state.tasks.flatMap(task => task.snapshot.annotations)];
      for (const [index, annotation] of annotations.entries()) if (annotation.capture) { const bytes = await readFile(running.service.assetPath(annotation.capture.screenshotAssetId)).catch(() => undefined); if (bytes) await writeFile(join(evidence, `capture-${index + 1}.png`), bytes); }
    }
    await running.close(); await rm(root, { recursive: true, force: true });
  });
  return { root, evidence, running, session, page, call, importAsset, image, object, saved, select, mark, done, state: () => running.service.state(session.id) };
}

test('chatbox selection previews are consumed by real input focus, Escape and direct reference-only Send', async t => {
  const app = await fixture(t), { page } = app;
  const asset = await app.image(), first = await app.object(asset), second = await app.object(asset, { x: 770, y: 300, width: 300, height: 180 });
  await app.select(first); await expect(page.locator('[data-reference-preview]')).toBeVisible();
  assert.deepEqual((await app.saved()).references.objectIds, []);
  await page.locator('#instruction').evaluate(element => (element as HTMLTextAreaElement).focus());
  assert.deepEqual((await app.saved()).references.objectIds, []);
  await page.locator('#instruction').evaluate(element => { (element as HTMLTextAreaElement).blur(); window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab' })); (element as HTMLTextAreaElement).focus(); });
  assert.deepEqual((await app.saved()).references.objectIds, []);
  await page.locator('#instruction').click(); await expect(page.locator('.chatbox-reference')).toHaveCount(1);
  await page.getByRole('button', { name: 'Remove reference Reference.png', exact: true }).click();
  await expect(page.locator('[data-reference-preview]')).toHaveCount(0); await expect(page.locator('.chatbox-reference')).toHaveCount(0);
  await app.select(first); await page.locator('#whiteboard').focus(); await page.keyboard.press('Escape');
  await expect(page.locator('[data-reference-preview]')).toHaveCount(0);
  await app.select(first); await app.select(second); await page.getByRole('button', { name: 'Send request', exact: true }).click();
  await expect(page.locator('.queue-item')).toHaveCount(1);
  const task = app.state().tasks[0]; assert.deepEqual(task.snapshot.requestReferences?.objectIds, [second.id]); assert.deepEqual(task.snapshot.requestReferences?.attachmentIds, []);
  assert.equal(task.snapshot.userRequest.text, ''); assert.match(task.requirementText, /Reference\.png/);
  await app.select(first); await page.locator('.composer-more').focus(); await page.keyboard.press('Tab');
  await expect(page.locator('.chatbox-reference')).toHaveCount(1);
});

test('chatbox @ search orders object and task identities and keeps IME, paste and attachment semantics', async t => {
  const app = await fixture(t), { page } = app;
  const asset = await app.image('Shared asset.png'), first = await app.object(asset), second = await app.object(asset, { x: 780, y: 300, width: 300, height: 180 });
  await page.locator('#instruction').fill('Earlier request'); await page.getByRole('button', { name: 'Send request', exact: true }).click(); await expect(page.locator('.queue-item')).toHaveCount(1);
  await page.locator('#instruction').fill('@Request'); await page.keyboard.press('Enter');
  await page.locator('#instruction').fill('@Shared'); await page.keyboard.press('Enter');
  await page.locator('#instruction').fill('@Shared'); await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter');
  const draft = await app.saved(); assert.deepEqual(draft.references.order, [{ kind: 'task', id: app.state().tasks[0].id }, { kind: 'object', id: first.id }, { kind: 'object', id: second.id }]);
  assert.deepEqual(draft.attachments, []); assert.equal(draft.text, '');
  await page.locator('#instruction').fill('Literal @unknown name'); await page.keyboard.press('Escape');
  await page.locator('#instruction').dispatchEvent('compositionstart'); await page.locator('#instruction').dispatchEvent('keydown', { key: 'Enter', keyCode: 229, isComposing: true });
  assert.equal(app.state().tasks.length, 1); await page.locator('#instruction').dispatchEvent('compositionend');
  await page.locator('#instruction').dispatchEvent('paste'); await page.keyboard.press('Escape'); await page.getByRole('button', { name: 'Send request', exact: true }).click();
  await expect(page.locator('.queue-item')).toHaveCount(2); assert.equal(app.state().tasks[1].snapshot.userRequest.text, 'Literal @unknown name');
  assert.deepEqual(app.state().tasks[1].snapshot.requestReferences?.order?.map(value => `${value.kind}:${value.id}`), draft.references.order?.map(value => `${value.kind}:${value.id}`));
});

test('managed React Done captures blank points, cross-object regions and historical scenes with separate current locate', async t => {
  const app = await fixture(t), { page } = app;
  const object = await app.object(await app.image());
  await app.mark({ x: 950, y: 450 }); const blank = await app.done('Blank space');
  assert.equal(blank.scope, 'region'); assert.equal(blank.geometry, 'point'); assert.equal(blank.bounds.width, 0); assert(blank.capture); assert.equal(blank.capture.scene.objects.length, 0);
  await app.mark({ x: 380, y: 340 }, { x: 520, y: 410 }); const cross = await app.done('Across one boundary');
  assert.equal(cross.scope, 'region'); assert.deepEqual(cross.objectIds, []); assert(cross.capture?.scene.objects.some(value => value.object.id === object.id)); assert.deepEqual((await app.saved()).references.objectIds, []);
  await app.mark({ x: 520, y: 360 }); const target = await app.done('On the image'); assert.equal(target.objectId, object.id); assert.equal(target.geometry, 'point');
  const png = await fetch(`${app.running.url}/api/assets/${target.capture!.screenshotAssetId}/content?sessionId=${app.session.id}`, { headers: { Authorization: `Bearer ${(await (await fetch(`${app.running.url}/api/bootstrap`)).json()).token}` } });
  assert(png.ok); assert.equal(png.headers.get('content-type'), 'image/png'); assert((await png.arrayBuffer()).byteLength > 500);
  await page.getByRole('button', { name: 'Send request', exact: true }).click(); await expect(page.locator('.queue-item')).toHaveCount(1); await expect(page.locator('.annotation-outline')).toHaveCount(0);
  await page.getByRole('button', { name: /View request 1:/ }).click();
  await page.getByRole('button', { name: 'View annotation 3: On the image', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Captured annotation', exact: true })).toBeVisible(); await expect(page.locator('.annotation-outline')).toHaveCount(0);
  await page.getByRole('button', { name: 'Locate current target', exact: true }).click();
  assert.equal(app.state().tasks[0].snapshot.annotations[2].capture?.id, target.capture?.id);
});

test('managed React target edits require a new capture while text edits preserve the original image', async t => {
  const app = await fixture(t), { page } = app;
  const object = await app.object(await app.image()); await app.mark({ x: 520, y: 360 }); const original = await app.done('Original comment');
  await page.locator('.draft-annotation .annotation-content').click(); await page.getByRole('textbox', { name: 'Annotation text', exact: true }).fill('Edited words');
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  const textOnly = (await app.saved()).annotations[0]; assert.equal(textOnly.capture?.id, original.capture?.id); assert.equal(textOnly.captureState?.version, 1);
  await page.locator('.draft-annotation .annotation-content').click();
  await page.getByRole('combobox', { name: 'Annotation target', exact: true }).selectOption('');
  await expect(page.locator('.draft-annotation')).toHaveAttribute('data-capture-state', 'incomplete'); await expect(page.getByRole('button', { name: 'Send request', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Done', exact: true }).click(); await expect(page.locator('.draft-annotation')).toHaveAttribute('data-capture-state', 'complete');
  const retargeted = (await app.saved()).annotations[0]; assert.equal(retargeted.captureState?.version, 2); assert.notEqual(retargeted.capture?.id, original.capture?.id); assert.equal(retargeted.scope, 'region'); assert.deepEqual(retargeted.objectIds, []);
  assert(retargeted.capture?.scene.objects.some(value => value.object.id === object.id));
  await page.reload(); await expect(page.locator('.draft-annotation')).toHaveAttribute('data-capture-state', 'complete'); assert.equal((await app.saved()).annotations[0].text, 'Edited words');
});

test('managed React delayed saves retain the newer target and capture cancellation invalidates late screenshots', async t => {
  const app = await fixture(t), { page } = app;
  const asset = await app.image(); const first = await app.object(asset), second = await app.object(asset);
  await app.mark({ x: 520, y: 360 }); await app.done('Stable words');
  let releaseSave!: () => void, enteredSave!: () => void;
  const held = new Promise<void>(resolve => releaseSave = resolve), entered = new Promise<void>(resolve => enteredSave = resolve);
  let delayed = false;
  await page.route('**/api/sessions/*/draft', async route => {
    if (route.request().method() === 'PUT' && !delayed) { delayed = true; const response = await route.fetch(); enteredSave(); await held; await route.fulfill({ response }); }
    else await route.continue();
  });
  await page.locator('.draft-annotation .annotation-content').click(); await page.getByRole('combobox', { name: 'Annotation target', exact: true }).selectOption(''); await entered;
  await page.getByRole('combobox', { name: 'Annotation target', exact: true }).selectOption(first.id);
  await expect(page.locator('.draft-annotation')).toHaveAttribute('data-capture-state', 'incomplete'); releaseSave();
  const changed = (await app.saved()).annotations[0]; assert.equal(changed.objectId, first.id); assert.equal(changed.captureState?.status, 'incomplete'); assert.equal(changed.capture, undefined); assert(changed.captureState!.version >= 2);
  await page.unroute('**/api/sessions/*/draft');
  const originalScreenshot = page.screenshot.bind(page);
  let releaseCapture!: () => void, enteredCapture!: () => void;
  const heldCapture = new Promise<void>(resolve => releaseCapture = resolve), enteredCapturePromise = new Promise<void>(resolve => enteredCapture = resolve);
  (page as any).screenshot = async (options: Parameters<Page['screenshot']>[0]) => { enteredCapture(); await heldCapture; return originalScreenshot(options); };
  await page.getByRole('button', { name: 'Done', exact: true }).click(); await enteredCapturePromise;
  await page.keyboard.press('Escape'); releaseCapture();
  await expect(page.locator('.capture-progress')).toHaveCount(0); (page as any).screenshot = originalScreenshot;
  const cancelled = (await app.saved()).annotations[0]; assert.equal(cancelled.text, 'Stable words'); assert.equal(cancelled.captureState?.status, 'incomplete'); assert(cancelled.captureState!.version > changed.captureState!.version);
  await page.locator('.draft-annotation .annotation-content').click(); await page.getByRole('combobox', { name: 'Annotation target', exact: true }).selectOption(second.id);
  await page.getByRole('button', { name: 'Done', exact: true }).click(); await expect(page.locator('.draft-annotation')).toHaveAttribute('data-capture-state', 'complete');
  assert.equal((await app.saved()).annotations[0].objectId, second.id);
});

test('ordinary pages preserve incomplete comments and open the project capture window for retry', async t => {
  const app = await fixture(t), { page } = app;
  const ordinary = await page.context().newPage(); await ordinary.goto(`${app.running.url}/?session=${app.session.id}`);
  await expect(ordinary.locator('#whiteboard')).toBeVisible(); assert.equal(await ordinary.evaluate(() => !!window.acanvasCaptureProvider), false);
  await ordinary.getByRole('button', { name: 'Mark canvas', exact: true }).click(); await ordinary.mouse.click(900, 400);
  await ordinary.getByRole('textbox', { name: 'Add a comment', exact: true }).fill('Capture from the managed window'); await ordinary.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(ordinary.locator('.draft-annotation')).toHaveAttribute('data-capture-state', 'incomplete'); await expect(ordinary.getByRole('button', { name: 'Send request', exact: true })).toBeDisabled();
  await ordinary.getByRole('button', { name: 'Open capture window', exact: true }).click();
  await expect(page.locator('.draft-annotation')).toHaveAttribute('data-capture-state', 'incomplete');
  await page.getByRole('button', { name: 'Retry annotation 1 capture', exact: true }).click(); await expect(page.locator('.draft-annotation')).toHaveAttribute('data-capture-state', 'complete');
  assert.equal((await app.saved()).annotations[0].text, 'Capture from the managed window'); await ordinary.close();
});

test('managed React refresh exposes a lost captured image and explicitly recaptures a new version', async t => {
  const app = await fixture(t), { page } = app;
  await app.mark({ x: 900, y: 400 }); const original = await app.done('Preserve this comment');
  await rm(app.running.service.assetPath(original.capture!.screenshotAssetId));
  let releaseQuery!: () => void, enteredQuery!: () => void;
  const heldQuery = new Promise<void>(resolve => releaseQuery = resolve), queryEntered = new Promise<void>(resolve => enteredQuery = resolve);
  let delayed = false;
  await page.route('**/captures/1', async route => {
    if (route.request().method() === 'GET' && !delayed) { delayed = true; const response = await route.fetch(); assert.equal(response.status(), 404); enteredQuery(); await heldQuery; await route.fulfill({ response }); }
    else await route.continue();
  });
  await page.reload(); await expect(page.locator('.draft-annotation')).toHaveAttribute('data-capture-state', 'unavailable');
  await queryEntered;
  await expect(page.getByRole('button', { name: 'Send request', exact: true })).toBeDisabled();
  await page.locator('.draft-annotation .annotation-content').click(); await page.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(page.locator('.draft-annotation')).toHaveAttribute('data-capture-state', 'unavailable'); await expect(page.getByRole('button', { name: 'Send request', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Retry annotation 1 capture', exact: true }).click();
  await expect(page.locator('.draft-annotation')).toHaveAttribute('data-capture-state', 'complete');
  const replacement = (await app.saved()).annotations[0]; assert.equal(replacement.text, 'Preserve this comment'); assert.equal(replacement.captureState?.version, 2); assert.notEqual(replacement.capture?.screenshotAssetId, original.capture?.screenshotAssetId);
  await expect(page.getByRole('button', { name: 'Send request', exact: true })).toBeEnabled();
  const lateResponse = page.waitForResponse(response => response.url().endsWith('/captures/1') && response.status() === 404);
  releaseQuery(); await (await lateResponse).finished();
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(page.locator('.draft-annotation')).toHaveAttribute('data-capture-state', 'complete'); await expect(page.getByRole('button', { name: 'Send request', exact: true })).toBeEnabled();
  assert.equal((await app.saved()).annotations[0].capture?.id, replacement.capture?.id);
  await writeFile(join(app.evidence, 'late-query-owner.json'), JSON.stringify({ delayedRealResponse: 404, oldVersion: 1, currentVersion: replacement.captureState?.version, currentCaptureId: replacement.capture?.id, statusAfterOldError: 'complete', sendEnabled: true }, null, 2));
  await page.unroute('**/captures/1');
});

test('managed sampling keeps corner and full-viewport marks clear and restores pointer cancellation before saving', async t => {
  const app = await fixture(t), { page } = app;
  await page.evaluate(() => {
    const root = document.querySelector('.app-shell')!; (window as any).samplingEvents = [];
    new MutationObserver(() => { const progress = document.querySelector('.capture-progress'); (window as any).samplingEvents.push({ sampling: root.hasAttribute('data-sampling'), capturing: root.hasAttribute('data-capturing'), cancelVisible: !!progress && getComputedStyle(progress).visibility === 'visible' }); }).observe(root, { attributes: true, attributeFilter: ['data-sampling', 'data-capturing'] });
  });
  await app.mark({ x: 1415, y: 970 }); const corner = await app.done('Bottom-right point');
  const stats = await page.evaluate(async capture => {
    const response = await fetch(`/api/assets/${capture.screenshotAssetId}/content?sessionId=${capture.sessionId}`); const bitmap = await createImageBitmap(await response.blob());
    const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height; const context = canvas.getContext('2d')!; context.drawImage(bitmap, 0, 0);
    const data = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
    const x = (capture.worldBounds.x * capture.viewport.zoom + capture.viewport.x - capture.mapping.crop.x) * capture.mapping.scaleX, y = (capture.worldBounds.y * capture.viewport.zoom + capture.viewport.y - capture.mapping.crop.y) * capture.mapping.scaleY;
    let blue = 0, outside = 0;
    for (let row = 0; row < bitmap.height; row++) for (let column = 0; column < bitmap.width; column++) {
      const offset = (row * bitmap.width + column) * 4, pixel = [data[offset], data[offset + 1], data[offset + 2]];
      if (Math.abs(column - x) <= 12 && Math.abs(row - y) <= 12) { if (pixel[2] - pixel[0] > 45 && pixel[1] - pixel[0] > 20) blue++; }
      else if (Math.abs(pixel[0] - 252) > 3 || Math.abs(pixel[1] - 252) > 3 || Math.abs(pixel[2] - 250) > 3) outside++;
    }
    return { blue, outside, transitions: (window as any).samplingEvents };
  }, corner.capture!);
  assert(stats.blue > 15); assert.equal(stats.outside, 0);
  assert(stats.transitions.some((event: { sampling: boolean; capturing: boolean; cancelVisible: boolean }) => event.sampling && event.capturing && !event.cancelVisible));
  assert(stats.transitions.some((event: { sampling: boolean; capturing: boolean; cancelVisible: boolean }) => !event.sampling && event.capturing && event.cancelVisible));
  await app.mark({ x: 8, y: 8 }, { x: 1432, y: 992 }); const full = await app.done('Whole visible scene');
  const pixels = await page.evaluate(async capture => {
    const response = await fetch(`/api/assets/${capture.screenshotAssetId}/content?sessionId=${capture.sessionId}`), bitmap = await createImageBitmap(await response.blob());
    const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height; const context = canvas.getContext('2d')!; context.drawImage(bitmap, 0, 0);
    return [[24, 24], [1390, 960], [500, 500]].map(([x, y]) => [...context.getImageData(Math.floor((x - capture.mapping.crop.x) * capture.mapping.scaleX), Math.floor((y - capture.mapping.crop.y) * capture.mapping.scaleY), 1, 1).data]);
  }, full.capture!);
  assert.deepEqual(pixels[0], pixels[2]); assert.deepEqual(pixels[1], pixels[2]);
});

test('managed React records Markdown scroll and real selected text and keeps the live HTML frame and form', async t => {
  const app = await fixture(t), { page } = app;
  const md = await app.importAsset('Notes.md', 'text/markdown', Buffer.from(Array.from({ length: 30 }, (_, i) => `## Block ${i}\n\nObserved paragraph ${i} with stable text.\n`).join('\n')));
  const mdObject = await app.object(md, { x: 220, y: 250, width: 340, height: 300 });
  const scroller = page.locator(`[data-object-id="${mdObject.id}"] .markdown-content`);
  await expect(scroller.locator('p').first()).toBeVisible();
  await scroller.evaluate(element => { element.scrollTop = 210; const paragraph = element.querySelectorAll('p')[2].firstChild!; const range = document.createRange(); range.setStart(paragraph, 0); range.setEnd(paragraph, 18); const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range); });
  await app.mark({ x: 300, y: 380 }); const annotated = await app.done('Selected document text');
  assert.equal(annotated.contentAnchor?.kind, 'text'); assert.equal(annotated.contentAnchor?.scroll?.y, 210); assert(annotated.contentAnchor?.quote); assert(annotated.contentAnchor?.path?.startsWith('rendered-dom:'));
  assert.equal(annotated.capture?.scene.objects.find(value => value.object.id === mdObject.id)?.scroll?.y, 210);
  const html = await app.importAsset('Live.html', 'text/html', Buffer.from('<!doctype html><style>body{background:#cff0e8;font:20px sans-serif}input{font:20px sans-serif}</style><input id="value" value="initial"><p id="clock">Live scene</p><script>window.identity=Math.random();setInterval(()=>document.querySelector("#clock").style.color=["red","blue"][Math.floor(Date.now()/100)%2],100)</script>'));
  const htmlObject = await app.object(html, { x: 730, y: 250, width: 350, height: 240 });
  const htmlContent = page.locator(`[data-object-id="${htmlObject.id}"] .html-content`);
  await htmlContent.hover(); await expect(htmlContent).toHaveAttribute('data-preview-state', 'live'); await expect(htmlContent.locator('iframe')).toBeVisible();
  const liveFrame = page.frameLocator(`[data-object-id="${htmlObject.id}"] iframe`); await liveFrame.locator('#value').fill('Saved live input');
  const frame = await (await htmlContent.locator('iframe').elementHandle())!.contentFrame(); assert(frame);
  const identity = await frame.evaluate(() => (window as any).identity);
  await app.mark({ x: 830, y: 280 }); const captured = await app.done('Keep the live HTML state');
  assert.equal(captured.objectId, htmlObject.id); assert.equal(await frame.evaluate(() => (window as any).identity), identity); assert.equal(await liveFrame.locator('#value').inputValue(), 'Saved live input');
  assert.equal(await htmlContent.getAttribute('data-preview-state'), 'live');
});

test('managed React saves independent video/audio selections and actual playback positions', async t => {
  const app = await fixture(t), { page } = app;
  const video = await app.importAsset('Clip.mp4', 'video/mp4', await readFile(resolve('tests/fixtures/frontend-video.mp4')));
  const audio = await app.importAsset('Sound.mp3', 'audio/mpeg', await readFile(resolve('tests/fixtures/reference-tone.mp3')));
  const videoObject = await app.object(video, { x: 300, y: 280, width: 300, height: 180 }), audioObject = await app.object(audio, { x: 760, y: 300, width: 480, height: 100 });
  await page.locator(`[data-object-id="${videoObject.id}"] video`).evaluate(async element => { const video = element as HTMLVideoElement; await new Promise<void>(resolve => { if (video.readyState > 0) resolve(); else video.addEventListener('loadedmetadata', () => resolve(), { once: true }); }); video.currentTime = Math.min(.4, video.duration / 2); await video.play(); });
  await app.mark({ x: 440, y: 360 }); const videoNote = await app.done('Video interval');
  assert.equal(videoNote.timeStart, 0); assert(videoNote.timeEnd && videoNote.timeEnd > 0); assert(videoNote.capture?.scene.objects.find(value => value.object.id === videoObject.id)?.media?.playbackTime! > 0);
  await page.locator(`[data-object-id="${audioObject.id}"] audio`).evaluate(element => { (element as HTMLAudioElement).currentTime = .2; });
  await app.mark({ x: 950, y: 340 }); const audioNote = await app.done('Audio whole selection');
  assert.equal(audioNote.timeStart, undefined); assert.equal(audioNote.snapshotAssetId, undefined); assert(audioNote.capture?.scene.objects.find(value => value.object.id === audioObject.id)?.media?.playbackTime! >= .2);
  const phases: Record<string, unknown>[] = [];
  const record = async (name: string, annotation: AnnotationInput, objectId: string) => {
    await writeFile(join(app.evidence, `${name}.png`), await readFile(app.running.service.assetPath(annotation.capture!.screenshotAssetId)));
    phases.push({ name, annotationId: annotation.id, timeStart: annotation.timeStart, timeEnd: annotation.timeEnd, temporalSelection: annotation.timeStart === undefined ? 'whole' : annotation.timeEnd === undefined ? 'point' : 'interval', version: annotation.captureState?.version, captureId: annotation.capture?.id, screenshotAssetId: annotation.capture?.screenshotAssetId, representativeFrameAssetId: annotation.snapshotAssetId, actualPlaybackTime: annotation.capture?.scene.objects.find(value => value.object.id === objectId)?.media?.playbackTime, target: annotation.capture?.target });
  };
  await record('video-whole', videoNote, videoObject.id); await record('audio-whole', audioNote, audioObject.id);
  const videoPlayer = page.locator(`[data-object-id="${videoObject.id}"] video`);
  await videoPlayer.evaluate(element => { const media = element as HTMLVideoElement; media.pause(); media.currentTime = .35; });
  await expect.poll(() => videoPlayer.evaluate(element => (element as HTMLVideoElement).readyState)).toBeGreaterThanOrEqual(2);
  await page.locator('.draft-annotation .annotation-content').nth(0).click();
  await expect(page.locator('.annotation-time-range')).toHaveAttribute('data-ready', 'true');
  const start = page.getByRole('slider', { name: 'Start point', exact: true }), end = page.getByRole('slider', { name: 'End point', exact: true });
  await start.press('ArrowRight'); await start.press('ArrowRight'); await end.press('ArrowLeft'); await end.press('ArrowLeft');
  await expect(page.locator('.draft-annotation').nth(0)).toHaveAttribute('data-capture-state', 'incomplete');
  await expect(page.getByRole('button', { name: 'Send request', exact: true })).toBeDisabled();
  const videoDuration = await videoPlayer.evaluate(element => (element as HTMLVideoElement).duration);
  await expect(start).toHaveAttribute('aria-valuenow', '0.2');
  const selectedVideoEnd = Number(await end.getAttribute('aria-valuenow')); assert(selectedVideoEnd > .2 && selectedVideoEnd < videoDuration);
  assert(Math.abs(await videoPlayer.evaluate(element => (element as HTMLVideoElement).currentTime) - .35) < .01);
  await page.locator('.annotation-full').screenshot({ path: join(app.evidence, 'video-partial-editor.png') });
  await page.getByRole('button', { name: 'Done', exact: true }).click(); await expect(page.locator('.draft-annotation').nth(0)).toHaveAttribute('data-capture-state', 'complete');
  const partialVideo = (await app.saved()).annotations[0];
  assert.equal(partialVideo.text, videoNote.text); assert.equal(partialVideo.timeStart, .2); assert.equal(partialVideo.timeEnd, selectedVideoEnd); assert(partialVideo.captureState!.version > videoNote.captureState!.version);
  assert.notEqual(partialVideo.capture?.id, videoNote.capture?.id); assert.notEqual(partialVideo.snapshotAssetId, videoNote.snapshotAssetId); assert.notEqual(partialVideo.snapshotAssetId, partialVideo.capture?.screenshotAssetId);
  assert.equal(partialVideo.capture?.target.timeStart, .2); assert.equal(partialVideo.capture?.target.timeEnd, selectedVideoEnd);
  assert(Math.abs(partialVideo.capture!.scene.objects.find(value => value.object.id === videoObject.id)!.media!.playbackTime! - .35) < .01);
  await record('video-partial', partialVideo, videoObject.id);
  await writeFile(join(app.evidence, 'video-partial-representative-frame.png'), await readFile(app.running.service.assetPath(partialVideo.snapshotAssetId!)));
  await page.locator('.draft-annotation .annotation-content').nth(0).click(); await end.press('Home');
  await expect(page.locator('.annotation-range-selection')).toHaveAttribute('data-point', 'true'); await expect(end).toHaveAttribute('aria-valuenow', '0.2');
  await page.getByRole('button', { name: 'Done', exact: true }).click(); await expect(page.locator('.draft-annotation').nth(0)).toHaveAttribute('data-capture-state', 'complete');
  const videoPoint = (await app.saved()).annotations[0]; assert.equal(videoPoint.timeStart, .2); assert.equal(videoPoint.timeEnd, undefined); assert(videoPoint.captureState!.version > partialVideo.captureState!.version); assert.notEqual(videoPoint.capture?.id, partialVideo.capture?.id); assert.equal(videoPoint.snapshotAssetId, partialVideo.snapshotAssetId);
  assert(Math.abs(videoPoint.capture!.scene.objects.find(value => value.object.id === videoObject.id)!.media!.playbackTime! - .35) < .01); await record('video-point', videoPoint, videoObject.id);
  const audioPlayer = page.locator(`[data-object-id="${audioObject.id}"] audio`);
  const audioHead = await audioPlayer.evaluate(element => { const media = element as HTMLAudioElement; media.pause(); const head = Math.min(.12, media.duration * .05); media.currentTime = head; return head; });
  await page.locator('.draft-annotation .annotation-content').nth(1).click(); await expect(page.locator('.annotation-time-range')).toHaveAttribute('data-ready', 'true');
  await page.locator('.annotation-full').evaluate(async element => { await Promise.all(element.getAnimations({ subtree: true }).map(animation => animation.finished.catch(() => {}))); });
  const track = (await page.locator('.annotation-range-timeline').boundingBox())!;
  await page.mouse.move(track.x + track.width * .25, track.y + track.height / 2); await page.mouse.down(); await page.mouse.move(track.x + track.width * .75, track.y + track.height / 2, { steps: 5 }); await page.mouse.up();
  const selectedAudioStart = Number(await start.getAttribute('aria-valuenow')), selectedAudioEnd = Number(await end.getAttribute('aria-valuenow'));
  const audioDuration = await audioPlayer.evaluate(element => (element as HTMLAudioElement).duration);
  assert(selectedAudioStart > 0 && selectedAudioEnd > selectedAudioStart); assert(selectedAudioEnd < audioDuration);
  assert(Math.abs(selectedAudioStart - Math.round(audioDuration * .25 * 100) / 100) < .011); assert(Math.abs(selectedAudioEnd - Math.round(audioDuration * .75 * 100) / 100) < .011);
  assert(Math.abs(await audioPlayer.evaluate(element => (element as HTMLAudioElement).currentTime) - audioHead) < .01); assert(Math.abs(selectedAudioStart - audioHead) > .01);
  await page.locator('.annotation-full').screenshot({ path: join(app.evidence, 'audio-partial-editor.png') });
  await page.getByRole('button', { name: 'Done', exact: true }).click(); await expect(page.locator('.draft-annotation').nth(1)).toHaveAttribute('data-capture-state', 'complete');
  const partialAudio = (await app.saved()).annotations[1]; assert.equal(partialAudio.text, audioNote.text); assert.equal(partialAudio.timeStart, selectedAudioStart); assert.equal(partialAudio.timeEnd, selectedAudioEnd); assert(partialAudio.captureState!.version > audioNote.captureState!.version); assert.notEqual(partialAudio.capture?.id, audioNote.capture?.id); assert.equal(partialAudio.snapshotAssetId, undefined);
  assert(Math.abs(partialAudio.capture!.scene.objects.find(value => value.object.id === audioObject.id)!.media!.playbackTime! - audioHead) < .01); await record('audio-partial', partialAudio, audioObject.id);
  await page.locator('.draft-annotation .annotation-content').nth(1).click(); await end.press('Home'); await expect(page.locator('.annotation-range-selection')).toHaveAttribute('data-point', 'true');
  const evaluate = page.evaluate.bind(page); let sawCommittedBeforeCheck = false;
  (page as any).evaluate = async (fn: any, arg?: any) => {
    const current = app.running.service.draft(app.session.id).annotations[1];
    if (!sawCommittedBeforeCheck && typeof fn === 'function' && fn.toString().includes('acanvasCaptureController') && current?.captureState?.status === 'complete' && current.timeEnd === undefined) {
      sawCommittedBeforeCheck = true;
      await expect(page.locator('.draft-annotation').nth(1)).toHaveAttribute('data-capture-state', 'complete');
    }
    return evaluate(fn, arg);
  };
  await page.getByRole('button', { name: 'Done', exact: true }).click(); await expect(page.locator('.draft-annotation').nth(1)).toHaveAttribute('data-capture-state', 'complete');
  await expect(page.locator('.capture-progress')).toHaveCount(0); (page as any).evaluate = evaluate; assert(sawCommittedBeforeCheck);
  const audioPoint = (await app.saved()).annotations[1]; assert.equal(audioPoint.timeStart, selectedAudioStart); assert.equal(audioPoint.timeEnd, undefined); assert(audioPoint.captureState!.version > partialAudio.captureState!.version); assert.notEqual(audioPoint.capture?.id, partialAudio.capture?.id); assert.equal(audioPoint.snapshotAssetId, undefined);
  assert(Math.abs(audioPoint.capture!.scene.objects.find(value => value.object.id === audioObject.id)!.media!.playbackTime! - audioHead) < .01); await record('audio-point', audioPoint, audioObject.id);
  await writeFile(join(app.evidence, 'media-time-phases.json'), JSON.stringify({ interaction: { videoPartial: 'native keyboard ArrowRight / ArrowLeft', audioPartial: 'native pointer drag 25% to 75%', temporalPoints: 'End handle Home clamps end to chosen start' }, committedUiVisibleBeforeHostCheck: sawCommittedBeforeCheck, phases }, null, 2));
});

test('managed React captures GIF, file cards, mixed scenes and the actual overlapping target', async t => {
  const app = await fixture(t), { page } = app;
  const gif = await app.importAsset('Animation.gif', 'image/gif', await readFile(resolve('tests/fixtures/animated-reference.gif')));
  const file = await app.importAsset('Source.bin', 'application/octet-stream', Buffer.from('Generic source document'));
  const gifObject = await app.object(gif, { x: 350, y: 290, width: 300, height: 180 }), fileObject = await app.object(file, { x: 790, y: 310, width: 280, height: 150 });
  await expect(page.locator(`[data-object-id="${gifObject.id}"] img`)).toBeVisible();
  await app.mark({ x: 470, y: 380 }); const gifNote = await app.done('The visible GIF frame'); assert.equal(gifNote.assetId, gif.id); assert(gifNote.capture?.screenshotAssetId);
  await app.mark({ x: 920, y: 390 }); const fileNote = await app.done('The visible file card'); assert.equal(fileNote.assetId, file.id); assert(fileNote.capture?.scene.objects.some(value => value.object.id === fileObject.id));
  await app.mark({ x: 330, y: 270 }, { x: 1100, y: 490 }); const mixed = await app.done('Across media boundaries');
  assert.equal(mixed.scope, 'region'); assert.deepEqual(mixed.objectIds, []); assert.equal(mixed.timeStart, undefined); assert.deepEqual(mixed.capture?.scene.objects.map(value => value.object.id), [gifObject.id, fileObject.id]);
  const back = await app.object(await app.image('Overlapping image.png'), { x: 350, y: 290, width: 300, height: 180 });
  await page.locator(`[data-object-id="${gifObject.id}"]`).evaluate(element => (element as HTMLElement).style.zIndex = '5');
  await app.mark({ x: 560, y: 430 }); const top = await app.done('Top painted target'); assert.equal(top.objectId, gifObject.id);
  await page.locator('.draft-annotation .annotation-content').last().click(); await page.getByRole('combobox', { name: 'Annotation target', exact: true }).selectOption(back.id);
  await page.getByRole('button', { name: 'Done', exact: true }).click(); await expect(page.locator('.draft-annotation').last()).toHaveAttribute('data-capture-state', 'complete');
  assert.equal((await app.saved()).annotations.at(-1)?.objectId, back.id);
  await page.locator(`[data-object-id="${gifObject.id}"]`).evaluate(element => { const object = element as HTMLElement; object.style.borderRadius = '32px'; const media = object.querySelector<HTMLElement>('.object-media')!; media.style.backgroundColor = 'transparent'; });
  await app.mark({ x: 380, y: 350 }); const rounded = await app.done('Visible lower corners');
  assert(rounded.capture?.scene.objects.some(value => value.object.id === back.id)); assert.deepEqual((await app.saved()).references.objectIds, []);
});

test('managed marks use the top painted media owner and keep letterbox points and crossing regions in world space', async t => {
  const app = await fixture(t), { page } = app;
  const sources = await page.evaluate(() => [[400, 400, '#d93232'], [400, 200, '#254ed1']].map(([width, height, color]) => { const canvas = document.createElement('canvas'); canvas.width = Number(width); canvas.height = Number(height); const context = canvas.getContext('2d')!; context.fillStyle = String(color); context.fillRect(0, 0, canvas.width, canvas.height); return canvas.toDataURL('image/png').split(',')[1]; }));
  const red = await app.importAsset('Underlying red.png', 'image/png', Buffer.from(sources[0], 'base64')), blue = await app.importAsset('Letterboxed blue.png', 'image/png', Buffer.from(sources[1], 'base64'));
  const lower = await app.object(red, { x: 350, y: 220, width: 400, height: 400 }), upper = await app.object(blue, { x: 350, y: 220, width: 400, height: 400 });
  await expect.poll(() => page.locator(`[data-object-id="${upper.id}"] img`).evaluate(image => (image as HTMLImageElement).naturalHeight)).toBe(200);
  await app.mark({ x: 500, y: 250 }); const letterbox = await app.done('The visible white margin');
  assert.equal(letterbox.scope, 'region'); assert.deepEqual(letterbox.objectIds, []); assert.equal(letterbox.objectId, undefined);
  assert(letterbox.capture?.scene.objects.some(value => value.object.id === upper.id)); assert(!letterbox.capture?.scene.objects.some(value => value.object.id === lower.id));
  await app.mark({ x: 500, y: 400 }); const content = await app.done('The visible blue image'); assert.equal(content.objectId, upper.id); assert.equal(content.assetId, blue.id);
  await app.mark({ x: 480, y: 310 }, { x: 540, y: 350 }); const cross = await app.done('Across the content boundary'); assert.equal(cross.scope, 'region'); assert.deepEqual(cross.objectIds, []);
  await app.mark({ x: 480, y: 330 }, { x: 540, y: 350 }); const contained = await app.done('Inside the visible content'); assert.equal(contained.objectId, upper.id); assert.equal(contained.coordinateSpace, 'normalized');
  assert.deepEqual((await app.saved()).references.objectIds, []);
});

test('managed React 320px themes, keyboard point marking and reduced motion retain usable composer', async t => {
  const app = await fixture(t, true), { page } = app;
  await page.emulateMedia({ reducedMotion: 'reduce' });
  let count = 0;
  for (const theme of ['light', 'dark'] as const) {
    if (theme === 'dark') await page.getByRole('button', { name: 'Switch to dark theme', exact: true }).click();
    await page.getByRole('button', { name: 'Mark canvas', exact: true }).click();
    if (theme === 'light') { await page.locator('#whiteboard').focus(); await page.keyboard.press('Enter'); }
    else {
      const cdp = await page.context().newCDPSession(page); await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 160, y: 350 }] }); await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await cdp.detach();
    }
    const note = await app.done(`${theme} blank point`); assert.equal(note.geometry, 'point'); assert.equal(note.bounds.width, 0);
    await expect(page.locator('.draft-annotation')).toHaveCount(++count);
    assert.equal(await page.locator('#whiteboard').evaluate(element => element.scrollLeft), 0);
    const bounds = await page.locator('.composer').boundingBox(); assert(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 321);
    await expect(page.getByRole('button', { name: 'Send request', exact: true })).toBeVisible();
    const marker = await page.locator('.annotation-outline.point-annotation').last().boundingBox(); assert(marker && Math.abs(marker.width - 20) < 1);
  }
});
