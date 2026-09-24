import { pipeline } from 'node:stream/promises';
import { MAX_UPLOAD_BYTES, ROOT_FOLDER_ID, validName } from '../../../../packages/shared/index.js';
import { publicFile } from '../db/catalog.js';
import { checkRequestOrigin, clearSessionCookie, createSession, hashPassword,
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

export function createHandler({ catalog, storage, maxUploadBytes = MAX_UPLOAD_BYTES, storageLimitBytes }) {
  let pendingMutation = Promise.resolve();
  function mutate(work) {
    const operation = pendingMutation.then(work);
    pendingMutation = operation.catch(() => {});
    return operation;
  }

  async function sendContent(response, file, download) {
    response.writeHead(200, contentHeaders(file, download));
    await pipeline(storage.read(file.storageKey), response);
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
        const user = validEmail(input?.email) ? catalog.findUser(input.email.trim().toLowerCase()) : null;
        if (!user || !validPassword(input?.password)
          || !await verifyPassword(input.password, user.passwordHash)) {
          throw new ApiError(401, 'INVALID_CREDENTIALS', 'Invalid email or password');
        }
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
        const file = await mutate(async () => {
          const details = uploadDetails(request, url, catalog, user.id, maxUploadBytes);
          const availableBytes = Math.max(0, catalog.usage(user.id, storageLimitBytes).limitBytes
            - catalog.usage(user.id, storageLimitBytes).usedBytes);
          const declaredLength = request.headers['content-length'];
          if (declaredLength !== undefined && Number(declaredLength) > availableBytes) {
            throw new ApiError(507, 'STORAGE_CAP_EXCEEDED', 'Storage limit would be exceeded');
          }
          const stored = await storage.save(request, maxUploadBytes, availableBytes);
          try {
            validateStoredFile(details.name, await storage.sample(stored.storageKey));
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
        const shareUrl = `http://127.0.0.1:${request.socket.localPort}/v1/shares/${share.token}`;
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
          const staged = await storage.stageRemove(file.storageKey);
          try {
            await catalog.deleteFile(file.id, user.id);
          } catch (error) {
            await staged.rollback();
            throw error;
          }
          await staged.commit();
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
