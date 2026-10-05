import { pathToFileURL } from 'node:url';

const DEFAULT_MAX_ENTRIES = 5000;
const DEFAULT_MAX_DEPTH = 6;
const DEFAULT_MAX_SCENARIOS = 250;
const MAX_OUTPUT_BYTES = 2_000_000;
const GITHUB_API = 'https://api.github.com';
const USER_AGENT = 'DropVault-public-folder-tree-importer/1.0';

function assertSource(owner, repo, sha) {
  if (!/^[A-Za-z0-9-]+$/u.test(owner) || !/^[A-Za-z0-9_.-]+$/u.test(repo)
    || repo === '.' || repo === '..'
    || !/^[a-f0-9]{40}$/iu.test(sha)) {
    throw new Error('Provide a GitHub owner, repository, and full 40-character commit SHA.');
  }
}

function validateLimit(value, name, maximum) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${name} must be an integer from 1 to ${maximum}.`);
  }
}

function cleanGitPath(path) {
  if (typeof path !== 'string' || !path || path.length > 1024 || path.startsWith('/')
    || path.includes('\\') || /[\u0000-\u001f\u007f]/u.test(path)
    || path.split('/').some((part) => !part || part === '.' || part === '..')) return null;
  return path;
}

/**
 * Turn a GitHub recursive tree into unlabeled folder-layout scenarios.
 * The containing folder is observed from the source tree; it is not a reviewed target.
 */
export function normalizeTree({ owner, repo, commitSha, treeSha, tree }, {
  maxEntries = DEFAULT_MAX_ENTRIES,
  maxDepth = DEFAULT_MAX_DEPTH,
  maxScenarios = DEFAULT_MAX_SCENARIOS,
} = {}) {
  assertSource(owner, repo, commitSha);
  validateLimit(maxEntries, 'maxEntries', 20_000);
  validateLimit(maxDepth, 'maxDepth', 32);
  validateLimit(maxScenarios, 'maxScenarios', 2_000);
  if (!tree || !Array.isArray(tree.tree)) throw new Error('GitHub response did not contain a tree array.');
  if (tree.truncated) throw new Error('GitHub marked the tree as truncated; refusing to create partial fixtures.');
  if (tree.tree.length > maxEntries) throw new Error(`Tree has ${tree.tree.length} entries, over maxEntries=${maxEntries}.`);

  const directories = new Set(['']);
  const files = [];
  for (const entry of tree.tree) {
    const path = cleanGitPath(entry?.path);
    if (!path) continue;
    const parts = path.split('/');
    if (parts.length > maxDepth) continue;
    if (entry.type === 'tree') directories.add(path);
    if (entry.type === 'blob') {
      files.push(path);
      for (let i = 1; i < parts.length; i += 1) directories.add(parts.slice(0, i).join('/'));
    }
  }
  const folderNames = [...directories].sort((a, b) => a.localeCompare(b));
  const scenarios = files.sort((a, b) => a.localeCompare(b)).slice(0, maxScenarios).map((sourcePath, index) => {
    const parts = sourcePath.split('/');
    const currentFolder = parts.length > 1 ? parts.slice(0, -1).join('/') : '';
    const currentParent = currentFolder.includes('/') ? currentFolder.slice(0, currentFolder.lastIndexOf('/')) : '';
    const peers = folderNames.filter((candidate) => candidate !== currentFolder
      && (candidate.includes('/') ? candidate.slice(0, candidate.lastIndexOf('/')) : '') === currentParent);
    return {
      scenarioId: `tree-file-${String(index + 1).padStart(4, '0')}`,
      name: parts.at(-1),
      currentFolder,
      candidateFolders: [currentFolder, ...peers.slice(0, 8)],
      sourcePath,
      labelSource: 'unlabeled_public_tree',
      targetFolderId: null,
    };
  });
  return {
    schemaVersion: 1,
    source: { provider: 'github', owner, repo, commitSha: commitSha.toLowerCase(), treeSha: treeSha.toLowerCase() },
    limitations: [
      'Folder paths describe existing repository layout only; they are not ground-truth destination labels.',
      'No file contents, names of maintainers, or repository metadata beyond paths are fetched.',
    ],
    bounds: { maxEntries, maxDepth, maxScenarios, entriesReceived: tree.tree.length },
    scenarios,
  };
}

export async function fetchGitTree({ owner, repo, sha }, { fetchImpl = fetch, maxEntries = DEFAULT_MAX_ENTRIES } = {}) {
  assertSource(owner, repo, sha);
  validateLimit(maxEntries, 'maxEntries', 20_000);
  const base = `${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git`;
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': USER_AGENT };
  const commitResponse = await fetchImpl(`${base}/commits/${sha}`, { headers });
  if (!commitResponse.ok) throw new Error(`GitHub commit request failed (${commitResponse.status}).`);
  const commit = await commitResponse.json();
  if (typeof commit.sha !== 'string' || commit.sha.toLowerCase() !== sha.toLowerCase()
    || typeof commit.tree?.sha !== 'string' || !/^[a-f0-9]{40}$/iu.test(commit.tree.sha)) {
    throw new Error('GitHub commit response did not verify the requested commit and its full tree SHA.');
  }
  const treeSha = commit.tree.sha;
  const treeResponse = await fetchImpl(`${base}/trees/${treeSha}?recursive=1`, { headers });
  if (!treeResponse.ok) throw new Error(`GitHub tree request failed (${treeResponse.status}).`);
  const body = await treeResponse.json();
  if (typeof body.sha !== 'string' || body.sha.toLowerCase() !== treeSha.toLowerCase()) {
    throw new Error('GitHub tree response SHA did not match the tree SHA pinned by the commit.');
  }
  if (body.truncated) throw new Error('GitHub marked the tree as truncated; choose a smaller pinned repository tree.');
  if (!Array.isArray(body.tree) || body.tree.length > maxEntries) {
    throw new Error(`GitHub tree is missing its entry array or exceeds maxEntries=${maxEntries}.`);
  }
  return { treeSha, tree: body };
}

export function serializeBoundedFixture(fixture) {
  const json = `${JSON.stringify(fixture, null, 2)}\n`;
  if (Buffer.byteLength(json, 'utf8') > MAX_OUTPUT_BYTES) throw new Error('Fixture exceeds the 2 MB output limit.');
  return json;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [owner, repo, sha, ...options] = process.argv.slice(2);
  try {
    const limits = Object.fromEntries(options.map((item) => {
      const match = /^--(max-entries|max-depth|max-scenarios)=(\d+)$/u.exec(item);
      if (!match) throw new Error(`Unknown option: ${item}`);
      return [match[1].replace(/-([a-z])/gu, (_, c) => c.toUpperCase()), Number(match[2])];
    }));
    const { treeSha, tree } = await fetchGitTree({ owner, repo, sha }, { maxEntries: limits.maxEntries });
    const fixture = normalizeTree({ owner, repo, commitSha: sha, treeSha, tree }, limits);
    process.stdout.write(serializeBoundedFixture(fixture));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
