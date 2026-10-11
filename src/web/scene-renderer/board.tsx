import { randomId } from '../random-id.js';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { AnnotationCaptureInput, AnnotationInput, Asset, BaseSceneSnapshot, BoardObject, CaptureView, Draft, SessionView } from '../../shared/types.js';
import { RequestError, type BoardApi } from '../api.js';
import { contentCapabilities, resolveContentKind } from '../../shared/content-types.js';
import { createProjectCaptureProvider, type ProjectCaptureCoordinator } from '../project-capture-provider.js';
import { SceneRenderer, boundsToCSS, sceneCrop, type Immutable, type SceneBounds, type SceneEvidence, type SceneInput, type SceneLayer, type SceneMark, type ScenePresentation, type ScenePrimitive, type SceneSize } from './index.js';
import { annotationCaptureCrop } from './capture-crop.js';
import { annotationBubbleTail } from '../annotation-note-layout.js';
import { SceneContentFrame, type SceneContentFrameInput, type SceneContentMetadata, type SceneContentRegistry } from './content.js';

export interface ProjectSceneSource { provider: ProjectCaptureCoordinator; view?: CaptureView; connectingView?: CaptureView; snapshot?: BaseSceneSnapshot }
export function useProjectScene(api: BoardApi, sessionId: string, objects: BoardObject[], saveDraft: (draft: Draft) => Promise<Draft>, onError: (cause: unknown) => void, serviceInstance: string) {
  const documentId = useRef(randomId()).current;
  const transport = useMemo(() => new Proxy(api, { get(target, key) { if (key === 'saveDraft') return saveDraft; const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value; } }), [api, saveDraft]);
  const [source, setSource] = useState<ProjectSceneSource>();
  const [connectionGeneration, setConnectionGeneration] = useState(0);
  const currentScope = useRef({ sessionId, serviceInstance }); currentScope.current = { sessionId, serviceInstance };
  const currentSource = useRef(source); currentSource.current = source;
  const retirement = useRef<Promise<void>>(Promise.resolve());
  const objectVersions = JSON.stringify(objects.map(object => [object.id, object.assetId, object.version]));
  useEffect(() => {
    if (!sessionId) { setSource(undefined); return; }
    const provider = createProjectCaptureProvider(transport, { sessionId, documentId }); let active = true;
    const pagehide = (event: PageTransitionEvent) => {
      if (event.persisted) return;
      active = false;
      retirement.current = Promise.all([retirement.current, provider.close({ keepalive: true }).catch(() => undefined)]).then(() => undefined);
    };
    window.addEventListener('pagehide', pagehide);
    setSource({ provider });
    void retirement.current.then(async () => {
      if (!active) return;
      const view = await provider.ready(); if (active) setSource({ provider, connectingView: view });
    }).catch(cause => { if (active) onError(cause); });
    return () => { active = false; window.removeEventListener('pagehide', pagehide); retirement.current = Promise.all([retirement.current, provider.close().catch(() => undefined)]).then(() => undefined); };
  }, [transport, sessionId, serviceInstance, connectionGeneration]);
  const watchedView = source?.view || source?.connectingView;
  useEffect(() => {
    const view = watchedView, provider = source?.provider;
    if (!view || !provider || view.sessionId !== sessionId) return;
    let active = true, timer = 0, retryDelay = 500; const controller = new AbortController(), service = serviceInstance;
    const stop = () => { active = false; controller.abort(); window.clearTimeout(timer); };
    const ownsView = () => {
      const current = currentSource.current, identity = current?.view || current?.connectingView;
      return active && !controller.signal.aborted && currentScope.current.sessionId === view.sessionId && currentScope.current.serviceInstance === service && current?.provider === provider && identity?.viewId === view.viewId && identity.viewGeneration === view.viewGeneration;
    };
    const pagehide = (event: PageTransitionEvent) => { if (!event.persisted) stop(); };
    const connect = async () => {
      try { await api.watchCaptureView(view, controller.signal, () => { retryDelay = 500; if (ownsView()) setSource(current => current?.provider === provider && current.view !== view ? { provider, view } : current); }); }
      catch (cause) {
        if (!ownsView()) return;
        if (cause instanceof RequestError && ['scene_view_closed', 'scene_view_conflict'].includes(cause.code)) {
          stop(); setConnectionGeneration(value => value + 1);
          return;
        }
        if (cause instanceof RequestError && cause.status >= 400 && cause.status < 500) {
          stop(); onError(cause);
          return;
        }
      }
      if (ownsView()) { timer = window.setTimeout(() => void connect(), retryDelay); retryDelay = Math.min(5000, retryDelay * 2); }
    };
    window.addEventListener('pagehide', pagehide); void connect();
    return () => { stop(); window.removeEventListener('pagehide', pagehide); };
  }, [api, watchedView, sessionId, serviceInstance]);
  useEffect(() => {
    if (!source?.view) return; let active = true;
    void source.provider.sceneSnapshot().then(snapshot => { if (active) setSource(current => current?.provider === source.provider ? { ...current, snapshot } : current); }).catch(onError);
    return () => { active = false; };
  }, [source?.view, objectVersions]);
  return source?.provider.sessionId === sessionId ? source : undefined;
}

