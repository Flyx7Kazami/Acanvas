import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Draft, RequestReference, Task } from '../src/shared/types.js';
import { startServer } from '../src/server/http.js';
import { referenceParts } from '../src/shared/task-message.js';

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'acanvas-reference-occurrences-'));
  let running = await startServer({ root, port: 0 });
  let token = (await (await fetch(`${running.url}/api/bootstrap`)).json()).token as string;
  t.after(async () => { await running.close(); await rm(root, { recursive: true, force: true }); });
  const call = async (path: string, method = 'GET', body?: unknown, expected = 200) => {
    const response = await fetch(`${running.url}${path}`, { method, headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const value = await response.json(); assert.equal(response.status, expected, JSON.stringify(value)); return value;
  };
  const session = await call('/api/sessions', 'POST', { name: 'Repeated references' }, 201);
  const cli = async (args: string[]) => {
    const { stdout, stderr } = await promisify(execFile)(process.execPath, [join(process.cwd(), 'dist/src/cli.js'), ...args, '--project', root, '--url', running.url, '--session', session.id]);
    assert.equal(stderr, ''); return stdout;
  };
  const save = (draft: Draft) => call(`/api/sessions/${session.id}/draft`, 'PUT', draft) as Promise<Draft>;
  const draft = async () => (await call(`/api/state?sessionId=${session.id}`)).draft as Draft;
  const send = (value: Draft) => call(`/api/sessions/${session.id}/tasks`, 'POST', { draftId: value.id, expectedRevision: value.revision }) as Promise<{ task: Task; draft: Draft }>;
  const asset = await (await fetch(`${running.url}/api/assets?name=Repeated.png&mime=image/png`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: 'private fixture pixels' })).json();
  await call('/api/board/operations', 'POST', { sessionId: session.id, operations: [{ type: 'create', object: { id: 'repeated-object', assetId: asset.id, x: 50, y: 80, width: 100, height: 60 } }] });
  return { root, session, asset, call, cli, save, draft, send, async restart() { await running.close(); running = await startServer({ root, port: 0 }); token = (await (await fetch(`${running.url}/api/bootstrap`)).json()).token; } };
}

