import type { BoardGroup, Bounds, GroupColor } from './types.js';

export const GROUP_FOLDER_WIDTH = 216;
export const GROUP_FOLDER_ART_HEIGHT = 224;
export const GROUP_PADDING = 24;
export const GROUP_TITLE_SPACE = 40;
export const GROUP_CAPTION_SPACE = 32;
export const GROUP_FOLDER_HEIGHT = GROUP_FOLDER_ART_HEIGHT + GROUP_CAPTION_SPACE;
export const GROUP_COLORS: readonly GroupColor[] = ['cobalt', 'sage', 'coral', 'lilac', 'ink', 'sand'];

export function groupDisplayBounds(group: Pick<BoardGroup, 'x' | 'y' | 'width' | 'height' | 'mode'>): Bounds {
  return { x: group.x, y: group.y, width: group.mode === 'folder' ? GROUP_FOLDER_WIDTH : group.width, height: group.mode === 'folder' ? GROUP_FOLDER_HEIGHT : group.height };
}

export function groupFrameBounds(members: readonly Bounds[], fallback: Bounds = { x: 0, y: 0, width: GROUP_FOLDER_WIDTH, height: GROUP_FOLDER_ART_HEIGHT }): Bounds {
  if (!members.length) return { x: fallback.x, y: fallback.y, width: fallback.width, height: fallback.height };
  const x = Math.min(...members.map(item => item.x)) - GROUP_PADDING;
  const y = Math.min(...members.map(item => item.y)) - GROUP_TITLE_SPACE;
  return { x, y, width: Math.max(...members.map(item => item.x + item.width)) + GROUP_PADDING - x, height: Math.max(...members.map(item => item.y + item.height)) + GROUP_CAPTION_SPACE + GROUP_PADDING - y };
}

export interface GroupLayoutUnit extends Bounds { id: string }
const overlaps = (a: number, aSize: number, b: number, bSize: number) => a < b + bSize && a + aSize > b;

/** Move visible board units as whole rectangles; a group contributes one unit. */
export function layoutGroupTransition(units: readonly GroupLayoutUnit[], groupId: string, nextBounds: Bounds): Map<string, Bounds> {
  const original = units.find(unit => unit.id === groupId);
  if (!original) return new Map();
  const placed = units.map(unit => ({ ...unit }));
  const target = placed.find(unit => unit.id === groupId)!;
  Object.assign(target, nextBounds);
  const originals = new Map(units.map(unit => [unit.id, unit]));
  for (const axis of ['x', 'y'] as const) {
    const size = axis === 'x' ? 'width' : 'height';
    const cross = axis === 'x' ? 'y' : 'x';
    const crossSize = axis === 'x' ? 'height' : 'width';
    const difference = original[size] - target[size];
    if (difference === 0) continue;
    const edge = original[axis] + original[size];
    if (difference > 0) {
      // Candidate membership uses the original frame; the second pass sees the
      // horizontal positions produced by the first pass.
      const candidates = placed.filter(unit => unit.id !== groupId && originals.get(unit.id)![axis] >= edge && overlaps(unit[cross], unit[crossSize], original[cross], original[crossSize]))
        .sort((a, b) => a[axis] - b[axis] || a.id.localeCompare(b.id));
      for (const unit of candidates) {
        const start = unit[axis];
        let destination = start - difference;
        for (const blocker of placed) {
          if (blocker.id === unit.id || !overlaps(unit[cross], unit[crossSize], blocker[cross], blocker[crossSize])) continue;
          const farEdge = blocker[axis] + blocker[size];
          if (farEdge <= start) destination = Math.max(destination, farEdge + GROUP_PADDING);
          // Preserve an existing overlap when resolving it would move the item
          // in the opposite direction. Every newly introduced collision stops
          // at the obstacle's near side.
          else if (blocker[axis] < start + unit[size] && blocker[axis] < start) destination = start;
        }
        unit[axis] = Math.min(start, destination);
      }
    } else {
      const sorted = placed.filter(unit => unit.id !== groupId).sort((a, b) => a[axis] - b[axis] || a.id.localeCompare(b.id));
      const moved = new Set<string>([groupId]);
      for (const unit of sorted) {
        const initial = originals.get(unit.id)!;
        let destination = unit[axis];
        for (const blocker of placed) {
          if (!moved.has(blocker.id) || blocker.id === unit.id || !overlaps(unit[cross], unit[crossSize], blocker[cross], blocker[crossSize])) continue;
          const oldBlocker = originals.get(blocker.id)!;
          // Only objects on this side of the old rectangle participate; this
          // prevents unrelated left/top content from being rearranged.
          if (initial[axis] < oldBlocker[axis] + oldBlocker[size]) continue;
          if (destination < blocker[axis] + blocker[size] + GROUP_PADDING) destination = blocker[axis] + blocker[size] + GROUP_PADDING;
        }
        if (destination > unit[axis]) { unit[axis] = destination; moved.add(unit.id); }
      }
    }
  }
  return new Map(placed.filter(unit => {
    const before = originals.get(unit.id)!;
    return unit.x !== before.x || unit.y !== before.y || unit.width !== before.width || unit.height !== before.height;
  }).map(({ id, x, y, width, height }) => [id, { x, y, width, height }]));
}
