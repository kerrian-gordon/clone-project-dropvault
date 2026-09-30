# Dropvault local API contract

The API uses Node.js 24. Local development stores file bytes on disk and metadata in a JSON catalog. Production mode targets AWS S3 for bytes and PostgreSQL for catalog metadata. It listens on `127.0.0.1:3000` by default. The unpaid demo plan switch is disabled by default and can be enabled only for local storage on a loopback host outside `NODE_ENV=production`. The catalog remains an in-memory document with a PostgreSQL advisory lock, so only one API process may run against a database at a time.

## Accounts and permissions

- `POST /v1/auth/register` accepts JSON `{ "email": "person@example.com", "password": "at least 12 characters", "displayName": "Alex" }`. `displayName` is optional, 1–50 characters, and public. The API stores a unique value (suffixing `-2` on collision) and returns `201 User` with a session cookie. Registration does not grant ownership of files already in a pre-account catalog.
- To migrate those files, set a private `DROPVAULT_LEGACY_CLAIM_TOKEN` of at least 32 random characters before starting the API. A signed-in account can then call `POST /v1/account/claim-legacy` with JSON `{ "token": "..." }`. The token is checked before all ownerless local files and folders are assigned to that account. Keep this token out of the web app and share it only with the intended owner. Leave the setting unset to disable claiming.
- `POST /v1/auth/login` accepts the same JSON and returns `200 User` with a new session cookie. `POST /v1/auth/logout` revokes the current session and returns `204`. `GET /v1/account` returns the signed-in `User`.
- Session cookies are `HttpOnly` and `SameSite=Strict`. They use `Secure` when the API itself receives HTTPS. Browser writes must come from the API origin; use a same-origin `/v1` proxy for local web development. `checkRequestOrigin` runs on every write. Browsers send `Origin` for those requests; if `Origin` is omitted (CLI tools), the check is skipped and `SameSite=Strict` still blocks cross-site cookie sends. A link opened from another site therefore arrives logged out, which is expected for this local demo. Production deployment needs HTTPS and an explicit trusted-proxy/cookie configuration.
- Registration is limited to 10 attempts per source IP and login to 5 failed attempts per source IP and email (also 30 total login attempts per source IP) within 15 minutes. These counters live in one API process and reset on restart; production hosting needs shared, proxy-aware throttling.
- All routes except health, capabilities, registration, login, and bearer-link redemption require a valid session. File and folder listings show only owned items. A named recipient may read and download a granted file, but only its owner may delete it, grant access, or create a bearer link. Private and forbidden IDs return `404`.
- `User`: `{ id, email, displayName, tier, createdAt }`, where `tier` is `free` or `demo`. `displayName` is a public gallery label chosen at registration. If omitted, the API uses the email local part and appends `-2`, `-3`, and so on when that label is taken. Password hashes and session tokens never appear in `User` responses.

## Themes and saved appearance

- Signed-in accounts can publish themes to a public gallery. A published theme is an immutable snapshot `{ id, creatorId, creatorName, name, settings, createdAt }`. The server gets `creatorId` from the session, not from the request. `creatorName` is copied from the account `displayName` at publish time, so later account changes or a missing account do not rewrite the gallery. A `creatorName` field in the POST body is ignored. Themes already stored, including the seeded "Alex" and "Blair" entries, keep their existing labels. Older themes without a label appear as "Community member". Each account may publish up to 20 themes. Theme publishes are also limited to 10 per account per 15 minutes (`429 RATE_LIMITED`); that counter lives in process memory and resets when the API restarts. All cookie-session writes, including theme and appearance routes, check the request `Origin` against the `Host` header.
- `ThemeSettings` is `{ "colors": { "background": "#f7f5f2", "surface": "#ffffff", "text": "#1e1919", "accent": "#0061ff" }, "font": "Inter", "spacing": "comfortable" }`. All four colors must be six-digit hex values. `font` is `Inter`, `Arial`, or `Georgia`; `spacing` is `compact` or `comfortable`. Extra fields, CSS, HTML, and scripts are rejected.
- Saving or publishing a theme requires a contrast ratio of at least 4.5:1 for text and accent against both the background and card surface. Previously saved themes remain readable through the API even if they do not pass the new check; users must adjust them before saving again or publishing.
- Installing a theme copies its settings into the signed-in account's appearance. Personal changes update that copy, leaving the published original and other accounts unchanged. `GET /v1/account/appearance` returns the saved selection after a new session or API restart. Accounts without a selection receive the default appearance.
- `Appearance` is `{ sourceThemeId, name, settings, selectedAt, updatedAt }`. `sourceThemeId` identifies the published theme used as the starting point; it is `null` for the default. The web app should fetch this response after sign-in and apply only the documented settings to its own CSS variables. Theme bytes are not part of file uploads or storage quotas.