test('repeated object and task occurrences keep every CLI position, reload, Send and edit while sharing snapshot sources', async t => {
  const f = await fixture(t);
  const prior = (await f.send(await f.save({ ...await f.draft(), text: 'Earlier source' }))).task;
  const text = '前😀中\n后', id = 'repeated-object';
  const order: RequestReference[] = [{ kind: 'object', id, textOffset: 0 }, { kind: 'object', id, textOffset: 0 }, { kind: 'task', id: prior.id, textOffset: 3 }, { kind: 'object', id, textOffset: 3 }, { kind: 'task', id: prior.id, textOffset: 3 }, { kind: 'object', id, textOffset: text.length }];
  const draftFile = join(f.root, 'draft.json');
  await writeFile(draftFile, JSON.stringify({ ...await f.draft(), text, references: { objectIds: [id], taskIds: [prior.id], order } }));
  const saved: Draft = JSON.parse(await f.cli(['draft', 'save', '--input', draftFile]));
  assert.deepEqual(saved.references, { objectIds: [id], taskIds: [prior.id], order });
  await f.restart(); assert.deepEqual((await f.draft()).references, saved.references);
  const submitted: { task: Task; draft: Draft } = JSON.parse(await f.cli(['draft', 'send', '--draft', saved.id, '--revision', String(saved.revision)]));
  const snapshot = submitted.task.snapshot, resolved = snapshot.requestReferences!.order!;
  assert.deepEqual(resolved.map(({ kind, id, textOffset }) => ({ kind, id, textOffset })), order);
  assert.deepEqual(snapshot.requestReferences!.objectIds, [id]); assert.deepEqual(snapshot.requestReferences!.taskIds, [prior.id]);
  assert.equal(snapshot.referenceContent.objects.length, 1); assert.equal(snapshot.referenceContent.assets.length, 1); assert.deepEqual(snapshot.referenceContent.taskIds, [prior.id]);
  const body = submitted.task.requirementText.split('\n\nReferences (reference_content):')[0];
  const parts = referenceParts(text, resolved).map(part => part.kind === 'text' ? part.text : `[@${JSON.stringify(part.reference.label)} (reference_content; ${JSON.stringify({ kind: part.reference.kind, id: part.reference.id })})]`).join('');
  assert.equal(body, parts); assert.equal((body.match(/repeated-object/g) || []).length, 4); assert.equal((body.match(new RegExp(prior.id, 'g')) || []).length, 2);
  assert.equal(await f.cli(['task', 'read', '--task', submitted.task.id, '--format', 'text']), `${submitted.task.requirementText}\n`);
  await f.call('/api/board/operations', 'POST', { sessionId: f.session.id, operations: [{ type: 'delete', objectId: id, expectedVersion: 1 }] });
  let edit: Draft = (await f.call(`/api/sessions/${f.session.id}/tasks/${submitted.task.id}/edit`, 'POST', { draftId: submitted.draft.id, expectedRevision: submitted.draft.revision })).draft;
  assert.deepEqual(edit.references.order, order);
  const nextText = '新😀\n正文', nextOrder: RequestReference[] = [{ kind: 'task', id: prior.id, textOffset: 0 }, { kind: 'object', id, textOffset: 3 }, { kind: 'task', id: prior.id, textOffset: 3 }, { kind: 'object', id, textOffset: 3 }];
  edit = await f.save({ ...edit, text: nextText, references: { objectIds: [id], taskIds: [prior.id], order: nextOrder } });
  const revised = await f.send(edit);
  assert.equal(revised.task.id, submitted.task.id); assert.equal(revised.task.sequence, submitted.task.sequence);
  assert.deepEqual(revised.task.snapshot.requestReferences!.order!.map(({ kind, id, textOffset }) => ({ kind, id, textOffset })), nextOrder);
  assert.equal(revised.task.snapshot.referenceContent.objects.length, 1); assert.equal(revised.task.snapshot.referenceContent.assets.length, 1);
  for (const reference of revised.task.snapshot.requestReferences!.order!) {
    const before = resolved.find(value => value.kind === reference.kind && value.id === reference.id)!;
    assert.deepEqual({ ...reference, textOffset: before.textOffset }, before);
  }
  const reopened = await f.call(`/api/sessions/${f.session.id}/tasks/${submitted.task.id}/edit`, 'POST', { draftId: revised.draft.id, expectedRevision: revised.draft.revision });
  assert.deepEqual(reopened.draft.references.order, nextOrder);
  const cancelled = await f.call(`/api/sessions/${f.session.id}/tasks/${submitted.task.id}/cancel-edit`, 'POST', { draftId: reopened.draft.id, expectedRevision: reopened.draft.revision });
  assert.deepEqual(cancelled.task.snapshot, revised.task.snapshot);
});

test('occurrences admit repeated legacy and equal UTF-16 positions and retain source, Unicode and list limits', async t => {
  const f = await fixture(t), id = 'repeated-object';
  let draft = await f.draft();
  const order: RequestReference[] = [{ kind: 'object', id }, { kind: 'object', id }];
  draft = await f.save({ ...draft, text: 'A😀B', references: { objectIds: [id], taskIds: [], order } });
  assert.deepEqual(draft.references.order, order);
  draft = await f.save({ ...draft, references: { objectIds: [id], taskIds: [], order: [{ kind: 'object', id, textOffset: 1 }, { kind: 'object', id, textOffset: 1 }, { kind: 'object', id, textOffset: 3 }] } });
  const invalid = [
    { objectIds: [id, id], taskIds: [], order: [{ kind: 'object', id, textOffset: 1 }] },
    { objectIds: [id], taskIds: [], order: [] },
    { objectIds: [id], taskIds: [], order: [{ kind: 'object', id, textOffset: 1 }, { kind: 'object', id: 'other', textOffset: 1 }] },
    { objectIds: [id], taskIds: [], order: [{ kind: 'object', id, textOffset: 2 }, { kind: 'object', id, textOffset: 3 }] },
    { objectIds: [id], taskIds: [], order: [{ kind: 'object', id, textOffset: 3 }, { kind: 'object', id, textOffset: 1 }] },
    { objectIds: [id], taskIds: [], order: Array.from({ length: 2001 }, () => ({ kind: 'object', id, textOffset: 1 })) },
  ];
  for (const references of invalid) {
    const error = await f.call(`/api/sessions/${f.session.id}/draft`, 'PUT', { ...draft, references }, 400);
    assert.equal(error.error.code, 'invalid_references'); assert.deepEqual(await f.draft(), draft);
  }
});
