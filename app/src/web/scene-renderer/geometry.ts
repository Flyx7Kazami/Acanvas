import type { SceneBounds, SceneCamera, SceneCrop, SceneSize } from './types.js';

export function requireSize(size: SceneSize, integer = false): void {
  if (![size.width, size.height].every(value => Number.isFinite(value) && value > 0 && (!integer || Number.isInteger(value)))) {
    throw new RangeError('Scene dimensions must be positive finite values.');
  }
}

export function boundsToCSS(bounds: SceneBounds, camera: SceneCamera, origin = { x: 0, y: 0 }): SceneBounds {
  return { x: bounds.x * camera.zoom + camera.x + origin.x, y: bounds.y * camera.zoom + camera.y + origin.y, width: bounds.width * camera.zoom, height: bounds.height * camera.zoom };
}

/** Pixel edges enclose the requested crop; an optional visible clip keeps each copied pixel inside its bounds. */
export function sceneCrop(cssViewport: SceneBounds, bitmap: SceneSize, requested?: SceneBounds, clipCSS?: SceneBounds): SceneCrop {
  requireSize(cssViewport); requireSize(bitmap, true);
  if (![cssViewport.x, cssViewport.y].every(Number.isFinite)) throw new RangeError('Scene viewport origin must have finite coordinates.');
  const requestedCSS = requested ?? cssViewport;
  if (![requestedCSS.x, requestedCSS.y, requestedCSS.width, requestedCSS.height].every(Number.isFinite) || requestedCSS.width <= 0 || requestedCSS.height <= 0) {
    throw new RangeError('Scene crop must have finite coordinates and positive dimensions.');
  }
  const scaleX = bitmap.width / cssViewport.width, scaleY = bitmap.height / cssViewport.height;
  if (clipCSS && (![clipCSS.x, clipCSS.y, clipCSS.width, clipCSS.height].every(Number.isFinite) || clipCSS.width <= 0 || clipCSS.height <= 0)) throw new RangeError('Scene crop clipping requires finite positive bounds.');
  const clipLeft = clipCSS ? Math.max(0, Math.ceil((clipCSS.x - cssViewport.x) * scaleX)) : 0, clipTop = clipCSS ? Math.max(0, Math.ceil((clipCSS.y - cssViewport.y) * scaleY)) : 0;
  const clipRight = clipCSS ? Math.min(bitmap.width, Math.floor((clipCSS.x + clipCSS.width - cssViewport.x) * scaleX)) : bitmap.width, clipBottom = clipCSS ? Math.min(bitmap.height, Math.floor((clipCSS.y + clipCSS.height - cssViewport.y) * scaleY)) : bitmap.height;
  const left = Math.max(clipLeft, Math.floor((requestedCSS.x - cssViewport.x) * scaleX));
  const top = Math.max(clipTop, Math.floor((requestedCSS.y - cssViewport.y) * scaleY));
  const right = Math.min(clipRight, Math.ceil((requestedCSS.x - cssViewport.x + requestedCSS.width) * scaleX));
  const bottom = Math.min(clipBottom, Math.ceil((requestedCSS.y - cssViewport.y + requestedCSS.height) * scaleY));
  if (right <= left || bottom <= top) throw new RangeError('Scene crop must intersect the presented viewport.');
  return {
    requestedCSS: { ...requestedCSS },
    cropCSS: { x: cssViewport.x + left / scaleX, y: cssViewport.y + top / scaleY, width: (right - left) / scaleX, height: (bottom - top) / scaleY },
    sourcePixels: { x: left, y: top, width: right - left, height: bottom - top },
    bitmap: { width: right - left, height: bottom - top }, scaleX, scaleY,
  };
}

export function immutableCopy<T>(value: T): T {
  const copy = structuredClone(value);
  const freeze = (item: unknown): void => {
    if (item && typeof item === 'object') {
      for (const child of Object.values(item)) freeze(child);
      Object.freeze(item);
    }
  };
  freeze(copy); return copy;
}
