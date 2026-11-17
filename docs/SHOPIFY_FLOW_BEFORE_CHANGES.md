# Shopify Flow production audit before changes

Audit date: 2026-07-23. No workflow was edited, disabled, or deleted.

## New Creator Applications

- Status: Active
- Trigger: Customer tags added
- Condition: added tag equals `creator-pending`
- Observed actions:
  - remove `creator-approved`, `creator-rejected`, and `creator-suspended`
  - update `custom.creator_status`
  - send an internal notification
  - update `custom.creator_submitted_at`
- Risk: it can overwrite an app-managed approved, rejected, or suspended
  state. It must become notification-only.
- Recent runs: completed runs were visible during the audit.

## Creator Application - Approved

- Status: Active
- Trigger: Customer tags added
- Condition: added tag equals `creator-approved`
- Observed actions:
  - remove `creator-approved` and `creator-applicant`
  - update `custom.creator_status`
  - send an internal notification
  - update `custom.creator_approved_at`
- Risk: it removes its own trigger/status tag and conflicts with the app's
  canonical approved tag set. It must become notification-only.

## Creator Application - Rejected

- Status: Active
- Trigger: Customer tags added
- Detailed canvas actions were not exposed by the browser audit.
- Required review: retain notification/email actions only; never re-add the
  trigger tag or update authoritative app status.

## Creator Application - Suspend

- Status: Active
- Trigger: Customer tags added
- Detailed canvas actions were not exposed by the browser audit.
- Required review: retain notification/email actions only; never re-add the
  trigger tag, delete collections, or delete creator products.

## Missing bridge

No active workflow specific to **Creator Application – Storefront** (`lXteLY`)
was found. Four confirmed form submitters had no creator tags before the
production repair.
