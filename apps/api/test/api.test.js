import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import test from 'node:test';
import { createApiServer } from '../src/server.js';
import { apiListenOptions } from '../src/start.js';
import { openLocalStorage } from '../src/services/storage/local.js';

const nativeFetch = globalThis.fetch;
let activeCookie;
async function fetch(input, options = {}) {
  return nativeFetch(input, { ...options, headers: {
    ...options.headers, ...(activeCookie ? { Cookie: activeCookie } : {}),
  } });
}

async function register(base, email = 'owner@example.test') {
  const response = await nativeFetch(`${base}/v1/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'correct horse battery staple' }),
  });
  assert.equal(response.status, 201);
  activeCookie = response.headers.get('set-cookie').split(';', 1)[0];
  return response.json();
}

function emptyZip(entries, comment = '') {
  const local = [];
  const central = [];
  let offset = 0;
  for (const name of entries) {
    const nameBytes = Buffer.from(name);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(nameBytes.length, 26);
    local.push(header, nameBytes);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50, 0);
    directory.writeUInt16LE(nameBytes.length, 28);
    directory.writeUInt32LE(offset, 42);
    central.push(directory, nameBytes);
    offset += header.length + nameBytes.length;
  }
  const localBytes = Buffer.concat(local);
  const centralBytes = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(localBytes.length, 16);
  const commentBytes = Buffer.from(comment, 'ascii');
  end.writeUInt16LE(commentBytes.length, 20);
  return Buffer.concat([localBytes, centralBytes, end, commentBytes]);
}

test('workspace snapshots bind a Git archive version and preserve its commit label in a copy', async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'dropvault-git-test-'));
  let running;
  try {
    running = await start(storageRoot, 1000);
    await register(running.base);
    const commit = 'a'.repeat(40);
    const zip = emptyZip(['README.md'], commit);
    const uploaded = await fetch(`${running.base}/v1/files?name=code.zip`, {
      method: 'POST', headers: { 'Content-Type': 'application/zip' }, body: zip,
    });
    assert.equal(uploaded.status, 201);
    const file = await uploaded.json();
    const folder = await (await fetch(`${running.base}/v1/folders`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Code' }),
    })).json();
    assert.equal((await fetch(`${running.base}/v1/files/${file.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folderId: folder.id }),
    })).status, 200);
    const workspace = await (await fetch(`${running.base}/v1/workspaces`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Code and data', description: '' }),
    })).json();
    const jsonRequest = (path, method, body) => fetch(`${running.base}${path}`, {
      method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    assert.equal((await jsonRequest(`/v1/workspaces/${workspace.id}/files`, 'POST',
      { fileId: file.id })).status, 200);
    const linked = await jsonRequest(`/v1/workspaces/${workspace.id}/git`, 'PUT', { fileId: file.id });
    assert.equal(linked.status, 200);
    assert.equal((await linked.json()).commitSha, commit);
    const snapshot = await jsonRequest(`/v1/workspaces/${workspace.id}/snapshots`, 'POST',
      { name: 'Run one', note: '', fileIds: [file.id] });
    assert.equal(snapshot.status, 201);
    const saved = await snapshot.json();
    assert.equal(saved.git.archiveVersionId, file.currentVersionId);
    assert.equal(saved.git.commitSha, commit);
    assert.deepEqual(saved.items[0].folderPath, ['Code']);
    const archive = await fetch(`${running.base}/v1/snapshots/${saved.id}/archive`);
    const tar = Buffer.from(await archive.arrayBuffer());
    const manifestLength = Number.parseInt(tar.subarray(124, 136).toString('ascii').trim(), 8);
    const manifest = JSON.parse(tar.subarray(512, 512 + manifestLength).toString('utf8'));
    assert.equal(manifest.git.commitSha, commit);
    assert.match(manifest.files[0].path, /^files\/Code\//u);
    const replacement = await fetch(`${running.base}/v1/files/${file.id}/versions`, {
      method: 'POST', headers: { 'Content-Type': 'application/zip' },
      body: emptyZip(['README.md'], 'b'.repeat(40)),
    });
    assert.equal(replacement.status, 201);
    const stale = await jsonRequest(`/v1/workspaces/${workspace.id}/snapshots`, 'POST',
      { name: 'Run two', note: '', fileIds: [file.id] });
    assert.equal(stale.status, 409);
    assert.equal((await stale.json()).error.code, 'GIT_ARCHIVE_CHANGED');
    const copied = await fetch(`${running.base}/v1/snapshots/${saved.id}/copy`, { method: 'POST' });
    assert.equal(copied.status, 201);
    const copy = await copied.json();
    assert.equal(copy.git.commitSha, commit);
    assert.notEqual(copy.git.archiveFileId, file.id);
    const copiedFiles = await (await fetch(`${running.base}/v1/workspaces/${copy.id}/files`)).json();
    const allFolders = await (await fetch(`${running.base}/v1/folders`)).json();
    const copiedFolder = allFolders.folders.find((item) => item.id === copiedFiles.files[0].folderId);
    assert.equal(copiedFolder.name, 'Code');
  } finally {
    if (running) await stop(running.server);
    await rm(storageRoot, { recursive: true, force: true });
  }
});

async function start(storageRoot, maxUploadBytes, storageLimitBytes, options = {}) {
  const server = await createApiServer({ storageRoot, maxUploadBytes, storageLimitBytes,
    demoPlanSwitchEnabled: true, ...options });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

test('unpaid plan changes are disabled unless the local demo opts in', async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'dropvault-plan-gate-test-'));
  let running;
  try {
    running = await start(storageRoot, 32, 4, { demoPlanSwitchEnabled: false });
    assert.deepEqual(await (await nativeFetch(`${running.base}/v1/capabilities`)).json(),
      { demoPlanSwitchEnabled: false });
    await register(running.base);
    const blocked = await fetch(`${running.base}/v1/account/plan`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tier: 'demo' }),
    });
    assert.equal(blocked.status, 403);
    assert.equal((await blocked.json()).error.code, 'DEMO_PLAN_DISABLED');
    assert.equal((await (await fetch(`${running.base}/v1/account`)).json()).tier, 'free');
    assert.equal((await (await fetch(`${running.base}/v1/storage/usage`)).json()).limitBytes, 4);
  } finally {
    if (running) await stop(running.server);
    await rm(storageRoot, { recursive: true, force: true });
  }
});

test('demo plan startup setting rejects an exposed host or S3 backend', async () => {
  assert.throws(() => apiListenOptions({ demoPlanSetting: '1', host: '0.0.0.0' }),
    /loopback host/u);
  assert.throws(() => apiListenOptions({ demoPlanSetting: '1', storageBackend: 's3' }),
    /local storage/u);
  await assert.rejects(() => createApiServer({ storageRoot: 'unused',
    productionStorage: { databaseUrl: 'postgres://invalid', bucket: 'test', region: 'us-east-1' },
    demoPlanSwitchEnabled: true }), /cannot be enabled with S3/u);
});

test('reset-style listen options enable the local demo plan switch', () => {
  const options = apiListenOptions({ storageLimitBytes: 104857600, demoPlanSetting: '1' });
  assert.equal(options.demoPlanSwitchEnabled, true);
  assert.equal(options.storageLimitBytes, 104857600);
  assert.equal(apiListenOptions({ demoPlanSwitchEnabled: true }).demoPlanSwitchEnabled, true);
});

