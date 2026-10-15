import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { Bootstrap, ServiceRuntime } from '../shared/types.js';
import { openRuntimeLog, readRuntime } from './runtime.js';

export function serviceUrl(value: string): URL {
  const base = new URL(value);
  if (base.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(base.hostname) || base.username || base.password || base.search || base.hash || base.pathname !== '/') throw new Error('Choose a loopback HTTP service URL.');
  return base;
}

async function bootstrapAt(root: string, base: URL, runtime?: ServiceRuntime): Promise<Bootstrap> {
  const response = await fetch(new URL('/api/bootstrap', base), { signal: AbortSignal.timeout(2000) });
  if (!response.ok) throw new Error(`The local service rejected the connection (${response.status}).`);
  const bootstrap = await response.json() as Bootstrap;
  if (bootstrap.project.root !== root) throw new Error('The service belongs to another project. Use its matching project root and local port.');
  if (runtime && (bootstrap.project.id !== runtime.project.id || bootstrap.service?.instanceId !== runtime.instanceId || bootstrap.service.pid !== runtime.pid)) throw new Error('The project service instance differs from its saved runtime metadata. Inspect the project service before continuing.');
  return bootstrap;
}

function processExists(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error; }
}

function connectionUnavailable(error: unknown): boolean {
  return error instanceof Error && ((error.cause as NodeJS.ErrnoException | undefined)?.code === 'ECONNREFUSED' || error.name === 'TimeoutError');
}

export async function connectProject(root: string, explicitUrl?: string, start = false, port = 0, network: { bind?: string; allowedHosts?: string[]; previewPort?: string; previewHosts?: string[] } = {}): Promise<{ base: URL; bootstrap: Bootstrap } | undefined> {
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new Error('Choose a valid local port.');
  if (explicitUrl) { const base = serviceUrl(explicitUrl); return { base, bootstrap: await bootstrapAt(root, base) }; }
  const saved = await readRuntime(root);
  if (saved) {
    const base = serviceUrl(saved.url);
    try { return { base, bootstrap: await bootstrapAt(root, base, saved) }; }
    catch (error) {
      if (!connectionUnavailable(error)) throw error;
      if (processExists(saved.pid)) throw new Error('The recorded project service is still running and cannot be reached. Inspect its runtime log before continuing.');
    }
  }
  if (!start) return;
  if (!process.versions.node.startsWith('24.')) throw new Error('Start the project CLI with its Node 24 runtime.');
  const log = await openRuntimeLog(root);
  const child = spawn(process.execPath, [fileURLToPath(new URL('./main.js', import.meta.url)), '--project', root, '--port', String(port), ...(network.bind ? ['--bind', network.bind] : []), ...(network.allowedHosts?.length ? ['--allow-host', network.allowedHosts.join(',')] : []), ...(network.previewPort ? ['--preview-port', network.previewPort] : []), ...(network.previewHosts?.length ? ['--preview-host', network.previewHosts.join(',')] : [])], { detached: true, stdio: ['ignore', log.fd, log.fd] });
  let launchError: Error | undefined;
  child.once('error', error => { launchError = error; });
  child.unref(); await log.close();
  const deadline = Date.now() + 10_000;
  do {
    if (launchError) throw launchError;
    const runtime = await readRuntime(root);
    if (runtime) {
      const base = serviceUrl(runtime.url);
      try { return { base, bootstrap: await bootstrapAt(root, base, runtime) }; }
      catch (error) { if (!connectionUnavailable(error)) throw error; }
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  throw new Error('The project service did not become ready. Inspect .acanvas/runtime/service.log.');
}

export async function waitForStop(root: string, instanceId: string): Promise<void> {
  const deadline = Date.now() + 5000;
  do {
    const runtime = await readRuntime(root);
    if (!runtime || runtime.instanceId !== instanceId) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  throw new Error('The service is still stopping. Inspect project status before another operation.');
}
