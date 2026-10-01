import test from 'node:test';
import assert from 'node:assert/strict';
import { alignedPositions, mediaContentRect, normalizedRegion, objectRegion, resizeBounds, screenToWorld, snapResize, snapTranslation, worldToScreen, zoomAt, type Alignment, type Rect, type ResizeCorner } from '../src/web/geometry.js';

const corners: ResizeCorner[] = ['nw', 'ne', 'sw', 'se'];
const oppositeCorner = (bounds: Rect, corner: ResizeCorner) => ({ x: bounds.x + (corner.endsWith('w') ? bounds.width : 0), y: bounds.y + (corner.startsWith('n') ? bounds.height : 0) });
const closeBounds = (actual: Rect, expected: Rect) => {
  for (const key of ['x', 'y', 'width', 'height'] as const) assert.ok(Math.abs(actual[key] - expected[key]) < 1e-9, `${key}: ${actual[key]} versus ${expected[key]}`);
};

test('all four resize corners preserve aspect ratio and their opposite corner', () => {
  const original = Object.freeze({ x: 10, y: 20, width: 200, height: 100 });
  for (const corner of corners) {
    const west = corner.endsWith('w'), north = corner.startsWith('n');
    const result = resizeBounds(original, corner, { x: west ? -40 : 40, y: north ? -20 : 20 });
    closeBounds(result, { x: west ? -30 : 10, y: north ? 0 : 20, width: 240, height: 120 });
    assert.deepEqual(oppositeCorner(result, corner), oppositeCorner(original, corner));
    assert.equal(result.width / result.height, original.width / original.height);
  }
});

test('resize projects both pointer axes onto the aspect diagonal', () => {
  const original = { x: 10, y: 20, width: 200, height: 100 };
  closeBounds(resizeBounds(original, 'se', { x: 40, y: 0 }), { x: 10, y: 20, width: 232, height: 116 });
  closeBounds(resizeBounds(original, 'se', { x: 0, y: 40 }), { x: 10, y: 20, width: 216, height: 108 });
  closeBounds(resizeBounds(original, 'se', { x: 20, y: -40 }), original);
});

test('resize limits both dimensions while preserving the anchor for every corner', () => {
  for (const original of [{ x: 10, y: 20, width: 300, height: 100 }, { x: 10, y: 20, width: 100, height: 300 }]) {
    for (const corner of corners) {
      const result = resizeBounds(original, corner, { x: corner.endsWith('w') ? 1000 : -1000, y: corner.startsWith('n') ? 1000 : -1000 });
      assert.ok(result.width >= 40 && result.height >= 40);
      assert.equal(Math.min(result.width, result.height), 40);
      assert.deepEqual(oppositeCorner(result, corner), oppositeCorner(original, corner));
      assert.equal(result.width / result.height, original.width / original.height);
    }
  }
  closeBounds(resizeBounds({ x: 0, y: 0, width: 300, height: 100 }, 'se', { x: -1000, y: -1000 }, 80), { x: 0, y: 0, width: 240, height: 80 });
});

test('each resize corner snaps its moving edge to a target center', () => {
  const original = { id: 'moving', x: 10, y: 20, width: 100, height: 100 };
  for (const corner of corners) {
    const west = corner.endsWith('w'), north = corner.startsWith('n'), edge = west ? 0 : 120;
    const result = snapResize(original, corner, { x: west ? -7 : 7, y: north ? -7 : 7 }, [{ id: 'target', x: edge - 10, y: 300, width: 20, height: 40 }], { x: 0, y: 0, zoom: 1 }, { width: 800, height: 600 });
    closeBounds(result.bounds, { x: west ? 0 : 10, y: north ? 10 : 20, width: 110, height: 110 });
    assert.deepEqual(oppositeCorner(result.bounds, corner), oppositeCorner(original, corner));
    assert.deepEqual(result.guides.map(guide => [guide.axis, guide.position]), [['x', edge]]);
    assert.ok(Math.abs(result.guides[0].start - (north ? 10 : 20)) < 1e-9); assert.equal(result.guides[0].end, 340);
  }
});

