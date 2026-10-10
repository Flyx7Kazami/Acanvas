import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Code2, File, FileText, Music2, Play, Type } from 'lucide-react';
import type { Asset } from '../shared/types';
import { resolveContentKind, type NoteFill } from '../shared/content-types';
import { getVideoThumbnail } from './videoThumbnail';
import { useAudioArtwork } from './audioArtwork';
import { MarkdownBlock } from './MarkdownCanvasContent';
import { NoteCanvasContent } from './NoteCanvasContent';
import { AudioCanvasPlayer } from './AudioCanvasPlayer';
import { HtmlCanvasContent } from './HtmlCanvasContent';
import type { CanvasWheelInput } from './canvas-wheel';
import type { BoardApi } from './api';
import { isContentInteraction } from '../shared/content-hit';
import './content.css';
import { SceneFileCard, SceneStaticImage } from './scene-renderer/static';
import { SceneGifContent, SceneVideoContent } from './scene-renderer/media';

const bytes = (value: number) => value < 1024 * 1024 ? `${Math.max(1, Math.round(value / 1024))} KB` : `${(value / (1024 * 1024)).toFixed(1)} MB`;

const THUMB_PREVIEW_DELAY = 500;
const THUMB_PREVIEW_WARM = 800;
let thumbPreviewActive = 0;
let thumbPreviewWarmUntil = 0;
let thumbPreviewSerial = 0;
const thumbPreviewListeners = new Set<(active: number) => void>();

function claimThumbPreview(id: number) {
  thumbPreviewActive = id;
  thumbPreviewWarmUntil = Date.now() + THUMB_PREVIEW_WARM;
  for (const listener of thumbPreviewListeners) listener(id);
}

function releaseThumbPreview(id: number) {
  if (thumbPreviewActive !== id) return;
  thumbPreviewActive = 0;
  thumbPreviewWarmUntil = Date.now() + THUMB_PREVIEW_WARM;
}

export function ThumbHoverPreview({ src, label, children }: { src: string; label: string; children: ReactNode }) {
  const anchor = useRef<HTMLSpanElement>(null), bubble = useRef<HTMLSpanElement>(null), identity = useRef(0), fadeIn = useRef(false);
  const showTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined), hideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [open, setOpen] = useState(false);
  const [frame, setFrame] = useState(0);
  if (identity.current === 0) identity.current = ++thumbPreviewSerial;
  const show = () => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    if (open || showTimer.current) return;
    const openNow = () => {
      showTimer.current = undefined;
      fadeIn.current = thumbPreviewActive === 0 && Date.now() >= thumbPreviewWarmUntil;
      claimThumbPreview(identity.current);
      setOpen(true);
    };
    if (thumbPreviewActive !== 0 || Date.now() < thumbPreviewWarmUntil) openNow();
    else showTimer.current = setTimeout(openNow, THUMB_PREVIEW_DELAY);
  };
  const hide = () => {
    if (showTimer.current) { clearTimeout(showTimer.current); showTimer.current = undefined; }
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => { releaseThumbPreview(identity.current); setOpen(false); }, 80);
  };
  useEffect(() => {
    const listener = (active: number) => {
      if (active === identity.current) return;
      if (showTimer.current) { clearTimeout(showTimer.current); showTimer.current = undefined; }
      if (hideTimer.current) { clearTimeout(hideTimer.current); hideTimer.current = undefined; }
      setOpen(false);
    };
    thumbPreviewListeners.add(listener);
    return () => {
      thumbPreviewListeners.delete(listener);
      releaseThumbPreview(identity.current);
      if (showTimer.current) clearTimeout(showTimer.current);
      if (hideTimer.current) clearTimeout(hideTimer.current);
    };
  }, []);
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const host = anchor.current, tip = bubble.current;
      if (!host || !tip) return;
      const image = tip.querySelector('img');
      if (!image?.complete || !image.naturalWidth) return;
      const rect = host.getBoundingClientRect(), width = tip.offsetWidth, height = tip.offsetHeight;
      const tail = 8, left = Math.max(8, Math.min(rect.left + rect.width / 2 - width / 2, window.innerWidth - width - 8));
      tip.style.left = `${left}px`;
      tip.style.top = `${Math.max(8, rect.top - 4 - tail - height)}px`;
      tip.style.setProperty('--tail', `${Math.min(Math.max(18, rect.left + rect.width / 2 - left), Math.max(18, width - 18))}px`);
      const first = tip.dataset.placed !== 'true';
      tip.dataset.placed = 'true';
      if (first) tip.dataset.enter = fadeIn.current ? 'true' : 'false';
    };
    place();
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => { window.removeEventListener('scroll', place, true); window.removeEventListener('resize', place); };
  }, [open, src, frame]);
  return <span ref={anchor} className="thumb-hover" onPointerEnter={show} onPointerLeave={hide} onFocus={show} onBlur={hide}>
    {children}
    {open && createPortal(<span ref={bubble} className="thumb-hover-bubble" role="tooltip" aria-label={label}><img src={src} alt="" onLoad={() => setFrame(value => value + 1)}/><svg className="thumb-hover-tail" viewBox="0 0 18 10" aria-hidden="true"><path d="M1.2.6 9 8.6 16.8.6"/></svg></span>, document.body)}
  </span>;
}

