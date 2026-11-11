import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { crc32, safeZipName, ZipWriter, readZip } from '../../src/zip.js';

const bytes = (text) => new TextEncoder().encode(text);

test('crc32 matches the published check value', () => {
  assert.equal(crc32(bytes('123456789')), 0xcbf43926);
  assert.equal(crc32(new Uint8Array(0)), 0);
});

test('safeZipName keeps folders and removes anything that could escape or break', () => {
  assert.equal(safeZipName('photos/P01_A1.jpg'), 'photos/P01_A1.jpg');
  assert.equal(safeZipName('../../etc/passwd'), 'etc/passwd');
  assert.equal(safeZipName('/abs/path.txt'), 'abs/path.txt');
  assert.equal(safeZipName('a\\b\\c.txt'), 'a/b/c.txt');
  assert.equal(safeZipName('bad:name?.txt'), 'bad_name_.txt');
  assert.equal(safeZipName('photo\u202egpj.exe'), 'photogpj.exe', 'characters that turn text around are removed');
  assert.equal(safeZipName('a\u200bb\ufeff.txt'), 'ab.txt');
  assert.equal(safeZipName('half\ud800.txt'), 'half_.txt');
  const cutAtFolder = safeZipName('x'.repeat(199) + '/y');
  assert.ok(cutAtFolder.length <= 200 && !cutAtFolder.endsWith('/'), 'a cut never leaves a folder mark at the end');
  const cutAtDot = safeZipName('p/' + 'x'.repeat(197) + '.jpg');
  assert.ok(!/[.\s/]$/.test(cutAtDot));
  const cutEmoji = safeZipName('\u{1F600}'.repeat(150));
  assert.ok(cutEmoji.length <= 200 && !/[\ud800-\udbff]$/.test(cutEmoji), 'a cut never splits a character');
  assert.equal(safeZipName('trailing. /x .'), 'trailing/x');
  assert.equal(safeZipName(''), 'file');
  assert.equal(safeZipName('./.'), 'file');
  assert.equal(safeZipName(null), 'file');
  assert.ok(safeZipName('x'.repeat(500)).length <= 200);
});

test('a written file reads back the same, including odd names and an empty file', async () => {
  const zip = new ZipWriter();
  const big = new Uint8Array(70000).map((_, i) => (i * 31) % 251);
  assert.equal(zip.add('backup.json', '{"ok":true}'), 'backup.json');
  assert.equal(zip.add('photos/Île à vélo.jpg', big), 'photos/Île à vélo.jpg');
  assert.equal(zip.add('empty.txt', ''), 'empty.txt');
  assert.equal(zip.add('buffer.bin', big.buffer.slice(0, 10)), 'buffer.bin');
  const blob = zip.finish();
  assert.equal(blob.type, 'application/zip');
  const read = await readZip(blob);
  assert.deepEqual(read.names, ['backup.json', 'photos/Île à vélo.jpg', 'empty.txt', 'buffer.bin']);
  assert.equal(await read.text('backup.json'), '{"ok":true}');
  assert.deepEqual(await read.bytes('photos/Île à vélo.jpg'), big);
  assert.equal((await read.bytes('empty.txt')).length, 0);
  assert.equal((await read.bytes('buffer.bin')).length, 10);
  assert.ok(read.has('empty.txt') && !read.has('nope.txt'));
  await assert.rejects(read.bytes('nope.txt'), /is not in the file/);
});

test('a repeated name gets a number instead of overwriting', () => {
  const zip = new ZipWriter();
  assert.equal(zip.add('photos/P01_1.jpg', 'a'), 'photos/P01_1.jpg');
  assert.equal(zip.add('photos/P01_1.jpg', 'b'), 'photos/P01_1 (2).jpg');
  assert.equal(zip.add('photos/p01_1.JPG', 'c'), 'photos/p01_1 (3).JPG', 'names that differ only by case would clash on Windows');
  assert.equal(zip.add('noext', 'd'), 'noext');
  assert.equal(zip.add('noext', 'e'), 'noext (2)');
});

