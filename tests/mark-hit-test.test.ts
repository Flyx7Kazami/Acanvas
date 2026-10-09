import test from 'node:test';
import assert from 'node:assert/strict';
import type { Asset, BoardObject, ScenePresentation } from '../src/shared/types.js';
import { presentedMarkTarget } from '../src/web/annotation-scene.js';

const object = (id: string, bounds = { x: 0, y: 0, width: 300, height: 300 }): BoardObject => ({ id, assetId: id, type: 'image', version: 1, ...bounds, createdAt: '', updatedAt: '' });
const asset = (id: string, mime: string): Asset => ({ id, name: id, kind: mime.startsWith('audio') ? 'file' : 'image', mime, size: 1, createdAt: '' });
function presentation(objects: BoardObject[], contents = objects): ScenePresentation {
  return { documentId: 'document', viewId: 'view', baseSceneId: 'base', frameSeq: 1, camera: { x: 0, y: 0, zoom: 1 }, cssViewport: { x: 0, y: 0, width: 320, height: 700 }, bitmap: { width: 640, height: 1400 }, media: [], layers: objects.map((object, layer) => ({ objectId: object.id, assetId: object.assetId, objectVersion: 1, layer, worldBounds: object, renderedBounds: object, contentWorldBounds: contents[layer] })) };
}

test('presented Mark ownership respects letterbox opaque bodies rounded corners and every crossing occluder', () => {
  const lower = object('lower'), upper = object('upper', { x: 40, y: 40, width: 200, height: 200 });
  const content = { ...upper, y: 90, height: 100 }, objects = [lower, upper], assets = [asset('lower', 'image/png'), asset('upper', 'image/png')];
  const shown = presentation(objects, [lower, content]);
  const point = (x: number, y: number) => presentedMarkTarget({ x, y, width: 0, height: 0 }, 'point', shown, objects, assets);
  assert.equal(point(100, 100).objectId, upper.id); assert.equal(point(100, 60).scope, 'region'); assert.equal(point(30, 100).objectId, lower.id); assert.equal(point(310, 310).scope, 'region');
  assert.equal(presentedMarkTarget({ x: 60, y: 100, width: 100, height: 70 }, 'rect', shown, objects, assets).objectId, upper.id);
  assert.equal(presentedMarkTarget({ x: 30, y: 100, width: 100, height: 70 }, 'rect', shown, objects, assets).scope, 'region');
  const cover = object('cover', { x: 95, y: 113, width: 1, height: 1 }), crossed = [lower, cover];
  assert.equal(presentedMarkTarget({ x: 20, y: 20, width: 230, height: 220 }, 'rect', presentation(crossed), crossed, assets).scope, 'region');
  const rounded = [lower, upper], roundAssets = [assets[0], asset('upper', 'audio/mpeg')], roundFrame = presentation(rounded);
  assert.equal(presentedMarkTarget({ x: 41, y: 41, width: 0, height: 0 }, 'point', roundFrame, rounded, roundAssets).objectId, lower.id);
  assert.equal(presentedMarkTarget({ x: 100, y: 41, width: 0, height: 0 }, 'point', roundFrame, rounded, roundAssets).objectId, upper.id);
  assert.equal(presentedMarkTarget({ x: 40, y: 40, width: 200, height: 200 }, 'rect', roundFrame, rounded, roundAssets).scope, 'region');
});
