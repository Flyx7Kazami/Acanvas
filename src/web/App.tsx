import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from 'react';
import { AlignCenterHorizontal, AlignCenterVertical, AlignEndHorizontal, AlignEndVertical, AlignStartHorizontal, AlignStartVertical, ArrowDownToLine, ArrowLeft, ArrowUp, Check, ChevronDown, Circle, Copy, Ellipsis, Hand, History, LoaderCircle, Maximize, Minus, Moon, MousePointer2, Pause, Pencil, Play, Plus, Sun, Trash2, Upload, X } from 'lucide-react';
import type { AnnotationInput, Asset, BoardObject, BoardOperation, Draft, SessionView, Task, TaskStatus } from '../shared/types';
import { alignedPositions, fitView, intersects, mediaContentRect, normalizedRegion, objectRegion, rectangle, screenToWorld, resizeBounds, resizeViewportBounds, snapViewportResize, snapResize, snapTranslation, unionBounds, zoomAt, type Alignment, type Point, type Rect, type SnapGuide, type ResizeCorner, type ResizeHandle } from './geometry';
import { useBoard } from './useBoard';
import { useAnimatedView } from './useAnimatedView';
import { filesFromTransfer } from './import';
import { useComposerLayout, useContextualControls, useNotificationLayout } from './useCanvasLayout';
import { AnnotationBubble } from './AnnotationBubble';
import type { BoardApi } from './api';
import { canvasWheelView, routesWheelToCanvas, type CanvasWheelInput } from './canvas-wheel';
import { AssetThumb, ContentRenderer } from './ContentRenderer';
import { contentCapabilities, resolveContentKind, resolveContentMime } from '../shared/content-types';
import { CanvasAnnotationNote } from './CanvasAnnotationNote';
import { NotificationStack, useNotices, type Notification } from './NotificationStack';

const statusLabels: Record<TaskStatus, string> = { queued: 'Queued', editing: 'Editing', running: 'Running', blocked: 'Needs input', interrupted: 'Interrupted', completed: 'Completed', cancelled: 'Cancelled' };
const timeLabel = (value: number) => `${Math.floor(value / 60)}:${String(Math.floor(value % 60)).padStart(2, '0')}`;
const unique = (values: string[]) => [...new Set(values)];

function IconButton({ label, children, className = '', ...props }: { label: string; children: ReactNode; className?: string } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button type="button" className={`icon-button ${className}`} title={label} aria-label={label} {...props}>{children}</button>;
}

async function fileDimensions(file: File): Promise<{ width: number; height: number } | undefined> {
  const mime = resolveContentMime(file.name, file.type);
  if (!mime.startsWith('image/') && !mime.startsWith('video/')) return;
  const url = URL.createObjectURL(file);
  return new Promise(resolve => {
    const media = mime.startsWith('image/') ? new Image() : document.createElement('video');
    let done = false;
    const finish = (size?: { width: number; height: number }) => { if (done) return; done = true; clearTimeout(timer); media.removeAttribute('src'); if (media instanceof HTMLVideoElement) media.load(); URL.revokeObjectURL(url); resolve(size); };
    const timer = window.setTimeout(() => finish(), 4000);
    media.onerror = () => finish();
    if (media instanceof HTMLImageElement) media.onload = () => finish({ width: media.naturalWidth, height: media.naturalHeight });
    else { media.preload = 'metadata'; media.onloadedmetadata = () => finish({ width: media.videoWidth, height: media.videoHeight }); }
    media.src = url;
  });
}

type UploadEntry = { id: string; name: string; controller: AbortController };
type CommentEdit = { value: AnnotationInput; sessionId: string; draftId: string; index: number; selectionKey?: string; end: string; snapshot?: Promise<Blob | undefined>; preparing?: Promise<void>; frameNote?: string; finished?: boolean };
type AnnotationReader = { annotationId: string; sessionId: string; draftId?: string; taskId?: string };
type Gesture = { kind: 'move' | 'resize' | 'pan' | 'select' | 'mark'; start: Point; point: Point; moved: boolean; preview?: Record<string, Rect>; view: SessionView; objects: BoardObject[]; sessionId: string; resizeCorner?: ResizeHandle; commentKey?: string; markBounds?: Rect; region?: Rect };


function taskReferences(task: Task) {
  const { assets, objects } = task.snapshot.referenceContent;
  const groups = task.snapshot.annotations.map(annotation => {
    const items = objects.filter(object => object.id === annotation.objectId || annotation.objectIds.includes(object.id)).map(object => ({ key: object.id, asset: assets.find(asset => asset.id === object.assetId), frame: false })).filter((item, index, all) => all.findIndex(value => value.asset?.id === item.asset?.id) === index);
    for (const id of [annotation.assetId, annotation.snapshotAssetId]) if (id && !items.some(item => item.asset?.id === id)) items.push({ key: id, asset: assets.find(asset => asset.id === id), frame: id === annotation.snapshotAssetId });
    return { annotation, items, primary: items.find(item => item.asset?.id === annotation.snapshotAssetId) || items.find(item => item.asset?.id === annotation.assetId) || items[0] };
  });
  const included = new Set(groups.flatMap(group => group.items.map(item => item.asset?.id)));
  const attachments = assets.filter((asset, index) => !included.has(asset.id) && assets.findIndex(value => value.id === asset.id) === index);
  return { groups, attachments, count: groups.length + attachments.length };
}

type QueueLayout = { height: number; items: Map<string, { x: number; y: number }> };
const queueLayouts = new WeakMap<HTMLElement, QueueLayout>();
function rememberQueueLayout() {
  document.querySelectorAll<HTMLElement>('.queue-item').forEach(element => {
    const bounds = element.getBoundingClientRect(), items = new Map<string, { x: number; y: number }>();
    element.querySelectorAll<HTMLElement>('[data-queue-layout]').forEach(item => { if (item.offsetWidth) { const box = item.getBoundingClientRect(); items.set(item.dataset.queueLayout!, { x: box.x - bounds.x, y: box.y - bounds.y }); } });
    queueLayouts.set(element, { height: bounds.height, items });
  });
}

function QueueItem({ task, detailOpen, animateSend, visible, played, children }: { task: Task; detailOpen: boolean; animateSend: boolean; visible: boolean; played: Set<string>; children: ReactNode }) {
  const [entering, setEntering] = useState(false);
  const element = useRef<HTMLElement>(null);
  const animations = useRef<Animation[]>([]);
  const count = taskReferences(task).count;
  const previewSpace = (limit: number, size: number, gap: number, titleGap: number) => count ? Math.min(count, limit) * size + Math.max(0, Math.min(count, limit) - 1) * gap + (count > limit ? 15 + gap : 0) + titleGap : 0;
  useLayoutEffect(() => {
    const node = element.current, before = node && queueLayouts.get(node);
    animations.current.forEach(animation => animation.cancel()); animations.current = [];
    if (!node || !before) return;
    queueLayouts.delete(node);
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const bounds = node.getBoundingClientRect(), options = { duration: 340, easing: 'cubic-bezier(.22,.85,.25,1.08)' };
    const targets = Array.from(node.querySelectorAll<HTMLElement>('[data-queue-layout]')).filter(item => item.offsetWidth).map(item => {
      const box = item.getBoundingClientRect(), previous = before.items.get(item.dataset.queueLayout!);
      const x = previous ? previous.x - (box.x - bounds.x) : 0, y = previous ? previous.y - (box.y - bounds.y) : -12;
      return { item, previous, x, y };
    });
    if (Math.abs(before.height - bounds.height) > .5) animations.current.push(node.animate([{ height: `${before.height}px` }, { height: `${bounds.height}px` }], options));
    targets.forEach(({ item, previous, x, y }) => {
      animations.current.push(item.animate([{ transform: `translate(${x}px,${y}px)`, opacity: previous ? 1 : 0 }, { transform: 'translate(0,0)', opacity: 1 }], options));
    });
  }, [detailOpen]);
  useEffect(() => { const reduced = matchMedia('(prefers-reduced-motion: reduce)'); const stop = () => { if (reduced.matches) animations.current.forEach(animation => animation.cancel()); }; reduced.addEventListener('change', stop); return () => { reduced.removeEventListener('change', stop); animations.current.forEach(animation => animation.cancel()); }; }, []);
  useLayoutEffect(() => {
    if (!visible) { setEntering(false); return; }
    if (!animateSend || played.has(task.id)) return;
    played.add(task.id);
    if (!matchMedia('(prefers-reduced-motion: reduce)').matches) setEntering(true);
  }, [animateSend, visible, task.id, played]);
  useEffect(() => {
    if (!entering) return;
    const reduced = matchMedia('(prefers-reduced-motion: reduce)');
    const stop = () => setEntering(false);
    const motionChange = () => { if (reduced.matches) stop(); };
    const cancelled = (event: AnimationEvent) => { if (event.target === element.current) stop(); };
    const node = element.current; node?.addEventListener('animationcancel', cancelled);
    reduced.addEventListener('change', motionChange);
    motionChange();
    return () => { node?.removeEventListener('animationcancel', cancelled); reduced.removeEventListener('change', motionChange); };
  }, [entering]);
  return <article ref={element} className={`queue-item${entering ? ' queue-entering' : ''}`} style={{ '--queue-preview-space': `${previewSpace(3, 24, 3, 8)}px`, '--queue-preview-space-narrow': `${previewSpace(3, 22, 2, 5)}px`, '--queue-preview-space-small': `${previewSpace(1, 22, 2, 3)}px` } as React.CSSProperties} role="listitem" data-task-id={task.id} data-status={task.status} data-detail-open={detailOpen} onAnimationEnd={event => { if (event.target === event.currentTarget) setEntering(false); }}>{children}</article>;
}

function MotionDisclosure({ open, children, ...props }: { open: boolean; children: ReactNode } & React.HTMLAttributes<HTMLDivElement>) {
  const [moving, setMoving] = useState(false);
  useLayoutEffect(() => {
    const reduced = matchMedia('(prefers-reduced-motion: reduce)');
    let timer = 0;
    const sync = () => { window.clearTimeout(timer); setMoving(!reduced.matches); if (!reduced.matches) timer = window.setTimeout(() => setMoving(false), 340); };
    sync(); reduced.addEventListener('change', sync);
    return () => { window.clearTimeout(timer); reduced.removeEventListener('change', sync); };
  }, [open]);
  return <div {...props} className={`${open || moving ? 'motion-disclosure ' : ''}${props.className || ''}`} data-motion={open ? 'open' : 'closing'} inert={!open} aria-hidden={!open}>{children}</div>;
}

function videoPlayback(video?: HTMLVideoElement) {
  return { currentTime: video && Number.isFinite(video.currentTime) ? video.currentTime : 0, duration: video && Number.isFinite(video.duration) ? video.duration : 0, paused: !video || video.paused || video.ended, ready: !!video && video.readyState >= 1 };
}

