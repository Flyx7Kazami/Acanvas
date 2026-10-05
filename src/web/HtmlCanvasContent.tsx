import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent } from 'react';
import { ArrowDownToLine, Code2, RotateCw, Square } from 'lucide-react';
import type { Asset } from '../shared/types';
import type { BoardApi, HtmlPreviewGrant } from './api';
import { HTML_PREVIEW_LIMIT, useHtmlPreviewSlot } from './HtmlPreviewPool';
import { rasterizeHtmlSnapshot } from './html-preview-snapshot';

import type { CanvasWheelInput } from './canvas-wheel';

export function HtmlCanvasContent({ asset, api, onReloadBoard, onFrameDrag, onFrameWheel }: { asset: Asset; api: BoardApi; onFrameWheel?: (event: CanvasWheelInput) => void; onReloadBoard?: () => Promise<void>; onFrameDrag?: (frame: HTMLIFrameElement, start: { x: number; y: number }, event: PointerEvent<HTMLElement>) => void }) {
  const container = useRef<HTMLDivElement>(null), preview = useHtmlPreviewSlot(container);
  const stoppedWhileHovered = useRef(false), hoverAttempted = useRef(false);
  const [attempt, setAttempt] = useState(0), [pendingDrag, setPendingDrag] = useState<{ pointerId: number; x: number; y: number }>();
  const [grant, setGrant] = useState<HtmlPreviewGrant>();
  const [error, setError] = useState(''), [ready, setReady] = useState(false), [reloadRequired, setReloadRequired] = useState(false);
  const frame = useRef<HTMLIFrameElement>(null), active = useRef<HtmlPreviewGrant | undefined>(undefined), requestSequence = useRef(0);
  const documentOrigin = useRef(document.querySelector<HTMLMetaElement>('meta[name="acanvas-html-preview-origin"]')?.content);
  const inputPort = useRef<MessagePort | undefined>(undefined);
  const allocated = ['capturing', 'live', 'freezing'].includes(preview.slot), live = preview.slot === 'live';
  const inputState = useRef({ live, onFrameWheel, onFrameDrag, preview }); inputState.current = { live, onFrameWheel, onFrameDrag, preview };
  const currentGeneration = useRef(preview.generation); currentGeneration.current = preview.generation;
  useEffect(() => { if (!pendingDrag) return; const timeout = setTimeout(() => setPendingDrag(undefined), 1500); return () => clearTimeout(timeout); }, [pendingDrag]);
  useEffect(() => {
    if (!allocated) return;
    const sequence = ++requestSequence.current, controller = new AbortController();
    let release: (() => void) | undefined, accepted = false;
    const revoke = (id: string) => api.revokeHtmlPreview(id, AbortSignal.timeout(2000)).catch(() => {});
    setError(''); setReady(false); setReloadRequired(false);
    const timeout = window.setTimeout(() => {
      if (sequence === requestSequence.current) { setError('Preview timed out. Try again.'); preview.fail(currentGeneration.current); }
    }, 10_000);
    void (async () => {
      release = await preview.acquire(controller.signal);
      if (controller.signal.aborted) return;
      const value = await api.createHtmlPreview(asset.id, AbortSignal.timeout(10_000));
      if (sequence !== requestSequence.current) { await revoke(value.id); return; }
      let url: URL;
      try { url = new URL(value.url); }
      catch { await revoke(value.id); throw new Error('The preview address is unavailable.'); }
      if (url.protocol !== 'http:' || !['127.0.0.2', '127.0.0.1', 'localhost'].includes(url.hostname) || url.hostname === window.location.hostname || url.origin !== value.origin || url.username || url.password || !Number.isFinite(Date.parse(value.expiresAt))) { await revoke(value.id); throw new Error('The preview address is unavailable.'); }
      if (documentOrigin.current && value.origin !== documentOrigin.current) {
        await revoke(value.id);
        if (sequence === requestSequence.current) setReloadRequired(true);
        throw new Error('Reload the board to run HTML preview.');
      }
      if (sequence !== requestSequence.current) { await revoke(value.id); return; }
      clearTimeout(timeout); accepted = true; active.current = value; setGrant(value);
    })().catch(cause => {
      if (sequence === requestSequence.current) { setError(cause instanceof Error ? cause.message : 'The preview is unavailable.'); preview.fail(currentGeneration.current); }
    }).finally(() => { if (!accepted) release?.(); });
    return () => {
      clearTimeout(timeout); controller.abort(); requestSequence.current++; const current = active.current; active.current = undefined;
      setGrant(undefined); setReady(false); setPendingDrag(undefined);
      if (current) void revoke(current.id).finally(() => release?.());
    };
  }, [api, asset.id, allocated, preview.fail, preview.acquire, attempt]);
  useLayoutEffect(() => {
    if (!grant || !frame.current) return;
    const iframe = frame.current;
    let connected = false, port: MessagePort | undefined;
    const framePoint = (x: number, y: number) => {
      if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1) return;
      const rect = iframe.getBoundingClientRect(), point = { clientX: rect.left + x * rect.width, clientY: rect.top + y * rect.height };
      return document.elementFromPoint(point.clientX, point.clientY) === iframe ? point : undefined;
    };
    const input = (event: MessageEvent) => {
      const data = event.data, { live, onFrameWheel, preview } = inputState.current;
      if (active.current?.id !== grant.id || frame.current !== iframe || data?.instanceId !== grant.id) return;
      if (data.type === 'acanvas:preview-engaged' && live && framePoint(data.x, data.y)) { preview.setHovered(true); preview.request(); }
      if (data.type === 'acanvas:preview-left') preview.setHovered(false);
      if (data.type === 'acanvas:preview-focus' && live && document.activeElement === iframe) preview.request();
      if (data.type === 'acanvas:preview-wheel' && live && onFrameWheel) {
        const { x, y, deltaX, deltaY, deltaMode, ctrlKey, metaKey } = data;
        if (![x, y, deltaX, deltaY].every(Number.isFinite) || Math.abs(deltaX) > 100000 || Math.abs(deltaY) > 100000 || ![0, 1, 2].includes(deltaMode) || typeof ctrlKey !== 'boolean' || typeof metaKey !== 'boolean') return;
        const point = framePoint(x, y); if (point) onFrameWheel({ ...point, deltaX, deltaY, deltaMode, ctrlKey, metaKey });
      }
    };
    const bridge = (event: MessageEvent) => {
      if (event.source !== iframe.contentWindow || event.origin !== 'null' || !event.data || event.data.instanceId !== grant.id || active.current?.id !== grant.id) return;
      if (event.data.type === 'acanvas:preview-input') {
        if (connected || event.ports.length !== 1) { event.ports.forEach(value => value.close()); return; }
        connected = true; port = event.ports[0]; inputPort.current = port; port.onmessage = input;
        port.postMessage({ type: 'acanvas:preview-wheel-mode', enabled: !!inputState.current.onFrameWheel && inputState.current.live });
      }
      if (event.data.type === 'acanvas:preview-ready') setReady(true);
      const { live, onFrameDrag } = inputState.current;
      if (event.data.type === 'acanvas:preview-drag' && live) {
        const { pointerId, x, y } = event.data;
        if (onFrameDrag && document.activeElement === iframe && Number.isSafeInteger(pointerId) && pointerId >= 0 && Number.isFinite(x) && Number.isFinite(y) && x >= 0 && x <= 1 && y >= 0 && y <= 1) setPendingDrag({ pointerId, x, y });
      }
    };
    window.addEventListener('message', bridge);
    return () => { window.removeEventListener('message', bridge); port?.close(); if (inputPort.current === port) inputPort.current = undefined; };
  }, [grant]);
  useEffect(() => { inputPort.current?.postMessage({ type: 'acanvas:preview-wheel-mode', enabled: !!onFrameWheel && live }); }, [onFrameWheel, live]);
  useEffect(() => {
    if (!grant) return;
    const timer = window.setTimeout(() => { setError('Preview expired. Hover again to restart.'); preview.stop(); }, Math.max(0, Date.parse(grant.expiresAt) - Date.now()));
    return () => clearTimeout(timer);
  }, [grant, preview.stop]);
  useEffect(() => {
    if (preview.slot !== 'capturing' && preview.slot !== 'freezing') return;
    // This includes grant acquisition and content that never reaches readiness.
    const timer = window.setTimeout(() => {
      setError('Snapshot unavailable. You can still interact or retry.'); preview.complete(preview.generation);
    }, preview.slot === 'freezing' ? 2000 : 8000);
    return () => clearTimeout(timer);
  }, [preview.slot, preview.generation, preview.complete]);
  useEffect(() => {
    if (!grant || !ready || preview.slot !== 'capturing' && preview.slot !== 'freezing') return;
    const controller = new AbortController(), requestId = crypto.randomUUID();
    let received = false, firstFrame = 0, secondFrame = 0;
    const message = (event: MessageEvent) => {
      if (received || event.source !== frame.current?.contentWindow || event.origin !== 'null' || !event.data || event.data.instanceId !== grant.id || event.data.requestId !== requestId) return;
      if (!['acanvas:preview-snapshot', 'acanvas:preview-snapshot-error'].includes(event.data.type)) return;
      received = true;
      if (event.data.type === 'acanvas:preview-snapshot-error') { setError('Snapshot unavailable. You can still interact or retry.'); preview.complete(preview.generation); return; }
      const { svg, width, height } = event.data;
      if (width !== preview.width || height !== preview.height) { setError('Snapshot size changed. Retry after resizing.'); preview.complete(preview.generation); return; }
      void rasterizeHtmlSnapshot({ svg, width, height }, controller.signal).then(image => {
        if (!controller.signal.aborted) { setError(''); preview.complete(preview.generation, image); }
      }).catch(() => {
        if (!controller.signal.aborted) { setError('Snapshot unavailable. You can still interact or retry.'); preview.complete(preview.generation); }
      });
    };
    window.addEventListener('message', message);
    firstFrame = requestAnimationFrame(() => { secondFrame = requestAnimationFrame(() => frame.current?.contentWindow?.postMessage({ type: 'acanvas:preview-snapshot', instanceId: grant.id, requestId }, '*')); });
    return () => { controller.abort(); cancelAnimationFrame(firstFrame); cancelAnimationFrame(secondFrame); window.removeEventListener('message', message); };
  }, [grant, ready, preview.slot, preview.generation, preview.width, preview.height, preview.complete]);

  function interact(explicit = false) { if (explicit) stoppedWhileHovered.current = false; if (reloadRequired || stoppedWhileHovered.current) return; setError(''); preview.request(); }
  function hover(event: PointerEvent<HTMLDivElement>) {
    if (hoverAttempted.current || (event.target as Element).closest('.html-preview-tools')) return;
    hoverAttempted.current = true; interact();
  }
  function reload() { setAttempt(value => value + 1); setError(''); }
  const preparing = preview.slot === 'capturing' || preview.slot === 'freezing' || preview.slot === 'waiting';
  return <div ref={container} className="html-content" data-preview-state={preview.slot} data-preview-ready={allocated && ready || undefined} tabIndex={0} aria-label={`HTML preview: ${asset.name}`}
    onPointerEnter={event => { preview.setHovered(true); hover(event); }} onPointerMove={hover} onPointerLeave={() => { preview.setHovered(false); stoppedWhileHovered.current = false; hoverAttempted.current = false; }}
    onFocus={event => { if (event.target === event.currentTarget) interact(true); }}
    onKeyDown={event => { if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); interact(true); } }}
    onPointerDown={event => { if (event.pointerType === 'touch' && !(event.target as Element).closest('[data-canvas-control].html-preview-tools')) interact(true); }}>
    {preview.image && <img className="html-snapshot" src={preview.image.url} alt={`Static preview of ${asset.name}`} draggable={false} data-snapshot-width={preview.image.width} data-snapshot-height={preview.image.height}/>}
    {allocated && grant && <iframe ref={frame} className={live ? 'html-live-frame' : 'html-capture-frame'} style={{ visibility: preview.image && !ready ? 'hidden' : undefined }} src={grant.url} title={`HTML preview: ${asset.name}`} sandbox="allow-scripts" referrerPolicy="no-referrer" allow="" tabIndex={live ? 0 : -1} aria-hidden={!live} onLoad={() => setReady(true)}/>}
    {!preview.image && !(allocated && grant) && <div className="html-poster"><Code2 size={32} strokeWidth={1.25}/><strong>{asset.name}</strong><span>{preparing ? preview.slot === 'waiting' ? `Waiting for a preview slot · ${HTML_PREVIEW_LIMIT} at a time` : 'Preparing preview…' : 'Preview unavailable'}</span></div>}
    {pendingDrag && live && <div className="html-drag-capture" aria-hidden="true" onPointerDown={() => setPendingDrag(undefined)} onPointerMove={event => {
      if (!event.isTrusted || !(event.buttons & 1)) { setPendingDrag(undefined); return; }
      if (event.pointerId === pendingDrag.pointerId && frame.current) { event.stopPropagation(); onFrameDrag?.(frame.current, pendingDrag, event); setPendingDrag(undefined); }
    }} onPointerUp={() => setPendingDrag(undefined)} onPointerCancel={() => setPendingDrag(undefined)}/>}
    <div className="html-preview-tools" data-canvas-control onPointerDown={event => event.stopPropagation()}>
      {live && <><button type="button" aria-label="Reload HTML preview" title="Reload preview" disabled={!grant} onClick={reload}><RotateCw size={13}/></button><button type="button" aria-label="Stop HTML preview" title="Stop preview" onClick={() => { stoppedWhileHovered.current = true; setError(''); preview.stop(); }}><Square size={13}/></button></>}
      {!live && !preparing && <button type="button" aria-label="Refresh HTML snapshot" title="Refresh snapshot" disabled={reloadRequired} onClick={() => { setError(''); preview.retry(); }}><RotateCw size={13}/></button>}
      <a href={api.content(asset.id)} download={asset.name} aria-label={`Download ${asset.name}`} title="Download original HTML"><ArrowDownToLine size={13}/></a>
    </div>
    {error && <div className="html-preview-error" role="status"><p>{error}</p>{reloadRequired && <button type="button" data-canvas-control onPointerDown={event => event.stopPropagation()} onClick={() => { if (onReloadBoard) void onReloadBoard(); else window.location.reload(); }}>Reload board</button>}</div>}
  </div>;
}
