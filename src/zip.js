// A small ZIP writer and reader, written for this app so that no outside library is needed.
//
// Writer: files are stored as they are, without compression. Photos and PDF reports are already
// compressed, so squeezing them again would only use battery.
// Reader: reads files that are stored or deflated, and checks every file against its checksum.
//
// Limits (far beyond what a phone can hold in memory): 65,534 files, 4 GB.

const MAX_ENTRIES = 65534;
const MAX_BYTES = 0xfffffffe;
const MAX_UNPACKED = 512 * 1024 * 1024;
const encoder = new TextEncoder();

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** The standard CRC-32 checksum of a Uint8Array. */
export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// Characters that cannot be seen, or that turn text around. A name holding them can look like
// something it is not ("photo<turn>gpj.exe" shows as "photoexe.jpg").
const HIDDEN = /[\u00ad\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;
const MAX_NAME = 200;

/**
 * Makes a name safe to store in a ZIP: forward slashes for folders, no "..", no leading slash,
 * no characters that Windows refuses, no hidden characters, at most 200 characters.
 */
export function safeZipName(name) {
  const parts = String(name == null ? '' : name)
    .replace(/\\/g, '/')
    .split('/')
    .map((part) =>
      part
        .replace(HIDDEN, '')
        // Half of a two-part character, and the two "non-characters", have no place in a name.
        .replace(/[\ud800-\udfff\ufffe\uffff]/gu, '_')
        // eslint-disable-next-line no-control-regex
        .replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '_')
        .replace(/^\s+|[\s.]+$/g, ''),
    )
    .filter((part) => part !== '' && part !== '.' && part !== '..');
  let joined = parts.join('/');
  if (joined.length > MAX_NAME) {
    joined = joined.slice(0, MAX_NAME);
    if (/[\ud800-\udbff]$/.test(joined)) joined = joined.slice(0, -1);
    // The cut must not leave a name ending in a folder mark, a dot or a space.
    joined = joined.replace(/[\s./]+$/, '');
  }
  return joined || 'file';
}

function toBytes(data) {
  if (typeof data === 'string') return encoder.encode(data);
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  throw new TypeError('ZIP entries must be text or bytes.');
}

function dosDateTime(date) {
  const d = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();
  const year = Math.min(Math.max(d.getFullYear(), 1980), 2107);
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const day = ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time: time & 0xffff, day: day & 0xffff };
}

function splitName(name) {
  const slash = name.lastIndexOf('/');
  const dot = name.lastIndexOf('.');
  if (dot > slash + 1) return [name.slice(0, dot), name.slice(dot)];
  return [name, ''];
}

export class ZipWriter {
  constructor() {
    this.parts = [];
    this.entries = [];
    this.offset = 0;
    this.used = new Set();
  }

  /** Adds one file. Returns the name it was stored under, which gets " (2)" if the name was taken. */
  add(name, data, modified) {
    if (this.entries.length >= MAX_ENTRIES) throw new Error('Too many files for one ZIP file.');
    const bytes = toBytes(data);
    let finalName = safeZipName(name);
    if (this.used.has(finalName.toLowerCase())) {
      const [stem, extension] = splitName(finalName);
      let n = 2;
      while (this.used.has((stem + ' (' + n + ')' + extension).toLowerCase())) n += 1;
      finalName = stem + ' (' + n + ')' + extension;
    }
    this.used.add(finalName.toLowerCase());

    const nameBytes = encoder.encode(finalName);
    if (nameBytes.length > 0xffff) throw new Error('A file name is too long for a ZIP file.');
    if (bytes.length > MAX_BYTES || this.offset + bytes.length + nameBytes.length + 30 > MAX_BYTES) {
      throw new Error('Too much data for one ZIP file.');
    }
    const crc = crc32(bytes);
    const { time, day } = dosDateTime(modified);

    const header = new DataView(new ArrayBuffer(30));
    header.setUint32(0, 0x04034b50, true);
    header.setUint16(4, 20, true); // version needed
    header.setUint16(6, 0x0800, true); // names are UTF-8
    header.setUint16(8, 0, true); // stored
    header.setUint16(10, time, true);
    header.setUint16(12, day, true);
    header.setUint32(14, crc, true);
    header.setUint32(18, bytes.length, true);
    header.setUint32(22, bytes.length, true);
    header.setUint16(26, nameBytes.length, true);
    header.setUint16(28, 0, true);

    this.entries.push({ nameBytes, crc, size: bytes.length, offset: this.offset, time, day });
    // Each file goes into its own Blob so the browser can keep large exports off the heap.
    this.parts.push(new Blob([header.buffer, nameBytes, bytes]));
    this.offset += 30 + nameBytes.length + bytes.length;
    return finalName;
  }

