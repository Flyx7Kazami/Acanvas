import { constants, createReadStream } from 'node:fs';
import { lstat, open, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import type { HostBinding } from './shared/types.js';
import { resolveContentMime } from './shared/content-types.js';
import { within } from './server/service.js';
import { bundleChanged, collectHtmlBundle, sameBundleSource, verifyBundleDirectories } from './server/html-bundle-import.js';
import { connectProject, waitForStop } from './server/client-runtime.js';

const help = `acanvas: project-local whiteboard CLI (Node 24)

Every API call requires --project /absolute/project. Queue calls require --session ID.
Use --url http://127.0.0.1:4317 to connect to a selected local service.
Without --url, calls discover the project's service; project open starts it when needed.

project open [--host NAME --thread ID] [--session ID] [--port NUMBER]
  CODEX_THREAD_ID automatically binds the current Codex conversation.
  Returns openUrl and sessionId for the current host conversation.
project status | project stop
session create --name NAME | session list | session read --session ID
session resume --session ID [--consumer ID] --expected-consumer ID|none --resolution TEXT
draft save --session ID --input draft.json | draft send --session ID --draft ID --revision NUMBER
view save --session ID --input view.json
asset import --file FILE [--mime MIME] [--allow-directory DIR] [--bundle-root DIR]
  --bundle-root authorizes and imports a publishable HTML directory (128 files / 32 MiB; hidden files skipped).
  Outputs also require --session ID --task ID --run ID --consumer ID.
asset read --asset ID --out FILE
board operations --session ID --input operations.json
task next --session ID [--consumer ID]
task read --session ID --task ID
task progress --session ID --task ID --run ID --consumer ID --message TEXT [--job ID]
task block|interrupt --session ID --task ID --run ID --consumer ID --reason TEXT
task reply --session ID --task ID --text TEXT
task resume --session ID --task ID [--consumer ID] --expected-run ID --resolution TEXT
task complete --session ID --task ID --run ID --consumer ID --input completion.json
task edit|cancel-edit --session ID --task ID --draft ID --revision NUMBER
task cancel --session ID --task ID --reason TEXT

Completion JSON: {"summary":"Delivered","assetIds":[],"validation":[],"operations":[]}
Board JSON: {"operations":[{"type":"create","object":{"assetId":"ID","x":0,"y":0,"width":320,"height":240}}]}
Empty task next returns task:null and releases the queue consumer.
The first next/resume can generate a new consumer ID; reuse the returned ID inside that loop.
Idle and transferred consumer IDs are retired. Start a new activation with a new ID.
`;
export async function cli(args: string[]): Promise<unknown> {
  if (!args.length || args.includes('--help') || args.includes('-h')) return { help };
  const [group, action] = args;
  const options = new Map<string, string>();
  for (let i = 2; i < args.length; i += 2) { if (!args[i]?.startsWith('--') || args[i + 1] === undefined) throw new Error('Options use --name VALUE.'); options.set(args[i].slice(2), args[i + 1]); }
  const required = (key: string) => { const value = options.get(key); if (!value) throw new Error(`--${key} is required.`); return value; };
  const projectRoot = await realpath(required('project'));
  const connection = await connectProject(projectRoot, options.get('url'), group === 'project' && action === 'open', options.has('port') ? Number(required('port')) : 0);
  if (!connection) {
    if (group === 'project' && ['status', 'stop'].includes(action)) return { projectRoot, status: 'stopped' };
    throw new Error('The project service is stopped. Run project open to start it.');
  }
  const { base, bootstrap } = connection;
  const request = async (path: string, method = 'GET', body?: unknown): Promise<any> => {
    const response = await fetch(new URL(path, base), { method, headers: { Authorization: `Bearer ${bootstrap.token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const result = await response.json();
    if (!response.ok) throw new Error(JSON.stringify(result));
    return result;
  };
  const sessionPath = () => `/api/sessions/${encodeURIComponent(required('session'))}`;
  const taskPath = () => `${sessionPath()}/tasks/${encodeURIComponent(required('task'))}`;
  const identity = () => ({ runId: required('run'), consumerId: required('consumer') });
  const input = async () => JSON.parse(await readFile(required('input'), 'utf8'));
  if (group === 'project') {
    if (action === 'status') return request('/api/project/status');
    if (action === 'stop') {
      if (!bootstrap.service?.instanceId) throw new Error('This service does not expose its runtime identity. Use its original terminal to stop it.');
      await request('/api/project/stop', 'POST', { instanceId: bootstrap.service.instanceId });
      await waitForStop(projectRoot, bootstrap.service.instanceId);
      return { project: bootstrap.project, status: 'stopped' };
    }
    if (action === 'open') {
      let host = options.get('host'), threadId = options.get('thread');
      if (host || threadId) { host = required('host'); threadId = required('thread'); }
      else if (process.env.CODEX_THREAD_ID) { host = 'codex'; threadId = process.env.CODEX_THREAD_ID; }
      let binding: HostBinding | undefined, sessionId = options.get('session');
      if (host && threadId) { binding = await request('/api/host-bindings', 'POST', { host, threadId, ...(sessionId ? { sessionId } : {}) }); sessionId = binding!.sessionId; }
      else if (sessionId) { const session = await request(`/api/state?sessionId=${encodeURIComponent(sessionId)}`); sessionId = session.session.id; }
      const openUrl = new URL(base); if (sessionId) openUrl.searchParams.set('session', sessionId);
      return { project: bootstrap.project, service: bootstrap.service, capabilities: bootstrap.capabilities, ...(binding ? { binding } : {}), ...(sessionId ? { sessionId } : {}), openUrl: openUrl.href };
    }
  }
  if (group === 'session') {
    if (action === 'create') return request('/api/sessions', 'POST', { name: required('name') });
    if (action === 'list') {
      // Read session metadata directly through a dedicated read endpoint.
      return request('/api/sessions');
    }
    if (action === 'read') return request(`/api/state?sessionId=${encodeURIComponent(required('session'))}`);
    if (action === 'resume') return request(`${sessionPath()}/resume`, 'POST', { consumerId: options.get('consumer') ?? randomUUID(), expectedConsumerId: required('expected-consumer') === 'none' ? null : required('expected-consumer'), resolution: required('resolution') });
  }
  if (group === 'draft') {
    if (action === 'save') return request(`${sessionPath()}/draft`, 'PUT', await input());
    if (action === 'send') return request(`${sessionPath()}/tasks`, 'POST', { draftId: required('draft'), expectedRevision: Number(required('revision')) });
  }
  if (group === 'view' && action === 'save') return request(`${sessionPath()}/view`, 'PUT', await input());
  if (group === 'board' && action === 'operations') { const value = await input(); return request('/api/board/operations', 'POST', { sessionId: required('session'), operations: value.operations }); }
  if (group === 'asset') {
    if (action === 'import') {
      if (options.has('bundle-root')) {
        if ((await lstat(required('file'))).isSymbolicLink()) throw new Error('Bundle symlinks are not supported.');
        const entry = await realpath(required('file'));
        const bundle = await collectHtmlBundle(required('bundle-root'), entry);
        const files: Record<string, string> = Object.create(null);
        for (const item of bundle.files) {
          await verifyBundleDirectories(bundle.directories);
          // Recheck the directory boundary immediately before opening each file.
          if ((await lstat(item.file)).isSymbolicLink() || !within(bundle.root, await realpath(item.file))) throw new Error('Bundle files must remain inside --bundle-root.');
          const handle = await open(item.file, constants.O_RDONLY | constants.O_NOFOLLOW);
          try {
            const info = await handle.stat({ bigint: true });
            if (!info.isFile() || info.size !== BigInt(item.size) || !sameBundleSource(info, item)) throw bundleChanged();
            await verifyBundleDirectories(bundle.directories);
            const params = new URLSearchParams({ name: basename(item.file), mime: item.mime });
            if (options.has('task')) { params.set('taskId', required('task')); params.set('sessionId', required('session')); params.set('runId', required('run')); params.set('consumerId', required('consumer')); }
            const response = await fetch(new URL(`/api/assets?${params}`, base), { method: 'POST', headers: { Authorization: `Bearer ${bootstrap.token}`, 'Content-Type': 'application/octet-stream', 'Content-Length': String(info.size) }, body: handle.createReadStream({ autoClose: false }) as unknown as BodyInit, duplex: 'half' } as RequestInit & { duplex: string });
            const result = await response.json(); if (!response.ok) throw new Error(JSON.stringify(result));
            files[item.path] = result.id;
            if (!sameBundleSource(await handle.stat({ bigint: true }), item)) throw bundleChanged();
            await verifyBundleDirectories(bundle.directories);
          } finally { await handle.close(); }
        }
        await verifyBundleDirectories(bundle.directories);
        return request('/api/html-bundles', 'POST', { entryPath: bundle.entryPath, files, ...(options.has('task') ? { source: { sessionId: required('session'), taskId: required('task'), ...identity() } } : {}) });
      }
      const file = await realpath(required('file'));
      const allowed = options.has('allow-directory') ? await realpath(required('allow-directory')) : projectRoot;
      if (!within(allowed, file)) throw new Error('The file must be within the project or the explicitly selected --allow-directory.');
      const info = await stat(file); if (!info.isFile()) throw new Error('Choose a regular file.');
      const params = new URLSearchParams({ name: basename(file), mime: resolveContentMime(basename(file), options.get('mime')) });
      if (options.has('task')) { params.set('taskId', required('task')); params.set('sessionId', required('session')); params.set('runId', required('run')); params.set('consumerId', required('consumer')); }
      const response = await fetch(new URL(`/api/assets?${params}`, base), { method: 'POST', headers: { Authorization: `Bearer ${bootstrap.token}`, 'Content-Type': 'application/octet-stream', 'Content-Length': String(info.size) }, body: createReadStream(file) as unknown as BodyInit, duplex: 'half' } as RequestInit & { duplex: string });
      const result = await response.json(); if (!response.ok) throw new Error(JSON.stringify(result)); return result;
    }
    if (action === 'read') {
      const response = await fetch(new URL(`/api/assets/${encodeURIComponent(required('asset'))}/content`, base), { headers: { Authorization: `Bearer ${bootstrap.token}` } });
      if (!response.ok) throw new Error(JSON.stringify(await response.json()));
      await writeFile(required('out'), Buffer.from(await response.arrayBuffer()), { flag: 'wx', mode: 0o600 });
      return { assetId: required('asset'), file: required('out') };
    }
  }
  if (group === 'task') {
    if (action === 'next') return request(`${sessionPath()}/claim`, 'POST', { consumerId: options.get('consumer') ?? randomUUID() });
    if (action === 'read') return request(`${taskPath()}/context`);
    if (action === 'progress') return request(`${taskPath()}/progress`, 'POST', { ...identity(), message: required('message'), ...(options.has('job') ? { externalJobId: required('job') } : {}) });
    if (action === 'block' || action === 'interrupt') return request(`${taskPath()}/${action}`, 'POST', { ...identity(), reason: required('reason') });
    if (action === 'reply') return request(`${taskPath()}/reply`, 'POST', { text: required('text') });
    if (action === 'resume') return request(`${taskPath()}/resume`, 'POST', { consumerId: options.get('consumer') ?? randomUUID(), expectedRunId: required('expected-run'), resolution: required('resolution') });
    if (action === 'complete') return request(`${taskPath()}/complete`, 'POST', { ...await input(), ...identity() });
    if (action === 'edit' || action === 'cancel-edit') return request(`${taskPath()}/${action}`, 'POST', { draftId: required('draft'), expectedRevision: Number(required('revision')) });
    if (action === 'cancel') return request(`${taskPath()}/cancel`, 'POST', { reason: required('reason') });
  }
  throw new Error('Choose a command from --help.');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { const result = await cli(process.argv.slice(2)); console.log(typeof result === 'object' && result && 'help' in result ? (result as { help: string }).help : JSON.stringify(result, null, 2)); }
  catch (error) { console.error(error instanceof Error ? error.message : 'The CLI request failed.'); process.exitCode = 1; }
}