async function stop(server) {
  server.closeAllConnections();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

test('upload multiple file types, browse folders, download, and retain metadata after restart', async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'dropvault-api-test-'));
  let running;
  try {
    running = await start(storageRoot, 32);
    const health = await fetch(`${running.base}/v1/health`);
    assert.deepEqual(await health.json(), { status: 'ok' });
    await register(running.base);

    const folderResponse = await fetch(`${running.base}/v1/folders`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Reports' }),
    });
    assert.equal(folderResponse.status, 201);
    const folder = await folderResponse.json();

    const uploads = [
      { name: 'report.pdf', type: 'application/pdf', bytes: Buffer.from('%PDF-1.4 test') },
      { name: 'notes.txt', type: 'text/plain', bytes: Buffer.from('hello Dropvault') },
    ];
    const files = await Promise.all(uploads.map(async ({ name, type, bytes }) => {
      const response = await fetch(`${running.base}/v1/files?name=${encodeURIComponent(name)}&folderId=${folder.id}`, {
        method: 'POST', headers: { 'Content-Type': type }, body: bytes,
      });
      assert.equal(response.status, 201);
      return response.json();
    }));
    assert.deepEqual(files.map((file) => file.name).sort(), ['notes.txt', 'report.pdf']);
    assert.ok(files.every((file) => !('storageKey' in file)));

    const listing = await fetch(`${running.base}/v1/folders/${folder.id}/children`);
    assert.equal((await listing.json()).files.length, 2);
    const content = await fetch(`${running.base}/v1/files/${files[0].id}/content?download=1`);
    assert.equal(content.headers.get('content-disposition').startsWith('attachment'), true);
    assert.deepEqual(Buffer.from(await content.arrayBuffer()), uploads[0].bytes);

    const invalid = await fetch(`${running.base}/v1/files?name=bad%2Fname`, { method: 'POST', body: 'x' });
    assert.equal(invalid.status, 400);
    const oversized = await fetch(`${running.base}/v1/files?name=too-big.txt`, {
      method: 'POST', body: Buffer.alloc(33),
    });
    assert.equal(oversized.status, 413);
    const chunkedOversized = await fetch(`${running.base}/v1/files?name=chunked-too-big.txt`, {
      method: 'POST', duplex: 'half',
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(Buffer.alloc(33));
          controller.close();
        },
      }),
    });
    assert.equal(chunkedOversized.status, 413);
    assert.equal((await readdir(join(storageRoot, 'originals'))).length, 2);
    assert.equal((await readdir(join(storageRoot, 'tmp'))).length, 0);

    await stop(running.server);
    running = await start(storageRoot, 32);
    const persisted = await fetch(`${running.base}/v1/folders/${folder.id}/children`);
    assert.equal((await persisted.json()).files.length, 2);
  } finally {
    if (running) await stop(running.server);
    await rm(storageRoot, { recursive: true, force: true });
  }
});

test('workspace snapshots pin exact versions, preserve quota, and enforce live file access', async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'dropvault-snapshot-test-'));
  let running;
  try {
    running = await start(storageRoot, 100, 20);
    await register(running.base);
    const ownerCookie = activeCookie;
    const requestJson = (path, method, body) => fetch(`${running.base}${path}`, {
      method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    assert.equal((await requestJson('/v1/account/plan', 'POST', { tier: 'demo' })).status, 200);
    const upload = await fetch(`${running.base}/v1/files?name=results.txt`, {
      method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'first result',
    });
    assert.equal(upload.status, 201);
    const file = await upload.json();
    const secondUpload = await fetch(`${running.base}/v1/files?name=methods.txt`, {
      method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'method one',
    });
    assert.equal(secondUpload.status, 201);
    const secondFile = await secondUpload.json();
    const workspaceResponse = await requestJson('/v1/workspaces', 'POST',
      { name: 'Study', description: 'Trial one' });
    assert.equal(workspaceResponse.status, 201);
    const workspace = await workspaceResponse.json();
    assert.equal((await requestJson(`/v1/workspaces/${workspace.id}/files`, 'POST',
      { fileId: file.id })).status, 200);
    assert.equal((await requestJson(`/v1/workspaces/${workspace.id}/files`, 'POST',
      { fileId: secondFile.id })).status, 200);
    const usageBefore = await (await fetch(`${running.base}/v1/storage/usage`)).json();
    const snapshotResponse = await requestJson(`/v1/workspaces/${workspace.id}/snapshots`, 'POST',
      { name: 'First analysis', note: 'Submitted result', fileIds: [file.id, secondFile.id] });
    assert.equal(snapshotResponse.status, 201);
    const snapshot = await snapshotResponse.json();
    assert.equal(snapshot.items[0].versionId, file.currentVersionId);
    assert.equal(snapshot.items[0].name, 'results.txt');
    assert.deepEqual(await (await fetch(`${running.base}/v1/storage/usage`)).json(), usageBefore);
    assert.equal((await requestJson(`/v1/workspaces/${workspace.id}/snapshots`, 'POST',
      { name: 'Wrong file', note: '', fileIds: ['missing'] })).status, 400);

    const replacement = await fetch(`${running.base}/v1/files/${file.id}/versions`, {
      method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'second result',
    });
    assert.equal(replacement.status, 201);
    const reviewedVersionChanged = await requestJson(`/v1/workspaces/${workspace.id}/snapshots`,
      'POST', { name: 'Stale review', note: '', fileIds: [file.id, secondFile.id],
        expectedVersions: [
          { fileId: file.id, versionId: file.currentVersionId },
          { fileId: secondFile.id, versionId: secondFile.currentVersionId },
        ] });
    assert.equal(reviewedVersionChanged.status, 409);
    assert.equal((await reviewedVersionChanged.json()).error.code, 'SNAPSHOT_FILES_CHANGED');
    const mismatchedSelection = await requestJson(`/v1/workspaces/${workspace.id}/snapshots`,
      'POST', { name: 'Invalid review', note: '', fileIds: [file.id],
        expectedVersions: [{ fileId: secondFile.id, versionId: secondFile.currentVersionId }] });
    assert.equal(mismatchedSelection.status, 400);
    assert.equal((await requestJson(`/v1/files/${file.id}`, 'PATCH',
      { name: 'renamed.txt' })).status, 200);
    const movedFolder = await (await requestJson('/v1/folders', 'POST', { name: 'Archive' })).json();
    assert.equal((await requestJson(`/v1/files/${file.id}`, 'PATCH',
      { folderId: movedFolder.id })).status, 200);
    assert.equal(await (await fetch(`${running.base}/v1/snapshots/${snapshot.id}/files/${file.id}/content`)).text(),
      'first result');
    assert.equal((await (await fetch(`${running.base}/v1/snapshots/${snapshot.id}`)).json()).items[0].name,
      'results.txt');
    assert.equal((await (await fetch(`${running.base}/v1/snapshots/${snapshot.id}`)).json()).items[0].folderId,
      'root');
    const archive = await fetch(`${running.base}/v1/snapshots/${snapshot.id}/archive`);
    assert.equal(archive.status, 200);
    assert.match(archive.headers.get('content-type'), /application\/x-tar/u);
    const tar = Buffer.from(await archive.arrayBuffer());
    const manifestLength = Number.parseInt(tar.subarray(124, 136).toString('ascii').trim(), 8);
    const manifest = JSON.parse(tar.subarray(512, 512 + manifestLength).toString('utf8'));
    assert.equal(manifest.snapshotId, snapshot.id);
    assert.deepEqual(manifest.files.map((item) => item.name), ['results.txt', 'methods.txt']);
    const firstFileOffset = 512 + Math.ceil(manifestLength / 512) * 512 + 512;
    assert.equal(tar.subarray(firstFileOffset, firstFileOffset + file.size).toString(), 'first result');
    const blocked = await fetch(`${running.base}/v1/files/${file.id}`, { method: 'DELETE' });
    assert.equal(blocked.status, 409);
    assert.equal((await blocked.json()).error.code, 'FILE_IN_SNAPSHOT');
    assert.equal((await fetch(`${running.base}/v1/workspaces/${workspace.id}`, { method: 'DELETE' })).status, 409);

    await register(running.base, 'reader@example.test');
    const readerCookie = activeCookie;
    assert.equal((await fetch(`${running.base}/v1/snapshots/${snapshot.id}`)).status, 404);
    activeCookie = ownerCookie;
    const prematureShare = await requestJson(`/v1/snapshots/${snapshot.id}/access`, 'POST',
      { email: 'reader@example.test' });
    assert.equal(prematureShare.status, 409);
    assert.equal((await prematureShare.json()).error.code, 'SNAPSHOT_ACCESS_INCOMPLETE');
    assert.equal((await requestJson(`/v1/files/${file.id}/access`, 'POST',
      { email: 'reader@example.test' })).status, 201);
    assert.equal((await requestJson(`/v1/snapshots/${snapshot.id}/access`, 'POST',
      { email: 'reader@example.test' })).status, 409);
    assert.equal((await requestJson(`/v1/files/${secondFile.id}/access`, 'POST',
      { email: 'reader@example.test' })).status, 201);
    assert.equal((await requestJson(`/v1/snapshots/${snapshot.id}/access`, 'POST',
      { email: 'reader@example.test' })).status, 201);
    activeCookie = readerCookie;
    assert.equal((await fetch(`${running.base}/v1/snapshots/${snapshot.id}`)).status, 200);
    assert.equal(await (await fetch(`${running.base}/v1/snapshots/${snapshot.id}/files/${file.id}/content`)).text(),
      'first result');
    assert.equal((await fetch(`${running.base}/v1/snapshots/${snapshot.id}/copy`, {
      method: 'POST',
    })).status, 507);
    assert.equal((await requestJson('/v1/account/plan', 'POST', { tier: 'demo' })).status, 200);
    const copiedResponse = await fetch(`${running.base}/v1/snapshots/${snapshot.id}/copy`, { method: 'POST' });
    assert.equal(copiedResponse.status, 201);
    const copiedWorkspace = await copiedResponse.json();
    const copiedFiles = await (await fetch(`${running.base}/v1/workspaces/${copiedWorkspace.id}/files`)).json();
    assert.equal(copiedFiles.files.length, 2);
    assert.equal(await (await fetch(`${running.base}/v1/files/${copiedFiles.files[0].id}/content`)).text(),
      'first result');
    assert.equal((await (await fetch(`${running.base}/v1/storage/usage`)).json()).usedBytes,
      file.size + secondFile.size);
    assert.equal((await fetch(`${running.base}/v1/workspaces/${workspace.id}`)).status, 404);
    activeCookie = ownerCookie;
    const access = await (await fetch(`${running.base}/v1/files/${secondFile.id}/access`)).json();
    assert.equal(access.users.length, 1);
    assert.equal((await fetch(`${running.base}/v1/files/${secondFile.id}/access/${access.users[0].userId}`, {
      method: 'DELETE',
    })).status, 204);
    activeCookie = readerCookie;
    assert.equal((await fetch(`${running.base}/v1/snapshots/${snapshot.id}`)).status, 404);
    assert.equal((await fetch(`${running.base}/v1/snapshots/${snapshot.id}/files/${file.id}/content`)).status, 404);
    activeCookie = ownerCookie;
    assert.equal((await (await fetch(`${running.base}/v1/snapshots/${snapshot.id}/access`)).json()).users.length, 0);
    assert.equal((await requestJson(`/v1/files/${secondFile.id}/access`, 'POST',
      { email: 'reader@example.test' })).status, 201);
    activeCookie = readerCookie;
    assert.equal((await fetch(`${running.base}/v1/snapshots/${snapshot.id}`)).status, 404);
    activeCookie = ownerCookie;

    await stop(running.server);
    running = await start(storageRoot, 100, 20);
    assert.equal(await (await fetch(`${running.base}/v1/snapshots/${snapshot.id}/files/${file.id}/content`)).text(),
      'first result');
    assert.equal((await fetch(`${running.base}/v1/snapshots/${snapshot.id}`, { method: 'DELETE' })).status, 204);
    assert.equal((await fetch(`${running.base}/v1/files/${file.id}`, { method: 'DELETE' })).status, 204);
    assert.equal((await fetch(`${running.base}/v1/workspaces/${workspace.id}`, { method: 'DELETE' })).status, 204);
  } finally {
    if (running) await stop(running.server);
    await rm(storageRoot, { recursive: true, force: true });
  }
});

