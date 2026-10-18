import { memo, useLayoutEffect, useMemo, useRef, type KeyboardEvent, type PointerEvent, type RefObject } from 'react';
import type { GroupPresentation } from './group-presentation';
import type { Asset, BoardObject, CaptureView } from '../shared/types';
import { contentCapabilities, resolveContentKind, type NoteFill } from '../shared/content-types';
import type { BoardApi } from './api';
import type { CanvasWheelInput } from './canvas-wheel';
import type { ResizeHandle } from './geometry';
import type { useBoard } from './useBoard';
import { ContentRenderer } from './ContentRenderer';
import { useCanvasRaster } from './CanvasWorld';
import { SceneContentContext, type SceneContentRegistry } from './scene-renderer/content';

export interface CanvasObjectActions {
  board: Pick<ReturnType<typeof useBoard>, 'saveContent' | 'registerContentEditor' | 'setContentDirty' | 'setContentComposing' | 'showError'>;
  keyDown: (object: BoardObject, event: KeyboardEvent<HTMLElement>) => void;
  resize: (object: BoardObject, corner: ResizeHandle, event: KeyboardEvent<HTMLButtonElement>) => void;
  blankPointerDown: (event: PointerEvent<HTMLElement>) => void;
  frameWheel: (event: CanvasWheelInput) => void;
  frameDrag: (objectId: string, frame: HTMLIFrameElement, start: { x: number; y: number }, event: PointerEvent<HTMLElement>) => void;
  activate: (objectId: string) => void;
  reload: () => Promise<void>;
  size: (objectId: string, size: { width: number; height: number }) => void;
  error: (objectId: string) => void;
  media: (objectId: string, kind: string, element: HTMLMediaElement | null) => void;
}

interface CanvasObjectProps {
  presentation: GroupPresentation;
  transitioning: boolean;
  object: BoardObject;
  canonical: BoardObject;
  asset?: Asset;
  api: BoardApi;
  sessionId: string;
  registry: SceneContentRegistry;
  captureView?: CaptureView;
  actions: RefObject<CanvasObjectActions>;
  index: number;
  selected: boolean;
  exterior: boolean;
  departing: boolean;
  arriving: boolean;
  moving: boolean;
  departureX?: number;
  departureY?: number;
  appearance?: { scale: number; opacity: number };
  readOnly: boolean;
  disabled: boolean;
  preserveScene: boolean;
  error?: boolean;
  fill?: NoteFill;
}

/** Camera movement is owned by the world transform; item props describe content and interaction state. */
export const CanvasObject = memo(function CanvasObject({ presentation, transitioning, object, canonical, asset, api, sessionId, registry, captureView, actions, index, selected, exterior, departing, arriving, moving, departureX, departureY, appearance, readOnly, disabled, preserveScene, error, fill }: CanvasObjectProps) {
  const element = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const node = element.current!;
    presentation.update(node, { x: object.x, y: object.y, width: object.width, height: object.height, dx: departing && departureX !== undefined ? departureX + 20 - object.x : 0, dy: departing && departureY !== undefined ? departureY + 16 - object.y : 0, scale: departing ? .22 : appearance?.scale ?? 1, opacity: departing ? 0 : exterior ? presentation.exterior.opacity : appearance?.opacity ?? 1, blur: exterior ? presentation.exterior.blur : 0 }, transitioning, arriving, moving);
  });
  useLayoutEffect(() => { const node = element.current!; return () => presentation.forget(node); }, [presentation]);
  const contentElement = useRef<HTMLDivElement>(null);
  const rasterElement = useRef<HTMLElement>(null);
  const scope = useMemo(() => ({ registry, objectId: object.id, width: object.width, height: object.height, captureView, contentElement }), [registry, object.id, object.width, object.height, captureView]);
  const kind = resolveContentKind(asset);
  const continuous = ['html', 'audio', 'video', 'gif'].includes(kind);
  useCanvasRaster(object.id, rasterElement, object, exterior || departing || transitioning || moving, kind === 'note' || kind === 'markdown');
  const handles = (contentCapabilities[kind].freeResize ? ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] : ['nw', 'ne', 'sw', 'se']) as ResizeHandle[];
  return <div ref={element} className="object-placement" data-group-presentation><article ref={rasterElement} className={`board-object object-${object.type} ${selected ? 'selected' : ''} ${exterior ? 'group-exterior' : ''} ${departing ? 'group-member-departing' : ''} ${arriving ? 'group-member-arriving' : ''}`} inert={exterior || departing} data-moving={moving || undefined} aria-hidden={exterior || undefined} data-object-id={object.id} data-content-kind={kind} data-object-version={canonical.version} data-selected={selected || undefined} tabIndex={exterior || departing ? -1 : 0} role="group" aria-label={`${asset?.name || 'File'}${selected ? ', selected' : ''}`} onKeyDown={event => actions.current.keyDown(object, event)}>
    <div ref={contentElement} className="object-media" data-continuous={continuous || undefined}><SceneContentContext.Provider value={scope}><ContentRenderer
      asset={asset} src={api.content(canonical.assetId)} api={api} objectId={object.id} objectVersion={canonical.version} sessionId={sessionId}
      readOnly={readOnly} disabled={disabled} preserveScene={preserveScene} error={error} fill={fill}
      saveContent={(text, expectedVersion) => actions.current.board.saveContent(object.id, text, expectedVersion, sessionId)}
      registerContentEditor={actions.current.board.registerContentEditor}
      onContentDirtyChange={dirty => actions.current.board.setContentDirty(sessionId, object.id, dirty)}
      onContentCompositionChange={composing => actions.current.board.setContentComposing(sessionId, object.id, composing)}
      onReloadBoard={() => actions.current.reload()} onBlankPointerDown={event => actions.current.blankPointerDown(event)}
      onFrameWheel={event => actions.current.frameWheel(event)} onFrameDrag={(frame, start, event) => actions.current.frameDrag(object.id, frame, start, event)}
      onSize={size => actions.current.size(object.id, size)} onError={() => actions.current.error(object.id)}
      onActivate={() => actions.current.activate(object.id)} onSaveError={cause => actions.current.board.showError(cause)}
      onMediaElement={element => actions.current.media(object.id, kind, element)}
    /></SceneContentContext.Provider></div>
    <div className="object-caption"><span className="object-index">{String(index + 1).padStart(2, '0')}</span><span title={asset?.name}>{asset?.name || 'File'}</span>{object.sourceTaskId && <span className="generated-label">Output</span>}</div>
    {selected && handles.map(corner => <button key={corner} type="button" className="resize-handle" data-resize-id={object.id} data-resize-corner={corner} aria-label={`Resize ${asset?.name || 'File'} ${{ nw: 'top left', n: 'top', ne: 'top right', e: 'right', se: 'bottom right', s: 'bottom', sw: 'bottom left', w: 'left' }[corner]}`} onKeyDown={event => actions.current.resize(object, corner, event)}/>)}
  </article></div>;
});
