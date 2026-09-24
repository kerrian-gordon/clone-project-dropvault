import { MAX_UPLOAD_BYTES, ROOT_FOLDER_ID, SUPPORTED_UPLOAD_TYPES, normalizeMimeType, validName } from '../../../../../packages/shared/index.js';
import { ApiError } from '../../routes/errors.js';

const signatures = new Map([
  ['pdf', (bytes) => bytes.subarray(0, 5).equals(Buffer.from('%PDF-'))],
  ['docx', zipSignature], ['pptx', zipSignature], ['xlsx', zipSignature], ['zip', zipSignature],
  ['png', (bytes) => bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))],
  ['jpg', (bytes) => bytes.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex'))],
  ['jpeg', (bytes) => bytes.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex'))],
  ['gif', (bytes) => ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString())],
  ['webp', (bytes) => bytes.subarray(0, 4).toString() === 'RIFF'
    && bytes.subarray(8, 12).toString() === 'WEBP'],
  ['gz', (bytes) => bytes.subarray(0, 2).equals(Buffer.from('1f8b', 'hex'))],
]);
const officeParts = new Map([
  ['docx', 'word/document.xml'],
  ['pptx', 'ppt/presentation.xml'],
  ['xlsx', 'xl/workbook.xml'],
]);

function zipSignature(bytes) {
  return bytes.subarray(0, 4).equals(Buffer.from('504b0304', 'hex'));
}

export async function validateStoredFile(name, bytes, readZipEntries) {
  const extension = name.split('.').at(-1).toLowerCase();
  const matches = signatures.get(extension);
  if (matches && !matches(bytes)) {
    throw new ApiError(415, 'INVALID_FILE_CONTENT', 'File content does not match its type');
  }
  if (officeParts.has(extension)) {
    const entries = await readZipEntries();
    if (!entries.has('[Content_Types].xml') || !entries.has('_rels/.rels')
      || !entries.has(officeParts.get(extension))) {
      throw new ApiError(415, 'INVALID_FILE_CONTENT', 'Office package is missing required parts');
    }
  }
}

export function uploadDetails(request, url, catalog, userId, maxUploadBytes = MAX_UPLOAD_BYTES) {
  const name = url.searchParams.get('name');
  const folderId = url.searchParams.get('folderId') || ROOT_FOLDER_ID;
  if (!validName(name)) throw new ApiError(400, 'INVALID_NAME', 'Provide a valid file name');
  catalog.listChildren(folderId, userId);
  const declaredLength = request.headers['content-length'];
  if (declaredLength !== undefined && Number(declaredLength) > maxUploadBytes) {
    throw new ApiError(413, 'FILE_TOO_LARGE', 'File exceeds the upload limit');
  }
  const extension = name.split('.').at(-1).toLowerCase();
  const mimeType = SUPPORTED_UPLOAD_TYPES[extension];
  if (!mimeType) throw new ApiError(415, 'UNSUPPORTED_FILE_TYPE', 'File type is not supported');
  const declaredType = normalizeMimeType(request.headers['content-type']);
  if (declaredType !== 'application/octet-stream' && declaredType !== mimeType) {
    throw new ApiError(415, 'UNSUPPORTED_FILE_TYPE', 'File extension and content type do not match');
  }
  return { name, folderId, mimeType };
}
