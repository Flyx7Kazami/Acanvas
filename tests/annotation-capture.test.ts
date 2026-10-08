import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { request as rawRequest } from 'node:http';
import { startServer, type RunningServer } from '../src/server/http.js';
import { cli } from '../src/cli.js';
import type { AnnotationCaptureInput, AnnotationInput, Asset, BoardObject, CaptureResult, Draft, Task } from '../src/shared/types.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFUlEQVR4nGP438HwH4QZGNL+/wdhAFaqCdWXkbmzAAAAAElFTkSuQmCC', 'base64');
const timestamp = '2026-10-08T01:00:00.000Z';
async function fixture(t: test.TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'acanvas-capture-test-')));
  let running = await startServer({ root, port: 0 });
  let bootstrap = await (await fetch(`${running.url}/api/bootstrap`)).json();
  const raw = (path: string, method = 'GET', body?: unknown) => fetch(`${running.url}${path}`, { method, headers: { Authorization: `Bearer ${bootstrap.token}`, ...(body && !Buffer.isBuffer(body) ? { 'Content-Type': 'application/json' } : {}) }, ...(body === undefined ? {} : { body: Buffer.isBuffer(body) ? new Uint8Array(body) : JSON.stringify(body) }) });
  const call = async (path: string, method = 'GET', body?: unknown, expected = 200) => { const response = await raw(path, method, body); const value = await response.json(); assert.equal(response.status, expected, JSON.stringify(value)); return value; };
  const session = async (name = 'A') => call('/api/sessions', 'POST', { name }, 201);
  const state = (sessionId: string) => call(`/api/state?sessionId=${sessionId}`);
  const save = (draft: Draft, changes: Partial<Draft>) => call(`/api/sessions/${draft.sessionId}/draft`, 'PUT', { ...draft, ...changes });
  const upload = async (name = 'reference.png', mime = 'image/png') => { const response = await fetch(`${running.url}/api/assets?name=${name}&mime=${mime}`, { method: 'POST', headers: { Authorization: `Bearer ${bootstrap.token}` }, body: new Uint8Array(png) }); assert.equal(response.status, 201); return await response.json() as Asset; };
  const object = async (sessionId: string, asset: Asset, x = 10) => (await call('/api/board/operations', 'POST', { sessionId, operations: [{ type: 'create', object: { assetId: asset.id, x, y: 20, width: 100, height: 80 } }] })).objects.at(-1) as BoardObject;
  const path = (draft: Draft, annotation: AnnotationInput) => `/api/sessions/${draft.sessionId}/drafts/${draft.id}/annotations/${annotation.id}/captures/${annotation.captureState!.version}`;
  const capture = async (draft: Draft, annotation: AnnotationInput, input: AnnotationCaptureInput) => { await call(path(draft, annotation), 'POST', input); return await call(`${path(draft, annotation)}/content`, 'PUT', png) as CaptureResult; };
  const send = (draft: Draft) => call(`/api/sessions/${draft.sessionId}/tasks`, 'POST', { draftId: draft.id, expectedRevision: draft.revision });
  t.after(async () => { await running.close(); await rm(root, { force: true, recursive: true }); });
  return { root, raw, call, session, state, save, upload, object, path, capture, send, get running() { return running; }, get token() { return bootstrap.token; }, async restart() { await running.close(); running = await startServer({ root, port: 0 }); bootstrap = await (await fetch(`${running.url}/api/bootstrap`)).json(); } };
}
const note = (object?: BoardObject, id = 'note'): AnnotationInput => ({ id, scope: object ? 'object' : 'region', coordinateSpace: object ? 'normalized' : 'world', ...(object ? { objectId: object.id, assetId: object.assetId } : {}), objectIds: object ? [object.id] : [], bounds: { x: object ? .2 : 200, y: object ? .3 : 100, width: .2, height: .2 }, geometry: 'rect', text: 'Keep the quiet light.', captureState: { version: 1, status: 'incomplete' } });
const metadata = (annotation: AnnotationInput, object?: BoardObject, asset?: Asset): AnnotationCaptureInput => {
  const { id, text, captureState, capture, ...target } = annotation;
  return { capturedAt: timestamp, target, worldBounds: { x: 30, y: 44, width: 20, height: 16 }, viewport: { x: 0, y: 0, zoom: 1, width: 800, height: 600, devicePixelRatio: 2 }, mapping: { crop: { x: 0, y: 0, width: 400, height: 300 }, pixelWidth: 2, pixelHeight: 2, scaleX: 2 / 400, scaleY: 2 / 300 }, scene: { objects: object ? [{ object, renderedBounds: { x: object.x + 3, y: object.y, width: object.width, height: object.height }, layer: 2 }] : [], assets: asset ? [asset] : [], omittedCount: 0 }, image: { mime: 'image/png', width: 2, height: 2, bytes: png.length } };
};

