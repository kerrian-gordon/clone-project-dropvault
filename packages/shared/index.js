/** @typedef {{ id: string, name: string, parentId: string, ownerId: string, createdAt: string }} Folder */
/** @typedef {{ id: string, name: string, folderId: string, ownerId: string, mimeType: string, size: number, createdAt: string }} FileRecord */
/** @typedef {{ id: string, email: string, tier: 'free' | 'demo', createdAt: string }} User */
/** @typedef {{ usedBytes: number, limitBytes: number, tier: 'free' | 'demo' }} StorageUsage */

export const ROOT_FOLDER_ID = 'root';
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
export const DEFAULT_STORAGE_LIMIT_BYTES = 1024 * 1024 * 1024;
export const MAX_NAME_LENGTH = 255;

export const routes = Object.freeze({
  health: '/v1/health',
  register: '/v1/auth/register',
  login: '/v1/auth/login',
  logout: '/v1/auth/logout',
  account: '/v1/account',
  plan: '/v1/account/plan',
  folders: '/v1/folders',
  children: (folderId) => `/v1/folders/${encodeURIComponent(folderId)}/children`,
  files: '/v1/files',
  sharedFiles: '/v1/files/shared',
  file: (fileId) => `/v1/files/${encodeURIComponent(fileId)}`,
  content: (fileId) => `/v1/files/${encodeURIComponent(fileId)}/content`,
  usage: '/v1/storage/usage',
  shares: (fileId) => `/v1/files/${encodeURIComponent(fileId)}/shares`,
  revokeShare: (fileId, shareId) => `/v1/files/${encodeURIComponent(fileId)}/shares/${encodeURIComponent(shareId)}`,
  share: (token) => `/v1/shares/${encodeURIComponent(token)}`,
  access: (fileId) => `/v1/files/${encodeURIComponent(fileId)}/access`,
  revokeAccess: (fileId, userId) => `/v1/files/${encodeURIComponent(fileId)}/access/${encodeURIComponent(userId)}`,
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
