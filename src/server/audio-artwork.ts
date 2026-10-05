import { parseFromTokenizer, selectCover } from 'music-metadata';
import { fromFile, type FileTokenizer } from 'strtok3';
import type { Asset } from '../shared/types.js';
import { resolveContentKind } from '../shared/content-types.js';
import { ApiFailure } from './service.js';

const readBudget = 8 * 1024 * 1024, coverLimit = 2 * 1024 * 1024;
export interface AudioArtwork { mime: string; bytes: Buffer }

function rasterMime(data: Uint8Array): string | undefined {
  if (data.length >= 8 && Buffer.from(data.subarray(0, 8)).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png';
  if (data[0] === 255 && data[1] === 216 && data[2] === 255) return 'image/jpeg';
  if (data.length >= 6 && /^GIF8[79]a$/.test(Buffer.from(data.subarray(0, 6)).toString('ascii'))) return 'image/gif';
  if (data.length >= 12 && Buffer.from(data.subarray(0, 4)).toString('ascii') === 'RIFF' && Buffer.from(data.subarray(8, 12)).toString('ascii') === 'WEBP') return 'image/webp';
}

/** Count actual metadata reads while allowing seeks across the original audio file. */
export function limitMetadataReads(tokenizer: FileTokenizer, budget = readBudget): FileTokenizer {
  let remaining = budget; const deadline = Date.now() + 2000;
  const sizeAllowed = (size: number) => {
    if (Date.now() > deadline) throw new ApiFailure(503, 'artwork_busy', 'Audio artwork is temporarily unavailable.');
    if (!Number.isSafeInteger(size) || size < 0 || size > remaining) throw new ApiFailure(413, 'artwork_metadata_limit', 'Audio metadata exceeds its read budget.');
  };
  for (const method of ['readBuffer', 'peekBuffer'] as const) {
    const read = tokenizer[method].bind(tokenizer);
    tokenizer[method] = async (buffer, options) => { sizeAllowed(options?.length ?? buffer.byteLength); const count = await read(buffer, options); remaining -= count; return count; };
  }
  for (const method of ['readToken', 'peekToken'] as const) {
    const read = tokenizer[method].bind(tokenizer);
    tokenizer[method] = async (token, position) => { sizeAllowed(token.len); return read(token, position ?? undefined); };
  }
  return tokenizer;
}

export async function extractAudioArtwork(path: string): Promise<AudioArtwork | null> {
  const tokenizer = limitMetadataReads(await fromFile(path));
  try {
    const metadata = await parseFromTokenizer(tokenizer, { duration: false, skipCovers: false });
    const cover = selectCover(metadata.common.picture);
    if (!cover || !cover.data.length || cover.data.length > coverLimit) return null;
    const mime = rasterMime(cover.data);
    if (!mime || cover.format.toLowerCase().replace('image/jpg', 'image/jpeg') !== mime) return null;
    return { mime, bytes: Buffer.from(cover.data) };
  } catch (error) {
    if (error instanceof ApiFailure) throw error;
    if (error && typeof error === 'object' && 'code' in error) throw new ApiFailure(503, 'artwork_busy', 'Audio artwork is temporarily unavailable.');
    return null;
  }
  finally { await tokenizer.close(); }
}

export class AudioArtworkReader {
  private cache = new Map<string, AudioArtwork | null>();
  private pending = new Map<string, Promise<AudioArtwork | null>>();
  private bytes = 0;
  constructor(private path: (assetId: string) => string, private extract = extractAudioArtwork) {}
  async get(asset: Asset): Promise<AudioArtwork | null> {
    if (resolveContentKind(asset) !== 'audio') return null;
    if (this.cache.has(asset.id)) { const cover = this.cache.get(asset.id)!; this.cache.delete(asset.id); this.cache.set(asset.id, cover); return cover; }
    const running = this.pending.get(asset.id); if (running) return running;
    const job = this.extract(this.path(asset.id)).then(cover => {
      this.cache.set(asset.id, cover); this.bytes += cover?.bytes.length || 0;
      while (this.cache.size > 64 || this.bytes > 16 * 1024 * 1024) { const id = this.cache.keys().next().value!; this.bytes -= this.cache.get(id)?.bytes.length || 0; this.cache.delete(id); }
      return cover;
    }).finally(() => this.pending.delete(asset.id));
    this.pending.set(asset.id, job); return job;
  }
}
