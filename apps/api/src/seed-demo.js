import { randomBytes, randomUUID } from 'node:crypto';
import { access, link, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { MAX_UPLOAD_BYTES, ROOT_FOLDER_ID, SUPPORTED_UPLOAD_TYPES } from '../../../packages/shared/index.js';
import { hashPassword, validPassword } from './modules/accounts/auth.js';
import { validateStoredFile } from './modules/uploads/validate.js';
import { zipEntryNames } from './modules/uploads/zip.js';

const defaultStorageRoot = fileURLToPath(new URL('../../../storage/', import.meta.url));
const fixturePath = fileURLToPath(new URL('../../web/src/shared/data/mock-multi-user-drive.json', import.meta.url));
const videoPath = fileURLToPath(new URL('../seed/assets/flower.mp4', import.meta.url));
const deckPath = fileURLToPath(new URL('../seed/assets/q4-deck.pptx', import.meta.url));

function pdfAtSize(size) {
  const parts = [
    '%PDF-1.4\n',
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>\nendobj\n',
    '4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n',
  ];
  const message = 'BT /F1 24 Tf 72 700 Td (Dropvault demo project brief) Tj ET\n';
  parts.push(`5 0 obj\n<< /Length ${Buffer.byteLength(message)} >>\nstream\n${message}endstream\nendobj\n`);
  const offsets = [];
  let offset = 0;
  for (const part of parts) {
    if (part.includes(' 0 obj\n')) offsets.push(offset);
    offset += Buffer.byteLength(part);
  }
  const xref = 'xref\n0 6\n0000000000 65535 f \n'
    + offsets.map((value) => `${String(value).padStart(10, '0')} 00000 n \n`).join('');
  const trailer = `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${size - Buffer.byteLength(xref) - Buffer.byteLength('trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n') - String(size).length - Buffer.byteLength('\n%%EOF\n')}\n%%EOF\n`;
  const footer = xref + trailer;
  const padding = size - offset - Buffer.byteLength(footer);
  if (padding < 0) throw new Error('PDF fixture size is too small');
  // PDF permits whitespace before its cross-reference table.
  return Buffer.concat([Buffer.from(parts.join('')), Buffer.alloc(padding, 0x20), Buffer.from(footer)]);
}

function textAtSize(size) {
  const line = Buffer.from('Dropvault demo meeting notes. Shared files stay in the owner\'s quota.\n');
  const bytes = Buffer.alloc(size, 0x20);
  for (let offset = 0; offset < size; offset += line.length) {
    line.copy(bytes, offset, 0, Math.min(line.length, size - offset));
  }
  return bytes;
}

function mp4AtSize(source, size) {
  const freeSize = size - source.length;
  if (freeSize < 8 || freeSize > 0xffffffff) throw new Error('MP4 fixture size is invalid');
  const free = Buffer.alloc(freeSize);
  free.writeUInt32BE(freeSize, 0);
  free.write('free', 4, 'ascii');
  return Buffer.concat([source, free]);
}

const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
  return value >>> 0;
});

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) value = (value >>> 8) ^ crcTable[(value ^ byte) & 0xff];
  return (value ^ 0xffffffff) >>> 0;
}

