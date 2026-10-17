import type { CanvasCamera, CameraClock, CameraFrame } from './canvas-camera.js';

type FrameClock = Pick<CameraClock, 'requestFrame' | 'cancelFrame'>;
const browserFrames: FrameClock = { requestFrame: callback => requestAnimationFrame(callback), cancelFrame: id => cancelAnimationFrame(id) };

/** Native content rasterization and camera compositing have separate lifetimes. */
export function attachCameraPresentation(camera: CanvasCamera, node: HTMLElement, clock: FrameClock = browserFrames) {
  let rasterZoom = camera.getFrame().view.zoom, lastZoom = rasterZoom;
  let refreshFrame = 0, scaleFrame = 0, scaling = false;
  const refreshRaster = () => {
    node.style.willChange = '';
    if (refreshFrame) return;
    // Keep retention released across a paint, including inputs arriving in the same frame.
    refreshFrame = clock.requestFrame(() => {
      refreshFrame = clock.requestFrame(() => {
        refreshFrame = 0; rasterZoom = camera.getFrame().view.zoom;
        if (scaling && camera.getFrame().moving) node.style.willChange = 'transform';
      });
    });
  };
  const exactScale = (zoom: number) => {
    const retained = !!node.style.willChange;
    scaling = false; node.style.willChange = '';
    if (retained || rasterZoom !== zoom) refreshRaster();
  };
  const render = ({ view, moving }: CameraFrame) => {
    if (!moving) {
      clock.cancelFrame(scaleFrame); scaleFrame = 0; exactScale(view.zoom); lastZoom = view.zoom;
    } else if (view.zoom !== lastZoom) {
      scaling = true; lastZoom = view.zoom; clock.cancelFrame(scaleFrame);
      // Three quiet display frames also accommodate 60 Hz input on a 120 Hz display.
      let quiet = 0;
      const settledScale = () => {
        if (++quiet < 3) scaleFrame = clock.requestFrame(settledScale);
        else { scaleFrame = 0; exactScale(camera.getFrame().view.zoom); }
      };
      scaleFrame = clock.requestFrame(settledScale);
    }
    if (scaling && !refreshFrame) {
      if (view.zoom > rasterZoom * 1.25 || view.zoom < rasterZoom / 1.25) refreshRaster();
      else node.style.willChange = 'transform';
    }
    node.style.transform = `translate(${view.x}px,${view.y}px) scale(${view.zoom})`;
    node.dataset.cameraMoving = String(moving);
  };
  const unsubscribe = camera.subscribePresentation(render);
  render(camera.getFrame());
  return () => { unsubscribe(); clock.cancelFrame(refreshFrame); clock.cancelFrame(scaleFrame); node.style.willChange = ''; };
}
