import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startServer } from '../src/server/http.js';
import { cli } from '../src/cli.js';
import { readRuntime } from '../src/server/runtime.js';

const execute = promisify(execFile);
const launch = async (root: string, args: string[]) => {
  const { stdout } = await execute(process.execPath, [resolve('dist/src/cli.js'), ...args, '--project', root], { timeout: 15_000 });
  return JSON.parse(stdout);
};

test('host conversations bind distinct task scopes and explicitly retain saved contexts', async t => {
  const root = await mkdtemp(join(tmpdir(), 'acanvas-host-binding-'));
  const server = await startServer({ root, port: 0 });
  t.after(async () => { await server.close(); await rm(root, { recursive: true, force: true }); });
  const args = ['--project', root, '--url', server.url];
  const first = await cli(['project', 'open', '--host', 'fixture', '--thread', 'conversation-a', ...args]) as any;
  const second = await cli(['project', 'open', '--host', 'fixture', '--thread', 'conversation-b', ...args]) as any;
  assert.notEqual(first.sessionId, second.sessionId);
  assert.equal(new URL(first.openUrl).searchParams.get('session'), first.sessionId);
  const old = server.service.createSession('Saved task context');
  const draft = server.service.draft(old.id), saved = server.service.saveDraft(old.id, { ...draft, text: 'Retain this saved request' });
  const task = server.service.sendDraft(old.id, saved.id, saved.revision).task;
  const restored = await cli(['project', 'open', '--host', 'fixture', '--thread', 'conversation-c', '--session', old.id, ...args]) as any;
  assert.equal(restored.sessionId, old.id);
  assert.equal(server.service.state(old.id).tasks[0].id, task.id);
  const reopened = await cli(['project', 'open', '--host', 'fixture', '--thread', 'conversation-c', ...args]) as any;
  assert.equal(reopened.sessionId, old.id);
  await assert.rejects(cli(['project', 'open', '--host', 'fixture', '--thread', 'conversation-c', '--session', first.sessionId, ...args]), /host_binding_conflict/);
  assert.equal(server.service.state(first.sessionId).tasks.length, 0);
  assert.equal(server.service.state(second.sessionId).tasks.length, 0);
  assert.equal(server.service.state(old.id).tasks[0].id, task.id);
});

test('explicit CLI session selects its scope while environment binding remains optional', async t => {
  const root = await mkdtemp(join(tmpdir(), 'acanvas-cli-explicit-scope-'));
  const emptyRoot = await mkdtemp(join(tmpdir(), 'acanvas-cli-empty-scope-'));
  const server = await startServer({ root, port: 0 });
  t.after(async () => { await server.close(); await rm(root, { recursive: true, force: true }); await rm(emptyRoot, { recursive: true, force: true }); });
  const foreign = server.service.createSession('Foreign conversation scope'), selected = server.service.createSession('Explicit task scope');
  const env: NodeJS.ProcessEnv = { ...process.env, CODEX_THREAD_ID: 'existing-foreign-conversation' };
  const noEnvironment: NodeJS.ProcessEnv = { ...process.env }; delete noEnvironment.CODEX_THREAD_ID;
  const run = async (args: string[], environment = env) => JSON.parse((await execute(process.execPath, [resolve('dist/src/cli.js'), ...args, '--project', root], { timeout: 15_000, env: environment })).stdout);
  const original = await run(['project', 'open', '--host', 'codex', '--thread', env.CODEX_THREAD_ID!, '--session', foreign.id]);
  assert.equal(original.sessionId, foreign.id);
  const counts = () => ({ sessions: server.service.sessions().length, bindings: (server.service.db.prepare('SELECT COUNT(*) AS count FROM host_bindings').get() as { count: number }).count });
  const before = counts(); assert.deepEqual(before, { sessions: 2, bindings: 1 });
  const result = await run(['project', 'open', '--session', selected.id]);
  assert.equal(result.sessionId, selected.id); assert.equal(new URL(result.openUrl).searchParams.get('session'), selected.id); assert.equal(result.binding, undefined); assert.deepEqual(counts(), before);
  assert.equal((server.service.db.prepare('SELECT session_id FROM host_bindings WHERE host=? AND thread_id=?').get('codex', env.CODEX_THREAD_ID) as { session_id: string }).session_id, foreign.id);
  await assert.rejects(run(['project', 'open', '--host', 'codex', '--thread', env.CODEX_THREAD_ID!, '--session', selected.id]), /host_binding_conflict/); assert.deepEqual(counts(), before);
  const convenience = await run(['project', 'open']); assert.equal(convenience.sessionId, foreign.id); assert.equal(convenience.binding.sessionId, foreign.id); assert.deepEqual(counts(), before);
  const plain = await run(['project', 'open'], noEnvironment); assert.equal(plain.sessionId, undefined); assert.equal(plain.binding, undefined); assert.deepEqual(counts(), before);
  for (const empty of ['', '   ']) await assert.rejects(execute(process.execPath, [resolve('dist/src/cli.js'), 'project', 'open', '--session', empty, '--project', emptyRoot], { timeout: 15_000, env }), /--session is required/);
  assert.equal(await readRuntime(emptyRoot), undefined); assert.deepEqual(await readdir(emptyRoot), []);
});

