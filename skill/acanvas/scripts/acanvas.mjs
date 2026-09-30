#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const installation = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const result = spawnSync(process.execPath, [resolve(installation, 'scripts/runtime.mjs'), 'cli', ...process.argv.slice(2)], { cwd: installation, stdio: 'inherit' });
if (result.error) { console.error(result.error.message); process.exit(1); }
process.exit(result.status ?? 1);
