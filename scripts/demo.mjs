import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { startServer } from '../dist/src/server/http.js';

const run = promisify(execFile);
const root = await realpath(await mkdtemp(join(tmpdir(), 'acanvas-cli-demo-')));
let server;
const command = async (args) => {
  console.log(`acanvas ${args.join(' ')} --project <temporary-project> --url ${server.url}`);
  const { stdout } = await run(process.execPath, [resolve('scripts/runtime.mjs'), 'cli', ...args, '--project', root, '--url', server.url], { cwd: process.cwd() });
  return JSON.parse(stdout);
};
try {
  server = await startServer({ root, port: 0 });
  const session = await command(['session', 'create', '--name', 'CLI demonstration']);
  const sourceFile = join(root, 'reference.png');
  await writeFile(sourceFile, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aJ1QAAAAASUVORK5CYII=', 'base64'));
  const source = await command(['asset', 'import', '--file', sourceFile, '--mime', 'image/png']);
  const state = await command(['session', 'read', '--session', session.id]);
  const draftFile = join(root, 'draft.json');
  await writeFile(draftFile, JSON.stringify({ ...state.draft, text: '复制此参考图为新素材并放回白板。', attachments: [source.id] }));
  const saved = await command(['draft', 'save', '--session', session.id, '--input', draftFile]);
  const sent = await command(['draft', 'send', '--session', session.id, '--draft', state.draft.id, '--revision', String(saved.revision)]);
  const claim = await command(['task', 'next', '--session', session.id, '--consumer', 'demo-agent']);
  await command(['task', 'read', '--session', session.id, '--task', sent.task.id]);
  const downloaded = join(root, 'downloaded.png');
  await command(['asset', 'read', '--asset', source.id, '--out', downloaded]);
  const outputFile = join(root, 'copied-reference.png'); await writeFile(outputFile, await readFile(downloaded));
  const identity = ['--session', session.id, '--task', sent.task.id, '--run', claim.run.id, '--consumer', 'demo-agent'];
  const output = await command(['asset', 'import', '--file', outputFile, '--mime', 'image/png', ...identity]);
  await command(['task', 'progress', ...identity, '--message', '已保存独立参考图副本，文件字节已核对。']);
  const completionFile = join(root, 'complete.json');
  await writeFile(completionFile, JSON.stringify({ summary: '参考图已复制为独立素材并加入白板。', assetIds: [output.id], validation: ['PNG文件签名有效，副本与参考图字节一致。'], operations: [{ type: 'create', object: { assetId: output.id, x: 120, y: 120, width: 240, height: 240 } }] }));
  const completed = await command(['task', 'complete', ...identity, '--input', completionFile]);
  const empty = await command(['task', 'next', '--session', session.id, '--consumer', 'demo-agent']);
  const before = await command(['session', 'read', '--session', session.id]);
  if (completed.status !== 'completed' || empty.task !== null || before.objects.length !== 1 || !Buffer.from(await readFile(sourceFile)).equals(await readFile(outputFile))) throw new Error('The CLI demonstration did not deliver its expected result.');
  console.log(JSON.stringify({ result: 'PASS', sourceBytes: source.size, outputBytes: output.size, taskStatus: completed.status, objectCount: before.objects.length, receiptAssetCount: completed.receipt.assetIds.length, queue: 'idle', generation: 'local file copy; external providers remain unverified' }));
} finally { await server?.close(); await rm(root, { recursive: true, force: true }); }
