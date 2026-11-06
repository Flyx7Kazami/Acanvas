import { sameViewContext, type CanvasCamera, type CameraClock, type CameraFrame } from './canvas-camera.js';
import type { Rect } from './geometry.js';

type FrameClock = Pick<CameraClock, 'requestFrame' | 'cancelFrame'>;
const browserFrames: FrameClock = { requestFrame: callback => requestAnimationFrame(callback), cancelFrame: id => cancelAnimationFrame(id) };
const rasterRegionLimit = 32;
const rasterDownscaleLimit = 4;
type Region = { id: string; node: HTMLElement; bounds: Rect; nativeContent: boolean; zoom: number; releasing: number; retained: boolean; admitted: boolean };

/** Camera composition and content paint sources own separate raster lifetimes. */
export class CanvasRasterRegions {
  private world?: HTMLElement;
  private regions = new Map<string, Region>();
  private sources = new Map<string, Set<HTMLElement>>();
  private frame: CameraFrame;
  private viewport = { width: 0, height: 0 };
  private scaling = false;
  private rasterFrame = 0;
  private worldRelease = 0;
  private worldRasterZoom = 0;
  constructor(initial: CameraFrame, private clock: FrameClock = browserFrames) { this.frame = initial; }
  connect(world: HTMLElement) { this.world = world; }
  private schedule() { if (!this.rasterFrame) this.rasterFrame = this.clock.requestFrame(this.updateRasters); }

  register(id: string, node: HTMLElement, bounds: Rect, nativeContent: boolean) {
    const region: Region = { id, node, bounds, nativeContent, zoom: this.frame.view.zoom, releasing: 0, retained: false, admitted: false };
    this.regions.set(id, region);
    node.dataset.cameraRegion = 'false';
    for (const source of this.sources.get(id) ?? []) source.dataset.cameraRaster = 'false';
    this.schedule();
    return {
      update: (bounds: Rect, nativeContent: boolean) => {
        if (this.regions.get(id) !== region) return;
        if (nativeContent !== region.nativeContent || bounds.x !== region.bounds.x || bounds.y !== region.bounds.y || bounds.width !== region.bounds.width || bounds.height !== region.bounds.height) this.schedule();
        if (nativeContent || bounds.width !== region.bounds.width || bounds.height !== region.bounds.height) {
          this.native(region); if (region.releasing) this.schedule();
        }
        region.bounds = bounds; region.nativeContent = nativeContent;
        if (nativeContent) this.admit(region, false);
      },
      dispose: () => { if (this.regions.get(id) === region) { this.admit(region, false); this.native(region); delete node.dataset.cameraRegion; this.regions.delete(id); } },
    };
  }

  registerSource(id: string, node: HTMLElement) {
    let sources = this.sources.get(id);
    if (!sources) { sources = new Set(); this.sources.set(id, sources); }
    sources.add(node); node.dataset.cameraSource = 'true'; node.dataset.cameraRaster = String(this.regions.get(id)?.admitted ?? false);
    const region = this.regions.get(id);
    if (region) { this.native(region); this.schedule(); }
    return () => {
      sources.delete(node);
      if (this.sources.get(id) === sources) {
        node.style.willChange = ''; delete node.dataset.cameraSource; delete node.dataset.cameraRaster;
        if (!sources.size) this.sources.delete(id);
      }
    };
  }

  setViewport(width: number, height: number) { this.viewport = { width, height }; this.schedule(); }
  private visible(region: Region) {
    const { x, y, zoom } = this.frame.view, bounds = region.bounds;
    return x + (bounds.x + bounds.width) * zoom >= 0 && x + bounds.x * zoom <= this.viewport.width
      && y + (bounds.y + bounds.height) * zoom >= 0 && y + bounds.y * zoom <= this.viewport.height;
  }
  private admit(region: Region, admitted: boolean) {
    if (region.admitted === admitted) return;
    region.admitted = admitted;
    region.node.dataset.cameraRegion = String(admitted);
    if (!admitted) this.native(region);
    for (const source of this.sources.get(region.id) ?? []) source.dataset.cameraRaster = String(admitted);
  }
  private planRasters() {
    const pending: { region: Region; area: number }[] = [];
    const { x, y, zoom } = this.frame.view;
    let admitted = 0;
    for (const region of this.regions.values()) {
      if (region.nativeContent || !this.sources.get(region.id)?.size || !this.visible(region) || region.node.contains(region.node.ownerDocument.activeElement)) { this.admit(region, false); continue; }
      if (region.admitted) { admitted++; continue; }
      const b = region.bounds;
      const width = Math.min(this.viewport.width, x + (b.x + b.width) * zoom) - Math.max(0, x + b.x * zoom);
      const height = Math.min(this.viewport.height, y + (b.y + b.height) * zoom) - Math.max(0, y + b.y * zoom);
      pending.push({ region, area: width * height });
    }
    // Retained surfaces have a fixed compositor cost; larger visible text viewports receive the available slots first.
    if (admitted >= rasterRegionLimit) return;
    pending.sort((a, b) => b.area - a.area);
    for (const { region } of pending.slice(0, rasterRegionLimit - admitted)) this.admit(region, true);
  }
  private native(region: Region) {
    if (region.retained) region.releasing = 2;
    for (const source of this.sources.get(region.id) ?? []) if (source.style.willChange) source.style.willChange = '';
    region.retained = false; region.zoom = this.frame.view.zoom;
  }
  private releaseWorld() {
    if (!this.world?.style.willChange) return;
    this.world.style.willChange = '';
    this.worldRasterZoom = 0;
    this.worldRelease = 2;
  }
  private retainWorld(zoom = this.frame.view.zoom) {
    if (!this.world || this.worldRelease) return;
    this.world.style.willChange = 'transform';
    this.worldRasterZoom = zoom;
  }
  private exact() {
    this.scaling = false;
    this.releaseWorld();
    if (this.world) {
      if (this.world.dataset.cameraScaling !== 'false') this.world.dataset.cameraScaling = 'false';
    }
    for (const region of this.regions.values()) this.native(region);
    this.schedule();
  }

