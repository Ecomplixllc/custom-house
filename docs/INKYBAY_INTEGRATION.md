# InkyBay Integration

Only manual saved-design URL mode is enabled. An approved creator customizes a Global Product in InkyBay, saves the design, buys through InkyBay separately if desired, and submits the HTTPS saved-design URL through the Creator Submission block. The app validates the product/metafields and hostname; an admin reviews and publishes a permanent buy-only duplicate.

Do not configure private dashboard scraping or guessed API endpoints. Ask InkyBay support for a signed callback/webhook containing: original Shopify product GID, saved design ID and URL, public preview URL, selected variant/options, logged-in customer identifier, retry semantics, and signature verification documentation. Until that is supplied and reviewed, `FutureInkyBayApiProvider` remains disabled.

Support template: “Please provide documented server-to-server saved-design callback/webhook support for our Shopify app, including all fields above, signing algorithm/key rotation, replay protection, IP requirements, error/retry behavior, and a sandbox.”
