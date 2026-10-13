import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { startServer } from '../src/server/http.js';
import type { Asset, BoardOperation, BoardState } from '../src/shared/types.js';

const execute = promisify(execFile);
const cliPath = fileURLToPath(new URL('../src/cli.js', import.meta.url));
test('built CLI lists groups, reads source files and world layout, and puts existing and new items into folders', async t => {
  const root = await mkdtemp(join(tmpdir(), 'acanvas-group-cli-')), running = await startServer({ root, port: 0 });
  t.after(async () => { await running.close(); await rm(root, { recursive: true, force: true }); });
  const command = async (...args: string[]) => JSON.parse((await execute(process.execPath, [cliPath, ...args, '--project', root, '--url', running.url])).stdout);
  const session = await command('session', 'create', '--name', 'CLI groups');
  const assets: Asset[] = [];
  for (const [name, content] of [['Palette.txt', 'Cobalt and sand'], ['Composition.txt', 'Space and rhythm'], ['Loose.txt', 'Move this reference']]) {
    const file = join(root, name); await writeFile(file, content);
    assets.push(await command('asset', 'import', '--file', file));
  }
  const input = join(root, 'operations.json');
  const operations = async (operations: BoardOperation[]) => { await writeFile(input, JSON.stringify({ operations })); return command('board', 'operations', '--session', session.id, '--input', input); };
  await operations(assets.map((asset, index) => ({ type: 'create', object: { id: ['a', 'b', 'loose'][index], assetId: asset.id, x: 100 + index * 300, y: 200, width: 200, height: 120 } })));
  await operations([{ type: 'group.create', group: { id: 'folder', objectIds: ['a', 'b'] }, expectedVersions: { a: 1, b: 1 } }]);
  await operations([{ type: 'group.update', groupId: 'folder', expectedVersion: 1, changes: { mode: 'folder' } }]);
  const listed = await command('group', 'list', '--session', session.id);
  assert.equal(listed.length, 1); assert.equal(listed[0].id, 'folder');
  const read = await command('group', 'read', '--session', session.id, '--group', 'folder');
  assert.equal(read.coordinateSpace, 'world'); assert.equal(read.group.mode, 'folder'); assert.equal(read.group.x, 76); assert.equal(read.group.y, 160);
  assert.deepEqual(read.displayBounds, { x: 76, y: 160, width: 216, height: 256 });
  assert.deepEqual(read.members.map((member: any) => ({ id: member.object.id, file: member.asset.name, assetId: member.asset.id, x: member.object.x, y: member.object.y, width: member.object.width, height: member.object.height })), [
    { id: 'a', file: 'Palette.txt', assetId: assets[0].id, x: 100, y: 200, width: 200, height: 120 },
    { id: 'b', file: 'Composition.txt', assetId: assets[1].id, x: 400, y: 200, width: 200, height: 120 },
  ]);
  const state = await command('session', 'read', '--session', session.id) as BoardState, loose = state.objects.find(item => item.id === 'loose')!;
  await assert.rejects(command('group', 'put', '--session', session.id, '--group', 'folder', '--object', 'loose'), /--version is required/);
  await command('group', 'put', '--session', session.id, '--group', 'folder', '--object', 'loose', '--version', String(loose.version));
  const after = await command('group', 'read', '--session', session.id, '--group', 'folder');
  const placed = after.members.find((member: any) => member.object.id === loose.id);
  assert.equal(placed.asset.id, loose.assetId); assert.equal(placed.asset.name, 'Loose.txt'); assert.equal(placed.object.id, loose.id);
  assert.equal(placed.object.x, loose.x); assert.equal(placed.object.y, loose.y); assert.equal(placed.object.width, loose.width); assert.equal(placed.object.height, loose.height);
  await assert.rejects(command('group', 'put', '--session', session.id, '--group', 'folder', '--object', 'loose', '--version', String(loose.version)), /object_conflict/);
  await assert.rejects(command('group', 'put', '--session', session.id, '--group', 'missing', '--object', 'loose', '--version', String(placed.object.version)), /group_missing/);
  const moved = await command('group', 'put', '--session', session.id, '--group', 'folder', '--object', 'loose', '--version', String(placed.object.version), '--x', '-80', '--y', '420');
  assert.equal(moved.objects.find((item: any) => item.id === 'loose').x, -80); assert.equal(moved.objects.find((item: any) => item.id === 'loose').y, 420);
  await operations([{ type: 'create', object: { id: 'new', groupId: 'folder', assetId: assets[2].id, x: 150, y: 550, width: 200, height: 120 } }]);
  const final = await command('group', 'read', '--session', session.id, '--group', 'folder');
  assert.deepEqual(final.members.map((member: any) => member.object.id), ['a', 'b', 'loose', 'new']);
  assert.equal(final.members.find((member: any) => member.object.id === 'new').asset.id, assets[2].id);
  const current = final.members.find((member: any) => member.object.id === 'loose').object;
  await operations([{ type: 'update', objectId: current.id, expectedVersion: current.version, changes: { groupId: null } }]);
  assert.equal((await command('group', 'read', '--session', session.id, '--group', 'folder')).members.some((member: any) => member.object.id === 'loose'), false);
  await assert.rejects(command('group', 'list'), /--session is required/);
  await assert.rejects(command('group', 'read', '--session', session.id, '--group', 'missing'), /referenced group is unavailable/);
  const help = (await execute(process.execPath, [cliPath, '--help'])).stdout;
  assert.match(help, /group list/); assert.match(help, /group read/); assert.match(help, /group put/); assert.match(help, /world coordinates/);
});
