import type { AnnotationInput, AnnotationTarget, Asset, BoardObject, ContentAnchor, SessionView, ScenePresentation } from '../shared/types.js';
import type { BrowserCaptureFrame, BrowserCaptureIdentity } from '../shared/browser-capture.js';
import { intersects, normalizedRegion, objectRegion, screenBounds, unionBounds, type Rect } from './geometry.js';
import type { Immutable } from './scene-renderer/types.js';
import { resolveContentKind } from '../shared/content-types.js';
import { readMarkdownContentAnchor } from './scene-renderer/media/markdown-anchor.js';

export const annotationTarget = (annotation: AnnotationInput): AnnotationTarget => {
  const { scope, objectId, objectIds, assetId, bounds, coordinateSpace, timeStart, timeEnd, snapshotAssetId, geometry, contentAnchor } = annotation;
  return { scope, ...(objectId ? { objectId } : {}), objectIds, ...(assetId ? { assetId } : {}), bounds, coordinateSpace, ...(timeStart !== undefined ? { timeStart } : {}), ...(timeEnd !== undefined ? { timeEnd } : {}), ...(snapshotAssetId ? { snapshotAssetId } : {}), ...(geometry ? { geometry } : {}), ...(contentAnchor ? { contentAnchor } : {}) };
};

export const contains = (outer: Rect, inner: Rect) => inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.width <= outer.x + outer.width && inner.y + inner.height <= outer.y + outer.height;

export function markTarget(world: Rect, geometry: 'point' | 'rect', objects: BoardObject[], contentBounds: (object: BoardObject) => Rect, chosenId?: string): Partial<AnnotationInput> {
  const candidates = [...objects].reverse().filter(object => contains(contentBounds(object), world));
  const object = chosenId ? candidates.find(value => value.id === chosenId) : candidates[0];
  return object ? { scope: 'object', objectId: object.id, objectIds: [object.id], assetId: object.assetId, bounds: normalizedRegion(world, contentBounds(object)), coordinateSpace: 'normalized', geometry } : { scope: 'region', objectId: undefined, objectIds: [], assetId: undefined, bounds: world, coordinateSpace: 'world', geometry, timeStart: undefined, timeEnd: undefined, snapshotAssetId: undefined, contentAnchor: undefined };
}

function inRoundedBody(point: { x: number; y: number }, body: Rect, radius: number): boolean {
  if (!contains(body, { ...point, width: 0, height: 0 })) return false;
  const x = Math.max(body.x + radius, Math.min(body.x + body.width - radius, point.x));
  const y = Math.max(body.y + radius, Math.min(body.y + body.height - radius, point.y));
  return Math.hypot(point.x - x, point.y - y) <= radius;
}

/** Selects content from the displayed frame, with opaque bodies shielding lower layers. */
export function presentedMarkTarget(world: Rect, geometry: 'point' | 'rect', presentation: Immutable<ScenePresentation> | undefined, objects: BoardObject[], assets: Asset[]): Partial<AnnotationInput> {
  const layers = [...(presentation?.layers || [])].sort((a, b) => b.layer - a.layer);
  const body = (id: string) => objects.find(object => object.id === id);
  const radius = (id: string) => {
    const object = body(id);
    return object && resolveContentKind(assets.find(asset => asset.id === object.assetId)) === 'audio' ? Math.min(22, object.width / 2, object.height / 2) : 0;
  };
  const topAt = (point: { x: number; y: number }) => layers.find(layer => {
    const object = body(layer.objectId); return !!object && inRoundedBody(point, object, radius(object.id));
  });
  const fallback = () => markTarget(world, geometry, [], () => world);
  const center = { x: world.x + world.width / 2, y: world.y + world.height / 2 };
  const layer = topAt(center), object = layer && body(layer.objectId), content = layer?.contentWorldBounds;
  if (!object || !content || !contains(content, world)) return fallback();
  const corners = [world, { x: world.x + world.width, y: world.y }, { x: world.x, y: world.y + world.height }, { x: world.x + world.width, y: world.y + world.height }];
  if (corners.some(point => topAt(point)?.objectId !== object.id)) return fallback();
  if (geometry === 'rect') {
    // The nearest point to a rounded body's center tests exact rounded-rectangle overlap.
    const occluded = layers.filter(value => value.layer > layer!.layer).some(value => {
      const cover = body(value.objectId); if (!cover || !intersects(world, cover)) return false;
      const x = Math.max(world.x, Math.min(world.x + world.width, cover.x + cover.width / 2));
      const y = Math.max(world.y, Math.min(world.y + world.height, cover.y + cover.height / 2));
      return inRoundedBody({ x, y }, cover, radius(cover.id));
    });
    if (occluded) return fallback();
  }
  return markTarget(world, geometry, [object], () => content);
}

