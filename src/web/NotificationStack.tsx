import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react';
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

export function NotificationStack({ items, notices, elementRef }: { items: Notification[]; notices: Notice[]; elementRef: RefObject<HTMLElement | null> }) {
  const latest = notices.at(-1);
  return <aside ref={elementRef} className="notification-stack" aria-label="Notifications" hidden={!items.length && !latest}>
    {items.map(item => <div key={item.id} className="notification-status">{item.content}</div>)}
    {latest && <div className={`notification-transients ${notices.length > 1 ? 'has-stack' : ''}`} data-count={notices.length}>
      {notices.length > 1 && <div className="notification-peeks" aria-hidden="true">{Array.from({ length: Math.min(notices.length - 1, 2) }, (_, index) => <span key={index} style={{ '--peek': index + 1 } as CSSProperties}/>)}</div>}
      <div key={latest.id} className={latest.tone === 'error' ? 'error-banner transient-error' : 'toast'} role={latest.tone === 'error' ? 'alert' : 'status'}>{latest.tone === 'success' && <Check size={14}/>}<span>{latest.text}</span></div>
    </div>}
  </aside>;
}
