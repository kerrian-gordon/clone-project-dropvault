import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { chromium } from 'playwright-core';
import { createServer as createViteServer } from 'vite';

test('Chromium recognizes compressed Office files by content', { timeout: 60_000 }, async () => {
  let vite;
  let browser;
  try {
    vite = await createViteServer({
      configFile: false,
      root: fileURLToPath(new URL('../', import.meta.url)),
      server: { host: '127.0.0.1', port: 0, strictPort: false },
    });
    await vite.listen();
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${vite.httpServer.address().port}/`);
    for (const [format, file] of [
      ['DOCX', 'docx/document-1.docx'],
      ['PPTX', 'pptx/presentation-1.pptx'],
      ['XLSX', 'xlsx/workbook-1.xlsx'],
    ]) {
      const content = await readFile(new URL(`../../../docs/ml/samples/${file}`, import.meta.url));
      const detected = await page.evaluate(async (encoded) => {
        const { recognizeFile } = await import('/src/features/upload/recognizeFile.js');
        const raw = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
        return recognizeFile(new File([raw], 'misleading.zip', { type: 'application/zip' }));
      }, content.toString('base64'));
      assert.equal(detected.format, format, `${file}: ${detected.reason}`);
    }
  } finally {
    await browser?.close();
    await vite?.close();
  }
});
