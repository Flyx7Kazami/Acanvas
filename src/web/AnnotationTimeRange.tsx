import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { Pause, Play } from 'lucide-react';
import { acquireAudioWaveform, type AudioWaveformData } from './audioWaveformData';
import { videoFramesAt } from './videoFrameAt';

type Range = { start: number; end: number };
type Props = { kind: 'audio' | 'video'; src: string; media?: HTMLMediaElement; start?: number; end?: number; fresh?: boolean; disabled?: boolean; onCommit: (start?: number, end?: number) => void; onError?: (cause: unknown) => void };
const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));
const clock = (value: number) => `${Math.floor(value / 60)}:${String(Math.floor(value % 60)).padStart(2, '0')}`;
const exactClock = (value: number) => { const hundredths = Math.round(value * 100); return `${Math.floor(hundredths / 6000)}:${String(Math.floor(hundredths / 100) % 60).padStart(2, '0')}.${String(hundredths % 100).padStart(2, '0')}`; };
const precise = (value: number) => Math.round(value * 100) / 100;

export function AnnotationTimeRange({ kind, src, media, start, end, fresh, disabled, onCommit, onError }: Props) {
  const [duration, setDuration] = useState(() => media?.duration || 0);
  const [wave, setWave] = useState<AudioWaveformData | undefined>(undefined);
  const [frames, setFrames] = useState<string[]>([]);
  const [playing, setPlaying] = useState(false);
  const [preview, setPreview] = useState<Range>();
  const track = useRef<HTMLDivElement>(null);
  const timeline = useRef<HTMLDivElement>(null);
  const gesture = useRef<{ pointerId: number; mode: 'start' | 'end' | 'new'; anchor: number; grabOffset: number; initial: Range } | undefined>(undefined);
  const previewing = useRef(false), previewEnd = useRef(0), previewFrame = useRef(0), previewIntent = useRef(0);
  const commit = useRef(onCommit); commit.current = onCommit;

  const stopPreview = () => {
    previewIntent.current++;
    cancelAnimationFrame(previewFrame.current);
    if (previewing.current) { previewing.current = false; media?.pause(); }
    setPlaying(false);
  };
  useEffect(() => {
    if (!media) return;
    const ended = () => { if (previewing.current) stopPreview(); };
    media.addEventListener('pause', ended); media.addEventListener('ended', ended);
    return () => { media.removeEventListener('pause', ended); media.removeEventListener('ended', ended); previewIntent.current++; cancelAnimationFrame(previewFrame.current); if (previewing.current) media.pause(); previewing.current = false; };
  }, [media]);

  useEffect(() => {
    if (!media) { setDuration(0); return; }
    const update = () => setDuration(Number.isFinite(media.duration) && media.duration > 0 ? media.duration : 0);
    update(); media.addEventListener('loadedmetadata', update); media.addEventListener('durationchange', update);
    return () => { media.removeEventListener('loadedmetadata', update); media.removeEventListener('durationchange', update); };
  }, [media]);
  useEffect(() => {
    if (kind !== 'audio') return;
    const task = acquireAudioWaveform(src); let live = true;
    setWave(task.cached);
    void task.promise.then(data => { if (live) setWave(data); }).catch(() => { if (live) setWave(undefined); });
    return () => { live = false; task.release(); };
  }, [kind, src]);
  useEffect(() => {
    if (kind !== 'video' || !duration) return;
    let live = true; const controller = new AbortController(); const urls: string[] = [];
    setFrames([]);
    void (async () => {
      const blobs = await videoFramesAt(src, Array.from({ length: 6 }, (_, index) => duration * (index + .5) / 6), 120, controller.signal);
      if (!live) return;
      urls.push(...blobs.map(blob => blob ? URL.createObjectURL(blob) : ''));
      setFrames([...urls]);
    })();
    return () => { live = false; controller.abort(); urls.forEach(url => { if (url) URL.revokeObjectURL(url); }); };
  }, [kind, src, duration]);

  const available = Number.isFinite(duration) && duration > 0;
  useEffect(() => {
    if (kind !== 'video' || !fresh || disabled || !media || !available || start !== undefined || end !== undefined) return;
    commit.current(0, precise(duration));
  }, [kind, fresh, disabled, media, available, start, end, duration]);
  const selected: Range = preview || { start: clamp(start ?? 0, 0, duration || Infinity), end: clamp(end ?? (start === undefined ? duration : start), 0, duration || Infinity) };
  const point = selected.start === selected.end;
  const position = (value: number) => available ? `${value / duration * 100}%` : '0%';
  const timeAt = (clientX: number) => {
    const rect = timeline.current?.getBoundingClientRect();
    return rect && rect.width ? precise(clamp((clientX - rect.left) / rect.width, 0, 1) * duration) : 0;
  };
  const save = (range: Range) => {
    stopPreview();
    const left = precise(clamp(Math.min(range.start, range.end), 0, duration));
    const right = precise(clamp(Math.max(range.start, range.end), 0, duration));
    if (kind === 'audio' && left === 0 && right === precise(duration)) onCommit(undefined, undefined);
    else onCommit(left, right === left ? undefined : right);
  };
  const rangeAt = (active: NonNullable<typeof gesture.current>, time: number): Range => {
    const edgeTime = clamp(time - active.grabOffset, 0, duration);
    return active.mode === 'start' ? { start: Math.min(edgeTime, active.initial.end), end: active.initial.end } : active.mode === 'end' ? { start: active.initial.start, end: Math.max(edgeTime, active.initial.start) } : { start: Math.min(active.anchor, time), end: Math.max(active.anchor, time) };
  };
  const down = (event: PointerEvent<HTMLDivElement>) => {
    if (!available || disabled || event.button !== 0) return;
    event.preventDefault(); event.stopPropagation();
    stopPreview();
    const target = event.target instanceof Element ? event.target.closest('[data-range-handle]')?.getAttribute('data-range-handle') : null;
    const mode = target === 'start' || target === 'end' ? target : 'new';
    const time = timeAt(event.clientX);
    gesture.current = { pointerId: event.pointerId, mode, anchor: time, grabOffset: mode === 'new' ? 0 : time - selected[mode], initial: selected };
    track.current?.setPointerCapture(event.pointerId);
    if (mode === 'new') setPreview({ start: time, end: time });
  };
  const motion = (event: PointerEvent<HTMLDivElement>) => {
    const active = gesture.current;
    if (!active || event.pointerId !== active.pointerId) return;
    setPreview(rangeAt(active, timeAt(event.clientX)));
  };
  const up = (event: PointerEvent<HTMLDivElement>) => {
    const active = gesture.current;
    if (!active || event.pointerId !== active.pointerId) return;
    const next = rangeAt(active, timeAt(event.clientX));
    gesture.current = undefined; setPreview(undefined); save(next);
  };
  const key = (event: KeyboardEvent<HTMLButtonElement>, edge: 'start' | 'end') => {
    if (!available || disabled) return;
    const delta = event.key === 'ArrowRight' || event.key === 'ArrowUp' ? (event.shiftKey ? 1 : .1) : event.key === 'ArrowLeft' || event.key === 'ArrowDown' ? (event.shiftKey ? -1 : -.1) : undefined;
    const value = event.key === 'Home' ? 0 : event.key === 'End' ? duration : delta === undefined ? undefined : (edge === 'start' ? selected.start : selected.end) + delta;
    if (value === undefined) return;
    event.preventDefault(); event.stopPropagation();
    save(edge === 'start' ? { start: Math.min(clamp(value, 0, duration), selected.end), end: selected.end } : { start: selected.start, end: Math.max(clamp(value, 0, duration), selected.start) });
  };

  const togglePreview = async () => {
    if (!media || !available || disabled) return;
    if (previewing.current) { stopPreview(); return; }
    const endTime = selected.end > selected.start ? selected.end : Math.min(duration, selected.start + 2);
    if (endTime <= selected.start) return;
    const intent = ++previewIntent.current;
    previewEnd.current = endTime; previewing.current = true;
    try {
      media.currentTime = selected.start;
      await media.play();
      if (intent !== previewIntent.current || !previewing.current) { media.pause(); return; }
      setPlaying(true);
      const check = () => {
        if (!previewing.current || intent !== previewIntent.current) return;
        if (media.paused || media.ended || media.currentTime >= previewEnd.current - .015) { stopPreview(); return; }
        previewFrame.current = requestAnimationFrame(check);
      };
      previewFrame.current = requestAnimationFrame(check);
    } catch (cause) { if (intent === previewIntent.current) { stopPreview(); onError?.(cause); } }
  };

  return <div className="annotation-time-range" role="group" aria-label={`${kind === 'video' ? 'Video' : 'Audio'} annotation time range`} data-ready={available}>
    <div ref={track} className={`annotation-range-track annotation-range-${kind}`} onPointerDown={down} onPointerMove={motion} onPointerUp={up} onPointerCancel={() => { gesture.current = undefined; setPreview(undefined); }} onLostPointerCapture={() => { gesture.current = undefined; setPreview(undefined); }}>
      <div ref={timeline} className="annotation-range-timeline">
        {kind === 'video' ? <div className="annotation-range-frames">{Array.from({ length: 6 }, (_, index) => <div key={index} className="annotation-range-frame" style={frames[index] ? { backgroundImage: `url(${frames[index]})` } : undefined}/>)}</div> : <div className="annotation-range-wave">{wave ? Array.from({ length: 84 }, (_, index) => { const from = Math.floor(index * wave.values.length / 84), to = Math.max(from + 1, Math.floor((index + 1) * wave.values.length / 84)); let peak = 0; for (let i = from; i < to; i++) peak = Math.max(peak, wave.values[i]); return <i key={index} style={{ height: `${Math.max(8, peak / wave.maximum * 86)}%` }}/>; }) : <span/>}</div>}
        <div className="annotation-range-selection" data-point={point} style={{ left: `calc(${position(selected.start)} - 8px)`, right: `calc(${available ? `${(duration - selected.end) / duration * 100}%` : '100%'} - 8px)` }}><i className="annotation-range-rail start"/><i className="annotation-range-rail end"/>{(['start', 'end'] as const).map(edge => <button key={edge} type="button" role="slider" aria-orientation="horizontal" data-range-handle={edge} className={`annotation-range-handle ${edge}`} aria-label={`${edge === 'start' ? 'Start' : 'End'} point`} aria-valuemin={0} aria-valuemax={duration} aria-valuenow={selected[edge]} aria-valuetext={exactClock(selected[edge])} disabled={!available || disabled} onKeyDown={event => key(event, edge)}><span/></button>)}</div>
      </div>
    </div>
    <div className="annotation-range-times"><span>{available ? clock(selected.start) : 'Time unavailable'}</span><button type="button" className="annotation-range-preview" aria-label={playing ? 'Pause range preview' : 'Play range preview'} title={playing ? 'Pause preview' : 'Preview range'} disabled={!available || disabled || selected.start >= duration} onClick={() => void togglePreview()}>{playing ? <Pause size={14} fill="currentColor"/> : <Play size={14} fill="currentColor"/>}</button><span>{available ? clock(selected.end) : ''}</span></div>
  </div>;
}
