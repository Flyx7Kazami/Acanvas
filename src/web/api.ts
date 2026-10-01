import type { ApiError, Asset, BoardOperation, BoardState, Bootstrap, Draft, Session, SessionView, Task } from '../shared/types';

const errorMessages: Record<string, string> = {
  authentication_required: '服务连接已过期，请重新连接。',
  origin_rejected: '请从已授权的本地白板地址打开页面。',
  host_rejected: '请使用本地服务地址打开白板。',
  path_boundary: '素材需保存在当前项目允许的目录内。',
  session_missing: '任务上下文已不可用，请从 agent 重新打开白板。',
  asset_missing: '引用的素材已不可用，请重新导入。',
  asset_file_missing: '素材文件已缺失，请恢复文件或重新导入。',
  asset_integrity: '素材文件与记录不一致，请恢复文件或重新导入。',
  object_missing: '引用的对象已移出画布，请更新本次需求附件。',
  draft_conflict: '这条需求已经发送或更新，请读取当前草稿后继续。',
  draft_revision_conflict: '草稿已在其他入口更新，请查看两份内容后继续。',
  object_conflict: '这个素材已被更新。已读取最新画布，请继续调整。',
  empty_request: '请添加需求文字、附件或批注。',
  upload_incomplete: '素材上传已中断，请重新导入完整文件。',
  upload_too_large: '素材超过当前上传大小，请选择较小文件。',
  request_too_large: '这次需求内容过大，请减少附件或文字后重试。',
  invalid_annotation: '请检查批注的区域、时间与素材引用后重试。',
  invalid_input: '请检查填写的内容后重试。',
  invalid_view: '请重新调整画布视图后重试。',
  invalid_object: '请检查素材尺寸后重试。',
  server_error: '本地服务暂时无法完成操作，请稍后重试。',
};

export class RequestError extends Error {
  constructor(message: string, public status: number, public code: string) { super(message); }
}

export class BoardApi {
  private token = '';
  private project?: Bootstrap['project'];
  projectChanged = false;

  async request<T>(path: string, options: RequestInit = {}, refreshAuthentication = true): Promise<T> {
    if (this.projectChanged) throw new RequestError('这个地址已连接其他项目。当前草稿已保留，请重新打开白板。', 409, 'project_changed');
    const headers = new Headers(options.headers);
    if (this.token) headers.set('Authorization', `Bearer ${this.token}`);
    if (options.body && typeof options.body === 'string') headers.set('Content-Type', 'application/json');
    let response: Response;
    try { response = await fetch(path, { ...options, headers, credentials: 'same-origin' }); }
    catch (cause) {
      if (cause instanceof DOMException && cause.name === 'AbortError') throw cause;
      throw new RequestError('本地服务连接已中断，请确认服务运行后重试。', 0, 'connection_lost');
    }
    if (response.status === 401 && refreshAuthentication && path !== '/api/bootstrap') {
      // The service authenticates before entering a mutation handler.
      await this.bootstrap();
      return this.request<T>(path, options, false);
    }
    if (!response.ok) {
      const data = await response.json().catch(() => ({})) as Partial<ApiError>;
      const code = data.error?.code || 'request_failed';
      throw new RequestError(errorMessages[code] || `操作未完成（${response.status}），请检查当前内容后重试。`, response.status, code);
    }
    return response.json() as Promise<T>;
  }

  async bootstrap(): Promise<Bootstrap> {
    const result = await this.request<Bootstrap>('/api/bootstrap');
    if (this.project && (result.project.id !== this.project.id || result.project.root !== this.project.root)) {
      this.projectChanged = true;
      this.token = '';
      throw new RequestError('这个地址已连接其他项目。当前草稿已保留，请重新打开白板。', 409, 'project_changed');
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
  view(sessionId: string, view: SessionView) { return this.request<Session>(`/api/sessions/${encodeURIComponent(sessionId)}/view`, { method: 'PUT', body: JSON.stringify(view) }); }
  operations(sessionId: string, operations: BoardOperation[]) { return this.request<{ objects: BoardState['objects'] }>('/api/board/operations', { method: 'POST', body: JSON.stringify({ sessionId, operations }) }); }
  upload(file: Blob, name: string, signal?: AbortSignal) { return this.request<Asset>(`/api/assets?name=${encodeURIComponent(name)}&mime=${encodeURIComponent(file.type || 'application/octet-stream')}`, { method: 'POST', body: file, signal }); }
  content(assetId: string) { return `/api/assets/${encodeURIComponent(assetId)}/content`; }
}
