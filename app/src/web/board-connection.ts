import { boardConnectionMessage, type BoardConnectionMessage, type BoardConnectionRequest } from '../shared/board-connection.js';
import type { CaptureView } from '../shared/types.js';

export class BoardConnectionError extends Error {
  constructor(public code: string, public status = 0) { super(code); }
}
type Subscription = { request: Exclude<BoardConnectionRequest, { type: 'unwatch' }>; ready(): void; changed?(): void; resolve(): void; reject(error: unknown): void; dispose(): void };
const sameView = (a: CaptureView, b: CaptureView) => a.projectId === b.projectId && a.sessionId === b.sessionId && a.documentId === b.documentId && a.viewId === b.viewId && a.viewGeneration === b.viewGeneration;

/** Project events and document ownership share one upgraded connection per page. */
export class BoardConnection {
  private socket?: WebSocket;
  private nextId = 0;
  private subscriptions = new Map<number, Subscription>();
  constructor(private instanceId: string) {}

  watchEvents(signal: AbortSignal, ready: () => void, changed: () => void) { return this.watch({ type: 'events', id: ++this.nextId }, signal, ready, changed); }
  watchView(view: CaptureView, signal: AbortSignal, ready: () => void) { return this.watch({ type: 'watch-view', id: ++this.nextId, view }, signal, ready); }
  close() {
    const socket = this.socket; this.socket = undefined;
    for (const id of [...this.subscriptions.keys()]) this.finish(id, new BoardConnectionError('connection_lost'));
    socket?.close();
  }
  private finish(id: number, error?: unknown) {
    const subscription = this.subscriptions.get(id); if (!subscription) return;
    this.subscriptions.delete(id); subscription.dispose();
    if (error) subscription.reject(error); else subscription.resolve();
    if (!this.subscriptions.size && this.socket) { const socket = this.socket; this.socket = undefined; socket.close(); }
  }
  private watch(request: Subscription['request'], signal: AbortSignal, ready: () => void, changed?: () => void): Promise<void> {
    if (signal.aborted) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const abort = () => { if (this.socket?.readyState === WebSocket.OPEN) this.send({ type: 'unwatch', id: request.id }); this.finish(request.id); };
      this.subscriptions.set(request.id, { request, ready, changed, resolve, reject, dispose: () => signal.removeEventListener('abort', abort) });
      signal.addEventListener('abort', abort, { once: true });
      if (this.socket?.readyState === WebSocket.OPEN) this.send(request);
      else if (!this.socket) this.connect();
    });
  }
  private send(request: BoardConnectionRequest) { this.socket?.send(JSON.stringify(request)); }
  private connect() {
    const url = new URL('/api/connection', window.location.href); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(url); this.socket = socket;
    const failed = () => {
      if (this.socket !== socket) return;
      this.socket = undefined;
      for (const id of [...this.subscriptions.keys()]) this.finish(id, new BoardConnectionError('connection_lost'));
      socket.close();
    };
    socket.addEventListener('open', () => { if (this.socket === socket) for (const subscription of this.subscriptions.values()) this.send(subscription.request); });
    socket.addEventListener('error', failed); socket.addEventListener('close', failed);
    socket.addEventListener('message', event => {
      if (this.socket !== socket) return;
      let message: BoardConnectionMessage | undefined;
      try { message = boardConnectionMessage(JSON.parse(event.data)); } catch { failed(); return; }
      if (!message) { failed(); return; }
      const subscription = this.subscriptions.get(message.id); if (!subscription) return;
      if (message.type === 'error') { this.finish(message.id, new BoardConnectionError(message.code, message.status)); return; }
      if (message.type === 'ready' && subscription.request.type === 'events') {
        if (message.instanceId !== this.instanceId) { failed(); return; }
        subscription.ready();
      } else if (message.type === 'view-ready' && subscription.request.type === 'watch-view') {
        if (!message.view || !sameView(message.view, subscription.request.view)) { failed(); return; }
        subscription.ready();
      } else if (message.type === 'change' && subscription.request.type === 'events') subscription.changed?.();
      else failed();
    });
  }
}
