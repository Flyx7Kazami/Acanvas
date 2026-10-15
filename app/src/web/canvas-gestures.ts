import type { SessionView } from '../shared/types.js';
import { zoomAt, type Point } from './geometry.js';

export type CanvasPointerInput = Pick<PointerEvent, 'target' | 'clientX' | 'clientY' | 'pointerId' | 'pointerType' | 'button' | 'buttons' | 'altKey' | 'shiftKey' | 'ctrlKey' | 'metaKey' | 'preventDefault' | 'stopPropagation'> & { currentTarget: HTMLDivElement };
export type CanvasGestureState = { view: SessionView; sessionId: string; disabled: boolean; busy: boolean };
export type CanvasGestureCallbacks = {
  current: () => CanvasGestureState;
  updateView: (view: SessionView, sessionId: string) => void;
  interrupt: () => void;
  cancelPointer: () => void;
  pointerDown: (event: CanvasPointerInput) => void;
  pointerMove: (event: CanvasPointerInput) => void;
  pointerUp: (event: CanvasPointerInput) => void;
};

export function canvasPinchView(view: SessionView, factor: number, start: Point, point = start): SessionView {
  const next = zoomAt(view, factor, start);
  return { ...view, ...next, x: next.x + point.x - start.x, y: next.y + point.y - start.y };
}

type ScaleGesture = { sessionId: string; view: SessionView; point: Point; scale: number };
type Touch = { start: CanvasPointerInput; point: Point; single: boolean };
type NativeGestureEvent = Event & { scale?: number; clientX?: number; clientY?: number };

