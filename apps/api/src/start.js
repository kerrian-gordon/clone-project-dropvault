import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createApiServer } from './server.js';

const defaultStorageRoot = fileURLToPath(new URL('../../../storage/', import.meta.url));

export function apiListenOptions(overrides = {}) {
  const storageRoot = overrides.storageRoot ?? process.env.DROPVAULT_STORAGE_DIR ?? defaultStorageRoot;
  const port = overrides.port ?? Number(process.env.PORT || 3000);
  const storageLimitBytes = Object.hasOwn(overrides, 'storageLimitBytes')
    ? overrides.storageLimitBytes
    : (process.env.DROPVAULT_STORAGE_LIMIT_BYTES === undefined
      ? undefined
      : Number(process.env.DROPVAULT_STORAGE_LIMIT_BYTES));
  const legacyClaimToken = Object.hasOwn(overrides, 'legacyClaimToken')
    ? overrides.legacyClaimToken
    : process.env.DROPVAULT_LEGACY_CLAIM_TOKEN;
  const moderatorToken = Object.hasOwn(overrides, 'moderatorToken')
    ? overrides.moderatorToken : process.env.DROPVAULT_MODERATOR_TOKEN;
  const publicBaseUrl = Object.hasOwn(overrides, 'publicBaseUrl')
    ? overrides.publicBaseUrl
    : process.env.DROPVAULT_PUBLIC_BASE_URL;
  const host = overrides.host ?? process.env.DROPVAULT_HOST ?? '127.0.0.1';
  const storageBackend = overrides.storageBackend ?? process.env.DROPVAULT_STORAGE_BACKEND ?? 'local';
  if (!['local', 's3'].includes(storageBackend)) {
    throw new Error('DROPVAULT_STORAGE_BACKEND must be local or s3');
  }
  const demoPlanSetting = overrides.demoPlanSetting ?? process.env.DROPVAULT_ENABLE_DEMO_PLAN_SWITCH ?? '0';
  if (!['0', '1'].includes(demoPlanSetting)) {
    throw new Error('DROPVAULT_ENABLE_DEMO_PLAN_SWITCH must be 0 or 1');
  }
  if (demoPlanSetting === '1' && (storageBackend !== 'local'
    || process.env.NODE_ENV === 'production'
    || !['127.0.0.1', '::1', 'localhost'].includes(host))) {
    throw new Error('The demo plan switch requires local storage, a loopback host, and non-production mode');
  }
  const demoPlanSwitchEnabled = demoPlanSetting === '1';
  const productionStorage = storageBackend === 's3'
    ? { databaseUrl: overrides.databaseUrl ?? process.env.DROPVAULT_DATABASE_URL,
      bucket: overrides.s3Bucket ?? process.env.DROPVAULT_S3_BUCKET,
      region: overrides.awsRegion ?? process.env.DROPVAULT_AWS_REGION,
      prefix: overrides.s3Prefix ?? process.env.DROPVAULT_S3_PREFIX ?? 'dropvault/' }
    : undefined;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be an integer from 1 to 65535');
  }
  return { storageRoot, port, storageLimitBytes, legacyClaimToken, moderatorToken, publicBaseUrl, host,
    productionStorage, demoPlanSwitchEnabled };
}

export async function listenApi(overrides = {}) {
  const options = apiListenOptions(overrides);
  const server = await createApiServer({
    storageRoot: options.storageRoot,
    storageLimitBytes: options.storageLimitBytes,
    legacyClaimToken: options.legacyClaimToken,
    moderatorToken: options.moderatorToken,
    publicBaseUrl: options.publicBaseUrl,
    productionStorage: options.productionStorage,
    demoPlanSwitchEnabled: options.demoPlanSwitchEnabled,
  });
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host, () => {
      server.removeListener('error', reject);
      console.log(`Dropvault API listening on ${options.host}:${options.port}`);
      resolveListen();
    });
  });
  return { server, ...options };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await listenApi();
}
