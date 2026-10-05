import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { hostedDemoOptions, startHostedDemo } from '../src/start-demo.js';

const gatePassword = 'a-demo-access-secret-longer-than-32-characters';
const accountPassword = 'a different demo account password';

async function close(server) {
  server.closeAllConnections();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

test('hosted demo requires an explicit volume, gate, seeded-account password, and HTTPS origin', () => {
  const good = { DROPVAULT_STORAGE_DIR: join(tmpdir(), 'dropvault-test-volume'),
    DROPVAULT_DEMO_ACCESS_PASSWORD: gatePassword, DROPVAULT_DEMO_PASSWORD: accountPassword,
    DROPVAULT_PUBLIC_BASE_URL: 'https://demo.example.test' };
  assert.equal(hostedDemoOptions(good).secureSessionCookies, true);
  assert.equal(hostedDemoOptions({ ...good, DROPVAULT_PUBLIC_BASE_URL: '',
    RENDER_EXTERNAL_URL: 'https://dropvault-freemium-demo.onrender.com' }).publicBaseUrl,
    'https://dropvault-freemium-demo.onrender.com');
  assert.throws(() => hostedDemoOptions({ ...good, DROPVAULT_STORAGE_DIR: '' }), /persistent-volume/u);
  assert.throws(() => hostedDemoOptions({ ...good, DROPVAULT_DEMO_ACCESS_PASSWORD: 'short' }), /32 characters/u);
  assert.throws(() => hostedDemoOptions({ ...good, DROPVAULT_DEMO_PASSWORD: 'short' }), /12 to 1024/u);
  assert.throws(() => hostedDemoOptions({ ...good, DROPVAULT_PUBLIC_BASE_URL: 'http://demo.example.test' }), /HTTPS/u);
});

test('hosted site gates pages and API, serves SPA routes, and persists free-to-Demo changes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dropvault-hosted-demo-'));
  const storageRoot = join(root, 'volume');
  const webDistDir = join(root, 'web');
  await mkdir(storageRoot);
  await mkdir(join(webDistDir, 'assets'), { recursive: true });
  await writeFile(join(webDistDir, 'index.html'), '<!doctype html><title>DropVault test</title>');
  await writeFile(join(webDistDir, 'assets', 'app-abc.js'), 'export const demo = true;');
  const options = { storageRoot, webDistDir, accessPassword: gatePassword, accountPassword,
    publicBaseUrl: 'https://demo.example.test', secureSessionCookies: true,
    host: '127.0.0.1', port: 0 };
  let running;
  try {
    running = await startHostedDemo(options);
    assert.equal(running.seeded, true);
    let base = `http://127.0.0.1:${running.server.address().port}`;
    const auth = { Authorization: `Basic ${Buffer.from(`demo:${gatePassword}`).toString('base64')}` };
    assert.equal((await fetch(`${base}/v1/health`)).status, 200);
    const blockedPage = await fetch(base);
    assert.equal(blockedPage.status, 401);
    assert.match(blockedPage.headers.get('www-authenticate'), /Basic/u);
    assert.equal((await fetch(`${base}/v1/capabilities`)).status, 401);
    assert.match(await (await fetch(`${base}/workspaces/abc`, { headers: auth })).text(), /DropVault test/u);
    const asset = await fetch(`${base}/assets/app-abc.js`, { headers: auth });
    assert.equal(asset.status, 200);
    assert.match(asset.headers.get('content-type'), /javascript/u);
    assert.equal((await fetch(`${base}/assets/../catalog.json`, { headers: auth })).status, 404);

    const login = await fetch(`${base}/v1/auth/login`, { method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'alex@example.test', password: accountPassword }) });
    assert.equal(login.status, 200);
    assert.match(login.headers.get('set-cookie'), /; Secure/u);
    const cookie = login.headers.get('set-cookie').split(';', 1)[0];
    const memberHeaders = { ...auth, Cookie: cookie };
    const before = await (await fetch(`${base}/v1/storage/usage`, { headers: memberHeaders })).json();
    assert.deepEqual(before, { usedBytes: 104857600, limitBytes: 104857600, tier: 'free' });
    const upgrade = await fetch(`${base}/v1/account/plan`, { method: 'POST',
      headers: { ...memberHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ tier: 'demo' }) });
    assert.equal(upgrade.status, 200);
    assert.equal((await upgrade.json()).tier, 'demo');
    await close(running.server);
    running = await startHostedDemo(options);
    assert.equal(running.seeded, false);
    base = `http://127.0.0.1:${running.server.address().port}`;
    const after = await (await fetch(`${base}/v1/storage/usage`, { headers: memberHeaders })).json();
    assert.equal(after.tier, 'demo');
    assert.equal(after.limitBytes, 1048576000);
  } finally {
    if (running?.server?.listening) await close(running.server);
    await rm(root, { recursive: true, force: true });
  }
});
