import assert from 'node:assert/strict';
import test from 'node:test';
import { readTextPreview, TEXT_PREVIEW_MAX_BYTES } from '../src/features/viewer/readTextPreview.js';

test('text preview stops after 50 KiB and cancels the remaining response', async () => {
  let canceled = false;
  const response = new Response(new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array(32 * 1024).fill(65)); },
    cancel() { canceled = true; },
  }));
  const preview = await readTextPreview(response);
  assert.equal(preview.length, TEXT_PREVIEW_MAX_BYTES);
  assert.equal(preview, 'A'.repeat(TEXT_PREVIEW_MAX_BYTES));
  assert.equal(canceled, true);
});

test('text preview rejects an API error response', async () => {
  await assert.rejects(readTextPreview(Response.json({ error: 'not found' }, { status: 404 })),
    /Preview request failed/u);
});
