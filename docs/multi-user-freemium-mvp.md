# Multi-user freemium MVP

This document defines the multi-user freemium milestone for Dropvault. The local API includes sessions, ownership, per-user quotas, named-user access, and a demo tier switch. The browser includes account entry, owned and shared listings, per-file uploads, deletion, access controls, a storage meter, a demo upgrade prompt that retries a blocked file, and previews for common browser-supported formats. Bearer-link sharing UI and a full browser integration check remain to be built. See [the implemented API contract](api.md) for exact routes and current limits.

## Product goal

Two people can use separate accounts to store and exchange documents. Each person can drop multiple files into the browser, find their files again, see their storage allowance, and recover from an upload blocked by that allowance. A recipient can open a file shared with their account. Files remain downloadable even when the browser cannot preview them.

## MVP decisions

| Decision | MVP behavior | Why it matters |
| --- | --- | --- |
| Accounts | Use authenticated user sessions. Every file and folder has an owner. | A browser must not be trusted to declare ownership. |
| Access | Owners can manage their files; named recipients can view and download files shared with them. Recipients cannot delete or reshare them in the MVP. | The front end can show only actions the current user may perform. The API must enforce the same rules. |
| Link sharing | Bearer links are a separate feature from sharing with an account. Keep the distinction visible in the UI and contract. | Opening a link in another browser does not prove that user-to-user permissions work. |
| Quota | Used bytes and limit belong to an account and its tier. The server checks the remaining allowance before accepting an upload and handles concurrent uploads safely. | A client-side meter cannot enforce a storage cap. |
| Plans | Provide at least a free tier and a larger demo tier. The prototype changes an account's tier without payment processing. | The full blocked-upload and upgrade journey can be tested before billing is built. |
| Upload formats | Explicitly support PDF, Word (`.docx`), PowerPoint (`.pptx`), and Excel (`.xlsx`) for upload and download. State the per-file limit separately from the account quota. | Supported for storage does not mean previewable in the browser. |
| Preview | Show inline previews for browser-friendly types such as images, PDF, and plain text. Offer a clear download state for Word, PowerPoint, Excel, and other files without a preview. | Document conversion and richer previews can follow after the core journeys work. |
| Downgrade | Preserve existing files and access when usage exceeds the new limit; block new uploads until usage falls below the limit or the account upgrades. | A plan change must not silently delete user data. |

## Shared contract and API work

Update `packages/shared/` and `docs/api.md` before connecting the browser to new routes. Define user identity, file and folder ownership, file access grants, tier, `usedBytes`, and `limitBytes`. Keep internal storage keys and session secrets out of public responses. Define permission-aware list, view, download, delete, and share responses, plus consistent errors for unauthenticated requests, forbidden access, unsupported uploads, oversize files, and storage limits. The storage-limit error must be distinct so the UI can offer an upgrade action.

Extend the API so every file and folder operation derives the acting user from the authenticated session and checks that user's access. Recalculate quota on upload and delete; do not accept a client-supplied `usedBytes` or owner ID as authority. Add a way to grant, list, and revoke access for a named account. A shared file remains charged to its owner's quota. Bearer-link endpoints need a separate policy for creation, redemption, and revocation before they are presented alongside named-user sharing.

The local JSON catalog is useful for development. The implemented API now includes `DROPVAULT_STORAGE_LIMIT_BYTES`, per-account usage and plan tiers, and bearer-link endpoints. See [the API contract](api.md) for current behavior; mark any future request or response examples as proposed until implemented.

## Front-end work

The web app uses React Router in declarative mode. `/files` is the root browser, `/folders/:id` is a folder, `/shared` lists named-user grants, and `/view/:id` is a linkable viewer. `/login` and `/register` are public, and signed-in routes redirect through login while preserving the requested URL. The upload area stays in the browser; sharing and upgrade prompts are dialogs on the current route so opening them does not discard selected files. Keep the upload queue above individual route pages if it must survive navigation within the current tab. Direct visits to SPA paths require an `index.html` fallback in deployment, with `/v1/*` still routed to the API.

