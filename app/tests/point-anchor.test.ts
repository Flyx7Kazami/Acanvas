import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect } from '@playwright/test';
import { chromium } from 'playwright-core';
import { startServer } from '../src/server/http.js';
import type { AnnotationInput, Asset } from '../src/shared/types.js';

async function fixture(t: test.TestContext, dpr = 1, touch = false) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'acanvas-point-project-')));
  const evidence = await realpath(await mkdtemp(join(tmpdir(), 'acanvas-point-evidence-')));
  t.diagnostic(`Evidence: ${evidence}`);
  const running = await startServer({ root, port: 0, webRoot: resolve(process.env.ACANVAS_TEST_WEB_ROOT || 'dist/web'), browser: { headless: true } });
  const session = running.service.createSession('Point annotation acceptance');
  const launch = chromium.launchPersistentContext;
  // Each isolated context keeps its native pixel ratio throughout capture.
  chromium.launchPersistentContext = (profile, options) => launch.call(chromium, profile, { ...options, deviceScaleFactor: dpr, hasTouch: touch });
  try { await running.browser.open(session.id); }
  finally { chromium.launchPersistentContext = launch; }
  const page = running.browser.page(session.id)!;
  await expect(page.locator('.composer')).toHaveAttribute('data-save-state', 'saved');
  const bootstrap = await (await fetch(`${running.url}/api/bootstrap`)).json();
  const call = async (path: string, method: string, body: unknown) => {
    const response = await fetch(`${running.url}${path}`, { method, headers: { Authorization: `Bearer ${bootstrap.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const value = await response.json(); assert(response.ok, JSON.stringify(value)); return value;
  };
  const encoded = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 400; canvas.height = 240;
    const context = canvas.getContext('2d')!; context.fillStyle = '#e4e7ee'; context.fillRect(0, 0, 400, 240);
    return canvas.toDataURL('image/png').split(',')[1];
  });
  const imported = await fetch(`${running.url}/api/assets?name=Point%20reference.png&mime=image%2Fpng`, { method: 'POST', headers: { Authorization: `Bearer ${bootstrap.token}` }, body: Buffer.from(encoded, 'base64') });
  assert(imported.ok); const asset: Asset = await imported.json();
  await call('/api/board/operations', 'POST', { sessionId: session.id, operations: [{ type: 'create', object: { assetId: asset.id, x: 400, y: 300, width: 300, height: 180 } }] });
  await expect(page.locator('.board-object')).toBeVisible();
  const object = running.service.objects()[0];
  const saved = async () => { await expect(page.locator('.composer')).toHaveAttribute('data-save-state', 'saved'); return running.service.draft(session.id); };
  const mark = async (x: number, y: number, touch = false) => {
    await page.getByRole('button', { name: 'Mark canvas', exact: true }).click();
    if (touch) {
      await page.touchscreen.tap(x, y);
    } else await page.mouse.click(x, y);
    await expect(page.getByRole('textbox', { name: 'Add a comment', exact: true })).toBeVisible();
    return page.locator('.canvas-annotation-group[data-active="true"]');
  };
  const done = async (text: string) => {
    await page.getByRole('textbox', { name: 'Add a comment', exact: true }).fill(text);
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    try { await expect(page.locator('.draft-annotation').last()).toHaveAttribute('data-capture-state', 'complete', { timeout: 15000 }); }
    catch (cause) { t.diagnostic(await page.locator('.draft-annotation').last().innerText()); await page.screenshot({ path: join(evidence, 'capture-failure.png') }); throw cause; }
    return (await saved()).annotations.at(-1)!;
  };
  const pinAt = async (id: string, x: number, y: number) => {
    const pin = page.locator(`.canvas-annotation-group[data-annotation-id="${id}"]>.annotation-pin`);
    const rect = await pin.boundingBox(); assert(rect);
    const tailX = 4 * rect.width / 24, tailY = 21 * rect.height / 24;
    assert(Math.abs(rect.x + tailX - x) < .5, `Pin tail x: ${JSON.stringify(rect)}, expected ${x}`);
    assert(Math.abs(rect.y + tailY - y) < .5, `Pin tail y: ${JSON.stringify(rect)}, expected ${y}`);
    assert.equal(rect.width, 28); assert.equal(rect.height, 28); return rect;
  };
  let closed = false;
  const close = async () => { if (closed) return; closed = true; await page.screenshot({ path: join(evidence, 'final-ui.png') }); await writeFile(join(evidence, 'final-draft.json'), JSON.stringify(running.service.draft(session.id), null, 2)); await running.close(); await rm(root, { recursive: true, force: true }); };
  t.after(close);
  return { evidence, running, session, page, call, object, saved, mark, done, pinAt, close };
}

test('point pins and captured rings share actual blank and normalized clicks across pan zoom DPR themes and touch', async t => {
  const samples = [];
  let evidence = '';
  const scenarios = [
    { name: 'light-wide', width: 1440, dpr: 1, zoom: .5, theme: 'light', touch: false, click: { x: 860, y: 400 } },
    { name: 'dark-wide-dpr2', width: 1440, dpr: 2, zoom: 2, theme: 'dark', touch: false, click: { x: 800, y: 330 } },
    { name: 'light-320-touch', width: 320, dpr: 2, zoom: 2, theme: 'light', touch: true, click: { x: 160, y: 340 } },
    { name: 'dark-320-touch', width: 320, dpr: 1, zoom: .5, theme: 'dark', touch: true, click: { x: 290, y: 140 } },
  ];
  for (const scenario of scenarios) {
    const app = await fixture(t, scenario.dpr, scenario.touch), { page } = app;
    if (!evidence) evidence = app.evidence;
    await page.setViewportSize({ width: scenario.width, height: 700 });
    await page.evaluate(theme => localStorage.setItem('acanvas-theme', theme), scenario.theme);
    const world = { x: 600, y: 450 };
    await app.call(`/api/sessions/${app.session.id}/view`, 'PUT', { ...app.session.view, x: scenario.click.x - world.x * scenario.zoom, y: scenario.click.y - world.y * scenario.zoom, zoom: scenario.zoom, selectedObjectIds: [] });
    await page.reload(); await expect(page.locator('.zoom-label')).toHaveText(`${scenario.zoom * 100}%`);
    assert.equal(await page.evaluate(() => devicePixelRatio), scenario.dpr);
    for (const target of ['object', 'blank'] as const) {
      const click = target === 'object' ? scenario.click : { x: scenario.width - 8, y: 680 };
      const group = await app.mark(click.x, click.y, scenario.touch);
      const id = (await group.getAttribute('data-annotation-id'))!;
      const editPin = await app.pinAt(id, click.x, click.y);
      const note = await group.locator('.canvas-annotation-note').boundingBox(); assert(note);
      assert(note.x >= 7.5 && note.x + note.width <= scenario.width - 7.5); assert(note.y >= 63.5 && note.y + note.height <= 620.5);
      const annotation = await app.done(`${scenario.name} ${target}`);
      const pin = await app.pinAt(annotation.id, click.x, click.y);
      assert.equal(annotation.geometry, 'point'); assert.equal(annotation.bounds.width, 0); assert.equal(annotation.bounds.height, 0);
      assert.equal(annotation.coordinateSpace, target === 'object' ? 'normalized' : 'world');
      if (target === 'object') { assert.equal(annotation.objectId, app.object.id); assert(Math.abs(annotation.bounds.x - 2 / 3) < 1e-9); assert(Math.abs(annotation.bounds.y - 5 / 6) < 1e-9); }
      const capture = annotation.capture!;
      const mapped = { x: capture.worldBounds.x * capture.viewport.zoom + capture.viewport.x, y: capture.worldBounds.y * capture.viewport.zoom + capture.viewport.y };
      assert(Math.abs(mapped.x - click.x) < .001); assert(Math.abs(mapped.y - click.y) < .001);
      const pixels = await page.evaluate(async capture => {
        const response = await fetch(`/api/assets/${capture.screenshotAssetId}/content?sessionId=${capture.sessionId}`), bitmap = await createImageBitmap(await response.blob());
        const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height;
        const context = canvas.getContext('2d')!; context.drawImage(bitmap, 0, 0); const data = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
        const x = (capture.worldBounds.x * capture.viewport.zoom + capture.viewport.x - capture.mapping.crop.x) * capture.mapping.scaleX, y = (capture.worldBounds.y * capture.viewport.zoom + capture.viewport.y - capture.mapping.crop.y) * capture.mapping.scaleY;
        let count = 0, sumX = 0, sumY = 0, minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (let row = 0; row < bitmap.height; row++) for (let column = 0; column < bitmap.width; column++) {
          const offset = (row * bitmap.width + column) * 4;
          if (data[offset + 2] - data[offset] > 45 && data[offset + 1] - data[offset] > 20) { count++; sumX += column; sumY += row; minX = Math.min(minX, column); minY = Math.min(minY, row); maxX = Math.max(maxX, column); maxY = Math.max(maxY, row); }
        }
        return { count, expected: { x, y }, centroid: { x: sumX / count, y: sumY / count }, bounds: { minX, minY, maxX, maxY }, width: bitmap.width, height: bitmap.height, scale: capture.mapping.scaleX };
      }, capture);
      assert(pixels.count > 15, JSON.stringify(pixels));
      const scale = pixels.scale;
      assert(pixels.centroid.y < pixels.expected.y - 6 * scale, JSON.stringify(pixels));
      assert(pixels.bounds.minY <= pixels.expected.y - 18 * scale && pixels.bounds.minY >= pixels.expected.y - 32 * scale, JSON.stringify(pixels));
      assert(pixels.bounds.maxX >= Math.min(pixels.expected.x + 16 * scale, pixels.width - 2) && pixels.bounds.maxX <= pixels.expected.x + 32 * scale, JSON.stringify(pixels));
      assert(pixels.bounds.minX >= pixels.expected.x - 16 * scale && pixels.bounds.maxY <= pixels.expected.y + 16 * scale, JSON.stringify(pixels));
      await writeFile(join(app.evidence, `${scenario.name}-${target}-capture.png`), await readFile(app.running.service.assetPath(capture.screenshotAssetId)));
      await page.screenshot({ path: join(app.evidence, `${scenario.name}-${target}.png`) });
      samples.push({ scenario, target, editPin, pin, note, annotation, pixels });
    }
    await app.close();
  }
  await writeFile(join(evidence, 'point-geometry.json'), JSON.stringify(samples, null, 2));
});

test('same and neighboring point comments move independently during expansion while region and legacy notes retain anchors', async t => {
  const app = await fixture(t), { page } = app;
  const legacy: AnnotationInput = { id: 'legacy-comment', scope: 'object', objectId: app.object.id, objectIds: [app.object.id], assetId: app.object.assetId, bounds: { x: 0, y: 0, width: 1, height: 1 }, coordinateSpace: 'normalized', text: 'Legacy comment' };
  const region: AnnotationInput = { id: 'region-comment', scope: 'region', objectIds: [], bounds: { x: 770, y: 300, width: 90, height: 60 }, coordinateSpace: 'world', geometry: 'rect', text: 'Region comment' };
  await app.call(`/api/sessions/${app.session.id}/draft`, 'PUT', { ...await app.saved(), annotations: [legacy, region] });
  await page.reload(); await expect(page.locator('.canvas-annotation-group')).toHaveCount(2);
  const retained = await Promise.all([legacy, region].map(annotation => page.locator(`.canvas-annotation-group[data-annotation-id="${annotation.id}"]>.annotation-pin`).boundingBox()));
  const points = [];
  for (const [index, position] of [{ x: 950, y: 440 }, { x: 950, y: 440 }, { x: 955, y: 455 }].entries()) { await app.mark(position.x, position.y); points.push({ annotation: await app.done(`Point ${index + 1}`), position }); }
  await page.waitForFunction(() => Array.from(document.querySelectorAll('.canvas-annotation-group')).every(group => group.getAnimations({ subtree: true }).every(animation => animation.playState === 'finished')));
  const notes = await page.locator('.canvas-annotation-group[data-geometry="point"]>.canvas-annotation-note').evaluateAll(elements => elements.map(element => { const { x, y, width, height } = element.getBoundingClientRect(); return { x, y, width, height }; }));
  for (let index = 0; index < notes.length; index++) for (let other = index + 1; other < notes.length; other++) assert(notes[index].x + notes[index].width <= notes[other].x || notes[other].x + notes[other].width <= notes[index].x || notes[index].y + notes[index].height <= notes[other].y || notes[other].y + notes[other].height <= notes[index].y);
  await page.locator('.draft-annotation .annotation-content').nth(2).click(); await expect(page.getByRole('textbox', { name: 'Annotation text', exact: true })).toBeFocused();
  const transitions = await page.locator(`.canvas-annotation-group[data-annotation-id="${points[0].annotation.id}"]`).evaluate(async element => {
    const animations = element.getAnimations({ subtree: true }); animations.forEach(animation => animation.pause());
    const samples = [];
    for (const time of [0, 65, 130, 195, 260]) {
      animations.forEach(animation => { animation.currentTime = time; }); await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      samples.push(Array.from(document.querySelectorAll('.canvas-annotation-group[data-geometry="point"]>.annotation-pin')).map(pin => { const { x, y, width, height } = pin.getBoundingClientRect(); return { x, y, width, height }; }));
    }
    animations.forEach(animation => animation.finish()); return { groupAnimations: element.getAnimations().length, samples };
  });
  assert.equal(transitions.groupAnimations, 0);
  for (const sample of transitions.samples) for (const [index, rect] of sample.entries()) { assert(Math.abs(rect.x + 4 * rect.width / 24 - points[index].position.x) < .5, JSON.stringify(rect)); assert(Math.abs(rect.y + 21 * rect.height / 24 - points[index].position.y) < .5, JSON.stringify(rect)); }
  await page.getByRole('textbox', { name: 'Annotation text', exact: true }).press('Escape');
  await page.emulateMedia({ reducedMotion: 'reduce' }); await page.locator('.draft-annotation .annotation-content').nth(3).click();
  for (const value of points) await app.pinAt(value.annotation.id, value.position.x, value.position.y);
  await page.getByRole('textbox', { name: 'Annotation text', exact: true }).press('Escape');
  for (const [index, annotation] of [legacy, region].entries()) assert.deepEqual(await page.locator(`.canvas-annotation-group[data-annotation-id="${annotation.id}"]>.annotation-pin`).boundingBox(), retained[index]);
  await writeFile(join(app.evidence, 'point-stack-motion.json'), JSON.stringify({ retained, notes, transitions }, null, 2));
  await page.screenshot({ path: join(app.evidence, 'point-stack.png') });
});
