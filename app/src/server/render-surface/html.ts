import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { ApiFailure, type CanvasService } from '../service.js';
import type { HtmlPreviewGrant, HtmlPreviewRuntime } from '../html-preview.js';
import { launchRenderEngine } from './engine.js';
import { NativeHtmlRuntime, type HtmlAudioPacket } from './cef.js';
import { NativeSurfaceInput } from './native-input.js';
import { runtimeDirectory } from '../runtime.js';
import { join } from 'node:path';
import { readHtmlSemantics,type HtmlSemanticSnapshot } from './semantics.js';
import { NativeSurfaceControls,type NativeControlInput } from './native-controls.js';
import {NativeSurfaceClipboard,validateHtmlClipboard} from './clipboard.js';
import type {HtmlClipboardAction,HtmlInputResult,HtmlSurfacePopup} from '../../shared/html-surface.js';

export interface SurfaceOwner { projectId: string; sessionId: string; documentId: string; viewId: string; viewGeneration: number; objectId: string;assetId:string }
export interface SurfaceViewport { width: number; height: number }
export interface SurfaceReference { surfaceId: string; instanceId: string; frameSeq: number; inputSeq: number; viewport: SurfaceViewport }
export interface HtmlSurfaceInfo extends SurfaceOwner { surfaceId: string; instanceId: string; assetId: string; viewport: SurfaceViewport; deviceScaleFactor: number;engine:'chromium'|'cef' }
export interface HtmlSurfaceFrame extends SurfaceReference { owner: SurfaceOwner; bitmap: SurfaceViewport; capturedAt: string; semantics:HtmlSemanticSnapshot;popup?:HtmlSurfacePopup; png: Buffer }
type InputEvent = { type: 'pointer'; action: 'move' | 'down' | 'up' | 'click'; x: number; y: number; button?: 'left' | 'middle' | 'right' }
  | { type: 'wheel'; x: number; y: number; deltaX: number; deltaY: number }
  | { type: 'key'; action: 'down' | 'up' | 'press'; key: string;emitText?:boolean;character?:string }
  | { type: 'text'; text: string } | NativeControlInput | HtmlClipboardAction;
export type HtmlSurfaceInput = InputEvent & { instanceId: string; inputSeq: number; viewport: SurfaceViewport;frameSeq?:number };
interface SurfaceEntry {
  info: HtmlSurfaceInfo; grant: HtmlPreviewGrant;releaseGrant:()=>void; context?: BrowserContext; page?: Page; native?:NativeHtmlRuntime; nativeInput?:NativeSurfaceInput;nativeControls?:NativeSurfaceControls;nativeClipboard?:NativeSurfaceClipboard;
  frameSeq: number; inputSeq: number; frames: Map<number, HtmlSurfaceFrame>; bytes: number;
  pins: Map<number, Set<string>>;
  pending: Promise<unknown>; closed: boolean;
  termination?:'closed'|'renderer';
}
interface SurfaceCreation { owner: Omit<SurfaceOwner,'projectId'>; cancelled: boolean; pending?: Promise<HtmlSurfaceInfo>; entry?: SurfaceEntry }
export interface HtmlSurfacesOptions { engine?:'chromium'|'cef'; engineDirectory?: string; maxSurfaces?: number; maxSurfacesPerView?: number; maxRetainedSurfaces?: number; maxFrames?: number; maxFrameBytes?: number; maxRetainedBytes?: number }

