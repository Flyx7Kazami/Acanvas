import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createInterface } from 'node:readline';
import { access, mkdir, mkdtemp, rm,readFile,writeFile,readdir,lstat,realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import type { SurfaceViewport } from './html.js';
import type {HtmlSemanticSnapshot,HtmlSurfacePopup} from '../../shared/html-surface.js';

const require = createRequire(import.meta.url);
const applicationDirectory = join(dirname(require.resolve('playwright-core/package.json')), '..', '..');
export const nativeSurfaceExecutable = join(applicationDirectory, '.runtime', 'cef-build', 'Release', 'acanvas-surface.app', 'Contents', 'MacOS', 'acanvas-surface');
const execute=promisify(execFile);
interface NativeProfileRecord {controllerPid:number;browserPid?:number;executable:string}
const alive=(pid:number)=>{try{process.kill(pid,0);return true}catch(error){return(error as NodeJS.ErrnoException).code!=='ESRCH'}};
/** Only records written by this runtime identify disposable, inactive profiles. */
export async function cleanNativeProfiles(directory:string):Promise<void>{
  directory=await realpath(directory).catch((error:NodeJS.ErrnoException)=>{if(error.code==='ENOENT')return '';throw error});if(!directory)return;
  const items=await readdir(directory,{withFileTypes:true}).catch((error:NodeJS.ErrnoException)=>{if(error.code==='ENOENT')return[];throw error});
  for(const item of items){
    if(!item.isDirectory()||!/^instance-[A-Za-z0-9]+$/.test(item.name))continue;
    const path=join(directory,item.name),recordPath=join(path,'acanvas-instance.json');
    if((await lstat(path)).isSymbolicLink()||await realpath(path)!==path)continue;
    let record:NativeProfileRecord;try{record=JSON.parse(await readFile(recordPath,'utf8'))}catch{continue}
    if(!Number.isSafeInteger(record.controllerPid)||record.controllerPid<1||typeof record.executable!=='string'||!record.executable.startsWith(join(applicationDirectory,'.runtime','cef-'))||!record.executable.endsWith('/acanvas-surface.app/Contents/MacOS/acanvas-surface'))continue;
    if(alive(record.controllerPid))continue;
    if(record.browserPid){if(!Number.isSafeInteger(record.browserPid)||record.browserPid<1)continue;if(alive(record.browserPid))continue;}
    await rm(path,{recursive:true,force:true});
  }
}
export interface HtmlAudioPacket { audioSeq: number; channels: number; sampleRate: number; frames: number; pts: number; pcm: Buffer }
export interface NativeSurfaceFrame { png: Buffer; width: number; height: number; nativeFrameSeq: number }
export interface NativePairedFrame {png:Buffer;semantics:HtmlSemanticSnapshot;popup?:HtmlSurfacePopup;timing:{prepareMs:number;pauseMs:number;semanticMs:number;copyMs:number;totalMs:number}}
interface Pending { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }

/** Private native process pipes carry browser protocol and per-instance PCM. */
export class NativeHtmlRuntime extends EventEmitter {
  private executable:string;
  private helperPrefix:string;
  constructor(private testClipboardTripwire:boolean|'fake'=false){super();this.executable=testClipboardTripwire?join(applicationDirectory,'.runtime',testClipboardTripwire==='fake'?'cef-fake-pasteboard-build':'cef-tripwire-build','Release','acanvas-surface.app','Contents','MacOS','acanvas-surface'):nativeSurfaceExecutable;this.helperPrefix=join(dirname(this.executable),'..','Frameworks','acanvas-surface Helper');}
  private process?: ChildProcessWithoutNullStreams;
  private pending = new Map<number, Pending>();
  private id = 0;
  private audioSeq = 0;
  private audio = new Map<number, HtmlAudioPacket>();
  private closing = false;
  private closeTask?: Promise<void>;
  private cacheDirectory?: string;
  private ready = false;
  private loaded = false;
  private painted=false;
  private diagnostics = '';
  private ownedWorkers=new Set<number>();
  private documentContexts=new Map<string,{id:number;sessionId?:string}>();
  private documentLoaded=false;
  private documentSession?:string;
  private samplingTarget?:{contextId:number;sessionId?:string};
  private terminate(error:Error){if(this.closing)return;for(const pending of this.pending.values()){clearTimeout(pending.timer);pending.reject(error)}this.pending.clear();this.samplingTarget=undefined;this.emit('closed',error);void this.close();}

  private async recordWorkers(parent:number):Promise<void>{
    const children=(await execute('/usr/bin/pgrep',['-P',String(parent)]).catch(()=>({stdout:''}))).stdout.trim().split(/\s+/).filter(Boolean).map(Number);
    for(const pid of children){const command=(await execute('/bin/ps',['-p',String(pid),'-o','command=']).catch(()=>({stdout:''}))).stdout.trim();if(!command.startsWith(this.helperPrefix))continue;this.ownedWorkers.add(pid);await this.recordWorkers(pid)}
  }
  private async reapWorkers():Promise<void>{
    for(const pid of this.ownedWorkers){const command=(await execute('/bin/ps',['-p',String(pid),'-o','command=']).catch(()=>({stdout:''}))).stdout.trim();if(!command.startsWith(this.helperPrefix))continue;try{process.kill(pid,'SIGTERM')}catch{}}
    const deadline=Date.now()+1000;while(Date.now()<deadline){let live=false;for(const pid of this.ownedWorkers){try{process.kill(pid,0);live=true}catch{}}if(!live)break;await new Promise(resolve=>setTimeout(resolve,20));}
    for(const pid of this.ownedWorkers){const command=(await execute('/bin/ps',['-p',String(pid),'-o','command=']).catch(()=>({stdout:''}))).stdout.trim();if(command.startsWith(this.helperPrefix)){try{process.kill(pid,'SIGKILL')}catch{}}}this.ownedWorkers.clear();
  }

  async open(url: string, cacheDirectory: string, dimensions: SurfaceViewport & { deviceScaleFactor?:number }): Promise<void> {
    if (this.process) throw new Error('native_surface_opened');
    if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('native_surface_platform');
    await access(this.executable).catch(() => { throw new Error('native_surface_missing:Run npm run install:html-runtime.'); });
    await mkdir(cacheDirectory, { recursive: true, mode: 0o700 });
    cacheDirectory=await realpath(cacheDirectory);
    await cleanNativeProfiles(cacheDirectory);
    this.cacheDirectory = await mkdtemp(join(cacheDirectory, 'instance-'));
    const record:NativeProfileRecord={controllerPid:process.pid,executable:this.executable};await writeFile(join(this.cacheDirectory,'acanvas-instance.json'),JSON.stringify(record),{mode:0o600,flag:'wx'});
    const argv=[`--surface-url=${url}`, `--surface-cache=${this.cacheDirectory}`, `--surface-log=${join(this.cacheDirectory, 'engine.log')}`, `--surface-width=${dimensions.width}`, `--surface-height=${dimensions.height}`,`--surface-scale=${dimensions.deviceScaleFactor??1}`];
    const child = spawn(this.executable,argv, { stdio: ['pipe', 'pipe', 'pipe'] });
    this.process = child;
    if(child.pid){record.browserPid=child.pid;await writeFile(join(this.cacheDirectory,'acanvas-instance.json'),JSON.stringify(record),{mode:0o600});}
    const lines = createInterface({ input: child.stdout });
    lines.on('line', line => {
      try {
        const event = JSON.parse(line);
        if (!['paint','audio','cdp'].includes(event.type)) this.diagnostics=(this.diagnostics+line+'\n').slice(-8192);
        if (event.type === 'ready') { this.ready = true; this.emit('ready', event); }
        if (event.type === 'load') { this.loaded = true; this.emit('load', event); }
        if(event.type==='document-load'){this.documentLoaded=true;this.emit('document-load',event);}
        if (event.type === 'paint') {this.painted=true;this.emit('paint', event);}
        if(event.type==='renderer-terminated')this.terminate(new Error('native_renderer_terminated'));
        if (event.type === 'cdp') {
          const message = JSON.parse(event.message), pending = this.pending.get(message.id);
          if (pending) { clearTimeout(pending.timer); this.pending.delete(message.id); message.error ? pending.reject(new Error(`native_protocol:${message.error.message}`)) : pending.resolve(message.result ?? {}); }
          else if (message.method) {
            if(message.method==='Target.targetCrashed'||message.method==='Inspector.targetCrashed')this.terminate(new Error('native_renderer_terminated'));
            if(message.method==='Runtime.executionContextCreated'&&message.params.context.auxData?.isDefault)this.documentContexts.set(message.params.context.auxData.frameId,{id:message.params.context.id,sessionId:message.sessionId});
            if(message.method==='Runtime.executionContextsCleared'){this.documentContexts.clear();this.samplingTarget=undefined;}
            if(message.method==='Runtime.executionContextDestroyed'&&this.samplingTarget?.contextId===message.params.executionContextId)this.samplingTarget=undefined;
            if(message.method==='Runtime.executionContextDestroyed')for(const [frame,context] of this.documentContexts)if(context.id===message.params.executionContextId&&context.sessionId===message.sessionId)this.documentContexts.delete(frame);
            this.emit('protocol-event', message);
          }
        }
        if (event.type === 'audio') {
          const pcm = Buffer.from(event.pcm, 'base64');
          if (!Number.isInteger(event.frames) || event.frames < 1 || event.frames > 8192 || !Number.isInteger(event.channels) || event.channels < 1 || event.channels > 8 || pcm.length !== event.frames * event.channels * 4) throw new Error('native_audio_packet');
          const packet: HtmlAudioPacket = { audioSeq: ++this.audioSeq, channels: event.channels, sampleRate: event.sampleRate, frames: event.frames, pts: event.pts, pcm };
          this.audio.set(packet.audioSeq, packet); while (this.audio.size > 128) this.audio.delete(this.audio.keys().next().value!);
          this.emit('audio', { ...packet, pcm: Buffer.from(pcm) });
        }
        if (event.type === 'audio-error') this.emit('audio-error', event.message);
      } catch (error) { this.emit('protocol-error', error); }
    });
    child.stderr.on('data', chunk => { this.diagnostics = (this.diagnostics + chunk.toString()).slice(-8192); });
    child.on('error', error => { this.emit('closed', error); });
    child.on('exit', (code, signal) => {
      const error = new Error(`native_surface_exit:${code ?? signal}:${this.diagnostics.slice(-2000)}`);
      for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); } this.pending.clear(); this.emit('closed', error);
    });
    await this.wait('ready', () => this.ready, 15_000);
    await this.protocol('Page.getFrameTree');
    await this.protocol('Runtime.enable');
    await this.protocol('Target.setDiscoverTargets',{discover:true});
    await this.wait('load', () => this.loaded, 15_000);
    await this.wait('document-load',()=>this.documentLoaded,10000);
    await this.wait('paint',()=>this.painted,8000);
    await this.recordWorkers(child.pid!);
  }
  private wait(event: string, condition: () => boolean, timeout: number): Promise<void> {
    if (condition()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => end(new Error(`native_surface_${event}_timeout:${this.diagnostics.slice(-2000)}`)), timeout);
      const done = () => end(); const closed = (error: Error) => end(error);
      const end = (error?: Error) => { clearTimeout(timer); this.off(event, done); this.off('closed', closed); error ? reject(error) : resolve(); };
      this.once(event, done); this.once('closed', closed);
    });
  }
  protocol(method: string, params: object = {},sessionId?:string): Promise<any> {
    if (!this.process || this.closing) return Promise.reject(new Error('native_surface_closed'));
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`native_surface_protocol_timeout:${method}`)); }, 8000);
      this.pending.set(id, { resolve, reject, timer });
      this.process!.stdin.write(JSON.stringify({ id, method, params,...(sessionId?{sessionId}:{}) }) + '\n', error => { if (error) { clearTimeout(timer); this.pending.delete(id); reject(error); } });
    });
  }
  async sample(): Promise<NativeSurfaceFrame> {
    const result = await this.protocol('Surface.sample'); return { ...result, png: Buffer.from(result.png, 'base64') };
  }
  async samplePair(reader:()=>HtmlSemanticSnapshot):Promise<NativePairedFrame>{
    const began=performance.now();
    if(!this.samplingTarget){const target=await this.documentContext();await this.protocol('Debugger.enable',{},target.sessionId);await this.protocol('Debugger.setSkipAllPauses',{skip:true},target.sessionId);await this.protocol('Animation.enable',{},target.sessionId);this.samplingTarget=target;}
    const target=this.samplingTarget,oldRate=(await this.protocol('Animation.getPlaybackRate',{},target.sessionId)).playbackRate;
    const compiled=await this.protocol('Runtime.compileScript',{expression:'setTimeout(function acanvasSamplingBoundary(){debugger;},0)',sourceURL:'acanvas-sampling-boundary',persistScript:true,executionContextId:target.contextId},target.sessionId);if(!compiled.scriptId)throw new Error('native_sampling_context');const prepared=performance.now();
    let paused=false,pauseStart=0,semanticEnd=0,copyEnd=0;
    let cancelBoundary=()=>{};
    const pausedEvent=new Promise<void>((resolve,reject)=>{let ended=false;const timer=setTimeout(()=>end(new Error('native_sampling_boundary_timeout')),8000);const event=(message:any)=>{if(message.method!=='Debugger.paused'||message.sessionId!==target.sessionId)return;if(!message.params.callFrames.some((frame:any)=>frame.location.scriptId===compiled.scriptId)){void this.protocol('Debugger.resume',{},target.sessionId).catch(()=>{});return;}paused=true;pauseStart=performance.now();end();};const closed=(error:Error)=>end(error);const end=(error?:Error)=>{if(ended)return;ended=true;clearTimeout(timer);this.off('protocol-event',event);this.off('closed',closed);error?reject(error):resolve()};cancelBoundary=()=>end(new Error('native_sampling_canceled'));this.on('protocol-event',event);this.on('closed',closed);});
    void pausedEvent.catch(()=>{});
    try{
      await this.protocol('Animation.setPlaybackRate',{playbackRate:0},target.sessionId);await this.protocol('Debugger.setSkipAllPauses',{skip:false},target.sessionId);
      await this.protocol('Runtime.runScript',{scriptId:compiled.scriptId,executionContextId:target.contextId,returnByValue:true,awaitPromise:false},target.sessionId);await pausedEvent;
      const result=await this.protocol('Runtime.evaluate',{expression:`(${reader.toString()})()`,contextId:target.contextId,returnByValue:true,awaitPromise:false,disableBreaks:true},target.sessionId);if(result.exceptionDetails)throw new Error('native_sampling_semantics');semanticEnd=performance.now();
      const shot=await this.protocol('Page.captureScreenshot',{format:'png',fromSurface:true,captureBeyondViewport:false});if(shot.data.length>13_981_016)throw new Error('native_sampling_bitmap_limit');const composed=await this.protocol('Surface.composePopup',{png:shot.data});copyEnd=performance.now();const png=Buffer.from(composed.png,'base64');
      return{png,semantics:result.result.value,...(composed.popup?{popup:composed.popup}:{}),timing:{prepareMs:prepared-began,pauseMs:copyEnd-pauseStart,semanticMs:semanticEnd-pauseStart,copyMs:copyEnd-semanticEnd,totalMs:copyEnd-began}};
    }finally{
      cancelBoundary();
      let cleanupError:Error|undefined;
      await this.protocol('Animation.setPlaybackRate',{playbackRate:oldRate},target.sessionId).catch(error=>{cleanupError=error});await this.protocol('Debugger.setSkipAllPauses',{skip:true},target.sessionId).catch(error=>{cleanupError=error});if(paused)await this.protocol('Debugger.resume',{},target.sessionId).catch(error=>{if(!String(error).includes('not paused')&&!String(error).includes('only perform operation while paused'))cleanupError=error});
      if(cleanupError&&!this.closing){this.terminate(new Error('native_sampling_restore_failed'));throw cleanupError;}
    }
  }
  private async documentContext(isolated=true):Promise<{contextId:number;sessionId?:string}>{
    const root=await this.protocol('Page.getFrameTree');let frame=root.frameTree.childFrames?.[0]?.frame;
    if(!frame){
      if(!this.documentSession){const targets=await this.protocol('Target.getTargets'),target=targets.targetInfos.find((target:any)=>target.type==='iframe');if(!target)throw new Error('native_document_missing');this.documentSession=(await this.protocol('Target.attachToTarget',{targetId:target.targetId,flatten:true})).sessionId;await this.protocol('Runtime.enable',{},this.documentSession);}
      frame=(await this.protocol('Page.getFrameTree',{},this.documentSession)).frameTree.frame;
    }
    const contextId=isolated?(await this.protocol('Page.createIsolatedWorld',{frameId:frame.id,worldName:'acanvas-semantic-read'},this.documentSession)).executionContextId:this.documentContexts.get(frame.id)?.id;
    if(!contextId)throw new Error('native_document_context');
    return{contextId,sessionId:this.documentSession};
  }
  async documentEvaluate(expression:string,isolated=true):Promise<any>{
    const target=await this.documentContext(isolated);const result=await this.protocol('Runtime.evaluate',{expression,contextId:target.contextId,returnByValue:true,awaitPromise:true},target.sessionId);if(result.exceptionDetails)throw new Error('native_document_evaluation');return result.result.value;
  }
  async documentNode(selector:string):Promise<{objectId:string;sessionId?:string}>{
    const target=await this.documentContext();const result=await this.protocol('Runtime.evaluate',{expression:`document.querySelector(${JSON.stringify(selector)})`,contextId:target.contextId,returnByValue:false},target.sessionId);if(result.exceptionDetails||!result.result.objectId||result.result.subtype==='null')throw new Error('native_document_node');return{objectId:result.result.objectId,sessionId:target.sessionId};
  }
  async releaseObject(node:{objectId:string;sessionId?:string}):Promise<void>{await this.protocol('Runtime.releaseObject',{objectId:node.objectId},node.sessionId);}
  async documentProtocol(method:string,params:object={}):Promise<any>{const target=await this.documentContext();return this.protocol(method,params,target.sessionId);}
  directory():string{if(!this.cacheDirectory)throw new Error('native_surface_closed');return this.cacheDirectory;}
  audioSince(afterSeq: number): HtmlAudioPacket[] { return [...this.audio.values()].filter(packet => packet.audioSeq > afterSeq).map(packet => ({ ...packet, pcm: Buffer.from(packet.pcm) })); }
  close(): Promise<void> {
    if (this.closeTask) return this.closeTask;
    this.closing = true;
    this.closeTask = (async () => {
      const child = this.process;
      if(child?.pid&&child.exitCode===null&&child.signalCode===null)await this.recordWorkers(child.pid);
      if (child?.pid && child.exitCode === null&&child.signalCode===null) await new Promise<void>(resolve => { const timer = setTimeout(() => { child.kill('SIGTERM'); }, 3000); const killTimer=setTimeout(()=>{child.kill('SIGKILL');},6000); child.once('close', () => { clearTimeout(timer); clearTimeout(killTimer); resolve(); }); child.stdin.end('quit\n'); });
      this.process = undefined;
      await this.reapWorkers();
      if (this.cacheDirectory) await rm(this.cacheDirectory, { recursive: true, force: true });
      this.cacheDirectory = undefined; this.audio.clear();
    })();
    return this.closeTask;
  }
}
