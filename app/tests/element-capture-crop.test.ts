import test from 'node:test';
import assert from 'node:assert/strict';
import type { Bounds, ScenePresentation } from '../src/shared/types.js';
import { annotationCaptureCrop } from '../src/web/scene-renderer/capture-crop.js';
import { boundsToCSS, immutableCopy, sceneCrop } from '../src/web/scene-renderer/geometry.js';

function presentation(world: Bounds = { x: 100, y: 80, width: 600, height: 360 }): ScenePresentation {
  const camera = { x: 0, y: 0, zoom: 1 }, cssViewport = { x: 0, y: 0, width: 1000, height: 700 };
  return { documentId: 'document', viewId: 'view', baseSceneId: 'snapshot', frameSeq: 7, camera, cssViewport, bitmap: { width: 1000, height: 700 },
    layers: [{ objectId: 'object', objectVersion: 3, worldBounds: world, contentWorldBounds: { x: 140, y: 120, width: 520, height: 268 }, renderedBounds: boundsToCSS(world, camera, cssViewport), layer: 1 }], media: [] };
}

test('object point and local region use all four complete paint edges with the actual pin', () => {
  const frame = immutableCopy(presentation()), markerCSS = { x: 686, y: 427, width: 28, height: 28 };
  const point = { x: 660, y: 388, width: 0, height: 0 }, region = { x: 270, y: 150, width: 12, height: 8 };
  const expected = { x: 84, y: 64, width: 646, height: 407 };
  assert.deepEqual(annotationCaptureCrop({ presentation: frame, worldBounds: point, objectId: 'object', markerCSS }), expected);
  assert.deepEqual(annotationCaptureCrop({ presentation: frame, worldBounds: region, objectId: 'object', markerCSS }), expected);
  assert.deepEqual(frame.layers[0].contentWorldBounds, { x: 140, y: 120, width: 520, height: 268 });
  assert.equal(frame.frameSeq, 7);
});

test('stacked region pin outside the object remains inside the complete capture request', () => {
  const frame = presentation(), markerCSS = { x: 90, y: -46, width: 35, height: 35 };
  assert.deepEqual(annotationCaptureCrop({ presentation: frame, objectId: 'object', worldBounds: { x: 140, y: 120, width: 52, height: 26 }, markerCSS }), { x: 74, y: -62, width: 642, height: 518 });
});

test('blank point and cross-object region retain the existing selected-region context', () => {
  const frame = presentation();
  assert.deepEqual(annotationCaptureCrop({ presentation: frame, worldBounds: { x: 800, y: 600, width: 0, height: 0 } }), { x: 704, y: 504, width: 192, height: 192 });
  assert.deepEqual(annotationCaptureCrop({ presentation: frame, worldBounds: { x: 60, y: 40, width: 760, height: 430 } }), { x: -36, y: -56, width: 952, height: 622 });
});

test('complete element geometry follows actual CSS offset, pan and page plus canvas zoom', () => {
  const frame = presentation(); frame.camera = { x: -44.75, y: 19.5, zoom: 1.875 }; frame.cssViewport = { x: -30.25, y: 37.5, width: 720.5, height: 540.25 };
  frame.layers[0].renderedBounds = boundsToCSS(frame.layers[0].worldBounds, frame.camera, frame.cssViewport);
  const markerCSS = { x: 482.5, y: 262.25, width: 35, height: 35 }, worldBounds = { x: 305.3333333333333, y: 109.46666666666667, width: 0, height: 0 };
  const requested = annotationCaptureCrop({ presentation: frame, objectId: 'object', worldBounds, markerCSS });
  assert.deepEqual(requested, { x: 96.5, y: 191, width: 1157, height: 707 });
  for (const dpr of [1, 2]) {
    frame.bitmap = { width: Math.round(frame.cssViewport.width * dpr), height: Math.round(frame.cssViewport.height * dpr) };
    const clipped = sceneCrop(frame.cssViewport, frame.bitmap, requested, { x: 0, y: 0, width: 800, height: 600 });
    assert.equal(clipped.scaleX, frame.bitmap.width / frame.cssViewport.width); assert.equal(clipped.scaleY, frame.bitmap.height / frame.cssViewport.height);
    assert(clipped.cropCSS.x >= 0); assert(clipped.cropCSS.y >= 0);
    assert(clipped.cropCSS.x + clipped.cropCSS.width <= frame.cssViewport.x + frame.cssViewport.width + 1e-10);
    assert(clipped.cropCSS.y + clipped.cropCSS.height <= frame.cssViewport.y + frame.cssViewport.height + 1e-10);
    assert(clipped.sourcePixels.x >= 0); assert(clipped.sourcePixels.y >= 0);
    assert.equal(clipped.sourcePixels.width, clipped.bitmap.width);
  }
});

test('partly offscreen fractional elements copy only page-visible pixels at actual bitmap ratios', () => {
  const frame = presentation({ x: -60.5, y: -55.25, width: 270.25, height: 220.5 });
  frame.cssViewport = { x: -20.25, y: -15.5, width: 320.5, height: 240.25 };
  frame.bitmap = { width: 643, height: 479 };
  frame.layers[0].renderedBounds = boundsToCSS(frame.layers[0].worldBounds, frame.camera, frame.cssViewport);
  const requested = annotationCaptureCrop({ presentation: frame, objectId: 'object', worldBounds: { x: 20, y: 20, width: 0, height: 0 }, markerCSS: { x: -14.25, y: -9.5, width: 28, height: 28 } });
  const crop = sceneCrop(frame.cssViewport, frame.bitmap, requested, { x: 0, y: 0, width: 400, height: 300 });
  assert.deepEqual(crop.sourcePixels, { x: 41, y: 31, width: 412, height: 331 });
  assert(crop.cropCSS.x >= 0); assert(crop.cropCSS.y >= 0);
  assert(crop.cropCSS.x < 1 / crop.scaleX); assert(crop.cropCSS.y < 1 / crop.scaleY);
});

test('overlapping higher layers remain in the crop and the held frame determines complete bounds', () => {
  const frame = presentation();
  frame.layers.push({ objectId: 'occluder', objectVersion: 1, worldBounds: { x: 250, y: 190, width: 120, height: 120 }, renderedBounds: { x: 250, y: 190, width: 120, height: 120 }, layer: 2 });
  const held = immutableCopy(frame), oldCrop = annotationCaptureCrop({ presentation: held, objectId: 'object', worldBounds: { x: 140, y: 120, width: 0, height: 0 }, markerCSS: { x: 126, y: 106, width: 28, height: 28 } });
  frame.frameSeq += 5; frame.layers[0].renderedBounds = { x: 810, y: 660, width: 300, height: 180 }; frame.layers.splice(0, 1);
  assert.deepEqual(oldCrop, { x: 84, y: 64, width: 632, height: 392 });
  assert.equal(held.layers[1].objectId, 'occluder'); assert.equal(held.frameSeq, 7);
  assert.throws(() => annotationCaptureCrop({ presentation: frame, objectId: 'object', worldBounds: { x: 140, y: 120, width: 0, height: 0 } }), /presented frame/);
});

test('capture bounds reject unavailable numeric geometry', () => {
  const frame = presentation();
  assert.throws(() => annotationCaptureCrop({ presentation: frame, objectId: 'object', worldBounds: { x: NaN, y: 120, width: 0, height: 0 } }), /finite/);
  assert.throws(() => annotationCaptureCrop({ presentation: frame, objectId: 'object', worldBounds: { x: 140, y: 120, width: 0, height: 0 }, markerCSS: { x: 0, y: 0, width: -1, height: 28 } }), /nonnegative/);
});
