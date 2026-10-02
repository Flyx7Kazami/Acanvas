import { useCallback, useEffect, useRef } from 'react';
import type { SessionView } from '../shared/types';

type UpdateView = (view: SessionView, sessionId: string, persist?: boolean) => void;
const duration = 380;

export function useAnimatedView(view: SessionView, sessionId: string, disabled: boolean, updateView: UpdateView) {
  const current = useRef({ view, sessionId, disabled });
  current.current = { view, sessionId, disabled };
  const animation = useRef<{ frame: number; sessionId: string; target: SessionView; view: SessionView } | null>(null);

  const interrupt = useCallback((persist = true) => {
    const active = animation.current;
    if (!active) return;
    cancelAnimationFrame(active.frame); animation.current = null;
    if (persist) updateView(active.view, active.sessionId);
  }, [updateView]);

  const animate = useCallback((target: SessionView) => {
    interrupt(false);
    const start = current.current;
    if (!start.sessionId || start.disabled) return;
    if (matchMedia('(prefers-reduced-motion: reduce)').matches || (start.view.x === target.x && start.view.y === target.y && start.view.zoom === target.zoom)) {
      updateView(target, start.sessionId); return;
    }
    const active = { frame: 0, sessionId: start.sessionId, target, view: start.view };
    animation.current = active;
    const started = performance.now();
    const step = (time: number) => {
      if (animation.current !== active) return;
      if (current.current.sessionId !== active.sessionId || current.current.disabled) { interrupt(false); return; }
      const progress = Math.min(1, Math.max(0, (time - started) / duration));
      const eased = progress < .5 ? 4 * progress ** 3 : 1 - (-2 * progress + 2) ** 3 / 2;
      active.view = { ...target, x: start.view.x + (target.x - start.view.x) * eased, y: start.view.y + (target.y - start.view.y) * eased, zoom: start.view.zoom + (target.zoom - start.view.zoom) * eased };
      if (progress === 1) { animation.current = null; updateView(target, active.sessionId); }
      else { updateView(active.view, active.sessionId, false); active.frame = requestAnimationFrame(step); }
    };
    active.frame = requestAnimationFrame(step);
  }, [interrupt, updateView]);

  useEffect(() => {
    const reduced = matchMedia('(prefers-reduced-motion: reduce)');
    const change = () => {
      const active = animation.current;
      if (reduced.matches && active) { interrupt(false); updateView(active.target, active.sessionId); }
    };
    reduced.addEventListener('change', change);
    return () => { reduced.removeEventListener('change', change); interrupt(false); };
  }, [interrupt, updateView]);
  useEffect(() => { if (animation.current?.sessionId !== sessionId || disabled) interrupt(); }, [sessionId, disabled, interrupt]);
  return { animate, interrupt };
}