test('the writer refuses things it cannot store', () => {
  const zip = new ZipWriter();
  assert.throws(() => zip.add('x', 12345), /text or bytes/);
});

test('a damaged file is noticed, and the other files still read', async () => {
  const zip = new ZipWriter();
  zip.add('good.txt', 'still fine');
  zip.add('bad.txt', 'this will be damaged');
  const data = new Uint8Array(await zip.finish().arrayBuffer());
  const at = data.length - 22 - 2 * 46 - 'good.txt'.length - 'bad.txt'.length - 3; // inside bad.txt's data
  data[at] ^= 0xff;
  const read = await readZip(new Blob([data]));
  assert.equal(await read.text('good.txt'), 'still fine');
  await assert.rejects(read.bytes('bad.txt'), /"bad.txt" is damaged/);
});

test('things that are not ZIP files are refused politely', async () => {
  await assert.rejects(readZip(new Blob(['hello'])), /not a ZIP file/);
  await assert.rejects(readZip(new Blob([new Uint8Array(100)])), /not a ZIP file/);
  await assert.rejects(readZip(null), /not a ZIP file/);
  const cut = new Uint8Array(await new ZipWriter().finish().arrayBuffer());
  const empty = await readZip(new Blob([cut]));
  assert.deepEqual(empty.names, []);
});

// Builds a one-file ZIP with real compression, the way a desktop ZIP program would.
function deflatedZip(name, content, options = {}) {
  const raw = bytes(content);
  const packed = deflateRawSync(raw);
  const nameBytes = bytes(name);
  const local = new DataView(new ArrayBuffer(30));
  local.setUint32(0, 0x04034b50, true);
  local.setUint16(4, 20, true);
  local.setUint16(6, options.flags || 0, true);
  local.setUint16(8, 8, true);
  local.setUint32(14, crc32(raw), true);
  local.setUint32(18, packed.length, true);
  local.setUint32(22, options.claim == null ? raw.length : options.claim, true);
  local.setUint16(26, nameBytes.length, true);
  const central = new DataView(new ArrayBuffer(46));
  central.setUint32(0, 0x02014b50, true);
  central.setUint16(8, options.flags || 0, true);
  central.setUint16(10, 8, true);
  central.setUint32(16, crc32(raw), true);
  central.setUint32(20, packed.length, true);
  central.setUint32(24, options.claim == null ? raw.length : options.claim, true);
  central.setUint16(28, nameBytes.length, true);
  central.setUint32(42, 0, true);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, options.count == null ? 1 : options.count, true);
  end.setUint16(10, options.count == null ? 1 : options.count, true);
  end.setUint32(12, 46 + nameBytes.length, true);
  end.setUint32(16, 30 + nameBytes.length + packed.length, true);
  return new Blob([local.buffer, nameBytes, packed, central.buffer, nameBytes, end.buffer]);
}

test('a compressed ZIP made by another program can be read', async () => {
  const text = 'pole data '.repeat(500);
  const read = await readZip(deflatedZip('backup.json', text));
  assert.equal(await read.text('backup.json'), text);
});

test('a file that unpacks to more than it promised is stopped', async () => {
  const read = await readZip(deflatedZip('bomb.bin', 'A'.repeat(200000), { claim: 100 }));
  await assert.rejects(read.bytes('bomb.bin'), /"bomb.bin" is damaged/);
});

test('password-locked and oversized ZIP files are refused', async () => {
  const locked = await readZip(deflatedZip('secret.txt', 'x', { flags: 1 }));
  await assert.rejects(locked.bytes('secret.txt'), /locked with a password/);
  await assert.rejects(readZip(deflatedZip('a.txt', 'x', { count: 0xffff })), /too large/);
});
