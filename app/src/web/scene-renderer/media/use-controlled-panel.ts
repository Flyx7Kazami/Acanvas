import { useRef, type RefObject } from 'react';
import { useSceneCapture, type SceneContentFrameInput } from '../content.js';
import { paintControlledPanel } from './controlled-panel.js';

/** The displayed panel DOM is rasterized with its native selection only when Done reads it. */
export function useControlledScenePanel(root: RefObject<HTMLElement | null>, options: { resolveRoot?: (element: HTMLElement) => HTMLElement; textRoot?: (element: HTMLElement) => HTMLElement | undefined; metadata?: () => Partial<SceneContentFrameInput> } = {}) {
  const current = useRef(options); current.current = options;
  return useSceneCapture(() => {
    if (!root.current) return;
    const element = current.current.resolveRoot?.(root.current) ?? root.current;
    return { ...paintControlledPanel(element, { textRoot: current.current.textRoot?.(element) }), fit: 'fill', ...current.current.metadata?.() };
  });
}
