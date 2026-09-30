import { createReadStream } from 'node:fs';
import { readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { basename, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import type { Bootstrap } from './shared/types.js';
import { within } from './server/service.js';

const help = `acanvas: project-local whiteboard CLI (Node 24)

Every API call requires --project /absolute/project. Queue calls require --session ID.
Use --url http://127.0.0.1:4317 for a service on another local port.

project open
session create --name NAME | session list | session read --session ID
session resume --session ID [--consumer ID] --expected-consumer ID|none --resolution TEXT
draft save --session ID --input draft.json | draft send --session ID --draft ID --revision NUMBER
view save --session ID --input view.json
asset import --file FILE [--mime MIME] [--allow-directory DIR]
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
task cancel --session ID --task ID --reason TEXT

Completion JSON: {"summary":"Delivered","assetIds":[],"validation":[],"operations":[]}
Board JSON: {"operations":[{"type":"create","object":{"assetId":"ID","x":0,"y":0,"width":320,"height":240}}]}
Empty task next returns task:null and releases the queue consumer.
The first next/resume can generate a new consumer ID; reuse the returned ID inside that loop.
Idle and transferred consumer IDs are retired. Start a new activation with a new ID.
`;
const fileMime: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.avif': 'image/avif', '.svg': 'image/svg+xml', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.pdf': 'application/pdf', '.zip': 'application/zip', '.txt': 'text/plain', '.html': 'text/html' };
export async function cli(args: string[]): Promise<unknown> {
  if (!args.length || args.includes('--help') || args.includes('-h')) return { help };
  const [group, action] = args;
  const options = new Map<string, string>();
  for (let i = 2; i < args.length; i += 2) { if (!args[i]?.startsWith('--') || args[i + 1] === undefined) throw new Error('Options use --name VALUE.'); options.set(args[i].slice(2), args[i + 1]); }
  const required = (key: string) => { const value = options.get(key); if (!value) throw new Error(`--${key} is required.`); return value; };
  const projectRoot = await realpath(required('project'));
  const base = new URL(options.get('url') ?? 'http://127.0.0.1:4317');
  if (base.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(base.hostname) || base.username || base.password || base.search || base.hash || base.pathname !== '/') throw new Error('Choose a loopback HTTP service URL.');
  const bootstrapResponse = await fetch(new URL('/api/bootstrap', base));
  if (!bootstrapResponse.ok) throw new Error(`The local service rejected the connection (${bootstrapResponse.status}).`);
  const bootstrap = await bootstrapResponse.json() as Bootstrap;
  if (bootstrap.project.root !== projectRoot) throw new Error('The service belongs to another project. Use its matching project root and local port.');
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
  if (group === 'project' && action === 'open') return { project: bootstrap.project, capabilities: bootstrap.capabilities };
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
      const file = await realpath(required('file'));
      const allowed = options.has('allow-directory') ? await realpath(required('allow-directory')) : projectRoot;
      if (!within(allowed, file)) throw new Error('The file must be within the project or the explicitly selected --allow-directory.');
      const info = await stat(file); if (!info.isFile()) throw new Error('Choose a regular file.');
      const params = new URLSearchParams({ name: basename(file), mime: options.get('mime') ?? fileMime[extname(file).toLowerCase()] ?? 'application/octet-stream' });
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
    if (action === 'cancel') return request(`${taskPath()}/cancel`, 'POST', { reason: required('reason') });
  }
  throw new Error('Choose a command from --help.');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { const result = await cli(process.argv.slice(2)); console.log(typeof result === 'object' && result && 'help' in result ? (result as { help: string }).help : JSON.stringify(result, null, 2)); }
  catch (error) { console.error(error instanceof Error ? error.message : 'The CLI request failed.'); process.exitCode = 1; }
}
