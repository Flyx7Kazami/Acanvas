import { useEffect, useRef } from 'react';
import { useSceneCapture } from '../content.js';

export function SceneVideoContent({ src, title, onSize, onError, onMediaElement, controls = false, tabIndex = -1 }: { src: string; title: string; onSize?: (size: { width: number; height: number }) => void; onError?: (cause?: unknown) => void; onMediaElement?: (element: HTMLMediaElement | null) => void; controls?: boolean; tabIndex?: number }) {
  const video = useRef<HTMLVideoElement>(null), current = useRef({ onMediaElement }); current.current = { onMediaElement };
  useEffect(() => { current.current.onMediaElement?.(video.current); return () => current.current.onMediaElement?.(null); }, []);
  const scope = useSceneCapture(() => {
    const element = video.current;
    if (!element || element.readyState < 2 || element.seeking || !element.videoWidth || !element.videoHeight || element.videoWidth * element.videoHeight > 8_000_000) return;
    return { pixels: element, bitmap: { width: element.videoWidth, height: element.videoHeight }, fit: 'contain', media: { playbackTime: element.currentTime, presentedTime: element.currentTime, timePrecision: 'playback-sampled' } };
  });
  return <video ref={video} playsInline preload={scope ? 'auto' : 'metadata'} controls={controls} tabIndex={tabIndex} src={src} aria-label={title} data-scene-media="video" onLoadedMetadata={event => onSize?.({ width: event.currentTarget.videoWidth, height: event.currentTarget.videoHeight })} onError={() => onError?.()}/>;
}
