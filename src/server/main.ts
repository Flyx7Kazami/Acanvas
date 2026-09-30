import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './http.js';

const args = process.argv.slice(2);
const option = (name: string) => { const position = args.indexOf(name); return position >= 0 ? args[position + 1] : undefined; };
const root = option('--project');
if (!root) { console.error('Usage: npm start -- --project /absolute/project [--port 4317] [--dev-origin http://127.0.0.1:5173]'); process.exit(1); }
const port = Number(option('--port') ?? 4317);
if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new Error('Choose a valid local port.');
const webRoot = resolve(fileURLToPath(new URL('../../web', import.meta.url)));
const running = await startServer({ root, port, webRoot, allowedOrigins: option('--dev-origin') ? [option('--dev-origin')!] : [] });
console.log(`acanvas: ${running.url}`);
console.log(`Project: ${running.service.project.root}`);
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => void running.close().then(() => process.exit(0)));