test('workspace viewers and contributors use live files within their roles', async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'dropvault-team-test-'));
  let running;
  try {
    running = await start(storageRoot, 100, 100);
    await register(running.base, 'project-owner@example.test');
    const ownerCookie = activeCookie;
    const requestJson = (path, method, body) => fetch(`${running.base}${path}`, {
      method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const workspace = await (await requestJson('/v1/workspaces', 'POST',
      { name: 'Shared study', description: '' })).json();
    const original = await (await fetch(`${running.base}/v1/workspaces/${workspace.id}/uploads?name=data.txt`, {
      method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'initial',
    })).json();
    await register(running.base, 'viewer@example.test');
    const viewerCookie = activeCookie;
    await register(running.base, 'contributor@example.test');
    const contributorCookie = activeCookie;
    activeCookie = ownerCookie;
    const viewerGrant = await requestJson(`/v1/workspaces/${workspace.id}/access`, 'POST',
      { email: 'viewer@example.test', role: 'viewer' });
    assert.equal(viewerGrant.status, 201);
    const viewer = await viewerGrant.json();
    assert.equal((await requestJson(`/v1/workspaces/${workspace.id}/access`, 'POST',
      { email: 'contributor@example.test', role: 'contributor' })).status, 201);

    activeCookie = viewerCookie;
    assert.equal((await fetch(`${running.base}/v1/workspaces/${workspace.id}`)).status, 200);
    assert.equal(await (await fetch(`${running.base}/v1/workspaces/${workspace.id}/files/${original.id}/content`)).text(),
      'initial');
    assert.equal((await fetch(`${running.base}/v1/files/${original.id}/content`)).status, 404);
    assert.equal((await fetch(`${running.base}/v1/workspaces/${workspace.id}/uploads?name=wrong.txt`, {
      method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'no',
    })).status, 404);
    assert.equal((await requestJson(`/v1/workspaces/${workspace.id}/snapshots`, 'POST',
      { name: 'Unauthorized', note: '', fileIds: [original.id] })).status, 404);

    activeCookie = contributorCookie;
    const contributed = await fetch(`${running.base}/v1/workspaces/${workspace.id}/uploads?name=notes.txt`, {
      method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'draft',
    });
    assert.equal(contributed.status, 201);
    const added = await contributed.json();
    assert.equal(added.ownerId, workspace.ownerId);
    assert.equal((await (await fetch(`${running.base}/v1/storage/usage`)).json()).usedBytes, 0);
    assert.equal((await fetch(`${running.base}/v1/files/${added.id}/content`)).status, 404);
    activeCookie = ownerCookie;
    assert.equal((await (await fetch(`${running.base}/v1/storage/usage`)).json()).usedBytes, 12);
    const snapshot = await (await requestJson(`/v1/workspaces/${workspace.id}/snapshots`, 'POST',
      { name: 'Draft', note: '', fileIds: [added.id] })).json();
    activeCookie = contributorCookie;
    const replacement = await fetch(`${running.base}/v1/workspaces/${workspace.id}/files/${added.id}/versions`, {
      method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'final',
    });
    assert.equal(replacement.status, 201);
    assert.equal(await (await fetch(`${running.base}/v1/snapshots/${snapshot.id}/files/${added.id}/content`)).text(),
      'draft');
    assert.equal(await (await fetch(`${running.base}/v1/workspaces/${workspace.id}/files/${added.id}/content`)).text(),
      'final');
    assert.equal((await fetch(`${running.base}/v1/files/${added.id}`, { method: 'DELETE' })).status, 404);

    activeCookie = ownerCookie;
    assert.equal((await fetch(`${running.base}/v1/workspaces/${workspace.id}/access/${viewer.userId}`, {
      method: 'DELETE',
    })).status, 204);
    activeCookie = viewerCookie;
    assert.equal((await fetch(`${running.base}/v1/workspaces/${workspace.id}`)).status, 404);
    assert.equal((await fetch(`${running.base}/v1/workspaces/${workspace.id}/files/${original.id}/content`)).status, 404);
    assert.equal((await fetch(`${running.base}/v1/snapshots/${snapshot.id}`)).status, 404);
  } finally {
    if (running) await stop(running.server);
    await rm(storageRoot, { recursive: true, force: true });
  }
});