test('capture state, preparation and failed bytes survive restart; stale completion and downgrade remain rejected', async t => {
  const f = await fixture(t), a = await f.session(), asset = await f.upload(), object = await f.object(a.id, asset);
  let draft: Draft = await f.save((await f.state(a.id)).draft, { annotations: [note(object)] });
  await f.call(`/api/sessions/${a.id}/tasks`, 'POST', { draftId: draft.id, expectedRevision: draft.revision }, 409);
  await f.call(f.path(draft, draft.annotations[0]), 'POST', metadata(draft.annotations[0], object, asset));
  await f.restart(); assert.deepEqual((await f.state(a.id)).draft, draft);
  assert.equal((await f.call(f.path(draft, draft.annotations[0]))).status, 'prepared');
  await new Promise<void>(resolve => {
    const request = rawRequest(`${f.running.url}${f.path(draft, draft.annotations[0])}/content`, { method: 'PUT', headers: { Authorization: `Bearer ${f.token}`, 'Content-Length': png.length } });
    request.on('error', () => resolve()); request.write(png.subarray(0, 30)); setTimeout(() => request.destroy(new Error('Capture cancelled.')), 30);
  });
  await f.restart(); assert.equal((await f.call(f.path(draft, draft.annotations[0]))).status, 'prepared');
  assert.equal((await readdir(join(f.root, '.acanvas', 'tmp'))).length, 0);
  const damaged = Buffer.from(png); damaged[50] ^= 1;
  await f.call(`${f.path(draft, draft.annotations[0])}/content`, 'PUT', damaged, 409);
  await f.restart(); assert.equal((await f.state(a.id)).draft.annotations[0].captureState.status, 'incomplete');
  await f.call(`/api/sessions/${a.id}/draft`, 'PUT', { ...draft, annotations: [{ ...draft.annotations[0], captureState: { version: 1, status: 'complete', captureId: 'forged' } }] }, 409);
  const old = draft;
  draft = await f.save(draft, { annotations: [{ ...draft.annotations[0], bounds: { x: .3, y: .3, width: .2, height: .2 } }] });
  assert.deepEqual(draft.annotations[0].captureState, { version: 2, status: 'incomplete' });
  await f.call(`${f.path(old, old.annotations[0])}/content`, 'PUT', png, 409);
  await f.call(f.path(old, old.annotations[0]), 'GET', undefined, 409);
  const { captureState, ...downgrade } = draft.annotations[0];
  await f.call(`/api/sessions/${a.id}/draft`, 'PUT', { ...draft, annotations: [downgrade] }, 409);
  draft = await f.save(draft, { annotations: [] });
  await f.call(`/api/sessions/${a.id}/draft`, 'PUT', { ...draft, annotations: [downgrade] }, 409);
});

