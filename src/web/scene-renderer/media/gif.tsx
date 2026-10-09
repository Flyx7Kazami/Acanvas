import { useEffect, useRef } from 'react';
import { useSceneContent } from '../content.js';
import { fetchGif } from './gif-decoder.js';

export function SceneGifContent({ src, title, onSize, onError }: { src: string; title: string; onSize?: (size: { width: number; height: number }) => void; onError?: (cause?: unknown) => void }) {
  const scope = useSceneContent(), ref = useRef<HTMLCanvasElement>(null), current = useRef({ scope, onSize, onError }); current.current = { scope, onSize, onError };
  useEffect(() => {
    if (!scope || !ref.current) return;
    const controller = new AbortController(); let request = 0, disposed = false;
    void fetchGif(src, controller.signal).then(decoder => {
      if (disposed || !ref.current) return;
      const canvas = ref.current; canvas.width = decoder.width; canvas.height = decoder.height; const context = canvas.getContext('2d')!;
      current.current.onSize?.({ width: decoder.width, height: decoder.height });
      const started = performance.now(); let displayed = '';
      const tick = () => {
        if (disposed || !current.current.scope) return;
        try {
          const position = decoder.advance(performance.now() - started), identity = `${position.loopIndex}:${position.frameIndex}`;
          if (displayed !== identity) {
            decoder.draw(context);
            current.current.scope.publish({ pixels: canvas, bitmap: { width: decoder.width, height: decoder.height }, fit: 'contain', media: { presentedTime: position.presentedTime, playbackTime: position.playbackTime, timePrecision: 'decoded-pts', frameIndex: position.frameIndex } });
            canvas.dataset.frameIndex = String(position.frameIndex); canvas.dataset.loopIndex = String(position.loopIndex); displayed = identity;
          }
          if (!position.ended || !position.ready) request = requestAnimationFrame(tick);
        } catch (cause) { current.current.scope.clear(); current.current.onError?.(cause); }
      };
      tick();
    }).catch(cause => { if (!disposed) { current.current.scope?.clear(); current.current.onError?.(cause); } });
    return () => { disposed = true; controller.abort(); cancelAnimationFrame(request); };
  }, [src, !!scope]);
  if (!scope) return <img src={src} alt={title} draggable={false} onLoad={event => onSize?.({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })} onError={() => onError?.()}/>;
  return <canvas ref={ref} role="img" aria-label={title} data-scene-media="gif" style={{ display: 'block', width: '100%', height: '100%' }}/>;
}
