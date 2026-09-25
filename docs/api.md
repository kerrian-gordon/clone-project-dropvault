# Dropvault local API contract

The API uses Node.js 24 built-in modules, local file storage, and a JSON metadata catalog. It listens on `127.0.0.1:3000` by default. This is a local prototype; the demo plan switch does not charge money, and the catalog is not designed for multiple server processes.

## Accounts and permissions

- `POST /v1/auth/register` accepts JSON `{ "email": "person@example.com", "password": "at least 12 characters" }`, creates a free account, and returns `201 User` with a session cookie. Registration does not grant ownership of files already in a pre-account catalog.
- To migrate those files, set a private `DROPVAULT_LEGACY_CLAIM_TOKEN` of at least 32 random characters before starting the API. A signed-in account can then call `POST /v1/account/claim-legacy` with JSON `{ "token": "..." }`. The token is checked before all ownerless local files and folders are assigned to that account. Keep this token out of the web app and share it only with the intended owner. Leave the setting unset to disable claiming.
- `POST /v1/auth/login` accepts the same JSON and returns `200 User` with a new session cookie. `POST /v1/auth/logout` revokes the current session and returns `204`. `GET /v1/account` returns the signed-in `User`.
- Session cookies are `HttpOnly` and `SameSite=Strict`. They use `Secure` when the API itself receives HTTPS. Browser writes must come from the API origin; use a same-origin `/v1` proxy for local web development. Production deployment needs HTTPS and an explicit trusted-proxy/cookie configuration.
- Registration is limited to 10 attempts per source IP and login to 5 failed attempts per source IP and email (also 30 total login attempts per source IP) within 15 minutes. These counters live in one API process and reset on restart; production hosting needs shared, proxy-aware throttling.
- All routes except health, registration, login, and bearer-link redemption require a valid session. File and folder listings show only owned items. A named recipient may read and download a granted file, but only its owner may delete it, grant access, or create a bearer link. Private and forbidden IDs return `404`.
- `User`: `{ id, email, tier, createdAt }`, where `tier` is `free` or `demo`. Password hashes and session tokens never appear in `User` responses.

## File model and limits

