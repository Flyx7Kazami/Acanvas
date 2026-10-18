import test from 'node:test';
import assert from 'node:assert/strict';
import { canvasPinchView } from '../src/web/canvas-gestures.js';
import { canvasWheelView } from '../src/web/canvas-wheel.js';
import { screenToWorld, zoomAt } from '../src/web/geometry.js';
import type { SessionView } from '../src/shared/types.js';

test('pinch scale and midpoint retain their world anchor across limits', () => {
  const view = { x: -70, y: 40, zoom: .8, selectedObjectIds: ['selected'] }, start = { x: 320, y: 240 }, point = { x: 345, y: 220 };
  for (const [factor, expectedZoom] of [[.01, .05], [.125, .1], [.75, .6], [1.5, 1.2], [100, 4]]) {
    const next = canvasPinchView(view, factor, start, point), before = screenToWorld(start, view), after = screenToWorld(point, next);
    assert.ok(Math.abs(before.x - after.x) < 1e-9); assert.ok(Math.abs(before.y - after.y) < 1e-9);
    assert.ok(Math.abs(next.zoom - expectedZoom) < 1e-9); assert.deepEqual(next.selectedObjectIds, ['selected']);
  }
});

test('modifier wheel zoom reaches five percent while retaining the point under the cursor', () => {
  const original: SessionView = { x: -70, y: 40, zoom: .15, selectedObjectIds: ['selected'] };
  const event = { clientX: 600, clientY: 280, deltaX: 0, deltaY: 1000, deltaMode: 0, ctrlKey: true, metaKey: false };
  const view = canvasWheelView(original, event, { left: 0, top: 0, height: 700 });
  assert.equal(view.zoom, .05);
  const before = screenToWorld({ x: event.clientX, y: event.clientY }, original), after = screenToWorld({ x: event.clientX, y: event.clientY }, view);
  assert.ok(Math.abs(before.x - after.x) < 1e-9); assert.ok(Math.abs(before.y - after.y) < 1e-9);
  assert.deepEqual(canvasWheelView(view, event, { left: 0, top: 0, height: 700 }), view);
});

test('wheel supports continuous ctrl and meta zoom, ordinary pan, and line/page units', () => {
  const original: SessionView = { x: 0, y: 0, zoom: 1, selectedObjectIds: [] }, bounds = { left: 0, top: 0, height: 700 };
  for (const modifier of ['ctrlKey', 'metaKey'] as const) {
    let view = original;
    for (let index = 0; index < 24; index++) view = canvasWheelView(view, { clientX: 600, clientY: 280, deltaX: 0, deltaY: -4, deltaMode: 0, ctrlKey: false, metaKey: false, [modifier]: true }, bounds);
    assert.ok(Math.abs(view.zoom - Math.exp(.48)) < 1e-9); const anchor = screenToWorld({ x: 600, y: 280 }, view); assert.ok(Math.abs(anchor.x - 600) < 1e-9); assert.ok(Math.abs(anchor.y - 280) < 1e-9);
  }
  const input = { clientX: 20, clientY: 30, deltaX: 2, deltaY: 3, deltaMode: 1, ctrlKey: false, metaKey: false };
  assert.deepEqual(canvasWheelView(original, input, bounds), { ...original, x: -32, y: -48 });
  assert.deepEqual(canvasWheelView(original, { ...input, deltaMode: 2 }, bounds), { ...original, x: -1400, y: -2100 });
});

test('zero scale input and a clamped zoom preserve the exact fractional camera pose', () => {
  const view: SessionView = { x: 18.573612375, y: -167.4329941, zoom: .2, selectedObjectIds: [] };
  const input = { clientX: 411.125, clientY: 392.375, deltaX: 0, deltaY: 0, deltaMode: 0, ctrlKey: true, metaKey: false };
  assert.equal(canvasWheelView(view, input, { left: 0, top: 0, height: 786 }), view);
  assert.equal(canvasWheelView(view, { ...input, ctrlKey: false }, { left: 0, top: 0, height: 786 }), view);
  const limited = { x: view.x, y: view.y, zoom: .05 };
  assert.deepEqual(zoomAt(limited, .5, { x: input.clientX, y: input.clientY }), limited);
});
