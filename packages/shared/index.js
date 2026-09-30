/** @typedef {{ id: string, name: string, parentId: string, ownerId: string, createdAt: string }} Folder */
/** @typedef {{ id: string, name: string, folderId: string, ownerId: string, mimeType: string, size: number, createdAt: string }} FileRecord */
/** @typedef {{ id: string, fileId: string, name: string, mimeType: string, size: number, createdAt: string, kind: 'uploaded' | 'replaced' | 'restored' | 'copied', restoredFrom?: string, copiedFromVersionId?: string, copiedFromSnapshotId?: string, label: string }} FileVersion */
/** @typedef {{ archiveFileId: string, archiveVersionId: string, commitSha: string, verification: 'zip-comment', commitVerified: false }} GitArchiveLink */
/** @typedef {{ id: string, ownerId: string, name: string, description: string, fileIds: string[], git?: GitArchiveLink, createdAt: string }} Workspace */
/** @typedef {{ fileId: string, versionId: string, name: string, folderId: string, folderPath: string[], mimeType: string, size: number }} SnapshotItem */
/** @typedef {{ id: string, workspaceId: string, ownerId: string, createdById: string, createdByName: string, name: string, note: string, items: SnapshotItem[], git: GitArchiveLink | null, createdAt: string }} Snapshot */
/** @typedef {{ id: string, email: string, displayName: string, tier: 'free' | 'demo', createdAt: string }} User */
/** @typedef {{ usedBytes: number, limitBytes: number, tier: 'free' | 'demo' }} StorageUsage */
/** @typedef {{ colors: { background: string, surface: string, text: string, accent: string }, font: 'Inter' | 'Arial' | 'Georgia', spacing: 'compact' | 'comfortable' }} ThemeSettings */
/** @typedef {{ id: string, creatorId: string, creatorName: string, name: string, settings: ThemeSettings, createdAt: string }} Theme */
/** @typedef {{ sourceThemeId: string | null, name: string, settings: ThemeSettings, selectedAt: string | null, updatedAt: string | null }} Appearance */

export { DEFAULT_THEME_SETTINGS, THEME_FONTS, THEME_SPACINGS, contrastRatio,
  publicCreatorName, themeContrastIssues, uniqueDisplayName, validCreatorName, validThemeName,
  validThemeSettings } from './themes.js';

export const ROOT_FOLDER_ID = 'root';
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
export const DEFAULT_STORAGE_LIMIT_BYTES = 1024 * 1024 * 1024;
export const MAX_NAME_LENGTH = 255;
export const SUPPORTED_UPLOAD_TYPES = Object.freeze({
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  txt: 'text/plain', csv: 'text/csv', json: 'application/json',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', webp: 'image/webp',
  mp3: 'audio/mpeg', mp4: 'video/mp4',
  zip: 'application/zip', gz: 'application/gzip',
});

export const routes = Object.freeze({
  health: '/v1/health',
  register: '/v1/auth/register',
  login: '/v1/auth/login',
  logout: '/v1/auth/logout',
  account: '/v1/account',
  themes: '/v1/themes',
  theme: (themeId) => `/v1/themes/${encodeURIComponent(themeId)}`,
  appearance: '/v1/account/appearance',
  appearanceSettings: '/v1/account/appearance/settings',
  claimLegacy: '/v1/account/claim-legacy',
  plan: '/v1/account/plan',
  folders: '/v1/folders',
  organizationSuggestions: '/v1/organization/suggestions',
  organizationDecision: (suggestionId) => `/v1/organization/suggestions/${encodeURIComponent(suggestionId)}/decision`,
  organizationStats: '/v1/organization/stats',
  folder: (folderId) => `/v1/folders/${encodeURIComponent(folderId)}`,
  children: (folderId) => `/v1/folders/${encodeURIComponent(folderId)}/children`,
  files: '/v1/files',
  ownedFiles: '/v1/files/owned',
  sharedFiles: '/v1/files/shared',
  file: (fileId) => `/v1/files/${encodeURIComponent(fileId)}`,
  content: (fileId) => `/v1/files/${encodeURIComponent(fileId)}/content`,
  versions: (fileId) => `/v1/files/${encodeURIComponent(fileId)}/versions`,
  version: (fileId, versionId) => `/v1/files/${encodeURIComponent(fileId)}/versions/${encodeURIComponent(versionId)}`,
  versionContent: (fileId, versionId) => `/v1/files/${encodeURIComponent(fileId)}/versions/${encodeURIComponent(versionId)}/content`,
  restoreVersion: (fileId, versionId) => `/v1/files/${encodeURIComponent(fileId)}/versions/${encodeURIComponent(versionId)}/restore`,
  workspaces: '/v1/workspaces',
  workspace: (workspaceId) => `/v1/workspaces/${encodeURIComponent(workspaceId)}`,
  workspaceFiles: (workspaceId) => `/v1/workspaces/${encodeURIComponent(workspaceId)}/files`,
  workspaceFile: (workspaceId, fileId) => `/v1/workspaces/${encodeURIComponent(workspaceId)}/files/${encodeURIComponent(fileId)}`,
  workspaceContent: (workspaceId, fileId) => `/v1/workspaces/${encodeURIComponent(workspaceId)}/files/${encodeURIComponent(fileId)}/content`,
  workspaceUpload: (workspaceId, name) => `/v1/workspaces/${encodeURIComponent(workspaceId)}/uploads?name=${encodeURIComponent(name)}`,
  workspaceVersion: (workspaceId, fileId) => `/v1/workspaces/${encodeURIComponent(workspaceId)}/files/${encodeURIComponent(fileId)}/versions`,
  workspaceAccess: (workspaceId) => `/v1/workspaces/${encodeURIComponent(workspaceId)}/access`,
  workspaceGit: (workspaceId) => `/v1/workspaces/${encodeURIComponent(workspaceId)}/git`,
  workspaceRecipient: (workspaceId, userId) => `/v1/workspaces/${encodeURIComponent(workspaceId)}/access/${encodeURIComponent(userId)}`,
  snapshots: (workspaceId) => `/v1/workspaces/${encodeURIComponent(workspaceId)}/snapshots`,
  sharedSnapshots: '/v1/snapshots/shared',
  snapshot: (snapshotId) => `/v1/snapshots/${encodeURIComponent(snapshotId)}`,
  snapshotAccess: (snapshotId) => `/v1/snapshots/${encodeURIComponent(snapshotId)}/access`,
  snapshotRecipient: (snapshotId, userId) => `/v1/snapshots/${encodeURIComponent(snapshotId)}/access/${encodeURIComponent(userId)}`,
  snapshotContent: (snapshotId, fileId) => `/v1/snapshots/${encodeURIComponent(snapshotId)}/files/${encodeURIComponent(fileId)}/content`,
  snapshotArchive: (snapshotId) => `/v1/snapshots/${encodeURIComponent(snapshotId)}/archive`,
  snapshotCopy: (snapshotId) => `/v1/snapshots/${encodeURIComponent(snapshotId)}/copy`,
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
