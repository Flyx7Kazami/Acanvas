import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';

const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
type DisplayRefs = { wave: RefObject<HTMLCanvasElement | null>; slider: RefObject<HTMLDivElement | null>; current: RefObject<HTMLSpanElement | null>; total: RefObject<HTMLSpanElement | null> };

/** The full-file amplitude envelope and native playback share the same time axis. */
export function useAudioWaveform(audio: RefObject<HTMLAudioElement | null>, display: DisplayRefs, src: string, onError?: (error: unknown) => void) {
  const [state, setState] = useState({ playing: false, ready: false, duration: 0, failed: false });
  const [playbackError, setPlaybackError] = useState(''), [waveformStatus, setWaveformStatus] = useState('Loading waveform…');
  const draw = useRef(() => {}), frame = useRef(0), active = useRef(false), intent = useRef(0);
  const reportError = useRef(onError); reportError.current = onError;
  useEffect(() => {
    const media = audio.current, canvas = display.wave.current, slider = display.slider.current;
    if (!media || !canvas || !slider) return;
    const controller = new AbortController(); let cancelled = false, peaks: Float32Array | undefined, maximum = 1;
    active.current = true; setPlaybackError(''); setWaveformStatus('Loading waveform…');
    function paint() {
      const duration = Number.isFinite(media!.duration) ? media!.duration : 0, time = media!.currentTime || 0;
      const width = canvas!.clientWidth, height = canvas!.clientHeight, ratio = devicePixelRatio || 1;
      if (canvas!.width !== Math.round(width * ratio) || canvas!.height !== Math.round(height * ratio)) { canvas!.width = Math.round(width * ratio); canvas!.height = Math.round(height * ratio); }
      const context = canvas!.getContext('2d');
      if (context && width && height) {
        context.setTransform(ratio, 0, 0, ratio, 0, 0); context.clearRect(0, 0, width, height);
        if (peaks) {
          const count = Math.max(1, Math.floor(width / 5)), step = width / count;
          for (let bar = 0; bar < count; bar++) {
            const start = Math.floor(bar * peaks.length / count), end = Math.max(start + 1, Math.floor((bar + 1) * peaks.length / count)); let square = 0;
            for (let i = start; i < end; i++) square += peaks[i] ** 2;
            const level = Math.sqrt(square / (end - start)) / maximum, h = Math.max(3, Math.pow(level, .72) * (height - 4));
            context.fillStyle = duration && (bar + .5) / count <= time / duration ? '#f5f5f5' : '#999';
            context.beginPath(); context.roundRect(bar * step + (step - 3) / 2, (height - h) / 2, 3, h, 1.5); context.fill();
          }
        }
      }
      canvas!.dataset.ready = String(!!peaks); canvas!.dataset.progress = String(duration ? time / duration : 0);
      slider!.setAttribute('aria-valuemax', String(duration)); slider!.setAttribute('aria-valuenow', String(time)); slider!.setAttribute('aria-valuetext', `${clock(time)} of ${clock(duration)}`);
      if (display.current.current) display.current.current.textContent = clock(time);
      if (display.total.current) display.total.current.textContent = clock(duration);
    }
    draw.current = paint;
    const sync = () => { const duration = Number.isFinite(media.duration) ? media.duration : 0; setState({ playing: !media.paused && !media.ended, ready: media.readyState >= 1 && duration > 0 && !media.error, duration, failed: !!media.error }); paint(); };
    const tick = () => { paint(); if (!cancelled && !media.paused && !media.ended) frame.current = requestAnimationFrame(tick); };
    const play = () => { cancelAnimationFrame(frame.current); sync(); tick(); };
    const pause = () => { intent.current++; cancelAnimationFrame(frame.current); sync(); };
    const error = () => { pause(); reportError.current?.(new Error('Audio could not be decoded.')); };
    const events: [string, EventListener][] = [['loadedmetadata', sync], ['durationchange', sync], ['play', play], ['pause', pause], ['ended', pause], ['error', error], ['timeupdate', paint], ['seeked', paint], ['emptied', sync]];
    events.forEach(([name, fn]) => media.addEventListener(name, fn));
    const observer = new ResizeObserver(paint); observer.observe(canvas); sync();
    void (async () => {
      try {
        const response = await fetch(src, { credentials: 'same-origin', signal: controller.signal });
        if (!response.ok || !response.body) throw new Error('Waveform unavailable');
        const limit = 32 * 1024 * 1024;
        if (Number(response.headers.get('content-length')) > limit) { await response.body.cancel(); throw new Error('Waveform supports files up to 32 MB'); }
        const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
        for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > limit) { await reader.cancel(); throw new Error('Waveform supports files up to 32 MB'); } chunks.push(value); }
        const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
        const decoded = await new OfflineAudioContext(1, 1, 44100).decodeAudioData(bytes.buffer);
        if (cancelled) return;
        const bins = Math.min(1600, decoded.length), values = new Float32Array(bins);
        for (let channel = 0; channel < decoded.numberOfChannels; channel++) {
          const samples = decoded.getChannelData(channel);
          for (let bin = 0; bin < bins; bin++) {
            const start = Math.floor(bin * samples.length / bins), end = Math.floor((bin + 1) * samples.length / bins); let square = 0;
            for (let i = start; i < end; i++) square += samples[i] ** 2;
            values[bin] = Math.max(values[bin], Math.sqrt(square / Math.max(1, end - start)));
          }
        }
        peaks = values; maximum = Math.max(...values) || 1; setWaveformStatus(''); paint();
      } catch (cause) { if (!cancelled) setWaveformStatus(cause instanceof Error ? cause.message : 'Waveform unavailable'); }
    })();
    return () => { cancelled = true; active.current = false; intent.current++; controller.abort(); cancelAnimationFrame(frame.current); observer.disconnect(); events.forEach(([name, fn]) => media.removeEventListener(name, fn)); media.pause(); };
  }, [src, audio, display.wave, display.slider, display.current, display.total]);
  const toggle = useCallback(async () => {
    const media = audio.current; if (!media || !active.current) return;
    const generation = ++intent.current;
    if (!media.paused && !media.ended) { media.pause(); return; }
    setPlaybackError('');
    try { if (media.ended) media.currentTime = 0; await media.play(); }
    catch (cause) { if (active.current && generation === intent.current && !(cause instanceof DOMException && cause.name === 'AbortError')) setPlaybackError('Playback could not start. Try again.'); }
  }, [audio]);
  const seek = useCallback((time: number) => { const media = audio.current; if (media && Number.isFinite(media.duration)) { media.currentTime = clamp(time, 0, media.duration); draw.current(); } }, [audio]);
  const seekFraction = useCallback((fraction: number) => seek(clamp(fraction, 0, 1) * (audio.current?.duration || 0)), [audio, seek]);
  const beginScrub = useCallback(() => { const media = audio.current, playing = !!media && !media.paused; media?.pause(); return playing; }, [audio]);
  return { ...state, playbackError, waveformStatus, toggle, seek, seekFraction, beginScrub };
}
