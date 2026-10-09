import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CanvasService } from '../src/server/service.js';
import { createProjectCaptureProvider, type ProjectCaptureTransport } from '../src/web/project-capture-provider.js';
import type { AnnotationInput, ScenePresentation } from '../src/shared/types.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFUlEQVR4nGP438HwH4QZGNL+/wdhAFaqCdWXkbmzAAAAAElFTkSuQmCC', 'base64');
const lost = () => Object.assign(new Error('The response was lost.'), { code: 'connection_lost' });
async function fixture(t: test.TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'acanvas-project-provider-'))); let service = new CanvasService(root);
  const session = service.createSession('Provider'); await writeFile(join(service.dataDir, 'assets/reference.png'), png);
  const asset = service.registerAsset({ id: 'asset', name: 'reference.png', mime: 'image/png', size: png.length, kind: 'image', createdAt: new Date().toISOString() }, 'assets/reference.png');
  const object = service.boardOperations(session.id, [{ type: 'create', object: { assetId: asset.id, x: 0, y: 0, width: 2, height: 2 } }]).objects[0];
  const events: string[] = [];
  const api: ProjectCaptureTransport = {
    registerCaptureView: async (...args) => { events.push('register'); return service.registerCaptureView(args[0], { documentId: args[1] }); },
    sceneSnapshot: async (...args) => { events.push('scene'); return service.sceneSnapshot(...args); },
    confirmScenePresentation: async (...args) => { events.push('presented'); return service.confirmScenePresentation(...args); },
    holdScenePresentation: async (...args) => { events.push('hold'); return service.holdScenePresentation(...args); },
    closeCaptureView: async (...args) => { events.push('close'); return service.closeCaptureView(...args); },
    saveDraft: async draft => { events.push('save'); return service.saveDraft(draft.sessionId, draft); },
    state: async id => ({ draft: service.draft(id) }),
    prepareCapture: async (...args) => { events.push('prepare'); return service.prepareCapture(...args); },
    commitCapture: async (sessionId, draftId, annotationId, version, image) => { events.push('upload'); const upload = service.captureUpload(sessionId, draftId, annotationId, version); await writeFile(upload.destination, Buffer.from(await image.arrayBuffer())); return service.captureResult(sessionId, draftId, annotationId, version); },
    captureResult: async (...args) => { events.push('query'); return service.captureResult(...args); },
    retryCapture: async (...args) => { events.push('retry'); return service.retryCapture(...args); },
  };
  const provider = createProjectCaptureProvider(api, { sessionId: session.id, documentId: 'provider-document', retryDelayMs: 0 });
  const view = await provider.ready(), snapshot = await provider.sceneSnapshot();
  const presentation: ScenePresentation = { documentId: view.documentId, viewId: view.viewId, frameSeq: 1, baseSceneId: snapshot.id, camera: { x: 0, y: 0, zoom: 1 }, cssViewport: { x: 0, y: 0, width: 2, height: 2 }, bitmap: { width: 2, height: 2 }, layers: [{ objectId: object.id, objectVersion: object.version, assetId: asset.id, worldBounds: { x: 0, y: 0, width: 2, height: 2 }, renderedBounds: { x: 0, y: 0, width: 2, height: 2 }, layer: 0 }], media: [] };
  const annotation: AnnotationInput = { id: 'note', scope: 'object', objectId: object.id, objectIds: [object.id], assetId: asset.id, bounds: { x: 0, y: 0, width: 1, height: 1 }, coordinateSpace: 'normalized', geometry: 'rect', text: 'Original comment.', captureState: { version: 1, status: 'incomplete' } };
  let copied = 0, encoded = 0;
  const input = () => ({ draft: service.draft(session.id), annotation, freeze: () => { copied++; events.push('copy'); return { presentation, cropCSS: presentation.cssViewport, encodePNG: async () => { encoded++; events.push('encode'); return new Blob([png], { type: 'image/png' }); } }; }, worldBounds: { x: 0, y: 0, width: 2, height: 2 }, viewport: { x: 0, y: 0, zoom: 1, width: 2, height: 2, devicePixelRatio: 1 }, scene: { objects: [{ object, renderedBounds: { x: 0, y: 0, width: 2, height: 2 }, layer: 0 }], assets: [asset], omittedCount: 0 } });
  t.after(async () => { service.close(); await rm(root, { recursive: true, force: true }); });
  return { session, object, api, events, provider, presentation, input, get service() { return service; }, get copied() { return copied; }, get encoded() { return encoded; }, restart() { service.close(); service = new CanvasService(root); } };
}

