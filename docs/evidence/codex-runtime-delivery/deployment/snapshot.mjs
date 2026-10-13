import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
export const sha256 = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : canonical(value)).digest('hex');
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
export async function protectedWrite(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
}
export async function ownWorkspace(project) {
  const path = await mkdtemp(join(await realpath(tmpdir()), 'acanvas-formal-deployment-'));
  await chmod(path, 0o700);
  await protectedWrite(join(path, 'deployment-owner.json'), { kind: 'acanvas-formal-deployment', owner: randomUUID(), project, createdAt: new Date().toISOString() });
  return path;
}
export function business(snapshot) {
  // This additive summary is computed at read time by the new build.
  const { service, capabilities, ...bootstrapBusiness } = snapshot.bootstrap;
  const { service: statusService, ...statusBusiness } = snapshot.status;
  return { bootstrap: bootstrapBusiness, status: statusBusiness, sessions: snapshot.sessions, states: snapshot.states.map(({ hostRuntime, ...state }) => state), assetBytes: snapshot.assetBytes };
}
function quiescence(states, sessions) {
  const tasks = states.flatMap(state => state.tasks);
  return { activeConsumers: sessions.filter(session => session.consumerId !== null).length, runningTasks: tasks.filter(task => task.status === 'running').length, runningRuns: tasks.flatMap(task => task.runs).filter(run => run.status === 'running').length, editingTasks: tasks.filter(task => task.status === 'editing').length, editingDrafts: states.filter(state => !!state.draft.editingTaskId).length };
}
export function summary(snapshot) {
  const tasks = snapshot.states.flatMap(state => state.tasks), assets = snapshot.assetBytes;
  return { capturedAt: snapshot.capturedAt, service: snapshot.bootstrap.service, projectId: snapshot.bootstrap.project.id, sessions: snapshot.sessions.length, drafts: snapshot.states.length, tasks: tasks.length, taskStatuses: Object.fromEntries([...new Set(tasks.map(task => task.status))].sort().map(status => [status, tasks.filter(task => task.status === status).length])), runs: tasks.flatMap(task => task.runs).length, receipts: tasks.filter(task => task.receipt).length, lateResults: tasks.flatMap(task => task.lateResults).length, assets: assets.length, assetBytes: assets.reduce((sum, entry) => sum + entry.bytes, 0), objects: snapshot.states[0]?.objects.length ?? 0, annotations: snapshot.states[0]?.annotations.length ?? 0, quiescence: quiescence(snapshot.states, snapshot.sessions), businessSha256: sha256(business(snapshot)), assetBytesSha256: sha256(assets), sessionsSha256: sha256(snapshot.sessions), network: snapshot.network, managedBrowser: { running: snapshot.browser.running, pages: snapshot.browser.pages.length, contextSha256: sha256(snapshot.browser.pages) }, httpResources: { files: snapshot.httpResources.length, sha256: sha256(snapshot.httpResources) }, dist: { files: snapshot.dist.length, sha256: sha256(snapshot.dist) }, stableDuringCapture: snapshot.stableDuringCapture };
}
export async function distManifest(root) {
  const entries = [];
  async function walk(path) {
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new Error('Build manifests must not contain symbolic links.');
    if (info.isDirectory()) for (const name of (await readdir(path)).sort()) await walk(join(path, name));
    else if (info.isFile()) { const bytes = await readFile(path); entries.push({ path: relative(root, path), bytes: bytes.length, sha256: sha256(bytes) }); }
    else throw new Error('Build manifests accept only directories and regular files.');
  }
  await walk(root);
  return entries;
}
export async function capture(project, dist, expected = {}) {
  project = await realpath(project); dist = await realpath(dist);
  const { readRuntime } = await import(pathToFileURL(join(dist, 'src/server/runtime.js')).href);
  const runtime = await readRuntime(project);
  if (!runtime) throw new Error('The formal service is stopped; no snapshot was taken.');
  const base = new URL(runtime.url);
  if (base.protocol !== 'http:' || base.hostname !== '127.0.0.1' || base.pathname !== '/' || base.search || base.hash || base.username || base.password) throw new Error('Formal snapshots require the recorded loopback service.');
  if (expected.port && Number(base.port) !== expected.port || expected.projectId && runtime.project.id !== expected.projectId || expected.instanceId && runtime.instanceId !== expected.instanceId || expected.pid && runtime.pid !== expected.pid) throw new Error('The formal runtime differs from the selected identity.');
  const fetchRead = async (path, token) => {
    const response = await fetch(new URL(path, base), { method: 'GET', headers: token ? { Authorization: `Bearer ${token}` } : {}, signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`A formal read failed at the public endpoint (${response.status}).`);
    return response;
  };
  const bootstrapRaw = await (await fetchRead('/api/bootstrap')).json();
  if (bootstrapRaw.project.root !== project || bootstrapRaw.project.id !== runtime.project.id || bootstrapRaw.service?.pid !== runtime.pid || bootstrapRaw.service?.instanceId !== runtime.instanceId) throw new Error('The formal service failed runtime identity verification.');
  const { token, ...bootstrap } = bootstrapRaw;
  if (typeof token !== 'string' || !token) throw new Error('No authenticated runtime connection is available.');
  const read = async path => (await fetchRead(path, token)).json();
  const status = await read('/api/project/status');
  if (status.status !== 'running' || canonical(status.project) !== canonical(bootstrap.project) || canonical(status.service) !== canonical(bootstrap.service)) throw new Error('The formal health endpoint differs from the verified running project/service identity.');
  const sessions = await read('/api/sessions');
  const readStates = async () => { const values = []; for (const session of sessions) values.push(await read(`/api/state?sessionId=${encodeURIComponent(session.id)}`)); return values; };
  const states = await readStates();
  if (states.some(state => canonical(state.sessions) !== canonical(sessions))) throw new Error('Sessions changed during the formal snapshot.');
  const browser = await read('/api/browser/pages');
  const assetMap = new Map();
  for (const state of states) for (const asset of state.assets) {
    const existing = assetMap.get(asset.id);
    if (existing && canonical(existing) !== canonical(asset)) throw new Error('An asset changed during the formal snapshot.');
    assetMap.set(asset.id, asset);
  }
  const assetBytes = [];
  for (const asset of [...assetMap.values()].sort((a, b) => a.id.localeCompare(b.id))) {
    const response = await fetchRead(`/api/assets/${encodeURIComponent(asset.id)}/content${asset.evidence ? `?sessionId=${encodeURIComponent(asset.evidence.sessionId)}` : ''}`, token);
    const hash = createHash('sha256'); let bytes = 0;
    for await (const chunk of response.body) { hash.update(chunk); bytes += chunk.length; }
    if (bytes !== asset.size) throw new Error('An asset byte length differs from its public metadata.');
    assetBytes.push({ id: asset.id, bytes, sha256: hash.digest('hex') });
  }
  const manifest = await distManifest(dist), httpResources = [], previewMetadataOrigins = new Set();
  for (const entry of manifest.filter(entry => entry.path.startsWith('web/'))) {
    const path = `/${entry.path.slice(4)}`;
    const bytes = Buffer.from(await (await fetchRead(path)).arrayBuffer());
    let buildBytes = bytes;
    if (path.endsWith('.html')) {
      const text = bytes.toString('utf8'), matches = [...text.matchAll(/<meta name="acanvas-html-preview-origin" content="([^"]*)">/g)];
      if (matches.length !== 1) throw new Error('The served HTML preview origin metadata is ambiguous.');
      previewMetadataOrigins.add(matches[0][1]);
      buildBytes = Buffer.from(text.replace(matches[0][0], ''));
    }
    if (buildBytes.length !== entry.bytes || sha256(buildBytes) !== entry.sha256) throw new Error(`A served browser resource differs from the selected local build: ${path}.`);
    httpResources.push({ path, bytes: bytes.length, sha256: sha256(bytes), buildSha256: sha256(buildBytes) });
  }
  const statesAgain = await readStates(), sessionsAgain = await read('/api/sessions'), browserAgain = await read('/api/browser/pages');
  const stableDuringCapture = canonical(states) === canonical(statesAgain) && canonical(sessions) === canonical(sessionsAgain) && canonical(browser) === canonical(browserAgain);
  if (!stableDuringCapture) throw new Error('Formal business fields or browser ownership changed during the snapshot.');
  const runtimeAgain = await readRuntime(project);
  if (canonical(runtimeAgain) !== canonical(runtime)) throw new Error('Formal runtime identity changed during the snapshot.');
  const network = { url: runtime.url, bind: runtime.bind ?? '127.0.0.1', allowedHosts: runtime.allowedHosts ?? [], previewOrigins: runtime.previewOrigins ?? [], urls: runtime.urls ?? [], loopbackPreviewOrigins: [...previewMetadataOrigins].sort() };
  const processArgs = (await execFileAsync('/bin/ps', ['-p', String(runtime.pid), '-o', 'command='], { encoding: 'utf8' })).stdout.trim();
  const snapshot = { capturedAt: new Date().toISOString(), runtime, network, processArgs, bootstrap, status, sessions, states, browser, assetBytes, httpResources, dist: manifest, stableDuringCapture };
  return snapshot;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  const [project, dist, evidence] = process.argv.slice(2);
  if (!project || !dist || !evidence) throw new Error('Use snapshot.mjs PROJECT DIST NEW_SUMMARY_FILE.');
  const workspace = await ownWorkspace(await realpath(project));
  const snapshot = await capture(project, dist, { port: 4317, projectId: 'c3e8d1a5-3b11-4bb8-b63f-b3f4d25e48fd' });
  await protectedWrite(join(workspace, 'preflight.json'), snapshot);
  await mkdir(dirname(evidence), { recursive: true });
  const result = summary(snapshot);
  await writeFile(evidence, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' });
  console.log(JSON.stringify({ workspace, summary: result }));
}
