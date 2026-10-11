import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, mkdir, readFile, realpath, rename, rm, stat } from 'node:fs/promises';
import { dirname, extname, resolve, relative } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { AnnotationCaptureInput, Asset, Bootstrap, CaptureView, CaptureViewOperation, CompleteInput, Draft, ServiceRuntime, SessionView } from '../shared/types.js';
import { editableTextBytes, editableTextMime, resolveContentKind, resolveContentMime, storageAssetKind } from '../shared/content-types.js';
import { ApiFailure, CanvasService, within } from './service.js';
import { AudioArtworkReader } from './audio-artwork.js';
import { clearRuntime, publishRuntime } from './runtime.js';
import { startHtmlPreview } from './html-preview.js';
import { ProjectBrowser, type ProjectBrowserOptions } from './browser-capture.js';
import { ProjectHtmlSurfaces, type HtmlSurfaceFrame, type HtmlSurfacesOptions } from './render-surface/html.js';
import { htmlInputRequestBytes } from '../shared/html-surface.js';
import { createBoardConnections, type ViewPresence } from './board-connection.js';

export interface ServerOptions { root: string; port?: number; maxUploadBytes?: number; webRoot?: string; allowedOrigins?: string[]; bind?: string; allowedHosts?: string[]; browser?: ProjectBrowserOptions; htmlSurfaces?: HtmlSurfacesOptions }
export interface RunningServer { service: CanvasService; browser: ProjectBrowser; url: string; urls: string[]; close: () => Promise<void> }
const mimeTypes: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png', '.ico': 'image/x-icon' };
const send = (response: ServerResponse, status: number, value: unknown) => { response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(value)); };
const sameToken = (received: string | undefined, token: string): boolean => !!received && Buffer.byteLength(received) === Buffer.byteLength(token) && timingSafeEqual(Buffer.from(received), Buffer.from(token));
const payload = async (request: IncomingMessage,limit=2*1024*1024): Promise<any> => {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of request) { size += chunk.length; if (size > limit) throw new ApiFailure(413, 'request_too_large', `The request exceeds ${limit} bytes.`); chunks.push(Buffer.from(chunk)); }
  const body = Buffer.concat(chunks).toString('utf8');
  try { const value = JSON.parse(body || '{}'); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(); return value; } catch { throw new ApiFailure(400, 'invalid_json', 'Send a JSON object.'); }
};

export const bindAddresses = ['127.0.0.1', '0.0.0.0', '::'];
export function normalizeAllowedHost(value: string): string {
  const host = value.trim().toLowerCase();
  if (!/^(\[[0-9a-f:.]+\]|[a-z0-9]([a-z0-9.-]*[a-z0-9])?)(:\d{1,5})?$/.test(host)) throw new Error(`Choose an allowed host as host[:port]: ${value}`);
  return host;
}

