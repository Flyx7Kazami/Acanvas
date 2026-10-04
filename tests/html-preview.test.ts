import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import type { AnnotationInput, Asset, Draft, Task } from '../src/shared/types.js';
import { startServer, type RunningServer } from '../src/server/http.js';
import { startHtmlPreview, type HtmlPreviewGrant } from '../src/server/html-preview.js';

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'acanvas-preview-http-'));
  const webRoot = join(root, 'web'); await mkdir(webRoot); await writeFile(join(webRoot, 'index.html'), '<!doctype html><html><head><title>Preview test</title></head><body>Canvas</body></html>');
  let running: RunningServer = await startServer({ root, port: 0, webRoot });
  let token = (await (await fetch(`${running.url}/api/bootstrap`)).json()).token as string;
  t.after(async () => { await running.close(); await rm(root, { recursive: true, force: true }); });
  const call = async (path: string, method = 'GET', body?: unknown, status = 200, origin?: string) => {
    const response = await fetch(`${origin ?? running.url}${path}`, { method, headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const value = await response.json(); assert.equal(response.status, status, value.error?.code); return value;
  };
  const upload = async (name: string, mime = '', body = '<button>Preview</button>'): Promise<Asset> => {
    const response = await fetch(`${running.url}/api/assets?name=${encodeURIComponent(name)}&mime=${encodeURIComponent(mime)}`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body });
    assert.equal(response.status, 201); return response.json();
  };
  return { root, call, upload, get running() { return running; }, get token() { return token; }, restart: async () => { const port = Number(new URL(running.url).port); await running.close(); running = await startServer({ root, port, webRoot }); token = (await (await fetch(`${running.url}/api/bootstrap`)).json()).token; } };
}
const embedded = { 'Sec-Fetch-Dest': 'iframe', 'Sec-Fetch-Mode': 'navigate' };
const navigation = (url: string, headers: Record<string, string> = embedded) => new Promise<Response>((resolve, reject) => {
  const request = httpRequest(url, { headers }, response => {
    const chunks: Buffer[] = [];
    response.on('data', chunk => chunks.push(Buffer.from(chunk)));
    response.on('end', () => {
      const responseHeaders = new Headers();
      for (const [name, value] of Object.entries(response.headers)) if (value !== undefined) for (const item of Array.isArray(value) ? value : [value]) responseHeaders.append(name, item);
      resolve(new Response(Buffer.concat(chunks), { status: response.statusCode, headers: responseHeaders }));
    });
  });
  request.on('error', reject); request.end();
});

test('uploads normalize content MIME and retain safe inline audio ranges plus downloadable HTML', async t => {
  const f = await fixture(t);
  for (const [name, supplied, mime, kind] of [
    ['signal.wav', '', 'audio/wav', 'file'], ['track.mp3', 'audio/mpeg; charset=binary', 'audio/mpeg', 'file'],
    ['notes.md', 'application/octet-stream', 'text/markdown', 'file'], ['widget.html', 'text/plain', 'text/html', 'file'],
    ['animation.gif', 'application/octet-stream', 'image/gif', 'image'],
  ]) {
    const asset = await f.upload(name, supplied, '0123456789'); assert.equal(asset.mime, mime); assert.equal(asset.kind, kind);
    if (mime.startsWith('audio/')) {
      const response = await fetch(`${f.running.url}/api/assets/${asset.id}/content`, { headers: { Authorization: `Bearer ${f.token}`, Range: 'bytes=2-5' } });
      assert.equal(response.status, 206); assert.equal(response.headers.get('content-type'), mime); assert.match(response.headers.get('content-disposition')!, /^inline;/); assert.equal(await response.text(), '2345');
    }
    if (mime === 'text/html') {
      const response = await fetch(`${f.running.url}/api/assets/${asset.id}/content`, { headers: { Authorization: `Bearer ${f.token}` } });
      assert.equal(response.headers.get('content-type'), 'application/octet-stream'); assert.match(response.headers.get('content-disposition')!, /^attachment;/); assert.equal(await response.text(), '0123456789');
    }
  }
});

