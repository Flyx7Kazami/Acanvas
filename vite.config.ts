import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  plugins: [react()],
  root: 'src/web',
  build: { outDir: '../../dist/web', emptyOutDir: true, rollupOptions: { input: { main: resolve('src/web/index.html'), audioReview: resolve('src/web/audio-review.html') } } },
  server: { host: '127.0.0.1', port: 5173, strictPort: true, proxy: { '/api': { target: 'http://127.0.0.1:4317', changeOrigin: true } } },
});
