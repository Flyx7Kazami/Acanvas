#!/usr/bin/env node
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

export const installation = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const runtimeNode = join(installation, '.runtime/node_modules/node/bin/node');
const cache = join(installation, '.npm-cache');
const runtimeDirectory = join(installation, '.runtime');
const environment = () => ({ ...process.env, PATH: `${dirname(runtimeNode)}:${process.env.PATH ?? ''}`, npm_config_cache: cache });
const execute = (command, args, env = environment()) => {
  const result = spawnSync(command, args, { cwd: installation, env, stdio: ['inherit', process.stderr, process.stderr] });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with ${result.status ?? 'a signal'}. Run node scripts/setup.mjs to retry setup in ${installation}.`);
};
const hasNode24 = () => existsSync(runtimeNode) && spawnSync(runtimeNode, ['--version'], { encoding: 'utf8' }).stdout?.trim().startsWith('v24.');
const hasDependencies = () => {
  if (!['typescript/bin/tsc', 'vite/bin/vite.js', 'better-sqlite3/package.json'].every(path => existsSync(join(installation, 'node_modules', path)))) return false;
  const dependencies = spawnSync('npm', ['ls', '--depth=0', '--include=dev'], { cwd: installation, env: environment(), stdio: 'ignore' });
  if (dependencies.status !== 0) return false;
  return spawnSync(runtimeNode, ['--input-type=module', '-e', "import Database from 'better-sqlite3'; const database = new Database(':memory:'); database.close();"], { cwd: installation, env: environment(), stdio: 'ignore' }).status === 0;
};
const hasBuild = () => ['dist/src/cli.js', 'dist/src/server/main.js', 'dist/web/index.html'].every(path => existsSync(join(installation, path)));

/** Prepare only this Skill installation; npm and its lifecycle scripts retain the host's permissions. */
export function setup({ rebuild = false } = {}) {
  mkdirSync(cache, { recursive: true });
  if (!hasNode24()) {
    mkdirSync(runtimeDirectory, { recursive: true });
    console.error('Acanvas: installing Node 24 in the Skill directory.');
    execute('npm', ['install', '--prefix', runtimeDirectory, '--no-save', '--package-lock=false', '--cache', cache, 'node@24'], { ...process.env, npm_config_cache: cache });
    if (!hasNode24()) throw new Error(`Node 24 setup did not produce ${runtimeNode}. Run node scripts/setup.mjs to retry.`);
  }
  let installed = false;
  if (!hasDependencies()) {
    console.error('Acanvas: installing declared dependencies in the Skill directory.');
    execute('npm', ['ci', '--include=dev', '--cache', cache]);
    installed = true;
  }
  if (rebuild || installed || !hasBuild()) {
    console.error('Acanvas: building the local application.');
    execute(runtimeNode, [join(installation, 'scripts/runtime.mjs'), 'build']);
  }
  return runtimeNode;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { setup({ rebuild: process.argv.includes('--rebuild') }); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
