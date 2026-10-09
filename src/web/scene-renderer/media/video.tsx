import { useEffect, useLayoutEffect, useRef } from 'react';
import { useSceneContent } from '../content.js';
import { observeVideoFrames } from './video-source.js';

export function SceneVideoContent({ src, title, onSize, onError, onMediaElement, controls = false, tabIndex = -1 }: { src: string; title: string; onSize?: (size: { width: number; height: number }) => void; onError?: (cause?: unknown) => void; onMediaElement?: (element: HTMLMediaElement | null) => void; controls?: boolean; tabIndex?: number }) {
  const scope = useSceneContent(), video = useRef<HTMLVideoElement>(null), current = useRef({ scope, onError, onMediaElement }); current.current = { scope, onError, onMediaElement };
  useEffect(() => { current.current.onMediaElement?.(video.current); return () => current.current.onMediaElement?.(null); }, []);
  useLayoutEffect(() => {
    if (!scope || !video.current) return;
    scope.clear();
    return observeVideoFrames(video.current, frame => current.current.scope?.publish({ pixels: frame.pixels, bitmap: frame.bitmap, fit: 'contain', media: frame.media }), cause => { current.current.scope?.clear(); current.current.onError?.(cause); }, () => current.current.scope?.clear());
  }, [src, !!scope]);
  return <video ref={video} playsInline preload={scope ? 'auto' : 'metadata'} controls={controls} tabIndex={tabIndex} src={src} aria-label={title} data-scene-media="video" onLoadedMetadata={event => onSize?.({ width: event.currentTarget.videoWidth, height: event.currentTarget.videoHeight })} onError={() => onError?.()}/>;
}
