import test from 'node:test';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { cli } from '../src/cli.js';
import { startServer } from '../src/server/http.js';
import { collectHtmlBundle } from '../src/server/html-bundle-import.js';
import { startHtmlPreview } from '../src/server/html-preview.js';
import type { Asset } from '../src/shared/types.js';

const resource = (url: string, dest = 'style', mode = 'no-cors') => new Promise<{ status: number; body: string; headers: Record<string, unknown> }>((resolve, reject) => {
  const req = httpRequest(url, { headers: { 'Sec-Fetch-Dest': dest, 'Sec-Fetch-Mode': mode } }, response => { const chunks: Buffer[] = []; response.on('data', chunk => chunks.push(Buffer.from(chunk))); response.on('end', () => resolve({ status: response.statusCode!, body: Buffer.concat(chunks).toString(), headers: response.headers })); }); req.on('error', reject); req.end();
});

test('CLI bundles save immutable resources under .acanvas, survive source removal/restart and retain task dependencies', async t => {
  const root = await mkdtemp(join(tmpdir(), 'acanvas-bundle-')), source = await mkdtemp(join(tmpdir(), 'acanvas-bundle-source-'));
  let server = await startServer({ root, port: 0 });
  t.after(async () => { await server.close(); await rm(root, { recursive: true, force: true }); await rm(source, { recursive: true, force: true }); });
  await mkdir(join(source, 'css')); await writeFile(join(source, 'index.html'), '<link rel="stylesheet" href="css/style.css"><p>Hello</p>'); await writeFile(join(source, 'css/style.css'), 'p{color:red}'); await writeFile(join(source, '.env'), 'SECRET');
  const asset = await cli(['asset', 'import', '--project', root, '--url', server.url, '--file', join(source, 'index.html'), '--bundle-root', source]) as Asset;
  assert.deepEqual(Object.keys(asset.htmlBundle!.files), ['css/style.css', 'index.html']);
  for (const id of Object.values(asset.htmlBundle!.files)) assert.ok(server.service.assetPath(id).startsWith(join(root, '.acanvas')));
  assert.equal(await readFile(server.service.assetPath(asset.id), 'utf8'), '<link rel="stylesheet" href="css/style.css"><p>Hello</p>');
  const session = server.service.createSession('bundle');
  const draft = server.service.saveDraft(session.id, { ...server.service.draft(session.id), text: 'Review', attachments: [asset.id] });
  const task = server.service.sendDraft(session.id, draft.id, draft.revision).task;
  assert.deepEqual(new Set(task.snapshot.referenceContent.assets.map(value => value.id)), new Set(Object.values(asset.htmlBundle!.files)));
  assert.deepEqual(task.snapshot.referenceContent.assets.find(value => value.id === asset.id)!.htmlBundle, asset.htmlBundle);
  assert.throws(() => server.service.registerHtmlBundle(asset.htmlBundle!), /new HTML import/);
  await rm(source, { recursive: true, force: true }); await server.close(); server = await startServer({ root, port: 0 });
  assert.deepEqual(server.service.asset(asset.id).htmlBundle, asset.htmlBundle);
  const preview = await startHtmlPreview(server.service); t.after(() => preview.close());
  const grant = preview.issue(asset.id, server.url), prefix = `${grant.origin}/preview/${grant.id}/files/`;
  assert.equal((await resource(grant.url, 'iframe', 'navigate')).status, 200);
  const style = await resource(`${prefix}css/style.css`); assert.equal(style.status, 200); assert.equal(style.body, 'p{color:red}'); assert.equal(style.headers['access-control-allow-origin'], '*');
  for (const path of ['.env', 'missing.css', '../css/style.css', '%2e%2e/css/style.css', 'css%2f..%2f..%2fstyle.css']) assert.notEqual((await resource(`${prefix}${path}`)).status, 200);
  assert.equal((await resource(`${prefix}css/style.css`, 'iframe', 'navigate')).status, 403);
  assert.equal((await resource(`${prefix}index.html`, 'script')).status, 403);
  const other = server.service.assets().find(value => value.id !== asset.id)!;
  assert.equal((await resource(`${grant.origin}/api/assets/${other.id}/content`)).status, 404);
  preview.revoke(grant.id); assert.equal((await resource(`${prefix}css/style.css`)).status, 404);
  const short = await startHtmlPreview(server.service, { lifetimeMs: 20 }); t.after(() => short.close()); const expiring = short.issue(asset.id, server.url);
  await new Promise(resolve => setTimeout(resolve, 30)); assert.equal((await resource(new URL('css/style.css', expiring.url).href)).status, 404);
});