test('HTML grants bind one file and a different cookie host; main authentication and source guards stay strict', async t => {
  const f = await fixture(t), html = await f.upload('widget.html'), other = await f.upload('other.html'), image = await f.upload('image.png');
  const grant: HtmlPreviewGrant = await f.call(`/api/assets/${html.id}/html-preview`, 'POST', {}, 201);
  assert.equal(new URL(grant.origin).hostname, 'localhost'); assert.notEqual(new URL(grant.origin).host, new URL(f.running.url).host);
  assert.equal(new URL(grant.url).pathname, `/preview/${grant.id}`); assert.ok(Date.parse(grant.expiresAt) > Date.now());
  const denied = await fetch(`${f.running.url}/api/assets/${html.id}/html-preview`, { method: 'POST', body: '{}' }); assert.equal(denied.status, 401); await denied.text();
  const nullOrigin = await fetch(`${f.running.url}/api/assets/${html.id}/html-preview`, { method: 'POST', headers: { Authorization: `Bearer ${f.token}`, Origin: 'null' }, body: '{}' }); assert.equal(nullOrigin.status, 403); await nullOrigin.text();
  await f.call(`/api/assets/${image.id}/html-preview`, 'POST', {}, 400);
  const main = await fetch(`${f.running.url}/api/bootstrap`); const csp = main.headers.get('content-security-policy')!;
  assert.match(csp, /script-src 'self';/); assert.match(csp, /connect-src 'self';/); assert.ok(csp.includes(`frame-src ${grant.origin};`)); await main.text();
  const response = await navigation(grant.url); assert.equal(response.status, 200);
  assert.equal(response.headers.get('set-cookie'), null); assert.ok(response.headers.get('content-security-policy')!.includes(`frame-ancestors ${f.running.url}`)); assert.match(response.headers.get('content-security-policy')!, /sandbox allow-scripts;/); assert.doesNotMatch(response.headers.get('content-security-policy')!, /allow-same-origin/);
  const document = await response.text(); assert.match(document, /acanvas:preview-ready/); assert.match(document, /acanvas:preview-exit/); assert.ok(!document.includes(f.token)); assert.ok(!document.includes(f.root));
  for (const url of [grant.url, `${grant.origin}/api/bootstrap`, `${grant.origin}/api/assets/${other.id}/content`, `${grant.origin}/preview/../../assets/${other.id}`]) {
    const response = await fetch(url); assert.ok([403, 404].includes(response.status)); await response.text();
  }
  const hostileHost = await navigation(grant.url, { ...embedded, Host: `127.0.0.1:${new URL(grant.origin).port}` }); assert.equal(hostileHost.status, 403); await hostileHost.text();
  const localhostMain = f.running.url.replace('127.0.0.1', 'localhost');
  const alternative: HtmlPreviewGrant = await f.call(`/api/assets/${html.id}/html-preview`, 'POST', {}, 201, localhostMain);
  assert.equal(new URL(alternative.origin).hostname, '127.0.0.1');
  const alternativePolicy = await fetch(`${localhostMain}/api/bootstrap`); assert.ok(alternativePolicy.headers.get('content-security-policy')!.includes(`frame-src ${alternative.origin};`)); await alternativePolicy.text();
  await f.call(`/api/html-previews/${grant.id}`, 'DELETE'); const revoked = await navigation(grant.url); assert.equal(revoked.status, 404); await revoked.text();
});

test('preview authorization expires and closes with its service; original assets survive a restart', async t => {
  const f = await fixture(t), html = await f.upload('widget.html');
  const preview = await startHtmlPreview(f.running.service, { lifetimeMs: 40 }); t.after(() => preview.close());
  const short = preview.issue(html.id, f.running.url);
  await new Promise(resolve => setTimeout(resolve, 60));
  const expired = await navigation(short.url); assert.equal(expired.status, 404); await expired.text();
  const grant: HtmlPreviewGrant = await f.call(`/api/assets/${html.id}/html-preview`, 'POST', {}, 201);
  const originalPage = await fetch(f.running.url); assert.ok(originalPage.headers.get('content-security-policy')!.includes(`frame-src ${grant.origin};`)); assert.ok((await originalPage.text()).includes(`name="acanvas-html-preview-origin" content="${grant.origin}"`));
  await f.restart();
  await assert.rejects(navigation(grant.url));
  const next: HtmlPreviewGrant = await f.call(`/api/assets/${html.id}/html-preview`, 'POST', {}, 201); assert.notEqual(next.id, grant.id);
  const currentPage = await fetch(f.running.url); assert.ok(currentPage.headers.get('content-security-policy')!.includes(`frame-src ${next.origin};`)); assert.ok((await currentPage.text()).includes(`name="acanvas-html-preview-origin" content="${next.origin}"`));
  const replay = await navigation(`${next.origin}/preview/${grant.id}`); assert.equal(replay.status, 404); await replay.text();
});

