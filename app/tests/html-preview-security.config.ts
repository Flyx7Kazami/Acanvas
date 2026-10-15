import { defineConfig } from '@playwright/test';
import base from './frontend.config.js';
export default defineConfig({ ...base, testMatch: ['html-preview-security.spec.ts'], timeout: 30_000, projects: [
  { name: 'html-boundaries', grepInvert: /external Stop/, use: { trace: 'retain-on-failure' } },
  { name: 'html-loop', grep: /external Stop/, use: { trace: 'off' } },
] });
