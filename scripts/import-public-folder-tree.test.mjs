import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchGitTree, normalizeTree, serializeBoundedFixture } from './import-public-folder-tree.mjs';

const source = { owner: 'example', repo: 'files', sha: 'a'.repeat(40) };
const treeSha = 'b'.repeat(40);
const responseCommit = { sha: source.sha, tree: { sha: treeSha } };
const responseTree = {
  sha: treeSha, truncated: false,
  tree: [
    { path: 'data', type: 'tree' },
    { path: 'data/monthly', type: 'tree' },
    { path: 'data/monthly/report.csv', type: 'blob' },
    { path: 'data/monthly/notes.txt', type: 'blob' },
    { path: 'docs/readme.md', type: 'blob' },
    { path: 'ignored/deeper/too/deep/file.txt', type: 'blob' },
    { path: 'link', type: 'commit' },
    { path: '../escape.txt', type: 'blob' },
  ],
};

test('fetches only a pinned public recursive tree and emits bounded unlabeled scenarios', async () => {
  const requested = [];
  const { tree, treeSha: fetchedTreeSha } = await fetchGitTree(source, { fetchImpl: async (url, options) => {
    requested.push({ url, options });
    return { ok: true, json: async () => requested.length === 1 ? responseCommit : responseTree };
  } });
  assert.match(requested[0].url, /\/repos\/example\/files\/git\/commits\/[a-f0-9]{40}$/u);
  assert.match(requested[1].url, /\/repos\/example\/files\/git\/trees\/[a-f0-9]{40}\?recursive=1$/u);
  assert.equal(requested[1].url.endsWith(`${treeSha}?recursive=1`), true);
  assert.equal(requested[0].options.headers.Accept, 'application/vnd.github+json');
  assert.equal(fetchedTreeSha, treeSha);
  const result = normalizeTree({ owner: source.owner, repo: source.repo, commitSha: source.sha, treeSha: fetchedTreeSha, tree }, { maxDepth: 3, maxScenarios: 2 });
  assert.equal(result.source.commitSha, source.sha);
  assert.equal(result.source.treeSha, treeSha);
  assert.equal(result.scenarios.length, 2);
  assert.equal(result.scenarios[0].name, 'notes.txt');
  assert.equal(result.scenarios[0].labelSource, 'unlabeled_public_tree');
  assert.equal(result.scenarios[0].targetFolderId, null);
  assert.deepEqual(result.scenarios[0].candidateFolders, ['data/monthly']);
  assert.equal(serializeBoundedFixture(result).endsWith('\n'), true);
});

test('refuses truncated trees and trees larger than configured bound', () => {
  const normalizedSource = { owner: source.owner, repo: source.repo, commitSha: source.sha, treeSha, tree: responseTree };
  assert.throws(() => normalizeTree({ ...normalizedSource, tree: { ...responseTree, truncated: true } }), /truncated/u);
  assert.throws(() => normalizeTree(normalizedSource, { maxEntries: 3 }), /over maxEntries/u);
});

test('fetch rejects oversized/truncated GitHub replies before normalization', async () => {
  await assert.rejects(fetchGitTree(source, { maxEntries: 2, fetchImpl: async (url) => ({
    ok: true, json: async () => url.includes('/commits/') ? responseCommit : responseTree,
  }) }), /exceeds maxEntries/u);
  await assert.rejects(fetchGitTree(source, { fetchImpl: async (url) => ({
    ok: true, json: async () => url.includes('/commits/') ? responseCommit : ({ ...responseTree, truncated: true }),
  }) }), /truncated/u);
});

test('rejects a mismatched commit response before requesting its tree', async () => {
  let calls = 0;
  await assert.rejects(fetchGitTree(source, { fetchImpl: async () => {
    calls += 1;
    return { ok: true, json: async () => ({ ...responseCommit, sha: 'c'.repeat(40) }) };
  } }), /did not verify the requested commit/u);
  assert.equal(calls, 1);
});

test('rejects branch names where a full commit SHA is required', () => {
  assert.throws(() => normalizeTree({ owner: 'example', repo: 'files', commitSha: 'main', treeSha, tree: responseTree }), /full 40-character/u);
  assert.throws(() => normalizeTree({ owner: 'example', repo: '..', commitSha: source.sha, treeSha, tree: responseTree }), /full 40-character/u);
});
