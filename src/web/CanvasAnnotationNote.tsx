import { useLayoutEffect, useRef, type RefObject } from 'react';
import type { SessionView } from '../shared/types';
import { screenBounds, type Rect } from './geometry';
import { AnnotationBubble } from './AnnotationBubble';
import { AnnotationCommentControl, type AnnotationCommentControlProps } from './AnnotationCommentControl';

export function CanvasAnnotationNote({ canvas, bounds, view, annotationId, number, active, control, onOpen }: { canvas: RefObject<HTMLDivElement | null>; bounds: Rect; view: SessionView; annotationId: string; number: number; active: boolean; control: AnnotationCommentControlProps; onOpen: () => void }) {
  const group = useRef<HTMLDivElement>(null), element = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const board = canvas.current, node = group.current, note = element.current;
    if (!board || !node || !note) return;
    const previous = [...board.querySelectorAll<HTMLElement>('.canvas-annotation-group')].filter(value => !!(node.compareDocumentPosition(value) & Node.DOCUMENT_POSITION_PRECEDING));
    const layout = () => {
      const region = screenBounds(bounds, view), height = Math.max(28, note.offsetHeight);
      node.dataset.anchorX = String(bounds.x); node.dataset.anchorY = String(bounds.y);
      const offset = previous.filter(value => Number(value.dataset.anchorX) === bounds.x && Number(value.dataset.anchorY) === bounds.y).reduce((sum, value) => sum + value.offsetHeight + 8, 0);
      node.style.left = `${region.x}px`; node.style.top = `${region.y - 8 - height - offset}px`; node.style.height = `${height}px`;
      note.dataset.positioned = 'true';
    };
    const observer = new ResizeObserver(layout);
    [note, ...previous].forEach(value => observer.observe(value)); layout();
    return () => observer.disconnect();
  });
  return <div ref={group} className="canvas-annotation-group" data-annotation-id={annotationId} data-active={active || undefined}>
    <button type="button" data-canvas-control className="annotation-pin" title={control.text} aria-label={`Annotation ${number}: ${control.text}`} onPointerDown={event => event.stopPropagation()} onClick={onOpen}><AnnotationBubble number={number} size={28}/></button>
    <AnnotationCommentControl {...control} controlRef={element} annotationId={annotationId} className={`canvas-annotation-note context-control${active ? ' inline-annotation-reader' : ' canvas-annotation-comment'}`}/>
  </div>;
}
