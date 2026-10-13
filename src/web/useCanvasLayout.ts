import { useLayoutEffect, type RefObject } from 'react';
import type { Draft, SessionView } from '../shared/types';
import { placeFloatingControl, placeVideoControl, screenBounds, unionBounds, type Rect } from './geometry';

type ElementRef<T extends HTMLElement = HTMLElement> = RefObject<T | null>;

export function useNotificationLayout(dock: ElementRef, notifications: ElementRef, loaded: boolean) {
  useLayoutEffect(() => {
    const stack = notifications.current;
    if (!stack) return;
    const observed = new Set<Element>();
    let pointerInside = false, visible = false;
    const observer = new ResizeObserver(() => layout());
    const layout = (resizing = false) => {
      const surfaces = dock.current ? Array.from(dock.current.querySelectorAll<HTMLElement>('.composer,.queue-list,.queue-expand,.composer-menu,.draft-conflict,.inline-resume,.unavailable-comments')) : [];
      for (const element of observed) if (!surfaces.includes(element as HTMLElement)) { observer.unobserve(element); observed.delete(element); }
      surfaces.forEach(surface => { if (!observed.has(surface)) { observer.observe(surface); observed.add(surface); } });
      const showing = stack.getClientRects().length > 0, appeared = showing && !visible;
      visible = showing;
      if (!showing) { pointerInside = false; return; }
      if (!resizing && !appeared && (pointerInside || stack.contains(document.activeElement))) return;
      const obstacles = surfaces.filter(surface => !surface.closest('[hidden],[inert],[aria-hidden="true"]') && surface.checkVisibility({ checkVisibilityCSS: true, checkOpacity: true })).map(surface => surface.getBoundingClientRect()).filter(bounds => bounds.width > 0 && bounds.height > 0);
      const gap = 12, edge = 16, right = innerWidth - edge, maximumWidth = Math.min(320, innerWidth - edge * 2);
      stack.style.bottom = `${edge}px`;
      stack.style.maxHeight = `${Math.min(240, innerHeight - edge * 2)}px`;
      stack.style.maxWidth = `${maximumWidth}px`;
      stack.dataset.narrow = 'false';
      const bounds = stack.getBoundingClientRect();
      const minimumWidth = Math.min(bounds.width, stack.querySelector('button,input,textarea,select') ? 200 : 44);
      const adjacent = obstacles.filter(obstacle => bounds.left < obstacle.right + gap && bounds.right > obstacle.left - gap && bounds.top < obstacle.bottom + gap && bounds.bottom > obstacle.top - gap);
      const availableWidth = Math.min(bounds.width, ...adjacent.map(obstacle => right - obstacle.right - gap));
      const width = Math.max(minimumWidth, availableWidth);
      stack.style.maxWidth = `${width}px`;
      stack.dataset.narrow = String(width < 120);
    };
    observer.observe(stack);
    const changes = new MutationObserver(() => layout());
    if (dock.current) changes.observe(dock.current, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'hidden', 'inert', 'aria-hidden'] });
    changes.observe(stack, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden'] });
    const enter = () => { pointerInside = true; };
    const leave = () => { pointerInside = false; layout(); };
    const focusOut = () => requestAnimationFrame(() => layout());
    const resize = () => layout(true);
    stack.addEventListener('pointerenter', enter); stack.addEventListener('pointerleave', leave); stack.addEventListener('focusout', focusOut);
    window.addEventListener('resize', resize);
    layout();
    return () => { observer.disconnect(); changes.disconnect(); stack.removeEventListener('pointerenter', enter); stack.removeEventListener('pointerleave', leave); stack.removeEventListener('focusout', focusOut); window.removeEventListener('resize', resize); };
  }, [dock, notifications, loaded]);
}

