import { useLayoutEffect, useRef, useSyncExternalStore, type ReactNode } from 'react';
import type { SessionView } from '../shared/types';
import { CanvasCamera } from './canvas-camera';
import { attachCameraPresentation } from './canvas-presentation';

export const useCameraView = (camera: CanvasCamera) => useSyncExternalStore(camera.subscribe, camera.getSnapshot);

export function CameraOverlay({ camera, children }: { camera: CanvasCamera; children: (view: SessionView) => ReactNode }) {
  return children(useCameraView(camera));
}

/** The world owns its matrix and retained raster; React owns the mounted content. */
export function CanvasWorld({ camera, transition, children }: { camera: CanvasCamera; transition?: string; children: ReactNode }) {
  const element = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const node = element.current!;
    const detach = attachCameraPresentation(camera, node);
    const settle = () => camera.settle();
    window.addEventListener('blur', settle); window.addEventListener('pagehide', settle); window.addEventListener('resize', settle);
    return () => { detach(); window.removeEventListener('blur', settle); window.removeEventListener('pagehide', settle); window.removeEventListener('resize', settle); };
  }, [camera]);
  return <div ref={element} className={`canvas-world${transition ? ' layout-transitioning' : ''}`} data-transition-kind={transition}>{children}</div>;
}
