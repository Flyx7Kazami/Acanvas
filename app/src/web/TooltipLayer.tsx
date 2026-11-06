import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import './tooltips.css';

function tooltipTarget(node: EventTarget | null) {
  return node instanceof Element ? node.closest<HTMLElement>('[data-tooltip]') : null;
}

export function TooltipLayer() {
  const [tip, setTip] = useState<{ target: HTMLElement; text: string; enter: boolean }>();
  const bubble = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let target: HTMLElement | null = null;
    let delay: number | undefined;
    let visible = false;
    let immediateUntil = 0;
    const dismiss = () => {
      immediateUntil = 0;
      if (!target) return;
      window.clearTimeout(delay);
      target = null;
      visible = false;
      setTip(undefined);
    };
    const show = (next: HTMLElement, enter = false) => {
      const text = next.dataset.tooltip?.trim();
      if (!text || !next.isConnected || !next.checkVisibility({ checkVisibilityCSS: true })) return;
      visible = true;
      setTip({ target: next, text, enter });
    };
    const over = (event: PointerEvent) => {
      if (event.pointerType === 'touch') return;
      const next = tooltipTarget(event.target);
      if (!next || next === target || tooltipTarget(event.relatedTarget) === next) return;
      const immediate = visible || performance.now() < immediateUntil;
      dismiss();
      target = next;
      if (immediate) show(next);
      else delay = window.setTimeout(() => show(next, true), 420);
    };
    const out = (event: PointerEvent) => {
      if (!target || tooltipTarget(event.target) !== target || tooltipTarget(event.relatedTarget) === target) return;
      const wasVisible = visible;
      dismiss();
      if (wasVisible) immediateUntil = performance.now() + 300;
    };
    const focus = (event: FocusEvent) => {
      const next = tooltipTarget(event.target);
      if (!next || !next.matches(':focus-visible')) return;
      dismiss();
      target = next;
      show(next);
    };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') dismiss(); };
    const listeners = new AbortController();
    const options = { capture: true, passive: true, signal: listeners.signal };
    document.addEventListener('pointerover', over, options);
    document.addEventListener('pointerout', out, options);
    document.addEventListener('pointerdown', dismiss, options);
    document.addEventListener('focusin', focus, options);
    document.addEventListener('focusout', dismiss, options);
    document.addEventListener('keydown', key, options);
    document.addEventListener('wheel', dismiss, options);
    document.addEventListener('scroll', dismiss, options);
    window.addEventListener('resize', dismiss, options);
    window.addEventListener('blur', dismiss, options);
    return () => { listeners.abort(); window.clearTimeout(delay); };
  }, []);

  useLayoutEffect(() => {
    if (!tip || !bubble.current) return;
    const anchor = tip.target.getBoundingClientRect();
    const element = bubble.current;
    const { width, height } = element.getBoundingClientRect();
    const edge = 8, gap = 8;
    const maxX = Math.max(edge, innerWidth - width - edge), maxY = Math.max(edge, innerHeight - height - edge);
    const clampX = (x: number) => Math.max(edge, Math.min(maxX, x));
    const clampY = (y: number) => Math.max(edge, Math.min(maxY, y));
    const x = clampX(anchor.left + (anchor.width - width) / 2);
    const y = clampY(anchor.top + (anchor.height - height) / 2);
    const vertical = [{ x, y: anchor.top - height - gap }, { x, y: anchor.bottom + gap }];
    const horizontal = [{ x: anchor.right + gap, y }, { x: anchor.left - width - gap, y }];
    const candidates = tip.target.closest('.canvas-toolbar') ? [...horizontal, ...vertical] : [...vertical, ...horizontal];
    const position = candidates.find(point => point.x >= edge && point.x <= maxX && point.y >= edge && point.y <= maxY) || { x, y: clampY(vertical[0].y) };
    element.style.left = `${position.x}px`;
    element.style.top = `${position.y}px`;
  }, [tip]);

  return tip ? createPortal(<div ref={bubble} className="control-tooltip" role="tooltip" data-enter={tip.enter || undefined}>{tip.text}</div>, document.body) : null;
}
