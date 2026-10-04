import { resolveContentMime } from '../shared/content-types';
import type { ApiError, Asset, BoardOperation, BoardState, Bootstrap, Draft, Session, SessionView, Task } from '../shared/types';

const errorMessages: Record<string, string> = {
  authentication_required: 'Your connection has expired. Reconnect to continue.',
  origin_rejected: 'Open the board from an approved local address.',
  host_rejected: 'Open the board using the local service address.',
  path_boundary: 'Files must be stored within the allowed project directory.',
  session_missing: 'This task context is unavailable. Reopen the board from your agent.',
  asset_missing: 'A referenced file is unavailable. Import it again.',
  asset_file_missing: 'The file is missing. Restore it or import it again.',
  asset_integrity: 'The file differs from its saved record. Restore it or import it again.',
  object_missing: 'A referenced object was removed from the canvas. Update the request attachments.',
  draft_conflict: 'This request has been sent or updated. Load the current draft to continue.',
  draft_revision_conflict: 'Your draft was updated elsewhere. Compare both versions to continue.',
  object_conflict: 'This file was updated. The latest canvas is loaded and ready to edit.',
  empty_request: 'Add request text, attachments or annotations.',
  upload_incomplete: 'The upload was interrupted. Import the complete file again.',
  upload_too_large: 'The file exceeds the upload limit. Choose a smaller file.',
  request_too_large: 'This request is too large. Reduce the attachments or text and try again.',
  task_edit_conflict: 'This request changed state. Save the current edit or select a waiting request.',
  invalid_annotation: 'Check the annotation area, timestamp and file references, then try again.',
  invalid_input: 'Check the entered content and try again.',
  invalid_view: 'Adjust the canvas view and try again.',
  invalid_object: 'Check the file dimensions and try again.',
  preview_type: 'Choose an HTML file to run a preview.',
  preview_too_large: 'HTML previews support files up to 10 MB. Download the original file.',
  preview_missing: 'This preview has expired. Run it again.',
  preview_unavailable: 'The HTML preview is unavailable. Download the original file.',
  server_error: 'The local service could not complete this action. Try again shortly.',
};

export class RequestError extends Error {
  constructor(message: string, public status: number, public code: string) { super(message); }
}

export interface HtmlPreviewGrant { id: string; url: string; origin: string; expiresAt: string }

export class BoardApi {
  private token = '';
  private project?: Bootstrap['project'];
  projectChanged = false;

  async request<T>(path: string, options: RequestInit = {}, refreshAuthentication = true): Promise<T> {
    if (this.projectChanged) throw new RequestError('This address now serves another project. Your draft is preserved. Reopen the board to continue.', 409, 'project_changed');
    const headers = new Headers(options.headers);
    if (this.token) headers.set('Authorization', `Bearer ${this.token}`);
    if (options.body && typeof options.body === 'string') headers.set('Content-Type', 'application/json');
    let response: Response;
    try { response = await fetch(path, { ...options, headers, credentials: 'same-origin' }); }
    catch (cause) {
      if (cause instanceof DOMException && cause.name === 'AbortError') throw cause;
      throw new RequestError('The local service is disconnected. Confirm it is running, then try again.', 0, 'connection_lost');
    }
    if (response.status === 401 && refreshAuthentication && path !== '/api/bootstrap') {
      // The service authenticates before entering a mutation handler.
      await this.bootstrap();
      return this.request<T>(path, options, false);
    }
    if (!response.ok) {
      const data = await response.json().catch(() => ({})) as Partial<ApiError>;
      const code = data.error?.code || 'request_failed';
      throw new RequestError(errorMessages[code] || `The action could not be completed (${response.status}). Check the current content and try again.`, response.status, code);
    }
    return response.json() as Promise<T>;
  }

  async bootstrap(): Promise<Bootstrap> {
    const result = await this.request<Bootstrap>('/api/bootstrap');
    if (this.project && (result.project.id !== this.project.id || result.project.root !== this.project.root)) {
      this.projectChanged = true;
      this.token = '';
      throw new RequestError('This address now serves another project. Your draft is preserved. Reopen the board to continue.', 409, 'project_changed');
    }
    this.project = result.project;
    this.token = result.token;
    return result;
  }

  state(sessionId?: string) { return this.request<BoardState>(`/api/state${sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ''}`); }
  sessions() { return this.request<Session[]>('/api/sessions'); }
  createSession(name: string) { return this.request<Session>('/api/sessions', { method: 'POST', body: JSON.stringify({ name }) }); }
  saveDraft(draft: Draft) { return this.request<Draft>(`/api/sessions/${encodeURIComponent(draft.sessionId)}/draft`, { method: 'PUT', body: JSON.stringify(draft) }); }
  send(sessionId: string, draftId: string, expectedRevision: number) { return this.request<{ task: Task; draft: Draft }>(`/api/sessions/${encodeURIComponent(sessionId)}/tasks`, { method: 'POST', body: JSON.stringify({ draftId, expectedRevision }) }); }
  editTask(sessionId: string, taskId: string, draftId: string, expectedRevision: number, cancel = false) { return this.request<{ task: Task; draft: Draft }>(`/api/sessions/${encodeURIComponent(sessionId)}/tasks/${encodeURIComponent(taskId)}/${cancel ? 'cancel-edit' : 'edit'}`, { method: 'POST', body: JSON.stringify({ draftId, expectedRevision }) }); }
  view(sessionId: string, view: SessionView) { return this.request<Session>(`/api/sessions/${encodeURIComponent(sessionId)}/view`, { method: 'PUT', body: JSON.stringify(view) }); }
  operations(sessionId: string, operations: BoardOperation[]) { return this.request<{ objects: BoardState['objects'] }>('/api/board/operations', { method: 'POST', body: JSON.stringify({ sessionId, operations }) }); }
  upload(file: Blob, name: string, signal?: AbortSignal) { return this.request<Asset>(`/api/assets?name=${encodeURIComponent(name)}&mime=${encodeURIComponent(resolveContentMime(name, file.type))}`, { method: 'POST', body: file, signal }); }
  content(assetId: string) { return `/api/assets/${encodeURIComponent(assetId)}/content`; }
  createHtmlPreview(assetId: string) { return this.request<HtmlPreviewGrant>(`/api/assets/${encodeURIComponent(assetId)}/html-preview`, { method: 'POST', body: '{}' }); }
  revokeHtmlPreview(id: string) { return this.request<{ revoked: boolean }>(`/api/html-previews/${encodeURIComponent(id)}`, { method: 'DELETE' }); }
}
