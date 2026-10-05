# Two-account project handoff rehearsal

The browser test in `apps/web/test/git-workspace.browser.js` simulates a code-and-data handoff through the running web app and API. It uses two isolated browser sessions and an isolated storage directory.

## What the test does

1. Create a small real Git repository with two commits and two distinct ZIP archives.
2. Sign in as the workspace owner. Import the first public GitHub commit through the UI, refresh to the second commit, upload a CSV, review the selected versions, and save a snapshot.
3. Invite a separate account as a workspace viewer.
4. Sign in as that recipient in another browser session. Open the shared snapshot, download its TAR into a clean directory, verify the checksums, and restore its code ZIP and CSV offline.
5. Confirm the restored bytes match the selected Git archive and CSV. Confirm the viewer cannot refresh the owner's GitHub import, then copy the snapshot into the recipient's own workspace.

The same browser test also checks a manual Git ZIP and a stale snapshot review after a file replacement.

Run the focused rehearsal with `node --test apps/web/test/git-workspace.browser.js`. It needs Google Chrome and starts its own API and Vite servers. The offline restore has focused checks in `node --test scripts/restore-snapshot.test.mjs`.

## What this simulation proves

It exercises real browser clicks, cookies, API authorization, local catalog and bytes, TAR export, checksums, and offline extraction. The GitHub API is replaced by a deterministic test client; the ZIPs themselves come from a real local Git repository. No external GitHub account or network access is exercised.

## Limits the rehearsal exposes

- The restored code is a ZIP of committed files, not a Git clone with history. The restore command keeps it at `code/code.zip`.
- Other files restore under `assets/` using their recorded folder paths. DropVault does not know where a game engine or research pipeline expects each asset inside the source tree.
- The test files are small. It does not prove resumable uploads, multi-gigabyte transfers, live S3/PostgreSQL behavior, or production throughput.
- The test prepares the accounts through the API, then uses the UI to sign in and perform the handoff. A human usability session would reveal confusion and timing problems that assertions cannot measure.

For a real pilot, have one person make a snapshot from their own project and a second person restore it on a separate computer without coaching. Record every missing file, unclear instruction, and permission failure before expanding the integration.
