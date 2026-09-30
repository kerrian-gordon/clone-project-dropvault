import { createServer } from 'node:http';
import { join } from 'node:path';
import { DEFAULT_STORAGE_LIMIT_BYTES, MAX_UPLOAD_BYTES } from '../../../packages/shared/index.js';
import { openCatalog } from './db/catalog.js';
import { openPostgresCatalog } from './db/postgres.js';
import { createHandler } from './routes/api.js';
import { openLocalStorage } from './services/storage/local.js';
import { openS3Storage } from './services/storage/s3.js';

export async function createApiServer({ storageRoot, maxUploadBytes = MAX_UPLOAD_BYTES,
  storageLimitBytes = DEFAULT_STORAGE_LIMIT_BYTES, legacyClaimToken,
  publicBaseUrl, storageFactory = openLocalStorage, productionStorage,
  demoPlanSwitchEnabled = false }) {
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
  if (productionStorage && (!productionStorage.databaseUrl || !productionStorage.bucket
    || !productionStorage.region)) throw new Error('PostgreSQL URL, S3 bucket, and S3 region are required');
  if (productionStorage && demoPlanSwitchEnabled) {
    throw new Error('The unpaid demo plan switch cannot be enabled with S3 production storage');
  }
  const persistence = productionStorage
    ? await openPostgresCatalog(productionStorage.databaseUrl) : undefined;
  try {
    const catalog = await openCatalog(join(storageRoot, 'catalog.json'), persistence);
    const storage = productionStorage
      ? await openS3Storage(productionStorage) : await storageFactory(storageRoot);
    const referencedStorageKeys = catalog.referencedStorageKeys();
    await storage.recoverDeletes(referencedStorageKeys);
    // A restored PostgreSQL catalog may be older than its S3 bucket. Never infer
    // that an S3 object is safe to delete merely because this catalog lacks it.
    if (catalog.loadedFromDisk && !productionStorage) {
      await storage.recoverOrphanUploads?.(referencedStorageKeys);
    }
    const server = createServer(createHandler({ catalog, storage, maxUploadBytes, storageLimitBytes,
      legacyClaimToken, publicBaseUrl, demoPlanSwitchEnabled }));
    server.on('close', () => { void catalog.close?.(); });
    return server;
  } catch (error) {
    await persistence?.close();
    throw error;
  }
}
