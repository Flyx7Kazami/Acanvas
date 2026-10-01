import { useLayoutEffect, type RefObject } from 'react';
import type { Draft, SessionView } from '../shared/types';
import { placeFloatingControl, screenBounds, unionBounds, type Rect } from './geometry';

type ElementRef<T extends HTMLElement = HTMLElement> = RefObject<T | null>;

export function useComposerLayout(input: ElementRef<HTMLTextAreaElement>, dock: ElementRef, draft: Draft | null, loaded: boolean) {
  useLayoutEffect(() => {
    const textarea = input.current, container = dock.current;
    if (!textarea || !container) return;
    const form = textarea.closest<HTMLElement>('.composer')!;
    const toolbar = document.querySelector<HTMLElement>('.canvas-toolbar');
    let previousWidth = -1, previousOtherHeight = -1;
    const layout = () => {
      const containerBounds = container.getBoundingClientRect();
      const otherHeight = container.offsetHeight - form.offsetHeight;
      const references = form.querySelector<HTMLElement>('.draft-attachments');
      const internalHeight = 28 + (references ? references.offsetHeight + 8 : 0);
      const bottom = innerHeight - containerBounds.bottom;
      const available = innerHeight - 64 - (toolbar?.offsetHeight || 226) - 12 - bottom - otherHeight - internalHeight;
      const maximum = Math.max(24, Math.min(144, Math.floor(available / 24) * 24));
      textarea.style.height = '24px';
      const height = textarea.value ? Math.min(maximum, Math.max(24, textarea.scrollHeight)) : 24;
      textarea.style.height = `${height}px`;
      textarea.style.overflowY = textarea.value && textarea.scrollHeight > height ? 'auto' : 'hidden';
      form.style.height = `${Math.max(52, height + internalHeight)}px`;
    };
    const positionDock = () => {
      const bounds = container.getBoundingClientRect();
      container.style.setProperty('--queue-available-height', `${Math.max(76, bounds.top - 64)}px`);
      if (toolbar) toolbar.style.top = `${Math.max(64 + toolbar.offsetHeight / 2, Math.min(innerHeight / 2, bounds.top - 12 - toolbar.offsetHeight / 2))}px`;
    };
    const observer = new ResizeObserver(entries => {
      const width = textarea.getBoundingClientRect().width;
      const otherHeight = Math.round(container.getBoundingClientRect().height - form.getBoundingClientRect().height);
      if (width !== previousWidth || otherHeight !== previousOtherHeight) { previousWidth = width; previousOtherHeight = otherHeight; layout(); }
      if (entries.some(entry => entry.target === container || entry.target === form)) positionDock();
    });
    observer.observe(textarea); observer.observe(container); observer.observe(form);
    const resize = () => { layout(); positionDock(); };
    window.addEventListener('resize', resize);
    layout(); positionDock();
    return () => { observer.disconnect(); window.removeEventListener('resize', resize); };
  }, [input, dock, draft?.id, draft?.text, draft?.attachments.length, draft?.annotations.length, loaded]);
}

export function useContextualControls(canvas: ElementRef, actions: ElementRef, playback: ElementRef, selected: Rect[], video: Rect | undefined, view: SessionView) {
  useLayoutEffect(() => {
    const board = canvas.current, actionBar = actions.current, videoBar = playback.current;
    const dock = document.querySelector<HTMLElement>('.creation-dock');
    if (!board || (!actionBar && !videoBar) || !selected.length) { dock?.style.removeProperty('--queue-context-limit'); return; }
    const persistent = [...document.querySelectorAll<HTMLElement>('.project-identity,.canvas-actions,.canvas-toolbar,.composer,.dock-footer,.draft-attachments,.draft-conflict,.inline-resume,.draft-annotation-reader,.unavailable-comments,.queue-stack,.annotation-pin')].filter(element => !actionBar?.classList.contains('inline-annotation-reader') || !element.matches('.annotation-pin'));
    const layout = () => {
      const bounds = board.getBoundingClientRect();
      const viewport = { x: 0, y: 0, width: bounds.width, height: bounds.height };
      const projected = selected.map(rect => screenBounds(rect, view));
      const visible = projected.some(rect => rect.x < viewport.width && rect.x + rect.width > 0 && rect.y < viewport.height && rect.y + rect.height > 0);
      for (const control of [actionBar, videoBar]) {
        if (!control) continue;
        control.dataset.positioned = String(visible);
        control.inert = !visible;
        control.setAttribute('aria-hidden', String(!visible));
      }
      if (!visible) { dock?.style.removeProperty('--queue-context-limit'); return; }
      if (dock) {
        const fixedBottom = Math.max(...persistent.filter(element => element.matches('.project-identity,.canvas-actions')).map(element => element.getBoundingClientRect().bottom));
        const queueLimit = Math.max(76, dock.getBoundingClientRect().top - fixedBottom - (actionBar?.offsetHeight || 0) - (videoBar?.offsetHeight || 0) - 24);
        dock.style.setProperty('--queue-context-limit', `${queueLimit}px`);
      }
      const obstacles = persistent.map(element => { const rect = element.getBoundingClientRect(); return { x: rect.x - bounds.x, y: rect.y - bounds.y, width: rect.width, height: rect.height }; });
      const anchor = unionBounds(projected);
      let actionPosition = actionBar ? placeFloatingControl(anchor, { width: actionBar.offsetWidth, height: actionBar.offsetHeight }, viewport, 'above', obstacles) : null;
      let videoPosition: Rect | null = null;
      if (videoBar && video) {
        const videoBounds = screenBounds(video, view);
        // The caption belongs to the canvas object and scales with its geometry.
        videoBounds.height += 32 * view.zoom;
        videoPosition = placeFloatingControl(videoBounds, { width: videoBar.offsetWidth, height: videoBar.offsetHeight }, viewport, 'below', actionPosition ? [...obstacles, actionPosition] : obstacles);
        if (actionBar && (!actionPosition || !videoPosition)) {
          const width = Math.max(actionBar.offsetWidth, videoBar.offsetWidth);
          const stack = placeFloatingControl(anchor, { width, height: actionBar.offsetHeight + 8 + videoBar.offsetHeight }, viewport, 'above', obstacles);
          if (stack) {
            actionPosition = { x: stack.x + (width - actionBar.offsetWidth) / 2, y: stack.y, width: actionBar.offsetWidth, height: actionBar.offsetHeight };
            videoPosition = { x: stack.x + (width - videoBar.offsetWidth) / 2, y: stack.y + actionBar.offsetHeight + 8, width: videoBar.offsetWidth, height: videoBar.offsetHeight };
          }
        }
      }
      for (const [control, position] of [[actionBar, actionPosition], [videoBar, videoPosition]] as const) {
        if (!control) continue;
        control.dataset.positioned = String(!!position); control.inert = !position; control.setAttribute('aria-hidden', String(!position));
        if (position) { control.style.left = `${position.x}px`; control.style.top = `${position.y}px`; }
      }
    };
    const observer = new ResizeObserver(layout);
    for (const element of [board, actionBar, videoBar, ...persistent]) if (element) observer.observe(element);
    window.addEventListener('resize', layout);
    layout();
    return () => { observer.disconnect(); window.removeEventListener('resize', layout); };
  });
}
