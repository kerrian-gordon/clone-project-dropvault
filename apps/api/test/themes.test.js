import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DEFAULT_THEME_SETTINGS } from '../../../packages/shared/index.js';
import { createApiServer } from '../src/server.js';

async function start(storageRoot) {
  const server = await createApiServer({ storageRoot });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

async function stop(server) {
  server.closeAllConnections();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

test('community theme installation and personal edits survive restart without changing the original', async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'dropvault-themes-test-'));
  let running;
  try {
    running = await start(storageRoot);
    const url = (path) => `${running.base}${path}`;
    const request = (cookie, path, options = {}) => fetch(url(path), {
      ...options, headers: { ...options.headers, ...(cookie ? { Cookie: cookie } : {}) },
    });
    const register = async (email) => {
      const response = await request(null, '/v1/auth/register', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password: 'correct horse battery staple' }),
      });
      assert.equal(response.status, 201);
      return response.headers.get('set-cookie').split(';', 1)[0];
    };
    const alex = await register('alex@example.test');
    const blair = await register('blair@example.test');
    assert.equal((await request(null, '/v1/themes')).status, 401);
    assert.deepEqual(await (await request(blair, '/v1/account/appearance')).json(), {
      sourceThemeId: null, name: 'Default', settings: DEFAULT_THEME_SETTINGS,
      selectedAt: null, updatedAt: null,
    });

    const settings = { colors: { background: '#151c27', surface: '#273349',
      text: '#f5f7fa', accent: '#80b5ff' }, font: 'Georgia', spacing: 'comfortable' };
    const published = await request(alex, '/v1/themes', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '  Night study  ', creatorName: 'Blair',
        settings, creatorId: 'forged' }),
    });
    assert.equal(published.status, 201);
    const theme = await published.json();
    assert.equal(theme.creatorId, (await (await request(alex, '/v1/account')).json()).id);
    assert.equal(theme.name, 'Night study');
    assert.equal(theme.creatorName, 'alex');
    assert.notEqual(theme.creatorName, 'Blair');
    assert.equal(JSON.stringify(theme).includes('alex@example.test'), false);
    assert.deepEqual(theme.settings, settings);
    const gallery = await (await request(blair, '/v1/themes?limit=1')).json();
    assert.deepEqual(gallery.themes.map((item) => item.id), [theme.id]);
    assert.equal(gallery.total, 1);
    assert.equal(gallery.nextOffset, null);
    const searchHit = await (await request(blair, '/v1/themes?q=night')).json();
    assert.equal(searchHit.total, 1);
    assert.equal(searchHit.themes[0].id, theme.id);
    const searchMiss = await (await request(blair, '/v1/themes?q=ocean')).json();
    assert.equal(searchMiss.total, 0);
    const creatorHit = await (await request(blair, '/v1/themes?q=alex')).json();
    assert.equal(creatorHit.total, 1);

    const installed = await request(blair, '/v1/account/appearance', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ themeId: theme.id }),
    });
    assert.equal(installed.status, 200);
    assert.deepEqual((await installed.json()).settings, settings);
    const personal = { ...settings, colors: { ...settings.colors, accent: '#ff91bc' },
      font: 'Inter', spacing: 'compact' };
    const saved = await request(blair, '/v1/account/appearance/settings', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ settings: personal }),
    });
    assert.equal(saved.status, 200);
    assert.deepEqual((await saved.json()).settings, personal);
    assert.deepEqual((await (await request(alex, `/v1/themes/${theme.id}`)).json()).settings, settings);
    assert.equal((await (await request(alex, '/v1/account/appearance')).json()).sourceThemeId, null);

    const invalid = await request(blair, '/v1/account/appearance/settings', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ settings: { ...personal, customCss: 'body { display: none }' } }),
    });
    assert.equal((await invalid.json()).error.code, 'INVALID_THEME_SETTINGS');
    const lowContrast = { ...settings, colors: { ...settings.colors, text: settings.colors.surface } };
    const unsafeSave = await request(blair, '/v1/account/appearance/settings', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ settings: lowContrast }),
    });
    assert.equal(unsafeSave.status, 400);
    assert.equal((await unsafeSave.json()).error.code, 'INVALID_THEME_CONTRAST');
    const unsafePublish = await request(alex, '/v1/themes', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Invisible', creatorName: 'Alex', settings: lowContrast }),
    });
    assert.equal(unsafePublish.status, 400);
    assert.equal((await unsafePublish.json()).error.code, 'INVALID_THEME_CONTRAST');
    assert.equal((await request(blair, '/v1/account/appearance', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ themeId: 'missing' }),
    })).status, 404);

    await stop(running.server);
    running = await start(storageRoot);
    const restored = await (await request(blair, '/v1/account/appearance')).json();
    assert.equal(restored.sourceThemeId, theme.id);
    assert.deepEqual(restored.settings, personal);
    assert.deepEqual((await (await request(alex, `/v1/themes/${theme.id}`)).json()).settings, settings);
    assert.equal((await request(blair, `/v1/themes/${theme.id}`, { method: 'DELETE' })).status, 404);
    assert.equal((await request(alex, `/v1/themes/${theme.id}`, { method: 'DELETE' })).status, 204);
    assert.equal((await request(blair, `/v1/themes/${theme.id}`)).status, 404);
    assert.deepEqual((await (await request(blair, '/v1/account/appearance')).json()).settings, personal);
    const reset = await request(blair, '/v1/account/appearance', { method: 'DELETE' });
    assert.equal(reset.status, 200);
    assert.deepEqual((await reset.json()).settings, DEFAULT_THEME_SETTINGS);
  } finally {
    if (running) await stop(running.server);
    await rm(storageRoot, { recursive: true, force: true });
  }
});