function VideoPlaybackControls({ objectId, videos, disabled, onError, controlRef }: { objectId: string; videos: Map<string, HTMLVideoElement>; disabled: boolean; onError: (cause: unknown) => void; controlRef: RefObject<HTMLDivElement | null> }) {
  const [playback, setPlayback] = useState(() => videoPlayback(videos.get(objectId)));
  useEffect(() => {
    const video = videos.get(objectId);
    if (!video) return;
    const sync = () => setPlayback(videoPlayback(video));
    const events = ['loadedmetadata', 'durationchange', 'timeupdate', 'play', 'pause', 'ended', 'emptied', 'seeked'];
    sync();
    events.forEach(name => video.addEventListener(name, sync));
    return () => events.forEach(name => video.removeEventListener(name, sync));
  }, [objectId, videos]);

  async function togglePlayback() {
    const video = videos.get(objectId);
    if (!video) return;
    try { if (video.paused || video.ended) await video.play(); else video.pause(); }
    catch (cause) { onError(cause); }
    finally { setPlayback(videoPlayback(video)); }
  }

  function seek(value: number) {
    const video = videos.get(objectId);
    if (!video || !playback.duration) return;
    video.currentTime = Math.min(playback.duration, Math.max(0, value));
    setPlayback(videoPlayback(video));
  }

  return <div ref={controlRef} className="video-playback context-control" data-canvas-control role="group" aria-label="Video playback" onPointerDown={event => event.stopPropagation()}>
    <IconButton label={playback.paused ? 'Play video' : 'Pause video'} disabled={disabled || !playback.ready} onClick={() => void togglePlayback()}>{playback.paused ? <Play size={16}/> : <Pause size={16}/>}</IconButton>
    <input type="range" aria-label="Video timeline" aria-valuetext={`${timeLabel(playback.currentTime)} of ${timeLabel(playback.duration)}`} min={0} max={playback.duration} step={0.1} value={Math.min(playback.currentTime, playback.duration)} style={{ '--video-progress': `${playback.duration ? Math.min(100, playback.currentTime / playback.duration * 100) : 0}%` } as React.CSSProperties} disabled={disabled || !playback.duration} onChange={event => seek(Number(event.target.value))}/>
    <span className="video-time" aria-hidden="true">{timeLabel(playback.currentTime)} / {timeLabel(playback.duration)}</span>
  </div>;
}

function TaskCard({ task, assets, objects, content, api, onReloadBoard, locateAsset, onAnnotationView, compact = false, summary = false }: { task: Task; assets: Asset[]; objects: BoardObject[]; content: (id: string) => string; api: BoardApi; onReloadBoard: () => Promise<void>; locateAsset: (id: string) => void; onAnnotationView: (task: Task, open: boolean, annotation?: AnnotationInput) => void; compact?: boolean; summary?: boolean }) {
  const sourceAssets = task.snapshot.referenceContent.assets;
  const references = taskReferences(task);
  const [previewLimit, setPreviewLimit] = useState(() => matchMedia('(max-width: 360px)').matches ? 1 : 3);
  useEffect(() => { const narrow = matchMedia('(max-width: 360px)'); const update = () => setPreviewLimit(narrow.matches ? 1 : 3); narrow.addEventListener('change', update); return () => narrow.removeEventListener('change', update); }, []);
  const [previewId, setPreviewId] = useState('');
  useEffect(() => { if (summary) setPreviewId(''); }, [summary]);
  const previewAsset = [...assets, ...sourceAssets].find(asset => asset.id === previewId);
  const assetAction = (asset: Asset, thumbnail: boolean) => resolveContentKind(asset) === 'file' ? <a href={content(asset.id)} download={asset.name} title={asset.name} aria-label={`Download ${asset.name}`} key={asset.id}>{thumbnail ? <AssetThumb asset={asset} src={content(asset.id)}/> : <><ArrowDownToLine size={12}/>{asset.name}</>}</a> : <button type="button" title={asset.name} aria-label={`View ${asset.name}`} key={asset.id} onClick={() => { if (objects.some(object => object.assetId === asset.id)) locateAsset(asset.id); else setPreviewId(current => current === asset.id ? '' : asset.id); }}>{thumbnail ? <AssetThumb asset={asset} src={content(asset.id)}/> : asset.name}</button>;
  return <article className="task-card" data-task-id={task.id} data-status={task.status}>
    {!compact && <div className="task-heading"><span className="task-sequence">Request {String(task.sequence).padStart(2, '0')}</span><span className={`status-badge status-${task.status}`}>{task.status === 'completed' && <Check size={11}/>} {statusLabels[task.status]}</span></div>}
    {!compact && <p className="task-instruction">{task.snapshot.userRequest.text || 'Create from the attachments and annotations.'}</p>}
    <div className="task-detail-content"><div className={`task-reference-groups${compact ? ' queue-previews' : ''}`} aria-label={compact ? `${references.count} references` : undefined}>
      {references.groups.map(({ annotation, items, primary }, index) => {
        const summaryIndex = references.attachments.length + index, shown = summary && summaryIndex < previewLimit;
        return <div className={`task-reference-group${shown ? ' summary-group' : ''}`} key={annotation.id} data-annotation-id={annotation.id}>
          <button type="button" className="task-annotation-badge" data-queue-layout={`badge-${annotation.id}`} aria-label={`View annotation ${index + 1}: ${annotation.text}`} onClick={() => onAnnotationView(task, true, annotation)}><AnnotationBubble number={index + 1} size={18}/></button>
          <div className="task-reference-row">{(items.length ? items : [{ key: 'region', asset: undefined, frame: false }]).map(item => {
            const preview = shown && (!primary || item.key === primary.key);
            return <div className={`task-reference-source${preview ? ' queue-preview' : ''}`} key={item.key} data-reference-item={item.key} data-queue-layout={`source-${annotation.id}-${item.key}`}>{item.asset ? item.frame ? <button type="button" title={item.asset.name} aria-label={`View ${item.asset.name}`} onClick={() => setPreviewId(current => current === item.asset!.id ? '' : item.asset!.id)}><span className="asset-thumb" data-kind="image"><img className="task-annotation-frame" src={content(item.asset.id)} alt="Annotated video frame"/></span></button> : assetAction(item.asset, true) : <span className="asset-thumb" aria-label="Canvas region"><Maximize size={14}/></span>}</div>;
          })}</div>
          <div className="task-item-annotation"><button type="button" className="task-annotation-text" onClick={() => onAnnotationView(task, true, annotation)}><span>{annotation.text}{annotation.timeStart !== undefined && <small> · {timeLabel(annotation.timeStart)}{annotation.timeEnd !== undefined && ` – ${timeLabel(annotation.timeEnd)}`}</small>}</span></button></div>
        </div>;
      })}
      {!!references.attachments.length && <div className="task-reference-group" data-unannotated-attachments><div className="task-reference-row">{references.attachments.map((asset, index) => <div className={`task-reference-source${summary && index < previewLimit ? ' queue-preview' : ''}`} key={asset.id} data-reference-item={asset.id} data-queue-layout={`attachment-${asset.id}`}>{assetAction(asset, true)}</div>)}</div></div>}
      {compact && summary && references.count > previewLimit && <span className="queue-preview-overflow" aria-label={`${references.count - previewLimit} more references; ${references.count} references total`}>+{references.count - previewLimit}</span>}
    </div>
    {previewAsset && <div className="task-media-preview" data-content-kind={resolveContentKind(previewAsset)} role="region" aria-label={`Preview ${previewAsset.name}`}><IconButton label="Close media preview" onClick={() => setPreviewId('')}><ChevronDown size={14}/></IconButton><ContentRenderer asset={previewAsset} src={content(previewAsset.id)} api={api} surface="detail" onReloadBoard={onReloadBoard}/></div>}
    {task.reason && <p className="task-reason">{task.reason}</p>}
    {task.runs.at(-1)?.progress.at(-1) && <p className="task-progress">{task.runs.at(-1)?.progress.at(-1)?.message}</p>}
    {task.receipt && <div className="task-receipt"><div className="receipt-label"><Check size={13}/>Receipt</div><p>{task.receipt.summary}</p>{!!task.receipt.assetIds.length && <div className="receipt-assets">{task.receipt.assetIds.map(id => { const asset = assets.find(asset => asset.id === id); return asset ? assetAction(asset, false) : <a key={id} href={content(id)} download>Download output</a>; })}</div>}{!!task.receipt.validation.length && <details><summary>Validation<ChevronDown size={12}/></summary><ul>{task.receipt.validation.map((line, index) => <li key={index}>{line}</li>)}</ul></details>}</div>}
    <time dateTime={task.createdAt}>{new Date(task.createdAt).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}</time></div>
  </article>;
}

