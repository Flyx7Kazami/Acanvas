import type { SessionView } from '../shared/types.js';
import { zoomAt } from './geometry.js';

export type CanvasWheelInput = { clientX: number; clientY: number; deltaX: number; deltaY: number; deltaMode: number; ctrlKey: boolean; metaKey: boolean };

// Pointer controls inherit canvas gestures. Reading regions opt into content
// scrolling, either continuously or while focused; the nearest declaration wins.
export function routesWheelToCanvas(canvas: Element, event: Pick<WheelEvent, 'target' | 'ctrlKey' | 'metaKey'>): boolean {
  if (event.ctrlKey || event.metaKey) return true;
  const target = event.target instanceof Element ? event.target : event.target instanceof Node ? event.target.parentElement : null;
  const region = target?.closest('[data-canvas-wheel]');
  if (!region || !canvas.contains(region)) return true;
  const policy = region.getAttribute('data-canvas-wheel');
  return !(policy === 'content' || policy === 'focused-content' && region.contains(region.ownerDocument.activeElement));
}

export function canvasWheelView(view: SessionView, event: CanvasWheelInput, bounds: Pick<DOMRect, 'left' | 'top' | 'height'>): SessionView {
  const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? bounds.height : 1;
  const deltaX = event.deltaX * unit, deltaY = event.deltaY * unit;
  if (event.ctrlKey || event.metaKey) return { ...view, ...zoomAt(view, Math.exp(-deltaY * .005), { x: event.clientX - bounds.left, y: event.clientY - bounds.top }) };
  return { ...view, x: view.x - deltaX, y: view.y - deltaY };
}
