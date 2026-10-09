import test from 'node:test';
import assert from 'node:assert/strict';
import { canvasPinchView } from '../src/web/canvas-gestures.js';
import { canvasWheelView } from '../src/web/canvas-wheel.js';
import { screenToWorld } from '../src/web/geometry.js';
import type { SessionView } from '../src/shared/types.js';

test('pinch scale and midpoint retain their world anchor across limits', () => {
  const view = { x: -70, y: 40, zoom: .8, selectedObjectIds: ['selected'] }, start = { x: 320, y: 240 }, point = { x: 345, y: 220 };
  for (const factor of [.01, .75, 1.5, 100]) {
    const next = canvasPinchView(view, factor, start, point), before = screenToWorld(start, view), after = screenToWorld(point, next);
    assert.ok(Math.abs(before.x - after.x) < 1e-9); assert.ok(Math.abs(before.y - after.y) < 1e-9);
    assert.ok(next.zoom >= .15 && next.zoom <= 4); assert.deepEqual(next.selectedObjectIds, ['selected']);
  }
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
