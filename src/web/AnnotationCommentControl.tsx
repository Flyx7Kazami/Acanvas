import { useRef, type ReactNode, type RefObject } from 'react';

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
  disabled?: boolean;
  onBack?: () => void;
  onDone?: () => void;
  onChange?: (text: string) => void;
  onOpen?: () => void;
  mediaControl?: ReactNode;
  children?: ReactNode;
};

export function AnnotationCommentControl({ text, mode, inputLabel, className = '', controlRef, inputRef, compositionRef, annotationId, regionLabel, disabled, onBack, onDone, onChange, onOpen, mediaControl, children }: AnnotationCommentControlProps) {
  const ownInput = useRef<HTMLTextAreaElement>(null), ownComposition = useRef(false);
  const composing = compositionRef || ownComposition;
  const input = inputRef || ownInput;
  if (mode === 'display') return <div ref={controlRef} className={`canvas-annotation-note canvas-annotation-comment ${className}`} data-annotation-id={annotationId} data-comment-mode="display" data-canvas-control onPointerDown={event => event.stopPropagation()}>
    <button type="button" className="canvas-annotation-summary" title={text} aria-label={inputLabel} onClick={onOpen}>{text.split('\n').find(line => line.trim()) || 'Add a comment'}</button>
  </div>;
  return <div ref={controlRef} className={`canvas-annotation-note annotation-full inline-annotation-reader ${className}`} role="region" aria-label={regionLabel || 'Annotation'} data-canvas-control data-annotation-id={annotationId} data-comment-mode={mode} onPointerDown={event => event.stopPropagation()} onKeyDown={event => {
    event.stopPropagation();
    if (composing.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    if (event.key === 'Escape') { event.preventDefault(); onBack?.(); }
    else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); (onDone || onBack)?.(); }
  }}>
    <div className="annotation-full-body">{mode === 'edit' ? <textarea ref={input} className="annotation-fulltext" data-canvas-wheel="content" rows={4} aria-label={inputLabel} placeholder="Add a comment…" value={text} disabled={disabled} onChange={event => onChange?.(event.target.value)} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}/>
      : <div className="annotation-fulltext" data-canvas-wheel="content" tabIndex={0} aria-label={inputLabel}>{text}</div>}
    </div>
    {mediaControl && <div className="annotation-media-control">{mediaControl}</div>}
    <div className="annotation-footer"><div className="annotation-context">{children}</div><button type="button" className="annotation-done" aria-label={mode === 'edit' ? 'Done' : 'Close annotation'} disabled={disabled} onClick={onDone || onBack}>{mode === 'edit' ? 'Done' : 'Close'}</button></div>
  </div>;
}
