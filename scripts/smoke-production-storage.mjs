import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import pg from 'pg';
import { createApiServer } from '../apps/api/src/server.js';

const { DROPVAULT_SMOKE_CONFIRM: confirmation,
  DROPVAULT_SMOKE_DATABASE_URL: databaseUrl,
  DROPVAULT_SMOKE_S3_BUCKET: bucket,
  DROPVAULT_SMOKE_AWS_REGION: region,
  DROPVAULT_SMOKE_S3_PREFIX: basePrefix } = process.env;

if (confirmation !== 'isolated-test-resources' || !databaseUrl || !bucket || !region
  || !basePrefix || !/^smoke\/[A-Za-z0-9/_-]*\/$/u.test(basePrefix)
  || !/smoke|test/iu.test(new URL(databaseUrl).pathname.slice(1))) {
  throw new Error('Use a fresh database named with smoke/test, a smoke/ S3 prefix, and '
    + 'DROPVAULT_SMOKE_CONFIRM=isolated-test-resources. See README.md.');
}

const probe = new pg.Client({ connectionString: databaseUrl });
await probe.connect();
try {
  const existing = await probe.query('SELECT to_regclass($1) AS catalog', ['dropvault_catalog']);
  if (existing.rows[0].catalog) {
    throw new Error('The smoke-test database already contains a DropVault catalog; use a fresh database');
  }
} finally {
  await probe.end();
}

const prefix = `${basePrefix}${randomUUID()}/`;
const productionStorage = { databaseUrl, bucket, region, prefix };
let server;
let base;

async function start() {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      server = await createApiServer({ storageRoot: tmpdir(), productionStorage });
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      base = `http://127.0.0.1:${server.address().port}`;
      return;
    } catch (error) {
      if (!error.message.includes('already using this PostgreSQL catalog') || attempt === 19) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

async function stop() {
  if (!server) return;
  server.closeAllConnections();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  server = undefined;
}

async function checked(path, options = {}, status = 200) {
  const response = await fetch(`${base}${path}`, options);
  if (response.status !== status) {
    throw new Error(`${path}: expected ${status}, got ${response.status}: ${await response.text()}`);
  }
  return response;
}

const json = (method, body, cookie) => ({ method,
  headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
  body: JSON.stringify(body) });

try {
  await start();
  assert.deepEqual(await (await checked('/v1/capabilities')).json(),
    { demoPlanSwitchEnabled: false });
  const registration = await checked('/v1/auth/register', json('POST', {
    email: `smoke-${randomUUID()}@example.test`, password: `${randomUUID()}${randomUUID()}`,
  }), 201);
  const cookie = registration.headers.get('set-cookie').split(';', 1)[0];
  const authorized = (options = {}) => ({ ...options,
    headers: { ...options.headers, Cookie: cookie } });
  const first = Buffer.from('DropVault S3 and PostgreSQL smoke test, version one\n');
  const uploaded = await checked('/v1/files?name=smoke.txt', authorized({
    method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: first,
  }), 201);
  const file = await uploaded.json();
  assert.deepEqual(Buffer.from(await (await checked(`/v1/files/${file.id}/content`,
    authorized())).arrayBuffer()), first);

  const second = Buffer.from('DropVault S3 and PostgreSQL smoke test, version two\n');
  await checked(`/v1/files/${file.id}/versions`, authorized({
    method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: second,
  }), 201);
  const workspace = await (await checked('/v1/workspaces', authorized(json('POST',
    { name: 'Smoke workspace', description: 'Dedicated production-storage check' })), 201)).json();
  await checked(`/v1/workspaces/${workspace.id}/files`, authorized(json('POST',
    { fileId: file.id })));
  const snapshot = await (await checked(`/v1/workspaces/${workspace.id}/snapshots`,
    authorized(json('POST', { name: 'Smoke snapshot', note: '', fileIds: [file.id] })), 201)).json();
  const archive = await checked(`/v1/snapshots/${snapshot.id}/archive`, authorized());
  assert.ok((await archive.arrayBuffer()).byteLength > 512);

  await stop();
  await start();
  assert.deepEqual(Buffer.from(await (await checked(`/v1/files/${file.id}/content`,
    authorized())).arrayBuffer()), second);
  assert.deepEqual(Buffer.from(await (await checked(
    `/v1/snapshots/${snapshot.id}/files/${file.id}/content`, authorized())).arrayBuffer()), second);
  console.log(`Production storage smoke check passed. Database: ${new URL(databaseUrl).pathname.slice(1)}. S3 prefix: ${prefix}`);
  console.log('Test records and objects were left in the dedicated resources for inspection.');
} finally {
  await stop();
}
