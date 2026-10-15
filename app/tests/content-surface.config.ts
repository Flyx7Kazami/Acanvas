import { defineConfig } from '@playwright/test';
export default defineConfig({ testDir: '.', testMatch: 'content-surface.spec.ts', workers: 1, timeout: 40000, use: { channel: 'chrome', headless: true, viewport: { width: 1280, height: 900 }, trace: 'retain-on-failure' }, reporter: [['list']] });
