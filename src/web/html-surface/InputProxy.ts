import type { HtmlSurfaceReference } from '../../shared/types.js';
import type { HtmlClipboardAction, HtmlClipboardData, HtmlInputResult } from '../../shared/html-surface.js';

export interface HtmlSelectedFile { name: string; mime: string; bytesBase64: string; lastModified: number }
export type HtmlInputAction =
  | { type: 'pointer'; action: 'move' | 'down' | 'up' | 'click'; x: number; y: number; button?: 'left' | 'middle' | 'right' }
  | { type: 'wheel'; x: number; y: number; deltaX: number; deltaY: number }
  | { type: 'key'; action: 'down' | 'up' | 'press'; key: string;emitText?:boolean;character?:string }
  | { type: 'text'; text: string }
  | { type: 'focus'; controlId: string }
  | { type: 'composition'; action: 'update' | 'commit' | 'cancel'; text: string; selectionStart?: number; selectionEnd?: number }
  | { type: 'control'; controlId: string; value: string | string[] }
  | { type: 'text-selection'; controlId: string; start: number; end: number; direction?: 'forward' | 'backward' | 'none' }
  | { type: 'files'; controlId: string; files: HtmlSelectedFile[] }
  | HtmlClipboardAction;
export const htmlInputEditsControl=(action:HtmlInputAction)=>action.type!=='wheel'&&(action.type!=='pointer'||action.action!=='move');
export type HtmlPresentedInput = HtmlInputAction & Pick<HtmlSurfaceReference, 'instanceId' | 'inputSeq' | 'viewport' | 'frameSeq'>;

/** Maps the current displayed CSS rectangle, including camera and page scaling. */
export function htmlSurfacePoint(point: { clientX: number; clientY: number }, rect: Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>, viewport: HtmlSurfaceReference['viewport']) {
  if (rect.width <= 0 || rect.height <= 0) return undefined;
  const x = (point.clientX - rect.left) * viewport.width / rect.width, y = (point.clientY - rect.top) * viewport.height / rect.height;
  return Number.isFinite(x) && Number.isFinite(y) && x >= 0 && y >= 0 && x < viewport.width && y < viewport.height ? { x, y } : undefined;
}

/** Input order follows accepted actions; every action retains its displayed frame coordinates. */
export class HtmlInputProxy {
  private frame?: HtmlSurfaceReference;
  private nextSequence = 0;
  private pending = Promise.resolve();
  private generation = 0;
  private pendingEdits = new Set<symbol>();
  private editSequence = 0;
  constructor(private send: (input: HtmlPresentedInput) => Promise<HtmlInputResult | void>) {}
  present(frame: HtmlSurfaceReference) {
    if (this.frame?.instanceId !== frame.instanceId) { this.generation++; this.nextSequence = frame.inputSeq; this.editSequence=frame.inputSeq;this.pendingEdits.clear(); }
    else this.nextSequence = Math.max(this.nextSequence, frame.inputSeq);
    this.frame = { ...frame, viewport: { ...frame.viewport } };
  }
  input(action: HtmlInputAction): Promise<HtmlInputResult | undefined> {
    return this.dispatch(action);
  }
  async clipboard(action: HtmlClipboardAction): Promise<HtmlClipboardData | undefined> {
    return (await this.dispatch(action))?.clipboard;
  }
  private dispatch(action: HtmlInputAction): Promise<HtmlInputResult | undefined> {
    const frame = this.frame && { ...this.frame, viewport: { ...this.frame.viewport } }, generation = this.generation;
    const edit=htmlInputEditsControl(action)?Symbol():undefined;
    if(edit)this.pendingEdits.add(edit);
    const work = this.pending.then(async () => {
      if (!frame || generation !== this.generation || !this.frame) throw new Error('The HTML surface has changed.');
      if (frame.viewport.width !== this.frame.viewport.width || frame.viewport.height !== this.frame.viewport.height) throw new Error('The HTML surface size has changed.');
      const inputSeq = this.nextSequence + 1;
      const result = await this.send({ ...action, instanceId: frame.instanceId, inputSeq, frameSeq: frame.frameSeq, viewport: frame.viewport });
      if (generation !== this.generation) return;
      if (result && result.inputSeq !== inputSeq) throw new Error('The HTML input sequence has changed.');
      this.nextSequence = inputSeq;
      if(edit)this.editSequence=inputSeq;
      if(result?.clipboardError)throw new Error(result.clipboardError);
      return result??{inputSeq};
    });
    const completed=work.finally(()=>{if(edit)this.pendingEdits.delete(edit)});
    this.pending = completed.then(() => {}, () => {}); return completed;
  }
  clear() { this.generation++; this.frame = undefined;this.pendingEdits.clear(); }
  canProjectEdits(frame:Pick<HtmlSurfaceReference,'instanceId'|'inputSeq'>){return this.frame?.instanceId===frame.instanceId&&this.pendingEdits.size===0&&frame.inputSeq>=this.editSequence;}
  flush() { return this.pending; }
  get inputSeq() { return this.nextSequence; }
  get instanceId(){return this.frame?.instanceId;}
}

