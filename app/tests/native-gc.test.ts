import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('an open SQLite service survives allocation-driven GC during repeated business reads', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'acanvas-native-gc-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const serviceModule = new URL('../src/server/service.js', import.meta.url).href;
  const code = `
    import { CanvasService } from ${JSON.stringify(serviceModule)};
    import { setImmediate } from 'node:timers/promises';
    const service = new CanvasService(${JSON.stringify(root)});
    const session = service.createSession('Temporary GC validation');
    let garbage = [];
    try {
      for (let index = 0; index < 6000; index++) {
        const state = service.state(session.id);
        if (state.session.id !== session.id) throw new Error('The service returned a different task scope.');
        garbage.push(Array.from({ length: 128 }, (_, item) => ({ index, item, value: 'temporary allocation ' + index + ' ' + item })));
        if (garbage.length > 64) garbage = [];
        if (index % 100 === 0) await setImmediate();
      }
      console.log('6000 business reads completed');
    } finally { service.close(); }
  `;
  const { stdout, stderr } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', code], { timeout: 20_000, maxBuffer: 128 * 1024 });
  assert.equal(stdout.trim(), '6000 business reads completed');
  assert.equal(stderr, '');
});
