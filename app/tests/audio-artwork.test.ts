import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fromFile } from 'strtok3';
import { AudioArtworkReader, extractAudioArtwork, limitMetadataReads } from '../src/server/audio-artwork.js';
import { ApiFailure } from '../src/server/service.js';
import { startServer } from '../src/server/http.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
function uncoveredWav() {
  const bytes = Buffer.alloc(44 + 88200); bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(44100, 24); bytes.writeUInt32LE(88200, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(88200, 40); return bytes;
}
const syncSafe = (size: number) => Buffer.from([(size >>> 21) & 127, (size >>> 14) & 127, (size >>> 7) & 127, size & 127]);
function apicMp3() {
  const picture = Buffer.concat([Buffer.from([0]), Buffer.from('image/png\0'), Buffer.from([3, 0]), png]);
  const frame = Buffer.alloc(10); frame.write('APIC'); frame.writeUInt32BE(picture.length, 4);
  const tags = Buffer.concat([frame, picture]); return Buffer.concat([Buffer.from('ID3\x03\x00\x00', 'binary'), syncSafe(tags.length), tags, Buffer.from([255, 251, 144, 100]), Buffer.alloc(1024)]);
}
function atom(kind: string, body: Buffer) { const header = Buffer.alloc(8); header.writeUInt32BE(body.length + 8); header.write(kind, 4); return Buffer.concat([header, body]); }
function covrM4a() {
  const pictureType = Buffer.alloc(8); pictureType.writeUInt32BE(14);
  const metadata = atom('meta', Buffer.concat([Buffer.alloc(4), atom('ilst', atom('covr', atom('data', Buffer.concat([pictureType, png]))))]));
  return Buffer.concat([atom('ftyp', Buffer.from('M4A \0\0\0\0M4A mp42', 'binary')), atom('mdat', Buffer.alloc(9 * 1024 * 1024)), atom('moov', atom('udta', metadata))]);
}

test('APIC MP3 and covr at the end of a large M4A return original cover bytes', async t => {
  const root = await mkdtemp(join(tmpdir(), 'acanvas-artwork-')); t.after(() => rm(root, { recursive: true, force: true }));
  for (const [name, contents] of [['embedded.mp3', apicMp3()], ['tail-cover.m4a', covrM4a()]] as const) {
    const path = join(root, name); await writeFile(path, contents); const cover = await extractAudioArtwork(path);
    assert.equal(cover?.mime, 'image/png'); assert.deepEqual(cover?.bytes, png); assert.deepEqual(await readFile(path), contents);
  }
});

test('metadata read budget counts repeated reads and permits unread random seek gaps', async t => {
  const root = await mkdtemp(join(tmpdir(), 'acanvas-metadata-budget-')); const path = join(root, 'bytes.bin'); await writeFile(path, Buffer.alloc(1000));
  const tokenizer = limitMetadataReads(await fromFile(path), 16); t.after(async () => { await tokenizer.close(); await rm(root, { recursive: true, force: true }); });
  await tokenizer.readBuffer(new Uint8Array(8)); await tokenizer.peekBuffer(new Uint8Array(8), { position: 900 });
  await assert.rejects(() => tokenizer.readBuffer(new Uint8Array(1)), /read budget/);
  const allocation = limitMetadataReads(await fromFile(path), 4); t.after(() => allocation.close());
  await assert.rejects(() => allocation.readToken({ len: 100_000_000, get: () => 0 }), /read budget/);
});

test('artwork uses the original asset and authenticated raster endpoint with cached absence', async t => {
  const root = await mkdtemp(join(tmpdir(), 'acanvas-artwork-api-')), server = await startServer({ root, port: 0 });
  t.after(async () => { await server.close(); await rm(root, { recursive: true, force: true }); });
  const token = (await (await fetch(`${server.url}/api/bootstrap`)).json()).token, headers = { Authorization: `Bearer ${token}` };
  const upload = async (name: string, body: Buffer) => (await fetch(`${server.url}/api/assets?name=${name}`, { method: 'POST', headers, body: new Uint8Array(body) })).json();
  const asset = await upload('covered.mp3', apicMp3()), empty = await upload('uncovered.wav', uncoveredWav());
  assert.equal((await fetch(`${server.url}/api/assets/${asset.id}/artwork`)).status, 401);
  const head = await fetch(`${server.url}/api/assets/${asset.id}/artwork`, { method: 'HEAD', headers }); assert.equal(head.status, 200); assert.equal(head.headers.get('content-type'), 'image/png'); assert.equal(head.headers.get('content-length'), String(png.length));
  const response = await fetch(`${server.url}/api/assets/${asset.id}/artwork`, { headers }); assert.deepEqual(Buffer.from(await response.arrayBuffer()), png); assert.match(response.headers.get('content-security-policy') || '', /sandbox/);
  for (let count = 0; count < 2; count++) assert.equal((await fetch(`${server.url}/api/assets/${empty.id}/artwork`, { headers })).status, 204);
  assert.equal(server.service.assets().length, 2);
});

test('a transient artwork extraction failure is retried for the same asset identity', async () => {
  let calls = 0;
  const reader = new AudioArtworkReader(() => 'controlled-source', async () => { if (++calls === 1) throw new ApiFailure(503, 'artwork_busy', 'Temporarily unavailable.'); return { mime: 'image/png', bytes: png }; });
  const asset = { id: 'covered-source', name: 'covered.mp3', mime: 'audio/mpeg', size: 10, kind: 'file' as const, createdAt: '' };
  await assert.rejects(() => reader.get(asset), error => error instanceof ApiFailure && error.status === 503);
  assert.deepEqual((await reader.get(asset))?.bytes, png); assert.deepEqual((await reader.get(asset))?.bytes, png); assert.equal(calls, 2);
});
