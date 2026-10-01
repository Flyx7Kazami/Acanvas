import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { ArrowDownToLine, ArrowUp, Check, ChevronDown, ChevronRight, Copy, File, Hand, ImagePlus, LoaderCircle, Maximize, Minus, Moon, MousePointer2, Plus, Scan, Sun, Trash2, Upload, X } from 'lucide-react';
import type { Annotation, AnnotationInput, Asset, BoardObject, Draft, SessionView, Task, TaskStatus } from '../shared/types';
import { fitView, intersects, mediaContentRect, normalizedRegion, objectRegion, rectangle, screenToWorld, zoomAt, type Point, type Rect } from './geometry';
import { useBoard } from './useBoard';
import { filesFromTransfer } from './import';

const statusLabels: Record<TaskStatus, string> = { queued: '待处理', running: '执行中', blocked: '等待补充', interrupted: '等待接续', completed: '已完成', cancelled: '已撤回' };
const saveLabels = { saved: '已保存', saving: '保存中', unsaved: '正在保存', failed: '保存未完成' };
const timeLabel = (value: number) => `${Math.floor(value / 60)}:${String(Math.floor(value % 60)).padStart(2, '0')}`;
const bytes = (value: number) => value < 1024 * 1024 ? `${Math.max(1, Math.round(value / 1024))} KB` : `${(value / (1024 * 1024)).toFixed(1)} MB`;
const unique = (values: string[]) => [...new Set(values)];

function IconButton({ label, children, className = '', ...props }: { label: string; children: ReactNode; className?: string } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button type="button" className={`icon-button ${className}`} title={label} aria-label={label} {...props}>{children}</button>;
}

function Modal({ open, title, children, onClose, className = '' }: { open: boolean; title: string; children: ReactNode; onClose: () => void; className?: string }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    if (!open || !element) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    element.showModal();
    return () => { element.close(); opener?.focus(); };
  }, [open]);
  return <dialog ref={dialog} className={`modal ${className}`} aria-label={title} onCancel={event => { event.preventDefault(); onClose(); }} onClick={event => { if (event.target === event.currentTarget) { const bounds = event.currentTarget.getBoundingClientRect(); if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) onClose(); } }}>
    <div className="modal-heading"><h2>{title}</h2><IconButton label={`关闭${title}`} onClick={onClose}><X size={18}/></IconButton></div>{open && children}
  </dialog>;
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
type AnnotationEdit = { value: AnnotationInput; sessionId: string; draftId: string; snapshot?: Blob; frameNote?: string };
type Gesture = { kind: 'move' | 'resize' | 'pan' | 'select'; start: Point; view: SessionView; objects: BoardObject[]; sessionId: string };

function AssetThumb({ asset, src }: { asset?: Asset; src: string }) {
  return <span className="asset-thumb">{asset?.kind === 'image' ? <img src={src} alt="" loading="lazy"/> : asset?.kind === 'video' ? <span className="video-symbol">▶</span> : <File size={18}/>}</span>;
}

