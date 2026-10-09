import { useEffect,useLayoutEffect,useRef,useState } from 'react';
import {flushSync} from 'react-dom';
import type { Asset,ProjectHtmlSurface,HtmlSurfaceFrameMetadata } from '../../shared/types';
import type { BoardApi } from '../api';
import {RequestError} from '../api';
import type { useSceneContent } from '../scene-renderer/content';
import {HtmlSurfaceControls} from './Controls';
import {HtmlInputProxy,htmlSurfacePoint,type HtmlInputAction} from './InputProxy';
import {HtmlPcmPlayer} from './PcmPlayer';
import {htmlClipboardHandlers,type HtmlClipboardRequest} from './Clipboard';

type Publisher=NonNullable<ReturnType<typeof useSceneContent>>;
function chrome(context:CanvasRenderingContext2D,width:number,height:number,scale:number,error:string,readOnly:boolean){
  context.save();context.scale(scale,scale);
  if(error){context.fillStyle='#e9e9e5';context.fillRect(0,0,width,height);context.fillStyle='#55554d';context.font='13px system-ui';context.textAlign='center';context.fillText(error==='Preparing preview'?'Preparing preview':'Preview unavailable',width/2,height/2);}
  context.fillStyle='rgba(255,255,255,.9)';context.fillRect(Math.max(0,width-42),8,34,28);context.strokeStyle='#55554d';context.lineWidth=1.3;context.beginPath();context.moveTo(width-25,15);context.lineTo(width-25,25);context.moveTo(width-29,21);context.lineTo(width-25,25);context.lineTo(width-21,21);context.moveTo(width-31,26);context.lineTo(width-31,30);context.lineTo(width-19,30);context.lineTo(width-19,26);context.stroke();
  if(readOnly&&!error){context.fillStyle='rgba(255,255,255,.85)';context.fillRect(8,Math.max(0,height-25),80,17);context.fillStyle='#55554d';context.font='11px system-ui';context.textAlign='left';context.fillText('Read-only preview',12,Math.max(12,height-13));}
  context.restore();
}
function feedback(context:CanvasRenderingContext2D,width:number,height:number,scale:number,message:string){if(!message)return;context.save();context.scale(scale,scale);context.fillStyle='rgba(255,248,230,.96)';context.fillRect(8,Math.max(0,height-42),Math.max(1,width-16),34);context.fillStyle='#61451c';context.font='12px system-ui';let text=message;while(text.length>1&&context.measureText(text).width>width-32)text=text.slice(0,-2);context.fillText(text,16,Math.max(14,height-20));context.restore();}

