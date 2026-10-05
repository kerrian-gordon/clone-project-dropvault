import { createHash, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join } from 'node:path';

const contentTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
};

function acceptedGate(request, passwordHash) {
  const header = request.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Basic ')) return false;
  const encoded = header.slice(6);
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded)) return false;
  const supplied = Buffer.from(encoded, 'base64').toString('utf8');
  if (!supplied.startsWith('demo:')) return false;
  return timingSafeEqual(createHash('sha256').update(supplied.slice(5)).digest(), passwordHash);
}

async function serveFile(request, response, path, immutable) {
  try {
    const info = await stat(path);
    if (!info.isFile()) throw new Error('Not a file');
    response.writeHead(200, {
      'Content-Type': contentTypes[extname(path).toLowerCase()] || 'application/octet-stream',
      'Content-Length': info.size,
      'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    if (request.method === 'HEAD') return response.end();
    createReadStream(path).on('error', (error) => response.destroy(error)).pipe(response);
  } catch (error) {
    if (error.code !== 'ENOENT' && error.message !== 'Not a file') console.error(error);
    response.writeHead(404, { 'Cache-Control': 'no-store' });
    response.end('Not found');
  }
}

export function wrapDemoSite(apiHandler, { webDistDir, accessPassword }) {
  if (!webDistDir || typeof accessPassword !== 'string' || accessPassword.length < 32) {
    throw new Error('A built web directory and a demo gate password of at least 32 characters are required');
  }
  const passwordHash = createHash('sha256').update(accessPassword).digest();
  return (request, response) => {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    if (pathname === '/v1/health' && request.method === 'GET') return apiHandler(request, response);
    if (!acceptedGate(request, passwordHash)) {
      response.writeHead(401, {
        'WWW-Authenticate': 'Basic realm="DropVault demo", charset="UTF-8"',
        'Cache-Control': 'no-store',
      });
      return response.end('Demo access required');
    }
    if (pathname === '/v1' || pathname.startsWith('/v1/')) return apiHandler(request, response);
    if (!['GET', 'HEAD'].includes(request.method)) {
      response.writeHead(405, { Allow: 'GET, HEAD', 'Cache-Control': 'no-store' });
      return response.end();
    }
    const asset = /^\/assets\/([A-Za-z0-9._-]+)$/u.exec(pathname);
    if (asset) return void serveFile(request, response, join(webDistDir, 'assets', asset[1]), true);
    if (pathname.startsWith('/assets/') || /\.[^/]+$/u.test(pathname)) {
      response.writeHead(404, { 'Cache-Control': 'no-store' });
      return response.end('Not found');
    }
    return void serveFile(request, response, join(webDistDir, 'index.html'), false);
  };
}
