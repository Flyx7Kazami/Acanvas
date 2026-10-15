import type { AnnotationCaptureInput, AnnotationTarget, Bounds, CaptureResult, CaptureRetryResult, ScenePresentation, SceneSource } from './types.js';

export interface BrowserCaptureIdentity {
  documentId: string;
  generation: number;
  sessionId: string;
  draftId: string;
  annotationId: string;
  version: number;
}

/** CSS viewport coordinates refer to the original page's innerWidth/innerHeight. */
export interface BrowserCaptureFrame {
  identity: BrowserCaptureIdentity;
  target: AnnotationTarget;
  worldBounds: Bounds;
  viewport: AnnotationCaptureInput['viewport'];
  crop: Bounds;
  scene: AnnotationCaptureInput['scene'];
}

/** Done has copied these pixels before asynchronous service calls or encoding. */
export interface SceneEvidenceFrame {
  identity: BrowserCaptureIdentity;
  sceneSource: SceneSource;
  presentation: ScenePresentation;
  capturedAt: string;
  target: AnnotationTarget;
  worldBounds: Bounds;
  cropCSS: Bounds;
  viewport: AnnotationCaptureInput['viewport'];
  scene: AnnotationCaptureInput['scene'];
  png: Blob;
}

export interface ProjectCaptureProvider {
  readonly documentId: string;
  readonly sessionId: string;
  readonly viewId: string;
  capture(frame: SceneEvidenceFrame): Promise<BrowserCaptureResult>;
  cancel(identity: BrowserCaptureIdentity): Promise<CaptureRetryResult | undefined>;
}

export type BrowserCaptureResult =
  | { status: 'complete'; result: CaptureResult; attempts: number; elapsedMs: number }
  | { status: 'incomplete'; code: string; retry?: CaptureRetryResult };

export interface BrowserCaptureProvider {
  readonly documentId: string;
  readonly sessionId: string;
  capture(frame: BrowserCaptureFrame): Promise<BrowserCaptureResult>;
  cancel(identity: BrowserCaptureIdentity): Promise<CaptureRetryResult | undefined>;
}

export interface BrowserCaptureController {
  /** Return undefined as soon as the active capture is cancelled or replaced. */
  read(): BrowserCaptureFrame | undefined;
  /** Hide fixed editing controls and wait for the sampling layout to render. */
  prepare(identity: BrowserCaptureIdentity): Promise<BrowserCaptureFrame | undefined>;
  /** Restore controls for this identity after sampling, cancellation or failure. */
  restore(identity: BrowserCaptureIdentity): Promise<void> | void;
}

export interface BrowserPage {
  pageId: string;
  sessionId: string;
  url: string;
}

export interface BrowserStatus {
  projectId: string;
  instanceId: string;
  running: boolean;
  pages: BrowserPage[];
}

declare global {
  interface Window {
    acanvasCaptureController?: BrowserCaptureController;
    acanvasCaptureProvider?: BrowserCaptureProvider;
  }
}
