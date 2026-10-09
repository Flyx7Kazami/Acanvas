import { createServer } from 'vite';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';

const output = resolve(process.env.ACANVAS_SCENE_IAB_OUTPUT);
await mkdir(output, { recursive: true });
const server = await createServer({ configFile: false, root: process.cwd(), logLevel: 'error', server: { host: '127.0.0.1', port: 0, watch: null },
  plugins: [{ name: 'isolated-scene-lab-evidence', configureServer(vite) {
    vite.middlewares.use(async (request, response, next) => {
      const filename = request.url === '/scene-lab-evidence/frame100.png' ? 'frame100.png' : request.url === '/scene-lab-evidence/result.json' ? 'result.json' : undefined;
      if (!filename || request.method !== 'POST') return next();
      try {
        const chunks = []; let bytes = 0;
        for await (const chunk of request) { bytes += chunk.length; if (bytes > 20 * 1024 * 1024) throw new Error('Fixture evidence exceeds its image limit.'); chunks.push(chunk); }
        await writeFile(join(output, filename), Buffer.concat(chunks)); response.statusCode = 200; response.end('saved');
      } catch (error) { response.statusCode = 400; response.end(error.message); }
    });
  } }],
});
await server.listen();
console.log(JSON.stringify({ url: `${server.resolvedUrls.local[0]}tests/fixtures/universal-scene/index.html?iab=1`, output, isolated: true }));
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await server.close(); process.exit(0); });
