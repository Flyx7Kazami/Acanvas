import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { CanvasService, ApiFailure } from '../src/server/service.js';
import { annotationTarget } from '../src/server/annotation-capture.js';
import { startServer } from '../src/server/http.js';
import { cli } from '../src/cli.js';
import type { AnnotationCaptureInput, AnnotationInput, Asset, BaseSceneSnapshot, CaptureView, Draft, ScenePresentation, SceneSource } from '../src/shared/types.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFUlEQVR4nGP438HwH4QZGNL+/wdhAFaqCdWXkbmzAAAAAElFTkSuQmCC', 'base64');
const failure = (operation: () => unknown, code: string) => assert.throws(operation, (error: unknown) => error instanceof ApiFailure && error.code === code);
async function fixture(t: test.TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'acanvas-scene-source-')));
  let service = new CanvasService(root);
  const session = service.createSession('Capture A'), other = service.createSession('Capture B');
  const asset: Asset = { id: randomUUID(), name: 'still.png', mime: 'image/png', size: png.length, kind: 'image', createdAt: new Date().toISOString() };
  await writeFile(join(service.dataDir, 'assets', `${asset.id}.png`), png);
  service.registerAsset(asset, `assets/${asset.id}.png`);
  const object = service.boardOperations(session.id, [{ type: 'create', object: { assetId: asset.id, x: 10, y: 20, width: 100, height: 80 } }]).objects[0];
  const sequences = new Map<string, number>();
  const operation = (view: CaptureView) => ({ documentId: view.documentId, viewGeneration: view.viewGeneration, operationSeq: (sequences.get(view.viewId) ?? 0) + 1 });
  const next = (view: CaptureView) => { const value = operation(view); sequences.set(view.viewId, value.operationSeq); return value; };
  const view = (documentId: string = randomUUID()) => service.registerCaptureView(session.id, { documentId });
  const scene = (view: CaptureView) => service.sceneSnapshot(view.sessionId, view.viewId, next(view));
  const presentation = (view: CaptureView, snapshot: BaseSceneSnapshot, frameSeq = 1): ScenePresentation => ({ documentId: view.documentId, viewId: view.viewId, frameSeq, baseSceneId: snapshot.id, camera: { x: 0, y: 0, zoom: 1 }, cssViewport: { x: 0, y: 0, width: 800, height: 600 }, bitmap: { width: 2, height: 2 }, layers: snapshot.objects.map((object, layer) => ({ objectId: object.id, assetId: object.assetId, objectVersion: object.version, worldBounds: { x: object.x + 3, y: object.y, width: object.width, height: object.height }, renderedBounds: { x: object.x + 3, y: object.y, width: object.width, height: object.height }, layer })), media: [] });
  const present = (view: CaptureView, presentation: ScenePresentation) => service.confirmScenePresentation(view.sessionId, view.viewId, { ...next(view), presentation });
  const hold = (view: CaptureView, presentation: ScenePresentation) => service.holdScenePresentation(view.sessionId, view.viewId, { ...next(view), presentation });
  const note = (source: SceneSource, id = 'note'): AnnotationInput => ({ id, scope: 'object', objectId: object.id, objectIds: [object.id], assetId: asset.id, coordinateSpace: 'normalized', bounds: { x: .2, y: .3, width: .2, height: .2 }, text: 'Preserve this scene.', geometry: 'rect', captureState: { version: 1, status: 'incomplete' }, sceneSource: source });
  const save = (draft: Draft, annotation: AnnotationInput) => service.saveDraft(session.id, { ...draft, annotations: [annotation] });
  const metadata = (annotation: AnnotationInput, snapshot: BaseSceneSnapshot, presentation: ScenePresentation): AnnotationCaptureInput => {
    const targetIds = new Set([...annotation.objectIds, ...(annotation.objectId ? [annotation.objectId] : [])]);
    const selected = [...snapshot.objects.filter(object => targetIds.has(object.id)), ...snapshot.objects.filter(object => !targetIds.has(object.id))].slice(0, 64);
    const objects = selected.map(object => { const layer = presentation.layers.find(layer => layer.objectId === object.id)!; return { object, renderedBounds: layer.worldBounds, layer: layer.layer }; });
    return { capturedAt: new Date().toISOString(), target: annotationTarget(annotation), worldBounds: { x: 33, y: 44, width: 20, height: 16 }, viewport: { x: 0, y: 0, zoom: 1, width: 800, height: 600, devicePixelRatio: 1 }, mapping: { crop: presentation.cssViewport, pixelWidth: 2, pixelHeight: 2, scaleX: 2 / 800, scaleY: 2 / 600 }, scene: { objects, assets: [asset], omittedCount: Math.max(0, snapshot.objects.length - 64) }, image: { mime: 'image/png', width: 2, height: 2, bytes: png.length }, sourceMode: 'scene-bitmap', sceneSource: annotation.sceneSource, presentation };
  };
  const capture = async (draft: Draft, input: AnnotationCaptureInput) => { const annotation = draft.annotations[0], version = annotation.captureState!.version; service.prepareCapture(session.id, draft.id, annotation.id, version, input); await writeFile(service.captureUpload(session.id, draft.id, annotation.id, version).destination, png); return service.captureResult(session.id, draft.id, annotation.id, version); };
  t.after(async () => { service.close(); await rm(root, { recursive: true, force: true }); });
  return { root, session, other, asset, object, next, view, scene, presentation, present, hold, note, save, metadata, capture, get service() { return service; }, restart() { service.close(); service = new CanvasService(root); } };
}

