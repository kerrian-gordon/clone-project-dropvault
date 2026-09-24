import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createApiServer } from '../src/server.js';

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

async function start(storageRoot, maxUploadBytes, storageLimitBytes) {
  const server = await createApiServer({ storageRoot, maxUploadBytes, storageLimitBytes });
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
    assert.equal(share.url, `${running.base}/v1/shares/${share.token}`);
    const links = await (await fetch(`${running.base}/v1/files/${file.id}/shares`)).json();
    assert.equal(links.links[0].id, share.id);
    assert.equal('token' in links.links[0], false);
    assert.equal((await readFile(join(storageRoot, 'catalog.json'), 'utf8')).includes(share.token), false);
    assert.deepEqual(Buffer.from(await (await fetch(share.url)).arrayBuffer()), Buffer.alloc(12, 'a'));

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
    assert.equal((await nativeFetch(share.url)).status, 200);
    assert.equal((await nativeFetch(`${running.base}/v1/files/${file.id}/shares/${share.id}`,
      { method: 'DELETE', headers: { Cookie: ownerCookie } })).status, 204);
    assert.equal((await nativeFetch(share.url)).status, 404);
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

test('login, logout, and pre-account catalog ownership survive migration', async () => {
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
    running = await start(storageRoot, 32, 20);
    const owner = await register(running.base);
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
