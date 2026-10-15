import { decompressFrame, parseGIF, type ParsedGif } from 'gifuct-js';

type EncodedFrame = Extract<ParsedGif['frames'][number], { image: unknown }>;
export const gifLimits = { bytes: 20 * 1024 * 1024, pixels: 4_000_000, frames: 10_000, records: 20_000, stepsPerTick: 16 } as const;
export interface GifPosition { frameIndex: number; loopIndex: number; presentedTime: number; playbackTime: number; ended: boolean; ready: boolean }

/** Compressed frames stay compressed; current composition and disposal restoration own bounded buffers. */
export class GifFrameDecoder {
  readonly width: number;
  readonly height: number;
  readonly frameCount: number;
  readonly durationMs: number;
  readonly loops: number;
  readonly delays: readonly number[];
  private readonly frames: EncodedFrame[];
  private readonly starts: number[];
  private readonly background: readonly number[];
  private rgba: Uint8ClampedArray<ArrayBuffer>;
  private restore?: Uint8ClampedArray<ArrayBuffer>;
  private index = -1;
  private loopIndex = 0;
  private previous?: EncodedFrame;

  constructor(private readonly parsed: ParsedGif) {
    this.width = parsed.lsd.width; this.height = parsed.lsd.height;
    if (!this.width || !this.height || this.width * this.height > gifLimits.pixels) throw new Error('GIF playback supports frames up to four million pixels.');
    this.frames = parsed.frames.filter((frame): frame is EncodedFrame => 'image' in frame);
    if (!this.frames.length || this.frames.length > gifLimits.frames) throw new Error('GIF playback supports one to 10000 frames.');
    let compressed = 0;
    for (const frame of this.frames) {
      const dims = frame.image.descriptor;
      if (!dims.width || !dims.height || dims.width * dims.height > gifLimits.pixels || dims.left + dims.width > this.width || dims.top + dims.height > this.height) throw new Error('GIF frame patches remain inside their logical screen.');
      compressed += frame.image.data.blocks.length;
      if (compressed > gifLimits.bytes) throw new Error('GIF compressed frame data exceeds 20 MiB.');
      if (!Number.isInteger(frame.gce?.delay ?? 0) || (frame.gce?.delay ?? 0) < 0 || ![0, 1, 2, 3].includes(frame.gce?.extras.disposal ?? 0)) throw new Error('GIF playback requires supported frame timing and disposal.');
    }
    this.frameCount = this.frames.length;
    this.delays = this.frames.map(frame => Math.max(20, (frame.gce?.delay ?? 10) * 10));
    this.starts = []; let duration = 0; for (const delay of this.delays) { this.starts.push(duration); duration += delay; } this.durationMs = duration;
    const application = parsed.frames.find(frame => 'application' in frame && ['NETSCAPE2.0', 'ANIMEXTS1.0'].includes(frame.application.id));
    const repeat = application && 'application' in application && application.application.blocks[0] === 1 ? application.application.blocks[1] + 256 * application.application.blocks[2] : undefined;
    this.loops = repeat === undefined ? 1 : repeat === 0 ? Infinity : repeat + 1;
    const background = parsed.gct?.[parsed.lsd.backgroundColorIndex];
    const transparent = this.frames.some(frame => frame.gce?.extras.transparentColorGiven && frame.gce.transparentColorIndex === parsed.lsd.backgroundColorIndex);
    this.background = background && !transparent ? [...background, 255] : [0, 0, 0, 0];
    this.rgba = new Uint8ClampedArray(this.width * this.height * 4); this.reset(0);
  }
  private fill(dims: { left: number; top: number; width: number; height: number }) {
    for (let y = dims.top; y < dims.top + dims.height; y++) for (let x = dims.left; x < dims.left + dims.width; x++) this.rgba.set(this.background, (y * this.width + x) * 4);
  }
  private reset(loop: number) { this.fill({ left: 0, top: 0, width: this.width, height: this.height }); this.index = -1; this.loopIndex = loop; this.previous = undefined; this.restore = undefined; }
  private decode(index: number) {
    const previous = this.previous;
    if (previous?.gce?.extras.disposal === 2) this.fill(previous.image.descriptor);
    else if (previous?.gce?.extras.disposal === 3 && this.restore) this.rgba.set(this.restore);
    const frame = this.frames[index];
    if (frame.gce?.extras.disposal === 3) this.restore = new Uint8ClampedArray(this.rgba); else this.restore = undefined;
    const decoded = decompressFrame(frame, this.parsed.gct, true), dims = frame.image.descriptor;
    if (!decoded || decoded.patch.length !== dims.width * dims.height * 4 || decoded.pixels.length !== dims.width * dims.height) throw new Error('The GIF frame data is incomplete.');
    for (let y = 0; y < dims.height; y++) for (let x = 0; x < dims.width; x++) {
      const patch = (y * dims.width + x) * 4, color = decoded.pixels[y * dims.width + x];
      if (!Number.isInteger(color) || color < 0 || color >= decoded.colorTable.length) throw new Error('The GIF frame color data is incomplete.');
      if (decoded.patch[patch + 3]) this.rgba.set(decoded.patch.subarray(patch, patch + 4), ((y + dims.top) * this.width + x + dims.left) * 4);
    }
    this.previous = frame; this.index = index;
  }
  advance(elapsedMs: number, steps: number = gifLimits.stepsPerTick): GifPosition {
    if (!Number.isFinite(elapsedMs) || elapsedMs < 0 || !Number.isSafeInteger(steps) || steps < 1 || steps > 64) throw new Error('GIF playback uses a finite clock and bounded decode steps.');
    const ended = Number.isFinite(this.loops) && elapsedMs >= this.durationMs * this.loops;
    const desiredLoop = ended ? this.loops - 1 : Math.floor(elapsedMs / this.durationMs), position = ended ? this.durationMs - .001 : elapsedMs % this.durationMs;
    let desiredIndex = 0; while (desiredIndex + 1 < this.starts.length && this.starts[desiredIndex + 1] <= position) desiredIndex++;
    if (desiredLoop !== this.loopIndex || desiredIndex < this.index) this.reset(desiredLoop);
    let count = 0; while (this.index < desiredIndex && count++ < steps) this.decode(this.index + 1);
    return { frameIndex: this.index, loopIndex: this.loopIndex, presentedTime: this.starts[this.index] / 1000, playbackTime: Math.min(elapsedMs, this.durationMs * this.loops) / 1000, ended, ready: this.index === desiredIndex };
  }
  draw(context: CanvasRenderingContext2D) { if (this.index < 0) throw new Error('Decode a GIF frame before drawing.'); context.putImageData(new ImageData(this.rgba, this.width, this.height), 0, 0); }
  copyPixels(): Uint8ClampedArray<ArrayBuffer> { return new Uint8ClampedArray(this.rgba); }
}

