import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createApiServer } from '../src/server.js';
import { seedDemoData } from '../src/seed-demo.js';

test('demo seed creates usable accounts, downloads, grants, and quota flow', async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'dropvault-seed-test-'));
  let server;
  const password = 'demo test password 123';
  try {
    const seeded = await seedDemoData({ storageRoot, password });
    assert.deepEqual(seeded.users, ['alex@example.test', 'blair@example.test']);
    assert.equal(seeded.files, 4);
    const catalog = JSON.parse(await readFile(join(storageRoot, 'catalog.json'), 'utf8'));
    assert.equal(catalog.files.length, 4);
    assert.equal(catalog.grants.length, 1);
    assert.equal(catalog.users.every((user) => user.passwordHash !== password), true);
    await assert.rejects(() => seedDemoData({ storageRoot, password }), /Catalog already exists/);

    server = await createApiServer({ storageRoot, storageLimitBytes: 104857600 });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;
    const login = async (email) => {
      const response = await fetch(`${base}/v1/auth/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      assert.equal(response.status, 200);
      return response.headers.get('set-cookie').split(';', 1)[0];
    };
    const alexCookie = await login('alex@example.test');
    const blairCookie = await login('blair@example.test');
    const request = (cookie, path, options = {}) => fetch(`${base}${path}`, {
      ...options, headers: { ...options.headers, Cookie: cookie },
    });

    const alexRoot = await (await request(alexCookie, '/v1/folders/root/children')).json();
    assert.deepEqual(alexRoot.folders.map((folder) => folder.name), ['Projects']);
    const projects = await (await request(alexCookie,
      `/v1/folders/${alexRoot.folders[0].id}/children`)).json();
    assert.deepEqual(projects.files.map((file) => file.name),
      ['Project-brief.pdf', 'Demo-video.mp4', 'Q4-deck.pptx']);
    assert.equal(projects.files.reduce((sum, file) => sum + file.size, 0), 104857600);
    const brief = projects.files[0];
    const pdf = await request(alexCookie, `/v1/files/${brief.id}/content`);
    assert.equal(pdf.status, 200);
    const pdfBytes = Buffer.from(await pdf.arrayBuffer());
    assert.equal(pdfBytes.length, brief.size);
    assert.equal(pdfBytes.subarray(0, 5).toString(), '%PDF-');
    const startXref = Number(/startxref\n(\d+)\n%%EOF\n$/u.exec(pdfBytes.toString('latin1'))?.[1]);
    assert.equal(pdfBytes.subarray(startXref, startXref + 5).toString(), 'xref\n');

    const video = await request(alexCookie, `/v1/files/${projects.files[1].id}/content`);
    assert.equal(video.status, 200);
    const videoBytes = Buffer.from(await video.arrayBuffer());
    assert.equal(videoBytes.length, projects.files[1].size);
    assert.equal(videoBytes.subarray(4, 8).toString(), 'ftyp');

    const deck = await request(alexCookie, `/v1/files/${projects.files[2].id}/content?download=1`);
    assert.equal(deck.status, 200);
    assert.equal((await deck.arrayBuffer()).byteLength, projects.files[2].size);

    const shared = await (await request(blairCookie, '/v1/files/shared')).json();
    assert.deepEqual(shared.files.map((file) => file.id), [brief.id]);
    const sharedContent = await request(blairCookie, `/v1/files/${brief.id}/content`);
    assert.equal(sharedContent.status, 200);
    assert.equal((await sharedContent.arrayBuffer()).byteLength, brief.size);
    const forbiddenDelete = await request(blairCookie, `/v1/files/${brief.id}`, { method: 'DELETE' });
    assert.equal(forbiddenDelete.status, 404);
    await forbiddenDelete.arrayBuffer();
    const usage = await (await request(alexCookie, '/v1/storage/usage')).json();
    assert.deepEqual(usage, { usedBytes: 104857600, limitBytes: 104857600, tier: 'free' });
    const uploadPath = '/v1/files?name=follow-up.txt';
    const blocked = await request(alexCookie, uploadPath, { method: 'POST', body: 'x' });
    assert.equal((await blocked.json()).error.code, 'STORAGE_CAP_EXCEEDED');
    const upgrade = await request(alexCookie, '/v1/account/plan', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tier: 'demo' }),
    });
    assert.equal((await upgrade.json()).tier, 'demo');
    assert.equal((await request(alexCookie, uploadPath, { method: 'POST', body: 'x' })).status, 201);
    assert.equal((await (await request(alexCookie, '/v1/storage/usage')).json()).usedBytes, 104857601);
  } finally {
    if (server) {
      server.closeAllConnections();
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
    await rm(storageRoot, { recursive: true, force: true });
  }
});
