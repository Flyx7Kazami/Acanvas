/** Samples source frames with one decoder and leaves the board's player untouched. */
export async function videoFramesAt(src: string, times: number[], size = 320, signal?: AbortSignal): Promise<(Blob | undefined)[]> {
  const video = document.createElement('video');
  video.preload = 'auto'; video.muted = true; video.playsInline = true;
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  const timeout = window.setTimeout(abort, 6000);
  const ready = new Promise<boolean>(resolve => {
    const loaded = () => { cleanup(); resolve(true); };
    const failed = () => { cleanup(); resolve(false); };
    const cleanup = () => { video.removeEventListener('loadedmetadata', loaded); video.removeEventListener('error', failed); controller.signal.removeEventListener('abort', failed); };
    video.addEventListener('loadedmetadata', loaded); video.addEventListener('error', failed); controller.signal.addEventListener('abort', failed, { once: true });
  });
  const capture = (seconds: number): Promise<Blob | undefined> => new Promise(resolve => {
    if (controller.signal.aborted) return resolve(undefined);
    let done = false;
    const finish = (blob?: Blob) => { if (done) return; done = true; clearTimeout(timer); video.removeEventListener('seeked', draw); video.removeEventListener('error', failed); controller.signal.removeEventListener('abort', failed); resolve(blob); };
    const failed = () => finish();
    const draw = () => {
      if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || !video.videoWidth || !video.videoHeight) return finish();
      try {
        const canvas = document.createElement('canvas');
        const scale = Math.min(1, size / Math.max(video.videoWidth, video.videoHeight));
        canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
        canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
        const context = canvas.getContext('2d');
        if (!context) return finish();
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
        canvas.toBlob(blob => { canvas.width = 0; canvas.height = 0; finish(blob || undefined); }, 'image/png');
      } catch { finish(); }
    };
    const timer = window.setTimeout(failed, 1000);
    video.addEventListener('error', failed, { once: true }); controller.signal.addEventListener('abort', failed, { once: true });
    const target = Math.min(Math.max(0, seconds), Math.max(0, (Number.isFinite(video.duration) ? video.duration : seconds) - .001));
    if (Math.abs(video.currentTime - target) < .002 && video.readyState >= 2) draw();
    else { video.addEventListener('seeked', draw, { once: true }); try { video.currentTime = target; } catch { finish(); } }
  });
  try {
    if (signal?.aborted) return times.map(() => undefined);
    video.src = src; video.load();
    if (!await ready) return times.map(() => undefined);
    const frames: (Blob | undefined)[] = [];
    for (const time of times) frames.push(await capture(time));
    return frames;
  } catch { return times.map(() => undefined); }
  finally { clearTimeout(timeout); signal?.removeEventListener('abort', abort); video.pause(); video.removeAttribute('src'); video.load(); }
}

export async function videoFrameAt(src: string, seconds: number, size = 320): Promise<Blob | undefined> {
  return (await videoFramesAt(src, [seconds], size))[0];
}
