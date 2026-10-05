# Public GitHub folder-tree fixtures

`scripts/import-public-folder-tree.mjs` fetches only GitHub's public Git data endpoints. Pin every run to an owner, repository, and full commit SHA; the importer first fetches that commit, checks GitHub returned the same commit SHA, then fetches its referenced tree SHA recursively and checks the returned tree SHA. It rejects branch and tag names. It does not use credentials, fetch blobs, or write to GitHub. Standard output is the fixture, so redirect it to a local file when you want to retain it.

Example using a fixed public commit from `octocat/Hello-World`:

```sh
node scripts/import-public-folder-tree.mjs octocat Hello-World 7fd1a60b01f91b314f59955a4e4d4e80d8edf11d
```

This read-only call was checked on October 1, 2026; it resolved the commit to tree `b4eecafa9be2f2006ce1b709d6857b07069b4608` and returned one file. That repository is a small endpoint smoke example, not a useful accuracy dataset. For broader stress cases, run the same command against selected public repositories and pin each to a reviewed commit. Respect GitHub's unauthenticated API rate limits. The script caps the tree at 5,000 entries, folder depth at 6, scenarios at 250, and serialized output at 2 MB; limits can be lowered or raised within hard ceilings with `--max-entries=`, `--max-depth=`, and `--max-scenarios=`. It fails closed when GitHub reports a truncated tree or the entry limit is exceeded.

The output's scenarios pair an observed filename with its observed parent directory and a small set of sibling folders. Every row has `labelSource: "unlabeled_public_tree"` and `targetFolderId: null`. Existing placement only says where a repository author put a file; it does not establish where DropVault should put it. Do not pass these rows to the supervised evaluator as reviewed labels. They can exercise parsing, candidate generation, and scale behavior, or be manually reviewed and copied into a separate labeled dataset with a recorded review process.

Run the isolated importer tests with:

```sh
node --test scripts/import-public-folder-tree.test.mjs
```

The tests mock GitHub's responses, so they verify both requests, commit-to-tree pinning, path normalization, pin validation, and truncation/size handling without requiring network access.
