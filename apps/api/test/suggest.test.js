import assert from 'node:assert/strict';
import test from 'node:test';
import { suggestFolder } from '../src/modules/files/suggest.js';

const folders = [
  { id: 'photos', name: 'Photos' },
  { id: 'reports', name: 'Quarterly Reports' },
  { id: 'documents', name: 'Documents' },
];

test('suggests one clear owned folder based on file name or type', () => {
  assert.equal(suggestFolder('quarterly-report.pdf', 'root', folders).folderId, 'reports');
  assert.equal(suggestFolder('holiday.jpg', 'root', folders).folderId, 'photos');
  assert.equal(suggestFolder('notes.pdf', 'root', folders).folderId, 'documents');
});

test('abstains for ambiguous matches and a file already in the best folder', () => {
  assert.equal(suggestFolder('holiday.jpg', 'photos', folders), null);
  assert.equal(suggestFolder('holiday.jpg', 'root', [
    { id: 'photos', name: 'Photos' }, { id: 'images', name: 'Images' },
  ]), null);
  assert.equal(suggestFolder('unknown.bin', 'root', folders), null);
});
