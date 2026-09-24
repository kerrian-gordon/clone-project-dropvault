import { createServer } from 'node:http';
import { join } from 'node:path';
import { DEFAULT_STORAGE_LIMIT_BYTES, MAX_UPLOAD_BYTES } from '../../../packages/shared/index.js';
import { openCatalog } from './db/catalog.js';
import { createHandler } from './routes/api.js';
import { openLocalStorage } from './services/storage/local.js';

export async function createApiServer({ storageRoot, maxUploadBytes = MAX_UPLOAD_BYTES,
  storageLimitBytes = DEFAULT_STORAGE_LIMIT_BYTES }) {
  if (!Number.isSafeInteger(storageLimitBytes) || storageLimitBytes < 0
    || storageLimitBytes > Math.floor(Number.MAX_SAFE_INTEGER / 10)) {
    throw new Error('storageLimitBytes must be a non-negative safe integer that supports the demo tier');
  }
  const catalog = await openCatalog(join(storageRoot, 'catalog.json'));
  const storage = await openLocalStorage(storageRoot);
  return createServer(createHandler({ catalog, storage, maxUploadBytes, storageLimitBytes }));
}
