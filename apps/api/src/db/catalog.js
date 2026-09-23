import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { ROOT_FOLDER_ID } from '../../../../packages/shared/index.js';
import { ApiError } from '../routes/errors.js';

export async function openCatalog(path) {
  await mkdir(dirname(path), { recursive: true });
  let state;
  try {
    state = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    state = { schemaVersion: 1, folders: [], files: [] };
  }
  if (state.schemaVersion !== 1 || !Array.isArray(state.folders) || !Array.isArray(state.files)) {
    throw new Error('Unsupported or invalid catalog format');
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

  function folderExists(folderId, current = state) {
    return folderId === ROOT_FOLDER_ID || current.folders.some((folder) => folder.id === folderId);
  }

  return {
    async createFolder(name, parentId) {
      return write((next) => {
        if (!folderExists(parentId, next)) throw new ApiError(404, 'FOLDER_NOT_FOUND', 'Parent folder was not found');
        if (next.folders.some((folder) => folder.parentId === parentId && folder.name === name)) {
          throw new ApiError(409, 'NAME_CONFLICT', 'A folder with that name already exists here');
        }
        const folder = { id: randomUUID(), name, parentId, createdAt: new Date().toISOString() };
        next.folders.push(folder);
        return folder;
      });
    },
    async addFile(details) {
      return write((next) => {
        if (!folderExists(details.folderId, next)) throw new ApiError(404, 'FOLDER_NOT_FOUND', 'Folder was not found');
        const file = { id: randomUUID(), name: details.name, folderId: details.folderId,
          mimeType: details.mimeType, size: details.size, createdAt: new Date().toISOString(),
          storageKey: details.storageKey };
        next.files.push(file);
        return publicFile(file);
      });
    },
    listChildren(folderId) {
      if (!folderExists(folderId)) throw new ApiError(404, 'FOLDER_NOT_FOUND', 'Folder was not found');
      return {
        folderId,
        folders: state.folders.filter((folder) => folder.parentId === folderId),
        files: state.files.filter((file) => file.folderId === folderId).map(publicFile),
      };
    },
    getFile(fileId) {
      const file = state.files.find((item) => item.id === fileId);
      if (!file) throw new ApiError(404, 'FILE_NOT_FOUND', 'File was not found');
      return file;
    },
  };
}

export function publicFile(file) {
  const { storageKey, ...metadata } = file;
  return metadata;
}
