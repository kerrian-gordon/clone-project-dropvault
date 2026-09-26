# First-time Mac setup for frontend work

This guide gets the web app and local API running with the two demo accounts. You do not need an API key. Each developer has their own local files and accounts.

## 1. Get the project

Install Git and Node.js **24 or newer**, then open Terminal. Check Node with `node --version`.

For a first checkout:

```bash
git clone https://github.com/kerrian-gordon/clone-project-dropvault.git
cd clone-project-dropvault
```

If you already have the repo, open its folder in Terminal and run `git switch main`, then `git pull --ff-only origin main`. Save any uncommitted work before switching branches or pulling.

Install the web dependencies from the repo root:

```bash
npm --prefix apps/web ci
```

## 2. Add demo accounts and files once

Before starting the API, run:

```bash
npm run seed:demo
```

The command prints one generated password for **alex@example.test** and **blair@example.test**. Save it locally; the password is not in GitHub. The seed creates their folders, sharing grant, and downloadable PDF, MP4, PPTX, and TXT files. It uses about 100 MiB of local storage.

If it says the catalog already exists, do not delete your existing files. You can keep using that catalog, or seed a new empty directory with:

```bash
DROPVAULT_STORAGE_DIR="$HOME/dropvault-demo-data" npm run seed:demo
```

If you use a different storage directory, set the same `DROPVAULT_STORAGE_DIR` when starting the API in the next step.

## 3. Start the API

In one Terminal window, from the repo root:

```bash
DROPVAULT_STORAGE_LIMIT_BYTES=104857600 npm run dev:api
```

If you seeded the separate directory, use:

```bash
DROPVAULT_STORAGE_DIR="$HOME/dropvault-demo-data" DROPVAULT_STORAGE_LIMIT_BYTES=104857600 npm run dev:api
```

Leave this Terminal window open. You should see `Dropvault API listening on 127.0.0.1:3000`. To check it, open another Terminal window and run `curl http://127.0.0.1:3000/v1/health`; it should return `{"status":"ok"}`. The API restarts when its source files change.

## 4. Start the web app

In a second Terminal window, from the same repo root:

```bash
npm run dev:web
```

Open `http://127.0.0.1:5173` in a browser. Sign in as Alex or Blair with the password from step 2. Alex owns three files and starts at the 100 MiB free limit; Blair can see the PDF shared by Alex. The web app calls the local API through Vite's `/v1` proxy. It does not read the mock JSON directly.

## 5. Edit the frontend

Open the repo folder in VS Code. The main frontend code is in `apps/web/src/`:

- `features/file-browser/` — owned and shared file lists
- `features/upload/` — file picker, drag and drop, progress, and upgrade prompt
- `features/viewer/` — previews, download, and access controls
- `app/` — routes, authentication context, and styles

Save a frontend file to see the browser update. After changes, run `npm test` and `npm run build:web` from the repo root. Press **Control-C** in each Terminal window when you are done.

## If something does not work

| What you see | Check |
| --- | --- |
| `npm` or `node` is not found, or Node is older than 24 | Install or select Node.js 24 or newer, then reopen Terminal. |
| `Catalog already exists` during seeding | The seed runs only on fresh storage. Use the existing account, or set a new `DROPVAULT_STORAGE_DIR` for both seed and API. |
| `EADDRINUSE` or port 3000 already in use | Stop the earlier API Terminal with Control-C, then start one API process. |
| The browser says it cannot reach the API | Confirm the API Terminal is still open and the health URL responds. |
| Login fails or demo files do not appear | Use the printed password and confirm the API uses the same storage directory that was seeded. |
| The API exits unexpectedly | Copy the last 10–20 lines from its Terminal; the error identifies what needs fixing. |

The seed is for local development only. The files live on your Mac under `storage/` by default and are not uploaded to GitHub.
