import { open } from 'node:fs/promises';
import { ApiError } from '../../routes/errors.js';

const MAX_DIRECTORY_BYTES = 2 * 1024 * 1024;

function invalidZip() {
  return new ApiError(415, 'INVALID_FILE_CONTENT', 'Office file is not a valid ZIP package');
}

export async function zipEntryNames(path) {
  const file = await open(path, 'r');
  try {
    const { size } = await file.stat();
    const tailLength = Math.min(size, 65_557);
    const tail = Buffer.alloc(tailLength);
    await file.read(tail, 0, tailLength, size - tailLength);
    let end = -1;
    for (let at = tailLength - 22; at >= 0; at -= 1) {
      if (tail.readUInt32LE(at) === 0x06054b50
        && at + 22 + tail.readUInt16LE(at + 20) === tailLength) {
        end = at;
        break;
      }
    }
    if (end < 0 || tail.readUInt16LE(end + 4) !== 0 || tail.readUInt16LE(end + 6) !== 0) {
      throw invalidZip();
    }
    const count = tail.readUInt16LE(end + 10);
    const directorySize = tail.readUInt32LE(end + 12);
    const directoryOffset = tail.readUInt32LE(end + 16);
    const endOffset = size - tailLength + end;
    if (count === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff
      || directorySize > MAX_DIRECTORY_BYTES || directoryOffset + directorySize !== endOffset) {
      throw invalidZip();
    }
    const directory = Buffer.alloc(directorySize);
    await file.read(directory, 0, directorySize, directoryOffset);
    const names = new Set();
    let at = 0;
    for (let entry = 0; entry < count; entry += 1) {
      if (at + 46 > directory.length || directory.readUInt32LE(at) !== 0x02014b50) {
        throw invalidZip();
      }
      const nameLength = directory.readUInt16LE(at + 28);
      const extraLength = directory.readUInt16LE(at + 30);
      const commentLength = directory.readUInt16LE(at + 32);
      const next = at + 46 + nameLength + extraLength + commentLength;
      if (next > directory.length) throw invalidZip();
      names.add(directory.subarray(at + 46, at + 46 + nameLength).toString('utf8'));
      at = next;
    }
    if (at !== directory.length) throw invalidZip();
    return names;
  } finally {
    await file.close();
  }
}