test('capture commit and draft send recover unread responses with one asset and one task through CLI', async t => {
  const f = await fixture(t), a = await f.session(), asset = await f.upload(), object = await f.object(a.id, asset);
  let draft: Draft = await f.save((await f.state(a.id)).draft, { text: 'Use this view.', annotations: [note(object)] });
  const inputFile = join(f.root, 'capture.json'), imageFile = join(f.root, 'capture.png');
  await writeFile(inputFile, JSON.stringify(metadata(draft.annotations[0], object, asset))); await writeFile(imageFile, png);
  const args = ['--project', f.root, '--url', f.running.url, '--session', a.id, '--draft', draft.id, '--annotation', 'note', '--version', '1'];
  const prepared = await cli(['capture', 'prepare', ...args, '--input', inputFile]) as CaptureResult;
  const response = await f.raw(`${f.path(draft, draft.annotations[0])}/content`, 'PUT', png); assert.equal(response.status, 200); await response.body?.cancel();
  await f.restart(); args[args.indexOf('--url') + 1] = f.running.url;
  const result = await cli(['capture', 'result', ...args]) as CaptureResult;
  assert.equal(result.capture.id, prepared.capture.id); assert.equal(result.status, 'committed'); draft = result.draft!;
  const repeated = await cli(['capture', 'commit', ...args, '--file', imageFile]) as CaptureResult;
  assert.equal(repeated.capture.screenshotAssetId, result.capture.screenshotAssetId);
  assert.equal(f.running.service.assets().filter(asset => asset.evidence).length, 1);
  const current = await f.save(draft, { annotations: [{ ...draft.annotations[0], text: 'Keep the original view with warmer light.' }] });
  assert.deepEqual(current.annotations[0].capture, draft.annotations[0].capture);
  const lost = await f.raw(`/api/sessions/${a.id}/tasks`, 'POST', { draftId: current.id, expectedRevision: current.revision }); assert.equal(lost.status, 200); await lost.body?.cancel();
  await f.restart();
  const sent = await cli(['draft', 'send', '--project', f.root, '--url', f.running.url, '--session', a.id, '--draft', current.id, '--revision', String(current.revision)]) as { task: Task };
  assert.equal((await f.state(a.id)).tasks.length, 1); assert.deepEqual(sent.task.snapshot.annotations[0].capture, draft.annotations[0].capture);
  const out = join(f.root, 'read.png');
  await cli(['asset', 'read', '--project', f.root, '--url', f.running.url, '--session', a.id, '--asset', result.capture.screenshotAssetId, '--out', out]);
  assert.deepEqual(await readFile(out), png);
});

test('two captures of one object preserve separate geometry after move, deletion and sending', async t => {
  const f = await fixture(t), a = await f.session(), asset = await f.upload(), object = await f.object(a.id, asset);
  let draft: Draft = await f.save((await f.state(a.id)).draft, { annotations: [note(object, 'first')] });
  draft = (await f.capture(draft, draft.annotations[0], metadata(draft.annotations[0], object, asset))).draft!;
  await f.call('/api/board/operations', 'POST', { sessionId: a.id, operations: [{ type: 'update', objectId: object.id, expectedVersion: 1, changes: { x: 230, width: 150 } }] });
  const moved: BoardObject = (await f.state(a.id)).objects[0];
  draft = await f.save(draft, { annotations: [...draft.annotations, note(moved, 'second')] });
  draft = (await f.capture(draft, draft.annotations[1], metadata(draft.annotations[1], moved, asset))).draft!;
  await f.call('/api/board/operations', 'POST', { sessionId: a.id, operations: [{ type: 'delete', objectId: object.id, expectedVersion: 2 }] });
  draft = await f.save(draft, { text: 'Both recorded scenes matter.' });
  const sent = await f.send(draft), annotations = sent.task.snapshot.annotations as AnnotationInput[];
  assert.deepEqual(annotations.map(value => value.capture!.scene.objects[0].object.x), [10, 230]);
  assert.deepEqual(annotations.map(value => value.capture!.scene.objects[0].renderedBounds.x), [13, 233]);
  assert.deepEqual(annotations.map(value => value.capture!.scene.objects[0].object.version), [1, 2]);
  assert.equal(sent.task.snapshot.referenceContent.objects.length, 0); assert.equal((await f.state(a.id)).annotations.length, 0);
  const replay = await f.call(f.path(draft, draft.annotations[0]), 'POST', metadata(note(object, 'first'), object, asset));
  assert.equal(replay.status, 'committed'); assert.equal(replay.capture.id, annotations[0].capture!.id);
});

