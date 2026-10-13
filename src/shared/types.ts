import type {HtmlSemanticSnapshot,HtmlControlInput,HtmlClipboardAction,HtmlSurfacePopup} from './html-surface.js';
import type { NoteFill } from './content-types.js';
export type AssetKind = 'image' | 'video' | 'file';
export type TaskStatus = 'queued' | 'editing' | 'running' | 'blocked' | 'interrupted' | 'completed' | 'cancelled';
export interface Project { id: string; name: string; root: string }
export interface HtmlBundle { entryPath: string; files: Record<string, string> }
export interface Asset { id: string; name: string; mime: string; size: number; kind: AssetKind; createdAt: string; sourceTaskId?: string; sourceRunId?: string; htmlBundle?: HtmlBundle; evidence?: { sessionId: string; draftId: string; captureId: string } }
export interface Bounds { x: number; y: number; width: number; height: number }
export interface BoardObject extends Bounds { id: string; assetId: string; type: AssetKind; version: number; createdAt: string; updatedAt: string; sourceTaskId?: string; sourceRunId?: string; fill?: NoteFill; groupId?: string }
export type GroupMode = 'frame' | 'folder';
export type GroupColor = 'cobalt' | 'sage' | 'coral' | 'lilac' | 'ink' | 'sand';
export interface BoardGroup extends Bounds { id: string; name: string; mode: GroupMode; color: GroupColor; version: number; createdAt: string; updatedAt: string; objectIds: string[] }
export interface ContentAnchor { kind: 'visual' | 'text'; scroll?: { x: number; y: number }; quote?: string; context?: string; path?: string; start?: number; end?: number }
export interface CaptureState { version: number; status: 'incomplete' | 'complete'; captureId?: string }
export interface AnnotationInput { id: string; scope: 'object' | 'group' | 'region'; boardGroupId?: string; objectId?: string; objectIds: string[]; assetId?: string; bounds: Bounds; coordinateSpace: 'normalized' | 'world'; text: string; timeStart?: number; timeEnd?: number; snapshotAssetId?: string; geometry?: 'point' | 'rect'; contentAnchor?: ContentAnchor; captureState?: CaptureState; capture?: AnnotationCapture; sceneSource?: SceneSource }
export type AnnotationTarget = Pick<AnnotationInput, 'scope' | 'boardGroupId' | 'objectId' | 'objectIds' | 'assetId' | 'bounds' | 'coordinateSpace' | 'timeStart' | 'timeEnd' | 'snapshotAssetId' | 'geometry' | 'contentAnchor'>;
export interface MediaPresentationPosition { playbackTime?: number; presentedTime?: number; representativeTime?: number; timePrecision?: 'decoded-pts' | 'rvfc-observed' | 'playback-sampled'; frameIndex?: number }
export interface CaptureSceneObject { object: BoardObject; renderedBounds: Bounds; layer: number; visibleBounds?: Bounds; media?: MediaPresentationPosition; scroll?: { x: number; y: number }; contentAnchor?: ContentAnchor }
export interface CaptureView { projectId: string; sessionId: string; documentId: string; viewId: string; viewGeneration: number }
export interface CaptureViewOperation { documentId: string; viewGeneration: number; operationSeq: number }
/** Complete service-delivered render input; capture.scene remains bounded reference metadata. */
export interface BaseSceneSnapshot { id: string; view: CaptureView; operationSeq: number; createdAt: string; expiresAt: string; objects: BoardObject[]; assets: Asset[]; groups?: BoardGroup[] }
export interface HtmlSurfaceReference { surfaceId: string; instanceId: string; frameSeq: number; inputSeq: number; viewport: { width: number; height: number } }
export interface ProjectHtmlSurface extends CaptureView { surfaceId: string; instanceId: string; objectId: string; assetId: string; viewport: { width: number; height: number }; deviceScaleFactor: number;engine:'chromium'|'cef' }
export interface HtmlSurfaceFrameMetadata extends HtmlSurfaceReference { owner: CaptureView & { objectId: string; assetId: string }; bitmap: { width: number; height: number }; capturedAt: string; semantics:HtmlSemanticSnapshot;popup?:HtmlSurfacePopup;contentUrl: string }
export type ProjectHtmlSurfaceInput = { instanceId: string; inputSeq: number; viewport: { width: number; height: number };frameSeq?:number } & (
  | { type: 'pointer'; action: 'move' | 'down' | 'up' | 'click'; x: number; y: number; button?: 'left' | 'middle' | 'right' }
  | { type: 'wheel'; x: number; y: number; deltaX: number; deltaY: number }
  | { type: 'key'; action: 'down' | 'up' | 'press'; key: string;emitText?:boolean;character?:string }
  | { type: 'text'; text: string } | HtmlControlInput | HtmlClipboardAction);
