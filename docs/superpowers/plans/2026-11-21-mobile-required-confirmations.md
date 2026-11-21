# Mobile Required Confirmations Implementation Plan

**Goal:** Make the mandatory confirmations in the mobile public customization checkout immediately visible and understandable without weakening validation.

**Files:**

- Modify `pitchprint-template-v10.84-CREATOR-SUBMIT-DRAFT-FIX.txt`
- Modify `tests/pitchprint-creator-flow-template.test.ts`
- Reference `docs/superpowers/specs/2026-11-21-mobile-required-confirmations-design.md`

## Task 1: Add regression coverage

- Add a focused template test for the required-action callout, incomplete state, remaining count, auto-open behavior, focus/scroll navigation, and unchanged cart-button validation.
- Run the focused test and confirm it fails before implementation.

## Task 2: Implement the mobile guidance

- Add mobile-only incomplete and complete confirmation-section styles.
- Create an accessible required-action callout above the cart button.
- Synchronize the remaining count, state classes, initial expansion, and callout visibility from the existing accordion state.
- Make the callout open and focus the missing confirmations while respecting reduced motion.

## Task 3: Verify and prepare development release

- Run the focused test, full tests, lint, typecheck, and build.
- Review the diff for scope and whitespace errors.
- Commit and push `development` for manual merchant approval before any production update.

