# Mobile Popup System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Standardize every creator-dashboard popup as a polished, accessible mobile bottom sheet while preserving tablet, desktop, and business behavior.

**Architecture:** Add one final, phone-only CSS contract that normalizes the outer modal, backdrop, sheet geometry, close target, overflow, and action sizing across the five existing popup families. Keep family-specific content layouts and semantic action colors in their existing selectors, and add a generic confirmation fallback for collection-banner removal. Verify the contract with source-level regression tests before full validation and release.

**Tech Stack:** Shopify theme app extension Liquid, CSS, vanilla JavaScript, Node test runner, TypeScript, Shopify CLI.

**Spec:** `docs/superpowers/specs/2026-09-12-mobile-popup-system-design.md`

## Global Constraints

- Apply the shared popup contract only at viewport widths of 600px and below.
- Preserve all tablet and desktop layouts.
- Do not change Shopify authentication, API calls, persistence, or form submission behavior.
- Preserve existing modal portal, focus return, scroll lock, loading, error, and `hidden` behavior.
- Destructive actions remain red; safe primary actions remain purple.
- Mobile actions fill the available width and have a minimum 48px touch target.
- Mobile sheet bottom padding includes `env(safe-area-inset-bottom)`.

---

### Task 1: Lock The Shared Mobile Contract With Regression Tests

**Files:**
- Modify: `tests/creator-dashboard.test.ts`

**Interfaces:**
- Consumes: the existing `block`, `script`, and `styles` fixture strings loaded by `tests/creator-dashboard.test.ts`.
- Produces: a source-level test named `creator dashboard popups share the professional mobile sheet contract` that guards the shared selectors and generic confirmation fallback.

- [ ] **Step 1: Write the failing regression test**

Add a test beside the existing modal tests that verifies the shared selector includes all five popup families, the phone breakpoint is `600px`, dialogs are full-width bottom sheets, close controls have 40px targets, actions are one-column and at least 48px tall, safe-area padding is present, and generic confirmations are covered independently from delete and withdraw.

```ts
test("creator dashboard popups share the professional mobile sheet contract", () => {
  assert.match(
    styles,
    /@media \(max-width: 600px\)[\s\S]*\.customhouse-payout-method-modal,[\s\S]*\.customhouse-profile-modal,[\s\S]*\.ch-design-review-modal,[\s\S]*\.ch-design-edit-modal,[\s\S]*\.ch-design-delete-modal\s*\{[^}]*align-items: end;[^}]*padding: 0;/s,
  );
  assert.match(
    styles,
    /\.customhouse-payout-method-modal \.ch-creator-modal__dialog,[\s\S]*\.customhouse-profile-modal-panel,[\s\S]*\.ch-design-delete-modal \.ch-creator-modal__dialog\s*\{[^}]*width: 100%;[^}]*max-height: calc\(100dvh - 54px\);[^}]*border-radius: 28px 28px 0 0;/s,
  );
  assert.match(styles, /min-height: 40px !important;/);
  assert.match(styles, /min-height: 48px !important;/);
  assert.match(styles, /env\(safe-area-inset-bottom\)/);
  assert.match(
    styles,
    /\.ch-design-delete-modal:not\(\.ch-design-delete-modal--withdraw\):not\(\.ch-design-delete-modal--delete\) footer\s*\{[^}]*grid-template-columns: minmax\(0, 1fr\);/s,
  );
  assert.match(script, /kind: "collection-banner-remove"/);
  assert.match(script, /destructive: true/);
});
```

- [ ] **Step 2: Run the focused test and confirm it fails**

Run: `node --test --test-name-pattern="professional mobile sheet contract" tests/creator-dashboard.test.ts`

Expected: FAIL because the shared five-family CSS contract and generic confirmation fallback do not exist yet.

- [ ] **Step 3: Commit the failing test**

```powershell
git add -- tests/creator-dashboard.test.ts
git commit -m "test: define mobile popup contract"
```

---

### Task 2: Implement The Shared Phone Popup Foundation

**Files:**
- Modify: `extensions/customhouse-creator-storefront/assets/customhouse.css`

**Interfaces:**
- Consumes: existing modal classes from `creator-dashboard.liquid` and existing specialized review, edit, delete, and withdraw rules.
- Produces: a final `@media (max-width: 600px)` cascade that applies common mobile geometry to all five popup families and a safe generic action-confirmation fallback.

- [ ] **Step 1: Add the shared outer-layer and backdrop rules**

Append a clearly labeled phone-only block after the existing modal-specific rules. Normalize bottom alignment, zero outer padding, backdrop dimming, and `box-sizing` without changing any selector above 600px.

```css
/* Shared professional mobile popup contract. */
@media (max-width: 600px) {
  .customhouse-payout-method-modal,
  .customhouse-profile-modal,
  .ch-design-review-modal,
  .ch-design-edit-modal,
  .ch-design-delete-modal {
    align-items: end;
    padding: 0;
  }

  .customhouse-payout-method-modal .ch-creator-modal__backdrop,
  .customhouse-profile-modal-backdrop,
  .ch-design-review-modal .ch-creator-modal__backdrop,
  .ch-design-edit-modal .ch-creator-modal__backdrop,
  .ch-design-delete-modal .ch-creator-modal__backdrop {
    background: rgba(10, 20, 36, .68);
    backdrop-filter: blur(3px);
  }
}
```

