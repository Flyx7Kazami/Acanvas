import { existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const local = resolve('.runtime/node_modules/node/bin/node');
const node = existsSync(local) ? local : process.execPath;
const version = spawnSync(node, ['--version'], { encoding: 'utf8' }).stdout?.trim();
if (!version?.startsWith('v24.')) {
  console.error('acanvas requires Node 24. Install the project runtime with: npm install --prefix .runtime --no-save --package-lock=false node@24');
  process.exit(1);
}
const execute = (args) => {
  const result = spawnSync(node, args, { stdio: 'inherit', env: { ...process.env, PATH: `${resolve('.runtime/node_modules/node/bin')}:${process.env.PATH}` } });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
};
const tsc = ['node_modules/typescript/bin/tsc'];
const command = process.argv[2];
const rest = process.argv.slice(3);
if (['build', 'build-server', 'test', 'typecheck'].includes(command)) execute([...tsc, '-p', 'tsconfig.server.json']);
if (['build', 'typecheck'].includes(command)) execute([...tsc, '-p', 'tsconfig.json']);
if (command === 'build') execute(['node_modules/vite/bin/vite.js', 'build']);
else if (command === 'test') execute(['--test', ...readdirSync('dist/tests').filter((name) => name.endsWith('.test.js')).map((name) => `dist/tests/${name}`)]);
else if (command === 'start') execute(['dist/src/server/main.js', ...rest]);
else if (command === 'cli') execute(['dist/src/cli.js', ...rest]);
else if (command === 'dev') execute(['node_modules/vite/bin/vite.js', ...rest]);
else if (command === 'demo') execute(['scripts/demo.mjs', ...rest]);
else if (command === 'test-browser') execute(['node_modules/@playwright/test/cli.js', 'test', '--config', 'tests/frontend.config.ts', ...rest]);
else if (!['build', 'build-server', 'typecheck'].includes(command)) throw new Error(`Unknown runtime command: ${command}`);
