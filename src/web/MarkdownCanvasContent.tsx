import { useEffect, useRef, useState } from 'react';
import { renderMarkdown } from './markdown';
import { useControlledScenePanel } from './scene-renderer/media/use-controlled-panel.js';
import { readMarkdownContentAnchor } from './scene-renderer/media/markdown-anchor.js';

const maximumTextBytes = 2 * 1024 * 1024;
export function MarkdownCanvasContent({ src, title }: { src: string; title: string }) {
  const root = useRef<HTMLDivElement>(null);
  useControlledScenePanel(root, { resolveRoot: element => element.closest<HTMLElement>('.content-shell') ?? element, textRoot: element => element.querySelector<HTMLElement>('.markdown-body') ?? undefined, metadata: () => { const contentAnchor = root.current && readMarkdownContentAnchor(root.current); return contentAnchor ? { scroll: contentAnchor.scroll, contentAnchor } : {}; } });
  const [content, setContent] = useState<{ src: string; html?: string; error?: string }>();
  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      try {
        const response = await fetch(src, { credentials: 'same-origin', signal: controller.signal });
        if (!response.ok) throw new Error('The document is unavailable. Download the original file.');
        if (Number(response.headers.get('Content-Length')) > maximumTextBytes) throw new Error('Preview supports documents up to 2 MB. Download the original file.');
        const reader = response.body?.getReader();
        if (!reader) throw new Error('The document is unavailable. Download the original file.');
        const decoder = new TextDecoder(); let source = '', size = 0;
        try {
          while (true) {
            const chunk = await reader.read(); if (chunk.done) break;
            size += chunk.value.byteLength;
            if (size > maximumTextBytes) { await reader.cancel(); throw new Error('Preview supports documents up to 2 MB. Download the original file.'); }
            source += decoder.decode(chunk.value, { stream: true });
          }
          source += decoder.decode();
        } finally { reader.releaseLock(); }
        if (!controller.signal.aborted) setContent({ src, html: renderMarkdown(source) });
      } catch (error) { if (!controller.signal.aborted) setContent({ src, error: error instanceof Error ? error.message : 'The document is unavailable.' }); }
    }
    void load(); return () => controller.abort();
  }, [src]);
  const current = content?.src === src ? content : undefined;
  return <div ref={root} className="markdown-content" data-canvas-wheel="content" role="document" aria-label={title} tabIndex={0}>
    {current?.error ? <p className="content-message">{current.error}</p> : current?.html !== undefined ? <div className="markdown-body" dangerouslySetInnerHTML={{ __html: current.html }}/> : <p className="content-message">Loading document…</p>}
  </div>;
}
