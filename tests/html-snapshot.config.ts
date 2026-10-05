import { defineConfig } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
export default defineConfig({ testDir: '.', testMatch: 'html-snapshot.spec.ts', workers: 1, timeout: 20000, outputDir: mkdtempSync(join(tmpdir(), 'acanvas-snapshot-browser-')), use: { ...(process.env.CHROMIUM_PATH ? { launchOptions: { executablePath: process.env.CHROMIUM_PATH } } : { channel: 'chrome' }), headless: true }, reporter: [['list']] });