export async function startServer(options: ServerOptions): Promise<RunningServer> {
  const bind = options.bind ?? '127.0.0.1';
  if (!bindAddresses.includes(bind)) throw new Error(`Choose a bind address from ${bindAddresses.join(', ')}.`);
  const extraHosts = [...new Set((options.allowedHosts ?? []).map(normalizeAllowedHost))];
  const service = new CanvasService(options.root);
  const artwork = new AudioArtworkReader(id => service.assetPath(id));
  const preview = await startHtmlPreview(service).catch(error => { service.close(); throw error; });
  const surfaces = new ProjectHtmlSurfaces(service, preview, options.htmlSurfaces);
  const surfaceOwners = new Map<string, CaptureView & { objectId: string; assetId: string }>();
  service.validateSurface = (owner, reference) => surfaces.validateSurface(owner, reference);
  service.retainSurface = (owner, reference) => surfaces.retainSurface(owner, reference);
  service.releaseSurface = (owner, reference) => surfaces.releaseSurface(owner, reference);
  const token = randomBytes(32).toString('base64url');
  const maxUploadBytes = options.maxUploadBytes ?? 512 * 1024 * 1024;
  const events = new Set<ServerResponse>();
  const responses = new Set<ServerResponse>();
  const requests = new Set<IncomingMessage>();
  const handlers = new Set<Promise<void>>();
  const captureUploads = new Set<string>();
  let stopService: () => Promise<void>;
  let browser: ProjectBrowser;
  let closing = false;
  let port = options.port ?? 4317;
  const presences = new Map<string, { view: CaptureView; connections: Set<ViewPresence>; timer?: ReturnType<typeof setTimeout> }>();
  const sameView = (a: CaptureView, b: CaptureView) => a.projectId === b.projectId && a.sessionId === b.sessionId && a.documentId === b.documentId && a.viewId === b.viewId && a.viewGeneration === b.viewGeneration;
  const endPresence = (viewId: string) => { const record = presences.get(viewId); if (!record) return; presences.delete(viewId); clearTimeout(record.timer); for (const connection of record.connections) connection.end(); };
  const retireView = async (view: Pick<CaptureView, 'sessionId' | 'viewId' | 'documentId' | 'viewGeneration'>, operation?: CaptureViewOperation) => {
    const result = operation ? service.closeCaptureView(view.sessionId, view.viewId, operation) : service.retireCaptureView(view.sessionId, view.viewId, view);
    endPresence(view.viewId); await surfaces.closeView(view.viewId);
    for (const [id, owner] of surfaceOwners) if (owner.viewId === view.viewId) surfaceOwners.delete(id);
    return result;
  };
  const watchPresence = (view: CaptureView, connection: ViewPresence) => {
    const active = service.captureView(view.sessionId, view.viewId);
    if (!sameView(view, active)) throw new ApiFailure(409, 'scene_view_conflict', 'Use the current document and view generation.');
    let record = presences.get(view.viewId);
    if (record && !sameView(record.view, view)) throw new ApiFailure(409, 'scene_view_conflict', 'Use the current document and view generation.');
    if (!record) { record = { view: active, connections: new Set() }; presences.set(view.viewId, record); }
    const current = record; clearTimeout(current.timer); current.timer = undefined; current.connections.add(connection);
    return () => {
      current.connections.delete(connection);
      if (closing || presences.get(view.viewId) !== current || current.connections.size || current.timer) return;
      current.timer = setTimeout(() => {
        current.timer = undefined;
        if (closing || presences.get(view.viewId) !== current || current.connections.size) return;
        let latest: CaptureView; try { latest = service.captureView(view.sessionId, view.viewId); } catch { endPresence(view.viewId); return; }
        if (!sameView(current.view, latest)) { endPresence(view.viewId); return; }
        void retireView(latest).catch(() => { endPresence(view.viewId); });
      }, 5000); current.timer.unref();
    };
  };
  const allowedHosts = () => extraHosts.map(host => /:\d+$/.test(host) && !host.endsWith(']') ? host : `${host}:${port}`);
  const authenticationCookieName = () => `acanvas_auth_${port}`;
  const guardSource = (request: IncomingMessage) => {
    const hosts = [`127.0.0.1:${port}`, `localhost:${port}`, ...allowedHosts()];
    if (!request.headers.host || !hosts.includes(request.headers.host.toLowerCase())) throw new ApiFailure(403, 'host_rejected', 'Use the local service address.');
    if (request.headers['sec-fetch-site'] === 'cross-site') throw new ApiFailure(403, 'origin_rejected', 'Cross-site access is restricted.');
    const origin = request.headers.origin;
    const origins = hosts.map((host) => `http://${host}`).concat(options.allowedOrigins ?? []);
    if (origin && (origin === 'null' || !origins.includes(origin))) throw new ApiFailure(403, 'origin_rejected', 'Use an approved local browser origin.');
  };
  const authenticate = (request: IncomingMessage) => {
    const bearer = request.headers.authorization?.startsWith('Bearer ') ? request.headers.authorization.slice(7) : undefined;
    const cookiePrefix = `${authenticationCookieName()}=`;
    const cookie = request.headers.cookie?.split(';').map((item) => item.trim()).find((item) => item.startsWith(cookiePrefix))?.slice(cookiePrefix.length);
    if (!sameToken(bearer, token) && !(['GET', 'HEAD'].includes(request.method ?? '') && sameToken(cookie, token))) throw new ApiFailure(401, 'authentication_required', 'Connect through this local service before using its API.');
  };
  const handle = async (request: IncomingMessage, response: ServerResponse) => {
    requests.add(request); responses.add(response);
    response.on('close', () => responses.delete(response));
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    const parentPolicy = (parentOrigin: string) => `default-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:; font-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; object-src 'none'; frame-src ${preview.originFor(parentOrigin)}; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`;
    response.setHeader('Content-Security-Policy', parentPolicy(`http://127.0.0.1:${port}`));
    try {
      if (closing) { response.setHeader('Connection', 'close'); request.resume(); send(response, 503, { error: { code: 'service_closing', message: 'Reconnect after the local service starts.' } }); return; }
      guardSource(request);
      response.setHeader('Content-Security-Policy', parentPolicy(`http://${request.headers.host}`));
      const url = new URL(request.url ?? '/', `http://127.0.0.1:${port}`);
      const path = url.pathname;
      const method = request.method;
      if (path === '/api/bootstrap' && method === 'GET') {
        response.setHeader('Set-Cookie', `${authenticationCookieName()}=${token}; HttpOnly; SameSite=Strict; Path=/api`);
        const bootstrap: Bootstrap = { project: service.project, token, service: service.identity(), capabilities: { maxUploadBytes, backup: false, recovery: true, mediaPreview: 'browser', generation: 'host_tools' } };
        send(response, 200, bootstrap); return;
      }
      if (path.startsWith('/api/')) {
        authenticate(request);
        if (path === '/api/project/status' && method === 'GET') { send(response, 200, { project: service.project, service: service.identity(), status: 'running' }); return; }
        if (path === '/api/project/stop' && method === 'POST') {
          const input = await payload(request);
          if (input.instanceId !== service.identity().instanceId) throw new ApiFailure(409, 'service_conflict', 'The service instance has changed. Inspect the project service before stopping it.');
          response.once('finish', () => { void stopService(); });
          send(response, 202, { project: service.project, service: service.identity(), status: 'stopping' }); return;
        }
        if (path === '/api/host-bindings' && method === 'POST') { send(response, 200, service.bindHost(await payload(request))); return; }
        if (path === '/api/browser/pages' && method === 'GET') { send(response, 200, browser.status(url.searchParams.get('sessionId') ?? undefined)); return; }
        if (path === '/api/browser/pages' && method === 'POST') {
          const input = await payload(request);
          if (input.instanceId !== service.identity().instanceId) throw new ApiFailure(409, 'service_conflict', 'Reconnect to the current project service.');
          send(response, 200, await browser.open(input.sessionId)); return;
        }
        const browserPageMatch = path.match(/^\/api\/browser\/pages\/([^/]+)$/);
        if (browserPageMatch && method === 'DELETE') {
          const input = await payload(request);
          if (input.instanceId !== service.identity().instanceId) throw new ApiFailure(409, 'service_conflict', 'Reconnect to the current project service.');
          send(response, 200, await browser.closePage(decodeURIComponent(browserPageMatch[1]))); return;
        }
        if (path === '/api/events' && method === 'GET') {
          response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
          response.write('event: ready\ndata: {}\n\n'); events.add(response);
          response.on('close', () => events.delete(response)); return;
        }
        if (path === '/api/state' && method === 'GET') { send(response, 200, service.state(url.searchParams.get('sessionId') ?? '')); return; }
        if (path === '/api/sessions' && method === 'POST') { send(response, 201, service.createSession((await payload(request)).name)); return; }
        if (path === '/api/sessions' && method === 'GET') { send(response, 200, service.sessions()); return; }
        const captureViewMatch = path.match(/^\/api\/sessions\/([^/]+)\/capture-views(?:\/([^/]+)(?:\/(scenes|presented|presentations|presence))?)?$/);
        if (captureViewMatch) {
          const sessionId = decodeURIComponent(captureViewMatch[1]), viewId = captureViewMatch[2] && decodeURIComponent(captureViewMatch[2]);
          if (!viewId && method === 'POST') { send(response, 201, service.registerCaptureView(sessionId, await payload(request))); return; }
          if (viewId && captureViewMatch[3] === 'presence' && method === 'GET') {
            const view = service.captureView(sessionId, viewId);
            if (url.searchParams.get('documentId') !== view.documentId || Number(url.searchParams.get('viewGeneration')) !== view.viewGeneration) throw new ApiFailure(409, 'scene_view_conflict', 'Use the current document and view generation.');
            const detach = watchPresence(view, response);
            response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' }); response.write('event: ready\ndata: {}\n\n');
            response.once('close', detach); return;
          }
          if (viewId && captureViewMatch[3] === 'scenes' && method === 'POST') { send(response, 200, service.sceneSnapshot(sessionId, viewId, await payload(request))); return; }
          if (viewId && captureViewMatch[3] === 'presented' && method === 'PUT') { send(response, 200, service.confirmScenePresentation(sessionId, viewId, await payload(request))); return; }
          if (viewId && captureViewMatch[3] === 'presentations' && method === 'POST') { send(response, 200, service.holdScenePresentation(sessionId, viewId, await payload(request))); return; }
          if (viewId && !captureViewMatch[3] && method === 'DELETE') { const input: CaptureViewOperation = await payload(request); send(response, 200, await retireView({ sessionId, viewId, documentId: input.documentId, viewGeneration: input.viewGeneration }, input)); return; }
        }
        const surfaceMatch = path.match(/^\/api\/sessions\/([^/]+)\/capture-views\/([^/]+)\/html-surfaces(?:\/([^/]+)(?:\/(sample|input|viewport|audio|frames\/(\d+)(\/content)?))?)?$/);
        if (surfaceMatch) {
          const sessionId = decodeURIComponent(surfaceMatch[1]), viewId = decodeURIComponent(surfaceMatch[2]), surfaceId = surfaceMatch[3] && decodeURIComponent(surfaceMatch[3]);
          const input = ['GET', 'HEAD'].includes(method ?? '') ? { documentId: url.searchParams.get('documentId'), viewGeneration: Number(url.searchParams.get('viewGeneration')) } : await payload(request,surfaceMatch[4]==='input'?htmlInputRequestBytes:2*1024*1024);
          const view = service.captureView(sessionId, viewId);
          if (input.documentId !== view.documentId || input.viewGeneration !== view.viewGeneration) throw new ApiFailure(409, 'scene_view_conflict', 'Use the current document and view generation.');
          const frameMetadata = (frame: HtmlSurfaceFrame) => { const { png, ...metadata } = frame; return { ...metadata, contentUrl: `/api/sessions/${encodeURIComponent(sessionId)}/capture-views/${encodeURIComponent(viewId)}/html-surfaces/${encodeURIComponent(frame.surfaceId)}/frames/${frame.frameSeq}/content?documentId=${encodeURIComponent(view.documentId)}&viewGeneration=${view.viewGeneration}` }; };
          if (!surfaceId && method === 'POST') {
            const info = await surfaces.create({ sessionId, viewId, documentId: view.documentId, viewGeneration: view.viewGeneration, objectId: input.objectId, assetId: input.assetId }, input.viewport);
            try { service.captureView(sessionId, viewId); }
            catch (error) { await surfaces.closeSurface(info.surfaceId); throw error; }
            surfaceOwners.set(info.surfaceId, { ...view, objectId: info.objectId, assetId: info.assetId }); send(response, 201, info); return;
          }
          const owner = surfaceOwners.get(surfaceId ?? '');
          if (!owner || owner.projectId !== view.projectId || owner.sessionId !== sessionId || owner.documentId !== view.documentId || owner.viewId !== viewId || owner.viewGeneration !== view.viewGeneration) throw new ApiFailure(403, 'surface_frame_scope', 'Use an HTML surface belonging to this document and view.');
          if (surfaceMatch[4] === 'sample' && method === 'POST') { send(response, 200, frameMetadata(await surfaces.sample(surfaceId!))); return; }
          if (surfaceMatch[4] === 'input' && method === 'POST') { if (!input.input || typeof input.input !== 'object' || Array.isArray(input.input)) throw new ApiFailure(400, 'invalid_input', 'Send a typed HTML surface input.'); send(response, 200, await surfaces.input(surfaceId!, input.input)); return; }
          if(surfaceMatch[4]==='audio'&&method==='GET'){const audio=surfaces.audioSince(surfaceId!,Number(url.searchParams.get('afterSeq')??0));send(response,200,{...audio,packets:audio.packets.map(({pcm,...packet})=>({...packet,pcmBase64:pcm.toString('base64')}))});return;}
          if (surfaceMatch[4] === 'viewport' && method === 'PUT') { send(response, 200, await surfaces.resize(surfaceId!, input.viewport)); return; }
          if (surfaceMatch[5] && ['GET', 'HEAD'].includes(method ?? '')) {
            const frame = surfaces.frame(surfaceId!, Number(surfaceMatch[5])); surfaces.validateSurface(owner, frame);
            if (surfaceMatch[6]) { response.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': frame.png.length, 'Cache-Control': 'no-store' }); response.end(method === 'HEAD' ? undefined : frame.png); }
            else send(response, 200, frameMetadata(frame));
            return;
          }
          if (!surfaceMatch[4] && method === 'DELETE') { await surfaces.closeSurface(surfaceId!); surfaceOwners.delete(surfaceId!); send(response, 200, { closed: true }); return; }
        }
        if (path === '/api/board/operations' && method === 'POST') { const input = await payload(request); send(response, 200, service.boardOperations(input.sessionId, input.operations)); return; }
        const previewAssetMatch = path.match(/^\/api\/assets\/([^/]+)\/html-preview$/);
        if (previewAssetMatch && method === 'POST') {
          await payload(request);
          service.sharedAsset(decodeURIComponent(previewAssetMatch[1]));
          send(response, 201, preview.issue(decodeURIComponent(previewAssetMatch[1]), request.headers.origin ?? `http://${request.headers.host}`)); return;
        }
        const previewMatch = path.match(/^\/api\/html-previews\/([A-Za-z0-9_-]{43})$/);
        if (previewMatch && method === 'DELETE') { preview.revoke(previewMatch[1]); send(response, 200, { revoked: true }); return; }
        if (path === '/api/html-bundles' && method === 'POST') { send(response, 201, service.registerHtmlBundle(await payload(request))); return; }
        const captureMatch = path.match(/^\/api\/sessions\/([^/]+)\/drafts\/([^/]+)\/annotations\/([^/]+)\/captures\/(\d+)(\/(?:content|retry))?$/);
        if (captureMatch) {
          const sessionId = decodeURIComponent(captureMatch[1]), draftId = decodeURIComponent(captureMatch[2]), annotationId = decodeURIComponent(captureMatch[3]), version = Number(captureMatch[4]);
          if (!captureMatch[5] && method === 'POST') { send(response, 200, service.prepareCapture(sessionId, draftId, annotationId, version, await payload(request) as AnnotationCaptureInput)); return; }
          if (!captureMatch[5] && method === 'GET') { send(response, 200, service.captureResult(sessionId, draftId, annotationId, version)); return; }
          if (captureMatch[5] === '/retry' && method === 'POST') { await payload(request); send(response, 200, service.retryCapture(sessionId, draftId, annotationId, version)); return; }
          if (captureMatch[5] === '/content' && method === 'PUT') {
            const upload = service.captureUpload(sessionId, draftId, annotationId, version);
            if (upload.committed) { request.resume(); send(response, 200, service.captureResult(sessionId, draftId, annotationId, version)); return; }
            try { const result = service.captureResult(sessionId, draftId, annotationId, version); if (result.status === 'committed') { request.resume(); send(response, 200, result); return; } }
            catch (error) { if (!(error instanceof ApiFailure) || error.code !== 'capture_file_invalid') throw error; }
            const expected = upload.capture.image.bytes, declared = Number(request.headers['content-length']);
            if (expected > maxUploadBytes || Number.isFinite(declared) && declared !== expected) { request.resume(); throw new ApiFailure(413, 'capture_file_invalid', 'Upload the declared capture image bytes.'); }
            if (captureUploads.has(upload.capture.id)) { request.resume(); throw new ApiFailure(409, 'capture_upload_active', 'Query the active capture upload result.'); }
            captureUploads.add(upload.capture.id);
            const temporary = `${upload.temporary}.${randomUUID()}`;
            let file: Awaited<ReturnType<typeof open>> | undefined;
            try {
              if (!within(service.dataDir, await realpath(dirname(upload.destination))) || !within(service.dataDir, await realpath(dirname(temporary)))) throw new ApiFailure(403, 'path_boundary', 'Capture storage remains inside the project.');
              file = await open(temporary, 'wx', 0o600); let size = 0;
              for await (const chunk of request) {
                size += chunk.length;
                if (size > expected) throw new ApiFailure(413, 'capture_file_invalid', 'Upload the declared capture image bytes.');
                let position = 0;
                while (position < chunk.length) { const result = await file.write(chunk, position, chunk.length - position); position += result.bytesWritten; }
              }
              if (!request.complete || size !== expected) throw new ApiFailure(400, 'capture_file_invalid', 'Upload the complete capture image.');
              await file.sync(); await file.close(); file = undefined;
              // Check ownership after receiving bytes, then publish one complete file.
              service.captureUpload(sessionId, draftId, annotationId, version);
              await rename(temporary, upload.destination);
              send(response, 200, service.captureResult(sessionId, draftId, annotationId, version));
            } finally { await file?.close().catch(() => {}); await rm(temporary, { force: true }); captureUploads.delete(upload.capture.id); }
            return;
          }
        }
        if (path === '/api/assets' && method === 'POST') {
          const declaredLength = Number(request.headers['content-length']);
          if (Number.isFinite(declaredLength) && declaredLength > maxUploadBytes) { request.resume(); throw new ApiFailure(413, 'upload_too_large', `Files may contain up to ${maxUploadBytes} bytes.`); }
          const name = (url.searchParams.get('name') ?? 'attachment').slice(0, 500);
          const mime = resolveContentMime(name, url.searchParams.get('mime') ?? 'application/octet-stream');
          const id = randomUUID();
          const extension = extname(name).toLowerCase();
          const safeExtension = /^\.[a-z0-9]{1,12}$/.test(extension) ? extension : '';
          const sourceTaskId = url.searchParams.get('taskId');
          const source = sourceTaskId ? { taskId: sourceTaskId, sessionId: url.searchParams.get('sessionId') ?? '', runId: url.searchParams.get('runId') ?? '', consumerId: url.searchParams.get('consumerId') ?? '' } : undefined;
          if (source) {
            const task = service.task(source.sessionId, source.taskId);
            if (!task.runs.some((run) => run.id === source.runId && run.consumerId === source.consumerId)) throw new ApiFailure(409, 'run_conflict', 'Output imports require a matching task and execution attempt.');
          }
          const temporary = resolve(service.dataDir, 'tmp', `${id}.upload`);
          const destination = source ? resolve(service.dataDir, 'outputs', source.taskId, source.runId, `${id}${safeExtension}`) : resolve(service.dataDir, 'assets', `${id}${safeExtension}`);
          await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
          if (!within(service.dataDir, await realpath(dirname(destination))) || !within(service.dataDir, await realpath(dirname(temporary)))) throw new ApiFailure(403, 'path_boundary', 'Upload storage must remain inside this project.');
          let file = await open(temporary, 'wx', 0o600), size = 0, retained = false;
          try {
            for await (const chunk of request) {
              size += chunk.length;
              if (size > maxUploadBytes) throw new ApiFailure(413, 'upload_too_large', `Files may contain up to ${maxUploadBytes} bytes.`);
              await file.write(chunk);
            }
            if (!request.complete) throw new ApiFailure(400, 'upload_incomplete', 'The upload ended before its file was complete.');
            await file.sync(); await file.close();
            await rename(temporary, destination);
            retained = true;
            const asset: Asset = { id, name, mime, size, kind: storageAssetKind({ name, mime }), createdAt: new Date().toISOString() };
            send(response, 201, service.registerAsset(asset, relative(service.dataDir, destination), source));
          } finally {
            await file.close().catch(() => {});
            await rm(temporary, { force: true });
            // Complete files can remain as unreferenced assets when registration fails.
            if (!retained) await rm(destination, { force: true });
          }
          return;
        }
        const artworkMatch = path.match(/^\/api\/assets\/([^/]+)\/artwork$/);
        if (artworkMatch && (method === 'GET' || method === 'HEAD')) {
          const cover = await artwork.get(service.readableAsset(decodeURIComponent(artworkMatch[1]), url.searchParams.get('sessionId') ?? undefined));
          response.setHeader('Cache-Control', 'private, no-store');
          if (!cover) { response.writeHead(204); response.end(); return; }
          response.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
          response.writeHead(200, { 'Content-Type': cover.mime, 'Content-Length': cover.bytes.length });
          response.end(method === 'HEAD' ? undefined : cover.bytes); return;
        }
        const assetMatch = path.match(/^\/api\/assets\/([^/]+)\/content$/);
        if (assetMatch && method === 'PUT') {
          const assetId = decodeURIComponent(assetMatch[1]);
          let current: Asset;
          try { current = service.sharedAsset(assetId); }
          catch (error) { request.resume(); throw error; }
          if (current.htmlBundle || !editableTextMime(current.mime)) { request.resume(); throw new ApiFailure(400, 'content_readonly', 'Only notes and Markdown can be edited.'); }
          const declared = Number(request.headers['content-length']);
          if (Number.isFinite(declared) && declared > editableTextBytes) { request.resume(); throw new ApiFailure(413, 'content_too_large', 'Notes and Markdown stay within 2 MB.'); }
          const temporary = resolve(service.dataDir, 'tmp', `${randomUUID()}.text`);
          await mkdir(dirname(temporary), { recursive: true, mode: 0o700 });
          if (!within(service.dataDir, await realpath(dirname(temporary)))) throw new ApiFailure(403, 'path_boundary', 'Upload storage must remain inside this project.');
          let file: Awaited<ReturnType<typeof open>> | undefined = await open(temporary, 'wx', 0o600), size = 0, consumed = false;
          try {
            for await (const chunk of request) {
              size += chunk.length;
              if (size > editableTextBytes) throw new ApiFailure(413, 'content_too_large', 'Notes and Markdown stay within 2 MB.');
              await file.write(chunk);
            }
            if (!request.complete) throw new ApiFailure(400, 'upload_incomplete', 'The upload ended before its text was complete.');
            await file.sync(); await file.close(); file = undefined;
            const saved = service.replaceAssetContent(assetId, temporary);
            consumed = true;
            send(response, 200, saved);
          } finally { await file?.close().catch(() => {}); if (!consumed) await rm(temporary, { force: true }); }
          return;
        }
        if (assetMatch && (method === 'GET' || method === 'HEAD')) {
          const asset = service.readableAsset(decodeURIComponent(assetMatch[1]), url.searchParams.get('sessionId') ?? undefined);
          const file = service.assetPath(asset.id);
          const info = await stat(file);
          if (!info.isFile() || info.size !== asset.size) throw new ApiFailure(409, 'asset_integrity', 'The asset file differs from its saved metadata.');
          let start = 0, end = asset.size - 1, status = 200;
          if (request.headers.range) {
            const match = request.headers.range.match(/^bytes=(\d*)-(\d*)$/);
            if (!match || (!match[1] && !match[2]) || !asset.size) { response.setHeader('Content-Range', `bytes */${asset.size}`); throw new ApiFailure(416, 'range_invalid', 'Select one valid byte range.'); }
            if (!match[1]) start = Math.max(0, asset.size - Number(match[2]));
            else { start = Number(match[1]); if (match[2]) end = Math.min(end, Number(match[2])); }
            if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= asset.size) { response.setHeader('Content-Range', `bytes */${asset.size}`); throw new ApiFailure(416, 'range_invalid', 'The range is outside this file.'); }
            status = 206; response.setHeader('Content-Range', `bytes ${start}-${end}/${asset.size}`);
          }
          const normalizedMime = resolveContentMime(asset.name, asset.mime), kind = resolveContentKind(asset);
          const playableAudio = kind === 'audio' && ['audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/x-wav', 'audio/wave', 'audio/vnd.wave', 'audio/mp4', 'audio/x-m4a', 'audio/aac', 'audio/ogg', 'audio/flac', 'audio/x-flac', 'audio/webm'].includes(normalizedMime);
          const download = asset.kind === 'file' && !playableAudio || /\.html?$/i.test(asset.name) || /html|javascript|xml/.test(normalizedMime) && normalizedMime !== 'image/svg+xml';
          response.setHeader('Content-Type', download ? 'application/octet-stream' : normalizedMime);
          response.setHeader('Content-Disposition', `${download || url.searchParams.get('download') === '1' ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(asset.name).replace(/'/g, '%27')}`);
          if (asset.mime === 'image/svg+xml') response.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; style-src 'unsafe-inline'");
          response.setHeader('Cache-Control', 'private, no-store'); response.setHeader('Accept-Ranges', 'bytes');
          response.setHeader('Content-Length', status === 206 ? end - start + 1 : asset.size);
          response.writeHead(status);
          if (method === 'HEAD' || !asset.size) response.end();
          else { const stream = createReadStream(file, { start, end }); stream.on('error', () => response.destroy()); response.on('close', () => stream.destroy()); stream.pipe(response); }
          return;
        }
        const sessionMatch = path.match(/^\/api\/sessions\/([^/]+)\/(draft|view|tasks|claim|resume)$/);
        if (sessionMatch) {
          const sessionId = decodeURIComponent(sessionMatch[1]), action = sessionMatch[2];
          if (action === 'draft' && method === 'PUT') { send(response, 200, service.saveDraft(sessionId, await payload(request) as Draft)); return; }
          if (action === 'view' && method === 'PUT') { send(response, 200, service.saveView(sessionId, await payload(request) as SessionView)); return; }
          if (action === 'tasks' && method === 'POST') { const input = await payload(request); send(response, 200, service.sendDraft(sessionId, input.draftId, input.expectedRevision)); return; }
          if (action === 'tasks' && method === 'GET') { send(response, 200, service.tasks(sessionId)); return; }
          if (action === 'claim' && method === 'POST') { send(response, 200, service.claim(sessionId, (await payload(request)).consumerId)); return; }
          if (action === 'resume' && method === 'POST') { send(response, 200, service.resumeSession(sessionId, await payload(request))); return; }
        }
        const taskMatch = path.match(/^\/api\/sessions\/([^/]+)\/tasks\/([^/]+)(?:\/(context|progress|block|interrupt|resume|complete|reply|cancel|edit|cancel-edit))?$/);
        if (taskMatch) {
          const sessionId = decodeURIComponent(taskMatch[1]), taskId = decodeURIComponent(taskMatch[2]), action = taskMatch[3];
          if (!action && method === 'GET') { send(response, 200, service.task(sessionId, taskId)); return; }
          if (action === 'context' && method === 'GET') { send(response, 200, service.context(sessionId, taskId)); return; }
          if (method === 'POST') {
            const input = await payload(request);
            if (action === 'edit') { send(response, 200, service.beginTaskEdit(sessionId, taskId, input)); return; }
            if (action === 'cancel-edit') { send(response, 200, service.cancelTaskEdit(sessionId, taskId, input)); return; }
            if (action === 'progress') { send(response, 200, service.progress(sessionId, taskId, input)); return; }
            if (action === 'block' || action === 'interrupt') { send(response, 200, service.pause(sessionId, taskId, input, action === 'block' ? 'blocked' : 'interrupted')); return; }
            if (action === 'resume') { send(response, 200, service.resume(sessionId, taskId, input)); return; }
            if (action === 'complete') { send(response, 200, service.complete(sessionId, taskId, input as CompleteInput)); return; }
            if (action === 'reply') { send(response, 200, service.reply(sessionId, taskId, input)); return; }
            if (action === 'cancel') { send(response, 200, service.cancel(sessionId, taskId, input.reason)); return; }
          }
        }
        throw new ApiFailure(404, 'route_missing', 'This API route is unavailable.');
      }
      if (method !== 'GET' && method !== 'HEAD') throw new ApiFailure(405, 'method_rejected', 'Use the API for mutations.');
      if (!options.webRoot) throw new ApiFailure(404, 'web_unavailable', 'Build the application to open the whiteboard.');
      const webRoot = await realpath(options.webRoot);
      const decoded = decodeURIComponent(path);
      const candidate = resolve(webRoot, `.${decoded === '/' ? '/index.html' : decoded}`);
      if (!within(webRoot, candidate)) throw new ApiFailure(403, 'path_boundary', 'Open a file inside the application.');
      let actual: string;
      try { actual = await realpath(candidate); } catch { throw new ApiFailure(404, 'file_missing', 'The application file is unavailable.'); }
      if (!within(webRoot, actual) || !(await stat(actual)).isFile()) throw new ApiFailure(403, 'path_boundary', 'Open an application file.');
      if (extname(actual) === '.html') {
        const html = await readFile(actual, 'utf8');
        const metadata = `<meta name="acanvas-html-preview-origin" content="${preview.originFor(`http://${request.headers.host}`)}">`;
        const document = /<\/head>/i.test(html) ? html.replace(/<\/head>/i, `${metadata}</head>`) : `${metadata}${html}`;
        response.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-cache', 'Content-Length': Buffer.byteLength(document) });
        response.end(method === 'HEAD' ? undefined : document); return;
      }
      response.writeHead(200, { 'Content-Type': mimeTypes[extname(actual)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' });
      if (method === 'HEAD') response.end(); else createReadStream(actual).pipe(response);
    } catch (error) {
      if (response.headersSent || response.destroyed) { if (!response.destroyed) response.destroy(); return; }
      const failure = error instanceof ApiFailure ? error : new ApiFailure(500, 'server_error', 'The local service could not complete this request.');
      send(response, failure.status, { error: { code: failure.code, message: failure.message, ...(failure.details === undefined ? {} : { details: failure.details }) } });
    } finally { requests.delete(request); }
  };
  const server = createServer((request, response) => {
    const pending = handle(request, response); handlers.add(pending);
    void pending.then(() => handlers.delete(pending), () => handlers.delete(pending));
  });
  const connections = createBoardConnections(server, { instanceId: service.identity().instanceId, watch: watchPresence, guard(request) {
    if (closing) throw new ApiFailure(503, 'service_closing', 'Reconnect after the local service starts.');
    guardSource(request);
    if (!request.headers.origin || (request.headers.origin !== `http://${request.headers.host}` && !options.allowedOrigins?.includes(request.headers.origin))) throw new ApiFailure(403, 'origin_rejected', 'Use the same local browser origin.');
    const prefix = `${authenticationCookieName()}=`;
    const cookie = request.headers.cookie?.split(';').map(value => value.trim()).find(value => value.startsWith(prefix))?.slice(prefix.length);
    if (!sameToken(cookie, token)) throw new ApiFailure(401, 'authentication_required', 'Connect through this local service before using its API.');
  } });
  service.onChange = () => { for (const response of events) response.write('event: change\ndata: {}\n\n'); connections.changed(); };
  const heartbeat = setInterval(() => { for (const response of events) response.write(': alive\n\n'); for (const record of presences.values()) for (const response of record.connections) if ('write' in response) (response as ServerResponse).write(': alive\n\n'); }, 15_000); heartbeat.unref();
  await new Promise<void>((resolvePromise, reject) => { server.once('error', reject); server.listen(port, bind, () => { server.off('error', reject); port = (server.address() as AddressInfo).port; resolvePromise(); }); }).catch(async error => { clearInterval(heartbeat); connections.close(); await surfaces.close(); await preview.close(); service.close(); throw error; });
  let shutdown: Promise<void> | undefined;
  const runtime: ServiceRuntime = { project: service.project, ...service.identity(), url: `http://127.0.0.1:${port}`, ...(bind === '127.0.0.1' ? {} : { bind }), ...(extraHosts.length ? { allowedHosts: extraHosts, urls: allowedHosts().map(host => `http://${host}`) } : {}) };
  browser = new ProjectBrowser(service, runtime.url, token, options.browser);
  stopService = () => {
    if (shutdown) return shutdown;
    shutdown = (async () => {
      closing = true; clearInterval(heartbeat); connections.close();
      // Cancel captures while the business service can still invalidate versions.
      await browser.close();
      const stopped = new Promise<void>((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise()));
      const streams = new Set([...events, ...[...presences.values()].flatMap(record => [...record.connections].filter((connection): connection is ServerResponse => 'write' in connection))]);
      for (const record of presences.values()) clearTimeout(record.timer); presences.clear();
      for (const response of streams) response.end(); events.clear();
      // Incomplete uploads end through their normal cleanup before SQLite closes.
      for (const request of requests) request.destroy();
      for (const response of responses) if (!streams.has(response)) response.destroy();
      server.closeIdleConnections();
      const forceTransportClose = setTimeout(() => server.closeAllConnections(), 1000); forceTransportClose.unref();
      try { await Promise.allSettled([...handlers]); await stopped; }
      finally { clearTimeout(forceTransportClose); await surfaces.close(); surfaceOwners.clear(); await preview.close(); service.close(); await clearRuntime(runtime); }
    })();
    return shutdown;
  };
  try { await publishRuntime(runtime); }
  catch (error) { await stopService(); throw error; }
  return { service, browser, url: runtime.url, urls: runtime.urls ?? [], close: stopService };
}