export function requestedMarkdownAnchor(objectId: string): ContentAnchor | undefined {
  const object = document.querySelector<HTMLElement>(`[data-object-id="${CSS.escape(objectId)}"]`);
  const scroll = object?.querySelector<HTMLElement>('.markdown-content');
  if (!scroll) return;
  return readMarkdownContentAnchor(scroll);
}

function clip(a: Rect, b: Rect): Rect | undefined {
  const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y), right = Math.min(a.x + a.width, b.x + b.width), bottom = Math.min(a.y + a.height, b.y + b.height);
  return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : undefined;
}

function subtract(rect: Rect, cover: Rect): Rect[] {
  const overlap = clip(rect, cover); if (!overlap) return [rect];
  return [
    { x: rect.x, y: rect.y, width: rect.width, height: overlap.y - rect.y },
    { x: rect.x, y: overlap.y + overlap.height, width: rect.width, height: rect.y + rect.height - overlap.y - overlap.height },
    { x: rect.x, y: overlap.y, width: overlap.x - rect.x, height: overlap.height },
    { x: overlap.x + overlap.width, y: overlap.y, width: rect.x + rect.width - overlap.x - overlap.width, height: overlap.height },
  ].filter(value => value.width > 0 && value.height > 0);
}

function hasOpaqueRect(element: HTMLElement | null): boolean {
  const media = element?.querySelector<HTMLElement>('.object-media');
  if (!element || !media) return false;
  const outer = getComputedStyle(element), style = getComputedStyle(media);
  return style.backgroundColor.startsWith('rgb(') && !style.backgroundColor.includes('/') &&
    [outer, style].every(value => value.opacity === '1' && value.filter === 'none' && value.clipPath === 'none' && value.maskImage === 'none' && value.mixBlendMode === 'normal' && [value.borderTopLeftRadius, value.borderTopRightRadius, value.borderBottomLeftRadius, value.borderBottomRightRadius].every(radius => Number.parseFloat(radius) === 0));
}

