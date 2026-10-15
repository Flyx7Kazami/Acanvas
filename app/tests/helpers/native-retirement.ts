import assert from 'node:assert/strict';
import { stat } from 'node:fs/promises';
import type { NativeHtmlRuntime } from '../../src/server/render-surface/cef.js';

export interface NativeRetirementSnapshot { profile: string; pids: number[] }
export async function nativeRetirementSnapshot(runtime: NativeHtmlRuntime): Promise<NativeRetirementSnapshot> {
  const source = runtime as any, pid = source.process?.pid as number | undefined;
  if (pid) await source.recordWorkers(pid);
  return { profile: runtime.directory(), pids: [...new Set<number>([...(pid ? [pid] : []), ...source.ownedWorkers])] };
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error; } };
export async function waitNativeRetired(snapshot: NativeRetirementSnapshot): Promise<number> {
  // A pending sample can take 8s, native SIGKILL follows at 6s, worker reaping takes 1s.
  const began = Date.now(), deadline = began + 18_000;
  let profileExists = true, live: number[] = [];
  do {
    try { await stat(snapshot.profile); profileExists = true; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; profileExists = false; }
    live = snapshot.pids.filter(alive);
    if (!profileExists && !live.length) return Date.now() - began;
    await new Promise(resolve => setTimeout(resolve, 20));
  } while (Date.now() < deadline);
  assert.equal(profileExists, false, `Owned native profile remained after shutdown: ${snapshot.profile}`);
  assert.deepEqual(live, [], 'Owned native processes remained after shutdown.');
  return Date.now() - began;
}
