import type { AssetKind } from './types.js';

export type ContentKind = 'image' | 'gif' | 'video' | 'audio' | 'markdown' | 'html' | 'note' | 'file';
export const noteMime = 'text/x-acanvas-note';
export const editableTextBytes = 2 * 1024 * 1024;
const editableMime = new Set(['text/markdown', 'text/x-markdown', noteMime]);
export const editableTextMime = (mime: string) => editableMime.has(mime.split(';', 1)[0].trim().toLowerCase());
export interface ContentSource { name: string; mime: string }

const extensionMime: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif', svg: 'image/svg+xml',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
  mp3: 'audio/mpeg', wav: 'audio/wav', wave: 'audio/wav', m4a: 'audio/mp4', aac: 'audio/aac', ogg: 'audio/ogg', oga: 'audio/ogg', flac: 'audio/flac', opus: 'audio/ogg',
  md: 'text/markdown', markdown: 'text/markdown', html: 'text/html', htm: 'text/html', txt: 'text/plain', pdf: 'application/pdf', zip: 'application/zip',
};
const genericMime = new Set(['', 'application/octet-stream', 'binary/octet-stream', 'text/plain']);

export function resolveContentMime(name: string, supplied = ''): string {
  const mime = supplied.split(';', 1)[0].trim().toLowerCase();
  const extension = name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  const fallback = extension && extensionMime[extension];
  if (fallback && genericMime.has(mime)) return fallback;
  return /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(mime) ? mime : fallback || 'application/octet-stream';
}

export function resolveContentKind(source?: ContentSource): ContentKind {
  if (!source) return 'file';
  const mime = resolveContentMime(source.name, source.mime);
  if (mime === 'image/gif') return 'gif';
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime === noteMime) return 'note';
  if (['text/markdown', 'text/x-markdown'].includes(mime)) return 'markdown';
  if (['text/html', 'application/xhtml+xml'].includes(mime)) return 'html';
  return 'file';
}

export function storageAssetKind(source: ContentSource): AssetKind {
  const kind = resolveContentKind(source);
  return kind === 'image' || kind === 'gif' ? 'image' : kind === 'video' ? 'video' : 'file';
}

export interface ContentCapabilities {
  label: string;
  region: boolean;
  time: boolean;
  interaction: boolean;
  freeResize: boolean;
  minimum: { width: number; height: number };
  initial: { width: number; height: number };
}
export const contentCapabilities: Record<ContentKind, ContentCapabilities> = {
  image: { label: 'Image', region: true, time: false, interaction: false, freeResize: false, minimum: { width: 40, height: 40 }, initial: { width: 280, height: 210 } },
  gif: { label: 'GIF', region: true, time: false, interaction: false, freeResize: false, minimum: { width: 40, height: 40 }, initial: { width: 280, height: 210 } },
  video: { label: 'Video', region: true, time: true, interaction: false, freeResize: false, minimum: { width: 40, height: 40 }, initial: { width: 280, height: 210 } },
  audio: { label: 'Audio', region: false, time: true, interaction: false, freeResize: true, minimum: { width: 280, height: 88 }, initial: { width: 480, height: 100 } },
  markdown: { label: 'Markdown', region: false, time: false, interaction: true, freeResize: true, minimum: { width: 180, height: 120 }, initial: { width: 420, height: 320 } },
  note: { label: 'Note', region: false, time: false, interaction: true, freeResize: true, minimum: { width: 160, height: 72 }, initial: { width: 240, height: 128 } },
  html: { label: 'HTML', region: false, time: false, interaction: true, freeResize: true, minimum: { width: 180, height: 120 }, initial: { width: 420, height: 320 } },
  file: { label: 'File', region: false, time: false, interaction: false, freeResize: false, minimum: { width: 40, height: 40 }, initial: { width: 280, height: 150 } },
};