## File model and limits

- `Folder`: `{ id, name, parentId, ownerId, createdAt }`. The built-in root folder has ID `root` and is scoped to the signed-in account; it is not stored as a record.
- `FileRecord`: `{ id, name, folderId, ownerId, mimeType, size, createdAt, currentVersionId }`. `size` is the current version's bytes. The internal `storageKey` is never returned by the API.
- `FileVersion`: `{ id, fileId, name, mimeType, size, createdAt, kind, label, restoredFrom? }`. `kind` includes `uploaded`, `replaced`, `restored`, and `imported`. Existing catalogs gain an initial version for each file without changing its bytes.
- `Workspace`: `{ id, ownerId, name, description, fileIds, git?, createdAt }`. `git` is either a manually linked `{ archiveFileId, archiveVersionId, commitSha, verification: "zip-comment", commitVerified: false }` or a GitHub import with `verification: "github-api"`, `commitVerified: true`, `repositoryFullName`, `ref`, and `importedAt`. The latter means the server resolved the commit with GitHub's API and fetched an archive by that commit ID; it is not a cryptographic signature of the ZIP. Members have either a viewer or contributor role. Files belong to the workspace owner and use that account's quota. Removing a file from a workspace does not remove it from a saved snapshot.
- `Snapshot`: `{ id, workspaceId, ownerId, createdById, createdByName, name, note, items, git, createdAt }`. The server records the creator from the signed-in account, with a display name fixed at creation. Each immutable item stores `fileId`, `versionId`, `name`, `folderId`, `folderPath`, `mimeType`, and `size` at creation. `git` copies the optional code archive link; the item whose `fileId` equals `git.archiveFileId` is the exact archived code version. All other items are project files, including datasets. Snapshots pin existing versions and add no new bytes. A pinned file cannot be deleted until all snapshots containing it are deleted. Deleting a snapshot removes its access grants, not the underlying file versions or their quota cost.
- Names must be 1–255 characters and cannot contain `/`, `\`, control characters, or be `.` or `..`.
- Uploads use one raw-byte request per file. A browser sends several requests for a multi-file drop. The maximum is **100 MiB per file** by default.
- Supported extensions are `.pdf`, `.docx`, `.pptx`, `.xlsx`, `.txt`, `.csv`, `.json`, `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.mp3`, `.mp4`, `.zip`, and `.gz`. The extension and declared MIME type must agree. PDF, Office/ZIP, PNG, JPEG, GIF, WebP, and GZIP uploads receive a leading-byte signature check. Office uploads also require a readable ZIP central directory with `[Content_Types].xml`, `_rels/.rels`, and the expected Word, PowerPoint, or Excel main part. This structural check does not prove that embedded content is safe or that the document can be opened; deeper parsing/scanning is future work.
- The free account limit defaults to **1 GiB**, configurable through `DROPVAULT_STORAGE_LIMIT_BYTES`. The demo tier has ten times that limit. Every retained version owned by an account counts toward usage, including versions restored as new copies; sharing does not transfer storage cost. Uploads are serialized within one API process to prevent concurrent requests from jointly exceeding the limit. Downgrading while over the free limit keeps files accessible and blocks further uploads or restores.
- The API admits at most 32 simultaneous write requests in one process. Additional writes return `503 SERVER_BUSY` and may be retried later.
- Uploaded bytes live in `storage/originals/`; temporary upload bytes live in `storage/tmp/`; metadata, hashed bearer-link tokens, account password hashes, and hashed session tokens are in `storage/catalog.json`. Keep this storage directory private and backed up if using real documents.
- File deletion stages all version bytes in `storage/tmp/` while metadata is removed. The API waits for active downloads. On startup, recovery restores a staged file when the catalog still references its storage key and the original is missing. If both copies exist, it retains the staged copy under a `review-*.pending` name so later deletes can proceed. It leaves other staged files and originals in place, including bytes from an interrupted upload or committed deletion. A restored catalog may be older than its local storage directory, so catalog absence alone is never grounds for startup deletion. Review unmatched bytes manually against the intended catalog backup before removing them; they continue to occupy disk space until then.

In S3 mode, uploads first spool to the operating system's temporary directory for size and type validation, then upload to the configured bucket prefix. File deletion commits catalog metadata before deleting S3 objects. Startup does not delete S3 objects missing from the loaded catalog: they may belong to a newer catalog than a restored PostgreSQL backup. An interrupted upload can therefore leave an unreferenced object; review and clean these objects manually only after comparing the intended catalog and bucket backups. Give the service account `GetObject`, `PutObject`, and `DeleteObject` permissions limited to that prefix; routine API startup no longer needs `ListBucket`. Use a private bucket, server-side encryption, bucket versioning/backups, TLS, and a persistent PostgreSQL database. No AWS keys or database password belong in Git. This backend has no real cloud integration test in this repository and is not yet validated under production load.

Set `DROPVAULT_STORAGE_BACKEND=s3`, `DROPVAULT_DATABASE_URL`, `DROPVAULT_S3_BUCKET`, and `DROPVAULT_AWS_REGION` to enable S3 plus PostgreSQL together. `DROPVAULT_S3_PREFIX` defaults to `dropvault/`; AWS credentials use the SDK's standard provider chain. Local mode is the default and requires none of these variables. PostgreSQL accepts one API instance at a time in this implementation; starting a second instance fails instead of risking a lost catalog update. Back up the database and bucket together.

## Endpoints

| Method and path | Request | Success response |
| --- | --- | --- |
| `GET /v1/health` | None | `200 { "status": "ok" }` |
| `GET /v1/capabilities` | None | `200 { "demoPlanSwitchEnabled": boolean }`; lets the web app hide local-only upgrade controls |
| `GET /v1/themes?offset=0&limit=20&q=` | Signed-in gallery; `offset` is non-negative and `limit` is 1–50; optional `q` (max 80 chars) matches theme name or creator name | `200 { "themes": Theme[], "total", "nextOffset" }` |
| `GET /v1/themes/:id` | Signed-in account | `200 Theme` |
| `POST /v1/themes` | JSON `{ "name": "Night study", "settings": ThemeSettings }`. A `creatorName` in the body is ignored. | `201 Theme`; `creatorName` is the account `displayName` snapshotted at publish. 20 themes per account (`409 THEME_LIMIT_REACHED`); 10 publishes per account per 15 minutes (`429 RATE_LIMITED`). |
| `DELETE /v1/themes/:id` | Creator only | `204`; removes gallery listing. Personal copies remain saved. Other signed-in accounts receive `404 THEME_NOT_FOUND`, same as a missing id. |
| `GET /v1/account/appearance` | None | `200 Appearance` for the signed-in account |
| `PUT /v1/account/appearance` | JSON `{ "themeId": "published-theme-id" }` | `200 Appearance`; installs a personal copy |
| `PUT /v1/account/appearance/settings` | JSON `{ "settings": ThemeSettings }` | `200 Appearance`; replaces the account's saved settings |
| `DELETE /v1/account/appearance` | None | `200 Appearance`; resets to the default |
| `POST /v1/folders` | JSON `{ "name": "Projects", "parentId": "root" }`; `parentId` defaults to `root` | `201 Folder` |
| `GET /v1/folders` | Signed-in account | `200 { "folders": Folder[] }` for all owned folders, for choosing a move destination |
| `GET /v1/files/owned` | Signed-in account | `200 { "files": FileRecord[] }` across all owned folders |
| `POST /v1/organization/suggestions` | JSON `{ "name": "trip.jpg", "currentFolderId": "root" }` | `200 { "suggestion": null }` or `{ "suggestion": { "id", "folderId", "folderName", "rule", "reason" } }`; considers owned existing folders only |
| `POST /v1/organization/suggestions/:id/decision` | JSON `{ "accept": true }` or `{ "accept": false }` | `204`; records the signed-in account's choice once; suggestion expires after 24 hours |
| `GET /v1/organization/stats` | Signed-in account | `200 { "shown", "accepted", "keptCurrent" }` for that account |
| `GET /v1/folders/:id/children` | Use `root` for top-level owned items | `200 { "folderId", "folders": Folder[], "files": FileRecord[] }` |
| `PATCH /v1/folders/:id` | Owner only; JSON with `name`, `parentId`, or both | `200 Folder`; rejects root, a missing destination, sibling name conflict, and moves into itself or a descendant |
| `DELETE /v1/folders/:id` | Owner only; folder must be empty | `204` |
| `POST /v1/files?name=:name&folderId=:id` | Raw file bytes; `Content-Type` should match extension; `folderId` defaults to `root` | `201 FileRecord` |
| `GET /v1/files/shared` | None | `200 { "files": FileRecord[] }` granted to the signed-in account |
| `GET /v1/files/:id` | Owner or recipient | `200 FileRecord` |
| `PATCH /v1/files/:id` | Owner only; JSON with `name`, `folderId`, or both | `200 FileRecord`; the original file extension must be kept |
| `DELETE /v1/files/:id` | Owner only; blocked while any snapshot includes the file | `204`; removes bytes, grants, and bearer links |
| `GET /v1/files/:id/content` | Owner or recipient; add `?download=1` for attachment | `200` file bytes |
| `GET /v1/files/:id/versions` | Owner only | `200 { "currentVersionId", "versions": FileVersion[] }`, newest first |
| `POST /v1/files/:id/versions` | Owner only; raw replacement bytes matching the current file extension and MIME type | `201 FileRecord`; keeps the old version and stable file ID, folder, and grants |
| `GET /v1/files/:id/versions/:versionId/content` | Owner only; add `?download=1` for attachment | `200` bytes of that immutable version |
| `PATCH /v1/files/:id/versions/:versionId` | Owner only; JSON `{ "label": "Approved draft" }`; empty label clears it | `200 FileVersion`; label has at most 80 characters |
| `POST /v1/files/:id/versions/:versionId/restore` | Owner only; no body | `201 FileRecord`; copies the selected bytes into a new current version, preserving the version being replaced |
| `GET /v1/storage/usage` | None | `200 { "usedBytes", "limitBytes", "tier" }` for the signed-in account |
| `POST /v1/account/claim-legacy` | Signed-in account; JSON `{ "token": "..." }`; requires server setting | `200 { "filesClaimed", "foldersClaimed" }` |
| `POST /v1/account/plan` | JSON `{ "tier": "free" }` or `{ "tier": "demo" }` | `200 User` only when `DROPVAULT_ENABLE_DEMO_PLAN_SWITCH=1` in local mode; otherwise `403 DEMO_PLAN_DISABLED` |
| `GET /v1/files/:id/access` | Owner only | `200 { "users": [{ "userId", "email", "createdAt" }] }` |
| `POST /v1/files/:id/access` | Owner only; JSON `{ "email": "recipient@example.com" }` | `201 { "userId", "email" }` |
| `DELETE /v1/files/:id/access/:userId` | Owner only | `204` |
| `POST /v1/files/:id/shares` | Owner only | `201 { "id", "token", "expiresAt", "url" }` |
| `GET /v1/files/:id/shares` | Owner only | `200 { "links": [{ "id", "createdAt", "expiresAt" }] }`; tokens are never listed again |
| `DELETE /v1/files/:id/shares/:shareId` | Owner only | `204` |
| `GET /v1/shares/:token` | Anyone holding an unexpired token | `200` file bytes; add `?download=1` for attachment |

## Workspaces and snapshots

Workspaces collect the owner's files. The owner may invite viewers, who browse and download, or contributors, who can also upload new files and replace current versions. Contributions belong to the owner, count against the owner's quota, and record the contributor as the version actor. Only the owner can add existing files, manage membership, create snapshots, or delete the workspace. A snapshot records exact file versions and folder paths in one catalog mutation; later changes do not alter it. Creating a snapshot copies no bytes, while restoring it as a new workspace copies every pinned version into the requesting account and requires enough quota. The copy creates a uniquely named root folder and recreates the saved folder paths beneath it. TAR exports include a manifest with exact names and folder paths; archive entry names are sanitized for extraction.

| Method and path | Request | Success response |
| --- | --- | --- |
| `GET /v1/workspaces` | Signed-in account | `200 { "workspaces": Workspace[] }` including owned and invited workspaces with `role` |
| `POST /v1/workspaces` | JSON `{ "name", "description" }`; description up to 1000 characters | `201 Workspace` |
| `GET /v1/workspaces/:id` | Owner or member | `200 Workspace` with `role` |
| `DELETE /v1/workspaces/:id` | Owner; no snapshots may remain | `204` |
| `GET /v1/workspaces/:id/files` | Owner or member | `200 { "files": FileRecord[] }` |
| `GET /v1/workspaces/:id/files/:fileId/content` | Owner or member | Current bytes; `?download=1` forces attachment |
| `POST /v1/workspaces/:id/uploads?name=...` | Owner or contributor; raw bytes and matching Content-Type | `201 FileRecord`; owner quota applies |
| `POST /v1/workspaces/:id/files/:fileId/versions` | Owner or contributor; raw bytes matching file type | `201 FileVersion`; owner quota applies |
| `POST /v1/workspaces/:id/files` | Owner; JSON `{ "fileId" }` of an owned file | `200 Workspace` |
| `DELETE /v1/workspaces/:id/files/:fileId` | Owner | `204`; removes membership only |
| `GET /v1/workspaces/:id/access` | Owner | `200 { "users": [{ "workspaceId", "userId", "email", "role", "createdAt" }] }` |
| `POST /v1/workspaces/:id/access` | Owner; JSON `{ "email", "role": "viewer" \| "contributor" }` | `201` grant; updates an existing role |
| `DELETE /v1/workspaces/:id/access/:userId` | Owner | `204`; member loses live workspace and workspace-based snapshot access |
| `PUT /v1/workspaces/:id/git` | Owner; JSON `{ "fileId" }` of an uploaded Git ZIP archive | `200 GitArchiveLink` |
| `POST /v1/workspaces/:id/github/import` | Owner; JSON `{ "repository": "owner/repo" }` or a public `https://github.com/owner/repo` URL; requires no existing linked code archive | `201 { "file": FileRecord, "git": GitArchiveLink, "unchanged": false }` |
| `POST /v1/workspaces/:id/github/refresh` | Owner; no body; requires a GitHub import | `200 { "git": GitArchiveLink, "unchanged": true }` when the default branch commit is unchanged, or `200 { "file": FileRecord, "git": GitArchiveLink, "unchanged": false }` after a new version |
| `GET /v1/workspaces/:id/snapshots` | Owner or member | `200 { "snapshots": Snapshot[] }` |
| `POST /v1/workspaces/:id/snapshots` | Owner; JSON `{ "name", "note", "fileIds" }` of 1–200 distinct workspace files. Optional `expectedVersions: [{ "fileId", "versionId" }]` must list the same files and rejects a version changed since review. | `201 Snapshot`; `409 SNAPSHOT_FILES_CHANGED` for a stale review |
| `GET /v1/snapshots/shared` | Signed-in recipient | `200 { "snapshots": Snapshot[] }` currently accessible to them |
| `GET /v1/snapshots/:id` | Owner, workspace member, or separately invited recipient with every file grant | `200 Snapshot` |
| `GET /v1/snapshots/:id/files/:fileId/content` | Same; add `?download=1` for attachment | `200` bytes of the pinned version with its saved name |
| `GET /v1/snapshots/:id/archive` | Same | TAR download with manifest and all pinned bytes |
| `POST /v1/snapshots/:id/copy` | Same; sufficient requesting-account quota | `201 Workspace` with independent files copied into the requester's account |
| `DELETE /v1/snapshots/:id` | Owner | `204`; removes snapshot and its recipient grants |
| `GET /v1/snapshots/:id/access` | Owner | `200 { "users": [{ "userId", "email", "createdAt" }] }` |
| `POST /v1/snapshots/:id/access` | Owner; JSON `{ "email" }`; recipient must already have grants on every item | `201 { "userId", "email" }` |
| `DELETE /v1/snapshots/:id/access/:userId` | Owner | `204` |

