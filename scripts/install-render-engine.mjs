import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const result = spawnSync(process.execPath, ['node_modules/playwright-core/cli.js', 'install', '--no-shell', 'chromium'], {
  stdio: 'inherit', env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: resolve('.runtime/browsers') },
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
