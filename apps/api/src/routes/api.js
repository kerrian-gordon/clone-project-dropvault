import { createHash, timingSafeEqual } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { snapshotArchive } from '../modules/files/archive.js';
import { MAX_UPLOAD_BYTES, ROOT_FOLDER_ID, SUPPORTED_UPLOAD_TYPES, normalizeMimeType, validName } from '../../../../packages/shared/index.js';
import { publicFile } from '../db/catalog.js';
import { checkRequestOrigin, clearSessionCookie, createAuthLimiter, createSession, hashPassword,
  requireUser, sessionCookie, sessionToken, validEmail, validPassword,
  verifyPassword } from '../modules/accounts/auth.js';
import { contentHeaders } from '../modules/files/content.js';
import { uploadDetails, validateStoredFile } from '../modules/uploads/validate.js';
import { ApiError, unwrapApiError } from './errors.js';

const MAX_ACTIVE_MUTATIONS = 32;
const MAX_ACTIVE_UPLOADS = 8;
const MAX_ACTIVE_REJECTION_DRAINS = 8;
const MAX_REJECT_DRAIN_BYTES = 16_384;
const REJECTION_DRAIN_TIMEOUT_MS = 10_000;

function json(response, status, value, headers = {}) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
    ...headers,
  });
  response.end(body);
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 16_384) throw new ApiError(413, 'BODY_TOO_LARGE', 'JSON body is too large');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new ApiError(400, 'INVALID_JSON', 'Provide a valid JSON body');
  }
}

