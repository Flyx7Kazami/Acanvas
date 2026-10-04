import { useLayoutEffect, useRef, type RefObject } from 'react';
import type { Rect } from './geometry';
import { AnnotationBubble } from './AnnotationBubble';
import { AnnotationCommentControl, type AnnotationCommentControlProps } from './AnnotationCommentControl';

export function CanvasAnnotationNote({ canvas, bounds, annotationId, number, active, control, onOpen }: { canvas: RefObject<HTMLDivElement | null>; bounds: Rect; annotationId: string; number: number; active: boolean; control: AnnotationCommentControlProps; onOpen: () => void }) {
  const group = useRef<HTMLDivElement>(null), element = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const board = canvas.current, node = group.current, note = element.current;
    if (!board || !node || !note) return;
    const previous = [...board.querySelectorAll<HTMLElement>('.canvas-annotation-group')].filter(value => !!(node.compareDocumentPosition(value) & Node.DOCUMENT_POSITION_PRECEDING));
    const layout = () => {
      const height = Math.max(28, note.offsetHeight);
      node.dataset.anchorX = String(bounds.x); node.dataset.anchorY = String(bounds.y);
      const offset = previous.filter(value => Number(value.dataset.anchorX) === bounds.x && Number(value.dataset.anchorY) === bounds.y).reduce((sum, value) => sum + value.offsetHeight + 8, 0);
      node.style.left = `${bounds.x}px`; node.style.top = `${bounds.y - 8 - height - offset}px`; node.style.height = `${height}px`;
      node.dataset.positioned = 'true';
      const viewport = board.getBoundingClientRect(), rect = node.getBoundingClientRect();
      node.inert = rect.right <= viewport.left || rect.left >= viewport.right || rect.bottom <= viewport.top || rect.top >= viewport.bottom;
    };
    const observer = new ResizeObserver(layout);
    [board, note, ...previous].forEach(value => observer.observe(value)); layout();
    return () => observer.disconnect();
  });
  return <div ref={group} className="canvas-annotation-group" data-annotation-id={annotationId} data-active={active || undefined} data-canvas-control>
    <button type="button" className="annotation-pin" title={control.text} aria-label={`Annotation ${number}: ${control.text || 'Add a comment'}`} onPointerDown={event => event.stopPropagation()} onClick={onOpen}><AnnotationBubble number={number} size={28}/></button>
    <AnnotationCommentControl {...control} controlRef={element} annotationId={annotationId}/>
  </div>;
}