- [ ] **Step 2: Normalize sheet geometry and the drag handle**

Use a shared dialog selector for the four `.ch-creator-modal` families plus `.customhouse-profile-modal-panel`. Set `width: 100%`, `max-height: calc(100dvh - 54px)`, top-only 28px radii, internal overflow control, and a consistent 42px by 5px drag handle.

```css
@media (max-width: 600px) {
  .customhouse-payout-method-modal .ch-creator-modal__dialog,
  .customhouse-profile-modal-panel,
  .ch-design-review-modal .ch-creator-modal__dialog,
  .ch-design-edit-modal .ch-creator-modal__dialog,
  .ch-design-delete-modal .ch-creator-modal__dialog {
    width: 100%;
    max-width: 600px;
    max-height: calc(100dvh - 54px);
    border-width: 1px 0 0;
    border-radius: 28px 28px 0 0;
    overflow-x: hidden;
    background: #fff;
    box-shadow: 0 -20px 54px rgba(6, 14, 28, .26);
  }

  .customhouse-payout-method-modal .ch-creator-modal__dialog::before,
  .customhouse-profile-modal-panel::before,
  .ch-design-review-modal .ch-creator-modal__dialog::before,
  .ch-design-edit-modal .ch-creator-modal__dialog::before,
  .ch-design-delete-modal .ch-creator-modal__dialog::before {
    content: "";
    position: absolute;
    top: 12px;
    left: 50%;
    width: 42px;
    height: 5px;
    border-radius: 999px;
    background: #c6cbd5;
    transform: translateX(-50%);
  }
}
```

- [ ] **Step 3: Normalize headers, close targets, and internal scrolling**

Set common header spacing to `30px 20px 14px`, force title containers to `min-width: 0`, keep close buttons at 40px square, and ensure payout/profile forms scroll inside the capped sheet. Use `:focus-visible` with a two-pixel purple outline so keyboard focus remains clear.

```css
@media (max-width: 600px) {
  .customhouse-payout-method-modal .ch-creator-modal__dialog header,
  .customhouse-profile-modal-panel header,
  .ch-design-review-modal .ch-creator-modal__dialog header,
  .ch-design-edit-modal .ch-creator-modal__dialog header,
  .ch-design-delete-modal .ch-creator-modal__dialog header {
    gap: 12px;
    padding: 30px 20px 14px;
    border-bottom: 0;
  }

  .customhouse-payout-method-modal .ch-creator-modal__dialog header > div,
  .customhouse-profile-modal-panel header > div,
  .ch-design-review-modal .ch-creator-modal__dialog header > div,
  .ch-design-edit-modal .ch-creator-modal__dialog header > div,
  .ch-design-delete-modal .ch-creator-modal__dialog header > div {
    min-width: 0;
  }

  .customhouse-payout-method-modal .ch-creator-modal__dialog header button,
  .customhouse-profile-modal-panel header button,
  .ch-design-review-modal .ch-creator-modal__dialog header button,
  .ch-design-edit-modal .ch-creator-modal__dialog header button,
  .ch-design-delete-modal .ch-creator-modal__dialog header button {
    width: 40px !important;
    height: 40px;
    min-height: 40px !important;
    padding: 0 !important;
  }

  .customhouse-payout-method-modal-form,
  .customhouse-profile-form-wrap {
    min-height: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
  }

  .customhouse-payout-method-modal button:focus-visible,
  .customhouse-profile-modal button:focus-visible,
  .ch-design-review-modal button:focus-visible,
  .ch-design-edit-modal button:focus-visible,
  .ch-design-delete-modal button:focus-visible {
    outline: 2px solid #6938ef;
    outline-offset: 2px;
  }
}
```

- [ ] **Step 4: Normalize actions and fix the generic confirmation**

Set each popup footer to one column with a 10px gap and safe-area bottom padding. Force footer buttons to `width: 100%`, `min-width: 0`, and at least 48px high. For generic confirmation only, put confirm first and cancel second while preserving red destructive styling.

```css
@media (max-width: 600px) {
  .ch-design-delete-modal:not(.ch-design-delete-modal--withdraw):not(.ch-design-delete-modal--delete) footer {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: 10px;
    padding: 0 20px calc(20px + env(safe-area-inset-bottom));
    border-top: 0;
  }

  .ch-design-delete-modal:not(.ch-design-delete-modal--withdraw):not(.ch-design-delete-modal--delete) footer button {
    width: 100% !important;
    min-width: 0;
    min-height: 50px !important;
    flex: none;
    padding: 10px 14px !important;
  }

  .ch-design-delete-modal:not(.ch-design-delete-modal--withdraw):not(.ch-design-delete-modal--delete) [data-dashboard-action-confirm] {
    order: 1;
  }

  .ch-design-delete-modal:not(.ch-design-delete-modal--withdraw):not(.ch-design-delete-modal--delete) [data-dashboard-action-close] {
    order: 2;
  }
}
```

