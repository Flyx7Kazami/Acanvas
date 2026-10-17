import assert from 'node:assert/strict';
import { test } from 'node:test';
import { acquireTextSource } from '../src/web/text-source.js';
import { editableTextBytes } from '../src/shared/content-types.js';

test('concurrent editors share a read and retain independent cancellation', async t => {
  let finish!: (response: Response) => void, signal!: AbortSignal;
  const fetch = t.mock.method(globalThis, 'fetch', (_url: string, options: RequestInit) => {
    signal = options.signal!;
    return new Promise<Response>(resolve => { finish = resolve; });
  });
  const first = acquireTextSource('/asset/shared'), second = acquireTextSource('/asset/shared');
  assert.equal(fetch.mock.callCount(), 1);
  first.release(); first.release();
  assert.equal(signal.aborted, false);
  finish(new Response('Shared source'));
  assert.equal(await second.promise, 'Shared source');
  second.release();
  assert.equal(signal.aborted, false);
});

test('the last reader cancels and a later reader starts a fresh request', async t => {
  const signals: AbortSignal[] = [];
  t.mock.method(globalThis, 'fetch', (_url: string, options: RequestInit) => new Promise<Response>((_resolve, reject) => {
    const signal = options.signal!; signals.push(signal);
    signal.addEventListener('abort', () => reject(signal.reason));
  }));
  const first = acquireTextSource('/asset/cancelled'), second = acquireTextSource('/asset/cancelled');
  const firstFailure = assert.rejects(first.promise), secondFailure = assert.rejects(second.promise);
  first.release(); assert.equal(signals[0].aborted, false);
  second.release(); assert.equal(signals[0].aborted, true);
  const next = acquireTextSource('/asset/cancelled');
  const nextFailure = assert.rejects(next.promise);
  await Promise.all([firstFailure, secondFailure]);
  assert.equal(signals.length, 2); assert.equal(signals[1].aborted, false);
  const joined = acquireTextSource('/asset/cancelled');
  assert.equal(joined.promise, next.promise);
  joined.release(); next.release(); await nextFailure;
});

test('completed reads release source data and sessions use distinct requests', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response('Source'));
  const a = acquireTextSource('/asset/source?sessionId=a'), b = acquireTextSource('/asset/source?sessionId=b');
  await Promise.all([a.promise, b.promise]); a.release(); b.release();
  const next = acquireTextSource('/asset/source?sessionId=a'); await next.promise; next.release();
  assert.equal(fetch.mock.callCount(), 3);
});

test('failed reads can retry and text size checks cover headers and decoded bytes', async t => {
  const responses = [new Response('unavailable', { status: 503 }), new Response('large', { headers: { 'Content-Length': String(editableTextBytes + 1) } }), new Response('界'.repeat(Math.ceil(editableTextBytes / 3))), new Response('Ready')];
  t.mock.method(globalThis, 'fetch', async () => responses.shift()!);
  for (const message of [/unavailable/, /2 MB/, /2 MB/]) {
    const request = acquireTextSource('/asset/retry'); await assert.rejects(request.promise, message); request.release();
  }
  const request = acquireTextSource('/asset/retry'); assert.equal(await request.promise, 'Ready'); request.release();
});
