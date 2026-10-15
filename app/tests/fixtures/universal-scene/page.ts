import { SceneFrame, SceneRenderer, type SceneInput, type ScenePresentation, type SceneSize, type SceneEvidence, type SceneBounds } from '../../../src/web/scene-renderer/index.js';
import { SceneContentFrame } from '../../../src/web/scene-renderer/texture.js';

const canvas = document.querySelector<HTMLCanvasElement>('#scene')!;
const renderer = new SceneRenderer(canvas, { documentId: 'laboratory-document', viewId: 'laboratory-view' });
const candidates = new Map<number, SceneFrame>(), evidence = new Map<number, SceneEvidence>(), expected = new Map<number, Uint8ClampedArray>();
let evidenceId = 0;
const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
type Options = { width?: number; height?: number; scale?: number; zoom?: number; x?: number; y?: number; dark?: boolean; count?: number; changed?: boolean };
function input(seq: number, options: Options = {}): SceneInput {
  canvas.style.width = `${options.width ?? 320}px`; canvas.style.height = `${options.height ?? 240}px`;
  const rect = canvas.getBoundingClientRect(), pageScale = rect.width / (options.width ?? 320);
  const layers: SceneInput['layers'] = Array.from({ length: options.count ?? 3 }, (_, index) => {
    const bounds = { x: 12 + index % 10 * 28, y: 16 + Math.floor(index / 10) * 28, width: 24, height: 24 };
    return { objectId: `object-${index}`, assetId: `asset-${index}`, objectVersion: seq, worldBounds: bounds, clip: bounds, layer: index,
      primitives: [{ kind: 'rect' as const, bounds, fill: index % 2 ? '#397fb8' : '#d67147' }] };
  });
  layers.push({ objectId: 'animation', assetId: 'animation-asset', objectVersion: 1,
    worldBounds: { x: 42, y: 116, width: 220, height: 64 }, layer: 100,
    surface: { surfaceId: 'surface-1', instanceId: 'instance-1', frameSeq: seq, inputSeq: seq - 1, viewport: { width: 220, height: 64 } },
    primitives: [{ kind: 'rect', bounds: { x: 42, y: 116, width: 220, height: 64 }, fill: options.changed ? '#20b270' : '#9768bc' },
      { kind: 'rect', bounds: { x: 50 + seq % 15 * 6, y: 126, width: 22, height: 24 }, fill: '#ffcf3f' },
      { kind: 'text', x: 50, y: 171, text: `Frame ${seq}`, font: '14px monospace', fill: '#fff' }] });
  return { documentId: 'laboratory-document', viewId: 'laboratory-view', frameSeq: seq, baseSceneId: `base-${seq}`,
    cssViewport: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, camera: { x: (options.x ?? 0) * pageScale, y: (options.y ?? 0) * pageScale, zoom: (options.zoom ?? 1) * pageScale },
    background: options.dark ? '#171d27' : '#faf7f1', layers, media: [{ objectId: 'animation', selectedRange: { start: 1, end: 2 }, presentedTime: seq / 10, representativeTime: 1, surfaceFrameSeq: seq }],
    marks: [{ x: 140, y: 75, number: 7, fill: '#7bbcff', textFill: '#151c28' }] };
}
function size(scene: SceneInput, options: Options): SceneSize {
  const scale = options.scale ?? devicePixelRatio; return { width: Math.round(scene.cssViewport.width * scale), height: Math.round(scene.cssViewport.height * scale) };
}
function cropPixels(crop?: SceneBounds): Uint8ClampedArray {
  if (!crop) return canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
  return canvas.getContext('2d')!.getImageData(crop.x, crop.y, crop.width, crop.height).data;
}
const api = {
  render(seq: number, options: Options = {}) {
    const scene = input(seq, options), frame = SceneFrame.render(document, scene, size(scene, options)); candidates.set(seq, frame);
    // Subsequent source mutations are independent from the candidate.
    scene.camera.x = 999; scene.media[0].presentedTime = 999; scene.layers[0].worldBounds.x = 999;
    return frame.presentation;
  },
  worker(seq: number, options: Options = {}) {
    return new Promise<ScenePresentation>(resolve => {
      const receive = (event: MessageEvent<{ pixels: ImageBitmap; presentation: ScenePresentation }>) => {
        if (event.data.presentation.frameSeq !== seq) return;
        worker.removeEventListener('message', receive);
        candidates.set(seq, SceneFrame.copyBitmap(document, event.data.pixels, event.data.presentation)); event.data.pixels.close();
        resolve(event.data.presentation);
      };
      worker.addEventListener('message', receive); const scene = input(seq, options); worker.postMessage({ scene, bitmap: size(scene, options) });
    });
  },
  present(seq: number) { return renderer.present(candidates.get(seq)!); },
  presented() { return renderer.presented; },
  capture(crop?: SceneBounds) {
    const copy = renderer.capture(crop), id = ++evidenceId; evidence.set(id, copy); expected.set(id, cropPixels(copy.crop.sourcePixels));
    return { id, presentation: copy.presentation, crop: copy.crop };
  },
  async encode(id: number) {
    const copy = evidence.get(id)!, start = performance.now(), blob = await copy.encodePNG(), encodedMs = performance.now() - start;
    const pixels = await createImageBitmap(blob), output = document.createElement('canvas'); output.width = pixels.width; output.height = pixels.height;
    output.getContext('2d')!.drawImage(pixels, 0, 0); pixels.close();
    const actual = output.getContext('2d')!.getImageData(0, 0, output.width, output.height).data, original = expected.get(id)!;
    let mismatchedChannels = 0; for (let index = 0; index < actual.length; index++) if (actual[index] !== original[index]) mismatchedChannels++;
    const bytes = new Uint8Array(await blob.arrayBuffer());
    return { width: output.width, height: output.height, mismatchedChannels, comparedChannels: actual.length, bytes: bytes.length, encodedMs, png: Array.from(bytes), frameSeq: copy.presentation.frameSeq };
  },
  visiblePixel(x: number, y: number) { return Array.from(canvas.getContext('2d')!.getImageData(x, y, 1, 1).data); },
  currentPixels() { return Array.from(cropPixels()); },
  boardContent(seq: number, options: Options = {}) {
    const source = document.createElement('canvas'); source.width = 32; source.height = 32; const context = source.getContext('2d')!;
    context.fillStyle = '#db3d45'; context.fillRect(0, 0, 32, 32);
    const texture = new SceneContentFrame(document, { pixels: source, bitmap: { width: 32, height: 32 }, fit: 'fill' });
    context.fillStyle = '#20b270'; context.fillRect(0, 0, 32, 32);
    const scene = input(seq, options), bounds = { x: 0, y: 0, width: 32, height: 32 };
    scene.layers.push({ objectId: 'copied-texture', objectVersion: 1, worldBounds: bounds, layer: 200, primitives: [{ kind: 'texture', bounds, texture }] });
    const accepted = renderer.renderContent(scene, size(scene, options));
    scene.camera.x = 999; scene.media[0].presentedTime = 999; scene.layers[0].worldBounds.x = 999;
    return { accepted, presentation: renderer.presented, frozen: Object.isFrozen(texture), pixel: api.visiblePixel(8 * devicePixelRatio, 8 * devicePixelRatio) };
  },
  rejectContent(seq: number, kind: 'texture' | 'image' | 'dimensions' | 'draw') {
    const scene = input(seq), bounds = { x: 0, y: 0, width: 32, height: 32 }; let callbackCalled = false;
    if (kind === 'texture') scene.layers[0].primitives = [{ kind: 'texture', bounds, texture: { draw() { callbackCalled = true; } } }];
    if (kind === 'image') scene.layers[0].primitives = [{ kind: 'image', bounds, source: document.createElement('canvas') }];
    if (kind === 'draw') scene.layers[0].primitives = [{ kind: 'rect', bounds, fill: 'red', radius: -1 }];
    try { renderer.renderContent(scene, kind === 'dimensions' ? { width: 0, height: 0 } : size(scene, {})); return { error: 'accepted', callbackCalled }; }
    catch (error) { return { error: (error as Error).name, callbackCalled, frameSeq: renderer.presented!.frameSeq }; }
  },
  async taintedContent(seq: number, url: string) {
    const image = new Image(); image.src = url; await image.decode();
    try {
      const texture = new SceneContentFrame(document, { pixels: image, bitmap: { width: 32, height: 32 } }), scene = input(seq), bounds = { x: 0, y: 0, width: 32, height: 32 };
      scene.layers[0].primitives = [{ kind: 'texture', bounds, texture }]; renderer.renderContent(scene, size(scene, {})); return 'exported';
    } catch (error) { return (error as Error).name; }
  },
  cssZoom(value: number) { document.body.style.zoom = String(value); },
  sourceMutation(seq: number) {
    const source = document.createElement('canvas'); source.width = 32; source.height = 32; const context = source.getContext('2d')!;
    context.fillStyle = '#db3d45'; context.fillRect(0, 0, 32, 32);
    const scene = input(seq); scene.layers = [{ objectId: 'mutable-source', objectVersion: 1, worldBounds: { x: 0, y: 0, width: 32, height: 32 }, layer: 1,
      primitives: [{ kind: 'image', bounds: { x: 0, y: 0, width: 32, height: 32 }, source }] }];
    const candidate = SceneFrame.render(document, scene, size(scene, {}));
    context.fillStyle = '#20b270'; context.fillRect(0, 0, 32, 32); renderer.present(candidate);
    return api.visiblePixel(8 * devicePixelRatio, 8 * devicePixelRatio);
  },
  async taintedExport(seq: number, url: string) {
    const image = new Image(); image.src = url; await image.decode();
    const scene = input(seq); scene.layers = [{ objectId: 'cross-origin-source', objectVersion: 1, worldBounds: { x: 0, y: 0, width: 32, height: 32 }, layer: 1,
      primitives: [{ kind: 'image', bounds: { x: 0, y: 0, width: 32, height: 32 }, source: image }] }];
    try { renderer.present(SceneFrame.render(document, scene, size(scene, {}))); await renderer.capture().encodePNG(); return 'exported'; }
    catch (error) { return (error as Error).name; }
  },
  async surface(seq: number, surface: { surfaceId: string; instanceId: string; frameSeq: number; inputSeq: number; viewport: SceneSize; png: number[] }) {
    const pixels = await createImageBitmap(new Blob([new Uint8Array(surface.png)], { type: 'image/png' }));
    const scene = input(seq), bounds = { x: 12, y: 16, width: 288, height: 156 };
    scene.layers = [{ objectId: 'persistent-html', assetId: 'html-asset', objectVersion: 1, worldBounds: bounds, clip: bounds, layer: 1,
      surface: { surfaceId: surface.surfaceId, instanceId: surface.instanceId, frameSeq: surface.frameSeq, inputSeq: surface.inputSeq, viewport: surface.viewport },
      primitives: [{ kind: 'image', bounds, source: pixels }] }];
    scene.media = [{ objectId: 'persistent-html', surfaceFrameSeq: surface.frameSeq }];
    const candidate = SceneFrame.render(document, scene, size(scene, {})); pixels.close(); candidates.set(seq, candidate); return candidate.presentation;
  },
  async animateUntil(seq: number) { let current = renderer.presented!.frameSeq; while (current < seq) { await new Promise(requestAnimationFrame); current++; api.render(current, { changed: true }); api.present(current); } },
};
(window as unknown as { sceneLab: typeof api }).sceneLab = api;

