import { defineConfig } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
export default defineConfig({ testDir: '.', testMatch: ['html-bundle.spec.ts', 'html-bundle-snapshot.spec.ts'], workers: 1, timeout: 45000, outputDir: mkdtempSync(join(tmpdir(), 'acanvas-bundle-browser-')), use: { ...(process.env.CHROMIUM_PATH ? { launchOptions: { executablePath: process.env.CHROMIUM_PATH } } : { channel: 'chrome' }), headless: true, viewport: { width: 1440, height: 1000 } }, reporter: [['list']] });
