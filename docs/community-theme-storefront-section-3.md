# Community theme storefront — PRD Section 3

Owner: Umer Bashir · dated 09/28/2026. Landed from the local draft so the demo branch can cite the same P0/P1/P2 list. This is the requirements excerpt, not a claim that the product matches it. The implemented contract is [docs/api.md](api.md).

Copy-ready original: `~/Downloads/dropvault-section-3-requirements.md`.

---

## 3. REQUIREMENTS

### User Journey 1: Dropbox user personalizing their workspace with a community theme
Context: This is the core MVP. A regular Dropbox user should go from “I want this to look more like me” to a live theme without installing unofficial software or editing Dropbox themselves. Optimize for speed, preview-before-commit, and an easy way back to default.

#### Sub-journey: Discovering themes
[P0] User can open DropVault from Dropbox without leaving their signed-in session.
[P0] User can browse a catalog of approved community themes (name, creator, thumbnail, rating).
[P0] User can search themes by name or creator.
[P1] User can filter themes by category (for example color, contrast, or style tags DropVault defines).
[P1] User can sort the catalog by popularity, newest, or rating.
[P2] User can save a theme to a personal wishlist without installing it.

#### Sub-journey: Previewing a theme
[P0] User can open a theme detail page with description, creator, screenshots, and what visual elements it changes.
[P0] User can preview the theme on a sample Dropbox workspace before it is applied to their real files view.
[P0] User can see which approved surfaces the theme is allowed to change (colors, background, icons, typography) and that it cannot access files or account data.
[P1] User can compare the preview with Dropbox’s current Light, Dark, or System appearance.
[P2] User can preview the theme on a mock file list that resembles their own folder layout (names stay fake; real file contents are not sent to the theme).

#### Sub-journey: Installing and using a theme
[P0] User can install an approved theme in one action from the preview or detail page.
[P0] User can see the theme take effect on their Dropbox workspace immediately after install.
[P0] User can have only one community theme active at a time.
[P0] User can switch back to Dropbox’s default appearance (Light, Dark, or System) in one action without reinstalling Dropbox.
[P1] User can switch between previously installed themes without browsing the full catalog again.
[P2] User can schedule a theme to apply only during a time window (for example evening).

#### Sub-journey: Managing and removing themes
[P0] User can see which theme is currently active.
[P0] User can uninstall a community theme and return to default appearance.
[P1] User can rate a theme they have installed.
[P1] User can report a theme that looks broken, misleading, or unsafe.
[P2] User can see a short history of themes they recently used.

---

### User Journey 2: Creator publishing a visual theme for the community
Context: Secondary users need a path from “I designed a look” to “other people can install it.” Optimize for staying inside approved visual tokens so the storefront stays safe. Paid themes are out of scope for this MVP.

#### Sub-journey: Creating a theme
[P0] User can create a creator account (or enable creator mode on an existing Dropbox account) before publishing.
[P0] User can build a theme using only approved visual properties (colors, backgrounds, icons, typography).
[P0] User can save a draft that is not public.
[P1] User can upload a storefront thumbnail and short description.
[P2] User can duplicate an existing approved theme they own as a starting point for a new draft.

#### Sub-journey: Submitting for review
[P0] User can submit a draft for DropVault review.
[P0] User can see whether the submission passed automated safety checks (no file access, no scripts outside the allowed theme format, no disallowed properties).
[P0] User can see a reject reason if automated checks fail, and can resubmit after fixing the theme.
[P1] User can withdraw a submission that is still in review.
[P2] User can request a human review note when an automated check is unclear.

#### Sub-journey: Publishing and maintaining a live theme
[P0] User can publish a theme only after it is approved.
[P0] User can unpublish their own live theme so new users cannot install it.
[P1] User can update a published theme; the update goes through the same review path before replacing the live version.
[P1] User can see install count and average rating for themes they published.
[P2] User can respond to a user rating or report with a short public note.

---

### User Journey 3: Dropbox keeping the storefront safe and usable
Context: The product only works if themes cannot touch files or break the core Dropbox experience. Optimize for default-deny customization and a fast revert path for end users.

#### Sub-journey: Enforcing theme limits
[P0] User’s files, passwords, and account data remain inaccessible to any theme.
[P0] User cannot install a theme that has not passed DropVault review.
[P0] User continues to use Dropbox file storage, sharing, and search the same way after a theme is applied (layout of core tasks does not change).
[P1] Organization admin can disable community themes for managed accounts.
[P2] User can see a simple “what this theme can change” summary at install time.

#### Sub-journey: Handling a bad or withdrawn theme
[P0] User whose active theme is unpublished or pulled for safety is returned to Dropbox default appearance automatically.
[P0] User can still open Dropbox and manage files if a theme fails to load.
[P1] User is notified if an installed theme was removed from the storefront for safety.
[P2] User can one-click reinstall a replacement recommended theme after a safety pull.
