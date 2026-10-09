import { createContext, useContext, useEffect, useMemo } from 'react';
import type { CaptureView } from '../../shared/types.js';
import { SceneContentFrame, type SceneContentFrameInput } from './texture.js';
export { SceneContentFrame } from './texture.js';
export type { ContentTextRun, SceneContentFrameInput, SceneContentMetadata } from './texture.js';

export class SceneContentRegistry {
  private frames = new Map<string, SceneContentFrame>();
  private listeners = new Set<() => void>();
  get(objectId: string) { return this.frames.get(objectId); }
  publish(objectId: string, input: SceneContentFrameInput) { this.frames.set(objectId, new SceneContentFrame(document, input)); this.emit(); }
  clear(objectId: string) { if (this.frames.delete(objectId)) this.emit(); }
  subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  requestRender() { this.emit(); }
  private emit() { this.listeners.forEach(listener => listener()); }
}

export interface SceneContentScope {
  registry: SceneContentRegistry;
  objectId: string;
  width: number;
  height: number;
  captureView?: CaptureView;
}
export const SceneContentContext = createContext<SceneContentScope | undefined>(undefined);

/** Optional scope keeps detailed previews native and publishes only board pixel sources. */
export function useSceneContent() {
  const scope = useContext(SceneContentContext);
  const publisher = useMemo(() => scope && ({ ...scope,
    publish: (input: SceneContentFrameInput) => scope.registry.publish(scope.objectId, input),
    clear: () => scope.registry.clear(scope.objectId),
    requestRender: () => scope.registry.requestRender(),
  }), [scope?.registry, scope?.objectId, scope?.width, scope?.height, scope?.captureView]);
  useEffect(() => () => { if (scope) scope.registry.clear(scope.objectId); }, [scope?.registry, scope?.objectId]);
  return publisher;
}