test('Done sources preserve early moved and deleted objects through draft, preparation, restart and Send', async t => {
  const f = await fixture(t), view = f.view(), snapshot = f.scene(view), presentation = f.presentation(view, snapshot);
  f.present(view, presentation); const source = f.hold(view, presentation);
  f.service.boardOperations(f.other.id, [{ type: 'update', objectId: f.object.id, expectedVersion: 1, changes: { x: 200 } }]);
  f.service.boardOperations(f.other.id, [{ type: 'delete', objectId: f.object.id, expectedVersion: 2 }]);
  const raw = f.note(source), { sceneSource, ...unconfirmed } = raw;
  failure(() => f.save(f.service.draft(f.session.id), unconfirmed), 'object_missing');
  let draft = f.save(f.service.draft(f.session.id), raw);
  f.restart(); draft = f.service.draft(f.session.id);
  const metadata = f.metadata(draft.annotations[0], snapshot, presentation);
  draft = (await f.capture(draft, metadata)).draft!;
  f.restart(); draft = f.service.draft(f.session.id);
  draft = f.save(draft, { ...draft.annotations[0], text: 'A revised comment keeps the scene.' });
  const sent = f.service.sendDraft(f.session.id, draft.id, draft.revision);
  assert.equal(sent.task.snapshot.annotations[0].capture!.scene.objects[0].object.x, 10);
  assert.deepEqual(sent.task.snapshot.annotations[0].capture!.presentation, presentation);
  assert.equal(sent.task.snapshot.referenceContent.objects.length, 0);
});

test('two documents in one session keep separate views and refuse source scope, sequence and identity substitutions', async t => {
  const f = await fixture(t), a = f.view(), b = f.view(), snapshot = f.scene(a), presentation = f.presentation(a, snapshot);
  assert.notEqual(a.viewId, b.viewId); assert.equal(a.sessionId, b.sessionId);
  failure(() => f.service.confirmScenePresentation(b.sessionId, b.viewId, { ...f.next(b), presentation: { ...presentation, documentId: b.documentId, viewId: b.viewId } }), 'scene_source_missing');
  f.present(a, presentation); const op = { ...f.next(a), presentation }, source = f.service.holdScenePresentation(a.sessionId, a.viewId, op);
  assert.deepEqual(f.service.holdScenePresentation(a.sessionId, a.viewId, op), source);
  failure(() => f.service.holdScenePresentation(a.sessionId, a.viewId, { ...op, presentation: { ...presentation, frameSeq: 2 } }), 'scene_operation_conflict');
  failure(() => f.service.holdScenePresentation(f.other.id, a.viewId, op), 'scene_scope');
  failure(() => f.save(f.service.draft(f.session.id), f.note({ ...source, viewId: b.viewId })), 'scene_source_missing');
  failure(() => f.save(f.service.draft(f.session.id), f.note({ ...source, sessionId: f.other.id })), 'scene_scope');
  failure(() => f.service.sceneSnapshot(a.sessionId, a.viewId, { ...f.next(a), viewGeneration: 22 }), 'scene_view_conflict');
});

test('current presentation survives candidate expiry and retention; unheld candidates and expired Done holds require renewal', async t => {
  const f = await fixture(t), view = f.view(), snapshot = f.scene(view), presentation = f.presentation(view, snapshot);
  f.present(view, presentation);
  f.service.db.prepare('UPDATE capture_scenes SET expires_at=0 WHERE id=?').run(snapshot.id);
  for (let count = 0; count < 12; count++) f.scene(view);
  assert.ok(f.service.db.prepare('SELECT id FROM capture_scenes WHERE id=?').get(snapshot.id));
  const source = f.hold(view, presentation);
  f.service.db.prepare('UPDATE scene_sources SET expires_at=0 WHERE id=?').run(source.id);
  failure(() => f.save(f.service.draft(f.session.id), f.note(source)), 'scene_source_expired');
  const refreshed = f.hold(view, presentation); let draft = f.save(f.service.draft(f.session.id), f.note(refreshed));
  f.service.db.prepare('UPDATE scene_sources SET expires_at=0 WHERE id=?').run(refreshed.id);
  draft = f.save(draft, { ...draft.annotations[0], text: 'Durable source.' }); assert.equal(draft.annotations[0].sceneSource!.id, refreshed.id);
  const candidate = f.scene(view); f.service.db.prepare('UPDATE capture_scenes SET expires_at=0 WHERE id=?').run(candidate.id);
  failure(() => f.present(view, f.presentation(view, candidate, 2)), 'scene_source_expired');
});

