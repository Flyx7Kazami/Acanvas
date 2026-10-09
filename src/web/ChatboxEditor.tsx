import { useLayoutEffect, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import type { Asset, BoardObject, Draft, DraftReferences, RequestReference, Task } from '../shared/types';
import { referenceOrder, referenceParts } from '../shared/task-message';
import { ChatboxReference } from './ChatboxReferences';

type TextPart = { kind: 'text'; text: string };
type ReferencePart = { kind: 'reference'; reference: RequestReference; preview?: boolean; hostKey?: string };
type Part = TextPart | ReferencePart;
type EditorSelection = { start: number; end: number; backward?: boolean };
type EditorValue = { text: string; references: DraftReferences };
export type EditorCaret = { text: string; caret: number; segmentStart: number; collapsed: boolean };
export type ChatboxEditorHandle = { confirmPreview: () => void; insertReference: (entry: RequestReference, query?: { start: number; end: number }) => void };

const partLength = (part: Part) => part.kind === 'text' ? part.text.length : 1;
const documentLength = (parts: Part[]) => parts.reduce((length, part) => length + partLength(part), 0);
const valueKey = (value: EditorValue) => JSON.stringify({ text: value.text, order: referenceOrder(value.references, value.text) });
const isBlock = (node: Node) => node instanceof HTMLElement && ['DIV', 'P'].includes(node.tagName);
const firstContentNode = (root: Node) => Array.from(root.childNodes).find(node => node.nodeType === Node.TEXT_NODE ? !!node.textContent : !(node instanceof HTMLElement && node.dataset.editorTail));
const referenceLeadingLine = (root: Node) => !!firstContentNode(root) && isBlock(firstContentNode(root)!) && Array.from(root.childNodes).some(node => node instanceof HTMLElement && !!node.dataset.editorReference);

function compact(parts: Part[]): Part[] {
  const result: Part[] = [];
  for (const part of parts) {
    if (part.kind === 'text') {
      if (!part.text) continue;
      const previous = result.at(-1);
      if (previous?.kind === 'text') previous.text += part.text;
      else result.push({ ...part });
    } else result.push(part);
  }
  return result;
}

function slice(parts: Part[], start: number, end: number): Part[] {
  let cursor = 0;
  return compact(parts.flatMap(part => {
    const next = cursor + partLength(part), left = Math.max(start, cursor), right = Math.min(end, next);
    const taken = right > left ? [part.kind === 'text' ? { kind: 'text' as const, text: part.text.slice(left - cursor, right - cursor) } : part] : [];
    cursor = next;
    return taken;
  }));
}

function splice(parts: Part[], start: number, end: number, inserted: Part[]): Part[] {
  return compact([...slice(parts, 0, start), ...inserted, ...slice(parts, end, documentLength(parts))]);
}

function serialize(parts: Part[]): EditorValue {
  let text = '';
  const order: RequestReference[] = [];
  for (const part of parts) {
    if (part.kind === 'text') text += part.text;
    else if (!part.preview) order.push({ kind: part.reference.kind, id: part.reference.id, textOffset: text.length });
  }
  return { text, references: { objectIds: [...new Set(order.filter(entry => entry.kind === 'object').map(entry => entry.id))], taskIds: [...new Set(order.filter(entry => entry.kind === 'task').map(entry => entry.id))], order } };
}

/** Browser text and immutable reference hosts share one editable document. */
function readParts(root: Node, leadingReferenceLine = referenceLeadingLine(root)): Part[] {
  const parts: Part[] = [];
  const append = (text: string) => { if (text) parts.push({ kind: 'text', text }); };
  const referencePlaceholder = (node: Node) => {
    if (!(node instanceof HTMLBRElement)) return false;
    let references = false;
    for (let next = node.nextSibling; next; next = next.nextSibling) {
      if (next instanceof HTMLElement && next.dataset.editorReference) references = true;
      else if (next.nodeType !== Node.TEXT_NODE || next.textContent) return false;
    }
    return references;
  };
  const visit = (container: Node) => {
    let previousLine = false, previousBlock = false;
    container.childNodes.forEach(node => {
      if (node instanceof HTMLElement && node.dataset.editorTail) return;
      if (referencePlaceholder(node)) return;
      if (node instanceof HTMLBRElement && isBlock(container) && node === container.lastChild) return;
      const block = isBlock(node), visible = block || node instanceof HTMLElement && !!node.dataset.editorReference || !!node.textContent || node instanceof HTMLBRElement;
      if (visible && previousLine && (block || previousBlock && !(node instanceof HTMLElement && node.dataset.editorReference))) append('\n');
      if (node.nodeType === Node.TEXT_NODE) append(node.textContent || '');
      else if (node instanceof HTMLElement && node.dataset.editorReference) parts.push({ kind: 'reference', reference: { kind: node.dataset.editorKind as 'object' | 'task', id: node.dataset.editorReference }, preview: node.dataset.editorPreview === 'true', hostKey: node.dataset.editorHost });
      else if (node instanceof HTMLBRElement) append('\n');
      else visit(node);
      if (visible) { previousLine = true; previousBlock = block; }
    });
  };
  if (root.childNodes.length === 1 && root.firstChild instanceof HTMLBRElement) return [];
  if (leadingReferenceLine && firstContentNode(root) && isBlock(firstContentNode(root)!)) append('\n');
  visit(root);
  return compact(parts);
}

function selectionIn(root: HTMLElement): EditorSelection | undefined {
  const selection = window.getSelection();
  if (!selection?.rangeCount || !selection.anchorNode || !selection.focusNode || !root.contains(selection.anchorNode) || !root.contains(selection.focusNode)) return;
  const range = selection.getRangeAt(0);
  return { start: positionIn(root, range.startContainer, range.startOffset), end: positionIn(root, range.endContainer, range.endOffset), backward: positionIn(root, selection.anchorNode, selection.anchorOffset) > positionIn(root, selection.focusNode, selection.focusOffset) };
}

function positionIn(root: HTMLElement, node: Node, offset: number) {
  const before = document.createRange(); before.selectNodeContents(root); before.setEnd(node, offset);
  return documentLength(readParts(before.cloneContents(), referenceLeadingLine(root)));
}

function placeSelection(root: HTMLElement, selection: EditorSelection) {
  const point = (position: number): [Node, number] => {
    let cursor = 0;
    for (const node of root.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) {
        const length = node.textContent?.length || 0;
        if (position <= cursor + length) return [node, Math.max(0, position - cursor)];
        cursor += length;
      } else if (node instanceof HTMLElement && node.dataset.editorReference) {
        if (position <= cursor) return [root, Array.from(root.childNodes).indexOf(node)];
        cursor++;
      }
    }
    return [root, root.childNodes.length];
  };
  const length = documentLength(readParts(root));
  const start = point(Math.min(length, selection.start)), end = point(Math.min(length, selection.end));
  const range = document.createRange(); range.setStart(...start); range.setEnd(...end);
  const current = window.getSelection(); current?.removeAllRanges(); current?.addRange(range);
  if (selection.backward) current?.setBaseAndExtent(...end, ...start);
}