test('project provider copies synchronously then holds and saves source before capture preparation', async t => {
  const f = await fixture(t); f.events.length = 0;
  const saving = f.provider.freezeAndHold(f.input()); assert.deepEqual(f.events, ['copy']);
  const { draft, frame } = await saving;
  assert.deepEqual(f.events, ['copy', 'presented', 'hold', 'save']); assert.equal(draft.annotations[0].sceneSource!.frameSeq, 1);
  const result = await f.provider.capture(frame); assert.equal(result.status, 'complete'); assert.equal(f.copied, 1); assert.equal(f.encoded, 1);
  assert.equal(f.events.filter(value => value === 'upload').length, 1);
  assert.deepEqual(await f.provider.capture(frame), result);
});

test('lost hold, draft, prepare and upload responses recover the same copied frame and service identities', async t => {
  const f = await fixture(t);
  for (const name of ['holdScenePresentation', 'saveDraft', 'prepareCapture', 'commitCapture'] as const) {
    const original = f.api[name] as (...args: any[]) => Promise<any>; let first = true;
    (f.api as any)[name] = async (...args: any[]) => { const value = await original(...args); if (first) { first = false; throw lost(); } return value; };
  }
  const { draft, frame } = await f.provider.freezeAndHold(f.input()); const result = await f.provider.capture(frame);
  assert.equal(result.status, 'complete'); assert.equal(f.copied, 1); assert.equal(f.encoded, 1);
  assert.equal((f.service.db.prepare('SELECT COUNT(*) AS count FROM scene_sources').get() as { count: number }).count, 1);
  assert.equal((f.service.db.prepare('SELECT COUNT(*) AS count FROM annotation_captures').get() as { count: number }).count, 1);
  assert.equal(f.service.draft(f.session.id).annotations[0].capture!.draftId, draft.id);
});

test('bounded encoding recovery uses copied pixels and preserves metadata while the current scene changes', async t => {
  const f = await fixture(t), input = f.input(); let encodeAttempts = 0;
  const freeze = input.freeze;
  input.freeze = () => { const original = freeze(); return { ...original, encodePNG: async () => { if (++encodeAttempts === 1) throw new Error('Temporary encoder failure.'); return original.encodePNG(); } }; };
  const { frame } = await f.provider.freezeAndHold(input);
  f.presentation.camera.x = 222; f.presentation.layers[0].worldBounds.x = 222;
  f.service.boardOperations(f.session.id, [{ type: 'delete', objectId: f.object.id, expectedVersion: 1 }]);
  const result = await f.provider.capture(frame); assert.equal(result.status, 'complete'); assert.equal(f.copied, 1); assert.equal(encodeAttempts, 2);
  if (result.status === 'complete') { assert.equal(result.result.capture.presentation!.camera.x, 0); assert.equal(result.result.capture.scene.objects[0].object.x, 0); }
});

test('cancelled upload advances the version and its delayed completion keeps the annotation incomplete', async t => {
  const f = await fixture(t), { frame } = await f.provider.freezeAndHold(f.input());
  let release!: () => void, started!: () => void;
  const delayed = new Promise<void>(resolve => { release = resolve; }), uploadStarted = new Promise<void>(resolve => { started = resolve; });
  const commit = f.api.commitCapture;
  f.api.commitCapture = async (...args) => { started(); await delayed; return commit(...args); };
  const capturing = f.provider.capture(frame); await uploadStarted; const cancelled = await f.provider.cancel(frame.identity); release();
  assert.equal(cancelled!.version, 2); assert.deepEqual(await capturing, { status: 'incomplete', code: 'capture_cancelled' });
  assert.deepEqual(await f.provider.capture(frame), { status: 'incomplete', code: 'capture_cancelled' });
  assert.equal(f.service.draft(f.session.id).annotations[0].captureState!.status, 'incomplete');
});

test('a new document resumes persisted pixels using the durable source after the original view closes and service restarts', async t => {
  const f = await fixture(t), { frame } = await f.provider.freezeAndHold(f.input());
  const pngBlob = await frame.encodePNG(); await f.provider.close(); f.restart();
  const next = createProjectCaptureProvider(f.api, { sessionId: f.session.id, documentId: 'recovery-document', retryDelayMs: 0 }); await next.ready();
  const { encodePNG, ...metadata } = frame, persisted = { ...metadata, png: pngBlob };
  const result = await next.resume(persisted); assert.equal(result.status, 'complete');
  if (result.status === 'complete') assert.equal(result.result.capture.sceneSource!.documentId, 'provider-document');
  const forged = { ...persisted, sceneSource: { ...persisted.sceneSource, frameSeq: 55 } };
  assert.deepEqual(await next.resume(forged), { status: 'incomplete', code: 'capture_version_conflict' });
});

