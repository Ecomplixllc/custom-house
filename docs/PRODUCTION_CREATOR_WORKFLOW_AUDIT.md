# Production Creator Workflow Audit

Audit date: 2026-07-23

## Confirmed root cause

The deployed GitHub `main` branch does not contain the `customers/create` or
`customers/update` routes, the Helium synchronization service,
creator-dashboard lazy sync, or the Helium mapping UI. Those components exist
on the checkpointed repair branch. Render therefore cannot synchronize a
Helium-created Shopify customer into PostgreSQL until the repair branch is
merged and deployed and the Shopify app configuration containing the webhook
subscriptions is released.

## Helium form

- Name: Creator Application – Storefront
- Form ID: `lXteLY`
- Type: Storefront
- Account option: Default
- Submission method: Register
- Rules: none
- Success behavior: Helium submission-success step
- Cancel behavior: `/account/login`

Observed fields:

| Label | Required | Shopify customer field / Helium data column |
| --- | --- | --- |
| First name | Yes | Standard customer field; not imported |
| Last name | Yes | Standard customer field; not imported |
| Creator Display Name | No | `app--960624--helium.creator_display_name_1` (`single_line_text`) |
| Legal Name | Yes | `app--960624--helium.legal_name` (`single_line_text`) |
| Country | No | Matching definition: `app--960624--helium.creator_country` (`single_line_text`) |
| Email address | Yes | Standard customer field; never imported |
| City | No | Matching definition: `app--960624--helium.creator_city` (`single_line_text`) |
| Creator Profile Photo | No | `app--960624--helium.creator_profile_photo_1` (`file_reference`) |
| Short Creator Bio | No | `app--960624--helium.short_creator_bio` (`text`) |
| Social/Portfolio URL | No | `app--960624--helium.socialportfolio_url` (`single_line_text`) |
| Terms Agreement | No | `app--960624--helium.terms_agreement` (`boolean`) |

The form contains no application-message field. Keep that logical mapping
disabled unless the merchant adds a matching field.

## Mapping candidates requiring Shopify definition verification

Helium's data-column inventory contains the following matching definitions.
The app Settings page must discover and validate them through Shopify before
they are saved; the browser form editor did not expose an internal binding for
Country or City, so those two entries are not claimed as confirmed bindings.

- `legalName` → `app--960624--helium.legal_name`
- `creatorDisplayName` → `app--960624--helium.creator_display_name_1`
- `country` → `app--960624--helium.creator_country`
- `city` → `app--960624--helium.creator_city`
- `creatorProfilePhoto` → `app--960624--helium.creator_profile_photo_1`
- `shortCreatorBio` → `app--960624--helium.short_creator_bio`
- `portfolioUrl` → `app--960624--helium.socialportfolio_url`
- `termsAccepted` → `app--960624--helium.terms_agreement`
- `socialProfiles` and `applicationMessage` → disabled unless dedicated fields
  are added.

## Shopify Flow audit

- `New Creator Applications` is active. It triggers when
  `creator-pending` is added, but currently removes `creator-approved`,
  `creator-rejected`, and `creator-suspended`. This can reset an app-managed
  decision and must be changed to notification-only.
- `Creator Application - Approved` is active. It triggers on
  `creator-approved`, but currently removes `creator-approved` itself and
  `creator-applicant`. This conflicts with the app's canonical tag state and
  must be changed to notification-only.
- `Creator Application - Rejected` and `Creator Application - Suspend` are
  active. Their canvas details require merchant review before any edits.
- No workflow was disabled, deleted, or edited during this audit.

Do not edit active workflows until the merchant confirms the change after
reviewing the workflow/version-history backup.
