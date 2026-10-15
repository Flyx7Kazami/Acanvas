import test from 'node:test';
import assert from 'node:assert/strict';
import { randomId } from '../src/web/random-id.js';

test('random IDs remain UUIDs when the page lacks a secure context', (t) => {
  const original = crypto.randomUUID;
  t.after(() => { Object.defineProperty(crypto, 'randomUUID', { value: original, configurable: true, writable: true }); });
  Object.defineProperty(crypto, 'randomUUID', { value: undefined, configurable: true, writable: true });
  const ids = new Set(Array.from({ length: 64 }, randomId));
  assert.equal(ids.size, 64);
  for (const id of ids) assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});
