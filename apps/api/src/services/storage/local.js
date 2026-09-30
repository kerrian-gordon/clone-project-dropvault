import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { access, copyFile, mkdir, open, readdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { ApiError, unwrapApiError } from '../../routes/errors.js';
import { gitArchiveCommit, zipEntryNames } from '../../modules/uploads/zip.js';

export async function openLocalStorage(root) {
  const originals = join(root, 'originals');
  const tmp = join(root, 'tmp');
  await Promise.all([mkdir(originals, { recursive: true }), mkdir(tmp, { recursive: true })]);

  return {
    async recoverDeletes(referencedKeys) {
      const referenced = new Set(referencedKeys);
      for (const name of await readdir(tmp)) {
        if (!name.startsWith('delete-') || !name.endsWith('.pending')) continue;
        const storageKey = name.slice('delete-'.length, -'.pending'.length);
        if (!/^[A-Za-z0-9_-]{1,100}$/u.test(storageKey)) continue;
        const stagedPath = join(tmp, name);
        const originalPath = join(originals, storageKey);
        if (referenced.has(storageKey)) {
          let originalExists = true;
          try {
            await access(originalPath);
          } catch (error) {
            if (error.code !== 'ENOENT') throw error;
            originalExists = false;
          }
          if (originalExists) {
            // Preserve both copies without blocking a later stageRemove for this key.
            await rename(stagedPath, join(tmp, `review-${storageKey}-${randomUUID()}.pending`));
          } else {
            await rename(stagedPath, originalPath);
          }
        }
      }
    },
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
        throw unwrapApiError(error) ?? error;
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
    zipEntries(storageKey) {
      return zipEntryNames(join(originals, storageKey));
    },
    gitArchiveCommit(storageKey) {
      return gitArchiveCommit(join(originals, storageKey));
    },
    async copy(storageKey) {
      const newKey = randomUUID();
      const destination = join(originals, newKey);
      try {
        await copyFile(join(originals, storageKey), destination);
      } catch (error) {
        await rm(destination, { force: true });
        throw error;
      }
      return { storageKey: newKey };
    },
    async remove(storageKey) {
      await rm(join(originals, storageKey), { force: true });
    },
    async stageRemove(storageKey) {
      const originalPath = join(originals, storageKey);
      const stagedPath = join(tmp, `delete-${storageKey}.pending`);
      await rename(originalPath, stagedPath);
      return {
        commit: () => rm(stagedPath, { force: true }),
        rollback: () => rename(stagedPath, originalPath),
      };
    },
  };
}
