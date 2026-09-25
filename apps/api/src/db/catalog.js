import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { ROOT_FOLDER_ID } from '../../../../packages/shared/index.js';
import { ApiError } from '../routes/errors.js';

export async function openCatalog(path) {
  await mkdir(dirname(path), { recursive: true });
  let state;
  let loadedFromDisk = true;
  try {
    state = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    loadedFromDisk = false;
    state = { schemaVersion: 1, folders: [], files: [], shares: [] };
  }
  if (state.schemaVersion !== 1 || !Array.isArray(state.folders) || !Array.isArray(state.files)) {
    throw new Error('Unsupported or invalid catalog format');
  }
  // Catalogs created before sharing was added have no shares field.
  state.shares ??= [];
  if (!Array.isArray(state.shares)) throw new Error('Invalid catalog shares');
  for (const share of state.shares) {
    share.id ??= share.tokenHash.slice(0, 32);
    share.expiresAt ??= new Date(Date.parse(share.createdAt) + 7 * 86_400_000).toISOString();
  }
  state.users ??= [];
  state.sessions ??= [];
  state.grants ??= [];
  if (![state.users, state.sessions, state.grants].every(Array.isArray)) {
    throw new Error('Invalid account catalog');
  }

  let pending = Promise.resolve();
  function write(change) {
    const operation = pending.then(async () => {
      const next = structuredClone(state);
      const result = change(next);
      const tempPath = `${path}.${randomUUID()}.tmp`;
      try {
        await writeFile(tempPath, JSON.stringify(next, null, 2));
        await rename(tempPath, path);
      } catch (error) {
        await rm(tempPath, { force: true });
        throw error;
      }
      state = next;
      return result;
    });
    pending = operation.catch(() => {});
    return operation;
  }

  function folderExists(folderId, ownerId, current = state) {
    return folderId === ROOT_FOLDER_ID || current.folders.some((folder) =>
      folder.id === folderId && folder.ownerId === ownerId);
  }

  function tokenHash(token) {
    return createHash('sha256').update(token).digest('hex');
  }

  return {
    loadedFromDisk,
    referencedStorageKeys() {
      return state.files.map((file) => file.storageKey);
    },
    async createUser(email, passwordHash) {
      return write((next) => {
        if (next.users.some((user) => user.email === email)) {
          throw new ApiError(409, 'ACCOUNT_EXISTS', 'Account already exists');
        }
        const user = { id: randomUUID(), email, passwordHash, tier: 'free',
          createdAt: new Date().toISOString() };
        next.users.push(user);
        return publicUser(user);
      });
    },
    async claimLegacy(userId) {
      return write((next) => {
        const folders = next.folders.filter((folder) => !folder.ownerId);
        const files = next.files.filter((file) => !file.ownerId);
        if (folders.length === 0 && files.length === 0) {
          throw new ApiError(409, 'NO_LEGACY_FILES', 'No unclaimed files or folders remain');
        }
        for (const folder of folders) folder.ownerId = userId;
        for (const file of files) file.ownerId = userId;
        return { foldersClaimed: folders.length, filesClaimed: files.length };
      });
    },
    findUser(email) {
      return state.users.find((user) => user.email === email);
    },
    getUser(userId) {
      const user = state.users.find((item) => item.id === userId);
      if (!user) throw new ApiError(401, 'UNAUTHENTICATED', 'Sign in to continue');
      return publicUser(user);
    },
    async createSession(userId, token, expiresAt) {
      return write((next) => {
        next.sessions.push({ userId, tokenHash: tokenHash(token), expiresAt });
      });
    },
    sessionUser(token) {
      if (!/^[A-Za-z0-9_-]{43}$/u.test(token)) return null;
      const session = state.sessions.find((item) => item.tokenHash === tokenHash(token)
        && Date.parse(item.expiresAt) > Date.now());
      return session ? state.users.find((user) => user.id === session.userId) ?? null : null;
    },
    async deleteSession(token) {
      return write((next) => {
        next.sessions = next.sessions.filter((item) => item.tokenHash !== tokenHash(token));
      });
    },
    async setTier(userId, tier) {
      return write((next) => {
        const user = next.users.find((item) => item.id === userId);
        if (!user) throw new ApiError(404, 'ACCOUNT_NOT_FOUND', 'Account was not found');
        user.tier = tier;
        return publicUser(user);
      });
    },
    async createFolder(name, parentId, ownerId) {
      return write((next) => {
        if (!folderExists(parentId, ownerId, next)) throw new ApiError(404, 'FOLDER_NOT_FOUND', 'Parent folder was not found');
        if (next.folders.some((folder) => folder.parentId === parentId && folder.ownerId === ownerId
          && folder.name === name)) {
          throw new ApiError(409, 'NAME_CONFLICT', 'A folder with that name already exists here');
        }
        const folder = { id: randomUUID(), name, parentId, ownerId, createdAt: new Date().toISOString() };
        next.folders.push(folder);
        return folder;
      });
    },
    async addFile(details) {
      return write((next) => {
        if (!folderExists(details.folderId, details.ownerId, next)) {
          throw new ApiError(404, 'FOLDER_NOT_FOUND', 'Folder was not found');
        }
        const file = { id: randomUUID(), name: details.name, folderId: details.folderId,
          ownerId: details.ownerId, mimeType: details.mimeType, size: details.size,
          createdAt: new Date().toISOString(),
          storageKey: details.storageKey };
        next.files.push(file);
        return publicFile(file);
      });
    },
    async deleteFolder(folderId, userId) {
      return write((next) => {
        if (folderId === ROOT_FOLDER_ID) throw new ApiError(400, 'INVALID_FOLDER', 'Root folder cannot be deleted');
        const index = next.folders.findIndex((folder) => folder.id === folderId && folder.ownerId === userId);
        if (index === -1) throw new ApiError(404, 'FOLDER_NOT_FOUND', 'Folder was not found');
        if (next.folders.some((folder) => folder.parentId === folderId)
          || next.files.some((file) => file.folderId === folderId)) {
          throw new ApiError(409, 'FOLDER_NOT_EMPTY', 'Folder must be empty before deletion');
        }
        next.folders.splice(index, 1);
      });
    },
    async deleteFile(fileId, userId) {
      return write((next) => {
        const index = next.files.findIndex((file) => file.id === fileId && file.ownerId === userId);
        if (index === -1) throw new ApiError(404, 'FILE_NOT_FOUND', 'File was not found');
        next.files.splice(index, 1);
        next.shares = next.shares.filter((share) => share.fileId !== fileId);
        next.grants = next.grants.filter((grant) => grant.fileId !== fileId);
      });
    },
    usage(userId, freeLimitBytes) {
      const user = this.getUser(userId);
      const limitBytes = user.tier === 'demo' ? freeLimitBytes * 10 : freeLimitBytes;
      return { usedBytes: state.files.filter((file) => file.ownerId === userId)
        .reduce((total, file) => total + file.size, 0), limitBytes, tier: user.tier };
    },
    async createShare(fileId, userId) {
      const token = randomBytes(32).toString('base64url');
      const id = randomUUID();
      const expiresAt = new Date(Date.now() + 7 * 86_400_000).toISOString();
      await write((next) => {
        if (!next.files.some((file) => file.id === fileId && file.ownerId === userId)) {
          throw new ApiError(404, 'FILE_NOT_FOUND', 'File was not found');
        }
        next.shares.push({ id, tokenHash: tokenHash(token), fileId,
          createdAt: new Date().toISOString(), expiresAt });
      });
      return { id, token, expiresAt };
    },
    listShares(fileId, userId) {
      this.getFile(fileId, userId, 'manage');
      return state.shares.filter((share) => share.fileId === fileId)
        .map(({ id, createdAt, expiresAt }) => ({ id, createdAt, expiresAt: expiresAt ?? null }));
    },
    async revokeShare(fileId, userId, shareId) {
      return write((next) => {
        if (!next.files.some((file) => file.id === fileId && file.ownerId === userId)) {
          throw new ApiError(404, 'FILE_NOT_FOUND', 'File was not found');
        }
        const index = next.shares.findIndex((share) => share.id === shareId && share.fileId === fileId);
        if (index === -1) throw new ApiError(404, 'SHARE_NOT_FOUND', 'Share link was not found');
        next.shares.splice(index, 1);
      });
    },
    async grantFile(fileId, ownerId, email) {
      return write((next) => {
        const file = next.files.find((item) => item.id === fileId && item.ownerId === ownerId);
        if (!file) throw new ApiError(404, 'FILE_NOT_FOUND', 'File was not found');
        const recipient = next.users.find((user) => user.email === email);
        if (!recipient) throw new ApiError(404, 'ACCOUNT_NOT_FOUND', 'Recipient was not found');
        if (recipient.id === ownerId) throw new ApiError(400, 'INVALID_RECIPIENT', 'Owner already has access');
        if (!next.grants.some((grant) => grant.fileId === fileId && grant.userId === recipient.id)) {
          next.grants.push({ fileId, userId: recipient.id, createdAt: new Date().toISOString() });
        }
        return { userId: recipient.id, email: recipient.email };
      });
    },
    listGrants(fileId, ownerId) {
      this.getFile(fileId, ownerId, 'manage');
      return state.grants.filter((grant) => grant.fileId === fileId).map((grant) => {
        const user = state.users.find((item) => item.id === grant.userId);
        return { userId: grant.userId, email: user?.email, createdAt: grant.createdAt };
      });
    },
    async revokeGrant(fileId, ownerId, recipientId) {
      return write((next) => {
        if (!next.files.some((file) => file.id === fileId && file.ownerId === ownerId)) {
          throw new ApiError(404, 'FILE_NOT_FOUND', 'File was not found');
        }
        next.grants = next.grants.filter((grant) => !(grant.fileId === fileId
          && grant.userId === recipientId));
      });
    },
    listShared(userId) {
      const ids = new Set(state.grants.filter((grant) => grant.userId === userId)
        .map((grant) => grant.fileId));
      return state.files.filter((file) => ids.has(file.id)).map(publicFile);
    },
    getSharedFile(token) {
      if (!/^[A-Za-z0-9_-]{43}$/u.test(token)) {
        throw new ApiError(404, 'SHARE_NOT_FOUND', 'Share link was not found');
      }
      const share = state.shares.find((item) => item.tokenHash === tokenHash(token));
      if (!share || (share.expiresAt && Date.parse(share.expiresAt) <= Date.now())) {
        throw new ApiError(404, 'SHARE_NOT_FOUND', 'Share link was not found');
      }
      const file = state.files.find((item) => item.id === share.fileId);
      if (!file) throw new ApiError(404, 'SHARE_NOT_FOUND', 'Share link was not found');
      return file;
    },
    listChildren(folderId, userId) {
      if (!folderExists(folderId, userId)) throw new ApiError(404, 'FOLDER_NOT_FOUND', 'Folder was not found');
      return {
        folderId,
        folders: state.folders.filter((folder) => folder.parentId === folderId
          && folder.ownerId === userId),
        files: state.files.filter((file) => file.folderId === folderId
          && file.ownerId === userId).map(publicFile),
      };
    },
    getFile(fileId, userId, action = 'read') {
      const file = state.files.find((item) => item.id === fileId);
      if (!file || (file.ownerId !== userId && (action === 'manage'
        || !state.grants.some((grant) => grant.fileId === fileId && grant.userId === userId)))) {
        throw new ApiError(404, 'FILE_NOT_FOUND', 'File was not found');
      }
      return file;
    },
  };
}

export function publicFile(file) {
  const { storageKey, ...metadata } = file;
  return metadata;
}

export function publicUser(user) {
  const { passwordHash, ...profile } = user;
  return profile;
}
