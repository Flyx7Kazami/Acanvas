import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from 'react';
import { ArrowDownToLine, ArrowUp, Check, ChevronDown, Copy, File, Hand, History, ImagePlus, LoaderCircle, Maximize, Minus, Moon, MousePointer2, Pause, Play, Plus, Sun, Trash2, Upload, X } from 'lucide-react';
import type { Annotation, AnnotationInput, Asset, BoardObject, Draft, SessionView, Task, TaskStatus } from '../shared/types';
import { fitView, intersects, mediaContentRect, normalizedRegion, objectRegion, rectangle, screenToWorld, unionBounds, zoomAt, type Point, type Rect } from './geometry';
import { useBoard } from './useBoard';
import { filesFromTransfer } from './import';
import { useComposerLayout, useContextualControls } from './useCanvasLayout';

const statusLabels: Record<TaskStatus, string> = { queued: 'Queued', running: 'Running', blocked: 'Needs input', interrupted: 'Interrupted', completed: 'Completed', cancelled: 'Cancelled' };
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
type Gesture = { kind: 'move' | 'resize' | 'pan' | 'select'; start: Point; view: SessionView; objects: BoardObject[]; sessionId: string };

function AssetThumb({ asset, src }: { asset?: Asset; src: string }) {
  return <span className="asset-thumb">{asset?.kind === 'image' ? <img src={src} alt="" loading="lazy"/> : asset?.kind === 'video' ? <span className="video-symbol">▶</span> : <File size={18}/>}</span>;
}

function QueueItem({ task, animateSend, visible, played, children }: { task: Task; animateSend: boolean; visible: boolean; played: Set<string>; children: ReactNode }) {
  const [entering, setEntering] = useState(false);
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
    const timer = window.setTimeout(stop, 260);
    reduced.addEventListener('change', motionChange);
    motionChange();
    return () => { window.clearTimeout(timer); reduced.removeEventListener('change', motionChange); };
  }, [entering]);
  return <article className={`queue-item${entering ? ' queue-entering' : ''}`} role="listitem" data-task-id={task.id} data-status={task.status} onAnimationEnd={event => { if (event.target === event.currentTarget) setEntering(false); }}>{children}</article>;
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

  return <div ref={controlRef} className="video-playback context-control" data-canvas-control role="group" aria-label="Video playback">
    <IconButton label={playback.paused ? 'Play video' : 'Pause video'} disabled={disabled || !playback.ready} onClick={() => void togglePlayback()}>{playback.paused ? <Play size={16}/> : <Pause size={16}/>}</IconButton>
    <input type="range" aria-label="Video timeline" aria-valuetext={`${timeLabel(playback.currentTime)} of ${timeLabel(playback.duration)}`} min={0} max={playback.duration} step={0.1} value={Math.min(playback.currentTime, playback.duration)} disabled={disabled || !playback.duration} onChange={event => seek(Number(event.target.value))}/>
    <span className="video-time" aria-hidden="true">{timeLabel(playback.currentTime)} / {timeLabel(playback.duration)}</span>
  </div>;
}

function TaskCard({ task, assets, objects, content, locateAsset }: { task: Task; assets: Asset[]; objects: BoardObject[]; content: (id: string) => string; locateAsset: (id: string) => void }) {
  const sourceAssets = task.snapshot.referenceContent.assets;
  const [previewId, setPreviewId] = useState('');
  const previewAsset = [...assets, ...sourceAssets].find(asset => asset.id === previewId);
  const assetAction = (asset: Asset, thumbnail: boolean) => asset.kind === 'file' ? <a href={content(asset.id)} download={asset.name} title={asset.name} key={asset.id}>{thumbnail ? <AssetThumb asset={asset} src={content(asset.id)}/> : <><ArrowDownToLine size={12}/>{asset.name}</>}</a> : <button type="button" title={asset.name} aria-label={`View ${asset.name}`} key={asset.id} onClick={() => { if (objects.some(object => object.assetId === asset.id)) locateAsset(asset.id); else setPreviewId(current => current === asset.id ? '' : asset.id); }}>{thumbnail ? <AssetThumb asset={asset} src={content(asset.id)}/> : asset.name}</button>;
  return <article className="task-card" data-task-id={task.id} data-status={task.status}>
    <div className="task-heading"><span className="task-sequence">Request {String(task.sequence).padStart(2, '0')}</span><span className={`status-badge status-${task.status}`}>{task.status === 'running' && <LoaderCircle size={11} className="spin"/>}{task.status === 'completed' && <Check size={11}/>} {statusLabels[task.status]}</span></div>
    <p className="task-instruction">{task.snapshot.userRequest.text || 'Create from the attachments and annotations.'}</p>
    {!!sourceAssets.length && <div className="task-attachments">{sourceAssets.map(asset => assetAction(asset, true))}</div>}
    {previewAsset && <div className="task-media-preview" role="region" aria-label={`Preview ${previewAsset.name}`}><IconButton label="Close media preview" onClick={() => setPreviewId('')}><X size={14}/></IconButton>{previewAsset.kind === 'image' ? <img src={content(previewAsset.id)} alt={previewAsset.name}/> : <video src={content(previewAsset.id)} controls playsInline preload="metadata"/>}</div>}
    {!!task.snapshot.annotations.length && <details className="task-annotations"><summary>{task.snapshot.annotations.length} annotations<ChevronDown size={12}/></summary>{task.snapshot.annotations.map((annotation, index) => <p key={annotation.id}><span>{index + 1}</span>{annotation.text}{annotation.timeStart !== undefined && <small> · {timeLabel(annotation.timeStart)}</small>}</p>)}</details>}
    {task.reason && <p className="task-reason">{task.reason}</p>}
    {task.runs.at(-1)?.progress.at(-1) && <p className="task-progress">{task.runs.at(-1)?.progress.at(-1)?.message}</p>}
    {task.receipt && <div className="task-receipt"><div className="receipt-label"><Check size={13}/>Receipt</div><p>{task.receipt.summary}</p>{!!task.receipt.assetIds.length && <div className="receipt-assets">{task.receipt.assetIds.map(id => { const asset = assets.find(asset => asset.id === id); return asset ? assetAction(asset, false) : <a key={id} href={content(id)} download>Download output</a>; })}</div>}{!!task.receipt.validation.length && <details><summary>Validation<ChevronDown size={12}/></summary><ul>{task.receipt.validation.map((line, index) => <li key={index}>{line}</li>)}</ul></details>}</div>}
    <time dateTime={task.createdAt}>{new Date(task.createdAt).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}</time>
  </article>;
}

