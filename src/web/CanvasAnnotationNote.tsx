import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';
import type { SessionView } from '../shared/types';
import { screenBounds, type Rect } from './geometry';
import { AnnotationBubble } from './AnnotationBubble';
import { AnnotationCommentControl, type AnnotationCommentControlProps } from './AnnotationCommentControl';

type NoteLayout = { expanded: boolean; width: number; height: number; padding: string; backgroundColor: string; borderRadius: string; boxShadow: string };

export function CanvasAnnotationNote({ canvas, bounds, view, annotationId, number, active, control, onOpen }: { canvas: RefObject<HTMLDivElement | null>; bounds: Rect; view: SessionView; annotationId: string; number: number; active: boolean; control: AnnotationCommentControlProps; onOpen: () => void }) {
  const group = useRef<HTMLDivElement>(null), element = useRef<HTMLDivElement>(null);
  const remembered = useRef<NoteLayout | null>(null), animations = useRef<Animation[]>([]);
  const expanded = control.mode !== 'display';
  useLayoutEffect(() => {
    const board = canvas.current, node = group.current, note = element.current;
    if (!board || !node || !note) return;
    const before = remembered.current, changing = before && before.expanded !== expanded;
    const moving = animations.current.some(animation => animation.playState === 'running' || animation.playState === 'paused');
    const position = node.getBoundingClientRect(), visual = note.getBoundingClientRect(), visualStyle = getComputedStyle(note);
    const from = moving ? { width: visual.width, height: visual.height, padding: visualStyle.padding, backgroundColor: visualStyle.backgroundColor, borderRadius: visualStyle.borderRadius, boxShadow: visualStyle.boxShadow } : before;
    if (changing) { animations.current.forEach(animation => animation.cancel()); animations.current = []; }
    const style = getComputedStyle(note);
    const target: NoteLayout = changing || !moving ? { expanded, width: note.offsetWidth, height: Math.max(28, note.offsetHeight), padding: style.padding, backgroundColor: style.backgroundColor, borderRadius: style.borderRadius, boxShadow: style.boxShadow } : { ...before!, expanded };
    remembered.current = target;
    const previous = [...board.querySelectorAll<HTMLElement>('.canvas-annotation-group')].filter(value => !!(node.compareDocumentPosition(value) & Node.DOCUMENT_POSITION_PRECEDING));
    const layout = () => {
      const anchor = screenBounds(bounds, view), height = target.height;
      const offset = previous.filter(value => Number(value.dataset.anchorX) === bounds.x && Number(value.dataset.anchorY) === bounds.y).reduce((sum, value) => sum + value.offsetHeight + 8, 0);
      const viewport = board.getBoundingClientRect(), rect = node.getBoundingClientRect(), transform = new DOMMatrix(getComputedStyle(node).transform);
      const top = anchor.y - 8 - height - offset, left = anchor.x;
      node.dataset.anchorX = String(bounds.x); node.dataset.anchorY = String(bounds.y);
      node.style.left = `${left}px`; node.style.top = `${top}px`; node.style.height = `${height}px`;
      node.dataset.positioned = 'true';
      node.inert = left + transform.m41 + rect.width <= 0 || left + transform.m41 >= viewport.width || top + transform.m42 + rect.height <= 0 || top + transform.m42 >= viewport.height;
      return { left, top, viewport };
    };
    const destination = layout();
    if (changing && from && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
      const options = { duration: 260, easing: 'cubic-bezier(.16,1,.3,1)' };
      const frame = (value: typeof from) => ({ width: `${value.width}px`, height: `${value.height}px`, padding: value.padding, backgroundColor: value.backgroundColor, borderRadius: value.borderRadius, boxShadow: value.boxShadow });
      const y = position.y - destination.viewport.y - destination.top;
      animations.current = [
        note.animate([frame(from), frame(target)], options),
        node.animate([{ transform: `translateY(${y}px)`, height: `${from.height}px` }, { transform: 'translateY(0)', height: `${target.height}px` }], options),
      ];
    }
    const observer = new ResizeObserver(layout);
    [board, note, ...previous].forEach(value => observer.observe(value));
    return () => observer.disconnect();
  });
  useEffect(() => {
    const reduced = matchMedia('(prefers-reduced-motion: reduce)');
    const stop = () => { if (reduced.matches) animations.current.forEach(animation => animation.cancel()); };
    reduced.addEventListener('change', stop);
    return () => { reduced.removeEventListener('change', stop); animations.current.forEach(animation => animation.cancel()); };
  }, []);
  return <div ref={group} className="canvas-annotation-group" data-annotation-id={annotationId} data-active={active || undefined} data-canvas-control>
    <button type="button" className="annotation-pin" title={control.text} aria-label={`Annotation ${number}: ${control.text || 'Add a comment'}`} onPointerDown={event => event.stopPropagation()} onClick={onOpen}><AnnotationBubble number={number} size={28}/></button>
    <AnnotationCommentControl {...control} controlRef={element} annotationId={annotationId}/>
  </div>;
}