test('owner can rename and move files and folders without changing file bytes or access', async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'dropvault-manage-test-'));
  let running;
  try {
    running = await start(storageRoot, 100, 100);
    await register(running.base);
    const ownerCookie = activeCookie;
    const sendJson = (path, method, body) => fetch(`${running.base}${path}`, {
      method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const makeFolder = async (name, parentId = 'root') => {
      const response = await sendJson('/v1/folders', 'POST', { name, parentId });
      assert.equal(response.status, 201);
      return response.json();
    };
    const projects = await makeFolder('Projects');
    const drafts = await makeFolder('Drafts', projects.id);
    const archive = await makeFolder('Archive');
    const upload = await fetch(`${running.base}/v1/files?name=notes.txt&folderId=${drafts.id}`, {
      method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'saved bytes',
    });
    assert.equal(upload.status, 201);
    const file = await upload.json();

    const folderList = await (await fetch(`${running.base}/v1/folders`)).json();
    assert.equal(folderList.folders.length, 3);
    const renamed = await sendJson(`/v1/files/${file.id}`, 'PATCH',
      { name: 'final.txt', folderId: archive.id });
    assert.equal(renamed.status, 200);
    assert.equal((await renamed.json()).folderId, archive.id);
    assert.equal((await (await fetch(`${running.base}/v1/folders/${drafts.id}/children`)).json()).files.length, 0);
    assert.equal((await (await fetch(`${running.base}/v1/folders/${archive.id}/children`)).json()).files[0].name,
      'final.txt');
    assert.equal(await (await fetch(`${running.base}/v1/files/${file.id}/content`)).text(), 'saved bytes');
    assert.equal((await (await fetch(`${running.base}/v1/storage/usage`)).json()).usedBytes, 11);

    const moved = await sendJson(`/v1/folders/${projects.id}`, 'PATCH',
      { name: 'Work', parentId: archive.id });
    assert.equal(moved.status, 200);
    assert.equal((await moved.json()).parentId, archive.id);
    assert.equal((await (await fetch(`${running.base}/v1/folders/${archive.id}/children`)).json()).folders[0].name,
      'Work');
    const cycle = await sendJson(`/v1/folders/${archive.id}`, 'PATCH', { parentId: drafts.id });
    assert.equal(cycle.status, 409);
    assert.equal((await cycle.json()).error.code, 'FOLDER_CYCLE');
    const existing = await makeFolder('Existing', archive.id);
    const conflict = await sendJson(`/v1/folders/${projects.id}`, 'PATCH', { name: existing.name });
    assert.equal(conflict.status, 409);
    assert.equal((await conflict.json()).error.code, 'NAME_CONFLICT');
    const extension = await sendJson(`/v1/files/${file.id}`, 'PATCH', { name: 'final.pdf' });
    assert.equal(extension.status, 400);
    assert.equal((await extension.json()).error.code, 'FILE_EXTENSION_CHANGE');
    assert.equal((await sendJson(`/v1/files/${file.id}`, 'PATCH', { folderId: 'missing' })).status, 404);
    assert.equal((await sendJson(`/v1/folders/${projects.id}`, 'PATCH', { parentId: 'missing' })).status, 404);
    assert.equal((await sendJson('/v1/folders/root', 'PATCH', { name: 'Other' })).status, 400);

    await register(running.base, 'other@example.test');
    const recipientCookie = activeCookie;
    const privateFolder = await makeFolder('Private');
    assert.equal((await fetch(`${running.base}/v1/folders`)).status, 200);
    assert.equal((await (await fetch(`${running.base}/v1/folders`)).json()).folders.length, 1);
    assert.equal((await sendJson(`/v1/files/${file.id}`, 'PATCH', { name: 'stolen.txt' })).status, 404);
    assert.equal((await sendJson(`/v1/folders/${projects.id}`, 'PATCH', { name: 'Stolen' })).status, 404);
    activeCookie = ownerCookie;
    assert.equal((await sendJson(`/v1/files/${file.id}`, 'PATCH',
      { folderId: privateFolder.id })).status, 404);
    const grant = await sendJson(`/v1/files/${file.id}/access`, 'POST',
      { email: 'other@example.test' });
    assert.equal(grant.status, 201);
    activeCookie = recipientCookie;
    assert.equal(await (await fetch(`${running.base}/v1/files/${file.id}/content`)).text(), 'saved bytes');
    assert.equal((await sendJson(`/v1/files/${file.id}`, 'PATCH', { name: 'stolen.txt' })).status, 404);
    activeCookie = ownerCookie;

    await stop(running.server);
    running = await start(storageRoot, 100, 100);
    const persisted = await (await fetch(`${running.base}/v1/files/${file.id}`)).json();
    assert.equal(persisted.name, 'final.txt');
    assert.equal(persisted.folderId, archive.id);
    assert.equal((await (await fetch(`${running.base}/v1/folders/${archive.id}/children`)).json())
      .folders[0].name, 'Work');
  } finally {
    if (running) await stop(running.server);
    await rm(storageRoot, { recursive: true, force: true });
  }
});

test('cap concurrent uploads, persist shares, and reclaim usage on deletion', async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'dropvault-usage-test-'));
  let running;
  try {
    running = await start(storageRoot, 32, 20);
    await register(running.base);
    const usage = async () => (await fetch(`${running.base}/v1/storage/usage`)).json();
    assert.deepEqual(await usage(), { usedBytes: 0, limitBytes: 20, tier: 'free' });

    const folderResponse = await fetch(`${running.base}/v1/folders`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Shared' }),
    });
    const folder = await folderResponse.json();
    assert.equal(folderResponse.status, 201);

    const attempts = await Promise.all(['one.txt', 'two.txt'].map(async (name) => {
      const response = await fetch(`${running.base}/v1/files?name=${name}&folderId=${folder.id}`, {
        method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: Buffer.alloc(12, 'a'),
      });
      return { status: response.status, body: await response.json() };
    }));
    assert.deepEqual(attempts.map((attempt) => attempt.status).sort(), [201, 507]);
    assert.equal(attempts.find((attempt) => attempt.status === 507).body.error.code, 'STORAGE_CAP_EXCEEDED');
    const file = attempts.find((attempt) => attempt.status === 201).body;
    assert.deepEqual(await usage(), { usedBytes: 12, limitBytes: 20, tier: 'free' });
    assert.equal((await readdir(join(storageRoot, 'originals'))).length, 1);

    const shareResponse = await fetch(`${running.base}/v1/files/${file.id}/shares`, { method: 'POST' });
    assert.equal(shareResponse.status, 201);
    const share = await shareResponse.json();
    assert.equal(share.token.length, 43);
    assert.ok(Date.parse(share.expiresAt) > Date.now());
    assert.equal(share.url, `/v1/shares/${share.token}`);
    const links = await (await fetch(`${running.base}/v1/files/${file.id}/shares`)).json();
    assert.equal(links.links[0].id, share.id);
    assert.equal('token' in links.links[0], false);
    assert.equal((await readFile(join(storageRoot, 'catalog.json'), 'utf8')).includes(share.token), false);
    assert.deepEqual(Buffer.from(await (await fetch(new URL(share.url, running.base))).arrayBuffer()),
      Buffer.alloc(12, 'a'));

    await stop(running.server);
    running = await start(storageRoot, 32, 20);
    assert.deepEqual(Buffer.from(await (await fetch(`${running.base}/v1/shares/${share.token}`)).arrayBuffer()),
      Buffer.alloc(12, 'a'));

    const full = await fetch(`${running.base}/v1/files?name=full.txt`, {
      method: 'POST', body: Buffer.alloc(8, 'b'),
    });
    assert.equal(full.status, 201);
    const secondFile = await full.json();
    assert.deepEqual(await usage(), { usedBytes: 20, limitBytes: 20, tier: 'free' });
    const overCap = await fetch(`${running.base}/v1/files?name=over.txt`, { method: 'POST', body: 'x' });
    assert.equal(overCap.status, 507);
    assert.equal((await overCap.json()).error.code, 'STORAGE_CAP_EXCEEDED');
    const exactUploadLimit = await fetch(`${running.base}/v1/files?name=exact-limit.txt`, {
      method: 'POST', body: Buffer.alloc(32),
    });
    assert.equal(exactUploadLimit.status, 507);
    const chunkedOverCap = await fetch(`${running.base}/v1/files?name=chunked.txt`, {
      method: 'POST', duplex: 'half',
      body: new ReadableStream({
        start(controller) { controller.enqueue(Buffer.from('x')); controller.close(); },
      }),
    });
    assert.equal(chunkedOverCap.status, 507);
    assert.equal((await readdir(join(storageRoot, 'tmp'))).length, 0);

    const nonempty = await fetch(`${running.base}/v1/folders/${folder.id}`, { method: 'DELETE' });
    assert.equal(nonempty.status, 409);
    assert.equal((await nonempty.json()).error.code, 'FOLDER_NOT_EMPTY');
    assert.equal((await fetch(`${running.base}/v1/files/${file.id}`, { method: 'DELETE' })).status, 204);
    assert.deepEqual(await usage(), { usedBytes: 8, limitBytes: 20, tier: 'free' });
    assert.equal((await fetch(`${running.base}/v1/shares/${share.token}`)).status, 404);
    assert.equal((await fetch(`${running.base}/v1/folders/${folder.id}`, { method: 'DELETE' })).status, 204);
    assert.equal((await fetch(`${running.base}/v1/files/${secondFile.id}`, { method: 'DELETE' })).status, 204);
    assert.deepEqual(await usage(), { usedBytes: 0, limitBytes: 20, tier: 'free' });
    assert.equal((await readdir(join(storageRoot, 'originals'))).length, 0);
  } finally {
    if (running) await stop(running.server);
    await rm(storageRoot, { recursive: true, force: true });
  }
});

