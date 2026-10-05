# Hosted freemium demo

This is an invite-only demonstration of the free plan and an **unpaid Demo tier**. It does not collect payment, grant a paid entitlement, or use real customer data. The Demo tier is a simulation with 10 times the free storage limit. The normal API startup still refuses to expose that switch on a public host.

## What it includes

- One container serves the built website and `/v1` API at the same origin.
- A site-wide HTTP Basic access password gates the website, API, and share links. Send it only to invited reviewers, over HTTPS.
- A fresh persistent volume is seeded once with fake Alex and Blair accounts, sample files, themes, and a 100 MiB free quota scenario. Existing catalogs are never reseeded.
- Invited reviewers can register their own account, try the free plan, and switch to Demo in the UI. Registration and all uploads use the same persistent volume. The fake accounts are `alex@example.test` and `blair@example.test` and share one separately configured account password.
- The website, API, and file bytes survive application restarts as long as the same volume is mounted.

## Required configuration

| Variable | Value |
| --- | --- |
| `DROPVAULT_DEMO_ACCESS_PASSWORD` | A random secret of at least 32 characters for the site gate. |
| `DROPVAULT_DEMO_PASSWORD` | A separate password of at least 12 characters for the seeded accounts. |
| `DROPVAULT_PUBLIC_BASE_URL` | The final `https://` origin, such as `https://demo.example.com`. This sets absolute share links and Secure session cookies. |
| `DROPVAULT_STORAGE_DIR` | Absolute path of the mounted persistent volume. The image defaults to `/data`. The directory must exist. |
| `PORT` | HTTP listener port; defaults to `3000`. |

The container listens on `0.0.0.0` for the hosting provider's HTTPS reverse proxy. Only one instance should use the volume and JSON catalog. Give the volume at least 1 GiB of space for the sample files and reviewer uploads. The process fails before listening if required secrets, the built website, or the volume are missing. A catalog already on the volume is opened as-is; keep the original seeded-account password or reset the volume deliberately.

## Run with Docker

Build from the repository root:

```text
docker build -t dropvault-demo .
```

Configure the required environment variables as **secrets** in your hosting provider, mount a persistent volume at `/data`, and run the image on port `3000`. Terminate HTTPS at the provider and forward the original `Host` header. Use the provider's health check path `/v1/health`. The health check does not require the invitation password; other pages and endpoints do.

For a local dry run, `DROPVAULT_PUBLIC_BASE_URL` may use a loopback HTTP origin matching the published port. The container expects an existing `/data` mount. Open the site, enter the site access credentials (`demo` and the access password) in the browser prompt, then sign in as Alex with the seeded-account password. The browser prompt is part of this invite-only demo, separate from DropVault's account login.

## Five-minute reviewer path

1. Sign in as Alex and inspect the sample folders, file previews, shared file, themes, and workspace.
2. Try a small upload. Alex's sample files already occupy the 100 MiB free allowance, so the UI shows the quota and Demo upgrade path.
3. Switch to Demo and repeat the upload. The demo allowance is 1,000 MiB. Reopen the site to see that the tier and files persist.
4. Save a workspace snapshot and download its TAR archive, or import a public GitHub repository commit as a code ZIP and save it alongside the files.
5. Sign in as Blair to inspect the file shared by Alex. Return to **Default** in the theme controls after trying a community theme.

## Operating limits

This is a single-instance, invitation-gated prototype. The site access password is shared by all invitees; rotate it after a demo. The API still permits invited people to register and upload, so limit the audience and available disk space. Basic Auth must be used only over HTTPS outside loopback. The local JSON catalog and disk storage are not a tested multi-instance or public production backend. Billing, private GitHub integration, and automated Git sync remain outside this demo.

Back up the mounted volume before important demonstrations. To return to the original fake data, stop the server and replace the volume with a fresh empty one; startup will seed it again. This discards reviewer changes, so do it only intentionally.
