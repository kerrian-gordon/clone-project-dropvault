import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { ApiError } from '../../routes/errors.js';

export async function openLocalStorage(root) {
  const originals = join(root, 'originals');
  const tmp = join(root, 'tmp');
  await Promise.all([mkdir(originals, { recursive: true }), mkdir(tmp, { recursive: true })]);

  return {
    async save(request, maxBytes) {
      const tempPath = join(tmp, randomUUID());
      let size = 0;
      const limit = new Transform({
        transform(chunk, encoding, callback) {
          size += chunk.length;
          callback(size > maxBytes ? new ApiError(413, 'FILE_TOO_LARGE', 'File exceeds the upload limit') : null, chunk);
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
    async remove(storageKey) {
      await rm(join(originals, storageKey), { force: true });
    },
  };
}