test('owner can revoke a bearer link while recipients cannot manage it', async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'dropvault-revoke-test-'));
  let running;
  try {
    running = await start(storageRoot, 100, 100);
    await register(running.base);
    const ownerCookie = activeCookie;
    const upload = await fetch(`${running.base}/v1/files?name=hello.txt`, {
      method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'hello',
    });
    const file = await upload.json();
    const share = await (await fetch(`${running.base}/v1/files/${file.id}/shares`,
      { method: 'POST' })).json();
    await register(running.base, 'recipient@example.test');
    assert.equal((await fetch(`${running.base}/v1/files/${file.id}/shares/${share.id}`,
      { method: 'DELETE' })).status, 404);
    assert.equal((await nativeFetch(new URL(share.url, running.base))).status, 200);
    assert.equal((await nativeFetch(`${running.base}/v1/files/${file.id}/shares/${share.id}`,
      { method: 'DELETE', headers: { Cookie: ownerCookie } })).status, 204);
    assert.equal((await nativeFetch(new URL(share.url, running.base))).status, 404);
  } finally {
    if (running) await stop(running.server);
    await rm(storageRoot, { recursive: true, force: true });
  }
});

test('existing catalogs without shares remain usable', async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'dropvault-migration-test-'));
  let running;
  try {
    await writeFile(join(storageRoot, 'catalog.json'),
      JSON.stringify({ schemaVersion: 1, folders: [], files: [] }));
    running = await start(storageRoot, 32, 20);
    await register(running.base);
    const upload = await fetch(`${running.base}/v1/files?name=legacy.txt`, {
      method: 'POST', body: 'hello',
    });
    assert.equal(upload.status, 201);
    const file = await upload.json();
    assert.equal((await fetch(`${running.base}/v1/files/${file.id}/shares`, { method: 'POST' })).status, 201);
    const catalog = JSON.parse(await readFile(join(storageRoot, 'catalog.json'), 'utf8'));
    assert.equal(catalog.shares.length, 1);
  } finally {
    if (running) await stop(running.server);
    await rm(storageRoot, { recursive: true, force: true });
  }
});

test('two accounts enforce file ownership, grants, and per-account quota', async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'dropvault-accounts-test-'));
  let running;
  try {
    running = await start(storageRoot, 32, 20);
    const owner = await register(running.base, 'owner@example.test');
    const ownerCookie = activeCookie;
    const recipient = await register(running.base, 'recipient@example.test');
    const recipientCookie = activeCookie;
    const request = (cookie, path, options = {}) => nativeFetch(`${running.base}${path}`, {
      ...options, headers: { ...options.headers, Cookie: cookie },
    });

    const noSession = await nativeFetch(`${running.base}/v1/folders/root/children`);
    assert.equal(noSession.status, 401);
    assert.equal((await noSession.json()).error.code, 'UNAUTHENTICATED');

    const folderResponse = await request(ownerCookie, '/v1/folders', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Private' }),
    });
    const folder = await folderResponse.json();
    assert.equal(folder.ownerId, owner.id);
    assert.equal((await request(recipientCookie, `/v1/folders/${folder.id}/children`)).status, 404);

    const fileResponse = await request(ownerCookie,
      `/v1/files?name=secret.pdf&folderId=${folder.id}`, {
        method: 'POST', headers: { 'Content-Type': 'application/pdf' }, body: Buffer.from('%PDF-test'),
      });
    assert.equal(fileResponse.status, 201);
    const file = await fileResponse.json();
    assert.equal(file.ownerId, owner.id);
    assert.equal((await request(recipientCookie, `/v1/files/${file.id}`)).status, 404);
    assert.equal((await request(recipientCookie, `/v1/files/${file.id}/content`)).status, 404);
    assert.equal((await request(recipientCookie, `/v1/files/${file.id}`, { method: 'DELETE' })).status, 404);
    assert.equal((await request(recipientCookie, `/v1/files/${file.id}/shares`, { method: 'POST' })).status, 404);
    assert.deepEqual((await (await request(recipientCookie, '/v1/files/shared')).json()).files, []);

    const grant = await request(ownerCookie, `/v1/files/${file.id}/access`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'recipient@example.test' }),
    });
    assert.equal(grant.status, 201);
    assert.equal((await grant.json()).userId, recipient.id);
    assert.equal((await (await request(ownerCookie, `/v1/files/${file.id}/access`)).json()).users.length, 1);
    assert.equal((await (await request(recipientCookie, '/v1/files/shared')).json()).files.length, 1);
    assert.equal((await request(recipientCookie, `/v1/files/${file.id}`)).status, 200);
    assert.equal((await request(recipientCookie, `/v1/files/${file.id}/content?download=1`)).status, 200);
    assert.equal((await request(recipientCookie, `/v1/files/${file.id}/access`)).status, 404);
    assert.deepEqual(await (await request(ownerCookie, '/v1/storage/usage')).json(),
      { usedBytes: 9, limitBytes: 20, tier: 'free' });
    assert.deepEqual(await (await request(recipientCookie, '/v1/storage/usage')).json(),
      { usedBytes: 0, limitBytes: 20, tier: 'free' });

    assert.equal((await request(ownerCookie, `/v1/files/${file.id}/access/${recipient.id}`,
      { method: 'DELETE' })).status, 204);
    assert.equal((await request(recipientCookie, `/v1/files/${file.id}`)).status, 404);

    const invalidPdf = await request(ownerCookie, '/v1/files?name=wrong.pdf', {
      method: 'POST', headers: { 'Content-Type': 'application/pdf' }, body: 'not a PDF',
    });
    assert.equal(invalidPdf.status, 415);
    assert.equal((await invalidPdf.json()).error.code, 'INVALID_FILE_CONTENT');
    assert.equal((await readdir(join(storageRoot, 'originals'))).length, 1);

    const blocked = await request(ownerCookie, '/v1/files?name=large.txt', {
      method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: Buffer.alloc(12, 'x'),
    });
    assert.equal(blocked.status, 507);
    const upgrade = await request(ownerCookie, '/v1/account/plan', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tier: 'demo' }),
    });
    assert.equal((await upgrade.json()).tier, 'demo');
    assert.equal((await request(ownerCookie, '/v1/files?name=large.txt', {
      method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: Buffer.alloc(12, 'x'),
    })).status, 201);
    assert.deepEqual(await (await request(ownerCookie, '/v1/storage/usage')).json(),
      { usedBytes: 21, limitBytes: 200, tier: 'demo' });
    assert.equal((await request(ownerCookie, '/v1/account/plan', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tier: 'free' }),
    })).status, 200);
    assert.equal((await request(ownerCookie, `/v1/files/${file.id}/content`)).status, 200);
    assert.equal((await request(ownerCookie, '/v1/files?name=extra.txt', {
      method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'x',
    })).status, 507);

    await stop(running.server);
    running = await start(storageRoot, 32, 20);
    assert.equal((await request(ownerCookie, `/v1/files/${file.id}`)).status, 200);
    assert.equal((await request(recipientCookie, `/v1/files/${file.id}`)).status, 404);
  } finally {
    if (running) await stop(running.server);
    await rm(storageRoot, { recursive: true, force: true });
  }
});