function fail(status: number, code: string, message: string): never { throw new ApiFailure(status, code, message); }
const sameViewport = (a: SurfaceViewport, b: SurfaceViewport) => a?.width === b.width && a?.height === b.height;
function viewport(value: SurfaceViewport): SurfaceViewport {
  if (!value || !Number.isInteger(value.width) || !Number.isInteger(value.height) || value.width < 1 || value.height < 1 || value.width > 4096 || value.height > 4096 || value.width * value.height > 8_000_000) fail(400, 'surface_viewport', 'Use an HTML surface within the supported pixel dimensions.');
  return { width: value.width, height: value.height };
}
function copyFrame(frame: HtmlSurfaceFrame): HtmlSurfaceFrame { return { ...frame, owner: { ...frame.owner }, viewport: { ...frame.viewport }, bitmap: { ...frame.bitmap },semantics:structuredClone(frame.semantics),...(frame.popup?{popup:structuredClone(frame.popup)}:{}), png: Buffer.from(frame.png) }; }

/** Internal browser handles remain private; clients exchange pixels and typed input. */
export class ProjectHtmlSurfaces {
  private browser?: Browser;
  private wrapper?: Server;
  private origin = '';
  private starting?: Promise<void>;
  private entries = new Map<string, SurfaceEntry>();
  private creating = new Set<SurfaceCreation>();
  private stopped = false;
  private retainedBytes = 0;

  constructor(private service: CanvasService, private preview: HtmlPreviewRuntime, private options: HtmlSurfacesOptions = {}) {this.options={...options,engine:options.engine??'cef'};}

