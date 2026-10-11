import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as rawRequest } from 'node:http';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import type { AnnotationInput, Asset, Claim, Draft, ResolvedRequestReference, Task } from '../src/shared/types.js';
import { startServer, type RunningServer } from '../src/server/http.js';
import { cli } from '../src/cli.js';
import { generateRequirementText } from '../src/shared/task-message.js';

async function fixture(t: test.TestContext, maxUploadBytes = 512 * 1024 * 1024) {
  const root = await mkdtemp(join(tmpdir(), 'acanvas-test-'));
  let running = await startServer({ root, port: 0, maxUploadBytes });
  let bootstrap = await (await fetch(`${running.url}/api/bootstrap`)).json();
  t.after(async () => { await running.close(); await rm(root, { recursive: true, force: true }); });
  const call = async (path: string, method = 'GET', body?: unknown, expected = 200) => {
    const response = await fetch(`${running.url}${path}`, { method, headers: { Authorization: `Bearer ${bootstrap.token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const value = await response.json(); assert.equal(response.status, expected, JSON.stringify(value)); return value;
  };
  const session = async (name = 'Session') => call('/api/sessions', 'POST', { name }, 201);
  const state = async (sessionId: string) => call(`/api/state?sessionId=${sessionId}`);
  const sendTask = async (sessionId: string, message = 'Prepare the reference') => {
    const draft: Draft = (await state(sessionId)).draft;
    const saved = await call(`/api/sessions/${sessionId}/draft`, 'PUT', { ...draft, text: message });
    return (await call(`/api/sessions/${sessionId}/tasks`, 'POST', { draftId: draft.id, expectedRevision: saved.revision })).task as Task;
  };
  const upload = async (body: string | Buffer, query = '', expected = 201, source = { name: 'sample.png', mime: 'image/png' }) => {
    const response = await fetch(`${running.url}/api/assets?name=${encodeURIComponent(source.name)}&mime=${encodeURIComponent(source.mime)}${query}`, { method: 'POST', body: typeof body === 'string' ? body : new Uint8Array(body), headers: { Authorization: `Bearer ${bootstrap.token}` } });
    const value = await response.json(); assert.equal(response.status, expected, JSON.stringify(value)); return value as Asset;
  };
  return { root, call, session, state, sendTask, upload, get running() { return running; }, get token() { return bootstrap.token; }, async restart() { await running.close(); running = await startServer({ root, port: 0, maxUploadBytes }); bootstrap = await (await fetch(`${running.url}/api/bootstrap`)).json(); } };
}

test('saved drafts are session-specific; duplicate send returns one immutable snapshot', async (t) => {
  const f = await fixture(t), a = await f.session('A'), b = await f.session('B');
  const asset = await f.upload('image bytes');
  const created = await f.call('/api/board/operations', 'POST', { sessionId: a.id, operations: [{ type: 'create', object: { assetId: asset.id, x: 10, y: 20, width: 200, height: 100 } }] });
  const object = created.objects[0];
  const initial = (await f.state(a.id)).draft;
  const saved = await f.call(`/api/sessions/${a.id}/draft`, 'PUT', { ...initial, text: 'Make it brighter', attachments: [asset.id], annotations: [{ id: 'local-note', scope: 'object', coordinateSpace: 'normalized', objectId: object.id, objectIds: [object.id], assetId: asset.id, bounds: { x: .2, y: .1, width: .3, height: .4 }, text: 'Brighter here' }] });
  const sends = await Promise.all([f.call(`/api/sessions/${a.id}/tasks`, 'POST', { draftId: saved.id, expectedRevision: saved.revision }), f.call(`/api/sessions/${a.id}/tasks`, 'POST', { draftId: saved.id, expectedRevision: saved.revision })]);
  assert.equal(sends[0].task.id, sends[1].task.id); assert.notEqual(sends[0].draft.id, saved.id);
  await f.call(`/api/sessions/${a.id}/draft`, 'PUT', saved, 409);
  assert.equal((await f.state(b.id)).draft.text, ''); assert.equal((await f.state(b.id)).tasks.length, 0);
  await f.call(`/api/sessions/${b.id}/tasks`, 'POST', { draftId: saved.id }, 409);
  await f.call('/api/board/operations', 'POST', { sessionId: b.id, operations: [{ type: 'delete', objectId: object.id, expectedVersion: 1 }] });
  const task = await f.call(`/api/sessions/${a.id}/tasks/${sends[0].task.id}`);
  assert.equal(task.snapshot.userRequest.source, 'user_instruction'); assert.equal(task.snapshot.referenceContent.source, 'reference_content');
  assert.equal(task.snapshot.annotations[0].text, 'Brighter here'); assert.equal(task.snapshot.referenceContent.objects[0].x, 10);
  assert.equal((await f.state(a.id)).annotations.length, 1);
  const bytes = await fetch(`${f.running.url}/api/assets/${asset.id}/content`, { headers: { Authorization: `Bearer ${f.token}` } }); assert.equal(await bytes.text(), 'image bytes');
});

test('one consumer per session and parallel FIFO sessions; empty claim leaves later tasks queued', async (t) => {
  const f = await fixture(t), a = await f.session('A'), b = await f.session('B');
  const first = await f.sendTask(a.id, 'first'), second = await f.sendTask(a.id, 'second'), other = await f.sendTask(b.id, 'other');
  const concurrent = await Promise.all(['one', 'two'].map(async (consumerId) => { const response = await fetch(`${f.running.url}/api/sessions/${a.id}/claim`, { method: 'POST', headers: { Authorization: `Bearer ${f.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ consumerId }) }); return { status: response.status, data: await response.json() }; }));
  assert.deepEqual(concurrent.map((result) => result.status).sort(), [200, 409]);
  const owner = concurrent.find((result) => result.status === 200)!.data as Claim;
  assert.equal(owner.task!.id, first.id);
  const parallel = await f.call(`/api/sessions/${b.id}/claim`, 'POST', { consumerId: 'other' }); assert.equal(parallel.task.id, other.id);
  await f.call(`/api/sessions/${a.id}/tasks/${first.id}/complete`, 'POST', { consumerId: owner.consumerId, runId: owner.run!.id, summary: 'First delivered', assetIds: [], validation: ['Text reviewed'], operations: [] });
  await f.call(`/api/sessions/${a.id}/claim`, 'POST', { consumerId: 'new-owner' }, 409);
  const next = await f.call(`/api/sessions/${a.id}/claim`, 'POST', { consumerId: owner.consumerId }); assert.equal(next.task.id, second.id);
  await f.call(`/api/sessions/${a.id}/tasks/${second.id}/complete`, 'POST', { consumerId: owner.consumerId, runId: next.run.id, summary: 'Second delivered', assetIds: [], validation: [], operations: [] });
  const empty = await f.call(`/api/sessions/${a.id}/claim`, 'POST', { consumerId: owner.consumerId }); assert.equal(empty.task, null);
  assert.equal((await f.state(a.id)).session.consumerId, null);
  const third = await f.sendTask(a.id, 'later'); assert.equal(third.status, 'queued');
  const afterEmpty = await f.call(`/api/sessions/${a.id}/claim`, 'POST', { consumerId: 'new-owner' }); assert.equal(afterEmpty.task.id, third.id);
});

test('resume reads existing outputs; stale attempts are retained and cannot publish', async (t) => {
  const f = await fixture(t), session = await f.session(), task = await f.sendTask(session.id);
  const claim = await f.call(`/api/sessions/${session.id}/claim`, 'POST', { consumerId: 'old-agent' });
  const output = await f.upload('generated bytes', `&sessionId=${session.id}&taskId=${task.id}&runId=${claim.run.id}&consumerId=old-agent`);
  await f.call(`/api/sessions/${session.id}/tasks/${task.id}/progress`, 'POST', { runId: claim.run.id, consumerId: 'old-agent', message: 'Output saved', externalJobId: 'provider-job-1', assetIds: [output.id] });
  await f.call(`/api/sessions/${session.id}/tasks/${task.id}/block`, 'POST', { runId: claim.run.id, consumerId: 'old-agent', reason: 'Confirm placement' });
  await f.call(`/api/sessions/${session.id}/claim`, 'POST', { consumerId: 'new-agent' }, 409);
  await f.call(`/api/sessions/${session.id}/tasks/${task.id}/reply`, 'POST', { text: 'Place at the right' });
  const resumed = await f.call(`/api/sessions/${session.id}/tasks/${task.id}/resume`, 'POST', { consumerId: 'new-agent', expectedRunId: claim.run.id, resolution: 'The saved file is complete; reuse it. External job is finished.' });
  assert.notEqual(resumed.run.id, claim.run.id); assert.equal(resumed.task.runs[0].outputAssetIds[0], output.id); assert.equal(resumed.task.replies.length, 1);
  const operations = [{ type: 'create', object: { assetId: output.id, x: 400, y: 0, width: 200, height: 150 } }];
  await f.call(`/api/sessions/${session.id}/tasks/${task.id}/complete`, 'POST', { consumerId: 'old-agent', runId: claim.run.id, summary: 'Late result', assetIds: [output.id], validation: [], operations }, 409);
  assert.equal((await f.state(session.id)).objects.length, 0);
  const completed = await f.call(`/api/sessions/${session.id}/tasks/${task.id}/complete`, 'POST', { consumerId: 'new-agent', runId: resumed.run.id, summary: 'Reference delivered', assetIds: [output.id], validation: ['Bytes reviewed'], operations });
  assert.equal(completed.status, 'completed'); assert.equal(completed.lateResults.length, 1); assert.equal(completed.receipt.objectIds.length, 1);
  const repeated = await f.call(`/api/sessions/${session.id}/tasks/${task.id}/complete`, 'POST', { consumerId: 'new-agent', runId: resumed.run.id, summary: 'Reference delivered', assetIds: [output.id], validation: [], operations });
  assert.equal(repeated.receipt.objectIds[0], completed.receipt.objectIds[0]); assert.equal((await f.state(session.id)).objects.length, 1);
});

