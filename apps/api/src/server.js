import { createServer } from 'node:http';
import { join } from 'node:path';
import { MAX_UPLOAD_BYTES } from '../../../packages/shared/index.js';
import { openCatalog } from './db/catalog.js';
import { createHandler } from './routes/api.js';
import { openLocalStorage } from './services/storage/local.js';

export async function createApiServer({ storageRoot, maxUploadBytes = MAX_UPLOAD_BYTES }) {
  const catalog = await openCatalog(join(storageRoot, 'catalog.json'));
  const storage = await openLocalStorage(storageRoot);
  return createServer(createHandler({ catalog, storage, maxUploadBytes }));
}
