// Clone an explicitly selected local board into a temporary renderer study.
// Run with Node 24 after building: node app/tests/zoom-render-study.mjs --source-url 'http://127.0.0.1:PORT/?session=ID'
import { mkdtemp, mkdir, cp, writeFile, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { startServer } from '../../dist/src/server/http.js';

const sourceArgument = process.argv.indexOf('--source-url');
if (sourceArgument < 0) throw new Error('Supply --source-url with the board URL and its session.');
const source = new URL(process.argv[sourceArgument + 1]);
const sessionId = source.searchParams.get('session');
if (!sessionId) throw new Error('The board URL needs an explicit session.');
const bootstrapResponse = await fetch(new URL('/api/bootstrap', source));
if (!bootstrapResponse.ok) throw new Error(`Source bootstrap: ${bootstrapResponse.status}`);
const { token } = await bootstrapResponse.json();
const headers = { Authorization: `Bearer ${token}` };
const stateResponse = await fetch(new URL(`/api/state?sessionId=${encodeURIComponent(sessionId)}`, source), { headers });
if (!stateResponse.ok) throw new Error(`Source state: ${stateResponse.status}`);
const state = await stateResponse.json();
const directory = await mkdtemp(join(tmpdir(), 'acanvas-render-study-'));
const webRoot = join(directory, 'web');
await cp(resolve(process.env.WEB_ROOT || 'dist/web'), webRoot, { recursive: true });
await cp(fileURLToPath(new URL('./fixtures/zoom-render-study/render-study.js', import.meta.url)), join(webRoot, 'render-study.js'));
const index = join(webRoot, 'index.html');
await writeFile(index, (await readFile(index, 'utf8')).replace('</body>', '<script type="module" src="/render-study.js"></script></body>'));
const projectRoot = join(directory, 'project');
await mkdir(projectRoot);
const running = await startServer({ root: projectRoot, port: 0, webRoot });
try {
  for (const [index, asset] of state.assets.entries()) {
    const response = await fetch(new URL(`/api/assets/${encodeURIComponent(asset.id)}/content`, source), { headers });
    if (!response.ok) throw new Error(`Source asset ${asset.id}: ${response.status}`);
    const data = Buffer.from(await response.arrayBuffer()), path = `assets/${index}`;
    await writeFile(join(running.service.dataDir, path), data);
    running.service.registerAsset(asset, path);
  }
  const session = running.service.createSession('Render architecture study');
  // The study compares independent image, note, and Markdown items in one world layer.
  const operations = state.objects.map(({ id, assetId, x, y, width, height }) => ({ type: 'create', object: { id, assetId, x, y, width, height } }));
  for (let offset = 0; offset < operations.length; offset += 1000) running.service.boardOperations(session.id, operations.slice(offset, offset + 1000));
  running.service.saveView(session.id, { x: 70, y: 120, zoom: .08, selectedObjectIds: [] });
  console.log(JSON.stringify({ root: directory, url: `${running.url}/?session=${session.id}`, objects: running.service.objects().length }));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => void running.close().then(() => process.exit(0)));
} catch (error) { await running.close(); throw error; }
