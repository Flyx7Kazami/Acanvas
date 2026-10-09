import { useLayoutEffect, useRef, type RefObject } from 'react';
import { useSceneContent, type SceneContentFrameInput } from '../content.js';
import { compileControlledPanel, paintControlledPanel } from './controlled-panel.js';

/** Panel layout, native selection and displayed bitmap are published at the same layout boundary. */
export function useControlledScenePanel(root: RefObject<HTMLElement | null>, options: { resolveRoot?: (element: HTMLElement) => HTMLElement; textRoot?: (element: HTMLElement) => HTMLElement | undefined; dynamicElements?: (element: HTMLElement) => HTMLElement[]; ignoreMutation?: (record: MutationRecord) => boolean; layoutKey?: () => string; metadata?: () => Partial<SceneContentFrameInput>; onError?: (cause: unknown) => void } = {}) {
  const scope = useSceneContent(), current = useRef(options), scopeRef = useRef(scope), sequence = useRef(0), publish = useRef(() => {});
  current.current = options; scopeRef.current = scope;
  useLayoutEffect(() => {
    if (!scope || !root.current) { publish.current = () => {}; return; }
    let scheduled = 0, disposed = false, dirty = true, wasAnimating = false, base: SceneContentFrameInput | undefined, commands: (() => NonNullable<SceneContentFrameInput['commands']>) | undefined, layoutKey: string | undefined;
    const paint = () => {
      if (disposed || !scopeRef.current || !root.current) return;
      try {
        const element = current.current.resolveRoot?.(root.current) ?? root.current;
        const dynamic = current.current.dynamicElements?.(element);
        const currentKey = current.current.layoutKey?.(); if (currentKey !== layoutKey) { layoutKey = currentKey; dirty = true; }
        const animating = !!dynamic && element.getAnimations({ subtree: true }).some(animation => animation.playState === 'running');
        if (!base || !dynamic || dirty || animating || wasAnimating) {
          if (dynamic) { const compiled = compileControlledPanel(element, dynamic, current.current.textRoot?.(element)); base = compiled.frame; commands = compiled.commands; }
          else { base = paintControlledPanel(element, { textRoot: current.current.textRoot?.(element) }); commands = undefined; }
          dirty = false;
        }
        wasAnimating = animating;
        const frame = { ...base, ...(commands ? { commands: commands() } : {}) };
        const layoutSeq = ++sequence.current;
        scopeRef.current.publish({ ...frame, fit: 'fill', ...current.current.metadata?.(), layoutSeq });
        element.dataset.sceneLayoutSeq = String(layoutSeq);
        if (animating && !scheduled) scheduled = requestAnimationFrame(() => { scheduled = 0; paint(); });
      } catch (cause) { scopeRef.current.clear(); current.current.onError?.(cause); }
    };
    publish.current = () => { cancelAnimationFrame(scheduled); scheduled = 0; paint(); };
    const schedule = () => { dirty = true; if (!scheduled) scheduled = requestAnimationFrame(() => { scheduled = 0; paint(); }); };
    const element = current.current.resolveRoot?.(root.current) ?? root.current;
    const observer = new ResizeObserver(schedule); observer.observe(element);
    for (const target of current.current.dynamicElements?.(element) ?? []) { observer.observe(target); if (target.parentElement) observer.observe(target.parentElement); }
    const mutations = new MutationObserver(records => { if (records.some(record => record.attributeName !== 'data-scene-layout-seq' && !current.current.ignoreMutation?.(record))) schedule(); }); mutations.observe(element, { childList: true, characterData: true, subtree: true, attributes: true });
    const theme = new MutationObserver(schedule); theme.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    const events = ['scroll', 'focusin', 'focusout', 'pointerover', 'pointerout', 'pointerup', 'keydown', 'load']; for (const event of events) element.addEventListener(event, schedule, true);
    document.addEventListener('selectionchange', schedule); document.fonts?.addEventListener('loadingdone', schedule);
    paint();
    return () => { disposed = true; publish.current = () => {}; cancelAnimationFrame(scheduled); observer.disconnect(); mutations.disconnect(); theme.disconnect(); for (const event of events) element.removeEventListener(event, schedule, true); document.removeEventListener('selectionchange', schedule); document.fonts?.removeEventListener('loadingdone', schedule); };
  }, [!!scope, root, scope?.width, scope?.height]);
  return { scope, publish };
}
