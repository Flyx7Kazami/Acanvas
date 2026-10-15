import { useRef } from 'react';
import { ArrowDownToLine, File } from 'lucide-react';
import type { Asset } from '../../shared/types.js';
import { useSceneCapture } from './content.js';
import { useControlledScenePanel } from './media/use-controlled-panel.js';
import { DominoLoader } from '../DominoLoader';

export function SceneStaticImage({ src, title, onError, onSize }: { src: string; title: string; onError?: () => void; onSize?: (size: { width: number; height: number }) => void }) {
  const image = useRef<HTMLImageElement>(null);
  useSceneCapture(() => { const pixels = image.current; return pixels?.complete && pixels.naturalWidth ? { pixels, bitmap: { width: pixels.naturalWidth, height: pixels.naturalHeight }, fit: 'contain' } : undefined; });
  return <img ref={image} src={src} alt={title} draggable={false} onLoad={event => onSize?.({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })} onError={onError}/>;
}

const bytes = (value: number) => value < 1024 * 1024 ? `${Math.max(1, Math.round(value / 1024))} KB` : `${(value / (1024 * 1024)).toFixed(1)} MB`;
export function SceneFileCard({ asset, src, error = false }: { asset?: Asset; src: string; error?: boolean }) {
  const node = useRef<HTMLDivElement>(null);
  useControlledScenePanel(node, { metadata: () => ({ scroll: { x: node.current?.scrollLeft || 0, y: node.current?.scrollTop || 0 } }) });
  const title = asset?.name || 'File', description = error ? 'Preview unavailable in this browser' : `${asset?.mime || 'Attachment'} · ${bytes(asset?.size || 0)}`;
  return <div ref={node} className="file-card" data-canvas-wheel="content">{!asset && !error ? <div className="content-loading" role="status"><DominoLoader size={36}/><span>Loading file…</span></div> : <><File size={32} strokeWidth={1.25}/><strong>{title}</strong><span>{description}</span><a data-canvas-control href={src} download={title} onPointerDown={event => event.stopPropagation()}><ArrowDownToLine size={13}/>Download file</a></>}</div>;
}
