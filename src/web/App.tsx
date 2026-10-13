import { randomId } from './random-id.js';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from 'react';
import { AlignCenterHorizontal, AlignCenterVertical, AlignEndHorizontal, AlignEndVertical, AlignStartHorizontal, AlignStartVertical, ArrowDownToLine, ArrowLeft, ArrowUp, FolderInput, FolderOutput, Check, ChevronDown, Circle, Copy, Ellipsis, Hand, History, LoaderCircle, Maximize, Minus, Monitor, Moon, MousePointer2, Palette, Pause, Pencil, PencilLine, Play, Plus, Redo2, Sun, Trash2, Type, Undo2, Upload, X } from 'lucide-react';
import { DominoLoader } from './DominoLoader';
import type { AnnotationInput, Asset, BaseSceneSnapshot, BoardGroup, BoardObject, BoardOperation, CaptureView, Draft, RequestReference, SessionView, Task, TaskStatus } from '../shared/types';
import { alignedPositions, fitView, screenBounds, intersects, mediaContentRect, normalizedRegion, objectRegion, rectangle, screenToWorld, resizeBounds, resizeViewportBounds, snapViewportResize, snapResize, snapTranslation, unionBounds, zoomAt, type Alignment, type Point, type Rect, type SnapGuide, type ResizeCorner, type ResizeHandle } from './geometry';
import { GroupName } from './GroupName';
import { GroupFolder } from './GroupFolder';
import { groupDisplayBounds, groupFrameBounds } from '../shared/groups';
import { useBoard } from './useBoard';
import { useAnimatedView } from './useAnimatedView';
import { filesFromTransfer } from './import';
import { useComposerLayout, useContextualControls, useNotificationLayout } from './useCanvasLayout';
import { AnnotationBubble } from './AnnotationBubble';
import type { BoardApi } from './api';
import { canvasWheelView, routesWheelToCanvas, type CanvasWheelInput } from './canvas-wheel';
import { attachCanvasGestures, type CanvasPointerInput } from './canvas-gestures';
import { AssetThumb, ContentRenderer, ThumbHoverPreview } from './ContentRenderer';
import { contentCapabilities, noteFillColor, noteMime, resolveContentKind, resolveContentMime, type NoteFill } from '../shared/content-types';
import { CanvasAnnotationNote } from './CanvasAnnotationNote';
import { annotationPinCenters } from './annotation-note-layout';
import { NotificationStack, useNotices, type Notification } from './NotificationStack';
import { AnnotationTimeRange } from './AnnotationTimeRange';
import { videoFrameAt } from './videoFrameAt';
import { GroupReferenceIcon, ReferenceSearch, referenceCandidates, type ReferenceCandidate } from './ChatboxReferences';
import { ChatboxEditor, type ChatboxEditorHandle, type EditorCaret } from './ChatboxEditor';
import { referenceLabel, referenceParts, snapshotReferences } from '../shared/task-message';
import { annotationTarget, requestedMarkdownAnchor, presentedMarkTarget } from './annotation-scene';
import type { BrowserCaptureIdentity, SceneEvidenceFrame } from '../shared/browser-capture';
import { SceneContentContext, SceneContentRegistry } from './scene-renderer/content';
import { SceneEvidenceRenderer, freezeBoardScene, frozenSceneMatches, presentedCaptureScene, replaceFrozenFrames, useProjectScene, type FrozenBoardScene } from './scene-renderer/board';
import type { PreparedSceneCapture, ProjectCaptureCoordinator } from './project-capture-provider';
import { pendingEvidence, removePendingEvidence, savePendingEvidence } from './scene-renderer/pending-evidence';
import { readThemePreference, themeFromPreference, type ThemePreference } from './theme';
import { useTaskQueue } from './useTaskQueue';

const statusLabels: Record<TaskStatus, string> = { queued: 'Queued', editing: 'Editing', running: 'Running', blocked: 'Needs input', interrupted: 'Interrupted', completed: 'Completed', cancelled: 'Cancelled' };
const timeLabel = (value: number) => `${Math.floor(value / 60)}:${String(Math.floor(value % 60)).padStart(2, '0')}`;
const unique = (values: string[]) => [...new Set(values)];

function requestParts(task: Task) {
  const snapshot = task.snapshot;
  return referenceParts(snapshot.userRequest.text, snapshotReferences(snapshot).map(reference => {
    const object = 'object' in reference ? reference.object : snapshot.referenceContent.objects.find(object => object.id === reference.id);
    const asset = 'asset' in reference ? reference.asset : snapshot.referenceContent.assets.find(asset => asset.id === object?.assetId);
    const group = reference.kind === 'group' ? ('group' in reference ? reference.group : snapshot.referenceContent.groups?.find(group => group.id === reference.id)) : undefined;
    return { ...reference, label: referenceLabel(snapshot, reference), asset, groupColor: group?.color };
  }));
}
function requestTitle(task: Task) { return requestParts(task).map(part => part.kind === 'text' ? part.text : ` ${part.reference.label} `).join(''); }

function IconButton({ label, children, className = '', ...props }: { label: string; children: ReactNode; className?: string } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button type="button" className={`icon-button ${className}`} title={label} aria-label={label} {...props}>{children}</button>;
}

function GroupActionButton({ label, children, ...props }: { label: string; children: ReactNode } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button type="button" className="group-action" title={label} aria-label={label} {...props}><span className="group-action-icon" aria-hidden="true">{children}</span></button>;
}

function FontAwesomeObjectIcon({ ungroup = false }: { ungroup?: boolean }) {
  return <span className="fontawesome-object-icon" aria-hidden="true" style={{ maskImage: `url(/icons/fontawesome/regular/object-${ungroup ? 'ungroup' : 'group'}.svg)` }}/>;
}

const noteColorChoices: { id: NoteFill | null; label: string }[] = [
  { id: null, label: 'Default' },
  { id: 'sand', label: 'Sand' },
  { id: 'sage', label: 'Sage' },
  { id: 'mist', label: 'Mist' },
  { id: 'blush', label: 'Blush' },
  { id: 'lilac', label: 'Lilac' },
];