export function AssetThumb({ asset, src, onError, onLoad, hoverPreview = false }: { asset?: Asset; src: string; onError?: () => void; onLoad?: () => void; hoverPreview?: boolean }) {
  const kind = resolveContentKind(asset), [frame, setFrame] = useState<{ src: string; image: string }>();
  const cover = useAudioArtwork(kind === 'audio' ? src : undefined);
  useEffect(() => {
    if (kind !== 'video') return;
    let active = true; void getVideoThumbnail(src).then(image => { if (active && image) setFrame({ src, image }); });
    return () => { active = false; };
  }, [kind, src]);
  const image = kind === 'image' || kind === 'gif' ? src : kind === 'audio' ? cover.url : frame?.src === src ? frame.image : undefined;
  const Icon = kind === 'video' ? Play : kind === 'audio' ? Music2 : kind === 'markdown' ? FileText : kind === 'html' ? Code2 : kind === 'note' ? Type : File;
  const thumb = <span className="asset-thumb" data-kind={kind}>{image ? <img src={image} alt="" loading="lazy" onLoad={onLoad} onError={() => { if (kind === 'audio') cover.onError(); onError?.(); }}/> : <Icon size={15} className="content-thumbnail-icon"/>}</span>;
  return hoverPreview && image ? <ThumbHoverPreview src={image} label={asset?.name || 'Preview'}>{thumb}</ThumbHoverPreview> : thumb;
}

export interface ContentRendererProps {
  asset?: Asset;
  src: string;
  api: BoardApi;
  surface?: 'canvas' | 'detail';
  disabled?: boolean;
  preserveScene?: boolean;
  error?: boolean;
  onError?: (cause?: unknown) => void;
  onSize?: (size: { width: number; height: number }) => void;
  onMediaElement?: (element: HTMLMediaElement | null) => void;
  onReloadBoard?: () => Promise<void>;
  onBlankPointerDown?: (event: PointerEvent<HTMLElement>) => void;
  onFrameWheel?: (event: CanvasWheelInput) => void;
  onFrameDrag?: (frame: HTMLIFrameElement, start: { x: number; y: number }, event: PointerEvent<HTMLElement>) => void;
  onActivate?: () => void;
  onSaveError?: (cause: unknown) => void;
  fill?: NoteFill;
}

export function ContentRenderer({ asset, src, api, surface = 'canvas', disabled, preserveScene, error, onError, onSize, onMediaElement, onReloadBoard, onBlankPointerDown, onFrameDrag, onFrameWheel, onActivate, onSaveError, fill }: ContentRendererProps) {
  const kind = resolveContentKind(asset), title = asset?.name || 'File';
  if (kind === 'note' && asset) return <NoteCanvasContent asset={asset} src={src} api={api} fill={fill} disabled={disabled} onBlankPointerDown={onBlankPointerDown} onActivate={onActivate} onSaveError={onSaveError}/>;
  if (error || kind === 'file') return <SceneFileCard asset={asset} src={src} error={error}/>;
  if (kind === 'image') return <SceneStaticImage src={src} title={title} onSize={onSize} onError={() => onError?.()}/>;
  if (kind === 'gif') return <SceneGifContent src={src} title={title} onSize={onSize} onError={onError}/>;
  if (kind === 'video') return <SceneVideoContent src={src} title={title} controls={surface === 'detail'} tabIndex={surface === 'detail' ? 0 : -1} onMediaElement={onMediaElement} onSize={onSize} onError={onError}/>;
  if (kind === 'audio') return <AudioCanvasPlayer key={asset?.id || src} src={src} title={title} assetId={asset?.id} disabled={disabled} onElement={element => onMediaElement?.(element)} onError={onError}/>;
  return <div className="content-shell" data-content-kind={kind} data-canvas-control onPointerDown={event => { if (surface === 'canvas' && !isContentInteraction(event.currentTarget, event.clientX, event.clientY, event.target as Element)) onBlankPointerDown?.(event); event.stopPropagation(); }}>
    {kind === 'markdown' ? <MarkdownBlock asset={asset} src={src} title={title} api={api} disabled={disabled} onSaveError={onSaveError}/> : asset && <HtmlCanvasContent key={asset.id} asset={asset} api={api} preserveScene={preserveScene} onReloadBoard={onReloadBoard} onBlankPointerDown={onBlankPointerDown} onFrameDrag={onFrameDrag} onFrameWheel={surface === 'canvas' ? onFrameWheel : undefined}/>}
  </div>;
}