export function createHandler({ catalog, storage, maxUploadBytes = MAX_UPLOAD_BYTES,
  storageLimitBytes, legacyClaimToken, publicBaseUrl }) {
  let pendingMutation = Promise.resolve();
  let activeMutations = 0;
  let activeUploads = 0;
  let activeRejectionDrains = 0;
  const authLimiter = createAuthLimiter();
  const activeReads = new Map();
  const deleting = new Set();
  async function mutate(work) {
    const previous = pendingMutation;
    let release;
    pendingMutation = new Promise((resolve) => { release = resolve; });
    await previous;
    try {
      return await work();
    } finally {
      release();
    }
  }

  function drainRequest(request, drainLimit) {
    if (request.readableEnded || request.destroyed) return Promise.resolve();
    return new Promise((resolve) => {
      const timeout = setTimeout(() => request.destroy(), REJECTION_DRAIN_TIMEOUT_MS);
      timeout.unref();
      const done = () => {
        clearTimeout(timeout);
        resolve();
      };
      request.once('end', done);
      request.once('close', done);
      request.once('error', done);
      let drained = 0;
      request.on('data', (chunk) => {
        drained += chunk.length;
        if (drained > drainLimit) request.destroy();
      });
      request.resume();
    });
  }

  function rejectAndDrain(request, response, status, code, message, drainLimit) {
    if (activeRejectionDrains >= MAX_ACTIVE_REJECTION_DRAINS) {
      response.setHeader('Connection', 'close');
      response.once('finish', () => request.destroy());
      json(response, status, { error: { code, message } });
      return;
    }
    activeRejectionDrains += 1;
    let finished = false;
    const timeout = setTimeout(() => request.destroy(), REJECTION_DRAIN_TIMEOUT_MS);
    timeout.unref();
    const finishDrain = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      activeRejectionDrains -= 1;
    };
    request.once('end', finishDrain);
    request.once('close', finishDrain);
    let drained = 0;
    request.on('data', (chunk) => {
      drained += chunk.length;
      if (drained > drainLimit) request.destroy();
    });
    request.resume();
    json(response, status, { error: { code, message } });
  }

  function rejectBusy(request, response, upload) {
    rejectAndDrain(request, response, 503, 'SERVER_BUSY',
      'Too many changes are pending; try again later',
      upload ? maxUploadBytes : MAX_REJECT_DRAIN_BYTES);
  }

  async function sendContent(response, file, download) {
    if (deleting.has(file.id)) throw new ApiError(404, 'FILE_NOT_FOUND', 'File was not found');
    const releaseRead = beginRead(file.id);
    try {
      const stream = storage.read(file.storageKey);
      response.writeHead(200, contentHeaders(file, download));
      await pipeline(stream, response);
    } finally {
      releaseRead();
    }
  }

  function beginRead(fileId) {
    if (deleting.has(fileId)) throw new ApiError(404, 'FILE_NOT_FOUND', 'File was not found');
    const current = activeReads.get(fileId) ?? { count: 0, waiters: [] };
    current.count += 1;
    activeReads.set(fileId, current);
    return () => {
      current.count -= 1;
      if (current.count === 0) {
        activeReads.delete(fileId);
        for (const resolve of current.waiters) resolve();
      }
    };
  }

  async function waitForReads(fileId) {
    const current = activeReads.get(fileId);
    if (current?.count) await new Promise((resolve) => current.waiters.push(resolve));
  }

  return async (request, response) => {
    const mutation = !['GET', 'HEAD', 'OPTIONS'].includes(request.method);
    const uploadPath = new URL(request.url, 'http://localhost').pathname;
    const upload = request.method === 'POST'
      && (uploadPath === '/v1/files' || /^\/v1\/files\/[^/]+\/versions$/u.test(uploadPath)
        || /^\/v1\/workspaces\/[^/]+\/uploads$/u.test(uploadPath)
        || /^\/v1\/workspaces\/[^/]+\/files\/[^/]+\/versions$/u.test(uploadPath));
    if (upload ? activeUploads >= MAX_ACTIVE_UPLOADS
      : mutation && activeMutations >= MAX_ACTIVE_MUTATIONS) {
      rejectBusy(request, response, upload);
      return;
    }
    let countedUpload = upload;
    if (upload) activeUploads += 1;
    else if (mutation) activeMutations += 1;
    try {
      const url = new URL(request.url, 'http://localhost');
      const path = url.pathname;
      checkRequestOrigin(request);

      if (request.method === 'GET' && path === '/v1/health') {
        return json(response, 200, { status: 'ok' });
      }
      if (request.method === 'POST' && path === '/v1/auth/register') {
        authLimiter.registration(request.socket.remoteAddress);
        const input = await readJson(request);
        if (!validEmail(input?.email) || !validPassword(input?.password)) {
          throw new ApiError(400, 'INVALID_CREDENTIALS', 'Provide an email and password of at least 12 characters');
        }
        const user = await catalog.createUser(input.email.trim().toLowerCase(),
          await hashPassword(input.password), input?.displayName);
        const token = await createSession(catalog, user.id);
        return json(response, 201, user, { 'Set-Cookie': sessionCookie(token, !!request.socket.encrypted) });
      }
      if (request.method === 'POST' && path === '/v1/auth/login') {
        const input = await readJson(request);
        const email = validEmail(input?.email) ? input.email.trim().toLowerCase() : '';
        const ip = request.socket.remoteAddress;
        authLimiter.checkLogin(ip, email);
        const user = email ? catalog.findUser(email) : null;
        if (!user || !validPassword(input?.password)
          || !await verifyPassword(input.password, user.passwordHash)) {
          authLimiter.failedLogin(ip, email);
          throw new ApiError(401, 'INVALID_CREDENTIALS', 'Invalid email or password');
        }
        authLimiter.successfulLogin(ip, email);
        const token = await createSession(catalog, user.id);
        return json(response, 200, catalog.getUser(user.id),
          { 'Set-Cookie': sessionCookie(token, !!request.socket.encrypted) });
      }
      const shareMatch = /^\/v1\/shares\/([^/]+)$/u.exec(path);
      if (request.method === 'GET' && shareMatch) {
        return await sendContent(response, catalog.getSharedFile(shareMatch[1]),
          url.searchParams.get('download') === '1');
      }

      const user = requireUser(request, catalog);
      if (request.method === 'POST' && path === '/v1/auth/logout') {
        await catalog.deleteSession(sessionToken(request));
        response.writeHead(204, { 'Set-Cookie': clearSessionCookie(!!request.socket.encrypted) });
        return response.end();
      }
      if (request.method === 'GET' && path === '/v1/account') {
        return json(response, 200, catalog.getUser(user.id));
      }
      if (request.method === 'GET' && path === '/v1/account/appearance') {
        return json(response, 200, catalog.getAppearance(user.id));
      }
      if (request.method === 'PUT' && path === '/v1/account/appearance') {
        const input = await readJson(request);
        if (typeof input?.themeId !== 'string') {
          throw new ApiError(400, 'INVALID_THEME_ID', 'Choose a theme to install');
        }
        return json(response, 200, await catalog.installTheme(user.id, input.themeId));
      }
      if (request.method === 'PUT' && path === '/v1/account/appearance/settings') {
        const input = await readJson(request);
        return json(response, 200, await catalog.saveAppearanceSettings(user.id, input?.settings));
      }
      if (request.method === 'DELETE' && path === '/v1/account/appearance') {
        return json(response, 200, await catalog.resetAppearance(user.id));
      }
      if (request.method === 'GET' && path === '/v1/themes') {
        const offset = url.searchParams.has('offset') ? Number(url.searchParams.get('offset')) : 0;
        const limit = url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : 20;
        const query = url.searchParams.get('q') ?? '';
        if (!Number.isSafeInteger(offset) || offset < 0
          || !Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
          throw new ApiError(400, 'INVALID_PAGE', 'Choose a non-negative offset and a limit from 1 to 50');
        }
        if (typeof query !== 'string' || query.length > 80) {
          throw new ApiError(400, 'INVALID_SEARCH', 'Search must be 80 characters or fewer');
        }
        return json(response, 200, catalog.listThemes(offset, limit, query));
      }
      if (request.method === 'POST' && path === '/v1/themes') {
        authLimiter.themePublish(request.socket.remoteAddress, user.id);
        const input = await readJson(request);
        return json(response, 201, await catalog.createTheme(user.id, input?.name,
          input?.settings));
      }
      const themeMatch = /^\/v1\/themes\/([^/]+)$/u.exec(path);
      if (request.method === 'GET' && themeMatch) {
        return json(response, 200, catalog.getTheme(themeMatch[1]));
      }
      if (request.method === 'DELETE' && themeMatch) {
        await catalog.deleteTheme(themeMatch[1], user.id);
        response.writeHead(204);
        return response.end();
      }
      if (request.method === 'POST' && path === '/v1/account/claim-legacy') {
        if (!legacyClaimToken) {
          throw new ApiError(409, 'LEGACY_CLAIM_DISABLED', 'Legacy claiming is not configured');
        }
        const input = await readJson(request);
        const supplied = createHash('sha256').update(String(input?.token ?? '')).digest();
        const expected = createHash('sha256').update(legacyClaimToken).digest();
        if (!timingSafeEqual(supplied, expected)) {
          throw new ApiError(403, 'INVALID_CLAIM_TOKEN', 'Legacy claim token is invalid');
        }
        return json(response, 200, await mutate(() => catalog.claimLegacy(user.id)));
      }
      if (request.method === 'POST' && path === '/v1/account/plan') {
        const input = await readJson(request);
        if (!['free', 'demo'].includes(input?.tier)) {
          throw new ApiError(400, 'INVALID_TIER', 'Choose free or demo');
        }
        return json(response, 200, await mutate(() => catalog.setTier(user.id, input.tier)));
      }
      if (request.method === 'GET' && path === '/v1/storage/usage') {
        return json(response, 200, catalog.usage(user.id, storageLimitBytes));
      }
      if (request.method === 'GET' && path === '/v1/files/owned') {
        return json(response, 200, { files: catalog.listOwnedFiles(user.id) });
      }
      if (path === '/v1/workspaces') {
        if (request.method === 'GET') {
          return json(response, 200, { workspaces: catalog.listWorkspaces(user.id).map((workspace) =>
            ({ ...workspace, role: catalog.workspaceRole(workspace.id, user.id) })) });
        }
        if (request.method === 'POST') {
          const input = await readJson(request);
          if (!validName(input?.name) || typeof input?.description !== 'string'
            || input.description.length > 1000) {
            throw new ApiError(400, 'INVALID_WORKSPACE', 'Provide a name and description up to 1000 characters');
          }
          return json(response, 201, await mutate(() => catalog.createWorkspace(
            user.id, input.name.trim(), input.description.trim())));
        }
      }
      const workspaceAccessMatch = /^\/v1\/workspaces\/([^/]+)\/access$/u.exec(path);
      if (workspaceAccessMatch) {
        if (request.method === 'GET') {
          return json(response, 200, { users: catalog.listWorkspaceGrants(workspaceAccessMatch[1], user.id) });
        }
        if (request.method === 'POST') {
          const input = await readJson(request);
          if (!validEmail(input?.email) || !['viewer', 'contributor'].includes(input?.role)) {
            throw new ApiError(400, 'INVALID_WORKSPACE_GRANT', 'Provide an account and viewer or contributor role');
          }
          return json(response, 201, await mutate(() => catalog.grantWorkspace(
            workspaceAccessMatch[1], user.id, input.email.trim().toLowerCase(), input.role)));
        }
      }
      const workspaceRecipientMatch = /^\/v1\/workspaces\/([^/]+)\/access\/([^/]+)$/u.exec(path);
      if (request.method === 'DELETE' && workspaceRecipientMatch) {
        await mutate(() => catalog.revokeWorkspaceGrant(
          workspaceRecipientMatch[1], user.id, workspaceRecipientMatch[2]));
        response.writeHead(204);
        return response.end();
      }
      const workspaceGitMatch = /^\/v1\/workspaces\/([^/]+)\/git$/u.exec(path);
      if (request.method === 'PUT' && workspaceGitMatch) {
        const input = await readJson(request);
        if (typeof input?.fileId !== 'string') {
          throw new ApiError(400, 'INVALID_GIT_ARCHIVE', 'Choose a code archive file');
        }
        const workspace = catalog.getWorkspace(workspaceGitMatch[1], user.id, 'manage');
        if (!workspace.fileIds.includes(input.fileId)) {
          throw new ApiError(404, 'FILE_NOT_FOUND', 'File was not found in this workspace');
        }
        const file = catalog.getFile(input.fileId, user.id, 'manage');
        if (!file.name.toLowerCase().endsWith('.zip')) {
          throw new ApiError(400, 'INVALID_GIT_ARCHIVE', 'Choose a ZIP archive');
        }
        const commit = await storage.gitArchiveCommit(file.storageKey);
        if (!commit) {
          throw new ApiError(422, 'GIT_COMMIT_MISSING',
            'ZIP comment has no Git commit. Create it with git archive --format=zip HEAD');
        }
        return json(response, 200, await mutate(() => catalog.setWorkspaceGitArchive(
          workspace.id, user.id, file.id, file.currentVersionId, commit)));
      }
      const workspaceUploadMatch = /^\/v1\/workspaces\/([^/]+)\/uploads$/u.exec(path);
      if (request.method === 'POST' && workspaceUploadMatch) {
        const workspace = catalog.getWorkspace(workspaceUploadMatch[1], user.id, 'contribute');
        const details = uploadDetails(request, url, catalog, workspace.ownerId, maxUploadBytes);
        const usage = catalog.usage(workspace.ownerId, storageLimitBytes);
        const available = Math.max(0, usage.limitBytes - usage.usedBytes);
        const declaredLength = request.headers['content-length'];
        if (available === 0 || (declaredLength !== undefined && Number(declaredLength) > available)) {
          if (countedUpload) { activeUploads -= 1; countedUpload = false; }
          await drainRequest(request, maxUploadBytes);
          throw new ApiError(507, 'STORAGE_CAP_EXCEEDED', 'Workspace owner storage limit would be exceeded');
        }
        const stored = await storage.save(request, maxUploadBytes, available);
        try {
          await validateStoredFile(details.name, await storage.sample(stored.storageKey),
            () => storage.zipEntries(stored.storageKey));
          const file = await mutate(() => {
            catalog.getWorkspace(workspace.id, user.id, 'contribute');
            const current = catalog.usage(workspace.ownerId, storageLimitBytes);
            if (stored.size > Math.max(0, current.limitBytes - current.usedBytes)) {
              throw new ApiError(507, 'STORAGE_CAP_EXCEEDED', 'Workspace owner storage limit would be exceeded');
            }
            return catalog.addWorkspaceUploadedFile(workspace.id, user.id, { ...details, ...stored });
          });
          return json(response, 201, file);
        } catch (error) {
          await storage.remove(stored.storageKey);
          throw error;
        }
      }
      const workspaceContentMatch = /^\/v1\/workspaces\/([^/]+)\/files\/([^/]+)\/content$/u.exec(path);
      if (request.method === 'GET' && workspaceContentMatch) {
        const workspace = catalog.getWorkspace(workspaceContentMatch[1], user.id);
        if (!workspace.fileIds.includes(workspaceContentMatch[2])) {
          throw new ApiError(404, 'FILE_NOT_FOUND', 'File was not found in this workspace');
        }
        const file = catalog.getFile(workspaceContentMatch[2], workspace.ownerId, 'manage');
        return await sendContent(response, file, url.searchParams.get('download') === '1');
      }
      const workspaceVersionMatch = /^\/v1\/workspaces\/([^/]+)\/files\/([^/]+)\/versions$/u.exec(path);
      if (request.method === 'POST' && workspaceVersionMatch) {
        const workspace = catalog.getWorkspace(workspaceVersionMatch[1], user.id, 'contribute');
        if (!workspace.fileIds.includes(workspaceVersionMatch[2])) {
          throw new ApiError(404, 'FILE_NOT_FOUND', 'File was not found in this workspace');
        }
        const file = catalog.getFile(workspaceVersionMatch[2], workspace.ownerId, 'manage');
        const extension = file.name.split('.').at(-1).toLowerCase();
        const mimeType = SUPPORTED_UPLOAD_TYPES[extension];
        if (!mimeType || (normalizeMimeType(request.headers['content-type']) !== 'application/octet-stream'
          && normalizeMimeType(request.headers['content-type']) !== mimeType)) {
          throw new ApiError(415, 'UNSUPPORTED_FILE_TYPE', 'Replacement must match the file type');
        }
        const declaredLength = request.headers['content-length'];
        if (declaredLength !== undefined && Number(declaredLength) > maxUploadBytes) {
          throw new ApiError(413, 'FILE_TOO_LARGE', 'File exceeds the upload limit');
        }
        const usage = catalog.usage(workspace.ownerId, storageLimitBytes);
        const available = Math.max(0, usage.limitBytes - usage.usedBytes);
        if (available === 0 || (declaredLength !== undefined && Number(declaredLength) > available)) {
          if (countedUpload) { activeUploads -= 1; countedUpload = false; }
          await drainRequest(request, maxUploadBytes);
          throw new ApiError(507, 'STORAGE_CAP_EXCEEDED', 'Workspace owner storage limit would be exceeded');
        }
        const stored = await storage.save(request, maxUploadBytes, available);
        try {
          await validateStoredFile(file.name, await storage.sample(stored.storageKey),
            () => storage.zipEntries(stored.storageKey));
          const updated = await mutate(() => {
            const currentWorkspace = catalog.getWorkspace(workspace.id, user.id, 'contribute');
            if (!currentWorkspace.fileIds.includes(file.id)) {
              throw new ApiError(404, 'FILE_NOT_FOUND', 'File was not found in this workspace');
            }
            const current = catalog.usage(workspace.ownerId, storageLimitBytes);
            if (stored.size > Math.max(0, current.limitBytes - current.usedBytes)) {
              throw new ApiError(507, 'STORAGE_CAP_EXCEEDED', 'Workspace owner storage limit would be exceeded');
            }
            return catalog.replaceFile(file.id, workspace.ownerId, stored, user.id);
          });
          return json(response, 201, updated);
        } catch (error) {
          await storage.remove(stored.storageKey);
          throw error;
        }
      }
      if (request.method === 'GET' && path === '/v1/snapshots/shared') {
        return json(response, 200, { snapshots: catalog.listSharedSnapshots(user.id) });
      }
      const workspaceFilesMatch = /^\/v1\/workspaces\/([^/]+)\/files$/u.exec(path);
      if (workspaceFilesMatch) {
        if (request.method === 'GET') {
          return json(response, 200, { files: catalog.listWorkspaceFiles(workspaceFilesMatch[1], user.id) });
        }
        if (request.method === 'POST') {
          const input = await readJson(request);
          if (typeof input?.fileId !== 'string') {
            throw new ApiError(400, 'INVALID_FILE', 'Choose a file to add');
          }
          return json(response, 200, await mutate(() => catalog.addWorkspaceFile(
            workspaceFilesMatch[1], user.id, input.fileId)));
        }
      }
      const workspaceFileMatch = /^\/v1\/workspaces\/([^/]+)\/files\/([^/]+)$/u.exec(path);
      if (request.method === 'DELETE' && workspaceFileMatch) {
        await mutate(() => catalog.removeWorkspaceFile(workspaceFileMatch[1], user.id, workspaceFileMatch[2]));
        response.writeHead(204);
        return response.end();
      }
      const snapshotsMatch = /^\/v1\/workspaces\/([^/]+)\/snapshots$/u.exec(path);
      if (snapshotsMatch) {
        if (request.method === 'GET') {
          return json(response, 200, { snapshots: catalog.listSnapshots(snapshotsMatch[1], user.id) });
        }
        if (request.method === 'POST') {
          const input = await readJson(request);
          if (!validName(input?.name) || typeof input?.note !== 'string' || input.note.length > 1000
            || !Array.isArray(input?.fileIds) || input.fileIds.length > 200
            || input.fileIds.some((id) => typeof id !== 'string')) {
            throw new ApiError(400, 'INVALID_SNAPSHOT',
              'Provide a name, note up to 1000 characters, and up to 200 selected files');
          }
          return json(response, 201, await mutate(() => catalog.createSnapshot(
            snapshotsMatch[1], user.id, input.name.trim(), input.note.trim(), input.fileIds)));
        }
      }
      const workspaceMatch = /^\/v1\/workspaces\/([^/]+)$/u.exec(path);
      if (workspaceMatch) {
        if (request.method === 'GET') {
          return json(response, 200, { ...catalog.getWorkspace(workspaceMatch[1], user.id),
            role: catalog.workspaceRole(workspaceMatch[1], user.id) });
        }
        if (request.method === 'DELETE') {
          await mutate(() => catalog.deleteWorkspace(workspaceMatch[1], user.id));
          response.writeHead(204);
          return response.end();
        }
      }
      const snapshotContentMatch = /^\/v1\/snapshots\/([^/]+)\/files\/([^/]+)\/content$/u.exec(path);
      if (request.method === 'GET' && snapshotContentMatch) {
        const snapshot = catalog.getSnapshot(snapshotContentMatch[1], user.id);
        const item = snapshot.items.find((entry) => entry.fileId === snapshotContentMatch[2]);
        const version = catalog.getSnapshotVersion(snapshot.id, snapshotContentMatch[2], user.id);
        return await sendContent(response, { ...version, id: version.fileId, name: item.name },
          url.searchParams.get('download') === '1');
      }
      const snapshotArchiveMatch = /^\/v1\/snapshots\/([^/]+)\/archive$/u.exec(path);
      if (request.method === 'GET' && snapshotArchiveMatch) {
        const snapshot = catalog.getSnapshot(snapshotArchiveMatch[1], user.id);
        const versions = catalog.snapshotVersions(snapshot.id, user.id);
        const releases = [];
        try {
          for (const item of snapshot.items) releases.push(beginRead(item.fileId));
          response.writeHead(200, {
            'Content-Type': 'application/x-tar',
            'Content-Disposition': `attachment; filename="snapshot-${snapshot.id}.tar"`,
            'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store',
          });
          await pipeline(snapshotArchive(snapshot, versions, storage), response);
        } finally {
          for (const release of releases) release();
        }
        return;
      }
      const snapshotCopyMatch = /^\/v1\/snapshots\/([^/]+)\/copy$/u.exec(path);
      if (request.method === 'POST' && snapshotCopyMatch) {
        const workspace = await mutate(async () => {
          const snapshot = catalog.getSnapshot(snapshotCopyMatch[1], user.id);
          const total = snapshot.items.reduce((sum, item) => sum + item.size, 0);
          const usage = catalog.usage(user.id, storageLimitBytes);
          if (total > Math.max(0, usage.limitBytes - usage.usedBytes)) {
            throw new ApiError(507, 'STORAGE_CAP_EXCEEDED', 'Not enough storage to copy this snapshot');
          }
          const versions = catalog.snapshotVersions(snapshot.id, user.id);
          const stored = [];
          try {
            for (const version of versions) stored.push(await storage.copy(version.storageKey));
            return await catalog.copySnapshot(snapshot.id, user.id, stored);
          } catch (error) {
            for (const item of stored) await storage.remove(item.storageKey);
            throw error;
          }
        });
        return json(response, 201, workspace);
      }
      const snapshotAccessMatch = /^\/v1\/snapshots\/([^/]+)\/access$/u.exec(path);
      if (snapshotAccessMatch) {
        if (request.method === 'GET') {
          return json(response, 200, { users: catalog.listSnapshotGrants(snapshotAccessMatch[1], user.id) });
        }
        if (request.method === 'POST') {
          const input = await readJson(request);
          if (!validEmail(input?.email)) throw new ApiError(400, 'INVALID_EMAIL', 'Provide a valid email');
          return json(response, 201, await mutate(() => catalog.grantSnapshot(
            snapshotAccessMatch[1], user.id, input.email.trim().toLowerCase())));
        }
      }
      const snapshotRecipientMatch = /^\/v1\/snapshots\/([^/]+)\/access\/([^/]+)$/u.exec(path);
      if (request.method === 'DELETE' && snapshotRecipientMatch) {
        await mutate(() => catalog.revokeSnapshotGrant(
          snapshotRecipientMatch[1], user.id, snapshotRecipientMatch[2]));
        response.writeHead(204);
        return response.end();
      }
      const snapshotMatch = /^\/v1\/snapshots\/([^/]+)$/u.exec(path);
      if (snapshotMatch) {
        if (request.method === 'GET') {
          return json(response, 200, catalog.getSnapshot(snapshotMatch[1], user.id));
        }
        if (request.method === 'DELETE') {
          await mutate(() => catalog.deleteSnapshot(snapshotMatch[1], user.id));
          response.writeHead(204);
          return response.end();
        }
      }
      if (request.method === 'POST' && path === '/v1/organization/suggestions') {
        const input = await readJson(request);
        const extension = typeof input?.name === 'string' ? input.name.split('.').at(-1)?.toLowerCase() : '';
        if (!validName(input?.name) || !Object.hasOwn(SUPPORTED_UPLOAD_TYPES, extension)) {
          throw new ApiError(400, 'INVALID_FILE_NAME', 'Provide a supported file name');
        }
        if (typeof input.currentFolderId !== 'string' || !input.currentFolderId) {
          throw new ApiError(400, 'INVALID_FOLDER', 'Provide the current folder');
        }
        return json(response, 200, await mutate(() => catalog.createOrganizationSuggestion(
          user.id, input.name, input.currentFolderId)));
      }
      const suggestionDecisionMatch = /^\/v1\/organization\/suggestions\/([^/]+)\/decision$/u.exec(path);
      if (request.method === 'POST' && suggestionDecisionMatch) {
        const input = await readJson(request);
        if (typeof input?.accept !== 'boolean') {
          throw new ApiError(400, 'INVALID_DECISION', 'Choose whether to use the suggested folder');
        }
        await mutate(() => catalog.decideOrganizationSuggestion(user.id, suggestionDecisionMatch[1], input.accept));
        response.writeHead(204);
        return response.end();
      }
      if (request.method === 'GET' && path === '/v1/organization/stats') {
        return json(response, 200, catalog.organizationStats(user.id));
      }
      if (request.method === 'POST' && path === '/v1/folders') {
        const input = await readJson(request);
        if (!validName(input?.name)) throw new ApiError(400, 'INVALID_NAME', 'Provide a valid folder name');
        const folder = await catalog.createFolder(input.name, input.parentId || ROOT_FOLDER_ID, user.id);
        return json(response, 201, folder);
      }
      if (request.method === 'GET' && path === '/v1/folders') {
        return json(response, 200, { folders: catalog.listFolders(user.id) });
      }

      const childrenMatch = /^\/v1\/folders\/([^/]+)\/children$/u.exec(path);
      if (request.method === 'GET' && childrenMatch) {
        return json(response, 200, catalog.listChildren(childrenMatch[1], user.id));
      }
      const folderMatch = /^\/v1\/folders\/([^/]+)$/u.exec(path);
      if (request.method === 'PATCH' && folderMatch) {
        const input = await readJson(request);
        if (!input || typeof input !== 'object' || Array.isArray(input)
          || !Object.keys(input).length || Object.keys(input).some((key) => !['name', 'parentId'].includes(key))) {
          throw new ApiError(400, 'INVALID_UPDATE', 'Provide a folder name or destination');
        }
        if ('name' in input && !validName(input.name)) {
          throw new ApiError(400, 'INVALID_NAME', 'Provide a valid folder name');
        }
        if ('parentId' in input && (typeof input.parentId !== 'string' || !input.parentId)) {
          throw new ApiError(400, 'INVALID_FOLDER', 'Provide a valid destination folder');
        }
        return json(response, 200, await mutate(() => catalog.updateFolder(folderMatch[1], user.id, input)));
      }
      if (request.method === 'DELETE' && folderMatch) {
        await mutate(() => catalog.deleteFolder(folderMatch[1], user.id));
        response.writeHead(204);
        return response.end();
      }

      if (request.method === 'POST' && path === '/v1/files') {
        // Validate name/folder/type before touching the catalog lock.
        const details = uploadDetails(request, url, catalog, user.id, maxUploadBytes);

        const usage = catalog.usage(user.id, storageLimitBytes);
        const preAvailable = Math.max(0, usage.limitBytes - usage.usedBytes);
        const declaredLength = request.headers['content-length'];
        if (preAvailable === 0 || (declaredLength !== undefined && Number(declaredLength) > preAvailable)) {
          // Release the upload slot before draining so other accounts can still
          // write. Drain the body before responding — Vite's proxy + Safari XHR
          // turn an early 507 into a bare 500, which hides the upgrade prompt.
          if (countedUpload) {
            activeUploads -= 1;
            countedUpload = false;
          }
          await drainRequest(request, maxUploadBytes);
          throw new ApiError(507, 'STORAGE_CAP_EXCEEDED', 'Storage limit would be exceeded');
        }

        const stored = await storage.save(request, maxUploadBytes, preAvailable);
        let file;
        try {
          await validateStoredFile(details.name, await storage.sample(stored.storageKey),
            () => storage.zipEntries(stored.storageKey));
          file = await mutate(async () => {
            const current = catalog.usage(user.id, storageLimitBytes);
            if (stored.size > Math.max(0, current.limitBytes - current.usedBytes)) {
              throw new ApiError(507, 'STORAGE_CAP_EXCEEDED', 'Storage limit would be exceeded');
            }
            return catalog.addFile({ ...details, ...stored, ownerId: user.id });
          });
        } catch (error) {
          await storage.remove(stored.storageKey);
          throw error;
        }
        return json(response, 201, file);
      }

      const versionsMatch = /^\/v1\/files\/([^/]+)\/versions$/u.exec(path);
      if (request.method === 'GET' && versionsMatch) {
        return json(response, 200, catalog.listVersions(versionsMatch[1], user.id));
      }
      if (request.method === 'POST' && versionsMatch) {
        const file = catalog.getFile(versionsMatch[1], user.id, 'manage');
        const extension = file.name.split('.').at(-1).toLowerCase();
        const mimeType = SUPPORTED_UPLOAD_TYPES[extension];
        if (!mimeType || (normalizeMimeType(request.headers['content-type']) !== 'application/octet-stream'
          && normalizeMimeType(request.headers['content-type']) !== mimeType)) {
          throw new ApiError(415, 'UNSUPPORTED_FILE_TYPE', 'Replacement must match the file type');
        }
        const declaredLength = request.headers['content-length'];
        if (declaredLength !== undefined && Number(declaredLength) > maxUploadBytes) {
          throw new ApiError(413, 'FILE_TOO_LARGE', 'File exceeds the upload limit');
        }
        const usage = catalog.usage(user.id, storageLimitBytes);
        const available = Math.max(0, usage.limitBytes - usage.usedBytes);
        if (available === 0 || (declaredLength !== undefined && Number(declaredLength) > available)) {
          if (countedUpload) { activeUploads -= 1; countedUpload = false; }
          await drainRequest(request, maxUploadBytes);
          throw new ApiError(507, 'STORAGE_CAP_EXCEEDED', 'Storage limit would be exceeded');
        }
        const stored = await storage.save(request, maxUploadBytes, available);
        try {
          await validateStoredFile(file.name, await storage.sample(stored.storageKey),
            () => storage.zipEntries(stored.storageKey));
          const updated = await mutate(() => {
            const current = catalog.usage(user.id, storageLimitBytes);
            if (stored.size > Math.max(0, current.limitBytes - current.usedBytes)) {
              throw new ApiError(507, 'STORAGE_CAP_EXCEEDED', 'Storage limit would be exceeded');
            }
            return catalog.replaceFile(file.id, user.id, stored);
          });
          return json(response, 201, updated);
        } catch (error) {
          await storage.remove(stored.storageKey);
          throw error;
        }
      }

      const versionContentMatch = /^\/v1\/files\/([^/]+)\/versions\/([^/]+)\/content$/u.exec(path);
      if (request.method === 'GET' && versionContentMatch) {
        const version = catalog.getVersion(versionContentMatch[1], user.id, versionContentMatch[2]);
        return await sendContent(response, { ...version, id: version.fileId },
          url.searchParams.get('download') === '1');
      }
      const versionRestoreMatch = /^\/v1\/files\/([^/]+)\/versions\/([^/]+)\/restore$/u.exec(path);
      if (request.method === 'POST' && versionRestoreMatch) {
        const [fileId, versionId] = versionRestoreMatch.slice(1);
        const updated = await mutate(async () => {
          const file = catalog.getFile(fileId, user.id, 'manage');
          const version = catalog.getVersion(fileId, user.id, versionId);
          if (file.currentVersionId === versionId) {
            throw new ApiError(409, 'VERSION_ALREADY_CURRENT', 'This version is already current');
          }
          const usage = catalog.usage(user.id, storageLimitBytes);
          if (version.size > Math.max(0, usage.limitBytes - usage.usedBytes)) {
            throw new ApiError(507, 'STORAGE_CAP_EXCEEDED', 'Storage limit would be exceeded');
          }
          const stored = await storage.copy(version.storageKey);
          try { return await catalog.restoreVersion(fileId, user.id, versionId, stored); }
          catch (error) { await storage.remove(stored.storageKey); throw error; }
        });
        return json(response, 201, updated);
      }
      const versionMatch = /^\/v1\/files\/([^/]+)\/versions\/([^/]+)$/u.exec(path);
      if (request.method === 'PATCH' && versionMatch) {
        const input = await readJson(request);
        if (typeof input?.label !== 'string' || input.label.length > 80
          || /[\u0000-\u001f\u007f]/u.test(input.label)) {
          throw new ApiError(400, 'INVALID_VERSION_LABEL', 'Use a label of at most 80 characters');
        }
        return json(response, 200, await mutate(() => catalog.labelVersion(
          versionMatch[1], user.id, versionMatch[2], input.label.trim())));
      }

      const contentMatch = /^\/v1\/files\/([^/]+)\/content$/u.exec(path);
      if (request.method === 'GET' && contentMatch) {
        const file = catalog.getFile(contentMatch[1], user.id);
        return await sendContent(response, file, url.searchParams.get('download') === '1');
      }

      const sharesMatch = /^\/v1\/files\/([^/]+)\/shares$/u.exec(path);
      if (request.method === 'POST' && sharesMatch) {
        const share = await catalog.createShare(sharesMatch[1], user.id);
        const sharePath = `/v1/shares/${share.token}`;
        const shareUrl = publicBaseUrl ? `${publicBaseUrl}${sharePath}` : sharePath;
        return json(response, 201, { ...share, url: shareUrl });
      }
      if (request.method === 'GET' && sharesMatch) {
        return json(response, 200, { links: catalog.listShares(sharesMatch[1], user.id) });
      }
      const revokeShareMatch = /^\/v1\/files\/([^/]+)\/shares\/([^/]+)$/u.exec(path);
      if (request.method === 'DELETE' && revokeShareMatch) {
        await catalog.revokeShare(revokeShareMatch[1], user.id, revokeShareMatch[2]);
        response.writeHead(204);
        return response.end();
      }
      if (request.method === 'GET' && path === '/v1/files/shared') {
        return json(response, 200, { files: catalog.listShared(user.id) });
      }
      const accessMatch = /^\/v1\/files\/([^/]+)\/access$/u.exec(path);
      if (request.method === 'GET' && accessMatch) {
        return json(response, 200, { users: catalog.listGrants(accessMatch[1], user.id) });
      }
      if (request.method === 'POST' && accessMatch) {
        const input = await readJson(request);
        if (!validEmail(input?.email)) throw new ApiError(400, 'INVALID_EMAIL', 'Provide a valid email');
        return json(response, 201, await catalog.grantFile(accessMatch[1], user.id,
          input.email.trim().toLowerCase()));
      }
      const revokeMatch = /^\/v1\/files\/([^/]+)\/access\/([^/]+)$/u.exec(path);
      if (request.method === 'DELETE' && revokeMatch) {
        await catalog.revokeGrant(revokeMatch[1], user.id, revokeMatch[2]);
        response.writeHead(204);
        return response.end();
      }

      const fileMatch = /^\/v1\/files\/([^/]+)$/u.exec(path);
      if (request.method === 'GET' && fileMatch) {
        return json(response, 200, publicFile(catalog.getFile(fileMatch[1], user.id)));
      }
      if (request.method === 'PATCH' && fileMatch) {
        const input = await readJson(request);
        if (!input || typeof input !== 'object' || Array.isArray(input)
          || !Object.keys(input).length || Object.keys(input).some((key) => !['name', 'folderId'].includes(key))) {
          throw new ApiError(400, 'INVALID_UPDATE', 'Provide a file name or destination');
        }
        if ('name' in input && !validName(input.name)) {
          throw new ApiError(400, 'INVALID_NAME', 'Provide a valid file name');
        }
        if ('folderId' in input && (typeof input.folderId !== 'string' || !input.folderId)) {
          throw new ApiError(400, 'INVALID_FOLDER', 'Provide a valid destination folder');
        }
        return json(response, 200, await mutate(() => catalog.updateFile(fileMatch[1], user.id, input)));
      }
      if (request.method === 'DELETE' && fileMatch) {
        await mutate(async () => {
          const file = catalog.getFile(fileMatch[1], user.id, 'manage');
          catalog.assertFileDeletable(file.id, user.id);
          deleting.add(file.id);
          try {
            await waitForReads(file.id);
            const staged = [];
            try {
              for (const key of catalog.versionStorageKeys(file.id, user.id)) {
                staged.push(await storage.stageRemove(key));
              }
              await catalog.deleteFile(file.id, user.id);
            } catch (error) {
              for (const item of staged.reverse()) await item.rollback();
              throw error;
            }
            // The catalog deletion is committed. Startup recovery retries file cleanup.
            for (const item of staged) {
              try { await item.commit(); }
              catch (error) { console.error('Deferred cleanup of deleted file', error); }
            }
          } finally {
            deleting.delete(file.id);
          }
        });
        response.writeHead(204);
        return response.end();
      }
      throw new ApiError(404, 'NOT_FOUND', 'Endpoint was not found');
    } catch (error) {
      if (response.destroyed) return;
      if (response.headersSent) {
        response.destroy(error);
        return;
      }
      const apiError = unwrapApiError(error);
      const status = apiError ? apiError.status : 500;
      const code = apiError ? apiError.code : 'INTERNAL_ERROR';
      const message = apiError ? apiError.message : 'Unexpected server error';
      if (status === 500) console.error(error);
      json(response, status, { error: { code, message } });
    } finally {
      if (countedUpload) activeUploads -= 1;
      else if (mutation && !upload) activeMutations -= 1;
    }
  };
}
