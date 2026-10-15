import { useLayoutEffect, useRef } from 'react';
import type { BoardGroup } from '../shared/types';

/** The editable title keeps the name's measured inline box and native text selection. */
export function GroupName({ group, editing, className = '', onCommit, onCancel }: { group: BoardGroup; editing: boolean; className?: string; onCommit: (value: string) => void; onCancel: () => void }) {
  const element = useRef<HTMLSpanElement>(null), input = useRef<HTMLInputElement>(null), dimensions = useRef({ width: 0, height: 0 }), composing = useRef(false), cancelled = useRef(false);
  useLayoutEffect(() => { if (!editing && element.current) dimensions.current = { width: element.current.offsetWidth, height: element.current.offsetHeight }; }, [group.name, editing]);
  useLayoutEffect(() => { if (editing) { cancelled.current = false; input.current?.focus({ preventScroll: true }); input.current?.select(); } }, [editing]);
  return <span ref={element} className={`group-name-slot ${className}`} style={editing ? { width: Math.max(16, dimensions.current.width), height: dimensions.current.height || undefined } : undefined}>
    {editing ? <input ref={input} className="group-name-input" data-canvas-control aria-label="Group name" defaultValue={group.name} maxLength={200} onPointerDown={event => event.stopPropagation()} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }} onKeyDown={event => {
      event.stopPropagation(); if (composing.current || event.nativeEvent.isComposing) return;
      if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); }
      if (event.key === 'Escape') { event.preventDefault(); cancelled.current = true; onCancel(); }
    }} onBlur={event => { if (!cancelled.current) onCommit(event.currentTarget.value.trim() || group.name); }}/>: group.name}
  </span>;
}
