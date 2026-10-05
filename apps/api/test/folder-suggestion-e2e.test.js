import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createApiServer } from '../src/server.js';

async function start() {
  const storageRoot = await mkdtemp(join(tmpdir(), 'dropvault-folder-flow-'));
  const server = await createApiServer({ storageRoot, maxUploadBytes: 1024 });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    storageRoot, server, base: `http://127.0.0.1:${server.address().port}`,
    async close() {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      await rm(storageRoot, { recursive: true, force: true });
    },
  };
}

async function account(base, email) {
  const response = await fetch(`${base}/v1/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'correct horse battery staple' }),
  });
  assert.equal(response.status, 201);
  const cookie = response.headers.get('set-cookie')?.split(';', 1)[0];
  assert.ok(cookie);
  return async (path, options = {}) => fetch(`${base}${path}`, {
    ...options, headers: { ...options.headers, Cookie: cookie },
  });
}

async function jsonRequest(request, path, method, body) {
  return request(path, { method, headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body) });
}

async function folder(request, name) {
  const response = await jsonRequest(request, '/v1/folders', 'POST', { name });
  assert.equal(response.status, 201);
  return response.json();
}

async function suggest(request, name, currentFolderId = 'root') {
  const response = await jsonRequest(request, '/v1/organization/suggestions', 'POST',
    { name, currentFolderId });
  assert.equal(response.status, 200);
  return (await response.json()).suggestion;
}

async function upload(request, name, folderId = 'root') {
  const response = await request(`/v1/files?name=${encodeURIComponent(name)}&folderId=${folderId}`, {
    method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'file contents',
  });
  assert.equal(response.status, 201);
  return response.json();
}

test('suggestions and decisions never move files; only an explicit file update does', async () => {
  const app = await start();
  try {
    const owner = await account(app.base, 'folder-flow-owner@example.test');
    const photos = await folder(owner, 'Photos');
    const file = await upload(owner, 'holiday.txt');
    assert.equal(file.folderId, 'root');

    const suggestion = await suggest(owner, 'holiday.jpg');
    assert.equal(suggestion.folderId, photos.id);
    assert.equal((await (await owner(`/v1/files/${file.id}`)).json()).folderId, 'root');
    assert.equal((await jsonRequest(owner,
      `/v1/organization/suggestions/${suggestion.id}/decision`, 'POST', { accept: true })).status, 204);
    assert.equal((await (await owner(`/v1/files/${file.id}`)).json()).folderId, 'root');

    const moved = await jsonRequest(owner, `/v1/files/${file.id}`, 'PATCH', { folderId: photos.id });
    assert.equal(moved.status, 200);
    assert.equal((await moved.json()).folderId, photos.id);
    assert.equal((await (await owner(`/v1/files/${file.id}`)).json()).folderId, photos.id);
  } finally {
    await app.close();
  }
});

test('keep, no suggestion, and account isolation preserve the current folder', async () => {
  const app = await start();
  try {
    const owner = await account(app.base, 'folder-flow-a@example.test');
    const other = await account(app.base, 'folder-flow-b@example.test');
    const photos = await folder(owner, 'Photos');
    const file = await upload(owner, 'holiday.txt');
    const suggestion = await suggest(owner, 'holiday.jpg');
    assert.equal(suggestion.folderId, photos.id);
    assert.equal(await suggest(owner, 'unknown.txt'), null);
    assert.equal(await suggest(owner, 'holiday.jpg', photos.id), null);
    assert.equal(await suggest(other, 'holiday.jpg'), null);

    const foreignFolder = await jsonRequest(other, '/v1/organization/suggestions', 'POST',
      { name: 'holiday.jpg', currentFolderId: photos.id });
    assert.equal(foreignFolder.status, 404);
    assert.equal((await jsonRequest(other,
      `/v1/organization/suggestions/${suggestion.id}/decision`, 'POST', { accept: true })).status, 404);
    assert.equal((await other(`/v1/files/${file.id}`)).status, 404);
    assert.equal((await jsonRequest(owner,
      `/v1/organization/suggestions/${suggestion.id}/decision`, 'POST', { accept: false })).status, 204);
    assert.equal((await (await owner(`/v1/files/${file.id}`)).json()).folderId, 'root');
    assert.deepEqual(await (await owner('/v1/organization/stats')).json(),
      { shown: 1, accepted: 0, keptCurrent: 1 });
    assert.deepEqual(await (await other('/v1/organization/stats')).json(),
      { shown: 0, accepted: 0, keptCurrent: 0 });
  } finally {
    await app.close();
  }
});
