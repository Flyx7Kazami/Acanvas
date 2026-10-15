import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(new URL('./src/web/', import.meta.url));
export default defineConfig({
  plugins: [react()],
  root: source,
  build: { outDir: fileURLToPath(new URL('../dist/web/', import.meta.url)), emptyOutDir: true, rollupOptions: { input: { main: `${source}index.html`, audioReview: `${source}audio-review.html` } } },
  server: { host: '127.0.0.1', port: 5173, strictPort: true, proxy: { '/api': { target: 'http://127.0.0.1:4317', changeOrigin: true, ws: true } } },
});
