# Dropvault local API contract

This contract is for tracks 1 and 2. The API uses Node.js 24 built-in modules and listens on `127.0.0.1:3000` by default. Requests and responses use JSON, except file uploads and downloads. There is no authentication yet, so the server is limited to the local machine.

## File model

- `Folder`: `{ id, name, parentId, createdAt }`. The built-in root folder has ID `root` and is not stored as a record.
- `FileRecord`: `{ id, name, folderId, mimeType, size, createdAt }`. `size` is bytes. IDs are generated UUIDs. The internal `storageKey` is never returned by the API.
- Names must be 1–255 characters and cannot contain `/`, `\`, control characters, or be `.` or `..`.
- All file types can be uploaded. The limit is **100 MiB per file**. The browser should send one file per request; it can send multiple requests for a multi-file drop. The MIME type is supplied by the client and is not a security guarantee.
- Uploaded bytes live in `storage/originals/`; temporary upload bytes live in `storage/tmp/`; metadata is persisted in `storage/catalog.json`. This catalog is suitable for local development, not a multi-server deployment.

## Endpoints

| Method and path | Request | Success response |
| --- | --- | --- |
| `GET /v1/health` | None | `200 { "status": "ok" }` |
| `POST /v1/folders` | JSON `{ "name": "Projects", "parentId": "root" }`; `parentId` defaults to `root` | `201 Folder` |
| `GET /v1/folders/:id/children` | Use `root` for top-level items | `200 { "folderId", "folders": Folder[], "files": FileRecord[] }` |
| `DELETE /v1/folders/:id` | None | `204` No Content; fails with `FOLDER_NOT_EMPTY` if the folder has children |
| `POST /v1/files?name=:name&folderId=:id` | Raw file bytes as the request body; `Content-Type` is the file MIME type; `folderId` defaults to `root`. Upload is rejected before bytes are streamed if it would exceed the storage cap. | `201 FileRecord` |
| `GET /v1/files/:id` | None | `200 FileRecord` |
| `DELETE /v1/files/:id` | None | `204` No Content; removes bytes from disk and the catalog entry |
| `GET /v1/files/:id/content` | None | `200` file bytes. Known safe preview MIME types use `inline`; others download as an attachment. |
| `GET /v1/files/:id/content?download=1` | None | `200` file bytes as an attachment. |
| `POST /v1/files/:id/shares` | None | `201 { "token": "...", "url": "..." }` — creates an opaque token stored in the catalog; no auth required to redeem it |
| `GET /v1/shares/:token` | None | `200` file bytes inline, same disposition rules as `/content`; `404` if the token is unknown |
| `GET /v1/storage/usage` | None | `200 { "usedBytes": number, "limitBytes": number }` — `usedBytes` is the sum of all stored `FileRecord.size` values; `limitBytes` comes from `DROPVAULT_STORAGE_LIMIT_BYTES` (default 1 GiB) |

The upload name belongs in the URL query, encoded with `encodeURIComponent(file.name)` in the web app. A drag-and-drop batch makes one request for each file. Each response gives that file's result, so the UI can show individual progress and errors.

For example, from PowerShell with `curl.exe`:

```powershell
curl.exe -X POST "http://127.0.0.1:3000/v1/files?name=report.pdf" -H "Content-Type: application/pdf" --data-binary "@report.pdf"
curl.exe "http://127.0.0.1:3000/v1/folders/root/children"
```

Errors use `{ "error": { "code": "...", "message": "..." } }` with an appropriate HTTP status. Common codes include `INVALID_NAME` (400), `INVALID_JSON` (400), `FILE_TOO_LARGE` (413), `FOLDER_NOT_FOUND` (404), `FILE_NOT_FOUND` (404), `NAME_CONFLICT` (409), `FOLDER_NOT_EMPTY` (409), and `STORAGE_CAP_EXCEEDED` (507). `STORAGE_CAP_EXCEEDED` is returned by `POST /v1/files` when `usedBytes + Content-Length > limitBytes`; the check happens before any bytes are written to disk.

The content endpoint only renders a small set of declared image, PDF, plain text, audio, and video MIME types inline. It returns `X-Content-Type-Options: nosniff`. The future viewer should still handle unsupported formats by offering download.
