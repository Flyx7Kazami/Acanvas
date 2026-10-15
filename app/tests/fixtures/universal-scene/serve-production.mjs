import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const directory = process.env.ACANVAS_SCENE_DIST;
const { startServer } = await import(pathToFileURL(join(directory, 'src/server/http.js')).href);
const root = await mkdtemp(join(tmpdir(), 'acanvas-scene-iab-project-'));
const server = await startServer({ root, port: 0, webRoot: join(directory, 'web') });
const bootstrap = await (await fetch(server.url + '/api/bootstrap')).json();
const call = async (path, method, body) => { const response = await fetch(server.url + path, { method, headers: { Authorization: 'Bearer ' + bootstrap.token, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); if (!response.ok) throw new Error('Fixture API failed.'); return response.json(); };
const session = await call('/api/sessions', 'POST', { name: 'Isolated embedded scene' });
const bytes = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="300" height="180"><rect width="300" height="180" fill="#8ebbcf"/><circle cx="90" cy="90" r="45" fill="#f2c365"/></svg>');
const response = await fetch(server.url + '/api/assets?name=Reference.svg&mime=image%2Fsvg%2Bxml', { method: 'POST', headers: { Authorization: 'Bearer ' + bootstrap.token }, body: bytes });
const asset = await response.json();
await call('/api/board/operations', 'POST', { sessionId: session.id, operations: [{ type: 'create', object: { assetId: asset.id, x: 260, y: 180, width: 300, height: 180 } }] });
console.log(JSON.stringify({ url: server.url + '/?session=' + session.id, root, pid: process.pid, isolated: true }));
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await server.close(); await rm(root, { recursive: true, force: true }); process.exit(0); });