test('closing a view invalidates fresh holds while saved evidence can finish and retry after restart', async t => {
  const f = await fixture(t), view = f.view(), snapshot = f.scene(view), presentation = f.presentation(view, snapshot);
  f.present(view, presentation); const source = f.hold(view, presentation); let draft = f.save(f.service.draft(f.session.id), f.note(source));
  const metadata = f.metadata(draft.annotations[0], snapshot, presentation);
  f.service.prepareCapture(view.sessionId, draft.id, 'note', 1, metadata);
  f.service.closeCaptureView(view.sessionId, view.viewId, f.next(view));
  failure(() => f.hold(view, presentation), 'scene_view_closed');
  const replacement = f.view(view.documentId); assert.equal(replacement.viewGeneration, view.viewGeneration + 1); assert.notEqual(replacement.viewId, view.viewId);
  f.restart(); const retry = f.service.retryCapture(view.sessionId, draft.id, 'note', 1); draft = retry.draft;
  failure(() => f.service.captureUpload(view.sessionId, draft.id, 'note', 1), 'capture_version_conflict');
  draft = (await f.capture(draft, f.metadata(draft.annotations[0], snapshot, presentation))).draft!;
  assert.equal(draft.annotations[0].capture!.version, 2); assert.equal(draft.annotations[0].capture!.sceneSource!.id, source.id);
});

test('new target or Done source updates the capture version; queued text edits inherit source ownership', async t => {
  const f = await fixture(t), view = f.view(), snapshot = f.scene(view), presentation = f.presentation(view, snapshot);
  f.present(view, presentation); let draft = f.save(f.service.draft(f.session.id), f.note(f.hold(view, presentation)));
  draft = (await f.capture(draft, f.metadata(draft.annotations[0], snapshot, presentation))).draft!;
  const sent = f.service.sendDraft(view.sessionId, draft.id, draft.revision);
  let edit = f.service.beginTaskEdit(view.sessionId, sent.task.id, { draftId: sent.draft.id, expectedRevision: sent.draft.revision }).draft;
  f.service.boardOperations(f.other.id, [{ type: 'delete', objectId: f.object.id, expectedVersion: 1 }]);
  edit = f.save(edit, { ...edit.annotations[0], text: 'Edit a saved comment.' });
  const edited = f.service.sendDraft(view.sessionId, edit.id, edit.revision); assert.equal(edited.task.snapshot.annotations[0].sceneSource!.id, draft.annotations[0].sceneSource!.id);
  edit = f.service.beginTaskEdit(view.sessionId, sent.task.id, { draftId: edited.draft.id, expectedRevision: edited.draft.revision }).draft;
  const nextFrame = { ...presentation, frameSeq: 2 }; f.present(view, nextFrame); const newSource = f.hold(view, nextFrame);
  edit = f.save(edit, { ...edit.annotations[0], sceneSource: newSource, bounds: { ...edit.annotations[0].bounds, x: .4 } });
  assert.equal(edit.annotations[0].captureState!.version, 2); assert.equal(edit.annotations[0].capture, undefined);
  failure(() => f.service.sendDraft(view.sessionId, edit.id, edit.revision), 'annotation_incomplete');
  const input = f.metadata(edit.annotations[0], snapshot, nextFrame); input.worldBounds.x = 53;
  edit = (await f.capture(edit, input)).draft!; f.service.sendDraft(view.sessionId, edit.id, edit.revision);
});

test('render delivery includes all objects while scene references retain their independent 64 object limit', async t => {
  const f = await fixture(t);
  f.service.boardOperations(f.session.id, Array.from({ length: 69 }, (_, index) => ({ type: 'create' as const, object: { assetId: f.asset.id, x: 130 + index * 2, y: 10, width: 1, height: 1 } })));
  const view = f.view(), snapshot = f.scene(view), presentation = f.presentation(view, snapshot);
  assert.equal(snapshot.objects.length, 70); assert.equal(presentation.layers.length, 70);
  f.present(view, presentation); const draft = f.save(f.service.draft(f.session.id), f.note(f.hold(view, presentation))), input = f.metadata(draft.annotations[0], snapshot, presentation);
  const capture = f.service.prepareCapture(view.sessionId, draft.id, 'note', 1, input).capture;
  assert.equal(capture.scene.objects.length, 64); assert.equal(capture.scene.omittedCount, 6); assert.equal(capture.presentation!.layers.length, 70);
});