  private async start(): Promise<void> {
    if (this.stopped) fail(503, 'surface_stopped', 'Connect to the running project renderer.');
    if (this.browser || this.options.engine==='cef' && this.wrapper) return;
    if (this.starting) return this.starting;
    this.starting = (async () => {
      const browser = this.options.engine==='cef'?undefined:await launchRenderEngine(this.options.engineDirectory);
      if (this.wrapper) await new Promise<void>((resolve, reject) => { this.wrapper!.close(error => error ? reject(error) : resolve()); this.wrapper!.closeAllConnections(); });
      const wrapper = createServer((request, response) => {
        response.setHeader('Cache-Control', 'no-store'); response.setHeader('X-Content-Type-Options', 'nosniff'); response.setHeader('Referrer-Policy', 'no-referrer');
        const id = new URL(request.url ?? '/', 'http://localhost').pathname.slice(1), entry = this.entries.get(id);
        if (request.method !== 'GET' || request.headers.host !== new URL(this.origin).host || !entry || entry.closed) { response.writeHead(404); response.end(); return; }
        response.setHeader('Content-Security-Policy', `default-src 'none'; style-src 'unsafe-inline'; frame-src ${entry.grant.origin}; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`);
        response.setHeader('Content-Type', 'text/html; charset=utf-8');
        response.end(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0;width:100%;height:100%;overflow:hidden}iframe{display:block;border:0;width:100%;height:100%}</style><iframe src="${entry.grant.url}" sandbox="allow-scripts" referrerpolicy="no-referrer" allow=""></iframe>`);
      });
      try {
        await new Promise<void>((resolve, reject) => { wrapper.once('error', reject); wrapper.listen(0, '127.0.0.1', () => { wrapper.off('error', reject); resolve(); }); });
        this.origin = `http://127.0.0.1:${(wrapper.address() as AddressInfo).port}`;
        this.browser = browser; this.wrapper = wrapper;
        browser?.on('disconnected', () => {
          if (this.browser === browser) this.browser = undefined;
          for (const entry of this.entries.values()) { entry.closed = true; this.preview.revoke(entry.grant.id); }
        });
      } catch (error) { await browser?.close(); throw error; }
    })();
    try { await this.starting; } finally { this.starting = undefined; }
  }

  create(owner: Omit<SurfaceOwner, 'projectId'> & { assetId: string }, size: SurfaceViewport & { deviceScaleFactor?: number }): Promise<HtmlSurfaceInfo> {
    owner={...owner};const creation:SurfaceCreation={owner,cancelled:false};this.creating.add(creation);
    const pending = (async () => {
      this.service.session(owner.sessionId);
      if (typeof owner.viewId !== 'string' || !owner.viewId || owner.viewId.length > 200) fail(400, 'surface_view', 'Open an HTML surface in the current view.');
      if (typeof owner.documentId !== 'string' || !owner.documentId || owner.documentId.length > 200 || !Number.isSafeInteger(owner.viewGeneration) || owner.viewGeneration < 1) fail(400, 'surface_document', 'Open an HTML surface in the current document generation.');
      const object = this.service.state(owner.sessionId).objects.find(object => object.id === owner.objectId);
      if (!object || object.assetId !== owner.assetId) fail(404, 'surface_object', 'Open the HTML asset belonging to this object.');
      const dimensions = viewport(size), deviceScaleFactor = size.deviceScaleFactor ?? 1;
      if (![1, 2].includes(deviceScaleFactor) || dimensions.width * dimensions.height * deviceScaleFactor ** 2 > 8_000_000) fail(400, 'surface_scale', 'Use a supported HTML surface pixel scale.');
      await this.start();
      if(this.stopped)fail(503,'surface_stopped','Connect to the running project renderer.');
      if(creation.cancelled)fail(410,'surface_closed','Reconnect the HTML surface in this view.');
      this.service.session(owner.sessionId);
      if(!this.service.state(owner.sessionId).objects.some(object=>object.id===owner.objectId&&object.assetId===owner.assetId))fail(404,'surface_object','Open the HTML asset belonging to this object.');
      const live = [...this.entries.values()].filter(entry => !entry.closed);
      if (live.length >= (this.options.maxSurfaces ?? 16)) fail(429, 'surface_limit', 'Close an HTML surface before opening another.');
      const inView = live.filter(entry => entry.info.sessionId === owner.sessionId && entry.info.documentId === owner.documentId && entry.info.viewId === owner.viewId && entry.info.viewGeneration === owner.viewGeneration);
      if (inView.length >= (this.options.maxSurfacesPerView ?? 4)) fail(429, 'surface_view_limit', 'Close an HTML surface in this view before opening another.');
      while (this.entries.size >= (this.options.maxRetainedSurfaces ?? 32)) {
        const candidate = [...this.entries.values()].find(entry => entry.closed && !entry.pins.size);
        if (!candidate) fail(429, 'surface_retained_limit', 'Finish preparing evidence before opening another HTML surface.');
        this.retainedBytes -= candidate.bytes; this.entries.delete(candidate.info.surfaceId);
      }
      const grant = this.preview.issue(owner.assetId, this.origin,'surface'),releaseGrant=this.preview.hold(grant.id);
      const info: HtmlSurfaceInfo = { ...owner, projectId: this.service.project.id, surfaceId: randomUUID(), instanceId: randomUUID(), viewport: dimensions, deviceScaleFactor,engine:this.options.engine??'cef' };
      const entry: SurfaceEntry = { info, grant,releaseGrant, frameSeq: 0, inputSeq: 0, frames: new Map(), pins: new Map(), bytes: 0, pending: Promise.resolve(), closed: false };
      this.entries.set(info.surfaceId, entry);creation.entry=entry;
      try {
        if(this.options.engine==='cef'){
          const directory=join(await runtimeDirectory(this.service.project.root),'html-surfaces');
          if(entry.closed||creation.cancelled||this.stopped)fail(410,'surface_closed','Reconnect the HTML surface in this view.');
          entry.native=new NativeHtmlRuntime();entry.nativeInput=new NativeSurfaceInput(entry.native);
          entry.native.on('closed',()=>{if(!entry.closed)entry.termination='renderer';entry.closed=true;entry.releaseGrant();this.preview.revoke(entry.grant.id);void entry.native?.close()});
          await entry.native.open(`${this.origin}/${info.surfaceId}`,directory,{...dimensions,deviceScaleFactor});
          if (entry.closed) { if (entry.termination === 'renderer') fail(503, 'surface_renderer_exit', 'The HTML renderer is reconnecting.'); fail(410, 'surface_closed', 'Reconnect the HTML surface in this view.'); }
          entry.nativeControls=new NativeSurfaceControls(entry.native,{directory:join(entry.native.directory(),'selected-files')});
          entry.nativeClipboard=new NativeSurfaceClipboard(entry.native,this.origin);
        }else{
          entry.context=await this.browser!.newContext({viewport:dimensions,deviceScaleFactor,acceptDownloads:false,permissions:[]});
          if(entry.closed||creation.cancelled||this.stopped){await entry.context.close();fail(410,'surface_closed','Reconnect the HTML surface in this view.');}
          entry.page=await entry.context.newPage();
          entry.page.on('crash',()=>{entry.closed=true;this.preview.revoke(entry.grant.id)});entry.page.on('close',()=>{entry.closed=true;this.preview.revoke(entry.grant.id)});entry.page.on('dialog',dialog=>{void dialog.dismiss()});
          await entry.page.goto(`${this.origin}/${info.surfaceId}`,{waitUntil:'load',timeout:15_000});
          const frame=entry.page.frames().find(frame=>frame.url()===grant.url);if(!frame)fail(503,'surface_document','The HTML instance did not become ready.');
        }
        if(entry.closed||creation.cancelled||this.stopped)fail(410,'surface_closed','Reconnect the HTML surface in this view.');
        return this.info(entry);
      } catch (error) { const closed = entry.closed && entry.termination === 'closed'; await this.closeEntry(entry); if (closed) fail(410, 'surface_closed', 'Reconnect the HTML surface in this view.'); throw error; }
    })().finally(()=>this.creating.delete(creation));
    creation.pending = pending; return pending;
  }

  private info(entry: SurfaceEntry): HtmlSurfaceInfo { return { ...entry.info, viewport: { ...entry.info.viewport } }; }
  private entry(id: string, requireLive = true): SurfaceEntry {
    const entry = this.entries.get(id);
    if(requireLive&&entry?.closed&&entry.termination==='renderer')fail(503,'surface_renderer_exit','The HTML renderer is reconnecting.');
    if (!entry || (requireLive && entry.closed)) fail(404, 'surface_missing', 'Reconnect the HTML surface in this view.');
    return entry!;
  }
  private serial<T>(entry: SurfaceEntry, action: () => Promise<T>): Promise<T> {
    const pending = entry.pending.catch(() => undefined).then(() => { if (entry.closed || this.stopped) fail(410, 'surface_closed', 'Reconnect the HTML surface in this view.'); return action(); });
    entry.pending = pending; return pending;
  }

  sample(id: string): Promise<HtmlSurfaceFrame> {
    const entry = this.entry(id);
    return this.serial(entry, async () => {
      const paired=entry.native?await entry.native.samplePair(readHtmlSemantics):undefined;
      const png = paired?paired.png:await entry.page!.screenshot({ type: 'png', animations: 'allow', caret: 'initial', scale: 'device', timeout: 8000 });
      if (png.length > (this.options.maxFrameBytes ?? 10 * 1024 * 1024)) fail(413, 'surface_frame_size', 'The HTML surface frame exceeds the supported byte size.');
      const bitmap = { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
      if (bitmap.width !== entry.info.viewport.width * entry.info.deviceScaleFactor || bitmap.height !== entry.info.viewport.height * entry.info.deviceScaleFactor) fail(409, 'surface_frame_dimensions', 'The HTML surface dimensions changed during sampling.');
      const { projectId, sessionId, documentId, viewId, viewGeneration, objectId,assetId } = entry.info;
      const semantics=paired?.semantics??await this.readSemantics(entry);
      const frame: HtmlSurfaceFrame = { owner: { projectId, sessionId, documentId, viewId, viewGeneration, objectId,assetId }, surfaceId: id, instanceId: entry.info.instanceId, frameSeq: ++entry.frameSeq, inputSeq: entry.inputSeq, viewport: { ...entry.info.viewport }, bitmap, capturedAt: new Date().toISOString(),semantics,...(paired?.popup?{popup:paired.popup}:{}), png: Buffer.from(png) };
      entry.frames.set(frame.frameSeq, frame); entry.bytes += png.length; this.retainedBytes += png.length;
      while ([...entry.frames.keys()].filter(seq => !entry.pins.has(seq)).length > (this.options.maxFrames ?? 16)) this.removeOldest(entry);
      while (this.retainedBytes > (this.options.maxRetainedBytes ?? 32 * 1024 * 1024)) {
        const candidate = [...this.entries.values()].find(candidate => [...candidate.frames.keys()].some(seq => !candidate.pins.has(seq) && (candidate.closed || seq !== candidate.frameSeq)));
        if (!candidate) { entry.frames.delete(frame.frameSeq); entry.bytes -= png.length; this.retainedBytes -= png.length; fail(507, 'surface_frame_budget', 'The project renderer has reached its frame memory budget.'); }
        this.removeOldest(candidate!);
      }
      return copyFrame(frame);
    }).catch(error=>{if(entry.termination==='renderer')fail(503,'surface_renderer_exit','The HTML renderer is reconnecting.');throw error;});
  }
  private removeOldest(entry: SurfaceEntry): void {
    const oldest = [...entry.frames.keys()].find(seq => !entry.pins.has(seq));
    if (oldest === undefined) return;
    const frame = entry.frames.get(oldest)!; entry.frames.delete(oldest); entry.bytes -= frame.png.length; this.retainedBytes -= frame.png.length;
  }
  frame(id: string, frameSeq: number): HtmlSurfaceFrame {
    const frame = this.entry(id, false).frames.get(frameSeq);
    if (!frame) fail(404, 'surface_frame_missing', 'Keep the displayed HTML pixels when preparing evidence.');
    return copyFrame(frame!);
  }
  validateSurface(owner: SurfaceOwner, reference: SurfaceReference): void {
    const frame = this.entry(reference.surfaceId, false).frames.get(reference.frameSeq);
    if (!frame || frame.instanceId !== reference.instanceId || frame.inputSeq !== reference.inputSeq || !sameViewport(reference.viewport, frame.viewport) || Object.entries(owner).some(([key, value]) => frame.owner[key as keyof SurfaceOwner] !== value)) fail(409, 'surface_frame_scope', 'Use the HTML frame delivered to this object and view.');
  }
  private pinKey(owner: SurfaceOwner): string { return JSON.stringify([owner.projectId, owner.sessionId, owner.documentId, owner.viewId, owner.viewGeneration, owner.objectId,owner.assetId]); }
  retainSurface(owner: SurfaceOwner, reference: SurfaceReference): void {
    this.validateSurface(owner, reference);
    const entry = this.entry(reference.surfaceId, false), pins = entry.pins.get(reference.frameSeq) ?? new Set<string>();
    pins.add(this.pinKey(owner)); entry.pins.set(reference.frameSeq, pins);
  }
  releaseSurface(owner: SurfaceOwner, reference: SurfaceReference): void {
    const entry = this.entries.get(reference.surfaceId), pins = entry?.pins.get(reference.frameSeq);
    if (!entry || !pins) return;
    pins.delete(this.pinKey(owner)); if (!pins.size) entry.pins.delete(reference.frameSeq);
    while ([...entry.frames.keys()].filter(seq => !entry.pins.has(seq)).length > (this.options.maxFrames ?? 16)) this.removeOldest(entry);
  }

  input(id: string, input: HtmlSurfaceInput): Promise<HtmlInputResult> {
    const entry = this.entry(id);
    return this.serial(entry, async () => {
      if (input.instanceId !== entry.info.instanceId || !sameViewport(input.viewport, entry.info.viewport) || input.inputSeq !== entry.inputSeq + 1) fail(409, 'surface_input_state', 'Send the next input for the displayed HTML instance and viewport.');
      if(input.type==='clipboard'){
        const presented=input.frameSeq&&entry.frames.get(input.frameSeq);if(!presented||!sameViewport(presented.viewport,input.viewport))fail(409,'surface_input_frame','Use the displayed HTML frame.');
        if(!entry.nativeClipboard||!['copy','cut','paste'].includes(input.action))fail(400,'surface_clipboard_action','Use a supported native clipboard action.');
        if(input.action==='paste')validateHtmlClipboard(input.data!);entry.inputSeq=input.inputSeq;
        try{const clipboard=await entry.nativeClipboard.apply(input);return{inputSeq:entry.inputSeq,...(clipboard?{clipboard}:{})};}
        catch{return{inputSeq:entry.inputSeq,clipboardError:'Clipboard is unavailable. Try this action again.'};}
      }
      if('controlId' in input||input.type==='composition'){
        const presented=input.frameSeq&&entry.frames.get(input.frameSeq);if(!presented||!sameViewport(presented.viewport,input.viewport))fail(409,'surface_input_frame','Use controls from the displayed HTML frame.');
        if('controlId' in input&&!presented.semantics.controls.some(control=>control.id===input.controlId))fail(409,'surface_input_control','Use a control from the displayed HTML frame.');
        if(!entry.nativeControls)fail(409,'surface_control_engine','Use the project native HTML runtime for controls.');
        if(input.type==='focus')await entry.native!.protocol('Surface.focus');
        await entry.nativeControls.apply(input);entry.inputSeq=input.inputSeq;return{inputSeq:entry.inputSeq};
      }
      if (input.type === 'pointer' && (!['move', 'down', 'up', 'click'].includes(input.action) || (input.button && !['left', 'middle', 'right'].includes(input.button)))) fail(400, 'surface_input_action', 'Use a supported pointer action and button.');
      if (input.type === 'wheel' && (!Number.isFinite(input.deltaX) || !Number.isFinite(input.deltaY) || Math.abs(input.deltaX) > 4096 || Math.abs(input.deltaY) > 4096)) fail(400, 'surface_input_wheel', 'Use a bounded wheel input.');
      if (input.type === 'key' && (typeof input.key !== 'string' || !input.key || input.key.length > 100 || !['down', 'up', 'press'].includes(input.action)||input.character!==undefined&&(typeof input.character!=='string'||input.character.length!==1)||input.emitText!==undefined&&typeof input.emitText!=='boolean')) fail(400, 'surface_input_key', 'Use a supported keyboard input.');
      if (input.type === 'text' && (typeof input.text !== 'string' || input.text.length > 65_536)) fail(400, 'surface_input_text', 'Use a supported text input.');
      if (input.type === 'pointer' || input.type === 'wheel') {
        if (!Number.isFinite(input.x) || !Number.isFinite(input.y) || input.x < 0 || input.y < 0 || input.x >= entry.info.viewport.width || input.y >= entry.info.viewport.height) fail(400, 'surface_input_point', 'Send a point within the HTML surface.');
        if(entry.page)await entry.page.mouse.move(input.x, input.y);
      }
      if (input.type === 'pointer') {
        if(entry.nativeInput)await entry.nativeInput.pointer(input.action,input.x,input.y,input.button);
        else if (input.action === 'click') await entry.page!.mouse.click(input.x, input.y, { button: input.button });
        else if (input.action === 'down') await entry.page!.mouse.down({ button: input.button });
        else if (input.action === 'up') await entry.page!.mouse.up({ button: input.button });
      } else if (input.type === 'wheel') {
        if(entry.nativeInput)await entry.nativeInput.wheel(input.x,input.y,input.deltaX,input.deltaY);else await entry.page!.mouse.wheel(input.deltaX, input.deltaY);
      } else if (input.type === 'key') {
        if(entry.nativeInput)await entry.nativeInput.key(input.action,input.key,input.emitText,input.character);else await entry.page!.keyboard[input.action](input.key);
      } else if (input.type === 'text') {
        if(entry.nativeInput)await entry.nativeInput.text(input.text);else await entry.page!.keyboard.insertText(input.text);
      } else fail(400, 'surface_input_type', 'Use a supported HTML input.');
      entry.inputSeq = input.inputSeq; return { inputSeq: entry.inputSeq };
    });
  }

  resize(id: string, dimensions: SurfaceViewport): Promise<HtmlSurfaceInfo> {
    const entry = this.entry(id), size = viewport(dimensions);
    return this.serial(entry, async () => { if (size.width * size.height * entry.info.deviceScaleFactor ** 2 > 8_000_000) fail(400, 'surface_scale', 'Use a supported HTML surface pixel scale.'); if(entry.native)await entry.native.protocol('Surface.resize',size);else await entry.page!.setViewportSize(size); entry.info.viewport = size; return this.info(entry); });
  }
  audioSince(id:string,afterSeq:number):{owner:SurfaceOwner;surfaceId:string;instanceId:string;clock:'engine-monotonic-ms';packets:HtmlAudioPacket[]}{const entry=this.entry(id);if(!Number.isSafeInteger(afterSeq)||afterSeq<0)fail(400,'surface_audio_sequence','Read audio after a supported sequence.');if(!entry.native)fail(409,'surface_audio_unavailable','Use the project native HTML audio surface.');const {projectId,sessionId,documentId,viewId,viewGeneration,objectId,assetId}=entry.info;return{owner:{projectId,sessionId,documentId,viewId,viewGeneration,objectId,assetId},surfaceId:id,instanceId:entry.info.instanceId,clock:'engine-monotonic-ms',packets:entry.native.audioSince(afterSeq)}}
  private readSemantics(entry:SurfaceEntry):Promise<HtmlSemanticSnapshot>{return entry.native?entry.native.documentEvaluate(`(${readHtmlSemantics.toString()})()`):entry.page!.frames().find(frame=>frame.url()===entry.grant.url)!.evaluate(readHtmlSemantics)}
  semantics(id:string):Promise<HtmlSemanticSnapshot>{const entry=this.entry(id);return this.serial(entry,()=>this.readSemantics(entry))}
  async closeSurface(id: string): Promise<void> {
    const entry = this.entries.get(id); if (!entry) return;
    await this.closeEntry(entry);
  }
  private async closeEntry(entry:SurfaceEntry):Promise<void>{
    entry.closed = true;entry.termination??='closed';entry.releaseGrant();this.preview.revoke(entry.grant.id);
    if(entry.native){await entry.pending.catch(()=>undefined);await entry.nativeControls?.close();await entry.native.close();}
    else{await entry.context?.close().catch(()=>{});await entry.pending.catch(()=>undefined);}
  }
  async closeView(viewId: string): Promise<void> { const entries=new Set([...this.entries.values()].filter(entry=>entry.info.viewId===viewId));for(const creation of this.creating)if(creation.owner.viewId===viewId){creation.cancelled=true;if(creation.entry)entries.add(creation.entry)}await Promise.all([...entries].map(entry=>this.closeEntry(entry))); }
  async close(): Promise<void> {
    this.stopped = true;for(const creation of this.creating)creation.cancelled=true;await this.starting?.catch(() => undefined);
    const entries=new Set(this.entries.values());for(const creation of this.creating)if(creation.entry)entries.add(creation.entry);
    await Promise.all([...entries].map(entry=>this.closeEntry(entry)));await Promise.allSettled([...this.creating].map(creation=>creation.pending!));await this.browser?.close();
    if (this.wrapper) await new Promise<void>((resolve, reject) => { this.wrapper!.close(error => error ? reject(error) : resolve()); this.wrapper!.closeAllConnections(); });
    this.entries.clear(); this.retainedBytes = 0; this.browser = undefined; this.wrapper = undefined;
  }
}
