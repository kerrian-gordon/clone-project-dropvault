import assert from 'node:assert/strict';
import test from 'node:test';
import { recognizeBytes, recognizeFile, RECOGNITION_MAX_BYTES } from '../src/features/upload/recognizeFile.js';

const utf8 = (text) => new TextEncoder().encode(text);

function simpleZip(files) {
  const local = [];
  const directory = [];
  let offset = 0;
  for (const [name, contents] of files) {
    const nameBytes = utf8(name);
    const data = utf8(contents);
    const header = new Uint8Array(30 + nameBytes.length);
    const h = new DataView(header.buffer);
    h.setUint32(0, 0x04034b50, true);
    h.setUint16(4, 20, true);
    h.setUint32(18, data.length, true);
    h.setUint32(22, data.length, true);
    h.setUint16(26, nameBytes.length, true);
    header.set(nameBytes, 30);
    local.push(header, data);
    const central = new Uint8Array(46 + nameBytes.length);
    const c = new DataView(central.buffer);
    c.setUint32(0, 0x02014b50, true);
    c.setUint16(4, 20, true);
    c.setUint16(6, 20, true);
    c.setUint32(20, data.length, true);
    c.setUint32(24, data.length, true);
    c.setUint16(28, nameBytes.length, true);
    c.setUint32(42, offset, true);
    central.set(nameBytes, 46);
    directory.push(central);
    offset += header.length + data.length;
  }
  const directorySize = directory.reduce((sum, part) => sum + part.length, 0);
  const end = new Uint8Array(22);
  const e = new DataView(end.buffer);
  e.setUint32(0, 0x06054b50, true);
  e.setUint16(8, files.length, true);
  e.setUint16(10, files.length, true);
  e.setUint32(12, directorySize, true);
  e.setUint32(16, offset, true);
  const parts = [...local, ...directory, end];
  const output = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) { output.set(part, at); at += part.length; }
  return output;
}

test('recognizes plausible PDF but abstains on a marker-only fake', async () => {
  const invalidOffset = utf8('%PDF-1.7\n1 0 obj\n<<>>\nendobj\nxref\n0 1\n0000000000 65535 f\ntrailer\n<<>>\nstartxref\n999\n%%EOF');
  // The cross-reference offset must point at the actual xref bytes.
  const xref = utf8('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n');
  const pdf = utf8(`${new TextDecoder().decode(xref)}xref\n0 1\n0000000000 65535 f\ntrailer\n<<>>\nstartxref\n${xref.length}\n%%EOF`);
  assert.equal((await recognizeBytes(pdf)).format, 'PDF');
  assert.equal((await recognizeBytes(invalidOffset)).format, 'UNKNOWN');
  assert.equal((await recognizeBytes(utf8('%PDF-1.7\nthis is only text\n%%EOF'))).format, 'UNKNOWN');
});

test('recognizes JSON structures and abstains on malformed or scalar JSON', async () => {
  assert.equal((await recognizeBytes(utf8('{"a": 1}'))).format, 'JSON');
  assert.equal((await recognizeBytes(utf8('[1,2,3]'))).format, 'JSON');
  assert.equal((await recognizeBytes(utf8('{"a":'))).format, 'UNKNOWN');
  assert.equal((await recognizeBytes(utf8('123'))).format, 'UNKNOWN');
});

test('recognizes numeric tables and text while abstaining on comma prose', async () => {
  assert.equal((await recognizeBytes(utf8('name,count\nAda,12\nBob,18\n'))).format, 'CSV');
  assert.equal((await recognizeBytes(utf8('Metadata from instrument\nCollected on Tuesday\nname,count,value\nAda,12,2.5\nBob,18,4.0\n'))).format, 'CSV');
  assert.equal((await recognizeBytes(utf8('Hello, Ada\nGoodbye, Bob\n'))).format, 'UNKNOWN');
  assert.equal((await recognizeBytes(utf8('Hello world.\nA second sentence.\n'))).format, 'TXT');
});

test('recognizes a bounded ZIP and abstains on malformed or conflicting packages', async () => {
  assert.equal((await recognizeBytes(simpleZip([['notes.txt', 'hello']]))).format, 'ZIP');
  assert.equal((await recognizeBytes(simpleZip([['notes.txt', 'a'], ['notes.txt', 'b']]))).format, 'UNKNOWN');
  assert.equal((await recognizeBytes(simpleZip([['[Content_Types].xml', '<Types/>']]))).format, 'UNKNOWN');
  const truncated = simpleZip([['notes.txt', 'hello']]).subarray(0, 20);
  assert.equal((await recognizeBytes(truncated)).format, 'UNKNOWN');
});

test('keeps binary, markup, and oversized files unclassified without reading them', async () => {
  assert.equal((await recognizeBytes(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0]))).format, 'UNKNOWN');
  assert.equal((await recognizeBytes(utf8('<html><body>Hi</body></html>'))).format, 'UNKNOWN');
  let read = false;
  const oversized = { size: RECOGNITION_MAX_BYTES + 1, slice() { read = true; throw new Error('read'); } };
  assert.equal((await recognizeFile(oversized)).format, 'UNKNOWN');
  assert.equal(read, false);
  const file = new File([utf8('{"kind":"test"}')], 'misleading.pdf');
  assert.equal((await recognizeFile(file)).format, 'JSON');
});
