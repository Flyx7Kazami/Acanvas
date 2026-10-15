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

async function fixture(t: test.TestContext, mime = 'image/png', bytes = 'private fixture pixels') {
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
  const asset = await (await fetch(`${running.url}/api/assets?name=Repeated.png&mime=${encodeURIComponent(mime)}`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: bytes })).json();
  await call('/api/board/operations', 'POST', { sessionId: session.id, operations: [{ type: 'create', object: { id: 'repeated-object', assetId: asset.id, x: 50, y: 80, width: 100, height: 60 } }] });
  const content = (method = 'GET', body?: string) => fetch(`${running.url}/api/assets/${asset.id}/content`, { method, headers: { Authorization: `Bearer ${token}` }, ...(body === undefined ? {} : { body }) });
  return { root, session, asset, call, cli, save, draft, send, content, async restart() { await running.close(); running = await startServer({ root, port: 0 }); token = (await (await fetch(`${running.url}/api/bootstrap`)).json()).token; } };
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

test('group references freeze names, members and files through CLI, reload and historical edits', async t => {
  const f = await fixture(t), id = 'repeated-object';
  const op = (operations: unknown[]) => f.call('/api/board/operations', 'POST', { sessionId: f.session.id, operations });
  await op([{ type: 'create', object: { id: 'member-two', assetId: f.asset.id, x: 200, y: -30, width: 80, height: 90 } }, { type: 'group.create', group: { id, name: 'My group', objectIds: ['repeated-object', 'member-two'] }, expectedVersions: { 'repeated-object': 1, 'member-two': 1 } }]);
  const order: RequestReference[] = [{ kind: 'group', id, textOffset: 0 }, { kind: 'object', id: 'repeated-object', textOffset: 3 }, { kind: 'group', id, textOffset: 3 }];
  const saved = await f.save({ ...await f.draft(), text: '前😀后', references: { objectIds: ['repeated-object'], taskIds: [], groupIds: [id], order } });
  await f.restart(); assert.deepEqual((await f.draft()).references, saved.references);
  const sent: { task: Task; draft: Draft } = JSON.parse(await f.cli(['draft', 'send', '--draft', saved.id, '--revision', String(saved.revision)]));
  const frozen = sent.task.snapshot, group = frozen.requestReferences!.order![0];
  assert.equal(group.kind, 'group'); if (group.kind !== 'group') throw Error('group expected');
  assert.equal(group.label, 'My group'); assert.equal(group.objects.length, 2); assert.equal(group.assets.length, 1);
  assert.deepEqual(frozen.requestReferences!.objectIds, ['repeated-object']); assert.deepEqual(frozen.requestReferences!.groupIds, [id]);
  assert.equal(frozen.referenceContent.objects.length, 2); assert.equal(frozen.referenceContent.groups!.length, 1);
  const text = await f.cli(['task', 'read', '--task', sent.task.id, '--format', 'text']);
  assert.match(text, /My group/); assert.match(text, /member-two/); assert.match(text, /Repeated.png/); assert.match(text, /reference_content/);
  await op([{ type: 'group.update', groupId: id, expectedVersion: group.group.version, changes: { name: 'Renamed', mode: 'folder' } }]);
  const state = await f.call(`/api/state?sessionId=${f.session.id}`), live = state.groups.find((value: any) => value.id === id);
  await op([{ type: 'group.ungroup', groupId: id, expectedVersion: live.version }]);
  await f.restart(); assert.deepEqual((await f.call(`/api/sessions/${f.session.id}/tasks/${sent.task.id}`)).snapshot, frozen);
  const edit = (await f.call(`/api/sessions/${f.session.id}/tasks/${sent.task.id}/edit`, 'POST', { draftId: sent.draft.id, expectedRevision: sent.draft.revision })).draft as Draft;
  assert.deepEqual(edit.references.order, order);
  const revised = await f.send(await f.save({ ...edit, text: '新😀文' }));
  assert.deepEqual(revised.task.snapshot.referenceContent, frozen.referenceContent);
  assert.deepEqual(revised.task.snapshot.requestReferences!.order, frozen.requestReferences!.order);
  await f.call(`/api/sessions/${f.session.id}/draft`, 'PUT', { ...revised.draft, text: '', references: { objectIds: [], taskIds: [], groupIds: ['missing'] } }, 404);
  await f.call(`/api/sessions/${f.session.id}/draft`, 'PUT', { ...revised.draft, text: '😀', references: { objectIds: [], taskIds: [], groupIds: [id], order: [{ kind: 'group', id, textOffset: 1 }] } }, 400);
});