test('detached service survives launcher exit, reuses its instance and preserves assets and tasks across stop', async t => {
  const root = await mkdtemp(join(tmpdir(), 'acanvas-detached-runtime-'));
  t.after(async () => { await launch(root, ['project', 'stop']).catch(() => undefined); await rm(root, { recursive: true, force: true }); });
  assert.equal((await launch(root, ['project', 'status'])).status, 'stopped');
  const first = await launch(root, ['project', 'open', '--host', 'fixture', '--thread', 'persistent-conversation']);
  const runtime = (await readRuntime(root))!;
  assert.equal(runtime.instanceId, first.service.instanceId);
  // This read runs in a new process after the launcher has already exited.
  const independent = await execute(process.execPath, ['--input-type=module', '-e', `const response=await fetch(${JSON.stringify(new URL('/api/bootstrap', first.openUrl).href)});const value=await response.json();console.log(JSON.stringify({status:response.status,instanceId:value.service.instanceId,projectRoot:value.project.root}));`]);
  assert.deepEqual(JSON.parse(independent.stdout), { status: 200, instanceId: runtime.instanceId, projectRoot: first.project.root });
  const again = await launch(root, ['project', 'open', '--host', 'fixture', '--thread', 'persistent-conversation']);
  assert.equal(again.sessionId, first.sessionId); assert.equal(again.service.instanceId, first.service.instanceId);
  const assetFile = join(root, 'fixture.txt'); await writeFile(assetFile, 'Persistent reference bytes');
  const asset = await launch(root, ['asset', 'import', '--file', assetFile]);
  const state = await launch(root, ['session', 'read', '--session', first.sessionId]);
  const draftFile = join(root, 'draft.json'); await writeFile(draftFile, JSON.stringify({ ...state.draft, text: 'Keep this task available', attachments: [asset.id] }));
  const draft = await launch(root, ['draft', 'save', '--session', first.sessionId, '--input', draftFile]);
  const sent = await launch(root, ['draft', 'send', '--session', first.sessionId, '--draft', draft.id, '--revision', String(draft.revision)]);
  const bootstrap = await (await fetch(new URL('/api/bootstrap', first.openUrl))).json();
  const rejected = await fetch(new URL('/api/project/stop', first.openUrl), { method: 'POST', headers: { Authorization: `Bearer ${bootstrap.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ instanceId: 'another-instance' }) });
  assert.equal(rejected.status, 409);
  assert.equal((await launch(root, ['project', 'status'])).status, 'running');
  const log = await readFile(join(root, '.acanvas/runtime/service.log'), 'utf8'); assert.ok(!log.includes(bootstrap.token));
  assert.equal((await launch(root, ['project', 'stop'])).status, 'stopped');
  assert.equal(await readRuntime(root), undefined);
  assert.equal((await launch(root, ['project', 'status'])).status, 'stopped');
  const resumed = await launch(root, ['project', 'open', '--host', 'fixture', '--thread', 'persistent-conversation']);
  assert.equal(resumed.sessionId, first.sessionId); assert.notEqual(resumed.service.instanceId, first.service.instanceId);
  const retained = await launch(root, ['session', 'read', '--session', first.sessionId]);
  assert.equal(retained.tasks[0].id, sent.task.id); assert.equal(retained.tasks[0].status, 'queued'); assert.equal(retained.assets[0].id, asset.id);
  const readBack = join(root, 'read-back.txt'); await launch(root, ['asset', 'read', '--asset', asset.id, '--out', readBack]);
  assert.equal(await readFile(readBack, 'utf8'), 'Persistent reference bytes');
});
