import test from 'node:test';
import assert from 'node:assert/strict';
import { CanvasCamera, type CameraClock } from '../src/web/canvas-camera.js';
import { canvasWheelView } from '../src/web/canvas-wheel.js';
import { attachCameraPresentation } from '../src/web/canvas-presentation.js';
import type { SessionView } from '../src/shared/types.js';

function fixture() {
  let serial = 0;
  const frames = new Map<number, () => void>(), timers = new Map<number, () => void>();
  const clock: CameraClock = {
    requestFrame: callback => { frames.set(++serial, callback); return serial; }, cancelFrame: id => { frames.delete(id); },
    delay: callback => { timers.set(++serial, callback); return serial; }, cancelDelay: id => { timers.delete(id); },
  };
  const drain = (callbacks: Map<number, () => void>) => { const ready = [...callbacks.values()]; callbacks.clear(); ready.forEach(callback => callback()); };
  const initial: SessionView = { x: 30, y: -20, zoom: .6, selectedObjectIds: ['a'] };
  return { initial, camera: new CanvasCamera(initial, clock), clock, frame: () => drain(frames), idle: () => drain(timers), frames };
}

test('wheel bursts retain every delta and present one shared camera frame', () => {
  const f = fixture(), presented: SessionView[] = [], controls: SessionView[] = [];
  f.camera.subscribePresentation(frame => { if (frame.view !== f.initial) presented.push(frame.view); });
  f.camera.subscribe(() => controls.push(f.camera.getSnapshot()));
  const event = { clientX: 450, clientY: 280, deltaX: 0, deltaY: -1, deltaMode: 0, ctrlKey: true, metaKey: false };
  for (let i = 0; i < 120; i++) f.camera.update(canvasWheelView(f.camera.getView(), event, { left: 0, top: 0, height: 800 }));
  assert.equal(f.frames.size, 1);
  assert.ok(Math.abs(f.camera.getView().zoom - .6 * Math.exp(.6)) < 1e-10);
  assert.equal(presented.length, 0); f.frame();
  assert.equal(presented.length, 1); assert.equal(controls.length, 1); assert.equal(presented[0], controls[0]);
  assert.deepEqual(controls[0].selectedObjectIds, ['a']);
});

test('an input boundary flushes the current camera before hit testing and settles its raster', () => {
  const f = fixture(); f.camera.update({ ...f.initial, x: 95, zoom: 1.2 });
  const read = f.camera.flush();
  assert.equal(read, f.camera.getSnapshot()); assert.equal(read.x, 95); assert.equal(f.frames.size, 0);
  assert.equal(f.camera.getFrame().moving, true);
  f.idle(); assert.equal(f.camera.getFrame().moving, false); assert.equal(f.camera.getSnapshot(), read);
});

test('session restoration retires pending camera input and publishes the restored selection', () => {
  const f = fixture(); f.camera.update({ ...f.initial, zoom: 2 });
  const restored = { x: -300, y: 240, zoom: .05, selectedObjectIds: ['b'], activeGroupId: 'folder' };
  f.camera.reset(restored); f.frame(); f.idle();
  assert.equal(f.camera.getView(), restored); assert.equal(f.camera.getSnapshot(), restored);
  assert.equal(f.camera.getFrame().moving, false);
});

test('context changes publish the accumulated pose together with committed content', () => {
  const f = fixture(); f.camera.update({ ...f.initial, x: 100, zoom: 1.4 });
  f.camera.update({ ...f.camera.getView(), selectedObjectIds: ['a', 'b'] });
  f.frame(); assert.equal(f.camera.getSnapshot(), f.initial);
  f.camera.commitContext(f.camera.getView(), '');
  assert.deepEqual(f.camera.getSnapshot(), { ...f.initial, x: 100, zoom: 1.4, selectedObjectIds: ['a', 'b'] });
  f.frame(); assert.equal(f.camera.getSnapshot().zoom, 1.4);
});

test('a restored session presents after its content commits with the matching owner', () => {
  const f = fixture(), restored = { ...f.initial, x: 800, zoom: 2 };
  f.camera.reset(restored, 'next');
  f.camera.commitContext(restored, 'previous'); assert.equal(f.camera.getSnapshot(), f.initial);
  f.camera.commitContext(restored, 'next'); assert.equal(f.camera.getSnapshot(), restored);
});

test('a released raster stays released across a paint when a new zoom arrives immediately', () => {
  const f = fixture(), node = { style: { transform: '', willChange: '' }, dataset: {} } as unknown as HTMLElement;
  const detach = attachCameraPresentation(f.camera, node, f.clock);
  f.camera.update({ ...f.initial, zoom: .65 }); f.frame(); assert.equal(node.style.willChange, 'transform');
  f.camera.settle(); assert.equal(node.style.willChange, '');
  f.camera.update({ ...f.initial, zoom: .68 }); f.camera.flush();
  assert.equal(node.style.willChange, ''); f.frame(); assert.equal(node.style.willChange, '');
  f.frame(); assert.equal(node.style.willChange, 'transform'); detach();
});

test('stable zoom restores exact raster detail while translation keeps advancing', () => {
  const f = fixture(), node = { style: { transform: '', willChange: '' }, dataset: {} } as unknown as HTMLElement;
  const detach = attachCameraPresentation(f.camera, node, f.clock);
  f.camera.update({ ...f.initial, zoom: .7 }); f.frame();
  for (let i = 0; i < 7; i++) { f.camera.update({ ...f.camera.getView(), x: i * 10 }); f.frame(); }
  assert.equal(node.style.willChange, ''); assert.equal(node.dataset.cameraMoving, 'true');
  assert.equal(node.style.transform, 'translate(60px,-20px) scale(0.7)'); detach();
});

test('60 Hz scale input retains its segment across intervening 120 Hz display frames', () => {
  const f = fixture(), node = { style: { transform: '', willChange: '' }, dataset: {} } as unknown as HTMLElement;
  const detach = attachCameraPresentation(f.camera, node, f.clock);
  for (let i = 1; i <= 15; i++) {
    f.camera.update({ ...f.initial, zoom: f.initial.zoom * 1.01 ** i });
    f.frame(); f.frame(); assert.equal(node.style.willChange, 'transform');
  }
  for (let i = 0; i < 6; i++) f.frame();
  assert.equal(node.style.willChange, ''); detach();
});
