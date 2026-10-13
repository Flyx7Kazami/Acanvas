// Reproduce only the three persistent UI assertions on the unchanged Git HEAD.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, realpath, readFile, writeFile, symlink } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const evidence = dirname(fileURLToPath(import.meta.url));
const repository = resolve(evidence, '../../../..');
const temporaryRoot = await realpath(tmpdir());
const baseline = await realpath(await mkdtemp(join(temporaryRoot, 'acanvas-runtime-baseline-ui-')));
const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim();
const inputs = ['src', 'tests', 'scripts', 'skill', 'package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.server.json', 'vite.config.ts'];
const archive = execFileSync('git', ['archive', '--format=tar', head, ...inputs], { cwd: repository, maxBuffer: 64 * 1024 * 1024 });
const extracted = spawnSync('/usr/bin/tar', ['-xf', '-', '-C', baseline], { input: archive, encoding: 'utf8' });
if (extracted.error || extracted.status !== 0) throw new Error('Owned HEAD baseline extraction failed.');
await writeFile(join(baseline, 'BASELINE-OWNERSHIP.json'), JSON.stringify({ kind: 'acanvas-owned-head-ui-baseline', repository, head, baseline, inputs, createdAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
for (const dependency of ['node_modules', '.runtime']) await symlink(join(repository, dependency), join(baseline, dependency));
const node = join(baseline, '.runtime/node_modules/node/bin/node');
const environment = { ...process.env, TMPDIR: temporaryRoot, PATH: `${join(baseline, '.runtime/node_modules/node/bin')}:${process.env.PATH ?? ''}` };
delete environment.CODEX_THREAD_ID;
const pattern = 'visible Canvas evidence excludes|annotation focus follows|reselecting one object';
const record = { baseline, head, nodeVersion: execFileSync(node, ['--version'], { encoding: 'utf8' }).trim(), archiveSha256: createHash('sha256').update(archive).digest('hex'), canonicalTemporaryRoot: temporaryRoot, changedGlobalEnvironment: false, sourceTests: [], commands: [], scratchPreserved: true };
for (const path of ['tests/chatbox-ui.test.ts', 'tests/reference-occurrences-ui.test.ts']) record.sourceTests.push({ path, sha256: createHash('sha256').update(await readFile(join(baseline, path))).digest('hex') });
for (const args of [['scripts/runtime.mjs', 'build'], ['--test', '--test-concurrency=1', '--test-name-pattern', pattern, 'dist/tests/chatbox-ui.test.js', 'dist/tests/reference-occurrences-ui.test.js']]) {
  const result = spawnSync(node, args, { cwd: baseline, env: environment, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
  process.stdout.write(result.stdout ?? ''); process.stderr.write(result.stderr ?? '');
  record.commands.push({ argv: [node, ...args], cwd: baseline, exitCode: result.status, error: result.error?.message });
  if (result.error || args[0] === 'scripts/runtime.mjs' && result.status !== 0) break;
}
record.result = record.commands.length === 2 && record.commands[1].exitCode === 1 ? 'PERSISTENT-UI-FAILURES-ALSO-ON-HEAD' : record.commands[1]?.exitCode === 0 ? 'HEAD-PASS' : 'BASELINE-BUILD-FAIL';
await writeFile(join(evidence, 'baseline-ui-result.json'), `${JSON.stringify(record, null, 2)}\n`);
console.log(JSON.stringify({ baseline, head, result: record.result, commands: record.commands }));
