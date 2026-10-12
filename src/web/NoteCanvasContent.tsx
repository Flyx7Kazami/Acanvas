import { useCallback, useRef } from 'react';
import type { PointerEvent } from 'react';
import type { Asset } from '../shared/types';
import { isNoteFill, noteFillColor, type NoteFill } from '../shared/content-types';
import type { BoardApi } from './api';
import { isContentInteraction } from '../shared/content-hit';
import { PlainTextEditor } from './PlainTextEditor';
import { useEditableText } from './useEditableText';
import { useControlledScenePanel } from './scene-renderer/media/use-controlled-panel.js';
import type { ContentSaveResult, RegisterContentEditor } from './content-editing';

export function NoteCanvasContent({ asset, src, api, fill, disabled, readOnly, objectId, objectVersion, sessionId, saveContent, registerContentEditor, onContentDirtyChange, onCompositionChange, onBlankPointerDown, onActivate, onSaveError }: { asset: Asset; src: string; api: BoardApi; fill?: NoteFill; disabled?: boolean; readOnly?: boolean; objectId?: string; objectVersion?: number; sessionId?: string; saveContent?: (text: string, expectedVersion?: number) => Promise<ContentSaveResult | void>; registerContentEditor?: RegisterContentEditor; onContentDirtyChange?: (dirty: boolean) => void; onCompositionChange?: (composing: boolean) => void; onBlankPointerDown?: (event: PointerEvent<HTMLElement>) => void; onActivate?: () => void; onSaveError?: (cause: unknown) => void }) {
  const root = useRef<HTMLDivElement>(null);
  useControlledScenePanel(root, { resolveRoot: element => element.closest<HTMLElement>('.content-shell') ?? element, textRoot: element => element.querySelector<HTMLElement>('.plain-text-mirror') ?? undefined });
  const save = useCallback(async (text: string, expectedVersion?: number) => { if (saveContent) return saveContent(text, expectedVersion); }, [saveContent]);
  const note = useEditableText(src, save, onSaveError, { objectId, objectVersion, sessionId, register: registerContentEditor, onDirtyChange: onContentDirtyChange, onCompositionChange });
  const color = isNoteFill(fill) ? fill : undefined;
  return <div ref={root} className="content-shell note-card" data-content-kind="note" data-fill={color} style={color ? { background: noteFillColor[color] } : undefined} data-canvas-control onPointerDown={event => { if (!isContentInteraction(event.currentTarget, event.clientX, event.clientY, event.target as Element)) onBlankPointerDown?.(event); event.stopPropagation(); }}>
    <PlainTextEditor variant="note" className="note-editor" label={asset.name || 'Note'} placeholder="Note" value={note.text ?? ''} disabled={disabled || !saveContent} readOnly={readOnly} onChange={note.change} onBlur={() => void note.flush()} onFocus={onActivate} onCompositionStart={() => note.setComposing(true)} onCompositionEnd={() => note.setComposing(false)}/>
  </div>;
}
