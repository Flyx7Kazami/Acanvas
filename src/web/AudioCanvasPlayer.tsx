import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Download, Music2 } from 'lucide-react';
import { useAudioWaveform } from './useAudioWaveform';
import { useAudioArtwork } from './audioArtwork';
import { useControlledScenePanel } from './scene-renderer/media/use-controlled-panel.js';
import './audio-canvas.css';

export interface AudioCanvasPlayerProps {
  src: string;
  title: string;
  assetId?: string;
  disabled?: boolean;
  onElement?: (element: HTMLAudioElement | null) => void;
  onError?: (error: unknown) => void;
}

export function AudioCanvasPlayer({ src, title, assetId, disabled = false, onElement, onError }: AudioCanvasPlayerProps) {
  const player = useRef<HTMLDivElement>(null), [layout, setLayout] = useState<'compact' | 'beside' | 'stack'>('compact');
  const audio = useRef<HTMLAudioElement>(null), wave = useRef<HTMLCanvasElement>(null), slider = useRef<HTMLDivElement>(null), current = useRef<HTMLSpanElement>(null), total = useRef<HTMLSpanElement>(null);
  const notifyElement = useRef(onElement); notifyElement.current = onElement;
  const presentedTime = useRef(0);
  const panel = useControlledScenePanel(player, {
    dynamicElements: () => [wave.current, current.current, total.current].filter((element): element is HTMLElement => !!element),
    ignoreMutation: record => record.type === 'attributes' && (record.target === wave.current && ['data-ready', 'data-progress'].includes(record.attributeName ?? '')
      || record.target === slider.current && ['aria-valuemax', 'aria-valuenow', 'aria-valuetext'].includes(record.attributeName ?? ''))
      || record.type === 'childList' && (record.target === current.current || record.target === total.current),
    layoutKey: () => `${current.current?.textContent?.length}:${total.current?.textContent?.length}`,
    metadata: () => ({ media: { playbackTime: presentedTime.current, presentedTime: presentedTime.current, timePrecision: 'playback-sampled' } }), onError,
  });
  const playback = useAudioWaveform(audio, { wave, slider, current, total, onFrame: frame => { presentedTime.current = frame.time; panel.publish.current(); } }, src, onError), cover = useAudioArtwork(assetId ? src : undefined);
  const drag = useRef<{ pointer: number; playing: boolean } | null>(null);
  useLayoutEffect(() => {
    const element = player.current!;
    const measure = () => {
      const width = element.clientWidth, height = element.clientHeight;
      const next = height < 150 || width / height >= 3.5 ? 'compact' : width / height >= 1.5 ? 'beside' : 'stack';
      const scale = Math.max(.86, Math.min(2, width / 260, Math.sqrt(width * height / (520 * 88)), next === 'compact' ? height / 88 : 2));
      element.style.setProperty('--audio-font-scale', String(scale));
      setLayout(next);
    };
    measure();
    const observer = new ResizeObserver(measure); observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => { player.current?.style.setProperty('--audio-cover-ratio', '1'); }, [cover.url]);
  useEffect(() => { notifyElement.current?.(audio.current); return () => { notifyElement.current?.(null); }; }, []);
  const fractionAt = (clientX: number) => { const box = slider.current!.getBoundingClientRect(); return (clientX - box.left) / box.width; };
  function finishScrub(resume: boolean) { const value = drag.current; drag.current = null; if (resume && value?.playing && audio.current?.paused && audio.current.currentTime < audio.current.duration) void playback.toggle(); }
  const name = title.replace(/\.[^.]+$/, ''), parts = name.split(' - ');
  const track = parts.length >= 3 ? parts.slice(2).join(' - ').replace(/^\d+\s+/, '') : name;
  const subtitle = parts.length >= 3 ? parts.slice(0, 2).join(' · ') : 'Audio';
  useEffect(() => { if (disabled && drag.current) { const pointer = drag.current.pointer; finishScrub(false); if (slider.current?.hasPointerCapture(pointer)) slider.current.releasePointerCapture(pointer); } }, [disabled]);
  return <div ref={player} className="audio-canvas-player" data-layout={layout} data-playing={playback.playing}>
    <audio ref={audio} src={src} preload="metadata" aria-label={title}/>
    <div className="audio-player-art">{cover.url ? <img className="audio-player-cover" src={cover.url} alt={`Cover for ${title}`} onLoad={event => { const image = event.currentTarget; player.current?.style.setProperty('--audio-cover-ratio', String(image.naturalWidth / image.naturalHeight)); }} onError={cover.onError} draggable={false}/> : <div className="audio-player-cover audio-cover-placeholder" aria-hidden="true"><Music2 size={24}/></div>}</div>
    <div className="audio-player-body"><div className="audio-player-heading"><strong title={name}>{track}</strong><span title={subtitle}>{subtitle}</span></div>
    <div className="audio-player-transport">
    <button type="button" className="audio-player-play" data-canvas-control aria-label={playback.playing ? 'Pause audio' : 'Play audio'} aria-pressed={playback.playing} disabled={disabled || !playback.ready} onPointerDown={event => event.stopPropagation()} onClick={() => void playback.toggle()}><svg className="audio-play-mark" viewBox="0 0 24 24" aria-hidden="true"><path className="audio-mark-left" d="M6.5 4L13.25 8L13.25 16L6.5 20Z"/><path className="audio-mark-right" d="M13.25 8L20 12L20 12L13.25 16Z"/></svg></button>
    <div ref={slider} className="audio-player-waveform" data-canvas-control role="slider" tabIndex={disabled || !playback.ready ? -1 : 0} aria-label="Audio timeline" aria-orientation="horizontal" aria-valuemin={0} aria-valuemax={playback.duration} aria-valuenow={0} aria-disabled={disabled || !playback.ready} onPointerDown={event => {
      if (disabled || !playback.ready || event.button !== 0) return; event.preventDefault(); event.stopPropagation(); event.currentTarget.dataset.pointerFocus = 'true'; event.currentTarget.focus({ preventScroll: true }); event.currentTarget.setPointerCapture(event.pointerId);
      const fraction = fractionAt(event.clientX); drag.current = { pointer: event.pointerId, playing: playback.beginScrub() }; playback.seekFraction(fraction);
    }} onPointerMove={event => { if (drag.current?.pointer === event.pointerId) { playback.seekFraction(fractionAt(event.clientX)); } }} onPointerUp={event => { if (drag.current?.pointer === event.pointerId) { finishScrub(true); if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); } }} onPointerCancel={() => finishScrub(false)} onLostPointerCapture={() => { if (drag.current) finishScrub(false); }} onBlur={event => { delete event.currentTarget.dataset.pointerFocus; }} onKeyDown={event => {
      delete event.currentTarget.dataset.pointerFocus;
      if (disabled || !playback.ready) return; const time = audio.current?.currentTime || 0;
      const target = { Home: 0, End: playback.duration, ArrowLeft: time - .1, ArrowRight: time + .1, ArrowDown: time - 1, ArrowUp: time + 1, PageDown: time - 12, PageUp: time + 12 }[event.key];
      if (target !== undefined) { event.preventDefault(); event.stopPropagation(); playback.seek(target); }
    }}><canvas ref={wave} aria-hidden="true"/>{playback.waveformStatus && <span className={playback.waveformStatus === 'Loading waveform…' ? 'sr-only' : 'audio-wave-status'} role="status">{playback.waveformStatus}</span>}</div>
    <div className="audio-player-clock"><span ref={current}>0:00</span><span className="audio-player-total" aria-hidden="true"> / <span ref={total}>0:00</span></span></div>
    </div></div>
    {playback.failed && <div className="audio-player-error" data-canvas-control role="status"><span>Audio could not be played.</span><a href={src} download={title}><Download size={12}/>Download</a></div>}
    {playback.playbackError && <div className="audio-player-error" data-canvas-control role="status">{playback.playbackError}</div>}
  </div>;
}
