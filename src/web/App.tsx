import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from 'react';
import { AlignCenterHorizontal, AlignCenterVertical, AlignEndHorizontal, AlignEndVertical, AlignStartHorizontal, AlignStartVertical, ArrowDownToLine, ArrowLeft, ArrowUp, Check, ChevronDown, Circle, Copy, File, Hand, History, ImagePlus, LoaderCircle, Maximize, Minus, Moon, MousePointer2, Pause, Pencil, Play, Plus, Sun, Trash2, Upload, X } from 'lucide-react';
import type { AnnotationInput, Asset, BoardObject, BoardOperation, Draft, SessionView, Task, TaskStatus } from '../shared/types';
import { alignedPositions, fitView, intersects, mediaContentRect, normalizedRegion, objectRegion, rectangle, screenToWorld, resizeBounds, snapResize, snapTranslation, unionBounds, zoomAt, type Alignment, type Point, type Rect, type SnapGuide, type ResizeCorner } from './geometry';
import { useBoard } from './useBoard';
import { useAnimatedView } from './useAnimatedView';
import { filesFromTransfer } from './import';
import { useComposerLayout, useContextualControls, useNotificationLayout } from './useCanvasLayout';
import { AnnotationBubble } from './AnnotationBubble';
import { getVideoThumbnail } from './videoThumbnail';
import { CanvasAnnotationNote } from './CanvasAnnotationNote';
import { AnnotationCommentControl } from './AnnotationCommentControl';

const statusLabels: Record<TaskStatus, string> = { queued: 'Queued', editing: 'Editing', running: 'Running', blocked: 'Needs input', interrupted: 'Interrupted', completed: 'Completed', cancelled: 'Cancelled' };
const timeLabel = (value: number) => `${Math.floor(value / 60)}:${String(Math.floor(value % 60)).padStart(2, '0')}`;
const bytes = (value: number) => value < 1024 * 1024 ? `${Math.max(1, Math.round(value / 1024))} KB` : `${(value / (1024 * 1024)).toFixed(1)} MB`;
const unique = (values: string[]) => [...new Set(values)];

function IconButton({ label, children, className = '', ...props }: { label: string; children: ReactNode; className?: string } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button type="button" className={`icon-button ${className}`} title={label} aria-label={label} {...props}>{children}</button>;
}

