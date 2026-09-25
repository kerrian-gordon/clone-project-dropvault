import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import test from 'node:test';
import { createApiServer } from '../src/server.js';
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

function emptyZip(entries) {
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
  return Buffer.concat([localBytes, centralBytes, end]);
}

async function start(storageRoot, maxUploadBytes, storageLimitBytes, options = {}) {
  const server = await createApiServer({ storageRoot, maxUploadBytes, storageLimitBytes, ...options });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

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

test('startup restores interrupted deletion and removes committed staged bytes', async () => {
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
    assert.deepEqual(await readdir(join(storageRoot, 'originals')), [storageKey]);
    assert.equal((await fetch(`${running.base}/v1/files/${file.id}/content`)).status, 200);
    assert.equal((await readdir(join(storageRoot, 'tmp'))).length, 0);
    await stop(running.server);
    running = null;

    await rename(original, staged);
    catalog.files = []; // Process stopped after catalog change, before byte cleanup.
    await writeFile(catalogPath, JSON.stringify(catalog));
    running = await start(storageRoot, 100, 100);
    assert.equal((await fetch(`${running.base}/v1/files/${file.id}`)).status, 404);
    assert.equal((await readdir(join(storageRoot, 'tmp'))).length, 0);
    assert.equal((await readdir(join(storageRoot, 'originals'))).length, 0);
  } finally {
    if (running) await stop(running.server);
    await rm(storageRoot, { recursive: true, force: true });
  }
});

test('cleanup failure returns committed deletion and recovers on restart', async () => {
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
    assert.equal((await readdir(join(storageRoot, 'tmp'))).length, 0);
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

test('mutation queue rejects excess work and recovers after a stalled upload', async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'dropvault-queue-test-'));
  let running;
  let releaseUpload;
  let markUploadStarted;
  const uploadStarted = new Promise((resolve) => { markUploadStarted = resolve; });
  const uploadGate = new Promise((resolve) => { releaseUpload = resolve; });
  const attempts = [];
  try {
    running = await start(storageRoot, 32_768, 1000, {
      storageFactory: async (root) => {
        const local = await openLocalStorage(root);
        return { ...local, async save(...args) {
          markUploadStarted();
          await uploadGate;
          return local.save(...args);
        } };
      },
    });
    await register(running.base);
    const upload = fetch(`${running.base}/v1/files?name=hold.txt`, {
      method: 'POST', body: 'hold',
    });
    attempts.push(upload);
    await uploadStarted;
    for (let index = 0; index < 40; index += 1) {
      attempts.push(fetch(`${running.base}/v1/folders`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: `folder-${index}` }),
      }));
    }
    const firstResponse = await Promise.race(attempts.slice(1));
    assert.equal(firstResponse.status, 503);
    assert.equal((await firstResponse.json()).error.code, 'SERVER_BUSY');
    let markRejectedUploadDrained;
    const rejectedUploadDrained = new Promise((resolve) => { markRejectedUploadDrained = resolve; });
    running.server.on('request', (request) => {
      if (request.url === '/v1/files?name=blocked.txt') {
        request.on('end', markRejectedUploadDrained);
      }
    });
    const rejectedUpload = await fetch(`${running.base}/v1/files?name=blocked.txt`, {
      method: 'POST', body: Buffer.alloc(20_000),
    });
    assert.equal(rejectedUpload.status, 503);
    await rejectedUploadDrained;
    releaseUpload();
    assert.equal((await upload).status, 201);
    const results = await Promise.all(attempts.slice(1));
    assert.ok(results.some((response) => response.status === 201));
    assert.ok(results.some((response) => response.status === 503));
    assert.equal((await fetch(`${running.base}/v1/folders`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'after-queue' }),
    })).status, 201);
  } finally {
    releaseUpload();
    await Promise.allSettled(attempts);
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
