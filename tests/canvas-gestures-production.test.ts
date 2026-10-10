import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { expect } from '@playwright/test';
import type { Page } from 'playwright-core';
import { startServer } from '../src/server/http.js';
import { canvasPinchView } from '../src/web/canvas-gestures.js';

async function camera(page: Page) { return page.locator('.canvas-world').evaluate(element => { const matrix = new DOMMatrix(getComputedStyle(element).transform); return { x: matrix.e, y: matrix.f, zoom: matrix.a }; }); }
function close(actual: { x: number; y: number; zoom: number }, expected: { x: number; y: number; zoom: number }) { for (const key of ['x', 'y', 'zoom'] as const) assert.ok(Math.abs(actual[key] - expected[key]) < .001, `${key}: ${actual[key]} / ${expected[key]}`); }

test('production canvas inherits native wheel fields, accumulates bursts, and owns distinct pinch inputs', { skip: process.env.ACANVAS_GESTURE_TESTS !== '1', timeout: 120_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'acanvas-gestures-production-'));
  const running = await startServer({ root, port: 0, webRoot: resolve(process.env.ACANVAS_TEST_WEB_ROOT || 'dist/web'), browser: { headless: true } });
  const samples: unknown[] = [];
  try {
    const session = running.service.createSession('Canvas gestures'), bootstrap = await (await fetch(`${running.url}/api/bootstrap`)).json();
    const call = async (path: string, method = 'GET', body?: unknown) => { const response = await fetch(`${running.url}${path}`, { method, headers: { Authorization: `Bearer ${bootstrap.token}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); assert(response.ok, `${method} ${path}: ${response.status}`); return response.json(); };
    const upload = async (name: string, mime: string, text: string) => { const response = await fetch(`${running.url}/api/assets?name=${encodeURIComponent(name)}&mime=${encodeURIComponent(mime)}`, { method: 'POST', headers: { Authorization: `Bearer ${bootstrap.token}` }, body: text }); assert(response.ok); return response.json(); };
    const image = await upload('Gesture.svg', 'image/svg+xml', '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="120"><rect width="200" height="120" fill="#4286ff"/></svg>');
    const markdown = await upload('Reading.md', 'text/markdown', '# Reading\n\n' + Array.from({ length: 80 }, (_, index) => `Paragraph ${index}: this document retains its own scrolling.`).join('\n\n'));
    await call('/api/board/operations', 'POST', { sessionId: session.id, operations: [{ type: 'create', object: { assetId: image.id, x: 490, y: 250, width: 200, height: 120 } }, { type: 'create', object: { assetId: markdown.id, x: 850, y: 120, width: 260, height: 300 } }] });
    await running.browser.open(session.id); const page = running.browser.page(session.id)!;
    await page.addInitScript(() => {
      const scope = window as any; scope.boardDraws = 0;
      for (const method of ['drawImage', 'putImageData', 'fillRect', 'strokeRect', 'clearRect', 'fill', 'stroke', 'fillText', 'strokeText'] as const) {
        const original = CanvasRenderingContext2D.prototype[method] as (...args: unknown[]) => unknown;
        Object.defineProperty(CanvasRenderingContext2D.prototype, method, { configurable: true, writable: true, value(this: CanvasRenderingContext2D, ...args: unknown[]) { scope.boardDraws++; return original.apply(this, args); } });
      }
    });
    await expect(page.locator('#whiteboard')).toHaveAttribute('data-view-id', /.+/);
    const reset = async (owner = session.id) => { await call(`/api/sessions/${owner}/view`, 'PUT', { x: 0, y: 0, zoom: 1, selectedObjectIds: [] }); await page.goto(`${running.url}/?session=${owner}`); await expect(page.locator('#whiteboard')).toHaveAttribute('data-view-id', /.+/); await expect(page.locator('.zoom-label')).toHaveText('100%'); await expect(page.locator('.board-object')).toHaveCount(2); };
    const burst = async (modifier: 'ctrlKey' | 'metaKey', deltaY: number, count = 24, selector = '#whiteboard') => page.evaluate(({ modifier, deltaY, count, selector }) => {
      const target = document.querySelector(selector)!; const bounds = document.querySelector('#whiteboard')!.getBoundingClientRect(), x = bounds.left + 600 * bounds.width / (document.querySelector('#whiteboard') as HTMLElement).clientWidth, y = bounds.top + 280 * bounds.height / (document.querySelector('#whiteboard') as HTMLElement).clientHeight;
      let prevented = 0;
      for (let index = 0; index < count; index++) { const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, clientX: x, clientY: y, deltaY, [modifier]: true }); target.dispatchEvent(event); if (event.defaultPrevented) prevented++; }
      return { prevented, inheritedCtrl: !Object.hasOwn(new WheelEvent('wheel', { ctrlKey: true }), 'ctrlKey'), drawsBefore: (window as any).boardDraws as number, viewportScale: visualViewport?.scale };
    }, { modifier, deltaY, count, selector });
    for (const modifier of ['ctrlKey', 'metaKey'] as const) {
      await reset(); const event = await burst(modifier, -4); assert.equal(event.prevented, 24); assert.equal(event.inheritedCtrl, true);
      const expected = canvasPinchView({ x: 0, y: 0, zoom: 1, selectedObjectIds: [] }, Math.exp(.48), { x: 600, y: 280 });
      await expect.poll(async () => (await camera(page)).zoom).toBeCloseTo(expected.zoom, 5); const actual = await camera(page); close(actual, expected); assert.equal(event.viewportScale, 1);
      assert.equal(await page.evaluate(() => (window as any).boardDraws), event.drawsBefore, 'Pinch zoom does not draw any 2D canvas.');
      await burst(modifier, 4); await expect.poll(async () => (await camera(page)).zoom).toBeCloseTo(1, 5); close(await camera(page), { x: 0, y: 0, zoom: 1 });
      samples.push({ input: modifier, count: 24, expected, actual, event, reversal: await camera(page) });
    }
    await reset(); await page.evaluate(() => document.documentElement.style.zoom = '1.25');
    await burst('ctrlKey', -4, 12, '.canvas-toolbar button');
    const scaledExpected = canvasPinchView({ x: 0, y: 0, zoom: 1, selectedObjectIds: [] }, Math.exp(.24), { x: 600, y: 280 });
    await expect.poll(async () => (await camera(page)).zoom).toBeCloseTo(scaledExpected.zoom, 5); close(await camera(page), scaledExpected); samples.push({ input: 'scaled viewport control target', actual: await camera(page), expected: scaledExpected });
    await reset(); const reading = page.locator('.markdown-content'); const beforeReading = await camera(page); await reading.hover(); await page.mouse.wheel(0, 220); await expect.poll(() => reading.evaluate(element => element.scrollTop)).toBeGreaterThan(0); close(await camera(page), beforeReading);
    await burst('ctrlKey', -4, 12, '.markdown-content'); await expect.poll(async () => (await camera(page)).zoom).toBeCloseTo(Math.exp(.24), 5); samples.push({ input: 'document scroll plus canvas pinch', scrollTop: await reading.evaluate(element => element.scrollTop), zoom: (await camera(page)).zoom });

    await reset(); const beforePan = await camera(page);
    const pan = await page.evaluate(() => { const board = document.querySelector('#whiteboard')!; const events = [{ deltaX: 2, deltaY: 3, deltaMode: 1 }, { deltaX: 1, deltaY: 1, deltaMode: 0 }]; return events.map(input => { const event = new WheelEvent('wheel', { ...input, bubbles: true, cancelable: true }); board.dispatchEvent(event); return event.defaultPrevented; }); });
    assert.deepEqual(pan, [true, true]); await expect.poll(async () => (await camera(page)).x).toBe(-33); close(await camera(page), { ...beforePan, x: -33, y: -49 }); samples.push({ input: 'ordinary wheel native units burst', camera: await camera(page) });

    await page.context().addInitScript(() => Object.defineProperty(window, 'ongesturestart', { configurable: true, value: null })); await reset();
    const native = async (type: string, scale: number) => page.evaluate(({ type, scale }) => { const event = new Event(type, { bubbles: true, cancelable: true }); Object.defineProperties(event, { scale: { value: scale }, clientX: { value: 600 }, clientY: { value: 280 } }); document.querySelector('#whiteboard')!.dispatchEvent(event); return event.defaultPrevented; }, { type, scale });
    assert(await native('gesturestart', 1)); assert(await native('gesturechange', 1.2)); await burst('ctrlKey', -4); assert(await native('gesturechange', 1.5)); assert(await native('gesturechange', 1.5)); assert(await native('gestureend', 1.5));
    await expect.poll(async () => (await camera(page)).zoom).toBeCloseTo(1.5, 5); close(await camera(page), canvasPinchView({ x: 0, y: 0, zoom: 1, selectedObjectIds: [] }, 1.5, { x: 600, y: 280 }));
    await burst('ctrlKey', -4, 1); await expect.poll(async () => (await camera(page)).zoom).toBeCloseTo(1.5 * Math.exp(.02), 5); samples.push({ input: 'WebKit capability path', relativeScale: 1.5, duplicateWheelSuppressed: true, afterEndWheel: await camera(page), support: 'Synthetic GestureEvent capability, not physical Safari input.' });

    await reset(); await native('gesturestart', 1); await native('gesturechange', 1.2);
    await page.evaluate(() => { window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })); window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })); });
    await burst('ctrlKey', -4, 1); await expect.poll(async () => (await camera(page)).zoom).toBeCloseTo(1.2 * Math.exp(.02), 5);
    samples.push({ input: 'persisted page lifecycle during unfinished WebKit gesture', camera: await camera(page), priorCameraPreserved: true, nextWheelAccepted: true });

    await reset(); await native('gesturestart', 1); await native('gesturechange', 1.2);
    const oldViewId = await page.locator('#whiteboard').getAttribute('data-view-id'); assert.ok(oldViewId);
    const oldView = running.service.captureView(session.id, oldViewId);
    await call(`/api/sessions/${session.id}/capture-views/${oldViewId}`, 'DELETE', { documentId: oldView.documentId, viewGeneration: oldView.viewGeneration, operationSeq: 1_000_000 });
    await expect.poll(() => page.locator('#whiteboard').getAttribute('data-view-id')).not.toBe(oldViewId);
    await expect(page.locator('#whiteboard')).toHaveAttribute('data-view-id', /.+/);
    await burst('ctrlKey', -4, 1); await expect.poll(async () => (await camera(page)).zoom).toBeCloseTo(1.2 * Math.exp(.02), 5);
    samples.push({ input: 'capture view retirement during unfinished WebKit gesture', oldViewId, newViewId: await page.locator('#whiteboard').getAttribute('data-view-id'), camera: await camera(page), priorCameraPreserved: true, nextWheelAccepted: true });

    await reset(); const cdp = await page.context().newCDPSession(page), beforeTouch = await call(`/api/state?sessionId=${session.id}`);
    const touch = async (type: 'touchStart' | 'touchMove' | 'touchEnd' | 'touchCancel', points: { x: number; y: number; id: number }[]) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points });
    await touch('touchStart', [{ x: 500, y: 310, id: 1 }, { x: 680, y: 310, id: 2 }]);
    await touch('touchMove', [{ x: 475, y: 340, id: 1 }, { x: 745, y: 340, id: 2 }]);
    await touch('touchEnd', []);
    const touchExpected = canvasPinchView({ x: 0, y: 0, zoom: 1, selectedObjectIds: [] }, 1.5, { x: 590, y: 310 }, { x: 610, y: 340 });
    await expect.poll(async () => (await camera(page)).zoom).toBeCloseTo(1.5, 5); close(await camera(page), touchExpected); await expect(page.locator('.board-object.selected')).toHaveCount(0);
    const afterTouch = await call(`/api/state?sessionId=${session.id}`); assert.deepEqual(afterTouch.objects, beforeTouch.objects); assert.deepEqual(afterTouch.draft.annotations, beforeTouch.draft.annotations); samples.push({ input: 'Chrome CDP touch pointer path', expected: touchExpected, actual: await camera(page), selectionPreserved: true, objectsPreserved: true });
    await reset(); await page.getByRole('button', { name: 'Mark canvas', exact: true }).click(); await touch('touchStart', [{ x: 500, y: 310, id: 1 }, { x: 680, y: 310, id: 2 }]); await touch('touchMove', [{ x: 475, y: 310, id: 1 }, { x: 745, y: 310, id: 2 }]); await touch('touchEnd', []);
    await expect.poll(async () => (await camera(page)).zoom).toBeCloseTo(1.5, 5); await expect(page.locator('.annotation-fulltext')).toHaveCount(0); assert.deepEqual((await call(`/api/state?sessionId=${session.id}`)).draft.annotations, beforeTouch.draft.annotations); samples.push({ input: 'two touches in Mark mode', annotationsPreserved: true });
    const beforeImage = beforeTouch.objects.find((object: { assetId: string }) => object.assetId === image.id);
    await reset();
    await touch('touchStart', [{ x: 590, y: 310, id: 1 }]); await touch('touchMove', [{ x: 628, y: 334, id: 1 }]);
    await touch('touchEnd', []); await expect.poll(async () => (await call(`/api/state?sessionId=${session.id}`)).objects.find((object: { id: string }) => object.id === beforeImage.id).version).toBe(beforeImage.version + 1); const single = (await call(`/api/state?sessionId=${session.id}`)).objects.find((object: { id: string }) => object.id === beforeImage.id); assert.equal(single.x, 528); assert.equal(single.y, 270); samples.push({ input: 'single touch after pinch', object: { x: single.x, y: single.y, version: single.version }, snappedToDocumentCenter: true });
    await reset(); await touch('touchStart', [{ x: 500, y: 500, id: 1 }, { x: 680, y: 500, id: 2 }]); await touch('touchCancel', []); await burst('ctrlKey', -4, 1); await expect.poll(async () => (await camera(page)).zoom).toBeCloseTo(Math.exp(.02), 5); samples.push({ input: 'touch cancel then wheel', actual: await camera(page) });

    await reset(); await native('gesturestart', 1); const other = running.service.createSession('Other gesture scope'); await reset(other.id); await native('gesturechange', 2); await native('gestureend', 2); close(await camera(page), { x: 0, y: 0, zoom: 1 }); assert.equal((await call(`/api/state?sessionId=${session.id}`)).session.view.zoom, 1); samples.push({ input: 'session change during native gesture', otherView: await camera(page), priorSessionView: (await call(`/api/state?sessionId=${session.id}`)).session.view });
    await cdp.detach();
    let baseline: unknown; try { baseline = JSON.parse(await readFile('/private/tmp/acanvas-gesture-baseline-result-20261009.json', 'utf8')); } catch { baseline = undefined; }
    if (process.env.ACANVAS_GESTURE_EVIDENCE) await writeFile(resolve(process.env.ACANVAS_GESTURE_EVIDENCE), JSON.stringify({ status: 'PASS', root, webRoot: process.env.ACANVAS_TEST_WEB_ROOT, browser: await page.context().browser()!.version(), baseline, samples, limitations: ['Synthetic DOM Ctrl/Meta wheel and GestureEvent sequences do not measure physical trackpad hardware.', 'Chrome CDP touch events exercise native touch-to-PointerEvent routing; physical touchscreen and Safari remain unmeasured.'] }, null, 2));
    t.diagnostic(`Gesture fixture: ${root}`);
  } finally { await running.close(); }
});
