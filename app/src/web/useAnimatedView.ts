import { useCallback, useEffect, useRef } from 'react';
import type { CanvasCamera } from './canvas-camera';
import type { SessionView } from '../shared/types';

type UpdateView = (view: SessionView, sessionId: string, persist?: boolean | 'immediate') => void;
export const viewTransitionDuration = 420;
export const viewTransitionEase = (progress: number) => progress < .5 ? 4 * progress ** 3 : 1 - (-2 * progress + 2) ** 3 / 2;

/** Persist the destination once; intermediate views only describe what is displayed. */
export function useAnimatedView(camera: CanvasCamera, sessionId: string, disabled: boolean, updateView: UpdateView, persistView: (view: SessionView, sessionId: string) => void) {
  const current = useRef({ sessionId, disabled }); current.current = { sessionId, disabled };
  const animation = useRef<{ frame: number; sessionId: string; target: SessionView; view: SessionView } | null>(null);
  const interrupt = useCallback((persist = true) => {
    const active = animation.current;
    if (!active) return;
    cancelAnimationFrame(active.frame); animation.current = null;
    if (persist) updateView(active.view, active.sessionId, 'immediate');
    camera.settle();
  }, [camera, updateView]);
  const targetView = useCallback(() => animation.current?.target || camera.getView(), [camera]);
  const animate = useCallback((target: SessionView) => {
    const start = { ...current.current, view: animation.current?.view || camera.getView() };
    interrupt(false);
    if (!start.sessionId || start.disabled) return;
    persistView(target, start.sessionId);
    if (matchMedia('(prefers-reduced-motion: reduce)').matches || (start.view.x === target.x && start.view.y === target.y && start.view.zoom === target.zoom)) { updateView(target, start.sessionId, false); camera.settle(); return; }
    const active = { frame: 0, sessionId: start.sessionId, target, view: { ...target, x: start.view.x, y: start.view.y, zoom: start.view.zoom } };
    animation.current = active; updateView(active.view, active.sessionId, false);
    const started = performance.now();
    const step = (time: number) => {
      if (animation.current !== active) return;
      if (current.current.sessionId !== active.sessionId || current.current.disabled) { interrupt(); return; }
      const progress = Math.min(1, Math.max(0, (time - started) / viewTransitionDuration)), eased = viewTransitionEase(progress);
      active.view = { ...target, x: start.view.x + (target.x - start.view.x) * eased, y: start.view.y + (target.y - start.view.y) * eased, zoom: start.view.zoom + (target.zoom - start.view.zoom) * eased };
      updateView(active.view, active.sessionId, false);
      camera.flush();
      if (progress === 1) { animation.current = null; camera.settle(); }
      else active.frame = requestAnimationFrame(step);
    };
    active.frame = requestAnimationFrame(step);
  }, [camera, interrupt, updateView, persistView]);
  useEffect(() => {
    const reduced = matchMedia('(prefers-reduced-motion: reduce)');
    const change = () => { const active = animation.current; if (reduced.matches && active) { interrupt(false); updateView(active.target, active.sessionId, false); camera.settle(); } };
    reduced.addEventListener('change', change);
    return () => { reduced.removeEventListener('change', change); interrupt(false); };
  }, [camera, interrupt, updateView, persistView]);
  useEffect(() => { if (animation.current?.sessionId !== sessionId || disabled) interrupt(); }, [sessionId, disabled, interrupt]);
  return { animate, interrupt, targetView };
}
