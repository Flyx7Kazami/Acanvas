import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { NativeHtmlRuntime } from './cef.js';

export interface SelectedHtmlFile { name: string; mime: string; bytesBase64: string; lastModified: number }
export type NativeControlInput =
  | { type: 'focus'; controlId: string }
  | { type: 'composition'; action: 'update' | 'commit' | 'cancel'; text: string; selectionStart?: number; selectionEnd?: number }
  | { type: 'control'; controlId: string; value: string | string[] }
  | { type: 'text-selection'; controlId: string; start: number; end: number; direction?: 'forward' | 'backward' | 'none' }
  | { type: 'files'; controlId: string; files: SelectedHtmlFile[] };

type Runtime = Pick<NativeHtmlRuntime, 'documentEvaluate' | 'protocol'> & {
  documentNode?: (selector: string) => Promise<{ objectId: string; sessionId?: string }>;
};
export interface NativeControlsOptions { directory: string; maxFileBytes?: number; maxRetainedFileBytes?: number; maxFiles?: number }
const bad = (code: string): never => { throw new Error(`surface_control_${code}`); };

/** File payloads contain user-selected bytes and a basename, never client paths. */
export function decodeSelectedHtmlFiles(files: SelectedHtmlFile[], options: Pick<NativeControlsOptions, 'maxFileBytes' | 'maxFiles'> = {}) {
  if (!Array.isArray(files) || files.length > (options.maxFiles ?? 32)) bad('files');
  let bytes = 0;
  return files.map(file => {
    if (!file || typeof file.name !== 'string' || !file.name || file.name.length > 255 || /[\\/\u0000-\u001f]/u.test(file.name) || ['.', '..'].includes(file.name)) bad('file_name');
    if (typeof file.mime !== 'string' || file.mime.length > 255 || /[\u0000-\u001f]/u.test(file.mime)) bad('file_mime');
    if (!Number.isSafeInteger(file.lastModified) || file.lastModified < 0 || file.lastModified > 8_640_000_000_000_000) bad('file_time');
    if (typeof file.bytesBase64 !== 'string' || file.bytesBase64.length > Math.ceil((options.maxFileBytes ?? 8_388_608) / 3) * 4 || file.bytesBase64.length % 4 || /[^A-Za-z0-9+/=]/u.test(file.bytesBase64)) bad('file_bytes');
    const padding=file.bytesBase64.endsWith('==')?2:file.bytesBase64.endsWith('=')?1:0;if(file.bytesBase64.slice(0,file.bytesBase64.length-padding).includes('='))bad('file_bytes');
    const buffer = Buffer.from(file.bytesBase64, 'base64');
    bytes += buffer.length;
    if (bytes > (options.maxFileBytes ?? 8_388_608) || buffer.toString('base64') !== file.bytesBase64) bad('file_bytes');
    return { ...file, buffer };
  });
}

/** Runs inside the source document's isolated world. */
function editControl(input: Exclude<NativeControlInput, { type: 'composition' } | { type: 'files' }>) {
  const element = document.querySelector<HTMLElement>(input.controlId);
  if (!element || !(element instanceof HTMLElement) || ('disabled' in element && (element as HTMLInputElement).disabled)) throw new Error('surface_control_missing');
  if (input.type === 'focus') { element.focus(); return { focused: document.activeElement === element }; }
  if (input.type === 'text-selection') {
    element.focus();
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) element.setSelectionRange(input.start, input.end, input.direction);
    else if (element.isContentEditable) {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      let node = walker.nextNode(), offset = 0, start: { node: Node; offset: number } | undefined, end: { node: Node; offset: number } | undefined;
      while (node) {
        const length = node.textContent?.length ?? 0;
        if (!start && input.start <= offset + length) start = { node, offset: Math.max(0, input.start - offset) };
        if (input.end <= offset + length) { end = { node, offset: Math.max(0, input.end - offset) }; break; }
        offset += length; node = walker.nextNode();
      }
      const selection = getSelection();
      if (start && end && selection) input.direction === 'backward' ? selection.setBaseAndExtent(end.node, end.offset, start.node, start.offset) : selection.setBaseAndExtent(start.node, start.offset, end.node, end.offset);
      else if (input.start === 0 && input.end === 0 && selection) { const range = document.createRange(); range.selectNodeContents(element); range.collapse(true); selection.removeAllRanges(); selection.addRange(range); }
      else throw new Error('surface_control_selection');
    } else throw new Error('surface_control_selection');
    return { selected: true };
  }
  if ((element as HTMLInputElement).readOnly) throw new Error('surface_control_readonly');
  if (element instanceof HTMLSelectElement) {
    const values = Array.isArray(input.value) ? input.value : [input.value];
    if (!element.multiple && values.length !== 1) throw new Error('surface_control_value');
    if (values.some(value => !Array.from(element.options).some(option => option.value === value && !option.disabled && !(option.parentElement instanceof HTMLOptGroupElement && option.parentElement.disabled)))) throw new Error('surface_control_option');
    for (const option of Array.from(element.options)) option.selected = values.includes(option.value);
  } else if (element instanceof HTMLInputElement && ['date', 'datetime-local', 'month', 'week', 'time', 'color', 'range', 'number'].includes(element.type) && typeof input.value === 'string') {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    const candidate = document.createElement('input'); candidate.type = element.type; setter.call(candidate, input.value);
    if (candidate.value !== input.value) throw new Error('surface_control_value');
    setter.call(element, input.value);
  } else throw new Error('surface_control_type');
  // These events express the client picker's committed value. Their isTrusted is false.
  element.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
  element.dispatchEvent(new Event('change', { bubbles: true }));
  return { value: (element as HTMLInputElement).value, events: 'client-value' };
}

