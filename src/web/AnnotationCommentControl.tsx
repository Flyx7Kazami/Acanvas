import { useLayoutEffect, useRef, type ReactNode, type RefObject } from 'react';
import { ArrowLeft, ArrowUp, LoaderCircle } from 'lucide-react';

export type AnnotationCommentControlProps = {
  text: string;
  mode: 'display' | 'view' | 'edit';
  inputLabel: string;
  className?: string;
  controlRef?: RefObject<HTMLDivElement | null>;
  inputRef?: RefObject<HTMLTextAreaElement | null>;
  compositionRef?: RefObject<boolean>;
  annotationId?: string;
  regionLabel?: string;
  controls?: boolean;
  disabled?: boolean;
  saving?: boolean;
  backLabel?: string;
  submitLabel?: string;
  onBack?: () => void;
  onSubmit?: () => void;
  onChange?: (text: string) => void;
  onOpen?: () => void;
  children?: ReactNode;
};

export function AnnotationCommentControl({ text, mode, inputLabel, className = '', controlRef, inputRef, compositionRef, annotationId, regionLabel, controls = true, disabled, saving, backLabel = 'Back to selection tools', submitLabel = 'Save comment', onBack, onSubmit, onChange, onOpen, children }: AnnotationCommentControlProps) {
  const ownInput = useRef<HTMLTextAreaElement>(null), ownComposition = useRef(false);
  const composing = compositionRef || ownComposition;
  const input = inputRef || ownInput;
  useLayoutEffect(() => {
    const textarea = input.current;
    if (!textarea) return;
    let width = 0;
    const layout = () => { textarea.style.height = '20px'; textarea.style.height = `${Math.min(80, Math.max(20, textarea.scrollHeight))}px`; };
    const observer = new ResizeObserver(() => { if (textarea.clientWidth !== width) { width = textarea.clientWidth; layout(); } });
    observer.observe(textarea); layout();
    return () => observer.disconnect();
  }, [input, text]);
  const button = (label: string, icon: ReactNode, action?: () => void, blocked = false) => <button type="button" className="icon-button" title={label} aria-label={label} aria-hidden={mode === 'display' || undefined} tabIndex={mode === 'display' ? -1 : undefined} disabled={blocked} onClick={action}>{icon}</button>;
  return <div ref={controlRef} className={`selection-actions comment-control ${className}`} role={regionLabel ? 'region' : undefined} aria-label={regionLabel} data-canvas-control={mode !== 'display' || !!onOpen || undefined} data-comment-editable={!!onOpen || undefined} data-annotation-id={annotationId} data-comment-mode={mode} onPointerDown={mode === 'display' && !onOpen ? undefined : event => event.stopPropagation()} onClick={mode === 'display' ? onOpen : undefined} onKeyDown={event => { event.stopPropagation(); if (event.key === 'Enter' && mode === 'display' && onOpen) { event.preventDefault(); onOpen(); } if (event.key === 'Escape' && !composing.current && !event.nativeEvent.isComposing) { event.preventDefault(); onBack?.(); } }}>
    <form onSubmit={event => { event.preventDefault(); if (!composing.current) onSubmit?.(); }}>
      {controls && button(backLabel, <ArrowLeft size={15}/>, onBack, disabled || mode === 'display')}
      <textarea ref={input} rows={1} aria-label={inputLabel} placeholder="Add a comment…" value={text} readOnly={mode !== 'edit'} tabIndex={mode === 'display' && !onOpen ? -1 : undefined} disabled={disabled} onChange={event => onChange?.(event.target.value)} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }} onKeyDown={event => { if (!controls || event.key !== 'Enter' || event.shiftKey || composing.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229 || mode !== 'edit') return; event.preventDefault(); onSubmit?.(); }}/>
      {controls && button(submitLabel, saving ? <LoaderCircle size={14} className="spin"/> : <ArrowUp size={14}/>, onSubmit, disabled || mode !== 'edit' || !text.trim())}
    </form>
    {children}
  </div>;
}