export async function htmlSelectedFiles(files: FileList | readonly File[], maxBytes = 8_388_608): Promise<HtmlSelectedFile[]> {
  const selected = Array.from(files); if (selected.length > 32 || selected.reduce((sum, file) => sum + file.size, 0) > maxBytes) throw new Error('Choose files within the HTML upload limit.');
  return Promise.all(selected.map(async file => {
    const bytes = new Uint8Array(await file.arrayBuffer()); let raw = '';
    for (let start = 0; start < bytes.length; start += 8192) raw += String.fromCharCode(...bytes.subarray(start, start + 8192));
    return { name: file.name, mime: file.type, bytesBase64: btoa(raw), lastModified: file.lastModified };
  }));
}

const printable = (event: KeyboardEvent) => event.key.length === 1 && !event.metaKey && !event.ctrlKey;
export function attachHtmlFocusOwnership(contains:(element:Element|null)=>boolean){
  let owned=contains(document.activeElement);
  const focus=(event:FocusEvent)=>{const target=event.target instanceof Element?event.target:null;if(target!==document.body&&target!==document.documentElement)owned=contains(target);};
  const interaction=(event:PointerEvent|KeyboardEvent)=>{if(event.isTrusted)owned=contains(event.target instanceof Element?event.target:null);};
  document.addEventListener('focusin',focus,true);document.addEventListener('pointerdown',interaction,true);document.addEventListener('keydown',interaction,true);
  return{
    owns:()=>{const active=document.activeElement;return owned&&(contains(active)||!active||active===document.body||active===document.documentElement);},
    dispose:()=>{document.removeEventListener('focusin',focus,true);document.removeEventListener('pointerdown',interaction,true);document.removeEventListener('keydown',interaction,true);owned=false;},
  };
}
/** Local IME owns candidate UI; physical keys follow the source browser's native key pipeline. */
export interface HtmlTextInputController {
  dispose:()=>void;
  isComposing:()=>boolean;
  project:(value:string|undefined,selection?:{start:number;end:number;direction?:'forward'|'backward'|'none'})=>void;
}
export function attachHtmlTextInput(element: HTMLInputElement | HTMLTextAreaElement, controlId: string, send: (input: HtmlInputAction) => void):HtmlTextInputController {
  let composing = false, enterDown = false,physicalCharacter=false,selectionIntent=0,observedSelectionIntent=0;
  const tuple=()=>({value:element.value,start:element.selectionStart,end:element.selectionEnd,direction:element.selectionDirection??'none'});
  let known=tuple();
  const remember=()=>{known=tuple()};
  const compositionstart = () => { composing = true; };
  const compositionupdate = (event: CompositionEvent) => { send({ type: 'composition', action: 'update', text: event.data, selectionStart: event.data.length, selectionEnd: event.data.length }); };
  const compositionend = (event: CompositionEvent) => {
    composing = false;
    send({ type: 'composition', action: event.data ? 'commit' : 'cancel', text: event.data });
  };
  const beforeinput = (event: InputEvent) => {
    if (composing || event.isComposing || event.inputType === 'insertCompositionText' || event.inputType === 'deleteCompositionText') return;
    if (event.inputType === 'insertFromComposition') return;
    if ((event.inputType === 'insertText' || event.inputType === 'insertReplacementText') && event.data&&!physicalCharacter) send({ type: 'text', text: event.data });
    if (!enterDown && (event.inputType === 'insertLineBreak' || event.inputType === 'insertParagraph')) send({ type: 'key', action: 'press', key: 'Enter' });
  };
  const keydown = (event: KeyboardEvent) => {
    if (composing || event.isComposing || event.key === 'Process' || event.key === 'Unidentified' || event.keyCode === 229) return;
    if ((event.metaKey || event.ctrlKey) && ['c', 'v', 'x'].includes(event.key.toLowerCase())) return;
    if(['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End','PageUp','PageDown'].includes(event.key)||(event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==='a')selectionIntent++;
    if (event.key === 'Tab') { event.preventDefault(); send({ type: 'key', action: 'press', key: event.shiftKey ? 'Shift+Tab' : 'Tab' }); return; }
    if (printable(event)) {physicalCharacter=true;send({type:'key',action:'down',key:event.code||event.key,character:event.key});return;}
    if (event.key === 'Enter') enterDown = true;
    send({ type: 'key', action: 'down', key: event.code || event.key });
  };
  const keyup = (event: KeyboardEvent) => {
    if (composing || event.isComposing || event.key === 'Process' || event.key === 'Unidentified' || event.keyCode === 229 || event.key === 'Tab') return;
    if ((event.metaKey || event.ctrlKey) && ['c', 'v', 'x'].includes(event.key.toLowerCase())) return;
    send({ type: 'key', action: 'up', key: event.code || event.key,...(printable(event)?{character:event.key}:{}) });physicalCharacter=false;
    if (event.key === 'Enter') enterDown = false;
  };
  const select = () => { const current=tuple();if(current.value===known.value&&current.start===known.start&&current.end===known.end&&current.direction===known.direction&&selectionIntent===observedSelectionIntent)return;observedSelectionIntent=selectionIntent;known=current;if (!composing && element.type !== 'password' && current.start !== null && current.end !== null) send({ type: 'text-selection', controlId, start: current.start, end: current.end, direction: current.direction as 'forward'|'backward'|'none' }); };
  const listeners = { compositionstart, compositionupdate, compositionend, beforeinput, keydown, keyup, select,input:remember };
  for (const [name, listener] of Object.entries(listeners)) element.addEventListener(name, listener as EventListener);
  return {
    isComposing:()=>composing,
    project:(value,selection)=>{
      if(composing)return;
      observedSelectionIntent=selectionIntent;
      known={value:value??element.value,start:selection?.start??element.selectionStart,end:selection?.end??element.selectionEnd,direction:selection?.direction??element.selectionDirection??'none'};
      if(value!==undefined&&element.value!==value)element.value=value;
      if(selection&&document.activeElement===element&&(element.selectionStart!==selection.start||element.selectionEnd!==selection.end||element.selectionDirection!==(selection.direction??'none')))try{element.setSelectionRange(selection.start,selection.end,selection.direction)}catch{/* Non-text input types have no selection range. */}
      remember();
    },
    dispose:()=>{for (const [name, listener] of Object.entries(listeners)) element.removeEventListener(name, listener as EventListener); if (composing) send({ type: 'composition', action: 'cancel', text: '' });},
  };
}
