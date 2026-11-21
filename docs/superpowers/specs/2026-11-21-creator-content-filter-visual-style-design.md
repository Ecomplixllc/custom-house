# Creator Content Filter Visual Style

## Intent

Bring the Creator Content filter selections in line with the Custom House storefront style shown in Image 9: dark surfaces, purple interaction states, lime highlights, strong compact typography, and clear removable selections.

## Goals

- Restyle active filter chips as branded, rounded pills with a purple surface, lime accent, and a visually distinct remove icon.
- Restyle filter checkbox rows with custom square controls, branded checked and hover states, and clear keyboard focus treatment.
- Keep labels readable and controls comfortable to use on desktop and mobile.
- Preserve existing filtering, search, pagination, URL state, clear-all behavior, and mobile drawer behavior.

## Non-goals

- No changes to available filter values, filtering logic, product results, or sorting.
- No broader Creator Content page redesign.
- No changes to Shopify product or collection data.

## Approaches considered

1. Restyle only the active chips. This is the smallest change but leaves the checkbox controls visually disconnected from the storefront.
2. Restyle active chips and checkbox rows. This was selected because it creates one consistent filter system without changing behavior.
3. Replace filter rows with large graphical cards. This would add unnecessary density and reduce the number of options visible at once.

## Selected design

- Active chips: pill shape, dark-to-purple background, purple border/glow, uppercase compact text, lime remove affordance, and branded hover/focus states.
- Checkbox rows: custom dark square checkbox, purple checked fill, lime checkmark, subtle row hover surface, and lime keyboard focus outline.
- Reduced-motion users will not receive decorative transitions.
- Existing HTML inputs remain in place for accessibility and event handling; CSS changes their presentation rather than replacing filter logic.

## Validation

- Add a regression test for the branded active-chip and checkbox style hooks before implementation.
- Run the focused Creator Content test, then the complete test, lint, typecheck, and build commands.
- Visually verify desktop and mobile layouts before release.
