# Try a code-and-data snapshot

This is the **manual** Git workflow. DropVault stores an archive of one committed code version with selected data file versions. For public repositories, it can also [import and manually refresh from GitHub](github-import.md). It does not act as a Git remote.

## 1. Prepare a code ZIP

In a small Git repository with at least one commit, run:

```sh
git status --short
git rev-parse HEAD
git archive --format=zip --output=code.zip HEAD
```

Check `git status --short` **before** creating the ZIP. Uncommitted and untracked work is not part of `HEAD`; commit what you intend to preserve. Keep the printed commit ID so you can compare it with the label shown in DropVault. The ZIP includes committed files such as `README.md`, but not Git history. The resulting `code.zip` is a new untracked file in your local repository unless you save it elsewhere.

## 2. Create and review a workspace

1. Start the [local app](local-development.md), sign in, and open **Workspaces**.
2. Create a workspace. Under **Contribute files**, choose `code.zip` and a small data file such as `results.csv`. Wait for both to show **success**.
3. Under **Link a Git code archive**, choose `code.zip` and select **Link archive**. Compare the displayed commit label with `git rev-parse HEAD`. This label comes from the ZIP comment; it is **not verified against GitHub**.
4. Under **Save a snapshot**, the linked ZIP is selected automatically. Select the data file, enter a name and note, and choose **Review snapshot**. Check the file list and version IDs, then choose **Create fixed snapshot**.

If a selected file is replaced after you review it, DropVault refuses the stale save and refreshes the file list. Review the new versions before trying again. If the linked ZIP itself was replaced, link its new version first.

## 3. Download and copy the result

Open the saved snapshot and choose **Download all (.tar)**. The archive contains `manifest.json` plus the selected original bytes. On systems with `tar`, inspect the entry list and manifest with:

```sh
tar -tf snapshot.tar
tar -xOf snapshot.tar manifest.json
```

The manifest maps safe archive paths to original names, folder paths, file IDs, exact version IDs, and the supplied Git commit label. **Restore as new workspace** makes independent copies under your account; it requires enough free quota and does not change the original snapshot.

Each newly downloaded TAR also includes a SHA-256 checksum for every file in its manifest. Verify the download before using it:

```sh
npm run verify:snapshot -- snapshot.tar
```

The command checks TAR structure, file sizes, and each checksum without extracting files. Older TAR downloads without checksums must be downloaded again from the snapshot. The checksums detect changed or incomplete downloads; they do not authenticate the person who supplied a manually linked Git commit label.

## Current limits

- The manually uploaded code ZIP is a point-in-time export. It is not refreshed from GitHub. DropVault does not import a GitHub README separately or store the repository's Git history.
- The supplied commit label can be forged or belong to another repository. Treat it as a reference until a future verified import exists.
- DropVault does not detect Git LFS pointer files or missing submodule contents in the ZIP. Inspect the archive before using it as a complete handoff.
- The upload limit is 100 MiB per file in the running app. A larger code ZIP needs a future larger-file import path.
- A snapshot preserves exact bytes and metadata; it does not run the code or prove the analysis is reproducible.

The [browser integration test](../apps/web/test/git-workspace.browser.js) creates a throwaway Git repository, uploads a real `git archive` ZIP and CSV, checks the downloaded TAR's bytes and manifest, and verifies the copied workspace. It also replaces the CSV between review and save to check that the stale review is rejected.