test('preview load size is bounded while the source remains available for download', async t => {
  const f = await fixture(t), html = await f.upload('large.html', 'text/html', 'x'.repeat(10 * 1024 * 1024 + 1));
  await f.call(`/api/assets/${html.id}/html-preview`, 'POST', {}, 413);
  const response = await fetch(`${f.running.url}/api/assets/${html.id}/content`, { method: 'HEAD', headers: { Authorization: `Bearer ${f.token}` } });
  assert.equal(response.status, 200); assert.equal(Number(response.headers.get('content-length')), html.size); assert.match(response.headers.get('content-disposition')!, /^attachment;/);
});

test('new annotation targets follow capabilities and task edits retain only their exact source target', async t => {
  const f = await fixture(t), session = await f.call('/api/sessions', 'POST', { name: 'Content targets' }, 201);
  const assets = await Promise.all(['sound.wav', 'notes.md', 'widget.html', 'picture.png', 'clip.mp4'].map(name => f.upload(name)));
  const result = await f.call('/api/board/operations', 'POST', { sessionId: session.id, operations: assets.map((asset, index) => ({ type: 'create', object: { assetId: asset.id, x: index * 200, y: 0, width: 180, height: 120 } })) });
  const objects = assets.map(asset => result.objects.find((object: { assetId: string }) => object.assetId === asset.id));
  let draft: Draft = (await f.call(`/api/state?sessionId=${session.id}`)).draft;
  const annotation = (index: number): AnnotationInput => ({ id: `note-${index}`, scope: 'object', coordinateSpace: 'normalized', objectId: objects[index].id, objectIds: [objects[index].id], assetId: assets[index].id, bounds: { x: 0, y: 0, width: 1, height: 1 }, text: 'Review this content' });
  for (const index of [0, 1, 2]) {
    await f.call(`/api/sessions/${session.id}/draft`, 'PUT', { ...draft, annotations: [{ ...annotation(index), bounds: { x: .2, y: 0, width: .5, height: 1 } }] }, 400);
  }
  for (const input of [
    { ...annotation(0), snapshotAssetId: assets[3].id }, { ...annotation(1), timeStart: 2 }, { ...annotation(2), timeStart: 2 },
    { ...annotation(3), timeStart: 2 }, { ...annotation(0), timeEnd: 3 }, { ...annotation(0), timeStart: 3, timeEnd: 2 },
    { ...annotation(0), assetId: assets[4].id },
  ]) await f.call(`/api/sessions/${session.id}/draft`, 'PUT', { ...draft, annotations: [input] }, 400);
  draft = await f.call(`/api/sessions/${session.id}/draft`, 'PUT', { ...draft, annotations: [{ ...annotation(0), timeStart: 1, timeEnd: 3 }, annotation(1), annotation(2), { ...annotation(4), timeStart: 2, snapshotAssetId: assets[3].id }] });
  const task: Task = (await f.call(`/api/sessions/${session.id}/tasks`, 'POST', { draftId: draft.id, expectedRevision: draft.revision })).task;
  // The isolated fixture represents a file-card region reference saved by an earlier application version.
  task.snapshot.annotations[1].bounds = { x: .2, y: 0, width: .5, height: 1 };
  f.running.service.db.prepare('UPDATE tasks SET snapshot_json=? WHERE id=?').run(JSON.stringify(task.snapshot), task.id);
  const ordinary: Draft = (await f.call(`/api/state?sessionId=${session.id}`)).draft;
  const edit = (await f.call(`/api/sessions/${session.id}/tasks/${task.id}/edit`, 'POST', { draftId: ordinary.id, expectedRevision: ordinary.revision })).draft as Draft;
  await f.call(`/api/sessions/${session.id}/draft`, 'PUT', { ...edit, annotations: [{ ...edit.annotations[1], id: edit.annotations[0].id, bounds: { x: .2, y: 0, width: .5, height: 1 } }] }, 400);
  await f.call(`/api/sessions/${session.id}/draft`, 'PUT', { ...edit, annotations: [{ ...edit.annotations[1], bounds: { x: .3, y: 0, width: .5, height: 1 } }] }, 400);
  await f.call(`/api/sessions/${session.id}/draft`, 'PUT', { ...edit, annotations: [{ ...edit.annotations[1], id: 'new-region-target' }] }, 400);
  const preserved = await f.call(`/api/sessions/${session.id}/draft`, 'PUT', { ...edit, annotations: edit.annotations.map(value => ({ ...value, text: 'Updated direction' })) });
  assert.equal(preserved.annotations[0].timeStart, 1); assert.equal(preserved.annotations[3].snapshotAssetId, assets[3].id); assert.deepEqual(preserved.annotations[1].bounds, { x: .2, y: 0, width: .5, height: 1 });
});
