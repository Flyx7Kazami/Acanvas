import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import type { AnnotationCaptureInput, AnnotationInput, Asset, BaseSceneSnapshot, BoardObject, CaptureView, Draft, SessionView } from '../../shared/types.js';
import type { BoardApi } from '../api.js';
import { contentCapabilities, resolveContentKind } from '../../shared/content-types.js';
import { createProjectCaptureProvider, type ProjectCaptureCoordinator } from '../project-capture-provider.js';
import { SceneFrame, SceneRenderer, type Immutable, type SceneBounds, type SceneInput, type SceneLayer, type ScenePresentation, type ScenePrimitive } from './index.js';
import { SceneContentRegistry, type SceneContentMetadata } from './content.js';

export interface ProjectSceneSource { provider: ProjectCaptureCoordinator; view?: CaptureView; snapshot?: BaseSceneSnapshot }
export function useProjectScene(api: BoardApi, sessionId: string, objects: BoardObject[], saveDraft: (draft: Draft) => Promise<Draft>, onError: (cause: unknown) => void, serviceInstance: string) {
  const documentId = useRef(crypto.randomUUID()).current;
  const transport = useMemo(() => new Proxy(api, { get(target, key) { if (key === 'saveDraft') return saveDraft; const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value; } }), [api, saveDraft]);
  const [source, setSource] = useState<ProjectSceneSource>();
  const retirement = useRef<Promise<void>>(Promise.resolve());
  const objectVersions = JSON.stringify(objects.map(object => [object.id, object.assetId, object.version]));
  useEffect(() => {
    if (!sessionId) { setSource(undefined); return; }
    const provider = createProjectCaptureProvider(transport, { sessionId, documentId }); let active = true;
    setSource({ provider });
    void retirement.current.then(async () => {
      if (!active) return;
      const view = await provider.ready(); if (active) setSource({ provider, view });
    }).catch(cause => { if (active) onError(cause); });
    return () => { active = false; retirement.current = Promise.all([retirement.current, provider.close().catch(() => undefined)]).then(() => undefined); };
  }, [transport, sessionId, serviceInstance]);
  useEffect(() => {
    if (!source?.view) return; let active = true;
    void source.provider.sceneSnapshot().then(snapshot => { if (active) setSource(current => current?.provider === source.provider ? { ...current, snapshot } : current); }).catch(onError);
    return () => { active = false; };
  }, [source?.view, objectVersions]);
  return source?.provider.sessionId === sessionId ? source : undefined;
}

export interface BoardSceneMark { annotation: AnnotationInput; bounds: SceneBounds; number: number }
export interface BoardSceneInput {
  canvas: RefObject<HTMLCanvasElement | null>;
  board: RefObject<HTMLElement | null>;
  registry: SceneContentRegistry;
  source?: ProjectSceneSource;
  objects: BoardObject[];
  assets: Asset[];
  view: SessionView;
  marks: BoardSceneMark[];
  editingBounds?: SceneBounds;
  selection?: SceneBounds | null;
  guides: { axis: 'x' | 'y'; position: number; start: number; end: number }[];
  theme: 'light' | 'dark';
  onError: (cause: unknown) => void;
}
const fontFamily = '"Google Sans",-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif';
function contain(bounds: SceneBounds, size: { width: number; height: number }): SceneBounds {
  const scale = Math.min(bounds.width / size.width, bounds.height / size.height), width = size.width * scale, height = size.height * scale;
  return { x: bounds.x + (bounds.width - width) / 2, y: bounds.y + (bounds.height - height) / 2, width, height };
}

