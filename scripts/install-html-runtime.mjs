import { createWriteStream } from 'node:fs';
import { mkdir, readFile, access, rename, rm } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const configuration = JSON.parse(await readFile('html-runtime.json', 'utf8')).native;
if (`${process.platform}-${process.arch}` !== configuration.platform) throw new Error(`HTML native runtime currently supports ${configuration.platform}.`);
const execute = (command, args) => { const result = spawnSync(command, args, { stdio: 'inherit' }); if (result.error) throw result.error; if (result.status !== 0) throw new Error(`${command} exited with ${result.status}.`); };
const destination = resolve(configuration.installDirectory), archive = resolve('.runtime/cef-macos-arm64.tar.bz2');
await mkdir(resolve('.runtime'), { recursive: true });
let installedVersion = '';
try { installedVersion = await readFile(resolve(destination, 'include/cef_version.h'), 'utf8'); } catch {}
if (!installedVersion.includes(configuration.cefVersion)) {
  const response = await fetch(configuration.distribution);
  if (!response.ok || !response.body) throw new Error(`CEF download failed (${response.status}).`);
  const temporary = `${archive}.download`;
  try { await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary, { mode: 0o600 })); await rename(temporary, archive); }
  catch (error) { await rm(temporary, { force: true }); throw error; }
  await mkdir(destination, { recursive: true });
  execute('tar', ['-xjf', archive, '-C', destination, '--strip-components', '1']);
}
await access(resolve(destination, 'include/cef_version.h'));
execute('cmake', ['-S', 'src/server/render-surface/native', '-B', configuration.buildDirectory, `-DCEF_ROOT=${destination}`, '-DCMAKE_BUILD_TYPE=Release', `-DPROJECT_ARCH=${configuration.architecture}`, '-DACANVAS_TEST_CLIPBOARD_TRIPWIRE=OFF', '-DACANVAS_TEST_CLIPBOARD_FAKE_HANDLE=OFF']);
execute('cmake', ['--build', configuration.buildDirectory, '--config', 'Release', '--target', 'acanvas-surface', '--parallel', '8']);
