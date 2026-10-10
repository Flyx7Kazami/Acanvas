import { useCallback, useRef } from 'react';
import type { PointerEvent } from 'react';
import type { Asset } from '../shared/types';
import { noteMime } from '../shared/content-types';
import type { BoardApi } from './api';
import { isContentInteraction } from '../shared/content-hit';
import { PlainTextEditor } from './PlainTextEditor';
import { useEditableText } from './useEditableText';
import { useControlledScenePanel } from './scene-renderer/media/use-controlled-panel.js';

export function NoteCanvasContent({ asset, src, api, disabled, onBlankPointerDown, onActivate, onSaveError }: { asset: Asset; src: string; api: BoardApi; disabled?: boolean; onBlankPointerDown?: (event: PointerEvent<HTMLElement>) => void; onActivate?: () => void; onSaveError?: (cause: unknown) => void }) {
  const root = useRef<HTMLDivElement>(null);
  useControlledScenePanel(root, { resolveRoot: element => element.closest<HTMLElement>('.content-shell') ?? element, textRoot: element => element.querySelector<HTMLElement>('.plain-text-mirror') ?? undefined });
  const save = useCallback(async (text: string) => { await api.replaceContent(asset.id, new Blob([text], { type: noteMime })); }, [api, asset.id]);
  const note = useEditableText(src, save, onSaveError);
  return <div ref={root} className="content-shell note-card" data-content-kind="note" data-canvas-control onPointerDown={event => { if (!isContentInteraction(event.currentTarget, event.clientX, event.clientY, event.target as Element)) onBlankPointerDown?.(event); event.stopPropagation(); }}>
    <PlainTextEditor variant="note" className="note-editor" label={asset.name || 'Note'} placeholder="Note" value={note.text ?? ''} disabled={disabled} onChange={note.change} onBlur={() => void note.flush()} onFocus={onActivate}/>
  </div>;
}
