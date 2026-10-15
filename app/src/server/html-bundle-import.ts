import { lstat, readdir, realpath } from 'node:fs/promises';
import type { BigIntStats } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { bundleLimits, bundleMime, validBundlePath } from '../shared/html-bundle.js';
import { within } from './service.js';

interface SourceIdentity { dev: bigint; ino: bigint; ctimeNs: bigint; mtimeNs: bigint }
interface BundleDirectory extends SourceIdentity { path: string }
const identity = (info: BigIntStats): SourceIdentity => ({ dev: info.dev, ino: info.ino, ctimeNs: info.ctimeNs, mtimeNs: info.mtimeNs });
export const sameBundleSource = (info: BigIntStats, expected: SourceIdentity) => info.dev === expected.dev && info.ino === expected.ino && info.ctimeNs === expected.ctimeNs && info.mtimeNs === expected.mtimeNs;
export const bundleChanged = () => new Error('The bundle changed while importing. Retry from a stable output directory.');
export async function verifyBundleDirectories(directories: BundleDirectory[]) {
  for (const directory of directories) {
    const info = await lstat(directory.path, { bigint: true });
    if (!info.isDirectory() || !sameBundleSource(info, directory)) throw bundleChanged();
  }
}

export async function collectHtmlBundle(requestedRoot: string, entry: string) {
  const root = await realpath(requestedRoot);
  if (!within(root, entry)) throw new Error('The HTML entry must be within --bundle-root.');
  const entryPath = relative(root, entry).split(sep).join('/');
  if (!validBundlePath(entryPath) || !/\.html?$/i.test(entryPath)) throw new Error('Choose a non-hidden HTML entry inside --bundle-root.');
  const files: ({ path: string; file: string; size: number; mime: string } & SourceIdentity)[] = [];
  const directories: BundleDirectory[] = [];
  let total = 0;
  const visit = async (directory: string, selected?: BigIntStats) => {
    await verifyBundleDirectories(directories);
    const info = await lstat(directory, { bigint: true });
    if (!info.isDirectory() || selected && !sameBundleSource(info, selected)) throw bundleChanged();
    if (directories.length >= bundleLimits.directories) throw new Error('HTML bundles support up to 128 directories.');
    directories.push({ path: directory, ...identity(info) });
    const names = await readdir(directory);
    // A restored directory still has a changed ctime; pinning just its inode
    // would let a rename/symlink/restore race seed outside file identities.
    await verifyBundleDirectories(directories);
    for (const name of names.sort()) {
      if (name.startsWith('.')) continue;
      const file = resolve(directory, name), path = relative(root, file).split(sep).join('/');
      const info = await lstat(file, { bigint: true });
      if (info.isSymbolicLink()) throw new Error(`Bundle symlinks are not supported: ${path}`);
      if (!validBundlePath(path)) throw new Error(`Unsupported bundle path: ${path}`);
      if (info.isDirectory()) { await visit(file, info); continue; }
      const mime = bundleMime(path), size = Number(info.size);
      if (!info.isFile() || !mime) throw new Error(`Unsupported bundle file: ${path}. Choose a directory containing only HTML, CSS, JavaScript, images and fonts.`);
      if (size > bundleLimits.fileBytes || (total += size) > bundleLimits.totalBytes || files.length >= bundleLimits.files) throw new Error('HTML bundles support up to 128 files, 10 MiB per file and 32 MiB total.');
      files.push({ path, file, size, ...identity(info), mime });
    }
    await verifyBundleDirectories(directories);
  };
  await visit(root);
  if (!files.some(file => file.path === entryPath)) throw new Error('The HTML entry must be a regular bundle file.');
  return { root, entryPath, files, directories };
}