test('bundle imports reject unsupported files, traversal, symlinks and bounds before upload', async t => {
  const root = await mkdtemp(join(tmpdir(), 'acanvas-bundle-limits-')); t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'index.html'), '<p>Safe</p>'); await writeFile(join(root, 'secret.txt'), 'private');
  await assert.rejects(collectHtmlBundle(root, join(root, 'index.html')), /Unsupported bundle file/);
  await rm(join(root, 'secret.txt')); await symlink('/tmp', join(root, 'escape')); await assert.rejects(collectHtmlBundle(root, join(root, 'index.html')), /symlinks/); await rm(join(root, 'escape'));
  await assert.rejects(collectHtmlBundle(root, '/tmp/index.html'), /within/);
  await writeFile(join(root, 'large.css'), Buffer.alloc(10 * 1024 * 1024 + 1)); await assert.rejects(collectHtmlBundle(root, join(root, 'index.html')), /10 MiB/); await rm(join(root, 'large.css'));
  for (let i = 0; i < 128; i++) await writeFile(join(root, `${i}.css`), '');
  await assert.rejects(collectHtmlBundle(root, join(root, 'index.html')), /128 files/);
});

test('output manifests require the current run and keep resource ownership and receipt dependencies', async t => {
  const root = await mkdtemp(join(tmpdir(), 'acanvas-bundle-output-'));
  const server = await startServer({ root, port: 0 }); t.after(async () => { await server.close(); await rm(root, { recursive: true, force: true }); });
  const service = server.service, session = service.createSession('Outputs');
  const draft = service.saveDraft(session.id, { ...service.draft(session.id), text: 'Build a page' });
  const task = service.sendDraft(session.id, draft.id, draft.revision).task;
  const claim = service.claim(session.id, 'bundle-consumer');
  const source = { sessionId: session.id, taskId: task.id, runId: claim.run!.id, consumerId: claim.consumerId };
  const token = (await (await fetch(`${server.url}/api/bootstrap`)).json()).token;
  const upload = async (name: string, output = true): Promise<Asset> => {
    const params = new URLSearchParams({ name, ...(output ? source : {}) });
    const response = await fetch(`${server.url}/api/assets?${params}`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: name.endsWith('.html') ? '<p>Output</p>' : 'p{color:red}' }); assert.equal(response.status, 201); return response.json();
  };
  const entry = await upload('index.html'), css = await upload('style.css'), foreign = await upload('foreign.css', false);
  const preview = await startHtmlPreview(service); t.after(() => preview.close());
  const originalGrant = preview.issue(entry.id, server.url);
  const manifest = { entryPath: 'index.html', files: { 'index.html': entry.id, 'style.css': css.id } };
  assert.throws(() => service.registerHtmlBundle(manifest), /execution identity/);
  assert.throws(() => service.registerHtmlBundle({ ...manifest, source: { ...source, consumerId: 'wrong' } }), /identity must match/);
  assert.throws(() => service.registerHtmlBundle({ ...manifest, files: { ...manifest.files, 'foreign.css': foreign.id }, source }), /same import source/);
  service.registerHtmlBundle({ ...manifest, source });
  const originalDocument = await resource(originalGrant.url, 'iframe', 'navigate');
  assert.equal(originalDocument.status, 200); assert.match(String(originalDocument.headers['content-security-policy']), /connect-src 'none'/);
  assert.equal((await resource(`${originalGrant.url}/files/style.css`)).status, 404);
  const result = service.complete(session.id, task.id, { ...source, summary: 'Done', validation: ['Bundle'], assetIds: [entry.id], operations: [] });
  assert.deepEqual(new Set(result.receipt!.assetIds), new Set([entry.id, css.id]));
});


