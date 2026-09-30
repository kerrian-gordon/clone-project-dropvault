import { Readable } from 'node:stream';
import { ApiError } from '../../routes/errors.js';

const ownerPattern = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/u;
const repoPattern = /^[A-Za-z0-9._-]{1,100}$/u;
const commitPattern = /^[a-f0-9]{40}$/u;
const apiHeaders = { Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'DropVault' };

export function parsePublicRepository(value) {
  if (typeof value !== 'string') throw new ApiError(400, 'INVALID_GITHUB_REPOSITORY',
    'Provide a public GitHub repository as owner/repo');
  let name = value.trim();
  if (name.startsWith('https://')) {
    let url;
    try { url = new URL(name); } catch { /* Report one clear repository error below. */ }
    if (!url || url.origin !== 'https://github.com' || url.username || url.password
      || url.search || url.hash) {
      throw new ApiError(400, 'INVALID_GITHUB_REPOSITORY',
        'Use a public github.com repository URL or owner/repo');
    }
    name = url.pathname.replace(/^\/+|\/+$/gu, '').replace(/\.git$/iu, '');
  }
  const parts = name.split('/');
  if (parts.length !== 2 || !ownerPattern.test(parts[0]) || !repoPattern.test(parts[1])
    || ['.', '..'].includes(parts[1])) {
    throw new ApiError(400, 'INVALID_GITHUB_REPOSITORY',
      'Provide a public GitHub repository as owner/repo');
  }
  return { owner: parts[0], repo: parts[1], repositoryFullName: parts.join('/') };
}

function githubError(status) {
  if (status === 404) return new ApiError(404, 'GITHUB_REPOSITORY_NOT_FOUND',
    'Public GitHub repository was not found');
  if (status === 403 || status === 429) return new ApiError(503, 'GITHUB_RATE_LIMITED',
    'GitHub is limiting requests; try again later');
  return new ApiError(502, 'GITHUB_UNAVAILABLE', 'GitHub could not complete the import');
}

export function createGitHubClient(fetchImpl = globalThis.fetch) {
  async function request(url, options = {}) {
    let response;
    try {
      response = await fetchImpl(url, { headers: apiHeaders, redirect: 'manual',
        signal: AbortSignal.timeout(60_000), ...options });
    } catch {
      throw new ApiError(502, 'GITHUB_UNAVAILABLE', 'GitHub could not be reached');
    }
    return response;
  }

  async function json(url) {
    const response = await request(url);
    if (!response.ok) throw githubError(response.status);
    try { return await response.json(); }
    catch { throw new ApiError(502, 'GITHUB_UNAVAILABLE', 'GitHub returned invalid metadata'); }
  }

  return {
    async resolve(repository) {
      const parsed = parsePublicRepository(repository);
      const base = `https://api.github.com/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}`;
      const metadata = await json(base);
      if (metadata.private !== false || typeof metadata.default_branch !== 'string'
        || !metadata.default_branch || metadata.default_branch.length > 200) {
        throw new ApiError(404, 'GITHUB_REPOSITORY_NOT_FOUND',
          'Public GitHub repository was not found');
      }
      const commit = await json(`${base}/commits/${encodeURIComponent(metadata.default_branch)}`);
      const sha = typeof commit.sha === 'string' ? commit.sha.toLowerCase() : '';
      if (!commitPattern.test(sha)) {
        throw new ApiError(502, 'GITHUB_UNAVAILABLE', 'GitHub returned an invalid commit ID');
      }
      return { ...parsed, ref: metadata.default_branch, commitSha: sha };
    },
    async download(source) {
      const endpoint = `https://api.github.com/repos/${encodeURIComponent(source.owner)}`
        + `/${encodeURIComponent(source.repo)}/zipball/${source.commitSha}`;
      let response = await request(endpoint);
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        let target;
        try { target = new URL(location, endpoint); } catch { /* Reject below. */ }
        const parts = target?.pathname.split('/') ?? [];
        if (!target || target.origin !== 'https://codeload.github.com'
          || target.username || target.password || target.search || target.hash
          || parts[1]?.toLowerCase() !== source.owner.toLowerCase()
          || parts[2]?.toLowerCase() !== source.repo.toLowerCase()
          || !['zip', 'legacy.zip'].includes(parts[3])
          || parts[4]?.toLowerCase() !== source.commitSha || parts.length !== 5) {
          throw new ApiError(502, 'GITHUB_UNAVAILABLE', 'GitHub returned an unexpected archive location');
        }
        response = await request(target, { headers: { 'User-Agent': 'DropVault' } });
      }
      if (!response.ok) throw githubError(response.status);
      if (!response.body) throw new ApiError(502, 'GITHUB_UNAVAILABLE', 'GitHub returned an empty archive');
      return { stream: Readable.fromWeb(response.body),
        contentLength: Number(response.headers.get('content-length')) || null };
    },
  };
}