export default function App() {
  const board = useBoard();
  const { state, draft, view } = board;
  const [theme, setTheme] = useState<'light' | 'dark'>(() => localStorage.getItem('acanvas-theme') === 'dark' ? 'dark' : 'light');
  const [mode, setMode] = useState<'select' | 'pan'>('select');
  const [snapGuides, setSnapGuides] = useState<SnapGuide[]>([]);
  const [layoutSaving, setLayoutSaving] = useState(false);
  const layoutBusy = useRef(false);
  const updateDrag = useRef<(active: Gesture, point: Point, bypass: boolean) => void>(() => {});
  const [composerFocused, setComposerFocused] = useState(false);
  const [composerMenuOpen, setComposerMenuOpen] = useState(false);
  const composerMore = useRef<HTMLButtonElement>(null), composerMenu = useRef<HTMLDivElement>(null), composerMenuIndex = useRef(0);
  const [editingTask, setEditingTask] = useState(false);
  const queueCloseTimer = useRef(0);
  const [queueHovered, setQueueHovered] = useState(false);
  const [queueFocused, setQueueFocused] = useState(false);
  const [queueExpanded, setQueueExpanded] = useState(false);
  const [sentTaskId, setSentTaskId] = useState('');
  const playedSendIds = useRef(new Set<string>());
  const [taskDetailId, updateTaskDetailId] = useState('');
  function setTaskDetailId(value: React.SetStateAction<string>) { rememberQueueLayout(); updateTaskDetailId(value); }
  const [inspectedTaskId, setInspectedTaskId] = useState('');
  const [annotatingKey, setAnnotatingKey] = useState('');
  const [aligningKey, setAligningKey] = useState('');
  const [markPreview, setMarkPreview] = useState<Rect | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [cancellingTask, setCancellingTask] = useState('');
  const comments = useRef(new Map<string, CommentEdit>());
  const [, setCommentRevision] = useState(0);
  const [annotationSaving, setAnnotationSaving] = useState(false);
  const [removingObjects, setRemovingObjects] = useState(false);
  const [annotationReader, setAnnotationReader] = useState<AnnotationReader | null>(null);
  const readerTrigger = useRef<HTMLElement | null>(null);
  const readerFocusFrame = useRef(0);
  const annotationInput = useRef<HTMLTextAreaElement>(null);
  const [uploads, setUploads] = useState<UploadEntry[]>([]);
  const [preview, setPreview] = useState<Record<string, Rect>>({});
  const [selectionRect, setSelectionRect] = useState<Rect | null>(null);
  const [mediaSizes, setMediaSizes] = useState<Record<string, { width: number; height: number }>>({});
  const [mediaErrors, setMediaErrors] = useState<Record<string, boolean>>({});
  const [dragOver, setDragOver] = useState(false);
  const persistentError = !state || board.projectChanged || board.saveState === 'failed';
  const { notices, notify: setNotice } = useNotices({ text: persistentError ? '' : board.error, revision: board.errorRevision });
  const [copyCommand, setCopyCommand] = useState('');
  const [spacePan, setSpacePan] = useState(false);
  const [resolvingConflict, setResolvingConflict] = useState(false);
  const canvas = useRef<HTMLDivElement>(null);
  const dock = useRef<HTMLElement>(null);
  const notifications = useRef<HTMLElement>(null);
  const instruction = useRef<HTMLTextAreaElement>(null);
  const selectionActions = useRef<HTMLDivElement>(null);
  const playbackControls = useRef<HTMLDivElement>(null);
  const composing = useRef(false);
  const commentComposing = useRef(false);
  const committing = useRef(false);
  const scope = useRef({ sessionId: '', draftId: '', objectIds: new Set<string>() });
  scope.current = { sessionId: state?.session.id || '', draftId: draft?.id || '', objectIds: new Set(state?.objects.map(object => object.id)) };
  const wheelState = useRef({ view, sessionId: state?.session.id || '', disabled: false });
  wheelState.current = { view, sessionId: state?.session.id || '', disabled: board.projectChanged || board.switching || board.sending };
  const gesture = useRef<Gesture | null>(null);
  const videoRefs = useRef(new Map<string, HTMLVideoElement>());
  const audioRefs = useRef(new Map<string, HTMLAudioElement>());
  const boardInput = useRef<HTMLInputElement>(null);
  const objects = (state?.objects || []).map(object => preview[object.id] ? { ...object, ...preview[object.id] } : object);
  const selectedIds = view.selectedObjectIds.filter(id => objects.some(object => object.id === id));
  const selected = objects.filter(object => selectedIds.includes(object.id));
  const selectedVideo = selected.length === 1 && selected[0].type === 'video' && !mediaErrors[selected[0].id] ? selected[0] : undefined;
  const assets = state?.assets || [];
  const assetFor = (id: string) => assets.find(asset => asset.id === id);
  const capabilityFor = (object: BoardObject) => contentCapabilities[resolveContentKind(assetFor(object.assetId))];
  const disabled = board.projectChanged || board.switching || board.sending || editingTask || annotationSaving || removingObjects || layoutSaving;
  const fitMotion = useAnimatedView(view, state?.session.id || '', disabled, board.updateView);
  const queuedTasks = state?.tasks.filter(task => ['queued', 'editing', 'running', 'blocked', 'interrupted'].includes(task.status)) || [];
  const pending = queuedTasks.length;
  const queueOpen = queueExpanded || queueHovered || queueFocused || !!taskDetailId || historyOpen;
  const commentKey = `${state?.session.id}:${draft?.id}:${[...selectedIds].sort().join(',')}`;
  const comment = [...comments.current.values()].find(edit => edit.selectionKey === commentKey && !edit.finished);
  const annotating = annotatingKey === commentKey && selected.length > 0;
  const aligning = aligningKey === commentKey && selected.length > 1;
  const inspectedTask = state?.tasks.find(task => task.id === inspectedTaskId);
  const inspectableTask = inspectedTask && (historyOpen || queuedTasks.some(task => task.id === inspectedTaskId)) ? inspectedTask : undefined;
  const viewingEditedTask = !!draft?.editingTaskId && inspectableTask?.id === draft.editingTaskId;
  const editingSourceTask = state?.tasks.find(task => task.id === draft?.editingTaskId);
  const annotationEdit = annotationReader?.draftId ? [...comments.current.values()].find(edit => edit.value.id === annotationReader.annotationId && edit.sessionId === annotationReader.sessionId && edit.draftId === annotationReader.draftId) : undefined;
  const annotationRead = annotationReader && annotationReader.sessionId === state?.session.id ? annotationReader.draftId ? draft?.id === annotationReader.draftId ? draft.annotations.find(annotation => annotation.id === annotationReader.annotationId) || (annotationEdit && !annotationEdit.finished ? annotationEdit.value : undefined) : undefined : state?.tasks.find(task => task.id === annotationReader.taskId)?.snapshot.annotations.find(annotation => annotation.id === annotationReader.annotationId) : undefined;
  const readerEditable = !!annotationRead && annotationReader?.draftId === draft?.id;
  const readingEditDraft = !!annotationReader?.taskId && annotationReader.sessionId === state?.session.id && annotationReader.taskId === draft?.editingTaskId;
  const projectedAnnotations = (inspectableTask?.snapshot.annotations || []).map(annotation => ({ ...annotation, inspectionTaskId: inspectableTask!.id }));
  const allAnnotations: (AnnotationInput & { inspectionTaskId?: string })[] = inspectableTask && !viewingEditedTask ? projectedAnnotations : [...(draft?.annotations || []), ...(annotationEdit && annotationRead && !draft?.annotations.some(annotation => annotation.id === annotationRead.id) ? [annotationRead] : [])];
  const unavailableComments = (draft?.annotations || []).filter(annotation => annotation.objectIds.some(id => !objects.some(object => object.id === id)) && !editingSourceTask?.snapshot.annotations.some(value => value.id === annotation.id));
  const hasRequest = !!(draft?.text.trim() || draft?.attachments.length || draft?.annotations.length);
  const composerCompact = !composerFocused && !hasRequest && !pending && !draft?.editingTaskId && !draft?.references.objectIds.length && !draft?.references.taskIds.length && !board.draftConflict && !uploads.length && !board.sending;
  function annotationSources(annotation: AnnotationInput): BoardObject[] {
    const source = inspectableTask && !viewingEditedTask ? inspectableTask : editingSourceTask;
    return annotation.objectIds.flatMap(id => {
      const original = source?.snapshot.referenceContent.objects.find(object => object.id === id);
      const current = objects.find(object => object.id === id && (!original || original.assetId === object.assetId));
      return current || original ? [current || original!] : [];
    });
  }
  function annotationBounds(annotation: AnnotationInput): Rect | undefined {
    if (annotation.scope === 'group') { const sources = annotationSources(annotation); return sources.length ? unionBounds(sources) : annotation.bounds; }
    if (annotation.coordinateSpace === 'world') return annotation.bounds;
    const object = annotationSources(annotation).find(object => object.id === annotation.objectId && (!annotation.assetId || object.assetId === annotation.assetId));
    const live = object && objects.find(current => current.id === object.id && current.assetId === object.assetId);
    return object ? objectRegion(annotation.bounds, live ? contentBounds(live) : object) : undefined;
  }
  function annotationDisplayBounds(annotation: AnnotationInput): Rect {
    const sources = annotationSources(annotation);
    if (annotation.scope === 'group') return sources.length ? unionBounds(sources) : annotation.bounds;
    return sources.length ? unionBounds(sources.map(source => { const live = objects.find(object => object.id === source.id && object.assetId === source.assetId); return live ? contentBounds(live) : source; })) : annotation.bounds;
  }
  const editingAnnotation = comment && draft?.annotations.find(annotation => annotation.id === comment.value.id) || comment?.value;
  const editingObject = editingAnnotation?.objectId ? objects.find(object => object.id === editingAnnotation.objectId) : undefined;
  const editingBounds = !inspectableTask && annotating && editingAnnotation ? markPreview || (editingAnnotation.scope === 'group' ? undefined : editingAnnotation.coordinateSpace === 'normalized' && editingObject ? objectRegion(editingAnnotation.bounds, mediaContentRect(editingObject, mediaSizes[editingObject.id])) : editingAnnotation.bounds) : undefined;

  useComposerLayout(instruction, dock, draft, !!state);
  useNotificationLayout(dock, notifications, !!state);
  useContextualControls(canvas, selectionActions, playbackControls, selected, selectedVideo ? mediaContentRect(selectedVideo, mediaSizes[selectedVideo.id]) : undefined, view);

  useEffect(() => { document.documentElement.dataset.theme = theme; localStorage.setItem('acanvas-theme', theme); document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#111111' : '#f5f5f3'); }, [theme]);
  useEffect(() => { setPreview({}); setSelectionRect(null); gesture.current = null; }, [state?.session.id]);
  useEffect(() => { setSnapGuides([]); gesture.current = null; setPreview({}); }, [state?.session.id, mode, spacePan]);
  useEffect(() => { const active = gesture.current; if (!active || active.objects.map(object => object.id).sort().join(',') !== [...selectedIds].sort().join(',')) { setSnapGuides([]); if (active?.kind === 'move') { gesture.current = null; setPreview({}); } } }, [selectedIds.join(',')]);
  useEffect(() => { setAnnotatingKey(''); setAligningKey(''); setMarkPreview(null); if (gesture.current?.kind === 'mark') gesture.current = null; }, [commentKey]);
  useLayoutEffect(() => { if (aligning) selectionActions.current?.querySelector<HTMLButtonElement>('.alignment-actions button')?.focus({ preventScroll: true }); }, [aligning]);
  useEffect(() => { setInspectedTaskId(''); setAnnotationReader(null); }, [state?.session.id]);
  useEffect(() => { if (inspectedTaskId && !inspectableTask) { setInspectedTaskId(''); setAnnotationReader(null); } }, [inspectedTaskId, !!inspectableTask]);
  useEffect(() => { if (annotationReader?.draftId && !annotationRead) setAnnotationReader(null); }, [annotationReader?.draftId, !!annotationRead]);
  useEffect(() => { const modifier = (event: KeyboardEvent) => { if (event.key !== 'Alt') return; const active = gesture.current; if ((active?.kind === 'move' || active?.kind === 'resize') && active.moved) updateDrag.current(active, active.point, event.type === 'keydown'); }; window.addEventListener('keydown', modifier); window.addEventListener('keyup', modifier); return () => { window.removeEventListener('keydown', modifier); window.removeEventListener('keyup', modifier); }; }, []);
  useEffect(() => { if (!pending) setQueueExpanded(false); }, [pending]);
  useEffect(() => { setSentTaskId(''); }, [state?.session.id]);
  useLayoutEffect(() => { if (composerMenuOpen) composerMenu.current?.querySelectorAll<HTMLButtonElement>('[role=menuitem]')[composerMenuIndex.current]?.focus(); }, [composerMenuOpen]);
  useEffect(() => {
    if (!composerMenuOpen) return;
    const outside = (event: globalThis.PointerEvent) => { if (!composerMenu.current?.contains(event.target as Node) && !composerMore.current?.contains(event.target as Node)) setComposerMenuOpen(false); };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [composerMenuOpen]);
  useEffect(() => { setComposerMenuOpen(false); }, [state?.session.id]);
  useEffect(() => {
    const close = (event: globalThis.PointerEvent) => { if (!dock.current?.contains(event.target as Node)) { setQueueExpanded(false); setQueueHovered(false); setQueueFocused(false); setTaskDetailId(''); } };
    document.addEventListener('pointerdown', close);
    return () => { document.removeEventListener('pointerdown', close); window.clearTimeout(queueCloseTimer.current); };
  }, []);
  const canvasWheel = useCallback((event: CanvasWheelInput) => {
    const element = canvas.current, current = wheelState.current;
    if (!element || current.disabled || gesture.current) return;
    fitMotion.interrupt();
    board.updateView(canvasWheelView(current.view, event, element.getBoundingClientRect()), current.sessionId);
  }, [board.updateView, fitMotion.interrupt]);
  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    const wheel = (event: WheelEvent) => {
      if (!routesWheelToCanvas(element, event)) return;
      event.preventDefault(); event.stopPropagation(); canvasWheel(event);
    };
    element.addEventListener('wheel', wheel, { capture: true, passive: false });
    return () => element.removeEventListener('wheel', wheel, true);
  }, [!!state, canvasWheel]);
  useEffect(() => {
    const singlePlayback = (event: Event) => { const active = event.target; if (!(active instanceof HTMLMediaElement)) return; document.querySelectorAll<HTMLMediaElement>('audio,video').forEach(element => { if (element !== active && !element.paused) element.pause(); }); };
    document.addEventListener('play', singlePlayback, true); return () => document.removeEventListener('play', singlePlayback, true);
  }, []);

  const viewUpdate = (next: Partial<SessionView>) => { if (!disabled && state) { fitMotion.interrupt(); board.updateView({ ...view, ...next }, state.session.id); } };
  const selectObjects = (ids: string[]) => { if ([...ids].sort().join(',') !== [...selectedIds].sort().join(',')) { clearInspection(); exitAnnotation(); } viewUpdate({ selectedObjectIds: unique(ids) }); };
  const localPoint = (event: { clientX: number; clientY: number }): Point => { const bounds = canvas.current!.getBoundingClientRect(); return { x: event.clientX - bounds.left, y: event.clientY - bounds.top }; };
  const contentBounds = (object: BoardObject) => mediaContentRect(object, mediaSizes[object.id]);

  async function importFiles(files: File[], dropPoint?: Point) {
    if (!files.length) return;
    if (!state || !draft || board.connection !== 'connected') { board.setError('The board is disconnected. Wait for it to reconnect, then import your files.'); return; }
    if (disabled) { board.setError(board.projectChanged ? 'This address now serves another project. Reopen the board to import files.' : 'Your request is being saved or sent. Import files once it finishes.'); return; }
    const sessionId = state.session.id;
    const importView = view;
    const size = canvas.current?.getBoundingClientRect();
    const position = screenToWorld(dropPoint ?? { x: (size?.width || 600) / 2, y: (size?.height || 600) / 2 }, importView);
    for (const [index, file] of files.entries()) {
      const id = crypto.randomUUID();
      const controller = new AbortController();
      setUploads(current => [...current, { id, name: file.name, controller }]);
      try {
        const dimensions = await fileDimensions(file);
        if (controller.signal.aborted) continue;
        const asset = await board.api.upload(file, file.name, controller.signal);
        let { width, height } = contentCapabilities[resolveContentKind(asset)].initial;
        if (dimensions?.width && dimensions.height) { const scale = Math.min(340 / dimensions.width, 280 / dimensions.height); width = dimensions.width * scale; height = dimensions.height * scale; }
        await board.operations([{ type: 'create', object: { assetId: asset.id, x: position.x - width / 2 + index * 30, y: position.y - height / 2 + index * 30, width, height } }], sessionId);
      } catch (cause) { if (!controller.signal.aborted) board.showError(cause); }
      finally { setUploads(current => current.filter(upload => upload.id !== id)); }
    }
  }

  const importFilesRef = useRef(importFiles);
  importFilesRef.current = importFiles;
  useEffect(() => {
    const paste = (event: ClipboardEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!event.clipboardData) return;
      const composerTarget = !!target?.closest('.composer');
      if (!composerTarget && target?.closest('input,textarea,[contenteditable="true"]')) return;
      const files = filesFromTransfer(event.clipboardData);
      if (files.length) { event.preventDefault(); void importFilesRef.current(files); }
      else if (Array.from(event.clipboardData.items).some(item => item.kind === 'file')) setNotice('Clipboard files are unavailable. Drop your files or use Import files.');
    };
    document.addEventListener('paste', paste);
    return () => document.removeEventListener('paste', paste);
  }, []);

  function beginComment(): CommentEdit | undefined {
    const existing = [...comments.current.values()].find(edit => edit.selectionKey === commentKey && !edit.finished);
    if (existing && !existing.finished) return existing;
    if (!state || !draft || disabled || !selected.length) return;
    const targets = selected, bounds = unionBounds(targets.length > 1 ? targets : targets.map(contentBounds));
    const single = targets.length === 1 ? targets[0] : undefined;
    const value: AnnotationInput = { id: crypto.randomUUID(), scope: single ? 'object' : 'group', objectId: single?.id, objectIds: targets.map(object => object.id), assetId: single?.assetId, bounds: single ? normalizedRegion(bounds, contentBounds(single)) : bounds, coordinateSpace: single ? 'normalized' : 'world', text: '' };
    if (value.bounds.width <= 0 || value.bounds.height <= 0) { setNotice('Select an area inside the image or video.'); return; }
    let snapshot: Promise<Blob | undefined> | undefined;
    let frameNote: string | undefined;
    if (single && resolveContentKind(assetFor(single.assetId)) === 'audio') audioRefs.current.get(single.id)?.pause();
    if (single?.type === 'video') {
      const video = videoRefs.current.get(single.id);
      value.timeStart = video?.currentTime || 0;
      video?.pause();
      if (video && video.readyState >= 2 && video.videoWidth) {
        try { const frame = document.createElement('canvas'); frame.width = video.videoWidth; frame.height = video.videoHeight; frame.getContext('2d')!.drawImage(video, 0, 0); snapshot = new Promise<Blob | undefined>(resolve => frame.toBlob(blob => resolve(blob || undefined), 'image/png')); }
        catch { /* The time point remains available for files without a browser frame. */ }
      }
      if (!snapshot) frameNote = 'The timestamp is saved. A frame preview is unavailable for this video.';
    }
    const edit: CommentEdit = { value, sessionId: state.session.id, draftId: draft.id, index: draft.annotations.length, selectionKey: commentKey, snapshot, frameNote, end: '' };
    comments.current.set(edit.value.id, edit); setCommentRevision(revision => revision + 1);
    return edit;
  }

  async function reloadBoard() { try { await board.flushDraft(); window.location.reload(); } catch (cause) { board.showError(cause); } }

  function clearInspection() { cancelAnimationFrame(readerFocusFrame.current); setInspectedTaskId(''); setAnnotationReader(null); }

  function closeAnnotation() {
    cancelAnimationFrame(readerFocusFrame.current);
    if (annotationEdit) annotationEdit.finished = true;
    const trigger = readerTrigger.current;
    setAnnotationReader(null); exitAnnotation();
    readerFocusFrame.current = requestAnimationFrame(() => { if (trigger?.isConnected && !trigger.closest('[inert]')) trigger.focus({ preventScroll: true }); else instruction.current?.focus({ preventScroll: true }); });
  }

  function focusAnnotation() {
    const input = annotationInput.current, boardBounds = canvas.current?.getBoundingClientRect(), rect = input?.getBoundingClientRect();
    if (input && boardBounds && rect && !input.closest('[inert]') && rect.right > boardBounds.left && rect.left < boardBounds.right && rect.bottom > boardBounds.top && rect.top < boardBounds.bottom) input.focus({ preventScroll: true });
  }

  function exitAnnotation() { setAnnotatingKey(''); setMarkPreview(null); if (gesture.current?.kind === 'mark') gesture.current = null; }

  function enterAnnotation() {

    const edit = beginComment();
    if (!edit) return;
    clearInspection(); setAligningKey(''); setMode('select'); setAnnotatingKey(commentKey); setMarkPreview(null);
    readerTrigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setAnnotationReader({ annotationId: edit.value.id, sessionId: edit.sessionId, draftId: edit.draftId });
    readerFocusFrame.current = requestAnimationFrame(focusAnnotation);
  }

  function exitAlignment() { setAligningKey(''); requestAnimationFrame(() => selectionActions.current?.querySelector<HTMLButtonElement>('[aria-label="Align"]')?.focus({ preventScroll: true })); }

  function enterAlignment() { clearInspection(); exitAnnotation(); setAligningKey(commentKey); }

  function toggleTaskDetail(task: Task) {
    const open = taskDetailId !== task.id;
    clearInspection(); exitAnnotation(); setTaskDetailId(open ? task.id : '');
    if (open) setInspectedTaskId(task.id);
  }

  function locateObjects(ids: string[]) {
    const targets = objects.filter(object => ids.includes(object.id));
    const size = canvas.current?.getBoundingClientRect();
    if (!targets.length || !size) return;
    const bounds = unionBounds(targets), dockTop = dock.current?.getBoundingClientRect().top || size.height;
    viewUpdate({ x: size.width / 2 - (bounds.x + bounds.width / 2) * view.zoom, y: (64 + dockTop) / 2 - (bounds.y + bounds.height / 2) * view.zoom, selectedObjectIds: targets.map(object => object.id) });
  }

  function locateAsset(id: string) { locateObjects(objects.filter(object => object.assetId === id).map(object => object.id)); }

  function openAnnotation(annotation: AnnotationInput, inDraft = false) {
    if (!state || !draft) return;
    cancelAnimationFrame(readerFocusFrame.current);
    readerTrigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (inDraft) {
      clearInspection();
      const existingEdit = [...comments.current.values()].find(edit => edit.sessionId === state.session.id && edit.draftId === draft.id && edit.value.id === annotation.id);
      if (existingEdit) existingEdit.finished = false;
      if (![...comments.current.values()].some(edit => edit.sessionId === state.session.id && edit.draftId === draft.id && edit.value.id === annotation.id)) comments.current.set(annotation.id, { value: { ...annotation, text: '' }, sessionId: state.session.id, draftId: draft.id, index: draft.annotations.findIndex(value => value.id === annotation.id), end: annotation.timeEnd === undefined ? '' : String(annotation.timeEnd) });
    }
    exitAnnotation(); setAligningKey('');
    setAnnotationReader({ annotationId: annotation.id, sessionId: state.session.id, ...(inDraft ? { draftId: draft.id } : { taskId: inspectableTask?.id }) });
    if (inDraft) readerFocusFrame.current = requestAnimationFrame(focusAnnotation);
  }

  const sameScope = (edit: { sessionId: string; draftId: string }) => scope.current.sessionId === edit.sessionId && scope.current.draftId === edit.draftId;

  function patchAnnotation(edit: CommentEdit, changes: Partial<AnnotationInput>) {
    edit.value = { ...edit.value, ...changes, text: '' };
    return board.changeDraftFor(edit.sessionId, edit.draftId, current => ({ ...current, annotations: current.annotations.map(annotation => annotation.id === edit.value.id ? { ...annotation, ...changes } : annotation) }));
  }

  function changeAnnotationText(text: string) {
    const owner = annotationReader, edit = annotationEdit;
    if (!owner?.draftId || !edit || !sameScope(edit)) return;
    board.changeDraftFor(owner.sessionId, owner.draftId, current => {
      const existingIndex = current.annotations.findIndex(annotation => annotation.id === owner.annotationId);
      const existing = current.annotations[existingIndex];
      const annotations = current.annotations.filter(annotation => annotation.id !== owner.annotationId);
      if (text.trim()) annotations.splice(Math.min(Math.max(0, existingIndex >= 0 ? existingIndex : edit.index), annotations.length), 0, { ...(existing || edit.value), text });
      return { ...current, annotations };
    });
    if (text.trim()) void prepareComment(edit).catch(board.showError);
  }

  function setAudioAnnotationTarget(edit: CommentEdit, timed: boolean) {
    const media = edit.value.objectId ? audioRefs.current.get(edit.value.objectId) : undefined;
    media?.pause(); edit.end = ''; patchAnnotation(edit, { timeStart: timed ? Number.isFinite(media?.currentTime) ? media!.currentTime : 0 : undefined, timeEnd: undefined, snapshotAssetId: undefined }); setCommentRevision(revision => revision + 1);
  }

  function changeAnnotationEnd(edit: CommentEdit, value: string) {
    edit.end = value; setCommentRevision(revision => revision + 1);
    const end = value.trim() ? Number(value) : undefined;
    if (end === undefined || Number.isFinite(end) && end >= (edit.value.timeStart || 0)) patchAnnotation(edit, { timeEnd: end });
  }

  async function prepareComment(edit: CommentEdit): Promise<void> {
    if (edit.preparing) return edit.preparing;
    if (!edit.snapshot) return;
    const work = (async () => {
      const blob = await edit.snapshot;
      const current = () => board.getDraftFor(edit.sessionId, edit.draftId)?.annotations.find(annotation => annotation.id === edit.value.id);
      if (!sameScope(edit) || !current() || !blob || current()?.snapshotAssetId) return;
      if (edit.value.objectIds.some(id => !scope.current.objectIds.has(id))) return;
      const asset = await board.api.upload(blob, `video-frame-${timeLabel(edit.value.timeStart || 0).replace(':', '-')}.png`);
      if (!sameScope(edit) || !current() || edit.value.objectIds.some(id => !scope.current.objectIds.has(id))) return;
      patchAnnotation(edit, { snapshotAssetId: asset.id });
    })();
    edit.preparing = work;
    try { await work; }
    finally { if (edit.preparing === work) edit.preparing = undefined; }
  }

  function removeDraftAnnotation(annotationId: string, clearError = false) {
    const owner = { ...scope.current };
    if (annotationReader?.draftId === owner.draftId && annotationReader.sessionId === owner.sessionId && annotationReader.annotationId === annotationId) closeAnnotation();
    for (const [key, edit] of comments.current) if (edit.sessionId === owner.sessionId && edit.draftId === owner.draftId && edit.value.id === annotationId) comments.current.delete(key);
    board.changeDraftFor(owner.sessionId, owner.draftId, current => ({ ...current, annotations: current.annotations.filter(annotation => annotation.id !== annotationId) }));
    if (clearError) board.setError('');
  }

  async function removeSelection() {
    if (!selected.length || disabled) return;
    const owner = { ...scope.current }, ids = new Set(selectedIds);
    setRemovingObjects(true);
    try {
      await board.operations(selected.map(object => ({ type: 'delete', objectId: object.id, expectedVersion: object.version })), owner.sessionId);
      for (const [key, edit] of comments.current) if (edit.sessionId === owner.sessionId && edit.draftId === owner.draftId && edit.value.objectIds.some(id => ids.has(id))) comments.current.delete(key);
      board.changeDraftFor(owner.sessionId, owner.draftId, current => ({ ...current, annotations: current.annotations.filter(annotation => !annotation.objectIds.some(id => ids.has(id))) }));
      setCommentRevision(revision => revision + 1); selectObjects([]);
    } catch { /* The service error and original input remain available. */ }
    finally { setRemovingObjects(false); }
  }

  async function sendRequest() {
    if (!hasRequest || disabled || committing.current || uploads.length || board.draftConflict || composing.current || commentComposing.current) return;
    const owner = { ...scope.current };
    committing.current = true; setAnnotationSaving(true);
    try {
      if (unavailableComments.length) throw new Error('This comment refers to a removed file. Discard it from the draft to continue.');
      for (const edit of comments.current.values()) if (edit.sessionId === owner.sessionId && edit.draftId === owner.draftId && board.getDraftFor(owner.sessionId, owner.draftId)?.annotations.some(annotation => annotation.id === edit.value.id)) {
        const end = edit.end.trim() ? Number(edit.end) : undefined;
        if (end !== undefined && (!Number.isFinite(end) || end < (edit.value.timeStart || 0))) throw new Error('The end time must be at or after the current timestamp.');
        await prepareComment(edit);
      }
      await board.flushDraft(owner.sessionId);
      if (!sameScope(owner)) throw new Error('The request scope has changed. Continue in the original draft.');
      const task = await board.send();
      if (task && (task.draftId === owner.draftId || task.lastEditDraftId === owner.draftId) && task.sessionId === scope.current.sessionId) {
        clearInspection(); exitAnnotation(); setTaskDetailId('');
        setHistoryOpen(false); setSentTaskId(task.id);
        for (const [key, edit] of comments.current) if (edit.sessionId === owner.sessionId && edit.draftId === owner.draftId) comments.current.delete(key);
        requestAnimationFrame(() => instruction.current?.focus({ preventScroll: true }));

      }
    } catch (cause) { board.showError(cause); }
    finally { committing.current = false; setAnnotationSaving(false); }
  }

  async function writeLayout(operations: BoardOperation[], sessionId: string) {
    if (!operations.length || layoutBusy.current) return;
    layoutBusy.current = true; setLayoutSaving(true);
    try { await board.operations(operations, sessionId); }
    catch { /* The current service layout and its error remain available. */ }
    finally { layoutBusy.current = false; setLayoutSaving(false); setPreview({}); }
  }

  async function alignSelection(alignment: Alignment) {
    if (!state || disabled || layoutBusy.current || selected.length < 2) return;
    const positions = alignedPositions(selected, alignment);
    const operations = positions.map(position => { const object = selected.find(value => value.id === position.id)!; return { type: 'update' as const, objectId: object.id, expectedVersion: object.version, changes: { x: position.x, y: position.y } }; });
    const sessionId = state.session.id;
    setSnapGuides([]); await writeLayout(operations, sessionId);
    if (scope.current.sessionId === sessionId) exitAlignment();
  }

  function previewMove(active: Gesture, point: Point, bypass: boolean) {
    active.point = point;
    if (!active.moved && Math.hypot(point.x - active.start.x, point.y - active.start.y) < 3) return;
    active.moved = true;
    const delta = { x: (point.x - active.start.x) / active.view.zoom, y: (point.y - active.start.y) / active.view.zoom };
    const size = canvas.current!.getBoundingClientRect();
    if (active.kind === 'resize') { const object = active.objects[0], capability = capabilityFor(object), result = capability.freeResize ? snapViewportResize(object, active.resizeCorner || 'se', delta, state?.objects || [], active.view, size, capability.minimum, bypass) : snapResize(object, (active.resizeCorner || 'se') as ResizeCorner, delta, state?.objects || [], active.view, size, bypass); active.preview = { [object.id]: result.bounds }; setPreview(active.preview); setSnapGuides(result.guides); return; }
    const result = !bypass ? snapTranslation(active.objects, state?.objects || [], delta, active.view, size) : { delta, guides: [] };
    active.preview = Object.fromEntries(active.objects.map(object => [object.id, { x: object.x + result.delta.x, y: object.y + result.delta.y, width: object.width, height: object.height }]));
    setPreview(active.preview); setSnapGuides(result.guides);
  }
  updateDrag.current = previewMove;

  function pointerDown(event: ReactPointerEvent<HTMLElement>, contentDrag = false) {
    if (disabled || layoutBusy.current || !state || (event.button !== 0 && event.button !== 1) || !contentDrag && (event.target as Element).closest('[data-canvas-control]')) return;
    fitMotion.interrupt();
    canvas.current?.focus({ preventScroll: true });
    const point = localPoint(event);
    const objectId = (event.target as HTMLElement).closest<HTMLElement>('[data-object-id]')?.dataset.objectId;
    const resizeId = (event.target as HTMLElement).closest<HTMLElement>('[data-resize-id]')?.dataset.resizeId;
    const effectiveMode = spacePan || event.button === 1 ? 'pan' : mode;
    const object = objects.find(value => value.id === objectId);
    if (effectiveMode === 'select' && !object && !resizeId && !annotating) clearInspection();
    if (effectiveMode === 'select' && annotating && (!object || !selectedIds.includes(object.id))) { clearInspection(); exitAnnotation(); }
    else if (effectiveMode === 'select' && !resizeId && annotating && selected.every(value => capabilityFor(value).region)) {
      const edit = beginComment();
      if (!edit) return;
      const bounds = unionBounds(selected.map(contentBounds)), world = screenToWorld(point, view);
      if (world.x < bounds.x || world.y < bounds.y || world.x > bounds.x + bounds.width || world.y > bounds.y + bounds.height) return;
      setSnapGuides([]);
      gesture.current = { kind: 'mark', start: point, point, moved: false, view, objects: selected, sessionId: state.session.id, commentKey: edit.value.id, markBounds: bounds };
      canvas.current!.setPointerCapture(event.pointerId); event.preventDefault(); return;
    }
    let kind: Gesture['kind'] = effectiveMode === 'pan' ? 'pan' : 'select';
    let moving: BoardObject[] = [];
    if (resizeId) { kind = 'resize'; moving = objects.filter(value => value.id === resizeId); }
    else if (effectiveMode === 'select' && object) {
      if (event.shiftKey) { selectObjects(selectedIds.includes(object.id) ? selectedIds.filter(id => id !== object.id) : [...selectedIds, object.id]); return; }
      const ids = selectedIds.includes(object.id) ? selectedIds : [object.id];
      selectObjects(ids); kind = 'move'; moving = objects.filter(value => ids.includes(value.id));
    } else if (effectiveMode === 'select' && !event.shiftKey) selectObjects([]);
    setSnapGuides([]);
    gesture.current = { kind, start: point, point, moved: false, view, objects: moving, sessionId: state.session.id, resizeCorner: (event.target as HTMLElement).closest<HTMLElement>('[data-resize-corner]')?.dataset.resizeCorner as ResizeHandle | undefined };
    canvas.current!.setPointerCapture(event.pointerId);
    event.preventDefault();
  }

  function frameDrag(objectId: string, frame: HTMLIFrameElement, start: { x: number; y: number }, event: ReactPointerEvent<HTMLElement>) {
    if (disabled || layoutBusy.current || !state || gesture.current || document.activeElement !== frame) return;
    const object = objects.find(value => value.id === objectId); if (!object) return;
    try { canvas.current!.setPointerCapture(event.pointerId); } catch { return; }
    if (!canvas.current!.hasPointerCapture(event.pointerId)) return;
    const bounds = frame.getBoundingClientRect(), boardBounds = canvas.current!.getBoundingClientRect();
    const point = { x: bounds.left + start.x * bounds.width - boardBounds.left, y: bounds.top + start.y * bounds.height - boardBounds.top };
    fitMotion.interrupt();
    const pan = mode === 'pan' || spacePan, ids = selectedIds.includes(objectId) ? selectedIds : [objectId];
    if (!pan) selectObjects(ids);
    gesture.current = { kind: pan ? 'pan' : 'move', start: point, point, moved: false, view, objects: pan ? [] : objects.filter(value => ids.includes(value.id)), sessionId: state.session.id };
    pointerMove(event);
    canvas.current!.focus({ preventScroll: true });
  }

  function pointerMove(event: ReactPointerEvent<HTMLElement>) {
    const active = gesture.current;
    if (!active) return;
    const point = localPoint(event);
    const dx = (point.x - active.start.x) / active.view.zoom;
    const dy = (point.y - active.start.y) / active.view.zoom;
    if (active.kind === 'mark') { const region = objectRegion(normalizedRegion(rectangle(screenToWorld(active.start, active.view), screenToWorld(point, active.view)), active.markBounds!), active.markBounds!); active.region = region.width > 0 && region.height > 0 ? region : undefined; setMarkPreview(active.region || null); return; }
    if (active.kind === 'move' || active.kind === 'resize') previewMove(active, point, event.altKey);
    if (active.kind === 'pan') board.updateView({ ...active.view, x: active.view.x + point.x - active.start.x, y: active.view.y + point.y - active.start.y }, active.sessionId);
    if (active.kind === 'select') setSelectionRect(rectangle(screenToWorld(active.start, active.view), screenToWorld(point, active.view)));
  }

  function pointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    const active = gesture.current;
    if (!active) return;
    gesture.current = null;
    setSnapGuides([]);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    const point = localPoint(event);
    const region = rectangle(screenToWorld(active.start, active.view), screenToWorld(point, active.view));
    if (active.kind === 'mark') {
      const edit = active.commentKey ? comments.current.get(active.commentKey) : undefined;
      if (edit && sameScope(edit) && active.region && active.region.width * active.view.zoom >= 3 && active.region.height * active.view.zoom >= 3) { patchAnnotation(edit, { scope: edit.value.coordinateSpace === 'normalized' ? 'object' : 'region', bounds: edit.value.coordinateSpace === 'normalized' ? normalizedRegion(active.region, active.markBounds!) : active.region }); setCommentRevision(revision => revision + 1); }
      setMarkPreview(null); focusAnnotation(); return;
    }
    if (active.kind === 'move') {
      const changes = active.moved && active.preview ? active.objects.flatMap(object => { const position = active.preview![object.id]; return position.x !== object.x || position.y !== object.y ? [{ type: 'update' as const, objectId: object.id, expectedVersion: object.version, changes: { x: position.x, y: position.y } }] : []; }) : [];
      if (changes.length) void writeLayout(changes, active.sessionId);
      else setPreview({});
    }
    if (active.kind === 'resize') {
      const changes = active.moved && active.preview ? active.objects.flatMap(object => { const bounds = active.preview![object.id]; return bounds.x !== object.x || bounds.y !== object.y || bounds.width !== object.width || bounds.height !== object.height ? [{ type: 'update' as const, objectId: object.id, expectedVersion: object.version, changes: bounds }] : []; }) : [];
      if (changes.length) void writeLayout(changes, active.sessionId);
      else setPreview({});
    }
    if (active.kind === 'select' && region.width > 2 && region.height > 2) selectObjects(objects.filter(object => intersects(region, object)).map(object => object.id));
    setSelectionRect(null);
  }

  function zoom(factor: number) {
    if (disabled) return;
    const size = canvas.current?.getBoundingClientRect();
    viewUpdate(zoomAt(view, factor, { x: (size?.width || 600) / 2, y: (size?.height || 600) / 2 }));
  }

  async function copyResume() {
    if (!state) return;
    const boardUrl = new URL(window.location.pathname, window.location.origin);
    boardUrl.searchParams.set('session', state.session.id);
    const command = `Continue the tasks on this project board. Project: ${state.project.root}; Board: ${boardUrl.href}. Check unfinished tasks and existing outputs, then process the queue in order. Register outputs and receipts after completing each task. Stop when the queue is empty or needs input.`;
    try { await navigator.clipboard.writeText(command); setNotice('Resume prompt copied.'); }
    catch { setCopyCommand(command); }
  }

  function addSelection() {
    if (!selected.length) return;
    board.changeDraft(current => ({ ...current, attachments: unique([...current.attachments, ...selected.map(object => object.assetId)]), references: { ...current.references, objectIds: unique([...current.references.objectIds, ...selectedIds]) } }));
    document.getElementById('instruction')?.focus({ preventScroll: true });
  }

  async function cancelTask(task: Task) {
    if (!state || disabled || cancellingTask) return;
    setCancellingTask(task.id);
    try {
      await board.api.request(`/api/sessions/${encodeURIComponent(state.session.id)}/tasks/${encodeURIComponent(task.id)}/cancel`, { method: 'POST', body: JSON.stringify({ reason: 'User cancelled the request.' }) });
      await board.refresh();
      if (inspectedTaskId === task.id) clearInspection();
      setTaskDetailId(current => current === task.id ? '' : current);
      setNotice('Request cancelled.');
    } catch (cause) { board.showError(cause); }
    finally { setCancellingTask(''); }
  }

  async function editRequest(task: Task, cancel = false) {
    if (disabled) return;
    setEditingTask(true);
    try {
      const selectedAnnotationId = annotationReader?.taskId === task.id ? annotationReader.annotationId : undefined;
      await board.editTask(task.id, cancel);
      const current = board.getDraftFor(state!.session.id);
      if (cancel && !current?.editingTaskId || !cancel && current?.editingTaskId === task.id) {
        clearInspection(); exitAnnotation(); setTaskDetailId(''); setQueueExpanded(false);
        const annotation = !cancel && selectedAnnotationId ? current?.annotations.find(value => value.id === selectedAnnotationId) : undefined;
        if (annotation && current) {
          comments.current.set(annotation.id, { value: { ...annotation, text: '' }, sessionId: current.sessionId, draftId: current.id, index: current.annotations.findIndex(value => value.id === annotation.id), end: annotation.timeEnd === undefined ? '' : String(annotation.timeEnd) });
          setAnnotationReader({ annotationId: annotation.id, sessionId: current.sessionId, draftId: current.id });
          requestAnimationFrame(focusAnnotation);
        } else requestAnimationFrame(() => instruction.current?.focus({ preventScroll: true }));
      }
    }
    finally { setEditingTask(false); }
  }

  function openComposerMenu(index = 0) { composerMenuIndex.current = index; setComposerMenuOpen(true); }
  function closeComposerMenu() { composerMore.current?.focus({ preventScroll: true }); setComposerMenuOpen(false); }

  function hoverQueue() { window.clearTimeout(queueCloseTimer.current); setQueueHovered(true); }
  function leaveDock() { queueCloseTimer.current = window.setTimeout(() => { setQueueHovered(false); if (!dock.current?.contains(document.activeElement)) { setQueueExpanded(false); setTaskDetailId(''); } }, 140); }


  const taskCard = (task: Task, compact = false) => <TaskCard compact={compact} summary={compact && taskDetailId !== task.id} task={task} assets={assets} objects={objects} content={id => board.api.content(id)} api={board.api} onReloadBoard={reloadBoard} locateAsset={locateAsset} onAnnotationView={(value, open, annotation) => { if (open && draft?.editingTaskId === value.id && annotation) { const current = draft.annotations.find(item => item.id === annotation.id); if (current) openAnnotation(current, true); } else if (open) { exitAnnotation(); setInspectedTaskId(value.id); readerTrigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; setAnnotationReader(annotation && state ? { annotationId: annotation.id, sessionId: state.session.id, taskId: value.id } : null); } else if (historyOpen) { setInspectedTaskId(current => current === value.id ? '' : current); setAnnotationReader(null); } }}/>;
  const composer = state && draft && <section ref={dock} className="creation-dock" data-canvas-control aria-label="Request composer and queue" onPointerLeave={leaveDock} onPointerEnter={() => window.clearTimeout(queueCloseTimer.current)} onKeyDown={event => { if (event.key === 'Escape') { clearInspection(); setTaskDetailId(''); setQueueExpanded(false); setQueueHovered(false); setQueueFocused(false); instruction.current?.focus(); } }} onDragOver={event => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); event.stopPropagation(); } }} onDrop={event => { const files = filesFromTransfer(event.dataTransfer); if (files.length) { event.preventDefault(); event.stopPropagation(); void importFiles(files); } }}>
    {(pending > 0 || historyOpen) && <div className={`queue-stack ${queueOpen ? 'expanded' : ''} ${pending > 1 && !historyOpen ? 'has-stack' : ''}`} data-pending={pending} onPointerEnter={event => { if (event.pointerType === 'mouse') hoverQueue(); }} onFocusCapture={event => { if ((event.target as HTMLElement).matches(':focus-visible')) setQueueFocused(true); }} onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setQueueFocused(false); }}>
      {pending > 1 && !historyOpen && <div className="queue-peeks" aria-hidden="true">{Array.from({ length: Math.min(pending - 1, 2) }, (_, index) => <span key={index} style={{ '--peek': index + 1 } as React.CSSProperties}/>)}</div>}
      {historyOpen ? <div className="queue-list history-list" id="request-history" role="region" aria-label="Request history"><div className="inline-heading"><span>Request history</span><IconButton label="Close request history" onClick={() => { clearInspection(); setHistoryOpen(false); composerMore.current?.focus({ preventScroll: true }); }}><ChevronDown size={14}/></IconButton></div>{state.tasks.length ? [...state.tasks].reverse().map(task => <div key={task.id}>{taskCard(task)}</div>) : <p className="field-hint">Your requests, progress and receipts appear here.</p>}</div> : <div className="queue-list" id="creation-queue" role="list" aria-label="Task queue">
        {queuedTasks.map((task, index) => <div key={task.id} className={index ? `queue-extra ${queueOpen ? 'open' : ''}` : 'queue-first'} inert={index > 0 && !queueOpen} aria-hidden={index > 0 && !queueOpen}><div className="queue-extra-content"><QueueItem task={task} detailOpen={taskDetailId === task.id} visible={queueOpen || index === 0} animateSend={sentTaskId === task.id} played={playedSendIds.current}>
          <div className={`queue-row ${taskDetailId === task.id ? 'detail-open' : ''}`}><button type="button" className="queue-task" aria-label={`View request ${task.sequence}: ${task.snapshot.userRequest.text || 'Attachments and annotations'} — ${statusLabels[task.status]}`} aria-expanded={taskDetailId === task.id} aria-controls={`request-details-${task.id}`} onClick={() => toggleTaskDetail(task)}>{task.status === 'queued' && <span className="queue-task-mark" aria-hidden="true"><Circle size={14}/></span>}<span className="queue-title" data-queue-layout="title">{task.snapshot.userRequest.text || 'Create from the attachments and annotations.'}</span></button>
          {['blocked', 'interrupted', 'editing'].includes(task.status) && <span className={`status-badge status-${task.status}`} aria-hidden="true">{statusLabels[task.status]}</span>}{task.status === 'queued' && <IconButton label={`Edit request ${task.sequence}`} disabled={disabled || !!draft.editingTaskId} onClick={() => void editRequest(task)}><Pencil size={14}/></IconButton>}{['queued', 'blocked', 'interrupted'].includes(task.status) && <IconButton label={`Cancel request ${task.sequence}`} disabled={disabled || !!cancellingTask} onClick={() => void cancelTask(task)}>{cancellingTask === task.id ? <LoaderCircle size={14} className="spin"/> : <Trash2 size={14}/>}</IconButton>}{taskDetailId === task.id && <IconButton label="Collapse request details" onClick={() => { clearInspection(); setTaskDetailId(''); document.querySelector<HTMLButtonElement>(`.queue-item[data-task-id="${task.id}"] .queue-task`)?.focus({ preventScroll: true }); }}><ChevronDown size={14}/></IconButton>}</div>
          <MotionDisclosure open={taskDetailId === task.id} className="inline-task-detail" id={`request-details-${task.id}`} role="region" aria-label={`Request ${task.sequence}`}>{taskCard(task, true)}</MotionDisclosure>
        </QueueItem></div></div>)}
      </div>}
      {!historyOpen && pending > 1 && <button type="button" className="queue-expand" aria-label={`${pending} requests`} aria-expanded={queueOpen} aria-controls="creation-queue" onClick={() => setQueueExpanded(current => !current)}>{pending}<ChevronDown size={12}/></button>}
    </div>}
    {board.draftConflict && <section className="draft-conflict" aria-label="Resolve draft update"><strong>Draft updated elsewhere</strong><div className="conflict-comparison">{[{ label: 'Your input', value: draft }, { label: 'Saved draft', value: board.draftConflict }].map(item => <section key={item.label}><h3>{item.label}</h3><p className="conflict-text">{item.value?.text || 'No text yet'}</p><div className="conflict-references"><span>{item.value?.attachments.length || 0} attachments · {item.value?.annotations.length || 0} annotations</span>{item.value?.attachments.map(id => <small key={id}>{assetFor(id)?.name || id}</small>)}{item.value?.annotations.map(annotation => <small key={annotation.id}>{annotation.text}</small>)}</div></section>)}</div><div className="inline-actions"><button type="button" className="button" disabled={resolvingConflict} onClick={() => { setResolvingConflict(true); void board.resolveDraftConflict('remote').catch(board.showError).finally(() => setResolvingConflict(false)); }}>Use saved draft</button><button type="button" className="button primary" disabled={resolvingConflict} onClick={() => { setResolvingConflict(true); void board.resolveDraftConflict('local').catch(board.showError).finally(() => setResolvingConflict(false)); }}>{resolvingConflict ? 'Saving…' : 'Keep your draft'}</button></div></section>}
    {!!unavailableComments.length && <div className="unavailable-comments" aria-label="Unavailable comments">{unavailableComments.map(annotation => <div key={annotation.id}><span>Removed file · {annotation.text}</span><IconButton label="Discard unavailable comment" onClick={() => removeDraftAnnotation(annotation.id, true)}><Trash2 size={14}/></IconButton></div>)}</div>}
    {copyCommand && <section className="inline-resume" aria-label="Resume prompt"><div className="inline-heading"><span>Resume prompt</span><IconButton label="Close resume prompt" onClick={() => { setCopyCommand(''); composerMore.current?.focus({ preventScroll: true }); }}><X size={14}/></IconButton></div><textarea aria-label="Resume prompt text" readOnly value={copyCommand} rows={3} onFocus={event => event.target.select()}/></section>}
    <div className="composer-shell" data-compact={composerCompact} onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) { setComposerFocused(false); setComposerMenuOpen(false); } }}>
    <form className="composer" data-compact={composerCompact} aria-label="Request draft" data-save-state={board.saveState} onSubmit={event => { event.preventDefault(); if (!composing.current && !commentComposing.current) void sendRequest(); }}>
    {draft.editingTaskId && <div className="composer-editing"><span>Editing request {state.tasks.find(task => task.id === draft.editingTaskId)?.sequence}</span><button type="button" disabled={disabled} onClick={() => { const task = state.tasks.find(task => task.id === draft.editingTaskId); if (task) void editRequest(task, true); }}>Cancel edit</button></div>}
    {!!(draft.attachments.length || draft.annotations.length) && <div className="draft-attachments" aria-label="Request attachments">{draft.attachments.map(id => { const asset = assetFor(id); return <div className="draft-asset" key={id}><AssetThumb asset={asset} src={board.api.content(id)}/><span title={asset?.name}>{asset?.name || 'Loading file'}</span><IconButton label={`Remove attachment ${asset?.name || id}`} disabled={disabled} onClick={() => board.changeDraft(current => ({ ...current, attachments: current.attachments.filter(value => value !== id), references: { ...current.references, objectIds: current.references.objectIds.filter(objectId => { const object = state.tasks.find(task => task.id === current.editingTaskId)?.snapshot.referenceContent.objects.find(value => value.id === objectId) || state.objects.find(value => value.id === objectId); return !!object && object.assetId !== id; }) } }))}><X size={13}/></IconButton></div>; })}{draft.annotations.map((annotation, index) => <div className="draft-annotation" key={annotation.id}><button type="button" className="annotation-content" onClick={() => openAnnotation(annotation, true)}><AnnotationBubble number={index + 1} size={24}/><span>{annotation.text}{annotation.timeStart !== undefined && <small> · {timeLabel(annotation.timeStart)}</small>}</span></button><IconButton label={`Remove annotation ${index + 1}`} disabled={disabled} onClick={() => removeDraftAnnotation(annotation.id)}><X size={13}/></IconButton></div>)}</div>}
      <div className="composer-input-row">
      <button ref={composerMore} type="button" className="composer-more" aria-label="More request actions" aria-haspopup="menu" aria-expanded={composerMenuOpen} aria-controls="composer-actions" onClick={() => { if (composerMenuOpen) closeComposerMenu(); else openComposerMenu(); }} onKeyDown={event => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); event.stopPropagation(); openComposerMenu(event.key === 'ArrowUp' ? 1 : 0); }
        else if (event.key === 'Escape' && composerMenuOpen) { event.preventDefault(); event.stopPropagation(); closeComposerMenu(); }
      }}><Ellipsis size={16}/></button>
      <label className="sr-only" htmlFor="instruction">Request</label><textarea ref={instruction} id="instruction" rows={1} placeholder={composerCompact ? 'Create…' : 'What would you like to create?'} onFocus={() => setComposerFocused(true)} value={draft.text} readOnly={board.projectChanged} disabled={board.switching || board.sending || annotationSaving} onChange={event => board.changeDraft(current => ({ ...current, text: event.target.value }))} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }} onKeyDown={event => { if (event.key !== 'Enter' || event.shiftKey || composing.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return; event.preventDefault(); void sendRequest(); }}/><button className="send-button" type="submit" disabled={disabled || !!uploads.length || !!board.draftConflict || !hasRequest} aria-label={draft.editingTaskId ? "Save edit" : "Send request"}>{board.sending || annotationSaving ? <LoaderCircle size={17} className="spin"/> : <ArrowUp size={16}/>}</button>
      </div>
    </form>
    {composerMenuOpen && <div ref={composerMenu} className="composer-menu" id="composer-actions" role="menu" aria-label="Request actions" onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeComposerMenu(); return; }
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault(); event.stopPropagation();
        const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role=menuitem]')), index = items.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        items[next]?.focus();
      }
      if (event.key === 'Enter' || event.key === ' ') event.stopPropagation();
    }}>
      <button type="button" role="menuitem" onClick={() => { closeComposerMenu(); clearInspection(); exitAnnotation(); setHistoryOpen(true); setTaskDetailId(''); }}><History size={16}/><span>Request history</span></button>
      <button type="button" role="menuitem" onClick={() => { closeComposerMenu(); void copyResume().finally(() => composerMore.current?.focus({ preventScroll: true })); }}><Copy size={16}/><span>Copy resume prompt</span></button>
    </div>}
    </div>
  </section>;

  const notificationItems: Notification[] = [];
  if (persistentError && (board.error || board.projectChanged)) notificationItems.push({ id: 'error', content: <div className="error-banner" role="alert"><span>{board.error || 'This address now serves another project. Your draft is preserved. Reopen the board to continue.'}</span>{!state ? <button onClick={() => window.location.reload()}>Reconnect</button> : board.projectChanged ? <button onClick={() => window.location.assign(window.location.pathname)}>Reopen board</button> : board.saveState === 'failed' && <button onClick={() => void board.flushDraft().catch(() => undefined)}>Retry saving</button>}<IconButton label="Dismiss error" disabled={board.projectChanged} onClick={() => board.setError('')}><X size={15}/></IconButton></div> });
  if (state && board.connection !== 'connected' && !board.projectChanged) notificationItems.push({ id: 'connection', content: <div className="connection-feedback" role="status"><LoaderCircle size={14} className="spin"/>{board.connection === 'reconnecting' ? 'Reconnecting…' : 'Connecting…'}</div> });
  for (const upload of uploads) notificationItems.push({ id: `upload-${upload.id}`, content: <div className="upload-list" aria-live="polite"><div><LoaderCircle size={15} className="spin"/><span>Importing {upload.name}</span><IconButton label={`Cancel import ${upload.name}`} onClick={() => upload.controller.abort()}><X size={15}/></IconButton></div></div> });
  const notificationList = <NotificationStack items={notificationItems} notices={notices} elementRef={notifications}/>;

  if (!state || !draft) return <><main className="startup"><span className="brand">acanvas<span>●</span></span>{board.error ? <h1>Unable to open the board</h1> : <><LoaderCircle size={24} className="spin"/><p>Opening your board…</p></>}</main>{notificationList}</>;

  return <div className="app-shell"><a className="skip-link" href="#whiteboard">Skip to canvas</a>
    <main className="canvas-main"><div id="whiteboard" className={`whiteboard mode-${annotating && !spacePan && mode === 'select' ? 'annotate' : spacePan ? 'pan' : mode} ${dragOver ? 'drag-over' : ''} ${board.switching ? 'is-loading' : ''}`} ref={canvas} tabIndex={0} role="region" aria-label="Project board. Enter selects files, arrow keys move them, and Space pans the canvas." onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={() => { gesture.current = null; setPreview({}); setSelectionRect(null); setSnapGuides([]); setMarkPreview(null); }} onKeyDown={event => { if (event.target !== event.currentTarget || disabled) return; if (event.key === ' ') { event.preventDefault(); setSpacePan(true); } if (event.key === 'Escape') { if (annotationRead) closeAnnotation(); else if (annotating) exitAnnotation(); else if (aligning) exitAlignment(); else { clearInspection(); selectObjects([]); setMode('select'); } } if (event.key === '+' || event.key === '=') { event.preventDefault(); zoom(1.2); } if (event.key === '-') { event.preventDefault(); zoom(1 / 1.2); } }} onKeyUp={event => { if (event.key === ' ') setSpacePan(false); }} onBlur={() => setSpacePan(false)} onDragOver={event => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); setDragOver(true); } }} onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragOver(false); }} onDrop={event => { event.preventDefault(); setDragOver(false); void importFiles(filesFromTransfer(event.dataTransfer), localPoint(event)); }}>
      <div className="canvas-world" style={{ transform: `translate(${view.x}px,${view.y}px) scale(${view.zoom})` }}>{objects.map((object, index) => { const asset = assetFor(object.assetId); const isSelected = selectedIds.includes(object.id); return <article key={object.id} className={`board-object object-${object.type} ${isSelected ? 'selected' : ''}`} data-object-id={object.id} data-content-kind={resolveContentKind(asset)} data-object-version={object.version} data-selected={isSelected || undefined} style={{ left: object.x, top: object.y, width: object.width, height: object.height }} tabIndex={0} role="group" aria-label={`${asset?.name || 'File'}${isSelected ? ', selected' : ''}`} onKeyDown={event => { if (event.target !== event.currentTarget || disabled) return; if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); selectObjects(event.shiftKey ? unique([...selectedIds, object.id]) : [object.id]); } const delta = { ArrowLeft: [-10, 0], ArrowRight: [10, 0], ArrowUp: [0, -10], ArrowDown: [0, 10] }[event.key]; if (delta) { event.preventDefault(); event.stopPropagation(); void board.operations([{ type: 'update', objectId: object.id, expectedVersion: object.version, changes: { x: object.x + delta[0], y: object.y + delta[1] } }]).catch(() => undefined); } }}>
        <div className="object-media"><ContentRenderer asset={asset} src={board.api.content(object.assetId)} api={board.api} onReloadBoard={reloadBoard} onBlankPointerDown={event => { event.stopPropagation(); pointerDown(event, true); }} onFrameWheel={canvasWheel} onFrameDrag={(frame, start, event) => frameDrag(object.id, frame, start, event)} disabled={disabled || annotating} error={mediaErrors[object.id]} onSize={size => setMediaSizes(current => ({ ...current, [object.id]: size }))} onError={() => setMediaErrors(current => ({ ...current, [object.id]: true }))} onMediaElement={element => { const refs = resolveContentKind(asset) === 'audio' ? audioRefs.current : videoRefs.current; if (element) (refs as Map<string, HTMLMediaElement>).set(object.id, element); else refs.delete(object.id); }}/></div>
        <div className="object-caption"><span className="object-index">{String(index + 1).padStart(2, '0')}</span><span title={asset?.name}>{asset?.name || 'File'}</span>{object.sourceTaskId && <span className="generated-label">Output</span>}</div>{isSelected && ((capabilityFor(object).freeResize ? ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] : ['nw', 'ne', 'sw', 'se']) as ResizeHandle[]).map(corner => <button key={corner} type="button" className="resize-handle" data-resize-id={object.id} data-resize-corner={corner} aria-label={`Resize ${asset?.name || 'File'} ${ { nw: 'top left', n: 'top', ne: 'top right', e: 'right', se: 'bottom right', s: 'bottom', sw: 'bottom left', w: 'left' }[corner]}`} onKeyDown={event => { if (!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key) || layoutBusy.current || disabled) return; event.preventDefault(); event.stopPropagation(); const delta = { x: event.key === 'ArrowRight' ? 10 : event.key === 'ArrowLeft' ? -10 : 0, y: event.key === 'ArrowDown' ? 10 : event.key === 'ArrowUp' ? -10 : 0 }; const capability = capabilityFor(object), bounds = capability.freeResize ? resizeViewportBounds(object, corner, delta, capability.minimum) : resizeBounds(object, corner as ResizeCorner, delta); void writeLayout([{ type: 'update', objectId: object.id, expectedVersion: object.version, changes: bounds }], state.session.id); }}/>) }</article>; })}
      {allAnnotations.map(annotation => { const bounds = annotationBounds(annotation); if (!bounds || annotation.scope === 'group' || annotating && annotation.id === comment?.value.id) return null; return <div className={`annotation-outline ${!annotation.inspectionTaskId ? 'draft-outline' : ''}`} key={`${annotation.inspectionTaskId || 'draft'}-${annotation.id}`} data-annotation-id={annotation.id} data-annotation-source={annotation.inspectionTaskId ? 'task' : 'draft'} data-source-removed={annotation.objectIds.some(id => !objects.some(object => object.id === id)) || undefined} style={{ left: bounds.x, top: bounds.y, width: bounds.width, height: bounds.height }}/>; })}
      {editingBounds && <div className="annotation-outline editing-outline" data-annotation-source="editing" style={{ left: editingBounds.x, top: editingBounds.y, width: editingBounds.width, height: editingBounds.height }}/>}
      {!!snapGuides.length && <svg className="alignment-guides" aria-hidden="true">{snapGuides.map(guide => <line key={guide.axis} data-snap-axis={guide.axis} vectorEffect="non-scaling-stroke" x1={guide.axis === 'x' ? guide.position : guide.start} y1={guide.axis === 'y' ? guide.position : guide.start} x2={guide.axis === 'x' ? guide.position : guide.end} y2={guide.axis === 'y' ? guide.position : guide.end}/>)}</svg>}
      {selectionRect && <div className="selection-rect" style={{ left: selectionRect.x, top: selectionRect.y, width: selectionRect.width, height: selectionRect.height }}/> }</div>
      {allAnnotations.map((annotation, index) => {
        const bounds = annotationBounds(annotation); if (!bounds) return null;
        const active = annotationRead?.id === annotation.id && ((!!annotationReader?.draftId || readingEditDraft) === !annotation.inspectionTaskId);
        const editable = active && readerEditable;
        const sources = annotationSources(annotation), sourceAssetIds = unique([...sources.map(object => object.assetId), ...[annotation.assetId, annotation.snapshotAssetId].filter((id): id is string => !!id)]);
        const creation = active && annotationEdit && !annotationEdit.finished && annotating;
        return <CanvasAnnotationNote key={`${annotation.inspectionTaskId || draft?.editingTaskId || 'draft'}-${annotation.id}`} canvas={canvas} bounds={annotationDisplayBounds(annotation)} view={view} number={index + 1} onOpen={() => openAnnotation(annotation, !annotation.inspectionTaskId)} annotationId={annotation.id} active={active} control={{ text: annotation.text, compositionRef: active ? commentComposing : undefined, mode: active ? editable ? 'edit' : 'view' : 'display', inputLabel: active ? editable ? creation ? 'Add a comment' : 'Annotation text' : 'Annotation comment' : `Comment ${index + 1}: ${annotation.text}`, inputRef: active ? annotationInput : undefined, disabled: active && disabled, onOpen: () => openAnnotation(annotation, !annotation.inspectionTaskId), onBack: closeAnnotation, onChange: changeAnnotationText, children: <>
          <div className="annotation-source-thumbs">{sourceAssetIds.map(id => <AssetThumb key={id} asset={assetFor(id)} src={board.api.content(id)}/>)}</div>
          {annotation.objectIds.some(id => !objects.some(object => object.id === id)) && <span className="annotation-source-status">Source removed</span>}
          {resolveContentKind(assetFor(annotation.assetId || '')) === 'audio' && <div className="comment-video-meta">{editable && annotationEdit ? <label>Audio target<select aria-label="Audio annotation target" disabled={disabled} value={annotation.timeStart === undefined ? 'whole' : 'time'} onChange={event => setAudioAnnotationTarget(annotationEdit, event.target.value === 'time')}><option value="whole">Whole audio</option><option value="time">Current time</option></select></label> : <span>{annotation.timeStart === undefined ? 'Whole audio' : 'Audio time'}</span>}</div>}{annotation.timeStart !== undefined && <div className="comment-video-meta"><span>{timeLabel(annotation.timeStart)}{annotation.timeEnd !== undefined && ` – ${timeLabel(annotation.timeEnd)}`}</span>{editable && annotationEdit ? <label>End time<input type="number" min={annotation.timeStart} step="0.1" placeholder="Optional" value={annotationEdit.end} disabled={disabled} onChange={event => changeAnnotationEnd(annotationEdit, event.target.value)}/></label> : annotation.objectId && (videoRefs.current.has(annotation.objectId) || audioRefs.current.has(annotation.objectId)) && <button type="button" className="annotation-media-action" onClick={() => { const media = videoRefs.current.get(annotation.objectId!) || audioRefs.current.get(annotation.objectId!); if (media) { media.pause(); media.currentTime = annotation.timeStart!; } }}>{audioRefs.current.has(annotation.objectId!) ? 'Jump to time' : 'Jump to frame'}</button>}{annotationEdit?.frameNote && <span title={annotationEdit.frameNote}>Timestamp only</span>}</div>}
        </> }}/>
      })}
      {dragOver && <div className="drop-indicator"><Upload size={28}/><span>Drop files onto the canvas</span></div>}
      {!annotationRead && !annotating && !!selected.length && <div ref={selectionActions} className={`selection-actions context-control ${aligning ? 'alignment-control' : 'selection-tool-control'}`} data-canvas-control onKeyDown={event => { event.stopPropagation(); if (event.key === 'Escape' && aligning) { event.preventDefault(); exitAlignment(); } }}>
        {aligning ? <><IconButton label="Back to selection tools" onClick={exitAlignment}><ArrowLeft size={15}/></IconButton><div className="alignment-actions" role="toolbar" aria-label="Align selected files"><IconButton label="Align left" disabled={disabled} onClick={() => alignSelection('left')}><AlignStartVertical size={15}/></IconButton><IconButton label="Align horizontal centers" disabled={disabled} onClick={() => alignSelection('horizontal-center')}><AlignCenterVertical size={15}/></IconButton><IconButton label="Align right" disabled={disabled} onClick={() => alignSelection('right')}><AlignEndVertical size={15}/></IconButton><IconButton label="Align top" disabled={disabled} onClick={() => alignSelection('top')}><AlignStartHorizontal size={15}/></IconButton><IconButton label="Align vertical centers" disabled={disabled} onClick={() => alignSelection('vertical-center')}><AlignCenterHorizontal size={15}/></IconButton><IconButton label="Align bottom" disabled={disabled} onClick={() => alignSelection('bottom')}><AlignEndHorizontal size={15}/></IconButton></div></> : <div className="selection-primary-tools" role="toolbar" aria-label="Selected file actions"><IconButton label="Attach to request" disabled={disabled} onClick={addSelection}><Plus size={22} strokeWidth={1.75}/></IconButton><IconButton label="Annotate" disabled={disabled} onClick={enterAnnotation}><AnnotationBubble size={18} tone="neutral"/></IconButton><IconButton label="Remove selected files from canvas" disabled={disabled} onClick={() => void removeSelection()}><Trash2 size={18}/></IconButton>{selected.length > 1 && <IconButton label="Align" aria-haspopup="false" disabled={disabled} onClick={enterAlignment}><AlignStartVertical size={18}/></IconButton>}</div>}
      </div>}
      {selectedVideo && <VideoPlaybackControls key={selectedVideo.id} objectId={selectedVideo.id} videos={videoRefs.current} disabled={disabled || annotating} onError={board.showError} controlRef={playbackControls}/> }
      <div className="canvas-toolbar" data-canvas-control role="toolbar" aria-label="Board tools"><IconButton disabled={disabled} label="Select files" aria-pressed={mode === 'select'} onClick={() => setMode('select')}><MousePointer2 size={16}/></IconButton><IconButton disabled={disabled} label="Pan canvas" aria-pressed={mode === 'pan'} onClick={() => setMode('pan')}><Hand size={16}/></IconButton><span className="toolbar-divider"/><IconButton disabled={disabled} label="Zoom out" onClick={() => zoom(1 / 1.2)}><Minus size={16}/></IconButton><button disabled={disabled} className="zoom-label" title="Reset zoom to 100%" aria-label="Reset zoom to 100%" onClick={() => { const size = canvas.current!.getBoundingClientRect(); viewUpdate(zoomAt(view, 1 / view.zoom, { x: size.width / 2, y: size.height / 2 })); }}>{Math.round(view.zoom * 100)}%</button><IconButton disabled={disabled} label="Zoom in" onClick={() => zoom(1.2)}><Plus size={16}/></IconButton><span className="toolbar-divider"/><IconButton disabled={disabled} label="Fit all files" onClick={() => { const size = canvas.current!.getBoundingClientRect(); fitMotion.animate({ ...view, ...fitView(objects, size) }); }}><Maximize size={16}/></IconButton></div>
      {board.switching && <div className="canvas-busy"><LoaderCircle size={20} className="spin"/>Connecting to the board</div>}
    </div><div className="project-identity" aria-label={`acanvas project: ${state.project.name}`} title={state.project.name}><span className="brand">acanvas<span aria-hidden="true">●</span></span><span className="project-name">{state.project.name}</span></div><div className="canvas-actions"><IconButton className="floating-control import-button" label="Import files" disabled={disabled} onClick={() => boardInput.current?.click()}><Upload size={17}/></IconButton><IconButton className="floating-control" label={theme === 'light' ? 'Switch to dark theme' : 'Switch to light theme'} onClick={() => setTheme(current => current === 'light' ? 'dark' : 'light')}>{theme === 'light' ? <Moon size={17}/> : <Sun size={17}/>}</IconButton></div>{composer}</main>
    <input className="sr-only" aria-label="Import files into canvas" tabIndex={-1} type="file" multiple ref={boardInput} onChange={event => { void importFiles(Array.from(event.target.files || [])); event.target.value = ''; }}/>
    {notificationList}
  </div>;
}