test('CLI rejects an ancestor swapped to an outside symlink after path validation', async t => {
  const base = await mkdtemp(join(tmpdir(), 'acanvas-bundle-race-')), root = join(base, 'project'), source = join(base, 'source'), outside = join(base, 'outside');
  for (const directory of [root, source, outside, join(source, 'sub')]) await mkdir(directory);
  await writeFile(join(source, 'index.html'), '<link rel="stylesheet" href="sub/style.css">');
  await writeFile(join(source, 'sub/style.css'), 'SAFE-CSS'); await writeFile(join(outside, 'style.css'), 'SECRET!!');
  const server = await startServer({ root, port: 0 });
  const original = fs.realpath; let swapped = false;
  try {
    fs.realpath = (async (path: string, ...args: any[]) => {
      const result = await (original as any)(path, ...args);
      if (String(path) === join(source, 'sub/style.css') && !swapped) {
        swapped = true; await fs.rename(join(source, 'sub'), join(source, 'sub-original')); await symlink(outside, join(source, 'sub'));
      }
      return result;
    }) as typeof fs.realpath;
    syncBuiltinESMExports();
    await assert.rejects(cli(['asset', 'import', '--project', root, '--url', server.url, '--file', join(source, 'index.html'), '--bundle-root', source]), /changed while importing/);
    assert.equal(swapped, true);
    assert.equal(server.service.assets().some(asset => asset.htmlBundle), false);
    for (const asset of server.service.assets()) assert.notEqual(await readFile(server.service.assetPath(asset.id), 'utf8'), 'SECRET!!');
  } finally { fs.realpath = original; syncBuiltinESMExports(); await server.close(); await rm(base, { recursive: true, force: true }); }
});

test('CLI rejects a source directory swapped during scanning then restored before validation', async () => {
  const base = await mkdtemp(join(tmpdir(), 'acanvas-bundle-scan-race-')), root = join(base, 'project'), source = join(base, 'source'), outside = join(base, 'outside');
  for (const directory of [root, source, outside, join(source, 'sub')]) await mkdir(directory);
  await writeFile(join(source, 'index.html'), '<link rel="stylesheet" href="sub/style.css">');
  await writeFile(join(source, 'sub/style.css'), 'SAFE-CSS'); await writeFile(join(outside, 'style.css'), 'SECRET!!');
  const server = await startServer({ root, port: 0 });
  const original = fs.readdir; let restored = false;
  try {
    fs.readdir = (async (path: string, ...args: any[]) => {
      if (String(path) !== join(source, 'sub')) return (original as any)(path, ...args);
      await fs.rename(join(source, 'sub'), join(source, 'sub-original'));
      await symlink(outside, join(source, 'sub'));
      const names = await (original as any)(path, ...args);
      await fs.unlink(join(source, 'sub')); await fs.rename(join(source, 'sub-original'), join(source, 'sub'));
      restored = true;
      return names;
    }) as typeof fs.readdir;
    syncBuiltinESMExports();
    await assert.rejects(cli(['asset', 'import', '--project', root, '--url', server.url, '--file', join(source, 'index.html'), '--bundle-root', source]), /changed while importing/);
    assert.equal(restored, true); assert.deepEqual(server.service.assets(), []);
  } finally { fs.readdir = original; syncBuiltinESMExports(); await server.close(); await rm(base, { recursive: true, force: true }); }
});
