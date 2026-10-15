import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeGif, gifLimits, scanGifStructure } from '../src/web/scene-renderer/media/gif-decoder.js';
import { gifFixture } from './fixtures/universal-media/gif-fixture.js';
const pixel = (value: Uint8ClampedArray, x: number, y: number) => [...value.subarray((y * 3 + x) * 4, (y * 3 + x + 1) * 4)];

test('on-demand GIF composition retains transparency, disposal restore and background clearing across nonfirst frames', () => {
  const decoder = decodeGif(gifFixture({ repeat: 0 }).buffer as ArrayBuffer);
  assert.equal(decoder.frameCount, 4); assert.equal(decoder.advance(0).frameIndex, 0); assert.deepEqual(pixel(decoder.copyPixels(), 0, 0), [240, 20, 40, 255]);
  assert.equal(decoder.advance(100).frameIndex, 1); assert.deepEqual(pixel(decoder.copyPixels(), 0, 0), [20, 210, 70, 255]);
  decoder.advance(200); assert.deepEqual(pixel(decoder.copyPixels(), 0, 0), [240, 20, 40, 255]); assert.deepEqual(pixel(decoder.copyPixels(), 2, 2), [30, 70, 235, 255]);
  decoder.advance(300); assert.deepEqual(pixel(decoder.copyPixels(), 0, 0), [240, 20, 40, 255]); assert.deepEqual(pixel(decoder.copyPixels(), 2, 2), [0, 0, 0, 0]);
  const loop = decoder.advance(450); assert.equal(loop.loopIndex, 1); assert.equal(loop.frameIndex, 0); assert.deepEqual(pixel(decoder.copyPixels(), 2, 2), [240, 20, 40, 255]);
});

test('GIF loop extension, no-loop final frame and zero-delay clock use explicit bounded semantics', () => {
  const once = decodeGif(gifFixture().buffer as ArrayBuffer); assert.equal(once.advance(1000).ended, true); assert.equal(once.advance(1000).frameIndex, 3);
  const repeated = decodeGif(gifFixture({ repeat: 1 }).buffer as ArrayBuffer); assert.equal(repeated.loops, 2); assert.equal(repeated.advance(900).loopIndex, 1);
  const fast = decodeGif(gifFixture({ repeat: 0, frames: [{ color: 1, left: 0, top: 0, width: 3, height: 3, disposal: 1, delay: 0 }] }).buffer as ArrayBuffer); assert.equal(fast.durationMs, 20); assert.equal(fast.advance(100000).frameIndex, 0);
});

test('GIF metadata limits precede RGBA allocation and decode steps retain only current composition', () => {
  const frames = Array.from({ length: 100 }, (_, index) => ({ color: index % 3 + 1, left: 0, top: 0, width: 3, height: 3, disposal: 1 }));
  const decoder = decodeGif(gifFixture({ frames }).buffer as ArrayBuffer); const partial = decoder.advance(9999, 2);
  assert.equal(partial.frameIndex, 1); assert.equal(partial.ready, false); assert.equal(decoder.copyPixels().byteLength, 36);
  const tooLarge = gifFixture(); tooLarge[6] = 255; tooLarge[7] = 255; tooLarge[8] = 255; tooLarge[9] = 255;
  assert.throws(() => decodeGif(tooLarge.buffer as ArrayBuffer), /four million/);
  assert.throws(() => decodeGif(new ArrayBuffer(gifLimits.bytes + 1)), /20 MiB/); assert.throws(() => decodeGif(gifFixture().subarray(0, 20).buffer.slice(0, 20) as ArrayBuffer), /incomplete/);
});

test('GIF scanning bounds image descriptors and extension records before object parsing', () => {
  const frames = Array.from({ length: 50_001 }, () => ({ color: 1, left: 0, top: 0, width: 1, height: 1, disposal: 1 }));
  const oversized = gifFixture({ frames }); assert.ok(oversized.byteLength < gifLimits.bytes);
  assert.throws(() => decodeGif(oversized.buffer as ArrayBuffer), /10000 frames/);
  const maximum = gifFixture({ repeat: 0, frames: frames.slice(0, gifLimits.frames) });
  assert.equal(scanGifStructure(maximum.buffer as ArrayBuffer).frames, gifLimits.frames);
  const base = gifFixture(), extension = new Uint8Array((gifLimits.records + 1) * 3 + base.length);
  extension.set(base.subarray(0, 25)); let offset = 25;
  for (let index = 0; index <= gifLimits.records; index++) { extension.set([0x21, 0xfe, 0], offset); offset += 3; }
  extension.set(base.subarray(25), offset);
  assert.throws(() => decodeGif(extension.buffer), /20000 parsed/);
});

test('GIF scanning validates patches, color tables, extension headers and terminated sub-blocks', () => {
  const patch = gifFixture(), image = patch.indexOf(0x2c); patch[image + 5] = 4;
  assert.throws(() => decodeGif(patch.buffer as ArrayBuffer), /patches/);
  const control = gifFixture(); control[27] = 3;
  assert.throws(() => decodeGif(control.buffer as ArrayBuffer), /control extension/);
  const application = gifFixture({ repeat: 0 }); application[27] = 10;
  assert.throws(() => decodeGif(application.buffer as ArrayBuffer), /extension header/);
  const truncated = gifFixture().slice(0, 19); truncated[truncated.length - 1] = 0x3b;
  assert.throws(() => decodeGif(truncated.buffer), /incomplete/);
  const blocks = gifFixture(); const first = blocks.indexOf(0x2c); blocks[first + 11] = 250;
  assert.throws(() => decodeGif(blocks.buffer as ArrayBuffer), /incomplete/);
});
