# Dropvault

Starting point for a Dropbox-style document app. The shared contract and local API are implemented. The React web app has account entry, owned and shared file listings, a multi-file picker and drop area with per-file progress and errors, a storage meter, owner-only deletion, named-account access management, a demo-plan upgrade and retry prompt for storage-limit errors, and a viewer with previews for common browser-supported formats. Bearer-link sharing UI remains to be built.

```text
apps/
  web/
    public/                    Static files served by the browser app
    src/
      app/                     App setup, pages, and navigation
      features/
        file-browser/          Folder listing, search, and file actions
        upload/                File picker, drag-and-drop area, and progress UI
        viewer/                Preview UI for supported file types
      shared/
        components/            Reusable UI pieces
        lib/                   Browser-side helpers and API client
  api/
    src/
      routes/                  HTTP endpoints
      modules/
        files/                 File and folder metadata
        uploads/               Upload validation and transfer handling
        previews/              Preview generation and file type handling
      services/
        storage/               Storage provider integration
      db/                      Local metadata catalog
packages/
  shared/                      Types and contracts shared by web and API
storage/                       Local development files; contents are ignored
  originals/                   Uploaded file bytes
  previews/                    Generated thumbnails and previews
  tmp/                         Incomplete uploads and processing work
docs/                          Product and architecture notes
```

The upload feature is where both file selection and drag and drop will live. The API's upload module will validate incoming files, while the storage service will save their bytes. File metadata belongs in `files`; generated representations belong in `previews`. The viewer can choose a suitable display for images, PDFs, text, audio, video, and other supported formats, with download available for files that cannot be previewed.

The directories contain `.gitkeep` files so the structure is visible in Git. The API uses Node.js 24 built-in modules, local disk for file bytes, and a JSON metadata catalog. It now has local account sessions, owner checks, per-account quotas, named-user access, and a defined upload-type list with a 100 MiB per-file limit. Production storage remains future work.

## Run the API

From the repository root, run `npm run dev:api` while developing. Node watches the API source files and restarts the process when they change. Keep this terminal open while using the web app. Use `npm run start:api` to run without file watching. The API listens at `http://127.0.0.1:3000` and stores files in `storage/`. Set `PORT` or `DROPVAULT_STORAGE_DIR` to override those defaults. After installing the web dependencies, run `npm test` to check the API and Vite proxy. If the API exits while no source files are changing, read the error in its terminal; file watching does not fix a crash.

Set `DROPVAULT_STORAGE_LIMIT_BYTES` to change the storage cap (default 1 GiB). For example, in PowerShell run `$env:DROPVAULT_STORAGE_LIMIT_BYTES='104857600'` before starting the API to set a 100 MiB cap.

### Seed a local demo

From a fresh checkout, before starting the API, run `npm run seed:demo`. This imports the two-account fixture into the local `storage/catalog.json` and creates actual sample file bytes in `storage/originals/`. It prints a generated password for both `alex@example.test` and `blair@example.test`; save that password for local testing. Passwords are hashed in the catalog, and the fixture JSON does not contain a password or session.

Set `DROPVAULT_STORAGE_LIMIT_BYTES=104857600` when starting the API to reproduce Alex's full 100 MiB free tier and the blocked-upload upgrade flow. For PowerShell:

```powershell
npm.cmd run seed:demo
$env:DROPVAULT_STORAGE_LIMIT_BYTES='104857600'
npm.cmd run dev:api
```

Run the web app in a second PowerShell terminal with `npm.cmd run dev:web`. Sign in as either demo account using the printed password. Alex owns three files and has granted Blair access to `Project-brief.pdf`. The seeded PDF, MP4, PPTX, and TXT contain sample content and can be downloaded; the PDF, video, and text can be previewed in the browser. The sample files are exactly the sizes listed in the JSON fixture, so Alex's usage begins at 100 MiB.

The seed command refuses to run if `catalog.json` or stored files already exist. To keep existing data, set `DROPVAULT_STORAGE_DIR` to a **new empty directory** for both the seed command and the API. The seed is disabled when `NODE_ENV=production`; never use these public demo accounts for real user data.

The request and response shapes, file model, limits, and example upload command are in [docs/api.md](docs/api.md). The web app uses the route helpers and documented file shapes in `packages/shared/index.js` and proxies `/v1` requests to the API during development.

## Run the web app

From the repository root, run `npm --prefix apps/web install` once. Start the API with `npm run dev:api`, then in another terminal run `npm run dev:web`. Open the URL Vite prints (normally `http://127.0.0.1:5173`). Vite proxies `/v1` to the local API so session cookies and API requests use the web origin. Run `npm run build:web` to check the production bundle.

