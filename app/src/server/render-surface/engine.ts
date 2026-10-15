import { createRequire } from 'node:module';
import { access, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { chromium, type Browser } from 'playwright-core';

const require = createRequire(import.meta.url);
const driverDirectory = dirname(require.resolve('playwright-core/package.json'));

/** Uses the Chromium revision declared by the installed project driver. */
export async function renderEngineInfo(directory?: string) {
  const manifest = JSON.parse(await readFile(join(driverDirectory, 'browsers.json'), 'utf8'));
  const engine = manifest.browsers.find((entry: { name: string }) => entry.name === 'chromium');
  const executable = process.platform === 'darwin' ? ['chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium']
    : process.platform === 'linux' ? ['chrome-linux', 'chrome'] : process.platform === 'win32' ? ['chrome-win', 'chrome.exe'] : undefined;
  if (!executable) throw new Error(`render_engine_platform:${process.platform}`);
  const root = resolve(directory ?? join(driverDirectory, '..', '..', '.runtime', 'browsers'));
  const executablePath = join(root, `chromium-${engine.revision}`, ...executable);
  return { name: 'chromium' as const, revision: String(engine.revision), browserVersion: String(engine.browserVersion), executablePath, directory: root, headless: true as const, audioOutput: 'unsupported' as const };
}

export async function launchRenderEngine(directory?: string): Promise<Browser> {
  const engine = await renderEngineInfo(directory);
  await access(engine.executablePath).catch(() => { throw new Error('render_engine_missing:Run npm run install:render-engine in the Acanvas application directory.'); });
  return chromium.launch({ executablePath: engine.executablePath, headless: true, chromiumSandbox: true, timeout: 15_000 });
}
