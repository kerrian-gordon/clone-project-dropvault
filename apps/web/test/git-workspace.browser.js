import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { chromium } from 'playwright-core';
import { createServer as createViteServer } from 'vite';
import { createApiServer } from '../../api/src/server.js';

function tarEntries(bytes) {
  const entries = new Map();
  for (let offset = 0; offset + 512 <= bytes.length;) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const text = (start, length) => header.subarray(start, start + length).toString('utf8').replace(/\0.*$/u, '');
    const name = text(0, 100);
    const prefix = text(345, 155);
    const size = Number.parseInt(text(124, 12).trim(), 8);
    assert.ok(Number.isSafeInteger(size) && size >= 0);
    const path = prefix ? `${prefix}/${name}` : name;
    entries.set(path, bytes.subarray(offset + 512, offset + 512 + size));
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
}

test('real Git archive and dataset survive workspace snapshot export and copy',
  { timeout: 60_000 }, async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'dropvault-git-workspace-'));
    const repo = join(tempRoot, 'sample-repo');
    const storageRoot = join(tempRoot, 'storage');
    const archivePath = join(tempRoot, 'code.zip');
    const dataPath = join(tempRoot, 'results.csv');
    const readme = '# Trial project\n\nRun `python analysis.py` with results.csv.\n';
    const csv = 'trial,score\n1,82\n2,91\n';
    const revisedCsv = 'trial,score\n1,83\n2,93\n';
    const webRoot = fileURLToPath(new URL('../', import.meta.url));
    let api;
    let vite;
    let browser;
    try {
      await mkdir(repo);
      await writeFile(join(repo, 'README.md'), readme);
      await writeFile(join(repo, 'analysis.py'), 'print("trial analysis")\n');
      await writeFile(dataPath, csv);
      execFileSync('git', ['-C', repo, 'init', '-q']);
      execFileSync('git', ['-C', repo, 'config', 'core.autocrlf', 'false']);
      execFileSync('git', ['-C', repo, 'add', '.']);
      execFileSync('git', ['-C', repo, '-c', 'user.name=DropVault Test',
        '-c', 'user.email=dropvault@example.test', 'commit', '-qm', 'Save trial code']);
      const commit = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
      execFileSync('git', ['-C', repo, 'archive', '--format=zip', `--output=${archivePath}`, 'HEAD']);
      const zip = await readFile(archivePath);

      api = await createApiServer({ storageRoot });
      api.listen(0, '127.0.0.1');
      await once(api, 'listening');
      const apiOrigin = `http://127.0.0.1:${api.address().port}`;
      const credentials = { email: 'git-flow@example.test', password: 'correct horse battery staple' };
      const registration = await fetch(`${apiOrigin}/v1/auth/register`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(credentials),
      });
      assert.equal(registration.status, 201);
      const cookie = registration.headers.get('set-cookie').split(';', 1)[0];
      vite = await createViteServer({
        configFile: false, root: webRoot, esbuild: { jsx: 'automatic' },
        server: { host: '127.0.0.1', port: 0, strictPort: false,
          proxy: { '/v1': { target: apiOrigin, changeOrigin: false } } },
      });
      await vite.listen();
      const webOrigin = `http://127.0.0.1:${vite.httpServer.address().port}`;
      browser = await chromium.launch({ channel: 'chrome', headless: true });
      const page = await browser.newPage({ acceptDownloads: true });
      page.setDefaultTimeout(10_000);
      const pageErrors = [];
      page.on('pageerror', (error) => pageErrors.push(error.message));
      await page.goto(webOrigin, { waitUntil: 'domcontentloaded', timeout: 20_000 });
      await page.getByRole('textbox', { name: 'Email' }).fill(credentials.email);
      await page.getByRole('textbox', { name: 'Password' }).fill(credentials.password);
      await page.getByRole('button', { name: 'Log in' }).click();
      await page.getByRole('link', { name: 'Workspaces', exact: true }).click();
      await page.getByRole('textbox', { name: 'Name' }).fill('Trial project');
      await page.getByRole('button', { name: 'Create workspace' }).click();
      await page.getByRole('heading', { name: 'Trial project' }).waitFor();
      await page.locator('input[aria-label="Choose workspace files"]')
        .setInputFiles([archivePath, dataPath]);
      await page.getByText('code.zip: success').waitFor();
      await page.getByText('results.csv: success').waitFor();
      await page.getByRole('combobox', { name: 'Git code archive' }).selectOption({ label: 'code.zip' });
      await page.getByRole('button', { name: 'Link archive' }).click();
      await page.getByText(new RegExp(`Linked commit ${commit} from a ZIP comment`, 'u')).waitFor();
      const checks = page.locator('.workspace-files input[type="checkbox"]');
      assert.equal(await checks.count(), 2);
      const codeCheck = page.locator('.workspace-files li').filter({ hasText: 'code.zip' })
        .locator('input[type="checkbox"]');
      const dataCheck = page.locator('.workspace-files li').filter({ hasText: 'results.csv' })
        .locator('input[type="checkbox"]');
      assert.equal(await codeCheck.isChecked(), true);
      assert.equal(await codeCheck.isDisabled(), true);
      await dataCheck.check();
      await page.getByRole('textbox', { name: 'Snapshot name' }).fill('Trial one');
      await page.getByRole('button', { name: 'Review snapshot' }).click();
      const workspaceId = new URL(page.url()).pathname.split('/').at(-1);
      const filesBefore = await (await fetch(`${apiOrigin}/v1/workspaces/${workspaceId}/files`,
        { headers: { Cookie: cookie } })).json();
      const dataFile = filesBefore.files.find((file) => file.name === 'results.csv');
      const replacement = await fetch(`${apiOrigin}/v1/workspaces/${workspaceId}/files/${dataFile.id}/versions`, {
        method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'text/csv' }, body: revisedCsv,
      });
      assert.equal(replacement.status, 201);
      await page.getByRole('button', { name: 'Create fixed snapshot' }).click();
      await page.getByText('A selected file changed since review; refresh and review the versions again').waitFor();
      await page.getByText('No snapshots yet.').waitFor();
      await page.getByRole('button', { name: 'Review snapshot' }).click();
      await page.getByRole('button', { name: 'Create fixed snapshot' }).click();
      await page.getByRole('heading', { name: 'Trial one' }).waitFor();
      assert.match(await page.locator('.workspace-page').innerText(), new RegExp(commit, 'u'));

      const downloadPromise = page.waitForEvent('download');
      await page.getByRole('link', { name: 'Download all (.tar)' }).click();
      const download = await downloadPromise;
      const tarPath = join(tempRoot, 'snapshot.tar');
      await download.saveAs(tarPath);
      const entries = tarEntries(await readFile(tarPath));
      const manifest = JSON.parse(entries.get('manifest.json').toString('utf8'));
      assert.equal(manifest.git.commitSha, commit);
      assert.deepEqual(manifest.files.map((file) => file.name).sort(), ['code.zip', 'results.csv']);
      const code = manifest.files.find((file) => file.name === 'code.zip');
      const data = manifest.files.find((file) => file.name === 'results.csv');
      assert.deepEqual(entries.get(code.path), zip);
      assert.equal(entries.get(data.path).toString('utf8'), revisedCsv);

      await page.getByRole('button', { name: 'Restore as new workspace' }).click();
      await page.getByRole('heading', { name: 'Trial one (copy)' }).waitFor();
      const copiedId = new URL(page.url()).pathname.split('/').at(-1);
      const copiedResponse = await fetch(`${apiOrigin}/v1/workspaces/${copiedId}`, { headers: { Cookie: cookie } });
      assert.equal(copiedResponse.status, 200);
      const copied = await copiedResponse.json();
      assert.equal(copied.git.commitSha, commit);
      const copiedFiles = await (await fetch(`${apiOrigin}/v1/workspaces/${copiedId}/files`,
        { headers: { Cookie: cookie } })).json();
      assert.deepEqual(copiedFiles.files.map((file) => file.name).sort(), ['code.zip', 'results.csv']);
      for (const file of copiedFiles.files) {
        const response = await fetch(`${apiOrigin}/v1/workspaces/${copiedId}/files/${file.id}/content`,
          { headers: { Cookie: cookie } });
        assert.equal(response.status, 200);
        const bytes = Buffer.from(await response.arrayBuffer());
        assert.deepEqual(bytes, file.name === 'code.zip' ? zip : Buffer.from(revisedCsv));
      }
      assert.deepEqual(pageErrors, []);
    } finally {
      if (browser) await browser.close();
      if (vite) await vite.close();
      if (api) {
        api.closeAllConnections();
        await new Promise((resolveClose, reject) =>
          api.close((error) => error ? reject(error) : resolveClose()));
      }
      if (!resolve(tempRoot).startsWith(resolve(tmpdir()) + sep)) {
        throw new Error('Unexpected test storage path');
      }
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
