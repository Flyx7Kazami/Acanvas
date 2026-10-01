const MAX_SIZE = 128;
const MAX_CACHE = 48;
const MAX_PENDING = 64;
const MAX_DECODERS = 2;
const DECODE_TIMEOUT = 5000;

const cache = new Map<string, string>();
const pending = new Map<string, Promise<string | undefined>>();
const queue: { src: string; resolve: (thumbnail: string | undefined) => void }[] = [];
let active = 0;

function decodeFirstFrame(src: string): Promise<string | undefined> {
  return new Promise(resolve => {
    const video = document.createElement('video');
    video.preload = 'auto';
    video.muted = true;
    video.playsInline = true;
    let finished = false;
    let canvas: HTMLCanvasElement | undefined;
    const finish = (thumbnail?: string) => {
      if (finished) return;
      finished = true;
      window.clearTimeout(timer);
      video.removeEventListener('loadeddata', capture);
      video.removeEventListener('error', failed);
      video.pause();
      video.removeAttribute('src');
      video.load();
      if (canvas) { canvas.width = 0; canvas.height = 0; }
      resolve(thumbnail);
    };
    const failed = () => finish();
    const capture = () => {
      if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || !video.videoWidth || !video.videoHeight) return;
      try {
        canvas = document.createElement('canvas');
        const scale = Math.min(1, MAX_SIZE / Math.max(video.videoWidth, video.videoHeight));
        canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
        canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
        const context = canvas.getContext('2d');
        if (!context) { finish(); return; }
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
        finish(canvas.toDataURL('image/jpeg', .75));
      } catch { finish(); }
    };
    const timer = window.setTimeout(failed, DECODE_TIMEOUT);
    video.addEventListener('loadeddata', capture);
    video.addEventListener('error', failed);
    try { video.src = src; video.load(); }
    catch { finish(); }
  });
}

async function run(job: typeof queue[number]) {
  try {
    const thumbnail = await decodeFirstFrame(job.src);
    if (thumbnail) {
      cache.set(job.src, thumbnail);
      if (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value!);
    }
    job.resolve(thumbnail);
  } catch { job.resolve(undefined); }
  finally { pending.delete(job.src); active--; drain(); }
}

function drain() {
  while (active < MAX_DECODERS && queue.length) {
    active++;
    void run(queue.shift()!);
  }
}

export function getVideoThumbnail(src: string): Promise<string | undefined> {
  if (typeof document === 'undefined' || typeof window === 'undefined') return Promise.resolve(undefined);
  let url: URL;
  try { url = new URL(src, window.location.href); }
  catch { return Promise.resolve(undefined); }
  if (url.origin !== window.location.origin || !['http:', 'https:'].includes(url.protocol)) return Promise.resolve(undefined);
  const key = url.href;
  const thumbnail = cache.get(key);
  if (thumbnail) { cache.delete(key); cache.set(key, thumbnail); return Promise.resolve(thumbnail); }
  const existing = pending.get(key);
  if (existing) return existing;
  if (pending.size >= MAX_PENDING) return Promise.resolve(undefined);
  const result = new Promise<string | undefined>(resolve => { queue.push({ src: key, resolve }); });
  pending.set(key, result);
  drain();
  return result;
}
