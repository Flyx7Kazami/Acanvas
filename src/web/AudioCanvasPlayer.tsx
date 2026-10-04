import { useEffect, useRef } from 'react';
import { AudioLines, ChevronDown, ChevronUp, Download, RotateCcw, SkipForward } from 'lucide-react';
import { useAudioSpectrum } from './useAudioSpectrum';
import './audio-canvas.css';

export interface AudioCanvasPlayerProps {
  src: string;
  title: string;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  disabled?: boolean;
  onElement?: (element: HTMLAudioElement | null) => void;
  onError?: (error: unknown) => void;
}

export function AudioCanvasPlayer({ src, title, expanded, onExpandedChange, disabled = false, onElement, onError }: AudioCanvasPlayerProps) {
  const audio = useRef<HTMLAudioElement>(null), bars = useRef<HTMLDivElement>(null), rail = useRef<HTMLInputElement>(null), current = useRef<HTMLSpanElement>(null), total = useRef<HTMLSpanElement>(null);
  const notifyElement = useRef(onElement); notifyElement.current = onElement;
  const playback = useAudioSpectrum(audio, { bars, rail, current, total }, onError);
  useEffect(() => { notifyElement.current?.(audio.current); return () => notifyElement.current?.(null); }, []);
  return <div className="audio-canvas-player" data-expanded={expanded} data-playing={playback.playing} style={{ '--audio-morph': expanded ? 1 : 0 } as React.CSSProperties} onPointerDown={event => { if ((event.target as HTMLElement).closest('[data-canvas-control]')) event.stopPropagation(); }} onDoubleClick={event => { if ((event.target as HTMLElement).closest('[data-canvas-control]')) event.stopPropagation(); }} onKeyDown={event => { if ((event.target as HTMLElement).closest('[data-canvas-control]')) event.stopPropagation(); }} onWheel={event => { if ((event.target as HTMLElement).closest('[data-canvas-control]')) event.stopPropagation(); }}>
    <audio ref={audio} src={src} preload="metadata" aria-label={title}/>
    <div className="audio-player-art" aria-hidden="true"><AudioLines/></div>
    <div className="audio-player-title"><strong title={title}>{title}</strong><span>Audio</span></div>
    <button type="button" className="audio-player-expand" data-canvas-control aria-label={expanded ? 'Collapse audio player' : 'Expand audio player'} aria-expanded={expanded} disabled={disabled} onClick={() => onExpandedChange(!expanded)}>{expanded ? <ChevronUp size={14}/> : <ChevronDown size={14}/>}</button>
    <div ref={bars} className="audio-player-spectrum" role="img" aria-label="Live frequency spectrum">{Array.from({ length: 32 }, (_, index) => <i className="audio-frequency-bar" key={index} style={{ '--level': 0 } as React.CSSProperties}/>)}</div>
    <div className="audio-player-timeline" data-canvas-control><input ref={rail} type="range" className="audio-player-seek" aria-label="Audio timeline" min={0} max={playback.duration} step={.1} defaultValue={0} disabled={disabled || !playback.ready} onChange={event => playback.seek(Number(event.target.value))}/><div className="audio-player-clock"><span ref={current}>0:00</span><span ref={total}>0:00</span></div></div>
    <div className="audio-player-transport" data-canvas-control>
      <button type="button" aria-label="Restart audio" title="Restart audio" disabled={disabled || !playback.ready} onClick={() => playback.seek(0)}><RotateCcw size={15}/></button>
      <button type="button" className="audio-player-play" aria-label={playback.playing ? 'Pause audio' : 'Play audio'} aria-pressed={playback.playing} disabled={disabled || !playback.ready} onClick={() => void playback.toggle()}><svg className="audio-play-mark" viewBox="0 0 24 24" aria-hidden="true"><path className="audio-mark-left" d="M6.5 4L13.25 8L13.25 16L6.5 20Z"/><path className="audio-mark-right" d="M13.25 8L20 12L20 12L13.25 16Z"/></svg></button>
      <button type="button" aria-label="Skip forward 10 seconds" title="Skip forward 10 seconds" disabled={disabled || !playback.ready} onClick={() => playback.seek((audio.current?.currentTime || 0) + 10)}><SkipForward size={15}/></button>
    </div>
    {playback.failed && <div className="audio-player-error" data-canvas-control role="status"><span>Audio could not be played.</span><a href={src} download={title}><Download size={12}/>Download</a></div>}
    {playback.playbackError && <div className="audio-player-error" data-canvas-control role="status">{playback.playbackError}</div>}
  </div>;
}
