# Mock drive data

These are static metadata fixtures for front-end work. Neither file contains document bytes or usable sessions. Keep both fixtures separate from the live API catalog.

## Single-user browsing fixture

`mock-drive.json` is starting data for a front-end prototype. It contains six folders and 25 file records using the field names in `docs/api.md`. The root folder is represented by the ID `root`; it is not an entry in `folders`.

To show a folder, select folders whose `parentId` matches its ID and files whose `folderId` matches its ID. `New Folder` is intentionally empty. The storage meter starts at about 76% of a 150 MiB demo limit, and `usedBytes` equals the sum of all file sizes.

These records describe files but contain no file bytes, previews, or usable share links. The UI can simulate upload, delete, and sharing changes locally, then replace the fixture with API responses during integration. Feature-specific values such as ML suggestions can be added separately.

## How to use it

- Treat `folders` and `files` as the initial state of the browser. The IDs are stable references for navigation and file actions; `root` is the top-level folder ID.
- Filter by `parentId` and `folderId` to render one folder at a time. The folder named `Shared` is only a sample folder name; it does not grant anyone access.
- Use `storageUsage` for the initial meter. When simulating an upload or deletion, change both the file list and `usedBytes` so the meter remains consistent. Check the per-file and account limits before marking an upload successful.
- Keep preview and download controls in a demo state unless real file bytes or an API response are available. A metadata record alone cannot produce a document preview or download.

## Scope of this fixture

This fixture is for browsing only. It has no account IDs, ownership, access grants, plan tier, or upgrade state. Use the separate `mock-multi-user-drive.json` fixture for those flows.

## Two-account sharing and upgrade fixture

`mock-multi-user-drive.json` is a focused, standalone fixture for flows 4 and 5 in the [multi-user freemium MVP plan](../../../../../docs/multi-user-freemium-mvp.md). It has two accounts, each with an owned folder and files. Alex owns three files totaling exactly 100 MiB, which is the configured free cap for this prototype (`DROPVAULT_STORAGE_LIMIT_BYTES=104857600`). Blair owns a 4 KiB text file. Alex grants Blair access to `Project-brief.pdf`; Blair can find and download that file but cannot manage it or see Alex's other files. Shared files count only against the owner's quota.

The `users`, `folders`, and `files` entries use the public API field names. To simulate `GET /v1/folders/:id/children`, return only folders and files owned by the acting user at that parent/folder ID. To simulate `GET /v1/files/shared` for Blair, return Alex's brief because its ID appears in `accessGrants` for Blair. To simulate `GET /v1/files/:id/access` for Alex, return the matching grant as a `users` entry. A recipient can view and download the granted file but cannot delete it, grant further access, or create a link. The `Shared` folder in `mock-drive.json` has no relationship to these account grants.

`storageUsageByUser` mirrors each account's `GET /v1/storage/usage` response. The `prototypeScenarios.blockedUpload` object is UI-only staging data: Alex's selected 1 MiB `.xlsx` is not in the initial `files` array, so uploading at the cap returns the exact `STORAGE_CAP_EXCEEDED` error shape. The `afterUpgrade` snapshot mirrors the demo-tier account and 10x quota responses. The `afterRetry` snapshot adds the file and raises used bytes by 1 MiB without asking the user to select it again. Apply those snapshots in order; do not add `afterRetry.file` to the initial list. A real browser `File` object cannot be serialized in JSON, so keep the selected file in the current tab's upload queue when connecting this flow to the API.
