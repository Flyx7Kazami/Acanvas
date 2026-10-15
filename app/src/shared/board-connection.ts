import type { CaptureView } from './types.js';

export type BoardConnectionRequest =
  | { type: 'events'; id: number }
  | { type: 'watch-view'; id: number; view: CaptureView }
  | { type: 'unwatch'; id: number };
export type BoardConnectionMessage =
  | { type: 'ready'; id: number; instanceId: string }
  | { type: 'view-ready'; id: number; view: CaptureView }
  | { type: 'change'; id: number }
  | { type: 'error'; id: number; status: number; code: string };

export function boardConnectionRequest(value: unknown): BoardConnectionRequest | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const request = value as Record<string, unknown>;
  if (!Number.isSafeInteger(request.id) || Number(request.id) <= 0) return;
  const keys = Object.keys(request).sort().join(',');
  if ((request.type === 'events' || request.type === 'unwatch') && keys === 'id,type') return request as BoardConnectionRequest;
  if (request.type !== 'watch-view' || keys !== 'id,type,view' || !request.view || typeof request.view !== 'object' || Array.isArray(request.view)) return;
  const view = request.view as Record<string, unknown>;
  if (Object.keys(view).sort().join(',') !== 'documentId,projectId,sessionId,viewGeneration,viewId') return;
  if (!['projectId', 'sessionId', 'documentId', 'viewId'].every(key => typeof view[key] === 'string' && view[key].length > 0 && view[key].length <= 200)) return;
  if (!Number.isSafeInteger(view.viewGeneration) || Number(view.viewGeneration) <= 0) return;
  return request as BoardConnectionRequest;
}

export function boardConnectionMessage(value: unknown): BoardConnectionMessage | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const message = value as Record<string, unknown>;
  if (!Number.isSafeInteger(message.id) || Number(message.id) <= 0) return;
  const keys = Object.keys(message).sort().join(',');
  if (message.type === 'change' && keys === 'id,type') return message as BoardConnectionMessage;
  if (message.type === 'ready' && keys === 'id,instanceId,type' && typeof message.instanceId === 'string' && message.instanceId.length > 0 && message.instanceId.length <= 200) return message as BoardConnectionMessage;
  if (message.type === 'view-ready' && keys === 'id,type,view' && boardConnectionRequest({ type: 'watch-view', id: message.id, view: message.view })) return message as BoardConnectionMessage;
  if (message.type === 'error' && keys === 'code,id,status,type' && Number.isInteger(message.status) && Number(message.status) >= 400 && Number(message.status) < 600 && typeof message.code === 'string' && message.code.length > 0 && message.code.length <= 100) return message as BoardConnectionMessage;
}
