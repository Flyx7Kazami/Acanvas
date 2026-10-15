#!/usr/bin/env node
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { installation, setup } from './setup.mjs';

try {
  const node = setup();
  const result = spawnSync(node, [join(installation, 'dist/src/cli.js'), ...process.argv.slice(2)], { cwd: installation, stdio: 'inherit' });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
