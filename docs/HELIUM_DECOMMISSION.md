# Helium and Flow decommission plan

Do not execute this plan until the app-native acceptance test passes and the merchant explicitly approves decommissioning.

1. Export the configured Helium mapping and save the final migration reconciliation report.
2. Confirm every tagged applicant has the expected Creator and CreatorApplication records.
3. Test the native application-through-publishing workflow with a dedicated customer on an unpublished duplicate theme.
4. Point the duplicate theme navigation to the native Become a Creator page and verify rollback navigation.
5. After merchant approval, disable the Helium form block and only creator-related Flow workflows. Do not delete them.
6. Keep Helium installed for seven days and monitor application/webhook audit events.
7. Roll back by re-enabling the Helium block/workflows and restoring old navigation; imported records remain intact.
8. Only after a second explicit approval, uninstall Helium and archive obsolete workflows. Retain metafield definitions pending data-retention review.
