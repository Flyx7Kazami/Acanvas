import { useEffect, useRef } from 'react';
import type { MediaPresentationPosition } from '../../../shared/types.js';
import { useSceneCapture } from '../content.js';
import { fetchGif } from './gif-decoder.js';

export function SceneGifContent({ src, title, onSize, onError }: { src: string; title: string; onSize?: (size: { width: number; height: number }) => void; onError?: (cause?: unknown) => void }) {
  const ref = useRef<HTMLCanvasElement>(null), shown = useRef<{ bitmap: { width: number; height: number }; media: MediaPresentationPosition } | undefined>(undefined), current = useRef({ onSize, onError }); current.current = { onSize, onError };
  const scope = useSceneCapture(() => { const canvas = ref.current, frame = shown.current; return canvas && frame ? { pixels: canvas, bitmap: frame.bitmap, fit: 'contain', media: frame.media } : undefined; });
  const decoded = !!scope;
  useEffect(() => {
    if (!decoded || !ref.current) return;
    const controller = new AbortController(); let request = 0, timer = 0, disposed = false; shown.current = undefined;
    void fetchGif(src, controller.signal).then(decoder => {
      if (disposed || !ref.current) return;
      const canvas = ref.current; canvas.width = decoder.width; canvas.height = decoder.height; const context = canvas.getContext('2d')!;
      current.current.onSize?.({ width: decoder.width, height: decoder.height });
      const started = performance.now(); let displayed = '';
      const tick = () => {
        request = 0; timer = 0; if (disposed) return;
        try {
          const elapsed = performance.now() - started, position = decoder.advance(elapsed), identity = `${position.loopIndex}:${position.frameIndex}`;
          if (displayed !== identity) {
            decoder.draw(context); displayed = identity;
            shown.current = { bitmap: { width: decoder.width, height: decoder.height }, media: { presentedTime: position.presentedTime, playbackTime: position.playbackTime, timePrecision: 'decoded-pts', frameIndex: position.frameIndex } };
            canvas.dataset.frameIndex = String(position.frameIndex); canvas.dataset.loopIndex = String(position.loopIndex);
          }
          // advance() decodes a bounded number of frames per call.
          if (!position.ready) request = requestAnimationFrame(tick);
          else if (!position.ended) timer = window.setTimeout(tick, Math.max(0, position.presentedTime * 1000 + decoder.delays[position.frameIndex] - elapsed % decoder.durationMs));
        } catch (cause) { shown.current = undefined; current.current.onError?.(cause); }
      };
      tick();
    }).catch(cause => { if (!disposed) { shown.current = undefined; current.current.onError?.(cause); } });
    return () => { disposed = true; controller.abort(); cancelAnimationFrame(request); clearTimeout(timer); };
  }, [src, decoded]);
  if (!scope) return <img src={src} alt={title} draggable={false} onLoad={event => onSize?.({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })} onError={() => onError?.()}/>;
  return <canvas ref={ref} role="img" aria-label={title} data-scene-media="gif" style={{ display: 'block', width: '100%', height: '100%' }}/>;
}