React Router uses browser history. `/` redirects to `/files`; `/files` lists the root, `/folders/:id` lists a folder, `/shared` lists files granted to the account, and `/view/:id` shows file details, download, ownership, and owner-only access controls. `/login` and `/register` are public; the file routes require a session and return to the requested URL after sign-in. Unknown URLs show a not-found page. The upload queue lives above the file routes so transfers continue while navigating within a signed-in session. The browser sends one raw request per queued file. On a storage-cap error, the user can switch to the local demo tier and retry the same selected file after the new allowance is confirmed. Selected files remain in memory only until the tab reloads or the user logs out. A production web server must serve `index.html` for direct visits and refreshes on SPA routes, while forwarding `/v1/*` to the API.

The original tracks 1 and 2 have a local implementation, extended with the MVP account and quota backend. The browser feature flows and full integration remain to be built.

## Suggested work split

Agree on the shared contract first, then the three feature tracks can move in parallel. Each track has a clear folder to own and a result to demonstrate.

| Track | Main folders | Work to do | Done when |
| --- | --- | --- | --- |
| 1. Shared contract | `packages/shared/`, `docs/` | Choose the stack and local storage approach. Define file and folder metadata, supported upload types and size limits, and the API requests and responses for upload, list, view, and download. | Web and API work can use the same file model and endpoints. |
| 2. API and storage | `apps/api/src/routes/`, `modules/files/`, `modules/uploads/`, `services/storage/`, `db/` | Accept one or more files, validate them, store originals, save metadata, list files and folders, and serve downloads. Delete a file or a folder (reject non-empty folders). Compute total bytes used across all stored files and expose it via `GET /v1/storage/usage`. Block uploads that would exceed the configurable byte cap (`DROPVAULT_STORAGE_LIMIT_BYTES`). Issue and store shareable-link tokens; serve the file to anyone who presents a valid token via `GET /v1/shares/:token`. | A file can be uploaded, found again, downloaded, and deleted. The API refuses an upload that would exceed the storage cap and returns a clear error. A shareable link can be created and redeemed. |
| 3. Browser and upload UI | `apps/web/src/app/`, `features/file-browser/`, `features/upload/`, `shared/` | Build folder navigation and file lists; add a file picker and drag-and-drop area for multiple files, plus progress and error states. Add a delete button with a confirmation step on each file row and folder. Show a storage meter (used-vs-limit bar) in the sidebar or header, fetched from `/v1/storage/usage`. When `usedBytes >= limitBytes`, disable the upload area, show a clear inline message, and surface an "Upgrade" call-to-action that opens an upgrade prompt (UI only — no payment processor this milestone). Add a share button that copies the shareable URL to the clipboard and shows it in a modal. | A user can drop several files, see their upload status, and find them in the browser. Files and empty folders can be deleted. The storage meter is always visible. Uploading at cap shows a clear error and an upgrade prompt. A file can be shared via a copied link. |
| 4. Viewing and previews | `apps/web/src/features/viewer/`, `apps/api/src/modules/previews/`, `storage/previews/` | Detect file type and display supported formats. Start with images, PDFs, and text; offer download for other files. Add thumbnails or more preview types later. **Note:** Word (`.docx`) and PowerPoint (`.pptx`) are the PRD's core document types; they cannot be rendered inline by the browser and will fall back to download-only unless a conversion step (e.g. LibreOffice headless → PDF or thumbnail) is added. Confirm with the team whether that conversion is in scope for this milestone or a follow-on. | Supported files open in the app; other uploaded files remain accessible by download. |
| 5. Integration and checks | Across the project | Connect the UI to the API and check the full upload, browse, view, and download flow with several file types and multiple files at once. Verify that deleting a file removes it from the browser and the freed bytes are immediately reflected in the storage meter. Verify that a shareable link resolves correctly from a fresh browser session without navigating through the file browser. Verify that the cap block and upgrade prompt appear when the limit is reached and clear after files are deleted. | The complete flow works from a fresh local setup. |

Tracks 2, 3, and 4 can be assigned to different people once track 1 is agreed. Track 5 follows their integration. This keeps the first milestone focused on reliable storage and access across many file types, while preview support can expand over time.

## Next milestone

The [multi-user freemium MVP plan](docs/multi-user-freemium-mvp.md) records the account, permissions, per-user quota, sharing, upload, and front-end flows proposed for the next milestone. It distinguishes the current local API from work that is still planned. A separate [two-account mock fixture](apps/web/src/shared/data/mock-multi-user-drive.json) supports the blocked-upload, upgrade, and named-user sharing prototypes; see its [usage notes](apps/web/src/shared/data/README.md).

Machine-learning file classification is outside this MVP. The `feat/improved-file-uploading-and-storage-with-machine-learning` branch contains no ML work and currently matches `feat/shared-contract-api`; see the [MVP scope note](docs/multi-user-freemium-mvp.md#follow-on-work).