test('object CAS rolls back a whole board or publication transaction', async (t) => {
  const f = await fixture(t), session = await f.session(), asset = await f.upload('reference');
  const created = await f.call('/api/board/operations', 'POST', { sessionId: session.id, operations: [0, 1].map((x) => ({ type: 'create', object: { assetId: asset.id, x, y: 0, width: 100, height: 100 } })) });
  const a = created.objects.find((object: any) => object.x === 0), b = created.objects.find((object: any) => object.x === 1);
  await f.call('/api/board/operations', 'POST', { sessionId: session.id, operations: [{ type: 'update', objectId: b.id, expectedVersion: 1, changes: { x: 300 } }] });
  const operations = [{ type: 'update', objectId: a.id, expectedVersion: 1, changes: { x: 500 } }, { type: 'update', objectId: b.id, expectedVersion: 1, changes: { x: 500 } }];
  await f.call('/api/board/operations', 'POST', { sessionId: session.id, operations }, 409);
  assert.equal((await f.state(session.id)).objects.find((object: any) => object.id === a.id).x, 0);
  const task = await f.sendTask(session.id), claim = await f.call(`/api/sessions/${session.id}/claim`, 'POST', { consumerId: 'agent' });
  await f.call(`/api/sessions/${session.id}/tasks/${task.id}/complete`, 'POST', { runId: claim.run.id, consumerId: 'agent', summary: 'Updated', assetIds: [], validation: [], operations }, 409);
  const current = await f.call(`/api/sessions/${session.id}/tasks/${task.id}`); assert.equal(current.status, 'running'); assert.equal(current.receipt, null);
  assert.equal((await f.state(session.id)).objects.find((object: any) => object.id === a.id).version, 1);
});

