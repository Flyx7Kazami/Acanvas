import { useEffect, useRef, useState } from 'react';
import { editableTextBytes } from '../shared/content-types';

export function useEditableText(src: string, save: (text: string) => Promise<void>, onError?: (cause: unknown) => void) {
  const [text, setText] = useState<string>();
  const saved = useRef<string | undefined>(undefined);
  const pending = useRef<string | undefined>(undefined);
  const edited = useRef(false);
  const timer = useRef(0);
  const tail = useRef(Promise.resolve());
  const saveRef = useRef(save);
  saveRef.current = save;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const flush = useRef(() => {
    window.clearTimeout(timer.current);
    const run = tail.current.catch(() => undefined).then(async () => {
      if (saved.current === undefined) return;
      while (pending.current !== undefined && pending.current !== saved.current) {
        const next: string = pending.current ?? '';
        const bytes = new TextEncoder().encode(next);
        if (bytes.byteLength > editableTextBytes) throw new Error('Notes and Markdown stay within 2 MB.');
        await saveRef.current(next);
        saved.current = next;
      }
    });
    tail.current = run.then(() => undefined, cause => { onErrorRef.current?.(cause); });
    return run;
  });
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(src, { credentials: 'same-origin', signal: controller.signal });
        if (!response.ok) throw new Error('The text is unavailable.');
        const length = Number(response.headers.get('Content-Length'));
        if (length > editableTextBytes) throw new Error('Notes and Markdown stay within 2 MB.');
        const source = await response.text();
        if (new TextEncoder().encode(source).byteLength > editableTextBytes) throw new Error('Notes and Markdown stay within 2 MB.');
        if (controller.signal.aborted) return;
        if (!edited.current) { pending.current = source; setText(source); }
        saved.current = source;
        if (edited.current && pending.current !== source) void flush.current();
      } catch (cause) { if (!controller.signal.aborted) onErrorRef.current?.(cause); }
    })();
    return () => { controller.abort(); window.clearTimeout(timer.current); void flush.current(); };
  }, [src]);
  const change = (value: string) => {
    edited.current = true;
    pending.current = value;
    setText(value);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void flush.current(), 400);
  };
  return { text, change, flush: () => flush.current() };
}
