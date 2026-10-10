import test from 'node:test';
import assert from 'node:assert/strict';
import { contentCapabilities, resolveContentKind, resolveContentMime, storageAssetKind } from '../src/shared/content-types.js';
import { resizeViewportBounds, snapViewportResize } from '../src/web/geometry.js';

test('content formats share MIME fallback while keeping original asset storage kinds', () => {
  for (const [name, mime, kind, storage] of [
    ['ANIMATION.GIF', '', 'gif', 'image'], ['note.md', 'text/plain', 'markdown', 'file'], ['index.htm', 'application/octet-stream', 'html', 'file'],
    ['memo.M4A', '', 'audio', 'file'], ['song.mp3', 'audio/mpeg; charset=binary', 'audio', 'file'], ['wave.wav', '', 'audio', 'file'],
    ['movie.mp4', '', 'video', 'video'], ['reference.png', '', 'image', 'image'], ['data.bin', '', 'file', 'file'],
    ['Note', 'text/x-acanvas-note', 'note', 'file'], ['memo.txt', 'text/plain', 'file', 'file'],
  ]) {
    assert.equal(resolveContentKind({ name, mime }), kind, name); assert.equal(storageAssetKind({ name, mime }), storage, name);
  }
  assert.equal(resolveContentMime('note.md', 'application/pdf'), 'application/pdf');
  assert.equal(resolveContentKind({ name: 'note.md', mime: 'application/pdf' }), 'file');
  assert.equal(contentCapabilities.audio.region, false); assert.equal(contentCapabilities.audio.time, true);
  assert.equal(contentCapabilities.markdown.region, false); assert.equal(contentCapabilities.html.interaction, true);
  assert.equal(contentCapabilities.note.freeResize, true); assert.equal(contentCapabilities.note.initial.width, 240);
});

test('document viewport resize changes width and height independently and retains opposite corners', () => {
  const original = { id: 'doc', x: 100, y: 100, width: 420, height: 320 }, minimum = { width: 180, height: 120 };
  assert.deepEqual(resizeViewportBounds(original, 'se', { x: 30, y: 0 }, minimum), { x: 100, y: 100, width: 450, height: 320 });
  assert.deepEqual(resizeViewportBounds(original, 'nw', { x: 500, y: 500 }, minimum), { x: 340, y: 300, width: 180, height: 120 });
  const target = { id: 'image', x: 551, y: 501, width: 100, height: 100 };
  const snap = snapViewportResize(original, 'se', { x: 30, y: 80 }, [original, target], { x: 0, y: 0, zoom: 1 }, { width: 900, height: 800 }, minimum);
  assert.deepEqual(snap.bounds, { x: 100, y: 100, width: 451, height: 401 }); assert.equal(snap.guides.length, 2);
});
