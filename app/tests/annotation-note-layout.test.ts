import test from 'node:test';
import assert from 'node:assert/strict';
import { annotationBubbleTail, placePointAnnotationNote } from '../src/web/annotation-note-layout.js';
import { intersects, type Point, type Rect } from '../src/web/geometry.js';

// Exhaustive geometric oracle: score each allowed placement once, then apply the placement priorities.
function exhaustive(anchor: Point, size: { width: number; height: number }, viewport: Rect, obstacles: Rect[]) {
  const tail = annotationBubbleTail(28), marker = { x: anchor.x - tail.x, y: anchor.y - tail.y, width: 28, height: 28 };
  const beside = marker.x + 36, alignedY = size.height <= 28 ? marker.y + (28 - size.height) / 2 : marker.y;
  const clamp = (value: number, origin: number, length: number, size: number) => Math.max(origin, Math.min(Math.max(origin, origin + length - size), value));
  const xs = [beside, marker.x - size.width - 8, anchor.x - size.width / 2, viewport.x, Math.max(viewport.x, viewport.x + viewport.width - size.width), ...obstacles.flatMap(r => [r.x + r.width + 8, r.x - size.width - 8])].map(x => clamp(x, viewport.x, viewport.width, size.width));
  const ys = [alignedY, marker.y, anchor.y + 22, anchor.y - size.height - 22, viewport.y, Math.max(viewport.y, viewport.y + viewport.height - size.height), ...obstacles.flatMap(r => [r.y + r.height + 8, r.y - size.height - 8])].map(y => clamp(y, viewport.y, viewport.height, size.height));
  const overlap = (a: Rect, b: Rect) => Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  return ys.flatMap(y => xs.map(x => {
    const rect = { x, y, ...size }, markerHit = intersects(rect, marker), obstacleHit = obstacles.some(o => intersects(rect, o));
    return { rect, priority: !markerHit && !obstacleHit ? 0 : !markerHit ? 1 : 2, score: obstacles.reduce((sum, o) => sum + overlap(rect, o), 0) * 100 + overlap(rect, marker) * 1000 + Math.abs(x - beside) + Math.abs(y - alignedY) * 8 };
  })).sort((a, b) => a.priority - b.priority || a.score - b.score)[0].rect;
}

test('point comments retain exhaustive placement across crowded, clamped and fractional geometry', () => {
  let seed = 7183;
  const random = () => ((seed = Math.imul(seed, 1664525) + 1013904223 >>> 0) / 4294967296);
  for (let index = 0; index < 600; index++) {
    const viewport = { x: random() * 80, y: random() * 80, width: index % 5 ? 300 + random() * 1100 : 50, height: index % 7 ? 200 + random() * 700 : 20 };
    const anchor = { x: (random() - .15) * 1400, y: (random() - .15) * 1000 };
    const size = { width: 30 + random() * (index % 3 ? 220 : 500), height: index % 2 ? 28 : 30 + random() * 300 };
    const obstacles = Array.from({ length: index % 35 }, () => ({ x: (random() - .1) * 1200, y: (random() - .1) * 900, width: random() * 500, height: random() * 400 }));
    if (index % 4 === 0) obstacles.push({ ...viewport });
    assert.deepEqual(placePointAnnotationNote(anchor, size, viewport, obstacles), exhaustive(anchor, size, viewport, obstacles), `scene ${index}`);
  }
});

test('point comments preserve inclusive touching edges, duplicate coordinates and stable ties', () => {
  for (const viewport of [{ x: 0, y: 0, width: 800, height: 600 }, { x: 80, y: 90, width: 40, height: 20 }]) {
    for (const anchor of [{ x: 200, y: 200 }, { x: -20, y: 150 }, { x: 900, y: 800 }]) {
      const size = { width: 220, height: 28 }, tail = annotationBubbleTail(28);
      const obstacles = [{ x: anchor.x - tail.x + 36 + size.width, y: anchor.y - tail.y, width: 0, height: 28 }, { ...viewport }, { ...viewport }];
      assert.deepEqual(placePointAnnotationNote(anchor, size, viewport, obstacles), exhaustive(anchor, size, viewport, obstacles));
    }
  }
});
