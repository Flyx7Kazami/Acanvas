import type { AnnotationInput, AnnotationTarget } from '../shared/types.js';
import { inflateSync } from 'node:zlib';

export const annotationTarget = (value: AnnotationInput | AnnotationTarget): AnnotationTarget => ({
  scope: value.scope, coordinateSpace: value.coordinateSpace,
  objectIds: [...new Set(value.objectIds)].sort(),
  ...(value.boardGroupId ? { boardGroupId: value.boardGroupId } : {}),
  ...(value.objectId ? { objectId: value.objectId } : {}),
  ...(value.assetId ? { assetId: value.assetId } : {}),
  bounds: { x: value.bounds.x, y: value.bounds.y, width: value.bounds.width, height: value.bounds.height },
  ...(value.timeStart !== undefined ? { timeStart: value.timeStart } : {}),
  ...(value.timeEnd !== undefined ? { timeEnd: value.timeEnd } : {}),
  ...(value.snapshotAssetId ? { snapshotAssetId: value.snapshotAssetId } : {}),
  ...(value.geometry ? { geometry: value.geometry } : {}),
  ...(value.contentAnchor ? { contentAnchor: { kind: value.contentAnchor.kind, ...(value.contentAnchor.scroll ? { scroll: { x: value.contentAnchor.scroll.x, y: value.contentAnchor.scroll.y } } : {}), ...Object.fromEntries(['quote', 'context', 'path', 'start', 'end'].filter(key => value.contentAnchor![key as keyof typeof value.contentAnchor] !== undefined).map(key => [key, value.contentAnchor![key as keyof typeof value.contentAnchor]])) } } : {}),
});
export const sameAnnotationTarget = (a: AnnotationInput | AnnotationTarget, b: AnnotationInput | AnnotationTarget) => JSON.stringify(annotationTarget(a)) === JSON.stringify(annotationTarget(b));

const crcTable = Array.from({ length: 256 }, (_, value) => { for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ value >>> 1 : value >>> 1; return value >>> 0; });
const crc32 = (bytes: Buffer) => { let value = 0xffffffff; for (const byte of bytes) value = crcTable[(value ^ byte) & 255] ^ value >>> 8; return (value ^ 0xffffffff) >>> 0; };
export function rasterDimensions(bytes: Buffer, mime: string): { width: number; height: number } | undefined {
  if (mime !== 'image/png' || bytes.length < 45 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return;
  let position = 8, width = 0, height = 0, depth = 0, channels = 0, interlace = 0, color = 0, palette = false, endedData = false;
  const data: Buffer[] = [];
  while (position + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(position), name = bytes.toString('ascii', position + 4, position + 8);
    if (position + length + 12 > bytes.length || !/^[A-Za-z]{4}$/.test(name) || crc32(bytes.subarray(position + 4, position + 8 + length)) !== bytes.readUInt32BE(position + 8 + length)) return;
    if (position === 8) {
      if (name !== 'IHDR' || length !== 13) return;
      width = bytes.readUInt32BE(position + 8); height = bytes.readUInt32BE(position + 12); depth = bytes[position + 16]; color = bytes[position + 17]; interlace = bytes[position + 20];
      const depths: Record<number, number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
      channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[color];
      if (!width || !height || width * height > 16_000_000 || !depths[color]?.includes(depth) || bytes[position + 18] !== 0 || bytes[position + 19] !== 0 || interlace > 1) return;
    } else if (name === 'IHDR') return;
    if (name === 'PLTE') { if (data.length || palette || !length || length % 3 || length > 768) return; palette = true; }
    if (name === 'IDAT') { if (endedData || color === 3 && !palette) return; data.push(bytes.subarray(position + 8, position + 8 + length)); }
    else if (data.length) endedData = true;
    if (!['IHDR', 'IDAT', 'IEND', 'PLTE'].includes(name) && name[0] === name[0].toUpperCase()) return;
    position += length + 12;
    if (name === 'IEND') {
      if (length || position !== bytes.length || !data.length) return;
      let pixels: Buffer;
      try { pixels = inflateSync(Buffer.concat(data), { maxOutputLength: 64 * 1024 * 1024 }); } catch { return; }
      const passes = interlace ? [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]] : [[0, 0, 1, 1]];
      let offset = 0;
      for (const [x, y, dx, dy] of passes) {
        const columns = Math.max(0, Math.ceil((width - x) / dx)), rows = Math.max(0, Math.ceil((height - y) / dy));
        if (!columns || !rows) continue;
        const stride = 1 + Math.ceil(columns * channels * depth / 8);
        for (let row = 0; row < rows; row++) { if (offset + stride > pixels.length || pixels[offset] > 4) return; offset += stride; }
      }
      return offset === pixels.length ? { width, height } : undefined;
    }
  }
}
