// Normal cleanup for the one explicitly owned pre-Send relay-startup failure.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const evidence = dirname(fileURLToPath(import.meta.url));
const log = await readFile(join(evidence, 'actual-ui-model.log'), 'utf8');
const events = log.split('\n').filter(line => line.startsWith('{"kind"')).map(line => JSON.parse(line));
const started = events.find(event => event.kind === 'owned_original_thread_started');
const opened = events.find(event => event.kind === 'harness_cli' && event.argv.includes('open'));
assert(started && opened); assert(!events.some(event => event.kind === 'actual_ui_send_persisted'));
const project = opened.result.project.root, scratch = dirname(project);
const ownership = JSON.parse(await readFile(join(scratch, 'OWNERSHIP.json'), 'utf8'));
assert.equal(ownership.kind, 'acanvas-owned-ui-runtime-integration'); assert(project.startsWith(scratch));
const candidate = ownership.candidate, node = join(candidate, '.runtime/node_modules/node/bin/node');
const argv = [join(candidate, 'scripts/runtime.mjs'), 'cli', 'project', 'stop', '--project', project, '--url', new URL(opened.result.openUrl).origin];
const stopped = spawnSync(node, argv, { cwd: candidate, encoding: 'utf8' });
assert.equal(stopped.status, 0); const result = JSON.parse(stopped.stdout); assert.equal(result.status, 'stopped');
let ownerCommand, ownerStopped;
try {
  ownerCommand = execFileSync('/bin/ps', ['-p', String(started.ownerPid), '-o', 'command='], { encoding: 'utf8' }).trim();
  assert(ownerCommand.includes('/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex'));
  assert(ownerCommand.includes(`--listen unix://${join(scratch, 'owner.sock')}`));
  process.kill(started.ownerPid, 'SIGTERM');
  for (let index = 0; index < 50; index++) { try { process.kill(started.ownerPid, 0); await new Promise(resolve => setTimeout(resolve, 100)); } catch (error) { assert.equal(error.code, 'ESRCH'); ownerStopped = true; break; } }
} catch (error) { if (error.status === 1) ownerStopped = true; else throw error; }
const record = { result: 'PRE-SEND-HARNESS-STARTUP-FAILURE-CLEANED', cause: 'macOS Unix socket pathname length exceeded; WebSocketServer error was unhandled.', taskSendAttempted: false, productAttached: false, originalModelCliAttempted: false, scratch, ownerPid: started.ownerPid, threadId: started.threadId, completedReadyOnly: true, serviceStopped: result.status === 'stopped', originalOwnedOwnerStopped: !!ownerStopped, ownerCommand, candidate, scratchPreserved: true, noUserResourceTouched: true, completedAt: new Date().toISOString() };
await writeFile(join(evidence, 'startup-failure.json'), `${JSON.stringify(record, null, 2)}\n`);
await rename(join(evidence, 'actual-ui-model.log'), join(evidence, 'actual-ui-model-bootstrap-failure.log'));
console.log(JSON.stringify(record));
