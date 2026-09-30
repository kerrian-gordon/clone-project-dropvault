# Local development

This guide expands the [project README](../README.md). Run commands from the repository root with Node.js 24. The default API is `http://127.0.0.1:3000`; the Vite web app normally runs at `http://127.0.0.1:5173` and proxies `/v1` to the API.

## Install and start

```sh
npm install
npm --prefix apps/web install
npm run dev:api
```

Start the web app in a second terminal:

```sh
npm run dev:web
```

`dev:api` watches API source files and restarts after edits. `npm run start:api` runs without watching. Keep the API terminal open while using the web app. If it exits while no files change, read the error in that terminal; file watching does not repair a crash. On Windows PowerShell, use `npm.cmd` when the shell blocks the `npm` script. For a Mac checkout, see the [first-time guide](mac-frontend-setup.md).

The browser app uses history routes such as `/files`, `/workspaces`, and `/snapshots/:id`. A production web server must serve `index.html` for direct visits and refreshes on these routes while forwarding `/v1/*` to the API.

## Seed a local demo

Before starting the API on a **fresh, empty** local storage directory, run:

```sh
npm run seed:demo
```

The command imports two fake accounts and real sample file bytes. It prints one generated password for `alex@example.test` and `blair@example.test`; save it for local testing. Passwords are hashed in the catalog and are absent from the JSON fixture. Alex owns three files and grants Blair access to `Project-brief.pdf`. The PDF, MP4, PPTX, and TXT samples can be downloaded; the PDF, video, and text can be previewed. Alex's seeded usage begins at 100 MiB.

The seed refuses to run when `storage/catalog.json` or stored files already exist. To preserve existing data, set `DROPVAULT_STORAGE_DIR` to a **new empty directory** for both seeding and starting the API. The seed is disabled with `NODE_ENV=production`. Do not use the demo accounts for real data.

To reproduce the blocked-upload and local Demo tier flow, start the API with `DROPVAULT_STORAGE_LIMIT_BYTES=104857600` and `DROPVAULT_ENABLE_DEMO_PLAN_SWITCH=1`. The unpaid tier switch is unavailable with S3 storage or `NODE_ENV=production`; public upgrades need a real entitlement or billing flow.

## Storage and configuration

Local mode stores metadata in `storage/catalog.json`, original bytes in `storage/originals/`, and temporary bytes in `storage/tmp/`. The contents of `storage/` are ignored by Git. `DROPVAULT_STORAGE_DIR` changes the local storage root; `PORT` changes the API port. The free account limit defaults to 1 GiB and can be set with `DROPVAULT_STORAGE_LIMIT_BYTES`; uploads default to at most 100 MiB per file.

Local startup leaves bytes that are absent from the catalog in place, including pending deletions. This protects files if an older catalog backup is restored. Inspect unmatched bytes before removing them manually; they still occupy disk space. See [storage and recovery behavior](api.md#file-model-and-limits).

Optional S3 and PostgreSQL mode requires `DROPVAULT_STORAGE_BACKEND=s3`, `DROPVAULT_DATABASE_URL`, `DROPVAULT_S3_BUCKET`, and `DROPVAULT_AWS_REGION`; `DROPVAULT_S3_PREFIX` defaults to `dropvault/`. Use the AWS credential provider chain and a private bucket. The catalog is loaded into one API process, protected by a PostgreSQL advisory lock; a second process against the same database will not start. Back up the database and bucket together. The mode has not yet been verified against live cloud resources from this repository.

For an isolated cloud-storage rehearsal, `npm run smoke:production-storage` requires a **fresh, dedicated** PostgreSQL database with `smoke` or `test` in its name, a private test bucket, `DROPVAULT_SMOKE_DATABASE_URL`, `DROPVAULT_SMOKE_S3_BUCKET`, `DROPVAULT_SMOKE_AWS_REGION`, `DROPVAULT_SMOKE_S3_PREFIX`, and `DROPVAULT_SMOKE_CONFIRM=isolated-test-resources`. It checks upload, download, replacement, snapshot export, and restart readback. It leaves test data in those dedicated resources for inspection. Review the [script](../scripts/smoke-production-storage.mjs) before running it.

`DROPVAULT_PUBLIC_BASE_URL` sets an HTTP(S) origin for absolute bearer links usable from another device. `DROPVAULT_HOST` changes the API bind host from its default loopback address. Use a trusted reverse proxy and HTTPS for a public service. Keep secrets out of Git; [`.env.example`](../.env.example) shows non-secret local options.

## Checks

```sh
npm test
npm run build:web
npm --prefix apps/web run test:browser
```

The browser checks need Google Chrome. They start their own API and Vite servers using temporary storage. The API request and response shapes, errors, and upload examples are in [the contract](api.md). The offline ML experiment has separate instructions in its [pilot report](ml/pilot-report.md) and is not required to run the web app.
