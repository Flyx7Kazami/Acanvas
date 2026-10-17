import test from 'node:test';
import assert from 'node:assert/strict';
import { CanvasCamera, type CameraClock } from '../src/web/canvas-camera.js';
import { canvasWheelView } from '../src/web/canvas-wheel.js';
import { attachCameraPresentation, CanvasRasterRegions } from '../src/web/canvas-presentation.js';
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

function presentation(f: ReturnType<typeof fixture>) {
  const world = { style: { transform: '' }, dataset: {} } as unknown as HTMLElement;
  const node = { style: { willChange: '' }, dataset: {}, ownerDocument: { activeElement: null }, contains: () => false } as unknown as HTMLElement;
  const regions = new CanvasRasterRegions(f.camera.getFrame(), f.clock); regions.setViewport(1000, 800);
  regions.register('primary', node, { x: 0, y: 0, width: 300, height: 200 }, false); regions.registerSource('primary', node);
  return { world, node, regions, detach: attachCameraPresentation(f.camera, world, regions) };
}

test('content rasters release across a paint before retaining the next zoom segment', () => {
  const f = fixture(), p = presentation(f);
  f.camera.update({ ...f.initial, zoom: .65 }); f.frame(); assert.equal(p.node.style.willChange, 'transform');
  f.camera.settle(); assert.equal(p.node.style.willChange, '');
  assert.equal(p.world.style.willChange, '');
  f.camera.update({ ...f.initial, zoom: .68 }); f.camera.flush();
  assert.equal(p.node.style.willChange, ''); f.frame(); assert.equal(p.node.style.willChange, ''); assert.equal(p.world.style.willChange, '');
  f.frame(); assert.equal(p.node.style.willChange, 'transform'); assert.equal(p.world.style.willChange, 'transform'); p.detach();
});

test('stable zoom restores native content detail while translation advances', () => {
  const f = fixture(), p = presentation(f);
  f.camera.update({ ...f.initial, zoom: .7 }); f.frame();
  for (let i = 0; i < 7; i++) { f.camera.update({ ...f.camera.getView(), x: i * 10 }); f.frame(); }
  assert.equal(p.node.style.willChange, ''); assert.equal(p.world.dataset.cameraMoving, 'true');
  assert.equal(p.world.style.transform, 'translate(60px,-20px) scale(0.7)'); p.detach();
});

test('60 Hz scale input retains content across intervening 120 Hz display frames', () => {
  const f = fixture(), p = presentation(f);
  for (let i = 1; i <= 8; i++) {
    f.camera.update({ ...f.initial, zoom: f.initial.zoom * 1.01 ** i });
    f.frame(); f.frame(); assert.equal(p.node.style.willChange, 'transform');
  }
  for (let i = 0; i < 6; i++) f.frame();
  assert.equal(p.node.style.willChange, 'transform'); f.idle();
  assert.equal(p.node.style.willChange, ''); p.detach();
});

test('content refreshes independently and visible static content owns retention', () => {
  const f = fixture(), p = presentation(f);
  const nodes = Array.from({ length: 8 }, () => ({ style: { willChange: '' }, dataset: {}, ownerDocument: { activeElement: null }, contains: () => false }) as unknown as HTMLElement);
  nodes.forEach((node, index) => { const id = `item-${index}`; p.regions.register(id, node, { x: index === 6 ? 10000 : 0, y: 0, width: 100, height: 100 }, index === 7); p.regions.registerSource(id, node); });
  f.camera.update({ ...f.initial, zoom: .61 }); f.frame();
  assert.equal(nodes[6].style.willChange, ''); assert.equal(nodes[7].style.willChange, '');
  f.camera.update({ ...f.initial, zoom: .68 }); f.frame();
  assert.equal([p.node, ...nodes.slice(0, 6)].filter(node => node.style.willChange === '').length, 4);
  assert.equal(p.world.style.willChange, 'transform');
  f.camera.update({ ...f.initial, zoom: .9 }); f.camera.flush();
  assert.ok(nodes.slice(0, 6).every(node => node.style.willChange === ''));
  f.camera.settle();
  assert.ok(nodes.every(node => node.style.willChange === '')); p.detach();
});

test('zooming out retains available text detail while camera composition refreshes', () => {
  const f = fixture(), p = presentation(f);
  f.camera.update({ ...f.initial, zoom: .61 }); f.frame();
  f.camera.update({ ...f.initial, zoom: .3 }); f.frame();
  assert.equal(p.node.style.willChange, 'transform'); assert.equal(p.world.style.willChange, '');
  f.frame(); f.frame(); assert.equal(p.node.style.willChange, 'transform');
  f.camera.update({ ...f.initial, zoom: .1 }); f.camera.flush(); assert.equal(p.node.style.willChange, '');
  f.idle(); assert.equal(p.world.style.willChange, ''); p.detach();
});

test('a large visible page uses a bounded text raster pool', () => {
  const f = fixture(), p = presentation(f);
  const nodes = Array.from({ length: 100 }, () => ({ style: { willChange: '' }, dataset: {}, ownerDocument: { activeElement: null }, contains: () => false }) as unknown as HTMLElement);
  nodes.forEach((node, index) => { const id = `budget-${index}`; p.regions.register(id, node, { x: 0, y: 0, width: 100, height: 100 }, false); p.regions.registerSource(id, node); });
  f.camera.update({ ...f.initial, zoom: .61 }); f.frame();
  assert.equal([p.node, ...nodes].filter(node => node.style.willChange === 'transform').length, 32);
  f.idle(); assert.ok(nodes.every(node => node.style.willChange === '')); p.detach();
});