export interface BoardSceneOutline { bounds: SceneBounds; point: boolean; dashed: boolean }
export interface BoardSceneMark { annotationId: string; pin: { x: number; y: number }; number: number; anchor?: 'center' | 'tail' }
export interface BoardSceneFreeze {
  board: HTMLElement;
  registry: SceneContentRegistry;
  view: CaptureView;
  snapshot: BaseSceneSnapshot;
  /** Displayed objects in layer order; their identities come from the displayed snapshot. */
  objects: BoardObject[];
  assets: Asset[];
  camera: SessionView;
  contentBounds: (object: BoardObject) => SceneBounds;
  annotations: AnnotationInput[];
  outlines: BoardSceneOutline[];
  editingBounds?: SceneBounds;
  selection?: SceneBounds | null;
  guides: { axis: 'x' | 'y'; position: number; start: number; end: number }[];
  marks: BoardSceneMark[];
  target: { annotation: AnnotationInput; worldBounds: SceneBounds };
  clip: SceneBounds;
  onCaptureError: (cause: unknown, asset?: Asset) => void;
}
export interface FrozenBoardScene {
  view: CaptureView;
  snapshot: BaseSceneSnapshot;
  scene: Omit<SceneInput, 'frameSeq' | 'baseSceneId'>;
  bitmap: SceneSize;
  requestedCrop: SceneBounds;
  clip: SceneBounds;
  worldBounds: SceneBounds;
  sources: Map<string, Immutable<SceneContentMetadata>>;
}

const fontFamily = '"Google Sans",-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif';
const inset = (bounds: SceneBounds, by: number): SceneBounds => ({ x: bounds.x + by, y: bounds.y + by, width: bounds.width - by * 2, height: bounds.height - by * 2 });
const overlaps = (a: SceneBounds, b: SceneBounds) => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
function withAlpha(color: string, alpha: number) {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color)?.[1]; if (!hex) return color;
  const digits = hex.length === 3 ? [...hex].map(value => value + value) : [hex.slice(0, 2), hex.slice(2, 4), hex.slice(4, 6)];
  return `rgba(${digits.map(value => Number.parseInt(value, 16)).join(',')},${alpha})`;
}
function scenePalette() {
  const style = getComputedStyle(document.documentElement), value = (name: string) => style.getPropertyValue(name).trim(), dark = document.documentElement.dataset.theme === 'dark';
  return { canvas: value('--canvas'), surface: value('--surface'), ink: value('--ink'), muted: value('--muted'), edge: value('--edge'), annotation: value('--annotation'), annotationFill: value('--annotation-fill'), annotationPin: value('--annotation-pin'), annotationInk: value('--annotation-ink'), shadow: dark ? { color: '#0002', y: 12, blur: 32 } : { color: '#20202008', y: 8, blur: 32 } };
}

