import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';
import type { SessionView } from '../shared/types';
import { screenBounds, type Rect } from './geometry';
import { placePointAnnotationNote } from './annotation-note-layout';
import { AnnotationBubble } from './AnnotationBubble';
import { AnnotationCommentControl, type AnnotationCommentControlProps } from './AnnotationCommentControl';

type NoteLayout = { expanded: boolean; point: boolean; width: number; height: number; padding: string; backgroundColor: string; borderRadius: string; boxShadow: string };

export function CanvasAnnotationNote({ canvas, bounds, markBounds, geometry, view, annotationId, number, active, control, onOpen }: { canvas: RefObject<HTMLDivElement | null>; bounds: Rect; markBounds?: Rect; geometry?: 'point' | 'rect'; view: SessionView; annotationId: string; number: number; active: boolean; control: AnnotationCommentControlProps; onOpen: () => void }) {
  const group = useRef<HTMLDivElement>(null), element = useRef<HTMLDivElement>(null);
  const remembered = useRef<NoteLayout | null>(null), animations = useRef<Animation[]>([]);
  const expanded = control.mode !== 'display';
  const point = geometry === 'point' && !!markBounds;
  useLayoutEffect(() => {
    const board = canvas.current, node = group.current, note = element.current;
    if (!board || !node || !note) return;
    const prior = remembered.current, before = prior?.point === point ? prior : null, changing = before && before.expanded !== expanded;
    if (prior && prior.point !== point) { animations.current.forEach(animation => animation.cancel()); animations.current = []; }
    const moving = animations.current.some(animation => animation.playState === 'running' || animation.playState === 'paused');
    const position = node.getBoundingClientRect(), visual = note.getBoundingClientRect(), visualStyle = getComputedStyle(note);
    const from = moving ? { width: visual.width, height: visual.height, padding: visualStyle.padding, backgroundColor: visualStyle.backgroundColor, borderRadius: visualStyle.borderRadius, boxShadow: visualStyle.boxShadow } : before;
    if (changing) { animations.current.forEach(animation => animation.cancel()); animations.current = []; }
    const style = getComputedStyle(note);
    const target: NoteLayout = changing || !moving ? { expanded, point, width: note.offsetWidth, height: Math.max(28, note.offsetHeight), padding: style.padding, backgroundColor: style.backgroundColor, borderRadius: style.borderRadius, boxShadow: style.boxShadow } : { ...before!, expanded };
    remembered.current = target;
    const previous = [...board.querySelectorAll<HTMLElement>('.canvas-annotation-group')].filter(value => !!(node.compareDocumentPosition(value) & Node.DOCUMENT_POSITION_PRECEDING));
    if (point) {
      const precedingNotes = previous.map(value => value.querySelector<HTMLElement>('.canvas-annotation-note')).filter((value): value is HTMLElement => !!value);
      const pins = [...board.querySelectorAll<HTMLElement>('.canvas-annotation-group[data-geometry="point"]>.annotation-pin')].filter(value => value.parentElement !== node);
      const controls = [...(board.closest('.app-shell')?.querySelectorAll<HTMLElement>('.creation-dock,.canvas-toolbar,.project-identity,.canvas-actions,.notification-stack') || [])];
      const layout = () => {
        const anchor = screenBounds(markBounds!, view), viewport = board.getBoundingClientRect();
        node.style.left = `${anchor.x}px`; node.style.top = `${anchor.y}px`; node.style.height = '';
        node.dataset.anchorX = String(markBounds!.x); node.dataset.anchorY = String(markBounds!.y);
        const obstacles = [...precedingNotes, ...pins, ...controls].filter(value => value.closest<HTMLElement>('.canvas-annotation-group')?.dataset.anchorVisible !== 'false' && getComputedStyle(value).visibility === 'visible').map(value => { const rect = value.getBoundingClientRect(); return { x: rect.x - viewport.x, y: rect.y - viewport.y, width: rect.width, height: rect.height }; }).filter(rect => rect.width > 0 && rect.height > 0);
        const placed = placePointAnnotationNote(anchor, target, { x: 8, y: 64, width: Math.max(0, viewport.width - 16), height: Math.max(0, viewport.height - 144) }, obstacles);
        note.style.left = `${placed.x - anchor.x}px`; note.style.top = `${placed.y - anchor.y}px`;
        const visible = anchor.x + 14 > 0 && anchor.x - 14 < viewport.width && anchor.y + 14 > 0 && anchor.y - 14 < viewport.height;
        node.dataset.anchorVisible = String(visible); node.dataset.positioned = 'true'; node.inert = !visible;
        return { placed, viewport };
      };
      const destination = layout();
      if (changing && from && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
        const options = { duration: 260, easing: 'cubic-bezier(.16,1,.3,1)' };
        const frame = (value: typeof from) => ({ width: `${value.width}px`, height: `${value.height}px`, padding: value.padding, backgroundColor: value.backgroundColor, borderRadius: value.borderRadius, boxShadow: value.boxShadow });
        const x = visual.x - destination.viewport.x - destination.placed.x, y = visual.y - destination.viewport.y - destination.placed.y;
        animations.current = [note.animate([frame(from), frame(target)], options), note.animate([{ transform: `translate(${x}px,${y}px)` }, { transform: 'translate(0,0)' }], options)];
      }
      const observer = new ResizeObserver(layout);
      [board, note, ...precedingNotes, ...controls].forEach(value => observer.observe(value));
      return () => observer.disconnect();
    }
    note.style.left = ''; note.style.top = ''; delete node.dataset.anchorVisible;
    const layout = () => {
      const anchor = screenBounds(bounds, view), height = target.height;
      const offset = previous.filter(value => value.dataset.geometry !== 'point' && Number(value.dataset.anchorX) === bounds.x && Number(value.dataset.anchorY) === bounds.y).reduce((sum, value) => sum + value.offsetHeight + 8, 0);
      const viewport = board.getBoundingClientRect(), rect = node.getBoundingClientRect(), transform = new DOMMatrix(getComputedStyle(node).transform);
      const anchoredTop = anchor.y - 8 - height - offset;
      const top = expanded ? Math.max(64, Math.min(anchoredTop, viewport.height - height - 80)) : anchoredTop;
      const left = expanded ? Math.max(8, Math.min(anchor.x, viewport.width - node.offsetWidth - 8)) : anchor.x;
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
  return <div ref={group} className="canvas-annotation-group" data-annotation-id={annotationId} data-active={active || undefined} data-geometry={point ? 'point' : undefined} data-canvas-control style={point ? { left: screenBounds(markBounds!, view).x, top: screenBounds(markBounds!, view).y } : undefined}>
    <button type="button" className="annotation-pin" title={control.text} aria-label={`Annotation ${number}: ${control.text || 'Add a comment'}`} onPointerDown={event => event.stopPropagation()} onClick={onOpen}><AnnotationBubble number={number} size={28}/></button>
    <AnnotationCommentControl {...control} controlRef={element} annotationId={annotationId}/>
  </div>;
}
