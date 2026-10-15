import type { IncomingMessage, Server } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { boardConnectionRequest, type BoardConnectionMessage } from '../shared/board-connection.js';
import type { CaptureView } from '../shared/types.js';
import { ApiFailure } from './service.js';

export interface ViewPresence { end(): void }
export function createBoardConnections(server: Server, options: {
  guard(request: IncomingMessage): void;
  instanceId: string;
  watch(view: CaptureView, connection: ViewPresence): () => void;
}) {
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024, perMessageDeflate: false });
  const events = new Map<WebSocket, Set<number>>();
  const awaitingPong = new Set<WebSocket>();
  server.on('upgrade', (request, socket, head) => {
    try {
      if (request.url !== '/api/connection') throw new ApiFailure(404, 'route_missing', 'Use the board connection route.');
      options.guard(request);
      sockets.handleUpgrade(request, socket, head, connection => sockets.emit('connection', connection, request));
    } catch (error) {
      const status = error instanceof ApiFailure ? error.status : 400;
      socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    }
  });
  sockets.on('connection', socket => {
    const subscriptions = new Map<number, () => void>(), watchedEvents = new Set<number>();
    events.set(socket, watchedEvents);
    socket.on('pong', () => awaitingPong.delete(socket));
    const send = (message: BoardConnectionMessage) => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message)); };
    const unwatch = (id: number) => { const close = subscriptions.get(id); subscriptions.delete(id); watchedEvents.delete(id); close?.(); };
    socket.on('message', (data, binary) => {
      let value: unknown;
      try { if (binary) throw new Error(); value = JSON.parse(data.toString()); } catch { socket.close(1008, 'invalid_message'); return; }
      const request = boardConnectionRequest(value);
      if (!request) { socket.close(1008, 'invalid_message'); return; }
      if (request.type === 'unwatch') { unwatch(request.id); return; }
      if (subscriptions.has(request.id)) { send({ type: 'error', id: request.id, status: 409, code: 'connection_subscription_conflict' }); return; }
      if (request.type === 'events') {
        subscriptions.set(request.id, () => undefined); watchedEvents.add(request.id);
        send({ type: 'ready', id: request.id, instanceId: options.instanceId }); return;
      }
      try {
        const close = options.watch(request.view, { end() { unwatch(request.id); send({ type: 'error', id: request.id, status: 409, code: 'scene_view_closed' }); } });
        subscriptions.set(request.id, close);
        send({ type: 'view-ready', id: request.id, view: request.view });
      } catch (error) {
        const failure = error instanceof ApiFailure ? error : new ApiFailure(500, 'server_error', 'The connection could not watch this view.');
        send({ type: 'error', id: request.id, status: failure.status, code: failure.code });
      }
    });
    socket.on('error', () => { /* Close releases each connection-owned view. */ });
    socket.once('close', () => { events.delete(socket); awaitingPong.delete(socket); for (const id of [...subscriptions.keys()]) unwatch(id); });
  });
  const heartbeat = setInterval(() => {
    for (const socket of sockets.clients) {
      if (awaitingPong.has(socket)) { socket.terminate(); continue; }
      if (socket.readyState === WebSocket.OPEN) { awaitingPong.add(socket); socket.ping(); }
    }
  }, 15_000); heartbeat.unref();
  return {
    changed() { for (const [socket, ids] of events) if (socket.readyState === WebSocket.OPEN) for (const id of ids) socket.send(JSON.stringify({ type: 'change', id } satisfies BoardConnectionMessage)); },
    close() { clearInterval(heartbeat); for (const socket of sockets.clients) socket.terminate(); sockets.close(); },
  };
}
