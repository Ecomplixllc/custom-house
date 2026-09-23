# Merchant Setup

1. Deploy/reinstall the app to approve the scopes in `shopify.app.toml`; set its real application and auth URLs.
2. Confirm the existing `customhouse` product metafield definitions and accepted values. The app does not create them.
3. In Settings, select the Online Store publication GID, add exact InkyBay saved-design hostnames, and optionally configure metaobject/customer-metafield mapping.
4. Mark Global Products: origin `global`, mode `customizable`, status `published`, Creator Profile empty. Use the Products page to dry-run validation; do not bulk-edit automatically.
5. Deploy the theme extension. Create “Become a Creator” and creator-dashboard pages; add their blocks. Add Creator Submission to Global Product templates, Creator Attribution and Buy-only Product Form to creator-product templates, and enable InkyBay Compatibility. It hides nothing until a reviewed selector JSON is supplied.
6. Keep Helium/Flow active during comparison; disable them manually only after import and end-to-end acceptance.

Verify InkyBay does not independently mark duplicated creator products customizable. Test with a customer account and a disposable saved design before launch.
