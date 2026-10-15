import { readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify, isDeepStrictEqual } from 'node:util';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const content = dirname(fileURLToPath(import.meta.url));
const installation = resolve(content, '../../../..');
const showcase = resolve(content, '..');
const [project, session] = process.argv.slice(2);
if (!project || !session) throw new Error('Pass the isolated demonstration project and session.');
const run = promisify(execFile);
const command = async (...args) => JSON.parse((await run(process.execPath, [join(installation, 'scripts/acanvas.mjs'), ...args, '--project', project, '--session', session], { cwd: installation })).stdout);
const published = JSON.parse(await readFile(join(content, 'geometric-board-layout.json'), 'utf8'));
const directory = await mkdtemp(join(dirname(project), 'verify-final-'));
const resources = [];
for (const [index, entry] of [...published.art, ...published.audio, ...published.apps].entries()) {
  const target = join(directory, `${index + 1}-${entry.file.split('/').pop()}`);
  await command('asset', 'read', '--asset', entry.assetId, '--out', target);
  const expected = await readFile(resolve(showcase, entry.file));
  const actual = await readFile(target);
  resources.push({ file: entry.file, assetId: entry.assetId, bytes: actual.length, matches: actual.equals(expected) });
}
const state = await command('session', 'read');
const fixtureDraft = published.fixtureDraft;
const draftIsFixture = fixtureDraft && state.draft.id === fixtureDraft.id && state.draft.revision === fixtureDraft.revision && state.draft.text === fixtureDraft.text
  && isDeepStrictEqual(state.draft.attachments, fixtureDraft.attachments) && isDeepStrictEqual(state.draft.annotations, fixtureDraft.annotations) && isDeepStrictEqual(state.draft.references, fixtureDraft.references)
  && state.draft.editingTaskId === fixtureDraft.editingTaskId;
const result = {
  ...(published.presentation ? { presentation: published.presentation } : {}),
  resources,
  objects: state.objects.length,
  groups: state.groups.filter(group => Object.values(published.fixtureGroups).includes(group.id)).map(group => ({ name: group.name, mode: group.mode, members: group.objectIds.length })),
  queue: state.tasks.filter(task => published.fixtureTaskIds.includes(task.id)).map(task => ({ sequence: task.sequence, status: task.status, text: task.snapshot.userRequest.text })),
  ...(draftIsFixture ? { draft: state.draft.text } : { preservedDraft: true }),
  view: state.session.view,
};
await writeFile(join(directory, 'verification.json'), JSON.stringify(result, null, 2));
await writeFile(join(showcase, 'geometric/evidence/published-resources.json'), JSON.stringify(result, null, 2));
if (resources.some(resource => !resource.matches)) throw new Error('Published materials must match the final source files.');
console.log(JSON.stringify({ resources: resources.length, matches: resources.every(resource => resource.matches), objects: result.objects, groups: result.groups, view: result.view }));