Separate snapshot invitations check current per-file grants on every read. Removing a file grant revokes that recipient's separate snapshot access. Workspace members have snapshot access through their live membership, which ends when the membership is revoked. Bearer links serve only current file content. The API rejects file deletion with `FILE_IN_SNAPSHOT` (409) and workspace deletion with `WORKSPACE_HAS_SNAPSHOTS` (409).

To link code manually, create a ZIP with `git archive --format=zip --output=code.zip HEAD`, upload it to the workspace, and call the Git link endpoint. Git writes the commit ID into the ZIP comment; DropVault reads that user-supplied label but does not verify it. Alternatively, import a public GitHub repository; the server resolves its default branch to a commit, fetches the ZIP for that commit, and stores it as a workspace file. Refresh checks the default branch on demand and creates another retained version only if the commit changed. Every imported version counts toward the owner's quota and the 100 MiB upload limit applies. A snapshot must include the linked ZIP at the linked version; the web app selects it automatically. Old snapshots keep their old ZIP after refresh. The web app sends the versions shown on its review screen as `expectedVersions`; the API refuses to save a different version if a contributor replaces a file before confirmation. The API response and TAR manifest include the creator ID and saved display name, the code archive file and version IDs, its commit metadata, and the exact version ID for every project file. This is a code-and-data archive link, not repository hosting, a Git remote, or an executable build record. See the [manual walkthrough](git-workspace-walkthrough.md) and [GitHub import guide](github-import.md).

