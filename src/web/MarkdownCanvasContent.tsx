import { useCallback, useMemo, useRef, useState } from 'react';
import { ArrowDownToLine, Code2, Eye } from 'lucide-react';
import type { Asset } from '../shared/types';
import { editableTextMime } from '../shared/content-types';
import type { BoardApi } from './api';
import { renderMarkdown } from './markdown';
import { PlainTextEditor } from './PlainTextEditor';
import { useEditableText } from './useEditableText';
import { useControlledScenePanel } from './scene-renderer/media/use-controlled-panel.js';
import { readMarkdownContentAnchor } from './scene-renderer/media/markdown-anchor.js';
import type { ContentSaveResult, RegisterContentEditor } from './content-editing';

export function MarkdownCanvasContent({ title, source }: { title: string; source?: string }) {
  const root = useRef<HTMLDivElement>(null);
  useControlledScenePanel(root, { resolveRoot: element => element.closest<HTMLElement>('.content-shell') ?? element, textRoot: element => element.querySelector<HTMLElement>('.markdown-body') ?? undefined, metadata: () => { const contentAnchor = root.current && readMarkdownContentAnchor(root.current); return contentAnchor ? { scroll: contentAnchor.scroll, contentAnchor } : {}; } });
  const markup = useMemo(() => source === undefined ? undefined : { __html: renderMarkdown(source) }, [source]);
  return <div ref={root} className="markdown-content" data-canvas-wheel="content" role="document" aria-label={title} tabIndex={0}>
    {markup ? <div className="markdown-body" dangerouslySetInnerHTML={markup}/> : <p className="content-message">Loading document…</p>}
  </div>;
}

function MarkdownSource({ title, value, disabled, readOnly, onChange, onBlur, onCompositionStart, onCompositionEnd }: { title: string; value: string; disabled?: boolean; readOnly?: boolean; onChange: (value: string) => void; onBlur: () => void; onCompositionStart?: () => void; onCompositionEnd?: () => void }) {
  const root = useRef<HTMLDivElement>(null);
  useControlledScenePanel(root, { resolveRoot: element => element.closest<HTMLElement>('.content-shell') ?? element, textRoot: element => element.querySelector<HTMLElement>('.plain-text-mirror') ?? undefined });
  return <div ref={root} className="markdown-source-wrap"><PlainTextEditor variant="markdown" className="markdown-source" label={`Edit ${title}`} value={value} disabled={disabled} readOnly={readOnly} onChange={onChange} onBlur={onBlur} onCompositionStart={onCompositionStart} onCompositionEnd={onCompositionEnd}/></div>;
}

export function MarkdownBlock({ asset, src, title, api, disabled, readOnly, objectId, objectVersion, sessionId, saveContent, registerContentEditor, onContentDirtyChange, onCompositionChange, onSaveError }: { asset?: Asset; src: string; title: string; api: BoardApi; disabled?: boolean; readOnly?: boolean; objectId?: string; objectVersion?: number; sessionId?: string; saveContent?: (text: string, expectedVersion?: number) => Promise<ContentSaveResult | void>; registerContentEditor?: RegisterContentEditor; onContentDirtyChange?: (dirty: boolean) => void; onCompositionChange?: (composing: boolean) => void; onSaveError?: (cause: unknown) => void }) {
  const [view, setView] = useState<'preview' | 'source'>('preview');
  const editable = !!asset && editableTextMime(asset.mime) && !!objectId && !!saveContent;
  const save = useCallback(async (text: string, expectedVersion?: number) => { if (saveContent) return saveContent(text, expectedVersion); }, [saveContent]);
  const document = useEditableText(src, save, onSaveError, { objectId, objectVersion, sessionId, register: registerContentEditor, onDirtyChange: onContentDirtyChange, onCompositionChange });
  const showPreview = () => { void document.flush().then(() => setView('preview'), () => undefined); };
  const download = async () => { try { await document.flush(); } catch { return; } const link = window.document.createElement('a'); link.href = src; link.download = title; link.click(); };
  return <>
    <div className="markdown-tools" data-canvas-control onPointerDown={event => event.stopPropagation()}>
      <div className="markdown-view-switch" role="group" aria-label="Markdown view">
        <button type="button" aria-pressed={view === 'preview'} aria-label="Preview Markdown" title="Preview" disabled={readOnly} onClick={showPreview}><Eye size={14}/></button>
        <button type="button" aria-pressed={view === 'source'} aria-label="Edit Markdown" title="Edit Markdown" disabled={!editable || disabled || readOnly} onClick={() => setView('source')}><Code2 size={14}/></button>
      </div>
      <button type="button" className="markdown-download" aria-label={`Download ${title}`} title="Download original Markdown" disabled={readOnly} onClick={() => void download()}><ArrowDownToLine size={13}/></button>
    </div>
    {view === 'source' ? <MarkdownSource title={title} value={document.text ?? ''} disabled={disabled} readOnly={readOnly} onChange={document.change} onBlur={() => void document.flush()} onCompositionStart={() => document.setComposing(true)} onCompositionEnd={() => document.setComposing(false)}/> : <MarkdownCanvasContent title={title} source={document.text}/>}
  </>;
}