test('queued text edits inherit capture ownership; target edits require a new capture and cancel restores the original draft', async t => {
  const f = await fixture(t), a = await f.session(), asset = await f.upload(), object = await f.object(a.id, asset);
  let draft: Draft = await f.save((await f.state(a.id)).draft, { annotations: [note(object)] });
  draft = (await f.capture(draft, draft.annotations[0], metadata(draft.annotations[0], object, asset))).draft!;
  const sent = await f.send(draft), task: Task = sent.task;
  let ordinary: Draft = await f.save(sent.draft, { annotations: [note(object, 'next')] });
  ordinary = (await f.capture(ordinary, ordinary.annotations[0], metadata(ordinary.annotations[0], object, asset))).draft!;
  const begin = () => f.call(`/api/sessions/${a.id}/tasks/${task.id}/edit`, 'POST', { draftId: ordinary.id, expectedRevision: ordinary.revision });
  let edit: Draft = (await begin()).draft;
  edit = await f.save(edit, { text: 'New request text.', annotations: [{ ...edit.annotations[0], text: 'New comment.' }] });
  const revised = await f.send(edit); assert.equal(revised.task.id, task.id); assert.equal(revised.task.sequence, task.sequence);
  assert.deepEqual(revised.task.snapshot.annotations[0].capture, task.snapshot.annotations[0].capture);
  assert.equal(revised.draft.id, ordinary.id); assert.deepEqual(revised.draft.annotations, ordinary.annotations); ordinary = revised.draft;
  edit = (await begin()).draft;
  edit = await f.save(edit, { annotations: [{ ...edit.annotations[0], bounds: { x: .4, y: .3, width: .2, height: .2 } }] });
  assert.equal(edit.annotations[0].captureState!.version, 2); assert.equal(edit.annotations[0].capture, undefined);
  await f.call(`/api/sessions/${a.id}/tasks`, 'POST', { draftId: edit.id, expectedRevision: edit.revision }, 409);
  edit = (await f.capture(edit, edit.annotations[0], metadata(edit.annotations[0], object, asset))).draft!;
  const refreshed = await f.send(edit); assert.equal(refreshed.task.id, task.id); assert.equal(refreshed.task.snapshot.annotations[0].capture.draftId, edit.id);
  ordinary = refreshed.draft; edit = (await begin()).draft;
  edit = await f.save(edit, { text: 'Discard this edit.' }); await f.restart();
  const cancelled = await f.call(`/api/sessions/${a.id}/tasks/${task.id}/cancel-edit`, 'POST', { draftId: edit.id, expectedRevision: edit.revision });
  assert.equal(cancelled.draft.id, ordinary.id); assert.deepEqual(cancelled.draft.annotations, ordinary.annotations);
});

