import { useLayoutEffect, useRef, type CSSProperties } from 'react';
import type { HtmlSurfaceReference } from '../../shared/types';
import { attachHtmlTextInput, htmlSelectedFiles, htmlSurfacePoint, type HtmlInputAction, type HtmlTextInputController } from './InputProxy';
import type { HtmlInputResult } from '../../shared/html-surface';
import { htmlClipboardHandlers, type HtmlClipboardRequest } from './Clipboard';

export interface HtmlSurfaceSemanticControl {
  id: string; tag: string; type: string; role: string; label: string; value?: string; checked?: boolean; disabled: boolean; readOnly: boolean;
  bounds: { x: number; y: number; width: number; height: number }; options?: Array<{ value: string; label: string; disabled: boolean; selected?: boolean }>;
  selection?: { start: number; end: number; direction?: 'forward' | 'backward' | 'none' }; focused: boolean; multiple?: boolean; accept?: string;
  min?: string; max?: string; step?: string; tabIndex?: number;
}
export interface HtmlSurfaceSemantics {
  controls: HtmlSurfaceSemanticControl[]; selection: string; scroll: { x: number; y: number }; title: string; omittedControls: number;
  readingOrder?: Array<{ id: string; role: string; text: string; level?: number; bounds: { x: number; y: number; width: number; height: number } }>;
  omittedText?: number;
}
export interface HtmlSurfaceControlsProps {
  snapshot: HtmlSurfaceSemantics; surface: Pick<HtmlSurfaceReference, 'instanceId' | 'viewport' | 'inputSeq'>; frameSeq: number;
  onInput: (input: HtmlInputAction) => Promise<HtmlInputResult|undefined>; canProject:()=>boolean; onError?: (error: unknown) => void;
  clientFocus:{owns:()=>boolean;focus:()=>void;popup:()=>boolean};
  onClipboard?: HtmlClipboardRequest;
}
const overlay: CSSProperties = { position: 'absolute', inset: 0, pointerEvents: 'none', overflow: 'hidden' };
const hidden: CSSProperties = { position: 'absolute', width: 1, height: 1, margin: -1, padding: 0, overflow: 'hidden', clipPath: 'inset(50%)', whiteSpace: 'nowrap', border: 0 };
const textTypes = new Set(['text', 'search', 'email', 'url', 'tel', 'password']);
const pickerTypes = new Set(['date', 'datetime-local', 'month', 'week', 'time', 'color', 'range', 'number']);

function TextProxy({ control, style, send, scope, initialValue, controllers, onFocus, onBlur }: { control: HtmlSurfaceSemanticControl; style: CSSProperties; send: (input: HtmlInputAction) => void; scope: string; initialValue:string;controllers:Map<string,HtmlTextInputController>;onFocus:()=>void;onBlur:()=>void }) {
  const input = useRef<HTMLInputElement | HTMLTextAreaElement>(null);
  const current = useRef(send); current.current = send;
  const pointer = useRef<number | undefined>(undefined);
  useLayoutEffect(() => {
    const element=input.current;if(!element)return;
    const controller=attachHtmlTextInput(element,control.id,action=>current.current(action));controllers.set(control.id,controller);
    return()=>{if(controllers.get(control.id)===controller)controllers.delete(control.id);controller.dispose();};
  }, [control.id, scope, controllers]);
  const pointerAction = (event: React.PointerEvent<HTMLInputElement | HTMLTextAreaElement>, action: 'down' | 'move' | 'up') => {
    event.stopPropagation();
    if (action === 'move' && pointer.current !== event.pointerId) return;
    const parent = event.currentTarget.parentElement; if (!parent) return;
    const rect = parent.getBoundingClientRect(), position = pointer.current === event.pointerId ? { clientX: Math.max(rect.left, Math.min(rect.right - .001, event.clientX)), clientY: Math.max(rect.top, Math.min(rect.bottom - .001, event.clientY)) } : event;
    const point = htmlSurfacePoint(position, rect, { width: Number(parent.dataset.surfaceWidth), height: Number(parent.dataset.surfaceHeight) });
    if (!point) return;
    if (action === 'down') { event.preventDefault(); pointer.current = event.pointerId; event.currentTarget.setPointerCapture(event.pointerId); event.currentTarget.focus({ preventScroll: true }); }
    if (action === 'up') { pointer.current = undefined; if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }
    send({ type: 'pointer', action, ...point, button: event.button === 2 ? 'right' : event.button === 1 ? 'middle' : 'left' });
  };
  const common = {
    style, 'aria-label': control.label, disabled: control.disabled, readOnly: control.readOnly, tabIndex: control.tabIndex,
    defaultValue:initialValue, onFocus, onBlur,
    onPointerDown: (event: React.PointerEvent<HTMLInputElement | HTMLTextAreaElement>) => pointerAction(event, 'down'),
    onPointerMove: (event: React.PointerEvent<HTMLInputElement | HTMLTextAreaElement>) => pointerAction(event, 'move'),
    onPointerUp: (event: React.PointerEvent<HTMLInputElement | HTMLTextAreaElement>) => pointerAction(event, 'up'),
    onPointerCancel: (event: React.PointerEvent<HTMLInputElement | HTMLTextAreaElement>) => pointerAction(event, 'up'),
    'data-html-control': control.id,
  };
  return control.tag === 'textarea' || control.type === 'contenteditable' || control.tag !== 'input'
    ? <textarea {...common} ref={element => { input.current = element; }} />
    : <input {...common} ref={element => { input.current = element; }} type={textTypes.has(control.type) ? control.type : 'text'} autoComplete="off" />;
}

