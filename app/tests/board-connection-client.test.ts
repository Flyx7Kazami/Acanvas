import test from 'node:test';
import assert from 'node:assert/strict';
import { BoardConnection, BoardConnectionError } from '../src/web/board-connection.js';
import type { CaptureView } from '../src/shared/types.js';

class Socket extends EventTarget {
  static OPEN = 1;
  static instances: Socket[] = [];
  readyState = 0;
  sent: any[] = [];
  constructor(public url: URL) { super(); Socket.instances.push(this); }
  send(value: string) { this.sent.push(JSON.parse(value)); }
  close() { this.readyState = 3; this.dispatchEvent(new Event('close')); }
  open() { this.readyState = 1; this.dispatchEvent(new Event('open')); }
  message(value: object) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) })); }
}
const view: CaptureView = { projectId: 'owned-project', sessionId: 'owned-session', documentId: 'owned-document', viewId: 'owned-view', viewGeneration: 1 };

test('one page shares events and view transport, ignores canceled acknowledgements and releases each owner', async () => {
  const originalSocket = globalThis.WebSocket, originalWindow = globalThis.window;
  Object.assign(globalThis, { WebSocket: Socket, window: { location: { href: 'http://127.0.0.1:1234/?session=owned' } } }); Socket.instances = [];
  try {
    const connection = new BoardConnection('owned-instance'), events = new AbortController(), first = new AbortController(), second = new AbortController();
    let eventReady = 0, firstReady = 0, secondReady = 0, changes = 0;
    const eventWatch = connection.watchEvents(events.signal, () => eventReady++, () => changes++);
    const firstWatch = connection.watchView(view, first.signal, () => firstReady++); first.abort(); await firstWatch;
    assert.equal(Socket.instances.length, 1); const socket = Socket.instances[0];
    assert.equal(socket.url.href, 'ws://127.0.0.1:1234/api/connection'); socket.open();
    assert.deepEqual(socket.sent, [{ type: 'events', id: 1 }]);
    socket.message({ type: 'view-ready', id: 2, view }); assert.equal(firstReady, 0);
    socket.message({ type: 'ready', id: 1, instanceId: 'owned-instance' }); socket.message({ type: 'change', id: 1 }); assert.equal(eventReady, 1); assert.equal(changes, 1);
    const secondWatch = connection.watchView(view, second.signal, () => secondReady++);
    assert.equal(Socket.instances.length, 1); assert.equal(socket.sent.at(-1)?.type, 'watch-view');
    second.abort(); await secondWatch; assert.deepEqual(socket.sent.at(-1), { type: 'unwatch', id: 3 });
    socket.message({ type: 'view-ready', id: 3, view }); assert.equal(secondReady, 0); assert.equal(socket.readyState, 1);
    events.abort(); await eventWatch; assert.equal(socket.readyState, 3);
  } finally { Object.assign(globalThis, { WebSocket: originalSocket, window: originalWindow }); }
});

test('view errors isolate their subscriber and instance changes reject the old connection', async () => {
  const originalSocket = globalThis.WebSocket, originalWindow = globalThis.window;
  Object.assign(globalThis, { WebSocket: Socket, window: { location: { href: 'http://127.0.0.1:1234/' } } }); Socket.instances = [];
  try {
    const connection = new BoardConnection('owned-instance'), events = new AbortController(), owner = new AbortController();
    const eventWatch = connection.watchEvents(events.signal, () => undefined, () => undefined);
    const viewWatch = connection.watchView(view, owner.signal, () => assert.fail('Invalid view acknowledged'));
    const rejectedView = assert.rejects(viewWatch, { status: 409, code: 'scene_view_conflict' });
    const socket = Socket.instances[0]; socket.open(); socket.message({ type: 'error', id: 2, status: 409, code: 'scene_view_conflict' }); await rejectedView;
    assert.equal(socket.readyState, 1);
    const rejectedEvents = assert.rejects(eventWatch, BoardConnectionError); socket.message({ type: 'ready', id: 1, instanceId: 'other-instance' }); await rejectedEvents;
    assert.equal(socket.readyState, 3);
    const next = connection.watchView(view, new AbortController().signal, () => assert.fail('Mismatched view acknowledged'));
    const rejectedNext = assert.rejects(next, BoardConnectionError), replacement = Socket.instances[1]; replacement.open();
    replacement.message({ type: 'view-ready', id: 3, view: { ...view, sessionId: 'other-session' } }); await rejectedNext;
    assert.equal(replacement.readyState, 3);
  } finally { Object.assign(globalThis, { WebSocket: originalSocket, window: originalWindow }); }
});