test('confirmed source checks presentation geometry, rendered identities and HTML surface ownership', async t => {
  const f = await fixture(t), view = f.view(), snapshot = f.scene(view), presentation = f.presentation(view, snapshot);
  const forged = structuredClone(presentation); forged.layers[0].objectVersion = 91;
  failure(() => f.present(view, forged), 'scene_object_conflict');
  const surface = structuredClone(presentation); surface.layers[0].surface = { surfaceId: 's', instanceId: 'i', frameSeq: 1, inputSeq: 0, viewport: { width: 100, height: 80 } };
  failure(() => f.present(view, surface), 'surface_unavailable');
  let owner: unknown; f.service.validateSurface = current => { owner = current; };
  f.present(view, surface); assert.deepEqual(owner, { ...view, objectId: f.object.id, assetId: f.asset.id });
  const draft = f.save(f.service.draft(f.session.id), f.note(f.hold(view, surface))), input = f.metadata(draft.annotations[0], snapshot, surface);
  failure(() => f.service.prepareCapture(view.sessionId, draft.id, 'note', 1, { ...input, presentation: { ...surface, frameSeq: 99 } }), 'scene_source_conflict');
  const shifted = structuredClone(input); shifted.scene.objects[0].renderedBounds.x += 1;
  failure(() => f.service.prepareCapture(view.sessionId, draft.id, 'note', 1, shifted), 'scene_source_conflict');
  const wrongGeometry = structuredClone(input); wrongGeometry.worldBounds.x += 1;
  failure(() => f.service.prepareCapture(view.sessionId, draft.id, 'note', 1, wrongGeometry), 'invalid_capture');
  const changed = structuredClone(draft.annotations); changed[0].sceneSource!.documentId = 'another-document';
  f.service.db.prepare('UPDATE drafts SET annotations_json=? WHERE id=?').run(JSON.stringify(changed), draft.id);
  failure(() => f.service.draft(view.sessionId), 'scene_source_conflict');
});

test('source binding shares the draft transaction and explicit object references keep their own Send rule', async t => {
  const f = await fixture(t), view = f.view(), snapshot = f.scene(view), presentation = f.presentation(view, snapshot);
  f.present(view, presentation); const annotation = f.note(f.hold(view, presentation)), original = f.service.draft(view.sessionId);
  failure(() => f.service.saveDraft(view.sessionId, { ...original, annotations: [annotation], references: { objectIds: ['unavailable'], taskIds: [] } }), 'object_missing');
  assert.equal((f.service.db.prepare('SELECT COUNT(*) AS count FROM annotation_sources').get() as { count: number }).count, 0);
  assert.equal(f.service.draft(view.sessionId).revision, original.revision);
  let draft = f.service.saveDraft(view.sessionId, { ...original, annotations: [annotation], references: { objectIds: [f.object.id], taskIds: [] } });
  draft = (await f.capture(draft, f.metadata(draft.annotations[0], snapshot, presentation))).draft!;
  f.service.boardOperations(f.other.id, [{ type: 'delete', objectId: f.object.id, expectedVersion: 1 }]);
  draft = f.save(draft, { ...draft.annotations[0], text: 'Preserve annotation evidence.' });
  failure(() => f.service.sendDraft(view.sessionId, draft.id, draft.revision), 'object_reference_unavailable');
  draft = f.service.saveDraft(view.sessionId, { ...draft, references: { objectIds: [], taskIds: [] } });
  assert.equal(f.service.sendDraft(view.sessionId, draft.id, draft.revision).task.snapshot.annotations[0].capture!.scene.objects[0].object.id, f.object.id);
});