  present(frame: CameraFrame) {
    const previous = this.frame.view, changed = frame.view.zoom !== previous.zoom;
    const translated = frame.view.x !== previous.x || frame.view.y !== previous.y;
    this.frame = frame;
    if (!frame.moving || (this.scaling && !changed && translated)) { this.exact(); return; }
    if (changed && !this.scaling) {
      this.scaling = true;
      if (this.world) {
        this.world.dataset.cameraScaling = 'true';
        this.retainWorld(Math.max(previous.zoom, frame.view.zoom));
      }
    }
    if (!this.scaling) return;
    if (this.worldRasterZoom && frame.view.zoom < this.worldRasterZoom / rasterDownscaleLimit) {
      this.releaseWorld();
      this.schedule();
    }
    this.planRasters();
    for (const region of this.regions.values()) {
      // Downscaling reuses detail already available in the source. Bound oversampling to four times the display scale.
      if (region.retained && (frame.view.zoom > region.zoom * 1.25 || frame.view.zoom < region.zoom / rasterDownscaleLimit)) {
        this.native(region); this.schedule();
      }
    }
    if (this.scaling && !this.rasterFrame) this.updateRasters();
  }

  private updateRasters = () => {
    this.rasterFrame = 0;
    this.planRasters();
    const zoom = this.frame.view.zoom;
    let work = false;
    if (this.worldRelease) {
      if (--this.worldRelease) work = true;
      else if (this.scaling) this.retainWorld();
    }
    for (const region of this.regions.values()) {
      if (region.releasing) {
        if (--region.releasing) { work = true; continue; }
        region.zoom = zoom;
      }
      if (!this.scaling || !region.admitted || region.nativeContent || !this.visible(region) || region.node.contains(region.node.ownerDocument.activeElement)) { this.native(region); work ||= !!region.releasing; continue; }
      const sources = this.sources.get(region.id);
      if (!sources?.size) continue;
      if (!region.retained) {
        region.zoom = zoom; region.retained = true;
        for (const source of sources) source.style.willChange = 'transform';
      }
    }
    if (work) this.schedule();
  };

  dispose() {
    this.exact(); this.clock.cancelFrame(this.rasterFrame); this.rasterFrame = 0;
    for (const region of this.regions.values()) delete region.node.dataset.cameraRegion;
    for (const sources of this.sources.values()) for (const source of sources) { source.style.willChange = ''; delete source.dataset.cameraSource; delete source.dataset.cameraRaster; }
    this.regions.clear(); this.sources.clear(); this.world = undefined; this.worldRelease = 0;
  }
}

class CameraTransformWriter {
  private animation?: Animation;
  private transform = '';
  constructor(private node: HTMLElement) {}
  get animated() { return !!this.animation; }
  write(transform: string, animate: boolean) {
    this.transform = transform;
    if (animate) {
      const keyframes = [{ transform }, { transform }];
      if (this.animation) (this.animation.effect as KeyframeEffect).setKeyframes(keyframes);
      else {
        this.animation = this.node.animate(keyframes, { duration: 1000, fill: 'both' });
        this.animation.pause(); this.animation.currentTime = 0;
      }
    } else this.commit();
  }
  commit() {
    this.node.style.transform = this.transform;
    this.animation?.cancel(); this.animation = undefined;
  }
}

export function attachCameraPresentation(camera: CanvasCamera, node: HTMLElement, regions?: CanvasRasterRegions) {
  regions?.connect(node);
  const writer = new CameraTransformWriter(node);
  let previous = camera.getFrame().view;
  const render = (frame: CameraFrame) => {
    const scaled = frame.view.zoom !== previous.zoom, translated = frame.view.x !== previous.x || frame.view.y !== previous.y;
    const animate = frame.presentation === 'composite' && frame.moving && sameViewContext(previous, frame.view) && (scaled || writer.animated && !translated);
    writer.write(`translate3d(${frame.view.x}px,${frame.view.y}px,0) scale(${frame.view.zoom})`, animate);
    previous = frame.view;
    const moving = String(frame.moving);
    if (node.dataset.cameraMoving !== moving) node.dataset.cameraMoving = moving;
    regions?.present(frame);
  };
  const unsubscribe = camera.subscribePresentation(render);
  render(camera.getFrame());
  return () => { unsubscribe(); writer.commit(); regions?.dispose(); };
}
