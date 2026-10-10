import { drawScene } from './draw.js';
import { immutableCopy, requireSize, sceneCrop } from './geometry.js';
import { SceneContentFrame } from './texture.js';
import type { Immutable, SceneBounds, SceneCrop, SceneInput, ScenePresentation, ScenePrimitive, SceneSize } from './types.js';

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

function contentString(value: unknown): void { if (typeof value !== 'string') throw new TypeError('Board paint and text values must be strings.'); }
function contentNumber(value: unknown): void { if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError('Board drawing coordinates must be finite numbers.'); }
function contentBounds(bounds: SceneBounds): void { for (const value of [bounds.x, bounds.y, bounds.width, bounds.height]) contentNumber(value); }
function contentPrimitive(primitive: ScenePrimitive): void {
  if (primitive.kind === 'rect' || primitive.kind === 'ellipse') {
    contentBounds(primitive.bounds); contentString(primitive.fill);
    if (primitive.stroke !== undefined) contentString(primitive.stroke);
    if (primitive.lineWidth !== undefined) contentNumber(primitive.lineWidth);
    for (const value of primitive.dash ?? []) contentNumber(value);
    if (primitive.kind === 'rect') {
      if (primitive.radius !== undefined) contentNumber(primitive.radius);
      if (primitive.shadow) { contentString(primitive.shadow.color); contentNumber(primitive.shadow.y); contentNumber(primitive.shadow.blur); }
    }
  } else if (primitive.kind === 'line') {
    contentString(primitive.stroke); contentNumber(primitive.lineWidth);
    for (const point of primitive.points) { contentNumber(point.x); contentNumber(point.y); }
  } else if (primitive.kind === 'text') {
    contentString(primitive.fill); contentString(primitive.font); contentString(primitive.text); contentNumber(primitive.x); contentNumber(primitive.y);
    if (primitive.maxWidth !== undefined) contentNumber(primitive.maxWidth);
  } else if (primitive.kind === 'texture') {
    contentBounds(primitive.bounds); if (primitive.radius !== undefined) contentNumber(primitive.radius);
    if (!SceneContentFrame.isCopiedTexture(primitive.texture)) throw new TypeError('Board textures must own validated copied pixels.');
  } else throw new TypeError('Use an independent SceneFrame for image sources.');
}
function contentInput(input: SceneInput, bitmap: SceneSize): void {
  requireSize(bitmap, true);
  contentString(input.background);
  for (const primitive of [...input.layers.flatMap(layer => layer.primitives), ...(input.overlays ?? [])]) contentPrimitive(primitive);
  for (const mark of input.marks) {
    contentString(mark.fill); contentString(mark.textFill); contentNumber(mark.x); contentNumber(mark.y); contentNumber(mark.number);
    if (mark.stroke !== undefined) contentString(mark.stroke);
    if (mark.focusColor !== undefined) contentString(mark.focusColor);
    if (mark.size !== undefined) contentNumber(mark.size);
  }
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
  #presentation?: Immutable<ScenePresentation>;
  #scratch?: { canvas: HTMLCanvasElement; context: CanvasRenderingContext2D };
  #identity: { documentId: string; viewId: string };
  constructor(canvas: HTMLCanvasElement, identity: { documentId: string; viewId: string }) {
    const context = canvas.getContext('2d'); if (!context) throw new Error('Canvas 2D is unavailable.');
    this.#canvas = canvas; this.#context = context; this.#identity = { ...identity };
  }

  get presented(): Immutable<ScenePresentation> | undefined { return this.#presentation; }

  private accepts(metadata: Pick<ScenePresentation, 'documentId' | 'viewId' | 'frameSeq'>): boolean {
    if (metadata.documentId !== this.#identity.documentId || metadata.viewId !== this.#identity.viewId) throw new Error('Scene frame belongs to another view.');
    return !this.#presentation || metadata.frameSeq > this.#presentation.frameSeq;
  }

  private commit(metadata: Immutable<ScenePresentation>, draw: (context: CanvasRenderingContext2D) => void) {
    if (this.#canvas.width !== metadata.bitmap.width) this.#canvas.width = metadata.bitmap.width;
    if (this.#canvas.height !== metadata.bitmap.height) this.#canvas.height = metadata.bitmap.height;
    this.#context.save();
    try { this.#context.setTransform(1, 0, 0, 1, 0, 0); this.#context.globalCompositeOperation = 'copy'; draw(this.#context); }
    finally { this.#context.restore(); }
    this.#presentation = metadata;
  }

  present(frame: SceneFrame): boolean {
    const metadata = frame.presentation;
    if (!this.accepts(metadata)) return false;
    this.commit(metadata, context => frame.drawTo(context)); return true;
  }

  /** Board textures already own an exportable copy; the mutable staging surface stays private. */
  renderContent(input: SceneInput, bitmap: SceneSize): boolean {
    try {
      if (!this.accepts(input)) return false;
      contentInput(input, bitmap);
      if (!this.#scratch) this.#scratch = canvas2D(this.#canvas.ownerDocument, bitmap);
      const scratch = this.#scratch;
      if (scratch.canvas.width !== bitmap.width) scratch.canvas.width = bitmap.width;
      if (scratch.canvas.height !== bitmap.height) scratch.canvas.height = bitmap.height;
      const metadata = drawScene(scratch.context, input, bitmap);
      this.commit(metadata, context => context.drawImage(scratch.canvas, 0, 0)); return true;
    } catch (error) { this.#scratch = undefined; throw error; }
  }

  /** Call synchronously at Done, before draft/network/encoder work yields to the event loop. */
  capture(cropCSS?: SceneBounds, clipCSS?: SceneBounds): SceneEvidence {
    const presentation = this.#presentation; if (!presentation) throw new Error('Scene has no presented frame.');
    const crop = sceneCrop(presentation.cssViewport, presentation.bitmap, cropCSS, clipCSS);
    return SceneEvidence.copyCanvas(this.#canvas, presentation, crop);
  }

  /** An offscreen evidence canvas draws one frame, labels it with its sequence, copies the crop and releases its bitmap. */
  renderEvidence(input: SceneInput, bitmap: SceneSize, cropCSS?: SceneBounds, clipCSS?: SceneBounds): SceneEvidence {
    if (!this.accepts(input)) throw new RangeError('Evidence frames use increasing sequence numbers.');
    contentInput(input, bitmap);
    this.#canvas.width = bitmap.width; this.#canvas.height = bitmap.height;
    try {
      this.#presentation = drawScene(this.#context, input, bitmap); this.#canvas.dataset.frameSeq = String(input.frameSeq);
      return this.capture(cropCSS, clipCSS);
    } finally { this.#canvas.width = 1; this.#canvas.height = 1; }
  }
}
