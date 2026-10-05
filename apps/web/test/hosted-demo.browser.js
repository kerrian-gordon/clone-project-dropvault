import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { chromium } from 'playwright-core';
import { startHostedDemo } from '../../api/src/start-demo.js';

test('built hosted demo lets an invited reviewer upgrade after the free quota blocks an upload',
  { timeout: 60_000 }, async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), 'dropvault-hosted-browser-'));
    const accessPassword = 'browser-demo-access-secret-longer-than-32-characters';
    const accountPassword = 'browser demo account password';
    const webDistDir = fileURLToPath(new URL('../dist/', import.meta.url));
    let running;
    let browser;
    try {
      running = await startHostedDemo({ storageRoot, webDistDir, accessPassword, accountPassword,
        publicBaseUrl: 'http://127.0.0.1:3000', secureSessionCookies: false,
        host: '127.0.0.1', port: 0 });
      const origin = `http://127.0.0.1:${running.server.address().port}`;
      browser = await chromium.launch({ channel: 'chrome', headless: true });
      const context = await browser.newContext({ httpCredentials: { username: 'demo', password: accessPassword } });
      const page = await context.newPage();
      page.setDefaultTimeout(10_000);
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(origin);
      await page.getByRole('textbox', { name: 'Email' }).fill('alex@example.test');
      await page.getByRole('textbox', { name: 'Password' }).fill(accountPassword);
      await page.getByRole('button', { name: 'Log in' }).click();
      await page.locator('input[aria-label="Choose files to upload"]')
        .setInputFiles({ name: 'extra.txt', mimeType: 'text/plain', buffer: Buffer.from('More demo data') });
      await page.getByRole('button', { name: 'Upgrade storage' }).waitFor();
      await page.getByRole('button', { name: 'Upgrade storage' }).click();
      await page.getByRole('button', { name: 'Switch to demo and retry' }).click();
      await page.locator('.upload-queue li').filter({ hasText: 'extra.txt' })
        .getByText('Uploaded', { exact: true }).waitFor();
      const headers = { Authorization: `Basic ${Buffer.from(`demo:${accessPassword}`).toString('base64')}` };
      const usage = await context.request.get(`${origin}/v1/storage/usage`, { headers });
      assert.equal(usage.status(), 200);
      assert.equal((await usage.json()).tier, 'demo');
      assert.deepEqual(errors, []);
    } finally {
      await browser?.close();
      if (running?.server) {
        running.server.closeAllConnections();
        await new Promise((resolve) => running.server.close(resolve));
      }
      await rm(storageRoot, { recursive: true, force: true });
    }
  });
