import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import type { HtmlBundle } from '../shared/types.js';
import { bundleMime, validBundlePath } from '../shared/html-bundle.js';
import { isContentInteraction } from '../shared/content-hit.js';
import { resolveContentKind } from '../shared/content-types.js';
import { installHtmlInputBridge } from '../shared/html-preview-input.js';
import { installHtmlSnapshotBridge } from '../shared/html-preview-snapshot.js';
import { ApiFailure, type CanvasService } from './service.js';

export interface HtmlPreviewGrant { id: string; url: string; origin: string; expiresAt: string }
interface Grant { bundle?: HtmlBundle; assetId: string; parentOrigin: string; origin: string; expires: number;purpose:'preview'|'surface' }
export interface HtmlPreviewRuntime {
  originFor: (parentOrigin: string) => string;
  issue: (assetId: string, parentOrigin: string,purpose?:'preview'|'surface') => HtmlPreviewGrant;
  hold:(id:string)=>()=>void;
  revoke: (id: string) => void;
  close: () => Promise<void>;
}

const permissions = ['accelerometer', 'autoplay', 'camera', 'clipboard-read', 'clipboard-write', 'display-capture', 'fullscreen', 'geolocation', 'gyroscope', 'hid', 'idle-detection', 'magnetometer', 'microphone', 'midi', 'payment', 'serial', 'usb', 'xr-spatial-tracking'].map(name => `${name}=()`).join(', ');
const deny = (response: ServerResponse, status: number, code: string) => {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify({ error: { code } }));
};