For prototyping the blocked-upload/upgrade and named-user sharing flows before full browser integration, use [`mock-multi-user-drive.json`](../apps/web/src/shared/data/mock-multi-user-drive.json) and its [usage notes](../apps/web/src/shared/data/README.md). The original `mock-drive.json` remains a single-user browsing fixture.

1. **Account entry and file browser.** Show the signed-in account, owned files, and files shared with that account. Display owner and access status where useful. Hide management actions the user does not have, while relying on API checks for security.
2. **Multiple-file upload.** Support both a picker and drag and drop. Queue each file separately, show progress and a result per file, and keep successful files visible when another file fails. The current API accepts one file per request, so a multi-file drop sends multiple requests.
3. **Storage meter and delete.** Show account usage against its limit, warn near the cap, confirm deletion, and refresh the meter and file list after successful deletion. The warning threshold should be a shared UI rule, not a different number on each screen.
4. **Blocked upload and upgrade.** Show the server's storage-limit message with an Upgrade action. Preserve the selected file in the current tab's upload queue while the user changes tier, then retry it after the new allowance is confirmed. Explain that selection cannot be guaranteed after a refresh or in a new browser session without a separate persistence design.
5. **Sharing and viewing.** Let an owner grant access to another account and see who has access. Let the recipient find and open the shared file. Show a preview when supported, with download available in every case. Treat bearer-link sharing as a distinct action if it is included in the UI.

## Acceptance checks

- Account A uploads several files in one drop, including `.pdf`, `.docx`, `.pptx`, and `.xlsx`; each file has its own progress and result. A can browse and download them after restarting the browser session.
- Account B cannot list, view, download, delete, or share A's private files by guessing IDs. After A grants B access to one file, B can find, view when previewable, and download that file, but cannot manage it.
- Uploading beyond A's allowance returns the distinct storage-limit error from the API. The browser leaves the blocked file in its current-session queue, offers an upgrade, and retries after the tier change without selecting the file again.
- Deleting an owned file reduces A's used bytes and updates the meter. Deleting or downgrading never silently removes other files; an over-limit downgraded account can still browse and download but cannot upload.
- Unsupported or oversized uploads produce readable per-file errors. A server failure does not make a failed file appear uploaded.
- Word, PowerPoint, and Excel remain accessible by download even when inline preview is unavailable.

## Work order and ownership

| Stage | Primary folders | Deliverable |
| --- | --- | --- |
| 1. Contract | `packages/shared/`, `docs/` | Agreed models, permissions, tier rules, endpoint shapes, and error codes. |
| 2. API | `apps/api/src/` | Sessions, ownership checks, per-account quota, delete, and named-user sharing. |
| 3. Browser | `apps/web/src/app/`, `features/file-browser/`, `features/upload/`, `features/viewer/` | The five visible journeys above, first against consistent fixture data and then the API. |
| 4. Integration | API and web | The two-account, storage-limit, upgrade, retry, delete, and download checks above pass from a fresh local setup. |

The contract should be settled before API and browser work branch apart. Once it is stable, API and browser tasks can proceed in parallel against the same fixtures and responses. Integration follows both.

## Follow-on work

Document conversion and richer previews, a storage breakdown by file, polished plan comparison, delivery of warning notifications, persistent upload recovery across reloads, payment processing, and production storage are outside this MVP. A simple plan choice and an in-app near-cap warning are included above because they are needed to make the core journey understandable.

Machine-learning file classification is also outside this MVP. Multiple-file upload does not require it: each upload is validated against the documented extension, MIME, size, and content checks, including uncommon types supported by the contract. The existing `feat/improved-file-uploading-and-storage-with-machine-learning` branch currently points to the same commit as `feat/shared-contract-api` and contains no ML implementation. Treat it as a stale historical branch, not an active dependency or an MVP deliverable. If classification is revisited, define its user benefit, training data, privacy behavior, confidence/fallback rules, and evaluation before starting new implementation work.