test('deleting another account\'s theme returns 404 like a missing theme', async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'dropvault-theme-delete-'));
  let running;
  try {
    running = await start(storageRoot);
    const url = (path) => `${running.base}${path}`;
    const request = (cookie, path, options = {}) => fetch(url(path), {
      ...options, headers: { ...options.headers, ...(cookie ? { Cookie: cookie } : {}) },
    });
    const register = async (email) => {
      const response = await request(null, '/v1/auth/register', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password: 'correct horse battery staple' }),
      });
      return response.headers.get('set-cookie').split(';', 1)[0];
    };
    const alex = await register('alex@example.test');
    const blair = await register('blair@example.test');
    const settings = { colors: { background: '#151c27', surface: '#273349',
      text: '#f5f7fa', accent: '#80b5ff' }, font: 'Georgia', spacing: 'comfortable' };
    const published = await request(alex, '/v1/themes', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Night study', settings }),
    });
    const theme = await published.json();
    const missing = await request(blair, '/v1/themes/not-a-theme', { method: 'DELETE' });
    const forbidden = await request(blair, `/v1/themes/${theme.id}`, { method: 'DELETE' });
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).error.code, 'THEME_NOT_FOUND');
    assert.equal(forbidden.status, 404);
    assert.equal((await forbidden.json()).error.code, 'THEME_NOT_FOUND');
    assert.equal((await request(alex, `/v1/themes/${theme.id}`)).status, 200);
  } finally {
    if (running) await stop(running.server);
    await rm(storageRoot, { recursive: true, force: true });
  }
});