function TaskCard({ task, assets, content, queue }: { task: Task; assets: Asset[]; content: (id: string) => string; queue: boolean }) {
  const sourceAssets = task.snapshot.referenceContent.assets;
  return <article className={`task-card ${queue ? 'queue-card' : ''}`} data-task-id={task.id} data-status={task.status}>
    <div className="task-heading"><span className="task-sequence">需求 {String(task.sequence).padStart(2, '0')}</span><span className={`status-badge status-${task.status}`}>{task.status === 'running' && <LoaderCircle size={11} className="spin"/>}{task.status === 'completed' && <Check size={11}/>} {statusLabels[task.status]}</span></div>
    <p className="task-instruction">{task.snapshot.userRequest.text || '根据附件与批注处理这次需求。'}</p>
    {!!sourceAssets.length && <div className="task-attachments">{sourceAssets.slice(0, 4).map(asset => <a href={content(asset.id)} target="_blank" rel="noreferrer" title={asset.name} key={asset.id}><AssetThumb asset={asset} src={content(asset.id)}/></a>)}{sourceAssets.length > 4 && <span>+{sourceAssets.length - 4}</span>}</div>}
    {!!task.snapshot.annotations.length && <details className="task-annotations"><summary>{task.snapshot.annotations.length} 条批注<ChevronDown size={12}/></summary>{task.snapshot.annotations.map((annotation, index) => <p key={annotation.id}><span>{index + 1}</span>{annotation.text}{annotation.timeStart !== undefined && <small> · {timeLabel(annotation.timeStart)}</small>}</p>)}</details>}
    {task.reason && <p className="task-reason">{task.reason}</p>}
    {task.runs.at(-1)?.progress.at(-1) && <p className="task-progress">{task.runs.at(-1)?.progress.at(-1)?.message}</p>}
    {task.receipt && <div className="task-receipt"><div className="receipt-label"><Check size={13}/>执行回执</div><p>{task.receipt.summary}</p>{!!task.receipt.assetIds.length && <div className="receipt-assets">{task.receipt.assetIds.map(id => <a key={id} href={content(id)} target="_blank" rel="noreferrer"><ArrowDownToLine size={12}/>{assets.find(asset => asset.id === id)?.name || '产物'}</a>)}</div>}{!!task.receipt.validation.length && <details><summary>验证记录<ChevronDown size={12}/></summary><ul>{task.receipt.validation.map((line, index) => <li key={index}>{line}</li>)}</ul></details>}</div>}
    <time dateTime={task.createdAt}>{new Date(task.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</time>
  </article>;
}

export default function App() {
  const board = useBoard();
  const { state, draft, view } = board;
  const [theme, setTheme] = useState<'light' | 'dark'>(() => localStorage.getItem('acanvas-theme') === 'dark' ? 'dark' : 'light');
  const [mode, setMode] = useState<'select' | 'pan'>('select');
  const [queueExpanded, setQueueExpanded] = useState(false);
  const queueInteraction = useRef({ hovering: false, focused: false, pinned: false });
  const [taskDetailId, setTaskDetailId] = useState('');
  const [historyOpen, setHistoryOpen] = useState(false);
  const [cancellingTask, setCancellingTask] = useState('');
  const [annotationEdit, setAnnotationEdit] = useState<AnnotationEdit | null>(null);
  const [annotationText, setAnnotationText] = useState('');
  const [annotationEnd, setAnnotationEnd] = useState('');
  const [annotationSaving, setAnnotationSaving] = useState(false);
  const [annotationRead, setAnnotationRead] = useState<AnnotationInput | null>(null);
  const [uploads, setUploads] = useState<UploadEntry[]>([]);
  const [preview, setPreview] = useState<Record<string, Rect>>({});
  const [selectionRect, setSelectionRect] = useState<Rect | null>(null);
  const [mediaSizes, setMediaSizes] = useState<Record<string, { width: number; height: number }>>({});
  const [mediaErrors, setMediaErrors] = useState<Record<string, boolean>>({});
  const [dragOver, setDragOver] = useState(false);
  const [notice, setNotice] = useState('');
  const [copyCommand, setCopyCommand] = useState('');
  const [spacePan, setSpacePan] = useState(false);
  const [conflictOpen, setConflictOpen] = useState(false);
  const [resolvingConflict, setResolvingConflict] = useState(false);
  const canvas = useRef<HTMLDivElement>(null);
  const wheelState = useRef({ view, sessionId: state?.session.id || '', disabled: false });
  wheelState.current = { view, sessionId: state?.session.id || '', disabled: board.projectChanged || board.switching || board.sending };
  const gesture = useRef<Gesture | null>(null);
  const videoRefs = useRef(new Map<string, HTMLVideoElement>());
  const boardInput = useRef<HTMLInputElement>(null);
  const objects = (state?.objects || []).map(object => preview[object.id] ? { ...object, ...preview[object.id] } : object);
  const selectedIds = view.selectedObjectIds.filter(id => objects.some(object => object.id === id));
  const selected = objects.filter(object => selectedIds.includes(object.id));
  const assets = state?.assets || [];
  const assetFor = (id: string) => assets.find(asset => asset.id === id);
  const disabled = board.projectChanged || board.switching || board.sending;
  const allAnnotations: (AnnotationInput | Annotation)[] = [...(state?.annotations || []), ...(draft?.annotations || [])];
  const queuedTasks = state?.tasks.filter(task => ['queued', 'running', 'blocked', 'interrupted'].includes(task.status)) || [];
  const pending = queuedTasks.length;
  const pastTasks = state?.tasks.filter(task => ['completed', 'cancelled'].includes(task.status)) || [];
  const detailTask = state?.tasks.find(task => task.id === taskDetailId);

  useEffect(() => { document.documentElement.dataset.theme = theme; localStorage.setItem('acanvas-theme', theme); document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#111111' : '#f5f5f3'); }, [theme]);
  useEffect(() => { setPreview({}); setSelectionRect(null); gesture.current = null; }, [state?.session.id]);
  useEffect(() => { if (!pending) { setQueueExpanded(false); queueInteraction.current = { hovering: false, focused: false, pinned: false }; } }, [pending]);
  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    const wheel = (event: WheelEvent) => {
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
    if (!state || !draft || board.connection !== 'connected') { board.setError('白板连接已中断。请等待重新连接后再导入素材。'); return; }
    if (disabled) { board.setError(board.projectChanged ? '这个地址已连接其他项目。请重新打开白板后导入素材。' : '当前需求正在保存或发送，请稍后导入素材。'); return; }
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
      if (!event.clipboardData || target?.closest('dialog')) return;
      const composerTarget = !!target?.closest('.composer');
      if (!composerTarget && target?.closest('input,textarea,[contenteditable="true"]')) return;
      const files = filesFromTransfer(event.clipboardData);
      if (files.length) { event.preventDefault(); void importFilesRef.current(files); }
      else if (Array.from(event.clipboardData.items).some(item => item.kind === 'file')) setNotice('剪贴板中的文件暂时无法读取。请拖入文件或选择素材。');
    };
    document.addEventListener('paste', paste);
    return () => document.removeEventListener('paste', paste);
  }, []);

  async function beginAnnotation(bounds: Rect, targets: BoardObject[]) {
    if (!state || !draft || disabled) return;
    const single = targets.length === 1 ? targets[0] : undefined;
    const value: AnnotationInput = { id: crypto.randomUUID(), scope: single ? 'object' : 'region', objectId: single?.id, objectIds: targets.map(object => object.id), assetId: single?.assetId, bounds: single ? normalizedRegion(bounds, contentBounds(single)) : bounds, coordinateSpace: single ? 'normalized' : 'world', text: '' };
    if (value.bounds.width <= 0 || value.bounds.height <= 0) { setNotice('请在素材画面内选择区域。'); return; }
    let snapshot: Blob | undefined;
    let frameNote: string | undefined;
    if (single?.type === 'video') {
      const video = videoRefs.current.get(single.id);
      value.timeStart = video?.currentTime || 0;
      video?.pause();
      if (video && video.readyState >= 2 && video.videoWidth) {
        try { const frame = document.createElement('canvas'); frame.width = video.videoWidth; frame.height = video.videoHeight; frame.getContext('2d')!.drawImage(video, 0, 0); snapshot = await new Promise<Blob | undefined>(resolve => frame.toBlob(blob => resolve(blob || undefined), 'image/png')); }
        catch { /* The time point remains available for files without a browser frame. */ }
      }
      if (!snapshot) frameNote = '时间点已记录，此视频暂无可用画面快照。';
    }
    setAnnotationText(''); setAnnotationEnd('');
    setAnnotationEdit({ value, sessionId: state.session.id, draftId: draft.id, snapshot, frameNote });
  }

  function openAnnotation(annotation: AnnotationInput) {
    if (annotation.objectId && annotation.timeStart !== undefined) {
      const video = videoRefs.current.get(annotation.objectId);
      if (video) { video.pause(); video.currentTime = annotation.timeStart; }
    }
    setAnnotationRead(annotation);
  }

  async function saveAnnotation() {
    if (!annotationEdit || !annotationText.trim()) return;
    const edit = annotationEdit;
    const end = annotationEnd.trim() ? Number(annotationEnd) : undefined;
    if (end !== undefined && (!Number.isFinite(end) || end < (edit.value.timeStart || 0))) { board.setError('结束时间需大于或等于当前时间点。'); return; }
    setAnnotationSaving(true);
    try {
      const snapshot = edit.snapshot ? await board.api.upload(edit.snapshot, `视频画面-${timeLabel(edit.value.timeStart || 0).replace(':', '-')}.png`) : undefined;
      const value = { ...edit.value, text: annotationText.trim(), timeEnd: end, snapshotAssetId: snapshot?.id };
      const attached = board.changeDraftFor(edit.sessionId, edit.draftId, current => ({ ...current, annotations: [...current.annotations.filter(annotation => annotation.id !== value.id), value] }));
      if (!attached) throw new Error('这条需求已经发送。请重新选择素材并添加批注。');
      await board.flushDraft(edit.sessionId);
      await board.refresh();
      setAnnotationEdit(null); setMode('select'); setNotice('批注已加入需求草稿。');
      document.getElementById('instruction')?.focus({ preventScroll: true });
    } catch (cause) { board.showError(cause); }
    finally { setAnnotationSaving(false); }
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
    const command = `继续处理这个项目白板的任务。项目：${state.project.root}；白板：${boardUrl.href}。先核对未完成任务和已有产物，再按顺序处理；完成后登记产物与回执，队列为空或需要补充时停止。`;
    try { await navigator.clipboard.writeText(command); setNotice('接续口令已复制。'); }
    catch { setCopyCommand(command); }
  }

  function addSelection() {
    if (!selected.length) return;
    board.changeDraft(current => ({ ...current, attachments: unique([...current.attachments, ...selected.map(object => object.assetId)]), references: { ...current.references, objectIds: unique([...current.references.objectIds, ...selectedIds]) } }));
    setNotice(`${selected.length} 个素材已附加到当前需求。`);
    document.getElementById('instruction')?.focus({ preventScroll: true });
  }

  async function cancelTask(task: Task) {
    if (!state || disabled || cancellingTask) return;
    setCancellingTask(task.id);
    try {
      await board.api.request(`/api/sessions/${encodeURIComponent(state.session.id)}/tasks/${encodeURIComponent(task.id)}/cancel`, { method: 'POST', body: JSON.stringify({ reason: '用户撤回需求。' }) });
      await board.refresh();
      setNotice('需求已撤回。');
    } catch (cause) { board.showError(cause); }
    finally { setCancellingTask(''); }
  }

  function queuePointerEnter(pointerType: string) {
    if (pointerType !== 'mouse') return;
    queueInteraction.current.hovering = true;
    if (pending > 3) setQueueExpanded(true);
  }

  function queuePointerLeave(pointerType: string) {
    if (pointerType !== 'mouse') return;
    const interaction = queueInteraction.current;
    interaction.hovering = false;
    if (!interaction.focused && !interaction.pinned && !taskDetailId) setQueueExpanded(false);
  }

  function toggleQueue() {
    const next = !queueExpanded;
    queueInteraction.current.pinned = next;
    setQueueExpanded(next);
  }

  const composer = state && draft && <section className="creation-dock" aria-label="需求输入与队列" onDragOver={event => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); event.stopPropagation(); } }} onDrop={event => { const files = filesFromTransfer(event.dataTransfer); if (files.length) { event.preventDefault(); event.stopPropagation(); void importFiles(files); } }}>
    {!!pending && <div className={`queue-stack ${queueExpanded ? 'expanded' : ''} ${pending > 3 ? 'has-stack' : ''}`} data-pending={pending} onPointerEnter={event => queuePointerEnter(event.pointerType)} onPointerLeave={event => queuePointerLeave(event.pointerType)} onFocus={event => { if (event.currentTarget.contains(event.relatedTarget as Node)) return; queueInteraction.current.focused = true; if (!(event.target as Element).closest('.queue-expand')) setQueueExpanded(true); }} onBlur={event => { if (event.currentTarget.contains(event.relatedTarget as Node)) return; const interaction = queueInteraction.current; interaction.focused = false; if (!interaction.hovering && !interaction.pinned && !taskDetailId) setQueueExpanded(false); }}>
      {!queueExpanded && pending > 3 && <div className="queue-peeks" aria-hidden="true">{Array.from({ length: Math.min(pending - 3, 2) }, (_, index) => <span key={index} style={{ '--peek': index + 1 } as React.CSSProperties}/>)}</div>}
      <div className="queue-list" id="creation-queue" role="list" aria-label="任务队列">
        {queuedTasks.map(task => <article className="queue-item" role="listitem" key={task.id} data-task-id={task.id} data-status={task.status}>
          <button type="button" className="queue-task" aria-label={`查看需求 ${task.sequence}：${task.snapshot.userRequest.text || '附件与批注'}`} onClick={() => { setQueueExpanded(true); setTaskDetailId(task.id); }}><span className="queue-task-mark">{task.status === 'running' ? <LoaderCircle size={15} className="spin"/> : <ArrowUp size={15}/>}</span><span className="queue-title">{task.snapshot.userRequest.text || '根据附件与批注处理这次需求。'}</span></button>
          <span className={`status-badge status-${task.status}`}>{statusLabels[task.status]}</span>
          {['queued', 'blocked', 'interrupted'].includes(task.status) && <IconButton label={`撤回需求 ${task.sequence}`} disabled={disabled || !!cancellingTask} onClick={() => void cancelTask(task)}>{cancellingTask === task.id ? <LoaderCircle size={15} className="spin"/> : <Trash2 size={15}/>}</IconButton>}
        </article>)}
      </div>
      {pending > 3 && <button type="button" className="queue-expand" aria-expanded={queueExpanded} aria-controls="creation-queue" onClick={toggleQueue}>{queueExpanded ? '收起队列' : `${pending} 条需求`}<ChevronDown size={12}/></button>}
    </div>}
    {board.draftConflict && <div className="draft-conflict" role="status"><strong>草稿在其他入口更新</strong><p>当前输入已保留。查看两份内容后继续保存。</p><button type="button" onClick={() => setConflictOpen(true)}>查看两份草稿<ChevronRight size={12}/></button></div>}
    {!!(draft.attachments.length || draft.annotations.length) && <div className="draft-attachments" aria-label="本次需求附件">{draft.attachments.map(id => { const asset = assetFor(id); return <div className="draft-asset" key={id}><AssetThumb asset={asset} src={board.api.content(id)}/><span title={asset?.name}>{asset?.name || '正在读取素材'}</span><IconButton label={`移除附件 ${asset?.name || id}`} disabled={disabled} onClick={() => board.changeDraft(current => ({ ...current, attachments: current.attachments.filter(value => value !== id), references: { ...current.references, objectIds: current.references.objectIds.filter(objectId => { const object = state.objects.find(value => value.id === objectId); return !!object && object.assetId !== id; }) } }))}><X size={13}/></IconButton></div>; })}{draft.annotations.map((annotation, index) => <div className="draft-annotation" key={annotation.id}><button type="button" className="annotation-content" onClick={() => openAnnotation(annotation)}><span className="annotation-number">{index + 1}</span><span>{annotation.text}{annotation.timeStart !== undefined && <small> · {timeLabel(annotation.timeStart)}</small>}</span></button><IconButton label={`移除批注 ${index + 1}`} disabled={disabled} onClick={() => board.changeDraft(current => ({ ...current, annotations: current.annotations.filter(value => value.id !== annotation.id) }))}><X size={13}/></IconButton></div>)}</div>}
    <form className="composer" aria-label="需求草稿" onSubmit={event => { event.preventDefault(); if (!disabled && !uploads.length && !board.draftConflict) void board.send(); }}>
    <label className="sr-only" htmlFor="instruction">创作需求</label><textarea id="instruction" rows={1} placeholder="描述这次想做的事…" value={draft.text} readOnly={board.projectChanged} disabled={board.switching || board.sending} onChange={event => board.changeDraft(current => ({ ...current, text: event.target.value }))} onKeyDown={event => { if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); if (!disabled && !uploads.length && !board.draftConflict && (draft.text.trim() || draft.attachments.length || draft.annotations.length)) void board.send(); } }}/><button className="send-button" type="submit" disabled={disabled || !!uploads.length || !!board.draftConflict || !(draft.text.trim() || draft.attachments.length || draft.annotations.length)} aria-label="发送需求">{board.sending ? <LoaderCircle size={17} className="spin"/> : <ArrowUp size={18}/>}</button>
    </form>
    <div className="dock-footer"><button type="button" onClick={() => setHistoryOpen(true)}>记录{pastTasks.length > 0 && <span>{pastTasks.length}</span>}</button><button type="button" onClick={() => void copyResume()}>复制接续口令<Copy size={11}/></button><span className="draft-save" role="status">{saveLabels[board.saveState]}</span><span className="send-hint">⌘ / Ctrl + Enter 发送</span></div>
  </section>;

  if (!state || !draft) return <main className="startup"><span className="brand">acanvas<span>●</span></span>{board.error ? <><h1>白板暂时无法打开</h1><p role="alert">{board.error}</p><button className="button primary" onClick={() => window.location.reload()}>重新连接</button></> : <><LoaderCircle size={24} className="spin"/><p>正在打开项目白板…</p></>}</main>;

  return <div className="app-shell"><a className="skip-link" href="#whiteboard">跳到共享白板</a><header className="topbar"><span className="brand">acanvas<span>●</span></span><span className="topbar-divider"/><div className="project-name"><span>项目白板</span><strong title={state.project.root}>{state.project.name}</strong></div><span className="connection-status" role="status"><i className={board.connection === 'connected' ? 'online' : ''}/>{board.projectChanged ? '项目已切换' : board.connection === 'connected' ? saveLabels[board.saveState] : board.connection === 'reconnecting' ? '重新连接中' : '连接中'}</span><div className="topbar-actions"><button className="button import-button" disabled={disabled} onClick={() => boardInput.current?.click()}><Upload size={15}/><span>导入素材</span></button><IconButton label={theme === 'light' ? '切换暗色主题' : '切换亮色主题'} onClick={() => setTheme(current => current === 'light' ? 'dark' : 'light')}>{theme === 'light' ? <Moon size={17}/> : <Sun size={17}/>}</IconButton></div></header>
    <div className="workspace-layout"><main className="canvas-main"><div className="canvas-heading"><div><span className="eyebrow">共享画布</span><span className="object-count">{objects.length} 个素材</span></div><span className="selection-label">{selected.length ? `已选择 ${selected.length} 个` : '选择素材，继续创作'}</span></div><div id="whiteboard" className={`whiteboard mode-${spacePan ? 'pan' : mode} ${dragOver ? 'drag-over' : ''} ${board.switching ? 'is-loading' : ''}`} ref={canvas} tabIndex={0} role="region" aria-label="共享白板，Enter选择素材，方向键移动，空格平移" style={{ backgroundSize: `${24 * view.zoom}px ${24 * view.zoom}px`, backgroundPosition: `${view.x}px ${view.y}px` }} onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={() => { gesture.current = null; setPreview({}); setSelectionRect(null); }} onKeyDown={event => { if (event.target !== event.currentTarget || disabled) return; if (event.key === ' ') { event.preventDefault(); setSpacePan(true); } if (event.key === 'Escape') { selectObjects([]); setMode('select'); } if (event.key === '+' || event.key === '=') { event.preventDefault(); zoom(1.2); } if (event.key === '-') { event.preventDefault(); zoom(1 / 1.2); } }} onKeyUp={event => { if (event.key === ' ') setSpacePan(false); }} onBlur={() => setSpacePan(false)} onDragOver={event => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); setDragOver(true); } }} onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragOver(false); }} onDrop={event => { event.preventDefault(); setDragOver(false); void importFiles(filesFromTransfer(event.dataTransfer), localPoint(event)); }}>
      <div className="canvas-world" style={{ transform: `translate(${view.x}px,${view.y}px) scale(${view.zoom})` }}>{objects.map((object, index) => { const asset = assetFor(object.assetId); const isSelected = selectedIds.includes(object.id); return <article key={object.id} className={`board-object object-${object.type} ${isSelected ? 'selected' : ''}`} data-object-id={object.id} data-selected={isSelected || undefined} style={{ left: object.x, top: object.y, width: object.width, height: object.height }} tabIndex={0} role="group" aria-label={`${asset?.name || '素材'}${isSelected ? '，已选择' : ''}`} onKeyDown={event => { if (event.target !== event.currentTarget || disabled) return; if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); selectObjects(event.shiftKey ? unique([...selectedIds, object.id]) : [object.id]); } const delta = { ArrowLeft: [-10, 0], ArrowRight: [10, 0], ArrowUp: [0, -10], ArrowDown: [0, 10] }[event.key]; if (delta) { event.preventDefault(); event.stopPropagation(); void board.operations([{ type: 'update', objectId: object.id, expectedVersion: object.version, changes: { x: object.x + delta[0], y: object.y + delta[1] } }]).catch(() => undefined); } }}>
        <div className="object-media">{object.type === 'image' && !mediaErrors[object.id] && <img src={board.api.content(object.assetId)} alt={asset?.name || '导入图片'} draggable={false} onLoad={event => { const size = { width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight }; setMediaSizes(current => ({ ...current, [object.id]: size })); }} onError={() => setMediaErrors(current => ({ ...current, [object.id]: true }))}/>} {object.type === 'video' && !mediaErrors[object.id] && <video controls playsInline preload="metadata" src={board.api.content(object.assetId)} ref={element => { if (element) videoRefs.current.set(object.id, element); else videoRefs.current.delete(object.id); }} onPointerDown={event => { if (mode === 'select' && !spacePan) event.stopPropagation(); }} onLoadedMetadata={event => { const size = { width: event.currentTarget.videoWidth, height: event.currentTarget.videoHeight }; setMediaSizes(current => ({ ...current, [object.id]: size })); }} onError={() => setMediaErrors(current => ({ ...current, [object.id]: true }))}/>} {(object.type === 'file' || mediaErrors[object.id]) && <div className="file-card"><File size={32} strokeWidth={1.25}/><strong>{asset?.name || '文件'}</strong><span>{mediaErrors[object.id] ? '浏览器暂时无法预览此文件' : `${asset?.mime || '附件'} · ${bytes(asset?.size || 0)}`}</span><a data-canvas-control href={board.api.content(object.assetId)} download={asset?.name} onPointerDown={event => event.stopPropagation()}><ArrowDownToLine size={13}/>下载文件</a></div>}</div>
        <div className="object-caption"><span className="object-index">{String(index + 1).padStart(2, '0')}</span><span title={asset?.name}>{asset?.name || '素材'}</span>{object.sourceTaskId && <span className="generated-label">产物</span>}</div>{isSelected && <button type="button" className="resize-handle" data-resize-id={object.id} aria-label={`调整尺寸 ${asset?.name || '素材'}`} onKeyDown={event => { if (!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key)) return; event.preventDefault(); event.stopPropagation(); const width = Math.max(40, object.width + (event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 10 : -10)); void board.operations([{ type: 'update', objectId: object.id, expectedVersion: object.version, changes: { width, height: width * object.height / object.width } }]).catch(() => undefined); }}/>}</article>; })}
      {allAnnotations.map((annotation, index) => { const object = objects.find(value => value.id === annotation.objectId); if (annotation.coordinateSpace === 'normalized' && !object) return null; const bounds = annotation.coordinateSpace === 'normalized' && object ? objectRegion(annotation.bounds, contentBounds(object)) : annotation.bounds; return <div className={`annotation-outline ${draft.annotations.some(value => value.id === annotation.id) ? 'draft-outline' : ''}`} key={`${annotation.id}-${index}`} style={{ left: bounds.x, top: bounds.y, width: bounds.width, height: bounds.height }}><button type="button" data-canvas-control className="annotation-pin" title={annotation.text} aria-label={`批注 ${index + 1}：${annotation.text}`} onPointerDown={event => event.stopPropagation()} onClick={() => openAnnotation(annotation)} style={{ transform: `scale(${1 / view.zoom})`, transformOrigin: 'bottom left' }}>{index + 1}</button></div>; })}
      {selectionRect && <div className="selection-rect" style={{ left: selectionRect.x, top: selectionRect.y, width: selectionRect.width, height: selectionRect.height }}/>}</div>
      {!objects.length && <div className="canvas-empty"><div className="empty-mark"><ImagePlus size={31} strokeWidth={1.25}/></div><h1>给想法一个空间</h1><p>拖入图片、视频或文件。<br/>选择素材，添加批注，开始一段创作。</p><button className="button primary" data-canvas-control disabled={disabled} onClick={() => boardInput.current?.click()}><Upload size={15}/>导入第一个素材</button><span>也可直接粘贴图片或文件</span></div>}
      {dragOver && <div className="drop-indicator"><Upload size={28}/><span>放开以添加到共享画布</span></div>}
      {!!selected.length && <div className="selection-actions" data-canvas-control><button type="button" disabled={disabled} onClick={addSelection}><Plus size={14}/>附加到需求</button><button type="button" disabled={disabled} onClick={() => { const left = Math.min(...selected.map(object => contentBounds(object).x)); const top = Math.min(...selected.map(object => contentBounds(object).y)); const right = Math.max(...selected.map(object => { const bounds = contentBounds(object); return bounds.x + bounds.width; })); const bottom = Math.max(...selected.map(object => { const bounds = contentBounds(object); return bounds.y + bounds.height; })); void beginAnnotation({ x: left, y: top, width: right - left, height: bottom - top }, selected); }}><Scan size={14}/>添加批注</button><IconButton label="从画布移除所选素材" disabled={disabled} onClick={() => { void board.operations(selected.map(object => ({ type: 'delete', objectId: object.id, expectedVersion: object.version }))).then(() => selectObjects([])).catch(() => undefined); }}><Trash2 size={15}/></IconButton></div>}
      <div className="canvas-toolbar" data-canvas-control role="toolbar" aria-label="白板工具"><IconButton disabled={disabled} label="选择素材" aria-pressed={mode === 'select'} onClick={() => setMode('select')}><MousePointer2 size={16}/></IconButton><IconButton disabled={disabled} label="平移画布" aria-pressed={mode === 'pan'} onClick={() => setMode('pan')}><Hand size={16}/></IconButton><span className="toolbar-divider"/><IconButton disabled={disabled} label="缩小画布" onClick={() => zoom(1 / 1.2)}><Minus size={16}/></IconButton><button disabled={disabled} className="zoom-label" title="恢复100%缩放" aria-label="恢复100%缩放" onClick={() => { const size = canvas.current!.getBoundingClientRect(); viewUpdate(zoomAt(view, 1 / view.zoom, { x: size.width / 2, y: size.height / 2 })); }}>{Math.round(view.zoom * 100)}%</button><IconButton disabled={disabled} label="放大画布" onClick={() => zoom(1.2)}><Plus size={16}/></IconButton><span className="toolbar-divider"/><IconButton disabled={disabled} label="适配全部素材" onClick={() => { const size = canvas.current!.getBoundingClientRect(); viewUpdate(fitView(objects, size)); }}><Maximize size={16}/></IconButton></div>
      {board.switching && <div className="canvas-busy"><LoaderCircle size={20} className="spin"/>正在连接白板</div>}
    </div>{composer}</main></div>
    <input className="sr-only" aria-label="选择画布素材文件" tabIndex={-1} type="file" multiple ref={boardInput} onChange={event => { void importFiles(Array.from(event.target.files || [])); event.target.value = ''; }}/>
    {(board.error || board.projectChanged) && <div className="error-banner" role="alert"><span>{board.error || '这个地址已连接其他项目。当前草稿已保留，请重新打开白板。'}</span>{board.projectChanged && <button onClick={() => window.location.assign(window.location.pathname)}>重新打开白板</button>}{!board.projectChanged && board.saveState === 'failed' && <button onClick={() => void board.flushDraft().catch(() => undefined)}>重试保存</button>}<IconButton label="关闭错误提示" disabled={board.projectChanged} onClick={() => board.setError('')}><X size={15}/></IconButton></div>}
    {!!uploads.length && <div className="upload-list" aria-live="polite">{uploads.map(upload => <div key={upload.id}><LoaderCircle size={15} className="spin"/><span>正在导入 {upload.name}<small>共享画布</small></span><IconButton label={`取消导入 ${upload.name}`} onClick={() => upload.controller.abort()}><X size={15}/></IconButton></div>)}</div>}
    {notice && <div className="toast" role="status"><Check size={14}/>{notice}</div>}
    <Modal open={conflictOpen && !!board.draftConflict} title="处理草稿更新" className="conflict-modal" onClose={() => { if (!resolvingConflict) setConflictOpen(false); }}><div className="conflict-comparison">{[{ label: '当前输入', value: draft }, { label: '服务端草稿', value: board.draftConflict }].map(item => <section key={item.label}><h3>{item.label}</h3><p className="conflict-text">{item.value?.text || '尚未填写文字'}</p><div className="conflict-references"><span>{item.value?.attachments.length || 0} 个附件 · {item.value?.annotations.length || 0} 条批注</span>{item.value?.attachments.map(id => <small key={id}>{assetFor(id)?.name || id}</small>)}{item.value?.annotations.map(annotation => <small key={annotation.id}>{annotation.text}</small>)}</div></section>)}</div><p className="field-hint">选择一份内容作为当前草稿。另一份内容在作出选择前保持完整。</p><div className="modal-actions"><button type="button" className="button" disabled={resolvingConflict} onClick={() => { setResolvingConflict(true); void board.resolveDraftConflict('remote').then(() => setConflictOpen(false)).catch(board.showError).finally(() => setResolvingConflict(false)); }}>使用服务端草稿</button><button type="button" className="button primary" disabled={resolvingConflict} onClick={() => { setResolvingConflict(true); void board.resolveDraftConflict('local').then(() => setConflictOpen(false)).catch(board.showError).finally(() => setResolvingConflict(false)); }}>{resolvingConflict ? '正在保存…' : '保留当前草稿'}</button></div></Modal>
    <Modal open={!!annotationEdit} title="添加批注" onClose={() => { if (!annotationSaving) setAnnotationEdit(null); }}><form onSubmit={event => { event.preventDefault(); void saveAnnotation(); }}><div className="annotation-context"><span><Scan size={15}/>{annotationEdit?.value.scope === 'object' ? '素材选区' : '画布区域'}</span><span>加入需求草稿</span></div>{annotationEdit?.value.timeStart !== undefined && <div className="video-annotation-meta"><span>视频时间点 {timeLabel(annotationEdit.value.timeStart)}</span><label>结束时间（秒，可选）<input type="number" min={annotationEdit.value.timeStart} step="0.1" value={annotationEnd} onChange={event => setAnnotationEnd(event.target.value)} disabled={annotationSaving}/></label>{annotationEdit.frameNote && <p>{annotationEdit.frameNote}</p>}</div>}<label className="field-label" htmlFor="annotation-text">批注内容</label><textarea id="annotation-text" autoFocus rows={4} placeholder="描述这个区域需要调整或保留的内容…" value={annotationText} onChange={event => setAnnotationText(event.target.value)} disabled={annotationSaving}/><div className="modal-actions"><button type="button" className="button" disabled={annotationSaving} onClick={() => setAnnotationEdit(null)}>取消</button><button type="submit" className="button primary" disabled={annotationSaving || !annotationText.trim()}>{annotationSaving ? '正在保存…' : '加入需求草稿'}</button></div></form></Modal>
    <Modal open={!!annotationRead} title="批注内容" onClose={() => setAnnotationRead(null)}><div className="annotation-reader"><p>{annotationRead?.text}</p>{annotationRead?.timeStart !== undefined && <span>视频 {timeLabel(annotationRead.timeStart)}{annotationRead.timeEnd !== undefined ? ` – ${timeLabel(annotationRead.timeEnd)}` : ''}</span>}{annotationRead?.snapshotAssetId && <img src={board.api.content(annotationRead.snapshotAssetId)} alt="批注对应的视频画面"/>}</div></Modal>
    <Modal open={!!copyCommand} title="接续口令" onClose={() => setCopyCommand('')}><p className="field-hint">复制口令，在当前 agent 聊天中继续处理。</p><textarea className="command-text" readOnly value={copyCommand} rows={5} autoFocus onFocus={event => event.target.select()}/></Modal>
    <Modal open={!!detailTask} title={detailTask ? `需求 ${detailTask.sequence}` : '需求详情'} className="task-modal" onClose={() => { setQueueExpanded(true); setTaskDetailId(''); }}>{detailTask && <TaskCard task={detailTask} assets={assets} content={id => board.api.content(id)} queue={false}/>}</Modal>
    <Modal open={historyOpen} title="需求记录" className="history-modal" onClose={() => setHistoryOpen(false)}>{state.tasks.length ? [...state.tasks].reverse().map(task => <TaskCard task={task} key={task.id} assets={assets} content={id => board.api.content(id)} queue={false}/>) : <p className="field-hint">发送需求后，进度与回执会保存在这里。</p>}</Modal>
  </div>;
}
