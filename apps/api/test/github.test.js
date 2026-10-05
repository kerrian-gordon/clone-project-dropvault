import assert from 'node:assert/strict';
import test from 'node:test';
import { createGitHubClient, parsePublicRepository } from '../src/services/github/public-import.js';

test('public repository input accepts only github.com paths or owner/repo', () => {
  assert.deepEqual(parsePublicRepository('https://github.com/Example/project.git'),
    { owner: 'Example', repo: 'project', repositoryFullName: 'Example/project' });
  for (const input of ['https://github.com.evil.test/a/b', 'https://github.com@evil.test/a/b',
    'https://github.com/a/b?token=secret', 'https://github.com/a/b/c', 'a/../b',
    'https://github.com:444/a/b']) {
    assert.throws(() => parsePublicRepository(input), { code: 'INVALID_GITHUB_REPOSITORY' });
  }
});

test('GitHub client pins an archive to a resolved commit and checks the redirect origin', async () => {
  const sha = 'a'.repeat(40);
  const requested = [];
  const client = createGitHubClient(async (url, options) => {
    const target = String(url);
    requested.push(target);
    assert.equal(options.redirect, 'manual');
    if (target === 'https://api.github.com/repos/sample/project') {
      return Response.json({ private: false, default_branch: 'main' });
    }
    if (target.endsWith('/commits/main')) return Response.json({ sha });
    if (target.endsWith(`/zipball/${sha}`)) return new Response(null, {
      status: 302, headers: { Location: `https://codeload.github.com/sample/project/legacy.zip/${sha}` },
    });
    if (target === `https://codeload.github.com/sample/project/legacy.zip/${sha}`) {
      return new Response(Buffer.from('archive'));
    }
    throw new Error(`Unexpected request: ${target}`);
  });
  const source = await client.resolve('sample/project');
  assert.equal(source.commitSha, sha);
  const downloaded = await client.download(source);
  const chunks = [];
  for await (const chunk of downloaded.stream) chunks.push(chunk);
  assert.equal(Buffer.concat(chunks).toString(), 'archive');
  assert.equal(requested.length, 4);

  const rejected = createGitHubClient(async () => new Response(null, {
    status: 302, headers: { Location: `https://example.test/sample/project/zip/${sha}` },
  }));
  await assert.rejects(rejected.download(source), { code: 'GITHUB_UNAVAILABLE' });
});

test('GitHub client lists recent commits and verifies a selected historical commit', async () => {
  const latest = 'a'.repeat(40);
  const older = 'b'.repeat(40);
  const requested = [];
  const client = createGitHubClient(async (url) => {
    const target = String(url);
    requested.push(target);
    if (target === 'https://api.github.com/repos/sample/project') {
      return Response.json({ private: false, default_branch: 'main' });
    }
    if (target.endsWith('/commits?sha=main&per_page=20')) {
      return Response.json([{ sha: latest, commit: { message: 'Latest\nMore',
        committer: { date: '2026-01-02T00:00:00Z' } } },
      { sha: older, commit: { message: 'Older', committer: { date: '2026-01-01T00:00:00Z' } } }]);
    }
    if (target.endsWith(`/commits/${older}`)) return Response.json({ sha: older });
    throw new Error(`Unexpected request: ${target}`);
  });
  const listed = await client.listCommits('sample/project');
  assert.deepEqual(listed.commits.map((item) => item.sha), [latest, older]);
  assert.equal(listed.commits[0].message, 'Latest');
  const source = await client.resolve('sample/project', older);
  assert.equal(source.commitSha, older);
  assert.equal(source.ref, older);
  assert.equal(source.sourceUrl, `https://github.com/sample/project/tree/${older}`);
  assert.equal(requested.length, 4);
  await assert.rejects(client.resolve('sample/project', 'not-a-sha'),
    { code: 'INVALID_GITHUB_COMMIT' });
  assert.equal(requested.length, 4);
});
