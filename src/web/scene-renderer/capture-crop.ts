import type { SceneBounds, ScenePresentation, Immutable } from './types.js';
import { boundsToCSS } from './geometry.js';

interface AnnotationCaptureCropInput {
  presentation: ScenePresentation | Immutable<ScenePresentation>;
  worldBounds: SceneBounds;
  objectId?: string;
  /** The marker's CSS bounds from the same presented frame. */
  markerCSS?: SceneBounds;
}

function expanded(bounds: SceneBounds, padding: number): SceneBounds {
  return { x: bounds.x - padding, y: bounds.y - padding, width: bounds.width + padding * 2, height: bounds.height + padding * 2 };
}

function enclosing(bounds: SceneBounds[]): SceneBounds {
  if (bounds.some(value => ![value.x, value.y, value.width, value.height].every(Number.isFinite) || value.width < 0 || value.height < 0)) {
    throw new RangeError('Annotation capture bounds must have finite coordinates and nonnegative dimensions.');
  }
  const x = Math.min(...bounds.map(value => value.x)), y = Math.min(...bounds.map(value => value.y));
  return { x, y, width: Math.max(...bounds.map(value => value.x + value.width)) - x, height: Math.max(...bounds.map(value => value.y + value.height)) - y };
}

/** Chooses context from the visible frame; SceneRenderer.capture clips it to available Canvas and page pixels. */
export function annotationCaptureCrop({ presentation, worldBounds, objectId, markerCSS }: AnnotationCaptureCropInput): SceneBounds {
  const targetCSS = boundsToCSS(worldBounds, presentation.camera, presentation.cssViewport);
  if (!objectId) return expanded(enclosing([targetCSS]), 96);
  const layer = presentation.layers.find(value => value.objectId === objectId);
  if (!layer) throw new Error('The annotation object is unavailable in the presented frame.');
  return expanded(enclosing([layer.renderedBounds, targetCSS, ...(markerCSS ? [markerCSS] : [])]), 16);
}
