# CustomHouse → PitchPrint authoritative method handoff

This report distinguishes local execution evidence from live production evidence.
No PitchPrint template or production-pricing database schema was changed.

## Root cause confirmed in source

1. The host answered only `CUSTOMHOUSE_PP_ORDER_CONFIG_REQUEST`; it did not answer the template's `CUSTOMHOUSE_PP_FULL_PRODUCT_CONFIG_REQUEST` or send `CUSTOMHOUSE_PP_FULL_PRODUCT_CONFIG`.
2. Public config selection treated fewer pricing entries as incomplete. A legitimate change from two enabled methods to one or zero could retain the earlier list.
3. Public launches relied on a Shopify metafield snapshot, without refreshing canonical database pricing. Creator launches could reuse previously hydrated base-product pricing.
4. An explicit empty version-two method map was incorrectly interpreted as legacy pricing and restored the old methods.
5. The public normalizer rebuilt selected fields and lost generic tier/registry metadata.

## Change

- Added an authenticated, no-store app-proxy read at `/api/pitchprint-method-config` using the existing canonical product resolver. Public launch refreshes this source and resends when it arrives; it normalizes Liquid's numeric product ID to a Shopify GID.
- Creator refreshes the existing canonical base-product endpoint on each launch. Both configs contain an array of enabled methods, including explicit `[]`, with canonical codes, currency, fee variant references, registry metadata and tier state/rates.
- Both hosts answer full-config requests and resend on existing runtime readiness events. Public retains the order-config compatibility response; Creator retains both existing compatibility responses. Requests and acknowledgements use allowed origins and remembered runtime targets.
- Pending results are keyed by product. Partial pricing cannot replace the complete method list. Authoritative reductions to one or zero methods are accepted.
- Added sanitized METHOD_HANDOFF and acknowledgement diagnostics. The existing ACK channel is observed; an ACK is not fabricated when a runtime does not emit one.

## T-shirt trace

PRODUCT_ID = gid://shopify/Product/16472592548185

PRODUCT_HANDLE = NOT_VERIFIED

DB_ENABLED_METHODS = NOT_VERIFIED

DB_STICKER_PRINTING_ENABLED = NOT_VERIFIED

DB_STICKER_PRINTING_SURCHARGE_MINOR = NOT_VERIFIED

Local fixture, based on the requested admin settings: STICKER_PRINTING only, 1000 minor SEK.
The local database environment is a placeholder and cannot establish a connection.
The unauthenticated storefront returned HTTP 401. No live DB state, iframe delivery or acknowledgement is claimed.

## Requested acceptance fields

ROOT_CAUSE = full-config handshake missing; stale list completeness guard and cached pricing; explicit empty map incorrectly restored legacy methods

T_SHIRT_DB_METHODS = NOT_VERIFIED

T_SHIRT_SERVER_METHODS = STICKER_PRINTING (fixture PASS; live NOT_VERIFIED)

T_SHIRT_STOREFRONT_METHODS = STICKER_PRINTING (executed host harness PASS; live NOT_VERIFIED)

T_SHIRT_PITCHPRINT_METHODS = STICKER_PRINTING (full-config message payload PASS; live iframe NOT_VERIFIED)

FULL_CONFIG_EVENT = CUSTOMHOUSE_PP_FULL_PRODUCT_CONFIG

FULL_CONFIG_SENT = YES in host harness; live NOT_VERIFIED

FULL_CONFIG_METHOD_COUNT = 1 in sticker-only fixture; live NOT_VERIFIED

FULL_CONFIG_METHOD_CODES = STICKER_PRINTING in fixture; live NOT_VERIFIED

PRODUCTION_METHODS_NULL = NO in resolved complete configs

CONFIG_TARGET_FOUND = YES in host harness; live NOT_VERIFIED

CONFIG_SENT_AFTER_READY = YES in host harness; live NOT_VERIFIED

CONFIG_ACKNOWLEDGED = YES with existing ACK in host harness; live NOT_VERIFIED

PUBLIC_HANDOFF = PASS locally; live NOT_VERIFIED

CREATOR_HANDOFF = PASS canonical config tests; live NOT_VERIFIED

STICKER_ONLY_LIVE = NOT_VERIFIED

TWO_METHOD_DYNAMIC = PASS locally

ZERO_METHOD_DYNAMIC = PASS locally

CUSTOM_METHOD_DYNAMIC = PASS locally

PITCHPRINT_TEMPLATE_CHANGED = NO

Template SHA256: `6FDD82DD975940D2D7C5DC227F4E8416A3B4303D2D12A510BCB522B0F13826C2`.

Validation: all 586 repository tests pass, lint passes, typecheck passes, and the production build passes. Typecheck/build used a process-local `SHOPIFY_APP_URL=http://localhost` because the saved local environment contains placeholder values. No saved environment file was changed.

Automatic approval review rejected downloading production environment variables because it retrieves sensitive credentials without specific authorization. No alternative credential extraction was attempted.

## Release requirements

App server deployment alone does not update Shopify-hosted scripts. The release must include the Creator storefront extension and the two Public theme assets:

- `extensions/customhouse-creator-storefront/assets/customhouse-dashboard.js`
- `theme-live-cart/assets/customhouse-pitchprint-order-handoff.js`
- `theme-live-cart/assets/customhouse-pitchprint-public-contract.js`

The existing Liquid already serializes `customhouse.production_method_pricing` as JSON and needs no change. The new proxy read removes reliance on metafield sync freshness.

Repository AGENTS.md requires development validation/test deployment and explicit approval before merging/deploying main. Production acceptance must be observed after all three release surfaces are deployed.
