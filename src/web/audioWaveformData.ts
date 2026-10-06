export interface AudioWaveformData { values: Float32Array; maximum: number }

const limit = 32 * 1024 * 1024;
const cacheLimit = 32;
const memory = new Map<string, AudioWaveformData>();
const pending = new Map<string, { controller: AbortController; users: number; abortTimer?: number; promise: Promise<AudioWaveformData> }>();
const storagePrefix = 'acanvas-waveform-v1:';
const storageIndex = 'acanvas-waveform-v1-index';

const immutableAsset = (url: string) => /^\/api\/assets\/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\/content$/i.test(new URL(url).pathname);

function remember(key: string, data: AudioWaveformData) {
  memory.delete(key);
  memory.set(key, data);
  if (memory.size > cacheLimit) memory.delete(memory.keys().next().value!);
}

function fromSession(key: string): AudioWaveformData | undefined {
  if (!immutableAsset(key)) return;
  try {
    const encoded = sessionStorage.getItem(storagePrefix + key);
    if (!encoded) return;
    const binary = atob(encoded);
    if (binary.length !== 1600 * 4) return;
    const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
    const values = new Float32Array(bytes.buffer);
    if (values.some(value => !Number.isFinite(value) || value < 0)) return;
    const data = { values, maximum: Math.max(...values) || 1 };
    remember(key, data);
    return data;
  } catch { return; }
}

function toSession(key: string, data: AudioWaveformData) {
  if (!immutableAsset(key) || data.values.length !== 1600) return;
  try {
    const binary = Array.from(new Uint8Array(data.values.buffer), byte => String.fromCharCode(byte)).join('');
    const index = JSON.parse(sessionStorage.getItem(storageIndex) || '[]') as string[];
    if (!Array.isArray(index)) return;
    const next = [...index.filter(item => item !== key), key];
    while (next.length > cacheLimit) sessionStorage.removeItem(storagePrefix + next.shift());
    sessionStorage.setItem(storagePrefix + key, btoa(binary));
    sessionStorage.setItem(storageIndex, JSON.stringify(next));
  } catch { /* Storage may be disabled or full; in-memory reuse still works. */ }
}

async function calculate(key: string, signal: AbortSignal): Promise<AudioWaveformData> {
  const response = await fetch(key, { credentials: 'same-origin', signal });
  if (!response.ok || !response.body) throw new Error('Waveform unavailable');
  if (Number(response.headers.get('content-length')) > limit) { await response.body.cancel(); throw new Error('Waveform supports files up to 32 MB'); }
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) { await reader.cancel(); throw new Error('Waveform supports files up to 32 MB'); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  if (signal.aborted) throw new DOMException('Waveform cancelled', 'AbortError');
  const decoded = await new OfflineAudioContext(1, 1, 44100).decodeAudioData(bytes.buffer);
  if (signal.aborted) throw new DOMException('Waveform cancelled', 'AbortError');
  const bins = Math.min(1600, decoded.length), values = new Float32Array(bins);
  for (let channel = 0; channel < decoded.numberOfChannels; channel++) {
    const samples = decoded.getChannelData(channel);
    for (let bin = 0; bin < bins; bin++) {
      const start = Math.floor(bin * samples.length / bins), end = Math.floor((bin + 1) * samples.length / bins); let square = 0;
      for (let i = start; i < end; i++) square += samples[i] * samples[i];
      values[bin] = Math.max(values[bin], Math.sqrt(square / Math.max(1, end - start)));
    }
  }
  return { values, maximum: Math.max(...values) || 1 };
}

/** Shares work between players and retains only the small, full-file envelope. */
export function acquireAudioWaveform(src: string) {
  const key = new URL(src, location.href).href;
  const cached = memory.get(key) || fromSession(key);
  if (cached) {
    remember(key, cached);
    return { cached, promise: Promise.resolve(cached), release: () => {} };
  }
  let task = pending.get(key);
  if (task?.controller.signal.aborted) { pending.delete(key); task = undefined; }
  if (!task) {
    const controller = new AbortController();
    task = { controller, users: 0, promise: undefined! };
    const current = task;
    current.promise = calculate(key, controller.signal).then(data => {
      if (!controller.signal.aborted) { remember(key, data); toSession(key, data); }
      return data;
    }).finally(() => { if (pending.get(key) === current) pending.delete(key); });
    pending.set(key, current);
  }
  task.users++;
  if (task.abortTimer !== undefined) { clearTimeout(task.abortTimer); task.abortTimer = undefined; }
  const current = task;
  return { cached: undefined, promise: current.promise, release: () => {
    current.users--;
    if (current.users === 0) current.abortTimer = window.setTimeout(() => { if (current.users === 0) current.controller.abort(); }, 0);
  } };
}