test('evidence reads and writes keep session ownership across content, range, metadata and indirect task contexts', async t => {
  const f = await fixture(t), a = await f.session(), b = await f.session('B'), asset = await f.upload(), object = await f.object(a.id, asset);
  let draft: Draft = await f.save((await f.state(a.id)).draft, { annotations: [note(object)] });
  const captured = await f.capture(draft, draft.annotations[0], metadata(draft.annotations[0], object, asset)); draft = captured.draft!;
  const id = captured.capture.screenshotAssetId, evidence = f.running.service.asset(id);
  assert.equal((await f.state(b.id)).assets.some((asset: Asset) => asset.id === id), false);
  assert.equal((await f.state(b.id)).draft.annotations.length, 0);
  for (const method of ['GET', 'HEAD']) for (const suffix of ['content', 'artwork']) {
    for (const query of ['', `?sessionId=${b.id}`]) assert.equal((await f.raw(`/api/assets/${id}/${suffix}${query}`, method)).status, 403);
  }
  const content = await f.raw(`/api/assets/${id}/content?sessionId=${a.id}`); assert.equal(content.status, 200); assert.deepEqual(Buffer.from(await content.arrayBuffer()), png);
  assert.equal((await f.raw(`/api/assets/${id}/content?sessionId=${a.id}`, 'HEAD')).status, 200);
  const ranged = await fetch(`${f.running.url}/api/assets/${id}/content?sessionId=${a.id}`, { headers: { Authorization: `Bearer ${f.token}`, Range: 'bytes=0-9' } }); assert.equal(ranged.status, 206);
  const forbiddenRange = await fetch(`${f.running.url}/api/assets/${id}/content?sessionId=${b.id}`, { headers: { Authorization: `Bearer ${f.token}`, Range: 'bytes=0-9' } }); assert.equal(forbiddenRange.status, 403);
  await f.call(`/api/assets/${id}/html-preview`, 'POST', {}, 403);
  await f.call('/api/board/operations', 'POST', { sessionId: a.id, operations: [{ type: 'create', object: { assetId: id, x: 0, y: 0, width: 1, height: 1 } }] }, 403);
  await f.call(`/api/sessions/${a.id}/draft`, 'PUT', { ...draft, attachments: [id] }, 403);
  await f.call(`/api/sessions/${a.id}/draft`, 'PUT', { ...draft, annotations: [{ ...note(undefined, 'evidence-target'), assetId: id }] }, 403);
  await f.call('/api/html-bundles', 'POST', { entryPath: 'index.html', files: { 'index.html': id } }, 403);
  assert.throws(() => f.running.service.registerAsset({ ...evidence, id: 'copied' }, `assets/../evidence/${captured.capture.id}.png`), /capture operation/);
  const sent = await f.send(draft), otherDraft: Draft = (await f.state(b.id)).draft;
  await f.call(`/api/sessions/${b.id}/draft`, 'PUT', { ...otherDraft, references: { objectIds: [], taskIds: [sent.task.id] } }, 403);
  // Seed a preexisting reference to exercise the documented historical continuation.
  f.running.service.db.prepare('UPDATE drafts SET references_json=? WHERE id=?').run(JSON.stringify({ objectIds: [], taskIds: [sent.task.id] }), otherDraft.id);
  let historical: Draft = await f.save((await f.state(b.id)).draft, { text: 'Preserve the saved reference.' });
  const otherTask = await f.send(historical);
  const context = await f.call(`/api/sessions/${b.id}/tasks/${otherTask.task.id}/context`);
  assert.equal(context.context.referencedTasks[0].snapshot.annotations.length, 0);
  assert.equal(context.context.referencedTasks[0].snapshot.referenceContent.assets.some((value: Asset) => value.evidence), false);
  let edit: Draft = (await f.call(`/api/sessions/${b.id}/tasks/${otherTask.task.id}/edit`, 'POST', { draftId: otherTask.draft.id, expectedRevision: otherTask.draft.revision })).draft;
  edit = await f.save(edit, { text: 'Only the body changed.' }); const revised = await f.send(edit); assert.equal(revised.task.id, otherTask.task.id);
  historical = (await f.call(`/api/sessions/${b.id}/tasks/${otherTask.task.id}/edit`, 'POST', { draftId: revised.draft.id, expectedRevision: revised.draft.revision })).draft;
  historical = await f.save(historical, { references: { objectIds: [], taskIds: [] } });
  await f.call(`/api/sessions/${b.id}/draft`, 'PUT', { ...historical, references: { objectIds: [], taskIds: [sent.task.id] } }, 403);
});

test('capture input rejects unsupported images, resource limits, invalid mappings and file dimension mismatches', async t => {
  const f = await fixture(t), a = await f.session();
  const annotation = note(); let draft: Draft = await f.save((await f.state(a.id)).draft, { annotations: [annotation] });
  const input = metadata(annotation);
  for (const invalid of [{ ...input, image: { ...input.image, mime: 'image/jpeg' } }, { ...input, image: { ...input.image, bytes: 20 * 1024 * 1024 + 1 } }, { ...input, image: { ...input.image, width: 20_000 } }, { ...input, mapping: { ...input.mapping, scaleX: 2 } }]) await f.call(f.path(draft, annotation), 'POST', invalid, 400);
  const wrong = { ...input, image: { ...input.image, width: 3 }, mapping: { ...input.mapping, pixelWidth: 3, scaleX: 3 / input.mapping.crop.width } };
  await f.call(f.path(draft, annotation), 'POST', wrong);
  await f.call(`${f.path(draft, annotation)}/content`, 'PUT', png, 409);
  assert.equal((await f.state(a.id)).draft.annotations[0].captureState.status, 'incomplete');
  draft = await f.save(draft, { annotations: [{ ...annotation, bounds: { ...annotation.bounds, x: 201 } }] });
  const current = draft.annotations[0]; await f.call(f.path(draft, current), 'POST', metadata(current));
  await f.call(`${f.path(draft, current)}/content`, 'PUT', Buffer.from('not a PNG'.padEnd(png.length)), 409);
  const invalidCompressedPixels = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFUlEQVQAnGP438HwH4QZGNL+/wdhAFaqCdWarsoAAAAAAElFTkSuQmCC', 'base64');
  await f.call(`${f.path(draft, current)}/content`, 'PUT', invalidCompressedPixels, 409);
  await f.call(`${f.path(draft, current)}/content`, 'PUT', png.subarray(0, png.length - 1), 413);
  assert.equal((await f.state(a.id)).draft.annotations[0].captureState.status, 'incomplete');
  assert.equal((await f.call(`${f.path(draft, current)}/content`, 'PUT', png)).status, 'committed');
});

