export const PUBLIC_STOREFRONT_NAV_ITEMS = [
  {
    key: "t-shirts",
    label: "T-SHIRTS",
    href: "/collections/t-shirts",
  },
  {
    key: "hoodies",
    label: "HOODIES",
    href: "/collections/hoodies",
  },
  {
    key: "design-selv",
    label: "DESIGN SELV",
    href: "/pages/design-selv",
  },
  {
    key: "inspiration",
    label: "INSPIRATION",
    href: "/blogs/news",
  },
  {
    key: "design-your-own",
    label: "DESIGN YOUR OWN",
    href: "/pages/collections",
  },
  {
    key: "creator-content",
    label: "CREATOR CONTENT",
    href: "/apps/customhouse/creator-content",
  },
] as const;

export type PublicStorefrontNavKey =
  (typeof PUBLIC_STOREFRONT_NAV_ITEMS)[number]["key"];
