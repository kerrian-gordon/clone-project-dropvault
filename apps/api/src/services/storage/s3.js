import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { CopyObjectCommand, DeleteObjectCommand, GetObjectCommand, PutObjectCommand,
  S3Client } from '@aws-sdk/client-s3';
import { ApiError, unwrapApiError } from '../../routes/errors.js';
import { gitArchiveCommit, zipEntryNames } from '../../modules/uploads/zip.js';

export async function openS3Storage({ bucket, region, prefix = 'dropvault/', client = new S3Client({ region }) }) {
  if (!bucket || !region || !/^[a-zA-Z0-9/_-]*$/u.test(prefix)) {
    throw new Error('S3 bucket, region, and safe key prefix are required');
  }
  const objectKey = (storageKey) => `${prefix}${storageKey}`;
  async function withTemp(storageKey, work) {
    const directory = await mkdtemp(join(tmpdir(), 'dropvault-s3-'));
    const path = join(directory, 'object');
    try {
      const object = await client.send(new GetObjectCommand({ Bucket: bucket, Key: objectKey(storageKey) }));
      await pipeline(object.Body, createWriteStream(path));
      return await work(path);
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
  async function remove(storageKey) {
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: objectKey(storageKey) }));
  }
  return {
    async recoverDeletes() {},
    async save(request, maxUploadBytes, availableBytes) {
      const directory = await mkdtemp(join(tmpdir(), 'dropvault-s3-'));
      const path = join(directory, 'upload');
      let size = 0;
      const limit = new Transform({ transform(chunk, encoding, callback) {
        size += chunk.length;
        if (size > maxUploadBytes) callback(new ApiError(413, 'FILE_TOO_LARGE', 'File exceeds the upload limit'));
        else if (size > availableBytes) callback(new ApiError(507, 'STORAGE_CAP_EXCEEDED', 'Storage limit would be exceeded'));
        else callback(null, chunk);
      } });
      try {
        await pipeline(request, limit, createWriteStream(path, { flags: 'wx' }));
        const storageKey = randomUUID();
        await client.send(new PutObjectCommand({ Bucket: bucket, Key: objectKey(storageKey),
          Body: createReadStream(path), ContentLength: size }));
        return { storageKey, size };
      } catch (error) { throw unwrapApiError(error) ?? error; }
      finally { await rm(directory, { recursive: true, force: true }); }
    },
    read(storageKey) {
      const output = new PassThrough();
      client.send(new GetObjectCommand({ Bucket: bucket, Key: objectKey(storageKey) }))
        .then((object) => pipeline(object.Body, output)).catch((error) => output.destroy(error));
      return output;
    },
    async sample(storageKey) {
      const object = await client.send(new GetObjectCommand({ Bucket: bucket,
        Key: objectKey(storageKey), Range: 'bytes=0-11' }));
      const chunks = [];
      for await (const chunk of object.Body) chunks.push(chunk);
      return Buffer.concat(chunks).subarray(0, 12);
    },
    zipEntries: (storageKey) => withTemp(storageKey, zipEntryNames),
    gitArchiveCommit: (storageKey) => withTemp(storageKey, gitArchiveCommit),
    async copy(storageKey) {
      const newKey = randomUUID();
      await client.send(new CopyObjectCommand({ Bucket: bucket, Key: objectKey(newKey),
        CopySource: `${bucket}/${objectKey(storageKey)}` }));
      return { storageKey: newKey };
    },
    remove,
    async stageRemove(storageKey) {
      return { commit: () => remove(storageKey), rollback: async () => {} };
    },
  };
}