- `Folder`: `{ id, name, parentId, ownerId, createdAt }`. The built-in root folder has ID `root` and is scoped to the signed-in account; it is not stored as a record.
- `FileRecord`: `{ id, name, folderId, ownerId, mimeType, size, createdAt }`. `size` is bytes. The internal `storageKey` is never returned by the API.
- Names must be 1–255 characters and cannot contain `/`, `\`, control characters, or be `.` or `..`.
- Uploads use one raw-byte request per file. A browser sends several requests for a multi-file drop. The maximum is **100 MiB per file** by default.
- Supported extensions are `.pdf`, `.docx`, `.pptx`, `.xlsx`, `.txt`, `.csv`, `.json`, `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.mp3`, `.mp4`, `.zip`, and `.gz`. The extension and declared MIME type must agree. PDF, Office/ZIP, PNG, JPEG, GIF, WebP, and GZIP uploads receive a leading-byte signature check. Office uploads also require a readable ZIP central directory with `[Content_Types].xml`, `_rels/.rels`, and the expected Word, PowerPoint, or Excel main part. This structural check does not prove that embedded content is safe or that the document can be opened; deeper parsing/scanning is future work.
- The free account limit defaults to **1 GiB**, configurable through `DROPVAULT_STORAGE_LIMIT_BYTES`. The demo tier has ten times that limit. Only files owned by an account count toward its usage; sharing does not transfer storage cost. Uploads are serialized within one API process to prevent concurrent requests from jointly exceeding the limit. Downgrading while over the free limit keeps files accessible and blocks further uploads.
- The API admits at most 32 simultaneous write requests in one process. Additional writes return `503 SERVER_BUSY` and may be retried later.
- Uploaded bytes live in `storage/originals/`; temporary upload bytes live in `storage/tmp/`; metadata, hashed bearer-link tokens, account password hashes, and hashed session tokens are in `storage/catalog.json`. Keep this storage directory private and backed up if using real documents.
- File deletion stages the bytes in `storage/tmp/` while metadata is removed. The API waits for active downloads, and startup recovery restores a staged file whose catalog record still exists or removes staged bytes after a committed deletion. When a catalog exists, startup also removes UUID-named originals that have no catalog record, including uploads interrupted between byte storage and catalog commit. If the catalog is missing, originals are left in place for manual recovery. Older temporary files made before this recovery format are also left untouched for manual inspection.

## Endpoints

| Method and path | Request | Success response |
| --- | --- | --- |
| `GET /v1/health` | None | `200 { "status": "ok" }` |
| `POST /v1/folders` | JSON `{ "name": "Projects", "parentId": "root" }`; `parentId` defaults to `root` | `201 Folder` |
| `GET /v1/folders/:id/children` | Use `root` for top-level owned items | `200 { "folderId", "folders": Folder[], "files": FileRecord[] }` |
| `DELETE /v1/folders/:id` | Owner only; folder must be empty | `204` |
| `POST /v1/files?name=:name&folderId=:id` | Raw file bytes; `Content-Type` should match extension; `folderId` defaults to `root` | `201 FileRecord` |
| `GET /v1/files/shared` | None | `200 { "files": FileRecord[] }` granted to the signed-in account |
| `GET /v1/files/:id` | Owner or recipient | `200 FileRecord` |
| `DELETE /v1/files/:id` | Owner only | `204`; removes bytes, grants, and bearer links |
| `GET /v1/files/:id/content` | Owner or recipient; add `?download=1` for attachment | `200` file bytes |
| `GET /v1/storage/usage` | None | `200 { "usedBytes", "limitBytes", "tier" }` for the signed-in account |
| `POST /v1/account/claim-legacy` | Signed-in account; JSON `{ "token": "..." }`; requires server setting | `200 { "filesClaimed", "foldersClaimed" }` |
| `POST /v1/account/plan` | JSON `{ "tier": "free" }` or `{ "tier": "demo" }` | `200 User`; local demo switch without payment |
| `GET /v1/files/:id/access` | Owner only | `200 { "users": [{ "userId", "email", "createdAt" }] }` |
| `POST /v1/files/:id/access` | Owner only; JSON `{ "email": "recipient@example.com" }` | `201 { "userId", "email" }` |
| `DELETE /v1/files/:id/access/:userId` | Owner only | `204` |
| `POST /v1/files/:id/shares` | Owner only | `201 { "id", "token", "expiresAt", "url" }` |
| `GET /v1/files/:id/shares` | Owner only | `200 { "links": [{ "id", "createdAt", "expiresAt" }] }`; tokens are never listed again |
| `DELETE /v1/files/:id/shares/:shareId` | Owner only | `204` |
| `GET /v1/shares/:token` | Anyone holding an unexpired token | `200` file bytes; add `?download=1` for attachment |

Bearer links expire seven days after creation and can be revoked by their owner. The returned `url` is a relative `/v1/shares/...` path by default. Set `DROPVAULT_PUBLIC_BASE_URL` to an HTTP(S) origin (for example `https://files.example.com`) to return absolute links usable from another device. The API still binds to `127.0.0.1` by default; use a trusted reverse proxy or set `DROPVAULT_HOST` for an appropriate local network binding. Anyone holding a valid link can download its file, so use named-account access when the recipient must be identified. Content is rendered inline only for a small set of browser-safe MIME types; other types download as attachments. Responses include `X-Content-Type-Options: nosniff`.

## Errors and local use

Errors use `{ "error": { "code": "...", "message": "..." } }`. Common codes include `UNAUTHENTICATED` (401), `INVALID_CREDENTIALS` (401 or 400), `INVALID_ORIGIN` (403), `INVALID_CLAIM_TOKEN` (403), `FILE_NOT_FOUND` (404), `FOLDER_NOT_FOUND` (404), `ACCOUNT_NOT_FOUND` (404), `SHARE_NOT_FOUND` (404), `NAME_CONFLICT` (409), `FOLDER_NOT_EMPTY` (409), `ACCOUNT_EXISTS` (409), `LEGACY_CLAIM_DISABLED` (409), `NO_LEGACY_FILES` (409), `FILE_TOO_LARGE` (413), `UNSUPPORTED_FILE_TYPE` (415), `INVALID_FILE_CONTENT` (415), `RATE_LIMITED` (429), `SERVER_BUSY` (503), and `STORAGE_CAP_EXCEEDED` (507). The storage-cap code lets the web app keep the selected file in its current-session queue and offer the demo upgrade flow.

From PowerShell, start with `node apps/api/src/start.js`. `curl.exe` can register and save a session cookie, then upload using that cookie:

```powershell
curl.exe -c cookies.txt -X POST "http://127.0.0.1:3000/v1/auth/register" -H "Content-Type: application/json" --data '{"email":"person@example.com","password":"correct horse battery staple"}'
curl.exe -b cookies.txt -X POST "http://127.0.0.1:3000/v1/files?name=report.pdf" -H "Content-Type: application/pdf" --data-binary "@report.pdf"
```

Treat `cookies.txt` as a secret and remove it when finished. On PowerShell, quoting for `curl.exe` JSON varies by shell/version; a REST client can send the same requests if needed.