test('an explicit capture retry preserves one next version after a lost response and accepts a new frame', async t => {
  const f = await fixture(t), a = await f.session();
  let draft: Draft = await f.save((await f.state(a.id)).draft, { annotations: [note()] });
  const oldPath = f.path(draft, draft.annotations[0]); await f.call(oldPath, 'POST', metadata(draft.annotations[0]));
  await f.restart(); assert.equal((await f.call(oldPath)).status, 'prepared');
  const response = await f.raw(`${oldPath}/retry`, 'POST', {}); assert.equal(response.status, 200); await response.body?.cancel();
  await f.restart();
  const retried = await f.call(`${oldPath}/retry`, 'POST', {}); assert.equal(retried.version, 2); draft = retried.draft;
  assert.equal(draft.annotations[0].captureState!.version, 2); assert.equal(draft.annotations[0].captureState!.status, 'incomplete');
  const again = await f.call(`${oldPath}/retry`, 'POST', {}); assert.equal(again.draft.revision, draft.revision);
  await f.call(`${oldPath}/content`, 'PUT', png, 409);
  const newFrame = { ...metadata(draft.annotations[0]), capturedAt: '2026-10-08T01:05:00.000Z' };
  draft = (await f.capture(draft, draft.annotations[0], newFrame)).draft!;
  const sent = await f.send(draft); assert.equal(sent.task.snapshot.annotations[0].capture.version, 2); assert.equal(sent.task.snapshot.annotations[0].capture.capturedAt, newFrame.capturedAt);
});

test('send validates a matching committed capture version inside its task transaction', async t => {
  const f = await fixture(t), a = await f.session();
  let draft: Draft = await f.save((await f.state(a.id)).draft, { annotations: [note()] });
  draft = (await f.capture(draft, draft.annotations[0], metadata(draft.annotations[0]))).draft!;
  const changed = structuredClone(draft.annotations); changed[0].captureState!.version = 2;
  f.running.service.db.prepare('UPDATE drafts SET annotations_json=? WHERE id=?').run(JSON.stringify(changed), draft.id);
  const failed = await f.call(`/api/sessions/${a.id}/tasks`, 'POST', { draftId: draft.id, expectedRevision: draft.revision }, 409);
  assert.equal(failed.error.code, 'capture_version_conflict');
  const state = await f.state(a.id); assert.equal(state.tasks.length, 0); assert.equal(state.draft.id, draft.id); assert.equal(state.draft.revision, draft.revision);
});

test('media selection, actual playback and visual/text anchors stay independent and target edits invalidate evidence', async t => {
  const f = await fixture(t), a = await f.session(), asset = await f.upload('audio.mp3', 'audio/mpeg'), object = await f.object(a.id, asset);
  const annotation: AnnotationInput = { ...note(object), bounds: { x: .5, y: .5, width: 0, height: 0 }, geometry: 'point', timeStart: 10, timeEnd: 20, contentAnchor: { kind: 'visual', scroll: { x: 0, y: 4 } } };
  let draft: Draft = await f.save((await f.state(a.id)).draft, { annotations: [annotation] });
  const input = metadata(annotation, object, asset); input.worldBounds.width = 0; input.worldBounds.height = 0; input.scene.objects[0].media = { playbackTime: 40, representativeTime: 10 };
  draft = (await f.capture(draft, annotation, input)).draft!;
  assert.equal(draft.annotations[0].capture!.target.timeEnd, 20); assert.equal(draft.annotations[0].capture!.scene.objects[0].media!.playbackTime, 40);
  draft = await f.save(draft, { annotations: [{ ...draft.annotations[0], timeStart: 12 }] }); assert.equal(draft.annotations[0].captureState!.version, 2);
  draft = await f.save(draft, { annotations: [{ ...draft.annotations[0], contentAnchor: { kind: 'text', quote: 'Original words', path: 'paragraph/2', start: 1, end: 4 } }] }); assert.equal(draft.annotations[0].captureState!.version, 3);
  assert.equal(draft.annotations[0].capture, undefined);
  await f.call(`/api/sessions/${a.id}/tasks`, 'POST', { draftId: draft.id, expectedRevision: draft.revision }, 409);
});