test('theme and appearance writes reject a foreign Origin', async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'dropvault-theme-origin-'));
  let running;
  try {
    running = await start(storageRoot);
    const url = (path) => `${running.base}${path}`;
    const request = (cookie, path, options = {}) => fetch(url(path), {
      ...options, headers: { ...options.headers, ...(cookie ? { Cookie: cookie } : {}) },
    });
    const register = await request(null, '/v1/auth/register', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'alex@example.test', password: 'correct horse battery staple' }),
    });
    const cookie = register.headers.get('set-cookie').split(';', 1)[0];
    const settings = { colors: { background: '#151c27', surface: '#273349',
      text: '#f5f7fa', accent: '#80b5ff' }, font: 'Georgia', spacing: 'comfortable' };
    const foreign = { Origin: 'https://other.example', 'Content-Type': 'application/json' };
    const publish = await request(cookie, '/v1/themes', {
      method: 'POST', headers: foreign, body: JSON.stringify({ name: 'Night study', settings }),
    });
    assert.equal(publish.status, 403);
    assert.equal((await publish.json()).error.code, 'INVALID_ORIGIN');
    const install = await request(cookie, '/v1/account/appearance', {
      method: 'PUT', headers: foreign, body: JSON.stringify({ themeId: 'x' }),
    });
    assert.equal(install.status, 403);
    assert.equal((await install.json()).error.code, 'INVALID_ORIGIN');
    const save = await request(cookie, '/v1/account/appearance/settings', {
      method: 'PUT', headers: foreign, body: JSON.stringify({ settings }),
    });
    assert.equal(save.status, 403);
    const reset = await request(cookie, '/v1/account/appearance', {
      method: 'DELETE', headers: { Origin: 'https://other.example' },
    });
    assert.equal(reset.status, 403);
  } finally {
    if (running) await stop(running.server);
    await rm(storageRoot, { recursive: true, force: true });
  }
});

test('theme publishing is rate limited per account', async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'dropvault-theme-rate-'));
  let running;
  try {
    running = await start(storageRoot);
    const url = (path) => `${running.base}${path}`;
    const request = (cookie, path, options = {}) => fetch(url(path), {
      ...options, headers: { ...options.headers, ...(cookie ? { Cookie: cookie } : {}) },
    });
    const register = await request(null, '/v1/auth/register', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'alex@example.test', password: 'correct horse battery staple' }),
    });
    const cookie = register.headers.get('set-cookie').split(';', 1)[0];
    const settings = { colors: { background: '#151c27', surface: '#273349',
      text: '#f5f7fa', accent: '#80b5ff' }, font: 'Georgia', spacing: 'comfortable' };
    for (let index = 0; index < 10; index += 1) {
      const published = await request(cookie, '/v1/themes', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: `Theme ${index}`, settings }),
      });
      assert.equal(published.status, 201);
    }
    const limited = await request(cookie, '/v1/themes', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Theme 10', settings }),
    });
    assert.equal(limited.status, 429);
    assert.equal((await limited.json()).error.code, 'RATE_LIMITED');
  } finally {
    if (running) await stop(running.server);
    await rm(storageRoot, { recursive: true, force: true });
  }
});

test('display names are unique and snapshotted even if the body sends another creatorName', async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'dropvault-display-name-'));
  let running;
  try {
    running = await start(storageRoot);
    const url = (path) => `${running.base}${path}`;
    const request = (cookie, path, options = {}) => fetch(url(path), {
      ...options, headers: { ...options.headers, ...(cookie ? { Cookie: cookie } : {}) },
    });
    const register = async (email, displayName) => {
      const response = await request(null, '/v1/auth/register', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password: 'correct horse battery staple', displayName }),
      });
      assert.equal(response.status, 201);
      const account = await response.json();
      return { cookie: response.headers.get('set-cookie').split(';', 1)[0], account };
    };
    const first = await register('alex@a.example', 'Alex');
    const second = await register('alex@b.example', 'Alex');
    assert.equal(first.account.displayName, 'Alex');
    assert.equal(second.account.displayName, 'Alex-2');
    const named = await register('ava@example.test', 'Ava Chen');
    const settings = { colors: { background: '#151c27', surface: '#273349',
      text: '#f5f7fa', accent: '#80b5ff' }, font: 'Georgia', spacing: 'comfortable' };
    const published = await request(named.cookie, '/v1/themes', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Studio', creatorName: 'Blair', settings }),
    });
    assert.equal(published.status, 201);
    assert.equal((await published.json()).creatorName, 'Ava Chen');
  } finally {
    if (running) await stop(running.server);
    await rm(storageRoot, { recursive: true, force: true });
  }
});
