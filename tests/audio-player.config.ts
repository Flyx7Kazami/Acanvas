import { defineConfig } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
export default defineConfig({ testDir: '.', testMatch: 'audio-player.spec.ts', workers: 1, timeout: 40_000, outputDir: mkdtempSync(join(tmpdir(), 'acanvas-audio-browser-')), use: { channel: 'chrome', headless: true, viewport: { width: 800, height: 600 }, trace: 'retain-on-failure' }, reporter: [['list']] });
