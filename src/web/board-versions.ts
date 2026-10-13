import type { BoardVersionChanges } from '../shared/types.js';

export type OwnVersion = { current: number; previous: Set<number> };
export type OwnVersions = Map<string, OwnVersion>;

/** Continue only version chains produced by this mutation queue. */
export function rememberVersionChanges(versions: OwnVersions, changes: BoardVersionChanges['objects']) {
  for (const change of changes) {
    if (change.version === undefined) { versions.delete(change.id); continue; }
    const previous = versions.get(change.id);
    const chain = previous && previous.current === change.beforeVersion ? previous.previous : new Set<number>();
    if (change.beforeVersion !== undefined) chain.add(change.beforeVersion);
    versions.set(change.id, { current: change.version, previous: chain });
  }
}

export function ownExpectedVersion(versions: OwnVersions | undefined, id: string, expected: number) {
  const own = versions?.get(id);
  return own?.previous.has(expected) ? own.current : expected;
}