async function fileDimensions(file: File): Promise<{ width: number; height: number } | undefined> {
  if (!file.type.startsWith('image/') && !file.type.startsWith('video/')) return;
  const url = URL.createObjectURL(file);
  return new Promise(resolve => {
    const media = file.type.startsWith('image/') ? new Image() : document.createElement('video');
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
type CommentEdit = { value: AnnotationInput; sessionId: string; draftId: string; end: string; snapshot?: Promise<Blob | undefined>; frameNote?: string };
type AnnotationReader = { annotation: AnnotationInput; sessionId: string; draftId?: string };
type Gesture = { kind: 'move' | 'resize' | 'pan' | 'select' | 'mark'; start: Point; point: Point; moved: boolean; preview?: Record<string, Rect>; view: SessionView; objects: BoardObject[]; sessionId: string; resizeCorner?: ResizeCorner; commentKey?: string; markBounds?: Rect; region?: Rect };

function AssetThumb({ asset, src }: { asset?: Asset; src: string }) {
  const [frame, setFrame] = useState<{ src: string; image: string }>();
  useEffect(() => {
    if (asset?.kind !== 'video') return;
    let active = true;
    void getVideoThumbnail(src).then(image => { if (active && image) setFrame({ src, image }); });
    return () => { active = false; };
  }, [asset?.kind, src]);
  const image = asset?.kind === 'image' ? src : frame?.src === src ? frame.image : undefined;
  return <span className="asset-thumb" data-kind={asset?.kind}>{image ? <img src={image} alt="" loading="lazy"/> : asset?.kind === 'video' ? <Play size={13}/> : <File size={15}/>}</span>;
}

function taskReferences(task: Task) {
  const { assets, objects } = task.snapshot.referenceContent;
  const groups = task.snapshot.annotations.map(annotation => {
    const items = objects.filter(object => object.id === annotation.objectId || annotation.objectIds.includes(object.id)).map(object => ({ key: object.id, asset: assets.find(asset => asset.id === object.assetId), frame: false }));
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

function TaskCard({ task, assets, objects, content, locateAsset, onAnnotationView, compact = false, summary = false }: { task: Task; assets: Asset[]; objects: BoardObject[]; content: (id: string) => string; locateAsset: (id: string) => void; onAnnotationView: (task: Task, open: boolean) => void; compact?: boolean; summary?: boolean }) {
  const sourceAssets = task.snapshot.referenceContent.assets;
  const references = taskReferences(task);
  const [previewLimit, setPreviewLimit] = useState(() => matchMedia('(max-width: 360px)').matches ? 1 : 3);
  useEffect(() => { const narrow = matchMedia('(max-width: 360px)'); const update = () => setPreviewLimit(narrow.matches ? 1 : 3); narrow.addEventListener('change', update); return () => narrow.removeEventListener('change', update); }, []);
  const [previewId, setPreviewId] = useState('');
  useEffect(() => { if (summary) setPreviewId(''); }, [summary]);
  const previewAsset = [...assets, ...sourceAssets].find(asset => asset.id === previewId);
  const assetAction = (asset: Asset, thumbnail: boolean) => asset.kind === 'file' ? <a href={content(asset.id)} download={asset.name} title={asset.name} aria-label={`Download ${asset.name}`} key={asset.id}>{thumbnail ? <AssetThumb asset={asset} src={content(asset.id)}/> : <><ArrowDownToLine size={12}/>{asset.name}</>}</a> : <button type="button" title={asset.name} aria-label={`View ${asset.name}`} key={asset.id} onClick={() => { if (objects.some(object => object.assetId === asset.id)) locateAsset(asset.id); else setPreviewId(current => current === asset.id ? '' : asset.id); }}>{thumbnail ? <AssetThumb asset={asset} src={content(asset.id)}/> : asset.name}</button>;
  return <article className="task-card" data-task-id={task.id} data-status={task.status}>
    {!compact && <div className="task-heading"><span className="task-sequence">Request {String(task.sequence).padStart(2, '0')}</span><span className={`status-badge status-${task.status}`}>{task.status === 'completed' && <Check size={11}/>} {statusLabels[task.status]}</span></div>}
    {!compact && <p className="task-instruction">{task.snapshot.userRequest.text || 'Create from the attachments and annotations.'}</p>}
    <div className="task-detail-content"><div className={`task-reference-groups${compact ? ' queue-previews' : ''}`} aria-label={compact ? `${references.count} references` : undefined}>
      {references.groups.map(({ annotation, items, primary }, index) => {
        const summaryIndex = references.attachments.length + index, shown = summary && summaryIndex < previewLimit;
        return <div className={`task-reference-group${shown ? ' summary-group' : ''}`} key={annotation.id} data-annotation-id={annotation.id}>
          <button type="button" className="task-annotation-badge" data-queue-layout={`badge-${annotation.id}`} aria-label={`View annotation ${index + 1}: ${annotation.text}`} onClick={() => onAnnotationView(task, true)}><AnnotationBubble number={index + 1} size={18}/></button>
          <div className="task-reference-row">{(items.length ? items : [{ key: 'region', asset: undefined, frame: false }]).map(item => {
            const preview = shown && (!primary || item.key === primary.key);
            return <div className={`task-reference-source${preview ? ' queue-preview' : ''}`} key={item.key} data-reference-item={item.key} data-queue-layout={`source-${annotation.id}-${item.key}`}>{item.asset ? item.frame ? <button type="button" title={item.asset.name} aria-label={`View ${item.asset.name}`} onClick={() => setPreviewId(current => current === item.asset!.id ? '' : item.asset!.id)}><span className="asset-thumb" data-kind="image"><img className="task-annotation-frame" src={content(item.asset.id)} alt="Annotated video frame"/></span></button> : assetAction(item.asset, true) : <span className="asset-thumb" aria-label="Canvas region"><Maximize size={14}/></span>}</div>;
          })}</div>
          <div className="task-item-annotation"><button type="button" className="task-annotation-text" onClick={() => onAnnotationView(task, true)}><span>{annotation.text}{annotation.timeStart !== undefined && <small> · {timeLabel(annotation.timeStart)}{annotation.timeEnd !== undefined && ` – ${timeLabel(annotation.timeEnd)}`}</small>}</span></button></div>
        </div>;
      })}
      {!!references.attachments.length && <div className="task-reference-group" data-unannotated-attachments><div className="task-reference-row">{references.attachments.map((asset, index) => <div className={`task-reference-source${summary && index < previewLimit ? ' queue-preview' : ''}`} key={asset.id} data-reference-item={asset.id} data-queue-layout={`attachment-${asset.id}`}>{assetAction(asset, true)}</div>)}</div></div>}
      {compact && summary && references.count > previewLimit && <span className="queue-preview-overflow" aria-label={`${references.count - previewLimit} more references; ${references.count} references total`}>+{references.count - previewLimit}</span>}
    </div>
    {previewAsset && <div className="task-media-preview" role="region" aria-label={`Preview ${previewAsset.name}`}><IconButton label="Close media preview" onClick={() => setPreviewId('')}><ChevronDown size={14}/></IconButton>{previewAsset.kind === 'image' ? <img src={content(previewAsset.id)} alt={previewAsset.name}/> : <video src={content(previewAsset.id)} controls playsInline preload="metadata"/>}</div>}
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
  const [notice, setNotice] = useState('');
  const [copyCommand, setCopyCommand] = useState('');
  const [spacePan, setSpacePan] = useState(false);
  const [resolvingConflict, setResolvingConflict] = useState(false);
  const canvas = useRef<HTMLDivElement>(null);
  const dock = useRef<HTMLElement>(null);
  const notifications = useRef<HTMLElement>(null);
  const instruction = useRef<HTMLTextAreaElement>(null);
  const selectionActions = useRef<HTMLDivElement>(null);
  const playbackControls = useRef<HTMLDivElement>(null);
  const commentInput = useRef<HTMLTextAreaElement>(null);
  const composing = useRef(false);
  const commentComposing = useRef(false);
  const committing = useRef(false);
  const scope = useRef({ sessionId: '', draftId: '', objectIds: new Set<string>() });
  scope.current = { sessionId: state?.session.id || '', draftId: draft?.id || '', objectIds: new Set(state?.objects.map(object => object.id)) };
  const wheelState = useRef({ view, sessionId: state?.session.id || '', disabled: false });
  wheelState.current = { view, sessionId: state?.session.id || '', disabled: board.projectChanged || board.switching || board.sending };
  const gesture = useRef<Gesture | null>(null);
  const videoRefs = useRef(new Map<string, HTMLVideoElement>());
  const boardInput = useRef<HTMLInputElement>(null);
  const objects = (state?.objects || []).map(object => preview[object.id] ? { ...object, ...preview[object.id] } : object);
  const selectedIds = view.selectedObjectIds.filter(id => objects.some(object => object.id === id));
  const selected = objects.filter(object => selectedIds.includes(object.id));
  const selectedVideo = selected.length === 1 && selected[0].type === 'video' && !mediaErrors[selected[0].id] ? selected[0] : undefined;
  const assets = state?.assets || [];
  const assetFor = (id: string) => assets.find(asset => asset.id === id);
  const disabled = board.projectChanged || board.switching || board.sending || editingTask || annotationSaving || removingObjects || layoutSaving;
  const fitMotion = useAnimatedView(view, state?.session.id || '', disabled, board.updateView);
  const queuedTasks = state?.tasks.filter(task => ['queued', 'editing', 'running', 'blocked', 'interrupted'].includes(task.status)) || [];
  const pending = queuedTasks.length;
  const queueOpen = queueExpanded || queueHovered || queueFocused || !!taskDetailId || historyOpen;
  const commentKey = `${state?.session.id}:${draft?.id}:${[...selectedIds].sort().join(',')}`;
  const comment = comments.current.get(commentKey);
  const annotating = annotatingKey === commentKey && selected.length > 0;
  const aligning = aligningKey === commentKey && selected.length > 1;
  const inspectedTask = state?.tasks.find(task => task.id === inspectedTaskId);
  const inspectableTask = inspectedTask && (historyOpen || queuedTasks.some(task => task.id === inspectedTaskId)) ? inspectedTask : undefined;
  const viewingEditedTask = !!draft?.editingTaskId && inspectableTask?.id === draft.editingTaskId;
  const editingSourceTask = state?.tasks.find(task => task.id === draft?.editingTaskId);
  const annotationRead = annotationReader && annotationReader.sessionId === state?.session.id ? annotationReader.draftId ? draft?.id === annotationReader.draftId ? draft.annotations.find(annotation => annotation.id === annotationReader.annotation.id) : undefined : annotationReader.annotation : undefined;
  const readerEditable = !!annotationRead && !!annotationReader?.draftId && !!draft?.editingTaskId;
  const projectedAnnotations = (inspectableTask?.snapshot.annotations || []).filter(annotation => annotation.objectIds.every(id => { const current = objects.find(object => object.id === id), original = inspectableTask?.snapshot.referenceContent.objects.find(object => object.id === id); return !!current && (!original || original.assetId === current.assetId); })).map(annotation => ({ ...annotation, inspectionTaskId: inspectableTask!.id }));
  const allAnnotations: (AnnotationInput & { inspectionTaskId?: string })[] = inspectableTask && !viewingEditedTask ? projectedAnnotations : draft?.annotations || [];
  const pendingComments = [...comments.current.values()].filter(edit => edit.sessionId === state?.session.id && edit.draftId === draft?.id && edit.value.text.trim());
  const unavailableComments = [...comments.current].filter(([, edit]) => pendingComments.includes(edit) && edit.value.objectIds.some(id => !scope.current.objectIds.has(id)));
  const hasRequest = !!(draft?.text.trim() || draft?.attachments.length || draft?.annotations.length || pendingComments.length);
  function annotationBounds(annotation: AnnotationInput): Rect | undefined {
    if (annotation.coordinateSpace === 'world') return annotation.bounds;
    const object = objects.find(object => object.id === annotation.objectId && (!annotation.assetId || object.assetId === annotation.assetId));
    if (object) return objectRegion(annotation.bounds, mediaContentRect(object, mediaSizes[object.id]));
    const original = (!inspectableTask || viewingEditedTask) && editingSourceTask?.snapshot.referenceContent.objects.find(object => object.id === annotation.objectId);
    return original ? objectRegion(annotation.bounds, original) : undefined;
  }
  function annotationDisplayBounds(annotation: AnnotationInput): Rect {
    const sources = annotation.objectIds.flatMap(id => {
      const current = objects.find(object => object.id === id);
      const original = editingSourceTask?.snapshot.referenceContent.objects.find(object => object.id === id);
      return current || original ? [current || original!] : [];
    });
    return sources.length ? unionBounds(sources) : annotation.bounds;
  }
  const editingObject = comment?.value.objectId ? objects.find(object => object.id === comment.value.objectId) : undefined;
  const editingBounds = !inspectableTask && annotating && comment ? markPreview || (comment.value.coordinateSpace === 'normalized' && editingObject ? objectRegion(comment.value.bounds, mediaContentRect(editingObject, mediaSizes[editingObject.id])) : comment.value.bounds) : undefined;

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
  useEffect(() => {
    const close = (event: globalThis.PointerEvent) => { if (!dock.current?.contains(event.target as Node)) { setQueueExpanded(false); setQueueHovered(false); setQueueFocused(false); clearInspection(); setTaskDetailId(''); } };
    document.addEventListener('pointerdown', close);
    return () => { document.removeEventListener('pointerdown', close); window.clearTimeout(queueCloseTimer.current); };
  }, []);
  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    const wheel = (event: WheelEvent) => {
      if ((event.target as HTMLElement).closest('[data-canvas-control]')) return;
      event.preventDefault();
      const current = wheelState.current;
      if (current.disabled || gesture.current) return;
      fitMotion.interrupt();
      const rect = element.getBoundingClientRect();
      if (event.ctrlKey || event.metaKey) board.updateView({ ...current.view, ...zoomAt(current.view, Math.exp(-event.deltaY * .005), { x: event.clientX - rect.left, y: event.clientY - rect.top }) }, current.sessionId);
      else board.updateView({ ...current.view, x: current.view.x - event.deltaX, y: current.view.y - event.deltaY }, current.sessionId);
    };
    element.addEventListener('wheel', wheel, { passive: false });
    return () => element.removeEventListener('wheel', wheel);
  }, [!!state, board.updateView, fitMotion.interrupt]);
  useEffect(() => { if (!notice) return; const timer = setTimeout(() => setNotice(''), 2800); return () => clearTimeout(timer); }, [notice]);

  const viewUpdate = (next: Partial<SessionView>) => { if (!disabled && state) { fitMotion.interrupt(); board.updateView({ ...view, ...next }, state.session.id); } };
  const selectObjects = (ids: string[]) => viewUpdate({ selectedObjectIds: unique(ids) });
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
        let width = 280, height = asset.kind === 'file' ? 150 : 210;
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
    const existing = comments.current.get(commentKey);
    if (existing) return existing;
    if (!state || !draft || disabled || !selected.length) return;
    const targets = selected, bounds = unionBounds(targets.map(contentBounds));
    const single = targets.length === 1 ? targets[0] : undefined;
    const value: AnnotationInput = { id: crypto.randomUUID(), scope: single ? 'object' : 'region', objectId: single?.id, objectIds: targets.map(object => object.id), assetId: single?.assetId, bounds: single ? normalizedRegion(bounds, contentBounds(single)) : bounds, coordinateSpace: single ? 'normalized' : 'world', text: '' };
    if (value.bounds.width <= 0 || value.bounds.height <= 0) { setNotice('Select an area inside the image or video.'); return; }
    let snapshot: Promise<Blob | undefined> | undefined;
    let frameNote: string | undefined;
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
    const edit = { value, sessionId: state.session.id, draftId: draft.id, snapshot, frameNote, end: '' };
    comments.current.set(commentKey, edit); setCommentRevision(revision => revision + 1);
    return edit;
  }

  function clearInspection() { cancelAnimationFrame(readerFocusFrame.current); setInspectedTaskId(''); setAnnotationReader(null); }

  function closeAnnotation() { cancelAnimationFrame(readerFocusFrame.current); const trigger = readerTrigger.current; setAnnotationReader(null); readerFocusFrame.current = requestAnimationFrame(() => { if (trigger?.isConnected) trigger.focus({ preventScroll: true }); else instruction.current?.focus({ preventScroll: true }); }); }

  function exitAnnotation() { setAnnotatingKey(''); setMarkPreview(null); if (gesture.current?.kind === 'mark') gesture.current = null; }

  function enterAnnotation() {
    const edit = beginComment();
    if (!edit) return;
    clearInspection(); setAligningKey(''); setMode('select'); setAnnotatingKey(commentKey); setMarkPreview(null);
    if (edit.value.objectId && edit.value.timeStart !== undefined) { const video = videoRefs.current.get(edit.value.objectId); if (video) { video.pause(); video.currentTime = edit.value.timeStart; } }
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
    if (inDraft) clearInspection();
    exitAnnotation(); setAligningKey('');
    if (annotation.objectId && annotation.timeStart !== undefined) {
      const video = videoRefs.current.get(annotation.objectId);
      if (video) { video.pause(); video.currentTime = annotation.timeStart; }
    }
    setAnnotationReader({ annotation, sessionId: state.session.id, ...(inDraft ? { draftId: draft.id } : {}) });
    if (inDraft && draft.editingTaskId) readerFocusFrame.current = requestAnimationFrame(() => annotationInput.current?.focus({ preventScroll: true }));
  }

  const sameScope = (edit: { sessionId: string; draftId: string }) => scope.current.sessionId === edit.sessionId && scope.current.draftId === edit.draftId;

  async function persistComment(key: string, edit: CommentEdit) {
      if (!sameScope(edit)) throw new Error('This draft has changed. Your comment remains with its original request.');
      const checkTargets = () => { if (edit.value.objectIds.some(id => !scope.current.objectIds.has(id))) throw new Error('This comment refers to a removed file. Discard it from the draft to continue.'); };
      checkTargets();
      const end = edit.end.trim() ? Number(edit.end) : undefined;
      if (end !== undefined && (!Number.isFinite(end) || end < (edit.value.timeStart || 0))) throw new Error('The end time must be at or after the current timestamp.');
      const blob = await edit.snapshot;
      if (!sameScope(edit)) throw new Error('This draft has changed. Your comment remains with its original request.');
      checkTargets();
      if (blob && !edit.value.snapshotAssetId) edit.value.snapshotAssetId = (await board.api.upload(blob, `video-frame-${timeLabel(edit.value.timeStart || 0).replace(':', '-')}.png`)).id;
      if (!sameScope(edit)) throw new Error('This draft has changed. Your comment remains with its original request.');
      checkTargets();
      const value = { ...edit.value, text: edit.value.text.trim(), timeEnd: end };
      const attached = board.changeDraftFor(edit.sessionId, edit.draftId, current => ({ ...current, annotations: [...current.annotations.filter(annotation => annotation.id !== value.id), value] }));
      if (!attached) throw new Error('This draft has changed. Your comment remains with its original request.');
      await board.flushDraft(edit.sessionId);
      if (!sameScope(edit)) throw new Error('This draft has changed. Your comment remains with its original request.');
      comments.current.delete(key); setCommentRevision(revision => revision + 1);
  }

  async function removeSelection() {
    if (!selected.length || disabled) return;
    const owner = { ...scope.current }, ids = new Set(selectedIds);
    setRemovingObjects(true);
    try {
      await board.operations(selected.map(object => ({ type: 'delete', objectId: object.id, expectedVersion: object.version })), owner.sessionId);
      for (const [key, edit] of comments.current) if (edit.sessionId === owner.sessionId && edit.draftId === owner.draftId && edit.value.objectIds.some(id => ids.has(id))) comments.current.delete(key);
      setCommentRevision(revision => revision + 1); selectObjects([]);
    } catch { /* The service error and original input remain available. */ }
    finally { setRemovingObjects(false); }
  }

  async function saveComment() {
    const edit = comments.current.get(commentKey);
    if (!edit?.value.text.trim() || committing.current || disabled) return;
    committing.current = true; setAnnotationSaving(true);
    try { await persistComment(commentKey, edit); exitAnnotation(); }
    catch (cause) { board.showError(cause); }
    finally { committing.current = false; setAnnotationSaving(false); }
  }

  async function sendRequest() {
    if (!hasRequest || disabled || committing.current || uploads.length || board.draftConflict) return;
    const owner = { ...scope.current };
    committing.current = true; setAnnotationSaving(true);
    try {
      for (const [key, edit] of comments.current) if (edit.sessionId === owner.sessionId && edit.draftId === owner.draftId && edit.value.text.trim()) await persistComment(key, edit);
      await board.flushDraft(owner.sessionId);
      if (!sameScope(owner)) throw new Error('The request scope has changed. Continue in the original draft.');
      const task = await board.send();
      if (task && (task.draftId === owner.draftId || task.lastEditDraftId === owner.draftId) && task.sessionId === scope.current.sessionId) {
        clearInspection(); exitAnnotation(); setTaskDetailId('');
        setHistoryOpen(false); setSentTaskId(task.id);

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
    if (active.kind === 'resize') { const object = active.objects[0], result = snapResize(object, active.resizeCorner || 'se', delta, state?.objects || [], active.view, size, bypass); active.preview = { [object.id]: result.bounds }; setPreview(active.preview); setSnapGuides(result.guides); return; }
    const result = !bypass ? snapTranslation(active.objects, state?.objects || [], delta, active.view, size) : { delta, guides: [] };
    active.preview = Object.fromEntries(active.objects.map(object => [object.id, { x: object.x + result.delta.x, y: object.y + result.delta.y, width: object.width, height: object.height }]));
    setPreview(active.preview); setSnapGuides(result.guides);
  }
  updateDrag.current = previewMove;

  function pointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (disabled || layoutBusy.current || !state || event.button !== 0 || (event.target as HTMLElement).closest('[data-canvas-control]')) return;
    fitMotion.interrupt();
    canvas.current?.focus({ preventScroll: true });
    const point = localPoint(event);
    const objectId = (event.target as HTMLElement).closest<HTMLElement>('[data-object-id]')?.dataset.objectId;
    const resizeId = (event.target as HTMLElement).closest<HTMLElement>('[data-resize-id]')?.dataset.resizeId;
    const effectiveMode = spacePan ? 'pan' : mode;
    const object = objects.find(value => value.id === objectId);
    if (annotating && !spacePan && (!object || !selectedIds.includes(object.id))) exitAnnotation();
    else if (!resizeId && annotating && !spacePan && selected.every(value => value.type === 'image' || value.type === 'video')) {
      const edit = beginComment();
      if (!edit) return;
      const bounds = unionBounds(selected.map(contentBounds)), world = screenToWorld(point, view);
      if (world.x < bounds.x || world.y < bounds.y || world.x > bounds.x + bounds.width || world.y > bounds.y + bounds.height) return;
      setSnapGuides([]);
      gesture.current = { kind: 'mark', start: point, point, moved: false, view, objects: selected, sessionId: state.session.id, commentKey, markBounds: bounds };
      event.currentTarget.setPointerCapture(event.pointerId); event.preventDefault(); return;
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
    gesture.current = { kind, start: point, point, moved: false, view, objects: moving, sessionId: state.session.id, resizeCorner: (event.target as HTMLElement).closest<HTMLElement>('[data-resize-corner]')?.dataset.resizeCorner as ResizeCorner | undefined };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  }

  function pointerMove(event: ReactPointerEvent<HTMLDivElement>) {
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
      if (edit && sameScope(edit) && active.region && active.region.width * active.view.zoom >= 3 && active.region.height * active.view.zoom >= 3) { edit.value.bounds = edit.value.coordinateSpace === 'normalized' ? normalizedRegion(active.region, active.markBounds!) : active.region; setCommentRevision(revision => revision + 1); }
      setMarkPreview(null); commentInput.current?.focus({ preventScroll: true }); return;
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
    try { await board.editTask(task.id, cancel); clearInspection(); exitAnnotation(); setTaskDetailId(''); setQueueExpanded(false); requestAnimationFrame(() => instruction.current?.focus({ preventScroll: true })); }
    finally { setEditingTask(false); }
  }

  function hoverQueue() { window.clearTimeout(queueCloseTimer.current); setQueueHovered(true); }
  function leaveDock() { queueCloseTimer.current = window.setTimeout(() => { setQueueHovered(false); if (!dock.current?.contains(document.activeElement)) { setQueueExpanded(false); if (!canvas.current?.querySelector('.inline-annotation-reader')) clearInspection(); setTaskDetailId(''); } }, 140); }


  const taskCard = (task: Task, compact = false) => <TaskCard compact={compact} summary={compact && taskDetailId !== task.id} task={task} assets={assets} objects={objects} content={id => board.api.content(id)} locateAsset={locateAsset} onAnnotationView={(value, open) => { if (open) { exitAnnotation(); setInspectedTaskId(value.id); setAnnotationReader(null); } else if (historyOpen) { setInspectedTaskId(current => current === value.id ? '' : current); setAnnotationReader(null); } }}/>;
  const composer = state && draft && <section ref={dock} className="creation-dock" data-canvas-control aria-label="Request composer and queue" onPointerLeave={leaveDock} onPointerEnter={() => window.clearTimeout(queueCloseTimer.current)} onKeyDown={event => { if (event.key === 'Escape') { clearInspection(); setTaskDetailId(''); setQueueExpanded(false); setQueueHovered(false); setQueueFocused(false); instruction.current?.focus(); } }} onDragOver={event => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); event.stopPropagation(); } }} onDrop={event => { const files = filesFromTransfer(event.dataTransfer); if (files.length) { event.preventDefault(); event.stopPropagation(); void importFiles(files); } }}>
    {(pending > 0 || historyOpen) && <div className={`queue-stack ${queueOpen ? 'expanded' : ''} ${pending > 1 && !historyOpen ? 'has-stack' : ''}`} data-pending={pending} onPointerEnter={event => { if (event.pointerType === 'mouse') hoverQueue(); }} onFocusCapture={event => { if ((event.target as HTMLElement).matches(':focus-visible')) setQueueFocused(true); }} onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setQueueFocused(false); }}>
      {pending > 1 && !historyOpen && <div className="queue-peeks" aria-hidden="true">{Array.from({ length: Math.min(pending - 1, 2) }, (_, index) => <span key={index} style={{ '--peek': index + 1 } as React.CSSProperties}/>)}</div>}
      {historyOpen ? <div className="queue-list history-list" id="request-history" role="region" aria-label="Request history"><div className="inline-heading"><span>Request history</span><IconButton label="Close request history" onClick={() => { clearInspection(); setHistoryOpen(false); document.querySelector<HTMLButtonElement>('.history-toggle')?.focus(); }}><ChevronDown size={14}/></IconButton></div>{state.tasks.length ? [...state.tasks].reverse().map(task => <div key={task.id}>{taskCard(task)}</div>) : <p className="field-hint">Your requests, progress and receipts appear here.</p>}</div> : <div className="queue-list" id="creation-queue" role="list" aria-label="Task queue">
        {queuedTasks.map((task, index) => <div key={task.id} className={index ? `queue-extra ${queueOpen ? 'open' : ''}` : 'queue-first'} inert={index > 0 && !queueOpen} aria-hidden={index > 0 && !queueOpen}><div className="queue-extra-content"><QueueItem task={task} detailOpen={taskDetailId === task.id} visible={queueOpen || index === 0} animateSend={sentTaskId === task.id} played={playedSendIds.current}>
          <div className={`queue-row ${taskDetailId === task.id ? 'detail-open' : ''}`}><button type="button" className="queue-task" aria-label={`View request ${task.sequence}: ${task.snapshot.userRequest.text || 'Attachments and annotations'} — ${statusLabels[task.status]}`} aria-expanded={taskDetailId === task.id} aria-controls={`request-details-${task.id}`} onClick={() => toggleTaskDetail(task)}>{task.status === 'queued' && <span className="queue-task-mark" aria-hidden="true"><Circle size={14}/></span>}<span className="queue-title" data-queue-layout="title">{task.snapshot.userRequest.text || 'Create from the attachments and annotations.'}</span></button>
          {['blocked', 'interrupted', 'editing'].includes(task.status) && <span className={`status-badge status-${task.status}`} aria-hidden="true">{statusLabels[task.status]}</span>}{task.status === 'queued' && <IconButton label={`Edit request ${task.sequence}`} disabled={disabled || !!draft.editingTaskId} onClick={() => void editRequest(task)}><Pencil size={14}/></IconButton>}{['queued', 'blocked', 'interrupted'].includes(task.status) && <IconButton label={`Cancel request ${task.sequence}`} disabled={disabled || !!cancellingTask} onClick={() => void cancelTask(task)}>{cancellingTask === task.id ? <LoaderCircle size={14} className="spin"/> : <Trash2 size={14}/>}</IconButton>}{taskDetailId === task.id && <IconButton label="Collapse request details" onClick={() => { clearInspection(); setTaskDetailId(''); document.querySelector<HTMLButtonElement>(`.queue-item[data-task-id="${task.id}"] .queue-task`)?.focus({ preventScroll: true }); }}><ChevronDown size={14}/></IconButton>}</div>
          <MotionDisclosure open={taskDetailId === task.id} className="inline-task-detail" id={`request-details-${task.id}`} role="region" aria-label={`Request ${task.sequence}`}>{taskCard(task, true)}</MotionDisclosure>
        </QueueItem></div></div>)}
      </div>}
      {!historyOpen && pending > 1 && <button type="button" className="queue-expand" aria-label={`${pending} requests`} aria-expanded={queueOpen} aria-controls="creation-queue" onClick={() => setQueueExpanded(current => !current)}>{pending}<ChevronDown size={12}/></button>}
    </div>}
    {board.draftConflict && <section className="draft-conflict" aria-label="Resolve draft update"><strong>Draft updated elsewhere</strong><div className="conflict-comparison">{[{ label: 'Your input', value: draft }, { label: 'Saved draft', value: board.draftConflict }].map(item => <section key={item.label}><h3>{item.label}</h3><p className="conflict-text">{item.value?.text || 'No text yet'}</p><div className="conflict-references"><span>{item.value?.attachments.length || 0} attachments · {item.value?.annotations.length || 0} annotations</span>{item.value?.attachments.map(id => <small key={id}>{assetFor(id)?.name || id}</small>)}{item.value?.annotations.map(annotation => <small key={annotation.id}>{annotation.text}</small>)}</div></section>)}</div><div className="inline-actions"><button type="button" className="button" disabled={resolvingConflict} onClick={() => { setResolvingConflict(true); void board.resolveDraftConflict('remote').catch(board.showError).finally(() => setResolvingConflict(false)); }}>Use saved draft</button><button type="button" className="button primary" disabled={resolvingConflict} onClick={() => { setResolvingConflict(true); void board.resolveDraftConflict('local').catch(board.showError).finally(() => setResolvingConflict(false)); }}>{resolvingConflict ? 'Saving…' : 'Keep your draft'}</button></div></section>}
    {!!unavailableComments.length && <div className="unavailable-comments" aria-label="Unavailable comments">{unavailableComments.map(([key, edit]) => <div key={key}><span>Removed file · {edit.value.text}</span><IconButton label="Discard unavailable comment" onClick={() => { comments.current.delete(key); board.changeDraft(current => ({ ...current, annotations: current.annotations.filter(annotation => annotation.id !== edit.value.id) })); setCommentRevision(revision => revision + 1); board.setError(''); }}><Trash2 size={14}/></IconButton></div>)}</div>}
    {copyCommand && <section className="inline-resume" aria-label="Resume prompt"><div className="inline-heading"><span>Resume prompt</span><IconButton label="Close resume prompt" onClick={() => setCopyCommand('')}><X size={14}/></IconButton></div><textarea aria-label="Resume prompt text" readOnly value={copyCommand} rows={3} onFocus={event => event.target.select()}/></section>}
    <form className="composer" data-compact={!composerFocused && !hasRequest && !pending} onFocusCapture={() => setComposerFocused(true)} onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setComposerFocused(false); }} aria-label="Request draft" data-save-state={board.saveState} onSubmit={event => { event.preventDefault(); if (!composing.current && !commentComposing.current) void sendRequest(); }}>
    {draft.editingTaskId && <div className="composer-editing"><span>Editing request {state.tasks.find(task => task.id === draft.editingTaskId)?.sequence}</span><button type="button" disabled={disabled} onClick={() => { const task = state.tasks.find(task => task.id === draft.editingTaskId); if (task) void editRequest(task, true); }}>Cancel edit</button></div>}
    {!!(draft.attachments.length || draft.annotations.length) && <div className="draft-attachments" aria-label="Request attachments">{draft.attachments.map(id => { const asset = assetFor(id); return <div className="draft-asset" key={id}><AssetThumb asset={asset} src={board.api.content(id)}/><span title={asset?.name}>{asset?.name || 'Loading file'}</span><IconButton label={`Remove attachment ${asset?.name || id}`} disabled={disabled} onClick={() => board.changeDraft(current => ({ ...current, attachments: current.attachments.filter(value => value !== id), references: { ...current.references, objectIds: current.references.objectIds.filter(objectId => { const object = state.tasks.find(task => task.id === current.editingTaskId)?.snapshot.referenceContent.objects.find(value => value.id === objectId) || state.objects.find(value => value.id === objectId); return !!object && object.assetId !== id; }) } }))}><X size={13}/></IconButton></div>; })}{draft.annotations.map((annotation, index) => <div className="draft-annotation" key={annotation.id}><button type="button" className="annotation-content" onClick={() => openAnnotation(annotation, true)}><AnnotationBubble number={index + 1} size={24}/><span>{annotation.text}{annotation.timeStart !== undefined && <small> · {timeLabel(annotation.timeStart)}</small>}</span></button><IconButton label={`Remove annotation ${index + 1}`} disabled={disabled} onClick={() => board.changeDraft(current => ({ ...current, annotations: current.annotations.filter(value => value.id !== annotation.id) }))}><X size={13}/></IconButton></div>)}</div>}
      <div className="composer-input-row">
      <label className="sr-only" htmlFor="instruction">Request</label><textarea ref={instruction} id="instruction" rows={1} placeholder="What would you like to create?" value={draft.text} readOnly={board.projectChanged} disabled={board.switching || board.sending || annotationSaving} onChange={event => board.changeDraft(current => ({ ...current, text: event.target.value }))} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }} onKeyDown={event => { if (event.key !== 'Enter' || event.shiftKey || composing.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return; event.preventDefault(); void sendRequest(); }}/><button className="send-button" type="submit" disabled={disabled || !!uploads.length || !!board.draftConflict || !hasRequest} aria-label={draft.editingTaskId ? "Save request" : "Send request"}>{board.sending || annotationSaving ? <LoaderCircle size={17} className="spin"/> : <ArrowUp size={16}/>}</button>
      </div>
    </form>
    <div className="dock-footer"><IconButton className="history-toggle" label="Request history" aria-expanded={historyOpen} aria-controls="request-history" onClick={() => { clearInspection(); exitAnnotation(); setHistoryOpen(current => !current); setTaskDetailId(''); }}><History size={15}/></IconButton><IconButton label="Copy resume prompt" onClick={() => void copyResume()}><Copy size={15}/></IconButton></div>
  </section>;

  const notificationList = <aside ref={notifications} className="notification-stack" aria-label="Notifications">
    {(board.error || board.projectChanged) && <div className="error-banner" role="alert"><span>{board.error || 'This address now serves another project. Your draft is preserved. Reopen the board to continue.'}</span>{!state ? <button onClick={() => window.location.reload()}>Reconnect</button> : board.projectChanged ? <button onClick={() => window.location.assign(window.location.pathname)}>Reopen board</button> : board.saveState === 'failed' && <button onClick={() => void board.flushDraft().catch(() => undefined)}>Retry saving</button>}<IconButton label="Dismiss error" disabled={board.projectChanged} onClick={() => board.setError('')}><X size={15}/></IconButton></div>}
    {!!state && board.connection !== 'connected' && !board.projectChanged && <div className="connection-feedback" role="status"><LoaderCircle size={14} className="spin"/>{board.connection === 'reconnecting' ? 'Reconnecting…' : 'Connecting…'}</div>}
    {!!uploads.length && <div className="upload-list" aria-live="polite">{uploads.map(upload => <div key={upload.id}><LoaderCircle size={15} className="spin"/><span>Importing {upload.name}</span><IconButton label={`Cancel import ${upload.name}`} onClick={() => upload.controller.abort()}><X size={15}/></IconButton></div>)}</div>}
    {notice && <div className="toast" role="status"><Check size={14}/><span>{notice}</span></div>}
  </aside>;

  if (!state || !draft) return <><main className="startup"><span className="brand">acanvas<span>●</span></span>{board.error ? <h1>Unable to open the board</h1> : <><LoaderCircle size={24} className="spin"/><p>Opening your board…</p></>}</main>{notificationList}</>;

  return <div className="app-shell"><a className="skip-link" href="#whiteboard">Skip to canvas</a>
    <main className="canvas-main"><div id="whiteboard" className={`whiteboard mode-${annotating && !spacePan ? 'annotate' : spacePan ? 'pan' : mode} ${dragOver ? 'drag-over' : ''} ${board.switching ? 'is-loading' : ''}`} ref={canvas} tabIndex={0} role="region" aria-label="Project board. Enter selects files, arrow keys move them, and Space pans the canvas." onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={() => { gesture.current = null; setPreview({}); setSelectionRect(null); setSnapGuides([]); setMarkPreview(null); }} onKeyDown={event => { if (event.target !== event.currentTarget || disabled) return; if (event.key === ' ') { event.preventDefault(); setSpacePan(true); } if (event.key === 'Escape') { if (annotating) exitAnnotation(); else if (aligning) exitAlignment(); else { clearInspection(); selectObjects([]); setMode('select'); } } if (event.key === '+' || event.key === '=') { event.preventDefault(); zoom(1.2); } if (event.key === '-') { event.preventDefault(); zoom(1 / 1.2); } }} onKeyUp={event => { if (event.key === ' ') setSpacePan(false); }} onBlur={() => setSpacePan(false)} onDragOver={event => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); setDragOver(true); } }} onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragOver(false); }} onDrop={event => { event.preventDefault(); setDragOver(false); void importFiles(filesFromTransfer(event.dataTransfer), localPoint(event)); }}>
      <div className="canvas-world" style={{ transform: `translate(${view.x}px,${view.y}px) scale(${view.zoom})` }}>{objects.map((object, index) => { const asset = assetFor(object.assetId); const isSelected = selectedIds.includes(object.id); return <article key={object.id} className={`board-object object-${object.type} ${isSelected ? 'selected' : ''}`} data-object-id={object.id} data-object-version={object.version} data-selected={isSelected || undefined} style={{ left: object.x, top: object.y, width: object.width, height: object.height }} tabIndex={0} role="group" aria-label={`${asset?.name || 'File'}${isSelected ? ', selected' : ''}`} onKeyDown={event => { if (event.target !== event.currentTarget || disabled) return; if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); selectObjects(event.shiftKey ? unique([...selectedIds, object.id]) : [object.id]); } const delta = { ArrowLeft: [-10, 0], ArrowRight: [10, 0], ArrowUp: [0, -10], ArrowDown: [0, 10] }[event.key]; if (delta) { event.preventDefault(); event.stopPropagation(); void board.operations([{ type: 'update', objectId: object.id, expectedVersion: object.version, changes: { x: object.x + delta[0], y: object.y + delta[1] } }]).catch(() => undefined); } }}>
        <div className="object-media">{object.type === 'image' && !mediaErrors[object.id] && <img src={board.api.content(object.assetId)} alt={asset?.name || 'Imported image'} draggable={false} onLoad={event => { const size = { width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight }; setMediaSizes(current => ({ ...current, [object.id]: size })); }} onError={() => setMediaErrors(current => ({ ...current, [object.id]: true }))}/>} {object.type === 'video' && !mediaErrors[object.id] && <video playsInline preload="metadata" tabIndex={-1} src={board.api.content(object.assetId)} ref={element => { if (element) videoRefs.current.set(object.id, element); else videoRefs.current.delete(object.id); }} onLoadedMetadata={event => { const size = { width: event.currentTarget.videoWidth, height: event.currentTarget.videoHeight }; setMediaSizes(current => ({ ...current, [object.id]: size })); }} onError={() => setMediaErrors(current => ({ ...current, [object.id]: true }))}/>} {(object.type === 'file' || mediaErrors[object.id]) && <div className="file-card"><File size={32} strokeWidth={1.25}/><strong>{asset?.name || 'File'}</strong><span>{mediaErrors[object.id] ? 'Preview unavailable in this browser' : `${asset?.mime || 'Attachment'} · ${bytes(asset?.size || 0)}`}</span><a data-canvas-control href={board.api.content(object.assetId)} download={asset?.name} onPointerDown={event => event.stopPropagation()}><ArrowDownToLine size={13}/>Download file</a></div>}</div>
        <div className="object-caption"><span className="object-index">{String(index + 1).padStart(2, '0')}</span><span title={asset?.name}>{asset?.name || 'File'}</span>{object.sourceTaskId && <span className="generated-label">Output</span>}</div>{isSelected && (['nw', 'ne', 'sw', 'se'] as ResizeCorner[]).map(corner => <button key={corner} type="button" className="resize-handle" data-resize-id={object.id} data-resize-corner={corner} aria-label={`Resize ${asset?.name || 'File'} ${ { nw: 'top left', ne: 'top right', sw: 'bottom left', se: 'bottom right' }[corner]}`} onKeyDown={event => { if (!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key) || layoutBusy.current || disabled) return; event.preventDefault(); event.stopPropagation(); const delta = { x: event.key === 'ArrowRight' ? 10 : event.key === 'ArrowLeft' ? -10 : 0, y: event.key === 'ArrowDown' ? 10 : event.key === 'ArrowUp' ? -10 : 0 }; const bounds = resizeBounds(object, corner, delta); void writeLayout([{ type: 'update', objectId: object.id, expectedVersion: object.version, changes: bounds }], state.session.id); }}/>) }</article>; })}
      {allAnnotations.map(annotation => { const bounds = annotationBounds(annotation); if (!bounds) return null; return <div className={`annotation-outline ${!annotation.inspectionTaskId ? 'draft-outline' : ''}`} key={`${annotation.inspectionTaskId || 'draft'}-${annotation.id}`} data-annotation-id={annotation.id} data-annotation-source={annotation.inspectionTaskId ? 'task' : 'draft'} data-source-removed={annotation.objectIds.some(id => !objects.some(object => object.id === id)) || undefined} style={{ borderWidth: 1 / view.zoom, left: bounds.x, top: bounds.y, width: bounds.width, height: bounds.height }}/>; })}
      {editingBounds && <div className="annotation-outline editing-outline" data-annotation-source="editing" style={{ left: editingBounds.x, top: editingBounds.y, width: editingBounds.width, height: editingBounds.height, borderWidth: 1 / view.zoom }}/>}
      {!!snapGuides.length && <svg className="alignment-guides" aria-hidden="true">{snapGuides.map(guide => <line key={guide.axis} data-snap-axis={guide.axis} vectorEffect="non-scaling-stroke" x1={guide.axis === 'x' ? guide.position : guide.start} y1={guide.axis === 'y' ? guide.position : guide.start} x2={guide.axis === 'x' ? guide.position : guide.end} y2={guide.axis === 'y' ? guide.position : guide.end}/>)}</svg>}
      {selectionRect && <div className="selection-rect" style={{ left: selectionRect.x, top: selectionRect.y, width: selectionRect.width, height: selectionRect.height }}/>}</div>
      {allAnnotations.map((annotation, index) => { const bounds = annotationBounds(annotation); if (!bounds) return null; const active = annotationRead?.id === annotation.id && !!annotationReader?.draftId === !annotation.inspectionTaskId; return <CanvasAnnotationNote key={`${annotation.inspectionTaskId || 'draft'}-${annotation.id}`} canvas={canvas} bounds={annotationDisplayBounds(annotation)} number={index + 1} onOpen={() => openAnnotation(annotation, !annotation.inspectionTaskId)} view={view} annotationId={annotation.id} active={active} control={{ text: annotation.text, controls: !draft.editingTaskId, compositionRef: active ? commentComposing : undefined, regionLabel: active ? 'Annotation' : undefined, mode: active ? readerEditable ? 'edit' : 'view' : 'display', inputLabel: active ? readerEditable ? 'Annotation text' : 'Annotation comment' : `Comment ${index + 1}: ${annotation.text}`, inputRef: active ? annotationInput : undefined, disabled: active && disabled, backLabel: 'Close annotation', onOpen: draft.editingTaskId && !annotation.inspectionTaskId ? () => openAnnotation(annotation, true) : undefined, onBack: closeAnnotation, onSubmit: closeAnnotation, onChange: text => { const owner = annotationReader; if (owner?.draftId) board.changeDraftFor(owner.sessionId, owner.draftId, current => ({ ...current, annotations: current.annotations.map(value => value.id === owner.annotation.id ? { ...value, text } : value) })); } }}/>; })}
      {!objects.length && <div className="canvas-empty"><div className="empty-mark"><ImagePlus size={31} strokeWidth={1.25}/></div><h1>Drop files to start</h1><p>Images, videos and files. Or paste from your clipboard.</p></div>}
      {dragOver && <div className="drop-indicator"><Upload size={28}/><span>Drop files onto the canvas</span></div>}
      {!annotationRead && annotating && <AnnotationCommentControl key={commentKey} controlRef={selectionActions} inputRef={commentInput} compositionRef={commentComposing} className="context-control" controls={!draft.editingTaskId} mode="edit" inputLabel="Add a comment" text={comment?.value.text || ''} disabled={disabled} saving={annotationSaving} onBack={exitAnnotation} onSubmit={() => void saveComment()} onChange={text => { const edit = beginComment(); if (edit) { edit.value.text = text; setCommentRevision(revision => revision + 1); } }}>{comment?.value.timeStart !== undefined && <div className="comment-video-meta"><span>{timeLabel(comment.value.timeStart)}</span><label>End time<input type="number" min={comment.value.timeStart} step="0.1" placeholder="Optional" value={comment.end} disabled={disabled} onChange={event => { comment.end = event.target.value; setCommentRevision(revision => revision + 1); }}/></label>{comment.frameNote && <span title={comment.frameNote}>Timestamp only</span>}</div>}</AnnotationCommentControl>}
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