test('resize chooses the closest diagonal displacement when two axes conflict', () => {
  const original = { id: 'moving', x: 0, y: 0, width: 200, height: 100 };
  const targets = [{ id: 'x', x: 204, y: 300, width: 40, height: 40 }, { id: 'y', x: 500, y: 103, width: 40, height: 40 }];
  const result = snapResize(original, 'se', { x: 0, y: 0 }, targets, { x: 0, y: 0, zoom: 1 }, { width: 1000, height: 800 });
  closeBounds(result.bounds, { x: 0, y: 0, width: 204, height: 102 });
  assert.deepEqual(result.guides, [{ axis: 'x', position: 204, start: 0, end: 340 }]);
});

test('resize shows both guides when the target edges share one aspect scale', () => {
  const original = { id: 'moving', x: 0, y: 0, width: 200, height: 100 };
  const targets = [{ id: 'x', x: 204, y: 300, width: 40, height: 40 }, { id: 'y', x: 500, y: 102, width: 40, height: 40 }];
  const result = snapResize(original, 'se', { x: 0, y: 0 }, targets, { x: 0, y: 0, zoom: 1 }, { width: 1000, height: 800 });
  closeBounds(result.bounds, { x: 0, y: 0, width: 204, height: 102 });
  assert.deepEqual(result.guides, [{ axis: 'x', position: 204, start: 0, end: 340 }, { axis: 'y', position: 102, start: 0, end: 540 }]);
});

test('resize snap threshold stays six screen pixels across zoom levels', () => {
  const original = { id: 'moving', x: 0, y: 0, width: 100, height: 100 };
  for (const zoom of [.5, 1, 2]) {
    const view = { x: 0, y: 0, zoom }, viewport = { width: 1000, height: 1000 };
    const target = { id: 'target', x: 100 + 6 / zoom, y: 300, width: 100, height: 100 };
    const atThreshold = snapResize(original, 'se', { x: 0, y: 0 }, [target], view, viewport);
    assert.ok(Math.abs(atThreshold.bounds.width - target.x) < 1e-9); assert.equal(atThreshold.guides.length, 1);
    const outside = snapResize(original, 'se', { x: 0, y: 0 }, [{ ...target, x: 100 + 6.1 / zoom }], view, viewport);
    assert.deepEqual(outside, { bounds: { x: 0, y: 0, width: 100, height: 100 }, guides: [] });
  }
});

test('resize snapping excludes self and offscreen targets, and supports bypass', () => {
  const original = { id: 'moving', x: 500, y: 50, width: 100, height: 100 }, view = { x: 0, y: 0, zoom: 1 }, viewport = { width: 600, height: 400 };
  const bounds = { x: 500, y: 50, width: 100, height: 100 };
  assert.deepEqual(snapResize(original, 'se', { x: 0, y: 0 }, [original, { id: 'offscreen', x: 604, y: 140, width: 20, height: 20 }], view, viewport), { bounds, guides: [] });
  const visible = { id: 'visible', x: 598, y: 300, width: 20, height: 20 };
  assert.equal(snapResize(original, 'se', { x: 0, y: 0 }, [visible], view, viewport).bounds.width, 98);
  assert.deepEqual(snapResize(original, 'se', { x: 0, y: 0 }, [visible], view, viewport, true), { bounds, guides: [] });
});

test('resize snapping retains minimum dimensions when a nearby target is smaller', () => {
  const original = { id: 'moving', x: 0, y: 0, width: 200, height: 100 };
  const result = snapResize(original, 'se', { x: -1000, y: -1000 }, [{ id: 'small', x: 79, y: 300, width: .1, height: 20 }], { x: 0, y: 0, zoom: 1 }, { width: 800, height: 600 });
  assert.deepEqual(result, { bounds: { x: 0, y: 0, width: 80, height: 40 }, guides: [] });
});

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
