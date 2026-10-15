import test from 'node:test';
import assert from 'node:assert/strict';
import { presentedContentAnchor } from '../src/web/scene-renderer/media/markdown-anchor.js';

test('presented content anchor retains the painted selection and returns a mutable independent value', () => {
  const frame = Object.freeze({ contentAnchor: Object.freeze({ kind: 'text' as const, scroll: Object.freeze({ x: 0, y: 20 }), quote: 'painted words', path: 'rendered-dom:p[0]', start: 2, end: 15 }) });
  const read = presentedContentAnchor(frame)!; read.scroll!.y = 220; read.quote = 'requested words';
  assert.equal(frame.contentAnchor.scroll.y, 20); assert.equal(frame.contentAnchor.quote, 'painted words'); assert.equal(presentedContentAnchor(undefined), undefined);
});
