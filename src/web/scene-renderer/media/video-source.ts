import type { MediaPresentationPosition } from '../../../shared/types.js';

export interface VideoTextureFrame { pixels: HTMLVideoElement; bitmap: { width: number; height: number }; media: MediaPresentationPosition; observedFrames?: number }
/** The publisher synchronously copies the current native decoder frame and its observed timing. */
export function observeVideoFrames(video: HTMLVideoElement, publish: (frame: VideoTextureFrame) => void, onError?: (cause: unknown) => void, onUnavailable?: () => void): () => void {
  let disposed = false, callback = 0, animation = 0, generation = 0, presentedTime: number | undefined;
  let source = video.src, waitingForData = video.readyState < 2, seeking = video.seeking;
  let seekStartedAt = seeking ? performance.now() : 0, minimumPresentationTime = 0, lastPresentationTime = -Infinity, lastPlaybackTime = video.currentTime;
  const observed = typeof video.requestVideoFrameCallback === 'function';
  const reset = (minimum = performance.now()) => { generation++; if (callback) video.cancelVideoFrameCallback(callback); callback = 0; minimumPresentationTime = minimum; };
  const sourceChanged = () => {
    source = video.src; waitingForData = true; seeking = false; seekStartedAt = 0; presentedTime = undefined; lastPresentationTime = -Infinity;
    delete video.dataset.presentedTime; delete video.dataset.timePrecision;
    reset(); onUnavailable?.();
  };
  const ready = () => !disposed && !waitingForData && !video.seeking && !seeking && video.readyState >= 2 && !!video.videoWidth && !!video.videoHeight;
  const paint = (metadata?: VideoFrameCallbackMetadata) => {
    if (!ready()) return;
    try {
      if (video.videoWidth * video.videoHeight > 8_000_000) throw new Error('Video textures support frames up to eight million pixels.');
      presentedTime = metadata?.mediaTime ?? video.currentTime;
      publish({ pixels: video, bitmap: { width: video.videoWidth, height: video.videoHeight }, media: { playbackTime: video.currentTime, presentedTime, timePrecision: metadata ? 'rvfc-observed' : 'playback-sampled' }, ...(metadata ? { observedFrames: metadata.presentedFrames } : {}) });
      video.dataset.presentedTime = String(presentedTime); video.dataset.timePrecision = metadata ? 'rvfc-observed' : 'playback-sampled';
      lastPlaybackTime = video.currentTime; if (metadata) lastPresentationTime = metadata.presentationTime;
    } catch (cause) { onError?.(cause); }
  };
  const schedule = () => {
    if (!observed || disposed || callback || waitingForData || seeking) return;
    const ownerGeneration = generation, ownerSource = source;
    const request = video.requestVideoFrameCallback((_now, metadata) => {
      if (disposed || ownerGeneration !== generation || ownerSource !== source) return;
      if (callback === request) callback = 0;
      if (video.src !== source) { sourceChanged(); return; }
      if (video.seeking) { seeking = true; seekStartedAt = performance.now(); reset(seekStartedAt); return; }
      // A native loop starts a new timeline; compositor submission timestamps still increase.
      if (video.currentTime < lastPlaybackTime) { reset(lastPresentationTime); lastPlaybackTime = video.currentTime; paint(); schedule(); return; }
      if (ready() && Number.isFinite(metadata.presentationTime) && metadata.presentationTime >= minimumPresentationTime && metadata.presentationTime > lastPresentationTime) paint(metadata);
      schedule();
    });
    callback = request;
  };
  const beginSeek = () => { if (video.src !== source) sourceChanged(); if (!seeking) seekStartedAt = performance.now(); seeking = true; reset(seekStartedAt); };
  const completeSeek = () => { seeking = false; reset(seekStartedAt || performance.now()); waitingForData = video.readyState < 2; lastPlaybackTime = video.currentTime; paint(); schedule(); };
  const loaded = () => { if (video.src !== source) sourceChanged(); waitingForData = video.readyState < 2; seeking = video.seeking; reset(); lastPlaybackTime = video.currentTime; paint(); schedule(); };
  const refresh = () => { if (video.src !== source) { sourceChanged(); return; } if (video.seeking) { beginSeek(); return; } reset(); lastPlaybackTime = video.currentTime; paint(); schedule(); };
  const tick = () => { if (video.src !== source) sourceChanged(); if (ready() && video.currentTime !== presentedTime) paint(); if (!disposed) animation = requestAnimationFrame(tick); };
  const error = () => { reset(); waitingForData = true; onUnavailable?.(); onError?.(new Error(video.error?.message || 'Video could not be decoded.')); };
  const events: [string, EventListener][] = [['loadstart', sourceChanged], ['emptied', sourceChanged], ['loadeddata', loaded], ['seeking', beginSeek], ['seeked', completeSeek], ['play', refresh], ['pause', refresh], ['resize', refresh], ['error', error]];
  for (const [event, handler] of events) video.addEventListener(event, handler);
  if (ready()) paint(); schedule(); if (!observed) animation = requestAnimationFrame(tick);
  return () => { disposed = true; reset(); cancelAnimationFrame(animation); for (const [event, handler] of events) video.removeEventListener(event, handler); };
}
