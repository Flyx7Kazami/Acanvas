import { BoardConnection, BoardConnectionError } from './board-connection.js';
import { resolveContentMime } from '../shared/content-types';
import type { AnnotationCaptureInput, ApiError, Asset, BaseSceneSnapshot, BoardOperation, BoardState, Bootstrap, CaptureResult, CaptureRetryResult, CaptureView, CaptureViewOperation, Draft, HtmlSurfaceFrameMetadata, ProjectHtmlSurface, ProjectHtmlSurfaceInput, ScenePresentation, ScenePresentationOperation, SceneSource, Session, SessionView, Task } from '../shared/types';
import type { BrowserPage, BrowserStatus } from '../shared/browser-capture';
import type {HtmlPcmBatch,HtmlInputResult} from '../shared/html-surface';

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
  content_readonly: 'Only notes and Markdown can be edited.',
  content_too_large: 'Notes and Markdown stay within 2 MB.',
  request_too_large: 'This request is too large. Reduce the attachments or text and try again.',
  task_edit_conflict: 'This request changed state. Save the current edit or select a waiting request.',
  invalid_annotation: 'Check the annotation area, timestamp and file references, then try again.',
  annotation_incomplete: 'Complete each annotation capture before sending.',
  annotation_version_conflict: 'Load the saved annotation version before editing.',
  capture_version_conflict: 'Capture the current draft and annotation version.',
  capture_target_conflict: 'Capture the saved target and position.',
  capture_scene_conflict: 'The canvas changed. Capture the scene again.',
  capture_conflict: 'Query the saved capture result for this version.',
  capture_file_invalid: 'Upload the complete screenshot with its saved dimensions.',
  capture_upload_active: 'Wait for the current upload and query its result.',
  capture_missing: 'Prepare this annotation capture first.',
  scene_scope: 'Use a scene from this document and task context.',
  scene_source_missing: 'Save the displayed scene before capturing this annotation.',
  scene_source_expired: 'Load the current scene and finish the annotation again.',
  scene_source_conflict: 'Keep the saved scene and target together.',
  scene_view_closed: 'Reconnect this document to continue capturing.',
  scene_view_conflict: 'Reconnect the current document view.',
  scene_operation_conflict: 'Complete the current view operation before continuing.',
  scene_frame_conflict: 'Confirm the displayed frame before finishing this annotation.',
  scene_object_conflict: 'Choose an object from the displayed scene.',
  invalid_scene: 'Check the displayed scene and bitmap dimensions.',
  surface_unavailable: 'The HTML surface is reconnecting. Try again shortly.',
  surface_frame_scope: 'Use the HTML frame belonging to this document and view.',
  surface_missing: 'Reconnect the HTML surface in this view.',
  surface_renderer_exit: 'The HTML preview is reconnecting.',
  surface_limit: 'HTML previews are waiting for project capacity.',
  surface_view_limit: 'This view has reached its HTML preview limit.',
  surface_retained_limit: 'HTML previews are waiting for pending screenshots to finish.',
  surface_input_state: 'Use the displayed HTML instance and viewport.',
  invalid_capture: 'Check the screenshot and scene metadata.',
  evidence_scope: 'Read this screenshot in its original task context.',
  evidence_usage: 'Use this screenshot as annotation evidence.',
  task_reference_scope: 'Choose a task from this conversation.',
  invalid_input: 'Check the entered content and try again.',
  invalid_view: 'Adjust the canvas view and try again.',
  invalid_object: 'Check the file dimensions and try again.',
  preview_type: 'Choose an HTML file to run a preview.',
  preview_too_large: 'HTML previews support files up to 10 MB. Download the original file.',
  preview_missing: 'This preview has expired. Run it again.',
  preview_unavailable: 'The HTML preview is unavailable. Download the original file.',
  server_error: 'The local service could not complete this action. Try again shortly.',
  browser_unavailable: 'Install Chrome to open the canvas window.',
  browser_navigation: 'Close the canvas window and open this board again.',
  service_conflict: 'Reconnect to the current project service.',
};

