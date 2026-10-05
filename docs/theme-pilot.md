# Theme gallery pilot

The theme gallery is a local prototype. Use a small invited group before deciding whether to build an approval queue, ratings, screenshots, or a larger storefront.

## Current flow

- A signed-in creator publishes a validated theme directly to the gallery. It is limited to approved color, font, and spacing settings.
- People can preview, install, customize, switch among themes they installed, and return to default at any time. **My themes** also lists a creator's published designs.
- A creator can unlist a theme. New users cannot find or install it; previous installers can keep or reapply their copy.
- A signed-in user can report a listed theme as broken, misleading, or unsafe. A second report from the same account updates that account's reason rather than adding a duplicate.
- An operator can remove a theme for safety. This blocks future installs and clears every appearance derived from it. Affected accounts see the default appearance after the next appearance refresh. An already open tab may show its cached appearance until it refreshes.

## Operator review

Set a private `DROPVAULT_MODERATOR_TOKEN` of at least 32 characters on the API process. When it is unset, the operator routes are unavailable. Send the token in the `X-DropVault-Moderator-Token` header to:

| Method | Path | Result |
| --- | --- | --- |
| `GET` | `/v1/moderation/theme-reports` | Reports with theme context |
| `POST` | `/v1/moderation/themes/:id/remove` | Safety removal and installed-copy reset |

Keep the token out of URLs, Git, and public logs. Use HTTPS if the API is exposed beyond the local computer. These routes are an operator tool for the small pilot; they are not a staffed public moderation console.

## Decide from observed use

Ask a few invited people to preview a theme, install it, customize it, switch to another, and return to default. Observe where they hesitate and ask whether they would use the gallery again. Record how many actually install and return, which themes they choose, and any reports or confusion about unlisting. The app does not yet collect those product metrics automatically. Build an approval queue only if submissions and reports warrant ongoing review work.
