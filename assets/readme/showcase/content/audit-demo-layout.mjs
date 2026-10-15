import { readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify, isDeepStrictEqual } from 'node:util';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const content = dirname(fileURLToPath(import.meta.url)), installation = resolve(content, '../../../..');
const [project, session] = process.argv.slice(2), run = promisify(execFile);
const expected = JSON.parse(await readFile(join(content, 'geometric-board-layout.json'), 'utf8'));
const state = JSON.parse((await run(process.execPath, [join(installation, 'scripts/acanvas.mjs'), 'session', 'read', '--project', project, '--session', session], { cwd: installation })).stdout);
const knownIds = new Set(expected.objects.map(object => object.id));
const fields = object => Object.fromEntries(['x', 'y', 'width', 'height', 'groupId'].map(key => [key, object[key] ?? null]));
const differences = expected.objects.flatMap(object => {
  const current = state.objects.find(value => value.id === object.id);
  return !current || !isDeepStrictEqual(fields(current), fields(object)) || current.assetId !== object.assetId ? [{ objectId: object.id, expected: fields(object), current: current ? fields(current) : null, assetChanged: !!current && current.assetId !== object.assetId }] : [];
});
const result = { kind: 'read-only comparison of the original shared demonstration', knownObjects: expected.objects.length, currentObjects: state.objects.length, differences, unknownObjectIds: state.objects.filter(object => !knownIds.has(object.id)).map(object => object.id), unknownGroups: state.groups.filter(group => !Object.values(expected.fixtureGroups).includes(group.id)).map(group => ({ id: group.id, mode: group.mode, members: group.objectIds.length })), fixtureTasks: state.tasks.filter(task => expected.fixtureTaskIds.includes(task.id)).map(task => ({ id: task.id, status: task.status })), extraTaskIds: state.tasks.filter(task => !expected.fixtureTaskIds.includes(task.id)).map(task => task.id), draftMatchesFixture: state.draft.id === expected.fixtureDraft.id && state.draft.revision === expected.fixtureDraft.revision && state.draft.text === expected.fixtureDraft.text && isDeepStrictEqual(state.draft.references, expected.fixtureDraft.references) };
await writeFile(resolve(content, '../geometric/evidence/original-demo-layout-comparison.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify({ changedKnownObjects: differences.length, unknownObjects: result.unknownObjectIds.length, unknownGroups: result.unknownGroups.length, draftMatchesFixture: result.draftMatchesFixture }));