test('login, logout, and explicit legacy claim protect old files', async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'dropvault-login-test-'));
  let running;
  try {
    const fileId = '33333333-3333-4333-8333-333333333333';
    const storageKey = 'legacy-file';
    await writeFile(join(storageRoot, 'catalog.json'), JSON.stringify({
      schemaVersion: 1, folders: [], shares: [], files: [{ id: fileId, name: 'old.txt',
        folderId: 'root', mimeType: 'text/plain', size: 3, createdAt: new Date().toISOString(),
        storageKey }],
    }));
    running = await start(storageRoot, 32, 20,
      { legacyClaimToken: 'local-migration-token-with-32-plus-characters' });
    const owner = await register(running.base);
    assert.equal((await fetch(`${running.base}/v1/files/${fileId}`)).status, 404);
    const badClaim = await fetch(`${running.base}/v1/account/claim-legacy`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'wrong token' }),
    });
    assert.equal(badClaim.status, 403);
    const claim = await fetch(`${running.base}/v1/account/claim-legacy`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'local-migration-token-with-32-plus-characters' }),
    });
    assert.equal(claim.status, 200);
    assert.deepEqual(await claim.json(), { filesClaimed: 1, foldersClaimed: 0 });
    assert.equal((await (await fetch(`${running.base}/v1/files/${fileId}`)).json()).ownerId, owner.id);

    const badLogin = await nativeFetch(`${running.base}/v1/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'owner@example.test', password: 'incorrect password' }),
    });
    assert.equal(badLogin.status, 401);
    const login = await nativeFetch(`${running.base}/v1/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'owner@example.test', password: 'correct horse battery staple' }),
    });
    assert.equal(login.status, 200);
    const loginCookie = login.headers.get('set-cookie').split(';', 1)[0];
    assert.equal((await nativeFetch(`${running.base}/v1/account`,
      { headers: { Cookie: loginCookie } })).status, 200);
    assert.equal((await nativeFetch(`${running.base}/v1/auth/logout`,
      { method: 'POST', headers: { Cookie: loginCookie } })).status, 204);
    assert.equal((await nativeFetch(`${running.base}/v1/account`,
      { headers: { Cookie: loginCookie } })).status, 401);
  } finally {
    if (running) await stop(running.server);
    await rm(storageRoot, { recursive: true, force: true });
  }
});

test('startup restores referenced bytes and preserves bytes absent from a restored catalog', async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'dropvault-recovery-test-'));
  let running;
  try {
    const preexisting = join(storageRoot, 'originals', '22222222-2222-4222-8222-222222222222');
    await mkdir(join(storageRoot, 'originals'));
    await writeFile(preexisting, 'preserve without a catalog');
    running = await start(storageRoot, 100, 100);
    assert.equal(await readFile(preexisting, 'utf8'), 'preserve without a catalog');
    await register(running.base);
    const upload = await fetch(`${running.base}/v1/files?name=restore.txt`, {
      method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'keep me',
    });
    const file = await upload.json();
    const catalogPath = join(storageRoot, 'catalog.json');
    const catalog = JSON.parse(await readFile(catalogPath, 'utf8'));
    const storageKey = catalog.files[0].storageKey;
    const original = join(storageRoot, 'originals', storageKey);
    const staged = join(storageRoot, 'tmp', `delete-${storageKey}.pending`);
    await stop(running.server);
    running = null;

    await rename(original, staged); // Process stopped after staging, before catalog change.
    const orphan = join(storageRoot, 'originals', '11111111-1111-4111-8111-111111111111');
    await writeFile(orphan, 'saved before catalog commit');
    running = await start(storageRoot, 100, 100);
    assert.equal((await readFile(original, 'utf8')), 'keep me');
    assert.equal(await readFile(preexisting, 'utf8'), 'preserve without a catalog');
    assert.equal(await readFile(orphan, 'utf8'), 'saved before catalog commit');
    assert.equal((await fetch(`${running.base}/v1/files/${file.id}/content`)).status, 200);
    assert.equal((await readdir(join(storageRoot, 'tmp'))).length, 0);
    await stop(running.server);
    running = null;

    await rename(original, staged);
    catalog.files = []; // An older catalog backup lacks the newer file.
    catalog.versions = [];
    await writeFile(catalogPath, JSON.stringify(catalog));
    running = await start(storageRoot, 100, 100);
    assert.equal((await fetch(`${running.base}/v1/files/${file.id}`)).status, 404);
    assert.equal(await readFile(staged, 'utf8'), 'keep me');
    assert.equal(await readFile(preexisting, 'utf8'), 'preserve without a catalog');
    assert.equal(await readFile(orphan, 'utf8'), 'saved before catalog commit');
  } finally {
    if (running) await stop(running.server);
    await rm(storageRoot, { recursive: true, force: true });
  }
});

test('startup preserves duplicate staged bytes without blocking a later delete', async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'dropvault-duplicate-stage-test-'));
  const key = '11111111-1111-4111-8111-111111111111';
  try {
    const storage = await openLocalStorage(storageRoot);
    const original = join(storageRoot, 'originals', key);
    await writeFile(original, 'catalog copy');
    await writeFile(join(storageRoot, 'tmp', `delete-${key}.pending`), 'pending copy');
    await storage.recoverDeletes([key]);
    assert.equal(await readFile(original, 'utf8'), 'catalog copy');
    const [review] = await readdir(join(storageRoot, 'tmp'));
    assert.match(review, /^review-11111111-1111-4111-8111-111111111111-[a-f0-9-]+\.pending$/u);
    assert.equal(await readFile(join(storageRoot, 'tmp', review), 'utf8'), 'pending copy');
    const staged = await storage.stageRemove(key);
    await staged.commit();
    assert.deepEqual(await readdir(join(storageRoot, 'tmp')), [review]);
  } finally {
    await rm(storageRoot, { recursive: true, force: true });
  }
});

test('cleanup failure returns committed deletion and leaves staged bytes for review', async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'dropvault-cleanup-test-'));
  let running;
  try {
    running = await start(storageRoot, 100, 100, {
      storageFactory: async (root) => {
        const storage = await openLocalStorage(root);
        return { ...storage, stageRemove: async (key) => {
          const staged = await storage.stageRemove(key);
          return { ...staged, commit: async () => { throw new Error('simulated cleanup failure'); } };
        } };
      },
    });
    await register(running.base);
    const upload = await fetch(`${running.base}/v1/files?name=remove.txt`, {
      method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'remove me',
    });
    const file = await upload.json();
    assert.equal((await fetch(`${running.base}/v1/files/${file.id}`, { method: 'DELETE' })).status, 204);
    assert.equal((await fetch(`${running.base}/v1/files/${file.id}`)).status, 404);
    assert.equal((await readdir(join(storageRoot, 'tmp'))).length, 1);
    await stop(running.server);
    running = await start(storageRoot, 100, 100);
    const pending = await readdir(join(storageRoot, 'tmp'));
    assert.equal(pending.length, 1);
    assert.equal(await readFile(join(storageRoot, 'tmp', pending[0]), 'utf8'), 'remove me');
  } finally {
    if (running) await stop(running.server);
    await rm(storageRoot, { recursive: true, force: true });
  }
});

