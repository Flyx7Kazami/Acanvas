import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { acquireAudioWaveform } from './audioWaveformData';

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
    const waveform = acquireAudioWaveform(src);
    let cancelled = false, peaks: Float32Array | undefined = waveform.cached?.values, maximum = waveform.cached?.maximum ?? 1;
    active.current = true; setPlaybackError(''); setWaveformStatus(peaks ? '' : 'Loading waveform…');
    function paint() {
      const duration = Number.isFinite(media!.duration) ? media!.duration : 0, time = media!.currentTime || 0;
      const width = canvas!.clientWidth, height = canvas!.clientHeight, ratio = devicePixelRatio || 1;
      if (canvas!.width !== Math.round(width * ratio) || canvas!.height !== Math.round(height * ratio)) { canvas!.width = Math.round(width * ratio); canvas!.height = Math.round(height * ratio); }
      const context = canvas!.getContext('2d');
      if (context && width && height) {
        const style = getComputedStyle(canvas!), played = style.getPropertyValue('--audio-wave-played').trim(), unplayed = style.getPropertyValue('--audio-wave').trim(), surface = style.getPropertyValue('--audio-surface').trim();
        context.setTransform(ratio, 0, 0, ratio, 0, 0); context.clearRect(0, 0, width, height);
        if (peaks) {
          const count = Math.max(1, Math.floor(width / 5)), step = width / count;
          const position = duration ? clamp(time / duration, 0, 1) * width : 0;
          const bars = new Path2D();
          for (let bar = 0; bar < count; bar++) {
            const start = Math.floor(bar * peaks.length / count), end = Math.max(start + 1, Math.floor((bar + 1) * peaks.length / count)); let square = 0;
            for (let i = start; i < end; i++) square += peaks[i] ** 2;
            const level = Math.sqrt(square / (end - start)) / maximum, h = Math.max(3, Math.pow(level, .72) * (height - 4));
            bars.roundRect(bar * step + (step - 3) / 2, (height - h) / 2, 3, h, 1.5);
          }
          context.fillStyle = unplayed; context.fill(bars);
          if (duration) {
            context.save(); context.beginPath(); context.rect(0, 0, position, height); context.clip(); context.fillStyle = played; context.fill(bars); context.restore();
            const cursor = clamp(Math.floor(position), 0, width - 1);
            context.fillStyle = surface; context.fillRect(cursor - 1, 0, 3, height);
            context.fillStyle = played; context.fillRect(cursor, 0, 1, height);
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
    const themeObserver = new MutationObserver(paint); themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    void waveform.promise.then(data => {
      if (cancelled) return;
      peaks = data.values; maximum = data.maximum; setWaveformStatus(''); paint();
    }).catch(cause => { if (!cancelled) setWaveformStatus(cause instanceof Error ? cause.message : 'Waveform unavailable'); });
    return () => { cancelled = true; active.current = false; intent.current++; waveform.release(); cancelAnimationFrame(frame.current); observer.disconnect(); themeObserver.disconnect(); events.forEach(([name, fn]) => media.removeEventListener(name, fn)); media.pause(); };
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
