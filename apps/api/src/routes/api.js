import { createHash, timingSafeEqual } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { MAX_UPLOAD_BYTES, ROOT_FOLDER_ID, validName } from '../../../../packages/shared/index.js';
import { publicFile } from '../db/catalog.js';
import { checkRequestOrigin, clearSessionCookie, createAuthLimiter, createSession, hashPassword,
  requireUser, sessionCookie, sessionToken, validEmail, validPassword,
  verifyPassword } from '../modules/accounts/auth.js';
import { contentHeaders } from '../modules/files/content.js';
import { uploadDetails, validateStoredFile } from '../modules/uploads/validate.js';
import { ApiError } from './errors.js';

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
  const authLimiter = createAuthLimiter();
  const activeReads = new Map();
  const deleting = new Set();
  function mutate(work) {
    const operation = pendingMutation.then(work);
    pendingMutation = operation.catch(() => {});
    return operation;
  }

  async function sendContent(response, file, download) {
    if (deleting.has(file.id)) throw new ApiError(404, 'FILE_NOT_FOUND', 'File was not found');
    const current = activeReads.get(file.id) ?? { count: 0, waiters: [] };
    current.count += 1;
    activeReads.set(file.id, current);
    try {
      const stream = storage.read(file.storageKey);
      response.writeHead(200, contentHeaders(file, download));
      await pipeline(stream, response);
    } finally {
      current.count -= 1;
      if (current.count === 0) {
        activeReads.delete(file.id);
        for (const resolve of current.waiters) resolve();
      }
    }
  }

  async function waitForReads(fileId) {
    const current = activeReads.get(fileId);
    if (current?.count) await new Promise((resolve) => current.waiters.push(resolve));
  }

  return async (request, response) => {
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
          await hashPassword(input.password));
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
        return sendContent(response, catalog.getSharedFile(shareMatch[1]),
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
      if (request.method === 'POST' && path === '/v1/folders') {
        const input = await readJson(request);
        if (!validName(input?.name)) throw new ApiError(400, 'INVALID_NAME', 'Provide a valid folder name');
        const folder = await catalog.createFolder(input.name, input.parentId || ROOT_FOLDER_ID, user.id);
        return json(response, 201, folder);
      }

      const childrenMatch = /^\/v1\/folders\/([^/]+)\/children$/u.exec(path);
      if (request.method === 'GET' && childrenMatch) {
        return json(response, 200, catalog.listChildren(childrenMatch[1], user.id));
      }
      const folderMatch = /^\/v1\/folders\/([^/]+)$/u.exec(path);
      if (request.method === 'DELETE' && folderMatch) {
        await mutate(() => catalog.deleteFolder(folderMatch[1], user.id));
        response.writeHead(204);
        return response.end();
      }

      if (request.method === 'POST' && path === '/v1/files') {
        // Validate name/folder/type before touching the catalog lock.
        const details = uploadDetails(request, url, catalog, user.id, maxUploadBytes);

        // Pre-check quota outside the lock (read-only, no catalog write).
        // If the request is already over-cap we drain and reject here so the
        // mutation queue is never held during I/O.  A TOCTOU re-check happens
        // inside mutate() before the actual write.
        const preAvailable = Math.max(0, catalog.usage(user.id, storageLimitBytes).limitBytes
          - catalog.usage(user.id, storageLimitBytes).usedBytes);
        const declaredLength = request.headers['content-length'];
        if (preAvailable === 0 || (declaredLength !== undefined && Number(declaredLength) > preAvailable)) {
          // Drain the request body outside the lock so the connection stays
          // open for the 507 response.  Cap at maxUploadBytes to bound I/O.
          let drained = 0;
          request.on('data', (chunk) => {
            drained += chunk.length;
            if (drained >= maxUploadBytes) request.destroy();
          });
          await new Promise((resolve) => { request.once('end', resolve); request.once('close', resolve); request.once('error', resolve); });
          throw new ApiError(507, 'STORAGE_CAP_EXCEEDED', 'Storage limit would be exceeded');
        }

        const file = await mutate(async () => {
          // Re-check inside the lock (TOCTOU guard): another upload may have
          // consumed the remaining space between the pre-check and here.
          const availableBytes = Math.max(0, catalog.usage(user.id, storageLimitBytes).limitBytes
            - catalog.usage(user.id, storageLimitBytes).usedBytes);
          const stored = await storage.save(request, maxUploadBytes, availableBytes);
          try {
            await validateStoredFile(details.name, await storage.sample(stored.storageKey),
              () => storage.zipEntries(stored.storageKey));
            return await catalog.addFile({ ...details, ...stored, ownerId: user.id });
          } catch (error) {
            await storage.remove(stored.storageKey);
            throw error;
          }
        });
        return json(response, 201, file);
      }

      const contentMatch = /^\/v1\/files\/([^/]+)\/content$/u.exec(path);
      if (request.method === 'GET' && contentMatch) {
        const file = catalog.getFile(contentMatch[1], user.id);
        return sendContent(response, file, url.searchParams.get('download') === '1');
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
      if (request.method === 'DELETE' && fileMatch) {
        await mutate(async () => {
          const file = catalog.getFile(fileMatch[1], user.id, 'manage');
          deleting.add(file.id);
          try {
            await waitForReads(file.id);
            const staged = await storage.stageRemove(file.storageKey);
            try {
              await catalog.deleteFile(file.id, user.id);
            } catch (error) {
              await staged.rollback();
              throw error;
            }
            // The catalog deletion is committed. Startup recovery retries file cleanup.
            try {
              await staged.commit();
            } catch (error) {
              console.error('Deferred cleanup of deleted file', error);
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
      if (response.headersSent || response.destroyed) {
        response.destroy(error);
        return;
      }
      const status = error instanceof ApiError ? error.status : 500;
      const code = error instanceof ApiError ? error.code : 'INTERNAL_ERROR';
      const message = error instanceof ApiError ? error.message : 'Unexpected server error';
      if (status === 500) console.error(error);
      json(response, status, { error: { code, message } });
    }
  };
}
