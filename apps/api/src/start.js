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
  const publicBaseUrl = Object.hasOwn(overrides, 'publicBaseUrl')
    ? overrides.publicBaseUrl
    : process.env.DROPVAULT_PUBLIC_BASE_URL;
  const host = overrides.host ?? process.env.DROPVAULT_HOST ?? '127.0.0.1';
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be an integer from 1 to 65535');
  }
  return { storageRoot, port, storageLimitBytes, legacyClaimToken, publicBaseUrl, host };
}

export async function listenApi(overrides = {}) {
  const options = apiListenOptions(overrides);
  const server = await createApiServer({
    storageRoot: options.storageRoot,
    storageLimitBytes: options.storageLimitBytes,
    legacyClaimToken: options.legacyClaimToken,
    publicBaseUrl: options.publicBaseUrl,
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
