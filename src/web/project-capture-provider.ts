import type { AnnotationCaptureInput, AnnotationInput, BaseSceneSnapshot, CaptureResult, CaptureRetryResult, CaptureView, CaptureViewOperation, Draft, ScenePresentation, ScenePresentationOperation, SceneSource } from '../shared/types.js';
import type { BrowserCaptureIdentity, BrowserCaptureResult, ProjectCaptureProvider as CaptureProvider, SceneEvidenceFrame } from '../shared/browser-capture.js';

export interface ProjectCaptureTransport {
  registerCaptureView(sessionId: string, documentId: string): Promise<CaptureView>;
  sceneSnapshot(sessionId: string, viewId: string, operation: CaptureViewOperation): Promise<BaseSceneSnapshot>;
  confirmScenePresentation(sessionId: string, viewId: string, operation: ScenePresentationOperation): Promise<ScenePresentation>;
  holdScenePresentation(sessionId: string, viewId: string, operation: ScenePresentationOperation): Promise<SceneSource>;
  closeCaptureView(sessionId: string, viewId: string, operation: CaptureViewOperation, options?: { keepalive?: boolean }): Promise<{ closed: true }>;
  saveDraft(draft: Draft): Promise<Draft>;
  state(sessionId: string): Promise<{ draft: Draft }>;
  prepareCapture(sessionId: string, draftId: string, annotationId: string, version: number, input: AnnotationCaptureInput): Promise<CaptureResult>;
  commitCapture(sessionId: string, draftId: string, annotationId: string, version: number, image: Blob, signal?: AbortSignal): Promise<CaptureResult>;
  captureResult(sessionId: string, draftId: string, annotationId: string, version: number): Promise<CaptureResult>;
  retryCapture(sessionId: string, draftId: string, annotationId: string, version: number): Promise<CaptureRetryResult>;
}

type ReadonlyValue<T> = T extends readonly (infer Value)[] ? readonly ReadonlyValue<Value>[] : T extends object ? { readonly [Key in keyof T]: ReadonlyValue<T[Key]> } : T;
export interface CopiedSceneFrame {
  presentation: ScenePresentation | ReadonlyValue<ScenePresentation>;
  cropCSS: SceneEvidenceFrame['cropCSS'];
  encodePNG(): Promise<Blob>;
}

export interface PreparedSceneCapture extends Omit<SceneEvidenceFrame, 'png'> { encodePNG(): Promise<Blob> }
export interface FreezeAndHoldInput {
  draft: Draft;
  annotation: AnnotationInput;
  /** This callback synchronously copies the visible bitmap and its paired metadata. */
  freeze(): CopiedSceneFrame;
  worldBounds: SceneEvidenceFrame['worldBounds'];
  viewport: SceneEvidenceFrame['viewport'];
  scene: SceneEvidenceFrame['scene'];
  signal?: AbortSignal;
}
export interface PendingFreezeIdentity { documentId: string; sessionId: string; draftId: string; annotationId: string; pendingGeneration: number }
export interface PendingFreezeCancellation { draft?: Draft; retry?: CaptureRetryResult }
export interface FreezeAndHoldTask extends Promise<{ draft: Draft; frame: PreparedSceneCapture }> { readonly identity: PendingFreezeIdentity; cancel(): Promise<PendingFreezeCancellation> }
interface PendingFreeze { identity: PendingFreezeIdentity; cancelled: boolean; controller: AbortController; saveStarted: boolean; sceneSource?: SceneSource; target: AnnotationInput; invalidatedVersion?: number; reconciliation?: Promise<PendingFreezeCancellation> }
export interface ProjectCaptureOptions { sessionId: string; documentId?: string; attempts?: number; retryDelayMs?: number; maxPendingCaptures?: number }

const code = (error: unknown) => error && typeof error === 'object' && 'code' in error ? String(error.code) : error instanceof DOMException && error.name === 'AbortError' ? 'capture_cancelled' : 'capture_failed';
const transient = (error: unknown) => ['connection_lost', 'capture_upload_active', 'service_closing', 'surface_unavailable', 'capture_encoding_failed'].includes(code(error));
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const identityKey = (identity: BrowserCaptureIdentity) => JSON.stringify(identity);
const wait = (milliseconds: number) => new Promise<void>(resolve => setTimeout(resolve, milliseconds));