/** Publishes the backend surface pixels into the board's same-frame renderer. */
export function SceneHtmlSurface({asset,api,scene}:{asset:Asset;api:BoardApi;scene:Publisher}){
  const canvas=useRef<HTMLCanvasElement>(null),surface=useRef<ProjectHtmlSurface|undefined>(undefined);
  const latest=useRef(scene);latest.current=scene;
  const [error,setError]=useState(''),[ready,setReady]=useState(false),[attempt,setAttempt]=useState(0);
  const [inputError,setInputError]=useState('');
  const [frame,setFrame]=useState<HtmlSurfaceFrameMetadata|undefined>();
  const [interactive,setInteractive]=useState(false);
  const input=useRef<HtmlInputProxy|undefined>(undefined),audio=useRef<HtmlPcmPlayer|undefined>(undefined);
  const popup=useRef<HTMLDivElement>(null);
  const painted=useRef(false);
  const inputFeedback=useRef(inputError);inputFeedback.current=inputError;
  const visual=useRef<{image:HTMLImageElement;frame:HtmlSurfaceFrameMetadata;readOnly:boolean}|undefined>(undefined);
  const identity=scene.captureView;
  useLayoutEffect(()=>{if(interactive&&frame?.popup)popup.current?.focus({preventScroll:true})},[interactive,!!frame?.popup]);
  useLayoutEffect(()=>{const value=visual.current,current=canvas.current;if(!value||!current)return;const context=current.getContext('2d');if(!context)return;context.clearRect(0,0,current.width,current.height);context.drawImage(value.image,0,0);const scale=value.frame.bitmap.width/value.frame.viewport.width;chrome(context,value.frame.viewport.width,value.frame.viewport.height,scale,'',value.readOnly);feedback(context,value.frame.viewport.width,value.frame.viewport.height,scale,inputError);latest.current.publish({pixels:current,bitmap:value.frame.bitmap,fit:'fill',surface:{surfaceId:value.frame.surfaceId,instanceId:value.frame.instanceId,frameSeq:value.frame.frameSeq,inputSeq:value.frame.inputSeq,viewport:value.frame.viewport},scroll:value.frame.semantics.scroll});},[inputError]);
  useLayoutEffect(()=>{if(identity||!canvas.current)return;const current=canvas.current;current.width=Math.max(1,Math.ceil(scene.width));current.height=Math.max(1,Math.ceil(scene.height));const context=current.getContext('2d');if(!context)return;chrome(context,current.width,current.height,1,'Preparing preview',true);scene.publish({pixels:current,bitmap:{width:current.width,height:current.height},fit:'fill'});},[identity,scene.width,scene.height,scene.publish]);
  useEffect(()=>{
    if(!identity)return;
    let stopped=false,timer:ReturnType<typeof setTimeout>|undefined,audioTimer:ReturnType<typeof setTimeout>|undefined,accepted:ProjectHtmlSurface|undefined,lastAudioSeq=0,retryDelay=500,opening=false;
    const controller=new AbortController();visual.current=undefined;setError('');setInputError('');setReady(false);setFrame(undefined);setInteractive(false);painted.current=false;
    const player=new HtmlPcmPlayer();audio.current=player;
    function paintPlaceholder(message:string){const current=canvas.current;if(!current||stopped)return;current.width=Math.max(1,Math.ceil(latest.current.width));current.height=Math.max(1,Math.ceil(latest.current.height));const context=current.getContext('2d');if(!context)return;chrome(context,current.width,current.height,1,message,true);latest.current.publish({pixels:current,bitmap:{width:current.width,height:current.height},fit:'fill'});}
    const close=(info:ProjectHtmlSurface)=>api.closeHtmlSurface(identity!,info.surfaceId).catch(()=>{});
    async function open(){
      if(stopped||opening)return;opening=true;
      try{const info=await api.createHtmlSurface(identity!,scene.objectId,asset.id,{width:Math.max(1,Math.ceil(latest.current.width)),height:Math.max(1,Math.ceil(latest.current.height)),deviceScaleFactor:window.devicePixelRatio>=2?2:1});if(stopped){void close(info);return}accepted=info;surface.current=info;lastAudioSeq=0;setInteractive(info.engine==='cef');input.current=new HtmlInputProxy(action=>api.inputHtmlSurface(identity!,info.surfaceId,action));retryDelay=500;void sample();if(info.engine==='cef')void pollAudio();}
      catch(cause){if(stopped)return;setError(cause instanceof Error?cause.message:'The preview is unavailable.');if(!painted.current)paintPlaceholder('Preview unavailable');if(!(cause instanceof RequestError)||cause.status>=500||cause.status===0||cause.status===429&&['surface_limit','surface_retained_limit'].includes(cause.code)){timer=setTimeout(()=>void open(),retryDelay);retryDelay=Math.min(5000,retryDelay*2)}}
      finally{opening=false}
    }
    function recover(){if(stopped)return;const previous=accepted;accepted=undefined;input.current?.clear();input.current=undefined;player.clear();setInteractive(false);setReady(false);clearTimeout(audioTimer);if(previous)void close(previous);timer=setTimeout(()=>void open(),retryDelay);retryDelay=Math.min(5000,retryDelay*2);}
    async function pollAudio(){if(stopped||accepted?.engine!=='cef')return;try{const batch=await api.htmlSurfaceAudio(identity!,accepted.surfaceId,lastAudioSeq,controller.signal);if(batch.instanceId!==accepted.instanceId)throw new Error('The HTML audio instance changed.');player.push(batch.instanceId,batch.packets);lastAudioSeq=Math.max(lastAudioSeq,...batch.packets.map(packet=>packet.audioSeq));}catch(cause){if(stopped)return;setError(cause instanceof Error?cause.message:'Audio unavailable');}if(!stopped)audioTimer=setTimeout(()=>void pollAudio(),125);}
    async function sample(){
      if(stopped||!accepted)return;
      try{
        const width=Math.max(1,Math.ceil(latest.current.width)),height=Math.max(1,Math.ceil(latest.current.height));
        if(accepted.viewport.width!==width||accepted.viewport.height!==height)accepted=await api.resizeHtmlSurface(identity!,accepted.surfaceId,{width,height});
        const frame:HtmlSurfaceFrameMetadata=await api.sampleHtmlSurface(identity!,accepted.surfaceId);
        const response=await fetch(frame.contentUrl,{credentials:'same-origin',signal:controller.signal});if(!response.ok)throw new Error('The preview frame is unavailable.');
        const blob=await response.blob(),url=URL.createObjectURL(blob),image=new Image();
        try{image.src=url;await image.decode();if(stopped||!canvas.current||latest.current.captureView?.viewId!==identity!.viewId)return;const current=canvas.current;current.width=frame.bitmap.width;current.height=frame.bitmap.height;const context=current.getContext('2d');if(!context)throw new Error('Canvas 2D is unavailable.');context.drawImage(image,0,0);chrome(context,frame.viewport.width,frame.viewport.height,frame.bitmap.width/frame.viewport.width,'',accepted.engine!=='cef');feedback(context,frame.viewport.width,frame.viewport.height,frame.bitmap.width/frame.viewport.width,inputFeedback.current);visual.current={image,frame,readOnly:accepted.engine!=='cef'};input.current?.present(frame);flushSync(()=>setFrame(frame));latest.current.publish({pixels:current,bitmap:frame.bitmap,fit:'fill',surface:{surfaceId:frame.surfaceId,instanceId:frame.instanceId,frameSeq:frame.frameSeq,inputSeq:frame.inputSeq,viewport:frame.viewport},scroll:frame.semantics.scroll});painted.current=true;setReady(true);setError('');}
        finally{URL.revokeObjectURL(url)}
      }catch(cause){if(stopped)return;setError(cause instanceof Error?cause.message:'The preview is unavailable.');if(cause instanceof RequestError&&cause.code==='surface_renderer_exit'){recover();return}if(!painted.current)paintPlaceholder('Preview unavailable');}
      if(!stopped)timer=setTimeout(()=>void sample(),250);
    }
    paintPlaceholder('Preparing preview');
    void open();
    return()=>{stopped=true;controller.abort();clearTimeout(timer);clearTimeout(audioTimer);input.current?.clear();input.current=undefined;if(audio.current===player)audio.current=undefined;void player.close();if(surface.current===accepted)surface.current=undefined;if(accepted)void close(accepted)};
  },[api,asset.id,identity?.viewId,identity?.documentId,identity?.viewGeneration,attempt]);
  const send=async(action:HtmlInputAction)=>{if(!input.current)throw new Error('The HTML surface is loading.');await input.current.input(action);setInputError('');};
  const report=(cause:unknown)=>setInputError(cause instanceof Error?cause.message:'The HTML input is unavailable.');
  const clipboard:HtmlClipboardRequest=async action=>{if(!input.current)throw new Error('The HTML surface is loading.');const result=await input.current.clipboard(action);setInputError('');return result};
  const clipboardHandlers=htmlClipboardHandlers(clipboard,report);
  const pointer=(event:React.PointerEvent<HTMLElement>,action:'move'|'down'|'up')=>{if(!interactive||!frame||!canvas.current)return;event.stopPropagation();const point=htmlSurfacePoint(event,canvas.current.getBoundingClientRect(),frame.viewport);if(!point)return;if(action==='down'){event.currentTarget.focus({preventScroll:true});event.currentTarget.setPointerCapture(event.pointerId)}if(action==='up'&&event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);void send({type:'pointer',action,...point,button:event.button===2?'right':event.button===1?'middle':'left'}).catch(report);};
  const key=(event:React.KeyboardEvent<HTMLElement>,action:'down'|'up')=>{if(!interactive||event.nativeEvent.isComposing||event.key==='Process'||(event.metaKey||event.ctrlKey)&&['c','v','x'].includes(event.key.toLowerCase()))return;event.preventDefault();event.stopPropagation();void send({type:'key',action,key:event.code||event.key,...(event.key.length===1&&!event.metaKey&&!event.ctrlKey?{character:event.key}:{})}).catch(report);};
  const wheel=(event:React.WheelEvent<HTMLElement>)=>{if(!interactive||!frame||!canvas.current)return;event.stopPropagation();const point=htmlSurfacePoint(event,canvas.current.getBoundingClientRect(),frame.viewport);if(point)void send({type:'wheel',...point,deltaX:Math.max(-4096,Math.min(4096,event.deltaX)),deltaY:Math.max(-4096,Math.min(4096,event.deltaY))}).catch(report)};
  const popupBounds=frame?.popup?.bounds;
  return <div className="html-content" data-preview-state="live" data-preview-ready={ready||undefined} aria-label={`HTML preview: ${asset.name}`} onPointerDownCapture={()=>{if(interactive)void audio.current?.resume().catch(report)}} onKeyDownCapture={event=>{if(interactive&&event.isTrusted)void audio.current?.resume().catch(report)}}>
    <canvas ref={canvas} data-canvas-wheel={interactive?'content':undefined} style={{width:'100%',height:'100%',display:'block'}} aria-label={asset.name} tabIndex={interactive?0:undefined} onCopy={interactive?clipboardHandlers.onCopy:undefined} onCut={interactive?clipboardHandlers.onCut:undefined} onPaste={interactive?clipboardHandlers.onPaste:undefined} onPointerDown={event=>pointer(event,'down')} onPointerMove={event=>pointer(event,'move')} onPointerUp={event=>pointer(event,'up')} onKeyDown={event=>key(event,'down')} onKeyUp={event=>key(event,'up')} onWheel={event=>{if(!interactive||!frame)return;event.stopPropagation();const point=htmlSurfacePoint(event,event.currentTarget.getBoundingClientRect(),frame.viewport);if(point)void send({type:'wheel',...point,deltaX:Math.max(-4096,Math.min(4096,event.deltaX)),deltaY:Math.max(-4096,Math.min(4096,event.deltaY))}).catch(report)}}/>
    {interactive&&frame&&<HtmlSurfaceControls snapshot={frame.semantics} surface={frame} frameSeq={frame.frameSeq} onInput={send} onClipboard={clipboard} onError={report}/>}
    {interactive&&frame&&popupBounds&&<div ref={popup} tabIndex={0} data-html-popup data-canvas-control data-canvas-wheel="content" data-popup-frame-seq={frame.popup!.frameSeq} aria-label="HTML picker" style={{position:'absolute',zIndex:20,left:`${Math.max(0,popupBounds.x)/frame.viewport.width*100}%`,top:`${Math.max(0,popupBounds.y)/frame.viewport.height*100}%`,width:`${Math.max(0,Math.min(frame.viewport.width,popupBounds.x+popupBounds.width)-Math.max(0,popupBounds.x))/frame.viewport.width*100}%`,height:`${Math.max(0,Math.min(frame.viewport.height,popupBounds.y+popupBounds.height)-Math.max(0,popupBounds.y))/frame.viewport.height*100}%`,outline:'none'}} onPointerDown={event=>pointer(event,'down')} onPointerMove={event=>pointer(event,'move')} onPointerUp={event=>pointer(event,'up')} onPointerCancel={event=>pointer(event,'up')} onKeyDown={event=>key(event,'down')} onKeyUp={event=>key(event,'up')} onWheel={wheel}/>}
    <div className="html-preview-tools" data-canvas-control onPointerDown={event=>event.stopPropagation()}><a href={api.content(asset.id)} download={asset.name} aria-label={`Download ${asset.name}`} title="Download original HTML">↓</a></div>
    {(inputError||error)&&<div className="html-preview-error" role="status"><p>{inputError||error}</p>{error&&<button type="button" data-canvas-control onClick={()=>setAttempt(value=>value+1)}>Retry preview</button>}</div>}
  </div>;
}
