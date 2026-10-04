import { defineConfig } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export default defineConfig({
  testDir: '.',
  testMatch: ['frontend.spec.ts', 'import-binding.spec.ts', 'annotation-system.spec.ts', 'multimodal.spec.ts'],
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  outputDir: mkdtempSync(join(tmpdir(), 'acanvas-browser-')),
  use: { channel: 'chrome', headless: true, viewport: { width: 1440, height: 1000 }, trace: 'retain-on-failure' },
  reporter: [['list']],
});