export interface RenderedLayer { objectId: string; assetId?: string; objectVersion: number; worldBounds: Bounds; contentWorldBounds?: Bounds; renderedBounds: Bounds; clipCSS?: Bounds; layer: number; surface?: HtmlSurfaceReference; contentAnchor?: ContentAnchor }
export interface PresentedMedia extends MediaPresentationPosition { objectId: string; selectedTime?: number; selectedRange?: { start: number; end: number }; surfaceFrameSeq?: number }
export interface ScenePresentation { documentId: string; viewId: string; frameSeq: number; baseSceneId: string; camera: { x: number; y: number; zoom: number }; cssViewport: Bounds; bitmap: { width: number; height: number }; layers: RenderedLayer[]; media: PresentedMedia[] }
export interface ScenePresentationOperation extends CaptureViewOperation { presentation: ScenePresentation }
/** Service-issued Done source; pixels remain owned by the presenting client. */
export interface SceneSource extends CaptureView { id: string; baseSceneId: string; frameSeq: number; operationSeq: number; sourceMode: 'scene-bitmap'; createdAt: string }
export interface AnnotationCaptureInput { capturedAt: string; target: AnnotationTarget; worldBounds: Bounds; viewport: { x: number; y: number; zoom: number; width: number; height: number; devicePixelRatio: number }; mapping: { crop: Bounds; pixelWidth: number; pixelHeight: number; scaleX: number; scaleY: number }; scene: { objects: CaptureSceneObject[]; assets: Asset[]; omittedCount: number }; image: { mime: 'image/png'; width: number; height: number; bytes: number }; sourceMode?: 'scene-bitmap'; sceneSource?: SceneSource; presentation?: ScenePresentation }
export interface AnnotationCapture extends AnnotationCaptureInput { id: string; sessionId: string; draftId: string; annotationId: string; version: number; screenshotAssetId: string; source: 'reference_content' }
export interface CaptureResult { status: 'prepared' | 'committed'; capture: AnnotationCapture; draft?: Draft }
export interface CaptureRetryResult { version: number; draft: Draft }
export interface Annotation extends AnnotationInput { source: 'user_annotation'; createdAt: string; sourceTaskId: string; sessionId: string }
export interface SessionView { x: number; y: number; zoom: number; selectedObjectIds: string[]; activeGroupId?: string; parentView?: { x: number; y: number; zoom: number } }
export interface Session { id: string; name: string; createdAt: string; view: SessionView; consumerId: string | null }
export interface HostBinding { host: string; threadId: string; sessionId: string }
export interface ServiceIdentity { pid: number; instanceId: string }
export interface ServiceRuntime extends ServiceIdentity { project: Project; url: string; bind?: string; allowedHosts?: string[]; previewOrigins?: string[]; urls?: string[] }
export interface RequestReference { kind: 'object' | 'task' | 'group'; id: string; textOffset?: number }
export interface DraftReferences { objectIds: string[]; taskIds: string[]; groupIds?: string[]; order?: RequestReference[] }
export type ResolvedRequestReference = RequestReference & (
  | { kind: 'object'; id: string; label: string; source: 'reference_content'; object: BoardObject; asset: Asset; sourceSessionId?: string; sourceTaskId?: string; sourceRunId?: string }
  | { kind: 'group'; id: string; label: string; source: 'reference_content'; group: BoardGroup; objects: BoardObject[]; assets: Asset[]; sourceSessionId?: string; sourceTaskId?: string; sourceRunId?: string }
  | { kind: 'task'; id: string; label: string; source: 'reference_content'; task: { sessionId: string; sequence: number; text: string }; sourceSessionId: string; sourceTaskId: string });
