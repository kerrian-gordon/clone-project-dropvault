import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createServer as createViteServer } from 'vite';
import { createApiServer } from '../../api/src/server.js';
import webConfig from '../vite.config.js';

test('Vite proxy preserves same-origin writes and rejects foreign origins', async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'dropvault-proxy-test-'));
  const webRoot = fileURLToPath(new URL('../', import.meta.url));
  let api;
  let vite;
  try {
    api = await createApiServer({ storageRoot });
    api.listen(0, '127.0.0.1');
    await once(api, 'listening');
    const apiOrigin = `http://127.0.0.1:${api.address().port}`;
    const configuredProxy = webConfig.server.proxy['/v1'];
    const proxy = typeof configuredProxy === 'string' ? apiOrigin
      : { ...configuredProxy, target: apiOrigin };
    vite = await createViteServer({
      configFile: false,
      root: webRoot,
      optimizeDeps: { noDiscovery: true, include: [] },
      server: { host: '127.0.0.1', port: 0, strictPort: true, proxy: { '/v1': proxy } },
    });
    await vite.listen();
    const webOrigin = `http://127.0.0.1:${vite.httpServer.address().port}`;
    const body = JSON.stringify({ email: 'proxy@example.test',
      password: 'correct horse battery staple' });
    const sameOrigin = await fetch(`${webOrigin}/v1/auth/register`, {
      method: 'POST', headers: { Origin: webOrigin, 'Content-Type': 'application/json' }, body,
    });
    assert.equal(sameOrigin.status, 201);
    assert.ok(sameOrigin.headers.get('set-cookie')?.startsWith('dropvault_session='));

    const foreignOrigin = await fetch(`${webOrigin}/v1/auth/login`, {
      method: 'POST', headers: { Origin: 'https://other.example',
        'Content-Type': 'application/json' }, body,
    });
    assert.equal(foreignOrigin.status, 403);
    assert.equal((await foreignOrigin.json()).error.code, 'INVALID_ORIGIN');
  } finally {
    if (vite) await vite.close();
    if (api) {
      api.closeAllConnections();
      await new Promise((resolve, reject) => api.close((error) => error ? reject(error) : resolve()));
    }
    await rm(storageRoot, { recursive: true, force: true });
  }
});
