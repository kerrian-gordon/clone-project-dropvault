import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const BLOCK = 512;
const CHUNK = 1024 * 1024;

async function readAt(file, position, length) {
  const bytes = Buffer.alloc(length);
  let done = 0;
  while (done < length) {
    const result = await file.read(bytes, done, length - done, position + done);
    if (!result.bytesRead) throw new Error('Archive is truncated');
    done += result.bytesRead;
  }
  return bytes;
}

function field(header, start, length) {
  return header.subarray(start, start + length).toString('ascii').split('\0', 1)[0];
}

function parseHeader(header) {
  if (header.every((byte) => byte === 0)) return null;
  const saved = Number.parseInt(field(header, 148, 8).trim(), 8);
  const copy = Buffer.from(header);
  copy.fill(0x20, 148, 156);
  if (!Number.isSafeInteger(saved) || saved !== copy.reduce((sum, byte) => sum + byte, 0)) {
    throw new Error('Invalid TAR header checksum');
  }
  const size = Number.parseInt(field(header, 124, 12).trim(), 8);
  if (!Number.isSafeInteger(size) || size < 0) throw new Error('Invalid TAR entry size');
  const name = field(header, 0, 100);
  const prefix = field(header, 345, 155);
  const path = prefix ? `${prefix}/${name}` : name;
  if (header[156] !== 48 || !path) throw new Error('Unsupported TAR entry');
  return { path, size };
}

async function hashEntry(file, position, size) {
  const hash = createHash('sha256');
  let remaining = size;
  while (remaining) {
    const bytes = await readAt(file, position, Math.min(CHUNK, remaining));
    hash.update(bytes);
    position += bytes.length;
    remaining -= bytes.length;
  }
  return hash.digest('hex');
}

export async function verifySnapshotArchive(path) {
  const file = await open(path, 'r');
  try {
    const { size: archiveSize } = await file.stat();
    let position = 0;
    const first = parseHeader(await readAt(file, position, BLOCK));
    if (first?.path !== 'manifest.json' || first.size > 16 * 1024 * 1024) {
      throw new Error('Expected a DropVault manifest as the first TAR entry');
    }
    position += BLOCK;
    const manifest = JSON.parse((await readAt(file, position, first.size)).toString('utf8'));
    if (manifest.format !== 'dropvault-snapshot-v1' || !Array.isArray(manifest.files)) {
      throw new Error('Unsupported DropVault snapshot manifest');
    }
    position += Math.ceil(first.size / BLOCK) * BLOCK;
    const paths = new Set();
    for (const item of manifest.files) {
      if (typeof item.path !== 'string' || paths.has(item.path)
        || !Number.isSafeInteger(item.size) || item.size < 0
        || !/^[a-f0-9]{64}$/u.test(item.sha256)) {
        throw new Error('Snapshot manifest has invalid file metadata or lacks SHA-256 checksums');
      }
      paths.add(item.path);
      const entry = parseHeader(await readAt(file, position, BLOCK));
      if (entry?.path !== item.path || entry.size !== item.size) {
        throw new Error(`Missing or mismatched archive entry: ${item.path}`);
      }
      position += BLOCK;
      if (await hashEntry(file, position, entry.size) !== item.sha256) {
        throw new Error(`Checksum mismatch: ${item.path}`);
      }
      position += Math.ceil(entry.size / BLOCK) * BLOCK;
    }
    if (position + 2 * BLOCK !== archiveSize
      || !(await readAt(file, position, 2 * BLOCK)).every((byte) => byte === 0)) {
      throw new Error('Unexpected data after snapshot files');
    }
    return { snapshotId: manifest.snapshotId, files: manifest.files.length,
      gitCommit: manifest.git?.commitSha ?? null };
  } finally {
    await file.close();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    if (process.argv.length !== 3) throw new Error('Usage: node scripts/verify-snapshot.mjs <snapshot.tar>');
    const result = await verifySnapshotArchive(process.argv[2]);
    console.log(`Verified snapshot ${result.snapshotId}: ${result.files} files${result.gitCommit ? `, Git commit ${result.gitCommit}` : ''}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
