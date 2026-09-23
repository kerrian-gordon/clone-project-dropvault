# Mock drive data

`mock-drive.json` is starting data for a front-end prototype. It contains six folders and 25 file records using the field names in `docs/api.md`. The root folder is represented by the ID `root`; it is not an entry in `folders`.

To show a folder, select folders whose `parentId` matches its ID and files whose `folderId` matches its ID. `New Folder` is intentionally empty. The storage meter starts at about 76% of a 150 MiB demo limit, and `usedBytes` equals the sum of all file sizes.

These records describe files but contain no file bytes, previews, or usable share links. The UI can simulate upload, delete, and sharing changes locally, then replace the fixture with API responses during integration. Feature-specific values such as ML suggestions can be added separately.

## How to use it

- Treat `folders` and `files` as the initial state of the browser. The IDs are stable references for navigation and file actions; `root` is the top-level folder ID.
- Filter by `parentId` and `folderId` to render one folder at a time. The folder named `Shared` is only a sample folder name; it does not grant anyone access.
- Use `storageUsage` for the initial meter. When simulating an upload or deletion, change both the file list and `usedBytes` so the meter remains consistent. Check the per-file and account limits before marking an upload successful.
- Keep preview and download controls in a demo state unless real file bytes or an API response are available. A metadata record alone cannot produce a document preview or download.

## Scope of this fixture

This is a single-user browser fixture for the current local file model. It has no account IDs, ownership, access grants, plan tier, or upgrade state. The [multi-user freemium MVP plan](../../../../../docs/multi-user-freemium-mvp.md) calls for those fields in a revised shared contract. Extend the fixture to match that contract before using it to demonstrate two-account sharing or per-user quota behavior.
