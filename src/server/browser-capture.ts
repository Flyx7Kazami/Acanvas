import { randomUUID } from 'node:crypto';
import { mkdir, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { BrowserContext, Page, Frame } from 'playwright-core';
import type { BrowserCaptureFrame, BrowserCaptureIdentity, BrowserCaptureResult, BrowserPage, BrowserStatus } from '../shared/browser-capture.js';
import type { AnnotationCaptureInput, CaptureResult, CaptureRetryResult } from '../shared/types.js';
import { ApiFailure, CanvasService, within } from './service.js';
import { runtimeDirectory } from './runtime.js';

export interface ProjectBrowserOptions { headless?: boolean }
type BindingSource = { context: BrowserContext; page: Page; frame: Frame };
interface ManagedPage { page: Page; info: BrowserPage; job?: CaptureJob }
interface CaptureJob {
  entry: ManagedPage;
  identity: BrowserCaptureIdentity;
  controller: AbortController;
  began: number;
  reason?: string;
  invalidation?: Promise<CaptureRetryResult | undefined>;
  result?: Promise<BrowserCaptureResult>;
  accepted?: boolean;
  sampling?: boolean;
  restoring?: Promise<void>;
}

const identityKeys = ['documentId', 'generation', 'sessionId', 'draftId', 'annotationId', 'version'] as const;
function sameIdentity(a: BrowserCaptureIdentity, b: BrowserCaptureIdentity): boolean { return identityKeys.every(key => a?.[key] === b?.[key]); }
function failureCode(error: unknown): string { return error instanceof ApiFailure ? error.code : error instanceof Error ? error.message : 'capture_unavailable'; }
function stableFrame(frame: BrowserCaptureFrame) {
  // Ongoing audio/video and animations express the captured frame. Application
  // geometry, scroll, viewport and target state express layout consistency.
  return { ...frame, scene: { ...frame.scene, objects: frame.scene.objects.map(({ media: _media, ...object }) => object) } };
}

/** Owns the interactive project browser and captures its original live pages. */
export class ProjectBrowser {
  private context?: BrowserContext;
  private launching?: Promise<BrowserContext>;
  private pages = new Map<string, ManagedPage>();
  private opening: Promise<unknown> = Promise.resolve();
  private jobs = new Set<CaptureJob>();
  private stopped = false;

  constructor(private service: CanvasService, private url: string, private token: string, private options: ProjectBrowserOptions = {}) {}

  status(sessionId?: string): BrowserStatus {
    if (sessionId) this.service.session(sessionId);
    return { projectId: this.service.project.id, instanceId: this.service.identity().instanceId, running: !!this.context, pages: [...this.pages.values()].filter(entry => !entry.page.isClosed() && (!sessionId || entry.info.sessionId === sessionId)).map(entry => ({ ...entry.info })) };
  }

  /** The server uses this handle; the HTTP API provides lifecycle actions only. */
  page(sessionId: string): Page | undefined { return this.pages.get(sessionId)?.page; }

  open(sessionId: string): Promise<BrowserPage> {
    this.service.session(sessionId);
    const task = this.opening.catch(() => undefined).then(() => this.openPage(sessionId));
    this.opening = task;
    return task;
  }

  private async browser(): Promise<BrowserContext> {
    if (this.stopped) throw new ApiFailure(503, 'browser_stopped', 'Open the project after its service starts.');
    if (this.context) return this.context;
    if (this.launching) return this.launching;
    this.launching = (async () => {
      const runtime = await runtimeDirectory(this.service.project.root);
      const directory = resolve(runtime, 'browser-profile');
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const profile = await realpath(directory);
      if (!within(runtime, profile)) throw new ApiFailure(403, 'path_boundary', 'The project browser profile remains inside runtime storage.');
      const { chromium } = await import('playwright-core');
      const context = await chromium.launchPersistentContext(profile, { channel: 'chrome', chromiumSandbox: true, headless: this.options.headless ?? false, viewport: this.options.headless ? { width: 1440, height: 1000 } : null, timeout: 15_000 });
      if (this.stopped) { await context.close(); throw new ApiFailure(503, 'browser_stopped', 'Open the project after its service starts.'); }
      this.context = context;
      context.on('close', () => {
        if (this.context !== context) return;
        this.context = undefined;
        for (const job of this.jobs) void this.invalidate(job, 'browser_disconnected');
        this.pages.clear();
      });
      return context;
    })();
    try { return await this.launching; }
    catch (error) {
      if (error instanceof ApiFailure) throw error;
      const failure = new ApiFailure(503, 'browser_unavailable', 'Start the project browser with an installed Chrome.', { reason: error instanceof Error ? error.message : 'Chrome did not become ready.' });
      failure.cause = error;
      throw failure;
    }
    finally { this.launching = undefined; }
  }

  private async openPage(sessionId: string): Promise<BrowserPage> {
    if (this.stopped) throw new ApiFailure(503, 'browser_stopped', 'Open the project after its service starts.');
    const current = this.pages.get(sessionId);
    if (current && !current.page.isClosed()) {
      if (!this.routeMatches(current)) throw new ApiFailure(409, 'browser_navigation', 'Close this project browser page and open its board again.');
      await current.page.bringToFront();
      return { ...current.info };
    }
    const context = await this.browser();
    const blank = context.pages().find(page => page.url() === 'about:blank' && ![...this.pages.values()].some(entry => entry.page === page));
    const page = blank ?? await context.newPage();
    const openUrl = new URL(this.url); openUrl.searchParams.set('session', sessionId);
    const entry: ManagedPage = { page, info: { pageId: randomUUID(), sessionId, url: openUrl.href } };
    await page.exposeBinding('__acanvasBrowserCapture', (source, frame: BrowserCaptureFrame) => this.capture(source, entry, frame));
    await page.exposeBinding('__acanvasBrowserCancel', async (source, identity: BrowserCaptureIdentity) => {
      this.sourceMatches(source, entry);
      const job = entry.job;
      if (!job || !sameIdentity(job.identity, identity)) return;
      return this.invalidate(job, 'capture_cancelled');
    });
    await page.addInitScript(({ sessionId }) => {
      if (window !== window.top) return;
      const bridge = window as unknown as { __acanvasBrowserCapture: (frame: BrowserCaptureFrame) => Promise<BrowserCaptureResult>; __acanvasBrowserCancel: (identity: BrowserCaptureIdentity) => Promise<CaptureRetryResult | undefined> };
      Object.defineProperty(window, 'acanvasCaptureProvider', { configurable: false, writable: false, value: Object.freeze({ documentId: crypto.randomUUID(), sessionId, capture: (frame: BrowserCaptureFrame) => bridge.__acanvasBrowserCapture(frame), cancel: (identity: BrowserCaptureIdentity) => bridge.__acanvasBrowserCancel(identity) }) });
    }, { sessionId });
    page.on('framenavigated', frame => {
      const job = entry.job;
      if (frame !== page.mainFrame() || !job) return;
      void page.evaluate(() => window.acanvasCaptureProvider?.documentId).then(documentId => {
        if (documentId !== job.identity.documentId || !this.routeMatches(entry)) return this.invalidate(job, 'capture_navigation');
      }).catch(() => this.invalidate(job, 'capture_navigation'));
    });
    const closed = () => {
      if (entry.job) void this.invalidate(entry.job, 'browser_page_closed');
      if (this.pages.get(sessionId) === entry) this.pages.delete(sessionId);
    };
    page.on('close', closed); page.on('crash', closed);
    this.pages.set(sessionId, entry);
    try { await page.goto(openUrl.href, { waitUntil: 'domcontentloaded', timeout: 15_000 }); await page.bringToFront(); }
    catch (error) { closed(); await page.close().catch(() => {}); throw error; }
    return { ...entry.info };
  }

  async closePage(sessionId: string): Promise<BrowserStatus> {
    this.service.session(sessionId);
    await this.opening.catch(() => undefined);
    const entry = this.pages.get(sessionId);
    if (entry?.job) await this.invalidate(entry.job, 'browser_page_closed');
    if (entry) await entry.page.close();
    return this.status(sessionId);
  }

  async close(): Promise<void> {
    this.stopped = true;
    await Promise.allSettled([...this.jobs].map(job => this.invalidate(job, 'browser_stopped')));
    await this.opening.catch(() => undefined);
    await this.launching?.catch(() => undefined);
    await this.context?.close();
    this.context = undefined; this.pages.clear();
    await Promise.allSettled([...this.jobs].map(job => job.result));
  }

  private routeMatches(entry: ManagedPage): boolean {
    if (entry.page.isClosed()) return false;
    const actual = new URL(entry.page.url()), expected = new URL(entry.info.url);
    return actual.origin === expected.origin && actual.pathname === expected.pathname && actual.searchParams.get('session') === entry.info.sessionId;
  }

  private sourceMatches(source: BindingSource, entry: ManagedPage): void {
    if (source.page !== entry.page || source.frame !== entry.page.mainFrame() || this.pages.get(entry.info.sessionId) !== entry || !this.routeMatches(entry)) throw new ApiFailure(403, 'capture_source', 'Capture the current project browser page.');
  }

  private async check(job: CaptureJob, expected: BrowserCaptureFrame): Promise<BrowserCaptureFrame> {
    if (job.reason || job.controller.signal.aborted) throw new Error(job.reason ?? 'capture_cancelled');
    if (!this.routeMatches(job.entry)) throw new Error('capture_navigation');
    const current = await job.entry.page.evaluate(() => {
      const provider = window.acanvasCaptureProvider;
      return { documentId: provider?.documentId, frame: window.acanvasCaptureController?.read() };
    });
    if (current.documentId !== job.identity.documentId || !current.frame || !sameIdentity(current.frame.identity, job.identity)) throw new Error('capture_replaced');
    if (!isDeepStrictEqual(current.frame.viewport, expected.viewport)) throw new Error('capture_viewport_changed');
    const draft = this.service.draft(job.identity.sessionId), annotation = draft.annotations.find(value => value.id === job.identity.annotationId);
    if (draft.id !== job.identity.draftId || annotation?.captureState?.version !== job.identity.version) throw new Error('annotation_version_conflict');
    return current.frame;
  }

  private async api<T>(job: CaptureJob, path: string, method = 'GET', body?: unknown, raw = false): Promise<T> {
    const response = await fetch(new URL(path, this.url), { method, signal: job.controller.signal, headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': raw ? 'image/png' : 'application/json' }, ...(body === undefined ? {} : { body: raw ? new Uint8Array(body as Buffer).buffer : JSON.stringify(body) }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error?.code ?? 'capture_save_failed');
    return result as T;
  }

  private capturePath(identity: BrowserCaptureIdentity): string {
    return `/api/sessions/${encodeURIComponent(identity.sessionId)}/drafts/${encodeURIComponent(identity.draftId)}/annotations/${encodeURIComponent(identity.annotationId)}/captures/${identity.version}`;
  }

  private invalidate(job: CaptureJob, reason: string): Promise<CaptureRetryResult | undefined> {
    if (job.invalidation) return job.invalidation;
    job.reason = reason; job.controller.abort();
    job.invalidation = (async () => {
      let result: CaptureRetryResult | undefined;
      if (job.accepted) {
        const identity = job.identity;
        const draft = this.service.draft(identity.sessionId);
        const annotation = draft.id === identity.draftId ? draft.annotations.find(value => value.id === identity.annotationId) : undefined;
        if (annotation?.captureState?.version === identity.version) result = this.service.retryCapture(identity.sessionId, identity.draftId, identity.annotationId, identity.version);
      }
      // Cancellation restores controls even when the native screenshot is still
      // finishing. Its bytes belong to an invalidated version and cannot commit.
      await this.restoreSampling(job).catch(() => {});
      return result;
    })();
    return job.invalidation;
  }

  private async prepareSampling(job: CaptureJob): Promise<BrowserCaptureFrame> {
    job.sampling = true;
    const prepared = await job.entry.page.evaluate(async identity => {
      if (window.acanvasCaptureProvider?.documentId !== identity.documentId) return;
      const controller = window.acanvasCaptureController;
      if (!controller?.prepare || !controller.restore) throw new Error('capture_preparation_unavailable');
      return controller.prepare(identity);
    }, job.identity);
    if (!prepared || !sameIdentity(prepared.identity, job.identity)) throw new Error('capture_replaced');
    return prepared;
  }

  private restoreSampling(job: CaptureJob): Promise<void> {
    if (!job.sampling) return job.restoring ?? Promise.resolve();
    job.sampling = false;
    const pending = job.entry.page.isClosed() ? Promise.resolve() : job.entry.page.evaluate(async identity => {
      if (window.acanvasCaptureProvider?.documentId !== identity.documentId) return;
      await window.acanvasCaptureController?.restore(identity);
    }, job.identity);
    job.restoring = pending;
    void pending.finally(() => { if (job.restoring === pending) job.restoring = undefined; }).catch(() => {});
    return pending;
  }

  private async capture(source: BindingSource, entry: ManagedPage, frame: BrowserCaptureFrame): Promise<BrowserCaptureResult> {
    try {
      this.sourceMatches(source, entry);
      const identity = frame?.identity;
      if (!identity || identity.sessionId !== entry.info.sessionId || !identity.documentId || !identity.draftId || !identity.annotationId || !Number.isSafeInteger(identity.version) || identity.version < 1 || !Number.isSafeInteger(identity.generation) || identity.generation < 1) throw new Error('capture_identity');
      if (entry.job) return sameIdentity(entry.job.identity, identity) ? entry.job.result! : { status: 'incomplete', code: 'capture_busy' };
      const job: CaptureJob = { entry, identity: { ...identity }, controller: new AbortController(), began: performance.now() };
      entry.job = job; this.jobs.add(job);
      job.result = this.run(job, frame);
      return await job.result;
    } catch (error) { return { status: 'incomplete', code: failureCode(error) }; }
  }

  private async run(job: CaptureJob, initial: BrowserCaptureFrame): Promise<BrowserCaptureResult> {
    const timer = setTimeout(() => { void this.invalidate(job, 'capture_timeout'); }, 8000); timer.unref();
    try {
      let frame = initial;
      for (let attempt = 1; attempt <= 2; attempt++) {
        await this.check(job, frame);
        job.accepted = true;
        let before: BrowserCaptureFrame, after: BrowserCaptureFrame, png: Buffer, capturedAt: string;
        try {
          const prepared = await this.prepareSampling(job);
          before = await this.check(job, frame);
          if (!isDeepStrictEqual(stableFrame(prepared), stableFrame(before))) {
            if (attempt === 2) throw new Error('capture_layout_changed');
            frame = before; continue;
          }
          if (!isDeepStrictEqual(stableFrame(before), stableFrame(frame))) {
            if (attempt === 2) throw new Error('capture_layout_changed');
            frame = before;
          }
          capturedAt = new Date().toISOString();
          png = await job.entry.page.screenshot({ type: 'png', fullPage: false, animations: 'allow', scale: 'device', timeout: 3000 });
          after = await this.check(job, frame);
        } finally { await this.restoreSampling(job); }
        if (!isDeepStrictEqual(stableFrame(before), stableFrame(after))) {
          if (attempt === 2 || performance.now() - job.began > 2000) throw new Error('capture_layout_changed');
          frame = after; continue;
        }
        const crop = await cropScreenshot(job.entry.page, png, before);
        const fresh = await this.check(job, frame);
        if (!isDeepStrictEqual(stableFrame(before), stableFrame(fresh))) {
          if (attempt === 2 || performance.now() - job.began > 2000) throw new Error('capture_layout_changed');
          frame = fresh; continue;
        }
        const bytes = Buffer.from(crop.base64, 'base64');
        const input: AnnotationCaptureInput = { target: before.target, worldBounds: before.worldBounds, viewport: before.viewport, scene: before.scene, capturedAt, image: { mime: 'image/png', width: crop.width, height: crop.height, bytes: bytes.length }, mapping: { crop: before.crop, pixelWidth: crop.width, pixelHeight: crop.height, scaleX: crop.width / before.crop.width, scaleY: crop.height / before.crop.height } };
        const path = this.capturePath(job.identity);
        await this.api<CaptureResult>(job, path, 'POST', input);
        await this.check(job, frame);
        try { await this.api<CaptureResult>(job, `${path}/content`, 'PUT', bytes, true); }
        catch (error) {
          // A completed upload may lose its response. Reconcile the saved identity
          // before exposing completion; cancellation continues through its version.
          if (job.controller.signal.aborted) throw error;
          const saved = await this.api<CaptureResult>(job, path);
          if (saved.status !== 'committed') throw error;
        }
        await this.check(job, frame);
        const result = await this.api<CaptureResult>(job, path);
        await this.check(job, frame);
        if (result.status !== 'committed') throw new Error('capture_save_failed');
        return { status: 'complete', result, attempts: attempt, elapsedMs: performance.now() - job.began };
      }
      throw new Error('capture_layout_changed');
    } catch (error) {
      const code = job.reason ?? failureCode(error);
      const retry = await this.invalidate(job, code);
      return { status: 'incomplete', code, ...(retry ? { retry } : {}) };
    } finally { clearTimeout(timer); await this.restoreSampling(job).catch(() => {}); if (job.entry.job === job) job.entry.job = undefined; this.jobs.delete(job); }
  }
}

async function cropScreenshot(page: Page, png: Buffer, frame: BrowserCaptureFrame) {
  return page.evaluate(async ({ data, crop, viewport }) => {
    for (const value of [crop.x, crop.y, crop.width, crop.height, viewport.width, viewport.height]) if (!Number.isFinite(value)) throw new Error('capture_crop');
    if (crop.x < 0 || crop.y < 0 || crop.width <= 0 || crop.height <= 0 || crop.x + crop.width > viewport.width || crop.y + crop.height > viewport.height || innerWidth !== viewport.width || innerHeight !== viewport.height) throw new Error('capture_crop');
    const source = new Image(); source.src = `data:image/png;base64,${data}`; await source.decode();
    const sourceScaleX = source.naturalWidth / viewport.width, sourceScaleY = source.naturalHeight / viewport.height;
    if (Math.abs(sourceScaleX - sourceScaleY) > .01) throw new Error('capture_mapping');
    const scale = Math.min(1, 1024 / Math.max(crop.width * sourceScaleX, crop.height * sourceScaleY));
    const canvas = document.createElement('canvas'); canvas.width = Math.max(1, Math.round(crop.width * sourceScaleX * scale)); canvas.height = Math.max(1, Math.round(crop.height * sourceScaleY * scale));
    canvas.getContext('2d')!.drawImage(source, crop.x * sourceScaleX, crop.y * sourceScaleY, crop.width * sourceScaleX, crop.height * sourceScaleY, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob>((accept, reject) => canvas.toBlob(value => value ? accept(value) : reject(new Error('capture_encode')), 'image/png'));
    const base64 = await new Promise<string>((accept, reject) => { const reader = new FileReader(); reader.onerror = () => reject(new Error('capture_encode')); reader.onload = () => accept((reader.result as string).split(',')[1]); reader.readAsDataURL(blob); });
    return { width: canvas.width, height: canvas.height, base64 };
  }, { data: png.toString('base64'), crop: frame.crop, viewport: frame.viewport });
}
