import { createContext, useCallback, useContext, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode, type RefObject } from 'react';

export const HTML_PREVIEW_LIMIT = 4;
type Slot = 'hidden' | 'waiting' | 'running' | 'stopped';
type Entry = { element: HTMLElement; intersecting: boolean; enabled: boolean };

// Reservations include previews still requesting a grant. Keep incumbents until
// they leave the viewport, stop, or the user explicitly requests another preview.
class HtmlPreviewPool {
  private entries = new Map<symbol, Entry>();
  private running = new Set<symbol>();
  private listeners = new Set<() => void>();
  private intersection?: IntersectionObserver;
  private mutations?: MutationObserver;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private visible(entry: Entry) {
    return entry.intersecting && !document.hidden && !entry.element.closest('[inert], [hidden], [aria-hidden="true"]') && entry.element.checkVisibility({ checkVisibilityCSS: true });
  }
  snapshot = (id: symbol): Slot => {
    const entry = this.entries.get(id);
    return !entry || !this.visible(entry) ? 'hidden' : !entry.enabled ? 'stopped' : this.running.has(id) ? 'running' : 'waiting';
  };
  private reconcile = () => {
    for (const id of this.running) { const entry = this.entries.get(id); if (!entry || !entry.enabled || !this.visible(entry)) this.running.delete(id); }
    for (const [id, entry] of this.entries) {
      if (this.running.size >= HTML_PREVIEW_LIMIT) break;
      if (entry.enabled && this.visible(entry)) this.running.add(id);
    }
    this.listeners.forEach(listener => listener());
  };
  register(id: symbol, element: HTMLElement) {
    if (!this.intersection) {
      this.intersection = new IntersectionObserver(changes => {
        for (const change of changes) for (const entry of this.entries.values()) if (entry.element === change.target) entry.intersecting = change.isIntersecting && change.intersectionRect.width > 0 && change.intersectionRect.height > 0;
        this.reconcile();
      }, { threshold: Number.EPSILON });
      // Closing disclosures may remain mounted and intersecting during motion.
      this.mutations = new MutationObserver(changes => {
        if (changes.some(change => [...this.entries.values()].some(entry => change.target instanceof Element && change.target.contains(entry.element)))) this.reconcile();
      });
      this.mutations.observe(document.documentElement, { subtree: true, attributes: true, attributeFilter: ['inert', 'hidden', 'aria-hidden', 'class', 'style'] });
      document.addEventListener('visibilitychange', this.reconcile);
    }
    this.entries.set(id, { element, intersecting: false, enabled: true });
    this.intersection.observe(element);
    return () => {
      this.intersection?.unobserve(element); this.entries.delete(id); this.running.delete(id); this.reconcile();
      if (!this.entries.size) {
        this.intersection?.disconnect(); this.intersection = undefined;
        this.mutations?.disconnect(); this.mutations = undefined;
        document.removeEventListener('visibilitychange', this.reconcile);
      }
    };
  }
  stop(id: symbol) { const entry = this.entries.get(id); if (entry) entry.enabled = false; this.reconcile(); }
  request(id: symbol) {
    const entry = this.entries.get(id); if (!entry) return;
    entry.enabled = true;
    if (this.visible(entry) && !this.running.has(id)) {
      if (this.running.size >= HTML_PREVIEW_LIMIT) this.running.delete(this.running.values().next().value!);
      this.running.add(id);
    }
    this.reconcile();
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
  const slot = useSyncExternalStore(pool.subscribe, () => pool.snapshot(id));
  const stop = useCallback(() => pool.stop(id), [pool, id]), request = useCallback(() => pool.request(id), [pool, id]);
  return { slot, stop, request };
}
