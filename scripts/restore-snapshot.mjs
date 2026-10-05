import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, open, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifySnapshotArchive } from './verify-snapshot.mjs';

const BLOCK = 512;
const CHUNK = 1024 * 1024;

async function readAt(file, position, length) {
  const bytes = Buffer.alloc(length);
  let done = 0;
  while (done < length) {
    const { bytesRead } = await file.read(bytes, done, length - done, position + done);
    if (!bytesRead) throw new Error('Archive is truncated');
    done += bytesRead;
  }
  return bytes;
}

function field(header, start, length) {
  return header.subarray(start, start + length).toString('ascii').split('\0', 1)[0];
}

function entryHeader(header) {
  const saved = Number.parseInt(field(header, 148, 8).trim(), 8);
  const copy = Buffer.from(header);
  copy.fill(0x20, 148, 156);
  if (!Number.isSafeInteger(saved) || saved !== copy.reduce((sum, byte) => sum + byte, 0)) {
    throw new Error('Invalid TAR header checksum');
  }
  const size = Number.parseInt(field(header, 124, 12).trim(), 8);
  const name = field(header, 0, 100);
  const prefix = field(header, 345, 155);
  if (!Number.isSafeInteger(size) || size < 0 || header[156] !== 48 || !name) {
    throw new Error('Unsupported TAR entry');
  }
  return { path: prefix ? `${prefix}/${name}` : name, size };
}

function safePart(value) {
  return typeof value === 'string' && value.length > 0 && value !== '.' && value !== '..'
    && !/[\\/\x00-\x1f<>:"|?*]/u.test(value) && !/[. ]$/u.test(value)
    && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(value);
}

function outputPaths(manifest) {
  const seen = new Set(['manifest.json']);
  const mapped = [];
  for (const item of manifest.files) {
    if (!safePart(item.name) || !Array.isArray(item.folderPath)
      || !item.folderPath.every(safePart) || item.folderPath.length > 64) {
      throw new Error('Snapshot contains an unsafe original filename or folder path');
    }
    const code = manifest.git?.archiveFileId === item.fileId
      && manifest.git?.archiveVersionId === item.versionId;
    const parts = code ? ['code', 'code.zip'] : ['assets', ...item.folderPath, item.name];
    const relative = parts.join('/');
    const key = relative.normalize('NFKC').toLowerCase();
    if (seen.has(key)) throw new Error(`Snapshot files collide at ${relative}`);
    seen.add(key);
    mapped.push({ item, parts });
  }
  if (manifest.git && !mapped.some(({ parts }) => parts[0] === 'code')) {
    throw new Error('Snapshot does not contain its linked code archive');
  }
  return mapped;
}

async function absent(path) {
  try { await lstat(path); return false; } catch (error) {
    if (error.code === 'ENOENT') return true;
    throw error;
  }
}

export async function restoreSnapshotArchive(archivePath, destination) {
  if (!archivePath || !destination) throw new Error('Provide a TAR and destination directory');
  const target = resolve(destination);
  if (!await absent(target)) throw new Error('Destination already exists; choose a new directory');
  await verifySnapshotArchive(archivePath);
  const file = await open(archivePath, 'r');
  let stage;
  try {
    const first = entryHeader(await readAt(file, 0, BLOCK));
    if (first.path !== 'manifest.json' || first.size > 16 * 1024 * 1024) {
      throw new Error('Expected a DropVault manifest');
    }
    const manifestBytes = await readAt(file, BLOCK, first.size);
    const manifest = JSON.parse(manifestBytes.toString('utf8'));
    if (manifest.format !== 'dropvault-snapshot-v1' || !Array.isArray(manifest.files)) {
      throw new Error('Unsupported DropVault snapshot manifest');
    }
    const mapped = outputPaths(manifest);
    const parent = dirname(target);
    await mkdir(parent, { recursive: true });
    stage = await mkdtemp(join(parent, `.dropvault-${basename(target)}-`));
    await writeFile(join(stage, 'manifest.json'), manifestBytes, { flag: 'wx' });
    let position = BLOCK + Math.ceil(first.size / BLOCK) * BLOCK;
    for (const { item, parts } of mapped) {
      const entry = entryHeader(await readAt(file, position, BLOCK));
      if (entry.path !== item.path || entry.size !== item.size) {
        throw new Error(`Missing or mismatched archive entry: ${item.path}`);
      }
      position += BLOCK;
      const output = join(stage, ...parts);
      if (!output.startsWith(stage + sep)) throw new Error('Unsafe output path');
      await mkdir(dirname(output), { recursive: true });
      const writer = await open(output, 'wx');
      const hash = createHash('sha256');
      try {
        let remaining = entry.size;
        while (remaining) {
          const bytes = await readAt(file, position, Math.min(CHUNK, remaining));
          await writer.writeFile(bytes);
          hash.update(bytes);
          position += bytes.length;
          remaining -= bytes.length;
        }
      } finally { await writer.close(); }
      if (hash.digest('hex') !== item.sha256) throw new Error(`Checksum mismatch: ${item.path}`);
      position += (BLOCK - entry.size % BLOCK) % BLOCK;
    }
    if (!await absent(target)) throw new Error('Destination was created during restore');
    await rename(stage, target);
    stage = undefined;
    return { destination: target, files: mapped.length, gitCommit: manifest.git?.commitSha ?? null };
  } finally {
    await file.close();
    if (stage && stage.startsWith(dirname(target) + sep)) await rm(stage, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    if (process.argv.length !== 4) throw new Error('Usage: node scripts/restore-snapshot.mjs <snapshot.tar> <new-directory>');
    const result = await restoreSnapshotArchive(process.argv[2], process.argv[3]);
    console.log(`Restored ${result.files} files to ${result.destination}${result.gitCommit ? ` (Git commit ${result.gitCommit})` : ''}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
