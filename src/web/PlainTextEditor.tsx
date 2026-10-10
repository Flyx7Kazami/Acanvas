import { useRef, type KeyboardEvent } from 'react';

export function PlainTextEditor({ value, label, className, variant, placeholder, disabled, onChange, onBlur, onFocus }: { value: string; label: string; className: string; variant: 'note' | 'markdown'; placeholder?: string; disabled?: boolean; onChange: (value: string) => void; onBlur?: () => void; onFocus?: () => void }) {
  const mirror = useRef<HTMLDivElement>(null);
  const sync = (scrollTop: number, scrollLeft: number) => { if (mirror.current) { mirror.current.scrollTop = scrollTop; mirror.current.scrollLeft = scrollLeft; } };
  return <div className={`plain-text-field ${variant}`}>
    <div ref={mirror} className="plain-text-mirror" aria-hidden="true">{value}</div>
    <textarea className={className} aria-label={label} placeholder={placeholder} value={value} disabled={disabled} spellCheck onChange={event => { onChange(event.target.value); sync(event.target.scrollTop, event.target.scrollLeft); }} onScroll={event => sync(event.currentTarget.scrollTop, event.currentTarget.scrollLeft)} onBlur={onBlur} onFocus={onFocus} onKeyDown={(event: KeyboardEvent<HTMLTextAreaElement>) => { if (event.key === 'Escape') { event.preventDefault(); event.currentTarget.blur(); } }}/>
  </div>;
}
