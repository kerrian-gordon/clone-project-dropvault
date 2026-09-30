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

test('owner creates and revokes a bearer link while a recipient cannot manage links',
  { timeout: 60_000 }, async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), 'dropvault-share-browser-test-'));
    const webRoot = fileURLToPath(new URL('../', import.meta.url));
    let server;
    let vite;
    let browser;
    try {
      server = await createApiServer({ storageRoot });
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const apiOrigin = `http://127.0.0.1:${server.address().port}`;
      vite = await createViteServer({
        configFile: false, root: webRoot, esbuild: { jsx: 'automatic' },
        server: { host: '127.0.0.1', port: 0, strictPort: false,
          proxy: { '/v1': { target: apiOrigin, changeOrigin: false } } },
      });
      await vite.listen();
      const webOrigin = `http://127.0.0.1:${vite.httpServer.address().port}`;
      const password = 'correct horse battery staple';
      async function register(email) {
        const response = await fetch(`${apiOrigin}/v1/auth/register`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password }),
        });
        assert.equal(response.status, 201);
        return response.headers.get('set-cookie').split(';', 1)[0];
      }
      const ownerEmail = 'owner@example.test';
      const recipientEmail = 'recipient@example.test';
      const ownerCookie = await register(ownerEmail);
      await register(recipientEmail);
      const uploaded = await fetch(`${apiOrigin}/v1/files?name=notes.txt`, {
        method: 'POST', headers: { Cookie: ownerCookie, 'Content-Type': 'text/plain' },
        body: 'Shared note',
      });
      assert.equal(uploaded.status, 201);
      const file = await uploaded.json();
      assert.equal((await fetch(`${apiOrigin}/v1/files/${file.id}/access`, {
        method: 'POST', headers: { Cookie: ownerCookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: recipientEmail }),
      })).status, 201);

      browser = await chromium.launch({ channel: 'chrome', headless: true });
      const page = await browser.newPage();
      await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: webOrigin });
      page.setDefaultTimeout(5000);
      const pageErrors = [];
      page.on('pageerror', (error) => pageErrors.push(error.message));
      await page.goto(webOrigin, { waitUntil: 'domcontentloaded', timeout: 20_000 });
      async function login(email) {
        await page.getByRole('textbox', { name: 'Email' }).fill(email);
        await page.getByRole('textbox', { name: 'Password' }).fill(password);
        await page.getByRole('button', { name: 'Log in' }).click();
      }
      await login(ownerEmail);
      await page.getByRole('link', { name: /notes\.txt/u }).click();
      await page.getByRole('button', { name: 'Share link' }).click();
      const dialog = page.getByRole('dialog', { name: 'Share a link to notes.txt' });
      await dialog.getByText('No links for this file.').waitFor();
      await dialog.getByRole('button', { name: 'Create link' }).click();
      const input = dialog.getByRole('textbox', { name: 'New link' });
      await input.waitFor();
      const link = await input.inputValue();
      assert.ok(link.startsWith(`${webOrigin}/v1/shares/`));
      const anonymousDownload = await fetch(link);
      assert.equal(anonymousDownload.status, 200);
      assert.equal(await anonymousDownload.text(), 'Shared note');
      await dialog.getByRole('button', { name: 'Copy link' }).click();
      assert.equal(await dialog.getByRole('status').innerText(), 'Link copied.');
      assert.equal(await page.evaluate(() => navigator.clipboard.readText()), link);

      await dialog.getByRole('button', { name: 'Done' }).click();
      await dialog.waitFor({ state: 'hidden' });
      await page.getByRole('button', { name: 'Share link' }).click();
      await dialog.getByRole('button', { name: 'Revoke link' }).waitFor();
      assert.equal(await dialog.getByRole('textbox', { name: 'New link' }).count(), 0);
      await dialog.getByRole('button', { name: 'Revoke link' }).click();
      await dialog.getByRole('button', { name: 'Revoke', exact: true }).click();
      await dialog.getByText('No links for this file.').waitFor();
      assert.equal((await fetch(link)).status, 404);
      await dialog.getByRole('button', { name: 'Done' }).click();

      await page.getByRole('button', { name: 'Log out' }).click();
      await login(recipientEmail);
      await page.getByRole('link', { name: 'Shared with me', exact: true }).click();
      await page.getByRole('link', { name: /notes\.txt/u }).click();
      await page.getByText('Shared with you', { exact: false }).waitFor();
      assert.equal(await page.getByRole('button', { name: 'Share link' }).count(), 0);
      assert.deepEqual(pageErrors, []);
    } finally {
      if (browser) await browser.close();
      if (vite) await vite.close();
      if (server) {
        server.closeAllConnections();
        await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      }
      await rm(storageRoot, { recursive: true, force: true });
    }
  });
