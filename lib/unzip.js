'use strict';

// Streaming ZIP extraction (stored + deflate) with size limits and CRC-32 verification.
// Reads only the central directory into memory; entry data is streamed to disk.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const zlib = require('node:zlib');
const { pipeline } = require('node:stream/promises');
const { Transform } = require('node:stream');

const MAX_ENTRY_BYTES = 4 * 1024 * 1024 * 1024; // 4 GiB (no ZIP64 support beyond this)

async function readTail(file, size) {
  const handle = await fsp.open(file, 'r');
  try {
    const length = Math.min(size, 65557 + 22);
    const buf = Buffer.alloc(length);
    await handle.read(buf, 0, length, size - length);
    return { buf, offset: size - length };
  } finally { await handle.close(); }
}

async function readAt(file, position, length) {
  const handle = await fsp.open(file, 'r');
  try {
    const buf = Buffer.alloc(length);
    await handle.read(buf, 0, length, position);
    return buf;
  } finally { await handle.close(); }
}

/** Lists entries: [{ name, method, compressedSize, size, crc, localOffset }]. */
async function listZip(file) {
  const { size } = await fsp.stat(file);
  const { buf, offset: base } = await readTail(file, size);
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd === -1) throw new Error('Not a ZIP archive (no end-of-central-directory record)');
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (cdOffset === 0xffffffff || count === 0xffff) throw new Error('ZIP64 archives are not supported');
  const cd = cdOffset >= base ? buf.subarray(cdOffset - base, cdOffset - base + cdSize) : await readAt(file, cdOffset, cdSize);
  const entries = [];
  let p = 0;
  for (let n = 0; n < count; n++) {
    if (cd.readUInt32LE(p) !== 0x02014b50) throw new Error('Corrupt ZIP central directory');
    const nameLength = cd.readUInt16LE(p + 28);
    const entry = {
      method: cd.readUInt16LE(p + 10),
      crc: cd.readUInt32LE(p + 16),
      compressedSize: cd.readUInt32LE(p + 20),
      size: cd.readUInt32LE(p + 24),
      localOffset: cd.readUInt32LE(p + 42),
      name: cd.toString('utf8', p + 46, p + 46 + nameLength),
    };
    p += 46 + nameLength + cd.readUInt16LE(p + 30) + cd.readUInt16LE(p + 32);
    if (!entry.name.endsWith('/')) entries.push(entry);
  }
  return entries;
}

/**
 * Streams one entry to `dest` (written as dest.part, then renamed). Verifies size and CRC-32.
 * @returns {Promise<{ name: string, size: number }>}
 */
async function extractEntry(file, entry, dest, { maxBytes = MAX_ENTRY_BYTES } = {}) {
  if (entry.size > maxBytes) throw new Error(`${entry.name}: ${entry.size} bytes exceeds the ${maxBytes}-byte limit`);
  if (![0, 8].includes(entry.method)) throw new Error(`Unsupported ZIP compression method ${entry.method}`);
  const local = await readAt(file, entry.localOffset, 30);
  if (local.readUInt32LE(0) !== 0x04034b50) throw new Error('Corrupt ZIP local header');
  const start = entry.localOffset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
  let written = 0;
  let crc = 0;
  const guard = new Transform({
    transform(chunk, _enc, done) {
      written += chunk.length;
      if (written > entry.size || written > maxBytes) { done(new Error(`${entry.name}: data exceeds its declared size (possible ZIP bomb)`)); return; }
      crc = zlib.crc32(chunk, crc);
      done(null, chunk);
    },
  });
  const part = `${dest}.part`;
  if (entry.size === 0) {
    await fsp.writeFile(part, Buffer.alloc(0));
    await fsp.rename(part, dest);
    return { name: entry.name, size: 0 };
  }
  const stages = [fs.createReadStream(file, { start, end: start + Math.max(entry.compressedSize, 1) - 1 })];
  if (entry.method === 8) stages.push(zlib.createInflateRaw());
  try {
    await pipeline(...stages, guard, fs.createWriteStream(part));
    if (written !== entry.size) throw new Error(`${entry.name}: extracted ${written} bytes, expected ${entry.size}`);
    if ((crc >>> 0) !== entry.crc) throw new Error(`${entry.name}: CRC mismatch (corrupt archive)`);
    await fsp.rename(part, dest);
  } catch (error) {
    await fsp.rm(part, { force: true });
    throw error;
  }
  return { name: entry.name, size: written };
}

module.exports = { listZip, extractEntry };
