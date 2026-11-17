# Security

## Trust boundaries
Storefront JavaScript is untrusted. Shopify's signed app-proxy authentication supplies shop context; only the signed `logged_in_customer_id` is used. Admin mutations always call `authenticate.admin`. Database ownership filters include both shop and creator/customer identity.

Secrets remain server-side in Shopify CLI/runtime environment variables and Prisma session storage. Responses, audit records, and logs never include access tokens or raw GraphQL responses. Configure HTTPS, secure cookies, restricted database/network access, backups, monitoring, and a persistent production database at the hosting layer.

Inputs are length/type checked; saved-design URLs require HTTPS, reject credentials/fragments, and must match a configured hostname. App-proxy writes are rate-limited and submission writes use deterministic unique idempotency keys. The in-memory rate limiter must be replaced with Redis or equivalent for multi-instance production.

Helium remains the storefront application form. Authenticated customer webhooks and admin queries read only customer ID, creator tags, and explicitly configured customer metafields. External status may update `HELIUM_IMPORT` records, while `CUSTOM_APP` status authority prevents later Flow or webhook deliveries from overwriting an admin decision. App-proxy dashboard ownership uses only Shopify's signed `logged_in_customer_id`; customer IDs supplied by browser bodies are ignored.

Retention: rejected or withdrawn application details should be removed under the merchant's documented retention schedule. Customer-redaction webhooks delete the Creator, applications, and submissions for the verified ownership key. Audit entries contain status/source metadata only and must not contain applicant email, phone, street address, cookies, authorization headers, tokens, or database connection values.

Uninstall and mandatory redaction webhooks erase shop/customer marketplace records. Data-request webhooks record a minimal fulfillment audit; the operator must connect this record to their privacy-request delivery process. No email, address, phone, order, payment, or customer-auth data is stored.
