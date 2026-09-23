/** @typedef {{ id: string, name: string, parentId: string, createdAt: string }} Folder */
/** @typedef {{ id: string, name: string, folderId: string, mimeType: string, size: number, createdAt: string }} FileRecord */

export const ROOT_FOLDER_ID = 'root';
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
export const MAX_NAME_LENGTH = 255;

export const routes = Object.freeze({
  health: '/v1/health',
  folders: '/v1/folders',
  children: (folderId) => `/v1/folders/${encodeURIComponent(folderId)}/children`,
  files: '/v1/files',
  file: (fileId) => `/v1/files/${encodeURIComponent(fileId)}`,
  content: (fileId) => `/v1/files/${encodeURIComponent(fileId)}/content`,
});

export function validName(name) {
  return typeof name === 'string'
    && name.length > 0
    && name.length <= MAX_NAME_LENGTH
    && name !== '.'
    && name !== '..'
    && !/[\\/\u0000-\u001f\u007f]/u.test(name)
    && name.trim().length > 0;
}

export function normalizeMimeType(value) {
  const mimeType = typeof value === 'string' ? value.split(';', 1)[0].trim().toLowerCase() : '';
  return /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/u.test(mimeType)
    ? mimeType
    : 'application/octet-stream';
}