document.querySelector<HTMLButtonElement>('#run')!.onclick = async () => {
  const result = document.querySelector('#result')!;
  try {
    document.querySelector<HTMLInputElement>('#comment')!.focus();
    api.render(100); api.present(100); await new Promise(requestAnimationFrame);
    const copied = api.capture(); await api.worker(105, { dark: true, changed: true, x: 40, zoom: 1.25 });
    const workerAhead = api.capture(); api.present(105);
    const png = await api.encode(copied.id), aheadPNG = await api.encode(workerAhead.id);
    const report = { result: png.mismatchedChannels === 0 && aheadPNG.mismatchedChannels === 0 ? 'passed' : 'failed', browser: navigator.userAgent,
      devicePixelRatio, presentedFrame: renderer.presented!.frameSeq, savedFrame: png.frameSeq, capturedWhileWorkerAhead: workerAhead.presentation.frameSeq,
      width: png.width, height: png.height, comparedChannels: png.comparedChannels + aheadPNG.comparedChannels, mismatchedChannels: png.mismatchedChannels + aheadPNG.mismatchedChannels,
      presentation: copied.presentation, crop: copied.crop, focus: document.activeElement?.id, url: location.href, encodedMs: png.encodedMs };
    if (new URLSearchParams(location.search).has('iab')) {
      await fetch('/scene-lab-evidence/frame100.png', { method: 'POST', body: new Uint8Array(png.png) });
      await fetch('/scene-lab-evidence/result.json', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(report) });
    }
    result.textContent = JSON.stringify(report, null, 2);
  } catch (error) { result.textContent = JSON.stringify({ result: 'failed', error: (error as Error).message }); }
};
