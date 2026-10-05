import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { chromium } from 'playwright-core';
import { createServer as createViteServer } from 'vite';
import { createApiServer } from '../../api/src/server.js';

test('upload waits for folder choice, then uses suggested or current folder',
  { timeout: 60_000 }, async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), 'dropvault-folder-browser-'));
    let api;
    let vite;
    let browser;
    try {
      api = await createApiServer({ storageRoot });
      api.listen(0, '127.0.0.1');
      await once(api, 'listening');
      const apiOrigin = `http://127.0.0.1:${api.address().port}`;
      vite = await createViteServer({
        configFile: false, root: fileURLToPath(new URL('../', import.meta.url)),
        esbuild: { jsx: 'automatic' },
        server: { host: '127.0.0.1', port: 0, strictPort: false,
          proxy: { '/v1': { target: apiOrigin, changeOrigin: false } } },
      });
      await vite.listen();
      const webOrigin = `http://127.0.0.1:${vite.httpServer.address().port}`;
      const email = 'folder-browser@example.test';
      const password = 'correct horse battery staple';
      const registered = await fetch(`${apiOrigin}/v1/auth/register`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      assert.equal(registered.status, 201);
      const cookie = registered.headers.get('set-cookie').split(';', 1)[0];
      const created = await fetch(`${apiOrigin}/v1/folders`, {
        method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Photos' }),
      });
      assert.equal(created.status, 201);
      const photos = await created.json();
      async function children(folderId) {
        const response = await fetch(`${apiOrigin}/v1/folders/${folderId}/children`, {
          headers: { Cookie: cookie },
        });
        assert.equal(response.status, 200);
        return response.json();
      }
      async function expectFiles(folderId, names) {
        for (let attempt = 0; attempt < 20; attempt += 1) {
          const actual = (await children(folderId)).files.map((file) => file.name);
          if (actual.join('\0') === names.join('\0')) return;
          await new Promise((resolveWait) => setTimeout(resolveWait, 100));
        }
        assert.deepEqual((await children(folderId)).files.map((file) => file.name), names);
      }

      browser = await chromium.launch({ channel: 'chrome', headless: true });
      const page = await browser.newPage();
      page.setDefaultTimeout(5000);
      const pageErrors = [];
      page.on('pageerror', (error) => pageErrors.push(error.message));
      await page.goto(webOrigin, { waitUntil: 'domcontentloaded', timeout: 20_000 });
      await page.getByRole('textbox', { name: 'Email' }).fill(email);
      await page.getByRole('textbox', { name: 'Password' }).fill(password);
      await page.getByRole('button', { name: 'Log in' }).click();
      const input = page.getByLabel('Choose files to upload');
      const image = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9n6sIAAAAASUVORK5CYII=',
        'base64');

      await input.setInputFiles({ name: 'trip.png', mimeType: 'image/png', buffer: image });
      await page.getByText('Choose where to upload this file.').waitFor();
      assert.equal((await children('root')).files.length, 0);
      assert.equal((await children(photos.id)).files.length, 0);
      await page.getByRole('button', { name: 'Use suggested folder' }).click();
      await page.getByText('Uploaded to Photos').waitFor();
      await expectFiles(photos.id, ['trip.png']);

      await input.setInputFiles({ name: 'walk.png', mimeType: 'image/png', buffer: image });
      await page.getByText('Choose where to upload this file.').waitFor();
      assert.equal((await children('root')).files.length, 0);
      await page.getByRole('button', { name: 'Keep here' }).click();
      await page.getByRole('link', { name: /walk\.png/u }).waitFor();
      await expectFiles('root', ['walk.png']);
      assert.deepEqual(pageErrors, []);
    } finally {
      await browser?.close();
      await vite?.close();
      if (api) {
        api.closeAllConnections();
        await new Promise((resolve, reject) => api.close((error) => error ? reject(error) : resolve()));
      }
      await rm(storageRoot, { recursive: true, force: true });
    }
  });
