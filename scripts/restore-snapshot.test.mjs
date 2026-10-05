import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { snapshotArchive } from '../apps/api/src/modules/files/archive.js';
import { restoreSnapshotArchive } from './restore-snapshot.mjs';

async function fixture(root, options = {}) {
  const code = Buffer.from('PK\x03\x04example archive');
  const data = Buffer.from('id,value\n1,42\n');
  const items = [
    { fileId: 'code', versionId: 'v-code', name: 'source.zip', folderPath: [], size: code.length },
    { fileId: 'data', versionId: 'v-data', name: options.name ?? 'results.csv',
      folderPath: options.folderPath ?? ['Research'], size: data.length },
  ];
  const snapshot = { id: 'snapshot', workspaceId: 'workspace', name: 'handoff',
    createdAt: new Date().toISOString(), items,
    git: { archiveFileId: 'code', archiveVersionId: 'v-code', commitSha: 'a'.repeat(40) } };
  const versions = [{ storageKey: 'code' }, { storageKey: 'data' }];
  const storage = { read(key) { return Readable.from([key === 'code' ? code : data]); } };
  const tar = join(root, 'snapshot.tar');
  const stream = await snapshotArchive(snapshot, versions, storage);
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  await writeFile(tar, Buffer.concat(chunks));
  return { tar, code, data };
}

test('restores verified code ZIP and original asset paths into a new directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dropvault-restore-test-'));
  try {
    const { tar, code, data } = await fixture(root);
    const destination = join(root, 'restored');
    const result = await restoreSnapshotArchive(tar, destination);
    assert.equal(result.gitCommit, 'a'.repeat(40));
    assert.deepEqual(await readFile(join(destination, 'code', 'code.zip')), code);
    assert.deepEqual(await readFile(join(destination, 'assets', 'Research', 'results.csv')), data);
    assert.equal(JSON.parse(await readFile(join(destination, 'manifest.json'), 'utf8')).snapshotId, 'snapshot');
    await assert.rejects(restoreSnapshotArchive(tar, destination), /Destination already exists/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('rejects changed TAR bytes and leaves no restore destination', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dropvault-restore-test-'));
  try {
    const { tar } = await fixture(root);
    const bytes = await readFile(tar);
    const index = bytes.indexOf(Buffer.from('id,value'));
    assert.ok(index > 0);
    bytes[index] ^= 1;
    await writeFile(tar, bytes);
    await assert.rejects(restoreSnapshotArchive(tar, join(root, 'restored')), /Checksum mismatch/u);
    await assert.rejects(readFile(join(root, 'restored', 'manifest.json')), { code: 'ENOENT' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('rejects traversal in original metadata despite a checksum-valid TAR', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dropvault-restore-test-'));
  try {
    const { tar } = await fixture(root, { folderPath: ['..'] });
    await assert.rejects(restoreSnapshotArchive(tar, join(root, 'restored')), /unsafe original/u);
    await assert.rejects(readFile(join(root, 'restored', 'manifest.json')), { code: 'ENOENT' });
  } finally { await rm(root, { recursive: true, force: true }); }
});
