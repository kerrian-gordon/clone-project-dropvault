import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';
import { openS3Storage } from '../src/services/storage/s3.js';

test('S3 adapter stores, reads, copies, and cleans unreferenced objects', async () => {
  const objects = new Map();
  const client = { async send(command) {
    const input = command.input;
    switch (command.constructor.name) {
      case 'PutObjectCommand': {
        const chunks = [];
        for await (const chunk of input.Body) chunks.push(chunk);
        const bytes = Buffer.concat(chunks);
        assert.equal(bytes.length, input.ContentLength);
        objects.set(input.Key, bytes);
        return {};
      }
      case 'GetObjectCommand': {
        const bytes = objects.get(input.Key);
        if (!bytes) throw new Error('Missing object');
        return { Body: Readable.from([input.Range ? bytes.subarray(0, 12) : bytes]) };
      }
      case 'CopyObjectCommand':
        objects.set(input.Key, Buffer.from(objects.get(input.CopySource.split('/').slice(1).join('/'))));
        return {};
      case 'DeleteObjectCommand': objects.delete(input.Key); return {};
      case 'ListObjectsV2Command':
        return { Contents: [...objects.keys()].filter((key) => key.startsWith(input.Prefix))
          .map((Key) => ({ Key })) };
      default: throw new Error(`Unexpected S3 command: ${command.constructor.name}`);
    }
  } };
  const storage = await openS3Storage({ bucket: 'test-bucket', region: 'us-east-1',
    prefix: 'project/', client });
  const saved = await storage.save(Readable.from([Buffer.from('sample bytes')]), 100, 100);
  assert.equal(saved.size, 12);
  assert.equal((await storage.sample(saved.storageKey)).toString(), 'sample bytes');
  const downloaded = [];
  for await (const chunk of storage.read(saved.storageKey)) downloaded.push(chunk);
  assert.equal(Buffer.concat(downloaded).toString(), 'sample bytes');
  const copy = await storage.copy(saved.storageKey);
  assert.notEqual(copy.storageKey, saved.storageKey);
  assert.equal(objects.size, 2);
  await storage.recoverOrphanUploads([saved.storageKey]);
  assert.equal(objects.size, 1);
  const staged = await storage.stageRemove(saved.storageKey);
  await staged.rollback();
  assert.equal(objects.size, 1);
  await staged.commit();
  assert.equal(objects.size, 0);
});
