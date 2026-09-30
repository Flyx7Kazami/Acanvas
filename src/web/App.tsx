import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { ArrowDownToLine, ArrowUp, Check, ChevronDown, ChevronRight, Copy, File, FolderOpen, Hand, ImagePlus, LoaderCircle, Maximize, Menu, MessageSquare, Minus, Moon, MousePointer2, Plus, Scan, Sun, Trash2, Upload, X } from 'lucide-react';
import type { Annotation, AnnotationInput, Asset, BoardObject, Draft, SessionView, Task, TaskStatus } from '../shared/types';
import { fitView, intersects, mediaContentRect, normalizedRegion, objectRegion, rectangle, screenToWorld, zoomAt, type Point, type Rect } from './geometry';
import { useBoard } from './useBoard';

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

function useMediaQuery(query: string) {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => { const media = window.matchMedia(query); const update = () => setMatches(media.matches); media.addEventListener('change', update); update(); return () => media.removeEventListener('change', update); }, [query]);
  return matches;
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

type UploadEntry = { id: string; name: string; target: 'board' | 'draft'; controller: AbortController };
type AnnotationEdit = { value: AnnotationInput; sessionId: string; draftId: string; sessionName: string; snapshot?: Blob; frameNote?: string };
type Gesture = { kind: 'move' | 'resize' | 'pan' | 'select' | 'annotate'; start: Point; view: SessionView; objects: BoardObject[]; sessionId: string; objectId?: string };

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
  const [mode, setMode] = useState<'select' | 'pan' | 'annotate'>('select');
  const [tab, setTab] = useState<'chat' | 'queue'>('chat');
  const [sessionDrawer, setSessionDrawer] = useState(false);
  const [panelDrawer, setPanelDrawer] = useState(false);
  const [newSession, setNewSession] = useState(false);
  const [sessionName, setSessionName] = useState('');
  const [creating, setCreating] = useState(false);
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
  const draftInput = useRef<HTMLInputElement>(null);
  const history = useRef<HTMLDivElement>(null);
  const narrowPanel = useMediaQuery('(max-width: 1080px)');
  const narrowSessions = useMediaQuery('(max-width: 760px)');
  const objects = (state?.objects || []).map(object => preview[object.id] ? { ...object, ...preview[object.id] } : object);
  const selectedIds = view.selectedObjectIds.filter(id => objects.some(object => object.id === id));
  const selected = objects.filter(object => selectedIds.includes(object.id));
  const assets = state?.assets || [];
  const assetFor = (id: string) => assets.find(asset => asset.id === id);
  const disabled = board.projectChanged || board.switching || board.sending;
  const allAnnotations: (AnnotationInput | Annotation)[] = [...(state?.annotations || []), ...(draft?.annotations || [])];
  const pending = state?.tasks.filter(task => ['queued', 'running', 'blocked', 'interrupted'].includes(task.status)).length || 0;

  useEffect(() => { document.documentElement.dataset.theme = theme; localStorage.setItem('acanvas-theme', theme); document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#111111' : '#f5f5f3'); }, [theme]);
  useEffect(() => { const element = history.current; if (element) element.scrollTop = element.scrollHeight; }, [state?.tasks.length, state?.session.id]);
  useEffect(() => { setPreview({}); setSelectionRect(null); gesture.current = null; }, [state?.session.id]);
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

  async function importFiles(files: File[], target: 'board' | 'draft') {
    if (!state || !draft || disabled || !files.length) return;
    const sessionId = state.session.id;
    const draftId = draft.id;
    const importView = view;
    const size = canvas.current?.getBoundingClientRect();
    const position = screenToWorld({ x: (size?.width || 600) / 2, y: (size?.height || 600) / 2 - 30 }, importView);
    for (const [index, file] of files.entries()) {
      const id = crypto.randomUUID();
      const controller = new AbortController();
      setUploads(current => [...current, { id, name: file.name, target, controller }]);
      try {
        const dimensions = target === 'board' ? await fileDimensions(file) : undefined;
        if (controller.signal.aborted) continue;
        const asset = await board.api.upload(file, file.name, controller.signal);
        if (target === 'board') {
          let width = 280, height = asset.kind === 'file' ? 150 : 210;
          if (dimensions?.width && dimensions.height) { const scale = Math.min(340 / dimensions.width, 280 / dimensions.height); width = dimensions.width * scale; height = dimensions.height * scale; }
          await board.operations([{ type: 'create', object: { assetId: asset.id, x: position.x - width / 2 + index * 30, y: position.y - height / 2 + index * 30, width, height } }], sessionId);
        } else {
          const attached = board.changeDraftFor(sessionId, draftId, current => ({ ...current, attachments: unique([...current.attachments, asset.id]) }));
          if (!attached) setNotice('素材已导入项目；原需求已发送，请重新附加素材。');
          await board.refresh();
        }
      } catch (cause) { if (!controller.signal.aborted) board.showError(cause); }
      finally { setUploads(current => current.filter(upload => upload.id !== id)); }
    }
  }

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
    setAnnotationEdit({ value, sessionId: state.session.id, draftId: draft.id, sessionName: state.session.name, snapshot, frameNote });
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
      if (narrowPanel) setPanelDrawer(true);
    } catch (cause) { board.showError(cause); }
    finally { setAnnotationSaving(false); }
  }

  function pointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (disabled || !state || event.button !== 0 || (event.target as HTMLElement).closest('[data-canvas-control]')) return;
    const point = localPoint(event);
    const objectId = (event.target as HTMLElement).closest<HTMLElement>('[data-object-id]')?.dataset.objectId;
    const resizeId = (event.target as HTMLElement).closest<HTMLElement>('[data-resize-id]')?.dataset.resizeId;
    const effectiveMode = spacePan ? 'pan' : mode;
    const object = objects.find(value => value.id === objectId);
    let kind: Gesture['kind'] = effectiveMode === 'pan' ? 'pan' : effectiveMode === 'annotate' ? 'annotate' : 'select';
    let moving: BoardObject[] = [];
    if (resizeId) { kind = 'resize'; moving = objects.filter(value => value.id === resizeId); }
    else if (effectiveMode === 'select' && object) {
      if (event.shiftKey) { selectObjects(selectedIds.includes(object.id) ? selectedIds.filter(id => id !== object.id) : [...selectedIds, object.id]); return; }
      const ids = selectedIds.includes(object.id) ? selectedIds : [object.id];
      selectObjects(ids); kind = 'move'; moving = objects.filter(value => ids.includes(value.id));
    } else if (effectiveMode === 'select' && !event.shiftKey) selectObjects([]);
    gesture.current = { kind, start: point, view, objects: moving, sessionId: state.session.id, objectId: object?.id };
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
    if (active.kind === 'select' || active.kind === 'annotate') setSelectionRect(rectangle(screenToWorld(active.start, active.view), screenToWorld(point, active.view)));
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
    if (active.kind === 'annotate' && region.width > 2 && region.height > 2) { const targets = active.objectId ? objects.filter(object => object.id === active.objectId) : objects.filter(object => intersects(region, contentBounds(object))); void beginAnnotation(region, targets); }
    setSelectionRect(null);
  }

  function zoom(factor: number) {
    if (disabled) return;
    const size = canvas.current?.getBoundingClientRect();
    viewUpdate(zoomAt(view, factor, { x: (size?.width || 600) / 2, y: (size?.height || 600) / 2 }));
  }

  async function copyResume() {
    if (!state) return;
    const command = `继续处理项目 ${state.project.root} 的白板会话 ${state.session.id}。先核对并恢复上次中断的任务，再按顺序完成待办；完成后记录结果，队列为空或需要我补充时停止。`;
    try { await navigator.clipboard.writeText(command); setNotice('会话恢复口令已复制。'); }
    catch { setCopyCommand(command); }
  }

  function addSelection() {
    if (!selected.length) return;
    board.changeDraft(current => ({ ...current, attachments: unique([...current.attachments, ...selected.map(object => object.assetId)]), references: { ...current.references, objectIds: unique([...current.references.objectIds, ...selectedIds]) } }));
    setNotice(`${selected.length} 个素材已附加到当前需求。`);
    if (narrowPanel) setPanelDrawer(true);
  }

  const sessionList = <nav className="session-list" aria-label="白板会话"><div className="rail-heading"><span>项目会话</span><IconButton label="新建白板会话" disabled={disabled} onClick={() => { setSessionName(''); setNewSession(true); }}><Plus size={16}/></IconButton></div><div className="session-buttons">{state?.sessions.map(session => <button key={session.id} className={`session-button ${session.id === state.session.id ? 'active' : ''}`} aria-current={session.id === state.session.id ? 'page' : undefined} disabled={disabled} onClick={() => { void board.switchSession(session.id); setSessionDrawer(false); }}><MessageSquare size={15}/><span>{session.name}</span>{session.consumerId && <span className="session-live" title="执行者已连接"/>}</button>)}</div><div className="rail-foot"><FolderOpen size={14}/><span>项目共享白板</span><p>需求与草稿按会话保存</p></div></nav>;

  const panel = state && draft && <aside className="session-panel" aria-label="当前会话需求与队列"><header className="panel-heading"><div><span className="eyebrow">当前发送目标</span><h2>{state.session.name}</h2></div><IconButton label="复制当前会话恢复口令" onClick={() => void copyResume()}><Copy size={16}/></IconButton></header><div className="panel-tabs" role="tablist" aria-label="会话内容"><button role="tab" aria-selected={tab === 'chat'} aria-controls="session-history" onClick={() => setTab('chat')}>需求记录</button><button role="tab" aria-selected={tab === 'queue'} aria-controls="session-history" onClick={() => setTab('queue')}>队列<span>{pending}</span></button></div><div id="session-history" className="session-history" ref={history} role="tabpanel" aria-label={tab === 'chat' ? '需求记录' : '任务队列'}>{state.tasks.length ? state.tasks.map(task => <TaskCard key={task.id} task={task} assets={assets} content={id => board.api.content(id)} queue={tab === 'queue'}/>) : <div className="history-empty"><MessageSquare size={25} strokeWidth={1.3}/><h3>从一个想法开始</h3><p>附上素材或批注，把需求发送到这个会话。</p></div>}<div className="queue-note">{state.session.consumerId ? '执行者已连接 · 按顺序处理当前会话' : pending ? '已排队，等待继续' : '当前会话队列为空'}<button type="button" onClick={() => void copyResume()}>复制接续口令<ChevronRight size={12}/></button></div></div><form className="composer" aria-label="当前会话需求草稿" onSubmit={event => { event.preventDefault(); if (!disabled && !uploads.length && !board.draftConflict) void board.send(); }} onDragOver={event => { event.preventDefault(); event.stopPropagation(); }} onDrop={event => { event.preventDefault(); event.stopPropagation(); void importFiles(Array.from(event.dataTransfer.files), 'draft'); }} onPaste={event => { const files = Array.from(event.clipboardData.files); if (files.length) { event.preventDefault(); event.stopPropagation(); void importFiles(files, 'draft'); } }}>
    {board.draftConflict && <div className="draft-conflict" role="status"><strong>草稿在其他入口更新</strong><p>当前输入已保留。查看两份内容后继续保存。</p><button type="button" onClick={() => setConflictOpen(true)}>查看两份草稿<ChevronRight size={12}/></button></div>}
    {!!(draft.attachments.length || draft.annotations.length) && <div className="draft-attachments" aria-label="本次需求附件">{draft.attachments.map(id => { const asset = assetFor(id); return <div className="draft-asset" key={id}><AssetThumb asset={asset} src={board.api.content(id)}/><span title={asset?.name}>{asset?.name || '正在读取素材'}</span><IconButton label={`移除附件 ${asset?.name || id}`} disabled={disabled} onClick={() => board.changeDraft(current => ({ ...current, attachments: current.attachments.filter(value => value !== id), references: { ...current.references, objectIds: current.references.objectIds.filter(objectId => { const object = state.objects.find(value => value.id === objectId); return !!object && object.assetId !== id; }) } }))}><X size={13}/></IconButton></div>; })}{draft.annotations.map((annotation, index) => <div className="draft-annotation" key={annotation.id}><button type="button" className="annotation-content" onClick={() => openAnnotation(annotation)}><span className="annotation-number">{index + 1}</span><span>{annotation.text}{annotation.timeStart !== undefined && <small> · {timeLabel(annotation.timeStart)}</small>}</span></button><IconButton label={`移除批注 ${index + 1}`} disabled={disabled} onClick={() => board.changeDraft(current => ({ ...current, annotations: current.annotations.filter(value => value.id !== annotation.id) }))}><X size={13}/></IconButton></div>)}</div>}
    <label className="sr-only" htmlFor="instruction">向 {state.session.name} 发送需求</label><textarea id="instruction" rows={3} placeholder="描述这次想做的事…" value={draft.text} readOnly={board.projectChanged} disabled={board.switching || board.sending} onChange={event => board.changeDraft(current => ({ ...current, text: event.target.value }))} onKeyDown={event => { if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); if (!disabled && !uploads.length && !board.draftConflict && (draft.text.trim() || draft.attachments.length || draft.annotations.length)) void board.send(); } }}/><div className="composer-bottom"><IconButton label="为当前需求添加附件" disabled={disabled} onClick={() => draftInput.current?.click()}><Plus size={18}/></IconButton><span className="draft-save" role="status">{saveLabels[board.saveState]}</span><button className="send-button" type="submit" disabled={disabled || !!uploads.length || !!board.draftConflict || !(draft.text.trim() || draft.attachments.length || draft.annotations.length)} aria-label="发送需求">{board.sending ? <LoaderCircle size={17} className="spin"/> : <ArrowUp size={18}/>}</button></div><p className="composer-target">发送至 {state.session.name}<span>⌘ / Ctrl + Enter</span></p>
  </form></aside>;

  if (!state || !draft) return <main className="startup"><span className="brand">acanvas<span>●</span></span>{board.error ? <><h1>白板暂时无法打开</h1><p role="alert">{board.error}</p><button className="button primary" onClick={() => window.location.reload()}>重新连接</button></> : <><LoaderCircle size={24} className="spin"/><p>正在打开项目白板…</p></>}</main>;

  return <div className="app-shell"><a className="skip-link" href="#whiteboard">跳到共享白板</a><header className="topbar"><IconButton className="mobile-sessions" label="打开会话列表" onClick={() => setSessionDrawer(true)}><Menu size={19}/></IconButton><span className="brand">acanvas<span>●</span></span><span className="topbar-divider"/><div className="project-name"><span>项目白板</span><strong title={state.project.root}>{state.project.name}</strong></div><span className="connection-status" role="status"><i className={board.connection === 'connected' ? 'online' : ''}/>{board.projectChanged ? '项目已切换' : board.connection === 'connected' ? saveLabels[board.saveState] : board.connection === 'reconnecting' ? '重新连接中' : '连接中'}</span><div className="topbar-actions"><button className="button import-button" disabled={disabled} onClick={() => boardInput.current?.click()}><Upload size={15}/><span>导入素材</span></button><IconButton label={theme === 'light' ? '切换暗色主题' : '切换亮色主题'} onClick={() => setTheme(current => current === 'light' ? 'dark' : 'light')}>{theme === 'light' ? <Moon size={17}/> : <Sun size={17}/>}</IconButton><IconButton className="mobile-panel" label="打开需求与队列" onClick={() => setPanelDrawer(true)}><MessageSquare size={18}/>{!!pending && <span className="panel-count">{pending}</span>}</IconButton></div></header>
    <div className="workspace-layout">{!narrowSessions && sessionList}<main className="canvas-main"><div className="canvas-heading"><div><span className="eyebrow">共享画布</span><span className="object-count">{objects.length} 个素材</span></div><span className="selection-label">{selected.length ? `已选择 ${selected.length} 个` : '选择素材，继续创作'}</span></div><div id="whiteboard" className={`whiteboard mode-${spacePan ? 'pan' : mode} ${dragOver ? 'drag-over' : ''} ${board.switching ? 'is-loading' : ''}`} ref={canvas} tabIndex={0} role="region" aria-label="共享白板，Enter选择素材，方向键移动，空格平移" style={{ backgroundSize: `${24 * view.zoom}px ${24 * view.zoom}px`, backgroundPosition: `${view.x}px ${view.y}px` }} onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={() => { gesture.current = null; setPreview({}); setSelectionRect(null); }} onKeyDown={event => { if (event.target !== event.currentTarget || disabled) return; if (event.key === ' ') { event.preventDefault(); setSpacePan(true); } if (event.key === 'Escape') { selectObjects([]); setMode('select'); } if (event.key === '+' || event.key === '=') { event.preventDefault(); zoom(1.2); } if (event.key === '-') { event.preventDefault(); zoom(1 / 1.2); } }} onKeyUp={event => { if (event.key === ' ') setSpacePan(false); }} onBlur={() => setSpacePan(false)} onDragOver={event => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); setDragOver(true); } }} onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragOver(false); }} onDrop={event => { event.preventDefault(); setDragOver(false); void importFiles(Array.from(event.dataTransfer.files), 'board'); }} onPaste={event => { if ((event.target as HTMLElement).closest('input,textarea,[contenteditable=true]')) return; const files = Array.from(event.clipboardData.files); if (files.length) { event.preventDefault(); void importFiles(files, 'board'); } }}>
      <div className="canvas-world" style={{ transform: `translate(${view.x}px,${view.y}px) scale(${view.zoom})` }}>{objects.map((object, index) => { const asset = assetFor(object.assetId); const isSelected = selectedIds.includes(object.id); return <article key={object.id} className={`board-object object-${object.type} ${isSelected ? 'selected' : ''}`} data-object-id={object.id} data-selected={isSelected || undefined} style={{ left: object.x, top: object.y, width: object.width, height: object.height }} tabIndex={0} role="group" aria-label={`${asset?.name || '素材'}${isSelected ? '，已选择' : ''}`} onKeyDown={event => { if (event.target !== event.currentTarget || disabled) return; if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); selectObjects(event.shiftKey ? unique([...selectedIds, object.id]) : [object.id]); } const delta = { ArrowLeft: [-10, 0], ArrowRight: [10, 0], ArrowUp: [0, -10], ArrowDown: [0, 10] }[event.key]; if (delta) { event.preventDefault(); event.stopPropagation(); void board.operations([{ type: 'update', objectId: object.id, expectedVersion: object.version, changes: { x: object.x + delta[0], y: object.y + delta[1] } }]).catch(() => undefined); } }}>
        <div className="object-media">{object.type === 'image' && !mediaErrors[object.id] && <img src={board.api.content(object.assetId)} alt={asset?.name || '导入图片'} draggable={false} onLoad={event => { const size = { width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight }; setMediaSizes(current => ({ ...current, [object.id]: size })); }} onError={() => setMediaErrors(current => ({ ...current, [object.id]: true }))}/>} {object.type === 'video' && !mediaErrors[object.id] && <video controls playsInline preload="metadata" src={board.api.content(object.assetId)} ref={element => { if (element) videoRefs.current.set(object.id, element); else videoRefs.current.delete(object.id); }} onPointerDown={event => { if (mode === 'select' && !spacePan) event.stopPropagation(); }} onLoadedMetadata={event => { const size = { width: event.currentTarget.videoWidth, height: event.currentTarget.videoHeight }; setMediaSizes(current => ({ ...current, [object.id]: size })); }} onError={() => setMediaErrors(current => ({ ...current, [object.id]: true }))}/>} {(object.type === 'file' || mediaErrors[object.id]) && <div className="file-card"><File size={32} strokeWidth={1.25}/><strong>{asset?.name || '文件'}</strong><span>{mediaErrors[object.id] ? '浏览器暂时无法预览此文件' : `${asset?.mime || '附件'} · ${bytes(asset?.size || 0)}`}</span><a data-canvas-control href={board.api.content(object.assetId)} download={asset?.name} onPointerDown={event => event.stopPropagation()}><ArrowDownToLine size={13}/>下载文件</a></div>}</div>
        <div className="object-caption"><span className="object-index">{String(index + 1).padStart(2, '0')}</span><span title={asset?.name}>{asset?.name || '素材'}</span>{object.sourceTaskId && <span className="generated-label">产物</span>}</div>{isSelected && <button type="button" className="resize-handle" data-resize-id={object.id} aria-label={`调整尺寸 ${asset?.name || '素材'}`} onKeyDown={event => { if (!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key)) return; event.preventDefault(); event.stopPropagation(); const width = Math.max(40, object.width + (event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 10 : -10)); void board.operations([{ type: 'update', objectId: object.id, expectedVersion: object.version, changes: { width, height: width * object.height / object.width } }]).catch(() => undefined); }}/>}</article>; })}
      {allAnnotations.map((annotation, index) => { const object = objects.find(value => value.id === annotation.objectId); if (annotation.coordinateSpace === 'normalized' && !object) return null; const bounds = annotation.coordinateSpace === 'normalized' && object ? objectRegion(annotation.bounds, contentBounds(object)) : annotation.bounds; return <div className={`annotation-outline ${draft.annotations.some(value => value.id === annotation.id) ? 'draft-outline' : ''}`} key={`${annotation.id}-${index}`} style={{ left: bounds.x, top: bounds.y, width: bounds.width, height: bounds.height }}><button type="button" data-canvas-control className="annotation-pin" title={annotation.text} aria-label={`批注 ${index + 1}：${annotation.text}`} onPointerDown={event => event.stopPropagation()} onClick={() => openAnnotation(annotation)} style={{ transform: `scale(${1 / view.zoom})`, transformOrigin: 'bottom left' }}>{index + 1}</button></div>; })}
      {selectionRect && <div className={`selection-rect ${mode === 'annotate' ? 'annotation-selection' : ''}`} style={{ left: selectionRect.x, top: selectionRect.y, width: selectionRect.width, height: selectionRect.height }}/>}</div>
      {!objects.length && <div className="canvas-empty"><div className="empty-mark"><ImagePlus size={31} strokeWidth={1.25}/></div><h1>给想法一个空间</h1><p>拖入图片、视频或文件。<br/>选择素材，添加批注，开始一段创作。</p><button className="button primary" data-canvas-control disabled={disabled} onClick={() => boardInput.current?.click()}><Plus size={15}/>导入第一个素材</button><span>也可粘贴截图与浏览器图片</span></div>}
      {dragOver && <div className="drop-indicator"><Upload size={28}/><span>放开以添加到共享画布</span></div>}
      {!!selected.length && <div className="selection-actions" data-canvas-control><button type="button" disabled={disabled} onClick={addSelection}><Plus size={14}/>附加到需求</button><button type="button" disabled={disabled} onClick={() => { const left = Math.min(...selected.map(object => contentBounds(object).x)); const top = Math.min(...selected.map(object => contentBounds(object).y)); const right = Math.max(...selected.map(object => { const bounds = contentBounds(object); return bounds.x + bounds.width; })); const bottom = Math.max(...selected.map(object => { const bounds = contentBounds(object); return bounds.y + bounds.height; })); void beginAnnotation({ x: left, y: top, width: right - left, height: bottom - top }, selected); }}><Scan size={14}/>添加批注</button><IconButton label="从画布移除所选素材" disabled={disabled} onClick={() => { void board.operations(selected.map(object => ({ type: 'delete', objectId: object.id, expectedVersion: object.version }))).then(() => selectObjects([])).catch(() => undefined); }}><Trash2 size={15}/></IconButton></div>}
      <div className="canvas-toolbar" data-canvas-control role="toolbar" aria-label="白板工具"><IconButton disabled={disabled} label="选择素材" aria-pressed={mode === 'select'} onClick={() => setMode('select')}><MousePointer2 size={17}/></IconButton><IconButton disabled={disabled} label="平移画布" aria-pressed={mode === 'pan'} onClick={() => setMode('pan')}><Hand size={17}/></IconButton><IconButton disabled={disabled} label="绘制区域批注" aria-pressed={mode === 'annotate'} onClick={() => setMode('annotate')}><Scan size={17}/></IconButton><span className="toolbar-divider"/><IconButton disabled={disabled} label="缩小画布" onClick={() => zoom(1 / 1.2)}><Minus size={16}/></IconButton><button disabled={disabled} className="zoom-label" title="恢复100%缩放" onClick={() => { const size = canvas.current!.getBoundingClientRect(); viewUpdate(zoomAt(view, 1 / view.zoom, { x: size.width / 2, y: size.height / 2 })); }}>{Math.round(view.zoom * 100)}%</button><IconButton disabled={disabled} label="放大画布" onClick={() => zoom(1.2)}><Plus size={16}/></IconButton><span className="toolbar-divider"/><IconButton disabled={disabled} label="适配全部素材" onClick={() => { const size = canvas.current!.getBoundingClientRect(); viewUpdate(fitView(objects, size)); }}><Maximize size={16}/></IconButton></div>
      {mode === 'annotate' && <div className="mode-hint">拖出选区，添加批注</div>}{board.switching && <div className="canvas-busy"><LoaderCircle size={20} className="spin"/>正在切换会话</div>}
    </div></main>{!narrowPanel && panel}</div>
    <input className="sr-only" aria-label="选择画布素材文件" tabIndex={-1} type="file" multiple ref={boardInput} onChange={event => { void importFiles(Array.from(event.target.files || []), 'board'); event.target.value = ''; }}/><input className="sr-only" aria-label="选择需求附件文件" tabIndex={-1} type="file" multiple ref={draftInput} onChange={event => { void importFiles(Array.from(event.target.files || []), 'draft'); event.target.value = ''; }}/>
    {(board.error || board.projectChanged) && <div className="error-banner" role="alert"><span>{board.error || '这个地址已连接其他项目。当前草稿已保留，请重新打开白板。'}</span>{board.projectChanged && <button onClick={() => window.location.assign(window.location.pathname)}>重新打开白板</button>}{!board.projectChanged && board.saveState === 'failed' && <button onClick={() => void board.flushDraft().catch(() => undefined)}>重试保存</button>}<IconButton label="关闭错误提示" disabled={board.projectChanged} onClick={() => board.setError('')}><X size={15}/></IconButton></div>}
    {!!uploads.length && <div className="upload-list" aria-live="polite">{uploads.map(upload => <div key={upload.id}><LoaderCircle size={15} className="spin"/><span>正在导入 {upload.name}<small>{upload.target === 'board' ? '共享画布' : '需求附件'}</small></span><IconButton label={`取消导入 ${upload.name}`} onClick={() => upload.controller.abort()}><X size={15}/></IconButton></div>)}</div>}
    {notice && <div className="toast" role="status"><Check size={14}/>{notice}</div>}
    <Modal open={conflictOpen && !!board.draftConflict} title="处理草稿更新" className="conflict-modal" onClose={() => { if (!resolvingConflict) setConflictOpen(false); }}><div className="conflict-comparison">{[{ label: '当前输入', value: draft }, { label: '服务端草稿', value: board.draftConflict }].map(item => <section key={item.label}><h3>{item.label}</h3><p className="conflict-text">{item.value?.text || '尚未填写文字'}</p><div className="conflict-references"><span>{item.value?.attachments.length || 0} 个附件 · {item.value?.annotations.length || 0} 条批注</span>{item.value?.attachments.map(id => <small key={id}>{assetFor(id)?.name || id}</small>)}{item.value?.annotations.map(annotation => <small key={annotation.id}>{annotation.text}</small>)}</div></section>)}</div><p className="field-hint">选择一份内容作为当前草稿。另一份内容在作出选择前保持完整。</p><div className="modal-actions"><button type="button" className="button" disabled={resolvingConflict} onClick={() => { setResolvingConflict(true); void board.resolveDraftConflict('remote').then(() => setConflictOpen(false)).catch(board.showError).finally(() => setResolvingConflict(false)); }}>使用服务端草稿</button><button type="button" className="button primary" disabled={resolvingConflict} onClick={() => { setResolvingConflict(true); void board.resolveDraftConflict('local').then(() => setConflictOpen(false)).catch(board.showError).finally(() => setResolvingConflict(false)); }}>{resolvingConflict ? '正在保存…' : '保留当前草稿'}</button></div></Modal>
    <Modal open={newSession} title="新建白板会话" onClose={() => { if (!creating) setNewSession(false); }}><form onSubmit={event => { event.preventDefault(); if (!sessionName.trim() || creating) return; setCreating(true); void board.createSession(sessionName.trim()).then(() => setNewSession(false)).catch(board.showError).finally(() => setCreating(false)); }}><label className="field-label" htmlFor="session-name">会话名称</label><input id="session-name" autoFocus value={sessionName} onChange={event => setSessionName(event.target.value)} placeholder="例如：视觉探索" disabled={creating}/><p className="field-hint">继续使用项目白板，开启独立的需求与草稿。</p><div className="modal-actions"><button type="button" className="button" disabled={creating} onClick={() => setNewSession(false)}>取消</button><button type="submit" className="button primary" disabled={creating || board.projectChanged || !sessionName.trim()}>{creating ? '正在创建…' : '创建会话'}</button></div></form></Modal>
    <Modal open={!!annotationEdit} title="添加批注" onClose={() => { if (!annotationSaving) setAnnotationEdit(null); }}><form onSubmit={event => { event.preventDefault(); void saveAnnotation(); }}><div className="annotation-context"><span><Scan size={15}/>{annotationEdit?.value.scope === 'object' ? '素材选区' : '画布区域'}</span><span>加入 {annotationEdit?.sessionName}</span></div>{annotationEdit?.value.timeStart !== undefined && <div className="video-annotation-meta"><span>视频时间点 {timeLabel(annotationEdit.value.timeStart)}</span><label>结束时间（秒，可选）<input type="number" min={annotationEdit.value.timeStart} step="0.1" value={annotationEnd} onChange={event => setAnnotationEnd(event.target.value)} disabled={annotationSaving}/></label>{annotationEdit.frameNote && <p>{annotationEdit.frameNote}</p>}</div>}<label className="field-label" htmlFor="annotation-text">批注内容</label><textarea id="annotation-text" autoFocus rows={4} placeholder="描述这个区域需要调整或保留的内容…" value={annotationText} onChange={event => setAnnotationText(event.target.value)} disabled={annotationSaving}/><div className="modal-actions"><button type="button" className="button" disabled={annotationSaving} onClick={() => setAnnotationEdit(null)}>取消</button><button type="submit" className="button primary" disabled={annotationSaving || !annotationText.trim()}>{annotationSaving ? '正在保存…' : '加入需求草稿'}</button></div></form></Modal>
    <Modal open={!!annotationRead} title="批注内容" onClose={() => setAnnotationRead(null)}><div className="annotation-reader"><p>{annotationRead?.text}</p>{annotationRead?.timeStart !== undefined && <span>视频 {timeLabel(annotationRead.timeStart)}{annotationRead.timeEnd !== undefined ? ` – ${timeLabel(annotationRead.timeEnd)}` : ''}</span>}{annotationRead?.snapshotAssetId && <img src={board.api.content(annotationRead.snapshotAssetId)} alt="批注对应的视频画面"/>}</div></Modal>
    <Modal open={!!copyCommand} title="会话恢复口令" onClose={() => setCopyCommand('')}><p className="field-hint">复制口令，在 agent 会话中继续处理。</p><textarea className="command-text" readOnly value={copyCommand} rows={5} autoFocus onFocus={event => event.target.select()}/></Modal>
    <Modal open={narrowSessions && sessionDrawer} title="白板会话" className="session-drawer" onClose={() => setSessionDrawer(false)}>{sessionList}</Modal>
    <Modal open={narrowPanel && panelDrawer} title="需求与队列" className="panel-drawer" onClose={() => setPanelDrawer(false)}>{panel}</Modal>
  </div>;
}
