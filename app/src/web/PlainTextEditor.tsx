import { useLayoutEffect, useRef, type KeyboardEvent } from 'react';

export function PlainTextEditor({ value, label, className, variant, placeholder, disabled, readOnly, onChange, onBlur, onFocus, onCompositionStart, onCompositionEnd }: { value: string; label: string; className: string; variant: 'note' | 'markdown'; placeholder?: string; disabled?: boolean; readOnly?: boolean; onChange: (value: string) => void; onBlur?: () => void; onFocus?: () => void; onCompositionStart?: () => void; onCompositionEnd?: () => void }) {
  const mirror = useRef<HTMLDivElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const previousValue = useRef(value);
  const selection = useRef({ start: 0, end: 0, direction: 'none' as 'forward' | 'backward' | 'none' });
  const rememberSelection = (element: HTMLTextAreaElement) => { selection.current = { start: element.selectionStart, end: element.selectionEnd, direction: element.selectionDirection }; };
  const sync = (scrollTop: number, scrollLeft: number) => { if (mirror.current) { mirror.current.scrollTop = scrollTop; mirror.current.scrollLeft = scrollLeft; } };
  useLayoutEffect(() => {
    const element = textarea.current, previous = previousValue.current;
    previousValue.current = value;
    if (!element || previous === value || document.activeElement !== element) return;
    const start = Math.min(selection.current.start, value.length), end = Math.min(selection.current.end, value.length);
    element.setSelectionRange(start, end, selection.current.direction);
  }, [value]);
  return <div className={`plain-text-field ${variant}`}>
    <div ref={mirror} className="plain-text-mirror" aria-hidden="true">{value}</div>
    <textarea ref={textarea} className={className} aria-label={label} placeholder={placeholder} value={value} disabled={disabled} readOnly={readOnly} spellCheck onChange={event => { rememberSelection(event.target); onChange(event.target.value); sync(event.target.scrollTop, event.target.scrollLeft); }} onSelect={event => rememberSelection(event.currentTarget)} onScroll={event => sync(event.currentTarget.scrollTop, event.currentTarget.scrollLeft)} onBlur={onBlur} onFocus={event => { rememberSelection(event.currentTarget); onFocus?.(); }} onCompositionStart={onCompositionStart} onCompositionEnd={onCompositionEnd} onKeyDown={(event: KeyboardEvent<HTMLTextAreaElement>) => { if (event.key === 'Escape') { event.preventDefault(); event.currentTarget.blur(); } }}/>
  </div>;
}