test('deletion waits for an active download to finish', async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'dropvault-active-read-test-'));
  let running;
  try {
    let signalRead;
    const readStarted = new Promise((resolve) => { signalRead = resolve; });
    running = await start(storageRoot, 100, 100, {
      storageFactory: async (root) => {
        const storage = await openLocalStorage(root);
        return { ...storage, read: (key) => {
          const slow = new Transform({
            transform(chunk, encoding, callback) {
              setTimeout(() => callback(null, chunk), 100);
            },
          });
          signalRead();
          return storage.read(key).pipe(slow);
        } };
      },
    });
    await register(running.base);
    const upload = await fetch(`${running.base}/v1/files?name=active.txt`, {
      method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'complete download',
    });
    const file = await upload.json();
    const download = fetch(`${running.base}/v1/files/${file.id}/content`);
    await readStarted;
    const deletion = fetch(`${running.base}/v1/files/${file.id}`, { method: 'DELETE' });
    assert.equal(await (await download).text(), 'complete download');
    assert.equal((await deletion).status, 204);
    assert.equal((await fetch(`${running.base}/v1/files/${file.id}/content`)).status, 404);
  } finally {
    if (running) await stop(running.server);
    await rm(storageRoot, { recursive: true, force: true });
  }
});

test('Office uploads require package parts and share URL can use public origin', async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'dropvault-office-test-'));
  let running;
  try {
    running = await start(storageRoot, 2_000, 10_000,
      { publicBaseUrl: 'https://dropvault.example' });
    await register(running.base);
    const arbitraryZip = emptyZip(['notes.txt']);
    const invalid = await fetch(`${running.base}/v1/files?name=fake.docx`, {
      method: 'POST', headers: { 'Content-Type':
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
      body: arbitraryZip,
    });
    assert.equal(invalid.status, 415);
    for (const [extension, mimeType, part] of [
      ['docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'word/document.xml'],
      ['pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation', 'ppt/presentation.xml'],
      ['xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'xl/workbook.xml'],
    ]) {
      const response = await fetch(`${running.base}/v1/files?name=example.${extension}`, {
        method: 'POST', headers: { 'Content-Type': mimeType },
        body: emptyZip(['[Content_Types].xml', '_rels/.rels', part]),
      });
      assert.equal(response.status, 201, extension);
    }
    const file = (await (await fetch(`${running.base}/v1/folders/root/children`)).json()).files[0];
    const share = await (await fetch(`${running.base}/v1/files/${file.id}/shares`,
      { method: 'POST' })).json();
    assert.equal(share.url, `https://dropvault.example/v1/shares/${share.token}`);
  } finally {
    if (running) await stop(running.server);
    await rm(storageRoot, { recursive: true, force: true });
  }
});

test('login attempts are throttled before a valid password is checked', async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'dropvault-rate-test-'));
  let running;
  try {
    running = await start(storageRoot, 100, 100);
    await register(running.base);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await nativeFetch(`${running.base}/v1/auth/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'owner@example.test', password: 'wrong-password-long' }),
      });
      assert.equal(response.status, 401);
    }
    const blocked = await nativeFetch(`${running.base}/v1/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'owner@example.test', password: 'correct horse battery staple' }),
    });
    assert.equal(blocked.status, 429);
    assert.equal((await blocked.json()).error.code, 'RATE_LIMITED');
  } finally {
    if (running) await stop(running.server);
    await rm(storageRoot, { recursive: true, force: true });
  }
});

test('successful logins also count toward the per-IP attempt limit', async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'dropvault-login-volume-test-'));
  let running;
  try {
    running = await start(storageRoot, 100, 100);
    await register(running.base);
    const credentials = JSON.stringify({ email: 'owner@example.test',
      password: 'correct horse battery staple' });
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const response = await nativeFetch(`${running.base}/v1/auth/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: credentials,
      });
      assert.equal(response.status, 200);
    }
    const blocked = await nativeFetch(`${running.base}/v1/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: credentials,
    });
    assert.equal(blocked.status, 429);
  } finally {
    if (running) await stop(running.server);
    await rm(storageRoot, { recursive: true, force: true });
  }
});

test('a stalled upload does not block another account and excess uploads are rejected', async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'dropvault-queue-test-'));
  let running;
  let releaseUpload;
  let markUploadsStarted;
  const uploadsStarted = new Promise((resolve) => { markUploadsStarted = resolve; });
  const uploadGate = new Promise((resolve) => { releaseUpload = resolve; });
  const uploads = [];
  let started = 0;
  try {
    running = await start(storageRoot, 32_768, 1000, {
      storageFactory: async (root) => {
        const local = await openLocalStorage(root);
        return { ...local, async save(...args) {
          started += 1;
          if (started === 8) markUploadsStarted();
          await uploadGate;
          return local.save(...args);
        } };
      },
    });
    await register(running.base, 'uploader@example.test');
    const uploaderCookie = activeCookie;
    await register(running.base, 'other@example.test');
    const otherCookie = activeCookie;
    for (let index = 0; index < 8; index += 1) {
      uploads.push(nativeFetch(`${running.base}/v1/files?name=hold-${index}.txt`, {
        method: 'POST', headers: { Cookie: uploaderCookie }, body: 'hold',
      }));
    }
    await uploadsStarted;
    const plan = await nativeFetch(`${running.base}/v1/account/plan`, {
      method: 'POST', headers: { Cookie: otherCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ tier: 'demo' }),
    });
    assert.equal(plan.status, 200);
    assert.equal((await plan.json()).tier, 'demo');
    const rejected = await nativeFetch(`${running.base}/v1/files?name=extra.txt`, {
      method: 'POST', headers: { Cookie: uploaderCookie }, body: 'extra',
    });
    assert.equal(rejected.status, 503);
    assert.equal((await rejected.json()).error.code, 'SERVER_BUSY');
    let markRejectedUploadDrained;
    const rejectedUploadDrained = new Promise((resolve) => { markRejectedUploadDrained = resolve; });
    running.server.on('request', (request) => {
      if (request.url === '/v1/files?name=blocked.txt') {
        request.on('end', markRejectedUploadDrained);
      }
    });
    const rejectedUpload = await nativeFetch(`${running.base}/v1/files?name=blocked.txt`, {
      method: 'POST', headers: { Cookie: uploaderCookie }, body: Buffer.alloc(20_000),
    });
    assert.equal(rejectedUpload.status, 503);
    await rejectedUploadDrained;
    releaseUpload();
    const results = await Promise.all(uploads);
    assert.ok(results.every((response) => response.status === 201));
    assert.equal((await fetch(`${running.base}/v1/folders`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'after-queue' }),
    })).status, 201);
  } finally {
    releaseUpload();
    await Promise.allSettled(uploads);
    if (running) await stop(running.server);
    await rm(storageRoot, { recursive: true, force: true });
  }
});

test('a slow quota rejection responds without occupying a write slot', async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'dropvault-slow-reject-test-'));
  let running;
  let slowRequest;
  try {
    running = await start(storageRoot, 32_768, 0);
    await register(running.base, 'full@example.test');
    const fullCookie = activeCookie;
    await register(running.base, 'other@example.test');
    const otherCookie = activeCookie;
    const rejected = new Promise((resolve, reject) => {
      slowRequest = httpRequest(`${running.base}/v1/files?name=slow.txt`, {
        method: 'POST', headers: { Cookie: fullCookie, 'Content-Length': 16_384 },
      }, (response) => {
        response.resume();
        response.on('end', () => resolve(response.statusCode));
      });
      slowRequest.on('error', reject);
      slowRequest.write('x');
    });
    const plan = await nativeFetch(`${running.base}/v1/account/plan`, {
      method: 'POST', headers: { Cookie: otherCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ tier: 'demo' }),
    });
    assert.equal(plan.status, 200);
    slowRequest.end(Buffer.alloc(16_383));
    assert.equal(await rejected, 507);
  } finally {
    slowRequest?.destroy();
    if (running) await stop(running.server);
    await rm(storageRoot, { recursive: true, force: true });
  }
});

