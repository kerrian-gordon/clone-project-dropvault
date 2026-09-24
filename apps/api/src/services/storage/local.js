import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { ApiError } from '../../routes/errors.js';

export async function openLocalStorage(root) {
  const originals = join(root, 'originals');
  const tmp = join(root, 'tmp');
  await Promise.all([mkdir(originals, { recursive: true }), mkdir(tmp, { recursive: true })]);

  return {
    async save(request, maxUploadBytes, availableBytes) {
      const tempPath = join(tmp, randomUUID());
      let size = 0;
      const limit = new Transform({
        transform(chunk, encoding, callback) {
          size += chunk.length;
          if (size > maxUploadBytes) {
            callback(new ApiError(413, 'FILE_TOO_LARGE', 'File exceeds the upload limit'));
          } else if (size > availableBytes) {
            callback(new ApiError(507, 'STORAGE_CAP_EXCEEDED', 'Storage limit would be exceeded'));
          } else {
            callback(null, chunk);
          }
        },
      });
      try {
        await pipeline(request, limit, createWriteStream(tempPath, { flags: 'wx' }));
        const storageKey = randomUUID();
        await rename(tempPath, join(originals, storageKey));
        return { storageKey, size };
      } catch (error) {
        await rm(tempPath, { force: true });
        throw error;
      }
    },
    read(storageKey) {
      return createReadStream(join(originals, storageKey));
    },
    async sample(storageKey) {
      const file = await open(join(originals, storageKey), 'r');
      try {
        const bytes = Buffer.alloc(12);
        const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
        return bytes.subarray(0, bytesRead);
      } finally {
        await file.close();
      }
    },
    async remove(storageKey) {
      await rm(join(originals, storageKey), { force: true });
    },
    async stageRemove(storageKey) {
      const originalPath = join(originals, storageKey);
      const stagedPath = join(tmp, `delete-${randomUUID()}`);
      await rename(originalPath, stagedPath);
      return {
        commit: () => rm(stagedPath, { force: true }),
        rollback: () => rename(stagedPath, originalPath),
      };
    },
  };
}
