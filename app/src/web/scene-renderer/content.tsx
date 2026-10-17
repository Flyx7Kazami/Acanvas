import { createContext, useContext, useLayoutEffect, useRef, type RefObject } from 'react';
import type { CaptureView } from '../../shared/types.js';
import { SceneContentFrame, type SceneContentFrameInput } from './texture.js';
export { SceneContentFrame } from './texture.js';
export type { ContentTextRun, SceneContentFrameInput, SceneContentMetadata } from './texture.js';

/** Reads the producer's currently displayed pixels; it runs only when Done freezes the scene. */
export type SceneContentSource = () => SceneContentFrameInput | undefined;
/** Starts in the Done task and may resolve after the displayed frame was copied. */
export type SceneContentRefresh = () => Promise<SceneContentFrameInput | undefined>;
export class SceneContentRegistry {
  private sources = new Map<string, SceneContentSource>();
  private refreshes = new Map<string, SceneContentRefresh>();
  register(objectId: string, source: SceneContentSource) { this.sources.set(objectId, source); return () => { if (this.sources.get(objectId) === source) this.sources.delete(objectId); }; }
  registerRefresh(objectId: string, refresh: SceneContentRefresh) { this.refreshes.set(objectId, refresh); return () => { if (this.refreshes.get(objectId) === refresh) this.refreshes.delete(objectId); }; }
  /** Unloaded content returns no frame; oversized or non-exportable content is reported and also drawn as a placeholder. */
  capture(objectId: string, onError: (cause: unknown) => void): SceneContentFrame | undefined {
    try { const input = this.sources.get(objectId)?.(); return input ? new SceneContentFrame(document, input) : undefined; }
    catch (cause) { onError(cause); return undefined; }
  }
  /** Calls every refresh immediately. Each one is limited to two seconds and cancelled with the capture. */
  beginRefresh(signal?: AbortSignal): Promise<ReadonlyMap<string, SceneContentFrameInput>> {
    const jobs = [...this.refreshes].map(async ([objectId, refresh]) => {
      if (signal?.aborted) return;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), 2000); });
      const cancelled = new Promise<undefined>(resolve => signal?.addEventListener('abort', () => resolve(undefined), { once: true }));
      try {
        const input = await Promise.race([refresh(), timeout, cancelled]);
        return input ? [objectId, input] as const : undefined;
      } catch { return undefined; }
      finally { clearTimeout(timer); }
    });
    return Promise.all(jobs).then(results => new Map(results.filter((value): value is readonly [string, SceneContentFrameInput] => !!value)));
  }
}

export interface SceneContentScope {
  registry: SceneContentRegistry;
  objectId: string;
  width: number;
  height: number;
  captureView?: CaptureView;
  contentElement?: RefObject<HTMLElement | null>;
}
export const SceneContentContext = createContext<SceneContentScope | undefined>(undefined);

/** Board objects have a scope; detail previews render natively without one. */
export function useSceneContent() { return useContext(SceneContentContext); }

/** Registers an on-demand frame reader for the scoped board object. */
export function useSceneCapture(source: SceneContentSource) {
  const scope = useContext(SceneContentContext), latest = useRef(source); latest.current = source;
  useLayoutEffect(() => scope?.registry.register(scope.objectId, () => {
    const element = scope.contentElement?.current;
    if (!element) return latest.current();
    const visibility = element.style.contentVisibility;
    element.style.contentVisibility = 'visible';
    try { return latest.current(); }
    finally { element.style.contentVisibility = visibility; }
  }), [scope?.registry, scope?.objectId, scope?.contentElement]);
  return scope;
}

/** Registers a Done refresh that can replace the frame copied at the start of the gesture. */
export function useSceneRefresh(refresh: SceneContentRefresh) {
  const scope = useContext(SceneContentContext), latest = useRef(refresh); latest.current = refresh;
  useLayoutEffect(() => scope?.registry.registerRefresh(scope.objectId, () => latest.current()), [scope?.registry, scope?.objectId]);
}