test('legacy annotations retain their fields and queue text editing semantics', async t => {
  const f = await fixture(t), a = await f.session(), asset = await f.upload(), object = await f.object(a.id, asset);
  const { captureState, geometry, ...legacy } = note(object);
  const draft: Draft = await f.save((await f.state(a.id)).draft, { annotations: [legacy] });
  const sent = await f.send(draft); assert.deepEqual(sent.task.snapshot.annotations, [legacy]);
  await f.call('/api/board/operations', 'POST', { sessionId: a.id, operations: [{ type: 'delete', objectId: object.id, expectedVersion: 1 }] });
  let edit: Draft = (await f.call(`/api/sessions/${a.id}/tasks/${sent.task.id}/edit`, 'POST', { draftId: sent.draft.id, expectedRevision: sent.draft.revision })).draft;
  edit = await f.save(edit, { annotations: [{ ...legacy, text: 'Revised legacy comment.' }] });
  const saved = await f.send(edit); assert.equal(saved.task.id, sent.task.id); assert.equal(saved.task.snapshot.annotations[0].captureState, undefined); assert.equal(saved.task.snapshot.referenceContent.objects[0].x, 10);
});

test('a process crash between file publication and SQLite completion recovers one capture through result query', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'acanvas-capture-crash-')));
  let restarted: RunningServer | undefined;
  const script = `import { startServer } from './dist/src/server/http.js'; import { existsSync } from 'node:fs'; const server=await startServer({root:process.argv[1],port:0}); const original=server.service.captureResult.bind(server.service); server.service.captureResult=(...args)=>{if(existsSync(server.service.captureUpload(...args).destination))process.exit(77);return original(...args)}; console.log(JSON.stringify({url:server.url}));`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, root], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(async () => { if (child.exitCode === null) child.kill(); await restarted?.close(); await rm(root, { force: true, recursive: true }); });
  let stdout = '', stderr = ''; child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
  const ready = await Promise.race([new Promise<string>(resolve => child.stdout.on('data', () => { if (stdout.includes('\n')) resolve(stdout.trim()); })), once(child, 'exit').then(() => { throw new Error(stderr); })]);
  const url = JSON.parse(ready).url, bootstrap = await (await fetch(`${url}/api/bootstrap`)).json();
  const request = async (path: string, method = 'GET', body?: unknown) => { const response = await fetch(`${url}${path}`, { method, headers: { Authorization: `Bearer ${bootstrap.token}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); assert.equal(response.status < 300, true); return response.json(); };
  const session = await request('/api/sessions', 'POST', { name: 'Crash' });
  const initial: Draft = (await request(`/api/state?sessionId=${session.id}`)).draft;
  const annotation = note(), draft: Draft = await request(`/api/sessions/${session.id}/draft`, 'PUT', { ...initial, annotations: [annotation] });
  const path = `/api/sessions/${session.id}/drafts/${draft.id}/annotations/${annotation.id}/captures/1`;
  const prepared = await request(path, 'POST', metadata(annotation));
  const exited = once(child, 'exit');
  await assert.rejects(fetch(`${url}${path}/content`, { method: 'PUT', headers: { Authorization: `Bearer ${bootstrap.token}` }, body: new Uint8Array(png) }));
  assert.equal((await exited)[0], 77);
  restarted = await startServer({ root, port: 0 });
  const auth = await (await fetch(`${restarted.url}/api/bootstrap`)).json();
  assert.equal(restarted.service.assets().length, 0); assert.equal(restarted.service.draft(session.id).annotations[0].captureState!.status, 'incomplete');
  const result = await (await fetch(`${restarted.url}${path}`, { headers: { Authorization: `Bearer ${auth.token}` } })).json() as CaptureResult;
  assert.equal(result.status, 'committed'); assert.equal(result.capture.id, prepared.capture.id); assert.equal(restarted.service.assets().length, 1);
  const sent = restarted.service.sendDraft(session.id, draft.id, result.draft!.revision);
  assert.equal(sent.task.snapshot.annotations[0].capture!.screenshotAssetId, prepared.capture.screenshotAssetId);
});
