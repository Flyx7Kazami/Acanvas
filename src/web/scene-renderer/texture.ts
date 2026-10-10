import type { ContentAnchor, PresentedMedia } from '../../shared/types.js';
import { immutableCopy, requireSize } from './geometry.js';
import type { Immutable, SceneBounds, SceneSize, SceneTextureDrawable } from './types.js';

export interface ContentTextRun { text: string; start: number; end: number; bounds: SceneBounds; href?: string }
export interface SceneContentFrameInput {
  pixels: CanvasImageSource;
  bitmap: SceneSize;
  cssSize?: SceneSize;
  fit?: 'contain' | 'fill';
  media?: Omit<PresentedMedia, 'objectId'>;
  scroll?: { x: number; y: number };
  contentAnchor?: ContentAnchor;
  textRuns?: ContentTextRun[];
}
export type SceneContentMetadata = Omit<SceneContentFrameInput, 'pixels'>;

/** Producers keep displaying after Done reads them; the texture owns its copied pixels. */
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
  static isCopiedTexture(value: unknown): value is SceneContentFrame {
    return typeof value === 'object' && value !== null && #pixels in value && Object.getPrototypeOf(value) === SceneContentFrame.prototype;
  }
  draw(context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, bounds: SceneBounds): void {
    context.drawImage(this.#pixels, bounds.x, bounds.y, bounds.width, bounds.height);
  }
}
