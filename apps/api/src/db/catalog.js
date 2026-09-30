import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { DEFAULT_THEME_SETTINGS, ROOT_FOLDER_ID, publicCreatorName, themeContrastIssues, uniqueDisplayName,
  validCreatorName, validThemeName, validThemeSettings } from '../../../../packages/shared/index.js';
import { ApiError } from '../routes/errors.js';
import { suggestFolder } from '../modules/files/suggest.js';

const MAX_THEMES_PER_ACCOUNT = 20;

function defaultAppearance() {
  return { sourceThemeId: null, name: 'Default',
    settings: structuredClone(DEFAULT_THEME_SETTINGS), selectedAt: null, updatedAt: null };
}

export async function openCatalog(path, persistence) {
  if (!persistence) await mkdir(dirname(path), { recursive: true });
  let state;
  try {
    const raw = persistence ? await persistence.load() : await readFile(path, 'utf8');
    if (raw === null) { const missing = new Error('Catalog does not exist'); missing.code = 'ENOENT'; throw missing; }
    state = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
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
  state.themes ??= [];
  state.appearances ??= [];
  state.versions ??= [];
  state.workspaces ??= [];
  state.workspaceGrants ??= [];
  state.snapshots ??= [];
  state.snapshotGrants ??= [];
  state.organizationSuggestions ??= [];
  state.organizationStats ??= [];
  if (![state.users, state.sessions, state.grants, state.themes,
    state.appearances, state.versions, state.workspaces, state.workspaceGrants, state.snapshots,
    state.snapshotGrants,
    state.organizationSuggestions, state.organizationStats].every(Array.isArray)) {
    throw new Error('Invalid account catalog');
  }
  // Older catalogs stored only the current file. Give that content a stable
  // first revision without rewriting the catalog until the next mutation.
  for (const file of state.files) {
    file.currentVersionId ??= file.id;
    if (!state.versions.some((version) => version.id === file.currentVersionId && version.fileId === file.id)) {
      state.versions.push({ id: file.currentVersionId, fileId: file.id, name: file.name,
        storageKey: file.storageKey, mimeType: file.mimeType, size: file.size,
        createdAt: file.createdAt, kind: 'uploaded', label: '' });
    }
  }
  for (const theme of state.themes) theme.creatorName ??= 'Community member';
  const takenNames = [];
  for (const user of state.users) {
    if (validCreatorName(user.displayName)) takenNames.push(user.displayName);
  }
  for (const user of state.users) {
    if (validCreatorName(user.displayName)) continue;
    user.displayName = uniqueDisplayName(publicCreatorName(user.email), takenNames)
      ?? 'Community member';
    takenNames.push(user.displayName);
  }
  // Legacy and manually linked ZIP comments are labels, not repository proof.
  for (const workspace of state.workspaces) {
    if (workspace.git?.verification !== 'github-api' && workspace.git) {
      workspace.git.commitVerified = false;
    } else if (workspace.git?.verification === 'github-api') {
      workspace.git.repositoryUrl ??= `https://github.com/${workspace.git.repositoryFullName}`;
      workspace.git.sourceUrl ??= `${workspace.git.repositoryUrl}/tree/${workspace.git.commitSha}`;
    }
  }
  for (const snapshot of state.snapshots) {
    snapshot.createdById ??= snapshot.ownerId;
    snapshot.createdByName ??= state.users.find((user) => user.id === snapshot.createdById)
      ?.displayName ?? 'Community member';
    if (snapshot.git?.verification !== 'github-api' && snapshot.git) {
      snapshot.git.commitVerified = false;
    } else if (snapshot.git?.verification === 'github-api') {
      snapshot.git.repositoryUrl ??= `https://github.com/${snapshot.git.repositoryFullName}`;
      snapshot.git.sourceUrl ??= `${snapshot.git.repositoryUrl}/tree/${snapshot.git.commitSha}`;
    }
  }

  let pending = Promise.resolve();
  function write(change) {
    const operation = pending.then(async () => {
      const next = structuredClone(state);
      const result = change(next);
      if (persistence) await persistence.save(next);
      else {
        const tempPath = `${path}.${randomUUID()}.tmp`;
        try {
          await writeFile(tempPath, JSON.stringify(next, null, 2));
          await rename(tempPath, path);
        } catch (error) {
          await rm(tempPath, { force: true });
          throw error;
        }
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

  function ownedWorkspace(current, workspaceId, userId) {
    const workspace = current.workspaces.find((item) => item.id === workspaceId && item.ownerId === userId);
    if (!workspace) throw new ApiError(404, 'WORKSPACE_NOT_FOUND', 'Workspace was not found');
    return workspace;
  }

  function accessibleWorkspace(current, workspaceId, userId, action = 'read') {
    const workspace = current.workspaces.find((item) => item.id === workspaceId);
    if (!workspace) throw new ApiError(404, 'WORKSPACE_NOT_FOUND', 'Workspace was not found');
    if (workspace.ownerId === userId) return workspace;
    const grant = current.workspaceGrants.find((item) => item.workspaceId === workspaceId
      && item.userId === userId);
    if (!grant || action === 'manage' || (action === 'contribute' && grant.role !== 'contributor')) {
      throw new ApiError(404, 'WORKSPACE_NOT_FOUND', 'Workspace was not found');
    }
    return workspace;
  }

  function accessibleSnapshot(current, snapshotId, userId, manage = false) {
    const snapshot = current.snapshots.find((item) => item.id === snapshotId);
    if (!snapshot) throw new ApiError(404, 'SNAPSHOT_NOT_FOUND', 'Snapshot was not found');
    if (snapshot.ownerId === userId) return snapshot;
    if (!manage && current.workspaceGrants.some((grant) => grant.workspaceId === snapshot.workspaceId
      && grant.userId === userId)) return snapshot;
    if (manage || !current.snapshotGrants.some((grant) => grant.snapshotId === snapshotId
      && grant.userId === userId) || !snapshot.items.every((item) =>
      current.grants.some((grant) => grant.fileId === item.fileId && grant.userId === userId))) {
      throw new ApiError(404, 'SNAPSHOT_NOT_FOUND', 'Snapshot was not found');
    }
    return snapshot;
  }

  return {
    close: () => persistence?.close(),
    referencedStorageKeys() {
      return [...new Set([...state.files.map((file) => file.storageKey),
        ...state.versions.map((version) => version.storageKey)])];
    },
    async createUser(email, passwordHash, requestedName) {
      return write((next) => {
        if (next.users.some((user) => user.email === email)) {
          throw new ApiError(409, 'ACCOUNT_EXISTS', 'Account already exists');
        }
        const requested = typeof requestedName === 'string' && requestedName.trim()
          ? requestedName.trim() : publicCreatorName(email);
        if (!validCreatorName(requested)) {
          throw new ApiError(400, 'INVALID_DISPLAY_NAME', 'Provide a public display name');
        }
        const displayName = uniqueDisplayName(requested, next.users.map((user) => user.displayName));
        if (!displayName) {
          throw new ApiError(400, 'INVALID_DISPLAY_NAME', 'Provide a public display name');
        }
        const user = { id: randomUUID(), email, passwordHash, displayName, tier: 'free',
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
    listThemes(offset = 0, limit = 20, query = '') {
      const needle = query.trim().toLowerCase();
      const matched = needle
        ? state.themes.filter((theme) => theme.name.toLowerCase().includes(needle)
          || theme.creatorName.toLowerCase().includes(needle))
        : state.themes;
      const sorted = [...matched].sort((left, right) =>
        right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id));
      return { themes: sorted.slice(offset, offset + limit), total: sorted.length,
        nextOffset: offset + limit < sorted.length ? offset + limit : null };
    },
    getTheme(themeId) {
      const theme = state.themes.find((item) => item.id === themeId);
      if (!theme) throw new ApiError(404, 'THEME_NOT_FOUND', 'Theme was not found');
      return theme;
    },
    async createTheme(creatorId, name, settings) {
      if (!validThemeName(name)) throw new ApiError(400, 'INVALID_THEME_NAME', 'Provide a valid theme name');
      if (!validThemeSettings(settings)) {
        throw new ApiError(400, 'INVALID_THEME_SETTINGS', 'Provide supported theme settings');
      }
      if (themeContrastIssues(settings).length) {
        throw new ApiError(400, 'INVALID_THEME_CONTRAST', themeContrastIssues(settings).join('; '));
      }
      return write((next) => {
        const creator = next.users.find((item) => item.id === creatorId);
        const creatorName = creator?.displayName;
        if (!validCreatorName(creatorName)) {
          throw new ApiError(400, 'INVALID_DISPLAY_NAME', 'Provide a public display name');
        }
        if (next.themes.filter((theme) => theme.creatorId === creatorId).length
          >= MAX_THEMES_PER_ACCOUNT) {
          throw new ApiError(409, 'THEME_LIMIT_REACHED', 'Theme publishing limit reached');
        }
        const theme = { id: randomUUID(), creatorId, creatorName: creatorName.trim(), name: name.trim(),
          settings: structuredClone(settings), createdAt: new Date().toISOString() };
        next.themes.push(theme);
        return theme;
      });
    },
    async deleteTheme(themeId, creatorId) {
      return write((next) => {
        const index = next.themes.findIndex((item) => item.id === themeId && item.creatorId === creatorId);
        if (index === -1) throw new ApiError(404, 'THEME_NOT_FOUND', 'Theme was not found');
        next.themes.splice(index, 1);
      });
    },
    getAppearance(userId) {
      this.getUser(userId);
      const appearance = state.appearances.find((item) => item.userId === userId);
      if (!appearance) return defaultAppearance();
      const { userId: _userId, ...publicAppearance } = appearance;
      return publicAppearance;
    },
    async installTheme(userId, themeId) {
      return write((next) => {
        const theme = next.themes.find((item) => item.id === themeId);
        if (!theme) throw new ApiError(404, 'THEME_NOT_FOUND', 'Theme was not found');
        const selectedAt = new Date().toISOString();
        const appearance = { userId, sourceThemeId: theme.id, name: theme.name,
          settings: structuredClone(theme.settings), selectedAt, updatedAt: selectedAt };
        next.appearances = next.appearances.filter((item) => item.userId !== userId);
        next.appearances.push(appearance);
        const { userId: _userId, ...publicAppearance } = appearance;
        return publicAppearance;
      });
    },
    async saveAppearanceSettings(userId, settings) {
      if (!validThemeSettings(settings)) {
        throw new ApiError(400, 'INVALID_THEME_SETTINGS', 'Provide supported theme settings');
      }
      if (themeContrastIssues(settings).length) {
        throw new ApiError(400, 'INVALID_THEME_CONTRAST', themeContrastIssues(settings).join('; '));
      }
      return write((next) => {
        let appearance = next.appearances.find((item) => item.userId === userId);
        if (!appearance) {
          appearance = { userId, sourceThemeId: null, name: 'Default',
            selectedAt: new Date().toISOString() };
          next.appearances.push(appearance);
        }
        appearance.settings = structuredClone(settings);
        appearance.updatedAt = new Date().toISOString();
        const { userId: _userId, ...publicAppearance } = appearance;
        return publicAppearance;
      });
    },
    async resetAppearance(userId) {
      await write((next) => {
        next.appearances = next.appearances.filter((item) => item.userId !== userId);
      });
      return defaultAppearance();
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
    listWorkspaces(userId) {
      const shared = new Set(state.workspaceGrants.filter((item) => item.userId === userId)
        .map((item) => item.workspaceId));
      return state.workspaces.filter((item) => item.ownerId === userId || shared.has(item.id));
    },
    getWorkspace(workspaceId, userId, action = 'read') {
      return accessibleWorkspace(state, workspaceId, userId, action);
    },
    workspaceRole(workspaceId, userId) {
      const workspace = accessibleWorkspace(state, workspaceId, userId);
      if (workspace.ownerId === userId) return 'owner';
      return state.workspaceGrants.find((item) => item.workspaceId === workspaceId
        && item.userId === userId).role;
    },
    listWorkspaceGrants(workspaceId, ownerId) {
      ownedWorkspace(state, workspaceId, ownerId);
      return state.workspaceGrants.filter((grant) => grant.workspaceId === workspaceId)
        .map((grant) => ({ ...grant, email: state.users.find((user) => user.id === grant.userId)?.email }));
    },
    async grantWorkspace(workspaceId, ownerId, email, role) {
      return write((next) => {
        ownedWorkspace(next, workspaceId, ownerId);
        const recipient = next.users.find((user) => user.email === email);
        if (!recipient) throw new ApiError(404, 'ACCOUNT_NOT_FOUND', 'Recipient was not found');
        if (recipient.id === ownerId) throw new ApiError(400, 'INVALID_RECIPIENT', 'Owner already has access');
        let grant = next.workspaceGrants.find((item) => item.workspaceId === workspaceId
          && item.userId === recipient.id);
        if (grant) grant.role = role;
        else {
          grant = { workspaceId, userId: recipient.id, role, createdAt: new Date().toISOString() };
          next.workspaceGrants.push(grant);
        }
        return { ...grant, email: recipient.email };
      });
    },
    async revokeWorkspaceGrant(workspaceId, ownerId, recipientId) {
      return write((next) => {
        ownedWorkspace(next, workspaceId, ownerId);
        next.workspaceGrants = next.workspaceGrants.filter((grant) =>
          !(grant.workspaceId === workspaceId && grant.userId === recipientId));
      });
    },
    async createWorkspace(userId, name, description) {
      return write((next) => {
        const workspace = { id: randomUUID(), ownerId: userId, name, description,
          fileIds: [], createdAt: new Date().toISOString() };
        next.workspaces.push(workspace);
        return workspace;
      });
    },
    async addWorkspaceFile(workspaceId, userId, fileId) {
      return write((next) => {
        const workspace = ownedWorkspace(next, workspaceId, userId);
        if (!next.files.some((file) => file.id === fileId && file.ownerId === userId)) {
          throw new ApiError(404, 'FILE_NOT_FOUND', 'File was not found');
        }
        if (!workspace.fileIds.includes(fileId)) workspace.fileIds.push(fileId);
        return workspace;
      });
    },
    async removeWorkspaceFile(workspaceId, userId, fileId) {
      return write((next) => {
        const workspace = ownedWorkspace(next, workspaceId, userId);
        if (!workspace.fileIds.includes(fileId)) {
          throw new ApiError(404, 'FILE_NOT_FOUND', 'File was not found in this workspace');
        }
        workspace.fileIds = workspace.fileIds.filter((id) => id !== fileId);
        if (workspace.git?.archiveFileId === fileId) delete workspace.git;
      });
    },
    async setWorkspaceGitArchive(workspaceId, userId, fileId, versionId, commitSha) {
      return write((next) => {
        const workspace = ownedWorkspace(next, workspaceId, userId);
        const file = next.files.find((item) => item.id === fileId && item.ownerId === userId);
        if (!workspace.fileIds.includes(fileId) || !file || file.currentVersionId !== versionId
          || !file.name.toLowerCase().endsWith('.zip')) {
          throw new ApiError(409, 'GIT_ARCHIVE_CHANGED', 'Choose a current ZIP file in this workspace');
        }
        workspace.git = { archiveFileId: fileId, archiveVersionId: versionId,
          commitSha, verification: 'zip-comment', commitVerified: false };
        return workspace.git;
      });
    },
    async importGitHubArchive(workspaceId, userId, source, stored) {
      return write((next) => {
        const workspace = ownedWorkspace(next, workspaceId, userId);
        if (workspace.git) throw new ApiError(409, 'GIT_ARCHIVE_ALREADY_LINKED',
          'Remove the current code archive from the workspace before importing a repository');
        const name = `${source.repo}-source.zip`;
        if (next.files.some((file) => workspace.fileIds.includes(file.id) && file.name === name)) {
          throw new ApiError(409, 'NAME_CONFLICT', 'A file with this name is already in the workspace');
        }
        const createdAt = new Date().toISOString();
        const file = { id: randomUUID(), name, folderId: ROOT_FOLDER_ID,
          ownerId: userId, mimeType: 'application/zip', size: stored.size,
          createdAt, storageKey: stored.storageKey, currentVersionId: randomUUID() };
        next.files.push(file);
        next.versions.push({ id: file.currentVersionId, fileId: file.id, name,
          storageKey: file.storageKey, mimeType: file.mimeType, size: file.size,
          createdAt, kind: 'imported', actorId: userId, label: '' });
        workspace.fileIds.push(file.id);
        workspace.git = { archiveFileId: file.id, archiveVersionId: file.currentVersionId,
          commitSha: source.commitSha, verification: 'github-api', commitVerified: true,
          repositoryFullName: source.repositoryFullName, repositoryUrl: source.repositoryUrl
            ?? `https://github.com/${source.repositoryFullName}`,
          sourceUrl: source.sourceUrl
            ?? `https://github.com/${source.repositoryFullName}/tree/${source.commitSha}`,
          ref: source.ref, importedAt: createdAt };
        return { file: publicFile(file), git: workspace.git, unchanged: false };
      });
    },
    async refreshGitHubArchive(workspaceId, userId, source, expected, stored) {
      return write((next) => {
        const workspace = ownedWorkspace(next, workspaceId, userId);
        if (workspace.git?.verification !== 'github-api'
          || workspace.git.repositoryFullName.toLowerCase() !== source.repositoryFullName.toLowerCase()) {
          throw new ApiError(409, 'GITHUB_IMPORT_CHANGED', 'The linked GitHub repository changed');
        }
        const file = next.files.find((item) => item.id === workspace.git.archiveFileId
          && item.ownerId === userId);
        if (!file || !workspace.fileIds.includes(file.id)
          || file.currentVersionId !== expected.archiveVersionId
          || workspace.git.archiveVersionId !== expected.archiveVersionId) {
          throw new ApiError(409, 'GIT_ARCHIVE_CHANGED',
            'The code archive changed while refreshing; try again');
        }
        if (workspace.git.commitSha === source.commitSha) {
          return { file: publicFile(file), git: workspace.git, unchanged: true };
        }
        const createdAt = new Date().toISOString();
        const version = { id: randomUUID(), fileId: file.id, name: file.name,
          storageKey: stored.storageKey, mimeType: file.mimeType, size: stored.size,
          createdAt, kind: 'imported', actorId: userId, label: '' };
        next.versions.push(version);
        file.storageKey = version.storageKey;
        file.size = version.size;
        file.currentVersionId = version.id;
        workspace.git = { ...workspace.git, archiveVersionId: version.id,
          commitSha: source.commitSha, ref: source.ref,
          sourceUrl: source.sourceUrl
            ?? `https://github.com/${source.repositoryFullName}/tree/${source.commitSha}`,
          importedAt: createdAt };
        return { file: publicFile(file), git: workspace.git, unchanged: false };
      });
    },
    async deleteWorkspace(workspaceId, userId) {
      return write((next) => {
        ownedWorkspace(next, workspaceId, userId);
        if (next.snapshots.some((snapshot) => snapshot.workspaceId === workspaceId)) {
          throw new ApiError(409, 'WORKSPACE_HAS_SNAPSHOTS',
            'Delete this workspace\'s snapshots before deleting the workspace');
        }
        next.workspaces = next.workspaces.filter((item) => item.id !== workspaceId);
        next.workspaceGrants = next.workspaceGrants.filter((grant) => grant.workspaceId !== workspaceId);
      });
    },
    listWorkspaceFiles(workspaceId, userId) {
      const workspace = accessibleWorkspace(state, workspaceId, userId);
      const ids = new Set(workspace.fileIds);
      return state.files.filter((file) => ids.has(file.id) && file.ownerId === workspace.ownerId)
        .map(publicFile);
    },
    listOwnedFiles(userId) {
      return state.files.filter((file) => file.ownerId === userId).map(publicFile);
    },
    listSnapshots(workspaceId, userId) {
      accessibleWorkspace(state, workspaceId, userId);
      return state.snapshots.filter((item) => item.workspaceId === workspaceId)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    },
    listSharedSnapshots(userId) {
      return state.snapshots.filter((snapshot) => {
        try { accessibleSnapshot(state, snapshot.id, userId); return snapshot.ownerId !== userId; }
        catch { return false; }
      });
    },
    getSnapshot(snapshotId, userId, manage = false) {
      return accessibleSnapshot(state, snapshotId, userId, manage);
    },
    getSnapshotVersion(snapshotId, fileId, userId) {
      const snapshot = accessibleSnapshot(state, snapshotId, userId);
      const item = snapshot.items.find((entry) => entry.fileId === fileId);
      if (!item) throw new ApiError(404, 'FILE_NOT_FOUND', 'File was not found in this snapshot');
      const version = state.versions.find((entry) => entry.id === item.versionId && entry.fileId === fileId);
      if (!version) throw new ApiError(404, 'VERSION_NOT_FOUND', 'Snapshot file version was not found');
      return version;
    },
    snapshotVersions(snapshotId, userId) {
      const snapshot = accessibleSnapshot(state, snapshotId, userId);
      return snapshot.items.map((item) => {
        const version = state.versions.find((entry) => entry.id === item.versionId
          && entry.fileId === item.fileId);
        if (!version) throw new ApiError(404, 'VERSION_NOT_FOUND', 'Snapshot file version was not found');
        return version;
      });
    },
    async copySnapshot(snapshotId, userId, stored) {
      return write((next) => {
        const source = accessibleSnapshot(next, snapshotId, userId);
        if (stored.length !== source.items.length) throw new Error('Snapshot copy is incomplete');
        const createdAt = new Date().toISOString();
        const workspace = { id: randomUUID(), ownerId: userId,
          name: `${source.name.slice(0, 245)} (copy)`,
          description: `Copy of snapshot ${source.id}`, fileIds: [], createdAt };
        next.workspaces.push(workspace);
        const rootFolder = { id: randomUUID(), ownerId: userId, parentId: ROOT_FOLDER_ID,
          name: `Snapshot ${workspace.id.slice(0, 8)}`, createdAt };
        next.folders.push(rootFolder);
        const folderIds = new Map([['[]', rootFolder.id]]);
        for (const [index, item] of source.items.entries()) {
          const version = next.versions.find((entry) => entry.id === item.versionId
            && entry.fileId === item.fileId);
          if (!version) throw new ApiError(404, 'VERSION_NOT_FOUND', 'Snapshot file version was not found');
          const parts = item.folderPath ?? [];
          let parentId = rootFolder.id;
          for (let depth = 0; depth < parts.length; depth += 1) {
            const key = JSON.stringify(parts.slice(0, depth + 1));
            if (!folderIds.has(key)) {
              const folder = { id: randomUUID(), ownerId: userId, parentId,
                name: parts[depth], createdAt };
              next.folders.push(folder);
              folderIds.set(key, folder.id);
            }
            parentId = folderIds.get(key);
          }
          const file = { id: randomUUID(), name: item.name, folderId: parentId,
            ownerId: userId, mimeType: item.mimeType, size: item.size, createdAt,
            storageKey: stored[index].storageKey, currentVersionId: randomUUID() };
          next.files.push(file);
          next.versions.push({ id: file.currentVersionId, fileId: file.id, name: file.name,
            storageKey: file.storageKey, mimeType: file.mimeType, size: file.size,
            createdAt, kind: 'copied', copiedFromVersionId: item.versionId,
            copiedFromSnapshotId: source.id, label: '' });
          workspace.fileIds.push(file.id);
          if (source.git?.archiveFileId === item.fileId) {
            workspace.git = { ...source.git, archiveFileId: file.id,
              archiveVersionId: file.currentVersionId };
          }
        }
        return workspace;
      });
    },
    assertFileDeletable(fileId, userId) {
      this.getFile(fileId, userId, 'manage');
      if (state.snapshots.some((snapshot) => snapshot.items.some((item) => item.fileId === fileId))) {
        throw new ApiError(409, 'FILE_IN_SNAPSHOT',
          'This file is used by a snapshot; delete the snapshot first');
      }
    },
    async createSnapshot(workspaceId, userId, name, note, fileIds, expectedVersions) {
      return write((next) => {
        const workspace = ownedWorkspace(next, workspaceId, userId);
        if (workspace.git) {
          const archive = next.files.find((file) => file.id === workspace.git.archiveFileId);
          if (!archive || archive.currentVersionId !== workspace.git.archiveVersionId
            || !fileIds.includes(archive.id)) {
            throw new ApiError(409, 'GIT_ARCHIVE_CHANGED',
              'Include the linked code archive at its linked version, or link its new version');
          }
        }
        if (!fileIds.length || new Set(fileIds).size !== fileIds.length
          || fileIds.some((id) => !workspace.fileIds.includes(id))) {
          throw new ApiError(400, 'INVALID_SNAPSHOT_FILES', 'Select files from this workspace');
        }
        const items = fileIds.map((id) => {
          const file = next.files.find((entry) => entry.id === id && entry.ownerId === userId);
          if (!file) throw new ApiError(404, 'FILE_NOT_FOUND', 'A selected file was not found');
          const version = next.versions.find((entry) => entry.id === file.currentVersionId && entry.fileId === id);
          if (!version) throw new ApiError(404, 'VERSION_NOT_FOUND', 'A selected version was not found');
          if (expectedVersions && expectedVersions.get(id) !== version.id) {
            throw new ApiError(409, 'SNAPSHOT_FILES_CHANGED',
              'A selected file changed since review; refresh and review the versions again');
          }
          const folderPath = [];
          let folderId = file.folderId;
          while (folderId !== ROOT_FOLDER_ID) {
            const folder = next.folders.find((entry) => entry.id === folderId && entry.ownerId === userId);
            if (!folder) throw new ApiError(404, 'FOLDER_NOT_FOUND', 'A file folder was not found');
            folderPath.unshift(folder.name);
            folderId = folder.parentId;
          }
          return { fileId: id, versionId: version.id, name: file.name, folderId: file.folderId,
            folderPath,
            mimeType: version.mimeType, size: version.size };
        });
        const snapshot = { id: randomUUID(), workspaceId, ownerId: userId,
          createdById: userId,
          createdByName: next.users.find((user) => user.id === userId)?.displayName
            ?? 'Community member', name, note,
          items, git: workspace.git ? { ...workspace.git } : null,
          createdAt: new Date().toISOString() };
        next.snapshots.push(snapshot);
        return snapshot;
      });
    },
    async deleteSnapshot(snapshotId, userId) {
      return write((next) => {
        accessibleSnapshot(next, snapshotId, userId, true);
        next.snapshots = next.snapshots.filter((item) => item.id !== snapshotId);
        next.snapshotGrants = next.snapshotGrants.filter((grant) => grant.snapshotId !== snapshotId);
      });
    },
    listSnapshotGrants(snapshotId, userId) {
      accessibleSnapshot(state, snapshotId, userId, true);
      return state.snapshotGrants.filter((grant) => grant.snapshotId === snapshotId).map((grant) => ({
        userId: grant.userId, email: state.users.find((user) => user.id === grant.userId)?.email,
        createdAt: grant.createdAt,
      }));
    },
    async grantSnapshot(snapshotId, ownerId, email) {
      return write((next) => {
        const snapshot = accessibleSnapshot(next, snapshotId, ownerId, true);
        const recipient = next.users.find((user) => user.email === email);
        if (!recipient) throw new ApiError(404, 'ACCOUNT_NOT_FOUND', 'Recipient was not found');
        if (recipient.id === ownerId) throw new ApiError(400, 'INVALID_RECIPIENT', 'Owner already has access');
        if (!snapshot.items.every((item) => next.grants.some((grant) =>
          grant.fileId === item.fileId && grant.userId === recipient.id))) {
          throw new ApiError(409, 'SNAPSHOT_ACCESS_INCOMPLETE',
            'Share every file in this snapshot with the recipient first');
        }
        if (!next.snapshotGrants.some((grant) => grant.snapshotId === snapshotId
          && grant.userId === recipient.id)) {
          next.snapshotGrants.push({ snapshotId, userId: recipient.id,
            createdAt: new Date().toISOString() });
        }
        return { userId: recipient.id, email: recipient.email };
      });
    },
    async revokeSnapshotGrant(snapshotId, ownerId, recipientId) {
      return write((next) => {
        accessibleSnapshot(next, snapshotId, ownerId, true);
        next.snapshotGrants = next.snapshotGrants.filter((grant) =>
          !(grant.snapshotId === snapshotId && grant.userId === recipientId));
      });
    },
    listFolders(ownerId) {
      return state.folders.filter((folder) => folder.ownerId === ownerId);
    },
    async createOrganizationSuggestion(ownerId, name, currentFolderId) {
      if (!folderExists(currentFolderId, ownerId)) {
        throw new ApiError(404, 'FOLDER_NOT_FOUND', 'Current folder was not found');
      }
      const proposed = suggestFolder(name, currentFolderId, this.listFolders(ownerId));
      if (!proposed) return { suggestion: null };
      return write((next) => {
        if (!folderExists(currentFolderId, ownerId, next)) {
          throw new ApiError(404, 'FOLDER_NOT_FOUND', 'Current folder was not found');
        }
        const current = suggestFolder(name, currentFolderId,
          next.folders.filter((folder) => folder.ownerId === ownerId));
        if (!current) return { suggestion: null };
        const now = Date.now();
        next.organizationSuggestions = next.organizationSuggestions.filter((item) =>
          now - Date.parse(item.createdAt) < 86_400_000);
        const owned = next.organizationSuggestions.filter((item) => item.ownerId === ownerId);
        if (owned.length >= 100) {
          const remove = new Set(owned.slice(0, owned.length - 99).map((item) => item.id));
          next.organizationSuggestions = next.organizationSuggestions.filter((item) => !remove.has(item.id));
        }
        const id = randomUUID();
        next.organizationSuggestions.push({ id, ownerId, folderId: current.folderId,
          rule: current.rule, createdAt: new Date(now).toISOString() });
        let stats = next.organizationStats.find((item) => item.ownerId === ownerId);
        if (!stats) {
          stats = { ownerId, shown: 0, accepted: 0, keptCurrent: 0 };
          next.organizationStats.push(stats);
        }
        stats.shown += 1;
        return { suggestion: { id, ...current } };
      });
    },
    async decideOrganizationSuggestion(ownerId, suggestionId, accept) {
      return write((next) => {
        const index = next.organizationSuggestions.findIndex((item) => item.id === suggestionId
          && item.ownerId === ownerId && Date.now() - Date.parse(item.createdAt) < 86_400_000);
        if (index === -1) {
          throw new ApiError(404, 'SUGGESTION_NOT_FOUND', 'Folder suggestion was not found');
        }
        next.organizationSuggestions.splice(index, 1);
        const stats = next.organizationStats.find((item) => item.ownerId === ownerId);
        if (accept) stats.accepted += 1;
        else stats.keptCurrent += 1;
      });
    },
    organizationStats(ownerId) {
      const stats = state.organizationStats.find((item) => item.ownerId === ownerId);
      return stats ? { shown: stats.shown, accepted: stats.accepted, keptCurrent: stats.keptCurrent }
        : { shown: 0, accepted: 0, keptCurrent: 0 };
    },
    async updateFolder(folderId, ownerId, changes) {
      return write((next) => {
        if (folderId === ROOT_FOLDER_ID) {
          throw new ApiError(400, 'INVALID_FOLDER', 'Root folder cannot be changed');
        }
        const folder = next.folders.find((item) => item.id === folderId && item.ownerId === ownerId);
        if (!folder) throw new ApiError(404, 'FOLDER_NOT_FOUND', 'Folder was not found');
        const name = changes.name ?? folder.name;
        const parentId = changes.parentId ?? folder.parentId;
        if (!folderExists(parentId, ownerId, next)) {
          throw new ApiError(404, 'FOLDER_NOT_FOUND', 'Destination folder was not found');
        }
        const visited = new Set();
        let cursor = parentId;
        while (cursor !== ROOT_FOLDER_ID) {
          if (cursor === folderId || visited.has(cursor)) {
            throw new ApiError(409, 'FOLDER_CYCLE', 'A folder cannot move inside itself');
          }
          visited.add(cursor);
          cursor = next.folders.find((item) => item.id === cursor && item.ownerId === ownerId)?.parentId;
          if (!cursor) throw new ApiError(404, 'FOLDER_NOT_FOUND', 'Destination folder was not found');
        }
        if (next.folders.some((item) => item.id !== folderId && item.ownerId === ownerId
          && item.parentId === parentId && item.name === name)) {
          throw new ApiError(409, 'NAME_CONFLICT', 'A folder with that name already exists here');
        }
        folder.name = name;
        folder.parentId = parentId;
        return folder;
      });
    },
    async addFile(details) {
      return write((next) => {
        if (!folderExists(details.folderId, details.ownerId, next)) {
          throw new ApiError(404, 'FOLDER_NOT_FOUND', 'Folder was not found');
        }
        const createdAt = new Date().toISOString();
        const file = { id: randomUUID(), name: details.name, folderId: details.folderId,
          ownerId: details.ownerId, mimeType: details.mimeType, size: details.size,
          createdAt, storageKey: details.storageKey, currentVersionId: randomUUID() };
        next.files.push(file);
        next.versions.push({ id: file.currentVersionId, fileId: file.id, name: file.name,
          storageKey: file.storageKey, mimeType: file.mimeType, size: file.size,
          createdAt, kind: 'uploaded', actorId: details.actorId ?? details.ownerId, label: '' });
        return publicFile(file);
      });
    },
    async addWorkspaceUploadedFile(workspaceId, actorId, details) {
      return write((next) => {
        const workspace = accessibleWorkspace(next, workspaceId, actorId, 'contribute');
        if (next.files.some((file) => workspace.fileIds.includes(file.id) && file.name === details.name)) {
          throw new ApiError(409, 'NAME_CONFLICT', 'A file with this name is already in the workspace');
        }
        const createdAt = new Date().toISOString();
        const file = { id: randomUUID(), name: details.name, folderId: ROOT_FOLDER_ID,
          ownerId: workspace.ownerId, mimeType: details.mimeType, size: details.size,
          createdAt, storageKey: details.storageKey, currentVersionId: randomUUID() };
        next.files.push(file);
        next.versions.push({ id: file.currentVersionId, fileId: file.id, name: file.name,
          storageKey: file.storageKey, mimeType: file.mimeType, size: file.size,
          createdAt, kind: 'uploaded', actorId, label: '' });
        workspace.fileIds.push(file.id);
        return publicFile(file);
      });
    },
    listVersions(fileId, ownerId) {
      const file = this.getFile(fileId, ownerId, 'manage');
      return { currentVersionId: file.currentVersionId,
        versions: state.versions.filter((version) => version.fileId === fileId)
          .reverse().map(publicVersion) };
    },
    getVersion(fileId, ownerId, versionId) {
      this.getFile(fileId, ownerId, 'manage');
      const version = state.versions.find((item) => item.fileId === fileId && item.id === versionId);
      if (!version) throw new ApiError(404, 'VERSION_NOT_FOUND', 'File version was not found');
      return version;
    },
    versionStorageKeys(fileId, ownerId) {
      this.getFile(fileId, ownerId, 'manage');
      return [...new Set(state.versions.filter((version) => version.fileId === fileId)
        .map((version) => version.storageKey))];
    },
    async replaceFile(fileId, ownerId, stored, actorId = ownerId) {
      return write((next) => {
        const file = next.files.find((item) => item.id === fileId && item.ownerId === ownerId);
        if (!file) throw new ApiError(404, 'FILE_NOT_FOUND', 'File was not found');
        if (next.workspaces.some((workspace) => workspace.ownerId === ownerId
          && workspace.git?.verification === 'github-api' && workspace.git.archiveFileId === fileId)) {
          throw new ApiError(409, 'GITHUB_ARCHIVE_MANAGED',
            'Use Refresh from GitHub to update this code archive');
        }
        const version = { id: randomUUID(), fileId, name: file.name,
          storageKey: stored.storageKey, mimeType: file.mimeType, size: stored.size,
          createdAt: new Date().toISOString(), kind: 'replaced', actorId, label: '' };
        next.versions.push(version);
        file.storageKey = version.storageKey;
        file.size = version.size;
        file.currentVersionId = version.id;
        return publicFile(file);
      });
    },
    async restoreVersion(fileId, ownerId, versionId, stored) {
      return write((next) => {
        const file = next.files.find((item) => item.id === fileId && item.ownerId === ownerId);
        if (!file) throw new ApiError(404, 'FILE_NOT_FOUND', 'File was not found');
        if (next.workspaces.some((workspace) => workspace.ownerId === ownerId
          && workspace.git?.verification === 'github-api' && workspace.git.archiveFileId === fileId)) {
          throw new ApiError(409, 'GITHUB_ARCHIVE_MANAGED',
            'Use Refresh from GitHub to update this code archive');
        }
        const source = next.versions.find((item) => item.fileId === fileId && item.id === versionId);
        if (!source) throw new ApiError(404, 'VERSION_NOT_FOUND', 'File version was not found');
        const version = { id: randomUUID(), fileId, name: file.name,
          storageKey: stored.storageKey, mimeType: source.mimeType, size: source.size,
          createdAt: new Date().toISOString(), kind: 'restored', restoredFrom: versionId, label: '' };
        next.versions.push(version);
        file.storageKey = version.storageKey;
        file.mimeType = version.mimeType;
        file.size = version.size;
        file.currentVersionId = version.id;
        return publicFile(file);
      });
    },
    async labelVersion(fileId, ownerId, versionId, label) {
      return write((next) => {
        if (!next.files.some((file) => file.id === fileId && file.ownerId === ownerId)) {
          throw new ApiError(404, 'FILE_NOT_FOUND', 'File was not found');
        }
        const version = next.versions.find((item) => item.fileId === fileId && item.id === versionId);
        if (!version) throw new ApiError(404, 'VERSION_NOT_FOUND', 'File version was not found');
        version.label = label;
        return publicVersion(version);
      });
    },
    async updateFile(fileId, ownerId, changes) {
      return write((next) => {
        const file = next.files.find((item) => item.id === fileId && item.ownerId === ownerId);
        if (!file) throw new ApiError(404, 'FILE_NOT_FOUND', 'File was not found');
        const name = changes.name ?? file.name;
        const folderId = changes.folderId ?? file.folderId;
        if (!folderExists(folderId, ownerId, next)) {
          throw new ApiError(404, 'FOLDER_NOT_FOUND', 'Destination folder was not found');
        }
        if (name.split('.').at(-1).toLowerCase() !== file.name.split('.').at(-1).toLowerCase()) {
          throw new ApiError(400, 'FILE_EXTENSION_CHANGE', 'Keep the original file extension');
        }
        file.name = name;
        file.folderId = folderId;
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
        if (next.snapshots.some((snapshot) => snapshot.items.some((item) => item.fileId === fileId))) {
          throw new ApiError(409, 'FILE_IN_SNAPSHOT',
            'This file is used by a snapshot; delete the snapshot first');
        }
        next.files.splice(index, 1);
        for (const workspace of next.workspaces) {
          workspace.fileIds = workspace.fileIds.filter((id) => id !== fileId);
          if (workspace.git?.archiveFileId === fileId) delete workspace.git;
        }
        next.versions = next.versions.filter((version) => version.fileId !== fileId);
        next.shares = next.shares.filter((share) => share.fileId !== fileId);
        next.grants = next.grants.filter((grant) => grant.fileId !== fileId);
      });
    },
    usage(userId, freeLimitBytes) {
      const user = this.getUser(userId);
      const limitBytes = user.tier === 'demo' ? freeLimitBytes * 10 : freeLimitBytes;
      const owned = new Set(state.files.filter((file) => file.ownerId === userId).map((file) => file.id));
      return { usedBytes: state.versions.filter((version) => owned.has(version.fileId))
        .reduce((total, version) => total + version.size, 0), limitBytes, tier: user.tier };
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
        const affectedSnapshots = new Set(next.snapshots.filter((snapshot) =>
          snapshot.items.some((item) => item.fileId === fileId)).map((snapshot) => snapshot.id));
        next.snapshotGrants = next.snapshotGrants.filter((grant) =>
          !(grant.userId === recipientId && affectedSnapshots.has(grant.snapshotId)));
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

function publicVersion(version) {
  const { storageKey, ...metadata } = version;
  return metadata;
}

export function publicUser(user) {
  const { passwordHash, ...profile } = user;
  return profile;
}
