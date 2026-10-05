import { createContext, useCallback, useContext, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode, type RefObject } from 'react';
import type { HtmlSnapshot } from './html-preview-snapshot';

export const HTML_PREVIEW_LIMIT = 4;
export const HTML_SNAPSHOT_LIMIT = 64;
export const HTML_SNAPSHOT_BYTES = 64 * 1024 * 1024;
type Slot = 'hidden' | 'waiting' | 'capturing' | 'live' | 'freezing' | 'frozen' | 'stopped';
type Entry = { element: HTMLElement; intersecting: boolean; attempted: boolean; requested: boolean; phase?: 'capturing' | 'live' | 'freezing'; width: number; height: number; generation: number; resizeTimer?: number };
type Cached = { image: HtmlSnapshot; cost: number };

// Both initial screenshot jobs and explicit interactive previews reserve slots,
// including pending grants and the short capture handoff before an eviction.
class HtmlPreviewPool {
  private entries = new Map<symbol, Entry>();
  private active = new Set<symbol>();
  private cache = new Map<symbol, Cached>();
  private cacheBytes = 0;
  private listeners = new Set<() => void>();
  private version = 0;
  private permits = 0;
  private permitQueue: (() => void)[] = [];
  private intersection?: IntersectionObserver;
  private mutations?: MutationObserver;
  private resize?: ResizeObserver;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  snapshot = () => this.version;
  // A cancelled POST can still issue a grant. Keep its permit until the late
  // response is revoked, even after its visual slot has been reassigned.
  acquire(signal: AbortSignal): Promise<() => void> {
    return new Promise((resolve, reject) => {
      const cancel = () => { this.permitQueue = this.permitQueue.filter(value => value !== grant); reject(new DOMException('Preview cancelled.', 'AbortError')); };
      const grant = () => {
        signal.removeEventListener('abort', cancel);
        if (signal.aborted) { cancel(); return; }
        this.permits++; let released = false;
        resolve(() => {
          if (released) return; released = true; this.permits--;
          this.permitQueue.shift()?.();
        });
      };
      if (signal.aborted) { cancel(); return; }
      signal.addEventListener('abort', cancel, { once: true });
      if (this.permits < HTML_PREVIEW_LIMIT) grant(); else this.permitQueue.push(grant);
    });
  }
  private visible(entry: Entry) {
    return entry.intersecting && !document.hidden && !entry.element.closest('[inert], [hidden], [aria-hidden="true"]') && entry.element.checkVisibility({ checkVisibilityCSS: true });
  }
  read(id: symbol) {
    const entry = this.entries.get(id), image = this.cache.get(id)?.image;
    const slot: Slot = !entry || !this.visible(entry) ? 'hidden' : entry.phase || (entry.requested || !entry.attempted ? 'waiting' : image ? 'frozen' : 'stopped');
    return { slot, image, width: entry?.width || 0, height: entry?.height || 0, generation: entry?.generation || 0 };
  }
  private release(id: symbol) { const entry = this.entries.get(id); if (entry) entry.phase = undefined; this.active.delete(id); }
  private reconcile = () => {
    for (const id of this.active) {
      const entry = this.entries.get(id);
      if (!entry || !this.visible(entry)) {
        if (entry && entry.phase !== 'capturing') { entry.attempted = true; entry.requested = false; }
        this.release(id);
      }
    }
    // Explicit requests have priority. Warm-up never evicts an interactive frame.
    for (const [id, entry] of this.entries) {
      if (!entry.requested || !this.visible(entry) || this.active.has(id)) continue;
      if (this.active.size >= HTML_PREVIEW_LIMIT) {
        const warming = [...this.active].find(key => this.entries.get(key)?.phase === 'capturing');
        if (warming) this.release(warming);
        else {
          if (![...this.active].some(key => this.entries.get(key)?.phase === 'freezing')) {
            const oldest = this.entries.get(this.active.values().next().value!); if (oldest) oldest.phase = 'freezing';
          }
          break;
        }
      }
      entry.phase = 'live'; entry.requested = false; this.active.add(id);
    }
    for (const [id, entry] of this.entries) {
      if (this.active.size >= HTML_PREVIEW_LIMIT) break;
      if (!entry.attempted && !entry.phase && this.visible(entry) && entry.width > 0 && entry.height > 0) { entry.phase = 'capturing'; this.active.add(id); }
    }
    this.version++; this.listeners.forEach(listener => listener());
  };
  register(id: symbol, element: HTMLElement) {
    if (!this.intersection) {
      this.intersection = new IntersectionObserver(changes => {
        for (const change of changes) for (const entry of this.entries.values()) if (entry.element === change.target) entry.intersecting = change.isIntersecting && change.intersectionRect.width > 0 && change.intersectionRect.height > 0;
        this.reconcile();
      }, { threshold: Number.EPSILON });
      this.mutations = new MutationObserver(changes => {
        if (changes.some(change => [...this.entries.values()].some(entry => change.target instanceof Element && change.target.contains(entry.element)))) this.reconcile();
      });
      this.mutations.observe(document.documentElement, { subtree: true, attributes: true, attributeFilter: ['inert', 'hidden', 'aria-hidden', 'class', 'style'] });
      this.resize = new ResizeObserver(changes => {
        for (const change of changes) for (const [id, entry] of this.entries) if (entry.element === change.target) {
          const width = Math.round(change.contentRect.width), height = Math.round(change.contentRect.height);
          clearTimeout(entry.resizeTimer);
          if (width <= 0 || height <= 0 || entry.width === width && entry.height === height) continue;
          entry.resizeTimer = window.setTimeout(() => {
            entry.width = width; entry.height = height; entry.generation++;
            if (!entry.phase && this.cache.has(id)) entry.attempted = false;
            this.reconcile();
          }, 200);
        }
      });
      document.addEventListener('visibilitychange', this.reconcile);
    }
    this.entries.set(id, { element, intersecting: false, attempted: false, requested: false, width: element.clientWidth, height: element.clientHeight, generation: 0 });
    this.intersection.observe(element); this.resize!.observe(element);
    return () => {
      clearTimeout(this.entries.get(id)?.resizeTimer);
      this.intersection?.unobserve(element); this.resize?.unobserve(element);
      this.entries.delete(id); this.release(id); this.removeImage(id); this.reconcile();
      if (!this.entries.size) {
        this.intersection?.disconnect(); this.intersection = undefined;
        this.mutations?.disconnect(); this.mutations = undefined;
        this.resize?.disconnect(); this.resize = undefined;
        document.removeEventListener('visibilitychange', this.reconcile);
      }
    };
  }
  private removeImage(id: symbol) { const old = this.cache.get(id); if (old) { this.cacheBytes -= old.cost; this.cache.delete(id); } }
  complete(id: symbol, generation: number, image?: HtmlSnapshot) {
    const entry = this.entries.get(id); if (!entry || entry.generation !== generation || !this.active.has(id) || entry.phase === 'live') return;
    if (image) {
      const cost = image.url.length * 2 + image.width * image.height * 4;
      if (cost <= HTML_SNAPSHOT_BYTES) {
        this.removeImage(id); this.cache.set(id, { image, cost }); this.cacheBytes += cost;
        while (this.cache.size > HTML_SNAPSHOT_LIMIT || this.cacheBytes > HTML_SNAPSHOT_BYTES) {
          const oldest = [...this.cache.keys()].find(key => key !== id && !this.visible(this.entries.get(key)!)) || this.cache.keys().next().value!;
          this.removeImage(oldest);
        }
      }
    }
    entry.attempted = true; entry.requested = false; this.release(id); this.reconcile();
  }
  fail(id: symbol, generation: number) {
    const entry = this.entries.get(id); if (!entry || entry.generation !== generation) return;
    entry.attempted = true; entry.requested = false; this.release(id); this.reconcile();
  }
  stop(id: symbol) {
    const entry = this.entries.get(id); if (!entry) return;
    entry.requested = false; entry.attempted = true;
    if (entry.phase === 'live') entry.phase = 'freezing'; else this.release(id);
    this.reconcile();
  }
  request(id: symbol) {
    const entry = this.entries.get(id); if (!entry) return;
    entry.attempted = true;
    if (entry.phase) entry.phase = 'live'; else entry.requested = true;
    this.reconcile();
  }
  retry(id: symbol) {
    const entry = this.entries.get(id); if (!entry) return;
    entry.attempted = false; entry.requested = false; this.release(id); entry.generation++; this.reconcile();
  }
}