Bearer links expire seven days after creation and can be revoked by their owner. The returned `url` is a relative `/v1/shares/...` path by default. Set `DROPVAULT_PUBLIC_BASE_URL` to an HTTP(S) origin (for example `https://files.example.com`) to return absolute links usable from another device. The API still binds to `127.0.0.1` by default; use a trusted reverse proxy or set `DROPVAULT_HOST` for an appropriate local network binding. Anyone holding a valid link can download its file, so use named-account access when the recipient must be identified. Content is rendered inline only for a small set of browser-safe MIME types; other types download as attachments. Responses include `X-Content-Type-Options: nosniff`.

Folder suggestions use file names, extensions, and existing folder names only. A unique best match is offered before upload; the file stays in its current folder unless the user chooses the suggested destination. When there is no clear match, upload continues in the current folder. The choice counters do not store file names or contents. The rules are deterministic and do not use the experimental ML classifier.

Versions have no time-based expiry in this local prototype. The owner can name, preview, compare text versions, download, and restore them. Shared recipients and bearer links see only the current version. Deleting the file permanently removes its complete version history. Replacing or restoring requires enough quota for an additional full copy; it never deletes an older version to make room.

## Errors and local use

Account registration also returns `INVALID_DISPLAY_NAME` (400) for an invalid public display name.

