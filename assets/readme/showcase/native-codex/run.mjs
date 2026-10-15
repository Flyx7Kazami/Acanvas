import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { prepare } from './prepare.mjs';
const args = process.argv.slice(2);
const option = key => { const index = args.indexOf(key); return index < 0 ? undefined : args[index + 1]; };
const canvasUrl = option('--canvas-url');
if (!canvasUrl)
    throw Error('Pass --canvas-url for the dedicated synthetic Acanvas example.');
const { workspace, source } = prepare({ canvasUrl, previewOrigin: option('--preview-origin'), appBundle: option('--codex-app') });
const runtime = path.join(workspace, 'runtime');
fs.mkdirSync(runtime);
fs.copyFileSync(path.join(workspace, 'runtime-package.json'), path.join(runtime, 'package.json'));
async function complete(command, parameters, options = {}) {
    const child = spawn(command, parameters, { stdio: 'inherit', ...options });
    await new Promise((resolve, reject) => child.once('exit', code => code === 0 ? resolve() : reject(Error(`${command} exited ${code}`))));
}
console.log(`Installed renderer ${source.version}; temporary workspace ${workspace}`);
await complete('npm', ['install', '--prefix', runtime, '--no-audit', '--no-fund']);
const environment = { ...process.env, SHOWCASE_WORKSPACE: workspace, SHOWCASE_CANVAS_URL: canvasUrl, SHOWCASE_PREVIEW_ORIGIN: option('--preview-origin') ?? '' };
const server = spawn(process.execPath, [path.join(workspace, 'serve.cjs')], { env: environment, stdio: ['ignore', 'pipe', 'inherit'] });
const rendererUrl = await new Promise((resolve, reject) => {
    server.stdout.once('data', data => resolve(data.toString().trim()));
    server.once('error', reject);
    server.once('exit', code => reject(Error(`Renderer server exited ${code}`)));
});
console.log(`Renderer ${rendererUrl}; native window Slow Signal — Acanvas Showcase`);
const electron = spawn(path.join(runtime, 'node_modules/.bin/electron'), [path.join(workspace, 'electron-main.cjs')], {
    env: { ...environment, SHOWCASE_RENDERER_URL: rendererUrl }, stdio: 'inherit',
});
const stop = () => { electron.kill('SIGTERM'); server.kill('SIGTERM'); };
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
electron.once('exit', () => { server.kill('SIGTERM'); });
