# Mobile Popup System Design

## Goal

Make every creator-dashboard popup professional, consistent, accessible, and responsive on mobile devices while preserving the approved tablet and desktop layouts and all existing business behavior.

## Scope

The dashboard currently has five popup families:

1. Payout method editor.
2. Creator profile editor.
3. Design review and submission.
4. Design details editor.
5. Shared action confirmation for delete, withdraw, and collection-banner removal.

This change standardizes their phone presentation at viewport widths of 600px and below. Tablet and desktop styles remain unchanged. No Shopify authentication, API calls, persistence logic, or form submission behavior changes.

## Existing Problem

The popup families were upgraded independently and do not share one complete mobile layout contract. Delete and withdraw confirmations have specialized mobile sheet rules, but collection-banner removal uses the generic confirmation state. Its older flex wrapping rules can collapse the two actions into tall, narrow columns, as shown in the supplied screenshot. Other popup families use similar but duplicated values for backdrop, sheet geometry, close controls, spacing, overflow, and safe-area padding.

## Chosen Approach

Add a shared mobile popup foundation to the existing stylesheet and keep each popup family's content-specific rules layered on top. The shared confirmation popup will receive a generic mobile sheet fallback, so every action kind has a professional layout even when it does not have a specialized modifier class.

This is a CSS-first change. JavaScript changes are limited to adding or clearing a stable action-kind class or data attribute only if the generic fallback cannot express semantic destructive and safe states reliably. Existing Liquid markup is preserved unless an accessibility attribute is missing.

## Mobile Layout Contract

At widths up to 600px:

- Popups align to the bottom edge as full-width sheets.
- Sheets use rounded top corners, a visible drag-handle treatment, and no rounded lower corners.
- The backdrop is consistently dimmed and lightly blurred.
- The sheet height is capped against `100dvh`, leaving visible context above it.
- Long content scrolls inside the sheet; the page behind it remains locked.
- Header, body, and footer use 20px horizontal spacing, reduced to 14px at widths up to 360px.
- Close buttons have a minimum 40px square touch target and a visible keyboard focus state.
- Primary and secondary footer actions stack vertically, fill the available width, and are at least 48px high.
- Primary action appears first. Cancel or continue-editing appears second.
- Bottom padding includes `env(safe-area-inset-bottom)`.
- Text wraps without horizontal clipping, and controls use `min-width: 0` where grid or flex sizing could overflow.

## Popup-Specific Behavior

### Payout Method Editor

Keep its existing fields and validation. Apply shared sheet geometry, scrolling, spacing, close control, and full-width actions. Field groups remain one column on phones.

### Creator Profile Editor

Keep the existing profile form and preview content. Apply the shared sheet geometry and ensure its long form scrolls internally without hiding the footer or close control.

### Design Review

Retain the two-column preview thumbnails and existing summary cards where they fit. Keep the current action order: submit, keep as draft, continue editing.

### Design Details Editor

Retain the current one-column form, metadata summaries, character count, save action, and cancel action. Use the shared sheet geometry and action sizing.

### Action Confirmation

Use the shared mobile sheet for all action kinds. Delete and collection-banner removal use red destructive primary actions. Withdraw-to-draft and other safe actions use the existing purple primary treatment. Specialized notices remain visible only for the matching delete or withdraw action; generic actions remain compact without an empty notice region.

## Interaction And Accessibility

- Preserve the existing modal open, close, focus-return, and background scroll-lock behavior.
- Keep close buttons and action buttons keyboard operable.
- Preserve `hidden` semantics for inactive modals and notices.
- Retain current error and loading messages, including the configured loading label for collection-banner removal.
- Respect `prefers-reduced-motion`; no required motion is introduced.
- Prevent accidental horizontal scrolling at 320px and wider phone viewports.

## Testing

Add focused regression assertions to `tests/creator-dashboard.test.ts` for:

- All five popup families remaining present and portal-enabled.
- The shared phone sheet rules at the 600px breakpoint.
- Full-width stacked action controls with minimum touch-target height.
- Safe-area bottom padding and internal viewport height constraints.
- Generic collection-banner removal using the shared confirmation fallback.
- Delete and withdraw retaining their specialized semantic styling.
- Tablet and desktop selectors not being changed by the phone-only rules.

Run the focused dashboard test first, then the complete test suite, typecheck, and production build. Visually inspect representative 320px, 390px, and 430px phone widths before deployment.

## Release

Commit and push the validated change on `development`. After release approval, merge the exact commit to `main`, deploy the production Shopify app version, and verify the live health endpoint.
