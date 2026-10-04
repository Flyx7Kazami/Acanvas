import { useEffect, useState } from 'react';
import { ArrowDownToLine, Code2, File, FileText, Music2, Play } from 'lucide-react';
import type { Asset } from '../shared/types';
import { resolveContentKind } from '../shared/content-types';
import { getVideoThumbnail } from './videoThumbnail';
import { MarkdownCanvasContent } from './MarkdownCanvasContent';
import { AudioCanvasPlayer } from './AudioCanvasPlayer';
import { HtmlCanvasContent } from './HtmlCanvasContent';
import type { BoardApi } from './api';
import './content.css';

const bytes = (value: number) => value < 1024 * 1024 ? `${Math.max(1, Math.round(value / 1024))} KB` : `${(value / (1024 * 1024)).toFixed(1)} MB`;

export function AssetThumb({ asset, src }: { asset?: Asset; src: string }) {
  const kind = resolveContentKind(asset), [frame, setFrame] = useState<{ src: string; image: string }>();
  useEffect(() => {
    if (kind !== 'video') return;
    let active = true; void getVideoThumbnail(src).then(image => { if (active && image) setFrame({ src, image }); });
    return () => { active = false; };
  }, [kind, src]);
  const image = kind === 'image' || kind === 'gif' ? src : frame?.src === src ? frame.image : undefined;
  const Icon = kind === 'video' ? Play : kind === 'audio' ? Music2 : kind === 'markdown' ? FileText : kind === 'html' ? Code2 : File;
  return <span className="asset-thumb" data-kind={kind}>{image ? <img src={image} alt="" loading="lazy"/> : <Icon size={15} className="content-thumbnail-icon"/>}</span>;
}

export interface ContentRendererProps {
  asset?: Asset;
  src: string;
  api: BoardApi;
  surface?: 'canvas' | 'detail';
  interactive?: boolean;
  disabled?: boolean;
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
  error?: boolean;
  onError?: (cause?: unknown) => void;
  onSize?: (size: { width: number; height: number }) => void;
  onMediaElement?: (element: HTMLMediaElement | null) => void;
  onExitInteraction?: () => void;
  onReloadBoard?: () => Promise<void>;
}

export function ContentRenderer({ asset, src, api, surface = 'canvas', interactive = false, disabled, expanded = false, onExpandedChange, error, onError, onSize, onMediaElement, onExitInteraction, onReloadBoard }: ContentRendererProps) {
  const [detailExpanded, setDetailExpanded] = useState(true);
  const kind = resolveContentKind(asset), title = asset?.name || 'File';
  if (error || kind === 'file') return <div className="file-card"><File size={32} strokeWidth={1.25}/><strong>{title}</strong><span>{error ? 'Preview unavailable in this browser' : `${asset?.mime || 'Attachment'} · ${bytes(asset?.size || 0)}`}</span><a data-canvas-control href={src} download={title} onPointerDown={event => event.stopPropagation()}><ArrowDownToLine size={13}/>Download file</a></div>;
  if (kind === 'image' || kind === 'gif') return <img src={src} alt={title} draggable={false} onLoad={event => onSize?.({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })} onError={() => onError?.()}/>;
  if (kind === 'video') return <video playsInline preload="metadata" controls={surface === 'detail'} tabIndex={surface === 'detail' ? 0 : -1} src={src} ref={element => onMediaElement?.(element)} onLoadedMetadata={event => onSize?.({ width: event.currentTarget.videoWidth, height: event.currentTarget.videoHeight })} onError={() => onError?.()}/>;
  if (kind === 'audio') return <AudioCanvasPlayer key={asset?.id || src} src={src} title={title} expanded={surface === 'detail' ? detailExpanded : expanded} onExpandedChange={surface === 'detail' ? setDetailExpanded : onExpandedChange || (() => {})} disabled={disabled} onElement={element => onMediaElement?.(element)} onError={onError}/>;
  const active = surface === 'detail' || interactive;
  return <div className={`content-shell${active ? ' is-interactive' : ''}`} data-content-kind={kind} data-canvas-control={active || undefined} onPointerDown={event => { if (active) event.stopPropagation(); }} onKeyDown={event => { if (active && event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onExitInteraction?.(); } }}>
    {kind === 'markdown' ? <><MarkdownCanvasContent src={src} title={title} interactive={active}/><a className="markdown-download" data-canvas-control href={src} download={title} aria-label={`Download ${title}`} title="Download original Markdown" onPointerDown={event => event.stopPropagation()}><ArrowDownToLine size={13}/></a></> : asset && <HtmlCanvasContent key={asset.id} asset={asset} api={api} interactive={active} onExitInteraction={onExitInteraction} onReloadBoard={onReloadBoard}/>}
    {!active && kind === 'markdown' && <div className="content-layout-shield" aria-hidden="true"/>}
  </div>;
}