export class RequestError extends Error {
  constructor(message: string, public status: number, public code: string) { super(message); }
}

export interface HtmlPreviewGrant { id: string; url: string; origin: string; expiresAt: string }

export class BoardApi {
  private instanceId = '';
  private token = '';
  private connection?: BoardConnection;
  private project?: Bootstrap['project'];
  projectChanged = false;

  async request<T>(path: string, options: RequestInit = {}, refreshAuthentication = true): Promise<T> {
    return (await this.response(path, options, refreshAuthentication)).json() as Promise<T>;
  }
  private async response(path: string, options: RequestInit = {}, refreshAuthentication = true): Promise<Response> {
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
      await this.bootstrap(options.signal || undefined);
      return this.response(path, options, false);
    }
    if (!response.ok) {
      const data = await response.json().catch(() => ({})) as Partial<ApiError>;
      const code = data.error?.code || 'request_failed';
      throw new RequestError(errorMessages[code] || `The action could not be completed (${response.status}). Check the current content and try again.`, response.status, code);
    }
    return response;
  }

  async bootstrap(signal?: AbortSignal): Promise<Bootstrap> {
    const result = await this.request<Bootstrap>('/api/bootstrap', { signal });
    if (this.project && (result.project.id !== this.project.id || result.project.root !== this.project.root)) {
      this.projectChanged = true;
      this.token = '';
      this.connection?.close(); this.connection = undefined;
      throw new RequestError('This address now serves another project. Your draft is preserved. Reopen the board to continue.', 409, 'project_changed');
    }
    this.project = result.project;
    this.token = result.token;
    if (this.instanceId !== result.service.instanceId) { this.connection?.close(); this.connection = new BoardConnection(result.service.instanceId); }
    this.instanceId = result.service.instanceId;
    return result;
  }

  state(sessionId?: string) { return this.request<BoardState>(`/api/state${sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ''}`); }
  sessions() { return this.request<Session[]>('/api/sessions'); }
  createSession(name: string) { return this.request<Session>('/api/sessions', { method: 'POST', body: JSON.stringify({ name }) }); }
  openBrowser(sessionId: string) { return this.request<BrowserPage>('/api/browser/pages', { method: 'POST', body: JSON.stringify({ sessionId, instanceId: this.instanceId }) }); }
  browserStatus(sessionId?: string) { return this.request<BrowserStatus>(`/api/browser/pages${sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ''}`); }
  closeBrowser(sessionId: string) { return this.request<BrowserStatus>(`/api/browser/pages/${encodeURIComponent(sessionId)}`, { method: 'DELETE', body: JSON.stringify({ instanceId: this.instanceId }) }); }
  saveDraft(draft: Draft) { return this.request<Draft>(`/api/sessions/${encodeURIComponent(draft.sessionId)}/draft`, { method: 'PUT', body: JSON.stringify(draft) }); }
  private captureViewPath(sessionId: string, viewId?: string) { return `/api/sessions/${encodeURIComponent(sessionId)}/capture-views${viewId ? `/${encodeURIComponent(viewId)}` : ''}`; }
  registerCaptureView(sessionId: string, documentId: string) { return this.request<CaptureView>(this.captureViewPath(sessionId), { method: 'POST', body: JSON.stringify({ documentId }) }); }
  private connectionError(cause: unknown): never {
    if (cause instanceof BoardConnectionError) throw new RequestError(errorMessages[cause.code] || 'The local service is disconnected.', cause.status, cause.code);
    throw cause;
  }
  watchEvents(signal: AbortSignal, onConnected: () => void, onChange: () => void) {
    if (!this.connection || this.projectChanged) return Promise.reject(new RequestError('Reconnect to the local service.', 0, 'connection_lost'));
    return this.connection.watchEvents(signal, onConnected, onChange).catch(cause => this.connectionError(cause));
  }
  watchCaptureView(view: CaptureView, signal: AbortSignal, onConnected: () => void = () => undefined): Promise<void> {
    if (!this.connection || this.projectChanged) return Promise.reject(new RequestError('Reconnect to the local service.', 0, 'connection_lost'));
    return this.connection.watchView(view, signal, onConnected).catch(cause => this.connectionError(cause));
  }
  sceneSnapshot(sessionId: string, viewId: string, operation: CaptureViewOperation) { return this.request<BaseSceneSnapshot>(`${this.captureViewPath(sessionId, viewId)}/scenes`, { method: 'POST', body: JSON.stringify(operation) }); }
  confirmScenePresentation(sessionId: string, viewId: string, operation: ScenePresentationOperation) { return this.request<ScenePresentation>(`${this.captureViewPath(sessionId, viewId)}/presented`, { method: 'PUT', body: JSON.stringify(operation) }); }
  holdScenePresentation(sessionId: string, viewId: string, operation: ScenePresentationOperation) { return this.request<SceneSource>(`${this.captureViewPath(sessionId, viewId)}/presentations`, { method: 'POST', body: JSON.stringify(operation) }); }
  closeCaptureView(sessionId: string, viewId: string, operation: CaptureViewOperation, options: { keepalive?: boolean } = {}) { return this.request<{ closed: true }>(this.captureViewPath(sessionId, viewId), { method: 'DELETE', body: JSON.stringify(operation), ...options }); }
  private htmlSurfacePath(view: CaptureView, surfaceId?: string) { return `${this.captureViewPath(view.sessionId, view.viewId)}/html-surfaces${surfaceId ? `/${encodeURIComponent(surfaceId)}` : ''}`; }
  private htmlSurfaceIdentity(view: CaptureView) { return { documentId: view.documentId, viewGeneration: view.viewGeneration }; }
  createHtmlSurface(view: CaptureView, objectId: string, assetId: string, viewport: { width: number; height: number; deviceScaleFactor?: number }) { return this.request<ProjectHtmlSurface>(this.htmlSurfacePath(view), { method: 'POST', body: JSON.stringify({ ...this.htmlSurfaceIdentity(view), objectId, assetId, viewport }) }); }
  sampleHtmlSurface(view: CaptureView, surfaceId: string) { return this.request<HtmlSurfaceFrameMetadata>(`${this.htmlSurfacePath(view, surfaceId)}/sample`, { method: 'POST', body: JSON.stringify(this.htmlSurfaceIdentity(view)) }); }
  htmlSurfaceFrame(view: CaptureView, surfaceId: string, frameSeq: number) { return this.request<HtmlSurfaceFrameMetadata>(`${this.htmlSurfacePath(view, surfaceId)}/frames/${frameSeq}?${new URLSearchParams({ documentId: view.documentId, viewGeneration: String(view.viewGeneration) })}`); }
  inputHtmlSurface(view: CaptureView, surfaceId: string, input: ProjectHtmlSurfaceInput) { return this.request<HtmlInputResult>(`${this.htmlSurfacePath(view, surfaceId)}/input`, { method: 'POST', body: JSON.stringify({ ...this.htmlSurfaceIdentity(view), input }) }); }
  htmlSurfaceAudio(view:CaptureView,surfaceId:string,afterSeq:number,signal?:AbortSignal){return this.request<HtmlPcmBatch>(`${this.htmlSurfacePath(view,surfaceId)}/audio?${new URLSearchParams({...this.htmlSurfaceIdentity(view),viewGeneration:String(view.viewGeneration),afterSeq:String(afterSeq)})}`,{signal});}
  resizeHtmlSurface(view: CaptureView, surfaceId: string, viewport: { width: number; height: number }) { return this.request<ProjectHtmlSurface>(`${this.htmlSurfacePath(view, surfaceId)}/viewport`, { method: 'PUT', body: JSON.stringify({ ...this.htmlSurfaceIdentity(view), viewport }) }); }
  closeHtmlSurface(view: CaptureView, surfaceId: string) { return this.request<{ closed: true }>(this.htmlSurfacePath(view, surfaceId), { method: 'DELETE', body: JSON.stringify(this.htmlSurfaceIdentity(view)) }); }
  send(sessionId: string, draftId: string, expectedRevision: number) { return this.request<{ task: Task; draft: Draft }>(`/api/sessions/${encodeURIComponent(sessionId)}/tasks`, { method: 'POST', body: JSON.stringify({ draftId, expectedRevision }) }); }
  editTask(sessionId: string, taskId: string, draftId: string, expectedRevision: number, cancel = false) { return this.request<{ task: Task; draft: Draft }>(`/api/sessions/${encodeURIComponent(sessionId)}/tasks/${encodeURIComponent(taskId)}/${cancel ? 'cancel-edit' : 'edit'}`, { method: 'POST', body: JSON.stringify({ draftId, expectedRevision }) }); }
  view(sessionId: string, view: SessionView) { return this.request<Session>(`/api/sessions/${encodeURIComponent(sessionId)}/view`, { method: 'PUT', body: JSON.stringify(view) }); }
  operations(sessionId: string, operations: BoardOperation[]) { return this.request<{ objects: BoardState['objects'] }>('/api/board/operations', { method: 'POST', body: JSON.stringify({ sessionId, operations }) }); }
  upload(file: Blob, name: string, signal?: AbortSignal, mime = file.type) { return this.request<Asset>(`/api/assets?name=${encodeURIComponent(name)}&mime=${encodeURIComponent(resolveContentMime(name, mime))}`, { method: 'POST', body: file, signal }); }
  replaceContent(assetId: string, file: Blob, signal?: AbortSignal) { return this.request<Asset>(`/api/assets/${encodeURIComponent(assetId)}/content`, { method: 'PUT', body: file, signal }); }
  content(assetId: string, sessionId?: string) { return `/api/assets/${encodeURIComponent(assetId)}/content${sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ''}`; }
  private capturePath(sessionId: string, draftId: string, annotationId: string, version: number) { return `/api/sessions/${encodeURIComponent(sessionId)}/drafts/${encodeURIComponent(draftId)}/annotations/${encodeURIComponent(annotationId)}/captures/${version}`; }
  prepareCapture(sessionId: string, draftId: string, annotationId: string, version: number, input: AnnotationCaptureInput) { return this.request<CaptureResult>(this.capturePath(sessionId, draftId, annotationId, version), { method: 'POST', body: JSON.stringify(input) }); }
  commitCapture(sessionId: string, draftId: string, annotationId: string, version: number, image: Blob, signal?: AbortSignal) { return this.request<CaptureResult>(`${this.capturePath(sessionId, draftId, annotationId, version)}/content`, { method: 'PUT', body: image, signal }); }
  captureResult(sessionId: string, draftId: string, annotationId: string, version: number) { return this.request<CaptureResult>(this.capturePath(sessionId, draftId, annotationId, version)); }
  retryCapture(sessionId: string, draftId: string, annotationId: string, version: number) { return this.request<CaptureRetryResult>(`${this.capturePath(sessionId, draftId, annotationId, version)}/retry`, { method: 'POST', body: '{}' }); }
  createHtmlPreview(assetId: string, signal?: AbortSignal) { return this.request<HtmlPreviewGrant>(`/api/assets/${encodeURIComponent(assetId)}/html-preview`, { method: 'POST', body: '{}', signal }); }
  revokeHtmlPreview(id: string, signal?: AbortSignal) { return this.request<{ revoked: boolean }>(`/api/html-previews/${encodeURIComponent(id)}`, { method: 'DELETE', signal }); }
}