- [ ] **Step 5: Add the narrow-phone spacing override**

At 360px and below, reduce horizontal header, form, notice, and footer spacing from 20px to 14px. Do not reduce action height or close-target size.

```css
@media (max-width: 360px) {
  .customhouse-payout-method-modal .ch-creator-modal__dialog header,
  .customhouse-profile-modal-panel header,
  .ch-design-review-modal .ch-creator-modal__dialog header,
  .ch-design-edit-modal .ch-creator-modal__dialog header,
  .ch-design-delete-modal .ch-creator-modal__dialog header,
  .customhouse-payout-method-modal-form,
  .customhouse-profile-form-wrap,
  .ch-design-delete-modal footer {
    padding-right: 14px;
    padding-left: 14px;
  }
}
```

- [ ] **Step 6: Run the focused modal tests**

Run: `node --test --test-name-pattern="modal|popup|bottom sheet" tests/creator-dashboard.test.ts`

Expected: all matching tests PASS, including the new shared-contract regression.

- [ ] **Step 7: Inspect the diff for tablet and desktop leakage**

Run: `git diff --check` and `git diff -- extensions/customhouse-creator-storefront/assets/customhouse.css tests/creator-dashboard.test.ts`

Expected: no whitespace errors; all new presentation rules are nested under `@media (max-width: 600px)`.

- [ ] **Step 8: Commit the implementation**

```powershell
git add -- extensions/customhouse-creator-storefront/assets/customhouse.css
git commit -m "fix: standardize mobile dashboard popups"
```

---

### Task 3: Validate Responsive Behavior And Production Build

**Files:**
- Verify: `extensions/customhouse-creator-storefront/assets/customhouse.css`
- Verify: `extensions/customhouse-creator-storefront/blocks/creator-dashboard.liquid`
- Verify: `extensions/customhouse-creator-storefront/assets/customhouse-dashboard.js`

**Interfaces:**
- Consumes: the completed CSS contract and existing modal open/close flows.
- Produces: passing automated validation and visual evidence at representative phone widths.

- [ ] **Step 1: Run the complete dashboard test file**

Run: `node --test tests/creator-dashboard.test.ts`

Expected: all creator-dashboard tests PASS.

- [ ] **Step 2: Run the complete project test suite**

Run: `npm test`

Expected: all tests PASS with no skipped regression caused by this change.

- [ ] **Step 3: Run TypeScript validation**

Run: `npm run typecheck`

Expected: exit code 0.

- [ ] **Step 4: Run the production build**

Run: `npm run build`

Expected: exit code 0 and a successful React Router production build.

- [ ] **Step 5: Inspect representative phone widths**

Open the creator dashboard account and product routes in a browser session with authenticated storefront access. At widths 320px, 390px, and 430px, open payout method, profile editor, design review, design details, delete, withdraw, and collection-banner removal popups.

Expected for every popup: no horizontal clipping; a top-rounded bottom sheet; visible close target; internally scrollable long content; stacked full-width actions; at least 48px action height; safe-area clearance. Collection-banner removal must show a normal red full-width `Remove Banner` button followed by a full-width `Cancel` button.

- [ ] **Step 6: Confirm the branch is clean except for planned commits**

Run: `git status --short --branch`

Expected: `development` is ahead only by the design, test, and implementation commits; no untracked or modified files.

---

### Task 4: Publish Development And Deploy The Approved Live Release

**Files:**
- No source-file changes.

**Interfaces:**
- Consumes: validated commits on `development`.
- Produces: synchronized `development`, `main`, and production Shopify app deployment, plus a healthy live endpoint.

- [ ] **Step 1: Push the development branch**

Run: `git push origin development`

Expected: remote `development` advances to the validated implementation commit.

- [ ] **Step 2: Merge the exact development state into main**

Run: `git switch main`, then `git merge --ff-only development`.

Expected: `main` fast-forwards with no merge commit or conflict.

- [ ] **Step 3: Re-run release validation on main**

Run: `npm test`, `npm run typecheck`, and `npm run build`.

Expected: all commands exit successfully on the exact production branch state.

- [ ] **Step 4: Push main**

Run: `git push origin main`

Expected: remote `main` advances to the same commit as `development`.

- [ ] **Step 5: Deploy from a clean detached worktree**

Create a temporary detached worktree at the production commit, then run:

```powershell
$release = "production-$(git rev-parse --short HEAD)-mobile-popups"
shopify app deploy --config shopify.app.production.toml --version $release --allow-updates --no-color
```

Expected: Shopify CLI reports a successful production app release. Existing Google Fonts `RemoteAsset` warnings may remain, but no deployment error is accepted.

- [ ] **Step 6: Verify production health and synchronize branches**

Request `https://custom-house.vercel.app/health`, remove the temporary deployment worktree, switch back to `development`, and compare local and remote refs.

Expected: the health endpoint returns success; `main`, `development`, `origin/main`, and `origin/development` point to the same production commit; the working tree is clean.
