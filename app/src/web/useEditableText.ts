import { useCallback, useEffect, useRef, useState } from 'react';
import { editableTextBytes } from '../shared/content-types';
import type { ContentSaveResult, RegisterContentEditor } from './content-editing';
import { acquireTextSource } from './text-source';

type SaveText = (text: string, expectedVersion?: number) => Promise<ContentSaveResult | void>;

type Options = {
  objectId?: string;
  objectVersion?: number;
  sessionId?: string;
  register?: RegisterContentEditor;
  onDirtyChange?: (dirty: boolean) => void;
  onCompositionChange?: (composing: boolean) => void;
};

const abandonedContent = new Map<string, { text: string; expectedVersion?: number }>();

/**
 * Text editing is local until the page's mutation queue saves it. The source
 * version is kept with the edit so an external object change is reported by
 * the service instead of being silently overwritten by a late autosave.
 */
export function useEditableText(src: string, save: SaveText, onError?: (cause: unknown) => void, options: Options = {}) {
  const [text, setText] = useState<string>();
  const saved = useRef<string | undefined>(undefined);
  const pending = useRef<string | undefined>(undefined);
  const baselineVersion = useRef<number | undefined>(options.objectVersion);
  const edited = useRef(false);
  const timer = useRef(0);
  const tail = useRef(Promise.resolve());
  const generation = useRef(0);
  const saveGeneration = useRef(0);
  const saveRef = useRef(save);
  saveRef.current = save;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const objectVersionRef = useRef(options.objectVersion);
  objectVersionRef.current = options.objectVersion;
  const identityKey = options.sessionId && options.objectId ? `${options.sessionId}:${options.objectId}` : '';
  const dirtyListener = useRef(options.onDirtyChange);
  dirtyListener.current = options.onDirtyChange;
  const compositionListener = useRef(options.onCompositionChange);
  compositionListener.current = options.onCompositionChange;
  const reportDirty = useCallback((dirty: boolean) => { dirtyListener.current?.(dirty); }, []);

  const isDirty = useCallback(() => pending.current !== undefined && pending.current !== saved.current, []);

  const flush = useCallback(() => {
    window.clearTimeout(timer.current);
    if (composing.current) return Promise.resolve();
    const run = tail.current.catch(() => undefined).then(async () => {
      if (pending.current === undefined) return;
      while (pending.current !== undefined && (saved.current === undefined || pending.current !== saved.current)) {
        const next: string = pending.current;
        const bytes = new TextEncoder().encode(next);
        if (bytes.byteLength > editableTextBytes) throw new Error('Notes and Markdown stay within 2 MB.');
        const result = await saveRef.current(next, baselineVersion.current);
        saved.current = next;
        edited.current = pending.current !== saved.current;
        reportDirty(edited.current);
        if (result) baselineVersion.current = result.version;
        else if (baselineVersion.current !== undefined) baselineVersion.current += 1;
        saveGeneration.current += 1;
      }
      edited.current = pending.current !== saved.current;
      reportDirty(edited.current);
      if (identityKey) {
        if (edited.current && pending.current !== undefined) abandonedContent.set(identityKey, { text: pending.current, expectedVersion: baselineVersion.current });
        else abandonedContent.delete(identityKey);
      }
    });
    tail.current = run.then(() => undefined, cause => { onErrorRef.current?.(cause); });
    return run;
  }, [identityKey]);

  const composing = useRef(false);
  const setComposing = useCallback((active: boolean) => {
    composing.current = active;
    compositionListener.current?.(active);
    if (!active) queueMicrotask(() => { if (!composing.current) void flush(); });
  }, [flush]);

  useEffect(() => {
    const currentGeneration = ++generation.current;
    const currentSaveGeneration = saveGeneration.current;
    const request = acquireTextSource(src);
    let active = true;
    void (async () => {
      try {
        const source = await request.promise;
        if (!active || currentGeneration !== generation.current || currentSaveGeneration !== saveGeneration.current) return;
        if (baselineVersion.current !== undefined && objectVersionRef.current !== undefined && baselineVersion.current > objectVersionRef.current && source !== saved.current) return;

        // A history replay or an external update is safe to adopt when this
        // editor has no unsaved text. A dirty editor keeps its local text and
        // submits against its original object version, allowing the service to
        // return the normal object conflict.
        if (saved.current === undefined) {
          saved.current = source;
          const recovered = identityKey ? abandonedContent.get(identityKey) : undefined;
          if (recovered) {
            pending.current = recovered.text;
            baselineVersion.current = recovered.expectedVersion;
            edited.current = pending.current !== source;
            reportDirty(edited.current);
            setText(recovered.text);
            if (!edited.current && identityKey) abandonedContent.delete(identityKey);
          } else {
            baselineVersion.current = objectVersionRef.current;
            if (pending.current === undefined) pending.current = source;
            if (pending.current === source) { edited.current = false; reportDirty(false); setText(source); }
            else void flush();
          }
        } else if (!isDirty()) {
          pending.current = source;
          saved.current = source;
          edited.current = false;
          reportDirty(false);
          baselineVersion.current = objectVersionRef.current;
          setText(source);
        } else if (pending.current === source) {
          saved.current = source;
          edited.current = false;
          reportDirty(false);
          baselineVersion.current = objectVersionRef.current;
          setText(source);
        }
      } catch (cause) {
        if (active && currentGeneration === generation.current) onErrorRef.current?.(cause);
      }
    })();
    return () => {
      active = false; request.release(); window.clearTimeout(timer.current);
      if (identityKey && isDirty() && pending.current !== undefined) abandonedContent.set(identityKey, { text: pending.current, expectedVersion: baselineVersion.current });
      void flush().catch(() => undefined);
    };
  }, [identityKey, isDirty, src]);

  useEffect(() => {
    if (!isDirty() && options.objectVersion !== undefined) baselineVersion.current = options.objectVersion;
  }, [isDirty, options.objectVersion]);

  const register = options.register;
  const sessionId = options.sessionId;
  const objectId = options.objectId;
  useEffect(() => {
    if (!register || !sessionId || !objectId) return;
    return register({ sessionId, objectId, flush, isDirty, isComposing: () => composing.current });
  }, [flush, isDirty, objectId, register, sessionId]);

  const change = useCallback((value: string) => {
    edited.current = true;
    reportDirty(true);
    pending.current = value;
    if (identityKey) abandonedContent.set(identityKey, { text: value, expectedVersion: baselineVersion.current });
    setText(value);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void flush(), 400);
  }, [flush]);

  return { text, change, flush, isDirty, setComposing };
}