/** Done reads the displayed scene once, synchronously: geometry, theme, marks, comment summaries and producer pixels. */
export function freezeBoardScene(input: BoardSceneFreeze): FrozenBoardScene {
  const board = input.board, rect = board.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) throw new Error('The visible scene is still loading. Complete the annotation when it is ready.');
  const cssScale = rect.width / Math.max(1, board.clientWidth), zoom = input.camera.zoom, camera = { x: input.camera.x * cssScale, y: input.camera.y * cssScale, zoom: zoom * cssScale };
  const cssViewport = { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  const pixelRatio = Math.min(devicePixelRatio, Math.sqrt(16_000_000 / (rect.width * rect.height)));
  const bitmap = { width: Math.max(1, Math.floor(rect.width * pixelRatio)), height: Math.max(1, Math.floor(rect.height * pixelRatio)) };
  const palette = scenePalette(), measure = document.createElement('canvas').getContext('2d')!, family = getComputedStyle(board).fontFamily || fontFamily;
  // DOM text baselines land on device pixels, and line boxes floor their half-leading.
  const deviceRatio = bitmap.height / cssViewport.height, baseline = (y: number) => (Math.round((y * camera.zoom + camera.y) * deviceRatio) / deviceRatio - camera.y) / camera.zoom;
  const line = (font: string, text: string) => { measure.font = font; const metrics = measure.measureText(text); return { width: metrics.width, ascent: metrics.fontBoundingBoxAscent, height: metrics.fontBoundingBoxAscent + metrics.fontBoundingBoxDescent }; };
  /** Mirrors .object-caption: a 22px flex row 10px below the object with a padded index badge, a 7px gap, the ellipsized name and the Output label. */
  const caption = (object: BoardObject, index: number, name: string): ScenePrimitive[] => {
    const top = object.y + object.height + 10, small = `8px ${family}`, label = String(index + 1).padStart(2, '0'), badge = line(small, label), title = line(`10px ${family}`, name), output = object.sourceTaskId ? line(small, 'Output') : undefined;
    const height = Math.max(22, badge.height + 6, title.height, (output?.height ?? 0) + 6), badgeWidth = badge.width + 8, outputWidth = output ? output.width + 10 : 0;
    const primitives: ScenePrimitive[] = [{ kind: 'rect', bounds: { x: object.x, y: top + (height - badge.height - 6) / 2, width: badgeWidth, height: badge.height + 6 }, fill: palette.surface, radius: 3 },
      { kind: 'text', x: object.x + 4, y: baseline(top + (height - badge.height - 6) / 2 + 3 + badge.ascent), text: label, font: small, fill: palette.muted },
      { kind: 'text', x: object.x + badgeWidth + 7, y: baseline(top + (height - title.height) / 2 + title.ascent), text: name, font: `10px ${family}`, fill: palette.muted, maxWidth: Math.max(1, object.width - badgeWidth - 7 - (output ? outputWidth + 7 : 0)), ellipsis: true }];
    if (output) primitives.push({ kind: 'rect', bounds: { x: object.x + object.width - outputWidth, y: top + (height - output.height - 6) / 2, width: outputWidth, height: output.height + 6 }, fill: palette.surface, radius: 3 }, { kind: 'text', x: object.x + object.width - outputWidth + 5, y: baseline(top + (height - output.height - 6) / 2 + 3 + output.ascent), text: 'Output', font: small, fill: palette.ink });
    return primitives;
  };
  const placed = input.objects.map((object, index) => { const worldBounds = { x: object.x - 40, y: object.y - 40, width: object.width + 80, height: object.height + 92 }; return { object, index, worldBounds, renderedBounds: boundsToCSS(worldBounds, camera, cssViewport) }; });
  const markerSize = 28 * cssScale, marker = input.marks.find(mark => mark.annotationId === input.target.annotation.id), origin = marker?.anchor === 'tail' ? annotationBubbleTail(markerSize) : { x: markerSize / 2, y: markerSize / 2 };
  const markerCSS = marker && { x: cssViewport.x + marker.pin.x * camera.zoom + camera.x - origin.x, y: cssViewport.y + marker.pin.y * camera.zoom + camera.y - origin.y, width: markerSize, height: markerSize };
  const requestedCrop = annotationCaptureCrop({ presentation: { camera, cssViewport, layers: placed.map(value => ({ objectId: value.object.id, renderedBounds: value.renderedBounds })) }, worldBounds: input.target.worldBounds, objectId: input.target.annotation.objectId, markerCSS });
  const crop = sceneCrop(cssViewport, bitmap, requestedCrop, input.clip).cropCSS;
  const targets = new Set([input.target.annotation.objectId, ...input.target.annotation.objectIds].filter((id): id is string => !!id));
  const layers: SceneLayer[] = [], media: SceneInput['media'] = [], sources = new Map<string, Immutable<SceneContentMetadata>>(), handles: ScenePrimitive[] = [];
  for (const { object, index, worldBounds, renderedBounds } of placed) {
    const bounds = { x: object.x, y: object.y, width: object.width, height: object.height }, content = input.contentBounds(object);
    const layer: SceneLayer = { objectId: object.id, assetId: object.assetId, objectVersion: object.version, worldBounds, contentWorldBounds: content, layer: index, primitives: [] };
    layers.push(layer);
    if (!targets.has(object.id) && !overlaps(renderedBounds, crop)) continue;
    const asset = input.assets.find(value => value.id === object.assetId), kind = resolveContentKind(asset), selected = input.camera.selectedObjectIds.includes(object.id), radius = kind === 'audio' ? 22 : 0;
    const frame = input.registry.capture(object.id, cause => input.onCaptureError(cause, asset)), primitives = layer.primitives;
    primitives.push({ kind: 'rect', bounds, fill: kind === 'video' ? '#161616' : palette.surface, radius, shadow: palette.shadow });
    if (frame) {
      sources.set(object.id, frame.metadata);
      if (frame.metadata.contentAnchor) layer.contentAnchor = structuredClone(frame.metadata.contentAnchor) as SceneLayer['contentAnchor'];
      primitives.push({ kind: 'texture', bounds: frame.metadata.fit === 'contain' ? content : bounds, texture: frame, radius });
      if (frame.metadata.media) {
        const annotation = input.annotations.find(value => value.objectId === object.id);
        media.push({ objectId: object.id, ...frame.metadata.media, ...(annotation?.timeStart === undefined ? {} : annotation.timeEnd === undefined ? { selectedTime: annotation.timeStart } : { selectedRange: { start: annotation.timeStart, end: annotation.timeEnd } }), ...(annotation?.snapshotAssetId && annotation.timeStart !== undefined ? { representativeTime: annotation.timeStart } : {}) });
      }
    } else primitives.push({ kind: 'text', x: bounds.x + 16, y: bounds.y + Math.min(32, bounds.height / 2), text: 'Loading preview…', font: `11px ${fontFamily}`, fill: palette.muted, maxWidth: Math.max(1, bounds.width - 32) });
    primitives.push(...caption(object, index, asset?.name || 'File'));
    // CSS outlines lie outside the border box.
    if (selected || kind !== 'audio') { const width = selected ? 2 : 1; primitives.push({ kind: 'rect', bounds: inset(bounds, -width / 2), fill: 'transparent', radius: radius && radius + width / 2, stroke: selected ? palette.ink : withAlpha(palette.edge, .65), lineWidth: width }); }
    if (selected) for (const [x, y] of contentCapabilities[kind].freeResize ? [[0, 0], [.5, 0], [1, 0], [1, .5], [1, 1], [.5, 1], [0, 1], [0, .5]] : [[0, 0], [1, 0], [1, 1], [0, 1]]) handles.push({ kind: 'rect', bounds: { x: bounds.x + x * bounds.width - 4.5, y: bounds.y + y * bounds.height - 4.5, width: 9, height: 9 }, fill: palette.surface, stroke: palette.ink, lineWidth: 2 });
  }
  const overlays: ScenePrimitive[] = [];
  if (input.selection && input.selection.width > 0 && input.selection.height > 0) overlays.push({ kind: 'rect', bounds: inset(input.selection, .5), fill: withAlpha(palette.ink, .07), stroke: palette.ink, lineWidth: 1 });
  for (const outline of [...input.outlines, ...(input.editingBounds ? [{ bounds: input.editingBounds, point: false, dashed: false }] : [])]) {
    if (outline.point) overlays.push({ kind: 'ellipse', bounds: inset({ x: outline.bounds.x - 10 / zoom, y: outline.bounds.y - 10 / zoom, width: 20 / zoom, height: 20 / zoom }, 1), fill: palette.annotationFill, stroke: palette.annotation, lineWidth: 2, ...(outline.dashed ? { dash: [6, 6] } : {}) });
    else overlays.push({ kind: 'rect', bounds: inset(outline.bounds, .5), fill: palette.annotationFill, stroke: palette.annotation, lineWidth: 1, ...(outline.dashed ? { dash: [3, 3] } : {}) });
  }
  for (const guide of input.guides) overlays.push({ kind: 'line', points: guide.axis === 'x' ? [{ x: guide.position, y: guide.start }, { x: guide.position, y: guide.end }] : [{ x: guide.start, y: guide.position }, { x: guide.end, y: guide.position }], stroke: withAlpha(palette.muted, .65), lineWidth: 1 / zoom });
  overlays.push(...handles);
  const toWorld = (x: number, y: number) => ({ x: (x - cssViewport.x - camera.x) / camera.zoom, y: (y - cssViewport.y - camera.y) / camera.zoom });
  for (const note of board.querySelectorAll<HTMLElement>('.canvas-annotation-comment[data-comment-mode="display"]')) {
    const button = note.querySelector<HTMLElement>('.canvas-annotation-summary'), style = getComputedStyle(note);
    if (!button || style.visibility !== 'visible') continue;
    const area = note.getBoundingClientRect(), textArea = button.getBoundingClientRect(), textStyle = getComputedStyle(button);
    if (area.width <= 0 || area.height <= 0 || !overlaps(area, crop)) continue;
    const position = toWorld(area.x, area.y), textPosition = toWorld(textArea.x, textArea.y), fontSize = Number.parseFloat(textStyle.fontSize), lineHeight = Number.parseFloat(textStyle.lineHeight);
    measure.font = `${textStyle.fontWeight} ${textStyle.fontSize} ${textStyle.fontFamily}`;
    const metrics = measure.measureText(button.textContent || ''), ascent = metrics.fontBoundingBoxAscent || fontSize * .8, descent = metrics.fontBoundingBoxDescent || fontSize * .2;
    overlays.push({ kind: 'rect', bounds: { ...position, width: area.width / camera.zoom, height: area.height / camera.zoom }, fill: style.backgroundColor, radius: Number.parseFloat(style.borderRadius) * cssScale / camera.zoom },
      { kind: 'text', x: textPosition.x, y: baseline(textPosition.y + (Math.floor((lineHeight - ascent - descent) / 2) + ascent) * cssScale / camera.zoom), text: button.textContent || '', font: `${textStyle.fontWeight} ${fontSize * cssScale / camera.zoom}px ${textStyle.fontFamily}`, fill: textStyle.color, maxWidth: textArea.width / camera.zoom, ellipsis: true });
  }
  const marks: SceneMark[] = input.marks.map(mark => ({ x: mark.pin.x, y: mark.pin.y, number: mark.number, fill: palette.annotationPin, stroke: palette.annotation, textFill: palette.annotationInk, style: 'bubble', size: markerSize, anchor: mark.anchor }));
  return { view: input.view, snapshot: input.snapshot, bitmap, requestedCrop, clip: input.clip, worldBounds: { ...input.target.worldBounds }, sources,
    scene: { documentId: input.view.documentId, viewId: input.view.viewId, camera, cssViewport, background: palette.canvas, layers, media, overlays, marks } };
}