export function captureScene({ identity, annotation, canvas, objects, assets, view, contentBounds, media }: {
  identity: BrowserCaptureIdentity; annotation: AnnotationInput; canvas: HTMLElement; objects: BoardObject[]; assets: Asset[]; view: SessionView;
  contentBounds: (object: BoardObject) => Rect; media: Map<string, HTMLMediaElement>;
}): BrowserCaptureFrame {
  objects = [...objects].sort((a, b) => {
    const layer = (id: string) => { const node = canvas.querySelector<HTMLElement>(`[data-object-id="${CSS.escape(id)}"]`); return node ? Number.parseInt(getComputedStyle(node).zIndex, 10) || 0 : 0; };
    return layer(a.id) - layer(b.id);
  });
  const board = canvas.getBoundingClientRect();
  const object = objects.find(value => value.id === annotation.objectId);
  const worldBounds = annotation.coordinateSpace === 'normalized' && object ? objectRegion(annotation.bounds, contentBounds(object)) : annotation.bounds;
  const viewport = { x: view.x + board.left, y: view.y + board.top, zoom: view.zoom, width: innerWidth, height: innerHeight, devicePixelRatio };
  const marker = screenBounds(worldBounds, viewport);
  const full = { x: Math.max(0, board.left), y: Math.max(0, board.top), width: Math.min(innerWidth, board.right) - Math.max(0, board.left), height: Math.min(innerHeight, board.bottom) - Math.max(0, board.top) };
  const margin = 96;
  const region = { x: Math.max(full.x, marker.x - margin), y: Math.max(full.y, marker.y - margin), width: 0, height: 0 };
  region.width = Math.min(full.x + full.width, marker.x + marker.width + margin) - region.x;
  region.height = Math.min(full.y + full.height, marker.y + marker.height + margin) - region.y;
  if (region.width <= 0 || region.height <= 0 || !intersects(marker, full)) throw new Error('Move the annotation into view, then capture it again.');
  const rendered = objects.map(value => {
    const element = canvas.querySelector<HTMLElement>(`[data-object-id="${CSS.escape(value.id)}"]`), rect = element?.getBoundingClientRect();
    return rect ? { x: (rect.x - viewport.x) / view.zoom, y: (rect.y - viewport.y) / view.zoom, width: rect.width / view.zoom, height: rect.height / view.zoom } : value;
  });
  const covers = objects.map(value => hasOpaqueRect(canvas.querySelector<HTMLElement>(`[data-object-id="${CSS.escape(value.id)}"]`)));
  const worldCrop = { x: (region.x - viewport.x) / view.zoom, y: (region.y - viewport.y) / view.zoom, width: region.width / view.zoom, height: region.height / view.zoom };
  const entries = objects.flatMap((value, layer) => {
    const visible = clip(rendered[layer], worldCrop);
    let pieces = visible ? [visible] : [];
    for (let above = layer + 1; above < rendered.length && pieces.length; above++) if (covers[above]) pieces = pieces.flatMap(piece => subtract(piece, rendered[above]));
    if (!pieces.length && !annotation.objectIds.includes(value.id) && annotation.objectId !== value.id) return [];
    const element = canvas.querySelector<HTMLElement>(`[data-object-id="${CSS.escape(value.id)}"]`), scroll = element?.querySelector<HTMLElement>('.markdown-content');
    const player = media.get(value.id);
    return [{ object: value, renderedBounds: rendered[layer], layer, ...(pieces.length ? { visibleBounds: unionBounds(pieces) } : {}), ...(player && Number.isFinite(player.currentTime) ? { media: { playbackTime: player.currentTime } } : {}), ...(scroll ? { scroll: { x: scroll.scrollLeft, y: scroll.scrollTop } } : {}) }];
  });
  const selected = entries.filter(value => annotation.objectIds.includes(value.object.id) || annotation.objectId === value.object.id);
  const nearby = entries.filter(value => !selected.includes(value));
  const sceneObjects = [...selected, ...nearby].slice(0, 64).sort((a, b) => a.layer - b.layer || a.object.id.localeCompare(b.object.id));
  const ids = new Set(sceneObjects.map(value => value.object.assetId));
  if (annotation.assetId) ids.add(annotation.assetId); if (annotation.snapshotAssetId) ids.add(annotation.snapshotAssetId);
  for (const id of [...ids]) for (const resource of Object.values(assets.find(asset => asset.id === id)?.htmlBundle?.files || {})) ids.add(resource);
  const sceneAssets = [...ids].map(id => assets.find(asset => asset.id === id)).filter((asset): asset is Asset => !!asset);
  if (sceneAssets.length > 256 || sceneAssets.length !== ids.size) throw new Error('The scene assets are unavailable. Reload the board, then retry.');
  return { identity, target: annotationTarget(annotation), worldBounds, viewport, crop: region, scene: { objects: sceneObjects, assets: sceneAssets, omittedCount: entries.length - sceneObjects.length } };
}