// Each input path owns its complete gesture. Touch contacts wait for a single
// drag or tap, so a two-contact start reaches the camera before object actions.
export function attachCanvasGestures(element: HTMLDivElement, callbacks: CanvasGestureCallbacks) {
  const touches = new Map<number, Touch>();
  let native: ScaleGesture | undefined, pinch: ScaleGesture | undefined, touchSession = '', touchEnded = false;
  const stop = (event: Event) => { event.preventDefault(); event.stopPropagation(); };
  const point = (event: { clientX: number; clientY: number }): Point => {
    const bounds = element.getBoundingClientRect(), scale = bounds.width / Math.max(1, element.clientWidth);
    return { x: (event.clientX - bounds.left) / scale, y: (event.clientY - bounds.top) / scale };
  };
  const snapshot = (event: PointerEvent): CanvasPointerInput => ({
    target: event.target, currentTarget: element, clientX: event.clientX, clientY: event.clientY, pointerId: event.pointerId, pointerType: event.pointerType,
    button: event.button, buttons: event.buttons, altKey: event.altKey, shiftKey: event.shiftKey, ctrlKey: event.ctrlKey, metaKey: event.metaKey,
    preventDefault: () => event.preventDefault(), stopPropagation: () => event.stopPropagation(),
  });
  const release = (id: number) => { if (element.hasPointerCapture(id)) element.releasePointerCapture(id); };
  const reset = () => {
    const ids = [...touches.keys()];
    const active = !!native || !!pinch || touches.size > 0 || callbacks.current().busy;
    native = undefined; pinch = undefined; touches.clear(); touchSession = ''; touchEnded = false;
    if (active) callbacks.cancelPointer();
    ids.forEach(release);
  };
  const current = () => {
    const state = callbacks.current();
    if (state.disabled || (native && native.sessionId !== state.sessionId) || (touchSession && touchSession !== state.sessionId)) reset();
    return state;
  };
  const pair = () => {
    const [a, b] = [...touches.values()];
    return { point: { x: (a.point.x + b.point.x) / 2, y: (a.point.y + b.point.y) / 2 }, scale: Math.max(.001, Math.hypot(a.point.x - b.point.x, a.point.y - b.point.y)) };
  };
  const beginPinch = () => {
    const state = current();
    if (state.disabled || touches.size < 2) return;
    callbacks.cancelPointer(); callbacks.interrupt();
    const start = pair(); pinch = { sessionId: state.sessionId, view: state.view, ...start }; touchEnded = true;
  };
  const down = (event: PointerEvent) => {
    if (event.pointerType !== 'touch') return;
    const state = current(), target = event.target instanceof Element ? event.target : null;
    if (state.disabled || !state.sessionId || target?.closest('[data-canvas-control]') || native || (state.busy && !touches.size)) return;
    stop(event);
    touches.set(event.pointerId, { start: snapshot(event), point: point(event), single: false });
    touchSession = state.sessionId;
    element.setPointerCapture(event.pointerId);
    if (touches.size === 2) beginPinch();
  };
  const move = (event: PointerEvent) => {
    current();
    const touch = touches.get(event.pointerId); if (!touch) return;
    stop(event); touch.point = point(event);
    if (pinch && touches.size >= 2) {
      const next = pair(); callbacks.updateView(canvasPinchView(pinch.view, next.scale / pinch.scale, pinch.point, next.point), pinch.sessionId); return;
    }
    if (touchEnded) return;
    if (!touch.single) {
      const start = point(touch.start);
      if (Math.hypot(touch.point.x - start.x, touch.point.y - start.y) < 4) return;
      touch.single = true; callbacks.pointerDown(touch.start);
    }
    callbacks.pointerMove(snapshot(event));
  };
  const up = (event: PointerEvent) => {
    current();
    const touch = touches.get(event.pointerId); if (!touch) return;
    stop(event);
    if (!touchEnded && !pinch) {
      if (!touch.single) callbacks.pointerDown(touch.start);
      callbacks.pointerMove(snapshot(event));
      callbacks.pointerUp(snapshot(event));
    }
    touches.delete(event.pointerId); release(event.pointerId);
    if (pinch && touches.size < 2) pinch = undefined;
    else if (pinch) beginPinch();
    if (!touches.size) { touchSession = ''; touchEnded = false; }
  };
  const cancel = (event: PointerEvent) => { if (touches.has(event.pointerId)) { stop(event); reset(); } };
  const lost = (event: PointerEvent) => { if (touches.has(event.pointerId)) reset(); };
  const gesturePoint = (event: NativeGestureEvent, fallback: Point) => Number.isFinite(event.clientX) && Number.isFinite(event.clientY) ? point(event as { clientX: number; clientY: number }) : fallback;
  const startNative = (event: NativeGestureEvent) => {
    stop(event);
    const state = current();
    if (state.disabled || state.busy || touches.size || !state.sessionId) return;
    callbacks.interrupt();
    native = { sessionId: state.sessionId, view: state.view, point: gesturePoint(event, { x: element.clientWidth / 2, y: element.clientHeight / 2 }), scale: Number.isFinite(event.scale) && event.scale! > 0 ? event.scale! : 1 };
  };
  const changeNative = (event: NativeGestureEvent) => {
    stop(event); current();
    if (!native || !Number.isFinite(event.scale) || event.scale! <= 0) return;
    callbacks.updateView(canvasPinchView(native.view, event.scale! / native.scale, native.point, gesturePoint(event, native.point)), native.sessionId);
  };
  const endNative = (event: NativeGestureEvent) => { stop(event); current(); native = undefined; };
  const listeners: [string, EventListener][] = [
    ['pointerdown', down as EventListener], ['pointermove', move as EventListener], ['pointerup', up as EventListener], ['pointercancel', cancel as EventListener], ['lostpointercapture', lost as EventListener],
  ];
  const window = element.ownerDocument.defaultView;
  if (window && ('GestureEvent' in window || 'ongesturestart' in window || 'ongesturestart' in element)) listeners.push(['gesturestart', startNative as EventListener], ['gesturechange', changeNative as EventListener], ['gestureend', endNative as EventListener]);
  listeners.forEach(([type, listener]) => element.addEventListener(type, listener, { capture: true, passive: false }));
  const lifecycle = ['pagehide', 'pageshow', 'blur'];
  lifecycle.forEach(type => window?.addEventListener(type, reset));
  return {
    acceptsWheel: () => { current(); return !native && !pinch && !touches.size; },
    ownsPointer: (id: number) => touches.has(id),
    reset,
    dispose: () => { reset(); listeners.forEach(([type, listener]) => element.removeEventListener(type, listener, true)); lifecycle.forEach(type => window?.removeEventListener(type, reset)); },
  };
}