/** Replaces HTML frames that finished after the synchronous copy, including a block that was still loading. */
export function replaceFrozenFrames(frozen: FrozenBoardScene, updates: ReadonlyMap<string, SceneContentFrameInput>) {
  for (const [id, input] of updates) {
    let frame: SceneContentFrame;
    try { frame = new SceneContentFrame(document, input); } catch { continue; }
    frozen.sources.set(id, frame.metadata);
    const layer = frozen.scene.layers.find(value => value.objectId === id); if (!layer) continue;
    const existing = layer.primitives.find(value => value.kind === 'texture');
    if (existing?.kind === 'texture') { existing.texture = frame; continue; }
    const bounds = layer.contentWorldBounds || { x: layer.worldBounds.x + 40, y: layer.worldBounds.y + 40, width: layer.worldBounds.width - 80, height: layer.worldBounds.height - 92 };
    const placeholder = layer.primitives.findIndex(value => value.kind === 'text' && value.text === 'Loading preview…');
    const texture: ScenePrimitive = { kind: 'texture', bounds, texture: frame };
    if (placeholder >= 0) layer.primitives.splice(placeholder, 1, texture); else layer.primitives.splice(1, 0, texture);
  }
}

/** A base scene can carry the frozen layers when it belongs to the same view and holds every frozen object at its frozen version. */
export function frozenSceneMatches(frozen: FrozenBoardScene, snapshot: BaseSceneSnapshot) {
  return snapshot.view.viewId === frozen.view.viewId && snapshot.view.viewGeneration === frozen.view.viewGeneration && frozen.scene.layers.every(layer => {
    const object = snapshot.objects.find(value => value.id === layer.objectId);
    return !!object && object.version === layer.objectVersion && object.assetId === layer.assetId;
  });
}

