import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, symlink, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// Copy only repository inputs. Running project scripts in the original checkout writes its served dist.
const directories = ['app', 'scripts', 'references', 'assets', 'agents'];
const files = ['package.json', 'package-lock.json', 'SKILL.md', 'LICENSE'];
const source = await realpath(fileURLToPath(new URL('..', import.meta.url)));
let selectedOutput, prepareOnly = false;
const selectedTests = [];
for (let index = 2; index < process.argv.length; index++) {
  const option = process.argv[index];
  if (option === '--prepare-only') prepareOnly = true;
  else if (option === '--output' && process.argv[index + 1]) selectedOutput = process.argv[++index];
  else if (option === '--test' && process.argv[index + 1]) selectedTests.push(process.argv[++index]);
  else throw new Error('Use [--output /absolute/new/temp/directory] [--prepare-only] [--test name.test.js]. With no test selection, the default test suite runs.');
}
if (prepareOnly && selectedTests.length) throw new Error('--prepare-only cannot be combined with --test.');
for (const name of selectedTests) if (!/^[A-Za-z0-9._-]+\.test\.js$/.test(name)) throw new Error('--test selects a compiled test filename inside dist/tests.');
const within = (base, target) => { const path = relative(base, target); return path === '' || path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path); };
const temporaryRoots = [await realpath(tmpdir()), await realpath('/tmp')];
let output;
if (selectedOutput) {
  if (!isAbsolute(selectedOutput)) throw new Error('--output must name a new absolute directory in the system temporary area.');
  const parent = await realpath(dirname(selectedOutput));
  if (!temporaryRoots.some(root => within(root, parent))) throw new Error('--output must stay in the system temporary area.');
  output = join(parent, selectedOutput.slice(dirname(selectedOutput).length + 1));
  await mkdir(output, { mode: 0o700 }); // Existing paths, including empty directories or links, are never reused.
} else output = await mkdtemp(join(await realpath(tmpdir()), 'acanvas-host-delivery-build-'));
await chmod(output, 0o700);
const ownership = { kind: 'acanvas-host-delivery-candidate', version: 1, owner: randomUUID(), source, output, createdAt: new Date().toISOString() };
await writeFile(join(output, 'candidate-owner.json'), `${JSON.stringify(ownership, null, 2)}\n`, { flag: 'wx', mode: 0o444 });
const manifest = [];
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
async function copyInput(path, optional = false) {
  const origin = join(source, path), target = join(output, path);
  let info;
  try { info = await lstat(origin); } catch (error) { if (optional && error.code === 'ENOENT') return; throw error; }
  if (info.isSymbolicLink()) throw new Error(`Candidate inputs cannot contain symbolic links: ${path}`);
  if (info.isDirectory()) {
    await mkdir(target, { mode: 0o700 });
    for (const name of (await readdir(origin)).sort()) {
      if (name.startsWith('.')) continue;
      await copyInput(join(path, name));
    }
  } else if (info.isFile()) {
    const bytes = await readFile(origin);
    await writeFile(target, bytes, { flag: 'wx', mode: 0o444 });
    manifest.push({ path, bytes: bytes.length, sha256: sha256(bytes) });
  } else throw new Error(`Candidate inputs must be regular files or directories: ${path}`);
}
for (const path of directories) await copyInput(path, path === 'agents');
for (const path of files) await copyInput(path, path === 'LICENSE');
// Refuse a mixed snapshot if another execution changed an input while it was being copied.
for (const entry of manifest) if (sha256(await readFile(join(source, entry.path))) !== entry.sha256) throw new Error(`Source changed while preparing the candidate: ${entry.path}. The owned candidate is retained for inspection.`);
await writeFile(join(output, 'source-manifest.json'), `${JSON.stringify({ owner: ownership.owner, files: manifest }, null, 2)}\n`, { flag: 'wx', mode: 0o444 });
for (const dependency of ['node_modules', '.runtime']) {
  const target = join(source, dependency);
  if (!(await lstat(target)).isDirectory()) throw new Error(`The project ${dependency} directory must already be installed.`);
  await symlink(target, join(output, dependency));
}
const node = join(output, '.runtime/node_modules/node/bin/node');
const version = spawnSync(node, ['--version'], { encoding: 'utf8' });
if (version.error || version.status !== 0 || !version.stdout.trim().startsWith('v24.')) throw new Error('The existing project runtime must provide Node 24. No runtime is installed or changed by this helper.');
console.log(JSON.stringify({ candidate: output, ownership: join(output, 'candidate-owner.json'), manifest: join(output, 'source-manifest.json'), node: version.stdout.trim(), prepareOnly }));
const candidateEnvironment = { ...process.env, TMPDIR: temporaryRoots[0], PATH: `${join(output, '.runtime/node_modules/node/bin')}:${process.env.PATH ?? ''}` };
delete candidateEnvironment.CODEX_THREAD_ID;
const execute = args => {
  const result = spawnSync(node, args, { cwd: output, stdio: 'inherit', env: candidateEnvironment });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Candidate command failed (${result.status ?? 'signal'}). The owned candidate is retained at ${output}.`);
};
if (!prepareOnly) {
  execute(['scripts/runtime.mjs', 'build']); // Server and web type checks, then the private production build.
  const tests = selectedTests.length ? selectedTests : (await readdir(join(output, 'dist/tests'))).filter(name => name.endsWith('.test.js')).sort();
  execute(['--test', '--test-concurrency=1', ...tests.map(name => join('dist/tests', name))]);
  const builtFiles = [];
  async function recordBuild(path) {
    const target = join(output, path), info = await lstat(target);
    if (info.isDirectory()) for (const name of (await readdir(target)).sort()) await recordBuild(join(path, name));
    else if (info.isFile()) { const bytes = await readFile(target); builtFiles.push({ path, bytes: bytes.length, sha256: sha256(bytes) }); }
    else throw new Error(`Unexpected build output: ${path}`);
  }
  await recordBuild('dist');
  await writeFile(join(output, 'build-manifest.json'), `${JSON.stringify({ owner: ownership.owner, sourceManifest: 'source-manifest.json', files: builtFiles }, null, 2)}\n`, { flag: 'wx', mode: 0o444 });
  console.log(JSON.stringify({ candidate: output, status: 'built-and-tested', tests, buildManifest: join(output, 'build-manifest.json') }));
}
