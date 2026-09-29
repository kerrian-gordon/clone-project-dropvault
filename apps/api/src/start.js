import { fileURLToPath } from 'node:url';
import { createApiServer } from './server.js';

const defaultStorageRoot = fileURLToPath(new URL('../../../storage/', import.meta.url));
const storageRoot = process.env.DROPVAULT_STORAGE_DIR || defaultStorageRoot;
const port = Number(process.env.PORT || 3000);
const storageLimitBytes = process.env.DROPVAULT_STORAGE_LIMIT_BYTES === undefined
  ? undefined : Number(process.env.DROPVAULT_STORAGE_LIMIT_BYTES);
const legacyClaimToken = process.env.DROPVAULT_LEGACY_CLAIM_TOKEN;
const publicBaseUrl = process.env.DROPVAULT_PUBLIC_BASE_URL;
const host = process.env.DROPVAULT_HOST || '127.0.0.1';
const productionStorage = process.env.DROPVAULT_STORAGE_BACKEND === 's3'
  ? { databaseUrl: process.env.DROPVAULT_DATABASE_URL,
    bucket: process.env.DROPVAULT_S3_BUCKET, region: process.env.DROPVAULT_AWS_REGION,
    prefix: process.env.DROPVAULT_S3_PREFIX || 'dropvault/' } : undefined;
if (process.env.DROPVAULT_STORAGE_BACKEND && !['local', 's3'].includes(process.env.DROPVAULT_STORAGE_BACKEND)) {
  throw new Error('DROPVAULT_STORAGE_BACKEND must be local or s3');
}

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT must be an integer from 1 to 65535');
}

const server = await createApiServer({ storageRoot, storageLimitBytes, legacyClaimToken,
  publicBaseUrl, productionStorage });
server.listen(port, host, () => {
  console.log(`Dropvault API listening on ${host}:${port}`);
});