/** Project API coordinator for any client that presents an exportable scene bitmap. */
export class ProjectCaptureCoordinator implements CaptureProvider {
  readonly documentId: string;
  readonly sessionId: string;
  private view?: CaptureView;
  private initializing?: Promise<CaptureView>;
  private operationSeq = 0;
  private generation = 0;
  private pendingGeneration = 0;
  private operations: Promise<unknown> = Promise.resolve();
  private presented?: ScenePresentation;
  private closed = false;
  private closeOptions: { keepalive?: boolean } = {};
  private closingView?: Promise<void>;
  private closeTask?: Promise<void>;
  private pendingFreezes = 0;
  private pending = new Map<string, PendingFreeze>();
  private jobs = new Map<string, { cancelled: boolean; controller: AbortController; frame?: object }>();
  private cancelledFrames = new WeakSet<object>();
  private restoredFrames = new WeakSet<object>();
  private encodings = new WeakMap<PreparedSceneCapture, Promise<Blob>>();
  private results = new WeakMap<object, BrowserCaptureResult>();
  private readonly attempts: number;
  private readonly retryDelayMs: number;
  private readonly maxPendingCaptures: number;

  constructor(private readonly api: ProjectCaptureTransport, options: ProjectCaptureOptions) {
    this.sessionId = options.sessionId; this.documentId = options.documentId ?? crypto.randomUUID();
    this.attempts = Math.max(1, Math.min(5, options.attempts ?? 3)); this.retryDelayMs = Math.max(0, Math.min(1000, options.retryDelayMs ?? 150));
    this.maxPendingCaptures = Math.max(1, Math.min(8, options.maxPendingCaptures ?? 4));
  }
  get viewId() { return this.view?.viewId ?? ''; }
  async ready(): Promise<CaptureView> {
    if (this.closed) throw Object.assign(new Error('The capture document is closed.'), { code: 'scene_view_closed' });
    if (this.view) return this.view;
    if (!this.initializing) this.initializing = this.api.registerCaptureView(this.sessionId, this.documentId).then(async view => {
      if (view.documentId !== this.documentId || view.sessionId !== this.sessionId) throw Object.assign(new Error('The capture view belongs to another document.'), { code: 'scene_scope' });
      this.view = view;
      if (this.closed) { await this.retireView(); throw Object.assign(new Error('This capture document was closed during initialization.'), { code: 'scene_view_closed' }); }
      return view;
    }).finally(() => { this.initializing = undefined; });
    return this.initializing;
  }
  private ordered<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.operations.catch(() => undefined).then(operation); this.operations = pending; return pending;
  }
  private operation(view: CaptureView): CaptureViewOperation { return { documentId: view.documentId, viewGeneration: view.viewGeneration, operationSeq: ++this.operationSeq }; }
  private async recover<T>(operation: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try { return await operation(); }
      catch (error) { if (!transient(error) || attempt >= this.attempts) throw error; await wait(this.retryDelayMs * attempt); }
    }
  }
  private assertPending(stage: PendingFreeze) { if (stage.cancelled || this.closed) throw Object.assign(new Error('The pending annotation capture was cancelled.'), { code: 'capture_cancelled' }); }
  private async awaitPending<T>(stage: PendingFreeze, operation: Promise<T>): Promise<T> {
    this.assertPending(stage);
    let reject!: (error: Error) => void;
    const cancelled = new Promise<never>((_resolve, onReject) => { reject = onReject; });
    const abort = () => reject(Object.assign(new Error('This pending capture was cancelled.'), { code: 'capture_cancelled' }));
    stage.controller.signal.addEventListener('abort', abort, { once: true });
    try { const value = await Promise.race([operation, cancelled]); this.assertPending(stage); return value; }
    finally { stage.controller.signal.removeEventListener('abort', abort); }
  }
  private pendingRecover<T>(stage: PendingFreeze, operation: () => Promise<T>): Promise<T> { return this.recover(async () => { this.assertPending(stage); return this.awaitPending(stage, operation()); }); }
  private sameTarget(a: AnnotationInput, b: AnnotationInput) {
    const target = (value: AnnotationInput) => ({ scope: value.scope, objectId: value.objectId, objectIds: [...value.objectIds].sort(), assetId: value.assetId, bounds: value.bounds, coordinateSpace: value.coordinateSpace, timeStart: value.timeStart, timeEnd: value.timeEnd, snapshotAssetId: value.snapshotAssetId, geometry: value.geometry, contentAnchor: value.contentAnchor });
    return equal(target(a), target(b));
  }
  private reconcileCancelled(stage: PendingFreeze): Promise<PendingFreezeCancellation> {
    if (!stage.saveStarted || !stage.sceneSource) return Promise.resolve({});
    if (stage.reconciliation) return stage.reconciliation;
    stage.reconciliation = (async () => {
      const draft = (await this.recover(() => this.api.state(stage.identity.sessionId))).draft, annotation = draft.annotations.find(value => value.id === stage.identity.annotationId);
      if (draft.id !== stage.identity.draftId || !annotation?.captureState || !equal(annotation.sceneSource, stage.sceneSource) || !this.sameTarget(annotation, stage.target)) return {};
      if (stage.invalidatedVersion !== undefined && annotation.captureState.version >= stage.invalidatedVersion) return { draft };
      const retry = await this.recover(() => this.api.retryCapture(stage.identity.sessionId, draft.id, annotation.id, annotation.captureState!.version));
      stage.invalidatedVersion = retry.version; return { draft: retry.draft, retry };
    })().finally(() => { stage.reconciliation = undefined; });
    return stage.reconciliation;
  }
  cancelPending(identity: PendingFreezeIdentity): Promise<PendingFreezeCancellation> {
    const stage = this.pending.get(JSON.stringify(identity));
    if (!stage) return Promise.resolve({});
    stage.cancelled = true; stage.controller.abort(); return this.reconcileCancelled(stage);
  }
  sceneSnapshot(): Promise<BaseSceneSnapshot> {
    return this.ordered(async () => { const view = await this.ready(), operation = this.operation(view); return this.recover(() => this.api.sceneSnapshot(this.sessionId, view.viewId, operation)); });
  }
  private async confirm(view: CaptureView, presentation: ScenePresentation) {
    if (presentation.documentId !== view.documentId || presentation.viewId !== view.viewId) throw Object.assign(new Error('The visible frame belongs to another document.'), { code: 'scene_scope' });
    if (equal(this.presented, presentation)) return;
    const operation = { ...this.operation(view), presentation };
    await this.recover(() => this.api.confirmScenePresentation(this.sessionId, view.viewId, operation)); this.presented = structuredClone(presentation);
  }
  confirmPresentation(presentation: CopiedSceneFrame['presentation']): Promise<void> {
    const paired = structuredClone(presentation) as ScenePresentation;
    return this.ordered(async () => this.confirm(await this.ready(), paired));
  }

  /** Pixel copying occurs in this synchronous entry, before its first service operation. */
  freezeAndHold(input: FreezeAndHoldInput): FreezeAndHoldTask {
    const identity: PendingFreezeIdentity = { documentId: this.documentId, sessionId: this.sessionId, draftId: input.draft.id, annotationId: input.annotation.id, pendingGeneration: ++this.pendingGeneration };
    const attach = (promise: Promise<{ draft: Draft; frame: PreparedSceneCapture }>) => Object.assign(promise, { identity, cancel: () => this.cancelPending(identity) });
    if (this.jobs.size + this.pendingFreezes >= this.maxPendingCaptures) return attach(Promise.reject(Object.assign(new Error('Complete a pending annotation capture before creating another.'), { code: 'capture_pending_limit' })));
    if (input.signal?.aborted) return attach(Promise.reject(Object.assign(new Error('This annotation capture was cancelled.'), { code: 'capture_cancelled' })));
    const stage: PendingFreeze = { identity, cancelled: false, controller: new AbortController(), saveStarted: false, target: structuredClone(input.annotation) };
    this.pending.set(JSON.stringify(identity), stage);
    let copied: CopiedSceneFrame;
    try { copied = input.freeze(); } catch (error) { this.pending.delete(JSON.stringify(identity)); return attach(Promise.reject(error)); }
    const presentation = structuredClone(copied.presentation) as ScenePresentation, capturedAt = new Date().toISOString();
    const originalDraft = structuredClone(input.draft), originalAnnotation = structuredClone(input.annotation);
    const frozenInput = { worldBounds: structuredClone(input.worldBounds), viewport: structuredClone(input.viewport), scene: structuredClone(input.scene), cropCSS: structuredClone(copied.cropCSS) };
    this.pendingFreezes++;
    const abort = () => { void this.cancelPending(identity).catch(() => {}); }; input.signal?.addEventListener('abort', abort, { once: true });
    return attach(this.ordered(async () => {
      this.assertPending(stage); const view = await this.awaitPending(stage, this.ready()); await this.awaitPending(stage, this.confirm(view, presentation));
      const operation = { ...this.operation(view), presentation }, sceneSource = await this.pendingRecover(stage, () => this.api.holdScenePresentation(this.sessionId, view.viewId, operation));
      stage.sceneSource = sceneSource; this.assertPending(stage);
      const annotation = { ...originalAnnotation, sceneSource, captureState: originalAnnotation.captureState ?? { version: 1, status: 'incomplete' as const } };
      const candidate: Draft = { ...originalDraft, annotations: originalDraft.annotations.some(value => value.id === annotation.id) ? originalDraft.annotations.map(value => value.id === annotation.id ? annotation : value) : [...originalDraft.annotations, annotation] };
      let draft: Draft;
      stage.saveStarted = true;
      try { draft = await this.pendingRecover(stage, () => { const request = this.api.saveDraft(candidate); void request.finally(() => { if (stage.cancelled || this.closed) void this.reconcileCancelled(stage).catch(() => {}); }).catch(() => {}); return request; }); }
      catch (error) {
        if (stage.cancelled || this.closed) throw error;
        if (!['draft_revision_conflict', 'connection_lost'].includes(code(error))) throw error;
        const current = (await this.pendingRecover(stage, () => this.api.state(this.sessionId))).draft, saved = current.annotations.find(value => value.id === annotation.id);
        if (current.id !== candidate.id || !saved || !equal(saved.sceneSource, sceneSource) || saved.text !== annotation.text) throw error;
        draft = current;
      }
      this.assertPending(stage);
      const saved = draft.annotations.find(value => value.id === annotation.id);
      if (!saved?.captureState || !equal(saved.sceneSource, sceneSource)) throw Object.assign(new Error('Read the saved annotation source before capturing.'), { code: 'scene_source_conflict' });
      const identity: BrowserCaptureIdentity = { documentId: this.documentId, sessionId: this.sessionId, draftId: draft.id, annotationId: annotation.id, version: saved.captureState.version, generation: ++this.generation };
      const { id, text, captureState, capture, sceneSource: savedSource, ...target } = saved;
      const frame: PreparedSceneCapture = { ...frozenInput, identity, capturedAt, presentation, sceneSource, target, encodePNG: () => copied.encodePNG() };
      this.jobs.set(identityKey(identity), { cancelled: false, controller: new AbortController(), frame });
      return { draft, frame };
    }).catch(async error => { if (!stage.cancelled && !this.closed) throw error; const result = await this.reconcileCancelled(stage); throw Object.assign(new Error('This annotation capture was cancelled.'), { code: 'capture_cancelled', ...result }); }).finally(() => { this.pendingFreezes--; this.pending.delete(JSON.stringify(stage.identity)); input.signal?.removeEventListener('abort', abort); }));
  }
  private active(identity: BrowserCaptureIdentity) {
    const job = this.jobs.get(identityKey(identity));
    return !!job && !job.cancelled && !this.closed;
  }
  private assertActive(identity: BrowserCaptureIdentity) { if (!this.active(identity)) throw Object.assign(new Error('This annotation capture was cancelled.'), { code: 'capture_cancelled' }); }
  private async query(identity: BrowserCaptureIdentity): Promise<CaptureResult | undefined> {
    try { return await this.api.captureResult(identity.sessionId, identity.draftId, identity.annotationId, identity.version); }
    catch (error) { if (code(error) === 'capture_missing') return; throw error; }
  }
  async capture(frame: PreparedSceneCapture | SceneEvidenceFrame): Promise<BrowserCaptureResult> {
    const cached = this.results.get(frame); if (cached?.status === 'complete') return cached;
    const identity = frame.identity, key = identityKey(identity), started = performance.now();
    if (this.cancelledFrames.has(frame)) return { status: 'incomplete', code: 'capture_cancelled' };
    const restored = this.restoredFrames.has(frame);
    if (identity.sessionId !== this.sessionId || identity.documentId !== frame.sceneSource.documentId || frame.presentation.viewId !== frame.sceneSource.viewId || (!restored && (identity.documentId !== this.documentId || frame.sceneSource.viewId !== this.viewId))) return { status: 'incomplete', code: 'scene_scope' };
    if (!this.jobs.has(key)) this.jobs.set(key, { cancelled: false, controller: new AbortController(), frame });
    let png: Blob | undefined, lastError: unknown;
    for (let attempt = 1; attempt <= this.attempts; attempt++) {
      try {
        this.assertActive(identity); let result = await this.query(identity); this.assertActive(identity);
        if (result?.status !== 'committed') {
          if (!png) {
            if ('png' in frame) png = frame.png;
            else {
              let encoding = this.encodings.get(frame);
              if (!encoding) { encoding = frame.encodePNG().catch(cause => { this.encodings.delete(frame); throw Object.assign(new Error('Encode the copied annotation pixels.'), { code: cause instanceof DOMException && cause.name === 'SecurityError' ? 'capture_not_exportable' : 'capture_encoding_failed', cause }); }); this.encodings.set(frame, encoding); }
              png = await encoding;
            }
            this.assertActive(identity);
            if (png.type !== 'image/png' || png.size < 1 || png.size > 20 * 1024 * 1024) throw Object.assign(new Error('Capture images use PNG within the supported byte size.'), { code: 'invalid_capture' });
          }
          const presentation = frame.presentation, width = Math.round(frame.cropCSS.width * presentation.bitmap.width / presentation.cssViewport.width), height = Math.round(frame.cropCSS.height * presentation.bitmap.height / presentation.cssViewport.height);
          const input: AnnotationCaptureInput = { capturedAt: frame.capturedAt, target: frame.target, worldBounds: frame.worldBounds, viewport: frame.viewport, mapping: { crop: frame.cropCSS, pixelWidth: width, pixelHeight: height, scaleX: width / frame.cropCSS.width, scaleY: height / frame.cropCSS.height }, scene: frame.scene, image: { mime: 'image/png', width, height, bytes: png.size }, sourceMode: 'scene-bitmap', sceneSource: frame.sceneSource, presentation };
          if (!result) result = await this.api.prepareCapture(identity.sessionId, identity.draftId, identity.annotationId, identity.version, input);
          this.assertActive(identity);
          if (result.status !== 'committed') result = await this.api.commitCapture(identity.sessionId, identity.draftId, identity.annotationId, identity.version, png, this.jobs.get(key)!.controller.signal);
          this.assertActive(identity);
        }
        if (result.status !== 'committed') throw Object.assign(new Error('Query the saved capture upload result.'), { code: 'capture_upload_active' });
        const completed: BrowserCaptureResult = { status: 'complete', result, attempts: attempt, elapsedMs: performance.now() - started };
        this.results.set(frame, completed); this.jobs.delete(key); return completed;
      } catch (error) {
        lastError = this.active(identity) ? error : Object.assign(new Error('This capture was cancelled.'), { code: 'capture_cancelled' }); if (!transient(lastError) || attempt >= this.attempts) break;
        await wait(this.retryDelayMs * attempt);
      }
    }
    return { status: 'incomplete', code: code(lastError) };
  }
  async cancel(identity: BrowserCaptureIdentity): Promise<CaptureRetryResult | undefined> {
    const job = this.jobs.get(identityKey(identity)); if (!job || job.cancelled) return;
    job.cancelled = true; job.controller.abort(); if (job.frame) this.cancelledFrames.add(job.frame);
    try { return await this.recover(() => this.api.retryCapture(identity.sessionId, identity.draftId, identity.annotationId, identity.version)); }
    catch (error) { if (['capture_version_conflict', 'capture_missing', 'draft_conflict'].includes(code(error))) return; throw error; }
    finally { this.jobs.delete(identityKey(identity)); }
  }
  /** Restore already copied pixels against the durable source, including a closed original view. */
  async resume(frame: PreparedSceneCapture | SceneEvidenceFrame): Promise<BrowserCaptureResult> {
    try {
      const draft = (await this.recover(() => this.api.state(this.sessionId))).draft, annotation = draft.annotations.find(value => value.id === frame.identity.annotationId);
      if (draft.id !== frame.identity.draftId || annotation?.captureState?.version !== frame.identity.version || !equal(annotation.sceneSource, frame.sceneSource)) return { status: 'incomplete', code: 'capture_version_conflict' };
      this.restoredFrames.add(frame); return this.capture(frame);
    } catch (error) { return { status: 'incomplete', code: code(error) }; }
  }
  close(options: { keepalive?: boolean } = {}): Promise<void> {
    if (options.keepalive) this.closeOptions.keepalive = true;
    if (options.keepalive && this.view) void this.retireView().catch(() => undefined);
    if (this.closeTask) return this.closeTask;
    this.closed = true; for (const job of this.jobs.values()) { job.cancelled = true; job.controller.abort(); }
    for (const stage of this.pending.values()) { stage.cancelled = true; stage.controller.abort(); }
    return this.closeTask = (async () => { await Promise.all([...this.pending.values()].map(stage => this.reconcileCancelled(stage))); await this.retireView(); this.jobs.clear(); })();
  }
  private retireView(): Promise<void> {
    if (!this.view) return Promise.resolve();
    if (!this.closingView) { const view = this.view, operation = this.operation(view); this.closingView = this.recover(() => this.api.closeCaptureView(this.sessionId, view.viewId, operation, this.closeOptions)).then(() => undefined); }
    return this.closingView;
  }
}

export const createProjectCaptureProvider = (api: ProjectCaptureTransport, options: ProjectCaptureOptions) => new ProjectCaptureCoordinator(api, options);
