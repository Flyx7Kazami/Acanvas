import { useEffect, useState } from 'react';

const cache = new Map<string, boolean>(), pending = new Map<string, Promise<string | null>>();
const endpoint = (src: string) => src.replace(/\/content(?:\?.*)?$/, '/artwork');
async function loadArtwork(src: string): Promise<string | null> {
  const key = endpoint(src), exists = cache.get(key);
  if (exists !== undefined) { cache.delete(key); cache.set(key, exists); return exists ? key : null; }
  const running = pending.get(key); if (running) return running;
  const job = (async () => {
    const response = await fetch(key, { method: 'HEAD', credentials: 'same-origin' });
    if (response.status !== 204 && !response.ok) throw new Error('Audio artwork is temporarily unavailable.');
    const available = response.status === 200 && ['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(response.headers.get('Content-Type') || '') && Number(response.headers.get('Content-Length')) <= 2 * 1024 * 1024;
    if (response.status === 204 || available) { cache.set(key, available); while (cache.size > 64) cache.delete(cache.keys().next().value!); }
    return available ? key : null;
  })().finally(() => pending.delete(key));
  pending.set(key, job); return job;
}

export function useAudioArtwork(src?: string) {
  const [value, setValue] = useState<{ src: string; url: string | null }>();
  useEffect(() => {
    if (!src) return;
    let active = true, retries = 0, timer = 0;
    const load = () => { void loadArtwork(src).then(url => { if (active) setValue({ src, url }); }).catch(() => { if (active && retries++ < 2) timer = window.setTimeout(load, 1000); }); };
    const retry = () => { retries = 0; load(); };
    load(); window.addEventListener('online', retry); window.addEventListener('focus', retry);
    return () => { active = false; clearTimeout(timer); window.removeEventListener('online', retry); window.removeEventListener('focus', retry); };
  }, [src]);
  return { url: value && value.src === src ? value.url : null, onError: () => { if (src) setValue({ src, url: null }); } };
}