/** All visible evidence layers are drawn here; semantic controls remain owned by React. */
export function useBoardScene(input: BoardSceneInput) {
  const renderer = useRef<SceneRenderer | undefined>(undefined);
  const latest = useRef(input);
  useLayoutEffect(() => { latest.current = input; });
  const seq = useRef(0), renderNow = useRef<() => void>(() => {});
  const presentation = useRef<Immutable<ScenePresentation> | undefined>(undefined);
  const layout = useRef<{ objects: BoardObject[]; contentBounds: Map<string, SceneBounds>; snapshot: BaseSceneSnapshot; sources: Map<string, Immutable<SceneContentMetadata>> } | undefined>(undefined);
  useLayoutEffect(() => {
    const element = input.canvas.current, source = input.source;
    if (!element || !source?.view) { renderer.current = undefined; presentation.current = undefined; layout.current = undefined; return; }
    const identity = source.view;
    renderer.current = new SceneRenderer(element, { documentId: identity.documentId, viewId: identity.viewId }); seq.current = 0;
    let active = true, confirming = false, queued: Immutable<ScenePresentation> | undefined;
    let markerAnimation = 0, alignMarkers = () => {};
    const confirmLatest = (value: Immutable<ScenePresentation>) => {
      queued = value;
      const send = () => {
        if (confirming || !active || !queued) return;
        const paired = queued; queued = undefined; confirming = true;
        void source.provider.confirmPresentation(paired).catch(cause => { if (active) latest.current.onError(cause); }).finally(() => { confirming = false; send(); });
      };
      send();
    };
    const render = () => {
      const current = latest.current, board = current.board.current, display = current.canvas.current, base = current.source?.snapshot;
      if (!board || !display || !base || current.source?.view?.viewId !== identity.viewId) return;
      const rect = display.getBoundingClientRect(); if (rect.width <= 0 || rect.height <= 0) return;
      const cssScale = rect.width / Math.max(1, board.clientWidth), camera = { x: current.view.x * cssScale, y: current.view.y * cssScale, zoom: current.view.zoom * cssScale };
      const cssViewport = { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      const pixelRatio = Math.min(devicePixelRatio, Math.sqrt(16_000_000 / (rect.width * rect.height)));
      const bitmap = { width: Math.max(1, Math.floor(rect.width * pixelRatio)), height: Math.max(1, Math.floor(rect.height * pixelRatio)) };
      const palette = current.theme === 'dark' ? { canvas: '#111', surface: '#222', ink: '#f3f3f3', muted: '#aaa', edge: '#3a3a3a', annotation: '#9ed0ff', annotationFill: 'rgba(158,208,255,.14)' }
        : { canvas: '#fcfcfa', surface: '#fff', ink: '#202020', muted: '#707070', edge: '#dedede', annotation: '#7bbcff', annotationFill: 'rgba(123,188,255,.12)' };
      const layers: SceneLayer[] = [], media: SceneInput['media'] = [], contentBounds = new Map<string, SceneBounds>(), sources = new Map<string, Immutable<SceneContentMetadata>>();
      for (const [index, object] of current.objects.entries()) {
        const asset = current.assets.find(value => value.id === object.assetId), frame = current.registry.get(object.id), selected = current.view.selectedObjectIds.includes(object.id);
        const bounds = { x: object.x, y: object.y, width: object.width, height: object.height };
        const kind = resolveContentKind(asset);
        const actualContentBounds = frame?.metadata.contentBounds ? { x: bounds.x + frame.metadata.contentBounds.x, y: bounds.y + frame.metadata.contentBounds.y, width: frame.metadata.contentBounds.width, height: frame.metadata.contentBounds.height } : frame?.metadata.fit === 'contain' ? contain(bounds, frame.metadata.bitmap) : bounds;
        contentBounds.set(object.id, actualContentBounds);
        const primitives: ScenePrimitive[] = [{ kind: 'rect', bounds, fill: kind === 'video' ? '#161616' : palette.surface, radius: kind === 'audio' ? 22 : 0, shadow: { color: current.theme === 'dark' ? '#0002' : '#20202008', y: current.theme === 'dark' ? 12 : 8, blur: 32 } }];
        if (frame) {
          sources.set(object.id, frame.metadata);
          primitives.push({ kind: 'texture', bounds: frame.metadata.fit === 'contain' ? contain(bounds, frame.metadata.bitmap) : bounds, texture: frame, radius: kind === 'audio' ? 22 : 0 });
          if (frame.metadata.media) {
            const annotation = current.marks.find(mark => mark.annotation.objectId === object.id)?.annotation;
            media.push({ objectId: object.id, ...frame.metadata.media, ...(annotation?.timeStart === undefined ? {} : annotation.timeEnd === undefined ? { selectedTime: annotation.timeStart } : { selectedRange: { start: annotation.timeStart, end: annotation.timeEnd } }), ...(annotation?.snapshotAssetId && annotation.timeStart !== undefined ? { representativeTime: annotation.timeStart } : {}) });
          }
        } else {
          primitives.push({ kind: 'text', x: bounds.x + 16, y: bounds.y + Math.min(32, bounds.height / 2), text: 'Loading preview…', font: `11px ${fontFamily}`, fill: palette.muted, maxWidth: Math.max(1, bounds.width - 32) });
        }
        // Captions use the same object order and fonts as their native hit areas.
        primitives.push({ kind: 'rect', bounds: { x: object.x, y: object.y + object.height + 12, width: 19, height: 16 }, fill: palette.surface, radius: 3 },
          { kind: 'text', x: object.x + 4, y: object.y + object.height + 23, text: String(index + 1).padStart(2, '0'), font: `8px ${fontFamily}`, fill: palette.muted },
          { kind: 'text', x: object.x + 26, y: object.y + object.height + 24, text: asset?.name || 'File', font: `10px ${fontFamily}`, fill: palette.muted, maxWidth: Math.max(1, object.width - 28 - (object.sourceTaskId ? 43 : 0)), ellipsis: true });
        if (object.sourceTaskId) primitives.push({ kind: 'rect', bounds: { x: object.x + object.width - 40, y: object.y + object.height + 12, width: 40, height: 16 }, fill: palette.surface, radius: 3 }, { kind: 'text', x: object.x + object.width - 35, y: object.y + object.height + 23, text: 'Output', font: `8px ${fontFamily}`, fill: palette.ink });
        if (selected || kind !== 'audio') primitives.push({ kind: 'rect', bounds, fill: 'transparent', radius: kind === 'audio' ? 22 : 0, stroke: selected ? palette.ink : palette.edge, lineWidth: selected ? 2 : 1 });
        if (selected) {
          const positions = contentCapabilities[kind].freeResize ? [[0, 0], [.5, 0], [1, 0], [1, .5], [1, 1], [.5, 1], [0, 1], [0, .5]] : [[0, 0], [1, 0], [1, 1], [0, 1]];
          for (const [x, y] of positions) primitives.push({ kind: 'rect', bounds: { x: bounds.x + x * bounds.width - 5.5, y: bounds.y + y * bounds.height - 5.5, width: 11, height: 11 }, fill: palette.surface, stroke: palette.ink, lineWidth: 2 });
        }
        const semantic = board.querySelector<HTMLElement>('[data-object-id="' + CSS.escape(object.id) + '"]');
        if (semantic && semantic === document.activeElement && semantic.matches(':focus-visible')) primitives.push({ kind: 'rect', bounds: { x: bounds.x - 5, y: bounds.y - 5, width: bounds.width + 10, height: bounds.height + 10 }, fill: 'transparent', radius: kind === 'audio' ? 27 : 0, stroke: palette.ink, lineWidth: 2 });
        layers.push({ objectId: object.id, assetId: object.assetId, objectVersion: object.version, worldBounds: { x: object.x - 40, y: object.y - 40, width: object.width + 80, height: object.height + 92 }, contentWorldBounds: actualContentBounds, layer: index,
          surface: frame?.metadata.surface ? structuredClone(frame.metadata.surface) : undefined, contentAnchor: frame?.metadata.contentAnchor ? structuredClone(frame.metadata.contentAnchor) : undefined, primitives });
      }
      const overlays: ScenePrimitive[] = [];
      const drawnMarks = current.marks.map(mark => {
        const content = mark.annotation.objectId ? contentBounds.get(mark.annotation.objectId) : undefined, normalized = mark.annotation.bounds;
        return content && mark.annotation.coordinateSpace === 'normalized' ? { ...mark, bounds: { x: content.x + normalized.x * content.width, y: content.y + normalized.y * content.height, width: normalized.width * content.width, height: normalized.height * content.height } } : mark;
      });
      for (const mark of drawnMarks) {
        if (mark.annotation.geometry !== 'point') overlays.push({ kind: 'rect', bounds: mark.bounds, fill: palette.annotationFill, stroke: palette.annotation, lineWidth: 1 / current.view.zoom });
      }
      for (const bounds of [current.selection, current.editingBounds].filter((value): value is SceneBounds => !!value && value.width > 0 && value.height > 0 && !drawnMarks.some(mark => mark.bounds.x === value.x && mark.bounds.y === value.y && mark.bounds.width === value.width && mark.bounds.height === value.height))) overlays.push({ kind: 'rect', bounds, fill: palette.annotationFill, stroke: palette.annotation, lineWidth: 1 / current.view.zoom });
      for (const guide of current.guides) overlays.push({ kind: 'line', points: guide.axis === 'x' ? [{ x: guide.position, y: guide.start }, { x: guide.position, y: guide.end }] : [{ x: guide.start, y: guide.position }, { x: guide.end, y: guide.position }], stroke: palette.muted, lineWidth: 1 / current.view.zoom });
      const scene: SceneInput = { documentId: identity.documentId, viewId: identity.viewId, baseSceneId: base.id, frameSeq: ++seq.current, camera, cssViewport, background: palette.canvas, layers, media,
        overlays,
        marks: drawnMarks.map((mark, index) => {
          const preceding = mark.annotation.geometry === 'point' ? 0 : drawnMarks.slice(0, index).filter(value => value.annotation.geometry !== 'point' && value.bounds.x === mark.bounds.x && value.bounds.y === mark.bounds.y).length;
          const button = board.querySelector<HTMLElement>('.canvas-annotation-group[data-annotation-id="' + CSS.escape(mark.annotation.id) + '"]>.annotation-pin');
          return { x: mark.bounds.x + (mark.annotation.geometry === 'point' ? 0 : 14 / current.view.zoom), y: mark.bounds.y - (mark.annotation.geometry === 'point' ? 0 : (22 + preceding * 36) / current.view.zoom), number: mark.number, fill: current.theme === 'dark' ? '#b6dfff' : '#c9e5ff', stroke: palette.annotation, textFill: current.theme === 'dark' ? '#163e63' : '#15436c', style: 'bubble' as const, size: 28 * cssScale, focused: button === document.activeElement && !!button?.matches(':focus-visible'), focusColor: palette.ink };
        }) };
      alignMarkers = () => {
        for (const [index, mark] of drawnMarks.entries()) {
          const button = board.querySelector<HTMLElement>('.canvas-annotation-group[data-annotation-id="' + CSS.escape(mark.annotation.id) + '"]>.annotation-pin'); if (!button) continue;
          const pin = scene.marks[index], rect = button.getBoundingClientRect(), style = getComputedStyle(button), matrix = style.transform === 'none' ? new DOMMatrix() : new DOMMatrix(style.transform);
          const left = cssViewport.x + pin.x * camera.zoom + camera.x - (pin.size ?? 28) / 2, top = cssViewport.y + pin.y * camera.zoom + camera.y - (pin.size ?? 28) / 2;
          button.style.transform = 'translate(' + (matrix.m41 + (left - rect.left) / cssScale) + 'px,' + (matrix.m42 + (top - rect.top) / cssScale) + 'px)';
        }
      };
      const animateInputs = () => { markerAnimation = 0; if (!active) return; alignMarkers(); if (Array.from(board.querySelectorAll('.canvas-annotation-group')).some(group => group.getAnimations().length > 0)) markerAnimation = requestAnimationFrame(animateInputs); };
      try { const frame = SceneFrame.render(document, scene, bitmap); renderer.current!.present(frame); presentation.current = frame.presentation; layout.current = { objects: structuredClone(current.objects), contentBounds, snapshot: base, sources }; display.dataset.frameSeq = String(frame.presentation.frameSeq); display.dataset.viewId = identity.viewId; display.dataset.viewGeneration = String(identity.viewGeneration); confirmLatest(frame.presentation); }
      catch (cause) { current.onError(cause); }
      alignMarkers(); if (!markerAnimation) markerAnimation = requestAnimationFrame(animateInputs);
    };
    renderNow.current = render; const unsubscribe = input.registry.subscribe(render);
    const observer = new ResizeObserver(render); observer.observe(element); const resize = () => render(); window.addEventListener('resize', resize);
    input.board.current?.addEventListener('focusin', render); input.board.current?.addEventListener('focusout', render);
    render();
    return () => { active = false; queued = undefined; cancelAnimationFrame(markerAnimation); unsubscribe(); observer.disconnect(); window.removeEventListener('resize', resize); input.board.current?.removeEventListener('focusin', render); input.board.current?.removeEventListener('focusout', render); renderNow.current = () => {}; renderer.current = undefined; presentation.current = undefined; layout.current = undefined; };
  }, [input.source?.view?.viewId, input.registry]);
  useLayoutEffect(() => { renderNow.current(); }, [input.source?.snapshot, input.objects, input.assets, input.view, input.theme, input.marks, input.selection, input.editingBounds, input.guides]);
  return { renderer, presentation, layout };
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