/** Scoped dispatch is owned by ProjectHtmlSurfaces; this class holds only per-instance file bytes. */
export class NativeSurfaceControls {
  private retainedBytes = 0;
  private directories = new Set<string>();
  constructor(private runtime: Runtime, private options: NativeControlsOptions = { directory: '/private/tmp/acanvas-html-files' }) {
  }
  async apply(input: NativeControlInput): Promise<void> {
    if (!input || typeof input.type !== 'string') bad('type');
    if (input.type === 'composition') {
      if (!['update', 'commit', 'cancel'].includes(input.action) || typeof input.text !== 'string' || input.text.length > 65_536) bad('composition');
      if (input.action === 'commit') { await this.runtime.protocol('Input.insertText', { text: input.text }); return; }
      const start = input.selectionStart ?? input.text.length, end = input.selectionEnd ?? start;
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end > input.text.length) bad('composition_selection');
      await this.runtime.protocol('Input.imeSetComposition', { text: input.action === 'cancel' ? '' : input.text, selectionStart: input.action === 'cancel' ? 0 : start, selectionEnd: input.action === 'cancel' ? 0 : end }); return;
    }
    if (typeof input.controlId !== 'string' || !input.controlId || input.controlId.length > 4096) bad('id');
    if (input.type === 'files') { await this.files(input); return; }
    if (input.type === 'text-selection' && (!Number.isInteger(input.start) || !Number.isInteger(input.end) || input.start < 0 || input.end < input.start || input.end > 65_536 || input.direction && !['none', 'forward', 'backward'].includes(input.direction))) bad('selection');
    if (input.type === 'control' && (typeof input.value !== 'string' && !(Array.isArray(input.value) && input.value.every(value => typeof value === 'string')) || JSON.stringify(input.value).length > 65_536)) bad('value');
    if (!['focus', 'control', 'text-selection'].includes(input.type)) bad('type');
    await this.runtime.documentEvaluate(`(${editControl.toString()})(${JSON.stringify(input)})`);
  }
  private async files(input: Extract<NativeControlInput, { type: 'files' }>): Promise<void> {
    const files = decodeSelectedHtmlFiles(input.files, this.options), total = files.reduce((sum, file) => sum + file.buffer.length, 0);
    if (this.retainedBytes + total > (this.options.maxRetainedFileBytes ?? 33_554_432)) bad('file_budget');
    const state = await this.runtime.documentEvaluate(`(()=>{const e=document.querySelector(${JSON.stringify(input.controlId)});return e instanceof HTMLInputElement && e.type==='file' && !e.disabled ? {multiple:e.multiple} : null})()`);
    if (!state || !state.multiple && files.length > 1) bad('file_target');
    const documentNode = this.runtime.documentNode;
    if (!documentNode) throw new Error('surface_control_file_runtime');
    const target = await documentNode.call(this.runtime, input.controlId);
    let directory: string | undefined;
    try {
      await mkdir(this.options.directory, { recursive: true, mode: 0o700 });
      directory = await mkdtemp(join(this.options.directory, 'selected-'));
      const paths: string[] = [];
      for (let index = 0; index < files.length; index++) {
        const file = files[index], parent = join(directory, String(index));
        await mkdir(parent, { mode: 0o700 }); const path = join(parent, file.name);
        await writeFile(path, file.buffer, { mode: 0o600 }); await utimes(path, file.lastModified / 1000, file.lastModified / 1000); paths.push(path);
      }
      await this.runtime.protocol('DOM.setFileInputFiles', { objectId: target.objectId, files: paths }, target.sessionId);
      this.directories.add(directory); this.retainedBytes += total; directory = undefined;
    } finally {
      await this.runtime.protocol('Runtime.releaseObject', { objectId: target.objectId }, target.sessionId).catch(() => {});
      if (directory) await rm(directory, { recursive: true, force: true });
    }
  }
  async close(): Promise<void> {
    await Promise.all([...this.directories].map(directory => rm(directory, { recursive: true, force: true })));
    this.directories.clear(); this.retainedBytes = 0;
  }
}