Errors use `{ "error": { "code": "...", "message": "..." } }`. Common codes include `UNAUTHENTICATED` (401), `INVALID_CREDENTIALS` (401 or 400), `INVALID_ORIGIN` (403), `INVALID_CLAIM_TOKEN` (403), `INVALID_THEME_ID` (400), `INVALID_THEME_NAME` (400), `INVALID_CREATOR_NAME` (400), `INVALID_THEME_SETTINGS` (400), `INVALID_THEME_CONTRAST` (400), `INVALID_PAGE` (400), `THEME_NOT_FOUND` (404), `THEME_LIMIT_REACHED` (409), `FILE_NOT_FOUND` (404), `VERSION_NOT_FOUND` (404), `VERSION_ALREADY_CURRENT` (409), `INVALID_VERSION_LABEL` (400), `WORKSPACE_NOT_FOUND` (404), `SNAPSHOT_NOT_FOUND` (404), `SNAPSHOT_FILES_CHANGED` (409), `GIT_ARCHIVE_CHANGED` (409), `GIT_COMMIT_MISSING` (422), `INVALID_GITHUB_REPOSITORY` (400), `GITHUB_REPOSITORY_NOT_FOUND` (404), `GITHUB_IMPORT_REQUIRED` (409), `GITHUB_IMPORT_CHANGED` (409), `GIT_ARCHIVE_ALREADY_LINKED` (409), `GITHUB_ARCHIVE_MANAGED` (409), `GITHUB_UNAVAILABLE` (502), `GITHUB_RATE_LIMITED` (503), `FILE_IN_SNAPSHOT` (409), `FOLDER_NOT_FOUND` (404), `ACCOUNT_NOT_FOUND` (404), `SHARE_NOT_FOUND` (404), `NAME_CONFLICT` (409), `FOLDER_NOT_EMPTY` (409), `ACCOUNT_EXISTS` (409), `LEGACY_CLAIM_DISABLED` (409), `NO_LEGACY_FILES` (409), `FILE_TOO_LARGE` (413), `UNSUPPORTED_FILE_TYPE` (415), `INVALID_FILE_CONTENT` (415), `RATE_LIMITED` (429), `SERVER_BUSY` (503), and `STORAGE_CAP_EXCEEDED` (507). The storage-cap code lets the web app keep the selected file in its current-session queue and offer the demo upgrade flow.

From PowerShell, start with `node apps/api/src/start.js`. `curl.exe` can register and save a session cookie, then upload using that cookie:

```powershell
curl.exe -c cookies.txt -X POST "http://127.0.0.1:3000/v1/auth/register" -H "Content-Type: application/json" --data '{"email":"person@example.com","password":"correct horse battery staple"}'
curl.exe -b cookies.txt -X POST "http://127.0.0.1:3000/v1/files?name=report.pdf" -H "Content-Type: application/pdf" --data-binary "@report.pdf"
```

Treat `cookies.txt` as a secret and remove it when finished. On PowerShell, quoting for `curl.exe` JSON varies by shell/version; a REST client can send the same requests if needed.
