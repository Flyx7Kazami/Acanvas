import { drawScene } from './draw.js';
import { immutableCopy, requireSize, sceneCrop } from './geometry.js';
import type { Immutable, SceneBounds, SceneCrop, SceneInput, ScenePresentation, SceneSize } from './types.js';

export type * from './types.js';
export { drawScene } from './draw.js';
export { boundsToCSS, sceneCrop } from './geometry.js';

function canvas2D(owner: Document, size: SceneSize): { canvas: HTMLCanvasElement; context: CanvasRenderingContext2D } {
  requireSize(size, true);
  const canvas = owner.createElement('canvas'); canvas.width = size.width; canvas.height = size.height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas 2D is unavailable.');
  return { canvas, context };
}

/** A candidate owns its copied pixels. Producers retain their own mutable render surfaces. */
export class SceneFrame {
  readonly presentation: Immutable<ScenePresentation>;
  #pixels: HTMLCanvasElement;
  private constructor(pixels: HTMLCanvasElement, presentation: Immutable<ScenePresentation>) {
    // Canvas origin cleanliness applies to the whole bitmap. Only exportable candidates enter the visible surface.
    pixels.getContext('2d')!.getImageData(0, 0, 1, 1);
    this.#pixels = pixels; this.presentation = presentation;
    Object.freeze(this);
  }

  static render(owner: Document, input: SceneInput, bitmap: SceneSize): SceneFrame {
    const { canvas, context } = canvas2D(owner, bitmap);
    return new SceneFrame(canvas, drawScene(context, input, bitmap));
  }

  /** Copy an explicitly paired worker/surface bitmap before its producer can close or reuse it. */
  static copyBitmap(owner: Document, pixels: ImageBitmap, presentation: ScenePresentation | Immutable<ScenePresentation>): SceneFrame {
    if (pixels.width !== presentation.bitmap.width || pixels.height !== presentation.bitmap.height) throw new RangeError('Scene bitmap dimensions must match its presentation.');
    const { canvas, context } = canvas2D(owner, presentation.bitmap);
    context.drawImage(pixels, 0, 0); return new SceneFrame(canvas, immutableCopy(presentation));
  }

  drawTo(context: CanvasRenderingContext2D): void { context.drawImage(this.#pixels, 0, 0); }
}

/** Evidence keeps an independent pixel copy while the displayed scene keeps advancing. */
export class SceneEvidence {
  readonly sourceMode = 'scene-bitmap' as const;
  readonly presentation: Immutable<ScenePresentation>;
  readonly crop: Immutable<SceneCrop>;
  #pixels: HTMLCanvasElement;
  private constructor(pixels: HTMLCanvasElement, presentation: Immutable<ScenePresentation>, crop: SceneCrop) {
    this.#pixels = pixels; this.presentation = presentation; this.crop = immutableCopy(crop);
    Object.freeze(this);
  }

  static copyCanvas(source: HTMLCanvasElement, presentation: Immutable<ScenePresentation>, crop: SceneCrop): SceneEvidence {
    const { canvas, context } = canvas2D(source.ownerDocument, crop.bitmap);
    const pixels = crop.sourcePixels;
    context.drawImage(source, pixels.x, pixels.y, pixels.width, pixels.height, 0, 0, canvas.width, canvas.height);
    return new SceneEvidence(canvas, presentation, crop);
  }

  async encodePNG(): Promise<Blob> {
    return new Promise<Blob>((resolve, reject) => {
      try { this.#pixels.toBlob(blob => blob ? resolve(blob) : reject(new Error('Scene PNG encoding returned no image.')), 'image/png'); }
      catch (error) { reject(error); }
    });
  }
}

/** The visible Canvas and its presentation record change together in one main-thread operation. */
export class SceneRenderer {
  #canvas: HTMLCanvasElement;
  #context: CanvasRenderingContext2D;
  #presentedFrame?: SceneFrame;
  #identity: { documentId: string; viewId: string };
  constructor(canvas: HTMLCanvasElement, identity: { documentId: string; viewId: string }) {
    const context = canvas.getContext('2d'); if (!context) throw new Error('Canvas 2D is unavailable.');
    this.#canvas = canvas; this.#context = context; this.#identity = { ...identity };
  }

  get presented(): Immutable<ScenePresentation> | undefined { return this.#presentedFrame?.presentation; }

  present(frame: SceneFrame): boolean {
    const metadata = frame.presentation;
    if (metadata.documentId !== this.#identity.documentId || metadata.viewId !== this.#identity.viewId) throw new Error('Scene frame belongs to another view.');
    if (this.#presentedFrame && metadata.frameSeq <= this.#presentedFrame.presentation.frameSeq) return false;
    this.#canvas.width = metadata.bitmap.width; this.#canvas.height = metadata.bitmap.height;
    this.#context.setTransform(1, 0, 0, 1, 0, 0); frame.drawTo(this.#context);
    this.#presentedFrame = frame; return true;
  }

  /** Call synchronously at Done, before draft/network/encoder work yields to the event loop. */
  capture(cropCSS?: SceneBounds, clipCSS?: SceneBounds): SceneEvidence {
    const frame = this.#presentedFrame; if (!frame) throw new Error('Scene has no presented frame.');
    const crop = sceneCrop(frame.presentation.cssViewport, frame.presentation.bitmap, cropCSS, clipCSS);
    return SceneEvidence.copyCanvas(this.#canvas, frame.presentation, crop);
  }
}