const PreviewContext = createContext<HtmlPreviewPool | null>(null);
export function HtmlPreviewProvider({ children }: { children: ReactNode }) {
  const [pool] = useState(() => new HtmlPreviewPool());
  return <PreviewContext.Provider value={pool}>{children}</PreviewContext.Provider>;
}

export function useHtmlPreviewSlot(element: RefObject<HTMLDivElement | null>) {
  const pool = useContext(PreviewContext), id = useRef(Symbol('html-preview')).current;
  if (!pool) throw new Error('HTML previews require a board preview provider.');
  useLayoutEffect(() => { if (element.current) return pool.register(id, element.current); }, [pool, id, element]);
  useSyncExternalStore(pool.subscribe, pool.snapshot);
  const stop = useCallback(() => pool.stop(id), [pool, id]), request = useCallback(() => pool.request(id), [pool, id]);
  const complete = useCallback((generation: number, image?: HtmlSnapshot) => pool.complete(id, generation, image), [pool, id]);
  const fail = useCallback((generation: number) => pool.fail(id, generation), [pool, id]);
  const acquire = useCallback((signal: AbortSignal) => pool.acquire(signal), [pool]);
  const retry = useCallback(() => pool.retry(id), [pool, id]);
  return { ...pool.read(id), stop, request, complete, retry, fail, acquire };
}