test('pending capture limit bounds synchronous pixel copies before queued service saves', async t => {
  const f = await fixture(t), provider = createProjectCaptureProvider(f.api, { sessionId: f.session.id, documentId: 'bounded-document', maxPendingCaptures: 1 });
  const view = await provider.ready(), snapshot = await provider.sceneSnapshot(), input = f.input();
  input.freeze = () => ({ presentation: { ...f.presentation, documentId: view.documentId, viewId: view.viewId, baseSceneId: snapshot.id }, cropCSS: f.presentation.cssViewport, encodePNG: async () => new Blob([png], { type: 'image/png' }) });
  const first = provider.freezeAndHold(input);
  await assert.rejects(provider.freezeAndHold(input), (error: unknown) => !!error && typeof error === 'object' && 'code' in error && error.code === 'capture_pending_limit');
  const { frame } = await first; await provider.cancel(frame.identity);
});

test('pending freeze cancellation while Done hold response is delayed releases the stage and saves no annotation', async t => {
  const f = await fixture(t), controller = new AbortController();
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; }), hold = f.api.holdScenePresentation;
  f.api.holdScenePresentation = async (...args) => { const source = await hold(...args); entered(); await held; return source; };
  const pending = f.provider.freezeAndHold({ ...f.input(), signal: controller.signal });
  const cancelled = assert.rejects(pending, (error: unknown) => !!error && typeof error === 'object' && 'code' in error && error.code === 'capture_cancelled');
  assert.equal(pending.identity.pendingGeneration, 1); await started; controller.abort(); await cancelled;
  assert.equal(f.service.draft(f.session.id).annotations.length, 0); assert.equal(f.events.includes('save'), false);
  release(); await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(f.events.includes('prepare'), false);
});

test('pending cancellation invalidates a committed draft whose save response is delayed and preserves its latest comment', async t => {
  const f = await fixture(t); let release!: () => void, entered!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; }), save = f.api.saveDraft;
  f.api.saveDraft = async (...args) => { const draft = await save(...args); entered(); await held; return draft; };
  const pending = f.provider.freezeAndHold(f.input());
  let cancelledDraft: unknown;
  const rejected = assert.rejects(pending, (error: unknown) => { if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'capture_cancelled') return false; cancelledDraft = 'draft' in error ? error.draft : undefined; return true; });
  await started;
  const saved = f.service.draft(f.session.id); f.service.saveDraft(f.session.id, { ...saved, text: 'A newer request body.', annotations: [{ ...saved.annotations[0], text: 'A newer annotation comment.' }] });
  const cancelled = await pending.cancel(); await rejected;
  assert.equal(cancelled.retry!.version, 2); assert.ok(cancelledDraft); assert.equal(cancelled.draft!.text, 'A newer request body.'); assert.equal(cancelled.draft!.annotations[0].text, 'A newer annotation comment.');
  release(); await new Promise(resolve => setTimeout(resolve, 10));
  const current = f.service.draft(f.session.id); assert.equal(current.annotations[0].captureState!.version, 2); assert.equal(f.events.includes('prepare'), false); assert.equal(f.events.filter(event => event === 'retry').length, 1);
});

test('close cancels a pending source before identity creation and late persistence cannot reactivate its job', async t => {
  const f = await fixture(t); let release!: () => void, entered!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; }), save = f.api.saveDraft;
  f.api.saveDraft = async (...args) => { const draft = await save(...args); entered(); await held; return draft; };
  const pending = f.provider.freezeAndHold(f.input()); const rejected = assert.rejects(pending, /cancelled/); await started;
  await f.provider.close(); await rejected; release(); await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(f.service.draft(f.session.id).annotations[0].captureState!.version, 2); assert.equal(f.events.includes('prepare'), false);
});

test('closing during delayed view initialization retires the late service-issued view', async t => {
  const f = await fixture(t), original = f.api.registerCaptureView;
  let release!: () => void, entered!: () => void, lateView: Awaited<ReturnType<typeof original>>;
  const held = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
  f.api.registerCaptureView = async (...args) => { lateView = await original(...args); entered(); await held; return lateView; };
  const provider = createProjectCaptureProvider(f.api, { sessionId: f.session.id, documentId: 'closing-document' }), ready = provider.ready();
  const rejected = assert.rejects(ready, /closed during initialization/); await started; await provider.close(); release(); await rejected;
  assert.throws(() => f.service.captureView(f.session.id, lateView!.viewId), /Register the current document/);
});
