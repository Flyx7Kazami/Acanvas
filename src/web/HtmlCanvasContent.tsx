import { useEffect, useRef, useState } from 'react';
import { ArrowDownToLine, Code2, Play, RotateCw, Square } from 'lucide-react';
import type { Asset } from '../shared/types';
import type { BoardApi, HtmlPreviewGrant } from './api';

export function HtmlCanvasContent({ asset, api, interactive, onExitInteraction, onReloadBoard }: { asset: Asset; api: BoardApi; interactive: boolean; onExitInteraction?: () => void; onReloadBoard?: () => Promise<void> }) {
  const [grant, setGrant] = useState<HtmlPreviewGrant>();
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [ready, setReady] = useState(false);
  const frame = useRef<HTMLIFrameElement>(null), active = useRef<HtmlPreviewGrant | undefined>(undefined), requestSequence = useRef(0);
  const mounted = useRef(true);
  const documentOrigin = useRef(document.querySelector<HTMLMetaElement>('meta[name="acanvas-html-preview-origin"]')?.content);
  const [reloadRequired, setReloadRequired] = useState(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; requestSequence.current++; const current = active.current; active.current = undefined; if (current) void api.revokeHtmlPreview(current.id).catch(() => {}); };
  }, [api, asset.id]);
  useEffect(() => {
    if (!grant) return;
    const bridge = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow || event.origin !== 'null' || !event.data || event.data.instanceId !== grant.id) return;
      if (event.data.type === 'acanvas:preview-ready') setReady(true);
      if (event.data.type === 'acanvas:preview-exit' && interactive) onExitInteraction?.();
    };
    window.addEventListener('message', bridge);
    const timer = window.setTimeout(() => stop('Preview expired. Run it again.'), Math.max(0, Date.parse(grant.expiresAt) - Date.now()));
    return () => { window.removeEventListener('message', bridge); clearTimeout(timer); };
  }, [grant, interactive, onExitInteraction]);

  function stop(message = '') {
    const sequence = ++requestSequence.current; const current = active.current; active.current = undefined;
    setGrant(undefined); setReady(false); setBusy(false); setError(message); setReloadRequired(false);
    if (current) void api.revokeHtmlPreview(current.id).catch(() => { if (mounted.current && sequence === requestSequence.current) setError('Preview stopped. The local service is disconnected.'); });
  }
  async function run() {
    stop(); const sequence = ++requestSequence.current; setBusy(true);
    try {
      const value = await api.createHtmlPreview(asset.id);
      if (!mounted.current || sequence !== requestSequence.current) { await api.revokeHtmlPreview(value.id); return; }
      const url = new URL(value.url);
      if (url.protocol !== 'http:' || !['127.0.0.2', '127.0.0.1', 'localhost'].includes(url.hostname) || url.hostname === window.location.hostname || url.origin !== value.origin || url.username || url.password || !Number.isFinite(Date.parse(value.expiresAt))) { await api.revokeHtmlPreview(value.id); throw new Error('The preview address is unavailable.'); }
      if (documentOrigin.current && value.origin !== documentOrigin.current) { await api.revokeHtmlPreview(value.id); setReloadRequired(true); throw new Error('Reload the board to run HTML preview.'); }
      active.current = value; setGrant(value); setBusy(false);
    } catch (cause) { if (mounted.current && sequence === requestSequence.current) { setBusy(false); setError(cause instanceof Error ? cause.message : 'The preview is unavailable.'); } }
  }
  return <div className="html-content" data-preview-ready={ready || undefined}>
    {grant ? <iframe ref={frame} src={grant.url} title={`HTML preview: ${asset.name}`} sandbox="allow-scripts" referrerPolicy="no-referrer" tabIndex={interactive ? 0 : -1} inert={!interactive} allow=""/> : <div className="html-poster"><Code2 size={32} strokeWidth={1.25}/><strong>{asset.name}</strong><span>Interactive HTML</span><button type="button" data-canvas-control disabled={busy || reloadRequired} onPointerDown={event => event.stopPropagation()} onClick={() => void run()}><Play size={13}/>{busy ? 'Starting preview…' : 'Run preview'}</button></div>}
    {grant && !interactive && <div className="content-layout-shield" aria-hidden="true"/>}
    <div className="html-preview-tools" data-canvas-control onPointerDown={event => event.stopPropagation()}>
      {grant && <><button type="button" aria-label="Reload HTML preview" title="Reload preview" disabled={busy} onClick={() => void run()}><RotateCw size={13}/></button><button type="button" aria-label="Stop HTML preview" title="Stop preview" onClick={() => stop()}><Square size={13}/></button></>}
      <a href={api.content(asset.id)} download={asset.name} aria-label={`Download ${asset.name}`} title="Download original HTML"><ArrowDownToLine size={13}/></a>
    </div>
    {error && <div className="html-preview-error" role="status"><p>{error}</p>{reloadRequired && <button type="button" data-canvas-control onPointerDown={event => event.stopPropagation()} onClick={() => { if (onReloadBoard) void onReloadBoard(); else window.location.reload(); }}>Reload board</button>}</div>}
  </div>;
}
