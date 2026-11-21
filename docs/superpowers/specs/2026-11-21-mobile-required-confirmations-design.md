# Mobile Required Confirmations Visibility

## Problem

On the mobile public-customization final step, the required copyright and custom-product confirmations are collapsed into an ordinary accordion row. The disabled Continue to cart button does not explain why checkout is blocked, so customers can miss the required action.

## Design

- Preserve both required confirmations and the existing disabled-cart validation.
- On mobile public customization only, automatically open the confirmation section once while confirmations are incomplete.
- Style the incomplete section with a high-contrast Custom House purple treatment and show the summary `Action required · N remaining`.
- Place a persistent `Required before purchase` callout directly above Continue to cart while confirmations remain incomplete.
- Make the callout a keyboard-accessible button that opens, scrolls to, and focuses the first unchecked confirmation.
- Switch the confirmation section to a subtle completed treatment and remove the callout when both boxes are checked.
- Respect reduced-motion preferences when scrolling.

## Non-goals

- No changes to cart payloads, confirmation requirements, product configuration, pricing, or desktop layout.
- No change to Creator submission mode.

## Validation

- Regression-test the mobile callout, incomplete state, remaining-count copy, auto-open behavior, navigation behavior, and preserved disabled-cart rule.
- Run the full test, lint, typecheck, and build suite.

