import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createApiServer } from '../src/server.js';

async function start(storageRoot, maxUploadBytes) {
  const server = await createApiServer({ storageRoot, maxUploadBytes });
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
