import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react';
import { Check } from 'lucide-react';

type Notice = { id: string; text: string; tone: 'success' | 'error'; expires: number };
export type Notification = { id: string; content: ReactNode };

export function useNotices(error: { text: string; revision: number }) {
  const [notices, setNotices] = useState<Notice[]>([]);
  const sequence = useRef(0);
  const seenError = useRef(0);
  const notify = useCallback((text: string, tone: Notice['tone'] = 'success') => {
    const notice = { id: `notice-${++sequence.current}`, text, tone, expires: Date.now() + 2800 };
    setNotices(current => [...current.filter(item => item.expires > Date.now()).slice(-4), notice]);
  }, []);
  useEffect(() => {
    if (seenError.current === error.revision) return;
    seenError.current = error.revision;
    if (error.text) notify(error.text, 'error');
  }, [error.text, error.revision, notify]);
  useEffect(() => {
    if (!notices.length) return;
    const timer = window.setTimeout(() => setNotices(current => current.filter(notice => notice.expires > Date.now())), Math.max(0, Math.min(...notices.map(notice => notice.expires)) - Date.now()));
    return () => window.clearTimeout(timer);
  }, [notices]);
  return { notices, notify };
}

type PresentedNotification = { key: string; kind: 'status' | 'notice'; content: ReactNode; count: number; active: boolean };
function activeNotifications(items: Notification[], notices: Notice[]): PresentedNotification[] {
  const latest = notices.at(-1);
  return [
    ...items.map(item => ({ key: `status:${item.id}`, kind: 'status' as const, content: item.content, count: 1, active: true })),
    ...(latest ? [{ key: latest.id, kind: 'notice' as const, count: notices.length, active: true, content: <>
      {notices.length > 1 && <div className="notification-peeks" aria-hidden="true">{Array.from({ length: Math.min(notices.length - 1, 2) }, (_, index) => <span key={index} style={{ '--peek': index + 1 } as CSSProperties}/>)}</div>}
      <div className={latest.tone === 'error' ? 'error-banner transient-error' : 'toast'} role={latest.tone === 'error' ? 'alert' : 'status'}>{latest.tone === 'success' && <Check size={14}/>}<span>{latest.text}</span></div>
    </> }] : []),
  ];
}

/** The outer box owns layout; only the inner pixels travel. */
function NotificationMotion({ active, onExit, children }: { active: boolean; onExit: () => void; children: ReactNode }) {
  const visual = useRef<HTMLDivElement>(null), exit = useRef(onExit); exit.current = onExit;
  const pose = useRef<{ opacity: string; transform: string } | undefined>(undefined);
  useLayoutEffect(() => {
    const node = visual.current!, reduced = matchMedia('(prefers-reduced-motion: reduce)');
    let animation: Animation | undefined;
    const stop = () => { if (!reduced.matches) return; animation?.cancel(); pose.current = undefined; if (!active) exit.current(); };
    if (reduced.matches) stop();
    else {
      const from = pose.current ?? { opacity: active ? '0' : '1', transform: `translateY(${active ? 8 : 0}px)` };
      animation = node.animate([from, { opacity: active ? '1' : '0', transform: `translateY(${active ? 0 : -8}px)` }], { duration: active ? 190 : 180, easing: 'cubic-bezier(.2,.8,.25,1)', fill: 'both' });
      animation.onfinish = () => { if (active) { animation?.cancel(); pose.current = undefined; } else exit.current(); };
    }
    reduced.addEventListener('change', stop);
    return () => {
      reduced.removeEventListener('change', stop);
      if (animation) { const style = getComputedStyle(node); pose.current = { opacity: style.opacity, transform: style.transform }; animation.onfinish = null; animation.cancel(); }
    };
  }, [active]);
  return <div ref={visual} className="notification-motion">{children}</div>;
}

export function NotificationStack({ items, notices, elementRef }: { items: Notification[]; notices: Notice[]; elementRef: RefObject<HTMLElement | null> }) {
  const [presented, setPresented] = useState(() => ({ items, notices, entries: activeNotifications(items, notices) }));
  // Reconcile before committing, preserving the same keyed status through an exit reversal.
  if (presented.items !== items || presented.notices !== notices) {
    const entries = activeNotifications(items, notices), keys = new Set(entries.map(entry => entry.key));
    presented.entries.forEach((entry, index) => {
      if (!keys.has(entry.key) && (entry.kind === 'status' || !notices.length)) entries.splice(Math.min(index, entries.length), 0, { ...entry, active: false });
    });
    setPresented({ items, notices, entries });
  }
  const remove = (key: string) => setPresented(current => ({ ...current, entries: current.entries.filter(entry => entry.key !== key || entry.active) }));
  return <aside ref={elementRef} className="notification-stack" aria-label="Notifications" hidden={!presented.entries.length}>
    <div className="notification-stack-content">
    {presented.entries.map(entry => <div key={entry.key} className={entry.kind === 'status' ? 'notification-status' : `notification-transients ${entry.count > 1 ? 'has-stack' : ''}`} data-count={entry.kind === 'notice' ? entry.count : undefined} data-notification-state={entry.active ? 'active' : 'leaving'} inert={!entry.active} aria-hidden={!entry.active || undefined}>
      <NotificationMotion active={entry.active} onExit={() => remove(entry.key)}>{entry.content}</NotificationMotion>
    </div>)}
    </div>
  </aside>;
}