test('a saved target edit awaits its own new Done source at the same edit version and preserves old evidence history', async t => {
  const f = await fixture(t), view = f.view(), snapshot = f.scene(view), presentation = f.presentation(view, snapshot);
  f.present(view, presentation); const originalSource = f.hold(view, presentation);
  let draft = f.save(f.service.draft(view.sessionId), f.note(originalSource));
  draft = (await f.capture(draft, f.metadata(draft.annotations[0], snapshot, presentation))).draft!;
  const original = draft.annotations[0], oldCapture = original.capture!;
  draft = f.save(draft, { ...original, text: 'Comment-only change.' });
  assert.equal(draft.annotations[0].captureState!.version, 1); assert.equal(draft.annotations[0].capture!.id, oldCapture.id);
  const region: AnnotationInput = { ...draft.annotations[0], scope: 'region', coordinateSpace: 'world', objectId: undefined, objectIds: [], assetId: undefined, bounds: { x: 33, y: 44, width: 20, height: 16 }, sceneSource: undefined };
  draft = f.save(draft, region);
  assert.deepEqual(draft.annotations[0].captureState, { version: 2, status: 'incomplete' }); assert.equal(draft.annotations[0].capture, undefined); assert.equal(draft.annotations[0].sceneSource, undefined);
  assert.equal((f.service.db.prepare('SELECT state FROM annotation_sources WHERE session_id=? AND draft_id=? AND annotation_id=? AND version=2').get(view.sessionId, draft.id, original.id) as { state: string }).state, 'awaiting');
  failure(() => f.service.sendDraft(view.sessionId, draft.id, draft.revision), 'annotation_incomplete');
  failure(() => f.service.prepareCapture(view.sessionId, draft.id, original.id, 2, { ...f.metadata(draft.annotations[0], snapshot, presentation), sourceMode: undefined, sceneSource: undefined, presentation: undefined }), 'scene_source_missing');
  failure(() => f.save(draft, { ...draft.annotations[0], sceneSource: originalSource }), 'scene_source_conflict');
  const newSource = f.hold(view, presentation);
  draft = f.save(draft, { ...draft.annotations[0], sceneSource: newSource });
  assert.equal(draft.annotations[0].captureState!.version, 2);
  draft = (await f.capture(draft, f.metadata(draft.annotations[0], snapshot, presentation))).draft!;
  assert.equal(draft.annotations[0].captureState!.status, 'complete'); assert.equal(draft.annotations[0].capture!.version, 2);
  const current = draft.annotations[0].capture!;
  assert.notEqual(current.id, oldCapture.id); assert.notEqual(current.sceneSource!.id, oldCapture.sceneSource!.id);
  const historical = f.service.captureResult(view.sessionId, oldCapture.draftId, original.id, 1);
  assert.equal(historical.capture.id, oldCapture.id); assert.equal(historical.draft!.annotations[0].captureState!.version, 2);
  const sent = f.service.sendDraft(view.sessionId, draft.id, draft.revision); assert.equal(sent.task.snapshot.annotations[0].capture!.id, current.id);
});

test('changing a pending target back uses a new version; missing object targets fail without altering saved evidence', async t => {
  const f = await fixture(t), view = f.view(), snapshot = f.scene(view), presentation = f.presentation(view, snapshot);
  f.present(view, presentation); let draft = f.save(f.service.draft(view.sessionId), f.note(f.hold(view, presentation)));
  draft = (await f.capture(draft, f.metadata(draft.annotations[0], snapshot, presentation))).draft!;
  const original = draft.annotations[0], change = { ...original, bounds: { ...original.bounds, x: .4 } };
  draft = f.save(draft, change); assert.equal(draft.annotations[0].captureState!.version, 2); assert.equal(draft.annotations[0].sceneSource, undefined);
  draft = f.save(draft, { ...draft.annotations[0], bounds: original.bounds }); assert.equal(draft.annotations[0].captureState!.version, 3); assert.equal(draft.annotations[0].capture, undefined);
  f.service.boardOperations(view.sessionId, [{ type: 'delete', objectId: f.object.id, expectedVersion: 1 }]);
  const priorRevision = draft.revision;
  failure(() => f.save(draft, { ...draft.annotations[0], bounds: change.bounds }), 'object_missing');
  assert.equal(f.service.draft(view.sessionId).revision, priorRevision); assert.equal(f.service.draft(view.sessionId).annotations[0].captureState!.version, 3);
});

test('source lifecycle migration keeps existing bound evidence and resumes an awaiting target after restart', async t => {
  const f = await fixture(t), view = f.view(), snapshot = f.scene(view), presentation = f.presentation(view, snapshot);
  f.present(view, presentation); let draft = f.save(f.service.draft(view.sessionId), f.note(f.hold(view, presentation)));
  draft = (await f.capture(draft, f.metadata(draft.annotations[0], snapshot, presentation))).draft!;
  const originalCapture = draft.annotations[0].capture!;
  f.service.db.exec('ALTER TABLE annotation_sources DROP COLUMN state'); f.restart();
  draft = f.service.draft(view.sessionId); assert.equal(draft.annotations[0].capture!.id, originalCapture.id);
  assert.equal((f.service.db.prepare('SELECT state FROM annotation_sources WHERE session_id=? AND draft_id=? AND annotation_id=? AND version=?').get(view.sessionId, draft.id, draft.annotations[0].id, draft.annotations[0].captureState!.version) as { state: string }).state, 'bound');
  draft = f.save(draft, { ...draft.annotations[0], bounds: { ...draft.annotations[0].bounds, x: .4 } }); f.restart();
  draft = f.service.draft(view.sessionId); assert.equal(draft.annotations[0].captureState!.status, 'incomplete'); assert.equal(draft.annotations[0].sceneSource, undefined);
  const newSource = f.hold(view, presentation); draft = f.save(draft, { ...draft.annotations[0], sceneSource: newSource });
  assert.equal(draft.annotations[0].captureState!.version, originalCapture.version + 1);
});

