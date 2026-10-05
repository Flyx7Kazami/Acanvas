export type AssetKind = 'image' | 'video' | 'file';
export type TaskStatus = 'queued' | 'editing' | 'running' | 'blocked' | 'interrupted' | 'completed' | 'cancelled';
export interface Project { id: string; name: string; root: string }
export interface HtmlBundle { entryPath: string; files: Record<string, string> }
export interface Asset { id: string; name: string; mime: string; size: number; kind: AssetKind; createdAt: string; sourceTaskId?: string; sourceRunId?: string; htmlBundle?: HtmlBundle }
export interface Bounds { x: number; y: number; width: number; height: number }
export interface BoardObject extends Bounds { id: string; assetId: string; type: AssetKind; version: number; createdAt: string; updatedAt: string; sourceTaskId?: string; sourceRunId?: string }
export interface AnnotationInput { id: string; scope: 'object' | 'group' | 'region'; objectId?: string; objectIds: string[]; assetId?: string; bounds: Bounds; coordinateSpace: 'normalized' | 'world'; text: string; timeStart?: number; timeEnd?: number; snapshotAssetId?: string }
export interface Annotation extends AnnotationInput { source: 'user_annotation'; createdAt: string; sourceTaskId: string; sessionId: string }
export interface SessionView { x: number; y: number; zoom: number; selectedObjectIds: string[] }
export interface Session { id: string; name: string; createdAt: string; view: SessionView; consumerId: string | null }
export interface HostBinding { host: string; threadId: string; sessionId: string }
export interface ServiceIdentity { pid: number; instanceId: string }
export interface ServiceRuntime extends ServiceIdentity { project: Project; url: string }
export interface Draft { editingTaskId?: string; id: string; sessionId: string; revision: number; text: string; attachments: string[]; annotations: AnnotationInput[]; references: { objectIds: string[]; taskIds: string[] }; updatedAt: string }
export interface TaskSnapshot { userRequest: { source: 'user_instruction'; text: string }; requestReferences?: { attachmentIds: string[]; objectIds: string[] }; annotations: AnnotationInput[]; referenceContent: { source: 'reference_content'; assets: Asset[]; objects: BoardObject[]; taskIds: string[] } }
export interface Progress { message: string; externalJobId?: string; assetIds?: string[]; createdAt: string }
export interface Receipt { summary: string; assetIds: string[]; objectIds: string[]; validation: string[]; createdAt: string }
export interface TaskReply { text: string; source: 'user_instruction'; createdAt: string }
export interface Run { id: string; taskId: string; consumerId: string; status: 'running' | 'blocked' | 'interrupted' | 'completed'; createdAt: string; updatedAt: string; progress: Progress[]; outputAssetIds: string[]; recoveryResolution?: string }
export interface LateResult { runId: string; consumerId: string; receivedAt: string; payload: unknown }
export interface Task { lastEditDraftId?: string; id: string; sessionId: string; draftId: string; sequence: number; status: TaskStatus; snapshot: TaskSnapshot; createdAt: string; updatedAt: string; currentRunId: string | null; reason: string | null; receipt: Receipt | null; replies: TaskReply[]; runs: Run[]; lateResults: LateResult[] }
export type BoardOperation =
  | { type: 'create'; object: { id?: string; assetId: string; x: number; y: number; width: number; height: number } }
  | { type: 'update'; objectId: string; expectedVersion: number; changes: Partial<Bounds> }
  | { type: 'delete'; objectId: string; expectedVersion: number };
export interface BoardState { project: Project; sessions: Session[]; session: Session; draft: Draft; assets: Asset[]; objects: BoardObject[]; annotations: Annotation[]; tasks: Task[] }
export interface Bootstrap { project: Project; token: string; service: ServiceIdentity; capabilities: { maxUploadBytes: number; backup: boolean; recovery: boolean; mediaPreview: 'browser'; generation: 'host_tools' } }
export interface Claim { task: Task | null; run: Run | null; consumerId: string; projectId: string; sessionId: string }
export interface RunIdentity { consumerId: string; runId: string }
export interface CompleteInput extends RunIdentity { summary: string; assetIds: string[]; validation: string[]; operations: BoardOperation[] }
export interface ApiError { error: { code: string; message: string; details?: unknown } }
