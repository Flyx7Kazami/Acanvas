import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';

const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
type Graph = { context: AudioContext; source: MediaElementAudioSourceNode; analyser: AnalyserNode; bins: Uint8Array<ArrayBuffer>; starts: Uint16Array<ArrayBuffer>; ends: Uint16Array<ArrayBuffer> };
type DisplayRefs = { bars: RefObject<HTMLDivElement | null>; rail: RefObject<HTMLInputElement | null>; current: RefObject<HTMLSpanElement | null>; total: RefObject<HTMLSpanElement | null> };

/** The media clock controls seeking; each displayed band reads a separate FFT frequency interval. */
export function useAudioSpectrum(audio: RefObject<HTMLAudioElement | null>, display: DisplayRefs, onError?: (error: unknown) => void) {
  const [state, setState] = useState({ playing: false, ready: false, duration: 0, failed: false });
  const [playbackError, setPlaybackError] = useState('');
  const playIntent = useRef(0);
  const graph = useRef<Graph | null>(null);
  const frame = useRef(0);
  const active = useRef(false);
  const reportError = useRef(onError); reportError.current = onError;
  const paint = useRef<() => void>(() => {});
  const start = useRef<() => void>(() => {});
  const stop = useRef<() => void>(() => {});

  useEffect(() => {
    const media = audio.current;
    if (!media) return;
    active.current = true;
    const bars = Array.from(display.bars.current?.children || []) as HTMLElement[];
    const writeClock = () => {
      const duration = Number.isFinite(media.duration) ? media.duration : 0;
      const current = clamp(Number.isFinite(media.currentTime) ? media.currentTime : 0, 0, duration || 0);
      const rail = display.rail.current;
      if (rail) {
        rail.max = String(duration); rail.value = String(current);
        rail.style.setProperty('--audio-progress', `${duration ? current / duration * 100 : 0}%`);
        const label = `${clock(current)} of ${clock(duration)}`;
        if (rail.getAttribute('aria-valuetext') !== label) rail.setAttribute('aria-valuetext', label);
      }
      if (display.current.current) display.current.current.textContent = clock(current);
      if (display.total.current) display.total.current.textContent = clock(duration);
    };
    const clearBars = () => bars.forEach(bar => bar.style.setProperty('--level', '0'));
    const sync = () => {
      const duration = Number.isFinite(media.duration) ? media.duration : 0;
      const next = { playing: !media.paused && !media.ended, ready: media.readyState >= 1 && duration > 0, duration, failed: !!media.error };
      setState(previous => Object.keys(next).every(key => previous[key as keyof typeof previous] === next[key as keyof typeof next]) ? previous : next);
      writeClock();
    };
    stop.current = () => { cancelAnimationFrame(frame.current); frame.current = 0; clearBars(); };
    paint.current = () => {
      const value = graph.current;
      if (!active.current || media.paused || media.ended || !value) { stop.current(); return; }
      value.analyser.getByteFrequencyData(value.bins);
      for (let band = 0; band < bars.length; band++) {
        let level = 0;
        for (let bin = value.starts[band]; bin < value.ends[band]; bin++) level = Math.max(level, value.bins[bin]);
        bars[band].style.setProperty('--level', (level / 255).toFixed(3));
      }
      writeClock();
      frame.current = requestAnimationFrame(paint.current);
    };
    start.current = () => { if (!frame.current && graph.current && !media.paused && !media.ended) frame.current = requestAnimationFrame(paint.current); };
    const began = () => { sync(); start.current(); };
    const paused = () => {
      sync();
      if (!media.paused && !media.ended) { start.current(); return; }
      playIntent.current++; stop.current(); void graph.current?.context.suspend().catch(() => {});
    };
    const failed = () => { paused(); reportError.current?.(new Error('Audio could not be decoded.')); };
    const emptied = () => { stop.current(); sync(); };
    const events: [string, EventListener][] = [['loadedmetadata', sync], ['durationchange', sync], ['timeupdate', writeClock], ['seeked', writeClock], ['play', began], ['playing', began], ['pause', paused], ['ended', paused], ['error', failed], ['emptied', emptied]];
    events.forEach(([event, handler]) => media.addEventListener(event, handler));
    sync();
    return () => {
      active.current = false;
      playIntent.current++;
      events.forEach(([event, handler]) => media.removeEventListener(event, handler));
      stop.current(); media.pause();
      const value = graph.current;
      if (value) { value.source.disconnect(); value.analyser.disconnect(); void value.context.close().catch(() => {}); graph.current = null; }
    };
  }, [audio, display.bars, display.rail, display.current, display.total]);

  const toggle = useCallback(async () => {
    const media = audio.current;
    if (!media || !active.current) return;
    const intent = ++playIntent.current;
    if (!media.paused && !media.ended) { media.pause(); return; }
    setPlaybackError('');
    try {
      if (!graph.current) {
        const context = new AudioContext(), analyser = context.createAnalyser();
        analyser.fftSize = 2048; analyser.smoothingTimeConstant = .65; analyser.minDecibels = -90; analyser.maxDecibels = -15;
        const source = context.createMediaElementSource(media);
        source.connect(analyser); analyser.connect(context.destination);
        const count = display.bars.current?.children.length || 32, starts = new Uint16Array(count), ends = new Uint16Array(count);
        const maxFrequency = Math.min(20_000, context.sampleRate / 2), binWidth = context.sampleRate / analyser.fftSize;
        for (let band = 0; band < count; band++) {
          const low = 20 * (maxFrequency / 20) ** (band / count), high = 20 * (maxFrequency / 20) ** ((band + 1) / count);
          starts[band] = clamp(Math.floor(low / binWidth), 1, analyser.frequencyBinCount - 1);
          ends[band] = clamp(Math.max(starts[band] + 1, Math.ceil(high / binWidth)), 2, analyser.frequencyBinCount);
          const bar = display.bars.current?.children[band] as HTMLElement | undefined;
          if (bar) { bar.dataset.frequencyStart = String(Math.round(low)); bar.dataset.frequencyEnd = String(Math.round(high)); }
        }
        graph.current = { context, source, analyser, bins: new Uint8Array(analyser.frequencyBinCount), starts, ends };
      }
      await graph.current.context.resume();
      if (!active.current || intent !== playIntent.current) return;
      if (media.ended) media.currentTime = 0;
      await media.play();
      if (active.current && intent === playIntent.current) start.current();
    } catch (error) {
      if (!active.current || intent !== playIntent.current || error instanceof DOMException && error.name === 'AbortError') return;
      stop.current(); void graph.current?.context.suspend().catch(() => {});
      setState(previous => ({ ...previous, playing: false, failed: !!media.error }));
      if (media.error) reportError.current?.(error);
      else setPlaybackError('Playback could not start. Try again.');
    }
  }, [audio, display.bars]);

  const seek = useCallback((seconds: number) => {
    const media = audio.current;
    if (!media || !Number.isFinite(media.duration)) return;
    media.currentTime = clamp(seconds, 0, media.duration);
    media.dispatchEvent(new Event('timeupdate'));
  }, [audio]);
  return { ...state, playbackError, toggle, seek };
}