export default function App() {
  const board = useBoard();
  const { state, draft, view } = board;
  const [theme, setTheme] = useState<'light' | 'dark'>(() => localStorage.getItem('acanvas-theme') === 'dark' ? 'dark' : 'light');
  const [mode, setMode] = useState<'select' | 'pan'>('select');
  const [queueExpanded, setQueueExpanded] = useState(false);
  const [sentTaskId, setSentTaskId] = useState('');
  const playedSendIds = useRef(new Set<string>());
  const revealedSendId = useRef('');
  const [taskDetailId, setTaskDetailId] = useState('');
  const [historyOpen, setHistoryOpen] = useState(false);
  const [cancellingTask, setCancellingTask] = useState('');
  const comments = useRef(new Map<string, CommentEdit>());
  const [, setCommentRevision] = useState(0);
  const [annotationSaving, setAnnotationSaving] = useState(false);
  const [removingObjects, setRemovingObjects] = useState(false);
  const [annotationRead, setAnnotationRead] = useState<AnnotationInput | null>(null);
  const [readerInDraft, setReaderInDraft] = useState(false);
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
  const disabled = board.projectChanged || board.switching || board.sending || annotationSaving || removingObjects;
  const allAnnotations: (AnnotationInput | Annotation)[] = [...(state?.annotations || []), ...(draft?.annotations || [])];
  const queuedTasks = state?.tasks.filter(task => ['queued', 'running', 'blocked', 'interrupted'].includes(task.status)) || [];
  const pending = queuedTasks.length;
  const commentKey = `${state?.session.id}:${draft?.id}:${[...selectedIds].sort().join(',')}`;
  const comment = comments.current.get(commentKey);
  const pendingComments = [...comments.current.values()].filter(edit => edit.sessionId === state?.session.id && edit.draftId === draft?.id && edit.value.text.trim());
  const unavailableComments = [...comments.current].filter(([, edit]) => pendingComments.includes(edit) && edit.value.objectIds.some(id => !scope.current.objectIds.has(id)));
  const hasRequest = !!(draft?.text.trim() || draft?.attachments.length || draft?.annotations.length || pendingComments.length);
  const readerObject = objects.find(object => object.id === annotationRead?.objectId);
  const readerBounds = annotationRead ? annotationRead.coordinateSpace === 'normalized' && readerObject ? objectRegion(annotationRead.bounds, mediaContentRect(readerObject, mediaSizes[readerObject.id])) : annotationRead.bounds : undefined;

  useComposerLayout(instruction, dock, draft, !!state);
  useContextualControls(canvas, selectionActions, playbackControls, annotationRead && !readerInDraft && readerBounds ? [readerBounds] : selected, selectedVideo, view);
  useEffect(() => { if (commentInput.current) { commentInput.current.style.height = '20px'; commentInput.current.style.height = `${Math.min(80, Math.max(20, commentInput.current.scrollHeight))}px`; } }, [comment?.value.text, commentKey]);

  useEffect(() => { document.documentElement.dataset.theme = theme; localStorage.setItem('acanvas-theme', theme); document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#111111' : '#f5f5f3'); }, [theme]);
  useEffect(() => { setPreview({}); setSelectionRect(null); gesture.current = null; }, [state?.session.id]);
  useEffect(() => { if (!pending) setQueueExpanded(false); }, [pending]);
  useEffect(() => { setSentTaskId(''); revealedSendId.current = ''; }, [state?.session.id]);
  useLayoutEffect(() => {
    if (!sentTaskId || revealedSendId.current === sentTaskId) return;
    const row = document.querySelector<HTMLElement>(`.queue-list>.queue-item[data-task-id="${sentTaskId}"]`);
    if (!row) return;
    if (getComputedStyle(row).display === 'none') { setQueueExpanded(true); return; }
    row.scrollIntoView({ block: 'nearest' }); revealedSendId.current = sentTaskId;
  }, [sentTaskId, queueExpanded, historyOpen, state?.tasks]);
  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    const wheel = (event: WheelEvent) => {
      if ((event.target as HTMLElement).closest('[data-canvas-control]')) return;
      event.preventDefault();
      const current = wheelState.current;
      if (current.disabled || gesture.current) return;
      const rect = element.getBoundingClientRect();
      if (event.ctrlKey || event.metaKey) board.updateView({ ...current.view, ...zoomAt(current.view, Math.exp(-event.deltaY * .005), { x: event.clientX - rect.left, y: event.clientY - rect.top }) }, current.sessionId);
      else board.updateView({ ...current.view, x: current.view.x - event.deltaX, y: current.view.y - event.deltaY }, current.sessionId);
    };
    element.addEventListener('wheel', wheel, { passive: false });
    return () => element.removeEventListener('wheel', wheel);
  }, [!!state, board.updateView]);
  useEffect(() => { if (!notice) return; const timer = setTimeout(() => setNotice(''), 2800); return () => clearTimeout(timer); }, [notice]);

  const viewUpdate = (next: Partial<SessionView>) => { if (!disabled && state) board.updateView({ ...view, ...next }, state.session.id); };
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

  function locateObjects(ids: string[]) {
    const targets = objects.filter(object => ids.includes(object.id));
    const size = canvas.current?.getBoundingClientRect();
    if (!targets.length || !size) return;
    const bounds = unionBounds(targets), dockTop = dock.current?.getBoundingClientRect().top || size.height;
    viewUpdate({ x: size.width / 2 - (bounds.x + bounds.width / 2) * view.zoom, y: (64 + dockTop) / 2 - (bounds.y + bounds.height / 2) * view.zoom, selectedObjectIds: targets.map(object => object.id) });
  }

  function locateAsset(id: string) { locateObjects(objects.filter(object => object.assetId === id).map(object => object.id)); }

  function openAnnotation(annotation: AnnotationInput, inDraft = false) {
    if (annotation.objectId && annotation.timeStart !== undefined) {
      const video = videoRefs.current.get(annotation.objectId);
      if (video) { video.pause(); video.currentTime = annotation.timeStart; }
    }
    const object = objects.find(value => value.id === annotation.objectId);
    const bounds = annotation.coordinateSpace === 'normalized' && object ? objectRegion(annotation.bounds, contentBounds(object)) : annotation.bounds;
    const size = canvas.current?.getBoundingClientRect();
    if (annotation.coordinateSpace === 'normalized' && object) locateObjects(annotation.objectIds);
    else if (annotation.coordinateSpace === 'world' && size) {
      viewUpdate({ x: size.width / 2 - (bounds.x + bounds.width / 2) * view.zoom, y: size.height / 2 - (bounds.y + bounds.height / 2) * view.zoom, selectedObjectIds: annotation.objectIds.filter(id => objects.some(value => value.id === id)) });
    }
    setReaderInDraft(annotation.coordinateSpace === 'normalized' && !object);
    setAnnotationRead(annotation);
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
    try { await persistComment(commentKey, edit); }
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
      if (task && task.draftId === owner.draftId && task.sessionId === scope.current.sessionId) {
        setHistoryOpen(false); setSentTaskId(task.id);
        if (queuedTasks.length >= 3) setQueueExpanded(true);
      }
    } catch (cause) { board.showError(cause); }
    finally { committing.current = false; setAnnotationSaving(false); }
  }

  function pointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (disabled || !state || event.button !== 0 || (event.target as HTMLElement).closest('[data-canvas-control]')) return;
    canvas.current?.focus({ preventScroll: true });
    const point = localPoint(event);
    const objectId = (event.target as HTMLElement).closest<HTMLElement>('[data-object-id]')?.dataset.objectId;
    const resizeId = (event.target as HTMLElement).closest<HTMLElement>('[data-resize-id]')?.dataset.resizeId;
    const effectiveMode = spacePan ? 'pan' : mode;
    const object = objects.find(value => value.id === objectId);
    let kind: Gesture['kind'] = effectiveMode === 'pan' ? 'pan' : 'select';
    let moving: BoardObject[] = [];
    if (resizeId) { kind = 'resize'; moving = objects.filter(value => value.id === resizeId); }
    else if (effectiveMode === 'select' && object) {
      if (event.shiftKey) { selectObjects(selectedIds.includes(object.id) ? selectedIds.filter(id => id !== object.id) : [...selectedIds, object.id]); return; }
      const ids = selectedIds.includes(object.id) ? selectedIds : [object.id];
      selectObjects(ids); kind = 'move'; moving = objects.filter(value => ids.includes(value.id));
    } else if (effectiveMode === 'select' && !event.shiftKey) selectObjects([]);
    gesture.current = { kind, start: point, view, objects: moving, sessionId: state.session.id };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  }

  function pointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const active = gesture.current;
    if (!active) return;
    const point = localPoint(event);
    const dx = (point.x - active.start.x) / active.view.zoom;
    const dy = (point.y - active.start.y) / active.view.zoom;
    if (active.kind === 'move') setPreview(Object.fromEntries(active.objects.map(object => [object.id, { x: object.x + dx, y: object.y + dy, width: object.width, height: object.height }])));
    if (active.kind === 'resize') { const object = active.objects[0]; const width = Math.max(40, object.width + dx); setPreview({ [object.id]: { x: object.x, y: object.y, width, height: width * object.height / object.width } }); }
    if (active.kind === 'pan') board.updateView({ ...active.view, x: active.view.x + point.x - active.start.x, y: active.view.y + point.y - active.start.y }, active.sessionId);
    if (active.kind === 'select') setSelectionRect(rectangle(screenToWorld(active.start, active.view), screenToWorld(point, active.view)));
  }

  function pointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    const active = gesture.current;
    if (!active) return;
    gesture.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    const point = localPoint(event);
    const region = rectangle(screenToWorld(active.start, active.view), screenToWorld(point, active.view));
    if (active.kind === 'move' || active.kind === 'resize') {
      const dx = (point.x - active.start.x) / active.view.zoom;
      const dy = (point.y - active.start.y) / active.view.zoom;
      const changes = Math.abs(dx) + Math.abs(dy) > .01 ? active.objects.map(object => {
        const width = Math.max(40, object.width + dx);
        return { type: 'update' as const, objectId: object.id, expectedVersion: object.version, changes: active.kind === 'resize' ? { width, height: width * object.height / object.width } : { x: object.x + dx, y: object.y + dy } };
      }) : [];
      if (changes.length) void board.operations(changes, active.sessionId).finally(() => setPreview({})).catch(() => undefined);
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
      setNotice('Request cancelled.');
    } catch (cause) { board.showError(cause); }
    finally { setCancellingTask(''); }
  }

  function toggleQueue() {
    setQueueExpanded(current => !current);
  }

  const reader = annotationRead && <div className="annotation-reader" role="region" aria-label="Annotation"><div className="inline-heading"><span>Comment</span><IconButton label="Close annotation" onClick={() => setAnnotationRead(null)}><X size={14}/></IconButton></div><p>{annotationRead.text}</p>{annotationRead.timeStart !== undefined && <span>Video {timeLabel(annotationRead.timeStart)}{annotationRead.timeEnd !== undefined ? ` – ${timeLabel(annotationRead.timeEnd)}` : ''}</span>}{annotationRead.snapshotAssetId && <img src={board.api.content(annotationRead.snapshotAssetId)} alt="Annotated video frame"/>}</div>;
  const taskCard = (task: Task) => <TaskCard task={task} assets={assets} objects={objects} content={id => board.api.content(id)} locateAsset={locateAsset}/>;
  const composer = state && draft && <section ref={dock} className="creation-dock" data-canvas-control aria-label="Request composer and queue" onDragOver={event => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); event.stopPropagation(); } }} onDrop={event => { const files = filesFromTransfer(event.dataTransfer); if (files.length) { event.preventDefault(); event.stopPropagation(); void importFiles(files); } }}>
    {(pending > 0 || historyOpen) && <div className={`queue-stack ${queueExpanded || historyOpen ? 'expanded' : ''} ${pending > 3 && !historyOpen ? 'has-stack' : ''}`} data-pending={pending}>
      {!queueExpanded && pending > 3 && !historyOpen && <div className="queue-peeks" aria-hidden="true">{Array.from({ length: Math.min(pending - 3, 2) }, (_, index) => <span key={index} style={{ '--peek': index + 1 } as React.CSSProperties}/>)}</div>}
      {historyOpen ? <div className="queue-list history-list" id="request-history" role="region" aria-label="Request history"><div className="inline-heading"><span>Request history</span><IconButton label="Close request history" onClick={() => { setHistoryOpen(false); document.querySelector<HTMLButtonElement>('.history-toggle')?.focus(); }}><X size={14}/></IconButton></div>{state.tasks.length ? [...state.tasks].reverse().map(task => <div key={task.id}>{taskCard(task)}</div>) : <p className="field-hint">Your requests, progress and receipts appear here.</p>}</div> : <div className="queue-list" id="creation-queue" role="list" aria-label="Task queue">
        {queuedTasks.map((task, index) => <QueueItem task={task} key={task.id} visible={queueExpanded || index < 3} animateSend={sentTaskId === task.id} played={playedSendIds.current}>
          <div className="queue-row"><button type="button" className="queue-task" aria-label={`View request ${task.sequence}: ${task.snapshot.userRequest.text || 'Attachments and annotations'}`} aria-expanded={taskDetailId === task.id} aria-controls={`request-details-${task.id}`} onClick={() => { setQueueExpanded(true); setTaskDetailId(current => current === task.id ? '' : task.id); }}><span className="queue-task-mark">{task.status === 'running' ? <LoaderCircle size={15} className="spin"/> : <ArrowUp size={15}/>}</span><span className="queue-title">{task.snapshot.userRequest.text || 'Create from the attachments and annotations.'}</span></button>
          <span className={`status-badge status-${task.status}`}>{statusLabels[task.status]}</span>{['queued', 'blocked', 'interrupted'].includes(task.status) && <IconButton label={`Cancel request ${task.sequence}`} disabled={disabled || !!cancellingTask} onClick={() => void cancelTask(task)}>{cancellingTask === task.id ? <LoaderCircle size={15} className="spin"/> : <Trash2 size={15}/>}</IconButton>}</div>
          {taskDetailId === task.id && <div className="inline-task-detail" id={`request-details-${task.id}`} role="region" aria-label={`Request ${task.sequence}`}><IconButton label="Collapse request details" onClick={() => { setTaskDetailId(''); document.querySelector<HTMLButtonElement>(`.queue-item[data-task-id="${task.id}"] .queue-task`)?.focus(); }}><X size={14}/></IconButton>{taskCard(task)}</div>}
        </QueueItem>)}
      </div>}
      {!historyOpen && pending > 3 && <button type="button" className="queue-expand" aria-expanded={queueExpanded} aria-controls="creation-queue" onClick={toggleQueue}>{queueExpanded ? 'Collapse queue' : `${pending} requests`}<ChevronDown size={12}/></button>}
    </div>}
    {board.draftConflict && <section className="draft-conflict" aria-label="Resolve draft update"><strong>Draft updated elsewhere</strong><div className="conflict-comparison">{[{ label: 'Your input', value: draft }, { label: 'Saved draft', value: board.draftConflict }].map(item => <section key={item.label}><h3>{item.label}</h3><p className="conflict-text">{item.value?.text || 'No text yet'}</p><div className="conflict-references"><span>{item.value?.attachments.length || 0} attachments · {item.value?.annotations.length || 0} annotations</span>{item.value?.attachments.map(id => <small key={id}>{assetFor(id)?.name || id}</small>)}{item.value?.annotations.map(annotation => <small key={annotation.id}>{annotation.text}</small>)}</div></section>)}</div><div className="inline-actions"><button type="button" className="button" disabled={resolvingConflict} onClick={() => { setResolvingConflict(true); void board.resolveDraftConflict('remote').catch(board.showError).finally(() => setResolvingConflict(false)); }}>Use saved draft</button><button type="button" className="button primary" disabled={resolvingConflict} onClick={() => { setResolvingConflict(true); void board.resolveDraftConflict('local').catch(board.showError).finally(() => setResolvingConflict(false)); }}>{resolvingConflict ? 'Saving…' : 'Keep your draft'}</button></div></section>}
    {!!unavailableComments.length && <div className="unavailable-comments" aria-label="Unavailable comments">{unavailableComments.map(([key, edit]) => <div key={key}><span>Removed file · {edit.value.text}</span><IconButton label="Discard unavailable comment" onClick={() => { comments.current.delete(key); board.changeDraft(current => ({ ...current, annotations: current.annotations.filter(annotation => annotation.id !== edit.value.id) })); setCommentRevision(revision => revision + 1); board.setError(''); }}><Trash2 size={14}/></IconButton></div>)}</div>}
    {readerInDraft && reader && <div className="draft-annotation-reader">{reader}</div>}
    {copyCommand && <section className="inline-resume" aria-label="Resume prompt"><div className="inline-heading"><span>Resume prompt</span><IconButton label="Close resume prompt" onClick={() => setCopyCommand('')}><X size={14}/></IconButton></div><textarea aria-label="Resume prompt text" readOnly value={copyCommand} rows={3} onFocus={event => event.target.select()}/></section>}
    <form className="composer" aria-label="Request draft" data-save-state={board.saveState} onSubmit={event => { event.preventDefault(); if (!composing.current && !commentComposing.current) void sendRequest(); }}>
    {!!(draft.attachments.length || draft.annotations.length) && <div className="draft-attachments" aria-label="Request attachments">{draft.attachments.map(id => { const asset = assetFor(id); return <div className="draft-asset" key={id}><AssetThumb asset={asset} src={board.api.content(id)}/><span title={asset?.name}>{asset?.name || 'Loading file'}</span><IconButton label={`Remove attachment ${asset?.name || id}`} disabled={disabled} onClick={() => board.changeDraft(current => ({ ...current, attachments: current.attachments.filter(value => value !== id), references: { ...current.references, objectIds: current.references.objectIds.filter(objectId => { const object = state.objects.find(value => value.id === objectId); return !!object && object.assetId !== id; }) } }))}><X size={13}/></IconButton></div>; })}{draft.annotations.map((annotation, index) => <div className="draft-annotation" key={annotation.id}><button type="button" className="annotation-content" onClick={() => openAnnotation(annotation, true)}><span className="annotation-number">{index + 1}</span><span>{annotation.text}{annotation.timeStart !== undefined && <small> · {timeLabel(annotation.timeStart)}</small>}</span></button><IconButton label={`Remove annotation ${index + 1}`} disabled={disabled} onClick={() => board.changeDraft(current => ({ ...current, annotations: current.annotations.filter(value => value.id !== annotation.id) }))}><X size={13}/></IconButton></div>)}</div>}
      <div className="composer-input-row">
      <label className="sr-only" htmlFor="instruction">Request</label><textarea ref={instruction} id="instruction" rows={1} placeholder="What would you like to create?" value={draft.text} readOnly={board.projectChanged} disabled={board.switching || board.sending || annotationSaving} onChange={event => board.changeDraft(current => ({ ...current, text: event.target.value }))} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }} onKeyDown={event => { if (event.key !== 'Enter' || event.shiftKey || composing.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return; event.preventDefault(); void sendRequest(); }}/><button className="send-button" type="submit" disabled={disabled || !!uploads.length || !!board.draftConflict || !hasRequest} aria-label="Send request">{board.sending || annotationSaving ? <LoaderCircle size={17} className="spin"/> : <ArrowUp size={18}/>}</button>
      </div>
    </form>
    <div className="dock-footer"><IconButton className="history-toggle" label="Request history" aria-expanded={historyOpen} aria-controls="request-history" onClick={() => { setHistoryOpen(current => !current); setTaskDetailId(''); }}><History size={15}/></IconButton><IconButton label="Copy resume prompt" onClick={() => void copyResume()}><Copy size={15}/></IconButton></div>
  </section>;

  if (!state || !draft) return <main className="startup"><span className="brand">acanvas<span>●</span></span>{board.error ? <><h1>Unable to open the board</h1><p role="alert">{board.error}</p><button className="button primary" onClick={() => window.location.reload()}>Reconnect</button></> : <><LoaderCircle size={24} className="spin"/><p>Opening your board…</p></>}</main>;

  return <div className="app-shell"><a className="skip-link" href="#whiteboard">Skip to canvas</a>
    <main className="canvas-main"><div id="whiteboard" className={`whiteboard mode-${spacePan ? 'pan' : mode} ${dragOver ? 'drag-over' : ''} ${board.switching ? 'is-loading' : ''}`} ref={canvas} tabIndex={0} role="region" aria-label="Project board. Enter selects files, arrow keys move them, and Space pans the canvas." style={{ backgroundSize: `${24 * view.zoom}px ${24 * view.zoom}px`, backgroundPosition: `${view.x}px ${view.y}px` }} onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={() => { gesture.current = null; setPreview({}); setSelectionRect(null); }} onKeyDown={event => { if (event.target !== event.currentTarget || disabled) return; if (event.key === ' ') { event.preventDefault(); setSpacePan(true); } if (event.key === 'Escape') { selectObjects([]); setMode('select'); } if (event.key === '+' || event.key === '=') { event.preventDefault(); zoom(1.2); } if (event.key === '-') { event.preventDefault(); zoom(1 / 1.2); } }} onKeyUp={event => { if (event.key === ' ') setSpacePan(false); }} onBlur={() => setSpacePan(false)} onDragOver={event => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); setDragOver(true); } }} onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragOver(false); }} onDrop={event => { event.preventDefault(); setDragOver(false); void importFiles(filesFromTransfer(event.dataTransfer), localPoint(event)); }}>
      <div className="canvas-world" style={{ transform: `translate(${view.x}px,${view.y}px) scale(${view.zoom})` }}>{objects.map((object, index) => { const asset = assetFor(object.assetId); const isSelected = selectedIds.includes(object.id); return <article key={object.id} className={`board-object object-${object.type} ${isSelected ? 'selected' : ''}`} data-object-id={object.id} data-object-version={object.version} data-selected={isSelected || undefined} style={{ left: object.x, top: object.y, width: object.width, height: object.height }} tabIndex={0} role="group" aria-label={`${asset?.name || 'File'}${isSelected ? ', selected' : ''}`} onKeyDown={event => { if (event.target !== event.currentTarget || disabled) return; if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); selectObjects(event.shiftKey ? unique([...selectedIds, object.id]) : [object.id]); } const delta = { ArrowLeft: [-10, 0], ArrowRight: [10, 0], ArrowUp: [0, -10], ArrowDown: [0, 10] }[event.key]; if (delta) { event.preventDefault(); event.stopPropagation(); void board.operations([{ type: 'update', objectId: object.id, expectedVersion: object.version, changes: { x: object.x + delta[0], y: object.y + delta[1] } }]).catch(() => undefined); } }}>
        <div className="object-media">{object.type === 'image' && !mediaErrors[object.id] && <img src={board.api.content(object.assetId)} alt={asset?.name || 'Imported image'} draggable={false} onLoad={event => { const size = { width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight }; setMediaSizes(current => ({ ...current, [object.id]: size })); }} onError={() => setMediaErrors(current => ({ ...current, [object.id]: true }))}/>} {object.type === 'video' && !mediaErrors[object.id] && <video playsInline preload="metadata" tabIndex={-1} src={board.api.content(object.assetId)} ref={element => { if (element) videoRefs.current.set(object.id, element); else videoRefs.current.delete(object.id); }} onLoadedMetadata={event => { const size = { width: event.currentTarget.videoWidth, height: event.currentTarget.videoHeight }; setMediaSizes(current => ({ ...current, [object.id]: size })); }} onError={() => setMediaErrors(current => ({ ...current, [object.id]: true }))}/>} {(object.type === 'file' || mediaErrors[object.id]) && <div className="file-card"><File size={32} strokeWidth={1.25}/><strong>{asset?.name || 'File'}</strong><span>{mediaErrors[object.id] ? 'Preview unavailable in this browser' : `${asset?.mime || 'Attachment'} · ${bytes(asset?.size || 0)}`}</span><a data-canvas-control href={board.api.content(object.assetId)} download={asset?.name} onPointerDown={event => event.stopPropagation()}><ArrowDownToLine size={13}/>Download file</a></div>}</div>
        <div className="object-caption"><span className="object-index">{String(index + 1).padStart(2, '0')}</span><span title={asset?.name}>{asset?.name || 'File'}</span>{object.sourceTaskId && <span className="generated-label">Output</span>}</div>{isSelected && <button type="button" className="resize-handle" data-resize-id={object.id} aria-label={`Resize ${asset?.name || 'File'}`} onKeyDown={event => { if (!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key)) return; event.preventDefault(); event.stopPropagation(); const width = Math.max(40, object.width + (event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 10 : -10)); void board.operations([{ type: 'update', objectId: object.id, expectedVersion: object.version, changes: { width, height: width * object.height / object.width } }]).catch(() => undefined); }}/>}</article>; })}
      {allAnnotations.map((annotation, index) => { const object = objects.find(value => value.id === annotation.objectId); if (annotation.coordinateSpace === 'normalized' && !object) return null; const bounds = annotation.coordinateSpace === 'normalized' && object ? objectRegion(annotation.bounds, contentBounds(object)) : annotation.bounds; return <div className={`annotation-outline ${draft.annotations.some(value => value.id === annotation.id) ? 'draft-outline' : ''}`} key={`${annotation.id}-${index}`} style={{ left: bounds.x, top: bounds.y, width: bounds.width, height: bounds.height }}><button type="button" data-canvas-control className="annotation-pin" title={annotation.text} aria-label={`Annotation ${index + 1}: ${annotation.text}`} onPointerDown={event => event.stopPropagation()} onClick={() => openAnnotation(annotation)} style={{ transform: `scale(${1 / view.zoom})`, transformOrigin: 'bottom left' }}>{index + 1}</button></div>; })}
      {selectionRect && <div className="selection-rect" style={{ left: selectionRect.x, top: selectionRect.y, width: selectionRect.width, height: selectionRect.height }}/>}</div>
      {!objects.length && <div className="canvas-empty"><div className="empty-mark"><ImagePlus size={31} strokeWidth={1.25}/></div><h1>Drop files to start</h1><p>Images, videos and files. Or paste from your clipboard.</p></div>}
      {dragOver && <div className="drop-indicator"><Upload size={28}/><span>Drop files onto the canvas</span></div>}
      {!annotationRead && !!selected.length && <div ref={selectionActions} className="selection-actions comment-control context-control" data-canvas-control onKeyDown={event => event.stopPropagation()}><form onSubmit={event => { event.preventDefault(); if (!commentComposing.current) void saveComment(); }}><IconButton label="Attach to request" disabled={disabled} onClick={addSelection}><Plus size={14}/></IconButton><textarea key={commentKey} ref={commentInput} rows={1} aria-label="Add a comment" placeholder="Add a comment…" value={comment?.value.text || ''} disabled={disabled} onFocus={() => { beginComment(); }} onChange={event => { const edit = beginComment(); if (edit) { edit.value.text = event.target.value; setCommentRevision(revision => revision + 1); } }} onCompositionStart={() => { commentComposing.current = true; }} onCompositionEnd={() => { commentComposing.current = false; }} onKeyDown={event => { if (event.key !== 'Enter' || event.shiftKey || commentComposing.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return; event.preventDefault(); void saveComment(); }}/><IconButton label="Save comment" disabled={disabled || !comment?.value.text.trim()} onClick={() => void saveComment()}>{annotationSaving ? <LoaderCircle size={14} className="spin"/> : <ArrowUp size={14}/>}</IconButton><IconButton label="Remove selected files from canvas" disabled={disabled} onClick={() => void removeSelection()}><Trash2 size={14}/></IconButton></form>{comment?.value.timeStart !== undefined && <div className="comment-video-meta"><span>{timeLabel(comment.value.timeStart)}</span><label>End time<input type="number" min={comment.value.timeStart} step="0.1" placeholder="Optional" value={comment.end} disabled={disabled} onChange={event => { comment.end = event.target.value; setCommentRevision(revision => revision + 1); }}/></label>{comment.frameNote && <span title={comment.frameNote}>Timestamp only</span>}</div>}</div>}
      {!readerInDraft && reader && <div ref={selectionActions} className="inline-annotation-reader context-control" data-canvas-control onKeyDown={event => { event.stopPropagation(); if (event.key === 'Escape') setAnnotationRead(null); }}>{reader}</div>}
      {selectedVideo && <VideoPlaybackControls key={selectedVideo.id} objectId={selectedVideo.id} videos={videoRefs.current} disabled={disabled} onError={board.showError} controlRef={playbackControls}/> }
      <div className="canvas-toolbar" data-canvas-control role="toolbar" aria-label="Board tools"><IconButton disabled={disabled} label="Select files" aria-pressed={mode === 'select'} onClick={() => setMode('select')}><MousePointer2 size={16}/></IconButton><IconButton disabled={disabled} label="Pan canvas" aria-pressed={mode === 'pan'} onClick={() => setMode('pan')}><Hand size={16}/></IconButton><span className="toolbar-divider"/><IconButton disabled={disabled} label="Zoom out" onClick={() => zoom(1 / 1.2)}><Minus size={16}/></IconButton><button disabled={disabled} className="zoom-label" title="Reset zoom to 100%" aria-label="Reset zoom to 100%" onClick={() => { const size = canvas.current!.getBoundingClientRect(); viewUpdate(zoomAt(view, 1 / view.zoom, { x: size.width / 2, y: size.height / 2 })); }}>{Math.round(view.zoom * 100)}%</button><IconButton disabled={disabled} label="Zoom in" onClick={() => zoom(1.2)}><Plus size={16}/></IconButton><span className="toolbar-divider"/><IconButton disabled={disabled} label="Fit all files" onClick={() => { const size = canvas.current!.getBoundingClientRect(); viewUpdate(fitView(objects, size)); }}><Maximize size={16}/></IconButton></div>
      {board.switching && <div className="canvas-busy"><LoaderCircle size={20} className="spin"/>Connecting to the board</div>}
    </div><div className="project-identity" aria-label={`acanvas project: ${state.project.name}`} title={state.project.name}><span className="brand">acanvas<span aria-hidden="true">●</span></span><span className="project-name">{state.project.name}</span></div><div className="canvas-actions"><IconButton className="floating-control import-button" label="Import files" disabled={disabled} onClick={() => boardInput.current?.click()}><Upload size={17}/></IconButton><IconButton className="floating-control" label={theme === 'light' ? 'Switch to dark theme' : 'Switch to light theme'} onClick={() => setTheme(current => current === 'light' ? 'dark' : 'light')}>{theme === 'light' ? <Moon size={17}/> : <Sun size={17}/>}</IconButton></div>{board.connection !== 'connected' && !board.projectChanged && <div className="connection-feedback" role="status"><LoaderCircle size={14} className="spin"/>{board.connection === 'reconnecting' ? 'Reconnecting…' : 'Connecting…'}</div>}{composer}</main>
    <input className="sr-only" aria-label="Import files into canvas" tabIndex={-1} type="file" multiple ref={boardInput} onChange={event => { void importFiles(Array.from(event.target.files || [])); event.target.value = ''; }}/>
    {(board.error || board.projectChanged) && <div className="error-banner" role="alert"><span>{board.error || 'This address now serves another project. Your draft is preserved. Reopen the board to continue.'}</span>{board.projectChanged && <button onClick={() => window.location.assign(window.location.pathname)}>Reopen board</button>}{!board.projectChanged && board.saveState === 'failed' && <button onClick={() => void board.flushDraft().catch(() => undefined)}>Retry saving</button>}<IconButton label="Dismiss error" disabled={board.projectChanged} onClick={() => board.setError('')}><X size={15}/></IconButton></div>}
    {!!uploads.length && <div className="upload-list" aria-live="polite">{uploads.map(upload => <div key={upload.id}><LoaderCircle size={15} className="spin"/><span>Importing {upload.name}</span><IconButton label={`Cancel import ${upload.name}`} onClick={() => upload.controller.abort()}><X size={15}/></IconButton></div>)}</div>}
    {notice && <div className="toast" role="status"><Check size={14}/>{notice}</div>}
  </div>;
}
