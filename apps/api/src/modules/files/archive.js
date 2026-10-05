import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';

const BLOCK = 512;

function octal(value, width) {
  const result = value.toString(8).padStart(width - 1, '0');
  if (result.length >= width) throw new Error('Archive entry is too large');
  return `${result}\0`;
}

function header(path, size, modifiedAt) {
  let name = path;
  let prefix = '';
  if (name.length > 100) {
    const split = [...path.matchAll(/\//gu)].map((match) => match.index)
      .find((index) => index <= 155 && path.length - index - 1 <= 100);
    if (split === undefined) throw new Error('Archive path is too long');
    prefix = path.slice(0, split);
    name = path.slice(split + 1);
  }
  if (size < 0 || !Number.isSafeInteger(size)) {
    throw new Error('Invalid archive entry');
  }
  const block = Buffer.alloc(BLOCK);
  block.write(name, 0, 'ascii');
  block.write(octal(0o644, 8), 100, 'ascii');
  block.write(octal(0, 8), 108, 'ascii');
  block.write(octal(0, 8), 116, 'ascii');
  block.write(octal(size, 12), 124, 'ascii');
  block.write(octal(Math.floor(Date.parse(modifiedAt) / 1000), 12), 136, 'ascii');
  block.fill(0x20, 148, 156);
  block[156] = '0'.charCodeAt(0);
  block.write('ustar\0', 257, 'ascii');
  block.write('00', 263, 'ascii');
  if (prefix) block.write(prefix, 345, 'ascii');
  const sum = block.reduce((total, byte) => total + byte, 0);
  block.write(octal(sum, 8), 148, 'ascii');
  return block;
}

function safeEntryName(item, index) {
  const safe = (value, limit) => value.normalize('NFKD').replace(/[^a-zA-Z0-9._-]/gu, '_')
    .slice(0, limit) || 'item';
  const file = `${String(index + 1).padStart(4, '0')}-${safe(item.name, 78)}`;
  const folders = (item.folderPath ?? []).map((part) => safe(part, 40));
  const path = ['files', ...folders, file].join('/');
  const canSplit = path.length <= 100 || [...path.matchAll(/\//gu)].some((match) =>
    match.index <= 155 && path.length - match.index - 1 <= 100);
  return path.length <= 255 && canSplit ? path : `files/${file}`;
}

export async function snapshotArchive(snapshot, versions, storage) {
  const entries = snapshot.items.map((item, index) => ({ item, version: versions[index],
    path: safeEntryName(item, index) }));
  for (const entry of entries) {
    const hash = createHash('sha256');
    let size = 0;
    for await (const chunk of storage.read(entry.version.storageKey)) {
      size += chunk.length;
      if (size > entry.item.size) throw new Error('Snapshot content size mismatch');
      hash.update(chunk);
    }
    if (size !== entry.item.size) throw new Error('Snapshot content size mismatch');
    entry.sha256 = hash.digest('hex');
  }
  const manifest = Buffer.from(JSON.stringify({ format: 'dropvault-snapshot-v1',
    snapshotId: snapshot.id, workspaceId: snapshot.workspaceId,
    createdById: snapshot.createdById, createdByName: snapshot.createdByName,
    name: snapshot.name,
    note: snapshot.note, createdAt: snapshot.createdAt, git: snapshot.git ?? null,
    files: entries.map(({ item, path, sha256 }) => ({ path, ...item, sha256 })) }, null, 2));
  return Readable.from((async function* () {
    yield header('manifest.json', manifest.length, snapshot.createdAt);
    yield manifest;
    if (manifest.length % BLOCK) yield Buffer.alloc(BLOCK - manifest.length % BLOCK);
    for (const { item, version, path } of entries) {
      yield header(path, item.size, snapshot.createdAt);
      let written = 0;
      for await (const chunk of storage.read(version.storageKey)) {
        written += chunk.length;
        if (written > item.size) throw new Error('Snapshot content size mismatch');
        yield chunk;
      }
      if (written !== item.size) throw new Error('Snapshot content size mismatch');
      if (written % BLOCK) yield Buffer.alloc(BLOCK - written % BLOCK);
    }
    yield Buffer.alloc(BLOCK * 2);
  })());
}