  /** Finishes the file and returns it as a Blob. */
  finish(type) {
    const start = this.offset;
    let size = 0;
    const central = [];
    for (const entry of this.entries) {
      const record = new DataView(new ArrayBuffer(46));
      record.setUint32(0, 0x02014b50, true);
      record.setUint16(4, 20, true);
      record.setUint16(6, 20, true);
      record.setUint16(8, 0x0800, true);
      record.setUint16(10, 0, true);
      record.setUint16(12, entry.time, true);
      record.setUint16(14, entry.day, true);
      record.setUint32(16, entry.crc, true);
      record.setUint32(20, entry.size, true);
      record.setUint32(24, entry.size, true);
      record.setUint16(28, entry.nameBytes.length, true);
      record.setUint32(42, entry.offset, true);
      central.push(record.buffer, entry.nameBytes);
      size += 46 + entry.nameBytes.length;
    }
    if (start + size > MAX_BYTES) throw new Error('Too much data for one ZIP file.');
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, this.entries.length, true);
    end.setUint16(10, this.entries.length, true);
    end.setUint32(12, size, true);
    end.setUint32(16, start, true);
    return new Blob([...this.parts, ...central, end.buffer], { type: type || 'application/zip' });
  }
}

const decoder = new TextDecoder('utf-8');

async function slice(blob, from, to) {
  return new Uint8Array(await blob.slice(from, to).arrayBuffer());
}

// Unpacks one deflated file. It stops as soon as the data grows past the size the ZIP file
// promised, so a file built to swell up without limit cannot use up the phone's memory.
async function inflate(bytes, expected) {
  if (typeof DecompressionStream === 'undefined') throw new Error('This browser cannot open compressed ZIP files.');
  if (expected > MAX_UNPACKED) throw new Error('too large');
  const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
  const out = new Uint8Array(expected);
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (length + value.length > expected) {
      await reader.cancel().catch(() => {});
      throw new Error('larger than promised');
    }
    out.set(value, length);
    length += value.length;
  }
  if (length !== expected) throw new Error('shorter than promised');
  return out;
}

/**
 * Opens a ZIP file.
 * Returns { names, has(name), bytes(name), text(name) }. bytes() and text() check the checksum
 * and throw a plain-language Error when a file is missing or damaged.
 */
export async function readZip(blob) {
  const notZip = () => new Error('This is not a ZIP file, or the file is damaged.');
  if (!blob || blob.size < 22) throw notZip();
  const tailStart = Math.max(0, blob.size - (22 + 0xffff));
  const tail = await slice(blob, tailStart, blob.size);
  let at = -1;
  for (let i = tail.length - 22; i >= 0; i -= 1) {
    if (tail[i] === 0x50 && tail[i + 1] === 0x4b && tail[i + 2] === 0x05 && tail[i + 3] === 0x06) {
      at = i;
      break;
    }
  }
  if (at < 0) throw notZip();
  const end = new DataView(tail.buffer, tail.byteOffset + at, 22);
  const count = end.getUint16(10, true);
  const size = end.getUint32(12, true);
  const start = end.getUint32(16, true);
  if (count > MAX_ENTRIES || size === 0xffffffff || start === 0xffffffff) throw new Error('This ZIP file is too large for the app to open.');
  if (start + size > blob.size) throw notZip();

  const directory = await slice(blob, start, start + size);
  const view = new DataView(directory.buffer, directory.byteOffset, directory.byteLength);
  const entries = new Map();
  let p = 0;
  for (let i = 0; i < count; i += 1) {
    if (p + 46 > directory.length || view.getUint32(p, true) !== 0x02014b50) throw notZip();
    const flags = view.getUint16(p + 8, true);
    const method = view.getUint16(p + 10, true);
    const crc = view.getUint32(p + 16, true);
    const packed = view.getUint32(p + 20, true);
    const unpacked = view.getUint32(p + 24, true);
    const nameLength = view.getUint16(p + 28, true);
    const extraLength = view.getUint16(p + 30, true);
    const commentLength = view.getUint16(p + 32, true);
    const offset = view.getUint32(p + 42, true);
    if (p + 46 + nameLength > directory.length) throw notZip();
    const name = decoder.decode(directory.subarray(p + 46, p + 46 + nameLength));
    entries.set(name, { flags, method, crc, packed, unpacked, offset });
    p += 46 + nameLength + extraLength + commentLength;
  }

  async function bytes(name) {
    const entry = entries.get(name);
    if (!entry) throw new Error('"' + name + '" is not in the file.');
    if (entry.flags & 1) throw new Error('"' + name + '" is locked with a password.');
    if (entry.method !== 0 && entry.method !== 8) throw new Error('"' + name + '" is packed in a way the app cannot read.');
    if (entry.offset + 30 > blob.size) throw new Error('"' + name + '" is damaged.');
    const head = await slice(blob, entry.offset, entry.offset + 30);
    const local = new DataView(head.buffer, head.byteOffset, 30);
    if (local.getUint32(0, true) !== 0x04034b50) throw new Error('"' + name + '" is damaged.');
    const dataStart = entry.offset + 30 + local.getUint16(26, true) + local.getUint16(28, true);
    if (dataStart + entry.packed > blob.size) throw new Error('"' + name + '" is damaged.');
    const packed = await slice(blob, dataStart, dataStart + entry.packed);
    let data;
    try {
      data = entry.method === 8 ? await inflate(packed, entry.unpacked) : packed;
    } catch (e) {
      throw new Error('"' + name + '" is damaged.');
    }
    if (data.length !== entry.unpacked || crc32(data) !== entry.crc) throw new Error('"' + name + '" is damaged.');
    return data;
  }

  return {
    names: [...entries.keys()],
    has: (name) => entries.has(name),
    bytes,
    text: async (name) => decoder.decode(await bytes(name)),
  };
}
