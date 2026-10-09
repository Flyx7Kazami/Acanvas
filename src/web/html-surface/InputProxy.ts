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
  constructor(private send: (input: HtmlPresentedInput) => Promise<HtmlInputResult | void>) {}
  present(frame: HtmlSurfaceReference) {
    if (this.frame?.instanceId !== frame.instanceId) { this.generation++; this.nextSequence = frame.inputSeq; }
    else this.nextSequence = Math.max(this.nextSequence, frame.inputSeq);
    this.frame = { ...frame, viewport: { ...frame.viewport } };
  }
  input(action: HtmlInputAction): Promise<void> {
    return this.dispatch(action).then(() => {});
  }
  clipboard(action: HtmlClipboardAction): Promise<HtmlClipboardData | undefined> {
    return this.dispatch(action);
  }
  private dispatch(action: HtmlInputAction): Promise<HtmlClipboardData | undefined> {
    const frame = this.frame && { ...this.frame, viewport: { ...this.frame.viewport } }, generation = this.generation;
    const work = this.pending.then(async () => {
      if (!frame || generation !== this.generation || !this.frame) throw new Error('The HTML surface has changed.');
      if (frame.viewport.width !== this.frame.viewport.width || frame.viewport.height !== this.frame.viewport.height) throw new Error('The HTML surface size has changed.');
      const inputSeq = this.nextSequence + 1;
      const result = await this.send({ ...action, instanceId: frame.instanceId, inputSeq, frameSeq: frame.frameSeq, viewport: frame.viewport });
      if (generation !== this.generation) return;
      if (result && result.inputSeq !== inputSeq) throw new Error('The HTML input sequence has changed.');
      this.nextSequence = inputSeq;
      if(result?.clipboardError)throw new Error(result.clipboardError);
      return result?.clipboard;
    });
    this.pending = work.then(() => {}, () => {}); return work;
  }
  clear() { this.generation++; this.frame = undefined; }
  flush() { return this.pending; }
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
/** Local IME owns candidate UI; physical keys follow the source browser's native key pipeline. */
export function attachHtmlTextInput(element: HTMLInputElement | HTMLTextAreaElement, controlId: string, send: (input: HtmlInputAction) => void) {
  let composing = false, enterDown = false,physicalCharacter=false;
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
  const select = () => { if (!composing && element.type !== 'password' && element.selectionStart !== null && element.selectionEnd !== null) send({ type: 'text-selection', controlId, start: element.selectionStart, end: element.selectionEnd, direction: element.selectionDirection ?? 'none' }); };
  const listeners = { compositionstart, compositionupdate, compositionend, beforeinput, keydown, keyup, select };
  for (const [name, listener] of Object.entries(listeners)) element.addEventListener(name, listener as EventListener);
  return () => { for (const [name, listener] of Object.entries(listeners)) element.removeEventListener(name, listener as EventListener); if (composing) send({ type: 'composition', action: 'cancel', text: '' }); };
}
