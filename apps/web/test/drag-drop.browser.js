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

test('multi-file drop and version history preserve recoverable content',
  { timeout: 60_000 }, async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), 'dropvault-drop-test-'));
    const webRoot = fileURLToPath(new URL('../', import.meta.url));
    let api;
    let vite;
    let browser;
    try {
      api = await createApiServer({ storageRoot });
      api.listen(0, '127.0.0.1');
      await once(api, 'listening');
      const apiOrigin = `http://127.0.0.1:${api.address().port}`;
      vite = await createViteServer({
        configFile: false, root: webRoot, esbuild: { jsx: 'automatic' },
        server: { host: '127.0.0.1', port: 0, strictPort: true,
          proxy: { '/v1': { target: apiOrigin, changeOrigin: false } } },
      });
      await vite.listen();
      const webOrigin = `http://127.0.0.1:${vite.httpServer.address().port}`;
      const credentials = { email: 'drop@example.test', password: 'correct horse battery staple' };
      const registered = await fetch(`${apiOrigin}/v1/auth/register`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(credentials),
      });
      assert.equal(registered.status, 201);
      const cookie = registered.headers.get('set-cookie').split(';', 1)[0];
      const created = await fetch(`${apiOrigin}/v1/folders`, {
        method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Photos' }),
      });
      assert.equal(created.status, 201);

      browser = await chromium.launch({ channel: 'chrome', headless: true });
      const page = await browser.newPage();
      page.setDefaultTimeout(5000);
      const pageErrors = [];
      page.on('pageerror', (error) => pageErrors.push(error.message));
      await page.goto(webOrigin);
      await page.getByRole('textbox', { name: 'Email' }).fill(credentials.email);
      await page.getByRole('textbox', { name: 'Password' }).fill(credentials.password);
      await page.getByRole('button', { name: 'Log in' }).click();
      const zone = page.locator('.drop-zone');
      await zone.waitFor();
      const dataTransfer = await page.evaluateHandle(() => {
        const transfer = new DataTransfer();
        const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9n6sIAAAAASUVORK5CYII='),
          (character) => character.charCodeAt(0));
        transfer.items.add(new File([png], 'trip.png', { type: 'image/png' }));
        transfer.items.add(new File(['A short note'], 'notes.txt', { type: 'text/plain' }));
        return transfer;
      });
      await zone.dispatchEvent('dragenter', { dataTransfer });
      await zone.locator('p').first().dispatchEvent('dragenter', { dataTransfer });
      await zone.locator('p').first().dispatchEvent('dragleave', { dataTransfer });
      assert.match(await zone.getAttribute('class'), /dragging/u);
      await zone.dispatchEvent('dragover', { dataTransfer });
      await zone.dispatchEvent('drop', { dataTransfer });
      assert.doesNotMatch(await zone.getAttribute('class'), /dragging/u);
      await page.getByRole('link', { name: /notes\.txt/u }).waitFor();
      await page.getByText('Choose where to upload this file.').waitFor();
      await page.getByRole('button', { name: 'Use suggested folder' }).click();
      await page.getByText('Uploaded to Photos').waitFor();
      await page.getByRole('link', { name: 'Photos Folder' }).click();
      await page.getByRole('link', { name: /trip\.png/u }).waitFor();
      await page.getByRole('link', { name: 'My files', exact: true }).click();
      await page.getByRole('link', { name: /notes\.txt/u }).click();
      await page.getByRole('button', { name: 'Upload new version' }).waitFor();
      await page.locator('.version-history input[type="file"]').setInputFiles({
        name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('A revised note'),
      });
      await page.getByText('A revised note').waitFor();
      const entries = page.locator('.version-list li');
      await entries.nth(1).waitFor();
      assert.equal(await entries.count(), 2);
      await entries.last().getByRole('button', { name: 'Name' }).click();
      await page.getByRole('textbox', { name: 'Version name' }).fill('First draft');
      await page.getByRole('button', { name: 'Save name' }).click();
      await page.getByText('First draft').waitFor();
      await entries.last().getByRole('button', { name: 'Preview' }).click();
      await page.getByRole('button', { name: 'Compare with current' }).click();
      await page.getByText('Selected version', { exact: true }).waitFor();
      assert.match(await page.locator('.version-comparison').innerText(), /A short note/u);
      assert.match(await page.locator('.version-comparison').innerText(), /A revised note/u);
      await entries.last().getByRole('button', { name: 'Restore as newest' }).click();
      await entries.nth(2).waitFor();
      assert.equal(await page.locator('.viewer-placeholder pre').innerText(), 'A short note');
      await page.reload();
      await page.locator('.version-list li').nth(2).waitFor();
      assert.equal(await page.locator('.viewer-placeholder pre').innerText(), 'A short note');
      await page.getByText('First draft').waitFor();
      assert.deepEqual(pageErrors, []);
    } finally {
      if (browser) await browser.close();
      if (vite) await vite.close();
      if (api) {
        api.closeAllConnections();
        await new Promise((resolve, reject) => api.close((error) => error ? reject(error) : resolve()));
      }
      await rm(storageRoot, { recursive: true, force: true });
    }
  });