/** Transparent native client controls supply IME, pickers, file selection and accessible focus. */
export function HtmlSurfaceControls({ snapshot, surface, frameSeq, onInput, onClipboard, onError, canProject, clientFocus }: HtmlSurfaceControlsProps) {
  const container = useRef<HTMLDivElement>(null);
  const send = (input: HtmlInputAction) => { void onInput(input).catch(error => onError?.(error)); };
  const scope = `${surface.instanceId}`;
  const clipboard = onClipboard ? htmlClipboardHandlers(onClipboard, onError) : undefined;
  const textInputs=useRef(new Map<string,HtmlTextInputController>()),knownFocus=useRef<string|undefined>(undefined);
  const initialValues=useRef(new Map<string,{value:string|string[];checked:boolean}>());
  const currentClientFocus=useRef(clientFocus);currentClientFocus.current=clientFocus;
  const focus=(controlId:string)=>{if(knownFocus.current===controlId)return;knownFocus.current=controlId;send({type:'focus',controlId});};
  const blur=(controlId:string)=>{if(knownFocus.current===controlId)knownFocus.current=undefined;};
  useLayoutEffect(()=>{
    if(!canProject()||[...textInputs.current.values()].some(controller=>controller.isComposing()))return;
    const root=container.current;if(!root)return;
    const focused=snapshot.controls.find(control=>control.focused),elements=new Map(Array.from(root.querySelectorAll<HTMLElement>('[data-html-control]')).map(element=>[element.dataset.htmlControl!,element]));
    for(const id of initialValues.current.keys())if(!elements.has(id))initialValues.current.delete(id);
    if(currentClientFocus.current.owns()&&!currentClientFocus.current.popup()){
      knownFocus.current=focused?.id;
      const target=focused&&elements.get(focused.id);
      if(target&&document.activeElement!==target)target.focus({preventScroll:true});
      if(!focused)currentClientFocus.current.focus();
    }
    for(const control of snapshot.controls){
      const element=elements.get(control.id);if(!element)continue;
      const controller=textInputs.current.get(control.id);
      if(controller){controller.project(control.type==='password'?undefined:control.value??'',control.selection);continue;}
      if(element instanceof HTMLSelectElement){
        if(control.multiple){const values=new Set(control.options?.filter(option=>option.selected).map(option=>option.value));for(const option of element.options)option.selected=values.has(option.value);}
        else if(element.value!==(control.value??''))element.value=control.value??'';
      }else if(element instanceof HTMLInputElement){
        if(control.type==='checkbox'||control.type==='radio')element.checked=control.checked??false;
        else if(pickerTypes.has(control.type)&&element.value!==(control.value??''))element.value=control.value??'';
      }
    }
  },[snapshot,surface.instanceId,surface.inputSeq,frameSeq,canProject]);
  const key = (event: React.KeyboardEvent, action: 'down' | 'up') => {
    if (event.isDefaultPrevented() || event.nativeEvent.isComposing) return;
    if (event.key === 'Tab') { event.preventDefault(); if (action === 'down') send({ type: 'key', action: 'press', key: event.shiftKey ? 'Shift+Tab' : 'Tab' }); return; }
    if ((event.ctrlKey || event.metaKey) && ['c', 'x', 'v'].includes(event.key.toLowerCase())) return;
    event.preventDefault();
    send({ type: 'key', action, key: event.code || event.key });
  };
  const renderControl = (control: HtmlSurfaceSemanticControl) => {
      const style: CSSProperties = { position: 'absolute', left: `${control.bounds.x / surface.viewport.width * 100}%`, top: `${control.bounds.y / surface.viewport.height * 100}%`, width: `${control.bounds.width / surface.viewport.width * 100}%`, height: `${control.bounds.height / surface.viewport.height * 100}%`, boxSizing: 'border-box', padding: 0, margin: 0, border: 0, opacity: 0, pointerEvents: 'auto', resize: 'none' };
      let initial=initialValues.current.get(control.id);if(!initial){initial={value:control.multiple?control.options?.filter(option=>option.selected).map(option=>option.value)??[]:control.value??'',checked:control.checked??false};initialValues.current.set(control.id,initial);}
      const common = { style, 'aria-label': control.label, disabled: control.disabled, tabIndex: control.tabIndex, 'data-html-control': control.id, onFocus: () => focus(control.id), onBlur:()=>blur(control.id), onPointerDown: (event: React.PointerEvent) => event.stopPropagation(), onKeyDown: (event: React.KeyboardEvent) => { if (event.key === 'Tab') key(event, 'down'); }, onKeyUp: (event: React.KeyboardEvent) => { if (event.key === 'Tab') key(event, 'up'); } };
      if (control.tag === 'textarea' || control.tag === 'input' && textTypes.has(control.type) || control.type === 'contenteditable' || control.tag !== 'input' && control.role === 'textbox') return <TextProxy key={`${scope}:${control.id}`} scope={scope} initialValue={control.type==='password'?'':String(initial.value)} controllers={textInputs.current} onFocus={()=>focus(control.id)} onBlur={()=>blur(control.id)} control={control} style={style} send={send} />;
      if (control.tag === 'select') return <select {...common} key={control.id} multiple={control.multiple} defaultValue={initial.value} onChange={event => send({ type: 'control', controlId: control.id, value: control.multiple ? Array.from(event.currentTarget.selectedOptions).map(option => option.value) : event.currentTarget.value })}>{control.options?.map((option, index) => <option key={index} value={option.value} disabled={option.disabled}>{option.label}</option>)}</select>;
      if (control.type === 'file') return <input {...common} key={control.id} type="file" multiple={control.multiple} accept={control.accept} onChange={event => { const files = event.currentTarget.files; if (files) void htmlSelectedFiles(files).then(selected => onInput({ type: 'files', controlId: control.id, files: selected })).catch(error => onError?.(error)); }} />;
      if (pickerTypes.has(control.type)) return <input {...common} key={control.id} type={control.type} min={control.min} max={control.max} step={control.step} defaultValue={initial.value} readOnly={control.readOnly} onChange={event => send({ type: 'control', controlId: control.id, value: event.currentTarget.value })} />;
      const click = (event: React.MouseEvent) => { event.stopPropagation(); send({ type: 'pointer', action: 'click', x: Math.max(0, Math.min(surface.viewport.width - 0.01, control.bounds.x + control.bounds.width / 2)), y: Math.max(0, Math.min(surface.viewport.height - 0.01, control.bounds.y + control.bounds.height / 2)), button: 'left' }); };
      if (control.type === 'checkbox' || control.type === 'radio') return <input {...common} key={control.id} type={control.type} defaultChecked={initial.checked} onChange={() => {}} onClick={click} onKeyDown={event => key(event, 'down')} onKeyUp={event => key(event, 'up')} />;
      return <button {...common} key={control.id} type="button" role={control.role === 'link' ? 'link' : undefined} onClick={click} onKeyDown={event => key(event, 'down')} onKeyUp={event => key(event, 'up')}>{control.label}</button>;
    };
  const readingIds = new Set(snapshot.readingOrder?.map(item => item.id) ?? []);
  return <div ref={container} style={overlay} data-canvas-control data-canvas-wheel="canvas" data-html-semantics data-surface-width={surface.viewport.width} data-surface-height={surface.viewport.height} data-frame-seq={frameSeq} aria-label={snapshot.title || 'HTML content'} onCopy={clipboard?.onCopy} onCut={clipboard?.onCut} onPaste={clipboard?.onPaste}>
    {snapshot.readingOrder?.map(item => {
      const control = snapshot.controls.find(control => control.id === item.id);
      return control ? renderControl(control) : <span key={item.id} style={hidden} role={item.role === 'heading' ? 'heading' : undefined} aria-level={item.role === 'heading' ? item.level : undefined}>{item.text}</span>;
    })}
    {snapshot.controls.filter(control => !readingIds.has(control.id)).map(renderControl)}
    {(snapshot.omittedControls > 0 || (snapshot.omittedText ?? 0) > 0) && <span style={hidden}>Additional content is available by scrolling.</span>}
  </div>;
}
