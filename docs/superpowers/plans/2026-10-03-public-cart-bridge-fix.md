# Public Multi-Variant Cart Bridge Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the established `CUSTOMHOUSE_PP_CART_READY` public flow validate every selected Shopify variant, prepare all merchandise and one authoritative production-fee line, add the set atomically, acknowledge success, and redirect to `/cart`.

**Architecture:** Keep the existing app-proxy server as the authority for product ownership, availability, artwork classification, fee identity, fee quantity, and legal confirmations. Update only the public storefront handoff so canonical `variantSelections[]` is evaluated before the legacy single-variant fallback; accept cross-window messages only from the known PitchPrint origin and return a cart acknowledgement to the message source after Shopify accepts the atomic add.

**Tech Stack:** Browser JavaScript, Shopify Ajax Cart API, React Router app proxy, TypeScript, Node test runner.

**Spec:** `C:/Users/jpcho/.codex/attachments/bfc97cce-d8b0-4e92-9371-be643d9201ab/Pasted text.txt`

## Global Constraints

- Do not modify Creator flow, Creator `BAKED_IN_V1`, public artwork classification, public price configuration, PitchPrint Color/Size UI, the checkout Function, or checkout-rule state.
- Do not trust browser prices, product identity, variant identity, artwork subtype, placement count, or legal confirmations.
- Preserve project/design IDs and the existing canonical cart property names.
- No paid order.

## Review Focus

- A complete multi-variant payload must not be rejected because the pre-editor single-variant snapshot is absent or stale.
- A malformed/foreign variant must fail server-side before any Shopify cart mutation.
- A foreign `postMessage` origin must not trigger a cart mutation.
- A failed app-proxy or Ajax-cart request must not redirect or expose internal errors.
- Repeated ready events for the same project must not duplicate cart lines.

---

### Task 1: Canonical public cart-ready selection contract

**Files:**
- Modify: `tests/public-pitchprint-contract.test.ts`
- Modify: `theme-live-cart/assets/customhouse-pitchprint-public-contract.js`

**Interfaces:**
- Produces: `buildCartSelectionContract({ value, source, snapshot, config })` returning canonical selections, selection count, and total quantity.

- [ ] Write a failing test for two canonical selections without a valid legacy snapshot and for safe legacy fallback.
- [ ] Run the focused test and confirm the missing function/old behavior fails.
- [ ] Implement the smallest normalizer using existing variant IDs and quantities.
- [ ] Run the focused tests and confirm they pass.

### Task 2: Storefront event, atomic add, acknowledgement, and diagnostics

**Files:**
- Modify: `tests/public-pitchprint-contract.test.ts`
- Modify: `theme-live-cart/assets/customhouse-pitchprint-order-handoff.js`

**Interfaces:**
- Consumes: `buildCartSelectionContract` from Task 1.
- Produces: established ready listener, sanitized stage diagnostics, one app-proxy request, one `/cart/add.js` request containing all prepared lines, success acknowledgement, and `/cart` redirect.

- [ ] Write a failing VM integration test proving two selections reach one atomic add even when the old single-variant snapshot is invalid.
- [ ] Test allowed versus foreign message origins, safe failure, acknowledgement, redirect, and duplicate-event idempotency.
- [ ] Run the focused tests and observe the old guard failure.
- [ ] Move selection validation before the legacy fallback guard, restrict cross-window origin, preserve DOM/client events, add sanitized diagnostics, and acknowledge only after a successful add.
- [ ] Run focused tests and confirm all pass.

### Task 3: Server regression and development release verification

**Files:**
- Modify only if a failing server regression reveals a gap: `app/services/production-method-cart.server.ts`
- Test: `tests/production-method-pricing.test.ts`

**Interfaces:**
- Consumes: canonical `variantSelections[]` from Task 2.
- Produces: validated merchandise lines and exactly one subtype-specific fee line.

- [ ] Run existing server tests covering multi-variant validation, Image/Logo and Text fees, placement multiplication, legal/project validation, and Creator exclusion.
- [ ] Add only missing behavior tests revealed by the trace; make no server change when current behavior already satisfies the spec.
- [ ] Run `npm test`, `npm run lint`, `npm run typecheck`, and `npm run build`.
- [ ] Confirm the checkout Function diff is empty.
- [ ] Commit and push `development`; deploy only the approved development/test surfaces and perform the exact no-purchase live QA after explicit production approval.
