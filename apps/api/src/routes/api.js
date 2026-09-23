import { pipeline } from 'node:stream/promises';
import { MAX_UPLOAD_BYTES, ROOT_FOLDER_ID, validName } from '../../../../packages/shared/index.js';
import { publicFile } from '../db/catalog.js';
import { contentHeaders } from '../modules/files/content.js';
import { uploadDetails } from '../modules/uploads/validate.js';
import { ApiError } from './errors.js';

function json(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'X-Content-Type-Options': 'nosniff',
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

export function createHandler({ catalog, storage, maxUploadBytes = MAX_UPLOAD_BYTES }) {
  return async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      const path = url.pathname;

      if (request.method === 'GET' && path === '/v1/health') {
        return json(response, 200, { status: 'ok' });
      }
      if (request.method === 'POST' && path === '/v1/folders') {
        const input = await readJson(request);
        if (!validName(input?.name)) throw new ApiError(400, 'INVALID_NAME', 'Provide a valid folder name');
        const folder = await catalog.createFolder(input.name, input.parentId || ROOT_FOLDER_ID);
        return json(response, 201, folder);
      }

      const childrenMatch = /^\/v1\/folders\/([^/]+)\/children$/u.exec(path);
      if (request.method === 'GET' && childrenMatch) {
        return json(response, 200, catalog.listChildren(childrenMatch[1]));
      }

      if (request.method === 'POST' && path === '/v1/files') {
        const details = uploadDetails(request, url, catalog, maxUploadBytes);
        const stored = await storage.save(request, maxUploadBytes);
        try {
          const file = await catalog.addFile({ ...details, ...stored });
          return json(response, 201, file);
        } catch (error) {
          await storage.remove(stored.storageKey);
          throw error;
        }
      }

      const contentMatch = /^\/v1\/files\/([^/]+)\/content$/u.exec(path);
      if (request.method === 'GET' && contentMatch) {
        const file = catalog.getFile(contentMatch[1]);
        response.writeHead(200, contentHeaders(file, url.searchParams.get('download') === '1'));
        await pipeline(storage.read(file.storageKey), response);
        return;
      }

      const fileMatch = /^\/v1\/files\/([^/]+)$/u.exec(path);
      if (request.method === 'GET' && fileMatch) {
        return json(response, 200, publicFile(catalog.getFile(fileMatch[1])));
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