test('normalized geometry uses actual content bounds and the camera includes page scaling', async t => {
  const f = await fixture(t), view = f.view(), snapshot = f.scene(view), presentation = f.presentation(view, snapshot);
  presentation.camera.zoom = 12.5; presentation.layers[0].contentWorldBounds = { x: 23, y: 20, width: 60, height: 80 };
  f.present(view, presentation); const draft = f.save(f.service.draft(view.sessionId), f.note(f.hold(view, presentation))), input = f.metadata(draft.annotations[0], snapshot, presentation);
  input.viewport.zoom = 12.5; input.worldBounds = { x: 35, y: 44, width: 12, height: 16 };
  const result = f.service.prepareCapture(view.sessionId, draft.id, 'note', 1, input);
  assert.equal(result.capture.viewport.zoom, 12.5); assert.deepEqual(result.capture.worldBounds, input.worldBounds);
});

test('captured content anchors match the held frame while requested target selection stays independent', async t => {
  const f = await fixture(t), view = f.view(), snapshot = f.scene(view), presentation = f.presentation(view, snapshot), actual = { kind: 'visual' as const, scroll: { x: 0, y: 0 } };
  presentation.layers[0].contentAnchor = actual; f.present(view, presentation);
  let draft = f.save(f.service.draft(view.sessionId), { ...f.note(f.hold(view, presentation)), contentAnchor: { kind: 'text', scroll: { x: 0, y: 220 }, quote: 'requested words', path: 'rendered-dom:p[0]', start: 2, end: 17 } });
  const input = f.metadata(draft.annotations[0], snapshot, presentation); input.scene.objects[0].scroll = actual.scroll; input.scene.objects[0].contentAnchor = actual;
  const wrong = structuredClone(input); wrong.scene.objects[0].contentAnchor = draft.annotations[0].contentAnchor;
  failure(() => f.service.prepareCapture(view.sessionId, draft.id, 'note', 1, wrong), 'scene_source_conflict');
  draft = (await f.capture(draft, input)).draft!; const sent = f.service.sendDraft(view.sessionId, draft.id, draft.revision);
  assert.equal(sent.task.snapshot.annotations[0].contentAnchor!.scroll!.y, 220); assert.deepEqual(sent.task.snapshot.annotations[0].capture!.scene.objects[0].contentAnchor, actual); assert.deepEqual(sent.task.snapshot.annotations[0].capture!.presentation!.layers[0].contentAnchor, actual);
});

test('an offset canvas presentation maps page coordinates through preparation and Send', async t => {
  const f = await fixture(t), view = f.view(), snapshot = f.scene(view), presentation = f.presentation(view, snapshot);
  presentation.cssViewport.x = 31; presentation.cssViewport.y = 23; presentation.camera = { x: 7, y: 11, zoom: 1.25 };
  for (const layer of presentation.layers) layer.renderedBounds = { x: layer.worldBounds.x * 1.25 + 38, y: layer.worldBounds.y * 1.25 + 34, width: layer.worldBounds.width * 1.25, height: layer.worldBounds.height * 1.25 };
  f.present(view, presentation); let draft = f.save(f.service.draft(view.sessionId), f.note(f.hold(view, presentation))), input = f.metadata(draft.annotations[0], snapshot, presentation);
  input.viewport = { x: 38, y: 34, zoom: 1.25, width: 900, height: 700, devicePixelRatio: 1 };
  failure(() => f.service.prepareCapture(view.sessionId, draft.id, 'note', 1, { ...input, viewport: { ...input.viewport, x: 7, y: 11 } }), 'invalid_capture');
  draft = (await f.capture(draft, input)).draft!;
  const sent = f.service.sendDraft(view.sessionId, draft.id, draft.revision);
  assert.deepEqual(sent.task.snapshot.annotations[0].capture!.viewport, input.viewport);
  assert.deepEqual(sent.task.snapshot.annotations[0].capture!.mapping.crop, presentation.cssViewport);
  assert.deepEqual(sent.task.snapshot.annotations[0].capture!.presentation, presentation);
});

