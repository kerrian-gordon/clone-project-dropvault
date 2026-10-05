import { access } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validPassword } from './modules/accounts/auth.js';
import { seedDemoData } from './seed-demo.js';
import { createApiServer } from './server.js';

const builtWeb = fileURLToPath(new URL('../../web/dist/', import.meta.url));
const freeLimitBytes = 104857600;

export function hostedDemoOptions(env = process.env) {
  const storageRoot = env.DROPVAULT_STORAGE_DIR;
  const accessPassword = env.DROPVAULT_DEMO_ACCESS_PASSWORD;
  const accountPassword = env.DROPVAULT_DEMO_PASSWORD;
  const publicBaseUrl = env.DROPVAULT_PUBLIC_BASE_URL;
  const host = env.DROPVAULT_HOST || '0.0.0.0';
  const port = Number(env.PORT || 3000);
  if (!storageRoot || !isAbsolute(storageRoot)) {
    throw new Error('DROPVAULT_STORAGE_DIR must be an absolute persistent-volume path');
  }
  if (typeof accessPassword !== 'string' || accessPassword.length < 32) {
    throw new Error('DROPVAULT_DEMO_ACCESS_PASSWORD must have at least 32 characters');
  }
  if (!validPassword(accountPassword)) {
    throw new Error('DROPVAULT_DEMO_PASSWORD must have 12 to 1024 characters');
  }
  if (!publicBaseUrl) throw new Error('DROPVAULT_PUBLIC_BASE_URL is required');
  const url = new URL(publicBaseUrl);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(loopback && url.protocol === 'http:'))
    || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('DROPVAULT_PUBLIC_BASE_URL must be an HTTPS origin (HTTP only for loopback)');
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be an integer from 1 to 65535');
  }
  if (env.DROPVAULT_STORAGE_BACKEND && env.DROPVAULT_STORAGE_BACKEND !== 'local') {
    throw new Error('Hosted demo uses local storage on one persistent volume');
  }
  return { storageRoot, accessPassword, accountPassword, publicBaseUrl: url.origin,
    secureSessionCookies: url.protocol === 'https:', host, port, webDistDir: builtWeb };
}

export async function startHostedDemo(options = hostedDemoOptions()) {
  await access(options.webDistDir);
  await access(options.storageRoot);
  let seeded = false;
  try {
    await access(join(options.storageRoot, 'catalog.json'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await seedDemoData({ storageRoot: options.storageRoot, password: options.accountPassword });
    seeded = true;
  }
  const server = await createApiServer({
    storageRoot: options.storageRoot,
    storageLimitBytes: freeLimitBytes,
    publicBaseUrl: options.publicBaseUrl,
    demoPlanSwitchEnabled: true,
    demoSite: { webDistDir: options.webDistDir,
      accessPassword: options.accessPassword,
      secureSessionCookies: options.secureSessionCookies },
  });
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host, () => {
      server.removeListener('error', reject);
      resolveListen();
    });
  });
  console.log(`DropVault gated demo listening on ${options.host}:${server.address().port}`);
  if (seeded) console.log('Seeded fake demo accounts: alex@example.test and blair@example.test');
  return { server, seeded };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await startHostedDemo();
}
