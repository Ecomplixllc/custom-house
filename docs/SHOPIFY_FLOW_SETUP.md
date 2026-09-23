# Shopify Flow setup for Helium creator applications

Production audit date: 2026-07-23.

## Confirmed Helium form

- Name: **Creator Application – Storefront**
- Form ID: `lXteLY`
- Type: Storefront
- Account option: Default
- Submission method: Register
- Form rules: none

Helium records this submission in the accessible customer metafield
`customer_fields.form_ids`. Four production customers were confirmed with
`lXteLY`.

## Helium Creator Form → Pending bridge

Create the workflow named **Helium Creator Form → Pending**:

1. Trigger: **Customer Fields → Customer submitted form**.
2. Require submitted form ID to equal `lXteLY`.
3. Require `creator-approved`, `creator-suspended`, and `creator-pending` to
   be absent.
4. Add `creator-applicant` and `creator-pending`.
5. Do not remove approved or suspended state tags.
6. Do not add approved, rejected, or suspended tags.
7. Activate only after reviewing the workflow summary, then verify one
   completed run without recursion.

## Existing workflows requiring correction

- **New Creator Applications** triggers on `creator-pending`. The production
  audit found that it removes approved, rejected, and suspended tags. Restrict
  it to notifications only.
- **Creator Application - Approved** triggers on `creator-approved`. The
  production audit found that it removes `creator-approved` itself and
  `creator-applicant`. Restrict it to notifications only.
- **Creator Application - Rejected** must be notification-only.
- **Creator Application - Suspend** must be notification-only.

Never disable or delete a workflow without merchant approval. Test each edit
with a dedicated customer and confirm it runs once.

## Helium field-access limitation

Helium's custom data columns use the app-owned namespace
`app--960624--helium`. The Custom House Creator app's Admin API session cannot
read those values or definitions. It can read only Helium's non-personal
`customer_fields.form_ids` marker.

Do not use the Helium access-token metafield or an undocumented Helium API.
Profile-field import requires a merchant-reviewed, documented method that
copies only the approved creator fields into merchant-owned customer
metafields readable by Custom House Creator. Until then, tag/webhook
synchronization creates safe placeholder pending records without storing
contact data.