test('capture view HTTP and CLI APIs bind session and retain the PNG byte validation boundary', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'acanvas-scene-http-'))), running = await startServer({ root, port: 0 });
  t.after(async () => { await running.close(); await rm(root, { recursive: true, force: true }); });
  const boot = await (await fetch(`${running.url}/api/bootstrap`)).json();
  const session = running.service.createSession('HTTP');
  const call = async (path: string, method: string, input: unknown, expected = 200) => { const response = await fetch(`${running.url}${path}`, { method, headers: { Authorization: `Bearer ${boot.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(input) }); const value = await response.json(); assert.equal(response.status, expected, JSON.stringify(value)); return value; };
  const view = await cli(['capture-view', 'register', '--project', root, '--url', running.url, '--session', session.id, '--document', 'cli-document']) as CaptureView;
  const op = (operationSeq: number) => ({ documentId: view.documentId, viewGeneration: view.viewGeneration, operationSeq });
  const path = `/api/sessions/${session.id}/capture-views/${view.viewId}`, snapshot = await call(`${path}/scenes`, 'POST', op(1));
  const presentation: ScenePresentation = { documentId: view.documentId, viewId: view.viewId, frameSeq: 1, baseSceneId: snapshot.id, camera: { x: 0, y: 0, zoom: 1 }, cssViewport: { x: 0, y: 0, width: 2, height: 2 }, bitmap: { width: 2, height: 2 }, layers: [], media: [] };
  await call(`${path}/presented`, 'PUT', { ...op(2), presentation }); const source = await call(`${path}/presentations`, 'POST', { ...op(3), presentation });
  const annotation: AnnotationInput = { id: 'blank', scope: 'region', objectIds: [], coordinateSpace: 'world', bounds: { x: 0, y: 0, width: 1, height: 1 }, geometry: 'rect', text: 'Blank scene.', captureState: { version: 1, status: 'incomplete' }, sceneSource: source };
  const draft = await call(`/api/sessions/${session.id}/draft`, 'PUT', { ...running.service.draft(session.id), annotations: [annotation] });
  const input: AnnotationCaptureInput = { sourceMode: 'scene-bitmap', sceneSource: source, presentation, capturedAt: new Date().toISOString(), target: annotationTarget(annotation), worldBounds: annotation.bounds, viewport: { x: 0, y: 0, zoom: 1, width: 2, height: 2, devicePixelRatio: 1 }, mapping: { crop: presentation.cssViewport, pixelWidth: 2, pixelHeight: 2, scaleX: 1, scaleY: 1 }, scene: { objects: [], assets: [], omittedCount: 0 }, image: { mime: 'image/png', width: 2, height: 2, bytes: png.length } };
  const capturePath = `/api/sessions/${session.id}/drafts/${draft.id}/annotations/blank/captures/1`;
  await call(capturePath, 'POST', input);
  const damaged = Buffer.from(png); damaged[50] ^= 1;
  const response = await fetch(`${running.url}${capturePath}/content`, { method: 'PUT', headers: { Authorization: `Bearer ${boot.token}` }, body: damaged }); assert.equal(response.status, 409);
  const valid = await fetch(`${running.url}${capturePath}/content`, { method: 'PUT', headers: { Authorization: `Bearer ${boot.token}` }, body: png }); assert.equal(valid.status, 200);
  await call(path, 'DELETE', op(4)); await call(`${path}/scenes`, 'POST', op(5), 409);
});

test('project HTML surface HTTP transport confirms actual frame ownership and closes with its document view', { skip: process.env.ACANVAS_HTML_SURFACE_TESTS !== '1', timeout: 60_000 }, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'acanvas-scene-surface-http-'))), running = await startServer({ root, port: 0 });
  t.after(async () => { await running.close(); await rm(root, { recursive: true, force: true }); });
  const boot = await (await fetch(`${running.url}/api/bootstrap`)).json(), session = running.service.createSession('HTML HTTP');
  const bytes = Buffer.from('<!doctype html><style>body{margin:0;background:#244653;color:white}input{width:20px}</style><input value="a">');
  await writeFile(join(running.service.dataDir, 'assets', 'test.html'), bytes);
  const asset = running.service.registerAsset({ id: 'html', name: 'test.html', mime: 'text/html', kind: 'file', size: bytes.length, createdAt: new Date().toISOString() }, 'assets/test.html');
  const object = running.service.boardOperations(session.id, [{ type: 'create', object: { assetId: asset.id, x: 0, y: 0, width: 24, height: 24 } }]).objects[0];
  const raw = (path: string, method = 'GET', input?: unknown) => fetch(`${running.url}${path}`, { method, headers: { Authorization: `Bearer ${boot.token}`, ...(input ? { 'Content-Type': 'application/json' } : {}) }, ...(input ? { body: JSON.stringify(input) } : {}) });
  const call = async (path: string, method = 'GET', input?: unknown, expected = 200) => { const response = await raw(path, method, input), data = await response.json(); assert.equal(response.status, expected, JSON.stringify(data)); return data; };
  const view: CaptureView = await call(`/api/sessions/${session.id}/capture-views`, 'POST', { documentId: 'surface-document' }, 201), second: CaptureView = await call(`/api/sessions/${session.id}/capture-views`, 'POST', { documentId: 'other-document' }, 201);
  const identity = { documentId: view.documentId, viewGeneration: view.viewGeneration }, path = `/api/sessions/${session.id}/capture-views/${view.viewId}`;
  const info = await call(`${path}/html-surfaces`, 'POST', { ...identity, objectId: object.id, assetId: asset.id, viewport: { width: 24, height: 24 } }, 201);
  const surfacePath = `${path}/html-surfaces/${info.surfaceId}`, frame = await call(`${surfacePath}/sample`, 'POST', identity);
  const pngResponse = await raw(frame.contentUrl), framePNG = Buffer.from(await pngResponse.arrayBuffer()); assert.equal(pngResponse.status, 200); assert.equal(pngResponse.headers.get('content-type'), 'image/png');
  await call(`/api/sessions/${session.id}/capture-views/${second.viewId}/html-surfaces/${info.surfaceId}/sample`, 'POST', { documentId: second.documentId, viewGeneration: second.viewGeneration }, 403);
  const snapshot = await call(`${path}/scenes`, 'POST', { ...identity, operationSeq: 1 });
  const presentation: ScenePresentation = { documentId: view.documentId, viewId: view.viewId, frameSeq: 1, baseSceneId: snapshot.id, camera: { x: 0, y: 0, zoom: 1 }, cssViewport: { x: 0, y: 0, width: 24, height: 24 }, bitmap: frame.bitmap, layers: [{ objectId: object.id, objectVersion: object.version, assetId: asset.id, worldBounds: { x: 0, y: 0, width: 24, height: 24 }, renderedBounds: { x: 0, y: 0, width: 24, height: 24 }, layer: 0, surface: { surfaceId: frame.surfaceId, instanceId: frame.instanceId, frameSeq: frame.frameSeq, inputSeq: frame.inputSeq, viewport: frame.viewport } }], media: [] };
  const forged = structuredClone(presentation); forged.layers[0].surface!.instanceId = 'another-instance';
  await call(`${path}/presented`, 'PUT', { ...identity, operationSeq: 2, presentation: forged }, 409);
  await call(`${path}/presented`, 'PUT', { ...identity, operationSeq: 2, presentation });
  const source = await call(`${path}/presentations`, 'POST', { ...identity, operationSeq: 3, presentation });
  const annotation: AnnotationInput = { id: 'surface-note', scope: 'object', objectId: object.id, objectIds: [object.id], assetId: asset.id, coordinateSpace: 'normalized', bounds: { x: 0, y: 0, width: 1, height: 1 }, text: 'Keep the displayed HTML.', captureState: { version: 1, status: 'incomplete' }, sceneSource: source };
  const draft: Draft = await call(`/api/sessions/${session.id}/draft`, 'PUT', { ...running.service.draft(session.id), annotations: [annotation] });
  const input: AnnotationCaptureInput = { capturedAt: new Date().toISOString(), target: annotationTarget(annotation), worldBounds: { x: 0, y: 0, width: 24, height: 24 }, viewport: { x: 0, y: 0, zoom: 1, width: 24, height: 24, devicePixelRatio: 1 }, mapping: { crop: presentation.cssViewport, pixelWidth: 24, pixelHeight: 24, scaleX: 1, scaleY: 1 }, scene: { objects: [{ object, renderedBounds: presentation.layers[0].worldBounds, layer: 0 }], assets: [asset], omittedCount: 0 }, image: { mime: 'image/png', width: 24, height: 24, bytes: framePNG.length }, sourceMode: 'scene-bitmap', sceneSource: source, presentation };
  const capturePath = `/api/sessions/${session.id}/drafts/${draft.id}/annotations/surface-note/captures/1`; await call(capturePath, 'POST', input);
  await call(path, 'DELETE', { ...identity, operationSeq: 4 });
  const committed = await fetch(`${running.url}${capturePath}/content`, { method: 'PUT', headers: { Authorization: `Bearer ${boot.token}` }, body: framePNG }); assert.equal(committed.status, 200);
  await call(`${surfacePath}/sample`, 'POST', identity, 409);
  const result = await call(capturePath); assert.equal(result.capture.presentation.layers[0].surface.frameSeq, frame.frameSeq);
});