test('media byte ranges, authentication, origins, hostile attachments and path boundaries', async (t) => {
  const f = await fixture(t), asset = await f.upload('0123456789');
  const bootstrap = await fetch(`${f.running.url}/api/bootstrap`); const cookie = bootstrap.headers.get('set-cookie')!.split(';')[0];
  const read = await fetch(`${f.running.url}/api/assets/${asset.id}/content`, { headers: { Cookie: cookie, Range: 'bytes=2-5' } });
  assert.equal(read.status, 206); assert.equal(read.headers.get('content-range'), 'bytes 2-5/10'); assert.equal(await read.text(), '2345');
  const suffix = await fetch(`${f.running.url}/api/assets/${asset.id}/content`, { headers: { Authorization: `Bearer ${f.token}`, Range: 'bytes=-2' } }); assert.equal(await suffix.text(), '89');
  const bad = await fetch(`${f.running.url}/api/assets/${asset.id}/content`, { headers: { Cookie: cookie, Range: 'bytes=100-' } }); assert.equal(bad.status, 416);
  assert.equal((await fetch(`${f.running.url}/api/assets/${asset.id}/content`)).status, 401);
  assert.equal((await fetch(`${f.running.url}/api/sessions`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: '{"name":"Cookie write"}' })).status, 401);
  assert.equal((await fetch(`${f.running.url}/api/bootstrap`, { headers: { Origin: 'https://example.com' } })).status, 403);
  assert.equal((await fetch(`${f.running.url}/api/bootstrap`, { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  assert.equal((await fetch(`${f.running.url}/api/sessions`, { method: 'POST', headers: { Authorization: `Bearer ${f.token}`, Origin: 'null', 'Content-Type': 'application/json' }, body: '{"name":"Null"}' })).status, 403);
  const hostileHost = await new Promise<number>((resolvePromise, reject) => { const request = rawRequest(`${f.running.url}/api/bootstrap`, { headers: { Host: 'evil.example' } }, (response) => { response.resume(); response.on('end', () => resolvePromise(response.statusCode!)); }); request.on('error', reject); request.end(); });
  assert.equal(hostileHost, 403);
  assert.equal((await fetch(`${f.running.url}/api/assets/%2e%2e%2fprivate/content`, { headers: { Cookie: cookie } })).status, 404);
  const htmlResponse = await fetch(`${f.running.url}/api/assets?name=hostile.html&mime=text/html`, { method: 'POST', headers: { Authorization: `Bearer ${f.token}` }, body: '<script>fetch("/api/bootstrap")</script>' }); const html = await htmlResponse.json();
  const htmlRead = await fetch(`${f.running.url}/api/assets/${html.id}/content`, { headers: { Cookie: cookie } }); assert.match(htmlRead.headers.get('content-disposition')!, /^attachment/); assert.equal(htmlRead.headers.get('content-type'), 'application/octet-stream');
  const svgResponse = await fetch(`${f.running.url}/api/assets?name=hostile.svg&mime=image/svg%2Bxml`, { method: 'POST', headers: { Authorization: `Bearer ${f.token}` }, body: '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>' }); const svg = await svgResponse.json();
  const svgRead = await fetch(`${f.running.url}/api/assets/${svg.id}/content`, { headers: { Cookie: cookie } }); assert.match(svgRead.headers.get('content-security-policy')!, /sandbox/); assert.equal(svgRead.headers.get('x-content-type-options'), 'nosniff');
  const outside = join(tmpdir(), `acanvas-outside-${asset.id}`); await writeFile(outside, '0123456789'); t.after(() => rm(outside, { force: true }));
  const path = f.running.service.assetPath(asset.id); await rm(path); await symlink(outside, path);
  assert.equal((await fetch(`${f.running.url}/api/assets/${asset.id}/content`, { headers: { Cookie: cookie } })).status, 403);
});

test('overlimit and aborted upload discard partial files; complete uploads survive restart', async (t) => {
  const f = await fixture(t, 20);
  await f.upload('a'.repeat(21), '', 413);
  await new Promise<void>((resolvePromise) => {
    const request = rawRequest(`${f.running.url}/api/assets?name=large.mp4&mime=video/mp4`, { method: 'POST', headers: { Authorization: `Bearer ${f.token}`, 'Content-Length': 20 } });
    request.on('error', () => resolvePromise()); request.on('close', () => resolvePromise());
    request.write('partial'); setTimeout(() => request.destroy(), 30);
  });
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  assert.deepEqual(await readdir(join(f.root, '.acanvas', 'tmp')), []); assert.equal(f.running.service.assets().length, 0);
  const complete = await f.upload('complete'); const session = await f.session(); const task = await f.sendTask(session.id);
  const claim = await f.call(`/api/sessions/${session.id}/claim`, 'POST', { consumerId: 'agent' });
  await f.call(`/api/sessions/${session.id}/tasks/${task.id}/progress`, 'POST', { consumerId: 'agent', runId: claim.run.id, message: 'Read the file' });
  await f.restart();
  const after = await f.state(session.id); assert.equal(after.tasks[0].status, 'interrupted'); assert.equal(after.tasks[0].runs[0].progress.length, 1);
  assert.equal(after.assets[0].id, complete.id); assert.equal(after.session.consumerId, null);
  await f.call(`/api/sessions/${session.id}/claim`, 'POST', { consumerId: 'new' }, 409);
  const resumed = await f.call(`/api/sessions/${session.id}/tasks/${task.id}/resume`, 'POST', { consumerId: 'new', expectedRunId: claim.run.id, resolution: 'No external operation started; continue from saved progress.' }); assert.equal(resumed.task.status, 'running');
});

test('CLI checks project identity and executes read/import/complete against the HTTP service', async (t) => {
  const f = await fixture(t), args = ['--project', f.root, '--url', f.running.url];
  const session = await cli(['session', 'create', '--name', 'Agent', ...args]) as any;
  const assetFile = join(f.root, 'reference.png'); await writeFile(assetFile, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aJ1QAAAAASUVORK5CYII=', 'base64'));
  const source = await cli(['asset', 'import', '--file', assetFile, '--mime', 'image/png', ...args]) as Asset;
  const state = await cli(['session', 'read', '--session', session.id, ...args]) as any;
  const draftFile = join(f.root, 'draft.json'); await writeFile(draftFile, JSON.stringify({ ...state.draft, text: 'Copy this reference into a new whiteboard image.', attachments: [source.id] }));
  const saved = await cli(['draft', 'save', '--session', session.id, '--input', draftFile, ...args]) as Draft;
  const sent = await cli(['draft', 'send', '--session', session.id, '--draft', state.draft.id, '--revision', String(saved.revision), ...args]) as any;
  const claimed = await cli(['task', 'next', '--session', session.id, '--consumer', 'cli-agent', ...args]) as Claim;
  const read = await cli(['task', 'read', '--session', session.id, '--task', sent.task.id, ...args]) as any; assert.equal(read.task.snapshot.referenceContent.assets[0].id, source.id);
  const downloaded = join(f.root, 'downloaded.png'); await cli(['asset', 'read', '--asset', source.id, '--out', downloaded, ...args]);
  const generated = join(f.root, 'generated.png'); await writeFile(generated, await readFile(downloaded));
  const identity = ['--session', session.id, '--task', sent.task.id, '--run', claimed.run!.id, '--consumer', 'cli-agent'];
  const output = await cli(['asset', 'import', '--file', generated, '--mime', 'image/png', ...identity, ...args]) as Asset;
  const completionFile = join(f.root, 'complete.json'); await writeFile(completionFile, JSON.stringify({ summary: 'Copied the supplied reference into a separate asset.', assetIds: [output.id], validation: ['Downloaded and copied the exact source bytes.'], operations: [{ type: 'create', object: { assetId: output.id, x: 200, y: 100, width: 320, height: 240 } }] }));
  const done = await cli(['task', 'complete', '--input', completionFile, ...identity, ...args]) as Task; assert.equal(done.status, 'completed'); assert.equal(done.receipt!.assetIds[0], output.id);
  const empty = await cli(['task', 'next', '--session', session.id, '--consumer', 'cli-agent', ...args]) as Claim; assert.equal(empty.task, null);
  const otherRoot = await mkdtemp(join(tmpdir(), 'acanvas-other-')); t.after(() => rm(otherRoot, { recursive: true, force: true }));
  await assert.rejects(cli(['session', 'create', '--name', 'Wrong project', '--project', otherRoot, '--url', f.running.url]), /another project/);
  assert.equal((await f.call('/api/sessions')).length, 1);
});

test('a project has one service owner and persisted views/drafts survive a restart', async (t) => {
  const f = await fixture(t), session = await f.session(), draft = (await f.state(session.id)).draft;
  await f.call(`/api/sessions/${session.id}/view`, 'PUT', { x: 100, y: 200, zoom: 2, selectedObjectIds: [] });
  await f.call(`/api/sessions/${session.id}/draft`, 'PUT', { ...draft, text: 'Saved for later' });
  const workerSession = await f.session('Active worker'), task = await f.sendTask(workerSession.id);
  const run = await f.call(`/api/sessions/${workerSession.id}/claim`, 'POST', { consumerId: 'active-worker' });
  await assert.rejects(startServer({ root: f.root, port: 0 }), /active local service/);
  const active = await f.state(workerSession.id); assert.equal(active.session.consumerId, 'active-worker'); assert.equal(active.tasks[0].status, 'running'); assert.equal(active.tasks[0].id, task.id); assert.equal(active.tasks[0].currentRunId, run.run.id);
  await f.restart(); const state = await f.state(session.id); assert.equal(state.draft.text, 'Saved for later'); assert.equal(state.draft.id, draft.id); assert.equal(state.session.view.zoom, 2);
  await f.call(`/api/sessions/${workerSession.id}/claim`, 'POST', { consumerId: 'active-worker' }, 409);
  const recovered = await f.state(workerSession.id); assert.equal(recovered.tasks[0].status, 'interrupted'); assert.equal(recovered.tasks[0].currentRunId, run.run.id);
});

test('cancelling a later queued task preserves the active consumer', async (t) => {
  const f = await fixture(t), session = await f.session();
  const first = await f.sendTask(session.id, 'Running work'), second = await f.sendTask(session.id, 'Queued work');
  const claimed = await f.call(`/api/sessions/${session.id}/claim`, 'POST', { consumerId: 'worker' });
  await f.call(`/api/sessions/${session.id}/tasks/${second.id}/cancel`, 'POST', { reason: 'Withdraw the queued request' });
  assert.equal((await f.state(session.id)).session.consumerId, 'worker');
  const completed = await f.call(`/api/sessions/${session.id}/tasks/${first.id}/complete`, 'POST', { consumerId: 'worker', runId: claimed.run.id, summary: 'Completed current work', assetIds: [], validation: [], operations: [] });
  assert.equal(completed.status, 'completed');
});

test('empty claim and draft send overlap with a persistent queued or running outcome', async (t) => {
  const f = await fixture(t), session = await f.session(), draft = (await f.state(session.id)).draft;
  const saved = await f.call(`/api/sessions/${session.id}/draft`, 'PUT', { ...draft, text: 'Added at the idle boundary' });
  const [claim, sent] = await Promise.all([
    f.call(`/api/sessions/${session.id}/claim`, 'POST', { consumerId: 'worker' }),
    f.call(`/api/sessions/${session.id}/tasks`, 'POST', { draftId: draft.id, expectedRevision: saved.revision }),
  ]);
  const state = await f.state(session.id);
  assert.equal(state.tasks.length, 1); assert.equal(state.tasks[0].id, sent.task.id);
  if (claim.task) { assert.equal(claim.task.id, sent.task.id); assert.equal(state.tasks[0].status, 'running'); assert.equal(state.session.consumerId, 'worker'); }
  else { assert.equal(state.tasks[0].status, 'queued'); assert.equal(state.session.consumerId, null); }
});

test('concurrent draft writes use revisions and stale send preserves the latest saved draft', async (t) => {
  const f = await fixture(t), session = await f.session(), draft = (await f.state(session.id)).draft;
  const results = await Promise.all(['A', 'B'].map(async (message) => {
    const response = await fetch(`${f.running.url}/api/sessions/${session.id}/draft`, { method: 'PUT', headers: { Authorization: `Bearer ${f.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ ...draft, text: message }) }); return { status: response.status, body: await response.json() };
  }));
  assert.deepEqual(results.map((result) => result.status).sort(), [200, 409]);
  assert.equal(results.find((result) => result.status === 409)!.body.error.code, 'draft_revision_conflict');
  const saved = (await f.state(session.id)).draft; assert.equal(saved.revision, draft.revision + 1);
  await f.call(`/api/sessions/${session.id}/tasks`, 'POST', { draftId: saved.id, expectedRevision: draft.revision }, 409);
  assert.equal((await f.state(session.id)).tasks.length, 0);
  const task = await f.call(`/api/sessions/${session.id}/tasks`, 'POST', { draftId: saved.id, expectedRevision: saved.revision });
  assert.equal(task.task.snapshot.userRequest.text, saved.text);
});

test('completion derives published assets and rejects cross-task and omitted receipt references atomically', async (t) => {
  const f = await fixture(t), a = await f.session('A'), b = await f.session('B');
  const taskA = await f.sendTask(a.id), taskB = await f.sendTask(b.id);
  const claimA = await f.call(`/api/sessions/${a.id}/claim`, 'POST', { consumerId: 'agentA' }), claimB = await f.call(`/api/sessions/${b.id}/claim`, 'POST', { consumerId: 'agentB' });
  const outputA = await f.upload('A output', `&sessionId=${a.id}&taskId=${taskA.id}&runId=${claimA.run.id}&consumerId=agentA`);
  const outputB = await f.upload('B output', `&sessionId=${b.id}&taskId=${taskB.id}&runId=${claimB.run.id}&consumerId=agentB`);
  const reference = await f.upload('ordinary reference');
  const operation = (assetId: string) => ({ type: 'create', object: { assetId, x: 0, y: 0, width: 100, height: 100 } });
  const completion = { consumerId: 'agentB', runId: claimB.run.id, summary: 'Published', assetIds: [], validation: [] };
  const completePath = `/api/sessions/${b.id}/tasks/${taskB.id}/complete`;
  for (const asset of [outputA, reference]) { const error = await f.call(completePath, 'POST', { ...completion, operations: [operation(outputB.id), operation(asset.id)], assetIds: [outputB.id] }, 409); assert.equal(error.error.code, 'output_ownership'); }
  const omitted = await f.call(completePath, 'POST', { ...completion, operations: [operation(outputB.id)] }, 409); assert.equal(omitted.error.code, 'receipt_assets_missing');
  const before = await f.state(b.id); assert.equal(before.objects.length, 0); assert.equal(before.tasks[0].status, 'running'); assert.equal(before.tasks[0].receipt, null);
  const done = await f.call(completePath, 'POST', { ...completion, assetIds: [outputB.id], operations: [operation(outputB.id)] });
  assert.equal(done.status, 'completed'); assert.deepEqual(done.receipt.assetIds, [outputB.id]);
  assert.equal((await f.state(b.id)).objects[0].sourceTaskId, taskB.id);
  const layoutTask = await f.sendTask(b.id, 'Move the existing result');
  const layoutClaim = await f.call(`/api/sessions/${b.id}/claim`, 'POST', { consumerId: 'agentB' });
  const object = (await f.state(b.id)).objects[0];
  const layout = await f.call(`/api/sessions/${b.id}/tasks/${layoutTask.id}/complete`, 'POST', { consumerId: 'agentB', runId: layoutClaim.run.id, summary: 'Moved the saved result', assetIds: [], validation: [], operations: [{ type: 'update', objectId: object.id, expectedVersion: object.version, changes: { x: 40 } }] });
  assert.equal(layout.status, 'completed'); assert.deepEqual(layout.receipt.assetIds, []);
  assert.equal((await f.state(b.id)).objects[0].sourceTaskId, taskB.id);
});

test('session resume transfers a settled queue by expected owner and retains running-attempt ownership', async (t) => {
  const f = await fixture(t), session = await f.session(), first = await f.sendTask(session.id, 'First'), second = await f.sendTask(session.id, 'Second');
  const claimed = await f.call(`/api/sessions/${session.id}/claim`, 'POST', { consumerId: 'old' });
  await f.call(`/api/sessions/${session.id}/resume`, 'POST', { consumerId: 'new', expectedConsumerId: 'old', resolution: 'Continue queue' }, 409);
  await f.call(`/api/sessions/${session.id}/tasks/${first.id}/complete`, 'POST', { consumerId: 'old', runId: claimed.run.id, summary: 'First complete', assetIds: [], validation: [], operations: [] });
  const args = ['--project', f.root, '--url', f.running.url, '--session', session.id];
  const resumed = await cli(['session', 'resume', '--consumer', 'new', '--expected-consumer', 'old', '--resolution', 'First task receipt is complete. Continue queued work.', ...args]) as any;
  assert.equal(resumed.consumerId, 'new');
  await f.call(`/api/sessions/${session.id}/resume`, 'POST', { consumerId: 'third', expectedConsumerId: 'old', resolution: 'Stale transfer' }, 409);
  await f.call(`/api/sessions/${session.id}/claim`, 'POST', { consumerId: 'old' }, 409);
  const next = await cli(['task', 'next', '--consumer', 'new', ...args]) as Claim; assert.equal(next.task!.id, second.id);
  await f.call(`/api/sessions/${session.id}/tasks/${second.id}/block`, 'POST', { consumerId: 'new', runId: next.run!.id, reason: 'Needs confirmation' });
  await f.call(`/api/sessions/${session.id}/resume`, 'POST', { consumerId: 'third', expectedConsumerId: 'new', resolution: 'Continue' }, 409);
  const recovered = await f.call(`/api/sessions/${session.id}/tasks/${second.id}/resume`, 'POST', { consumerId: 'third', expectedRunId: next.run!.id, resolution: 'Reviewed the blocked request; continue.' });
  await f.call(`/api/sessions/${session.id}/tasks/${second.id}/interrupt`, 'POST', { consumerId: 'third', runId: recovered.run.id, reason: 'External result needs checking' });
  await f.call(`/api/sessions/${session.id}/resume`, 'POST', { consumerId: 'fourth', expectedConsumerId: 'third', resolution: 'Continue' }, 409);
});

test('idle and transferred consumers stay retired across later enqueue and claim calls', async (t) => {
  const f = await fixture(t), session = await f.session(), first = await f.sendTask(session.id);
  const claimed = await f.call(`/api/sessions/${session.id}/claim`, 'POST', { consumerId: 'old' });
  await f.call(`/api/sessions/${session.id}/tasks/${first.id}/complete`, 'POST', { consumerId: 'old', runId: claimed.run.id, summary: 'Complete', assetIds: [], validation: [], operations: [] });
  await f.call(`/api/sessions/${session.id}/resume`, 'POST', { consumerId: 'new', expectedConsumerId: 'old', resolution: 'Continue after reviewing the completed receipt' });
  await f.call(`/api/sessions/${session.id}/claim`, 'POST', { consumerId: 'old' }, 409);
  assert.equal((await f.state(session.id)).session.consumerId, 'new');
  const empty = await f.call(`/api/sessions/${session.id}/claim`, 'POST', { consumerId: 'new' }); assert.equal(empty.task, null);
  assert.equal((await f.state(session.id)).session.consumerId, null);
  await f.sendTask(session.id, 'Added after idle');
  for (const consumerId of ['old', 'new']) { const error = await f.call(`/api/sessions/${session.id}/claim`, 'POST', { consumerId }, 409); assert.equal(error.error.code, 'consumer_retired'); }
  const fresh = await cli(['task', 'next', '--session', session.id, '--project', f.root, '--url', f.running.url]) as Claim;
  assert.equal(fresh.task!.status, 'running'); assert.notEqual(fresh.consumerId, 'old'); assert.notEqual(fresh.consumerId, 'new'); assert.equal(fresh.sessionId, session.id);
});

test('importing the CLI from another cli.js process leaves command execution to its caller', async () => {
  const { stdout, stderr } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', `process.argv[1]='/tmp/another-tool/cli.js'; process.argv.push('--bad-option'); await import('./dist/src/cli.js'); console.log('imported');`]);
  assert.equal(stdout.trim(), 'imported'); assert.equal(stderr, '');
});

test('Node 24 SQLite lifecycle survives repeated open/claim/complete/close and garbage collection', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'acanvas-native-lifecycle-')); t.after(() => rm(root, { recursive: true, force: true }));
  const code = `import {CanvasService} from './dist/src/server/service.js'; for(let index=0;index<25;index++){let service=new CanvasService(${JSON.stringify(root)});const session=service.createSession('Run '+index);const draft=service.draft(session.id);const saved=service.saveDraft(session.id,{...draft,text:'Deliver text'});const {task}=service.sendDraft(session.id,saved.id,saved.revision);const claim=service.claim(session.id,'node24');service.complete(session.id,task.id,{runId:claim.run.id,consumerId:'node24',summary:'Delivered',assetIds:[],validation:[],operations:[]});service.close();service=null;global.gc();}console.log('25 lifecycle cycles passed');`;
  const { stdout, stderr } = await promisify(execFile)(process.execPath, ['--expose-gc', '--input-type=module', '-e', code]);
  assert.match(stdout, /25 lifecycle cycles passed/); assert.equal(stderr, '');
});

test('service shutdown ends active SSE and incomplete uploads before closing SQLite', async (t) => {
  const f = await fixture(t);
  const stream = await fetch(`${f.running.url}/api/events`, { headers: { Authorization: `Bearer ${f.token}` } });
  const reader = stream.body!.getReader(); assert.match(new TextDecoder().decode((await reader.read()).value), /event: ready/);
  const uploadStopped = new Promise<void>((resolvePromise) => {
    const request = rawRequest(`${f.running.url}/api/assets?name=pending.mp4&mime=video/mp4`, { method: 'POST', headers: { Authorization: `Bearer ${f.token}`, 'Content-Length': 1000000 } });
    request.on('error', () => resolvePromise()); request.on('close', () => resolvePromise()); request.write('partial upload');
  });
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 30));
  const started = Date.now(); await f.restart(); assert.ok(Date.now() - started < 2000, 'HTTP shutdown must drain promptly');
  await uploadStopped; assert.equal((await reader.read()).done, true);
  assert.deepEqual(await readdir(join(f.root, '.acanvas', 'tmp')), []); assert.equal(f.running.service.assets().length, 0);
  const session = await f.session('Restarted'); assert.equal((await f.state(session.id)).tasks.length, 0);
});

test('production Node 24 process recovers after a crash and exits normally with active SSE', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'acanvas-production-lifecycle-'));
  let child: ChildProcess | undefined, token = '', url = '';
  t.after(async () => { if (child && child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await new Promise<void>((resolvePromise) => child!.once('exit', () => resolvePromise())); } await rm(root, { recursive: true, force: true }); });
  const start = async () => {
    child = spawn(process.execPath, ['dist/src/server/main.js', '--project', root, '--port', '0'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', errors = '';
    child.stderr!.on('data', (chunk) => { errors += chunk.toString(); });
    url = await new Promise<string>((resolvePromise, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Production service startup timed out: ${errors}`)), 5000);
      child!.once('error', (error) => { clearTimeout(timeout); reject(error); });
      child!.once('exit', () => { clearTimeout(timeout); reject(new Error(`Production service ended during startup: ${errors}`)); });
      child!.stdout!.on('data', (chunk) => { output += chunk.toString(); const match = output.match(/acanvas: (http:\/\/127\.0\.0\.1:\d+)/); if (match) { clearTimeout(timeout); resolvePromise(match[1]); } });
    });
    token = (await (await fetch(`${url}/api/bootstrap`)).json()).token;
  };
  const call = async (path: string, method = 'GET', body?: unknown, expected = 200) => {
    const response = await fetch(`${url}${path}`, { method, headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const value = await response.json(); assert.equal(response.status, expected, JSON.stringify(value)); return value;
  };
  const stop = async (signal: 'SIGTERM' | 'SIGKILL') => {
    const ended = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolvePromise) => child!.once('exit', (code, signalCode) => resolvePromise({ code, signal: signalCode })));
    const started = Date.now(); child!.kill(signal); const result = await ended;
    assert.ok(Date.now() - started < 2000, 'The production process must close promptly');
    if (signal === 'SIGTERM') { assert.equal(result.code, 0); assert.equal(result.signal, null); } else assert.equal(result.signal, 'SIGKILL');
  };
  await start();
  const session = await call('/api/sessions', 'POST', { name: 'Production recovery' }, 201), draft = (await call(`/api/state?sessionId=${session.id}`)).draft;
  const saved = await call(`/api/sessions/${session.id}/draft`, 'PUT', { ...draft, text: 'Save a text delivery receipt' });
  const sent = await call(`/api/sessions/${session.id}/tasks`, 'POST', { draftId: saved.id, expectedRevision: saved.revision });
  const claimed = await call(`/api/sessions/${session.id}/claim`, 'POST', { consumerId: 'before-crash' });
  await call(`/api/sessions/${session.id}/tasks/${sent.task.id}/progress`, 'POST', { consumerId: 'before-crash', runId: claimed.run.id, message: 'Read the request; no external job started.' });
  await stop('SIGKILL');
  await start();
  const interrupted = await call(`/api/state?sessionId=${session.id}`); assert.equal(interrupted.tasks[0].status, 'interrupted'); assert.equal(interrupted.tasks[0].runs[0].progress.length, 1);
  await call(`/api/sessions/${session.id}/claim`, 'POST', { consumerId: 'before-crash' }, 409);
  const resumed = await call(`/api/sessions/${session.id}/tasks/${sent.task.id}/resume`, 'POST', { consumerId: 'after-crash', expectedRunId: claimed.run.id, resolution: 'Saved progress confirms that no external operation started; continue with a text receipt.' });
  await call(`/api/sessions/${session.id}/tasks/${sent.task.id}/complete`, 'POST', { consumerId: 'after-crash', runId: resumed.run.id, summary: 'Text delivery recorded', assetIds: [], validation: ['Saved request reviewed'], operations: [] });
  const stream = await fetch(`${url}/api/events`, { headers: { Authorization: `Bearer ${token}` } }); const reader = stream.body!.getReader(); await reader.read();
  await stop('SIGTERM'); assert.equal((await reader.read()).done, true);
  await start(); const completed = await call(`/api/state?sessionId=${session.id}`); assert.equal(completed.tasks[0].status, 'completed'); assert.equal(completed.tasks[0].receipt.summary, 'Text delivery recorded');
  const empty = await call(`/api/sessions/${session.id}/claim`, 'POST', { consumerId: 'new-activation' }); assert.equal(empty.task, null);
  await stop('SIGTERM');
});

test('waiting request editing retains FIFO identity, source references and the previous draft across restart', async t => {
  const f = await fixture(t), session = await f.session('Editing'), other = await f.session('Other');
  const asset = await f.upload('source reference');
  await f.call('/api/board/operations', 'POST', { sessionId: session.id, operations: [{ type: 'create', object: { id: 'edit-source', assetId: asset.id, x: 10, y: 20, width: 100, height: 80 } }] });
  const first = await f.sendTask(session.id, 'First request');
  let draft: Draft = (await f.state(session.id)).draft;
  draft = await f.call(`/api/sessions/${session.id}/draft`, 'PUT', { ...draft, text: 'Original request', attachments: [asset.id], references: { objectIds: ['edit-source'], taskIds: [first.id] }, annotations: [{ id: 'edit-note', scope: 'object', objectId: 'edit-source', objectIds: ['edit-source'], assetId: asset.id, bounds: { x: 0, y: 0, width: 1, height: 1 }, coordinateSpace: 'normalized', text: 'Source comment' }] });
  const target: Task = (await f.call(`/api/sessions/${session.id}/tasks`, 'POST', { draftId: draft.id, expectedRevision: draft.revision })).task;
  const last = await f.sendTask(session.id, 'Last request');
  draft = (await f.state(session.id)).draft;
  const previous: Draft = await f.call(`/api/sessions/${session.id}/draft`, 'PUT', { ...draft, text: 'Unsent next idea', attachments: [asset.id] });
  const edit = await f.call(`/api/sessions/${session.id}/tasks/${target.id}/edit`, 'POST', { draftId: previous.id, expectedRevision: previous.revision });
  assert.equal(edit.task.status, 'editing'); assert.equal(edit.draft.editingTaskId, target.id); assert.deepEqual(edit.task.snapshot, target.snapshot);
  assert.deepEqual((await f.call(`/api/sessions/${session.id}/tasks/${target.id}/edit`, 'POST', { draftId: previous.id, expectedRevision: previous.revision })).draft, edit.draft);
  const claimed: Claim = await f.call(`/api/sessions/${session.id}/claim`, 'POST', { consumerId: 'edit-consumer' }); assert.equal(claimed.task?.id, first.id);
  await f.call(`/api/sessions/${session.id}/tasks/${first.id}/complete`, 'POST', { consumerId: 'edit-consumer', runId: claimed.run!.id, summary: 'First complete', assetIds: [], validation: [], operations: [] });
  const paused = await f.call(`/api/sessions/${session.id}/claim`, 'POST', { consumerId: 'edit-consumer' }, 409); assert.equal(paused.error.code, 'queue_paused'); assert.equal(paused.error.details.taskId, target.id);
  await f.call(`/api/sessions/${other.id}/tasks/${target.id}/edit`, 'POST', { draftId: previous.id, expectedRevision: previous.revision }, 404);
  await f.restart(); assert.deepEqual((await f.state(session.id)).draft, edit.draft);
  const cancelled = await f.call(`/api/sessions/${session.id}/tasks/${target.id}/cancel-edit`, 'POST', { draftId: edit.draft.id, expectedRevision: edit.draft.revision });
  assert.equal(cancelled.draft.id, previous.id); assert.equal(cancelled.draft.text, previous.text); assert.deepEqual(cancelled.draft.attachments, previous.attachments); assert.equal(cancelled.task.status, 'queued'); assert.deepEqual(cancelled.task.snapshot, target.snapshot);
  const again = await f.call(`/api/sessions/${session.id}/tasks/${target.id}/edit`, 'POST', { draftId: cancelled.draft.id, expectedRevision: cancelled.draft.revision });
  const object = (await f.state(session.id)).objects[0];
  await f.call('/api/board/operations', 'POST', { sessionId: session.id, operations: [{ type: 'delete', objectId: object.id, expectedVersion: object.version }] });
  const saved: Draft = await f.call(`/api/sessions/${session.id}/draft`, 'PUT', { ...again.draft, text: 'Revised request', annotations: again.draft.annotations.map((annotation: any) => ({ ...annotation, text: 'Revised comment' })) });
  await f.call(`/api/sessions/${session.id}/draft`, 'PUT', { ...saved, revision: saved.revision - 1 }, 409);
  const submitted = await f.call(`/api/sessions/${session.id}/tasks`, 'POST', { draftId: saved.id, expectedRevision: saved.revision });
  assert.equal(submitted.task.id, target.id); assert.equal(submitted.task.sequence, target.sequence); assert.equal(submitted.task.status, 'queued'); assert.equal(submitted.task.snapshot.userRequest.text, 'Revised request'); assert.equal(submitted.task.snapshot.annotations[0].text, 'Revised comment'); assert.deepEqual(submitted.task.snapshot.referenceContent, target.snapshot.referenceContent);
  assert.equal(submitted.draft.id, previous.id); assert.equal(submitted.draft.text, previous.text);
  const repeated = await f.call(`/api/sessions/${session.id}/tasks`, 'POST', { draftId: saved.id, expectedRevision: saved.revision }); assert.equal(repeated.task.id, target.id); assert.deepEqual(repeated.draft, submitted.draft);
  assert.deepEqual((await f.state(session.id)).tasks.map((task: Task) => task.id), [first.id, target.id, last.id]);
  assert.equal((await f.call(`/api/sessions/${session.id}/claim`, 'POST', { consumerId: 'after-edit' })).task.id, target.id);
});

test('claim and edit share one reservation boundary while the losing action retains its content', async t => {
  const f = await fixture(t), session = await f.session('Edit race');
  const task = await f.sendTask(session.id, 'Race original'), draft: Draft = (await f.state(session.id)).draft;
  const request = (action: string, body: unknown) => fetch(`${f.running.url}/api/sessions/${session.id}/${action}`, { method: 'POST', headers: { Authorization: `Bearer ${f.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const responses = await Promise.all([request(`tasks/${task.id}/edit`, { draftId: draft.id, expectedRevision: draft.revision }), request('claim', { consumerId: 'race-consumer' })]);
  assert.deepEqual(responses.map(response => response.status).sort(), [200, 409]);
  const state = await f.state(session.id); assert.deepEqual(state.tasks[0].snapshot, task.snapshot);
  if (state.tasks[0].status === 'editing') { assert.equal(state.draft.text, task.snapshot.userRequest.text); assert.equal(state.tasks[0].runs.length, 0); }
  else { assert.equal(state.tasks[0].status, 'running'); assert.equal(state.draft.id, draft.id); assert.equal(state.tasks[0].runs.length, 1); }
});

test('request edit restores explicit references while annotation dependencies remain in the snapshot', async t => {
  const f = await fixture(t), session = await f.session('Annotation references');
  const assets = await Promise.all(['one', 'two', 'three', 'four', 'video frame'].map((value, index) => f.upload(value, '', 201, index === 3 ? { name: 'sample.mp4', mime: 'video/mp4' } : undefined)));
  const objects = assets.slice(0, 4).map((asset, index) => ({ id: `annotation-source-${index}`, assetId: asset.id, x: index * 120, y: 20, width: 100, height: 80 }));
  await f.call('/api/board/operations', 'POST', { sessionId: session.id, operations: objects.map(object => ({ type: 'create', object })) });
  const annotations = [
    { id: 'region-note', scope: 'region', coordinateSpace: 'world', objectIds: objects.slice(0, 3).map(object => object.id), bounds: { x: 0, y: 0, width: 400, height: 100 }, text: 'Three sources' },
    { id: 'object-note', scope: 'object', coordinateSpace: 'normalized', objectId: objects[3].id, objectIds: [objects[3].id], assetId: assets[3].id, snapshotAssetId: assets[4].id, timeStart: 4, bounds: { x: 0, y: 0, width: 1, height: 1 }, text: 'One source with frame' },
  ];
  const initial: Draft = (await f.state(session.id)).draft;
  const saved = await f.call(`/api/sessions/${session.id}/draft`, 'PUT', { ...initial, annotations });
  const sent: Task = (await f.call(`/api/sessions/${session.id}/tasks`, 'POST', { draftId: saved.id, expectedRevision: saved.revision })).task;
  assert.deepEqual(sent.snapshot.requestReferences, { attachmentIds: [], objectIds: [], taskIds: [], order: [] });
  assert.deepEqual(sent.snapshot.referenceContent.assets.map(asset => asset.id), assets.map(asset => asset.id));
  const ordinary: Draft = (await f.state(session.id)).draft;
  let edit = await f.call(`/api/sessions/${session.id}/tasks/${sent.id}/edit`, 'POST', { draftId: ordinary.id, expectedRevision: ordinary.revision });
  assert.deepEqual(edit.draft.attachments, []); assert.deepEqual(edit.draft.references.objectIds, []); assert.deepEqual(edit.draft.annotations, annotations);
  await f.restart(); assert.deepEqual((await f.state(session.id)).draft, edit.draft);
  const explicit = await f.call(`/api/sessions/${session.id}/draft`, 'PUT', { ...edit.draft, attachments: [assets[0].id], references: { objectIds: [objects[0].id], taskIds: [] } });
  const revised: Task = (await f.call(`/api/sessions/${session.id}/tasks`, 'POST', { draftId: explicit.id, expectedRevision: explicit.revision })).task;
  assert.deepEqual(revised.snapshot.requestReferences?.attachmentIds, [assets[0].id]); assert.deepEqual(revised.snapshot.requestReferences?.objectIds, [objects[0].id]);
  assert.deepEqual(revised.snapshot.requestReferences?.order?.map(({ kind, id }) => ({ kind, id })), [{ kind: 'object', id: objects[0].id }]);
  const current: Draft = (await f.state(session.id)).draft;
  edit = await f.call(`/api/sessions/${session.id}/tasks/${sent.id}/edit`, 'POST', { draftId: current.id, expectedRevision: current.revision });
  assert.deepEqual(edit.draft.attachments, [assets[0].id]); assert.deepEqual(edit.draft.references.objectIds, [objects[0].id]);
  const removed = await f.call(`/api/sessions/${session.id}/draft`, 'PUT', { ...edit.draft, annotations: [] });
  const final: Task = (await f.call(`/api/sessions/${session.id}/tasks`, 'POST', { draftId: removed.id, expectedRevision: removed.revision })).task;
  assert.deepEqual(final.snapshot.referenceContent.assets.map(asset => asset.id), [assets[0].id]);
  assert.deepEqual(final.snapshot.referenceContent.objects.map(object => object.id), [objects[0].id]);
  assert.equal(final.id, sent.id); assert.equal(final.sequence, sent.sequence);
});

test('earlier reference provenance and active edit additions remain available across restart', async t => {
  const f = await fixture(t), session = await f.session('Earlier request'), asset = await f.upload('source');
  await f.call('/api/board/operations', 'POST', { sessionId: session.id, operations: [{ type: 'create', object: { id: 'earlier-object', assetId: asset.id, x: 0, y: 0, width: 100, height: 80 } }] });
  const initial = (await f.state(session.id)).draft;
  const saved = await f.call(`/api/sessions/${session.id}/draft`, 'PUT', { ...initial, attachments: [asset.id], annotations: [{ id: 'earlier-note', scope: 'object', coordinateSpace: 'normalized', objectId: 'earlier-object', objectIds: ['earlier-object'], assetId: asset.id, bounds: { x: 0, y: 0, width: 1, height: 1 }, text: 'An explicitly attached source' }] });
  const task: Task = (await f.call(`/api/sessions/${session.id}/tasks`, 'POST', { draftId: saved.id, expectedRevision: saved.revision })).task;
  delete task.snapshot.requestReferences;
  task.snapshot.requirementText = generateRequirementText(task.snapshot);
  f.running.service.db.prepare('UPDATE tasks SET snapshot_json=? WHERE id=?').run(JSON.stringify(task.snapshot), task.id);
  const current = (await f.state(session.id)).draft;
  const edit = await f.call(`/api/sessions/${session.id}/tasks/${task.id}/edit`, 'POST', { draftId: current.id, expectedRevision: current.revision });
  assert.deepEqual(edit.draft.attachments, [asset.id]);
  const extra = await f.upload('added during editing');
  const modified = await f.call(`/api/sessions/${session.id}/draft`, 'PUT', { ...edit.draft, text: 'My unsent additions', attachments: [...edit.draft.attachments, extra.id] });
  await f.restart();
  const resumed = await f.call(`/api/sessions/${session.id}/tasks/${task.id}/edit`, 'POST', { draftId: modified.id, expectedRevision: modified.revision });
  assert.deepEqual(resumed.draft, modified); assert.deepEqual(resumed.task.snapshot, task.snapshot);
});

test('a user specified annotation-only correction preserves an earlier request and surrounding drafts', async t => {
  const f = await fixture(t), session = await f.session('Earlier annotation-only request');
  const prior = await f.sendTask(session.id, 'Related request');
  const assets = await Promise.all(['one', 'two', 'three', 'four'].map(value => f.upload(value)));
  const objects = assets.map((asset, index) => ({ id: `earlier-annotation-${index}`, assetId: asset.id, x: index * 120, y: 20, width: 100, height: 80 }));
  await f.call('/api/board/operations', 'POST', { sessionId: session.id, operations: objects.map(object => ({ type: 'create', object })) });
  const annotations: AnnotationInput[] = [
    { id: 'earlier-region', scope: 'region', coordinateSpace: 'world', objectIds: objects.slice(0, 3).map(object => object.id), bounds: { x: 0, y: 0, width: 400, height: 100 }, text: 'abc' },
    { id: 'earlier-single', scope: 'object', coordinateSpace: 'normalized', objectId: objects[3].id, objectIds: [objects[3].id], assetId: assets[3].id, bounds: { x: 0, y: 0, width: 1, height: 1 }, text: 'g' },
  ];
  const send = async (changes: Partial<Draft>) => {
    const draft = (await f.state(session.id)).draft;
    const saved = await f.call(`/api/sessions/${session.id}/draft`, 'PUT', { ...draft, ...changes });
    return (await f.call(`/api/sessions/${session.id}/tasks`, 'POST', { draftId: saved.id, expectedRevision: saved.revision })).task as Task;
  };
  const target = await send({ text: 'efg', annotations, references: { objectIds: [], taskIds: [prior.id] } });
  const overlap = await send({ text: 'Keep the explicit attachment', attachments: [assets[3].id], annotations: [annotations[1]] });
  for (const task of [target, overlap]) {
    delete task.snapshot.requestReferences;
    task.snapshot.requirementText = generateRequirementText(task.snapshot);
    f.running.service.db.prepare('UPDATE tasks SET snapshot_json=? WHERE id=?').run(JSON.stringify(task.snapshot), task.id);
  }
  let state = await f.state(session.id);
  const previous = await f.call(`/api/sessions/${session.id}/draft`, 'PUT', { ...state.draft, text: 'Unsent next idea', attachments: [assets[0].id], references: { objectIds: [objects[0].id], taskIds: [prior.id] } });
  const edit = await f.call(`/api/sessions/${session.id}/tasks/${target.id}/edit`, 'POST', { draftId: previous.id, expectedRevision: previous.revision });
  assert.deepEqual(edit.draft.attachments, assets.map(asset => asset.id));
  const saved = await f.call(`/api/sessions/${session.id}/draft`, 'PUT', { ...edit.draft, attachments: [], references: { objectIds: [], taskIds: [prior.id], order: [{ kind: 'task', id: prior.id }] } });
  const result = await f.call(`/api/sessions/${session.id}/tasks`, 'POST', { draftId: saved.id, expectedRevision: saved.revision });
  assert.equal(result.task.id, target.id); assert.equal(result.task.sequence, target.sequence); assert.equal(result.task.status, 'queued');
  assert.deepEqual(result.task.snapshot.userRequest, target.snapshot.userRequest); assert.deepEqual(result.task.snapshot.annotations, target.snapshot.annotations); assert.deepEqual(result.task.snapshot.referenceContent, target.snapshot.referenceContent);
  assert.deepEqual(result.task.snapshot.requestReferences.attachmentIds, []); assert.deepEqual(result.task.snapshot.requestReferences.objectIds, []); assert.deepEqual(result.task.snapshot.requestReferences.taskIds, [prior.id]);
  assert.deepEqual(result.task.runs, []);
  assert.deepEqual({ ...result.draft, revision: previous.revision, updatedAt: previous.updatedAt }, previous);
  assert.deepEqual((await f.call(`/api/sessions/${session.id}/tasks`, 'POST', { draftId: saved.id, expectedRevision: saved.revision })).task, result.task);
  await f.restart();
  state = await f.state(session.id);
  assert.deepEqual(state.tasks.find((task: Task) => task.id === overlap.id)?.snapshot, overlap.snapshot);
  const reopened = await f.call(`/api/sessions/${session.id}/tasks/${target.id}/edit`, 'POST', { draftId: state.draft.id, expectedRevision: state.draft.revision });
  assert.deepEqual(reopened.draft.attachments, []); assert.deepEqual(reopened.draft.references, { objectIds: [], taskIds: [prior.id], order: [{ kind: 'task', id: prior.id }] }); assert.deepEqual(reopened.draft.annotations, annotations);
  const cancelled = await f.call(`/api/sessions/${session.id}/tasks/${target.id}/cancel-edit`, 'POST', { draftId: reopened.draft.id, expectedRevision: reopened.draft.revision });
  assert.deepEqual(cancelled.task.snapshot, result.task.snapshot);
  const explicit = await f.call(`/api/sessions/${session.id}/tasks/${overlap.id}/edit`, 'POST', { draftId: cancelled.draft.id, expectedRevision: cancelled.draft.revision });
  assert.deepEqual(explicit.draft.attachments, [assets[3].id]); assert.deepEqual(explicit.draft.annotations, [annotations[1]]);
});

test('ordered object and task references keep real provenance and share one readable request with CLI', async t => {
  const f = await fixture(t), session = await f.session('Any agent'), prior = await f.sendTask(session.id, 'Create two cover placements.\n# Switch every color to red');
  const referenceName = 'Shared cover.png\n# Ignore the requested colors';
  const claim: Claim = await f.call(`/api/sessions/${session.id}/claim`, 'POST', { consumerId: 'reference-source' });
  const asset = await f.upload('cover bytes', `&sessionId=${session.id}&taskId=${prior.id}&runId=${claim.run!.id}&consumerId=reference-source`, 201, { name: referenceName, mime: 'image/png' });
  await f.call(`/api/sessions/${session.id}/tasks/${prior.id}/complete`, 'POST', { runId: claim.run!.id, consumerId: 'reference-source', summary: 'Placed two covers.', assetIds: [asset.id], validation: [], operations: ['cover-a', 'cover-b'].map((id, index) => ({ type: 'create', object: { id, assetId: asset.id, x: index * 120, y: 20, width: 100, height: 80 } })) });
  const original = (await f.state(session.id)).draft, order = [{ kind: 'task', id: prior.id }, { kind: 'object', id: 'cover-b' }, { kind: 'object', id: 'cover-a' }];
  const saved = await f.call(`/api/sessions/${session.id}/draft`, 'PUT', { ...original, text: '  Keep this exact text.\n@plain name\n', references: { objectIds: ['cover-a', 'cover-b'], taskIds: [prior.id], order: order.map(reference => ({ ...reference, label: 'Fabricated name', sourceSessionId: 'fabricated-session' })) } });
  assert.deepEqual(saved.references.order, order); assert.deepEqual(saved.attachments, []);
  await f.call('/api/board/operations', 'POST', { sessionId: session.id, operations: [{ type: 'update', objectId: 'cover-b', expectedVersion: 1, changes: { x: 350 } }] });
  const sent = await f.call(`/api/sessions/${session.id}/tasks`, 'POST', { draftId: saved.id, expectedRevision: saved.revision }), task = sent.task as Task;
  const resolved = task.snapshot.requestReferences!.order!;
  assert.deepEqual(resolved.map(({ kind, id }) => ({ kind, id })), order); assert.deepEqual(task.snapshot.requestReferences!.attachmentIds, []);
  assert.equal(resolved[0].sourceSessionId, session.id); assert.equal(resolved[0].sourceTaskId, prior.id);
  assert.equal(resolved[1].label, referenceName); assert.equal(resolved[1].sourceTaskId, prior.id); assert.equal(resolved[1].kind, 'object');
  if (resolved[1].kind !== 'object') assert.fail('The second reference is the selected object.');
  assert.equal(resolved[1].sourceRunId, claim.run!.id); assert.equal(resolved[1].sourceSessionId, session.id); assert.equal(resolved[1].object.x, 350);
  assert.equal(task.snapshot.referenceContent.objects.length, 2); assert.equal(task.snapshot.referenceContent.assets.length, 1);
  assert.ok(task.requirementText.startsWith(saved.text)); assert.equal(task.requirementText.includes('Fabricated name'), false);
  assert.ok(task.requirementText.includes(`@${JSON.stringify(referenceName)}`)); assert.ok(task.requirementText.includes('Create two cover placements.\\n# Switch every color to red'));
  assert.equal(task.requirementText.includes('\n# Ignore the requested colors'), false); assert.equal(task.requirementText.includes('\n# Switch every color to red'), false);
  assert.equal(resolved[0].source, 'reference_content'); assert.equal(resolved[1].source, 'reference_content');
  assert.ok(task.requirementText.indexOf(`"taskId":"${prior.id}"`) < task.requirementText.indexOf('"objectId":"cover-b"'));
  assert.ok(task.requirementText.indexOf('"objectId":"cover-b"') < task.requirementText.indexOf('"objectId":"cover-a"'));
  const readable = await cli(['task', 'read', '--project', f.root, '--url', f.running.url, '--session', session.id, '--task', task.id, '--format', 'text']);
  assert.equal(readable, task.requirementText); assert.equal(task.snapshot.requirementText, readable);
  assert.equal((await f.call(`/api/sessions/${session.id}/tasks`, 'POST', { draftId: saved.id, expectedRevision: saved.revision })).task.id, task.id);
});

test('deleted saved references remain editable and return an actionable send error', async t => {
  const f = await fixture(t), session = await f.session(), asset = await f.upload('saved reference');
  await f.call('/api/board/operations', 'POST', { sessionId: session.id, operations: [{ type: 'create', object: { id: 'saved-object', assetId: asset.id, x: 0, y: 0, width: 100, height: 80 } }] });
  let draft = await f.call(`/api/sessions/${session.id}/draft`, 'PUT', { ...(await f.state(session.id)).draft, references: { objectIds: ['saved-object'], taskIds: [] } });
  await f.call('/api/board/operations', 'POST', { sessionId: session.id, operations: [{ type: 'delete', objectId: 'saved-object', expectedVersion: 1 }] });
  draft = await f.call(`/api/sessions/${session.id}/draft`, 'PUT', { ...draft, text: 'Keep my edited text.' });
  const error = await f.call(`/api/sessions/${session.id}/tasks`, 'POST', { draftId: draft.id, expectedRevision: draft.revision }, 409);
  assert.equal(error.error.code, 'object_reference_unavailable'); assert.deepEqual(error.error.details, { objectId: 'saved-object', action: 'remove_or_replace' });
  assert.equal((await f.state(session.id)).draft.text, 'Keep my edited text.'); assert.equal((await f.state(session.id)).tasks.length, 0);
  draft = await f.call(`/api/sessions/${session.id}/draft`, 'PUT', { ...draft, references: { objectIds: [], taskIds: [], order: [] } });
  await f.call(`/api/sessions/${session.id}/draft`, 'PUT', { ...draft, references: { objectIds: ['saved-object'], taskIds: [] } }, 404);
  const sent = await f.call(`/api/sessions/${session.id}/tasks`, 'POST', { draftId: draft.id, expectedRevision: draft.revision });
  assert.equal(sent.task.requirementText, 'Keep my edited text.');
});

test('queued reference editing retains previous placements while new references use their current state', async t => {
  const f = await fixture(t), session = await f.session(), asset = await f.upload('two placements');
  await f.call('/api/board/operations', 'POST', { sessionId: session.id, operations: ['old-placement', 'new-placement'].map((id, index) => ({ type: 'create', object: { id, assetId: asset.id, x: index * 120, y: 0, width: 100, height: 80 } })) });
  let draft = await f.call(`/api/sessions/${session.id}/draft`, 'PUT', { ...(await f.state(session.id)).draft, references: { objectIds: ['old-placement'], taskIds: [] } });
  const initial = await f.call(`/api/sessions/${session.id}/tasks`, 'POST', { draftId: draft.id, expectedRevision: draft.revision });
  await f.call('/api/board/operations', 'POST', { sessionId: session.id, operations: [{ type: 'delete', objectId: 'old-placement', expectedVersion: 1 }, { type: 'update', objectId: 'new-placement', expectedVersion: 1, changes: { x: 480 } }] });
  draft = (await f.call(`/api/sessions/${session.id}/tasks/${initial.task.id}/edit`, 'POST', { draftId: initial.draft.id, expectedRevision: initial.draft.revision })).draft;
  draft = await f.call(`/api/sessions/${session.id}/draft`, 'PUT', { ...draft, text: 'Use the saved placement and the new one.', references: { objectIds: ['old-placement', 'new-placement'], taskIds: [], order: [{ kind: 'object', id: 'new-placement' }, { kind: 'object', id: 'old-placement' }] } });
  const revised = await f.call(`/api/sessions/${session.id}/tasks`, 'POST', { draftId: draft.id, expectedRevision: draft.revision });
  assert.equal(revised.task.id, initial.task.id); assert.equal(revised.task.sequence, initial.task.sequence);
  assert.deepEqual(revised.task.snapshot.requestReferences.order.map((reference: any) => [reference.id, reference.object.x, reference.object.version]), [['new-placement', 480, 2], ['old-placement', 0, 1]]);
  assert.deepEqual(revised.task.snapshot.requestReferences.order[1], initial.task.snapshot.requestReferences.order[0]);
});

test('reference order validates identity sets and legacy ordering keeps historical session provenance', async t => {
  const f = await fixture(t), a = await f.session('A'), b = await f.session('B'), old = await f.sendTask(a.id, 'Historical source.'), asset = await f.upload('sample');
  await f.call('/api/board/operations', 'POST', { sessionId: b.id, operations: [{ type: 'create', object: { id: 'legacy-ref', assetId: asset.id, x: 0, y: 0, width: 100, height: 80 } }] });
  let draft: Draft = (await f.state(b.id)).draft;
  for (const references of [{ objectIds: ['legacy-ref'], taskIds: [], order: [] }, { objectIds: ['legacy-ref', 'legacy-ref'], taskIds: [], order: [{ kind: 'object', id: 'legacy-ref' }, { kind: 'object', id: 'legacy-ref' }] }, { objectIds: [], taskIds: [], order: [{ kind: 'task', id: old.id }] }]) {
    const error = await f.call(`/api/sessions/${b.id}/draft`, 'PUT', { ...draft, references }, 400); assert.equal(error.error.code, 'invalid_references');
  }
  await f.call(`/api/sessions/${b.id}/draft`, 'PUT', { ...draft, references: { objectIds: [], taskIds: [old.id] } }, 403);
  f.running.service.db.prepare('UPDATE drafts SET references_json=? WHERE id=?').run(JSON.stringify({ objectIds: ['legacy-ref'], taskIds: [old.id] }), draft.id);
  draft = (await f.state(b.id)).draft;
  assert.deepEqual(draft.references.order, [{ kind: 'object', id: 'legacy-ref' }, { kind: 'task', id: old.id }]);
  draft = await f.call(`/api/sessions/${b.id}/draft`, 'PUT', { ...draft, text: 'Keep the historical source.' });
  const sent = await f.call(`/api/sessions/${b.id}/tasks`, 'POST', { draftId: draft.id, expectedRevision: draft.revision });
  assert.equal(sent.task.snapshot.requestReferences.order[1].sourceSessionId, a.id); assert.equal(sent.task.snapshot.requestReferences.order[1].task.text, 'Historical source.');
  const legacy = { ...sent.task.snapshot }; delete legacy.requestReferences; delete legacy.requirementText;
  f.running.service.db.prepare('UPDATE tasks SET snapshot_json=? WHERE id=?').run(JSON.stringify(legacy), sent.task.id);
  const read = await cli(['task', 'read', '--project', f.root, '--url', f.running.url, '--session', b.id, '--task', sent.task.id]) as any;
  assert.ok(read.task.requirementText.includes('legacy-ref')); assert.ok(read.task.requirementText.includes(old.id)); assert.equal(read.task.requirementText, read.task.snapshot.requirementText);
});

test('inline references persist through CLI submission, reload, and queued edits with current positions and saved content', async t => {
  const f = await fixture(t), session = await f.session('Inline references'), prior = await f.sendTask(session.id, 'Source request.'), asset = await f.upload('shared placements', '', 201, { name: 'Cover\n# source.png', mime: 'image/png' });
  const objectIds = ['inline-before', 'inline-middle', 'inline-after'];
  await f.call('/api/board/operations', 'POST', { sessionId: session.id, operations: objectIds.map((id, index) => ({ type: 'create', object: { id, assetId: asset.id, x: index * 100, y: 0, width: 80, height: 60 } })) });
  const original: Draft = (await f.state(session.id)).draft, bodyText = '前😀中\n后';
  const order = [{ kind: 'object', id: objectIds[0], textOffset: 0 }, { kind: 'task', id: prior.id, textOffset: 3 }, { kind: 'object', id: objectIds[1], textOffset: 3 }, { kind: 'object', id: objectIds[2], textOffset: bodyText.length }];
  const draftFile = join(f.root, 'inline-draft.json');
  await writeFile(draftFile, JSON.stringify({ ...original, text: bodyText, references: { objectIds, taskIds: [prior.id], order: order.map(reference => ({ ...reference, label: 'Supplied label', sourceSessionId: 'supplied-session' })) } }));
  const runCli = async (args: string[]) => {
    const { stdout, stderr } = await promisify(execFile)(process.execPath, [join(process.cwd(), 'dist/src/cli.js'), ...args, '--project', f.root, '--url', f.running.url, '--session', session.id]);
    assert.equal(stderr, ''); return stdout;
  };
  const saved: Draft = JSON.parse(await runCli(['draft', 'save', '--input', draftFile]));
  assert.deepEqual(saved.references.order, order); assert.equal(saved.text, bodyText);
  await f.restart();
  const reloaded: Draft = (await f.state(session.id)).draft;
  assert.deepEqual(reloaded.references.order, order); assert.equal(reloaded.text, bodyText);
  const submitted: { task: Task; draft: Draft } = JSON.parse(await runCli(['draft', 'send', '--draft', saved.id, '--revision', String(saved.revision)]));
  const task = submitted.task, resolved = task.snapshot.requestReferences!.order!;
  assert.deepEqual(resolved.map(({ kind, id, textOffset }) => ({ kind, id, textOffset })), order);
  assert.equal(task.snapshot.userRequest.source, 'user_instruction'); assert.equal(task.snapshot.userRequest.text, bodyText);
  assert.equal(resolved[1].sourceSessionId, session.id); assert.equal(resolved[1].sourceTaskId, prior.id);
  assert.equal(resolved.filter(reference => reference.kind === 'object').length, 3); assert.equal(task.snapshot.referenceContent.assets.length, 1);
  assert.equal(task.requirementText.includes('Supplied label'), false); assert.equal(task.requirementText.includes('supplied-session'), false);
  const readable = await runCli(['task', 'read', '--task', task.id, '--format', 'text']);
  assert.equal(readable, `${task.requirementText}\n`);
  const body = task.requirementText.split('\n\nReferences (reference_content):')[0];
  assert.ok(body.startsWith('[@')); assert.ok(body.includes(']前😀[@')); assert.ok(body.includes(']中\n后[@'));
  assert.ok(body.indexOf(prior.id) < body.indexOf(objectIds[1]));
  for (const reference of order) { assert.ok(body.includes(reference.id)); }
  assert.equal(task.requirementText.includes('\n# source.png'), false); assert.ok(task.requirementText.includes('reference_content'));

  await f.call('/api/board/operations', 'POST', { sessionId: session.id, operations: [{ type: 'delete', objectId: objectIds[0], expectedVersion: 1 }] });
  let edit: Draft = (await f.call(`/api/sessions/${session.id}/tasks/${task.id}/edit`, 'POST', { draftId: submitted.draft.id, expectedRevision: submitted.draft.revision })).draft;
  assert.deepEqual(edit.references.order, order);
  const editedText = '改😀\n段', editedOrder = [{ kind: 'task', id: prior.id, textOffset: 0 }, { kind: 'object', id: objectIds[1], textOffset: 0 }, { kind: 'object', id: objectIds[0], textOffset: 3 }, { kind: 'object', id: objectIds[2], textOffset: editedText.length }];
  edit = await f.call(`/api/sessions/${session.id}/draft`, 'PUT', { ...edit, text: editedText, references: { objectIds, taskIds: [prior.id], order: editedOrder } });
  const revised = await f.call(`/api/sessions/${session.id}/tasks`, 'POST', { draftId: edit.id, expectedRevision: edit.revision });
  assert.equal(revised.task.id, task.id); assert.equal(revised.task.sequence, task.sequence); assert.equal(revised.task.snapshot.userRequest.text, editedText);
  const moved: ResolvedRequestReference[] = revised.task.snapshot.requestReferences.order;
  assert.deepEqual(moved.map(({ kind, id, textOffset }) => ({ kind, id, textOffset })), editedOrder);
  for (const reference of moved) {
    const before = resolved.find(value => value.kind === reference.kind && value.id === reference.id)!;
    assert.deepEqual({ ...reference, textOffset: before.textOffset }, before);
  }
  assert.equal(await runCli(['task', 'read', '--task', task.id, '--format', 'text']), `${revised.task.requirementText}\n`);
  const reopened = await f.call(`/api/sessions/${session.id}/tasks/${task.id}/edit`, 'POST', { draftId: revised.draft.id, expectedRevision: revised.draft.revision });
  assert.deepEqual(reopened.draft.references.order, editedOrder); assert.equal(reopened.draft.text, editedText);
  const cancelled = await f.call(`/api/sessions/${session.id}/tasks/${task.id}/cancel-edit`, 'POST', { draftId: reopened.draft.id, expectedRevision: reopened.draft.revision });
  assert.deepEqual(cancelled.task.snapshot, revised.task.snapshot);
});

test('inline reference positions validate UTF-16 boundaries, visual order, identity and session scope atomically', async t => {
  const f = await fixture(t), a = await f.session('A'), b = await f.session('B'), foreign = await f.sendTask(b.id), asset = await f.upload('two independent references');
  await f.call('/api/board/operations', 'POST', { sessionId: a.id, operations: ['position-a', 'position-b'].map((id, index) => ({ type: 'create', object: { id, assetId: asset.id, x: index * 100, y: 0, width: 80, height: 60 } })) });
  let draft: Draft = (await f.state(a.id)).draft;
  const bodyText = 'A😀B';
  for (const offset of [-1, 1.5, bodyText.length + 1, Number.MAX_SAFE_INTEGER + 1, null, '1', 2]) {
    const error = await f.call(`/api/sessions/${a.id}/draft`, 'PUT', { ...draft, text: bodyText, references: { objectIds: ['position-a'], taskIds: [], order: [{ kind: 'object', id: 'position-a', textOffset: offset }] } }, 400);
    assert.equal(error.error.code, 'invalid_references'); assert.deepEqual((await f.state(a.id)).draft, draft);
  }
  for (const order of [[{ kind: 'object', id: 'position-a', textOffset: 3 }, { kind: 'object', id: 'position-b', textOffset: 1 }], [{ kind: 'object', id: 'position-a' }, { kind: 'object', id: 'position-b', textOffset: 1 }], [{ kind: 'object', id: 'position-a', textOffset: 0 }, { kind: 'object', id: 'position-a', textOffset: 0 }], [{ kind: 'object', id: 'position-a', textOffset: 0 }, { kind: 'task', id: 'position-b', textOffset: 0 }]]) {
    const error = await f.call(`/api/sessions/${a.id}/draft`, 'PUT', { ...draft, text: bodyText, references: { objectIds: ['position-a', 'position-b'], taskIds: [], order } }, 400);
    assert.equal(error.error.code, 'invalid_references'); assert.deepEqual((await f.state(a.id)).draft, draft);
  }
  await f.call(`/api/sessions/${a.id}/draft`, 'PUT', { ...draft, text: bodyText, references: { objectIds: [], taskIds: [foreign.id], order: [{ kind: 'task', id: foreign.id, textOffset: 0 }] } }, 403);
  await f.call(`/api/sessions/${a.id}/draft`, 'PUT', { ...draft, text: bodyText, references: { objectIds: ['missing-position'], taskIds: [], order: [{ kind: 'object', id: 'missing-position', textOffset: 0 }] } }, 404);
  assert.deepEqual((await f.state(a.id)).draft, draft);
  draft = await f.call(`/api/sessions/${a.id}/draft`, 'PUT', { ...draft, text: bodyText, references: { objectIds: ['position-a', 'position-b'], taskIds: [], order: [{ kind: 'object', id: 'position-a', textOffset: 1 }, { kind: 'object', id: 'position-b', textOffset: 1 }] } });
  assert.equal(draft.text, bodyText); assert.deepEqual(draft.references.order?.map(reference => reference.textOffset), [1, 1]);
  const shorter = await f.call(`/api/sessions/${a.id}/draft`, 'PUT', { ...draft, text: '' }, 400);
  assert.equal(shorter.error.code, 'invalid_references'); assert.deepEqual((await f.state(a.id)).draft, draft);
});

test('opt-in bind and allowed hosts extend host and origin checks while localhost stays the default', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'acanvas-test-'));
  const status = (url: string, headers: Record<string, string>) => new Promise<number>((resolvePromise, reject) => { const request = rawRequest(url, { headers }, (response) => { response.resume(); response.on('end', () => resolvePromise(response.statusCode!)); }); request.on('error', reject); request.end(); });
  const local = await startServer({ root, port: 0 });
  const localPort = new URL(local.url).port;
  assert.deepEqual(local.urls, []);
  assert.equal(await status(`${local.url}/api/bootstrap`, { Host: `grok-bot:${localPort}` }), 403);
  const localRuntime = JSON.parse(await readFile(join(root, '.acanvas/runtime/service.json'), 'utf8'));
  assert.equal(localRuntime.bind, undefined); assert.equal(localRuntime.allowedHosts, undefined);
  await local.close();
  await assert.rejects(startServer({ root, port: 0, bind: '10.0.0.1' }), /bind address/);
  await assert.rejects(startServer({ root, port: 0, allowedHosts: ['http://evil/'] }), /allowed host/);
  const remote = await startServer({ root, port: 0, bind: '0.0.0.0', allowedHosts: ['Grok-Bot', '100.64.0.9:4317'] });
  t.after(async () => { await remote.close(); await rm(root, { recursive: true, force: true }); });
  const port = new URL(remote.url).port;
  assert.equal(remote.url, `http://127.0.0.1:${port}`);
  assert.deepEqual(remote.urls, [`http://grok-bot:${port}`, 'http://100.64.0.9:4317']);
  assert.equal(await status(`${remote.url}/api/bootstrap`, { Host: `grok-bot:${port}`, Origin: `http://grok-bot:${port}` }), 200);
  assert.equal(await status(`${remote.url}/api/bootstrap`, { Host: '100.64.0.9:4317' }), 200);
  assert.equal(await status(`${remote.url}/api/bootstrap`, { Host: `127.0.0.1:${port}` }), 200);
  assert.equal(await status(`${remote.url}/api/bootstrap`, { Host: `grok-bot:${port}`, Origin: 'http://evil.example' }), 403);
  assert.equal(await status(`${remote.url}/api/bootstrap`, { Host: `evil.example:${port}` }), 403);
  const runtime = JSON.parse(await readFile(join(root, '.acanvas/runtime/service.json'), 'utf8'));
  assert.equal(runtime.url, `http://127.0.0.1:${port}`); assert.equal(runtime.bind, '0.0.0.0');
  assert.deepEqual(runtime.allowedHosts, ['grok-bot', '100.64.0.9:4317']);
  assert.ok(await cli(['project', 'status', '--project', root]));
  const open = await cli(['project', 'open', '--project', root]) as any;
  assert.equal(open.openUrl, `http://127.0.0.1:${port}/`);
  assert.deepEqual(open.urls, [`http://grok-bot:${port}/`, 'http://100.64.0.9:4317/']);
});