test('historical group and newly explicit member retain their own layouts with explicit snapshot priority', async t => {
  const f = await fixture(t), id = 'repeated-object', groupId = 'historical-group';
  const op = (operations: unknown[]) => f.call('/api/board/operations', 'POST', { sessionId: f.session.id, operations });
  await op([{ type: 'update', objectId: id, expectedVersion: 1, changes: { x: 0 } }, { type: 'create', object: { id: 'second-member', assetId: f.asset.id, x: 200, y: 80, width: 100, height: 60 } }, { type: 'group.create', group: { id: groupId, name: 'Historical group', objectIds: [id, 'second-member'] }, expectedVersions: { [id]: 2, 'second-member': 1 } }]);
  const sent = await f.send(await f.save({ ...await f.draft(), text: 'Group source', references: { objectIds: [], taskIds: [], groupIds: [groupId], order: [{ kind: 'group', id: groupId, textOffset: 0 }] } }));
  const frozen = sent.task.snapshot.requestReferences!.order![0];
  assert.equal(frozen.kind, 'group'); if (frozen.kind !== 'group') throw Error('group expected');
  assert.equal(frozen.objects[0].x, 0);
  await op([{ type: 'update', objectId: id, expectedVersion: frozen.objects[0].version, changes: { x: 999 } }]);
  const state = await f.call(`/api/state?sessionId=${f.session.id}`);
  assert.equal(state.objects.find((object: any) => object.id === id).x, 999);
  const edit = (await f.call(`/api/sessions/${f.session.id}/tasks/${sent.task.id}/edit`, 'POST', { draftId: sent.draft.id, expectedRevision: sent.draft.revision })).draft as Draft;
  const revised = await f.send(await f.save({ ...edit, references: { ...edit.references, objectIds: [id], order: [...edit.references.order!, { kind: 'object', id, textOffset: edit.text.length }] } }));
  const snapshot = revised.task.snapshot, [group, explicit] = snapshot.requestReferences!.order!;
  assert.deepEqual(group, frozen);
  assert.equal(explicit.kind, 'object'); if (explicit.kind !== 'object') throw Error('object expected');
  assert.equal(explicit.object.x, 999);
  assert.equal(explicit.source, 'reference_content');
  assert.equal(explicit.id, id); assert.equal(explicit.object.assetId, f.asset.id); assert.equal(explicit.asset.id, f.asset.id);
  assert.deepEqual(explicit.asset, frozen.assets[0]);
  assert.equal(snapshot.referenceContent.objects.length, 2);
  const contentObject = snapshot.referenceContent.objects.find(object => object.id === id)!;
  assert.equal(contentObject.x, 999);
  assert.deepEqual(contentObject, explicit.object);
  assert.deepEqual(snapshot.referenceContent.groups, [frozen.group]);
  assert.deepEqual(snapshot.referenceContent.assets, sent.task.snapshot.referenceContent.assets);
  assert.equal(snapshot.referenceContent.source, 'reference_content');
  await f.restart();
  assert.deepEqual((await f.call(`/api/sessions/${f.session.id}/tasks/${sent.task.id}`)).snapshot, snapshot);
});


test('historical group assets and newly explicit note assets retain their resolved metadata', async t => {
  const f = await fixture(t, 'text/x-acanvas-note', 'a'), id = 'repeated-object', groupId = 'note-group';
  const op = (operations: unknown[]) => f.call('/api/board/operations', 'POST', { sessionId: f.session.id, operations });
  await op([{ type: 'create', object: { id: 'second-note', assetId: f.asset.id, x: 200, y: 80, width: 100, height: 60 } }, { type: 'group.create', group: { id: groupId, name: 'Notes', objectIds: [id, 'second-note'] }, expectedVersions: { [id]: 1, 'second-note': 1 } }]);
  const sent = await f.send(await f.save({ ...await f.draft(), text: 'Note source', references: { objectIds: [], taskIds: [], groupIds: [groupId], order: [{ kind: 'group', id: groupId, textOffset: 0 }] } }));
  const frozen = sent.task.snapshot.requestReferences!.order![0];
  assert.equal(frozen.kind, 'group'); if (frozen.kind !== 'group') throw Error('group expected');
  assert.equal(frozen.assets[0].size, 1);
  const body = 'new note body size';
  assert.equal(Buffer.byteLength(body), 18);
  const current = (await f.call(`/api/state?sessionId=${f.session.id}`)).objects.find((object: any) => object.id === id);
  const replaced = await op([{ type: 'content', objectId: id, expectedVersion: current.version, text: body }]);
  const revisedObject = replaced.objects.find((object: any) => object.id === id);
  assert.notEqual(revisedObject.assetId, f.asset.id);
  assert.equal(await (await f.content()).text(), 'a');
  const edit = (await f.call(`/api/sessions/${f.session.id}/tasks/${sent.task.id}/edit`, 'POST', { draftId: sent.draft.id, expectedRevision: sent.draft.revision })).draft as Draft;
  const saved = await f.save({ ...edit, references: { ...edit.references, objectIds: [id], order: [...edit.references.order!, { kind: 'object', id, textOffset: edit.text.length }] } });
  await f.call(`/api/sessions/${f.session.id}/tasks`, 'POST', { draftId: saved.id, expectedRevision: saved.revision - 1 }, 409);
  const revised = await f.send(saved), snapshot = revised.task.snapshot;
  const [group, explicit] = snapshot.requestReferences!.order!;
  assert.deepEqual(group, frozen);
  assert.equal(explicit.kind, 'object'); if (explicit.kind !== 'object') throw Error('object expected');
  assert.equal(explicit.asset.size, 18); assert.equal(explicit.asset.id, revisedObject.assetId);
  assert.equal(explicit.source, 'reference_content'); assert.equal(explicit.object.assetId, revisedObject.assetId);
  assert.deepEqual(new Set(snapshot.referenceContent.assets.map(asset => asset.id)), new Set([explicit.asset.id, f.asset.id]));
  assert.deepEqual(snapshot.referenceContent.groups, [frozen.group]);
  await f.restart();
  assert.deepEqual((await f.call(`/api/sessions/${f.session.id}/tasks/${sent.task.id}`)).snapshot, snapshot);
  const reopened = (await f.call(`/api/sessions/${f.session.id}/tasks/${sent.task.id}/edit`, 'POST', { draftId: revised.draft.id, expectedRevision: revised.draft.revision })).draft as Draft;
  const latest = (await f.call(`/api/state?sessionId=${f.session.id}`)).objects.find((object: any) => object.id === id);
  await op([{ type: 'content', objectId: id, expectedVersion: latest.version, text: 'later' }]);
  const resent = await f.send(reopened);
  assert.deepEqual(resent.task.snapshot.requestReferences!.order, snapshot.requestReferences!.order);
  assert.deepEqual(resent.task.snapshot.referenceContent.assets, snapshot.referenceContent.assets);
});
