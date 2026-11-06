import test from 'node:test';
import assert from 'node:assert/strict';
import { CanvasRasterRegions } from '../src/web/canvas-presentation.js';
import type { CameraFrame } from '../src/web/canvas-camera.js';

function rig(count = 8) {
  let serial = 0;
  const callbacks = new Map<number, () => void>();
  const clock = { requestFrame(callback: () => void) { callbacks.set(++serial, callback); return serial; }, cancelFrame(id: number) { callbacks.delete(id); } };
  const document = { activeElement: null as unknown };
  const frame = (zoom: number, moving = true, x = 0): CameraFrame => ({ view: { x, y: 0, zoom, selectedObjectIds: [] }, moving, presentation: moving ? 'composite' : 'native' });
  const regions = new CanvasRasterRegions(frame(1, false), clock), world = { style: { willChange: '' }, dataset: {} } as unknown as HTMLElement;
  regions.connect(world); regions.setViewport(1000, 800);
  const nodes = Array.from({ length: count }, () => ({ style: { willChange: '' }, dataset: {}, ownerDocument: document, contains(target: unknown) { return target === this; } }) as unknown as HTMLElement);
  const handles = nodes.map((node, i) => regions.register(String(i), node, { x: i % 4 * 100, y: Math.floor(i / 4) * 100, width: 100, height: 100 }, false));
  const sources = nodes.map((node, i) => regions.registerSource(String(i), node));
  const tick = () => { const ready = [...callbacks.values()]; callbacks.clear(); ready.forEach(callback => callback()); };
  tick(); regions.present(frame(1.01));
  assert.ok(nodes.every(node => node.style.willChange === 'transform'));
  assert.equal(callbacks.size, 0);
  return { regions, nodes, handles, sources, world, document, callbacks, tick, present: (zoom: number, moving = true, x = 0) => regions.present(frame(zoom, moving, x)) };
}

test('retained sources stay stable through the inclusive 25 percent scale budget', () => {
  const f = rig();
  for (const ratio of [1.1, 1.11, 1.2, 1.249, 1.25]) {
    f.present(1.01 * ratio);
    assert.ok(f.nodes.every(node => node.style.willChange === 'transform'));
    assert.equal(f.callbacks.size, 0, 'stable retained sources schedule no refresh-only frame');
  }
  f.regions.dispose();
});

test('crossing the scale budget releases all sources and retains the latest pose after two frames', () => {
  const f = rig(), over = 1.01 * 1.25 + .000001;
  f.present(over); assert.ok(f.nodes.every(node => node.style.willChange === ''));
  assert.equal(f.callbacks.size, 1); f.tick(); assert.ok(f.nodes.every(node => node.style.willChange === ''));
  const latest = over * 1.01; f.present(latest); f.tick();
  assert.ok(f.nodes.every(node => node.style.willChange === 'transform')); assert.equal(f.callbacks.size, 0);
  f.present(latest * 1.25); assert.ok(f.nodes.every(node => node.style.willChange === 'transform'));
  f.present(latest * 1.25 + .000001); assert.ok(f.nodes.every(node => node.style.willChange === ''));
  f.regions.dispose();
});

test('the four-times downscale budget retains its strict boundary and two-frame recovery', () => {
  const f = rig();
  f.present(1.01 / 4); assert.ok(f.nodes.every(node => node.style.willChange === 'transform'));
  assert.equal(f.world.style.willChange, 'transform');
  f.present(1.01 / 4 - .000001); assert.ok(f.nodes.every(node => node.style.willChange === ''));
  assert.equal(f.world.style.willChange, '');
  f.tick(); assert.ok(f.nodes.every(node => node.style.willChange === ''));
  assert.equal(f.world.style.willChange, '');
  f.tick(); assert.ok(f.nodes.every(node => node.style.willChange === 'transform'));
  assert.equal(f.world.style.willChange, 'transform');
  f.regions.dispose();
});

test('focus, native content, resize and source replacement keep their native boundaries', () => {
  const f = rig();
  f.document.activeElement = f.nodes[0]; f.present(1.02);
  assert.equal(f.nodes[0].style.willChange, ''); assert.equal(f.nodes[0].dataset.cameraRaster, 'false');
  f.handles[1].update({ x: 100, y: 0, width: 100, height: 100 }, true);
  assert.equal(f.nodes[1].style.willChange, ''); assert.equal(f.nodes[1].dataset.cameraRaster, 'false');
  f.handles[2].update({ x: 200, y: 0, width: 120, height: 100 }, false);
  assert.equal(f.nodes[2].style.willChange, '');
  f.sources[3]();
  const replacement = { style: { willChange: '' }, dataset: {} } as unknown as HTMLElement;
  const detach = f.regions.registerSource('3', replacement); assert.equal(replacement.style.willChange, '');
  f.tick(); assert.equal(replacement.style.willChange, ''); f.tick(); assert.equal(replacement.style.willChange, 'transform');
  assert.equal(f.nodes[0].style.willChange, ''); assert.equal(f.nodes[1].style.willChange, '');
  detach(); f.regions.dispose();
});

test('pure pan and settle restore native detail while world re-entry keeps the two-frame release', () => {
  const f = rig();
  f.present(1.01, true, 10); assert.ok(f.nodes.every(node => node.style.willChange === ''));
  assert.equal(f.world.style.willChange, '');
  f.present(1.02, true, 10); f.tick(); assert.equal(f.world.style.willChange, '');
  f.tick(); assert.equal(f.world.style.willChange, 'transform');
  f.present(1.02, false, 10); assert.ok(f.nodes.every(node => node.style.willChange === '')); assert.equal(f.world.style.willChange, '');
  f.regions.dispose(); assert.equal(f.callbacks.size, 0);
});
