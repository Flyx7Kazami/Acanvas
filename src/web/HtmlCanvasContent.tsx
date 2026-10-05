import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { ArrowDownToLine, Code2, Play, RotateCw, Square } from 'lucide-react';
import type { Asset } from '../shared/types';
import type { BoardApi, HtmlPreviewGrant } from './api';
import { HTML_PREVIEW_LIMIT, useHtmlPreviewSlot } from './HtmlPreviewPool';

export function HtmlCanvasContent({ asset, api, onReloadBoard, onFrameDrag }: { asset: Asset; api: BoardApi; onReloadBoard?: () => Promise<void>; onFrameDrag?: (frame: HTMLIFrameElement, start: { x: number; y: number }, event: PointerEvent<HTMLElement>) => void }) {
  const container = useRef<HTMLDivElement>(null), preview = useHtmlPreviewSlot(container);
  const [attempt, setAttempt] = useState(0);
  const [pendingDrag, setPendingDrag] = useState<{ pointerId: number; x: number; y: number }>();
  useEffect(() => { if (!pendingDrag) return; const timeout = setTimeout(() => setPendingDrag(undefined), 1500); return () => clearTimeout(timeout); }, [pendingDrag]);
  const [grant, setGrant] = useState<HtmlPreviewGrant>();
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [ready, setReady] = useState(false);
  const frame = useRef<HTMLIFrameElement>(null), active = useRef<HtmlPreviewGrant | undefined>(undefined), requestSequence = useRef(0);
  const documentOrigin = useRef(document.querySelector<HTMLMetaElement>('meta[name="acanvas-html-preview-origin"]')?.content);
  const [reloadRequired, setReloadRequired] = useState(false);
  useEffect(() => {
    if (preview.slot !== 'running') return;
    const sequence = ++requestSequence.current;
    setBusy(true); setError(''); setReady(false); setReloadRequired(false);
    void api.createHtmlPreview(asset.id).then(async value => {
      if (sequence !== requestSequence.current) { await api.revokeHtmlPreview(value.id).catch(() => {}); return; }
      let url: URL;
      try { url = new URL(value.url); }
      catch { await api.revokeHtmlPreview(value.id).catch(() => {}); throw new Error('The preview address is unavailable.'); }
      if (url.protocol !== 'http:' || !['127.0.0.2', '127.0.0.1', 'localhost'].includes(url.hostname) || url.hostname === window.location.hostname || url.origin !== value.origin || url.username || url.password || !Number.isFinite(Date.parse(value.expiresAt))) { await api.revokeHtmlPreview(value.id).catch(() => {}); throw new Error('The preview address is unavailable.'); }
      if (documentOrigin.current && value.origin !== documentOrigin.current) {
        await api.revokeHtmlPreview(value.id).catch(() => {});
        if (sequence === requestSequence.current) setReloadRequired(true);
        throw new Error('Reload the board to run HTML preview.');
      }
      if (sequence !== requestSequence.current) { await api.revokeHtmlPreview(value.id).catch(() => {}); return; }
      active.current = value; setGrant(value); setBusy(false);
    }).catch(cause => {
      if (sequence === requestSequence.current) { setError(cause instanceof Error ? cause.message : 'The preview is unavailable.'); preview.stop(); }
    });
    return () => {
      requestSequence.current++; const current = active.current; active.current = undefined;
      setGrant(undefined); setReady(false); setBusy(false); setPendingDrag(undefined);
      if (current) void api.revokeHtmlPreview(current.id).catch(() => {});
    };
  }, [api, asset.id, preview.slot, preview.stop, attempt]);
  useEffect(() => {
    if (!grant) return;
    const bridge = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow || event.origin !== 'null' || !event.data || event.data.instanceId !== grant.id) return;
      if (event.data.type === 'acanvas:preview-ready') setReady(true);
      if (event.data.type === 'acanvas:preview-drag' && frame.current) {
        const { pointerId, x, y } = event.data;
        if (onFrameDrag && document.activeElement === frame.current && Number.isSafeInteger(pointerId) && pointerId >= 0 && Number.isFinite(x) && Number.isFinite(y) && x >= 0 && x <= 1 && y >= 0 && y <= 1) setPendingDrag({ pointerId, x, y });
      }
    };
    window.addEventListener('message', bridge);
    const timer = window.setTimeout(() => { setError('Preview expired. Run it again.'); preview.stop(); }, Math.max(0, Date.parse(grant.expiresAt) - Date.now()));
    return () => { window.removeEventListener('message', bridge); clearTimeout(timer); };
  }, [grant, onFrameDrag, preview.stop]);

  function run() { setAttempt(value => value + 1); preview.request(); }
  const running = preview.slot === 'running', limited = preview.slot === 'waiting';
  return <div ref={container} className="html-content" data-preview-state={preview.slot} data-preview-ready={running && ready || undefined}>
    {running && grant ? <iframe ref={frame} src={grant.url} title={`HTML preview: ${asset.name}`} sandbox="allow-scripts" referrerPolicy="no-referrer" allow=""/> : <div className="html-poster"><Code2 size={32} strokeWidth={1.25}/><strong>{asset.name}</strong><span>{limited ? `Preview limit: ${HTML_PREVIEW_LIMIT} at a time` : preview.slot === 'stopped' ? 'Preview stopped' : 'Interactive HTML'}</span><button type="button" data-canvas-control disabled={running || reloadRequired} onPointerDown={event => event.stopPropagation()} onClick={run}><Play size={13}/>{running ? 'Starting preview…' : limited ? 'Show preview' : 'Run preview'}</button></div>}
    {pendingDrag && <div className="html-drag-capture" aria-hidden="true" onPointerDown={() => setPendingDrag(undefined)} onPointerMove={event => {
      if (!event.isTrusted || !(event.buttons & 1)) { setPendingDrag(undefined); return; }
      if (event.pointerId === pendingDrag.pointerId && frame.current) { event.stopPropagation(); onFrameDrag?.(frame.current, pendingDrag, event); setPendingDrag(undefined); }
    }} onPointerUp={() => setPendingDrag(undefined)} onPointerCancel={() => setPendingDrag(undefined)}/>}
    <div className="html-preview-tools" data-canvas-control onPointerDown={event => event.stopPropagation()}>
      {running && grant && <><button type="button" aria-label="Reload HTML preview" title="Reload preview" disabled={busy} onClick={run}><RotateCw size={13}/></button><button type="button" aria-label="Stop HTML preview" title="Stop preview" onClick={() => { setError(''); preview.stop(); }}><Square size={13}/></button></>}
      <a href={api.content(asset.id)} download={asset.name} aria-label={`Download ${asset.name}`} title="Download original HTML"><ArrowDownToLine size={13}/></a>
    </div>
    {error && <div className="html-preview-error" role="status"><p>{error}</p>{reloadRequired && <button type="button" data-canvas-control onPointerDown={event => event.stopPropagation()} onClick={() => { if (onReloadBoard) void onReloadBoard(); else window.location.reload(); }}>Reload board</button>}</div>}
  </div>;
}