function withoutPreview(parts: Part[], selection: EditorSelection): { parts: Part[]; selection: EditorSelection } {
  let cursor = 0, beforeStart = 0, beforeEnd = 0;
  for (const part of parts) {
    if (part.kind === 'reference' && part.preview) { if (cursor < selection.start) beforeStart++; if (cursor < selection.end) beforeEnd++; }
    cursor += partLength(part);
  }
  return { parts: parts.filter(part => part.kind !== 'reference' || !part.preview), selection: { ...selection, start: selection.start - beforeStart, end: selection.end - beforeEnd } };
}

function caretIn(parts: Part[], selection: EditorSelection): EditorCaret {
  let cursor = 0, caret = 0, segmentStart = 0;
  for (const part of parts) {
    if (cursor >= selection.end) break;
    if (part.kind === 'text') caret += Math.min(part.text.length, selection.end - cursor);
    else segmentStart = caret;
    cursor += partLength(part);
  }
  return { text: serialize(parts).text, caret, segmentStart, collapsed: selection.start === selection.end };
}

export function ChatboxEditor({ draft, preview, objects, assets, tasks, content, inputRef, controller, composing, disabled, placeholder, expanded, activeDescendant, onChange, onCaret, onConsumePreview, onPreviewRemove, onUserPointer, onFocus, onComposition, onKeyDown }: {
  draft: Draft; preview: string[]; objects: BoardObject[]; assets: Asset[]; tasks: Task[]; content: (id: string) => string;
  inputRef: RefObject<HTMLDivElement | null>; controller: RefObject<ChatboxEditorHandle | null>; composing: RefObject<boolean>; disabled: boolean;
  placeholder: string; expanded: boolean; activeDescendant?: string; onChange: (value: EditorValue) => void; onCaret: (caret: EditorCaret) => void;
  onConsumePreview: () => void; onPreviewRemove: (id: string) => void; onUserPointer: () => void; onFocus: () => void; onComposition: (active: boolean) => void; onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
}) {
  const props = useRef({ draft, disabled, onChange, onCaret, onConsumePreview, onPreviewRemove });
  props.current = { draft, disabled, onChange, onCaret, onConsumePreview, onPreviewRemove };
  const parts = useRef<Part[]>([]), savedSelection = useRef<EditorSelection>({ start: 0, end: 0 });
  const currentDraft = useRef(''), previewProp = useRef<string[]>([]), lastValue = useRef('');
  const normalizeFrame = useRef(0);
  const nativeEdit = useRef<{ draftId: string; parts: Part[]; selection: EditorSelection; applied: boolean } | null>(null);
  const hosts = useRef(new Map<string, HTMLSpanElement>());
  const hostSequence = useRef(0);
  const [slots, setSlots] = useState<{ key: string; host: HTMLSpanElement; part: ReferencePart }[]>([]);

  function readSelection() {
    const root = inputRef.current;
    if (!root) return savedSelection.current;
    const current = document.activeElement === root ? selectionIn(root) : undefined;
    if (current) savedSelection.current = current;
    return current || savedSelection.current;
  }

  function render(next: Part[], selection?: EditorSelection) {
    const root = inputRef.current; if (!root) return;
    nativeEdit.current = null; cancelAnimationFrame(normalizeFrame.current);
    parts.current = compact(next);
    const nodes: Node[] = [document.createTextNode('')], nextSlots: typeof slots = [];
    const caretLine = () => { const line = document.createElement('br'); line.dataset.editorTail = 'true'; nodes.push(line); };
    for (const part of parts.current) {
      if (part.kind === 'text') nodes.push(document.createTextNode(part.text));
      else {
        if (nodes.at(-1)?.nodeType === Node.TEXT_NODE && nodes.at(-1)?.textContent?.endsWith('\n')) caretLine();
        const key = part.hostKey ??= `reference-${++hostSequence.current}`;
        const host = hosts.current.get(key) || document.createElement('span'); hosts.current.set(key, host);
        host.className = 'inline-reference-node'; host.contentEditable = 'false';
        host.dataset.editorReference = part.reference.id; host.dataset.editorKind = part.reference.kind; host.dataset.editorPreview = String(!!part.preview);
        host.dataset.editorHost = key;
        nodes.push(host, document.createTextNode('')); nextSlots.push({ key, host, part });
      }
    }
    const lastPart = parts.current.at(-1);
    if (lastPart?.kind === 'text' && lastPart.text.endsWith('\n')) {
      caretLine(); nodes.push(document.createTextNode(''));
    }
    if (nodes.at(-1)?.nodeType !== Node.TEXT_NODE) nodes.push(document.createTextNode(''));
    root.replaceChildren(...nodes);
    const activeHosts = new Set(nextSlots.map(slot => slot.key));
    for (const key of hosts.current.keys()) if (!activeHosts.has(key)) hosts.current.delete(key);
    root.dataset.empty = String(!parts.current.length);
    setSlots(nextSlots);
    if (selection) { savedSelection.current = selection; placeSelection(root, selection); }
  }

  function emit(next: Part[], selection: EditorSelection, normalize = true) {
    const removedPreviews = parts.current.filter((part): part is ReferencePart => part.kind === 'reference' && !!part.preview && !next.some(value => value.kind === 'reference' && value.preview && value.hostKey === part.hostKey));
    parts.current = next; savedSelection.current = selection;
    if (inputRef.current) inputRef.current.dataset.empty = String(!next.length);
    if (normalize) render(next, document.activeElement === inputRef.current ? selection : undefined);
    const value = serialize(next), key = valueKey(value);
    if (key !== lastValue.current) { lastValue.current = key; props.current.onChange(value); }
    if (!composing.current) props.current.onCaret(caretIn(next, selection));
    removedPreviews.forEach(part => props.current.onPreviewRemove(part.reference.id));
  }

  function settleNative() {
    const work = nativeEdit.current;
    if (work?.applied) emit(work.parts, inputRef.current && selectionIn(inputRef.current) || savedSelection.current);
  }

  function confirmPreview() {
    settleNative();
    if (props.current.disabled || !parts.current.some(part => part.kind === 'reference' && part.preview)) return;
    const selection = readSelection();
    const next = parts.current.map(part => part.kind === 'reference' && part.preview ? { ...part, preview: false } : part);
    emit(next, selection);
    props.current.onConsumePreview();
  }

  function remove(entry: ReferencePart) {
    settleNative();
    if (props.current.disabled) return;
    const selection = readSelection();
    let cursor = 0, beforeStart = 0, beforeEnd = 0;
    const next = parts.current.filter(part => {
      const removed = part.kind === 'reference' && part.hostKey === entry.hostKey;
      if (removed) { if (cursor < selection.start) beforeStart++; if (cursor < selection.end) beforeEnd++; }
      cursor += partLength(part); return !removed;
    });
    emit(next, { start: selection.start - beforeStart, end: selection.end - beforeEnd });
  }

  function insertReference(entry: RequestReference, query?: { start: number; end: number }) {
    settleNative();
    if (props.current.disabled) return;
    const base = withoutPreview(parts.current, readSelection());
    const end = Math.min(documentLength(base.parts), base.selection.end), start = query ? Math.max(0, end - (query.end - query.start)) : base.selection.start;
    const next = splice(base.parts, start, end, [{ kind: 'reference', reference: entry }]);
    const caret = start + 1;
    inputRef.current?.focus({ preventScroll: true });
    emit(next, { start: caret, end: caret }); props.current.onConsumePreview();
  }
  controller.current = { confirmPreview, insertReference };

  useLayoutEffect(() => {
    const root = inputRef.current; if (!root || composing.current || nativeEdit.current?.applied && nativeEdit.current.draftId === draft.id) return;
    const changedDraft = currentDraft.current !== draft.id;
    const key = valueKey(draft);
    if (changedDraft || key !== valueKey(serialize(readParts(root)))) {
      const selected = changedDraft ? undefined : document.activeElement === root ? readSelection() : undefined;
      const next = referenceParts(draft.text, referenceOrder(draft.references, draft.text));
      const length = documentLength(next);
      currentDraft.current = draft.id;
      if (changedDraft) previewProp.current = [];
      savedSelection.current = selected ? { start: Math.min(length, selected.start), end: Math.min(length, selected.end) } : { start: length, end: length };
      render(next, selected ? savedSelection.current : undefined);
    }
    lastValue.current = key;
    if (previewProp.current !== preview) {
      const activeSelection = readSelection(), base = withoutPreview(parts.current, activeSelection);
      const anchor = Math.min(documentLength(base.parts), base.selection.backward ? base.selection.start : base.selection.end);
      const next = splice(base.parts, anchor, anchor, preview.map(id => ({ kind: 'reference' as const, reference: { kind: 'object' as const, id }, preview: true })));
      const focused = document.activeElement === root;
      render(next, focused ? base.selection : undefined);
      if (!focused) savedSelection.current = base.selection;
      previewProp.current = preview;
    }
  }, [draft.id, draft.text, draft.references, preview]);

  useLayoutEffect(() => {
    const selection = () => {
      const root = inputRef.current; if (!root || document.activeElement !== root || composing.current) return;
      const current = selectionIn(root); if (!current) return;
      savedSelection.current = current; props.current.onCaret(caretIn(readParts(root), current));
    };
    document.addEventListener('selectionchange', selection);
    const root = inputRef.current!;
    const beforeInput = (event: InputEvent) => {
      nativeEdit.current = null;
      if (props.current.disabled || composing.current || event.isComposing || event.defaultPrevented) return;
      const text = ['insertParagraph', 'insertLineBreak'].includes(event.inputType) ? '\n' : ['insertText', 'insertReplacementText'].includes(event.inputType) ? event.data : null;
      if (text === null) return;
      const range = event.getTargetRanges()[0];
      const selection = range ? { start: positionIn(root, range.startContainer, range.startOffset), end: positionIn(root, range.endContainer, range.endOffset) } : readSelection();
      const next = splice(parts.current, selection.start, selection.end, [{ kind: 'text', text }]), caret = selection.start + text.length;
      nativeEdit.current = { draftId: props.current.draft.id, parts: next, selection: { start: caret, end: caret }, applied: false };
    };
    root.addEventListener('beforeinput', beforeInput);
    return () => { document.removeEventListener('selectionchange', selection); root.removeEventListener('beforeinput', beforeInput); cancelAnimationFrame(normalizeFrame.current); controller.current = null; };
  }, []);

  function insertText(text: string) {
    const current = readSelection(), next = splice(readParts(inputRef.current!), current.start, current.end, [{ kind: 'text', text }]);
    const caret = current.start + text.length; emit(next, { start: caret, end: caret });
  }

  return <><div ref={inputRef} id="instruction" className="chatbox-editor" contentEditable={!disabled} suppressContentEditableWarning tabIndex={0} role="combobox" aria-label="Request" aria-multiline="true" aria-autocomplete="list" aria-expanded={expanded} aria-controls={expanded ? 'reference-search' : undefined} aria-activedescendant={activeDescendant} aria-disabled={disabled} data-placeholder={placeholder} onPointerDown={event => { settleNative(); if (event.isTrusted) onUserPointer(); }} onFocus={() => { settleNative(); placeSelection(inputRef.current!, savedSelection.current); onFocus(); }} onBlur={settleNative} onInput={() => {
    if (disabled) return;
    const work = nativeEdit.current;
    if (work && work.draftId === props.current.draft.id && !composing.current) { work.applied = true; emit(work.parts, work.selection, false); }
    else emit(readParts(inputRef.current!), readSelection(), false);
    cancelAnimationFrame(normalizeFrame.current);
    if (!composing.current) {
      const draftId = props.current.draft.id;
      normalizeFrame.current = requestAnimationFrame(() => {
        if (!inputRef.current || props.current.draft.id !== draftId || composing.current) return;
        const work = nativeEdit.current;
        if (work?.applied) settleNative();
        else emit(readParts(inputRef.current), readSelection());
      });
    }
  }} onCompositionStart={() => { nativeEdit.current = null; cancelAnimationFrame(normalizeFrame.current); composing.current = true; onComposition(true); }} onCompositionEnd={() => {
    composing.current = false; onComposition(false); const next = readParts(inputRef.current!); emit(next, readSelection());
  }} onPaste={event => {
    if (disabled || !event.clipboardData || Array.from(event.clipboardData.items).some(item => item.kind === 'file')) return;
    event.preventDefault(); insertText(event.clipboardData.getData('text/plain'));
  }} onDrop={event => {
    if (disabled || event.dataTransfer.types.includes('Files')) return;
    event.preventDefault(); insertText(event.dataTransfer.getData('text/plain'));
  }} onKeyDown={event => {
    settleNative();
    onKeyDown(event);
    if (event.defaultPrevented || disabled || composing.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    if (event.key === 'Enter') { event.preventDefault(); insertText('\n'); return; }
    if (!['Backspace', 'Delete', 'ArrowLeft', 'ArrowRight'].includes(event.key) || event.metaKey || event.ctrlKey || event.altKey) return;
    const current = readSelection(), next = readParts(inputRef.current!);
    let cursor = 0;
    const tokens = next.flatMap(part => { const start = cursor; cursor += partLength(part); return part.kind === 'reference' ? [{ start, part }] : []; });
    if (current.start !== current.end) {
      if (['Backspace', 'Delete'].includes(event.key)) { event.preventDefault(); emit(splice(next, current.start, current.end, []), { start: current.start, end: current.start }); }
      return;
    }
    const backward = event.key === 'Backspace' || event.key === 'ArrowLeft';
    const token = tokens.find(token => backward ? token.start + 1 === current.start : token.start === current.start);
    if (!token) return;
    event.preventDefault();
    if (event.key === 'Backspace' || event.key === 'Delete') emit(splice(next, token.start, token.start + 1, []), { start: token.start, end: token.start });
    else { const caret = current.start + (backward ? -1 : 1); const selected = event.shiftKey ? { start: Math.min(current.start, caret), end: Math.max(current.end, caret), backward } : { start: caret, end: caret }; savedSelection.current = selected; placeSelection(inputRef.current!, selected); props.current.onCaret(caretIn(next, selected)); }
  }}/>{slots.map(slot => createPortal(<ChatboxReference entry={slot.part.reference} draft={draft} preview={slot.part.preview} objects={objects} assets={assets} tasks={tasks} content={content} disabled={disabled} onConfirm={confirmPreview} onRemove={() => remove(slot.part)}/>, slot.host, slot.key))}</>;
}
