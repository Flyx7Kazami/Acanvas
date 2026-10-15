import { readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const content = dirname(fileURLToPath(import.meta.url)), installation = resolve(content, '../../../..'), run = promisify(execFile);
const [project, session] = process.argv.slice(2);
const fixture = JSON.parse(await readFile(resolve(content, '../geometric/evidence/previous-demo-fixture.json'), 'utf8'));
const base = JSON.parse(await readFile(join(project, 'demo-base.json'), 'utf8'));
const state = JSON.parse((await run(process.execPath, [join(installation, 'scripts/acanvas.mjs'), 'session', 'read', '--project', project, '--session', session], { cwd: installation })).stdout);
const roleIds = Object.fromEntries(fixture.created.map(object => [object.key, object.id]));
for (const key of ['direction', 'listening', 'brief', 'next']) roleIds[key] = base.objects.find(object => object.key === key).id;
const rolesById = Object.fromEntries(Object.entries(roleIds).map(([key, id]) => [id, key]));
const objects = Object.entries(roleIds).map(([key, id]) => {
  const object = state.objects.find(object => object.id === id);
  if (!object) throw new Error(`The known manual object is unavailable: ${key}`);
  return { key, sourceObjectId: id, x: object.x, y: object.y, width: object.width, height: object.height, ...(object.fill ? { fill: object.fill } : {}), ...(object.groupId ? { sourceGroupId: object.groupId } : {}) };
});
const groups = state.groups.filter(group => group.objectIds.some(id => rolesById[id])).map((group, index) => {
  if (group.objectIds.some(id => !rolesById[id])) throw new Error('A manual group also contains additional user material. Preserve the source and review that group before copying.');
  const name = ['Visual language', 'Studies'].includes(group.name) || /^Group \d+$/.test(group.name) ? group.name : `Group ${index + 1}`;
  return { key: group.id === fixture.fixtureGroups.frame ? 'frame' : group.id === fixture.fixtureGroups.folder ? 'folder' : `manual-${index + 1}`, sourceGroupId: group.id, name, mode: group.mode, color: group.color, x: group.x, y: group.y, width: group.width, height: group.height, members: group.objectIds.map(id => rolesById[id]) };
});
const result = { kind: 'User-authored manual showcase layout', objects, groups };
await writeFile(join(content, 'manual-layout.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
