import { readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify, isDeepStrictEqual } from 'node:util';
import { dirname, resolve, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { manualLayout, geometricLayout, geometricView, projectGeometricLayout } from './geometric-layout.mjs';

const content = dirname(fileURLToPath(import.meta.url));
const showcase = resolve(content, '..');
const installation = resolve(content, '../../../..');
const [project, session, manifestFile, width = String(manualLayout.viewport?.width ?? 918.5), height = String(manualLayout.viewport?.height ?? 798)] = process.argv.slice(2);
if (!project || !session || !manifestFile) throw new Error('Pass the isolated demonstration project, session, and material manifest.');
const base = JSON.parse(await readFile(join(project, 'demo-base.json'), 'utf8'));
if (base.project !== project || base.session !== session) throw new Error('Use the project and session recorded by the demonstration builder.');
const priorLayout = JSON.parse(await readFile(join(content, 'real-board-layout.json'), 'utf8'));
const priorPublished = JSON.parse(await readFile(join(content, 'geometric-board-layout.json'), 'utf8'));
const fixtureGroups = priorPublished.fixtureGroups ?? {
  frame: priorLayout.groups.find(group => group.mode === 'frame').id,
  folder: priorLayout.groups.find(group => group.mode === 'folder').id,
};
const fixtureTaskIds = priorPublished.fixtureTaskIds ?? priorLayout.tasks.map(task => task.id);
const ownedObjectIds = new Set([...base.objects, ...priorLayout.objects, ...priorPublished.created].map(object => object.id));
let fixtureDraft = priorPublished.fixtureDraft ?? priorPublished.draft;
const sameDraft = (current, expected) => expected && current.id === expected.id && current.revision === expected.revision && current.text === expected.text
  && isDeepStrictEqual(current.attachments, expected.attachments) && isDeepStrictEqual(current.annotations, expected.annotations) && isDeepStrictEqual(current.references, expected.references)
  && current.editingTaskId === expected.editingTaskId;
const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
const viewport = { width: Number(width), height: Number(height) };
const run = promisify(execFile);
const command = async (...args) => JSON.parse((await run(process.execPath, [join(installation, 'scripts/acanvas.mjs'), ...args, '--project', project, '--session', session], { cwd: installation })).stdout);
const input = async (name, value) => { const file = join(project, name); await writeFile(file, JSON.stringify(value, null, 2)); return file; };
const importFile = async entry => {
  const file = resolve(dirname(manifestFile), entry.file);
  const args = entry.bundleRoot ? ['--bundle-root', resolve(dirname(manifestFile), entry.bundleRoot)] : ['--allow-directory', dirname(file)];
  const imported = await command('asset', 'import', '--file', file, ...args);
  return { ...entry, file: relative(showcase, file), ...(entry.bundleRoot ? { bundleRoot: relative(showcase, resolve(dirname(manifestFile), entry.bundleRoot)) } : {}), assetId: imported.assetId ?? imported.id };
};

let state = await command('session', 'read');
const preserveCurrentDraft = async () => {
  await input('geometric-publication-preserved.json', { preservedDraft: true, skippedPublication: true, draftId: state.draft.id, revision: state.draft.revision });
  console.log(JSON.stringify({ preservedDraft: true, skippedPublication: true }));
  process.exit(0);
};
if (!sameDraft(state.draft, fixtureDraft)) await preserveCurrentDraft();
const frame = state.groups.find(group => group.id === fixtureGroups.frame);
const folder = state.groups.find(group => group.id === fixtureGroups.folder);
if (!frame || !folder) throw new Error('The demonstration frame and folder must exist.');
const notes = Object.fromEntries(['direction', 'listening', 'next', 'brief'].map(key => [key, state.objects.find(object => object.id === base.objects.find(saved => saved.key === key)?.id)]));
if (Object.values(notes).some(object => !object)) throw new Error('The four native text objects must exist.');
const art = [];
for (const entry of manifest.art) art.push(await importFile(entry));
const audio = [];
for (const entry of manifest.audio) audio.push(await importFile(entry));
const apps = [];
for (const entry of manifest.apps) apps.push(await importFile(entry));
state = await command('session', 'read');
if (!sameDraft(state.draft, fixtureDraft)) await preserveCurrentDraft();

const created = [];
const create = (key, assetId, x, y, objectWidth, objectHeight, groupId) => {
  const id = randomUUID();
  const object = { id, assetId, x, y, width: objectWidth, height: objectHeight, ...(groupId ? { groupId } : {}) };
  created.push({ key, ...object });
  return { type: 'create', object };
};
const retained = new Set(Object.values(notes).map(object => object.id));
const groupFor = key => { const sourceGroupId = manualLayout.objects.find(object => object.key === key).sourceGroupId; return sourceGroupId ? fixtureGroups[manualLayout.groups.find(group => group.sourceGroupId === sourceGroupId).key] : null; };
const preservedObjectIds = state.objects.filter(object => !ownedObjectIds.has(object.id)).map(object => object.id);
const operations = state.objects.filter(object => ownedObjectIds.has(object.id) && !retained.has(object.id)).map(object => ({ type: 'delete', objectId: object.id, expectedVersion: object.version }));
for (const [key, object] of Object.entries(notes)) {
  const [x, y, objectWidth, objectHeight] = geometricLayout[key];
  operations.push({ type: 'update', objectId: object.id, expectedVersion: object.version, changes: { x, y, width: objectWidth, height: objectHeight, groupId: groupFor(key) } });
}
art.forEach((entry, index) => {
  operations.push(create(`art-${index + 1}`, entry.assetId, ...geometricLayout[`art-${index + 1}`], groupFor(`art-${index + 1}`)));
  const hidden = manualLayout.objects.find(object => object.key === `folder-art-${index + 1}`);
  operations.push(create(hidden.key, entry.assetId, hidden.x, hidden.y, hidden.width, hidden.height, groupFor(hidden.key)));
});
audio.forEach((entry, index) => operations.push(create(`audio-${index + 1}`, entry.assetId, ...geometricLayout[`audio-${index + 1}`], groupFor(`audio-${index + 1}`))));
apps.forEach((entry, index) => operations.push(create(`app-${index + 1}`, entry.assetId, ...geometricLayout[`app-${index + 1}`], groupFor(`app-${index + 1}`))));
await command('board', 'operations', '--input', await input('geometric-objects.json', { operations }));

state = await command('session', 'read');
const texts = {
  direction: 'Shape, then rhythm.\nBold blocks.\nQuiet breathing room.',
  listening: 'Two sound directions\nWarm pulses / soft noise\nListen before choosing.',
  next: 'Next pass ↗\nChoose 02.\nTune the rhythm.',
  brief: '# Slow Signal\n\nA listening app, shaped by rhythm.\n\n**Explore:** colour, geometry, sound.\n',
};
await command('board', 'operations', '--input', await input('geometric-text.json', { operations: Object.entries(notes).map(([key, object]) => ({ type: 'content', objectId: object.id, expectedVersion: state.objects.find(value => value.id === object.id).version, text: texts[key] })) }));
state = await command('session', 'read');
await command('board', 'operations', '--input', await input('geometric-groups.json', { operations: manualLayout.groups.map(group => ({ type: 'group.update', groupId: fixtureGroups[group.key], expectedVersion: state.groups.find(value => value.id === fixtureGroups[group.key]).version, changes: { name: group.name, mode: group.mode, x: group.x, y: group.y } })) }));

const requests = [
  { text: 'Create a new poster from these studies.', objectIds: ['art-1', 'art-2'].map(key => created.find(object => object.key === key).id), groupIds: [] },
  { text: 'Try the warm pulse with direction 02.', objectIds: ['audio-1', 'app-2'].map(key => created.find(object => object.key === key).id), groupIds: [] },
  { text: 'Extend the visual language into motion.', objectIds: [], groupIds: [frame.id] },
];
state = await command('session', 'read');
const updatedTaskIds = [];
let preservedDraft = false;
for (let index = 0; index < requests.length; index++) {
  state = await command('session', 'read');
  if (!sameDraft(state.draft, fixtureDraft)) { preservedDraft = true; break; }
  const task = state.tasks.find(task => task.id === fixtureTaskIds[index]);
  if (task?.status !== 'queued') continue;
  const edit = await command('task', 'edit', '--task', task.id, '--draft', state.draft.id, '--revision', String(state.draft.revision));
  const request = requests[index];
  const draft = { ...edit.draft, text: request.text, attachments: [], annotations: [], references: { objectIds: request.objectIds, taskIds: [], groupIds: request.groupIds } };
  const saved = await command('draft', 'save', '--input', await input(`geometric-request-${index + 1}.json`, draft));
  const sent = await command('draft', 'send', '--draft', saved.id, '--revision', String(saved.revision));
  fixtureDraft = sent.draft;
  updatedTaskIds.push(task.id);
}
state = await command('session', 'read');
if (sameDraft(state.draft, fixtureDraft)) {
  const draft = { ...state.draft, text: 'Refine direction 02.', attachments: [], annotations: [], references: { objectIds: [created.find(object => object.key === 'app-2').id], taskIds: [], groupIds: [frame.id] } };
  fixtureDraft = await command('draft', 'save', '--input', await input('geometric-draft.json', draft));
} else preservedDraft = true;
const view = geometricView(viewport);
await command('view', 'save', '--input', await input('geometric-view.json', view));
state = await command('session', 'read');
const publishedObjectIds = new Set([...retained, ...created.map(object => object.id)]);
const record = { ...(priorPublished.presentation ? { presentation: priorPublished.presentation } : {}), viewport, view, art, audio, apps, created, fixtureGroups, fixtureTaskIds, fixtureDraft, preservedObjectIds, updatedTaskIds, preservedDraft, objects: state.objects.filter(object => publishedObjectIds.has(object.id)), groups: state.groups.filter(group => Object.values(fixtureGroups).includes(group.id)), tasks: state.tasks.filter(task => fixtureTaskIds.includes(task.id)).map(task => ({ id: task.id, sequence: task.sequence, status: task.status, text: task.snapshot.userRequest.text })), ...(preservedDraft ? {} : { draft: state.draft }) };
await input('geometric-readback.json', state);
await writeFile(join(content, 'geometric-board-layout.json'), JSON.stringify(record, null, 2));
const projectionIds = Object.fromEntries([...created.map(object => [object.key, object.id]), ...Object.entries(notes).map(([key, object]) => [key, object.id])]);
await writeFile(resolve(content, '../geometric/evidence/staggered-layout-projection.json'), JSON.stringify(projectGeometricLayout(state, projectionIds, fixtureGroups, viewport, view), null, 2));
console.log(JSON.stringify({ objects: state.objects.length, groups: state.groups.map(group => ({ name: group.name, mode: group.mode, members: group.objectIds.length })), queued: state.tasks.filter(task => task.status === 'queued').length, preservedObjectIds, updatedTaskIds, preservedDraft, view }));