export async function startHtmlPreview(service: CanvasService, options: { lifetimeMs?: number; maxBytes?: number; bind?: string; port?: number; origins?: string[] } = {}): Promise<HtmlPreviewRuntime> {
  const grants = new Map<string, Grant>();
  const active=new Map<string,number>();
  const handlers = new Set<Promise<void>>(), responses = new Set<ServerResponse>();
  const lifetime = options.lifetimeMs ?? 10 * 60 * 1000, maxBytes = options.maxBytes ?? 10 * 1024 * 1024;
  let port = 0, closing = false, shutdown: Promise<void> | undefined;
  // The preview uses the other loopback hostname so the main authentication cookie stays on its host.
  const loopback = (parentOrigin: string) => `http://${new URL(parentOrigin).hostname === 'localhost' ? '127.0.0.1' : 'localhost'}:${port}`;
  // Configured origins serve remote boards; a board never receives its own origin, and an HTTPS board only receives HTTPS previews.
  const originFor = (parentOrigin: string) => {
    const parent = new URL(parentOrigin), configured = options.origins ?? [];
    if (['localhost', '127.0.0.1'].includes(parent.hostname) || !configured.length) return loopback(parentOrigin);
    const usable = configured.map(value => new URL(value)).filter(value => value.origin !== parent.origin && (parent.protocol === 'http:' || value.protocol === 'https:'));
    return (usable.find(value => value.hostname !== parent.hostname && value.protocol === parent.protocol) ?? usable.find(value => value.hostname !== parent.hostname) ?? usable[0])?.origin ?? loopback(parentOrigin);
  };
  const expired=(id:string,grant:Grant)=>grant.expires<=Date.now()&&!active.has(id);
  const prune = () => { for (const [id, grant] of grants) if (expired(id,grant)) grants.delete(id); };
  const handle = async (request: IncomingMessage, response: ServerResponse) => {
    responses.add(response); response.on('close', () => responses.delete(response));
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Permissions-Policy', permissions);
    response.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; frame-ancestors 'none'");
    try {
      if (closing) { deny(response, 503, 'preview_closing'); return; }
      prune();
      const path = new URL(request.url ?? '/', 'http://localhost').pathname;
      const match = path.match(/^\/preview\/([A-Za-z0-9_-]{43})(?:\/files\/(.+))?$/), grant = match && grants.get(match[1]);
      if (!grant) { deny(response, 404, 'preview_missing'); return; }
      if (request.headers.host?.toLowerCase() !== new URL(grant.origin).host) { deny(response, 403, 'preview_host_rejected'); return; }
      if (request.method !== 'GET' && request.method !== 'HEAD') { deny(response, 405, 'preview_method_rejected'); return; }
      const asset = service.asset(grant.assetId);
      const resourcePath = match![2] ? decodeURIComponent(match![2]) : undefined;
      const bundle = grant.bundle;
      const entryRequest = bundle ? resourcePath === bundle.entryPath : !resourcePath;
      if (!entryRequest) {
        if (!bundle || !resourcePath || !validBundlePath(resourcePath) || !Object.hasOwn(bundle.files, resourcePath)) { deny(response, 404, 'preview_resource_missing'); return; }
        const mime = bundleMime(resourcePath)!;
        const destination = request.headers['sec-fetch-dest'];
        const accepted = mime === 'text/css' ? ['style'] : mime === 'text/javascript' ? ['script'] : mime.startsWith('image/') ? ['image', 'empty'] : mime.startsWith('font/') ? ['font'] : [];
        if (typeof destination !== 'string' || !accepted.includes(destination) || !['cors', 'no-cors'].includes(String(request.headers['sec-fetch-mode']))) { deny(response, 403, 'preview_resource_type'); return; }
        const bytes = await readFile(service.assetPath(bundle.files[resourcePath]));
        if (closing || !grants.has(match![1]) || expired(match![1],grant)) { deny(response, 404, 'preview_missing'); return; }
        // Only this capability-scoped resource endpoint supports opaque-origin CORS.
        response.setHeader('Access-Control-Allow-Origin', '*');
        response.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
        response.setHeader('Content-Type', mime);
        response.setHeader('Content-Length', bytes.length);
        response.writeHead(200); response.end(request.method === 'HEAD' ? undefined : bytes); return;
      }
      if (request.headers['sec-fetch-dest'] !== 'iframe' || request.headers['sec-fetch-mode'] !== 'navigate') { deny(response, 403, 'preview_embedding_required'); return; }
      if (asset.size > maxBytes) { deny(response, 413, 'preview_too_large'); return; }
      const source = await readFile(service.assetPath(asset.id), 'utf8');
      if (closing || !grants.has(match![1]) || expired(match![1],grant)) { deny(response, 404, 'preview_missing'); return; }
      const bridge = `(()=>{const hit=${isContentInteraction.toString()};const send=parent.postMessage.bind(parent),instanceId=${JSON.stringify(match![1])},target=${JSON.stringify(grant.parentOrigin)};${bundle ? 'window' : 'document'}.addEventListener('${bundle ? 'load' : 'DOMContentLoaded'}',()=>send({type:'acanvas:preview-ready',instanceId},target),{once:true});let blankDown=false;document.addEventListener('dragstart',event=>{if(blankDown)event.preventDefault();},{capture:true});document.addEventListener('pointerdown',event=>{blankDown=false;if(event.isTrusted&&event.button===0&&!hit(document.documentElement,event.clientX,event.clientY,event.target)){blankDown=true;send({type:'acanvas:preview-drag',instanceId,pointerId:event.pointerId,x:event.clientX/innerWidth,y:event.clientY/innerHeight},target);}},{capture:true});})();`;
      const snapshotBridge = `(${installHtmlSnapshotBridge.toString()})(${JSON.stringify(match![1])},${JSON.stringify(grant.parentOrigin)});`;
      const inputBridge = `(${installHtmlInputBridge.toString()})(${JSON.stringify(match![1])},${JSON.stringify(grant.parentOrigin)});`;
      const document = grant.purpose==='surface'?source:`<!doctype html><script>${inputBridge}${bridge}${snapshotBridge}</script>${source}`;
      const resources = bundle ? `${grant.origin}/preview/${match![1]}/files/` : '';
      response.setHeader('Content-Security-Policy', `sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'${resources ? ` ${resources}` : ''}; style-src 'unsafe-inline'${resources ? ` ${resources}` : ''}; img-src data:${resources ? ` ${resources}` : ''}; connect-src ${resources || "'none'"}; media-src 'none'; font-src ${resources || "'none'"}; worker-src 'none'; child-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors ${grant.parentOrigin}`);
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.setHeader('Content-Length', Buffer.byteLength(document));
      response.writeHead(200); response.end(request.method === 'HEAD' ? undefined : document);
    } catch (error) {
      if (response.headersSent || response.destroyed) { response.destroy(); return; }
      deny(response, error instanceof ApiFailure ? error.status : 500, error instanceof ApiFailure ? error.code : 'preview_unavailable');
    }
  };
  const server = createServer((request, response) => {
    const pending = handle(request, response); handlers.add(pending);
    void pending.finally(() => handlers.delete(pending));
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(options.port ?? 0, options.bind ?? '127.0.0.1', () => { server.off('error', reject); port = (server.address() as AddressInfo).port; resolve(); }); });
  const expiry = setInterval(prune, Math.min(lifetime, 60_000)); expiry.unref();
  return {
    originFor,
    issue: (assetId, parentOrigin,purpose='preview') => {
      const parent = new URL(parentOrigin);
      if (parent.origin !== parentOrigin || !['http:', 'https:'].includes(parent.protocol)) throw new ApiFailure(400, 'preview_origin', 'Use the current whiteboard origin.');
      const asset = service.asset(assetId); service.assetPath(asset.id);
      if (resolveContentKind(asset) !== 'html') throw new ApiFailure(400, 'preview_type', 'Run an HTML file in this preview.');
      if (asset.size > maxBytes) throw new ApiFailure(413, 'preview_too_large', 'HTML previews support files up to 10 MiB. Download the original file to open it separately.');
      prune();
      const id = randomBytes(32).toString('base64url'), expires = Date.now() + lifetime, origin = originFor(parentOrigin);
      grants.set(id, { assetId, parentOrigin, origin, expires,purpose, ...(asset.htmlBundle ? { bundle: structuredClone(asset.htmlBundle) } : {}) });
      return { id, url: `${origin}/preview/${id}${asset.htmlBundle ? `/files/${asset.htmlBundle.entryPath.split('/').map(encodeURIComponent).join('/')}` : ''}`, origin, expiresAt: new Date(expires).toISOString() };
    },
    hold:id=>{const grant=grants.get(id);if(!grant||expired(id,grant)||grant.purpose!=='surface')throw new ApiFailure(404,'preview_missing','Open an active HTML surface.');active.set(id,(active.get(id)??0)+1);let released=false;return()=>{if(released)return;released=true;const owners=(active.get(id)??1)-1;if(owners>0)active.set(id,owners);else active.delete(id);prune();};},
    revoke: id => { grants.delete(id);active.delete(id); },
    close: () => {
      if (shutdown) return shutdown;
      shutdown = (async () => {
        closing = true; clearInterval(expiry); grants.clear();active.clear();
        const stopped = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        for (const response of responses) response.destroy();
        server.closeAllConnections();
        await Promise.allSettled([...handlers]); await stopped;
      })();
      return shutdown;
    },
  };
}