test('quota rejection drains a declared upload body', async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'dropvault-drain-test-'));
  let running;
  try {
    running = await start(storageRoot, 32_768, 0);
    await register(running.base);
    let markDrained;
    const drained = new Promise((resolve) => { markDrained = resolve; });
    running.server.on('request', (request) => {
      if (request.url === '/v1/files?name=blocked.txt') request.on('end', markDrained);
    });
    const status = await new Promise((resolve, reject) => {
      const request = httpRequest(`${running.base}/v1/files?name=blocked.txt`, {
        method: 'POST', headers: { Cookie: activeCookie, 'Content-Length': 16_384 },
      }, (response) => {
        response.resume();
        response.on('end', () => resolve(response.statusCode));
      });
      request.on('error', reject);
      request.end(Buffer.alloc(16_384));
    });
    assert.equal(status, 507);
    await Promise.race([
      drained,
      new Promise((_, reject) => setTimeout(() => reject(new Error('Upload body was not drained')), 1000)),
    ]);
  } finally {
    if (running) await stop(running.server);
    await rm(storageRoot, { recursive: true, force: true });
  }
});

test('folder suggestions are opt-in, account-scoped, and choices persist', async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'dropvault-suggestions-test-'));
  let running;
  const jsonHeaders = { 'Content-Type': 'application/json' };
  try {
    running = await start(storageRoot, 1024);
    await register(running.base, 'suggest-owner@example.test');
    const ownerCookie = activeCookie;
    const folderResponse = await fetch(`${running.base}/v1/folders`, {
      method: 'POST', headers: jsonHeaders, body: JSON.stringify({ name: 'Photos' }),
    });
    const folder = await folderResponse.json();
    const requestSuggestion = (name, currentFolderId = 'root') => nativeFetch(
      `${running.base}/v1/organization/suggestions`, {
        method: 'POST', headers: { ...jsonHeaders, Cookie: ownerCookie },
        body: JSON.stringify({ name, currentFolderId }),
      });
    const suggestionResponse = await requestSuggestion('holiday.jpg');
    assert.equal(suggestionResponse.status, 200);
    const { suggestion } = await suggestionResponse.json();
    assert.equal(suggestion.folderId, folder.id);
    assert.equal(suggestion.rule, 'type_match');
    assert.deepEqual(await (await requestSuggestion('holiday.jpg', folder.id)).json(),
      { suggestion: null });
    assert.deepEqual(await (await requestSuggestion('unknown.txt')).json(),
      { suggestion: null });

    await register(running.base, 'suggest-other@example.test');
    const otherCookie = activeCookie;
    assert.deepEqual(await (await nativeFetch(`${running.base}/v1/organization/suggestions`, {
      method: 'POST', headers: { ...jsonHeaders, Cookie: otherCookie },
      body: JSON.stringify({ name: 'holiday.jpg', currentFolderId: 'root' }),
    })).json(), { suggestion: null });
    const forbidden = await nativeFetch(`${running.base}/v1/organization/suggestions/${suggestion.id}/decision`, {
      method: 'POST', headers: { ...jsonHeaders, Cookie: otherCookie },
      body: JSON.stringify({ accept: true }),
    });
    assert.equal(forbidden.status, 404);
    const choice = await nativeFetch(`${running.base}/v1/organization/suggestions/${suggestion.id}/decision`, {
      method: 'POST', headers: { ...jsonHeaders, Cookie: ownerCookie },
      body: JSON.stringify({ accept: true }),
    });
    assert.equal(choice.status, 204);
    assert.equal((await nativeFetch(`${running.base}/v1/organization/suggestions/${suggestion.id}/decision`, {
      method: 'POST', headers: { ...jsonHeaders, Cookie: ownerCookie },
      body: JSON.stringify({ accept: true }),
    })).status, 404);
    const second = (await (await requestSuggestion('another.jpg')).json()).suggestion;
    assert.equal((await nativeFetch(`${running.base}/v1/organization/suggestions/${second.id}/decision`, {
      method: 'POST', headers: { ...jsonHeaders, Cookie: ownerCookie },
      body: JSON.stringify({ accept: false }),
    })).status, 204);
    assert.deepEqual(await (await nativeFetch(`${running.base}/v1/organization/stats`, {
      headers: { Cookie: ownerCookie },
    })).json(), { shown: 2, accepted: 1, keptCurrent: 1 });
    await stop(running.server);
    running = await start(storageRoot, 1024);
    assert.deepEqual(await (await nativeFetch(`${running.base}/v1/organization/stats`, {
      headers: { Cookie: ownerCookie },
    })).json(), { shown: 2, accepted: 1, keptCurrent: 1 });
  } finally {
    if (running) await stop(running.server);
    await rm(storageRoot, { recursive: true, force: true });
  }
});

test('file versions preserve older bytes, enforce quota and ownership, and restore safely', async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'dropvault-versions-test-'));
  let running;
  try {
    running = await start(storageRoot, 100, 11);
    await register(running.base, 'versions-owner@example.test');
    const ownerCookie = activeCookie;
    const ownerFetch = (path, options = {}) => nativeFetch(`${running.base}${path}`, {
      ...options, headers: { ...options.headers, Cookie: ownerCookie },
    });
    const upload = await ownerFetch('/v1/files?name=draft.txt', {
      method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'first',
    });
    assert.equal(upload.status, 201);
    const file = await upload.json();
    const path = `/v1/files/${file.id}/versions`;
    const initial = await (await ownerFetch(path)).json();
    assert.equal(initial.versions.length, 1);
    const firstId = initial.versions[0].id;
    const second = await ownerFetch(path, {
      method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'second',
    });
    assert.equal(second.status, 201);
    assert.equal((await second.json()).id, file.id);
    assert.equal((await (await ownerFetch('/v1/storage/usage')).json()).usedBytes, 11);
    const blocked = await ownerFetch(path, {
      method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'third',
    });
    assert.equal(blocked.status, 507);
    assert.equal((await blocked.json()).error.code, 'STORAGE_CAP_EXCEEDED');
    assert.equal((await ownerFetch(`${path}/${firstId}/restore`, { method: 'POST' })).status, 507);
    assert.equal((await (await ownerFetch(`${path}/${firstId}/content`)).text()), 'first');
    assert.equal((await (await ownerFetch(`/v1/files/${file.id}/content`)).text()), 'second');
    const labeled = await ownerFetch(`${path}/${firstId}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'Approved draft' }),
    });
    assert.equal((await labeled.json()).label, 'Approved draft');

    await register(running.base, 'versions-reader@example.test');
    const readerCookie = activeCookie;
    assert.equal((await nativeFetch(`${running.base}${path}`, {
      headers: { Cookie: readerCookie },
    })).status, 404);
    const granted = await ownerFetch(`/v1/files/${file.id}/access`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'versions-reader@example.test' }),
    });
    assert.equal(granted.status, 201);
    assert.equal((await nativeFetch(`${running.base}/v1/files/${file.id}/content`, {
      headers: { Cookie: readerCookie },
    })).status, 200);
    assert.equal((await nativeFetch(`${running.base}${path}/${firstId}/content`, {
      headers: { Cookie: readerCookie },
    })).status, 404);

    await stop(running.server);
    running = await start(storageRoot, 100, 30);
    const beforeRestore = await (await ownerFetch(path)).json();
    assert.equal(beforeRestore.versions.length, 2);
    assert.equal(beforeRestore.versions.find((version) => version.id === firstId).label, 'Approved draft');
    const restored = await ownerFetch(`${path}/${firstId}/restore`, { method: 'POST' });
    assert.equal(restored.status, 201);
    const current = await restored.json();
    assert.equal(current.id, file.id);
    assert.notEqual(current.currentVersionId, firstId);
    assert.equal((await (await ownerFetch(`/v1/files/${file.id}/content`)).text()), 'first');
    const history = await (await ownerFetch(path)).json();
    assert.equal(history.versions.length, 3);
    assert.equal(history.versions[0].kind, 'restored');
    assert.equal((await (await ownerFetch(`${path}/${beforeRestore.currentVersionId}/content`)).text()), 'second');
    assert.equal((await (await ownerFetch('/v1/storage/usage')).json()).usedBytes, 16);
    assert.equal((await ownerFetch(`/v1/files/${file.id}`, { method: 'DELETE' })).status, 204);
    assert.equal((await (await ownerFetch('/v1/storage/usage')).json()).usedBytes, 0);
    assert.deepEqual(await readdir(join(storageRoot, 'originals')), []);
  } finally {
    if (running) await stop(running.server);
    await rm(storageRoot, { recursive: true, force: true });
  }
});
