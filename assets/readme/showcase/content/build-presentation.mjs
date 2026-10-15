import { readFile, writeFile, mkdir, mkdtemp } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, resolve, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { manualLayout, geometricLayout, geometricView, projectGeometricLayout } from './geometric-layout.mjs';

const content = dirname(fileURLToPath(import.meta.url)), showcase = resolve(content, '..'), installation = resolve(content, '../../../..');
const run = promisify(execFile), directory = await mkdtemp('/private/tmp/acanvas-presentation-'), project = join(directory, 'Slow Signal');
await mkdir(project);
const env = { ...process.env, CODEX_THREAD_ID: '' };
let session;
const command = async (...args) => JSON.parse((await run(process.execPath, [join(installation, 'scripts/acanvas.mjs'), ...args, '--project', project, ...(session ? ['--session', session] : [])], { cwd: installation, env })).stdout);
const input = async (name, value) => { const file = join(project, name); await writeFile(file, JSON.stringify(value, null, 2)); return file; };
const opened = await command('project', 'open');
session = (await command('session', 'create', '--name', 'Slow Signal presentation')).id;
const connection = await command('project', 'open');
const manifest = JSON.parse(await readFile(resolve(showcase, 'geometric/materials.json'), 'utf8'));
const importFile = async entry => {
  const file = resolve(showcase, 'geometric', entry.file);
  const asset = await command('asset', 'import', '--file', file, '--allow-directory', dirname(file));
  return { file: relative(showcase, file), assetId: asset.id };
};
const art = [], audio = [], apps = [];
for (const entry of manifest.art) art.push(await importFile(entry));
for (const entry of manifest.audio) audio.push(await importFile(entry));
for (const entry of manifest.apps) apps.push(await importFile(entry));
const texts = {
  direction: ['art-direction.note', 'Shape, then rhythm.\nBold blocks.\nQuiet breathing room.'],
  listening: ['listening.note', 'Two sound directions\nWarm pulses / soft noise\nListen before choosing.'],
  next: ['next-pass.note', 'Next pass ↗\nChoose 02.\nTune the rhythm.'],
  brief: ['creative-brief.md', '# Slow Signal\n\nA listening app, shaped by rhythm.\n\n**Explore:** colour, geometry, sound.\n'],
};
const created = [], notes = {}, operations = [];
const create = (key, assetId, bounds) => {
  const [x, y, width, height] = bounds, object = { id: randomUUID(), assetId, x, y, width, height };
  created.push({ key, ...object }); operations.push({ type: 'create', object }); return object;
};
for (const [key, [name, text]] of Object.entries(texts)) {
  const file = join(project, name); await writeFile(file, text);
  const asset = await command('asset', 'import', '--file', file, ...(key === 'brief' ? [] : ['--mime', 'text/x-acanvas-note']));
  notes[key] = create(key, asset.id, geometricLayout[key]);
}
art.forEach((entry, index) => {
  create(`art-${index + 1}`, entry.assetId, geometricLayout[`art-${index + 1}`]);
  const hidden = manualLayout.objects.find(object => object.key === `folder-art-${index + 1}`);
  create(hidden.key, entry.assetId, [hidden.x, hidden.y, hidden.width, hidden.height]);
});
audio.forEach((entry, index) => create(`audio-${index + 1}`, entry.assetId, geometricLayout[`audio-${index + 1}`]));
apps.forEach((entry, index) => create(`app-${index + 1}`, entry.assetId, geometricLayout[`app-${index + 1}`]));
await command('board', 'operations', '--input', await input('create-presentation.json', { operations }));
let state = await command('session', 'read');
await command('board', 'operations', '--input', await input('presentation-note-colours.json', { operations: ['direction', 'listening', 'next'].map(key => ({ type: 'update', objectId: notes[key].id, expectedVersion: state.objects.find(object => object.id === notes[key].id).version, changes: { fill: manualLayout.objects.find(object => object.key === key).fill ?? null } })) }));
state = await command('session', 'read');
const fixtureGroups = Object.fromEntries(manualLayout.groups.map(group => [group.key, randomUUID()]));
const groupOperations = manualLayout.groups.map(group => {
  const members = group.members.map(key => state.objects.find(object => object.id === created.find(value => value.key === key).id));
  return { type: 'group.create', group: { id: fixtureGroups[group.key], name: group.name, color: group.color, objectIds: members.map(object => object.id) }, expectedVersions: Object.fromEntries(members.map(object => [object.id, object.version])) };
});
await command('board', 'operations', '--input', await input('presentation-groups.json', { operations: groupOperations }));
for (const group of manualLayout.groups) {
  state = await command('session', 'read');
  await command('board', 'operations', '--input', await input(`presentation-group-${group.key}.json`, { operations: [{ type: 'group.update', groupId: fixtureGroups[group.key], expectedVersion: state.groups.find(value => value.id === fixtureGroups[group.key]).version, changes: { name: group.name, mode: group.mode, x: group.x, y: group.y } }] }));
}
state = await command('session', 'read');
await command('board', 'operations', '--input', await input('presentation-manual-geometry.json', { operations: manualLayout.objects.map(object => ({ type: 'update', objectId: created.find(value => value.key === object.key).id, expectedVersion: state.objects.find(value => value.id === created.find(saved => saved.key === object.key).id).version, changes: { x: object.x, y: object.y, width: object.width, height: object.height } })) }));
const idFor = key => created.find(object => object.key === key).id;
const requests = [
  { text: 'Create a new poster from these studies.', objectIds: ['art-1', 'art-2'].map(idFor), groupIds: [] },
  { text: 'Try the warm pulse with direction 02.', objectIds: ['audio-1', 'app-2'].map(idFor), groupIds: [] },
  { text: 'Extend the visual language into motion.', objectIds: [], groupIds: [fixtureGroups.frame] },
];
const fixtureTaskIds = [];
for (const [index, request] of requests.entries()) {
  state = await command('session', 'read');
  const draft = { ...state.draft, text: request.text, attachments: [], annotations: [], references: { objectIds: request.objectIds, taskIds: [], groupIds: request.groupIds } };
  const saved = await command('draft', 'save', '--input', await input(`presentation-request-${index + 1}.json`, draft));
  fixtureTaskIds.push((await command('draft', 'send', '--draft', saved.id, '--revision', String(saved.revision))).task.id);
}
state = await command('session', 'read');
const fixtureDraft = await command('draft', 'save', '--input', await input('presentation-draft.json', { ...state.draft, text: 'Refine direction 02.', references: { objectIds: [idFor('app-2')], taskIds: [], groupIds: [fixtureGroups.frame] } }));
const viewport = manualLayout.viewport ?? { width: 918.5, height: 798 }, view = geometricView(viewport);
await command('view', 'save', '--input', await input('presentation-view.json', view));
state = await command('session', 'read');
const updatedCreated = created.map(object => ({ ...object, ...state.objects.find(value => value.id === object.id) }));
await input('demo-base.json', { project, session, objects: updatedCreated });
const presentation = { kind: 'Independent README presentation', builder: 'content/build-presentation.mjs', layoutSource: 'content/manual-layout.json', projectId: state.project.id, sessionId: session, hostBindingConfigured: Boolean(opened.binding || connection.binding), runtimeMode: state.hostRuntime.mode, runtimeConnection: state.hostRuntime.connection };
const record = { presentation, viewport, view, queuePresentation: 'collapsed', art, audio, apps, created: updatedCreated.filter(object => !Object.keys(notes).includes(object.key)), fixtureGroups, fixtureTaskIds, fixtureDraft, preservedObjectIds: [], updatedTaskIds: fixtureTaskIds, preservedDraft: false, objects: state.objects, groups: state.groups, tasks: state.tasks.map(task => ({ id: task.id, sequence: task.sequence, status: task.status, text: task.snapshot.userRequest.text })), draft: state.draft };
const oldCheckpoint = await readFile(join(content, 'geometric-board-layout.json'), 'utf8');
await writeFile(resolve(showcase, 'geometric/evidence/previous-demo-fixture.json'), oldCheckpoint);
await writeFile(join(content, 'geometric-board-layout.json'), JSON.stringify(record, null, 2));
await writeFile(join(content, 'real-board-layout.json'), JSON.stringify({ presentation, objects: state.objects, groups: state.groups, tasks: record.tasks, view }, null, 2));
await writeFile(resolve(showcase, 'geometric/evidence/staggered-layout-projection.json'), JSON.stringify(projectGeometricLayout(state, Object.fromEntries(updatedCreated.map(object => [object.key, object.id])), fixtureGroups, viewport, view), null, 2));
await input('presentation-readback.json', state);
const previewOrigin = (await fetch(connection.openUrl)).headers.get('content-security-policy')?.match(/frame-src\s+([^;]+)/)?.[1];
const receipt = { project, session, openUrl: connection.openUrl, previewOrigin, service: opened.service, objects: state.objects.length, groups: state.groups.map(group => ({ name: group.name, mode: group.mode, members: group.objectIds.length })), queued: state.tasks.length, view, hostBindingConfigured: presentation.hostBindingConfigured };
await writeFile(join(directory, 'presentation-receipt.json'), JSON.stringify(receipt, null, 2));
console.log(JSON.stringify(receipt));
