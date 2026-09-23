# Dropvault

Starting point for a Dropbox-style document app. The shared contract and local API are implemented; the web app and preview generation are still folder scaffolds.

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

The directories contain `.gitkeep` files so the structure is visible in Git. The API uses Node.js 24 built-in modules, local disk for file bytes, and a JSON metadata catalog. Uploads accept any file type up to 100 MiB. This is a local development setup; authentication and production storage are future work.

## Run the API

From the repository root, run `node apps/api/src/start.js`. It listens at `http://127.0.0.1:3000` and stores files in `storage/`. Set `PORT` or `DROPVAULT_STORAGE_DIR` to override those defaults. Run `node --test apps/api/test/*.test.js` to check the API.

The request and response shapes, file model, limits, and example upload command are in [docs/api.md](docs/api.md). The web app can use the route helpers and documented file shapes in `packages/shared/index.js`. When the web app gets a development server, proxy `/v1` requests to the API.

Tracks 1 and 2 now have a local implementation. Tracks 3–5 remain to be built.

## Suggested work split

Agree on the shared contract first, then the three feature tracks can move in parallel. Each track has a clear folder to own and a result to demonstrate.

| Track | Main folders | Work to do | Done when |
| --- | --- | --- | --- |
| 1. Shared contract | `packages/shared/`, `docs/` | Choose the stack and local storage approach. Define file and folder metadata, supported upload types and size limits, and the API requests and responses for upload, list, view, and download. | Web and API work can use the same file model and endpoints. |
| 2. API and storage | `apps/api/src/routes/`, `modules/files/`, `modules/uploads/`, `services/storage/`, `db/` | Accept one or more files, validate them, store originals, save metadata, list files and folders, and serve downloads. | A file can be uploaded, found again, and downloaded. |
| 3. Browser and upload UI | `apps/web/src/app/`, `features/file-browser/`, `features/upload/`, `shared/` | Build folder navigation and file lists; add a file picker and drag-and-drop area for multiple files, plus progress and error states. | A user can drop several files, see their upload status, and find them in the browser. |
| 4. Viewing and previews | `apps/web/src/features/viewer/`, `apps/api/src/modules/previews/`, `storage/previews/` | Detect file type and display supported formats. Start with images, PDFs, and text; offer download for other files. Add thumbnails or more preview types later. | Supported files open in the app; other uploaded files remain accessible by download. |
| 5. Integration and checks | Across the project | Connect the UI to the API and check the full upload, browse, view, and download flow with several file types and multiple files at once. | The complete flow works from a fresh local setup. |

Tracks 2, 3, and 4 can be assigned to different people once track 1 is agreed. Track 5 follows their integration. This keeps the first milestone focused on reliable storage and access across many file types, while preview support can expand over time.
