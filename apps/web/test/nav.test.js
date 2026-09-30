import assert from 'node:assert/strict';
import test from 'node:test';
import { filesNavCurrent, workspacesNavCurrent } from '../src/app/navCurrent.js';

test('My files stays current inside a folder and on a file', () => {
  assert.equal(filesNavCurrent('/files'), true);
  assert.equal(filesNavCurrent('/folders/abc'), true);
  assert.equal(filesNavCurrent('/view/abc'), true);
  assert.equal(filesNavCurrent('/shared'), false);
  assert.equal(filesNavCurrent('/themes'), false);
});

test('Workspaces stays current on a workspace and a snapshot', () => {
  assert.equal(workspacesNavCurrent('/workspaces'), true);
  assert.equal(workspacesNavCurrent('/workspaces/abc'), true);
  assert.equal(workspacesNavCurrent('/snapshots/abc'), true);
  assert.equal(workspacesNavCurrent('/files'), false);
  assert.equal(workspacesNavCurrent('/themes'), false);
});
