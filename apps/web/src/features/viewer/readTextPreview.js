export const TEXT_PREVIEW_MAX_BYTES = 50 * 1024;

export async function readTextPreview(response) {
  if (!response.ok || !response.body) throw new Error('Preview request failed');
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (length < TEXT_PREVIEW_MAX_BYTES) {
      const { value, done } = await reader.read();
      if (done) break;
      const part = value.subarray(0, TEXT_PREVIEW_MAX_BYTES - length);
      chunks.push(part);
      length += part.length;
    }
    if (length === TEXT_PREVIEW_MAX_BYTES) await reader.cancel();
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder().decode(bytes);
}
