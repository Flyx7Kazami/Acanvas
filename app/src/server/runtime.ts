import { constants } from 'node:fs';
import { mkdir, open, readFile, realpath, rename, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { ServiceRuntime } from '../shared/types.js';
import { within } from './service.js';

export async function runtimeDirectory(root: string): Promise<string> {
  root = await realpath(root);
  const data = resolve(root, '.acanvas');
  await mkdir(data, { recursive: true, mode: 0o700 });
  if (!within(root, await realpath(data))) throw new Error('Project runtime storage must remain inside the project.');
  const directory = resolve(data, 'runtime');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const actual = await realpath(directory);
  if (!within(root, actual)) throw new Error('Project runtime storage must remain inside the project.');
  return actual;
}

export async function readRuntime(root: string): Promise<ServiceRuntime | undefined> {
  root = await realpath(root);
  const path = resolve(root, '.acanvas/runtime/service.json');
  try {
    if (!within(root, await realpath(path))) throw new Error('Project runtime metadata must remain inside the project.');
    const value = JSON.parse(await readFile(path, 'utf8')) as ServiceRuntime;
    if (!value.project || value.project.root !== root || typeof value.project.id !== 'string' || typeof value.url !== 'string' || !Number.isSafeInteger(value.pid) || value.pid <= 0 || typeof value.instanceId !== 'string' || !value.instanceId) throw new Error('Project runtime metadata is invalid.');
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
}

export async function publishRuntime(runtime: ServiceRuntime): Promise<void> {
  const directory = await runtimeDirectory(runtime.project.root);
  const temporary = resolve(directory, `${runtime.instanceId}.tmp`);
  const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try { await file.writeFile(JSON.stringify(runtime)); await file.sync(); }
  finally { await file.close(); }
  await rename(temporary, resolve(directory, 'service.json'));
}

export async function clearRuntime(runtime: ServiceRuntime): Promise<void> {
  const current = await readRuntime(runtime.project.root);
  if (current?.instanceId === runtime.instanceId && current.pid === runtime.pid) await unlink(resolve(runtime.project.root, '.acanvas/runtime/service.json'));
}

export async function openRuntimeLog(root: string) {
  return open(resolve(await runtimeDirectory(root), 'service.log'), constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, 0o600);
}
