import { readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const content = dirname(fileURLToPath(import.meta.url));
const installation = resolve(content, '../../../..');
const [project, session, panelWidth = '940', panelHeight = '820'] = process.argv.slice(2);
if (!project || !session) throw new Error('Pass the isolated demonstration project and session.');
const viewport = { width: Number(panelWidth), height: Number(panelHeight) };
if (!Number.isFinite(viewport.width) || !Number.isFinite(viewport.height) || viewport.width < 600 || viewport.height < 600) throw new Error('Pass a desktop side panel width and height of at least 600 pixels.');
const base = JSON.parse(await readFile(join(project, 'demo-base.json'), 'utf8'));
if (base.project !== project || base.session !== session) throw new Error('Use the project and session recorded by the demonstration builder.');
const run = promisify(execFile);
const command = async (...args) => JSON.parse((await run(process.execPath, [join(installation, 'scripts/acanvas.mjs'), ...args, '--project', project, '--session', session], { cwd: installation })).stdout);
const input = async (name, value) => { const file = join(project, name); await writeFile(file, JSON.stringify(value, null, 2)); return file; };

// World coordinates leave space for native object captions and the group frame.
const layout = {
  wordmark: [0, 45, 310, 93],
  bloom: [0, 180, 310, 465],
  signal: [0, 705, 190, 122],
  direction: [0, 890, 310, 155],
  echo: [375, 100, 215, 215],
  next: [635, 100, 210, 168],
  ticket: [635, 320, 210, 65],
  drift: [375, 445, 470, 313],
  activity: [905, 75, 330, 411],
  brief: [905, 550, 330, 430],
  afterimage: [1295, 75, 350, 125],
  smallhours: [1295, 255, 350, 125],
  listening: [1295, 440, 350, 175],
  lineup: [375, 850, 135, 171],
  palette: [575, 865, 270, 159],
};
let state = await command('session', 'read');
const savedByKey = key => {
  const saved = base.objects.find(object => object.key === key);
  const fileName = saved?.file?.split('/').pop() || `${key}.png`;
  return state.objects.find(object => object.assetId === saved?.assetId)
    || state.objects.find(object => state.assets.find(asset => asset.id === object.assetId)?.name === fileName);
};
const operations = [];
for (const [key, bounds] of Object.entries(layout)) {
  const object = savedByKey(key);
  if (!object) throw new Error(`Missing demonstration object: ${key}`);
  const [x, y, width, height] = bounds;
  operations.push({ type: 'update', objectId: object.id, expectedVersion: object.version, changes: { x, y, width, height } });
}
const folder = state.groups.find(group => group.name === 'Image studies' && group.mode === 'folder');
if (!folder) throw new Error('The Image studies folder must exist.');
operations.push({ type: 'group.update', groupId: folder.id, expectedVersion: folder.version, changes: { x: 1295, y: 715 } });
await command('board', 'operations', '--input', await input('real-layout-operations.json', { operations }));
// The native toolbar and expanded queue retain clear space around the artwork.
const zoom = Math.floor(Math.min((viewport.width - 134) / 1645, (viewport.height - 288) / 1077) * 100) / 100;
const view = { x: 84, y: 76, zoom, selectedObjectIds: [] };
await command('view', 'save', '--input', await input('real-layout-view.json', view));
state = await command('session', 'read');
const record = {
  viewport, view,
  objects: [...Object.keys(layout), 'bloom-blue-study', 'echo-blue-study', 'drift-blue-study'].map(key => ({ key, ...savedByKey(key) })),
  groups: state.groups,
  tasks: state.tasks.map(task => ({ id: task.id, sequence: task.sequence, status: task.status })),
};
await writeFile(join(content, 'real-board-layout.json'), JSON.stringify(record, null, 2));
await input('real-layout-readback.json', state);
console.log(JSON.stringify({ objects: state.objects.length, groups: state.groups.map(group => ({ name: group.name, mode: group.mode, members: group.objectIds.length })), queued: state.tasks.filter(task => task.status === 'queued').length, view }));
