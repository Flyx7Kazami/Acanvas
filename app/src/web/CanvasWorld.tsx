import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useRef, useSyncExternalStore, type ReactNode, type RefObject } from 'react';
import type { SessionView } from '../shared/types';
import { CanvasCamera } from './canvas-camera';
import { attachCameraPresentation, CanvasRasterRegions } from './canvas-presentation';
import type { Rect } from './geometry';
import { SceneContentContext } from './scene-renderer/content';

const RasterContext = createContext<CanvasRasterRegions | undefined>(undefined);
export function useCanvasRaster(id: string, element: RefObject<HTMLElement | null>, bounds: Rect, nativeContent: boolean, enabled: boolean) {
  const regions = useContext(RasterContext), handle = useRef<ReturnType<CanvasRasterRegions['register']> | undefined>(undefined);
  useLayoutEffect(() => {
    if (!enabled || !regions || !element.current) return;
    const registration = regions.register(id, element.current, bounds, nativeContent); handle.current = registration;
    return () => { registration.dispose(); handle.current = undefined; };
  }, [regions, element, id, enabled]);
  useLayoutEffect(() => { handle.current?.update(bounds, nativeContent); });
}

export function useCanvasRasterSource<T extends HTMLElement>(element: RefObject<T | null>) {
  const regions = useContext(RasterContext), objectId = useContext(SceneContentContext)?.objectId;
  const dispose = useRef<(() => void) | undefined>(undefined);
  return useCallback((node: T | null) => {
    dispose.current?.(); dispose.current = undefined; element.current = node;
    if (node && regions && objectId) dispose.current = regions.registerSource(objectId, node);
  }, [regions, objectId, element]);
}

export const useCameraView = (camera: CanvasCamera) => useSyncExternalStore(camera.subscribe, camera.getSnapshot);

export function CameraOverlay({ camera, children }: { camera: CanvasCamera; children: (view: SessionView) => ReactNode }) {
  return children(useCameraView(camera));
}

/** The camera owns world composition; content surfaces own their raster lifetimes. */
export function CanvasWorld({ camera, transition, children }: { camera: CanvasCamera; transition?: string; children: ReactNode }) {
  const element = useRef<HTMLDivElement>(null);
  const regions = useMemo(() => new CanvasRasterRegions(camera.getFrame()), [camera]);
  useLayoutEffect(() => {
    const node = element.current!;
    const board = node.parentElement!;
    regions.setViewport(board.clientWidth, board.clientHeight);
    const resize = new ResizeObserver(() => regions.setViewport(board.clientWidth, board.clientHeight)); resize.observe(board);
    const detach = attachCameraPresentation(camera, node, regions);
    const settle = () => camera.settle();
    window.addEventListener('blur', settle); window.addEventListener('pagehide', settle); window.addEventListener('resize', settle);
    return () => { detach(); resize.disconnect(); window.removeEventListener('blur', settle); window.removeEventListener('pagehide', settle); window.removeEventListener('resize', settle); };
  }, [camera, regions]);
  return <RasterContext.Provider value={regions}><div ref={element} className={`canvas-world${transition ? ' layout-transitioning' : ''}`} data-transition-kind={transition}><div className="canvas-content-layer">{children}</div></div></RasterContext.Provider>;
}
