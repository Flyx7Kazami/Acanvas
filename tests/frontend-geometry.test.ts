import test from 'node:test';
import assert from 'node:assert/strict';
import { mediaContentRect, normalizedRegion, objectRegion, screenToWorld, worldToScreen, zoomAt } from '../src/web/geometry.js';

test('media annotation excludes letterboxing and follows move/resize under zoom', () => {
  const object = { x: 200, y: -80, width: 400, height: 400 };
  const media = mediaContentRect(object, { width: 600, height: 300 });
  assert.deepEqual(media, { x: 200, y: 20, width: 400, height: 200 });
  const view = { x: 70, y: 130, zoom: 1.75 };
  const region = { x: 280, y: 60, width: 200, height: 100 };
  assert.deepEqual(screenToWorld(worldToScreen({ x: region.x, y: region.y }, view), view), { x: region.x, y: region.y });
  const normalized = normalizedRegion(region, media);
  for (const [key, expected] of Object.entries({ x: .2, y: .2, width: .5, height: .5 })) assert.ok(Math.abs(normalized[key as keyof typeof normalized] - expected) < 1e-9);
  const moved = mediaContentRect({ x: -20, y: 100, width: 800, height: 800 }, { width: 600, height: 300 });
  const relocated = objectRegion(normalized, moved);
  for (const [key, expected] of Object.entries({ x: 140, y: 380, width: 400, height: 200 })) assert.ok(Math.abs(relocated[key as keyof typeof relocated] - expected) < 1e-9);
});

test('zoom preserves the cursor world point at supported scale limits', () => {
  const original = { x: -120, y: 65, zoom: .8 }, anchor = { x: 640, y: 300 };
  for (const factor of [.01, 1.5, 100]) {
    const next = zoomAt(original, factor, anchor);
    assert.deepEqual(screenToWorld(anchor, next), screenToWorld(anchor, original));
    assert.ok(next.zoom >= .15 && next.zoom <= 4);
  }
});
