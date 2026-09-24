import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { ApiError } from '../../routes/errors.js';

const scrypt = promisify(scryptCallback);
const SESSION_DAYS = 7;
const RATE_WINDOW_MS = 15 * 60_000;

export function createAuthLimiter() {
  const attempts = new Map();
  function entry(key) {
    const now = Date.now();
    const current = attempts.get(key);
    if (current && current.expiresAt > now) return current;
    const fresh = { count: 0, expiresAt: now + RATE_WINDOW_MS };
    attempts.set(key, fresh);
    return fresh;
  }
  function check(key, limit) {
    if (entry(key).count >= limit) {
      throw new ApiError(429, 'RATE_LIMITED', 'Too many authentication attempts; try again later');
    }
  }
  function record(key) {
    entry(key).count += 1;
  }
  return {
    registration(ip) {
      const key = `register:${ip}`;
      check(key, 10);
      record(key);
    },
    checkLogin(ip, email) {
      check(`login-ip:${ip}`, 30);
      check(`login-account:${ip}:${email}`, 5);
    },
    failedLogin(ip, email) {
      record(`login-ip:${ip}`);
      record(`login-account:${ip}:${email}`);
    },
    successfulLogin(ip, email) {
      attempts.delete(`login-account:${ip}:${email}`);
    },
  };
}

export function validEmail(value) {
  return typeof value === 'string' && value.length <= 254
    && /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value);
}

export function validPassword(value) {
  return typeof value === 'string' && value.length >= 12 && value.length <= 1024;
}

export async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = await scrypt(password, salt, 64);
  return `${salt}:${hash.toString('hex')}`;
}

export async function verifyPassword(password, stored) {
  if (typeof stored !== 'string') return false;
  const [salt, hex] = stored.split(':');
  if (!salt || !hex || !/^[a-f0-9]{128}$/u.test(hex)) return false;
  const actual = await scrypt(password, salt, 64);
  return timingSafeEqual(actual, Buffer.from(hex, 'hex'));
}

export function sessionToken(request) {
  const cookies = request.headers.cookie?.split(';') ?? [];
  const cookie = cookies.map((part) => part.trim()).find((part) => part.startsWith('dropvault_session='));
  return cookie?.slice('dropvault_session='.length) ?? null;
}

export function requireUser(request, catalog) {
  const user = catalog.sessionUser(sessionToken(request));
  if (!user) throw new ApiError(401, 'UNAUTHENTICATED', 'Sign in to continue');
  return user;
}

export async function createSession(catalog, userId) {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86_400_000).toISOString();
  await catalog.createSession(userId, token, expiresAt);
  return token;
}

export function sessionCookie(token, secure = false) {
  return `dropvault_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_DAYS * 86_400}`
    + (secure ? '; Secure' : '');
}

export function clearSessionCookie(secure = false) {
  return 'dropvault_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'
    + (secure ? '; Secure' : '');
}

export function checkRequestOrigin(request) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return;
  const origin = request.headers.origin;
  if (!origin) return; // CLI clients may omit Origin; browsers supply it for cross-origin writes.
  const host = request.headers.host;
  if (origin !== `http://${host}` && origin !== `https://${host}`) {
    throw new ApiError(403, 'INVALID_ORIGIN', 'Cross-origin changes are not allowed');
  }
}
