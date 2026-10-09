import { createContext, useContext, useEffect, useMemo } from 'react';
import type { CaptureView, ContentAnchor, HtmlSurfaceReference, PresentedMedia } from '../../shared/types.js';
import { immutableCopy, requireSize } from './geometry.js';
import type { Immutable, SceneBounds, SceneSize, SceneTextureDrawable } from './types.js';

export interface ContentTextRun { text: string; start: number; end: number; bounds: SceneBounds; href?: string }
export interface SceneContentFrameInput {
  pixels: CanvasImageSource;
  bitmap: SceneSize;
  cssSize?: SceneSize;
  layoutSeq?: number;
  contentBounds?: SceneBounds;
  fit?: 'contain' | 'fill';
  media?: Omit<PresentedMedia, 'objectId'>;
  surface?: HtmlSurfaceReference;
  scroll?: { x: number; y: number };
  contentAnchor?: ContentAnchor;
  textRuns?: ContentTextRun[];
}
export type SceneContentMetadata = Omit<SceneContentFrameInput, 'pixels'>;

/** Producers can reuse their surfaces after publish; the texture owns its copied pixels. */
export class SceneContentFrame implements SceneTextureDrawable {
  readonly metadata: Immutable<SceneContentMetadata>;
  #pixels: HTMLCanvasElement;
  constructor(owner: Document, input: SceneContentFrameInput) {
    requireSize(input.bitmap, true);
    this.#pixels = owner.createElement('canvas'); this.#pixels.width = input.bitmap.width; this.#pixels.height = input.bitmap.height;
    const context = this.#pixels.getContext('2d'); if (!context) throw new Error('Canvas 2D is unavailable.');
    context.drawImage(input.pixels, 0, 0, input.bitmap.width, input.bitmap.height);
    context.getImageData(0, 0, 1, 1);
    const { pixels, ...metadata } = input; this.metadata = immutableCopy(metadata); Object.freeze(this);
  }
  draw(context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, bounds: SceneBounds): void {
    context.drawImage(this.#pixels, bounds.x, bounds.y, bounds.width, bounds.height);
  }
}

export class SceneContentRegistry {
  private frames = new Map<string, SceneContentFrame>();
  private listeners = new Set<() => void>();
  get(objectId: string) { return this.frames.get(objectId); }
  publish(objectId: string, input: SceneContentFrameInput) { this.frames.set(objectId, new SceneContentFrame(document, input)); this.emit(); }
  clear(objectId: string) { if (this.frames.delete(objectId)) this.emit(); }
  subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  requestRender() { this.emit(); }
  private emit() { this.listeners.forEach(listener => listener()); }
}

export interface SceneContentScope {
  registry: SceneContentRegistry;
  objectId: string;
  width: number;
  height: number;
  captureView?: CaptureView;
}
export const SceneContentContext = createContext<SceneContentScope | undefined>(undefined);

/** Optional scope keeps detailed previews native and publishes only board pixel sources. */
export function useSceneContent() {
  const scope = useContext(SceneContentContext);
  const publisher = useMemo(() => scope && ({ ...scope,
    publish: (input: SceneContentFrameInput) => scope.registry.publish(scope.objectId, input),
    clear: () => scope.registry.clear(scope.objectId),
    requestRender: () => scope.registry.requestRender(),
  }), [scope?.registry, scope?.objectId, scope?.width, scope?.height, scope?.captureView]);
  useEffect(() => () => { if (scope) scope.registry.clear(scope.objectId); }, [scope?.registry, scope?.objectId]);
  return publisher;
}