/** Cursor-only scanning bounds image and extension allocations before the object parser runs. */
export function scanGifStructure(buffer: ArrayBuffer): { width: number; height: number; frames: number; records: number } {
  if (buffer.byteLength < 14 || buffer.byteLength > gifLimits.bytes) throw new Error('GIF playback supports complete files up to 20 MiB.');
  const bytes = new Uint8Array(buffer), signature = String.fromCharCode(...bytes.subarray(0, 6));
  if (!['GIF87a', 'GIF89a'].includes(signature)) throw new Error('The GIF file is incomplete.');
  const uint16 = (offset: number) => bytes[offset] + 256 * bytes[offset + 1];
  const width = uint16(6), height = uint16(8);
  if (!width || !height || width * height > gifLimits.pixels) throw new Error('GIF playback supports frames up to four million pixels.');
  let cursor = 13, frames = 0, records = 0, previousStage = 4;
  const skip = (size: number) => { if (cursor + size > bytes.length) throw new Error('The GIF block is incomplete.'); cursor += size; };
  const subBlocks = () => { while (true) { if (cursor >= bytes.length) throw new Error('The GIF block is incomplete.'); const size = bytes[cursor++]; if (size === 0) return; skip(size); } };
  if (bytes[10] & 0x80) skip(3 * (1 << ((bytes[10] & 7) + 1)));
  while (cursor < bytes.length) {
    const code = bytes[cursor++]; let stage: number;
    if (code === 0x3b) { if (cursor !== bytes.length || !frames) throw new Error('The GIF file is incomplete.'); return { width, height, frames, records }; }
    if (code === 0x2c) {
      if (++frames > gifLimits.frames) throw new Error('GIF playback supports one to 10000 frames.');
      const descriptor = cursor; skip(9);
      const left = uint16(descriptor), top = uint16(descriptor + 2), patchWidth = uint16(descriptor + 4), patchHeight = uint16(descriptor + 6), packed = bytes[descriptor + 8];
      if (!patchWidth || !patchHeight || patchWidth * patchHeight > gifLimits.pixels || left + patchWidth > width || top + patchHeight > height) throw new Error('GIF frame patches remain inside their logical screen.');
      if (packed & 0x80) skip(3 * (1 << ((packed & 7) + 1)));
      if (cursor >= bytes.length || bytes[cursor] < 2 || bytes[cursor] > 8) throw new Error('The GIF image code size is unsupported.');
      cursor++; subBlocks(); stage = 3;
    } else if (code === 0x21) {
      if (cursor >= bytes.length) throw new Error('The GIF extension is incomplete.');
      const label = bytes[cursor++];
      if (label === 0xf9) {
        if (cursor + 6 > bytes.length || bytes[cursor] !== 4 || bytes[cursor + 5] !== 0 || ((bytes[cursor + 1] >> 2) & 7) > 3) throw new Error('The GIF control extension is unsupported or incomplete.');
        skip(6); stage = 0;
      } else if (label === 0xff || label === 0x01) {
        const size = label === 0xff ? 11 : 12;
        if (cursor >= bytes.length || bytes[cursor++] !== size) throw new Error('The GIF extension header is incomplete.');
        skip(size); subBlocks(); stage = label === 0xff ? 1 : 4;
      } else if (label === 0xfe) { subBlocks(); stage = 2; }
      else throw new Error('The GIF extension type is unsupported.');
    } else throw new Error('The GIF block type is unsupported.');
    if (stage <= previousStage && ++records > gifLimits.records) throw new Error('GIF playback supports up to 20000 parsed image and extension records.');
    previousStage = stage;
  }
  throw new Error('The GIF file is incomplete.');
}

export function decodeGif(buffer: ArrayBuffer): GifFrameDecoder {
  scanGifStructure(buffer);
  return new GifFrameDecoder(parseGIF(buffer));
}

export async function fetchGif(src: string, signal?: AbortSignal): Promise<GifFrameDecoder> {
  const response = await fetch(src, { credentials: 'same-origin', signal });
  if (!response.ok || Number(response.headers.get('Content-Length')) > gifLimits.bytes || !response.body) throw new Error('The GIF source is unavailable or exceeds 20 MiB.');
  const reader = response.body.getReader(), chunks: Uint8Array<ArrayBuffer>[] = []; let size = 0;
  try { while (true) { const value = await reader.read(); if (value.done) break; size += value.value.byteLength; if (size > gifLimits.bytes) throw new Error('GIF playback supports files up to 20 MiB.'); chunks.push(value.value); } }
  finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return decodeGif(bytes.buffer);
}