export function useComposerLayout(input: ElementRef, dock: ElementRef, draft: Draft | null, loaded: boolean, previewCount = 0) {
  useLayoutEffect(() => {
    const editor = input.current, container = dock.current;
    if (!editor || !container) return;
    const form = editor.closest<HTMLElement>('.composer')!;
    const toolbar = document.querySelector<HTMLElement>('.canvas-toolbar');
    let previousWidth = -1, previousOtherHeight = -1;
    const layout = () => {
      const containerBounds = container.getBoundingClientRect();
      const otherHeight = container.offsetHeight - form.offsetHeight;
      const blocks = [...form.querySelectorAll<HTMLElement>('.composer-block')];
      const editing = form.querySelector<HTMLElement>('.composer-editing');
      const style = getComputedStyle(form), row = form.querySelector<HTMLElement>('.composer-input-row')!;
      const textStyle = getComputedStyle(editor);
      const textChrome = parseFloat(textStyle.marginTop) + parseFloat(textStyle.marginBottom);
      const rowChrome = Math.max(textChrome, (row.querySelector<HTMLElement>('.send-button')?.offsetHeight || 40) - 24);
      const internalHeight = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom) + 2 + rowChrome + blocks.reduce((height, block) => height + block.offsetHeight + parseFloat(getComputedStyle(block).marginTop) + parseFloat(getComputedStyle(block).marginBottom), 0) + (editing ? editing.offsetHeight + parseFloat(getComputedStyle(editing).marginBottom) : 0);
      const bottom = innerHeight - containerBounds.bottom;
      const available = innerHeight - 64 - (toolbar?.offsetHeight || 226) - 12 - bottom - otherHeight - internalHeight;
      const maximum = Math.max(24, Math.min(144, Math.floor(available / 24) * 24));
      editor.style.height = '24px';
      const hasContent = editor.dataset.empty !== 'true';
      const height = hasContent ? Math.min(maximum, Math.max(24, editor.scrollHeight)) : 24;
      editor.style.height = `${height}px`;
      editor.style.overflowY = hasContent && editor.scrollHeight > height ? 'auto' : 'hidden';
      form.style.height = `${Math.max(52, height + internalHeight)}px`;
    };
    const positionDock = () => {
      const bounds = container.getBoundingClientRect();
      container.style.setProperty('--queue-available-height', `${Math.max(76, bounds.top - 64)}px`);
      if (toolbar) toolbar.style.top = `${Math.max(64 + toolbar.offsetHeight / 2, Math.min(innerHeight / 2, bounds.top - 12 - toolbar.offsetHeight / 2))}px`;
    };
    const observer = new ResizeObserver(entries => {
      const width = editor.getBoundingClientRect().width;
      const otherHeight = Math.round(container.getBoundingClientRect().height - form.getBoundingClientRect().height);
      if (width !== previousWidth || otherHeight !== previousOtherHeight) { previousWidth = width; previousOtherHeight = otherHeight; layout(); }
      if (entries.some(entry => entry.target === container || entry.target === form)) positionDock();
    });
    observer.observe(editor); observer.observe(container); observer.observe(form);
    const contents = new MutationObserver(() => { layout(); positionDock(); });
    contents.observe(editor, { childList: true, subtree: true, characterData: true });
    const resize = () => { layout(); positionDock(); };
    window.addEventListener('resize', resize);
    layout(); positionDock();
    return () => { observer.disconnect(); contents.disconnect(); window.removeEventListener('resize', resize); };
  }, [input, dock, draft?.id, draft?.text, draft?.attachments.length, draft?.annotations.length, draft?.references.objectIds.length, draft?.references.taskIds.length, loaded, previewCount]);
}

export function useContextualControls(canvas: ElementRef, actions: ElementRef, playback: ElementRef, selected: Rect[], video: Rect | undefined, view: SessionView) {
  useLayoutEffect(() => {
    const board = canvas.current, actionBar = actions.current, videoBar = playback.current;
    const dock = document.querySelector<HTMLElement>('.creation-dock');
    if (!board || (!actionBar && !videoBar) || !selected.length) { dock?.style.removeProperty('--queue-context-limit'); return; }
    const groupTitles = [...board.querySelectorAll<HTMLElement>('.group-frame-title')].filter(element => !element.closest('[inert],[aria-hidden="true"]') && element.getClientRects().length > 0);
    const persistent = [...document.querySelectorAll<HTMLElement>('.project-identity,.canvas-actions,.canvas-toolbar,.composer,.composer-menu,.draft-attachments,.draft-conflict,.inline-resume,.unavailable-comments,.queue-stack,.annotation-pin,.canvas-annotation-note'), ...groupTitles];
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
      let videoPosition: Rect | null = null;
      if (videoBar && video) {
        const position = placeVideoControl(screenBounds(video, view), viewport, obstacles);
        videoPosition = position?.bounds || null;
        if (position) { videoBar.dataset.layout = position.layout; videoBar.style.width = `${position.bounds.width}px`; }
      }
      const actionPosition = actionBar ? placeFloatingControl(anchor, { width: actionBar.offsetWidth, height: actionBar.offsetHeight }, viewport, 'above', videoPosition ? [...obstacles, videoPosition] : obstacles) : null;
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