/** One offscreen renderer per capture view; frame sequences keep increasing across Done operations and page lifetimes. */
export class SceneEvidenceRenderer {
  private current?: { key: string; renderer: SceneRenderer; last: number };
  render(frozen: FrozenBoardScene, snapshot: BaseSceneSnapshot): SceneEvidence {
    const key = `${frozen.view.viewId}:${frozen.view.viewGeneration}`;
    if (this.current?.key !== key) { const canvas = document.createElement('canvas'); canvas.className = 'scene-evidence-canvas'; this.current = { key, renderer: new SceneRenderer(canvas, { documentId: frozen.view.documentId, viewId: frozen.view.viewId }), last: 0 }; }
    const frameSeq = Math.max(this.current.last + 1, Date.now()); this.current.last = frameSeq;
    return this.current.renderer.renderEvidence({ ...frozen.scene, baseSceneId: snapshot.id, frameSeq }, frozen.bitmap, frozen.requestedCrop, frozen.clip);
  }
}

/** Reference metadata follows the presented layout and remains bounded separately from complete pixels. */
export function presentedCaptureScene(presentation: Immutable<ScenePresentation>, snapshot: BaseSceneSnapshot, cropCSS: SceneBounds, annotation: AnnotationInput, sources?: Map<string, Immutable<SceneContentMetadata>>, targetAssets: Asset[] = []): AnnotationCaptureInput['scene'] {
  const entries = presentation.layers.flatMap(layer => {
    const object = snapshot.objects.find(value => value.id === layer.objectId); if (!object) return [];
    const intersects = layer.renderedBounds.x < cropCSS.x + cropCSS.width && layer.renderedBounds.x + layer.renderedBounds.width > cropCSS.x && layer.renderedBounds.y < cropCSS.y + cropCSS.height && layer.renderedBounds.y + layer.renderedBounds.height > cropCSS.y;
    if (!intersects && !annotation.objectIds.includes(object.id) && annotation.objectId !== object.id) return [];
    const media = presentation.media.find(value => value.objectId === object.id);
    const position = media && { playbackTime: media.playbackTime, presentedTime: media.presentedTime, representativeTime: media.representativeTime, timePrecision: media.timePrecision, frameIndex: media.frameIndex }, scroll = layer.contentAnchor?.scroll ?? sources?.get(object.id)?.scroll;
    return [{ object, renderedBounds: { ...layer.worldBounds }, layer: layer.layer, ...(position ? { media: position } : {}), ...(scroll ? { scroll: { ...scroll } } : {}), ...(layer.contentAnchor ? { contentAnchor: structuredClone(layer.contentAnchor) } : {}) }];
  });
  const selected = entries.filter(value => annotation.objectIds.includes(value.object.id) || annotation.objectId === value.object.id);
  const objects = [...selected, ...entries.filter(value => !selected.includes(value))].slice(0, 64).sort((a, b) => a.layer - b.layer);
  const ids = new Set(objects.map(value => value.object.assetId)); if (annotation.assetId) ids.add(annotation.assetId); if (annotation.snapshotAssetId) ids.add(annotation.snapshotAssetId);
  const available = [...snapshot.assets, ...targetAssets.filter(asset => !snapshot.assets.some(value => value.id === asset.id))];
  for (const id of [...ids]) for (const resource of Object.values(available.find(asset => asset.id === id)?.htmlBundle?.files || {})) ids.add(resource);
  const assets = available.filter(asset => ids.has(asset.id));
  if (assets.length !== ids.size) throw new Error('The annotation scene assets are still loading.');
  return { objects, assets, omittedCount: entries.length - objects.length };
}
