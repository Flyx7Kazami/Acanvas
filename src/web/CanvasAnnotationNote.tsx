import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';
import type { SessionView } from '../shared/types';
import { screenBounds, worldToScreen, type Point, type Rect } from './geometry';
import { placePointAnnotationNote } from './annotation-note-layout';
import { AnnotationBubble } from './AnnotationBubble';
import { AnnotationCommentControl, type AnnotationCommentControlProps } from './AnnotationCommentControl';

type NoteLayout = { expanded: boolean; point: boolean; width: number; height: number; padding: string; backgroundColor: string; borderRadius: string; boxShadow: string };

export function CanvasAnnotationNote({ canvas, bounds, markBounds, pin, geometry, view, layoutVersion, annotationId, number, active, redrawing, control, onOpen }: { canvas: RefObject<HTMLDivElement | null>; bounds: Rect; markBounds?: Rect; pin?: Point; geometry?: 'point' | 'rect'; view: SessionView; layoutVersion: string; annotationId: string; number: number; active: boolean; redrawing?: boolean; control: AnnotationCommentControlProps; onOpen: () => void }) {
  const group = useRef<HTMLDivElement>(null), element = useRef<HTMLDivElement>(null), pinButton = useRef<HTMLButtonElement>(null);
  const remembered = useRef<NoteLayout | null>(null), animations = useRef<Animation[]>([]);
  const layoutRef = useRef<() => void>(() => {}), observer = useRef<ResizeObserver | null>(null);
  const expanded = control.mode !== 'display';
  const point = geometry === 'point' && !!markBounds;
  useLayoutEffect(() => { const value = new ResizeObserver(() => layoutRef.current()); observer.current = value; return () => { value.disconnect(); observer.current = null; }; }, []);
  useLayoutEffect(() => {
    const board = canvas.current, node = group.current, note = element.current;
    if (!board || !node || !note) return;
    let scale = board.getBoundingClientRect().width / Math.max(1, board.clientWidth);
    const visible = () => { const rect = board.getBoundingClientRect(), x = Math.max(0, rect.x), y = Math.max(64, rect.y), right = Math.min(innerWidth, rect.right), bottom = Math.min(innerHeight - 80, rect.bottom); return { x: (x + 8 - rect.x) / scale, y: (y - rect.y) / scale, width: Math.max(0, (right - x - 16) / scale), height: Math.max(0, (bottom - y) / scale) }; };
    // The numbered pin keeps the shared pin position; its group only places the comment.
    const placePin = (left: number, top: number) => { const button = pinButton.current; if (!button) return; const center = pin ? worldToScreen(pin, view) : { x: left + 14, y: top + 14 }; button.style.transform = `translate(${center.x - 14 - left}px,${center.y - 14 - top}px)`; };
    const availableSize = visible();
    const leadingWidth = point ? 0 : 28 + (Number.parseFloat(getComputedStyle(node).columnGap) || 8);
    note.style.maxWidth = `${Math.max(0, availableSize.width - leadingWidth)}px`;
    note.style.maxHeight = expanded ? `${availableSize.height}px` : '';
    const prior = remembered.current, before = prior?.point === point ? prior : null, changing = before && before.expanded !== expanded;
    if (prior && prior.point !== point) { animations.current.forEach(animation => animation.cancel()); animations.current = []; }
    const moving = animations.current.some(animation => animation.playState === 'running' || animation.playState === 'paused');
    const position = node.getBoundingClientRect(), visual = note.getBoundingClientRect(), visualStyle = getComputedStyle(note);
    const from = moving ? { width: visual.width / scale, height: visual.height / scale, padding: visualStyle.padding, backgroundColor: visualStyle.backgroundColor, borderRadius: visualStyle.borderRadius, boxShadow: visualStyle.boxShadow } : before;
    if (changing) { animations.current.forEach(animation => animation.cancel()); animations.current = []; }
    const style = getComputedStyle(note);
    const target: NoteLayout = changing || !moving ? { expanded, point, width: note.offsetWidth, height: Math.max(28, note.offsetHeight), padding: style.padding, backgroundColor: style.backgroundColor, borderRadius: style.borderRadius, boxShadow: style.boxShadow } : { ...before!, expanded };
    remembered.current = target;
    const fitVisibleSize = () => {
      scale = board.getBoundingClientRect().width / Math.max(1, board.clientWidth);
      const available = visible(), width = `${Math.max(0, available.width - leadingWidth)}px`, height = expanded ? `${available.height}px` : '';
      if (note.style.maxWidth !== width || note.style.maxHeight !== height) {
        animations.current.forEach(animation => animation.cancel()); animations.current = [];
        note.style.maxWidth = width; note.style.maxHeight = height;
        target.width = note.offsetWidth; target.height = Math.max(28, note.offsetHeight);
      }
      return available;
    };
    const previous = [...board.querySelectorAll<HTMLElement>('.canvas-annotation-group')].filter(value => !!(node.compareDocumentPosition(value) & Node.DOCUMENT_POSITION_PRECEDING));
    if (point) {
      const precedingNotes = previous.map(value => value.querySelector<HTMLElement>('.canvas-annotation-note')).filter((value): value is HTMLElement => !!value);
      const pins = [...board.querySelectorAll<HTMLElement>('.canvas-annotation-group[data-geometry="point"]>.annotation-pin')].filter(value => value.parentElement !== node);
      const controls = [...(board.closest('.app-shell')?.querySelectorAll<HTMLElement>('.creation-dock,.canvas-toolbar,.project-identity,.canvas-actions,.notification-stack') || [])];
      const layout = () => {
        fitVisibleSize();
        const anchor = screenBounds(markBounds!, view), viewport = board.getBoundingClientRect();
        node.style.left = `${anchor.x}px`; node.style.top = `${anchor.y}px`; node.style.height = ''; placePin(anchor.x - 14, anchor.y - 14);
        node.dataset.anchorX = String(markBounds!.x); node.dataset.anchorY = String(markBounds!.y);
        const obstacles = [...precedingNotes, ...pins, ...controls].filter(value => value.closest<HTMLElement>('.canvas-annotation-group')?.dataset.anchorVisible !== 'false' && getComputedStyle(value).visibility === 'visible').map(value => { const rect = value.getBoundingClientRect(); return { x: (rect.x - viewport.x) / scale, y: (rect.y - viewport.y) / scale, width: rect.width / scale, height: rect.height / scale }; }).filter(rect => rect.width > 0 && rect.height > 0);
        const placed = placePointAnnotationNote(anchor, target, visible(), obstacles);
        note.style.left = `${placed.x - anchor.x}px`; note.style.top = `${placed.y - anchor.y}px`;
        const shown = anchor.x + 14 > -viewport.x / scale && anchor.x - 14 < (innerWidth - viewport.x) / scale && anchor.y + 14 > -viewport.y / scale && anchor.y - 14 < (innerHeight - viewport.y) / scale;
        node.dataset.anchorVisible = String(shown); node.dataset.positioned = 'true'; node.inert = !shown;
        return { placed, viewport };
      };
      const destination = layout();
      if (changing && from && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
        const options = { duration: 260, easing: 'cubic-bezier(.16,1,.3,1)' };
        const frame = (value: typeof from) => ({ width: `${value.width}px`, height: `${value.height}px`, padding: value.padding, backgroundColor: value.backgroundColor, borderRadius: value.borderRadius, boxShadow: value.boxShadow });
        const x = (visual.x - destination.viewport.x) / scale - destination.placed.x, y = (visual.y - destination.viewport.y) / scale - destination.placed.y;
        animations.current = [note.animate([frame(from), frame(target)], options), note.animate([{ transform: `translate(${x}px,${y}px)` }, { transform: 'translate(0,0)' }], options)];
      }
      layoutRef.current = layout; [board, note, ...precedingNotes, ...controls].forEach(value => observer.current?.observe(value));
      return () => { layoutRef.current = () => {}; };
    }
    note.style.left = ''; note.style.top = ''; delete node.dataset.anchorVisible;
    const layout = () => {
      fitVisibleSize();
      const anchor = screenBounds(bounds, view), height = target.height;
      const offset = previous.filter(value => value.dataset.geometry !== 'point' && Number(value.dataset.anchorX) === bounds.x && Number(value.dataset.anchorY) === bounds.y).reduce((sum, value) => sum + value.offsetHeight + 8, 0);
      const viewport = board.getBoundingClientRect(), rect = node.getBoundingClientRect(), transform = new DOMMatrix(getComputedStyle(node).transform);
      const anchoredTop = anchor.y - 8 - height - offset;
      const available = visible();
      const top = expanded ? Math.max(available.y, Math.min(anchoredTop, available.y + available.height - height)) : anchoredTop;
      const left = expanded ? Math.max(available.x, Math.min(anchor.x, available.x + available.width - node.offsetWidth)) : anchor.x;
      node.dataset.anchorX = String(bounds.x); node.dataset.anchorY = String(bounds.y);
      node.style.left = `${left}px`; node.style.top = `${top}px`; node.style.height = `${height}px`; placePin(left, top);
      node.dataset.positioned = 'true';
      node.inert = left + transform.m41 + rect.width / scale <= -viewport.x / scale || left + transform.m41 >= (innerWidth - viewport.x) / scale || top + transform.m42 + rect.height / scale <= -viewport.y / scale || top + transform.m42 >= (innerHeight - viewport.y) / scale;
      return { left, top, viewport };
    };
    const destination = layout();
    if (changing && from && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
      const options = { duration: 260, easing: 'cubic-bezier(.16,1,.3,1)' };
      const frame = (value: typeof from) => ({ width: `${value.width}px`, height: `${value.height}px`, padding: value.padding, backgroundColor: value.backgroundColor, borderRadius: value.borderRadius, boxShadow: value.boxShadow });
      const y = (position.y - destination.viewport.y) / scale - destination.top;
      animations.current = [
        note.animate([frame(from), frame(target)], options),
        node.animate([{ transform: `translateY(${y}px)`, height: `${from.height}px` }, { transform: 'translateY(0)', height: `${target.height}px` }], options),
      ];
    }
    layoutRef.current = layout; [board, note, ...previous].forEach(value => observer.current?.observe(value));
    return () => { layoutRef.current = () => {}; };
  }, [view.x, view.y, view.zoom, bounds.x, bounds.y, bounds.width, bounds.height, markBounds?.x, markBounds?.y, markBounds?.width, markBounds?.height, pin?.x, pin?.y, expanded, point, active, layoutVersion]);
  useEffect(() => {
    const reduced = matchMedia('(prefers-reduced-motion: reduce)');
    const stop = () => { if (reduced.matches) animations.current.forEach(animation => animation.cancel()); };
    reduced.addEventListener('change', stop);
    return () => { reduced.removeEventListener('change', stop); animations.current.forEach(animation => animation.cancel()); };
  }, []);
  return <div ref={group} className="canvas-annotation-group" data-annotation-id={annotationId} data-active={active || undefined} data-redrawing={redrawing || undefined} data-geometry={point ? 'point' : undefined} data-canvas-control style={point ? { left: screenBounds(markBounds!, view).x, top: screenBounds(markBounds!, view).y } : undefined}>
    <button ref={pinButton} type="button" className="annotation-pin" title={control.text} aria-label={`Annotation ${number}: ${control.text || 'Add a comment'}`} onPointerDown={event => event.stopPropagation()} onClick={onOpen}><AnnotationBubble number={number} size={28}/></button>
    <AnnotationCommentControl {...control} controlRef={element} annotationId={annotationId}/>
  </div>;
}