function pptxAtSize(source, size) {
  // Add an unreferenced, valid XML part to the sample package to preserve the
  // metadata fixture's exact byte size and its 100 MiB quota scenario.
  const name = Buffer.from('customXml/demo-padding.xml');
  const eocdOffset = source.lastIndexOf(Buffer.from('504b0506', 'hex'));
  if (eocdOffset < 0 || eocdOffset + 22 !== source.length) throw new Error('Sample PPTX has an unsupported ZIP footer');
  const entryCount = source.readUInt16LE(eocdOffset + 10);
  const directorySize = source.readUInt32LE(eocdOffset + 12);
  const directoryOffset = source.readUInt32LE(eocdOffset + 16);
  if (directoryOffset + directorySize !== eocdOffset) throw new Error('Sample PPTX ZIP directory is invalid');
  const overhead = 30 + name.length + 46 + name.length;
  const contentSize = size - source.length - overhead;
  if (contentSize < 13) throw new Error('PPTX fixture size is too small');
  const content = Buffer.alloc(contentSize, 0x20);
  content.write('<demo>', 0, 'ascii');
  content.write('</demo>', content.length - 7, 'ascii');
  const checksum = crc32(content);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt32LE(checksum, 14);
  local.writeUInt32LE(content.length, 18);
  local.writeUInt32LE(content.length, 22);
  local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt32LE(checksum, 16);
  central.writeUInt32LE(content.length, 20);
  central.writeUInt32LE(content.length, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt32LE(directoryOffset, 42);
  const eocd = Buffer.from(source.subarray(eocdOffset));
  eocd.writeUInt16LE(entryCount + 1, 8);
  eocd.writeUInt16LE(entryCount + 1, 10);
  eocd.writeUInt32LE(directorySize + central.length + name.length, 12);
  eocd.writeUInt32LE(directoryOffset + local.length + name.length + content.length, 16);
  return Buffer.concat([
    source.subarray(0, directoryOffset), local, name, content,
    source.subarray(directoryOffset, eocdOffset), central, name, eocd,
  ]);
}

async function contentFor(file) {
  if (file.name === 'Project-brief.pdf') return pdfAtSize(file.size);
  if (file.name === 'Demo-video.mp4') return mp4AtSize(await readFile(videoPath), file.size);
  if (file.name === 'Q4-deck.pptx') return pptxAtSize(await readFile(deckPath), file.size);
  if (file.name === 'Meeting-notes.txt') return textAtSize(file.size);
  throw new Error(`No sample content is available for ${file.name}`);
}

async function isEmptyOrMissing(path) {
  try {
    const names = await readdir(path);
    return names.every((name) => name === '.gitkeep');
  } catch (error) {
    if (error.code === 'ENOENT') return true;
    throw error;
  }
}

export async function seedDemoData({ storageRoot = defaultStorageRoot, password } = {}) {
  if (!validPassword(password)) throw new Error('Demo password must be 12 to 1024 characters');
  const catalogPath = join(storageRoot, 'catalog.json');
  const originalsPath = join(storageRoot, 'originals');
  const tmpPath = join(storageRoot, 'tmp');
  try {
    await access(catalogPath);
    throw new Error('Catalog already exists; use a fresh storage directory for demo seeding');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (!await isEmptyOrMissing(originalsPath) || !await isEmptyOrMissing(tmpPath)) {
    throw new Error('Storage directory contains files; use a fresh directory for demo seeding');
  }

  const fixture = JSON.parse(await readFile(fixturePath, 'utf8'));
  const ids = new Set(fixture.users.map((user) => user.id));
  const folderIds = new Set(fixture.folders.map((folder) => folder.id));
  const fileIds = new Set(fixture.files.map((file) => file.id));
  for (const folder of fixture.folders) {
    if (!ids.has(folder.ownerId) || (folder.parentId !== ROOT_FOLDER_ID && !folderIds.has(folder.parentId))) {
      throw new Error(`Fixture folder has an invalid owner or parent: ${folder.name}`);
    }
  }
  for (const file of fixture.files) {
    const extension = file.name.split('.').at(-1).toLowerCase();
    if (!ids.has(file.ownerId) || (file.folderId !== ROOT_FOLDER_ID && !folderIds.has(file.folderId))
      || SUPPORTED_UPLOAD_TYPES[extension] !== file.mimeType
      || !Number.isSafeInteger(file.size) || file.size < 1 || file.size > MAX_UPLOAD_BYTES) {
      throw new Error(`Fixture file is invalid: ${file.name}`);
    }
  }
  for (const grant of fixture.accessGrants) {
    if (!fileIds.has(grant.fileId) || !ids.has(grant.userId)) throw new Error('Fixture access grant is invalid');
  }
  for (const user of fixture.users) {
    const usedBytes = fixture.files.filter((file) => file.ownerId === user.id)
      .reduce((sum, file) => sum + file.size, 0);
    if (fixture.storageUsageByUser[user.id]?.usedBytes !== usedBytes) {
      throw new Error(`Fixture quota does not match files for ${user.email}`);
    }
  }

  const passwordHash = await hashPassword(password);
  const catalog = {
    schemaVersion: 1,
    users: fixture.users.map((user) => ({ ...user, passwordHash })),
    folders: fixture.folders,
    files: [],
    grants: fixture.accessGrants.map(({ fileId, userId, createdAt }) => ({ fileId, userId, createdAt })),
    shares: [], sessions: [],
  };
  await mkdir(originalsPath, { recursive: true });
  await mkdir(tmpPath, { recursive: true });
  const created = [];
  const tempCatalogPath = join(storageRoot, `catalog.seed-${randomUUID()}.tmp`);
  let committed = false;
  try {
    for (const file of fixture.files) {
      const bytes = await contentFor(file);
      if (bytes.length !== file.size) throw new Error(`Generated size does not match ${file.name}`);
      const storageKey = randomUUID();
      const path = join(originalsPath, storageKey);
      await writeFile(path, bytes, { flag: 'wx' });
      created.push(path);
      await validateStoredFile(file.name, bytes.subarray(0, 12), () => zipEntryNames(path));
      catalog.files.push({ ...file, storageKey });
    }
    await writeFile(tempCatalogPath, JSON.stringify(catalog, null, 2), { flag: 'wx' });
    // Linking is atomic and fails if another process created the catalog.
    await link(tempCatalogPath, catalogPath);
    committed = true;
  } catch (error) {
    if (!committed) await Promise.all(created.map((path) => rm(path, { force: true })));
    throw error;
  } finally {
    await rm(tempCatalogPath, { force: true });
  }
  return { users: fixture.users.map(({ email }) => email), folders: fixture.folders.length,
    files: fixture.files.length, usedBytes: Object.values(fixture.storageUsageByUser)
      .reduce((sum, usage) => sum + usage.usedBytes, 0), storageRoot };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.env.NODE_ENV === 'production') throw new Error('Demo seeding is disabled in production');
  const password = process.env.DROPVAULT_DEMO_PASSWORD || randomBytes(18).toString('base64url');
  const result = await seedDemoData({ storageRoot: process.env.DROPVAULT_STORAGE_DIR || defaultStorageRoot, password });
  console.log(`Seeded ${result.users.length} demo accounts, ${result.folders} folders and ${result.files} files in ${result.storageRoot}`);
  console.log(`Sign in as ${result.users.join(' or ')} with password: ${password}`);
  console.log('For the fixture\'s 100 MiB free cap, set DROPVAULT_STORAGE_LIMIT_BYTES=104857600 before starting the API.');
}
