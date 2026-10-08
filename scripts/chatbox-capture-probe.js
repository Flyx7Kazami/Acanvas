/* Experimental controls copied into an isolated build by the capture laboratory.
 * This file is outside the product bundle and provides no production host bridge. */
(() => {
  const handle = crypto.randomUUID();
  const logs = [];
  let stream, video;
  const panel = document.createElement('section');
  panel.id = 'capture-laboratory';
  panel.style.cssText = 'position:fixed;z-index:1000;right:12px;top:12px;width:370px;padding:12px;background:#fff;border:1px solid #aaa;border-radius:8px;font:12px monospace;color:#111';
  panel.innerHTML = '<strong>Capture laboratory</strong><div><button id="lab-media">Play media</button> <button id="lab-share">Share this tab</button> <button id="lab-frame">Capture frame</button> <button id="lab-stop">Stop sharing</button></div><pre id="lab-log" style="white-space:pre-wrap;max-height:160px;overflow:auto"></pre>';
  document.body.appendChild(panel);
  const log = value => { logs.push(value); panel.querySelector('pre').textContent = JSON.stringify(logs.slice(-4), null, 2); };
  const capabilities = { secureContext: isSecureContext, getDisplayMedia: typeof navigator.mediaDevices?.getDisplayMedia, setCaptureHandleConfig: typeof navigator.mediaDevices?.setCaptureHandleConfig, getCaptureHandle: typeof MediaStreamTrack?.prototype.getCaptureHandle, dpr: devicePixelRatio, viewport: { width: innerWidth, height: innerHeight } };
  try { navigator.mediaDevices?.setCaptureHandleConfig?.({ handle, exposeOrigin: true, permittedOrigins: [location.origin] }); } catch (error) { capabilities.captureHandleError = error.name; }
  log({ capabilities });
  const checkSource = track => {
    const settings = track.getSettings(), identity = track.getCaptureHandle?.();
    if (settings.displaySurface !== 'browser') throw new Error('source_not_browser');
    if (!identity || identity.handle !== handle || identity.origin !== location.origin) throw new Error('source_identity_unverified');
    return { settings, identity: { ownHandleMatches: true, originMatches: true } };
  };
  const freshFrame = (source, signal, timeout = 1200) => new Promise((accept, reject) => {
    let callback;
    const done = (error, result) => { clearTimeout(timer); signal?.removeEventListener('abort', abort); if (callback !== undefined) source.cancelVideoFrameCallback(callback); error ? reject(error) : accept(result); };
    const abort = () => done(new DOMException('Capture cancelled', 'AbortError'));
    const timer = setTimeout(() => done(new Error('frame_timeout')), timeout);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) return abort();
    callback = source.requestVideoFrameCallback((now, metadata) => done(null, { now, ...metadata }));
  });
  const cropMapping = (rect, sourceWidth, sourceHeight) => {
    const sx = sourceWidth / innerWidth, sy = sourceHeight / innerHeight;
    if (Math.abs(sx - sy) > .01) throw new Error('viewport_capture_aspect_mismatch');
    const left = Math.max(0, Math.floor(rect.x * sx)), top = Math.max(0, Math.floor(rect.y * sy));
    const right = Math.min(sourceWidth, Math.ceil((rect.x + rect.width) * sx)), bottom = Math.min(sourceHeight, Math.ceil((rect.y + rect.height) * sy));
    return { viewport: { width: innerWidth, height: innerHeight, devicePixelRatio }, source: { width: sourceWidth, height: sourceHeight }, cssRect: rect, pixelRect: { x: left, y: top, width: right - left, height: bottom - top }, scale: { x: sx, y: sy }, worldTransform: document.querySelector('.canvas-world')?.style.transform };
  };
  async function share() {
    const began = performance.now();
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({ video: { displaySurface: 'browser', frameRate: 30 }, audio: false, selfBrowserSurface: 'include', preferCurrentTab: true, surfaceSwitching: 'exclude' });
      const track = stream.getVideoTracks()[0];
      track.addEventListener('ended', () => log({ event: 'source-ended' }));
      track.addEventListener('capturehandlechange', () => { try { checkSource(track); } catch (error) { stream.getTracks().forEach(item => item.stop()); log({ event: 'identity-changed', error: error.message }); } });
      const source = checkSource(track);
      video = document.createElement('video'); video.muted = true; video.playsInline = true; video.srcObject = stream;
      await video.play(); await freshFrame(video);
      log({ event: 'sharing', elapsedMs: performance.now() - began, ...source });
      return source;
    } catch (error) { stream?.getTracks().forEach(track => track.stop()); log({ event: 'share-error', name: error.name, message: error.message, elapsedMs: performance.now() - began }); throw error; }
  }
  const layout = () => JSON.stringify({ view: document.querySelector('.canvas-world')?.style.transform, viewport: [innerWidth, innerHeight, devicePixelRatio], objects: [...document.querySelectorAll('.board-object')].map(element => [element.dataset.objectId, element.dataset.objectVersion, element.getBoundingClientRect().toJSON()]), scroll: document.querySelector('.markdown-content')?.scrollTop });
  async function captureOnce(rect, options) {
    if (!stream || !video || stream.getVideoTracks()[0]?.readyState !== 'live') throw new Error('sharing_required');
    checkSource(stream.getVideoTracks()[0]);
    const hidden = [...document.querySelectorAll('[data-lab-editor], #capture-laboratory')].map(element => ({ element, visibility: element.style.visibility }));
    hidden.forEach(({ element }) => element.style.visibility = 'hidden');
    const started = performance.now(), before = layout();
    try {
      await new Promise(accept => requestAnimationFrame(() => requestAnimationFrame(accept)));
      // The stream runs continuously. Wait for a newly delivered frame after
      // the editing controls disappear; its time is saved, not reconstructed.
      const frame = await freshFrame(video, options.signal, options.frameTimeoutMs ?? 1200);
      const ready = performance.now(), mapping = cropMapping(rect, video.videoWidth, video.videoHeight), pixel = mapping.pixelRect;
      const canvas = document.createElement('canvas'); canvas.width = pixel.width; canvas.height = pixel.height;
      const drawAt = performance.now(); canvas.getContext('2d').drawImage(video, pixel.x, pixel.y, pixel.width, pixel.height, 0, 0, pixel.width, pixel.height);
      const drawMs = performance.now() - drawAt, encodeAt = performance.now();
      const blob = await new Promise(accept => canvas.toBlob(accept, 'image/png'));
      if (!blob) throw new Error('encoding_failed');
      if (options.signal?.aborted) throw new DOMException('Capture cancelled', 'AbortError');
      options.afterDraw?.();
      if (before !== layout()) throw new Error('layout_changed');
      const result = { frame, mapping, bytes: blob.size, waitMs: ready - started, drawMs, encodeMs: performance.now() - encodeAt, totalMs: performance.now() - started };
      log({ event: 'captured', ...result });
      return { blob, ...result };
    } finally { hidden.forEach(({ element, visibility }) => element.style.visibility = visibility); }
  }
  async function capture(rect = { x: 70, y: 70, width: innerWidth - 100, height: innerHeight - 120 }, options = {}) {
    const began = performance.now(), attempts = options.maxAttempts ?? 2, totalTimeoutMs = options.totalTimeoutMs ?? 2500;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const remaining = totalTimeoutMs - (performance.now() - began);
      if (remaining <= 0) throw new Error('capture_timeout');
      try {
        const result = await captureOnce(rect, { ...options, frameTimeoutMs: Math.min(options.frameTimeoutMs ?? 1200, remaining) });
        return { ...result, attempts: attempt, retryCount: attempt - 1, completeMs: performance.now() - began };
      } catch (error) { if (!['layout_changed', 'frame_timeout'].includes(error.message) || attempt === attempts) throw error; }
    }
  }
  document.querySelector('#lab-media').onclick = async () => {
    document.querySelector('.html-content')?.focus();
    const results = await Promise.allSettled([...document.querySelectorAll('.board-object video')].map(media => { media.muted = true; media.loop = true; return media.play(); }));
    const md = document.querySelector('.markdown-content'); if (md) md.scrollTop = 240;
    log({ event: 'media-start', results: results.map(result => result.status) });
  };
  document.querySelector('#lab-share').onclick = () => share().catch(() => {});
  document.querySelector('#lab-frame').onclick = () => capture().catch(error => log({ event: 'capture-error', name: error.name, message: error.message }));
  document.querySelector('#lab-stop').onclick = () => { stream?.getTracks().forEach(track => track.stop()); log({ event: 'app-stop', readyState: stream?.getVideoTracks()[0]?.readyState }); };
  window.captureLaboratory = { capabilities, logs, share, capture, cropMapping, checkSource, freshFrame, get stream() { return stream; }, get video() { return video; }, handle };
})();