export interface Draft { editingTaskId?: string; id: string; sessionId: string; revision: number; text: string; attachments: string[]; annotations: AnnotationInput[]; references: DraftReferences; updatedAt: string }
export interface TaskSnapshot { userRequest: { source: 'user_instruction'; text: string }; requestReferences?: { attachmentIds: string[]; objectIds: string[]; taskIds?: string[]; groupIds?: string[]; order?: ResolvedRequestReference[] }; annotations: AnnotationInput[]; referenceContent: { source: 'reference_content'; assets: Asset[]; objects: BoardObject[]; groups?: BoardGroup[]; taskIds: string[] }; requirementText?: string }
export interface Progress { message: string; externalJobId?: string; assetIds?: string[]; createdAt: string }
export interface Receipt { summary: string; assetIds: string[]; objectIds: string[]; validation: string[]; createdAt: string }
export interface TaskReply { text: string; source: 'user_instruction'; createdAt: string }
export interface Run { id: string; taskId: string; consumerId: string; status: 'running' | 'blocked' | 'interrupted' | 'completed'; createdAt: string; updatedAt: string; progress: Progress[]; outputAssetIds: string[]; recoveryResolution?: string }
export interface LateResult { runId: string; consumerId: string; receivedAt: string; payload: unknown }
export interface Task { lastEditDraftId?: string; id: string; sessionId: string; draftId: string; sequence: number; status: TaskStatus; snapshot: TaskSnapshot; requirementText: string; createdAt: string; updatedAt: string; currentRunId: string | null; reason: string | null; receipt: Receipt | null; replies: TaskReply[]; runs: Run[]; lateResults: LateResult[] }
export type BoardOperation =
  | { type: 'create'; object: { id?: string; assetId: string; x: number; y: number; width: number; height: number; groupId?: string } }
  | { type: 'update'; objectId: string; expectedVersion: number; changes: Partial<Bounds> & { fill?: NoteFill | null; groupId?: string | null } }
  | { type: 'content'; objectId: string; expectedVersion: number; text: string }
  | { type: 'delete'; objectId: string; expectedVersion: number }
  | { type: 'group.create'; group: { id?: string; name?: string; objectIds: string[]; color?: GroupColor }; expectedVersions: Record<string, number> }
  | { type: 'group.update'; groupId: string; expectedVersion: number; changes: { name?: string; mode?: GroupMode; x?: number; y?: number } }
  | { type: 'group.ungroup'; groupId: string; expectedVersion: number };
export interface BoardVersionChanges { objects: { id: string; beforeVersion?: number; version?: number }[]; groups: { id: string; beforeVersion?: number; version?: number }[] }
export interface BoardHistory { canUndo: boolean; canRedo: boolean }
export interface BoardState { project: Project; sessions: Session[]; session: Session; draft: Draft; assets: Asset[]; objects: BoardObject[]; groups: BoardGroup[]; annotations: Annotation[]; tasks: Task[]; history: BoardHistory }
export interface Bootstrap { project: Project; token: string; service: ServiceIdentity; capabilities: { maxUploadBytes: number; backup: boolean; recovery: boolean; mediaPreview: 'browser'; generation: 'host_tools' } }
export interface Claim { task: Task | null; run: Run | null; consumerId: string; projectId: string; sessionId: string }
export interface RunIdentity { consumerId: string; runId: string }
export interface CompleteInput extends RunIdentity { summary: string; assetIds: string[]; validation: string[]; operations: BoardOperation[] }
export interface ApiError { error: { code: string; message: string; details?: unknown } }
