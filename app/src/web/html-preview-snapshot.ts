export interface HtmlSnapshot { url: string; width: number; height: number; bytes: number }
export interface HtmlSnapshotPayload { svg: string; width: number; height: number }

// One decode at a time bounds temporary image/canvas memory across the board.
let pending: Promise<unknown> = Promise.resolve();
let queued = 0;
export function rasterizeHtmlSnapshot(payload: HtmlSnapshotPayload, signal?: AbortSignal): Promise<HtmlSnapshot> {
  if (queued >= 8) return Promise.reject(new Error('Snapshot queue is full.'));
  queued++;
  const abort = () => { if (signal?.aborted) throw new DOMException('Snapshot cancelled.', 'AbortError'); };
  const work = async () => {
    abort();
    const { svg, width, height } = payload;
    if (typeof svg !== 'string' || svg.length > 6 * 1024 * 1024 || new TextEncoder().encode(svg).byteLength > 6 * 1024 * 1024 || !Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width > 4096 || height > 4096 || width * height > 8_000_000) throw new Error('Snapshot exceeds the size limit.');
    if (/<!DOCTYPE|<!ENTITY/i.test(svg)) throw new Error('Snapshot image is invalid.');
    const parsed = new DOMParser().parseFromString(svg, 'image/svg+xml'), root = parsed.documentElement;
    if (root.localName !== 'svg' || root.namespaceURI !== 'http://www.w3.org/2000/svg' || parsed.querySelector('parsererror') || root.getAttribute('width') !== String(width) || root.getAttribute('height') !== String(height)) throw new Error('Snapshot dimensions are invalid.');
    const viewBox = root.getAttribute('viewBox');
    if (viewBox && viewBox.trim().split(/[\s,]+/).map(Number).join(' ') !== `0 0 ${width} ${height}`) throw new Error('Snapshot view box is invalid.');
    if (root.hasAttribute('style')) throw new Error('Snapshot root styles are invalid.');
    if (parsed.querySelector('animate, animateMotion, animateTransform, set')) throw new Error('Snapshot animation is invalid.');
    root.setAttribute('style', `width:${width}px!important;height:${height}px!important;max-width:${width}px!important;max-height:${height}px!important;overflow:hidden!important`);
    const boundedSvg = new XMLSerializer().serializeToString(root);
    const image = new Image();
    try {
      await new Promise<void>((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout>;
        const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', cancel); image.onload = null; image.onerror = null; };
        const cancel = () => { cleanup(); image.src = ''; reject(new DOMException('Snapshot cancelled.', 'AbortError')); };
        image.onload = () => { cleanup(); resolve(); };
        image.onerror = () => { cleanup(); reject(new Error('Snapshot image could not be decoded.')); };
        timer = setTimeout(() => { cleanup(); image.src = ''; reject(new Error('Snapshot image timed out.')); }, 5000);
        signal?.addEventListener('abort', cancel, { once: true });
        // SVG loaded as an image cannot run scripts or load external resources.
        // A blob SVG would taint Chromium's canvas when it has foreignObject.
        image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(boundedSvg)}`;
      });
      abort();
      const scale = Math.min(1, 1600 / width, 1600 / height, Math.sqrt(2_000_000 / (width * height)));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(width * scale)); canvas.height = Math.max(1, Math.round(height * scale));
      try {
        const context = canvas.getContext('2d');
        if (!context) throw new Error('Snapshot canvas is unavailable.');
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        const url = canvas.toDataURL('image/png');
        if (!url.startsWith('data:image/png;base64,') || url.length > 4 * 1024 * 1024) throw new Error('Snapshot image is too large.');
        abort();
        return { url, width, height, bytes: url.length * 2 };
      } finally { canvas.width = canvas.height = 0; }
    } finally { image.src = ''; }
  };
  const result = pending.then(work, work).finally(() => { queued--; });
  pending = result.then(() => undefined, () => undefined);
  return result;
}
