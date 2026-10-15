import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { cleanNativeProfiles, nativeSurfaceExecutable } from '../src/server/render-surface/cef.js';

test('native profile scanning accepts recovered paths and preserves ownership and filesystem errors', async t => {
  const originals = { readdir: fs.readdir, lstat: fs.lstat, realpath: fs.realpath };
  for (const mode of ['readdir-disappear', 'realpath-disappear', 'lstat-EACCES', 'realpath-EACCES', 'lstat-EIO', 'replace-symlink', 'live-controller', 'live-browser', 'unknown-record', 'foreign-executable', 'inactive-owned']) await t.test(mode, async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'acanvas-profile-scan-')), profile = join(root, 'instance-Review'), outside = await fs.mkdtemp(join(tmpdir(), 'acanvas-profile-target-'));
    await fs.mkdir(profile, { mode: 0o700 });
    const record = mode === 'live-browser' ? { controllerPid: 999999999, browserPid: process.pid, executable: nativeSurfaceExecutable }
      : mode === 'foreign-executable' ? { controllerPid: 999999999, executable: '/private/foreign/acanvas-surface.app/Contents/MacOS/acanvas-surface' }
      : { controllerPid: mode === 'inactive-owned' ? 999999999 : process.pid, executable: nativeSurfaceExecutable };
    if (mode !== 'unknown-record') await fs.writeFile(join(profile, 'acanvas-instance.json'), JSON.stringify(record));
    let fired = false;
    if (mode === 'readdir-disappear' || mode === 'replace-symlink') (fs as any).readdir = async (path: string, ...args: any[]) => { const snapshot = await (originals.readdir as any)(path, ...args); if (String(path) === root && !fired) { fired = true; await fs.rm(profile, { recursive: true, force: true }); if (mode === 'replace-symlink') await fs.symlink(outside, profile); } return snapshot; };
    if (mode === 'realpath-disappear') (fs as any).lstat = async (path: string, ...args: any[]) => { const value = await (originals.lstat as any)(path, ...args); if (String(path) === profile && !fired) { fired = true; await fs.rm(profile, { recursive: true, force: true }); } return value; };
    if (mode.startsWith('lstat-') || mode === 'realpath-EACCES') {
      const operation = mode.startsWith('lstat-') ? 'lstat' : 'realpath', code = mode.endsWith('EIO') ? 'EIO' : 'EACCES';
      (fs as any)[operation] = async (path: string, ...args: any[]) => { if (String(path) === profile) throw Object.assign(new Error('Owned simulated filesystem error.'), { code }); return (originals[operation] as any)(path, ...args); };
    }
    syncBuiltinESMExports();
    try {
      if (mode.includes('EACCES') || mode.includes('EIO')) await assert.rejects(cleanNativeProfiles(root), { code: mode.endsWith('EIO') ? 'EIO' : 'EACCES' }); else await cleanNativeProfiles(root);
      if (['live-controller', 'live-browser', 'unknown-record', 'foreign-executable'].includes(mode)) assert((await originals.lstat(profile)).isDirectory());
      if (mode === 'replace-symlink') { assert((await originals.lstat(profile)).isSymbolicLink()); assert((await originals.lstat(outside)).isDirectory()); }
      if (mode === 'inactive-owned') await assert.rejects(originals.lstat(profile), { code: 'ENOENT' });
    } finally { Object.assign(fs, originals); syncBuiltinESMExports(); await fs.rm(root, { recursive: true, force: true }); await fs.rm(outside, { recursive: true, force: true }); }
  });
});
