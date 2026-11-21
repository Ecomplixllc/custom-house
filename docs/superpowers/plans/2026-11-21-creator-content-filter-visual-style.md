# Creator Content Filter Visual Style Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Creator Content filter selections match the Custom House dark, purple, and lime graphical style without changing filtering behavior.

**Architecture:** Keep the existing server-rendered Creator Content HTML and client-side filtering intact. Add regression assertions around the generated CSS/markup, then update only the scoped `customhouse-creator-content` styles and active-filter presentation in the existing response builder.

**Tech Stack:** TypeScript, Node test runner, server-rendered HTML/CSS, Shopify app-proxy storefront page

**Spec:** `docs/superpowers/specs/2026-11-21-creator-content-filter-visual-style-design.md`

## Global Constraints

- Preserve existing filtering, search, pagination, URL state, clear-all behavior, and mobile drawer behavior.
- Do not change available filter values, sorting, product results, Shopify product data, or collection data.
- Keep the existing HTML checkbox inputs in place for accessibility and event handling.
- Use the existing page variables `--cc-panel`, `--cc-line`, `--cc-text`, `--cc-lime`, and `--cc-purple`.
- Respect reduced-motion preferences for decorative transitions.

## Review Focus

- A long active-filter label must wrap or constrain safely without overflowing the viewport; Task 1 asserts chip width and text layout styles.
- Keyboard users must see a clear focus indicator on chips and checkbox rows; Task 1 asserts `:focus-visible` and `:focus-within` states.
- Checked, unchecked, hover, and disabled checkbox states must remain visually distinguishable; Task 1 asserts custom base, checked, hover, and disabled selectors.
- Mobile filter selections must remain usable in the drawer and active chips must wrap within the container; Task 1 asserts flexible wrapping and touch-sized controls.
- Reduced-motion users must not receive decorative control transitions; Task 1 asserts a `prefers-reduced-motion:reduce` override.

---

### Task 1: Branded filter selection controls

**Files:**
- Modify: `tests/creator-content.test.ts`
- Modify: `app/services/storefront-proxy.server.ts:1023-1031`
- Reference: `docs/superpowers/specs/2026-11-21-creator-content-filter-visual-style-design.md`

**Interfaces:**
- Consumes: `creatorContentHtml(input)` and its existing `data-creator-content-active-filters` and `data-creator-content-filter` hooks.
- Produces: scoped active-chip and custom-checkbox presentation inside `.customhouse-creator-content-page`; no new exported TypeScript interface.

- [ ] **Step 1: Add a failing generated-markup regression test**

Add `test("Creator Content uses branded active filters and checkbox states", async () => { ... })` to `tests/creator-content.test.ts`. Generate markup with `creatorContentHtml(...)` and assert that it contains:

- active-filter pill rules with `border-radius:999px`, a purple treatment, lime remove/focus treatment, `max-width:100%`, and wrapping-safe text layout;
- checkbox `appearance:none` base styling;
- explicit `:checked`, `:hover`, `:focus-within`, and `:disabled` selectors;
- at least a 36px checkbox-row minimum height for touch usability;
- a `@media(prefers-reduced-motion:reduce)` override for these controls.

- [ ] **Step 2: Run the focused test and verify the RED state**

Run: `node --experimental-strip-types --test --test-name-pattern="Creator Content uses branded active filters and checkbox states" tests/creator-content.test.ts`

Expected: FAIL because the current output uses generic toolbar-button and native checkbox styling.

- [ ] **Step 3: Implement scoped active-filter pill styles**

In `creatorContentHtml` within `app/services/storefront-proxy.server.ts`, replace the generic active-filter button rule with scoped rules that provide:

- compact pill layout with `max-width:100%` and safe wrapping;
- dark-to-purple background, purple border/glow, and lime accent;
- branded hover and keyboard focus states;
- an obvious remove affordance while retaining the existing `data-creator-content-clear` behavior.

- [ ] **Step 4: Implement scoped custom checkbox-row styles**

Style the existing `input[type=checkbox]` elements and their labels without replacing them. Add the dark unchecked box, purple checked fill, lime checkmark, row hover surface, keyboard focus ring, disabled state, 36px minimum row height, and reduced-motion override.

- [ ] **Step 5: Run the focused test and verify the GREEN state**

Run: `node --experimental-strip-types --test --test-name-pattern="Creator Content uses branded active filters and checkbox states" tests/creator-content.test.ts`

Expected: PASS with one matching test and no failures.

- [ ] **Step 6: Run the full validation suite**

Run, in order:

- `npm test`
- `npm run lint`
- `npm run typecheck`
- `npm run build`

Expected: every command exits with code 0; report any pre-existing warning separately instead of hiding it.

- [ ] **Step 7: Visually verify responsive presentation**

Render or open the Creator Content page with at least one selected filter and verify:

- desktop: active pills and checked rows match the dark/purple/lime design and the filter sidebar layout is unchanged;
- mobile: active pills wrap, checkbox rows remain touch-friendly, and the drawer still opens and closes;
- keyboard: focus is visible on removable chips and checkbox rows.

- [ ] **Step 8: Commit the approved implementation**

```bash
git add app/services/storefront-proxy.server.ts tests/creator-content.test.ts docs/superpowers/specs/2026-11-21-creator-content-filter-visual-style-design.md docs/superpowers/plans/2026-11-21-creator-content-filter-visual-style.md
git commit -m "feat: style creator content filters"
```

### Task 2: Development test deployment

**Files:**
- No source changes expected.

**Interfaces:**
- Consumes: the verified Task 1 commit on `development`.
- Produces: a pushed `development` commit and a preview/test deployment for merchant review; production remains unchanged.

- [ ] **Step 1: Confirm branch and compare with remote**

Run: `git branch --show-current` and `git status --short`

Expected: branch is `development`; only known user-owned untracked files remain outside the committed change.

- [ ] **Step 2: Push the development branch**

Run: `git push origin development`

Expected: the Task 1 commit is present on `origin/development`.

- [ ] **Step 3: Create the normal preview/test deployment**

Use the repository's established Vercel preview deployment workflow without assigning the production alias.

Expected: deployment finishes successfully and provides a preview URL.

- [ ] **Step 4: Perform preview health and visual checks**

Verify the preview health endpoint and the Creator Content response, then repeat the desktop/mobile filter checks from Task 1 where the preview environment permits authenticated app-proxy access.

Expected: health reports the app and database as connected, and no new browser console error is introduced by the filter styles.

- [ ] **Step 5: Stop for production approval**

Report the preview URL, commit, validation evidence, visual findings, and a short client-facing message. Do not merge to `main`, assign the production alias, or deploy production until the user explicitly approves.
