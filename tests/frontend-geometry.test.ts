import test from 'node:test';
import assert from 'node:assert/strict';
import { alignedPositions, mediaContentRect, normalizedRegion, objectRegion, screenToWorld, snapTranslation, worldToScreen, zoomAt, type Alignment } from '../src/web/geometry.js';

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

test('snap chooses the closest edges independently and ignores offscreen targets', () => {
  const moving = [{ id: 'moving', x: 0, y: 0, width: 20, height: 20 }];
  const targets = [{ id: 'near', x: 100, y: 80, width: 40, height: 20 }, { id: 'farther', x: 101, y: 200, width: 40, height: 20 }];
  const result = snapTranslation(moving, targets, { x: 78, y: 60 }, { x: 0, y: 0, zoom: 1 }, { width: 800, height: 600 });
  assert.deepEqual(result.delta, { x: 80, y: 60 });
  assert.deepEqual(result.guides.map(guide => [guide.axis, guide.position]), [['x', 100], ['y', 80]]);
  const offscreen = [{ id: 'hidden', x: 900, y: 100, width: 20, height: 20 }];
  assert.deepEqual(snapTranslation(moving, offscreen, { x: 878, y: 80 }, { x: 0, y: 0, zoom: 1 }, { width: 800, height: 600 }), { delta: { x: 878, y: 80 }, guides: [] });
});

test('snap threshold remains six screen pixels at several zoom levels', () => {
  const moving = [{ id: 'moving', x: 0, y: 0, width: 20, height: 20 }], objects = [{ id: 'target', x: 100, y: 500, width: 20, height: 20 }];
  for (const zoom of [.5, 1, 2]) {
    const view = { x: 0, y: 0, zoom }, viewport = { width: 800, height: 1200 };
    const atThreshold = snapTranslation(moving, objects, { x: 80 - 6 / zoom, y: 100 }, view, viewport);
    assert.equal(atThreshold.delta.x, 80); assert.equal(atThreshold.guides.length, 1);
    const outside = snapTranslation(moving, objects, { x: 80 - 6.1 / zoom, y: 100 }, view, viewport);
    assert.equal(outside.guides.length, 0);
  }
});

test('group snapping uses its union and excludes every moving member', () => {
  const moving = [{ id: 'a', x: 0, y: 0, width: 20, height: 30 }, { id: 'b', x: 50, y: 40, width: 20, height: 30 }];
  const view = { x: 0, y: 0, zoom: 1 }, viewport = { width: 800, height: 600 };
  const free = snapTranslation(moving, moving, { x: 1, y: 2 }, view, viewport);
  assert.deepEqual(free, { delta: { x: 1, y: 2 }, guides: [] });
  const result = snapTranslation(moving, [...moving, { id: 'target', x: 100, y: 200, width: 20, height: 20 }], { x: 26, y: 0 }, view, viewport);
  assert.equal(result.delta.x, 30); assert.equal(moving[1].x + result.delta.x - moving[0].x - result.delta.x, 50);
});

test('six alignment positions use union boundaries and skip unchanged objects', () => {
  const objects = [{ id: 'a', x: 10, y: 20, width: 40, height: 30 }, { id: 'b', x: 70, y: 80, width: 20, height: 50 }];
  const expected: Record<Alignment, { id: string; x: number; y: number }[]> = {
    left: [{ id: 'b', x: 10, y: 80 }], 'horizontal-center': [{ id: 'a', x: 30, y: 20 }, { id: 'b', x: 40, y: 80 }], right: [{ id: 'a', x: 50, y: 20 }],
    top: [{ id: 'b', x: 70, y: 20 }], 'vertical-center': [{ id: 'a', x: 10, y: 60 }, { id: 'b', x: 70, y: 50 }], bottom: [{ id: 'a', x: 10, y: 100 }],
  };
  for (const alignment of Object.keys(expected) as Alignment[]) assert.deepEqual(alignedPositions(objects, alignment), expected[alignment]);
  assert.deepEqual(alignedPositions([{ ...objects[0] }, { ...objects[1], x: 10 }], 'left'), []);
  assert.deepEqual(alignedPositions([objects[0]], 'bottom'), []);
  assert.equal(objects[0].width, 40); assert.equal(objects[1].height, 50);
});

test('decimal alignment keeps equal anchors unchanged and retains real subpixel moves', () => {
  const objects = [{ id: 'a', x: 1.2, y: 10, width: 100, height: 40 }, { id: 'b', x: 51.2, y: 20, width: 50, height: 20 }];
  assert.deepEqual(alignedPositions(objects, 'right'), []);
  const moved = alignedPositions([objects[0], { ...objects[1], x: 51.20000001 }], 'right');
  assert.equal(moved.length, 1); assert.equal(moved[0].id, 'a'); assert.ok(moved[0].x > 1.200000005);
});