function SelectionFlyout({ label, disabled, trigger, menuLabel, panelClassName, role, onMenuLeave, children }: { label: string; disabled?: boolean; trigger: ReactNode; menuLabel: string; panelClassName: string; role: 'radiogroup' | 'toolbar'; onMenuLeave?: () => void; children: ReactNode }) {
  const root = useRef<HTMLDivElement>(null);
  const place = () => {
    const flyout = root.current, panel = flyout?.querySelector<HTMLElement>('.selection-submenu-panel');
    if (!flyout || !panel) return;
    flyout.dataset.side = flyout.getBoundingClientRect().top < panel.offsetHeight + 24 ? 'below' : 'above';
  };
  return <div ref={root} className="selection-flyout" onPointerEnter={place} onFocus={place}><IconButton label={label} aria-haspopup="menu" disabled={disabled}>{trigger}</IconButton><div className="selection-submenu"><div className={`selection-submenu-panel ${panelClassName}`} role={role} aria-label={menuLabel} onPointerLeave={onMenuLeave}>{children}</div></div></div>;
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
type CommentEdit = { value: AnnotationInput; sessionId: string; draftId: string; index: number; selectionKey?: string; snapshot?: Promise<Blob | undefined>; snapshotGeneration: number; fresh?: boolean; preparing?: Promise<void>; preparingGeneration?: number; frameNote?: string; finished?: boolean };
type AnnotationReader = { annotationId: string; sessionId: string; draftId?: string; taskId?: string };
type Gesture = { kind: 'move' | 'resize' | 'pan' | 'select' | 'mark' | 'note' | 'group'; pointerId: number; start: Point; point: Point; moved: boolean; preview?: Record<string, Rect>; view: SessionView; objects: BoardObject[]; sessionId: string; resizeCorner?: ResizeHandle; commentKey?: string; markBounds?: Rect; region?: Rect; group?: BoardGroup; opensGroup?: boolean };


function taskReferences(task: Task) {
  const { assets, objects } = task.snapshot.referenceContent;
  const groups = task.snapshot.annotations.map(annotation => {
    const items = objects.filter(object => object.id === annotation.objectId || annotation.objectIds.includes(object.id)).map(object => ({ key: object.id, asset: assets.find(asset => asset.id === object.assetId), frame: false })).filter((item, index, all) => all.findIndex(value => value.asset?.id === item.asset?.id) === index);
    for (const id of [annotation.assetId, annotation.snapshotAssetId, annotation.capture?.screenshotAssetId]) if (id && !items.some(item => item.asset?.id === id)) items.push({ key: id, asset: assets.find(asset => asset.id === id), frame: id === annotation.snapshotAssetId || id === annotation.capture?.screenshotAssetId });
    return { annotation, items, primary: items.find(item => item.asset?.id === annotation.capture?.screenshotAssetId) || items.find(item => item.asset?.id === annotation.snapshotAssetId) || items.find(item => item.asset?.id === annotation.assetId) || items[0] };
  });
  const included = new Set(groups.flatMap(group => group.items.map(item => item.asset?.id)));
  const explicit = task.snapshot.requestReferences;
  const explicitIds = explicit ? new Set([...explicit.attachmentIds, ...explicit.objectIds.flatMap(id => objects.find(value => value.id === id)?.assetId || [])]) : undefined;
  const attachments = assets.filter((asset, index) => (!explicitIds || explicitIds.has(asset.id)) && !included.has(asset.id) && assets.findIndex(value => value.id === asset.id) === index);
  return { groups, attachments, count: groups.length + attachments.length };
}

type QueueLayout = { top: number; height: number; items: Map<string, { x: number; y: number }> };
const queueLayouts = new WeakMap<HTMLElement, QueueLayout>();
function rememberQueueLayout() {
  document.querySelectorAll<HTMLElement>('.queue-item').forEach(element => {
    const bounds = element.getBoundingClientRect(), items = new Map<string, { x: number; y: number }>();
    element.querySelectorAll<HTMLElement>('[data-queue-layout]').forEach(item => { if (item.offsetWidth) { const box = item.getBoundingClientRect(); items.set(item.dataset.queueLayout!, { x: box.x - bounds.x, y: box.y - bounds.y }); } });
    queueLayouts.set(element, { top: bounds.top, height: bounds.height, items });
  });
}

function QueueItem({ task, detailOpen, animateSend, visible, played, exiting, collapsing, fromStatus, layoutRevision, children }: { task: Task; detailOpen: boolean; animateSend: boolean; visible: boolean; played: Set<string>; exiting: boolean; collapsing: boolean; fromStatus?: TaskStatus; layoutRevision: number; children: ReactNode }) {
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
    const vertical = Math.abs(before.top - bounds.top) > .5 ? before.top - bounds.top : 0;
    if (vertical) animations.current.push(node.animate([{ transform: `translateY(${vertical}px)` }, { transform: 'translateY(0)' }], options));
    if (Math.abs(before.height - bounds.height) > .5) animations.current.push(node.animate([{ height: `${before.height}px` }, { height: `${bounds.height}px` }], options));
    targets.forEach(({ item, previous, x, y }) => {
      animations.current.push(item.animate([{ transform: `translate(${x}px,${y}px)`, opacity: previous ? 1 : 0 }, { transform: 'translate(0,0)', opacity: 1 }], options));
    });
  }, [detailOpen, layoutRevision]);
  useEffect(() => { const reduced = matchMedia('(prefers-reduced-motion: reduce)'); const stop = () => { if (reduced.matches) animations.current.forEach(animation => animation.cancel()); }; reduced.addEventListener('change', stop); return () => { reduced.removeEventListener('change', stop); animations.current.forEach(animation => animation.cancel()); }; }, []);
  useLayoutEffect(() => {
    if (exiting) { setEntering(false); return; }
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
  useLayoutEffect(() => {
    const node = element.current;
    if (!node || !exiting || !collapsing) { node?.style.removeProperty('--queue-exit-height'); return; }
    node.style.setProperty('--queue-exit-height', `${node.getBoundingClientRect().height}px`);
    return () => { node.style.removeProperty('--queue-exit-height'); };
  }, [collapsing, exiting]);
  return <article ref={element} className={`queue-item${entering ? ' queue-entering' : ''}${exiting ? ' queue-item-exiting' : ''}${exiting && collapsing ? ' queue-item-collapsing' : ''}`} style={{ '--queue-preview-space': `${previewSpace(3, 24, 3, 8)}px`, '--queue-preview-space-narrow': `${previewSpace(3, 22, 2, 5)}px`, '--queue-preview-space-small': `${previewSpace(1, 22, 2, 3)}px` } as React.CSSProperties} role="listitem" data-task-id={task.id} data-status={task.status} data-queue-status={fromStatus || task.status} data-detail-open={detailOpen} onAnimationEnd={event => { if (event.target === event.currentTarget) setEntering(false); }}>{children}</article>;
}

function MotionDisclosure({ open, children, duration = 340, unmountWhenClosed = false, ...props }: { open: boolean; children: ReactNode; duration?: number; unmountWhenClosed?: boolean } & React.HTMLAttributes<HTMLDivElement>) {
  const [moving, setMoving] = useState(false);
  useLayoutEffect(() => {
    const reduced = matchMedia('(prefers-reduced-motion: reduce)');
    let timer = 0;
    const sync = () => { window.clearTimeout(timer); setMoving(!reduced.matches); if (!reduced.matches) timer = window.setTimeout(() => setMoving(false), duration); };
    sync(); reduced.addEventListener('change', sync);
    return () => { window.clearTimeout(timer); reduced.removeEventListener('change', sync); };
  }, [open, duration]);
  return <div {...props} className={`${open || moving ? 'motion-disclosure ' : ''}${props.className || ''}`} data-motion={open ? 'open' : 'closing'} inert={!open} aria-hidden={!open}>{!unmountWhenClosed || open || moving ? children : null}</div>;
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

function TaskCard({ task, assets, objects, content, api, onReloadBoard, locateAsset, onAnnotationView, onSaveError, compact = false, summary = false }: { task: Task; assets: Asset[]; objects: BoardObject[]; content: (id: string) => string; api: BoardApi; onReloadBoard: () => Promise<void>; locateAsset: (id: string) => void; onAnnotationView: (task: Task, open: boolean, annotation?: AnnotationInput) => void; onSaveError?: (cause: unknown) => void; compact?: boolean; summary?: boolean }) {
  const sourceAssets = task.snapshot.referenceContent.assets;
  const references = taskReferences(task);
  const [previewLimit, setPreviewLimit] = useState(() => matchMedia('(max-width: 360px)').matches ? 1 : 3);
  useEffect(() => { const narrow = matchMedia('(max-width: 360px)'); const update = () => setPreviewLimit(narrow.matches ? 1 : 3); narrow.addEventListener('change', update); return () => narrow.removeEventListener('change', update); }, []);
  const [previewId, setPreviewId] = useState('');
  useEffect(() => { if (summary) setPreviewId(''); }, [summary]);
  const previewAsset = [...assets, ...sourceAssets].find(asset => asset.id === previewId);
  const assetAction = (asset: Asset, thumbnail: boolean) => resolveContentKind(asset) === 'file' ? <a href={content(asset.id)} download={asset.name} title={asset.name} aria-label={`Download ${asset.name}`} key={asset.id}>{thumbnail ? <AssetThumb hoverPreview asset={asset} src={content(asset.id)}/> : <><ArrowDownToLine size={12}/>{asset.name}</>}</a> : <button type="button" title={asset.name} aria-label={`View ${asset.name}`} key={asset.id} onClick={() => { if (objects.some(object => object.assetId === asset.id)) locateAsset(asset.id); else setPreviewId(current => current === asset.id ? '' : asset.id); }}>{thumbnail ? <AssetThumb hoverPreview asset={asset} src={content(asset.id)}/> : asset.name}</button>;
  return <article className="task-card" data-task-id={task.id} data-status={task.status}>
    {!compact && <div className="task-heading"><span className="task-sequence">Request {String(task.sequence).padStart(2, '0')}</span><span className={`status-badge status-${task.status}`}>{task.status === 'completed' && <Check size={11}/>} {statusLabels[task.status]}</span></div>}
    {(!compact || !summary) && <p className="task-instruction">{requestTitle(task) ? requestParts(task).map((part, index) => part.kind === 'text' ? part.text : <span className="task-inline-reference" key={`${part.reference.kind}:${part.reference.id}:${index}`} data-reference-kind={part.reference.kind} data-reference-id={part.reference.id}>{part.reference.kind === 'object' ? <AssetThumb hoverPreview asset={part.reference.asset} src={part.reference.asset ? content(part.reference.asset.id) : ''}/> : part.reference.kind === 'group' ? <GroupReferenceIcon color={part.reference.groupColor}/> : <History size={14}/>}<span>{part.reference.label}</span></span>) : 'Create from the attachments and annotations.'}</p>}
    <div className="task-detail-content"><div className={`task-reference-groups${compact ? ' queue-previews' : ''}`} aria-label={compact ? `${references.count} references` : undefined}>
      {references.groups.map(({ annotation, items, primary }, index) => {
        const summaryIndex = references.attachments.length + index, shown = summary && summaryIndex < previewLimit;
        return <div className={`task-reference-group${shown ? ' summary-group' : ''}`} key={annotation.id} data-annotation-id={annotation.id}>
          <button type="button" className="task-annotation-badge" data-queue-layout={`badge-${annotation.id}`} aria-label={`View annotation ${index + 1}: ${annotation.text}`} onClick={() => onAnnotationView(task, true, annotation)}><AnnotationBubble number={index + 1} size={18}/></button>
          <div className="task-reference-row">{(items.length ? items : [{ key: 'region', asset: undefined, frame: false }]).map(item => {
            const preview = shown && (!primary || item.key === primary.key);
            return <div className={`task-reference-source${preview ? ' queue-preview' : ''}`} key={item.key} data-reference-item={item.key} data-queue-layout={`source-${annotation.id}-${item.key}`}>{item.asset ? item.frame ? <ThumbHoverPreview src={content(item.asset.id)} label={item.asset.id === annotation.capture?.screenshotAssetId ? 'Captured annotation scene' : 'Annotated video frame'}><span className="asset-thumb" data-kind="image"><img className="task-annotation-frame" src={content(item.asset.id)} alt={item.asset.id === annotation.capture?.screenshotAssetId ? 'Captured annotation scene' : 'Annotated video frame'}/></span></ThumbHoverPreview> : assetAction(item.asset, true) : <span className="asset-thumb" aria-label="Canvas region"><Maximize size={14}/></span>}</div>;
          })}</div>
          <div className="task-item-annotation"><button type="button" className="task-annotation-text" onClick={() => onAnnotationView(task, true, annotation)}><span>{annotation.text}{annotation.timeStart !== undefined && <small> · {timeLabel(annotation.timeStart)}{annotation.timeEnd !== undefined && ` – ${timeLabel(annotation.timeEnd)}`}</small>}</span></button></div>
        </div>;
      })}
      {!!references.attachments.length && <div className="task-reference-group" data-unannotated-attachments><div className="task-reference-row">{references.attachments.map((asset, index) => <div className={`task-reference-source${summary && index < previewLimit ? ' queue-preview' : ''}`} key={asset.id} data-reference-item={asset.id} data-queue-layout={`attachment-${asset.id}`}>{assetAction(asset, true)}</div>)}</div></div>}
      {compact && summary && references.count > previewLimit && <span className="queue-preview-overflow" aria-label={`${references.count - previewLimit} more references; ${references.count} references total`}>+{references.count - previewLimit}</span>}
    </div>
    {previewAsset && <div className="task-media-preview" data-content-kind={resolveContentKind(previewAsset)} role="region" aria-label={`Preview ${previewAsset.name}`}><IconButton label="Close media preview" onClick={() => setPreviewId('')}><ChevronDown size={14}/></IconButton><ContentRenderer asset={previewAsset} src={content(previewAsset.id)} api={api} surface="detail" onReloadBoard={onReloadBoard} onSaveError={onSaveError}/></div>}
    {task.status !== 'cancelled' && task.reason && <p className="task-reason">{task.reason}</p>}
    {task.receipt && <div className="task-receipt"><div className="receipt-label"><Check size={13}/>Receipt</div><p>{task.receipt.summary}</p>{!!task.receipt.assetIds.length && <div className="receipt-assets">{task.receipt.assetIds.map(id => { const asset = assets.find(asset => asset.id === id); return asset ? assetAction(asset, false) : <a key={id} href={content(id)} download>Download output</a>; })}</div>}{!!task.receipt.validation.length && <details><summary>Validation<ChevronDown size={12}/></summary><ul>{task.receipt.validation.map((line, index) => <li key={index}>{line}</li>)}</ul></details>}</div>}
    <time dateTime={task.createdAt}>{new Date(task.createdAt).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}</time></div>
  </article>;
}

export default function App() {
  const board = useBoard();
  const { state, draft, view } = board;
  const [themePreference, setThemePreference] = useState<ThemePreference>(readThemePreference);
  const [systemDark, setSystemDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches);
  const [themeMenuOpen, setThemeMenuOpen] = useState(false);
  const themeControl = useRef<HTMLDivElement>(null);
  const themeMenu = useRef<HTMLDivElement>(null);
  const theme = themePreference === 'system' ? (systemDark ? 'dark' : 'light') : themePreference;
  const [noteColorHover, setNoteColorHover] = useState<NoteFill | null | undefined>(undefined);
  const [noteFillPending, setNoteFillPending] = useState<{ objectId: string; fill: NoteFill | null } | null>(null);
  const [mode, setMode] = useState<'select' | 'pan' | 'mark' | 'note'>('select');
  const pendingNote = useRef('');
  const [referencePreview, setReferencePreview] = useState<RequestReference[]>([]);
  const tabFocus = useRef(false);
  const [mention, setMention] = useState<{ start: number; end: number; query: string } | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [captureErrors, setCaptureErrors] = useState<Record<string, string>>({});
  const [captureBusyId, setCaptureBusyId] = useState('');
  const [markHover, setMarkHover] = useState<{ objectId: string; bounds: Rect; radius: number } | null>(null);
  const hoverPoint = useRef<Point | null>(null);
  const [samplingIdentity, setSamplingIdentity] = useState<BrowserCaptureIdentity | null>(null);
  const captureGeneration = useRef(0);
  const captureJob = useRef<{ owner: { sessionId: string; draftId: string; annotationId: string }; generation: number; controller: AbortController; identity?: BrowserCaptureIdentity; provider: ProjectCaptureCoordinator; frame?: PreparedSceneCapture | SceneEvidenceFrame; persisted?: SceneEvidenceFrame; worldBounds?: Rect } | null>(null);
  const retainedCaptures = useRef(new Map<string, { frame: PreparedSceneCapture | SceneEvidenceFrame; provider: ProjectCaptureCoordinator }>());
  const queriedCaptures = useRef(new Set<string>());
  const [capturedHistory, setCapturedHistory] = useState<{ task: Task; annotation: AnnotationInput } | null>(null);
  const selectedTextAnchors = useRef(new Map<string, NonNullable<AnnotationInput['contentAnchor']>>());
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
  const [queueLayoutRevision, setQueueLayoutRevision] = useState(0);
  const queueOpenRef = useRef(false);
  const beforeQueueItemRemove = useCallback(() => { rememberQueueLayout(); if (queueOpenRef.current) setQueueLayoutRevision(current => current + 1); }, []);
  const [taskDetailId, updateTaskDetailId] = useState('');
  function setTaskDetailId(value: React.SetStateAction<string>) { rememberQueueLayout(); setQueueLayoutRevision(current => current + 1); updateTaskDetailId(value); }
  const [inspectedTaskId, setInspectedTaskId] = useState('');
  const [annotatingKey, setAnnotatingKey] = useState('');
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
  const [groupInteraction, setGroupInteraction] = useState({ selectedId: '', hoveredId: '', focusedId: '' });
  const { selectedId: selectedGroupId, hoveredId: hoveredGroupId, focusedId: focusedGroupId } = groupInteraction;
  const [groupTransition, setGroupTransition] = useState<{ id: string; kind: 'collapse' | 'expand' | 'enter' | 'leave'; ghost?: BoardGroup } | null>(null);
  const transitionTimer = useRef(0);
  const [renamingGroupId, setRenamingGroupId] = useState('');
  const [groupPosition, setGroupPosition] = useState<{ id: string; x: number; y: number; scale?: number } | null>(null);
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
  const sceneRegistry = useRef(new SceneContentRegistry()).current;
  const evidenceRenderer = useRef(new SceneEvidenceRenderer()).current;
  const projectScene = useProjectScene(board.api, state?.session.id || '', state?.objects || [], board.saveCapturedDraft, board.showError, board.serviceInstance, state?.groups);
  const dock = useRef<HTMLElement>(null);
  const historyPanel = useRef<HTMLDivElement>(null);
  const capturedHistoryPanel = useRef<HTMLElement>(null);
  const notifications = useRef<HTMLElement>(null);
  const instruction = useRef<HTMLDivElement>(null);
  const editor = useRef<ChatboxEditorHandle>(null);
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
  const dragAppearance = useRef<Record<string, { scale: number; opacity: number }>>({});
  const gestureController = useRef<ReturnType<typeof attachCanvasGestures> | undefined>(undefined);
  const pointerHandlers = useRef({ down: (_event: CanvasPointerInput) => {}, move: (_event: CanvasPointerInput) => {}, up: (_event: CanvasPointerInput) => {}, cancel: () => {} });
  const videoRefs = useRef(new Map<string, HTMLVideoElement>());
  const audioRefs = useRef(new Map<string, HTMLAudioElement>());
  const boardInput = useRef<HTMLInputElement>(null);
  const allObjects = (projectScene?.snapshot?.objects || []).map(object => preview[object.id] ? { ...object, ...preview[object.id] } : object);
  const groups = (state?.groups || []).map(group => {
    const members = allObjects.filter(object => object.groupId === group.id);
    const bounds = group.mode === 'frame' ? groupFrameBounds(members, group) : group;
    return { ...group, ...bounds, ...(groupPosition?.id === group.id ? { x: groupPosition.x, y: groupPosition.y } : {}) };
  });
  const activeGroup = groups.find(group => group.id === view.activeGroupId);
  const rootObjects = allObjects.filter(object => !object.groupId || groups.find(group => group.id === object.groupId)?.mode !== 'folder');
  const objects = activeGroup ? allObjects.filter(object => object.groupId === activeGroup.id) : rootObjects;
  const exteriorObjects = activeGroup ? rootObjects.filter(object => object.groupId !== activeGroup.id) : [];
  const departingGroup = groupTransition && ['collapse', 'leave'].includes(groupTransition.kind) && !activeGroup ? groups.find(group => group.id === groupTransition.id && group.mode === 'folder') : undefined;
  const departingObjects = departingGroup ? allObjects.filter(object => object.groupId === departingGroup.id) : [];
  const displayObjects = [...exteriorObjects, ...objects, ...departingObjects.filter(object => !objects.some(item => item.id === object.id))];
  const selectedGroup = !activeGroup ? [renamingGroupId, hoveredGroupId, focusedGroupId, selectedGroupId].map(id => groups.find(group => group.id === id)).find(group => !!group) : undefined;
  const fitTargets = activeGroup ? objects : [...objects.filter(object => !object.groupId), ...groups.map(groupDisplayBounds)];
  const selectedIds = view.selectedObjectIds.filter(id => objects.some(object => object.id === id));
  const selected = objects.filter(object => selectedIds.includes(object.id));
  const selectedVideo = selected.length === 1 && selected[0].type === 'video' && !mediaErrors[selected[0].id] ? selected[0] : undefined;
  const assets = [...(projectScene?.snapshot?.assets || []), ...(state?.assets || []).filter(asset => !projectScene?.snapshot?.assets.some(value => value.id === asset.id))];
  const assetFor = (id: string) => assets.find(asset => asset.id === id);
  const selectedNote = selected.length === 1 && resolveContentKind(assetFor(selected[0].assetId)) === 'note' ? selected[0] : undefined;
  const shownNoteFill = (object: BoardObject): NoteFill | undefined => {
    if (noteColorHover !== undefined && selectedNote?.id === object.id) return noteColorHover ?? undefined;
    if (noteFillPending?.objectId === object.id && (object.fill ?? null) !== noteFillPending.fill) return noteFillPending.fill ?? undefined;
    return object.fill;
  };
  const capabilityFor = (object: BoardObject) => contentCapabilities[resolveContentKind(assetFor(object.assetId))];
  const disabled = board.projectChanged || board.switching || board.sending || editingTask || removingObjects || layoutSaving || !!board.historyBusy;
  const historyUnavailable = disabled || board.contentComposing || (!board.contentDirty && board.mutationBusy) || !state?.history;
  const fitMotion = useAnimatedView(view, state?.session.id || '', disabled, board.updateView);
  const queuedTaskState = useTaskQueue(state?.tasks || [], state?.session.id, { onBeforeRemove: beforeQueueItemRemove });
  const queuedTasks = queuedTaskState.items;
  const pending = queuedTasks.length;
  const queueExiting = !historyOpen && pending > 0 && queuedTasks.every(({ exiting }) => exiting);
  const queueOpen = queueExpanded || queueHovered || queueFocused || queuedTasks.some(({ task }) => task.id === taskDetailId) || historyOpen;
  queueOpenRef.current = queueOpen;
  const commentKey = `${state?.session.id}:${draft?.id}:${[...selectedIds].sort().join(',')}`;
  const comment = [...comments.current.values()].find(edit => edit.selectionKey === commentKey && !edit.finished);
  const annotating = mode === 'mark' || annotatingKey === commentKey && selected.length > 0;
  const inspectedTask = state?.tasks.find(task => task.id === inspectedTaskId);
  const inspectableTask = inspectedTask && (historyOpen || queuedTasks.some(({ task }) => task.id === inspectedTaskId)) ? inspectedTask : undefined;
  const viewingEditedTask = !!draft?.editingTaskId && inspectableTask?.id === draft.editingTaskId;
  const editingSourceTask = state?.tasks.find(task => task.id === draft?.editingTaskId);
  const annotationEdit = annotationReader?.draftId ? [...comments.current.values()].find(edit => edit.value.id === annotationReader.annotationId && edit.sessionId === annotationReader.sessionId && edit.draftId === annotationReader.draftId) : undefined;
  const annotationRead = annotationReader && annotationReader.sessionId === state?.session.id ? annotationReader.draftId ? draft?.id === annotationReader.draftId ? draft.annotations.find(annotation => annotation.id === annotationReader.annotationId) || (annotationEdit && !annotationEdit.finished ? annotationEdit.value : undefined) : undefined : state?.tasks.find(task => task.id === annotationReader.taskId)?.snapshot.annotations.find(annotation => annotation.id === annotationReader.annotationId) : undefined;
  const readerEditable = !!annotationRead && annotationReader?.draftId === draft?.id;
  const readingEditDraft = !!annotationReader?.taskId && annotationReader.sessionId === state?.session.id && annotationReader.taskId === draft?.editingTaskId;
  const projectedAnnotations = (inspectableTask?.snapshot.annotations || []).filter(annotation => !annotation.capture).map(annotation => ({ ...annotation, inspectionTaskId: inspectableTask!.id }));
  const layerAnnotations: (AnnotationInput & { inspectionTaskId?: string })[] = inspectableTask && !viewingEditedTask ? projectedAnnotations : [...(draft?.annotations || []), ...(annotationEdit && annotationRead && !draft?.annotations.some(annotation => annotation.id === annotationRead.id) ? [annotationRead] : [])];
  const allAnnotations = layerAnnotations.filter(annotation => {
    const live = allObjects.filter(object => annotation.objectIds.includes(object.id));
    if (live.length) return live.some(object => objects.some(visible => visible.id === object.id));
    const ownerGroupId = groups.some(group => group.id === annotation.boardGroupId && group.mode === 'folder') ? annotation.boardGroupId : undefined;
    return ownerGroupId === activeGroup?.id;
  });
  const unavailableComments = (draft?.annotations || []).filter(annotation => !annotation.capture && !annotation.sceneSource && captureJob.current?.owner.annotationId !== annotation.id && annotation.objectIds.some(id => !allObjects.some(object => object.id === id)) && !editingSourceTask?.snapshot.annotations.some(value => value.id === annotation.id));
  const hasRequest = !!(draft?.text.trim() || draft?.attachments.length || draft?.annotations.length || draft?.references.objectIds.length || draft?.references.taskIds.length || draft?.references.groupIds?.length || referencePreview.length);
  const incompleteAnnotations = draft?.annotations.filter(annotation => annotation.captureState?.status === 'incomplete') || [];
  const candidates = state ? referenceCandidates(allObjects, groups, assets, state.tasks, state.session.id, mention?.query || '') : [];
  const composerCompact = !composerFocused && !hasRequest && !pending && !draft?.editingTaskId && !draft?.references.objectIds.length && !draft?.references.taskIds.length && !draft?.references.groupIds?.length && !board.draftConflict && !uploads.length && !board.sending;
  function annotationSources(annotation: AnnotationInput): BoardObject[] {
    const source = inspectableTask && !viewingEditedTask ? inspectableTask : editingSourceTask;
    return annotation.objectIds.flatMap(id => {
      const original = source?.snapshot.referenceContent.objects.find(object => object.id === id);
      const current = allObjects.find(object => object.id === id && (!original || original.assetId === object.assetId));
      return current || original ? [current || original!] : [];
    });
  }
  function annotationBounds(annotation: AnnotationInput): Rect | undefined {
    if (annotation.scope === 'group') { const sources = annotationSources(annotation); return sources.length ? unionBounds(sources) : annotation.bounds; }
    if (annotation.coordinateSpace === 'world') return annotation.bounds;
    const object = annotationSources(annotation).find(object => object.id === annotation.objectId && (!annotation.assetId || object.assetId === annotation.assetId));
    const live = object && allObjects.find(current => current.id === object.id && current.assetId === object.assetId);
    const retained = [...retainedCaptures.current.values()].find(value => value.frame.identity.sessionId === state?.session.id && value.frame.identity.draftId === draft?.id && value.frame.identity.annotationId === annotation.id && value.frame.identity.version === annotation.captureState?.version);
    return object ? objectRegion(annotation.bounds, live ? contentBounds(live) : object) : annotation.capture?.worldBounds || retained?.frame.worldBounds || (captureJob.current?.owner.annotationId === annotation.id ? captureJob.current.worldBounds : undefined);
  }
  function annotationDisplayBounds(annotation: AnnotationInput): Rect {
    const sources = annotationSources(annotation);
    if (annotation.scope === 'group') return sources.length ? unionBounds(sources) : annotation.bounds;
    return sources.length ? unionBounds(sources.map(source => { const live = allObjects.find(object => object.id === source.id && object.assetId === source.assetId); return live ? contentBounds(live) : source; })) : annotation.capture?.worldBounds || annotation.bounds;
  }
  function annotationActive(annotation: AnnotationInput & { inspectionTaskId?: string }) { return annotationRead?.id === annotation.id && ((!!annotationReader?.draftId || readingEditDraft) === !annotation.inspectionTaskId); }
  const annotationMarks = allAnnotations.flatMap((annotation, index) => { const bounds = annotationBounds(annotation); return bounds ? [{ annotation, bounds, number: index + 1 }] : []; });
  const annotationPins = annotationPinCenters(annotationMarks.map(mark => ({ bounds: mark.bounds, geometry: mark.annotation.geometry })), view.zoom);
  const pinFor = new Map(annotationMarks.map((mark, index) => [mark.annotation, annotationPins[index]]));
  const visibleOutlines = annotationMarks.filter(({ annotation }) => annotation.scope !== 'group' && annotation.geometry !== 'point' && !(annotating && annotation.id === comment?.value.id));
  const noteLayoutVersion = [mode, ...allAnnotations.map(annotation => { const display = annotationDisplayBounds(annotation), mark = annotationBounds(annotation); return [annotation.id, display.x, display.y, mark?.x, mark?.y, annotation.geometry, annotationActive(annotation)].join(':'); })].join('|');
  const editingAnnotation = comment && draft?.annotations.find(annotation => annotation.id === comment.value.id) || comment?.value;
  const editingObject = editingAnnotation?.objectId ? objects.find(object => object.id === editingAnnotation.objectId) : undefined;
  const editingBounds = !inspectableTask && annotating && editingAnnotation ? markPreview || (editingAnnotation.scope === 'group' ? undefined : editingAnnotation.coordinateSpace === 'normalized' && editingObject ? objectRegion(editingAnnotation.bounds, mediaContentRect(editingObject, mediaSizes[editingObject.id])) : editingAnnotation.bounds) : undefined;

  useComposerLayout(instruction, dock, draft, !!state, referencePreview.length);
  useNotificationLayout(dock, notifications, !!state);
  useContextualControls(canvas, selectionActions, playbackControls, selectedGroup ? [groupDisplayBounds(selectedGroup)] : selected, selectedVideo ? mediaContentRect(selectedVideo, mediaSizes[selectedVideo.id]) : undefined, view);

  useEffect(() => { const query = window.matchMedia('(prefers-color-scheme: dark)'); const apply = () => setSystemDark(query.matches); apply(); query.addEventListener('change', apply); return () => query.removeEventListener('change', apply); }, []);
  useEffect(() => { document.documentElement.dataset.theme = themeFromPreference(themePreference); localStorage.setItem('acanvas-theme', themePreference); document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#111111' : '#f5f5f3'); }, [theme, themePreference]);
  useEffect(() => { if (!themeMenuOpen) return; const close = (event: PointerEvent) => { if (!themeControl.current?.contains(event.target as Node)) setThemeMenuOpen(false); }; document.addEventListener('pointerdown', close); return () => document.removeEventListener('pointerdown', close); }, [themeMenuOpen]);
  useLayoutEffect(() => { if (themeMenuOpen) themeMenu.current?.querySelector<HTMLButtonElement>('[aria-checked=true]')?.focus(); }, [themeMenuOpen]);
  useEffect(() => { pointerHandlers.current.cancel(); }, [state?.session.id]);
  useEffect(() => { pointerHandlers.current.cancel(); }, [state?.session.id, mode, spacePan]);
  useEffect(() => { const active = gesture.current; if (!active || active.objects.map(object => object.id).sort().join(',') !== [...selectedIds].sort().join(',')) { setSnapGuides([]); if (active?.kind === 'move') { gesture.current = null; setPreview({}); } } }, [selectedIds.join(',')]);
  useEffect(() => { setAnnotatingKey(''); setMarkPreview(null); if (gesture.current?.kind === 'mark') gesture.current = null; }, [commentKey]);
  useEffect(() => { setInspectedTaskId(''); setAnnotationReader(null); selectGroupTarget(''); }, [state?.session.id]);
  useEffect(() => { selectGroupTarget(''); }, [view.activeGroupId]);
  useEffect(() => { if (view.activeGroupId && state && !state.groups.some(group => group.id === view.activeGroupId && group.mode === 'folder')) { board.updateView({ ...view, ...(view.parentView || {}), selectedObjectIds: [], activeGroupId: undefined, parentView: undefined }); } }, [state?.groups, view.activeGroupId]);
  useEffect(() => { setReferencePreview([]); setMention(null); setCapturedHistory(null); setCaptureErrors({}); }, [state?.session.id, draft?.id]);
  useEffect(() => {
    const inNativeEditor = (value: EventTarget | null) => value instanceof Element && !!value.closest('input,textarea,select,iframe,[contenteditable],[contenteditable="true"]');
    const key = (event: KeyboardEvent) => {
      tabFocus.current = event.isTrusted && event.key === 'Tab'; if (tabFocus.current) window.setTimeout(() => { tabFocus.current = false; }, 0);
      if (event.key === 'Escape' && captureJob.current) { event.preventDefault(); void cancelCapture(); }
      const historyShortcutBlocked = board.projectChanged || board.switching || board.sending || editingTask || removingObjects || !!board.historyBusy;
      const target = event.target instanceof Element ? event.target : document.activeElement;
      const unifiedTextEditor = target instanceof Element && !!target.closest('textarea.note-editor,textarea.markdown-source');
      const composingEvent = event.isComposing || event.key === 'Process' || event.keyCode === 229 || board.contentComposing;
      if (composingEvent) return;
      if (historyShortcutBlocked || !canvas.current || (!unifiedTextEditor && (inNativeEditor(event.target) || inNativeEditor(document.activeElement)))) return;
      if (!target || !(canvas.current.contains(target) || target === canvas.current)) return;
      const keyName = event.key.toLowerCase();
      const modifier = event.ctrlKey || event.metaKey;
      const action = modifier && keyName === 'z' ? (event.shiftKey ? 'redo' : 'undo') : event.ctrlKey && keyName === 'y' ? 'redo' : undefined;
      const available = action === 'undo' ? state?.history?.canUndo || board.contentDirty : state?.history?.canRedo;
      if (!action || (!available && !board.mutationBusy)) return;
      event.preventDefault(); event.stopPropagation(); void board[action]().catch(() => undefined);
    };
    const pointer = () => { tabFocus.current = false; };
    window.addEventListener('keydown', key, true); window.addEventListener('pointerdown', pointer, true);
    return () => { window.removeEventListener('keydown', key, true); window.removeEventListener('pointerdown', pointer, true); };
  }, [board, disabled, state?.history]);
  useEffect(() => {
    if (!draft || board.saveState !== 'saved' || annotationSaving) return;
    for (const annotation of draft.annotations) {
      if (!annotation.captureState) continue;
      const key = `${draft.sessionId}:${draft.id}:${annotation.id}:${annotation.captureState.version}`;
      if (queriedCaptures.current.has(key)) continue;
      queriedCaptures.current.add(key);
      const owner = { sessionId: draft.sessionId, draftId: draft.id };
      void board.api.captureResult(draft.sessionId, annotation.capture?.draftId || draft.id, annotation.id, annotation.captureState.version).then(result => {
        if (!annotationMatches(owner, annotation) || result.capture.annotationId !== annotation.id || result.capture.version !== annotation.captureState?.version || result.capture.sessionId !== owner.sessionId || result.capture.draftId !== (annotation.capture?.draftId || owner.draftId)) return;
        const captured = result.draft?.annotations.find(value => value.id === annotation.id);
        if (result.status === 'committed' && result.draft && captured?.capture?.id === result.capture.id && captured.captureState?.version === annotation.captureState?.version) { board.acceptSavedDraft(result.draft); updateCaptureImageAvailability(owner, captured, true); void board.refresh(); }
      }).catch(cause => { if (cause instanceof Error && 'code' in cause && ['asset_missing', 'asset_file_missing', 'asset_integrity'].includes(String(cause.code))) updateCaptureImageAvailability(owner, annotation, false); });
    }
  }, [draft?.id, draft?.revision, board.saveState, annotationSaving]);
  useEffect(() => {
    if (!projectScene?.view || !draft || captureJob.current) return;
    const provider = projectScene.provider, owner = { sessionId: draft.sessionId, draftId: draft.id }; let active = true;
    void (async () => {
      const frames = await pendingEvidence(owner.sessionId, owner.draftId);
      for (const frame of frames) {
        if (!active || !sameScope(owner)) return;
        const annotation = board.getDraftFor(owner.sessionId, owner.draftId)?.annotations.find(value => value.id === frame.identity.annotationId);
        if (!annotation || annotation.captureState?.version !== frame.identity.version || annotation.sceneSource?.id !== frame.sceneSource.id || JSON.stringify(annotationTarget(annotation)) !== JSON.stringify(frame.target) || annotation.captureState.status === 'complete') { await removePendingEvidence(frame); continue; }
        const key = owner.sessionId + ':' + owner.draftId + ':' + annotation.id + ':' + frame.identity.version;
        retainedCaptures.current.set(key, { frame, provider });
        const job = { owner: { ...owner, annotationId: annotation.id }, generation: ++captureGeneration.current, controller: new AbortController(), identity: frame.identity, provider, frame, persisted: frame, worldBounds: frame.worldBounds };
        captureJob.current = job; setCaptureBusyId(annotation.id); setAnnotationSaving(true);
        try {
          const result = await provider.resume(frame);
          if (!active || captureJob.current !== job || !sameScope(owner)) return;
          if (result.status === 'complete' && result.result.draft) {
            board.acceptSavedDraft(result.result.draft); await removePendingEvidence(frame); retainedCaptures.current.delete(key); setCaptureErrors(current => ({ ...current, [annotation.id]: '' })); await board.refresh();
          } else setCaptureErrors(current => ({ ...current, [annotation.id]: result.status === 'incomplete' ? captureErrorLabel(result.code) : 'The saved scene is unavailable.' }));
        } finally { if (captureJob.current === job) captureJob.current = null; if (active && sameScope(owner)) { setCaptureBusyId(''); setAnnotationSaving(false); } }
      }
    })().catch(cause => { if (active && sameScope(owner)) board.showError(cause); });
    return () => { active = false; };
  }, [projectScene?.view?.viewId, draft?.id]);
  useEffect(() => {
    const cancel = (event?: PageTransitionEvent) => { if (event?.persisted) return; const job = captureJob.current; captureJob.current = null; if (job) { job.controller.abort(); void job.provider.close({ keepalive: !!event }); } };
    window.addEventListener('pagehide', cancel); return () => { cancel(); window.removeEventListener('pagehide', cancel); };
  }, []);
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
    if (!historyOpen) return;
    let frameFocusTimer = 0;
    const contains = (target: Node | null) => {
      if (!target) return false;
      if (historyPanel.current?.contains(target) || capturedHistoryPanel.current?.contains(target)) return true;
      const annotation = target instanceof Element ? target.closest<HTMLElement>('.canvas-annotation-group') : null;
      return !!annotation && !!inspectedTask?.snapshot.annotations.some(value => value.id === annotation.dataset.annotationId);
    };
    const outside = (event: globalThis.PointerEvent) => { if (!contains(event.target as Node)) closeHistory(); };
    const frameFocus = () => { frameFocusTimer = window.setTimeout(() => { const target = document.activeElement; if (target instanceof HTMLIFrameElement && !contains(target)) closeHistory(); }, 0); };
    document.addEventListener('pointerdown', outside, true);
    window.addEventListener('blur', frameFocus);
    return () => { document.removeEventListener('pointerdown', outside, true); window.removeEventListener('blur', frameFocus); window.clearTimeout(frameFocusTimer); };
  }, [historyOpen, inspectedTask]);
  useEffect(() => {
    const close = (event: globalThis.PointerEvent) => { if (!dock.current?.contains(event.target as Node)) { window.clearTimeout(queueCloseTimer.current); setQueueExpanded(false); setQueueHovered(false); setQueueFocused(false); setTaskDetailId(''); } };
    document.addEventListener('pointerdown', close, true);
    return () => { document.removeEventListener('pointerdown', close, true); window.clearTimeout(queueCloseTimer.current); };
  }, []);
  const canvasWheel = useCallback((event: CanvasWheelInput) => {
    const element = canvas.current, current = wheelState.current;
    if (!element || current.disabled || gesture.current) return;
    fitMotion.interrupt();
    const rect = element.getBoundingClientRect(), scale = rect.width / Math.max(1, element.clientWidth);
    const input: CanvasWheelInput = { clientX: (event.clientX - rect.left) / scale, clientY: (event.clientY - rect.top) / scale, deltaX: event.deltaX / (event.deltaMode === 0 && !event.ctrlKey && !event.metaKey ? scale : 1), deltaY: event.deltaY / (event.deltaMode === 0 && !event.ctrlKey && !event.metaKey ? scale : 1), deltaMode: event.deltaMode, ctrlKey: event.ctrlKey, metaKey: event.metaKey };
    const next = canvasWheelView(current.view, input, { left: 0, top: 0, height: element.clientHeight });
    wheelState.current = { ...current, view: next }; board.updateView(next, current.sessionId);
  }, [board.updateView, fitMotion.interrupt]);
  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    const gestures = attachCanvasGestures(element, {
      current: () => ({ ...wheelState.current, busy: !!gesture.current }),
      updateView: (next, owner) => { wheelState.current = { ...wheelState.current, view: next }; board.updateView(next, owner); },
      interrupt: fitMotion.interrupt, cancelPointer: () => pointerHandlers.current.cancel(),
      pointerDown: event => pointerHandlers.current.down(event), pointerMove: event => pointerHandlers.current.move(event), pointerUp: event => pointerHandlers.current.up(event),
    });
    gestureController.current = gestures;
    const wheel = (event: WheelEvent) => {
      if (!routesWheelToCanvas(element, event)) return;
      event.preventDefault(); event.stopPropagation(); if (gestures.acceptsWheel()) canvasWheel(event);
    };
    element.addEventListener('wheel', wheel, { capture: true, passive: false });
    return () => { gestures.dispose(); if (gestureController.current === gestures) gestureController.current = undefined; element.removeEventListener('wheel', wheel, true); };
  }, [!!state, canvasWheel, board.updateView, fitMotion.interrupt]);
  useEffect(() => { gestureController.current?.reset(); }, [state?.session.id, disabled, mode, spacePan, projectScene?.view?.viewId, projectScene?.view?.viewGeneration, board.serviceInstance]);
  useEffect(() => {
    const singlePlayback = (event: Event) => { const active = event.target; if (!(active instanceof HTMLMediaElement)) return; document.querySelectorAll<HTMLMediaElement>('audio,video').forEach(element => { if (element !== active && !element.paused) element.pause(); }); };
    document.addEventListener('play', singlePlayback, true); return () => document.removeEventListener('play', singlePlayback, true);
  }, []);

  const viewUpdate = (next: Partial<SessionView>) => { if (!disabled && state) { fitMotion.interrupt(); board.updateView({ ...view, ...next }, state.session.id, 'activeGroupId' in next ? 'immediate' : true); } };
  function selectGroupTarget(id: string) { setGroupInteraction({ selectedId: id, hoveredId: '', focusedId: '' }); }
  function hoverGroupTarget(id: string) { setGroupInteraction(current => ({ ...current, hoveredId: id })); }
  function focusGroupTarget(id: string) { setGroupInteraction(current => ({ ...current, hoveredId: '', focusedId: id })); }
  function releaseGroupTarget(id: string, source: 'hoveredId' | 'focusedId') { setGroupInteraction(current => current[source] === id ? { ...current, [source]: '' } : current); }
  function selectGroup(group: BoardGroup) {
    clearInspection(); exitAnnotation(); selectGroupTarget(group.id); setReferencePreview([{ kind: 'group', id: group.id }]); viewUpdate({ selectedObjectIds: [] });
  }
  const selectObjects = (ids: string[], user = true) => { selectGroupTarget(''); if ([...ids].sort().join(',') !== [...selectedIds].sort().join(',')) { clearInspection(); exitAnnotation(); } const ordered = unique(ids); if (user) setReferencePreview(ordered.map(id => ({ kind: 'object', id }))); viewUpdate({ selectedObjectIds: ordered }); };
  useLayoutEffect(() => {
    const assetId = pendingNote.current;
    if (!assetId || !canvas.current) return;
    const object = state?.objects.find(item => item.assetId === assetId);
    if (!object) return;
    const field = canvas.current.querySelector<HTMLElement>(`[data-object-id="${CSS.escape(object.id)}"] .note-editor`);
    if (!field) return;
    selectObjects([object.id]);
    field.focus();
    pendingNote.current = '';
  }, [state?.objects]);
  function confirmReferencePreview() {
    if (!referencePreview.length || disabled) return;
    editor.current?.confirmPreview();
  }
  function updateMention({ text, caret, segmentStart, collapsed }: EditorCaret) {
    if (composing.current) { setMention(null); return; }
    const match = collapsed ? /(?:^|\s)@([^\n@]*)$/.exec(text.slice(segmentStart, caret)) : null;
    const next = match ? { start: caret - match[1].length - 1, end: caret, query: match[1] } : null;
    if (mention?.start !== next?.start || mention?.end !== next?.end || mention?.query !== next?.query) setMentionIndex(0);
    setMention(next);
  }
  function chooseReference(entry: ReferenceCandidate) {
    const active = mention;
    editor.current?.insertReference(entry, active || undefined);
    setMention(null); setReferencePreview([]);
  }
  const localPoint = (event: { clientX: number; clientY: number }): Point => { const bounds = canvas.current!.getBoundingClientRect(), scale = bounds.width / Math.max(1, canvas.current!.clientWidth); return { x: (event.clientX - bounds.x) / scale, y: (event.clientY - bounds.y) / scale }; };
  function contentBounds(object: BoardObject): Rect { return mediaContentRect(object, mediaSizes[object.id]); }
  function rememberMarkdownSelection() {
    selectedTextAnchors.current.clear();
    for (const object of objects) { const anchor = requestedMarkdownAnchor(object.id); if (anchor?.kind === 'text') selectedTextAnchors.current.set(object.id, anchor); }
  }
  function requestedAnchor(objectId: string) {
    const current = requestedMarkdownAnchor(objectId), selected = selectedTextAnchors.current.get(objectId);
    return selected && current?.scroll?.x === selected.scroll?.x && current?.scroll?.y === selected.scroll?.y ? selected : current;
  }
  function presentedObjects(values: BoardObject[]): BoardObject[] {
    const root = canvas.current; if (!root) return values;
    const area = root.getBoundingClientRect(), scale = area.width / Math.max(1, root.clientWidth), zoom = view.zoom * scale;
    return values.flatMap(object => {
      const element = root.querySelector<HTMLElement>(`.board-object[data-object-id="${CSS.escape(object.id)}"]`); if (!element) return [object];
      if (Number(getComputedStyle(element).opacity) <= .001) return [];
      const bounds = element.getBoundingClientRect();
      return [{ ...object, x: (bounds.x - area.x - view.x * scale) / zoom, y: (bounds.y - area.y - view.y * scale) / zoom, width: bounds.width / zoom, height: bounds.height / zoom }];
    });
  }
  function targetForWorld(world: Rect, geometry: 'point' | 'rect') {
    const shown = presentedObjects(objects);
    return presentedMarkTarget(world, geometry, { layers: shown.map((object, layer) => ({ objectId: object.id, layer, contentWorldBounds: contentBounds(object) })) }, shown, assets);
  }
  function updateMarkHover(point: Point | null) {
    hoverPoint.current = point;
    if (!point || mode !== 'mark' || spacePan || gesture.current) { setMarkHover(null); return; }
    const target = targetForWorld({ ...screenToWorld(point, view), width: 0, height: 0 }, 'point');
    const object = objects.find(object => object.id === target.objectId);
    const next = target.objectId && object ? { objectId: target.objectId, bounds: contentBounds(object), radius: resolveContentKind(assetFor(object.assetId)) === 'audio' ? Math.min(22, object.width / 2, object.height / 2) : 0 } : null;
    setMarkHover(current => JSON.stringify(current) === JSON.stringify(next) ? current : next);
  }
  useEffect(() => {
    if (mode !== 'mark' || spacePan) { hoverPoint.current = null; setMarkHover(null); return; }
    updateMarkHover(hoverPoint.current);
  }, [mode, spacePan]);
  useEffect(() => { if (mode === 'mark' && !spacePan && hoverPoint.current) updateMarkHover(hoverPoint.current); }, [projectScene?.snapshot, preview, view, mediaSizes]);
  function applyMark(world: Rect, geometry: 'point' | 'rect', edit?: CommentEdit) {
    if (!state || !draft) return;
    const target = targetForWorld(world, geometry);
    target.boardGroupId = activeGroup?.id;
    if (target.objectId) target.contentAnchor = requestedAnchor(target.objectId);
    selectedTextAnchors.current.clear();
    if (edit && sameScope(edit)) {
      const changedObject = target.objectId !== edit.value.objectId;
      patchAnnotation(edit, { ...target, ...(changedObject ? { timeStart: undefined, timeEnd: undefined, snapshotAssetId: undefined } : {}) });
    } else {
      const value: AnnotationInput = { id: randomId(), scope: 'region', objectIds: [], bounds: world, coordinateSpace: 'world', text: '', geometry, captureState: { version: 1, status: 'incomplete' }, ...(activeGroup ? { boardGroupId: activeGroup.id } : {}), ...target };
      const next: CommentEdit = { value, sessionId: state.session.id, draftId: draft.id, index: draft.annotations.length, snapshotGeneration: 0, fresh: true };
      comments.current.set(value.id, next); setAnnotationReader({ annotationId: value.id, sessionId: state.session.id, draftId: draft.id }); readerTrigger.current = canvas.current;
    }
    setCommentRevision(revision => revision + 1); setMarkPreview(null); updateMarkHover(null); setMode('select'); readerFocusFrame.current = requestAnimationFrame(focusAnnotation);
  }
  const sceneState = useRef({ objects: state?.objects || [], assets, view, contentBounds });
  sceneState.current = { objects: state?.objects || [], assets, view, contentBounds };

  async function importFiles(files: File[], dropPoint?: Point) {
    if (!files.length) return;
    if (!state || !draft || board.connection !== 'connected') { board.setError('The board is disconnected. Wait for it to reconnect, then import your files.'); return; }
    if (disabled) { board.setError(board.projectChanged ? 'This address now serves another project. Reopen the board to import files.' : 'Your request is being saved or sent. Import files once it finishes.'); return; }
    const sessionId = state.session.id;
    const importView = view;
    const size = canvas.current?.getBoundingClientRect();
    const position = screenToWorld(dropPoint ?? { x: (size?.width || 600) / 2, y: (size?.height || 600) / 2 }, importView);
    for (const [index, file] of files.entries()) {
      const id = randomId();
      const controller = new AbortController();
      setUploads(current => [...current, { id, name: file.name, controller }]);
      try {
        const dimensions = await fileDimensions(file);
        if (controller.signal.aborted) continue;
        const asset = await board.api.upload(file, file.name, controller.signal);
        let { width, height } = contentCapabilities[resolveContentKind(asset)].initial;
        if (dimensions?.width && dimensions.height) { const scale = Math.min(340 / dimensions.width, 280 / dimensions.height); width = dimensions.width * scale; height = dimensions.height * scale; }
        await board.operations([{ type: 'create', object: { assetId: asset.id, x: position.x - width / 2 + index * 30, y: position.y - height / 2 + index * 30, width, height, ...(importView.activeGroupId ? { groupId: importView.activeGroupId } : {}) } }], sessionId);
      } catch (cause) { if (!controller.signal.aborted) board.showError(cause); }
      finally { setUploads(current => current.filter(upload => upload.id !== id)); }
    }
  }

  async function placeNote(origin: Point) {
    if (!state || !draft || board.connection !== 'connected') { board.setError('The board is disconnected. Wait for it to reconnect, then add a note.'); return; }
    if (disabled) { board.setError(board.projectChanged ? 'This address now serves another project. Reopen the board to add a note.' : 'Your request is being saved or sent. Add a note once it finishes.'); return; }
    const { width, height } = contentCapabilities.note.initial;
    const ownerGroupId = view.activeGroupId;
    try {
      const asset = await board.api.upload(new File([new Uint8Array()], 'Note', { type: noteMime }), 'Note', undefined, noteMime);
      pendingNote.current = asset.id;
      await board.operations([{ type: 'create', object: { assetId: asset.id, x: origin.x, y: origin.y, width, height, ...(ownerGroupId ? { groupId: ownerGroupId } : {}) } }], state.session.id);
      setMode('select');
    } catch (cause) { pendingNote.current = ''; board.showError(cause); }
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

  function beginComment(targets = selected, wholeGroup = false): CommentEdit | undefined {
    const existing = [...comments.current.values()].find(edit => edit.selectionKey === commentKey && !edit.finished);
    if (existing && !existing.finished) return existing;
    if (!state || !draft || disabled || !targets.length) return;
    const bounds = unionBounds(targets.length > 1 ? targets : targets.map(contentBounds));
    const single = targets.length === 1 ? targets[0] : undefined;
    const value: AnnotationInput = { id: randomId(), scope: single ? 'object' : wholeGroup ? 'group' : 'region', objectId: single?.id, objectIds: wholeGroup ? targets.map(object => object.id) : single ? [single.id] : [], assetId: single?.assetId, bounds: single ? normalizedRegion(bounds, contentBounds(single)) : bounds, coordinateSpace: single ? 'normalized' : 'world', text: '', geometry: 'rect', captureState: { version: 1, status: 'incomplete' }, ...(activeGroup ? { boardGroupId: activeGroup.id } : {}), ...(single ? { contentAnchor: requestedAnchor(single.id) } : {}) };
    if (value.bounds.width <= 0 || value.bounds.height <= 0) { setNotice('Select an area inside the image or video.'); return; }
    let snapshot: Promise<Blob | undefined> | undefined;
    let frameNote: string | undefined;
    if (single && resolveContentKind(assetFor(single.assetId)) === 'audio') audioRefs.current.get(single.id)?.pause();
    if (single?.type === 'video') {
      const video = videoRefs.current.get(single.id);
      video?.pause();
      if (video && Number.isFinite(video.duration) && video.duration > 0) {
        value.timeStart = 0;
        value.timeEnd = video.duration;
        snapshot = videoFrameAt(board.api.content(single.assetId), 0);
      }
    }
    const edit: CommentEdit = { value, sessionId: state.session.id, draftId: draft.id, index: draft.annotations.length, selectionKey: commentKey, snapshot, snapshotGeneration: 0, fresh: true, frameNote };
    comments.current.set(edit.value.id, edit); setCommentRevision(revision => revision + 1);
    return edit;
  }

  async function reloadBoard() { try { await board.flushContent(); await board.flushDraft(); window.location.reload(); } catch (cause) { board.showError(cause); } }

  function clearInspection() { cancelAnimationFrame(readerFocusFrame.current); setInspectedTaskId(''); setAnnotationReader(null); setCapturedHistory(null); }

  function closeAnnotation() {
    cancelAnimationFrame(readerFocusFrame.current);
    if (annotationEdit) annotationEdit.finished = true;
    const trigger = readerTrigger.current;
    setAnnotationReader(null); exitAnnotation(); if (mode === 'mark') setMode('select');
    readerFocusFrame.current = requestAnimationFrame(() => { if (trigger?.isConnected && !trigger.closest('[inert]')) trigger.focus({ preventScroll: true }); else instruction.current?.focus({ preventScroll: true }); });
  }

  function focusAnnotation() {
    const input = annotationInput.current, boardBounds = canvas.current?.getBoundingClientRect(), rect = input?.getBoundingClientRect();
    if (input?.closest('.annotation-full')?.contains(document.activeElement)) return;
    if (input && boardBounds && rect && !input.closest('[inert]') && rect.right > boardBounds.left && rect.left < boardBounds.right && rect.bottom > boardBounds.top && rect.top < boardBounds.bottom) input.focus({ preventScroll: true });
  }

  function exitAnnotation() { updateMarkHover(null); setAnnotatingKey(''); setMarkPreview(null); if (gesture.current?.kind === 'mark') gesture.current = null; }

  function enterAnnotation(targets = selected, wholeGroup = false) {
    const edit = beginComment(targets, wholeGroup);
    if (!edit) return;
    clearInspection(); setMode('select'); setAnnotatingKey(commentKey); setMarkPreview(null); setReferencePreview([]);
    readerTrigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setAnnotationReader({ annotationId: edit.value.id, sessionId: edit.sessionId, draftId: edit.draftId });
    readerFocusFrame.current = requestAnimationFrame(focusAnnotation);
  }

  function toggleTaskDetail(task: Task) {
    const open = taskDetailId !== task.id;
    clearInspection(); exitAnnotation(); setTaskDetailId(open ? task.id : '');
    if (open && task.snapshot.annotations.some(annotation => !annotation.capture)) setInspectedTaskId(task.id);
  }

  function locateObjects(ids: string[]) {
    const targets = allObjects.filter(object => ids.includes(object.id));
    const size = canvas.current?.getBoundingClientRect();
    if (!targets.length || !size) return;
    const bounds = unionBounds(targets), dockTop = dock.current?.getBoundingClientRect().top || size.height;
    const targetGroup = targets[0].groupId && groups.find(group => group.id === targets[0].groupId && group.mode === 'folder');
    viewUpdate({ x: size.width / 2 - (bounds.x + bounds.width / 2) * view.zoom, y: (64 + dockTop) / 2 - (bounds.y + bounds.height / 2) * view.zoom, selectedObjectIds: targets.map(object => object.id), activeGroupId: targetGroup ? targetGroup.id : undefined, parentView: targetGroup ? view.parentView || { x: view.x, y: view.y, zoom: view.zoom } : undefined });
  }

  function locateAsset(id: string) { locateObjects(allObjects.filter(object => object.assetId === id).map(object => object.id)); }

  function openAnnotation(annotation: AnnotationInput, inDraft = false) {
    if (!state || !draft) return;
    const source = allObjects.find(object => annotation.objectIds.includes(object.id));
    const ownerGroup = source?.groupId ? groups.find(group => group.id === source.groupId && group.mode === 'folder') : annotation.boardGroupId ? groups.find(group => group.id === annotation.boardGroupId && group.mode === 'folder') : undefined;
    if (ownerGroup?.id !== activeGroup?.id) {
      if (annotation.objectIds.length) locateObjects(annotation.objectIds);
      else if (ownerGroup) enterGroup(ownerGroup);
      else leaveGroup();
    }
    if (annotationRead?.id === annotation.id && readerEditable === inDraft) { if (inDraft) focusAnnotation(); return; }
    cancelAnimationFrame(readerFocusFrame.current);
    readerTrigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (inDraft) {
      clearInspection();
      const existingEdit = [...comments.current.values()].find(edit => edit.sessionId === state.session.id && edit.draftId === draft.id && edit.value.id === annotation.id);
      if (existingEdit) { existingEdit.finished = false; existingEdit.fresh = false; }
      if (![...comments.current.values()].some(edit => edit.sessionId === state.session.id && edit.draftId === draft.id && edit.value.id === annotation.id)) comments.current.set(annotation.id, { value: { ...annotation, text: '' }, sessionId: state.session.id, draftId: draft.id, index: draft.annotations.findIndex(value => value.id === annotation.id), snapshotGeneration: 0 });
      if (annotation.objectId && annotation.contentAnchor?.scroll) {
        const scroller = canvas.current?.querySelector<HTMLElement>(`[data-object-id="${CSS.escape(annotation.objectId)}"] .markdown-content`);
        if (scroller) { scroller.scrollLeft = annotation.contentAnchor.scroll.x; scroller.scrollTop = annotation.contentAnchor.scroll.y; }
      }
    }
    exitAnnotation();
    setAnnotationReader({ annotationId: annotation.id, sessionId: state.session.id, ...(inDraft ? { draftId: draft.id } : { taskId: inspectableTask?.id }) });
    if (inDraft) readerFocusFrame.current = requestAnimationFrame(focusAnnotation);
  }

  const sameScope = (edit: { sessionId: string; draftId: string }) => scope.current.sessionId === edit.sessionId && scope.current.draftId === edit.draftId;

  function patchAnnotation(edit: CommentEdit, changes: Partial<AnnotationInput>) {
    if (captureJob.current?.owner.annotationId === edit.value.id && sameScope(edit)) { void cancelCapture(); captureGeneration.current++; }
    edit.value = { ...edit.value, ...changes };
    return board.changeDraftFor(edit.sessionId, edit.draftId, current => ({ ...current, annotations: current.annotations.map(annotation => annotation.id === edit.value.id ? { ...annotation, ...changes } : annotation) }));
  }

  function changeAnnotationText(text: string) {
    const owner = annotationReader, edit = annotationEdit;
    if (!owner?.draftId || !edit || !sameScope(edit)) return;
    edit.value = { ...edit.value, text };
    board.changeDraftFor(owner.sessionId, owner.draftId, current => {
      const existingIndex = current.annotations.findIndex(annotation => annotation.id === owner.annotationId);
      const existing = current.annotations[existingIndex];
      const annotations = current.annotations.filter(annotation => annotation.id !== owner.annotationId);
      if (text.trim()) annotations.splice(Math.min(Math.max(0, existingIndex >= 0 ? existingIndex : edit.index), annotations.length), 0, { ...(existing || edit.value), text });
      return { ...current, annotations };
    });
    if (text.trim()) void prepareComment(edit).catch(board.showError);
  }

  function changeAnnotationRange(edit: CommentEdit, kind: 'audio' | 'video', src: string, start?: number, end?: number) {
    const previousStart = edit.value.timeStart;
    if (kind === 'video' && start !== previousStart) {
      edit.snapshotGeneration++;
      edit.snapshot = videoFrameAt(src, start || 0);
      edit.frameNote = undefined;
      patchAnnotation(edit, { timeStart: start, timeEnd: end, snapshotAssetId: undefined });
      if (board.getDraftFor(edit.sessionId, edit.draftId)?.annotations.find(value => value.id === edit.value.id)?.text.trim()) void prepareComment(edit).catch(board.showError);
    } else patchAnnotation(edit, { timeStart: start, timeEnd: end });
    setCommentRevision(revision => revision + 1);
  }

  async function prepareComment(edit: CommentEdit): Promise<void> {
    if (edit.finished) return;
    if (edit.preparing) {
      if (edit.preparingGeneration === edit.snapshotGeneration) return edit.preparing;
      try { await edit.preparing; } catch { /* A superseded frame does not block the current time point. */ }
      if (edit.preparing && edit.preparingGeneration === edit.snapshotGeneration) return edit.preparing;
    }
    if (!edit.snapshot) return;
    const generation = edit.snapshotGeneration;
    const time = edit.value.timeStart || 0;
    const work = (async () => {
      const blob = await edit.snapshot;
      const current = () => board.getDraftFor(edit.sessionId, edit.draftId)?.annotations.find(annotation => annotation.id === edit.value.id);
      if (edit.finished || generation !== edit.snapshotGeneration || !sameScope(edit) || !current() || current()?.snapshotAssetId) return;
      if (!blob) { edit.frameNote = 'The timestamp is saved. A frame preview is unavailable for this video.'; setCommentRevision(revision => revision + 1); return; }
      if (edit.value.objectIds.some(id => !scope.current.objectIds.has(id))) return;
      const asset = await board.api.upload(blob, `video-frame-${timeLabel(time).replace(':', '-')}.png`);
      await board.refresh();
      if (edit.finished || generation !== edit.snapshotGeneration || !sameScope(edit) || !current() || edit.value.objectIds.some(id => !scope.current.objectIds.has(id))) return;
      patchAnnotation(edit, { snapshotAssetId: asset.id });
    })();
    edit.preparing = work; edit.preparingGeneration = generation;
    try { await work; }
    finally { if (edit.preparing === work) edit.preparing = undefined; }
  }

  async function finishAnnotation(annotation = annotationRead, recapture = !!annotation && !!captureErrors[annotation.id]) {
    if (!annotation || annotationSaving || commentComposing.current || !draft || !state) return;
    if (!annotation.text.trim()) { closeAnnotation(); return; }
    const owner = { sessionId: state.session.id, draftId: draft.id }, id = annotation.id;
    try { await board.flushContent(owner.sessionId); }
    catch (cause) { board.showError(cause); return; }
    let expected = board.getDraftFor(owner.sessionId, owner.draftId)?.annotations.find(value => value.id === id) || annotation;
    if (!expected.captureState) { await board.flushDraft(owner.sessionId); closeAnnotation(); return; }
    if (expected.captureState.status === 'complete' && !recapture) {
      setAnnotationSaving(true);
      try { await board.flushDraft(owner.sessionId); await board.api.captureResult(owner.sessionId, expected.capture?.draftId || owner.draftId, id, expected.captureState.version); if (sameScope(owner)) { closeAnnotation(); updateCaptureImageAvailability(owner, expected, true); } }
      catch (cause) { if (annotationMatches(owner, expected)) setCaptureErrors(current => ({ ...current, [id]: cause instanceof Error ? cause.message : 'Captured image unavailable.' })); }
      finally { setAnnotationSaving(false); }
      return;
    }
    const provider = projectScene?.provider;
    if (!provider) { setCaptureErrors(current => ({ ...current, [id]: 'The scene is connecting. Complete the annotation when the board is ready.' })); return; }
    const generation = ++captureGeneration.current, controller = new AbortController();
    const job = { owner: { ...owner, annotationId: id }, generation, controller, provider } as NonNullable<typeof captureJob.current>;
    captureJob.current = job; setCaptureBusyId(id); setAnnotationSaving(true);
    const key = owner.sessionId + ':' + owner.draftId + ':' + id + ':' + expected.captureState.version;
    try {
      const retained = recapture ? undefined : retainedCaptures.current.get(key);
      let frame: PreparedSceneCapture | SceneEvidenceFrame;
      if (retained && retained.provider === provider && JSON.stringify(retained.frame.target) === JSON.stringify(annotationTarget(expected))) frame = retained.frame;
      else {
        const captureView = projectScene?.view, snapshot = projectScene?.snapshot;
        if (!captureView || !snapshot || snapshot.view.viewId !== captureView.viewId) throw new Error('The visible scene is still loading. Complete the annotation when it is ready.');
        // This is the Done boundary. HTML refreshes start here; the displayed scene is copied before the editor closes and before any await.
        const pendingFrames = sceneRegistry.beginRefresh(controller.signal);
        const frozen = freezeDisplayedScene(expected, captureView, snapshot);
        job.worldBounds = { ...frozen.worldBounds };
        closeAnnotation();
        replaceFrozenFrames(frozen, await pendingFrames);
        const held = await holdFrozenScene(frozen, expected, owner, job);
        if (!held) return;
        if (captureJob.current !== job || controller.signal.aborted || !sameScope(owner)) { await provider.cancel(held.frame.identity); return; }
        board.acceptSavedDraft(held.draft); frame = held.frame; expected = held.draft.annotations.find(value => value.id === id)!;
        retainedCaptures.current.set(owner.sessionId + ':' + owner.draftId + ':' + id + ':' + frame.identity.version, { frame, provider });
      }
      job.identity = frame.identity; job.frame = frame;
      if (!('png' in frame)) {
        const { encodePNG, ...metadata } = frame, persisted = { ...metadata, png: await encodePNG() } as SceneEvidenceFrame;
        if (captureJob.current !== job || controller.signal.aborted || !sameScope(owner)) return;
        try { await savePendingEvidence(persisted); job.persisted = persisted; } catch { /* The current page keeps its copied pixels while the server upload completes. */ }
        if (captureJob.current !== job || controller.signal.aborted || !sameScope(owner)) { if (job.persisted) await removePendingEvidence(job.persisted); return; }
        frame = persisted; job.frame = frame;
        retainedCaptures.current.set(owner.sessionId + ':' + owner.draftId + ':' + id + ':' + frame.identity.version, { frame, provider });
      } else job.persisted = frame;
      const result = await provider.capture(frame);
      if (captureJob.current !== job || controller.signal.aborted || !sameScope(owner)) return;
      if (result.status === 'complete' && result.result.draft) {
        const completed = result.result.draft.annotations.find(value => value.id === id);
        if (!completed || completed.captureState?.version !== frame.identity.version || JSON.stringify(annotationTarget(completed)) !== JSON.stringify(frame.target)) return;
        board.acceptSavedDraft(result.result.draft); updateCaptureImageAvailability(owner, completed, true);
        retainedCaptures.current.delete(owner.sessionId + ':' + owner.draftId + ':' + id + ':' + frame.identity.version);
        if (job.persisted) await removePendingEvidence(job.persisted).catch(() => undefined);
        await board.refresh();
      } else throw new Error(result.status === 'incomplete' ? captureErrorLabel(result.code) : 'The saved scene is unavailable.');
    } catch (cause) {
      if (cause && typeof cause === 'object' && 'draft' in cause && cause.draft && sameScope(owner)) board.acceptSavedDraft(cause.draft as Draft);
      if (sameScope(owner) && captureJob.current === job) setCaptureErrors(current => ({ ...current, [id]: cause instanceof Error ? cause.message : 'Capture failed. Retry this annotation.' }));
    } finally { if (captureJob.current === job) captureJob.current = null; setSamplingIdentity(null); setCaptureBusyId(''); setAnnotationSaving(false); }
  }

  function freezeDisplayedScene(expected: AnnotationInput, captureView: CaptureView, snapshot: BaseSceneSnapshot): FrozenBoardScene {
    const displayed = presentedObjects(displayObjects);
    const target = expected.objectId ? displayed.find(object => object.id === expected.objectId) : undefined;
    const worldBounds = expected.coordinateSpace === 'normalized' && target ? objectRegion(expected.bounds, contentBounds(target)) : expected.bounds;
    const liveObjects = displayed.map(object => { const canonical = state?.objects.find(value => value.id === object.id); return canonical ? { ...object, assetId: canonical.assetId, version: canonical.version } : object; });
    return freezeBoardScene({ board: canvas.current!, registry: sceneRegistry, view: captureView, snapshot, objects: liveObjects, exteriorObjectIds: exteriorObjects.map(object => object.id), assets, camera: view, contentBounds, objectStyles: Object.fromEntries(displayed.map(object => { const element = canvas.current!.querySelector<HTMLElement>(`.board-object[data-object-id="${CSS.escape(object.id)}"]`); const style = element && getComputedStyle(element); return [object.id, { opacity: Number(style?.opacity ?? 1), blur: Number(/blur\(([^p]+)px\)/.exec(style?.filter || '')?.[1] || 0), scale: style?.transform && style.transform !== 'none' ? new DOMMatrix(style.transform).a : 1 }]; })), annotations: allAnnotations,
      outlines: visibleOutlines.map(({ annotation, bounds }) => ({ bounds, point: annotation.geometry === 'point', dashed: !annotation.inspectionTaskId })), editingBounds, selection: selectionRect, guides: snapGuides,
      marks: annotationMarks.map((mark, index) => ({ annotationId: mark.annotation.id, pin: annotationPins[index], number: mark.number, anchor: mark.annotation.geometry === 'point' ? 'tail' as const : 'center' as const })), target: { annotation: expected, worldBounds }, clip: { x: 0, y: 0, width: innerWidth, height: innerHeight },
      onCaptureError: (cause, asset) => board.showError(new Error(`${asset?.name || 'A file'} appears as a placeholder in the annotation image: ${cause instanceof Error ? cause.message : 'its content could not be copied.'}`)) });
  }

  /** Renders and holds the frozen scene on a base snapshot that still carries its objects; the snapshot is renewed near expiry and once after rejection. */
  async function holdFrozenScene(frozen: FrozenBoardScene, expected: AnnotationInput, owner: { sessionId: string; draftId: string }, job: NonNullable<typeof captureJob.current>) {
    const { provider, controller } = job, current = () => captureJob.current === job && !controller.signal.aborted && sameScope(owner);
    const renewScene = () => new Promise<BaseSceneSnapshot>((resolve, reject) => {
      const abort = () => reject(new DOMException('This annotation capture was cancelled.', 'AbortError'));
      controller.signal.addEventListener('abort', abort, { once: true });
      provider.sceneSnapshot().then(resolve, reject).finally(() => controller.signal.removeEventListener('abort', abort));
    });
    let snapshot = frozen.snapshot;
    if (Date.parse(snapshot.expiresAt) - Date.now() < 60_000) snapshot = await renewScene();
    for (let renewed = false; ; renewed = true) {
      if (!current()) return;
      if (!frozenSceneMatches(frozen, snapshot)) throw new Error('The visible scene is still loading. Complete the annotation when it is ready.');
      const draft = board.getDraftFor(owner.sessionId, owner.draftId);
      if (!draft || !annotationMatches(owner, expected)) return;
      const evidence = evidenceRenderer.render(frozen, snapshot), presentation = evidence.presentation, cropCSS = evidence.crop.cropCSS;
      const viewport = { x: presentation.camera.x + presentation.cssViewport.x, y: presentation.camera.y + presentation.cssViewport.y, zoom: presentation.camera.zoom, width: frozen.clip.width, height: frozen.clip.height, devicePixelRatio: presentation.bitmap.width / presentation.cssViewport.width };
      try {
        return await provider.freezeAndHold({ draft, annotation: expected, signal: controller.signal, freeze: () => ({ presentation, cropCSS, encodePNG: () => evidence.encodePNG() }),
          worldBounds: frozen.worldBounds, viewport, scene: presentedCaptureScene(presentation, snapshot, cropCSS, expected, frozen.sources, assets.filter(asset => asset.id === expected.snapshotAssetId)) });
      } catch (cause) {
        const code = cause && typeof cause === 'object' && 'code' in cause ? String(cause.code) : '';
        if (renewed || !current() || !['scene_source_expired', 'scene_source_missing'].includes(code)) throw cause;
        snapshot = await renewScene();
      }
    }
  }

  function updateCaptureImageAvailability(owner: { sessionId: string; draftId: string }, expected: AnnotationInput, available: boolean) {
    if (!expected.capture || !annotationMatches(owner, expected)) return;
    setCaptureErrors(errors => ({ ...errors, [expected.id]: available ? '' : 'Captured image unavailable. Capture again or remove this annotation.' }));
  }

  function annotationMatches(owner: { sessionId: string; draftId: string }, expected: AnnotationInput) {
    if (!sameScope(owner)) return false;
    const current = board.getDraftFor(owner.sessionId, owner.draftId)?.annotations.find(value => value.id === expected.id);
    return !!current && current.captureState?.version === expected.captureState?.version && JSON.stringify(annotationTarget(current)) === JSON.stringify(annotationTarget(expected)) &&
      current.capture?.id === expected.capture?.id && current.capture?.screenshotAssetId === expected.capture?.screenshotAssetId && current.capture?.sessionId === expected.capture?.sessionId &&
      current.capture?.draftId === expected.capture?.draftId && current.capture?.annotationId === expected.capture?.annotationId && current.capture?.version === expected.capture?.version;
  }

  function captureErrorLabel(code: string) {
    if (code === 'capture_cancelled') return 'Capture cancelled. Retry when ready.';
    if (code === 'capture_timeout') return 'Capture timed out. Retry this annotation.';
    if (code === 'capture_scene_changed' || code === 'capture_scene_conflict') return 'The scene changed during capture. Retry this annotation.';
    return 'The scene could not be saved. Retry this annotation.';
  }

  async function cancelCapture() {
    const job = captureJob.current; captureJob.current = null; captureGeneration.current++;
    if (!job) return;
    job.controller.abort();
    const owner = job.owner;
    try {
      if (job.identity) { const retry = await job.provider.cancel(job.identity); if (retry && sameScope(owner)) board.acceptSavedDraft(retry.draft); }
      if (job.persisted) await removePendingEvidence(job.persisted);
    } catch (cause) { if (sameScope(owner)) board.showError(cause); }
    for (const [key, retained] of retainedCaptures.current) if (retained.frame.identity.annotationId === owner.annotationId && retained.frame.identity.sessionId === owner.sessionId && retained.frame.identity.draftId === owner.draftId) retainedCaptures.current.delete(key);
    if (sameScope(owner)) setCaptureErrors(current => ({ ...current, [owner.annotationId]: 'Capture cancelled. Retry when ready.' }));
    setCaptureBusyId(''); setAnnotationSaving(false);
  }

  function removeDraftAnnotation(annotationId: string, clearError = false) {
    const owner = { ...scope.current };
    if (annotationReader?.draftId === owner.draftId && annotationReader.sessionId === owner.sessionId && annotationReader.annotationId === annotationId) closeAnnotation();
    for (const [key, edit] of comments.current) if (edit.sessionId === owner.sessionId && edit.draftId === owner.draftId && edit.value.id === annotationId) comments.current.delete(key);
    board.changeDraftFor(owner.sessionId, owner.draftId, current => ({ ...current, annotations: current.annotations.filter(annotation => annotation.id !== annotationId) }));
    setCaptureErrors(current => { const next = { ...current }; delete next[annotationId]; return next; });
    if (clearError) board.setError('');
  }

  async function removeSelection() {
    if (!selected.length || disabled) return;
    const owner = { ...scope.current }, ids = new Set(selectedIds);
    setRemovingObjects(true);
    try {
      await board.operations(selected.map(object => ({ type: 'delete', objectId: object.id, expectedVersion: object.version })), owner.sessionId);
      for (const [key, edit] of comments.current) if (edit.sessionId === owner.sessionId && edit.draftId === owner.draftId && edit.value.objectIds.some(id => ids.has(id)) && !board.getDraftFor(owner.sessionId, owner.draftId)?.annotations.find(annotation => annotation.id === edit.value.id)?.capture && !board.getDraftFor(owner.sessionId, owner.draftId)?.annotations.find(annotation => annotation.id === edit.value.id)?.sceneSource && captureJob.current?.owner.annotationId !== edit.value.id) comments.current.delete(key);
      board.changeDraftFor(owner.sessionId, owner.draftId, current => ({ ...current, annotations: current.annotations.filter(annotation => !!annotation.capture || !!annotation.sceneSource || captureJob.current?.owner.annotationId === annotation.id || !annotation.objectIds.some(id => ids.has(id))) }));
      setCommentRevision(revision => revision + 1); selectObjects([]);
    } catch { /* The service error and original input remain available. */ }
    finally { setRemovingObjects(false); }
  }

  async function sendRequest() {
    if (disabled || committing.current || uploads.length || board.draftConflict || composing.current || commentComposing.current) return;
    confirmReferencePreview();
    const latest = board.getDraftFor(scope.current.sessionId, scope.current.draftId);
    if (!latest || !(latest.text.trim() || latest.attachments.length || latest.annotations.length || latest.references.objectIds.length || latest.references.taskIds.length || latest.references.groupIds?.length)) return;
    if (latest.annotations.some(annotation => annotation.captureState?.status === 'incomplete')) { board.showError(new Error('Complete each annotation capture before sending.')); return; }
    if (latest.annotations.some(annotation => !!captureErrors[annotation.id])) { board.showError(new Error('Capture each unavailable annotation again before sending.')); return; }
    const owner = { ...scope.current };
    committing.current = true; setAnnotationSaving(true);
    try {
      if (unavailableComments.length) throw new Error('This comment refers to a removed file. Discard it from the draft to continue.');
      for (const edit of comments.current.values()) if (edit.sessionId === owner.sessionId && edit.draftId === owner.draftId && board.getDraftFor(owner.sessionId, owner.draftId)?.annotations.some(annotation => annotation.id === edit.value.id)) {
        await prepareComment(edit);
      }
      await board.flushDraft(owner.sessionId);
      if (!sameScope(owner)) throw new Error('The request scope has changed. Continue in the original draft.');
      const task = await board.send();
      if (task && (task.draftId === owner.draftId || task.lastEditDraftId === owner.draftId) && task.sessionId === scope.current.sessionId) {
        clearInspection(); exitAnnotation(); setMode('select'); setReferencePreview([]); setCapturedHistory(null); setTaskDetailId('');
        setHistoryOpen(false); setSentTaskId(task.id);
        for (const [key, edit] of comments.current) if (edit.sessionId === owner.sessionId && edit.draftId === owner.draftId) comments.current.delete(key);
        requestAnimationFrame(() => instruction.current?.focus({ preventScroll: true }));

      }
    } catch (cause) { board.showError(cause); }
    finally { committing.current = false; setAnnotationSaving(false); }
  }

  function animateView(next: Partial<SessionView>) { if (!disabled && state) fitMotion.animate({ ...view, ...next }); }
  function beginGroupTransition(id: string, kind: 'collapse' | 'expand' | 'enter' | 'leave', ghost?: BoardGroup) {
    window.clearTimeout(transitionTimer.current);
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) { setGroupTransition(null); return; }
    setGroupTransition({ id, kind, ghost });
    if (!ghost) transitionTimer.current = window.setTimeout(() => setGroupTransition(null), 620);
  }
  useEffect(() => () => window.clearTimeout(transitionTimer.current), []);
  useEffect(() => {
    if (!groupTransition?.ghost || groups.some(group => group.id === groupTransition.id)) return;
    transitionTimer.current = window.setTimeout(() => setGroupTransition(null), 620);
    return () => window.clearTimeout(transitionTimer.current);
  }, [groupTransition, state?.groups]);
  const snapObjects = objects.map(object => ({ ...object, id: `object:${object.id}` }));
  const snapTargets = activeGroup ? snapObjects : [...snapObjects, ...groups.filter(group => group.mode === 'folder' && group.id !== selectedGroupId).map(group => ({ ...groupDisplayBounds(group), id: `group:${group.id}` }))];
  function enterGroup(group: BoardGroup) {
    if (disabled) return;
    clearInspection(); exitAnnotation(); selectGroupTarget(''); setReferencePreview([]); setPreview({}); setMode('select');
    const size = { width: canvas.current!.clientWidth, height: canvas.current!.clientHeight };
    const members = allObjects.filter(object => object.groupId === group.id);
    const next = members.length ? fitView(members, size) : { x: size.width / 2 - group.x, y: size.height / 2 - group.y, zoom: 1 };
    beginGroupTransition(group.id, 'enter');
    animateView({ ...next, activeGroupId: group.id, parentView: view.parentView || { x: view.x, y: view.y, zoom: view.zoom }, selectedObjectIds: [] });
    canvas.current?.focus({ preventScroll: true });
  }
  function leaveGroup() {
    clearInspection(); exitAnnotation(); selectGroupTarget(''); setReferencePreview([]); setPreview({}); setMode('select');
    if (activeGroup) beginGroupTransition(activeGroup.id, 'leave');
    animateView({ ...(view.parentView || {}), activeGroupId: undefined, parentView: undefined, selectedObjectIds: [] });
    canvas.current?.focus({ preventScroll: true });
  }
  async function createGroup() {
    if (!state || selected.length < 2 || activeGroup || selected.some(object => object.groupId)) return;
    const id = randomId();
    await writeLayout([{ type: 'group.create', group: { id, objectIds: selected.map(object => object.id) }, expectedVersions: Object.fromEntries(selected.map(object => [object.id, object.version])) }], state.session.id);
    selectGroupTarget(id); setReferencePreview([{ kind: 'group', id }]); viewUpdate({ selectedObjectIds: [] });
  }
  function updateGroup(group: BoardGroup, changes: { name?: string; mode?: 'folder' | 'frame' }) {
    if (!state) return;
    if (activeGroup && changes.mode === 'frame') leaveGroup();
    if (changes.mode) beginGroupTransition(group.id, changes.mode === 'folder' ? 'collapse' : 'expand');
    void writeLayout([{ type: 'group.update', groupId: group.id, expectedVersion: group.version, changes }], state.session.id);
  }
  async function ungroup(group: BoardGroup) {
    if (!state || disabled || layoutBusy.current) return;
    if (activeGroup) leaveGroup();
    selectGroupTarget(''); setReferencePreview([]);
    if (group.mode === 'folder') beginGroupTransition(group.id, 'expand', group);
    const completed = await writeLayout([{ type: 'group.ungroup', groupId: group.id, expectedVersion: group.version }], state.session.id);
    if (!completed) setGroupTransition(null);
  }
  function groupActions(group: BoardGroup) {
    return <div className="group-action-list"><GroupActionButton label="Rename" disabled={disabled} onClick={() => { if (!activeGroup) selectGroup(group); setRenamingGroupId(group.id); }}><PencilLine size={16}/></GroupActionButton>
      <GroupActionButton label={group.mode === 'frame' ? 'Store in folder' : 'Expand on board'} disabled={disabled} onClick={() => updateGroup(group, { mode: group.mode === 'frame' ? 'folder' : 'frame' })}>{group.mode === 'frame' ? <FolderInput size={16}/> : <FolderOutput size={16}/>}</GroupActionButton><GroupActionButton label="Ungroup" disabled={disabled} onClick={() => void ungroup(group)}><FontAwesomeObjectIcon ungroup/></GroupActionButton></div>;
  }
  function groupName(group: BoardGroup, className = '') {
    return <GroupName group={group} className={className} editing={renamingGroupId === group.id} onCancel={() => setRenamingGroupId('')} onCommit={name => { setRenamingGroupId(''); if (name !== group.name) updateGroup(group, { name }); }}/>;
  }
  function renderGroup(group: BoardGroup, exterior = false) {
    const bounds = groupDisplayBounds(group);
    const transitionGhost = !!activeGroup && group.id === activeGroup.id && groupTransition?.kind === 'enter' || groupTransition?.ghost === group && !groups.some(value => value.id === group.id);
    const groupKeyDown = (event: React.KeyboardEvent<HTMLElement>, selectOnly = false) => {
      if (event.target !== event.currentTarget || disabled) return;
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault(); if (group.mode === 'folder' && !selectOnly) enterGroup(group); else selectGroup(group);
      }
      const delta = { ArrowLeft: [-10, 0], ArrowRight: [10, 0], ArrowUp: [0, -10], ArrowDown: [0, 10] }[event.key];
      if (delta && state) { event.preventDefault(); void writeLayout([{ type: 'group.update', groupId: group.id, expectedVersion: group.version, changes: { x: group.x + delta[0], y: group.y + delta[1] } }], state.session.id); }
    };
    return <section key={group.id} className={`board-group group-${group.mode}${exterior ? ' group-exterior' : ''}${transitionGhost ? ' group-transition-ghost' : ''}`} data-transition-group={groupTransition?.id === group.id || undefined} data-moving={gesture.current?.group?.id === group.id || undefined} data-group-id={group.id} data-group-color={group.color} data-group-name={group.name} data-group-count={group.objectIds.length} data-folder-open={!exterior && group.mode === 'folder' && (hoveredGroupId === group.id || focusedGroupId === group.id) || undefined} inert={exterior} aria-hidden={exterior || undefined} aria-label={`${group.name}, ${group.objectIds.length} items`} style={{ left: bounds.x, top: bounds.y, width: bounds.width, height: bounds.height, ...(groupPosition?.id === group.id && groupPosition.scale ? { transform: `scale(${groupPosition.scale})`, transformOrigin: '0 0' } : {}) }} onPointerEnter={() => { if (!exterior && group.mode === 'folder') hoverGroupTarget(group.id); }} onPointerLeave={event => { if (!(event.relatedTarget as Element | null)?.closest?.(`[data-group-actions-id="${group.id}"]`)) releaseGroupTarget(group.id, 'hoveredId'); }} onFocusCapture={() => { if (!exterior) focusGroupTarget(group.id); }} onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget as Node) && !(event.relatedTarget as Element | null)?.closest?.(`[data-group-actions-id="${group.id}"]`)) releaseGroupTarget(group.id, 'focusedId'); }}>
      {group.mode === 'frame' ? <div className="group-frame-title" data-renaming={renamingGroupId === group.id || undefined} data-canvas-control={renamingGroupId === group.id || undefined}><button className="group-frame-select" type="button" disabled={disabled} onDoubleClick={() => setRenamingGroupId(group.id)} aria-label={`Select group ${group.name}`} onKeyDown={groupKeyDown}/>{groupName(group)}</div> : <><div className="group-folder-hit" tabIndex={exterior ? -1 : 0} role="button" aria-disabled={disabled || undefined} aria-label={`Open folder ${group.name}`} onKeyDown={groupKeyDown}><GroupFolder group={group} objects={allObjects} assets={assets} api={board.api}/></div><div className="folder-caption" role={renamingGroupId === group.id ? undefined : 'button'} tabIndex={renamingGroupId === group.id ? undefined : exterior ? -1 : 0} aria-disabled={disabled || undefined} aria-label={renamingGroupId === group.id ? undefined : `Select group ${group.name}`} onKeyDown={event => groupKeyDown(event, true)}>{groupName(group, 'folder-name')}</div></>}
    </section>;
  }

  async function writeLayout(operations: BoardOperation[], sessionId: string) {
    if (!operations.length || layoutBusy.current) return;
    layoutBusy.current = true; setLayoutSaving(true);
    try { await board.operations(operations, sessionId); return true; }
    catch { return false; }
    finally { layoutBusy.current = false; dragAppearance.current = {}; setLayoutSaving(false); setPreview({}); }
  }

  async function alignSelection(alignment: Alignment) {
    if (!state || disabled || layoutBusy.current || selected.length < 2) return;
    const positions = alignedPositions(selected, alignment);
    const operations = positions.map(position => { const object = selected.find(value => value.id === position.id)!; return { type: 'update' as const, objectId: object.id, expectedVersion: object.version, changes: { x: position.x, y: position.y } }; });
    const sessionId = state.session.id;
    setSnapGuides([]); await writeLayout(operations, sessionId);
  }

  function previewMove(active: Gesture, point: Point, bypass: boolean) {
    active.point = point;
    if (!active.moved && Math.hypot(point.x - active.start.x, point.y - active.start.y) < 3) return;
    active.moved = true;
    const delta = { x: (point.x - active.start.x) / active.view.zoom, y: (point.y - active.start.y) / active.view.zoom };
    const size = canvas.current!.getBoundingClientRect();
    if (active.kind === 'resize') { const object = active.objects[0], capability = capabilityFor(object), result = capability.freeResize ? snapViewportResize({ ...object, id: `object:${object.id}` }, active.resizeCorner || 'se', delta, snapTargets, active.view, size, capability.minimum, bypass) : snapResize({ ...object, id: `object:${object.id}` }, (active.resizeCorner || 'se') as ResizeCorner, delta, snapTargets, active.view, size, bypass); active.preview = { [object.id]: result.bounds }; setPreview(active.preview); setSnapGuides(result.guides); return; }
    const moving = active.group ? [{ ...groupDisplayBounds(active.group), id: `group:${active.group.id}` }] : active.objects.map(object => ({ ...object, id: `object:${object.id}` }));
    const result = !bypass ? snapTranslation(moving, snapTargets.filter(object => !active.group?.objectIds.some(id => `object:${id}` === object.id)), delta, active.view, size) : { delta, guides: [] };
    active.preview = Object.fromEntries(active.objects.map(object => [object.id, { x: object.x + result.delta.x, y: object.y + result.delta.y, width: object.width, height: object.height }]));
    setPreview(active.preview); setSnapGuides(result.guides);
    if (active.group) setGroupPosition(current => ({ id: active.group!.id, x: active.group!.x + result.delta.x, y: active.group!.y + result.delta.y, scale: current?.scale }));
  }
  updateDrag.current = previewMove;

  function pointerDown(event: ReactPointerEvent<HTMLElement> | CanvasPointerInput, contentDrag = false) {
    if (disabled || layoutBusy.current || !state || (event.button !== 0 && event.button !== 1) || !contentDrag && (event.target as Element).closest('[data-canvas-control]')) return;
    updateMarkHover(null);
    const targetObjectId = (event.target as Element).closest<HTMLElement>('[data-object-id]')?.dataset.objectId;
    const targetGroupId = targetObjectId ? undefined : (event.target as Element).closest<HTMLElement>('[data-group-id]')?.dataset.groupId;
    const shown = groupTransition ? presentedObjects(allObjects) : allObjects;
    const movingIds = targetGroupId ? allObjects.filter(object => object.groupId === targetGroupId).map(object => object.id) : targetObjectId ? selectedIds.includes(targetObjectId) ? selectedIds : [targetObjectId] : [];
    const poses = new Map(shown.map(object => [object.id, object]));
    const rootBox = canvas.current!.getBoundingClientRect(), rootScale = rootBox.width / canvas.current!.clientWidth;
    const groupElement = targetGroupId && canvas.current?.querySelector<HTMLElement>(`[data-group-id="${CSS.escape(targetGroupId)}"]`);
    const groupArt = groupElement && (groupElement.querySelector<HTMLElement>('.group-folder-hit') || groupElement);
    const groupBox = groupArt && groupArt.getBoundingClientRect();
    const groupPose = groupBox ? { x: (groupBox.x - rootBox.x - view.x * rootScale) / (view.zoom * rootScale), y: (groupBox.y - rootBox.y - view.y * rootScale) / (view.zoom * rootScale), scale: groupArt!.classList.contains('group-folder-hit') ? groupBox.width / (216 * view.zoom * rootScale) : 1 } : undefined;
    if (groupTransition) {
      window.clearTimeout(transitionTimer.current); setGroupTransition(null);
      dragAppearance.current = {};
      canvas.current?.querySelectorAll<HTMLElement>('.board-object,.board-group').forEach(element => {
        const id = element.dataset.objectId, owned = id ? movingIds.includes(id) : element.dataset.groupId === targetGroupId;
        if (owned && id && poses.has(id)) { const style = getComputedStyle(element); dragAppearance.current[id] = { scale: poses.get(id)!.width / allObjects.find(object => object.id === id)!.width, opacity: Number(style.opacity) }; }
        element.getAnimations().forEach(animation => owned ? animation.cancel() : animation.finish());
      });
    }
    const gestureObjects = objects.map(object => poses.has(object.id) ? { ...object, x: poses.get(object.id)!.x, y: poses.get(object.id)!.y } : object);
    fitMotion.interrupt();
    canvas.current?.focus({ preventScroll: true });
    const point = localPoint(event);
    const displayedView = view;
    const objectId = (event.target as HTMLElement).closest<HTMLElement>('[data-object-id]')?.dataset.objectId;
    const resizeId = (event.target as HTMLElement).closest<HTMLElement>('[data-resize-id]')?.dataset.resizeId;
    const effectiveMode = spacePan || event.button === 1 ? 'pan' : mode;
    const object = gestureObjects.find(value => value.id === objectId);
    const groupId = (event.target as HTMLElement).closest<HTMLElement>('[data-group-id]')?.dataset.groupId;
    const storedGroup = !activeGroup && groups.find(group => group.id === groupId);
    const pickedGroup = storedGroup && groupPose ? { ...storedGroup, x: groupPose.x, y: groupPose.y } : storedGroup;
    if (pickedGroup && !object && !resizeId && effectiveMode === 'select') {
      selectGroup(pickedGroup);
      gesture.current = { kind: 'group', group: pickedGroup, opensGroup: !!(event.target as Element).closest('.group-folder-hit'), pointerId: event.pointerId, start: point, point, moved: false, view: displayedView, objects: allObjects.filter(object => object.groupId === pickedGroup.id).map(object => poses.has(object.id) ? { ...object, x: poses.get(object.id)!.x, y: poses.get(object.id)!.y } : object), sessionId: state.session.id };
      setGroupPosition({ id: pickedGroup.id, x: pickedGroup.x, y: pickedGroup.y, scale: groupPose?.scale });
      setPreview(Object.fromEntries(gesture.current.objects.map(object => [object.id, { x: object.x, y: object.y, width: object.width, height: object.height }])));
      canvas.current!.setPointerCapture(event.pointerId); event.preventDefault(); return;
    }
    if (effectiveMode === 'mark') {
      setSnapGuides([]);
      gesture.current = { kind: 'mark', pointerId: event.pointerId, start: point, point, moved: false, view: displayedView, objects: [], sessionId: state.session.id, commentKey: annotationEdit?.value.id };
      canvas.current!.setPointerCapture(event.pointerId); event.preventDefault(); return;
    }
    if (effectiveMode === 'note') {
      setSnapGuides([]);
      gesture.current = { kind: 'note', pointerId: event.pointerId, start: point, point, moved: false, view: displayedView, objects: [], sessionId: state.session.id };
      canvas.current!.setPointerCapture(event.pointerId); event.preventDefault(); return;
    }
    if (effectiveMode === 'select' && !object && !resizeId && !annotating) clearInspection();
    let kind: Gesture['kind'] = effectiveMode === 'pan' ? 'pan' : 'select';
    let moving: BoardObject[] = [];
    if (resizeId) { kind = 'resize'; moving = gestureObjects.filter(value => value.id === resizeId); }
    else if (effectiveMode === 'select' && object) {
      if (event.shiftKey) { selectObjects(selectedIds.includes(object.id) ? selectedIds.filter(id => id !== object.id) : [...selectedIds, object.id]); return; }
      const ids = selectedIds.includes(object.id) ? selectedIds : [object.id];
      selectObjects(ids); kind = 'move'; moving = gestureObjects.filter(value => ids.includes(value.id));
      if (movingIds.length) setPreview(Object.fromEntries(moving.map(object => [object.id, { x: object.x, y: object.y, width: object.width, height: object.height }])));
    } else if (effectiveMode === 'select' && !event.shiftKey) selectObjects([]);
    setSnapGuides([]);
    gesture.current = { kind, pointerId: event.pointerId, start: point, point, moved: false, view: displayedView, objects: moving, sessionId: state.session.id, resizeCorner: (event.target as HTMLElement).closest<HTMLElement>('[data-resize-corner]')?.dataset.resizeCorner as ResizeHandle | undefined };
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
    gesture.current = { kind: pan ? 'pan' : 'move', pointerId: event.pointerId, start: point, point, moved: false, view, objects: pan ? [] : objects.filter(value => ids.includes(value.id)), sessionId: state.session.id };
    pointerMove(event);
    canvas.current!.focus({ preventScroll: true });
  }

  function pointerMove(event: ReactPointerEvent<HTMLElement> | CanvasPointerInput) {
    const active = gesture.current;
    if (!active) { updateMarkHover((event.target as Element).closest('[data-canvas-control]') ? null : localPoint(event)); return; }
    const point = localPoint(event);
    const dx = (point.x - active.start.x) / active.view.zoom;
    const dy = (point.y - active.start.y) / active.view.zoom;
    if (active.kind === 'note') { if (Math.hypot(point.x - active.start.x, point.y - active.start.y) >= 3) active.moved = true; return; }
    if (active.kind === 'mark') { active.region = rectangle(screenToWorld(active.start, active.view), screenToWorld(point, active.view)); setMarkPreview(active.region); return; }
    if (active.kind === 'group' || active.kind === 'move' || active.kind === 'resize') previewMove(active, point, event.altKey);
    if (active.kind === 'pan') board.updateView({ ...active.view, x: active.view.x + point.x - active.start.x, y: active.view.y + point.y - active.start.y }, active.sessionId);
    if (active.kind === 'select') setSelectionRect(rectangle(screenToWorld(active.start, active.view), screenToWorld(point, active.view)));
  }

  function pointerUp(event: ReactPointerEvent<HTMLDivElement> | CanvasPointerInput) {
    const active = gesture.current;
    if (!active) return;
    gesture.current = null;
    setSnapGuides([]);
    if (!gestureController.current?.ownsPointer(event.pointerId) && event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    const point = localPoint(event);
    const region = rectangle(screenToWorld(active.start, active.view), screenToWorld(point, active.view));
    if (active.kind === 'mark') {
      const edit = active.commentKey ? comments.current.get(active.commentKey) : undefined;
      const geometry = region.width * active.view.zoom < 4 && region.height * active.view.zoom < 4 ? 'point' : 'rect';
      const world = geometry === 'point' ? { ...screenToWorld(active.start, active.view), width: 0, height: 0 } : { ...region, width: Math.max(region.width, 1 / active.view.zoom), height: Math.max(region.height, 1 / active.view.zoom) };
      applyMark(world, geometry, edit); return;
    }
    if (active.kind === 'note') { if (!active.moved) void placeNote(screenToWorld(active.start, active.view)); return; }
    if (active.kind === 'group' && active.group) {
      const shifted = groupPosition;
      if (active.moved && shifted) void writeLayout([{ type: 'group.update', groupId: active.group.id, expectedVersion: active.group.version, changes: { x: shifted.x, y: shifted.y } }], active.sessionId).finally(() => { dragAppearance.current = {}; setGroupPosition(null); });
      else { if (active.opensGroup) enterGroup(active.group); dragAppearance.current = {}; setGroupPosition(null); setPreview({}); }
      return;
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
    fitMotion.animate({ ...fitMotion.targetView(), ...zoomAt(fitMotion.targetView(), factor, { x: (canvas.current?.clientWidth || 600) / 2, y: (canvas.current?.clientHeight || 600) / 2 }) });
  }

  async function copyResume() {
    if (!state) return;
    const boardUrl = new URL(window.location.pathname, window.location.origin);
    boardUrl.searchParams.set('session', state.session.id);
    const command = `Continue the tasks on this project board. Project: ${state.project.root}; Board: ${boardUrl.href}. Check unfinished tasks and existing outputs, then process the queue in order. Register outputs and receipts after completing each task. Stop when the queue is empty or needs input.`;
    try { await navigator.clipboard.writeText(command); setNotice('Resume prompt copied.'); }
    catch { setCopyCommand(command); }
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
          comments.current.set(annotation.id, { value: { ...annotation, text: '' }, sessionId: current.sessionId, draftId: current.id, index: current.annotations.findIndex(value => value.id === annotation.id), snapshotGeneration: 0 });
          setAnnotationReader({ annotationId: annotation.id, sessionId: current.sessionId, draftId: current.id });
          requestAnimationFrame(focusAnnotation);
        } else requestAnimationFrame(() => instruction.current?.focus({ preventScroll: true }));
      }
    }
    finally { setEditingTask(false); }
  }

  function openComposerMenu(index = 0) { composerMenuIndex.current = index; setComposerMenuOpen(true); }
  function closeComposerMenu() { composerMore.current?.focus({ preventScroll: true }); setComposerMenuOpen(false); }

  function closeHistory(restoreFocus = false) {
    clearInspection(); setHistoryOpen(false); setTaskDetailId(''); setQueueExpanded(false); setQueueHovered(false); setQueueFocused(false);
    if (restoreFocus) composerMore.current?.focus({ preventScroll: true });
  }

  function hoverQueue() { window.clearTimeout(queueCloseTimer.current); setQueueHovered(true); }
  function leaveDock() { queueCloseTimer.current = window.setTimeout(() => { setQueueHovered(false); if (!dock.current?.contains(document.activeElement)) { setQueueExpanded(false); setTaskDetailId(''); } }, 140); }


  const taskCard = (task: Task, compact = false) => <TaskCard compact={compact} summary={compact && taskDetailId !== task.id} task={task} assets={assets} objects={allObjects} content={id => board.api.content(id, state?.session.id)} api={board.api} onReloadBoard={reloadBoard} onSaveError={board.showError} locateAsset={locateAsset} onAnnotationView={(value, open, annotation) => { if (open && draft?.editingTaskId === value.id && annotation) { const current = draft.annotations.find(item => item.id === annotation.id); if (current) openAnnotation(current, true); } else if (open && annotation?.capture) { exitAnnotation(); setInspectedTaskId(''); setAnnotationReader(null); setCapturedHistory({ task: value, annotation }); } else if (open) { exitAnnotation(); setInspectedTaskId(value.id); readerTrigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; setAnnotationReader(annotation && state ? { annotationId: annotation.id, sessionId: state.session.id, taskId: value.id } : null); } else if (historyOpen) { setInspectedTaskId(current => current === value.id ? '' : current); setAnnotationReader(null); } }}/>;
  const composer = state && draft && <section ref={dock} className="creation-dock" data-canvas-control aria-label="Request composer and queue" onPointerLeave={leaveDock} onPointerEnter={() => window.clearTimeout(queueCloseTimer.current)} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); if (historyOpen) { closeHistory(true); return; } setReferencePreview([]); setMention(null); clearInspection(); setTaskDetailId(''); setQueueExpanded(false); setQueueHovered(false); setQueueFocused(false); instruction.current?.focus(); } }} onDragOver={event => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); event.stopPropagation(); } }} onDrop={event => { const files = filesFromTransfer(event.dataTransfer); if (files.length) { event.preventDefault(); event.stopPropagation(); void importFiles(files); } }}>
    {(pending > 0 && !historyOpen) && <div className={`queue-stack ${queueOpen ? 'expanded' : ''} ${pending > 1 && !historyOpen ? 'has-stack' : ''}${queueExiting ? ' queue-stack-exiting' : ''}`} data-pending={pending} onPointerEnter={event => { if (event.pointerType === 'mouse') hoverQueue(); }} onFocusCapture={event => { if ((event.target as HTMLElement).matches(':focus-visible')) setQueueFocused(true); }} onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setQueueFocused(false); }}>
      {pending > 1 && !historyOpen && <div className="queue-peeks" aria-hidden="true">{Array.from({ length: Math.min(pending - 1, 2) }, (_, index) => <span key={index} style={{ '--peek': index + 1 } as React.CSSProperties}/>)}</div>}
      <div className="queue-list" id="creation-queue" role="list" aria-label="Task queue">
        {queuedTasks.map(({ task, exiting, fromStatus }, index) => <div key={task.id} className={index ? `queue-extra ${queueOpen ? 'open' : ''}` : 'queue-first'} inert={index > 0 && !queueOpen} aria-hidden={index > 0 && !queueOpen}><div className="queue-extra-content"><QueueItem task={task} detailOpen={taskDetailId === task.id} visible={queueOpen || index === 0} animateSend={sentTaskId === task.id} played={playedSendIds.current} exiting={exiting} collapsing={queueOpen} fromStatus={fromStatus} layoutRevision={queueLayoutRevision + queuedTaskState.layoutRevision}>
          <div className={`queue-row ${taskDetailId === task.id ? 'detail-open' : ''}`}><button type="button" className="queue-task" aria-label={`View request ${task.sequence}: ${requestTitle(task) || 'Attachments and annotations'} — ${statusLabels[task.status]}`} aria-expanded={taskDetailId === task.id} aria-controls={`request-details-${task.id}`} onClick={() => toggleTaskDetail(task)}>{task.status === 'completed' && exiting ? <span className="queue-task-mark queue-task-mark-done" aria-hidden="true"><LoaderCircle size={14} className="queue-task-mark-spinner spin"/><Check size={14} className="queue-task-mark-check"/></span> : ['queued', 'running'].includes(task.status) && <span className="queue-task-mark" aria-hidden="true">{task.status === 'running' ? <LoaderCircle size={14} className="spin"/> : <Circle size={14}/>}</span>}<span className={`queue-title${task.status === 'completed' && exiting ? ' queue-title-completing' : ''}`} data-queue-layout="title">{requestTitle(task) || 'Create from the attachments and annotations.'}</span></button>
          {['blocked', 'interrupted', 'editing'].includes(task.status) && <span className={`status-badge status-${task.status}`} aria-hidden="true">{statusLabels[task.status]}</span>}{task.status === 'queued' && <IconButton label={`Edit request ${task.sequence}`} disabled={disabled || !!draft.editingTaskId} onClick={() => void editRequest(task)}><Pencil size={14}/></IconButton>}{['queued', 'blocked', 'interrupted'].includes(task.status) && <IconButton label={`Cancel request ${task.sequence}`} aria-busy={cancellingTask === task.id || undefined} disabled={disabled || !!cancellingTask} onClick={() => void cancelTask(task)}><Trash2 size={14}/></IconButton>}{taskDetailId === task.id && <IconButton label="Collapse request details" onClick={() => { clearInspection(); setTaskDetailId(''); document.querySelector<HTMLButtonElement>(`.queue-item[data-task-id="${task.id}"] .queue-task`)?.focus({ preventScroll: true }); }}><ChevronDown size={14}/></IconButton>}</div>
          <MotionDisclosure open={taskDetailId === task.id} className="inline-task-detail" id={`request-details-${task.id}`} role="region" aria-label={`Request ${task.sequence}`}>{taskCard(task, true)}</MotionDisclosure>
        </QueueItem></div></div>)}
      </div>
      {!historyOpen && pending > 1 && <button type="button" className="queue-expand" aria-label={`${pending} requests`} aria-expanded={queueOpen} aria-controls="creation-queue" onClick={() => setQueueExpanded(current => !current)}>{pending}<ChevronDown size={12}/></button>}
    </div>}
    <MotionDisclosure open={historyOpen} duration={220} unmountWhenClosed className="queue-stack expanded history-stack"><div className="history-content"><div ref={historyPanel} className="queue-list history-list" id="request-history" role="region" aria-label="Request history"><div className="inline-heading"><span>Request history</span><IconButton label="Close request history" onClick={() => closeHistory(true)}><ChevronDown size={14}/></IconButton></div>{state.tasks.length ? [...state.tasks].reverse().map(task => <div key={task.id}>{taskCard(task)}</div>) : <p className="field-hint">Your requests and receipts appear here.</p>}</div></div></MotionDisclosure>
    {board.draftConflict && <section className="draft-conflict" aria-label="Resolve draft update"><strong>Draft updated elsewhere</strong><div className="conflict-comparison">{[{ label: 'Your input', value: draft }, { label: 'Saved draft', value: board.draftConflict }].map(item => <section key={item.label}><h3>{item.label}</h3><p className="conflict-text">{item.value?.text || 'No text yet'}</p><div className="conflict-references"><span>{item.value?.attachments.length || 0} attachments · {item.value?.annotations.length || 0} annotations</span>{item.value?.attachments.map(id => <small key={id}>{assetFor(id)?.name || id}</small>)}{item.value?.annotations.map(annotation => <small key={annotation.id}>{annotation.text}</small>)}</div></section>)}</div><div className="inline-actions"><button type="button" className="button" disabled={resolvingConflict} aria-busy={resolvingConflict || undefined} onClick={() => { setResolvingConflict(true); void board.resolveDraftConflict('remote').catch(board.showError).finally(() => setResolvingConflict(false)); }}>Use saved draft</button><button type="button" className="button primary" disabled={resolvingConflict} aria-busy={resolvingConflict || undefined} onClick={() => { setResolvingConflict(true); void board.resolveDraftConflict('local').catch(board.showError).finally(() => setResolvingConflict(false)); }}>Keep your draft</button></div></section>}
    {resolvingConflict && <div className="draft-resolution-status" role="status"><DominoLoader size={22}/><span>Saving draft…</span></div>}
    {!!unavailableComments.length && <div className="unavailable-comments" aria-label="Unavailable comments">{unavailableComments.map(annotation => <div key={annotation.id}><span>Removed file · {annotation.text}</span><IconButton label="Discard unavailable comment" onClick={() => removeDraftAnnotation(annotation.id, true)}><Trash2 size={14}/></IconButton></div>)}</div>}
    {copyCommand && <section className="inline-resume" aria-label="Resume prompt"><div className="inline-heading"><span>Resume prompt</span><IconButton label="Close resume prompt" onClick={() => { setCopyCommand(''); composerMore.current?.focus({ preventScroll: true }); }}><X size={14}/></IconButton></div><textarea aria-label="Resume prompt text" readOnly value={copyCommand} rows={3} onFocus={event => event.target.select()}/></section>}
    {capturedHistory?.annotation.capture && <section ref={capturedHistoryPanel} className="captured-annotation-reader" role="region" aria-label="Captured annotation"><div className="inline-heading"><span>Request {capturedHistory.task.sequence} · Captured scene</span><IconButton label="Close captured annotation" onClick={() => setCapturedHistory(null)}><X size={14}/></IconButton></div><img src={board.api.content(capturedHistory.annotation.capture.screenshotAssetId, state.session.id)} alt={`Captured scene: ${capturedHistory.annotation.text}`}/><p>{capturedHistory.annotation.text}</p><small>{new Date(capturedHistory.annotation.capture.capturedAt).toLocaleString()}</small>{capturedHistory.annotation.objectIds.some(id => objects.some(object => object.id === id)) && <button type="button" className="button" onClick={() => locateObjects(capturedHistory.annotation.objectIds)}>Locate current target</button>}</section>}

    <div className="composer-shell" data-compact={composerCompact} onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) { setComposerFocused(false); setComposerMenuOpen(false); } }}>
    <form className="composer" data-compact={composerCompact} aria-label="Request draft" data-save-state={board.saveState} onSubmit={event => { event.preventDefault(); if (!composing.current && !commentComposing.current) void sendRequest(); }}>
    {draft.editingTaskId && <div className="composer-editing"><span>Editing request {state.tasks.find(task => task.id === draft.editingTaskId)?.sequence}</span><button type="button" disabled={disabled} onClick={() => { const task = state.tasks.find(task => task.id === draft.editingTaskId); if (task) void editRequest(task, true); }}>Cancel edit</button></div>}
    {!!draft.annotations.length && <div className="draft-annotations composer-block" aria-label="Request annotations">{draft.annotations.map((annotation, index) => <div className="draft-annotation" key={annotation.id} data-capture-state={annotation.captureState?.status === 'complete' && captureErrors[annotation.id] ? 'unavailable' : annotation.captureState?.status || 'legacy'}>
      <button type="button" className="annotation-content" onClick={() => openAnnotation(annotation, true)} disabled={disabled || annotationSaving} aria-busy={annotationSaving || undefined}><AnnotationBubble number={index + 1} size={22}/>{annotation.capture && <ThumbHoverPreview src={board.api.content(annotation.capture.screenshotAssetId, state.session.id)} label={annotation.text || 'Annotation preview'}><AssetThumb key={`${annotation.capture.id}:${annotation.capture.screenshotAssetId}`} asset={assetFor(annotation.capture.screenshotAssetId)} src={board.api.content(annotation.capture.screenshotAssetId, state.session.id)} onError={() => updateCaptureImageAvailability({ sessionId: state.session.id, draftId: draft.id }, annotation, false)} onLoad={() => updateCaptureImageAvailability({ sessionId: state.session.id, draftId: draft.id }, annotation, true)}/></ThumbHoverPreview>}<span>{annotation.text}{annotation.timeStart !== undefined && <small>{`${timeLabel(annotation.timeStart)}${annotation.timeEnd !== undefined ? ` – ${timeLabel(annotation.timeEnd)}` : ''}`}</small>}</span></button>
      <IconButton label={`Remove annotation ${index + 1}`} disabled={disabled} onClick={() => removeDraftAnnotation(annotation.id)}><X size={13}/></IconButton>
    </div>)}</div>}
    {!!draft.attachments.length && <div className="draft-attachments composer-block" aria-label="Request attachments">{draft.attachments.map(id => { const asset = assetFor(id); return <div className="draft-asset" key={id}><AssetThumb asset={asset} src={board.api.content(id)}/><span title={asset?.name}>{asset?.name || 'Loading file'}</span><IconButton label={`Remove attachment ${asset?.name || id}`} disabled={disabled} onClick={() => board.changeDraft(current => ({ ...current, attachments: current.attachments.filter(value => value !== id) }))}><X size={13}/></IconButton></div>; })}</div>}
      <div className="composer-input-row">
      <button ref={composerMore} type="button" className="composer-more" aria-label="More request actions" aria-haspopup="menu" aria-expanded={composerMenuOpen} aria-controls="composer-actions" onClick={() => { if (composerMenuOpen) closeComposerMenu(); else openComposerMenu(); }} onKeyDown={event => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); event.stopPropagation(); openComposerMenu(event.key === 'ArrowUp' ? 1 : 0); }
        else if (event.key === 'Escape' && composerMenuOpen) { event.preventDefault(); event.stopPropagation(); closeComposerMenu(); }
      }}><Ellipsis size={16}/></button>
      <ChatboxEditor draft={draft} preview={referencePreview} groups={groups} objects={allObjects} assets={assets} tasks={state.tasks} content={id => board.api.content(id, state.session.id)} inputRef={instruction} controller={editor} composing={composing} disabled={board.projectChanged || board.switching || board.sending} placeholder={composerCompact ? 'Create…' : 'What would you like to create?'} expanded={!!mention} activeDescendant={mention && candidates[mentionIndex] ? `reference-option-${mentionIndex}` : undefined} onChange={value => board.changeDraft(current => ({ ...current, ...value }))} onCaret={updateMention} onConsumePreview={() => setReferencePreview([])} onPreviewRemove={entry => setReferencePreview(current => current.filter(value => value.kind !== entry.kind || value.id !== entry.id))} onUserPointer={confirmReferencePreview} onFocus={() => { setComposerFocused(true); if (tabFocus.current) confirmReferencePreview(); tabFocus.current = false; }} onComposition={active => { if (active) setMention(null); }} onKeyDown={event => {
        if (composing.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setMention(null); setReferencePreview([]); return; }
        if (mention && ['ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); setMentionIndex(current => candidates.length ? (current + (event.key === 'ArrowDown' ? 1 : -1) + candidates.length) % candidates.length : 0); return; }
        if (event.key !== 'Enter' || event.shiftKey) return;
        event.preventDefault(); if (mention) { if (candidates[mentionIndex]) chooseReference(candidates[mentionIndex]); } else void sendRequest();
      }}/><button className="send-button" type="submit" disabled={disabled || !!uploads.length || !!board.draftConflict || !hasRequest || !!incompleteAnnotations.length || draft.annotations.some(annotation => !!captureErrors[annotation.id])} aria-busy={board.sending || annotationSaving || undefined} aria-label={draft.editingTaskId ? "Save edit" : "Send request"}>{board.sending || annotationSaving ? <DominoLoader size={24}/> : <ArrowUp size={16}/>}</button>
      </div>
    </form>
    {mention && <ReferenceSearch candidates={candidates} selected={mentionIndex} content={id => board.api.content(id, state.session.id)} onSelect={chooseReference} onHover={setMentionIndex}/>}
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
  if (state && board.connection !== 'connected' && !board.projectChanged) notificationItems.push({ id: 'connection', content: <div className="connection-feedback" role="status"><DominoLoader size={22}/>{board.connection === 'reconnecting' ? 'Reconnecting…' : 'Connecting…'}</div> });
  for (const upload of uploads) notificationItems.push({ id: `upload-${upload.id}`, content: <div className="upload-list" aria-live="polite"><div><DominoLoader size={24}/><span>Importing {upload.name}</span><IconButton label={`Cancel import ${upload.name}`} onClick={() => upload.controller.abort()}><X size={15}/></IconButton></div></div> });
  const notificationList = <NotificationStack items={notificationItems} notices={notices} elementRef={notifications}/>;

  pointerHandlers.current = { down: pointerDown, move: pointerMove, up: pointerUp, cancel: () => { const active = gesture.current; gesture.current = null; if (active && !gestureController.current?.ownsPointer(active.pointerId) && canvas.current?.hasPointerCapture(active.pointerId)) canvas.current.releasePointerCapture(active.pointerId); updateMarkHover(null); setPreview({}); setSelectionRect(null); setSnapGuides([]); setMarkPreview(null); } };
  if (!state || !draft) return <><main className="startup"><span className="brand"><img className="brand-icon" src="/brand/acanvas-icon.svg" alt=""/>Acanvas</span>{board.error ? <h1>Unable to open the board</h1> : <div className="startup-loading" role="status"><DominoLoader/><p>Opening your board…</p></div>}</main>{notificationList}</>;

  return <div className="app-shell" data-capturing={!!captureBusyId || undefined} data-sampling={!!samplingIdentity || undefined}><a className="skip-link" href="#whiteboard">Skip to canvas</a>
    <main className="canvas-main"><div id="whiteboard" className={`whiteboard mode-${spacePan ? 'pan' : mode} ${dragOver ? 'drag-over' : ''} ${board.switching ? 'is-loading' : ''}`} ref={canvas} data-view-id={projectScene?.view?.viewId} data-view-generation={projectScene?.view?.viewGeneration} tabIndex={0} role="region" aria-label="Project board. Enter selects files, arrow keys move them, and Space pans the canvas." onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerLeave={() => updateMarkHover(null)} onPointerCancel={() => { gesture.current = null; dragAppearance.current = {}; setGroupPosition(null); updateMarkHover(null); setPreview({}); setSelectionRect(null); setSnapGuides([]); setMarkPreview(null); }} onKeyDown={event => { if (event.target !== event.currentTarget || disabled) return; if (event.key === ' ') { event.preventDefault(); setSpacePan(true); } if (event.key === 'Enter' && mode === 'mark') { event.preventDefault(); if (selected.length === 1 && !annotationEdit) enterAnnotation(); else { const point = screenToWorld({ x: canvas.current!.clientWidth / 2, y: canvas.current!.clientHeight / 2 }, view); applyMark({ ...point, width: 0, height: 0 }, 'point', annotationEdit); } } if (event.key === 'Escape') { setReferencePreview([]); if (captureBusyId) void cancelCapture(); else if (annotationRead) closeAnnotation(); else if (annotating) { exitAnnotation(); setMode('select'); } else { clearInspection(); selectObjects([]); setMode('select'); } } if (event.key === '+' || event.key === '=') { event.preventDefault(); zoom(1.2); } if (event.key === '-') { event.preventDefault(); zoom(1 / 1.2); } }} onKeyUp={event => { if (event.key === ' ') setSpacePan(false); }} onBlur={() => setSpacePan(false)} onDragOver={event => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); setDragOver(true); } }} onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragOver(false); }} onDrop={event => { event.preventDefault(); setDragOver(false); void importFiles(filesFromTransfer(event.dataTransfer), localPoint(event)); }}>
      {activeGroup && <div className="group-navigation" data-canvas-control><div className="group-navigation-header"><GroupActionButton label="Back to board" onClick={leaveGroup}><ArrowLeft size={16}/></GroupActionButton>{groupName(activeGroup, 'group-navigation-name')}</div>{groupActions(activeGroup)}</div>}
      <div className={`canvas-world${groupTransition ? ' layout-transitioning' : ''}`} data-transition-kind={groupTransition?.kind} style={{ transform: `translate(${view.x}px,${view.y}px) scale(${view.zoom})` }}>{!activeGroup && groups.map(group => renderGroup(group))}{!activeGroup && groupTransition?.ghost && !groups.some(group => group.id === groupTransition.ghost!.id) && renderGroup(groupTransition.ghost, true)}{activeGroup && groups.filter(group => group.id !== activeGroup.id).map(group => renderGroup(group, true))}{activeGroup && groupTransition?.kind === 'enter' && renderGroup(activeGroup, true)}{displayObjects.map((object, index) => { const canonical = state.objects.find(value => value.id === object.id) || object; const asset = assetFor(canonical.assetId); const exterior = exteriorObjects.some(item => item.id === object.id); const departing = departingObjects.some(item => item.id === object.id); const arriving = !!groupTransition && (groupTransition.id === object.groupId || !!groupTransition.ghost?.objectIds.includes(object.id)) && (groupTransition.kind === 'enter' || groupTransition.kind === 'expand'); const isSelected = !exterior && !departing && selectedIds.includes(object.id); return <article key={object.id} className={`board-object object-${object.type} ${isSelected ? 'selected' : ''} ${exterior ? 'group-exterior' : ''} ${departing ? 'group-member-departing' : ''} ${arriving ? 'group-member-arriving' : ''}`} inert={exterior || departing} data-moving={gesture.current?.objects.some(item => item.id === object.id) || undefined} aria-hidden={exterior || undefined} data-object-id={object.id} data-content-kind={resolveContentKind(asset)} data-object-version={canonical.version} data-selected={isSelected || undefined} style={{ left: object.x, top: object.y, width: object.width, height: object.height, ...(dragAppearance.current[object.id] ? { transform: `scale(${dragAppearance.current[object.id].scale})`, transformOrigin: '0 0', opacity: dragAppearance.current[object.id].opacity } : {}), ...(departing && departingGroup ? { transform: `translate(${departingGroup.x + 20 - object.x}px,${departingGroup.y + 16 - object.y}px) scale(.22)` } : {}) }} tabIndex={exterior || departing ? -1 : 0} role="group" aria-label={`${asset?.name || 'File'}${isSelected ? ', selected' : ''}`} onKeyDown={event => { if (event.target !== event.currentTarget || disabled) return; if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); selectObjects(event.shiftKey ? unique([...selectedIds, object.id]) : [object.id]); } const delta = { ArrowLeft: [-10, 0], ArrowRight: [10, 0], ArrowUp: [0, -10], ArrowDown: [0, 10] }[event.key]; if (delta) { event.preventDefault(); event.stopPropagation(); void board.operations([{ type: 'update', objectId: object.id, expectedVersion: object.version, changes: { x: object.x + delta[0], y: object.y + delta[1] } }]).catch(() => undefined); } }}>
        <div className="object-media"><SceneContentContext.Provider value={{ registry: sceneRegistry, objectId: object.id, width: object.width, height: object.height, captureView: projectScene?.view }}><ContentRenderer asset={asset} src={board.api.content(canonical.assetId)} api={board.api} objectId={object.id} objectVersion={canonical.version} sessionId={state.session.id} readOnly={!!board.historyBusy || exterior || departing} saveContent={(text, expectedVersion) => board.saveContent(object.id, text, expectedVersion, state.session.id)} registerContentEditor={board.registerContentEditor} onContentDirtyChange={dirty => board.setContentDirty(state.session.id, object.id, dirty)} onContentCompositionChange={composing => board.setContentComposing(state.session.id, object.id, composing)} onReloadBoard={reloadBoard} onBlankPointerDown={event => { event.stopPropagation(); pointerDown(event, true); }} onFrameWheel={canvasWheel} onFrameDrag={(frame, start, event) => frameDrag(object.id, frame, start, event)} disabled={disabled || annotating || exterior} preserveScene={annotating || !!annotationRead} error={mediaErrors[object.id]} onSize={size => setMediaSizes(current => ({ ...current, [object.id]: size }))} onError={() => setMediaErrors(current => ({ ...current, [object.id]: true }))} onActivate={() => selectObjects([object.id])} onSaveError={board.showError} fill={shownNoteFill(object)} onMediaElement={element => { const refs = resolveContentKind(asset) === 'audio' ? audioRefs.current : videoRefs.current; if (element) (refs as Map<string, HTMLMediaElement>).set(object.id, element); else refs.delete(object.id); }}/></SceneContentContext.Provider></div>
        <div className="object-caption"><span className="object-index">{String(index + 1).padStart(2, '0')}</span><span title={asset?.name}>{asset?.name || 'File'}</span>{object.sourceTaskId && <span className="generated-label">Output</span>}</div>{isSelected && ((capabilityFor(object).freeResize ? ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] : ['nw', 'ne', 'sw', 'se']) as ResizeHandle[]).map(corner => <button key={corner} type="button" className="resize-handle" data-resize-id={object.id} data-resize-corner={corner} aria-label={`Resize ${asset?.name || 'File'} ${ { nw: 'top left', n: 'top', ne: 'top right', e: 'right', se: 'bottom right', s: 'bottom', sw: 'bottom left', w: 'left' }[corner]}`} onKeyDown={event => { if (!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key) || layoutBusy.current || disabled) return; event.preventDefault(); event.stopPropagation(); const delta = { x: event.key === 'ArrowRight' ? 10 : event.key === 'ArrowLeft' ? -10 : 0, y: event.key === 'ArrowDown' ? 10 : event.key === 'ArrowUp' ? -10 : 0 }; const capability = capabilityFor(object), bounds = capability.freeResize ? resizeViewportBounds(object, corner, delta, capability.minimum) : resizeBounds(object, corner as ResizeCorner, delta); void writeLayout([{ type: 'update', objectId: object.id, expectedVersion: object.version, changes: bounds }], state.session.id); }}/>) }</article>; })}
      {visibleOutlines.map(({ annotation, bounds }) => <div className={`annotation-outline ${!annotation.inspectionTaskId ? 'draft-outline' : ''}`} key={`${annotation.inspectionTaskId || 'draft'}-${annotation.id}`} data-annotation-id={annotation.id} data-annotation-source={annotation.inspectionTaskId ? 'task' : 'draft'} data-source-removed={annotation.objectIds.some(id => !allObjects.some(object => object.id === id)) || undefined} style={{ left: bounds.x, top: bounds.y, width: bounds.width, height: bounds.height }}/>)}
      {editingBounds && <div className="annotation-outline editing-outline" data-annotation-source="editing" style={{ left: editingBounds.x, top: editingBounds.y, width: editingBounds.width, height: editingBounds.height }}/>}
      {!!snapGuides.length && <svg className="alignment-guides" aria-hidden="true">{snapGuides.map(guide => <line key={guide.axis} data-snap-axis={guide.axis} vectorEffect="non-scaling-stroke" x1={guide.axis === 'x' ? guide.position : guide.start} y1={guide.axis === 'y' ? guide.position : guide.start} x2={guide.axis === 'x' ? guide.position : guide.end} y2={guide.axis === 'y' ? guide.position : guide.end}/>)}</svg>}
      {selectionRect && <div className="selection-rect" style={{ left: selectionRect.x, top: selectionRect.y, width: selectionRect.width, height: selectionRect.height }}/> }</div>
      {allAnnotations.map((annotation, index) => {
        const bounds = annotationBounds(annotation); if (!bounds) return null;
        const active = annotationActive(annotation);
        const editable = active && readerEditable;
        const sources = annotationSources(annotation), sourceAssetIds = unique([...sources.map(object => object.assetId), ...[annotation.assetId, annotation.snapshotAssetId].filter((id): id is string => !!id)]);
        const creation = active && annotationEdit && annotationEdit.fresh && !annotationEdit.finished;
        const kind = resolveContentKind(assetFor(annotation.assetId || ''));
        const timeControl = editable && annotationEdit && (kind === 'audio' || kind === 'video') && annotation.assetId ? <AnnotationTimeRange key={annotation.id} kind={kind} src={board.api.content(annotation.assetId)} media={annotation.objectId ? kind === 'video' ? videoRefs.current.get(annotation.objectId) : audioRefs.current.get(annotation.objectId) : undefined} start={annotation.timeStart} end={annotation.timeEnd} fresh={annotationEdit.fresh} disabled={disabled} onCommit={(start, end) => changeAnnotationRange(annotationEdit, kind, board.api.content(annotation.assetId!), start, end)} onError={board.showError}/> : undefined;
        return <CanvasAnnotationNote key={`${annotation.inspectionTaskId || draft?.editingTaskId || 'draft'}-${annotation.id}`} canvas={canvas} bounds={annotationDisplayBounds(annotation)} markBounds={bounds} pin={pinFor.get(annotation)} geometry={annotation.geometry} view={view} layoutVersion={noteLayoutVersion} number={index + 1} onOpen={() => openAnnotation(annotation, !annotation.inspectionTaskId)} annotationId={annotation.id} active={active} redrawing={active && mode === 'mark'} control={{ text: annotation.text, compositionRef: active ? commentComposing : undefined, mode: active ? editable ? 'edit' : 'view' : 'display', inputLabel: active ? editable ? creation ? 'Add a comment' : 'Annotation text' : 'Annotation comment' : `Comment ${index + 1}: ${annotation.text}`, inputRef: active ? annotationInput : undefined, disabled: active && disabled, busy: active && annotationSaving, onOpen: () => openAnnotation(annotation, !annotation.inspectionTaskId), onBack: closeAnnotation, onDone: editable ? () => void finishAnnotation(annotation) : undefined, onChange: changeAnnotationText, mediaControl: timeControl, children: <>
          <div className="annotation-source-thumbs">{sourceAssetIds.map(id => <AssetThumb hoverPreview key={id} asset={assetFor(id)} src={board.api.content(id)}/>)}</div>
          {annotation.objectIds.some(id => !allObjects.some(object => object.id === id)) && <span className="annotation-source-status">Source removed</span>}
          {timeControl && annotationEdit?.frameNote && <span className="annotation-source-status" title={annotationEdit.frameNote}>Frame unavailable</span>}
          {!timeControl && (kind === 'audio' || annotation.timeStart !== undefined) && <div className="comment-video-meta"><span>{annotation.timeStart === undefined ? 'Whole audio' : `${timeLabel(annotation.timeStart)}${annotation.timeEnd !== undefined ? ` – ${timeLabel(annotation.timeEnd)}` : ''}`}</span>{annotation.timeStart !== undefined && annotation.objectId && (videoRefs.current.has(annotation.objectId) || audioRefs.current.has(annotation.objectId)) && <button type="button" className="annotation-media-action" onClick={() => { const media = videoRefs.current.get(annotation.objectId!) || audioRefs.current.get(annotation.objectId!); if (media) { media.pause(); media.currentTime = annotation.timeStart!; } }}>{kind === 'audio' ? 'Jump to time' : 'Jump to frame'}</button>}{annotationEdit?.frameNote && <span title={annotationEdit.frameNote}>Timestamp only</span>}</div>}
        </> }}/>
      })}
      {markHover && mode === 'mark' && !spacePan && <div className="canvas-mark-guide" data-mark-target={markHover.objectId} aria-hidden="true" style={{ ...screenBounds(markHover.bounds, view), left: screenBounds(markHover.bounds, view).x, top: screenBounds(markHover.bounds, view).y, borderRadius: markHover.radius * view.zoom }}/>}
      {mode === 'mark' && !spacePan && <div className="canvas-mark-surface" aria-hidden="true"/>}
      {dragOver && <div className="drop-indicator"><Upload size={28}/><span>Drop files onto the canvas</span></div>}
      {!annotationRead && !annotating && (!!selected.length || !!selectedGroup) && <div ref={selectionActions} className={`selection-actions context-control selection-tool-control${selectedGroup ? ' group-hover-actions' : ''}`} data-canvas-control data-group-actions-id={selectedGroup?.id} onPointerEnter={() => { if (selectedGroup) hoverGroupTarget(selectedGroup.id); }} onPointerLeave={event => { if (!(event.relatedTarget as Element | null)?.closest?.(`[data-group-id="${selectedGroup?.id}"]`)) releaseGroupTarget(selectedGroup?.id || '', 'hoveredId'); }} onFocusCapture={() => { if (selectedGroup) focusGroupTarget(selectedGroup.id); }} onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) releaseGroupTarget(selectedGroup?.id || '', 'focusedId'); }} onKeyDown={event => { event.stopPropagation(); if (event.key !== 'Escape') return; const flyout = (event.target as Element).closest('.selection-flyout'); const trigger = flyout?.querySelector<HTMLButtonElement>(':scope > .icon-button'); if (trigger && event.target !== trigger) { event.preventDefault(); trigger.focus(); } }}>
        <div className="selection-primary-tools" role="toolbar" aria-label="Selected file actions">{selectedGroup ? groupActions(selectedGroup) : <>{!activeGroup && selected.length > 1 && selected.every(object => !object.groupId) && <GroupActionButton label="Group" disabled={disabled} onClick={() => void createGroup()}><FontAwesomeObjectIcon/></GroupActionButton>}{selectedNote && <SelectionFlyout label="Note color" disabled={disabled} menuLabel="Note color" panelClassName="note-color-menu" role="radiogroup" onMenuLeave={() => setNoteColorHover(undefined)} trigger={<Palette size={16}/>}>{noteColorChoices.map(color => <button key={color.label} type="button" role="radio" className={color.id ? undefined : 'note-color-default'} aria-checked={selectedNote.fill === color.id || (!selectedNote.fill && !color.id)} aria-label={color.label} disabled={disabled} onPointerEnter={() => setNoteColorHover(color.id)} onClick={() => { setNoteFillPending({ objectId: selectedNote.id, fill: color.id }); void board.operations([{ type: 'update', objectId: selectedNote.id, expectedVersion: selectedNote.version, changes: { fill: color.id } }]).catch(() => undefined); }}><span className="note-color-swatch" style={color.id ? { background: noteFillColor[color.id] } : undefined}/></button>)}</SelectionFlyout>}{selected.length > 1 && <SelectionFlyout label="Align" disabled={disabled} menuLabel="Align selected files" panelClassName="alignment-actions" role="toolbar" trigger={<AlignStartVertical size={16}/>}><IconButton label="Align left" disabled={disabled} onClick={() => alignSelection('left')}><AlignStartVertical size={15}/></IconButton><IconButton label="Align horizontal centers" disabled={disabled} onClick={() => alignSelection('horizontal-center')}><AlignCenterVertical size={15}/></IconButton><IconButton label="Align right" disabled={disabled} onClick={() => alignSelection('right')}><AlignEndVertical size={15}/></IconButton><IconButton label="Align top" disabled={disabled} onClick={() => alignSelection('top')}><AlignStartHorizontal size={15}/></IconButton><IconButton label="Align vertical centers" disabled={disabled} onClick={() => alignSelection('vertical-center')}><AlignCenterHorizontal size={15}/></IconButton><IconButton label="Align bottom" disabled={disabled} onClick={() => alignSelection('bottom')}><AlignEndHorizontal size={15}/></IconButton></SelectionFlyout>}<IconButton label="Remove selected files from canvas" disabled={disabled} onClick={() => void removeSelection()}><Trash2 size={16}/></IconButton></>}</div>
      </div>}
      {selectedVideo && <VideoPlaybackControls key={selectedVideo.id} objectId={selectedVideo.id} videos={videoRefs.current} disabled={disabled || annotating} onError={board.showError} controlRef={playbackControls}/> }
      <div className="canvas-toolbar" data-canvas-control role="toolbar" aria-label="Board tools" aria-busy={board.mutationBusy || undefined}><IconButton disabled={disabled} label="Select files" aria-pressed={mode === 'select'} onClick={() => setMode('select')}><MousePointer2 size={16}/></IconButton><IconButton disabled={disabled} label="Pan canvas" aria-pressed={mode === 'pan'} onClick={() => setMode('pan')}><Hand size={16}/></IconButton><IconButton disabled={disabled} label="Mark canvas" onPointerDown={rememberMarkdownSelection} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') rememberMarkdownSelection(); }} aria-pressed={mode === 'mark'} onClick={() => { if (annotationEdit) { updateMarkHover(null); setMode('mark'); canvas.current?.focus({ preventScroll: true }); return; } if (selectedGroupId) { const targetGroup = groups.find(group => group.id === selectedGroupId); if (targetGroup?.mode === 'frame') { enterAnnotation(presentedObjects(allObjects.filter(object => targetGroup.objectIds.includes(object.id))), true); return; } } if (selected.length > 1) { enterAnnotation(); return; } clearInspection(); exitAnnotation(); setMode('mark'); setReferencePreview([]); canvas.current?.focus({ preventScroll: true }); }}><AnnotationBubble size={18} tone="neutral"/></IconButton><IconButton disabled={disabled} label="Add note" aria-pressed={mode === 'note'} onClick={() => { clearInspection(); exitAnnotation(); setMode('note'); canvas.current?.focus({ preventScroll: true }); }}><Type size={16}/></IconButton><span className="toolbar-divider"/><IconButton disabled={historyUnavailable || (!state.history?.canUndo && !board.contentDirty)} label="Undo" aria-keyshortcuts="Control+Z Meta+Z" onClick={() => void board.undo().catch(() => undefined)}><Undo2 size={16}/></IconButton><IconButton disabled={historyUnavailable || !state.history?.canRedo} label="Redo" aria-keyshortcuts="Control+Shift+Z Meta+Shift+Z Control+Y" onClick={() => void board.redo().catch(() => undefined)}><Redo2 size={16}/></IconButton><span className="toolbar-divider"/><IconButton disabled={disabled} label="Zoom out" onClick={() => zoom(1 / 1.2)}><Minus size={16}/></IconButton><button disabled={disabled} className="zoom-label" title="Reset zoom to 100%" aria-label="Reset zoom to 100%" onClick={() => { zoom(1 / fitMotion.targetView().zoom); }}>{Math.round(view.zoom * 100)}%</button><IconButton disabled={disabled} label="Zoom in" onClick={() => zoom(1.2)}><Plus size={16}/></IconButton><span className="toolbar-divider"/><IconButton disabled={disabled} label="Fit all files" onClick={() => { const size = { width: canvas.current!.clientWidth, height: canvas.current!.clientHeight }; fitMotion.animate({ ...view, ...fitView(fitTargets, size) }); }}><Maximize size={16}/></IconButton></div>
      {board.switching && <div className="canvas-busy" role="status"><DominoLoader size={32}/><span>Connecting to the board</span></div>}
    </div><div className="project-identity" aria-label={`Acanvas project: ${state.project.name}`} title={state.project.name}><span className="brand"><img className="brand-icon" src="/brand/acanvas-icon.svg" alt=""/>Acanvas</span><span className="project-name">{state.project.name}</span></div><div className="canvas-actions"><IconButton className="floating-control import-button" label="Import files" disabled={disabled} onClick={() => boardInput.current?.click()}><Upload size={17}/></IconButton><div className="theme-control" ref={themeControl} onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setThemeMenuOpen(false); }}><IconButton className="floating-control" label="Theme" aria-haspopup="menu" aria-expanded={themeMenuOpen} aria-controls="theme-menu" onClick={() => setThemeMenuOpen(current => !current)} onKeyDown={event => { if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setThemeMenuOpen(true); } else if (event.key === 'Escape' && themeMenuOpen) { event.preventDefault(); setThemeMenuOpen(false); } }}>{themePreference === 'system' ? <Monitor size={17}/> : theme === 'dark' ? <Moon size={17}/> : <Sun size={17}/>}</IconButton>{themeMenuOpen && <div ref={themeMenu} id="theme-menu" className="theme-menu" role="menu" aria-label="Theme" onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setThemeMenuOpen(false); themeControl.current?.querySelector<HTMLButtonElement>('button')?.focus(); return; } if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return; event.preventDefault(); event.stopPropagation(); const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role=menuitemradio]')), index = items.indexOf(document.activeElement as HTMLButtonElement); const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length; items[next]?.focus(); }}>{([{ id: 'light', label: 'Light' }, { id: 'dark', label: 'Dark' }, { id: 'system', label: 'Follow system' }] as const).map(choice => <button key={choice.id} type="button" role="menuitemradio" aria-checked={themePreference === choice.id} onClick={() => { setThemePreference(choice.id); setThemeMenuOpen(false); themeControl.current?.querySelector<HTMLButtonElement>('button')?.focus(); }}>{choice.id === 'light' ? <Sun size={16}/> : choice.id === 'dark' ? <Moon size={16}/> : <Monitor size={16}/>}<span>{choice.label}</span>{themePreference === choice.id && <Check size={14}/>}</button>)}</div>}</div></div>{composer}</main>
    <input className="sr-only" aria-label="Import files into canvas" tabIndex={-1} type="file" multiple ref={boardInput} onChange={event => { void importFiles(Array.from(event.target.files || [])); event.target.value = ''; }}/>

    {notificationList}
  </div>;
}
