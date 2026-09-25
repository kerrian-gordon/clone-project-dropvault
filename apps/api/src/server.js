import { createServer } from 'node:http';
import { join } from 'node:path';
import { DEFAULT_STORAGE_LIMIT_BYTES, MAX_UPLOAD_BYTES } from '../../../packages/shared/index.js';
import { openCatalog } from './db/catalog.js';
import { createHandler } from './routes/api.js';
import { openLocalStorage } from './services/storage/local.js';

export async function createApiServer({ storageRoot, maxUploadBytes = MAX_UPLOAD_BYTES,
  storageLimitBytes = DEFAULT_STORAGE_LIMIT_BYTES, legacyClaimToken,
  publicBaseUrl, storageFactory = openLocalStorage }) {
  if (!Number.isSafeInteger(storageLimitBytes) || storageLimitBytes < 0
    || storageLimitBytes > Math.floor(Number.MAX_SAFE_INTEGER / 10)) {
    throw new Error('storageLimitBytes must be a non-negative safe integer that supports the demo tier');
  }
  if (legacyClaimToken !== undefined && (typeof legacyClaimToken !== 'string'
    || legacyClaimToken.length < 32)) {
    throw new Error('legacyClaimToken must have at least 32 characters');
  }
  if (publicBaseUrl !== undefined) {
    const url = new URL(publicBaseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
      || url.search || url.hash || url.pathname !== '/') {
      throw new Error('publicBaseUrl must be an HTTP(S) origin without a path');
    }
    publicBaseUrl = url.origin;
  }
  const catalog = await openCatalog(join(storageRoot, 'catalog.json'));
  const storage = await storageFactory(storageRoot);
  const referencedStorageKeys = catalog.referencedStorageKeys();
  await storage.recoverDeletes(referencedStorageKeys);
  if (catalog.loadedFromDisk) await storage.recoverOrphanUploads?.(referencedStorageKeys);
  return createServer(createHandler({ catalog, storage, maxUploadBytes, storageLimitBytes,
    legacyClaimToken, publicBaseUrl }));
}
