import db from "../db.server.ts";
import { DomainError } from "./domain.ts";
import {
  creatorProductSetupFromRecord,
  prepareCreatorProductCart,
  publicCreatorCollection,
  publicCreatorProductDetail,
  getPublishedCreatorProduct,
  listPublishedCreatorProductsForHandle,
} from "./creator-products.server.ts";
import type { ShopifyGraphqlClient } from "./shopify-graphql.server.ts";
import {
  getCreatorCollectionStorefrontUrl,
  getCreatorProductStorefrontUrl,
} from "./creator-storefront-urls.ts";
import { normalizeCustomerGid } from "./helium-sync.ts";
import { formatMinorMoney } from "./money.ts";
import { listPublicCreatorDirectory } from "./creator-discovery.server.ts";
import { loadPublicCreatorContent } from "./creator-content.server.ts";

const SAFE_HEADERS = {
  "Cache-Control": "no-store",
  "Content-Type": "application/json; charset=utf-8",
  "Referrer-Policy": "same-origin",
  "X-Content-Type-Options": "nosniff",
} as const;

const DEFAULT_HEADER_LOGO_URL =
  "https://customhouse.se/cdn/shop/files/Screenshot_43-removebg-preview.png?width=900";
const DEFAULT_FOOTER_BACKGROUND_URL =
  "https://customhouse.se/cdn/shop/files/ChatGPT_Image_Jun_27_2026_06_10_23_PM.png?width=2400";

export type VerifiedProxyContext = {
  shop: string;
  customerId: string | null;
  client?: ShopifyGraphqlClient;
};

export type ProxyAuthenticator = (
  request: Request,
) => Promise<VerifiedProxyContext>;

type ProxyRoute =
  | { kind: "base" }
  | { kind: "creatorContent" }
  | { kind: "creators" }
  | { kind: "creator"; creatorHandle: string }
  | { kind: "creatorProduct"; creatorHandle: string; creatorProductId: string }
  | { kind: "creatorProductCart"; creatorHandle: string; creatorProductId: string }
  | { kind: "design"; designSlug: string }
  | { kind: "designCart"; designId: string }
  | { kind: "notFound" };

type SiteHeaderAccount =
  | { loggedIn: false }
  | {
      loggedIn: true;
      displayName: string | null;
      hasCreatorDashboard: boolean;
    };

function success(data: Record<string, unknown>, status = 200): Response {
  return Response.json(
    { ok: true, success: true, ...data },
    { status, headers: SAFE_HEADERS },
  );
}

function failure(code: string, message: string, status: number): Response {
  return Response.json(
    { ok: false, success: false, error: { code, message } },
    { status, headers: SAFE_HEADERS },
  );
}

function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "text/html; charset=utf-8",
      "Referrer-Policy": "same-origin",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function wantsJson(request: Request) {
  const url = new URL(request.url);
  return (
    url.searchParams.get("format") === "json" ||
    (request.headers.get("accept") || "").includes("application/json")
  );
}

function escapeHtml(value: unknown) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatMoney(amount: string, currencyCode: string) {
  const value = Number(amount);
  const minor = BigInt(Math.round((Number.isFinite(value) ? value : 0) * 100));
  return formatMinorMoney(minor, currencyCode);
}

function formatMinorAmount(amountMinor: bigint, currencyCode: string) {
  return formatMinorMoney(amountMinor, currencyCode);
}

function methodLabel(method: string) {
  if (method === "EMBROIDERY") return "Embroidery";
  if (method === "DTF") return "DTF printing";
  if (method === "DTG") return "DTG printing";
  return method;
}

function jsonAttr(value: unknown) {
  return escapeHtml(JSON.stringify(value));
}

export function collectionShareTargets(
  collectionUrl: string,
  shareText = "Shop this CustomHouse creator collection.",
) {
  const url = String(collectionUrl || "").trim();
  const text = String(shareText || "Shop this CustomHouse creator collection.").trim();
  return {
    facebook: `https://www.facebook.com/sharer/sharer.php?${new URLSearchParams({ u: url }).toString()}`,
    x: `https://twitter.com/intent/tweet?${new URLSearchParams({ url, text }).toString()}`,
    whatsapp: `https://wa.me/?${new URLSearchParams({ text: `${text} ${url}` }).toString()}`,
    linkedin: `https://www.linkedin.com/sharing/share-offsite/?${new URLSearchParams({ url }).toString()}`,
  };
}

function swatchColor(value: string) {
  const key = value.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const colors: Record<string, string> = {
    black: "#050505",
    white: "#f4f4f5",
    gray: "#6f6f6f",
    grey: "#6f6f6f",
    navy: "#12243d",
    green: "#156044",
    blue: "#2457d6",
    beige: "#c9b99a",
    purple: "#8a2cff",
    red: "#dd201c",
    pink: "#e66da3",
    orange: "#e37822",
    yellow: "#f2cf28",
    brown: "#69452c",
  };
  return colors[key] || "#555555";
}

function productPreviewImages(input: {
  previewUrl: string | null;
  previewUrls?: string | null;
}) {
  const images = new Set<string>();
  if (input.previewUrl?.startsWith("https://")) images.add(input.previewUrl);
  try {
    const parsed = JSON.parse(input.previewUrls || "[]");
    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        if (typeof item === "string" && item.startsWith("https://")) {
          images.add(item);
        }
      }
    }
  } catch {
    // Ignore malformed preview history; previewUrl remains the safe fallback.
  }
  return [...images];
}

function publicImageUrl(value: string | null | undefined) {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

type PublicSocialPlatform =
  | "instagram"
  | "facebook"
  | "tiktok"
  | "youtube"
  | "x"
  | "website";

type PublicCreatorSocialLink = {
  platform: PublicSocialPlatform;
  label: string;
  url: string;
  icon: string;
};

const SOCIAL_PLATFORM_META: Record<
  PublicSocialPlatform,
  { label: string; icon: string }
> = {
  instagram: { label: "Instagram", icon: "photo_camera" },
  facebook: { label: "Facebook", icon: "groups" },
  tiktok: { label: "TikTok", icon: "music_note" },
  youtube: { label: "YouTube", icon: "smart_display" },
  x: { label: "X", icon: "alternate_email" },
  website: { label: "Website", icon: "link" },
};

function publicLinkUrl(value: unknown) {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" || url.protocol === "http:"
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

function parseSocialLinksJson(value: unknown) {
  if (typeof value !== "string" || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === "string") : [];
  } catch {
    return value
      .split(/[\s,\r\n]+/)
      .map((item) => item.trim())
      .filter(Boolean);
  }
}

function socialPlatformForUrl(
  url: string,
  fallback?: string | null,
): PublicSocialPlatform {
  const platform = String(fallback || "").toLowerCase();
  const host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  if (host.includes("instagram.com") || platform.includes("instagram")) return "instagram";
  if (host.includes("facebook.com") || host.includes("fb.com") || platform.includes("facebook")) return "facebook";
  if (host.includes("tiktok.com") || platform.includes("tiktok")) return "tiktok";
  if (host.includes("youtube.com") || host.includes("youtu.be") || platform.includes("youtube")) return "youtube";
  if (host === "x.com" || host.includes("twitter.com") || platform === "x" || platform.includes("twitter")) return "x";
  return "website";
}

export function publicCreatorSocialLinks(creator: {
  portfolioUrl?: string | null;
  socialLinksJson?: string | null;
  primaryPlatform?: string | null;
  primaryProfileUrl?: string | null;
}) {
  const candidates = [
    {
      value: creator.primaryProfileUrl,
      platform: creator.primaryPlatform,
    },
    ...parseSocialLinksJson(creator.socialLinksJson).map((value) => ({
      value,
      platform: null,
    })),
    {
      value: creator.portfolioUrl,
      platform: "website",
    },
  ];
  const seenUrls = new Set<string>();
  const seenPlatforms = new Set<PublicSocialPlatform>();
  const links: PublicCreatorSocialLink[] = [];
  for (const candidate of candidates) {
    const url = publicLinkUrl(candidate.value);
    if (!url || seenUrls.has(url)) continue;
    const platform = socialPlatformForUrl(url, candidate.platform);
    if (seenPlatforms.has(platform)) continue;
    const meta = SOCIAL_PLATFORM_META[platform];
    seenUrls.add(url);
    seenPlatforms.add(platform);
    links.push({ platform, label: meta.label, icon: meta.icon, url });
  }
  return links;
}

function cssString(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/[\r\n]/g, "");
}

function heroBackgroundAttr(imageUrl: string | null) {
  if (!imageUrl) return "";
  const style = `background-image: linear-gradient(90deg, rgba(0,0,0,.82) 0%, rgba(0,0,0,.62) 45%, rgba(0,0,0,.30) 100%), url("${cssString(imageUrl)}");`;
  return ` style="${escapeHtml(style)}"`;
}

function socialLinksHtml(creator: Parameters<typeof publicCreatorSocialLinks>[0]) {
  const links = publicCreatorSocialLinks(creator);
  if (!links.length) return "";
  return `<nav class="customhouse-public-socials" aria-label="Creator social links">
    ${links
      .map(
        (link) =>
          `<a class="customhouse-public-social" data-social-platform="${escapeHtml(link.platform)}" href="${escapeHtml(link.url)}" target="_blank" rel="noopener noreferrer" aria-label="${escapeHtml(link.label)}">
            <span class="material-symbols-outlined" aria-hidden="true">${escapeHtml(link.icon)}</span>
          </a>`,
      )
      .join("")}
  </nav>`;
}

function publicSocialLinksRecord(
  creator: Parameters<typeof publicCreatorSocialLinks>[0],
) {
  return Object.fromEntries(
    publicCreatorSocialLinks(creator).map((link) => [link.platform, link.url]),
  );
}

function publicCss() {
  return `<style>
    [data-customhouse]{--ch-primary:#8a2cff;--ch-primary-2:#5b22e8;--ch-service:#c8ff00;--ch-text:#f8fafc;--ch-muted:#b8bfd0;--ch-border:rgba(255,255,255,.13);--ch-soft:#151515;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:var(--ch-text);letter-spacing:0}
    .material-symbols-outlined{font-family:"Material Symbols Outlined";font-weight:400;font-style:normal;font-size:1.25rem;line-height:1;letter-spacing:normal;text-transform:none;display:inline-flex;align-items:center;justify-content:center;white-space:nowrap;word-wrap:normal;direction:ltr;-webkit-font-feature-settings:"liga";-webkit-font-smoothing:antialiased;font-variation-settings:"FILL" 0,"wght" 600,"GRAD" 0,"opsz" 24}
    body:has([data-customhouse]){margin:0;background:radial-gradient(circle at 78% 4%,#16081f 0,#080808 34%,#030303 100%);color:var(--ch-text)}
    .customhouse-header{--customhouse-header-height:86px;--customhouse-header-pad-x:clamp(24px,4.4vw,58px);--customhouse-header-text:#fff;position:relative;z-index:50;background:#101010;color:var(--customhouse-header-text);font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
    .customhouse-header__inner{display:grid;grid-template-columns:1fr auto 1fr;align-items:center;width:min(100%,1440px);min-height:var(--customhouse-header-height);margin:0 auto;padding:20px var(--customhouse-header-pad-x) 12px;box-sizing:border-box}
    .customhouse-header__logo,.customhouse-header__nav a,.customhouse-header__icon,.customhouse-mobile-drawer__link,.customhouse-mobile-drawer__action{color:inherit;text-decoration:none}
    .customhouse-header__logo{display:inline-flex;align-items:center;gap:10px;justify-self:start;min-width:0}
    .customhouse-header__mark{display:inline-grid;place-items:center;width:74px;height:45px;color:#fff;line-height:1}
    .customhouse-header__mark svg{display:block;width:100%;height:100%;fill:currentColor}
    .customhouse-header__wordmark{font-family:Impact,Haettenschweiler,"Arial Narrow Bold",sans-serif;font-size:clamp(1.7rem,2.45vw,2.45rem);font-weight:900;letter-spacing:-.055em;line-height:.85;color:#fff;text-transform:uppercase}
    .customhouse-header__nav{display:flex;align-items:center;justify-content:center;gap:clamp(28px,4.5vw,58px)}
    .customhouse-header__nav a{font-size:clamp(.94rem,1.15vw,1.15rem);font-weight:950;text-transform:uppercase;letter-spacing:-.02em;transition:color .18s ease,transform .18s ease}
    .customhouse-header__nav a:hover,.customhouse-header__nav a:focus-visible{color:#c8ff00;transform:translateY(-1px);outline:0}
    .customhouse-header__actions{display:flex;align-items:center;justify-content:flex-end;gap:clamp(14px,2vw,22px)}
    .customhouse-header__icon{position:relative;display:inline-grid;place-items:center;width:34px;height:34px;border:0;background:transparent;color:#fff;padding:0;cursor:pointer}
    .customhouse-header__icon svg{display:block;width:28px;height:28px;fill:none;stroke:currentColor;stroke-width:2.4;stroke-linecap:round;stroke-linejoin:round}
    .customhouse-header__cart-count{position:absolute;right:-6px;bottom:-4px;display:grid;place-items:center;min-width:17px;height:17px;padding:0 4px;border-radius:999px;background:#fff;color:#111;font-size:.68rem;font-weight:950;line-height:1}
    .customhouse-header__menu-button{display:none}
    .customhouse-mobile-drawer{position:fixed;inset:0;z-index:70;display:grid;grid-template-columns:minmax(260px,82vw) 1fr;pointer-events:none;visibility:hidden}
    .customhouse-mobile-drawer.is-open{pointer-events:auto;visibility:visible}
    .customhouse-mobile-drawer__panel{height:100%;padding:22px;background:#0b0b0c;box-shadow:22px 0 60px rgba(0,0,0,.42);transform:translateX(-100%);transition:transform .22s ease}
    .customhouse-mobile-drawer.is-open .customhouse-mobile-drawer__panel{transform:translateX(0)}
    .customhouse-mobile-drawer__backdrop{background:rgba(0,0,0,.62);opacity:0;transition:opacity .22s ease}
    .customhouse-mobile-drawer.is-open .customhouse-mobile-drawer__backdrop{opacity:1}
    .customhouse-mobile-drawer__top{display:flex;align-items:center;justify-content:space-between;gap:1rem;margin-bottom:2rem}
    .customhouse-mobile-drawer__close{display:grid;place-items:center;width:42px;height:42px;border:1px solid rgba(255,255,255,.15);border-radius:999px;background:rgba(255,255,255,.04);color:#fff}
    .customhouse-mobile-drawer__close svg{width:22px;height:22px;stroke:currentColor;stroke-width:2.5;stroke-linecap:round}
    .customhouse-mobile-drawer__nav{display:grid;gap:.6rem}
    .customhouse-mobile-drawer__link,.customhouse-mobile-drawer__action{display:flex;align-items:center;justify-content:space-between;min-height:48px;border-bottom:1px solid rgba(255,255,255,.1);color:#fff;font-size:1rem;font-weight:950;text-transform:uppercase}
    .customhouse-mobile-drawer__action{margin-top:1rem;border:1px solid rgba(138,44,255,.55);border-radius:10px;padding:0 1rem;background:rgba(138,44,255,.14)}
    .customhouse-global-footer{position:relative;z-index:1;margin-top:0;min-height:180px;padding:56px clamp(24px,6vw,72px);background:#050506;color:#f4f4f2;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;overflow:hidden}
    .customhouse-global-footer::before{content:"";position:absolute;top:10px;left:clamp(24px,6vw,80px);right:clamp(24px,6vw,80px);height:2px;background:#7d3cc7;box-shadow:0 0 12px #7d3cc7;opacity:.9}
    .customhouse-global-footer::after{content:"";position:absolute;inset:0;background:radial-gradient(circle at 12% 72%,rgba(125,60,199,.26),transparent 24%),radial-gradient(circle at 88% 45%,rgba(200,255,0,.1),transparent 18%),repeating-linear-gradient(90deg,rgba(255,255,255,.035) 0 1px,transparent 1px 6px);opacity:.45;pointer-events:none}
    .customhouse-global-footer__inner{position:relative;z-index:1;display:flex;align-items:center;justify-content:space-between;gap:2rem;max-width:1440px;margin:0 auto}
    .customhouse-global-footer__heading{margin:0 0 1rem;color:#fff;font-size:.95rem;font-weight:950;text-transform:uppercase}
    .customhouse-global-footer__socials,.customhouse-global-footer__links{display:flex;align-items:center;flex-wrap:wrap;gap:14px}
    .customhouse-global-footer__social{display:grid;place-items:center;width:40px;height:40px;border-radius:999px;color:#fff;text-decoration:none}
    .customhouse-global-footer__social svg{width:30px;height:30px;fill:none;stroke:currentColor;stroke-width:2}
    .customhouse-global-footer__links a{color:#f4f4f2;text-decoration:none;font-size:.95rem;font-weight:950;text-transform:uppercase;letter-spacing:.02em}
    .customhouse-global-footer__links a+a::before{content:"|";margin-right:14px;color:rgba(244,244,242,.72)}
    .customhouse-public-page,.customhouse-product-page{width:min(1180px,calc(100vw - 2rem));margin:0 auto;padding:0 0 2.5rem}
    .customhouse-public-hero{position:relative;z-index:2;min-height:260px;display:grid;align-content:center;gap:1.25rem;padding:2.15rem clamp(1.1rem,4vw,3rem) 2.35rem;border:1px solid rgba(255,255,255,.1);border-radius:0 0 12px 12px;background:radial-gradient(circle at 78% 20%,rgba(138,44,255,.16),transparent 28%),linear-gradient(100deg,#09090a 0%,#050506 46%,rgba(18,18,20,.92) 100%);overflow:visible}
    .customhouse-public-hero--with-banner{background-size:cover;background-position:center;background-repeat:no-repeat;background-origin:border-box;background-clip:border-box}
    .customhouse-public-hero::after{content:"";position:absolute;inset:0;background:linear-gradient(135deg,transparent 0 52%,rgba(200,255,0,.035) 52% 56%,transparent 56%);pointer-events:none}
    .customhouse-public-hero-copy{position:relative;z-index:3;max-width:470px}
    .customhouse-public-hero span,.customhouse-public-link{color:var(--ch-primary);font-size:.78rem;font-weight:800;text-transform:uppercase;text-decoration:none}
    .customhouse-public-hero h1{margin:.15rem 0 0;font-size:clamp(3rem,7vw,5.2rem);line-height:.88;text-transform:uppercase;font-family:Impact,Haettenschweiler,"Arial Narrow Bold",sans-serif;font-style:italic;font-weight:900}
    .customhouse-product-panel h1{margin:.15rem 0 0;font-size:clamp(1.85rem,3.4vw,3rem);line-height:1.02;text-transform:uppercase;font-family:Impact,Haettenschweiler,"Arial Narrow Bold",sans-serif;font-style:italic;font-weight:900}
    .customhouse-public-hero p,.customhouse-product-panel p{color:var(--ch-muted);line-height:1.45}
    .customhouse-public-socials{display:flex;flex-wrap:wrap;gap:.55rem;margin-top:1rem}
    .customhouse-public-social{display:grid;place-items:center;width:38px;height:38px;border:1px solid rgba(255,255,255,.14);border-radius:999px;background:rgba(255,255,255,.08);color:#fff;text-decoration:none;transition:background .18s ease,border-color .18s ease,color .18s ease,transform .18s ease}
    .customhouse-public-social:hover{border-color:rgba(200,255,0,.52);background:rgba(255,255,255,.14);color:var(--ch-service);transform:translateY(-1px)}
    .customhouse-public-social .material-symbols-outlined{color:inherit;font-size:1.18rem}
    .customhouse-public-stats{display:flex;flex-wrap:wrap;gap:.85rem;margin-top:1.2rem}
    .customhouse-public-stat{display:flex;align-items:center;justify-content:center;text-align:left;gap:.55rem;min-width:118px;padding:.72rem .8rem;border:1px solid rgba(200,255,0,.34);border-radius:10px;background:linear-gradient(180deg,rgba(200,255,0,.07),rgba(255,255,255,.02))}
    .customhouse-public-stat-icon{display:inline-flex;align-items:center;justify-content:center;width:auto;height:auto;color:var(--ch-service);background:transparent}
    .customhouse-public-stat-icon.material-symbols-outlined{font-size:1.8rem}
    .customhouse-public-stat strong{display:block;color:var(--ch-service);font-size:1.35rem;line-height:1}
    .customhouse-public-stat span{display:block;color:#fff;font-size:.7rem;font-weight:950;line-height:1;text-transform:uppercase}
    .customhouse-public-share{position:relative;z-index:40;display:flex;flex-wrap:wrap;align-items:center;gap:.65rem;margin-top:1rem;isolation:isolate}
    .customhouse-public-share-toggle,.customhouse-public-share-copy,.customhouse-public-share-menu a,.customhouse-public-share-menu button{display:inline-flex;align-items:center;justify-content:center;min-height:38px;border-radius:8px;font-size:.78rem;font-weight:950;text-decoration:none;text-transform:uppercase;cursor:pointer}
    .customhouse-public-share-toggle,.customhouse-public-share-copy{gap:.45rem;padding:.6rem .85rem;border:1px solid rgba(200,255,0,.52);background:rgba(200,255,0,.08);color:#fff}
    .customhouse-public-share-copy{border-color:rgba(138,44,255,.85);background:rgba(138,44,255,.12)}
    .customhouse-public-share-status{min-height:1.2rem;margin:0;color:var(--ch-service);font-size:.78rem;font-weight:850}
    .customhouse-public-share-menu{position:absolute;left:0;top:calc(100% + 8px);z-index:80;display:grid;width:min(220px,calc(100vw - 2rem));gap:4px;padding:.45rem;border:1px solid var(--ch-border);border-radius:8px;background:#080809;box-shadow:0 18px 42px rgba(0,0,0,.32)}
    .customhouse-public-share-menu[hidden]{display:none}
    .customhouse-public-share-menu a,.customhouse-public-share-menu button{width:100%;justify-content:flex-start;padding:.58rem .68rem;border:0;background:transparent;color:#fff;text-align:left;box-shadow:none}
    .customhouse-public-share-menu a:hover,.customhouse-public-share-menu a:focus,.customhouse-public-share-menu button:hover,.customhouse-public-share-menu button:focus{background:rgba(138,44,255,.18);color:var(--ch-service)}
    .customhouse-public-services{position:relative;z-index:1;display:grid;grid-template-columns:repeat(4,minmax(0,1fr));margin:0 0 1.5rem;border:1px solid var(--ch-border);border-radius:12px;background:linear-gradient(180deg,rgba(255,255,255,.045),rgba(255,255,255,.02));overflow:hidden}
    .customhouse-public-service{display:flex;align-items:center;justify-content:center;text-align:left;gap:.85rem;padding:1.25rem 1.35rem}
    .customhouse-public-service+.customhouse-public-service{border-left:1px solid var(--ch-border)}
    .customhouse-public-service-icon{display:inline-flex;align-items:center;justify-content:center;width:auto;height:auto;background:transparent;color:var(--ch-service)}
    .customhouse-public-service-icon.material-symbols-outlined{font-size:1.9rem}
    .customhouse-public-service strong{display:block;color:#fff;font-size:.78rem;text-transform:uppercase}
    .customhouse-public-service span{display:block;color:var(--ch-muted);font-size:.83rem;margin-top:.18rem}
    .customhouse-public-toolbar{display:flex;align-items:center;justify-content:space-between;gap:1rem;margin:0 0 1.1rem}
    .customhouse-public-filter,.customhouse-public-sort{min-width:132px;border:1px solid var(--ch-border);border-radius:8px;background:rgba(255,255,255,.045);padding:.78rem .95rem;color:#fff;font-weight:850}
    .customhouse-public-filter small{display:block;color:#fff;font-size:.66rem;text-transform:uppercase}
    .customhouse-public-filter span{display:flex;justify-content:space-between;color:var(--ch-muted);font-size:.86rem;margin-top:.25rem}
    .customhouse-public-toolbar-right{display:flex;align-items:center;gap:.65rem}
    .customhouse-public-sort{display:flex;align-items:center;justify-content:space-between;gap:1rem;min-width:180px}
    .customhouse-public-view{display:flex;border:1px solid var(--ch-border);border-radius:8px;overflow:hidden;background:rgba(255,255,255,.04)}
    .customhouse-public-view span{display:grid;place-items:center;width:44px;height:44px;color:#b9bdc8}
    .customhouse-public-view span:first-child{background:var(--ch-primary);color:#fff}
    .customhouse-public-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:1rem}
    .customhouse-public-card{position:relative;display:grid;grid-template-rows:auto 1fr;border:1px solid rgba(255,255,255,.11);border-radius:8px;background:linear-gradient(150deg,rgba(255,255,255,.04),rgba(0,0,0,.92));overflow:hidden;text-decoration:none;color:#fff;min-width:0}
    .customhouse-public-card-favorite{position:absolute;right:.8rem;top:.8rem;display:grid;place-items:center;width:34px;height:34px;border:1px solid rgba(138,44,255,.8);border-radius:999px;background:rgba(0,0,0,.5);color:var(--ch-primary);z-index:1}
    .customhouse-public-card-media{display:grid;place-items:center;aspect-ratio:1/1;background:linear-gradient(145deg,rgba(255,255,255,.08),#101012 46%,#080809);overflow:hidden}
    .customhouse-public-card img,.customhouse-product-media img{width:100%;height:100%;object-fit:cover}
    .customhouse-public-card-media img{object-fit:contain;object-position:center center;padding:.35rem}
    .customhouse-public-card-body{display:grid;gap:.45rem;padding:.85rem}
    .customhouse-public-card h3{min-height:2.34em;margin:0;color:#fff;font-size:.96rem;font-weight:950;line-height:1.17;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
    .customhouse-public-card p{margin:0;color:var(--ch-muted);font-size:.82rem;line-height:1.3}
    .customhouse-public-card strong{display:block;color:var(--ch-service);font-size:.95rem;font-weight:950}
    .customhouse-public-button,.customhouse-product-panel button{display:inline-flex;align-items:center;justify-content:center;border-radius:8px;font-weight:900;text-decoration:none;cursor:pointer}
    .customhouse-public-button{min-height:36px;border:1px solid rgba(138,44,255,.9);color:var(--ch-primary);font-size:.72rem;text-transform:uppercase}
    .customhouse-product-page{padding:3rem 0}
    .customhouse-product-layout{display:grid;grid-template-columns:minmax(0,1.2fr) minmax(330px,.8fr);gap:3rem;align-items:start}
    .customhouse-product-gallery{display:grid;grid-template-columns:92px minmax(0,1fr);gap:1rem}
    .customhouse-product-thumbs{display:grid;align-content:start;gap:.75rem}
    .customhouse-product-thumb{display:grid;place-items:center;aspect-ratio:1/1;border:1px solid rgba(255,255,255,.18);border-radius:8px;background:#111;overflow:hidden;padding:0;cursor:pointer}
    .customhouse-product-thumb.is-active{border-color:var(--ch-primary);box-shadow:0 0 0 1px rgba(138,44,255,.35)}
    .customhouse-product-thumb img{width:100%;height:100%;object-fit:cover}
    .customhouse-product-media{display:grid;place-items:center;aspect-ratio:1/1;border:1px solid var(--ch-border);border-radius:8px;background:repeating-linear-gradient(135deg,#202020 0,#202020 2px,#1a1a1a 2px,#1a1a1a 7px);overflow:hidden}
    .customhouse-product-media img{object-fit:contain;padding:2rem}
    .customhouse-service-row{display:grid;grid-template-columns:repeat(3,1fr);margin-top:1rem;border:1px solid var(--ch-border);border-radius:8px;background:linear-gradient(180deg,rgba(255,255,255,.055),rgba(255,255,255,.025));overflow:hidden}
    .customhouse-service-row span{display:grid;gap:.1rem;padding:1rem 1.15rem;color:var(--ch-muted);font-size:.78rem}
    .customhouse-service-row span+span{border-left:1px solid var(--ch-border)}
    .customhouse-service-row strong{color:#fff;font-size:.76rem;text-transform:uppercase}
    .customhouse-product-panel{display:grid;gap:1.15rem;padding:.25rem 0 0}
    .customhouse-creator-line{display:flex;align-items:center;flex-wrap:wrap;gap:.45rem;color:var(--ch-primary);font-size:.9rem;font-weight:900}
    .customhouse-verified{display:inline-grid;place-items:center;width:18px;height:18px;border-radius:999px;background:var(--ch-primary);color:#fff;font-size:.72rem}
    .customhouse-product-price{margin:0;color:var(--ch-primary)!important;font-size:clamp(2rem,4vw,2.6rem);font-weight:950;line-height:1}
    .customhouse-product-description{max-width:36rem;margin:0;padding-bottom:1.2rem;border-bottom:1px solid var(--ch-border);font-size:1rem}
    .customhouse-locked-note{display:none}
    .customhouse-locked-details{display:grid;gap:.55rem;margin:0;padding:1rem;border:1px solid var(--ch-border);border-radius:8px;background:rgba(255,255,255,.045)}
    .customhouse-locked-details div{display:flex;align-items:center;justify-content:space-between;gap:1rem}
    .customhouse-locked-details dt{color:var(--ch-muted);font-size:.72rem;font-weight:950;text-transform:uppercase}
    .customhouse-locked-details dd{display:inline-flex;align-items:center;gap:.45rem;margin:0;color:#fff;font-weight:900;text-align:right}
    .customhouse-made-to-order-note{margin:0;color:var(--ch-muted);font-size:.86rem;line-height:1.42}
    .customhouse-acknowledgement{display:flex;align-items:flex-start;gap:.65rem;color:var(--ch-text);font-size:.86rem;font-weight:650;line-height:1.42;text-transform:none}
    .customhouse-acknowledgement input{width:18px;height:18px;margin:.1rem 0 0;accent-color:var(--ch-primary)}
    .customhouse-acknowledgement a{color:var(--ch-service)}
    .customhouse-product-form{display:grid;gap:1rem}
    .customhouse-field{display:grid;gap:.65rem;margin:0;font-weight:850;text-transform:uppercase}
    .customhouse-field select{position:absolute;width:1px;height:1px;opacity:0;pointer-events:none}
    .customhouse-option-header{display:flex;justify-content:space-between;gap:1rem;color:#fff;font-size:.78rem}
    .customhouse-option-header strong{color:var(--ch-muted)}
    .customhouse-option-pills{display:flex;flex-wrap:wrap;gap:.65rem}
    .customhouse-option-pill{display:inline-flex;align-items:center;justify-content:center;flex-wrap:wrap;gap:.35rem;min-height:42px;border:1px solid rgba(138,44,255,.8);background:transparent;color:#fff;padding:.65rem 1rem;text-transform:uppercase;font-weight:850}
    .customhouse-option-pill.is-active{background:var(--ch-primary);border-color:var(--ch-primary);box-shadow:0 0 0 1px rgba(138,44,255,.35),0 10px 22px rgba(138,44,255,.24)}
    .customhouse-option-pill__price{font-size:.78rem;line-height:1;opacity:.82;text-transform:none;white-space:nowrap}
    .customhouse-field--color .customhouse-option-pill{min-height:58px;gap:.65rem;border-color:rgba(255,255,255,.18);background:rgba(255,255,255,.045);padding:.55rem .95rem .55rem .55rem}
    .customhouse-field--color .customhouse-option-pill.is-active{border-color:var(--ch-primary);background:rgba(138,44,255,.28)}
    .customhouse-swatch{width:40px;height:40px;border-radius:999px;border:1px solid rgba(255,255,255,.34);background:var(--ch-swatch,#555)}
    .customhouse-qty-row{display:flex;align-items:center;gap:.75rem}
    .customhouse-qty{display:inline-flex;align-items:center;border:1px solid rgba(255,255,255,.18);border-radius:8px;background:rgba(255,255,255,.045);overflow:hidden}
    .customhouse-qty button{width:42px;min-height:38px;border:0;background:transparent;color:#fff;font-size:1.2rem}
    .customhouse-qty input{width:52px;min-height:38px;border:0;background:transparent;color:#fff;text-align:center;font:inherit;font-weight:900}
    .customhouse-add-button{width:100%;min-height:56px;border:1px solid var(--ch-service);background:#000;color:#fff;text-transform:uppercase}
    .customhouse-more{position:relative;margin-top:2rem;border:1px solid rgba(138,44,255,.42);border-radius:14px;background:radial-gradient(circle at 82% 30%,rgba(200,255,0,.12),transparent 28%),linear-gradient(180deg,rgba(138,44,255,.12),rgba(255,255,255,.02));padding:2rem clamp(1rem,3vw,2rem) 1.35rem;overflow:hidden}
    .customhouse-more[hidden]{display:none}
    .customhouse-more__header{text-align:center;margin:0 auto 1.25rem;max-width:760px}
    .customhouse-more__crown{display:block;color:var(--ch-primary);font-size:1.55rem;line-height:1}
    .customhouse-more__title{display:flex;align-items:center;justify-content:center;flex-wrap:wrap;gap:.75rem;margin:.45rem 0 0;color:#fff;font-size:clamp(1.45rem,3vw,2.15rem);font-weight:950;text-transform:uppercase}
    .customhouse-more__title::before,.customhouse-more__title::after{content:"";display:block;width:46px;height:2px;background:var(--ch-primary)}
    .customhouse-more__title strong{color:var(--ch-service)}
    .customhouse-more__grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:.95rem}
    .customhouse-more__card{position:relative;display:grid;grid-template-rows:auto 1fr auto;gap:.62rem;border:1px solid rgba(138,44,255,.38);border-radius:8px;background:linear-gradient(150deg,rgba(138,44,255,.18),rgba(6,6,10,.95) 42%,rgba(0,0,0,.82));padding:.75rem;text-decoration:none;color:#fff;min-width:0;box-shadow:0 18px 42px rgba(0,0,0,.2)}
    .customhouse-more__card[hidden]{display:none}
    .customhouse-more__favorite{position:absolute;right:.72rem;top:.72rem;display:grid;place-items:center;width:32px;height:32px;border:1px solid rgba(138,44,255,.82);border-radius:999px;background:rgba(0,0,0,.45);color:var(--ch-primary);font-size:1.1rem;line-height:1;z-index:1}
    .customhouse-more__image{display:grid;place-items:center;align-items:center;justify-items:center;justify-self:center;width:min(100%,178px);aspect-ratio:1/1;border-radius:7px;background:linear-gradient(145deg,rgba(138,44,255,.16),#101012 45%,#080809);overflow:hidden}
    .customhouse-more__image img{display:block;width:92%;height:92%;margin:auto;object-fit:contain;object-position:center center;padding:.2rem}
    .customhouse-more__body{display:grid;gap:.5rem;min-width:0}
    .customhouse-more__card h3{min-height:2.34em;margin:0;color:#fff;font-size:.94rem;font-weight:950;line-height:1.17;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
    .customhouse-more__price{display:block;color:var(--ch-service);font-size:.92rem;font-weight:950;text-align:left;white-space:nowrap}
    .customhouse-more__button{display:flex;align-items:center;justify-content:center;min-height:34px;border:1px solid rgba(138,44,255,.9);border-radius:5px;color:var(--ch-primary);font-size:.72rem;font-weight:950;text-transform:uppercase}
    .customhouse-more__controls{display:flex;justify-content:center;gap:8rem;margin-top:1rem}
    .customhouse-more__arrow{width:38px;height:38px;border:1px solid var(--ch-primary);border-radius:999px;background:rgba(0,0,0,.2);color:var(--ch-primary);font-size:1.45rem;line-height:1}
    [data-customhouse-cart-message],.customhouse-public-empty{color:var(--ch-muted)}
    @media(max-width:1100px){.customhouse-public-grid,.customhouse-more__grid{grid-template-columns:repeat(3,minmax(0,1fr))}.customhouse-public-services{grid-template-columns:repeat(2,minmax(0,1fr))}.customhouse-public-service:nth-child(3){border-left:0;border-top:1px solid var(--ch-border)}.customhouse-public-service:nth-child(4){border-top:1px solid var(--ch-border)}}
    @media(max-width:900px){.customhouse-header{--customhouse-header-height:82px;--customhouse-header-pad-x:clamp(14px,4vw,34px)}.customhouse-header__inner{grid-template-columns:1fr auto;min-height:var(--customhouse-header-height)}.customhouse-header__nav,.customhouse-header__profile-link{display:none}.customhouse-header__menu-button{display:inline-grid}.customhouse-header__mark{width:58px;height:36px}.customhouse-header__wordmark{font-size:clamp(1.28rem,5vw,1.7rem)}.customhouse-header__icon{width:32px;height:32px}.customhouse-header__icon svg{width:26px;height:26px}.customhouse-public-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.customhouse-product-layout{grid-template-columns:1fr;gap:1.5rem}.customhouse-product-page{padding:1rem 0 2rem}.customhouse-product-gallery{display:flex;flex-direction:column-reverse;gap:.75rem}.customhouse-product-thumbs{display:flex;gap:.65rem;overflow-x:auto;scroll-snap-type:x proximity;padding-bottom:.15rem}.customhouse-product-thumb{width:76px;min-width:76px;scroll-snap-align:start}.customhouse-service-row{grid-template-columns:1fr}.customhouse-service-row span+span{border-left:0;border-top:1px solid var(--ch-border)}.customhouse-more__grid{grid-template-columns:repeat(2,minmax(0,1fr))}.customhouse-more__controls{gap:4rem}.customhouse-global-footer__inner{align-items:flex-start;flex-direction:column}.customhouse-global-footer__links{gap:10px 0}.customhouse-global-footer__links a{font-size:.86rem}.customhouse-global-footer__links a+a::before{margin:0 10px}}
    @media(max-width:760px){.customhouse-public-page,.customhouse-product-page{width:min(100vw - 1rem,1180px)}.customhouse-public-hero{min-height:auto;padding:1.35rem 1rem 1.5rem;border-radius:0 0 10px 10px}.customhouse-public-hero h1{font-size:clamp(2.5rem,15vw,4rem)}.customhouse-public-socials{gap:.45rem}.customhouse-public-social{width:36px;height:36px}.customhouse-public-stats{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:.65rem}.customhouse-public-stat{min-width:0;padding:.6rem .58rem;gap:.45rem}.customhouse-public-stat-icon.material-symbols-outlined{font-size:1.6rem}.customhouse-public-share{align-items:stretch;flex-direction:column}.customhouse-public-share-toggle,.customhouse-public-share-copy{width:100%}.customhouse-public-share-menu{position:static;width:100%;margin-top:-.2rem}.customhouse-public-services{grid-template-columns:1fr}.customhouse-public-service+.customhouse-public-service{border-left:0;border-top:1px solid var(--ch-border)}.customhouse-public-service{padding:1.05rem}.customhouse-public-service-icon.material-symbols-outlined{font-size:1.7rem}.customhouse-public-toolbar{align-items:stretch;flex-direction:column}.customhouse-public-toolbar-right{width:100%;justify-content:space-between}.customhouse-public-filter,.customhouse-public-sort{width:100%;min-width:0}.customhouse-public-view{flex:0 0 auto}.customhouse-public-grid{grid-template-columns:1fr}.customhouse-product-panel h1{font-size:clamp(1.9rem,10vw,2.8rem)}.customhouse-product-media img{padding:1rem}.customhouse-option-pill{flex:1 1 auto}.customhouse-field--color .customhouse-option-pill{flex:0 1 calc(50% - .4rem)}.customhouse-more{padding:1.5rem .8rem 1rem}.customhouse-more__title::before,.customhouse-more__title::after{width:28px}.customhouse-more__grid{grid-template-columns:1fr}.customhouse-more__image{max-height:170px}.customhouse-more__card h3{font-size:.9rem}.customhouse-more__button{min-height:32px}}
    .customhouse-header{--customhouse-header-content-width:1600px;--customhouse-logo-width-desktop:390px;--customhouse-logo-mark-width-desktop:133px;--customhouse-logo-mark-height-desktop:47px;--customhouse-logo-wordmark-size-desktop:42px;--customhouse-logo-width-mobile:160px;--customhouse-logo-mark-width-mobile:54px;--customhouse-logo-mark-height-mobile:19px;--customhouse-logo-wordmark-size-mobile:17px;--customhouse-drawer-logo-width:170px;--customhouse-drawer-logo-mark-width:58px;--customhouse-drawer-logo-mark-height:20px;--customhouse-drawer-logo-wordmark-size:18px;--customhouse-drawer-menu-font-size:14px;--customhouse-header-height:132px;--customhouse-header-pad-x:clamp(24px,4.4vw,58px);--customhouse-header-text:#fff;position:relative;z-index:50;display:block;width:100%;color:var(--customhouse-header-text);background:#050505}
    .customhouse-header__inner{box-sizing:border-box;width:min(100%,var(--customhouse-header-content-width));margin-inline:auto;min-height:var(--customhouse-header-height);display:grid;grid-template-columns:auto 1fr auto;align-items:center;gap:clamp(28px,4vw,54px);padding:22px var(--customhouse-header-pad-x) 12px}
    .customhouse-header__logo{--customhouse-logo-width:var(--customhouse-logo-width-desktop);--customhouse-logo-mark-width:var(--customhouse-logo-mark-width-desktop);--customhouse-logo-mark-height:var(--customhouse-logo-mark-height-desktop);--customhouse-logo-wordmark-size:var(--customhouse-logo-wordmark-size-desktop);display:inline-flex;align-items:center;gap:8px;width:var(--customhouse-logo-width);max-width:100%;min-width:0;line-height:1;filter:drop-shadow(0 2px 4px rgb(0 0 0 / .35))}
    .customhouse-header__mark{position:relative;width:var(--customhouse-logo-mark-width);height:var(--customhouse-logo-mark-height);flex:0 0 auto;display:block;color:#fff}
    .customhouse-header__logo-image{display:block;width:100%;height:auto;max-height:72px;object-fit:contain}
    .customhouse-header__wordmark{font-family:Impact,Haettenschweiler,"Arial Narrow Bold","Arial Narrow",sans-serif;font-size:var(--customhouse-logo-wordmark-size);font-weight:900;letter-spacing:0;line-height:1;font-stretch:condensed;white-space:nowrap}
    .customhouse-header__nav{display:flex;align-items:center;justify-content:flex-end;gap:clamp(24px,3.1vw,46px);min-width:0;overflow:hidden}
    .customhouse-header__nav a{font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-size:clamp(14px,1.08vw,17px);font-weight:800;letter-spacing:.015em;line-height:1;white-space:nowrap;text-transform:uppercase;text-shadow:none}
    .customhouse-header__actions{display:flex;align-items:center;gap:clamp(18px,2.1vw,28px);min-width:0;justify-content:flex-end}
    .customhouse-header__icon{position:relative;display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;flex:0 0 auto}
    .customhouse-header__icon svg{width:100%;height:100%;fill:none;stroke:currentColor;stroke-width:3.1;stroke-linecap:round;stroke-linejoin:round;filter:drop-shadow(0 2px 3px rgb(0 0 0 / .35))}
    .customhouse-header__profile{position:relative;display:block;flex:0 0 auto}
    .customhouse-header__profile>summary{box-sizing:border-box;display:inline-flex;width:30px;height:30px;min-width:30px;padding:0;list-style:none;cursor:pointer;border-radius:50%;color:#fff;background:transparent;transition:color .18s ease,background-color .18s ease,transform .18s ease}
    .customhouse-header__profile>summary svg{display:block;width:30px!important;height:30px!important;min-width:30px}
    .customhouse-header__profile>summary:hover,.customhouse-header__profile>summary:focus-visible,.customhouse-header__profile[open]>summary{color:#9bd21a;background:rgb(155 210 26 / .14);box-shadow:0 0 0 5px rgb(155 210 26 / .08);outline:none;transform:scale(1.06)}
    .customhouse-header__profile>summary::-webkit-details-marker{display:none}
    .customhouse-header__profile-menu{position:absolute;top:calc(100% + 14px);right:0;z-index:20;display:grid;gap:4px;width:min(280px,calc(100vw - 32px));padding:12px;border:1px solid rgb(255 255 255 / .14);border-radius:12px;color:#fff;background:rgb(8 9 10 / .98);box-shadow:0 18px 48px rgb(0 0 0 / .38)}
    .customhouse-header__profile-menu a{padding:11px 12px;border-radius:8px;color:inherit;font-weight:700;text-decoration:none}
    .customhouse-header__profile-menu a:hover,.customhouse-header__profile-menu a:focus-visible{color:#111;background:#9bd21a;outline:none}
    .customhouse-header__profile-choice{display:grid;gap:6px;margin-top:2px;padding-block:13px;border-top:1px solid rgb(255 255 255 / .1)}
    .customhouse-header__profile-choice strong{display:block;font:inherit;line-height:1.1}
    .customhouse-header__profile-choice small{display:block;color:rgba(255,255,255,.68);font-size:.74rem;font-weight:500;line-height:1.45;text-transform:none}
    .customhouse-header__profile-choice:hover small,.customhouse-header__profile-choice:focus-visible small{color:#111}
    .customhouse-header__profile-name{margin:0 0 6px;padding:7px 12px 12px;border-bottom:1px solid rgb(255 255 255 / .14);font-size:.875rem;font-weight:800;overflow-wrap:anywhere}
    html.customhouse-mobile-drawer-open,html.customhouse-mobile-drawer-open body{overflow:hidden}
    .customhouse-mobile-drawer__overlay{position:fixed;inset:0;z-index:998;display:block;border:0;background:rgb(0 0 0 / .34);opacity:0;pointer-events:none;transition:opacity .24s ease}
    .customhouse-mobile-drawer__overlay.is-open{opacity:1;pointer-events:auto}
    .customhouse-mobile-drawer{position:fixed;inset:0 0 0 auto;z-index:999;box-sizing:border-box;display:flex;width:min(84vw,420px);max-width:calc(100vw - 24px);height:100vh;height:100dvh;flex-direction:column;overflow-y:auto;padding:clamp(28px,8vw,46px) clamp(20px,5.8vw,34px) 32px;color:#fff;background:radial-gradient(circle at 28% 22%,rgb(255 255 255 / .055),transparent 30%),linear-gradient(145deg,#070707,#121212 56%,#080808);box-shadow:-18px 0 34px rgb(0 0 0 / .42);opacity:0;pointer-events:none;visibility:visible;transform:translateX(105%);transition:transform .28s ease,opacity .24s ease}
    .customhouse-mobile-drawer::before{content:"";position:absolute;inset:0;pointer-events:none;background-image:linear-gradient(90deg,rgb(255 255 255 / .025) 1px,transparent 1px),linear-gradient(0deg,rgb(255 255 255 / .018) 1px,transparent 1px);background-size:19px 23px;opacity:.42}
    .customhouse-mobile-drawer.is-open{opacity:1;pointer-events:auto;transform:translateX(0)}
    .customhouse-mobile-drawer__header,.customhouse-mobile-drawer__nav,.customhouse-mobile-drawer__account{position:relative;z-index:1}
    .customhouse-mobile-drawer__header{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:clamp(34px,9vw,58px)}
    .customhouse-mobile-drawer__logo{--customhouse-logo-width:var(--customhouse-drawer-logo-width);--customhouse-logo-mark-width:var(--customhouse-drawer-logo-mark-width);--customhouse-logo-mark-height:var(--customhouse-drawer-logo-mark-height);--customhouse-logo-wordmark-size:var(--customhouse-drawer-logo-wordmark-size);gap:7px}
    .customhouse-mobile-drawer__close{display:inline-flex;width:clamp(36px,9vw,46px);height:clamp(36px,9vw,46px);align-items:center;justify-content:center;flex:0 0 auto;padding:0;border:0;color:#fff;background:transparent;cursor:pointer}
    .customhouse-mobile-drawer__close svg{width:100%;height:100%;fill:none;stroke:currentColor;stroke-width:2.4;stroke-linecap:round}
    .customhouse-mobile-drawer__nav{display:grid;margin-bottom:clamp(34px,9vw,54px)}
    .customhouse-mobile-drawer__nav a,.customhouse-mobile-drawer__account a{display:grid;grid-template-columns:clamp(30px,8vw,42px) minmax(0,1fr);align-items:center;gap:clamp(12px,3.8vw,20px);color:#fff;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-size:var(--customhouse-drawer-menu-font-size);font-weight:800;letter-spacing:.015em;line-height:1.1;text-decoration:none;text-transform:uppercase}
    .customhouse-mobile-drawer__nav a{min-height:clamp(62px,17vw,86px);border-bottom:1px solid rgb(255 255 255 / .18)}
    .customhouse-mobile-drawer__line-icon{color:#9bd21a}
    .customhouse-mobile-drawer__line-icon svg,.customhouse-mobile-drawer__account-icon svg{width:clamp(24px,6.5vw,34px);height:clamp(24px,6.5vw,34px);fill:none;stroke:currentColor;stroke-width:2.2;stroke-linecap:round;stroke-linejoin:round}
    .customhouse-mobile-drawer__account{display:grid;gap:22px;margin-top:auto;padding-bottom:8px}
    #FooterStrip-customhouse-app{position:relative;isolation:isolate;overflow:hidden;width:100%;min-height:var(--footer-min-height);padding:var(--footer-padding-top) var(--footer-padding-x) var(--footer-padding-bottom);background:var(--footer-bg);color:var(--footer-text);box-sizing:border-box}
    #FooterStrip-customhouse-app::before{content:"";position:absolute;z-index:3;top:var(--footer-line-offset);left:var(--footer-line-inset);right:var(--footer-line-inset);height:var(--footer-line-height);background:var(--footer-accent);opacity:var(--footer-line-opacity);box-shadow:0 0 10px var(--footer-accent)}
    #FooterStrip-customhouse-app .footer-strip__image,#FooterStrip-customhouse-app .footer-strip__texture{position:absolute;inset:0;pointer-events:none}
    #FooterStrip-customhouse-app .footer-strip__image{z-index:0;background-repeat:no-repeat;background-size:cover;opacity:var(--footer-image-opacity)}
    #FooterStrip-customhouse-app .footer-strip__texture{z-index:1;opacity:var(--footer-texture-opacity);background:radial-gradient(circle at 50% 40%,rgba(255,255,255,.22) 0 1px,transparent 1.6px) 0 0/13px 11px,radial-gradient(circle at 40% 60%,rgba(255,255,255,.16) 0 1px,transparent 1.9px) 4px 5px/21px 17px,radial-gradient(ellipse at 58% 42%,rgba(255,255,255,.18),transparent 34%),linear-gradient(90deg,rgba(255,255,255,.04),transparent 18%,rgba(255,255,255,.09) 50%,transparent 82%);mix-blend-mode:screen}
    #FooterStrip-customhouse-app .footer-strip__inner{position:relative;z-index:2;min-height:calc(var(--footer-min-height) - var(--footer-padding-top) - var(--footer-padding-bottom));max-width:var(--footer-max-width);margin:0 auto;display:flex;align-items:center;justify-content:space-between;gap:var(--footer-group-gap);box-sizing:border-box}
    #FooterStrip-customhouse-app .footer-strip__social{display:grid;gap:11px;min-width:max-content}
    #FooterStrip-customhouse-app .footer-strip__heading,#FooterStrip-customhouse-app .footer-strip__link{margin:0;color:var(--footer-text);font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-style:normal;font-weight:var(--footer-text-weight);line-height:1.05;letter-spacing:.015em;text-transform:uppercase;text-decoration:none;text-shadow:none}
    #FooterStrip-customhouse-app .footer-strip__heading{font-size:var(--footer-label-size)}
    #FooterStrip-customhouse-app .footer-strip__icons{display:flex;align-items:center;gap:var(--footer-icon-gap);min-height:var(--footer-icon-size)}
    #FooterStrip-customhouse-app .footer-strip__icon{width:var(--footer-icon-size);height:var(--footer-icon-size);display:inline-flex;align-items:center;justify-content:center;color:var(--footer-text);flex:0 0 auto;text-decoration:none}
    #FooterStrip-customhouse-app .footer-strip__icon svg{width:100%;height:100%;display:block;object-fit:contain;fill:currentColor}
    #FooterStrip-customhouse-app .footer-strip__icon svg rect,#FooterStrip-customhouse-app .footer-strip__icon svg circle{fill:none;stroke:currentColor;stroke-width:2.15}
    #FooterStrip-customhouse-app .footer-strip__icon svg .footer-strip__icon-dot{fill:currentColor;stroke:none}
    #FooterStrip-customhouse-app .footer-strip__icon svg .footer-strip__facebook-circle{fill:currentColor;stroke:none}
    #FooterStrip-customhouse-app .footer-strip__icon svg .footer-strip__facebook-f{fill:var(--footer-icon-cutout)}
    #FooterStrip-customhouse-app .footer-strip__links{display:flex;align-items:center;justify-content:flex-end;flex-wrap:wrap;gap:10px var(--footer-link-gap);max-width:100%}
    #FooterStrip-customhouse-app .footer-strip__link{position:relative;display:inline-flex;align-items:center;min-height:24px;font-size:var(--footer-link-size);white-space:nowrap}
    #FooterStrip-customhouse-app .footer-strip__link+.footer-strip__link::before{content:"";width:2px;height:18px;margin-right:var(--footer-link-gap);background:currentColor;opacity:.55}
    @media screen and (min-width:901px) and (max-width:1500px){.customhouse-header{--customhouse-logo-width-desktop:320px;--customhouse-logo-mark-width-desktop:108px;--customhouse-logo-wordmark-size-desktop:35px}.customhouse-header__inner{gap:clamp(18px,2.2vw,32px)}.customhouse-header__nav{gap:clamp(18px,2.2vw,32px)}.customhouse-header__nav a{font-size:clamp(13px,.92vw,15px)}}
    @media screen and (min-width:901px){.customhouse-header__menu-button{display:none!important}.customhouse-header__nav{display:flex!important}.customhouse-header__profile{display:block!important}}
    @media screen and (max-width:900px){.customhouse-header{position:relative;--customhouse-header-height:clamp(74px,10vw,94px);--customhouse-header-pad-x:clamp(14px,4vw,34px);background:rgb(6 7 8 / .96)}.customhouse-header__inner{min-height:var(--customhouse-header-height);grid-template-columns:minmax(0,1fr) auto;gap:clamp(10px,2.4vw,24px);padding-top:clamp(14px,2.2vw,20px);padding-bottom:12px}.customhouse-header__nav{display:none}.customhouse-header__profile{display:none}.customhouse-header__logo{--customhouse-logo-width:clamp(var(--customhouse-logo-width-mobile),24vw,var(--customhouse-logo-width-desktop));--customhouse-logo-mark-width:clamp(var(--customhouse-logo-mark-width-mobile),7.2vw,var(--customhouse-logo-mark-width-desktop));--customhouse-logo-mark-height:clamp(var(--customhouse-logo-mark-height-mobile),2.6vw,var(--customhouse-logo-mark-height-desktop));--customhouse-logo-wordmark-size:clamp(var(--customhouse-logo-wordmark-size-mobile),2.45vw,var(--customhouse-logo-wordmark-size-desktop));gap:7px}.customhouse-header__logo-image{max-height:54px}.customhouse-header__actions{gap:clamp(10px,2.2vw,18px)}.customhouse-header__icon{width:clamp(28px,3.6vw,34px);height:clamp(28px,3.6vw,34px)}.customhouse-header__icon svg{stroke-width:2.6}.customhouse-header__menu-button{display:inline-flex;color:#9bd21a}.customhouse-header__menu-button svg{stroke-width:2.8}}
    @media screen and (max-width:749px){.customhouse-header{--customhouse-header-height:94px;--customhouse-header-pad-x:clamp(13px,4.5vw,22px)}.customhouse-header__inner{gap:10px;padding-top:16px;padding-bottom:12px}.customhouse-header__logo{--customhouse-logo-width:var(--customhouse-logo-width-mobile);--customhouse-logo-mark-width:var(--customhouse-logo-mark-width-mobile);--customhouse-logo-mark-height:var(--customhouse-logo-mark-height-mobile);--customhouse-logo-wordmark-size:var(--customhouse-logo-wordmark-size-mobile)}.customhouse-header__actions{gap:clamp(10px,3vw,18px)}.customhouse-header__icon{width:clamp(28px,8vw,34px);height:clamp(28px,8vw,34px)}.customhouse-mobile-drawer{width:min(82vw,390px)}#FooterStrip-customhouse-app{min-height:auto;padding-right:var(--footer-mobile-padding-x);padding-left:var(--footer-mobile-padding-x)}#FooterStrip-customhouse-app .footer-strip__inner{min-height:auto;flex-direction:column;align-items:center;justify-content:center;gap:22px;text-align:center}#FooterStrip-customhouse-app .footer-strip__social{justify-items:center;min-width:0;width:100%}#FooterStrip-customhouse-app .footer-strip__heading{font-size:var(--footer-mobile-label-size)}#FooterStrip-customhouse-app .footer-strip__icon{width:var(--footer-mobile-icon-size);height:var(--footer-mobile-icon-size)}#FooterStrip-customhouse-app .footer-strip__links{width:100%;justify-content:center;row-gap:8px}#FooterStrip-customhouse-app .footer-strip__link{font-size:var(--footer-mobile-link-size);min-height:22px;white-space:normal;overflow-wrap:anywhere}}
  </style>`;
}

async function siteHeaderAccount(context: VerifiedProxyContext): Promise<SiteHeaderAccount> {
  if (!context.customerId) return { loggedIn: false };
  const customerId = normalizeCustomerGid(context.customerId);
  const creator = await db.creator.findUnique({
    where: {
      shop_customerId: {
        shop: context.shop,
        customerId,
      },
    },
    select: {
      displayName: true,
    },
  });
  return {
    loggedIn: true,
    displayName: creator?.displayName?.trim() || null,
    hasCreatorDashboard: Boolean(creator),
  };
}

function siteHeader(
  account: SiteHeaderAccount = { loggedIn: false },
  activePage?: "creatorContent",
) {
  const logoUrl =
    publicImageUrl(process.env.CUSTOMHOUSE_HEADER_LOGO_URL) ||
    DEFAULT_HEADER_LOGO_URL;
  const logoMarkup = logoUrl
    ? `<img class="customhouse-header__logo-image" src="${escapeHtml(logoUrl)}" alt="CustomHouse" loading="eager">`
    : `<span class="customhouse-header__mark" aria-hidden="true">
        <svg viewBox="0 0 140 54" focusable="false">
          <path d="M0 0h43l25 27-25 27H0l24-27L0 0Z"></path>
          <path d="M140 0H97L72 27l25 27h43l-24-27 24-27Z"></path>
        </svg>
      </span>
      <span class="customhouse-header__wordmark">CUSTOMHOUSE</span>`;
  const loginUrl = "/customer_authentication/login?return_to=%2Fpages%2Fcreator-dashboard";
  const becomeCreatorLoginUrl = "/customer_authentication/login?return_to=%2Fpages%2Fbecome-a-creator";
  const creatorDashboardUrl = "/pages/creator-dashboard";
  const logoutUrl = "/account/logout";
  const creatorContentCurrent = activePage === "creatorContent";
  const profileMenu = account.loggedIn
    ? `<p class="customhouse-header__profile-name">${escapeHtml(account.displayName || "Customer account")}</p>
            ${
              account.hasCreatorDashboard
                ? `<a href="${creatorDashboardUrl}">Creator dashboard</a>`
                : `<a href="/pages/become-a-creator">Become a creator</a>`
            }
            <a href="${logoutUrl}">Log out</a>`
    : `<p class="customhouse-header__profile-name">Customer account</p>
            <a href="${loginUrl}">Log in</a>
            <a class="customhouse-header__profile-choice" href="${loginUrl}">
              <strong>Create account</strong>
              <small>Create a customer account to manage your orders and purchases.</small>
            </a>
            <a class="customhouse-header__profile-choice" href="${becomeCreatorLoginUrl}">
              <strong>Become a creator</strong>
              <small>Apply to become a Creator and publish your designs on CustomHouse.</small>
            </a>`;
  const mobileAccountLinks = account.loggedIn
    ? `<a href="${account.hasCreatorDashboard ? creatorDashboardUrl : "/pages/become-a-creator"}">
          <span class="customhouse-mobile-drawer__account-icon" aria-hidden="true"><svg viewBox="0 0 32 32" focusable="false"><circle cx="16" cy="10" r="5.5"></circle><path d="M5 28c1.5-6.2 5.2-9.5 11-9.5s9.5 3.3 11 9.5"></path></svg></span>
          <span>${account.hasCreatorDashboard ? "CREATOR DASHBOARD" : "BECOME A CREATOR"}</span>
        </a>
        <a href="${logoutUrl}">
          <span class="customhouse-mobile-drawer__account-icon" aria-hidden="true"><svg viewBox="0 0 32 32" focusable="false"><path d="M18 6h7v20h-7"></path><path d="M16 16H5"></path><path d="m10 11-5 5 5 5"></path></svg></span>
          <span>LOG OUT</span>
        </a>`
    : `<a href="${becomeCreatorLoginUrl}">
          <span class="customhouse-mobile-drawer__account-icon" aria-hidden="true"><svg viewBox="0 0 32 32" focusable="false"><path d="M16 4v24"></path><path d="M4 16h24"></path></svg></span>
          <span>BECOME A CREATOR</span>
        </a>
        <a href="${loginUrl}">
          <span class="customhouse-mobile-drawer__account-icon" aria-hidden="true"><svg viewBox="0 0 32 32" focusable="false"><path d="M14 6H7v20h7"></path><path d="M16 16h11"></path><path d="m22 11 5 5-5 5"></path></svg></span>
          <span>LOG IN</span>
        </a>`;
  return `<header class="customhouse-header" data-customhouse-shell>
    <div class="customhouse-header__inner">
      <a class="customhouse-header__logo" href="/" aria-label="CustomHouse home">
        ${logoMarkup}
      </a>
      <nav class="customhouse-header__nav" aria-label="Main navigation">
        <a href="/collections/t-shirts">T-SHIRTS</a>
        <a href="/collections/hoodies">HOODIES</a>
        <a href="/pages/design-selv">DESIGN SELV</a>
        <a href="/blogs/news">INSPIRATION</a>
        <a href="/apps/customhouse/creator-content"${creatorContentCurrent ? ' aria-current="page"' : ""}>CREATOR CONTENT</a>
      </nav>
      <div class="customhouse-header__actions">
        <a class="customhouse-header__icon" href="/search" aria-label="Search">
          <svg viewBox="0 0 32 32" aria-hidden="true" focusable="false"><circle cx="14" cy="14" r="9.5"></circle><path d="m21 21 7 7"></path></svg>
        </a>
        <a class="customhouse-header__icon" href="/cart" aria-label="Cart">
          <svg viewBox="0 0 32 32" aria-hidden="true" focusable="false"><path d="M3 5h4l3 17h15l4-12H9"></path><circle cx="13" cy="27" r="1.8"></circle><circle cx="24" cy="27" r="1.8"></circle></svg>
        </a>
        <details class="customhouse-header__profile">
          <summary class="customhouse-header__icon" aria-label="Open profile menu">
            <svg viewBox="0 0 32 32" aria-hidden="true" focusable="false"><circle cx="16" cy="10" r="5.5"></circle><path d="M5 28c1.5-6.2 5.2-9.5 11-9.5s9.5 3.3 11 9.5"></path></svg>
          </summary>
          <div class="customhouse-header__profile-menu">
            ${profileMenu}
          </div>
        </details>
        <button class="customhouse-header__icon customhouse-header__menu-button" type="button" data-customhouse-menu-open aria-label="Open menu" aria-expanded="false">
          <svg viewBox="0 0 32 32" aria-hidden="true" focusable="false"><path d="M6 9h20M6 16h20M6 23h20"></path></svg>
        </button>
      </div>
    </div>
    <button class="customhouse-mobile-drawer__overlay" type="button" aria-label="Close menu" hidden data-customhouse-menu-close></button>
    <aside id="CustomhouseMobileDrawer-app" class="customhouse-mobile-drawer" aria-label="Mobile menu" aria-hidden="true" tabindex="-1" hidden data-customhouse-mobile-drawer>
      <div class="customhouse-mobile-drawer__header">
        <a class="customhouse-header__logo customhouse-mobile-drawer__logo" href="/" aria-label="CustomHouse home">${logoMarkup}</a>
        <button class="customhouse-mobile-drawer__close" type="button" aria-label="Close menu" data-customhouse-menu-close>
          <svg viewBox="0 0 32 32" aria-hidden="true" focusable="false"><path d="M7 7 25 25"></path><path d="M25 7 7 25"></path></svg>
        </button>
      </div>
      <nav class="customhouse-mobile-drawer__nav" aria-label="Mobile navigation">
        <a href="/collections/t-shirts">
          <span class="customhouse-mobile-drawer__line-icon" aria-hidden="true"><svg viewBox="0 0 48 48" focusable="false"><path d="M17 8h14l10 8-5 8-5-3v19H17V21l-5 3-5-8 10-8Z"></path><path d="M20 8c1.1 3 2.4 4.5 4 4.5S26.9 11 28 8"></path><path d="M18 35h12"></path></svg></span>
          <span>T-SHIRTS</span>
        </a>
        <a href="/collections/hoodies">
          <span class="customhouse-mobile-drawer__line-icon" aria-hidden="true"><svg viewBox="0 0 48 48" focusable="false"><path d="M15 20c0-7.6 3.8-13 9-13s9 5.4 9 13"></path><path d="M13 18 7 32l8 4 3-8v13h12V28l3 8 8-4-6-14"></path><path d="M18 20h12"></path><path d="M21 41v-8h6v8"></path></svg></span>
          <span>HOODIES</span>
        </a>
        <a href="/pages/design-selv">
          <span class="customhouse-mobile-drawer__line-icon" aria-hidden="true"><svg viewBox="0 0 48 48" focusable="false"><path d="M10 37 36 11l6 6-26 26-8 2 2-8Z"></path><path d="m31 16 6 6"></path><path d="M8 43h26"></path></svg></span>
          <span>DESIGN SELV</span>
        </a>
        <a href="/blogs/news">
          <span class="customhouse-mobile-drawer__line-icon" aria-hidden="true"><svg viewBox="0 0 48 48" focusable="false"><path d="M18 30c-2.8-2.2-4.5-5.3-4.5-9 0-6.3 4.7-11 10.5-11s10.5 4.7 10.5 11c0 3.7-1.7 6.8-4.5 9"></path><path d="M19 34h10"></path><path d="M20.5 39h7"></path><path d="M24 3v4"></path><path d="M9 10l3 3"></path><path d="M39 10l-3 3"></path><path d="M7 22h4"></path><path d="M37 22h4"></path></svg></span>
          <span>INSPIRATION</span>
        </a>
        <a href="/apps/customhouse/creator-content"${creatorContentCurrent ? ' aria-current="page"' : ""}>
          <span class="customhouse-mobile-drawer__line-icon" aria-hidden="true"><svg viewBox="0 0 48 48" focusable="false"><circle cx="17" cy="17" r="7"></circle><circle cx="33" cy="19" r="5"></circle><path d="M5 40c1.6-8 5.6-12 12-12s10.4 4 12 12"></path><path d="M27 30c6.8 0 11 3.3 12.5 10"></path></svg></span>
          <span>CREATOR CONTENT</span>
        </a>
      </nav>
      <div class="customhouse-mobile-drawer__account">
        ${mobileAccountLinks}
      </div>
    </aside>
  </header>`;
}

function siteFooter() {
  const backgroundUrl =
    publicImageUrl(process.env.CUSTOMHOUSE_FOOTER_BACKGROUND_URL) ||
    DEFAULT_FOOTER_BACKGROUND_URL;
  return `<footer
    id="FooterStrip-customhouse-app"
    class="footer-strip"
    data-customhouse-shell
    style="--footer-bg:#050506;--footer-text:#f4f4f2;--footer-accent:#7d3cc7;--footer-icon-cutout:#050506;--footer-max-width:1200px;--footer-min-height:128px;--footer-padding-top:32px;--footer-padding-bottom:22px;--footer-padding-x:42px;--footer-mobile-padding-x:22px;--footer-label-size:16px;--footer-link-size:17px;--footer-mobile-label-size:15px;--footer-mobile-link-size:15px;--footer-icon-size:28px;--footer-mobile-icon-size:26px;--footer-icon-gap:13px;--footer-link-gap:22px;--footer-group-gap:36px;--footer-text-weight:800;--footer-line-height:3px;--footer-line-offset:20px;--footer-line-inset:0px;--footer-line-opacity:.85;--footer-texture-opacity:.65;--footer-image-opacity:.7;"
  >
    ${backgroundUrl ? `<div class="footer-strip__image footer-strip__image--desktop" style="background-image:url(${escapeHtml(backgroundUrl)});background-position:center center;" aria-hidden="true"></div>` : ""}
    <div class="footer-strip__texture" aria-hidden="true"></div>
    <div class="footer-strip__inner">
      <div class="footer-strip__social">
        <div class="footer-strip__heading">FÖLJ OSS</div>
        <div class="footer-strip__icons" aria-label="FÖLJ OSS">
          <a class="footer-strip__icon" href="https://www.youtube.com/" target="_blank" rel="noopener noreferrer" aria-label="YouTube"><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M21.35 7.4a3 3 0 0 0-2.11-2.12C17.38 4.78 12 4.78 12 4.78s-5.38 0-7.24.5A3 3 0 0 0 2.65 7.4 31.42 31.42 0 0 0 2.15 12c0 1.55.17 3.1.5 4.6a3 3 0 0 0 2.11 2.12c1.86.5 7.24.5 7.24.5s5.38 0 7.24-.5a3 3 0 0 0 2.11-2.12c.33-1.5.5-3.05.5-4.6s-.17-3.1-.5-4.6ZM10.05 15.45v-6.9L15.68 12l-5.63 3.45Z"></path></svg></a>
          <a class="footer-strip__icon" href="https://www.facebook.com/" target="_blank" rel="noopener noreferrer" aria-label="Facebook"><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle class="footer-strip__facebook-circle" cx="12" cy="12" r="10"></circle><path class="footer-strip__facebook-f" d="M13.12 18.15v-5.57h1.86l.28-2.17h-2.14V9.03c0-.63.17-1.06 1.08-1.06h1.15V6.03c-.2-.03-.88-.09-1.68-.09-1.66 0-2.8 1.01-2.8 2.87v1.6H8.99v2.17h1.88v5.57h2.25Z"></path></svg></a>
          <a class="footer-strip__icon" href="https://www.instagram.com/" target="_blank" rel="noopener noreferrer" aria-label="Instagram"><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><rect x="3.1" y="3.1" width="17.8" height="17.8" rx="5.1"></rect><circle cx="12" cy="12" r="4.15"></circle><circle class="footer-strip__icon-dot" cx="17.25" cy="6.85" r="1.15"></circle></svg></a>
        </div>
      </div>
      <nav class="footer-strip__links" aria-label="Footer quick links">
        <a class="footer-strip__link" href="/pages/faq">FAQ</a>
        <a class="footer-strip__link" href="/pages/contact">KONTAKT</a>
        <a class="footer-strip__link" href="/policies/privacy-policy">VILLKOR</a>
        <a class="footer-strip__link" href="/pages/become-a-creator">BECOME A CREATOR</a>
      </nav>
    </div>
  </footer>`;
}

function siteShellScript() {
  return `<script>
    (() => {
      const drawer = document.querySelector("[data-customhouse-mobile-drawer]");
      const openButton = document.querySelector("[data-customhouse-menu-open]");
      const overlay = document.querySelector(".customhouse-mobile-drawer__overlay");
      if (!drawer || !openButton || !overlay) return;
      const setOpen = (open) => {
        drawer.classList.toggle("is-open", open);
        drawer.setAttribute("aria-hidden", open ? "false" : "true");
        drawer.hidden = !open;
        overlay.classList.toggle("is-open", open);
        overlay.hidden = !open;
        openButton.setAttribute("aria-expanded", open ? "true" : "false");
        document.documentElement.classList.toggle("customhouse-mobile-drawer-open", open);
        if (open) drawer.focus({ preventScroll: true });
      };
      openButton.addEventListener("click", () => setOpen(true));
      document.querySelectorAll("[data-customhouse-menu-close], .customhouse-mobile-drawer a").forEach((item) => {
        item.addEventListener("click", () => setOpen(false));
      });
      document.addEventListener("keydown", (event) => {
        if (event.key === "Escape") setOpen(false);
      });
    })();
  </script>`;
}

export function creatorContentHtml(
  input: Awaited<ReturnType<typeof loadPublicCreatorContent>> & {
    headerAccount?: SiteHeaderAccount;
  },
) {
  const heroImages = input.products
    .map((product) => product.imageUrl)
    .filter((url): url is string => Boolean(url))
    .slice(0, 3);
  const heroArt = heroImages.length
    ? heroImages
        .map(
          (url, index) =>
            `<span class="customhouse-creator-content__hero-shot customhouse-creator-content__hero-shot--${index + 1}"><img src="${escapeHtml(url)}" alt="" loading="${index ? "lazy" : "eager"}"></span>`,
        )
        .join("")
    : `<span class="customhouse-creator-content__hero-monogram" aria-hidden="true">CH</span>`;
  const categoryChips = ["All", ...input.categories]
    .map(
      (category, index) =>
        `<button class="customhouse-creator-content__chip${index === 0 ? " is-active" : ""}" type="button" data-creator-content-category="${escapeHtml(category)}" aria-pressed="${index === 0 ? "true" : "false"}">${escapeHtml(category)}</button>`,
    )
    .join("");
  const featuredCreators = input.featuredCreators.length
    ? input.featuredCreators
        .map((creator) => {
          const initials = creator.displayName
            .split(/\s+/)
            .slice(0, 2)
            .map((part) => part[0] || "")
            .join("")
            .toUpperCase();
          return `<article class="customhouse-creator-content__creator">
            <a class="customhouse-creator-content__creator-media" href="${escapeHtml(creator.viewUrl)}" aria-label="View ${escapeHtml(creator.displayName)}">
              ${
                creator.profileImageUrl
                  ? `<img src="${escapeHtml(creator.profileImageUrl)}" alt="${escapeHtml(creator.displayName)}" loading="lazy">`
                  : `<span aria-hidden="true">${escapeHtml(initials || "CH")}</span>`
              }
            </a>
            <div class="customhouse-creator-content__creator-copy">
              <strong>${escapeHtml(creator.displayName)}</strong>
              <small>@${escapeHtml(creator.publicHandle)}</small>
              ${creator.categories.length ? `<p>${escapeHtml(creator.categories.slice(0, 2).join(" · "))}</p>` : ""}
            </div>
            <a class="customhouse-creator-content__creator-action" href="${escapeHtml(creator.viewUrl)}">VIEW CREATOR</a>
          </article>`;
        })
        .join("")
    : `<p class="customhouse-creator-content__empty-inline">Featured Creators will appear here when selected by CustomHouse.</p>`;
  const checkboxGroup = (
    title: string,
    name: string,
    values: Array<{ value: string; label: string }>,
  ) =>
    values.length
      ? `<fieldset class="customhouse-creator-content__filter-group">
          <legend>${escapeHtml(title)}</legend>
          ${values
            .map(
              ({ value, label }) =>
                `<label><input type="checkbox" name="${escapeHtml(name)}" value="${escapeHtml(value)}" data-creator-content-filter> <span>${escapeHtml(label)}</span></label>`,
            )
            .join("")}
        </fieldset>`
      : "";
  const creatorFilters = checkboxGroup(
    "Creator",
    "creator",
    input.filters.creators.map((creator) => ({
      value: creator.id,
      label: creator.displayName,
    })),
  );
  const productTypeFilters = checkboxGroup(
    "Product type",
    "productType",
    input.filters.productTypes.map((value) => ({ value, label: value })),
  );
  const sizeFilters = checkboxGroup(
    "Size",
    "size",
    input.filters.sizes.map((value) => ({ value, label: value })),
  );
  const colorFilters = checkboxGroup(
    "Color",
    "color",
    input.filters.colors.map((value) => ({ value, label: value })),
  );
  const availabilityFilters = input.products.length
    ? checkboxGroup(
        "Availability",
        "availability",
        [
          { value: "available", label: "In stock" },
          ...(input.filters.availability
            ? [{ value: "unavailable", label: "Sold out" }]
            : []),
        ],
      )
    : "";
  const priceFilter = input.filters.price
    ? `<fieldset class="customhouse-creator-content__filter-group customhouse-creator-content__filter-group--price">
        <legend>Price</legend>
        <div>
          <label>Min<input type="number" min="${escapeHtml(String(input.filters.price.min))}" max="${escapeHtml(String(input.filters.price.max))}" placeholder="${escapeHtml(String(input.filters.price.min))}" data-creator-content-price-min></label>
          <label>Max<input type="number" min="${escapeHtml(String(input.filters.price.min))}" max="${escapeHtml(String(input.filters.price.max))}" placeholder="${escapeHtml(String(input.filters.price.max))}" data-creator-content-price-max></label>
        </div>
        <small>${escapeHtml(input.filters.price.currencyCode)}</small>
      </fieldset>`
    : "";
  const productCards = input.products.length
    ? input.products
        .map((product) => {
          const creatorInitial = product.creatorDisplayName.slice(0, 1).toUpperCase();
          const price =
            product.price.min === product.price.max
              ? formatMoney(String(product.price.min), product.price.currencyCode)
              : `${formatMoney(String(product.price.min), product.price.currencyCode)} – ${formatMoney(String(product.price.max), product.price.currencyCode)}`;
          const searchText = [
            product.creatorDisplayName,
            product.creatorHandle,
            product.creatorPublicHandle,
            product.collectionName,
            product.title,
            product.productType,
            ...product.creatorCategories,
          ]
            .join(" ")
            .toLocaleLowerCase();
          return `<article
            class="customhouse-creator-content__product"
            data-creator-content-product
            data-product-id="${escapeHtml(product.id)}"
            data-search="${escapeHtml(searchText)}"
            data-creator="${escapeHtml(product.creatorId)}"
            data-categories="${escapeHtml(product.creatorCategories.map((value) => value.toLocaleLowerCase()).join("||"))}"
            data-product-type="${escapeHtml(product.productType)}"
            data-sizes="${escapeHtml(product.sizes.join("||"))}"
            data-colors="${escapeHtml(product.colors.join("||"))}"
            data-price-min="${escapeHtml(String(product.price.min))}"
            data-price-max="${escapeHtml(String(product.price.max))}"
            data-available="${product.available ? "true" : "false"}"
            data-published="${escapeHtml(product.publishedAt || "")}">
            <a class="customhouse-creator-content__product-media" href="${escapeHtml(product.viewUrl)}">
              ${
                product.imageUrl
                  ? `<img src="${escapeHtml(product.imageUrl)}" alt="${escapeHtml(product.title)}" loading="lazy">`
                  : `<span aria-hidden="true">CH</span>`
              }
              ${product.available ? "" : `<em>SOLD OUT</em>`}
            </a>
            <div class="customhouse-creator-content__product-body">
              <a class="customhouse-creator-content__product-creator" href="${escapeHtml(product.creatorUrl)}">
                <span class="customhouse-creator-content__mini-avatar">
                  ${product.creatorAvatarUrl ? `<img src="${escapeHtml(product.creatorAvatarUrl)}" alt="" loading="lazy">` : escapeHtml(creatorInitial)}
                </span>
                <span><small>CustomHouse Creator</small><strong>${escapeHtml(product.creatorDisplayName)}</strong></span>
              </a>
              <h3><a href="${escapeHtml(product.viewUrl)}">${escapeHtml(product.title)}</a></h3>
              <p class="customhouse-creator-content__product-type">${escapeHtml(product.productType)}</p>
              <strong class="customhouse-creator-content__price">${escapeHtml(price)}</strong>
              <a class="customhouse-creator-content__buy" href="${escapeHtml(product.viewUrl)}">BUY PRODUCT</a>
            </div>
          </article>`;
        })
        .join("")
    : "";
  return html(`<!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>Creator Content | CustomHouse</title>
        ${publicCss()}
        <style>
          .customhouse-creator-content-page{--cc-bg:#060708;--cc-panel:#111216;--cc-panel-2:#17181d;--cc-line:#303139;--cc-text:#f7f7f4;--cc-muted:#a1a3ad;--cc-lime:#b7ff00;--cc-purple:#872cff;min-height:100vh;background:var(--cc-bg);color:var(--cc-text);font-family:Arial,Helvetica,sans-serif}.customhouse-creator-content-page *{box-sizing:border-box}.customhouse-creator-content-page a{color:inherit}.customhouse-creator-content__container{width:min(1440px,calc(100% - 48px));margin:0 auto}.customhouse-creator-content__breadcrumb{display:flex;gap:9px;align-items:center;padding:20px 0 14px;color:#7f818c;font-size:11px;font-weight:800;letter-spacing:.12em;text-transform:uppercase}.customhouse-creator-content__breadcrumb span:last-child{color:var(--cc-purple)}.customhouse-creator-content__hero{position:relative;display:grid;grid-template-columns:minmax(0,1.05fr) minmax(360px,.95fr);min-height:420px;overflow:hidden;border:1px solid var(--cc-line);background:linear-gradient(115deg,#07080a 0 48%,#181922 48% 100%)}.customhouse-creator-content__hero::after{position:absolute;right:-70px;bottom:-130px;width:340px;height:340px;border:60px solid rgba(135,44,255,.26);border-radius:50%;content:""}.customhouse-creator-content__hero-copy{position:relative;z-index:2;display:flex;flex-direction:column;justify-content:center;padding:52px}.customhouse-creator-content__eyebrow{margin:0 0 12px;color:var(--cc-lime);font-size:12px;font-weight:900;letter-spacing:.16em}.customhouse-creator-content__hero h1{max-width:700px;margin:0;font-size:clamp(54px,6vw,94px);font-style:italic;font-weight:950;letter-spacing:-.07em;line-height:.82}.customhouse-creator-content__hero h1 span{display:block;color:var(--cc-lime)}.customhouse-creator-content__hero-copy>p:last-child{max-width:600px;margin:26px 0 0;color:#d2d3d8;font-size:16px;line-height:1.55}.customhouse-creator-content__hero-art{position:relative;min-height:420px;overflow:hidden}.customhouse-creator-content__hero-shot{position:absolute;display:block;overflow:hidden;border:1px solid rgba(255,255,255,.2);background:#0d0e12;box-shadow:0 24px 60px rgba(0,0,0,.5)}.customhouse-creator-content__hero-shot img{width:100%;height:100%;object-fit:cover}.customhouse-creator-content__hero-shot--1{right:6%;top:7%;width:55%;height:82%;transform:rotate(3deg)}.customhouse-creator-content__hero-shot--2{left:2%;bottom:5%;width:38%;height:56%;transform:rotate(-7deg)}.customhouse-creator-content__hero-shot--3{right:1%;bottom:-7%;width:31%;height:45%;transform:rotate(8deg)}.customhouse-creator-content__hero-monogram{position:absolute;inset:0;display:grid;place-items:center;color:rgba(255,255,255,.08);font-size:180px;font-weight:950}.customhouse-creator-content__benefits{display:grid;grid-template-columns:repeat(4,1fr);border:1px solid var(--cc-line);border-top:0;background:#0d0e11}.customhouse-creator-content__benefit{display:grid;grid-template-columns:38px 1fr;gap:10px;align-items:center;min-height:82px;padding:14px 22px;border-right:1px solid var(--cc-line)}.customhouse-creator-content__benefit:last-child{border-right:0}.customhouse-creator-content__benefit b{color:var(--cc-lime);font-size:22px}.customhouse-creator-content__benefit strong,.customhouse-creator-content__benefit small{display:block}.customhouse-creator-content__benefit strong{font-size:12px}.customhouse-creator-content__benefit small{margin-top:4px;color:var(--cc-muted);font-size:10px}.customhouse-creator-content__discovery{padding:42px 0 82px}.customhouse-creator-content__search{position:relative}.customhouse-creator-content__search input{width:100%;height:58px;border:1px solid var(--cc-line);border-radius:6px;outline:0;background:var(--cc-panel);color:var(--cc-text);padding:0 58px 0 20px;font:700 14px/1 Arial}.customhouse-creator-content__search input:focus{border-color:var(--cc-purple);box-shadow:0 0 0 3px rgba(135,44,255,.18)}.customhouse-creator-content__search span{position:absolute;right:20px;top:50%;transform:translateY(-50%);color:var(--cc-lime);font-size:24px}.customhouse-creator-content__chips{display:flex;gap:9px;overflow:auto;padding:16px 0 4px;scrollbar-width:none}.customhouse-creator-content__chips::-webkit-scrollbar{display:none}.customhouse-creator-content__chip{flex:0 0 auto;min-height:37px;border:1px solid var(--cc-line);border-radius:999px;background:var(--cc-panel);color:var(--cc-text);padding:0 17px;font-size:11px;font-weight:800;cursor:pointer}.customhouse-creator-content__chip.is-active{border-color:var(--cc-lime);background:rgba(183,255,0,.09);color:var(--cc-lime)}.customhouse-creator-content__section-heading{display:flex;align-items:end;justify-content:space-between;gap:20px;margin:42px 0 18px}.customhouse-creator-content__section-heading p{margin:0 0 7px;color:var(--cc-lime);font-size:11px;font-weight:900;letter-spacing:.14em}.customhouse-creator-content__section-heading h2{margin:0;font-size:clamp(28px,3vw,44px);letter-spacing:-.05em}.customhouse-creator-content__featured{display:flex;gap:12px;overflow:auto;padding:0 0 10px;scroll-snap-type:x proximity}.customhouse-creator-content__creator{display:grid;grid-template-columns:68px minmax(120px,1fr);grid-template-rows:auto auto;gap:10px 13px;min-width:285px;max-width:330px;flex:1 0 285px;border:1px solid var(--cc-line);border-radius:10px;background:linear-gradient(145deg,var(--cc-panel-2),#0b0c0f);padding:14px;scroll-snap-align:start}.customhouse-creator-content__creator-media{grid-row:1/3;width:68px;height:68px;overflow:hidden;border:2px solid var(--cc-purple);border-radius:50%;background:#20152d;text-decoration:none}.customhouse-creator-content__creator-media img{width:100%;height:100%;object-fit:cover}.customhouse-creator-content__creator-media span{display:grid;width:100%;height:100%;place-items:center;color:var(--cc-lime);font-size:20px;font-weight:900}.customhouse-creator-content__creator-copy{min-width:0}.customhouse-creator-content__creator-copy strong,.customhouse-creator-content__creator-copy small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.customhouse-creator-content__creator-copy small,.customhouse-creator-content__creator-copy p{color:var(--cc-muted);font-size:10px}.customhouse-creator-content__creator-copy p{margin:5px 0 0}.customhouse-creator-content__creator-action{justify-self:start;color:var(--cc-lime);font-size:10px;font-weight:900;text-decoration:none}.customhouse-creator-content__empty-inline{color:var(--cc-muted)}.customhouse-creator-content__toolbar{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:38px 0 14px}.customhouse-creator-content__toolbar-left{display:flex;align-items:center;gap:12px}.customhouse-creator-content__toolbar button,.customhouse-creator-content__toolbar select{height:42px;border:1px solid var(--cc-line);border-radius:6px;background:var(--cc-panel);color:var(--cc-text);padding:0 14px;font-size:11px;font-weight:800}.customhouse-creator-content__filter-open{display:none}.customhouse-creator-content__active-filters{display:flex;gap:7px;flex-wrap:wrap}.customhouse-creator-content__active-filters button{height:30px;border-color:rgba(135,44,255,.7);color:#d8c2ff}.customhouse-creator-content__results{display:grid;grid-template-columns:250px minmax(0,1fr);gap:20px}.customhouse-creator-content__filters{position:sticky;top:18px;align-self:start;border:1px solid var(--cc-line);border-radius:8px;background:var(--cc-panel);padding:18px}.customhouse-creator-content__filter-head{display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--cc-line);padding:0 0 14px}.customhouse-creator-content__filter-head h3{margin:0;font-size:15px}.customhouse-creator-content__filter-head button{border:0;background:none;color:var(--cc-lime);font-size:10px;font-weight:800;cursor:pointer}.customhouse-creator-content__filter-close{display:none}.customhouse-creator-content__filter-group{display:grid;gap:9px;margin:0;padding:17px 0;border:0;border-bottom:1px solid var(--cc-line)}.customhouse-creator-content__filter-group legend{padding:0 0 4px;font-size:11px;font-weight:900;text-transform:uppercase}.customhouse-creator-content__filter-group>label{display:flex;align-items:center;gap:8px;color:#d3d4da;font-size:11px}.customhouse-creator-content__filter-group input[type=checkbox]{width:16px;height:16px;accent-color:var(--cc-purple)}.customhouse-creator-content__filter-group--price>div{display:grid;grid-template-columns:1fr 1fr;gap:8px}.customhouse-creator-content__filter-group--price label{display:grid;gap:5px;color:var(--cc-muted);font-size:9px}.customhouse-creator-content__filter-group--price input{min-width:0;width:100%;height:36px;border:1px solid var(--cc-line);border-radius:4px;background:#08090b;color:var(--cc-text);padding:0 8px}.customhouse-creator-content__filter-group--price small{color:var(--cc-muted)}.customhouse-creator-content__grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:13px}.customhouse-creator-content__product{min-width:0;overflow:hidden;border:1px solid var(--cc-line);border-radius:8px;background:var(--cc-panel)}.customhouse-creator-content__product[hidden]{display:none}.customhouse-creator-content__product-media{position:relative;display:block;aspect-ratio:1/1;overflow:hidden;background:radial-gradient(circle at 50% 40%,#292b32,#0c0d10 72%)}.customhouse-creator-content__product-media img{width:100%;height:100%;object-fit:contain;transition:transform .25s ease}.customhouse-creator-content__product:hover .customhouse-creator-content__product-media img{transform:scale(1.025)}.customhouse-creator-content__product-media>span{display:grid;width:100%;height:100%;place-items:center;color:#2c2e36;font-size:70px;font-weight:950}.customhouse-creator-content__product-media em{position:absolute;left:10px;top:10px;border-radius:4px;background:#07080a;color:#fff;padding:6px 8px;font-size:9px;font-style:normal;font-weight:900}.customhouse-creator-content__product-body{display:grid;gap:9px;padding:12px}.customhouse-creator-content__product-creator{display:flex;align-items:center;gap:8px;text-decoration:none}.customhouse-creator-content__mini-avatar{display:grid;width:28px;height:28px;flex:0 0 28px;place-items:center;overflow:hidden;border:1px solid var(--cc-purple);border-radius:50%;background:#211431;color:var(--cc-lime);font-size:10px;font-weight:900}.customhouse-creator-content__mini-avatar img{width:100%;height:100%;object-fit:cover}.customhouse-creator-content__product-creator small,.customhouse-creator-content__product-creator strong{display:block}.customhouse-creator-content__product-creator small{color:var(--cc-muted);font-size:8px}.customhouse-creator-content__product-creator strong{font-size:10px}.customhouse-creator-content__product h3{min-height:34px;margin:0;font-size:13px;line-height:1.3}.customhouse-creator-content__product h3 a{text-decoration:none}.customhouse-creator-content__product-type{margin:0;color:var(--cc-muted);font-size:9px}.customhouse-creator-content__price{color:var(--cc-lime);font-size:13px}.customhouse-creator-content__buy{display:grid;min-height:37px;place-items:center;border:1px solid var(--cc-purple);border-radius:4px;color:#fff;font-size:10px;font-weight:900;text-decoration:none}.customhouse-creator-content__buy:hover{background:var(--cc-purple)}.customhouse-creator-content__empty{display:none;min-height:280px;place-items:center;border:1px dashed var(--cc-line);color:var(--cc-muted);text-align:center}.customhouse-creator-content__empty.is-visible{display:grid}.customhouse-creator-content__load-more{display:block;min-width:180px;height:44px;margin:24px auto 0;border:1px solid var(--cc-purple);border-radius:5px;background:var(--cc-purple);color:#fff;font-weight:900;cursor:pointer}.customhouse-creator-content__load-more[hidden]{display:none}.customhouse-creator-content__drawer-overlay{display:none}
          @media(max-width:1279px){.customhouse-creator-content__container{width:min(1120px,calc(100% - 36px))}.customhouse-creator-content__hero{grid-template-columns:1fr .8fr}.customhouse-creator-content__hero-copy{padding:42px}.customhouse-creator-content__benefits{grid-template-columns:repeat(2,1fr)}.customhouse-creator-content__benefit:nth-child(2){border-right:0}.customhouse-creator-content__benefit:nth-child(-n+2){border-bottom:1px solid var(--cc-line)}.customhouse-creator-content__grid{grid-template-columns:repeat(3,minmax(0,1fr))}}
          @media(max-width:900px){.customhouse-creator-content__hero{grid-template-columns:1fr minmax(260px,.62fr)}.customhouse-creator-content__results{grid-template-columns:1fr}.customhouse-creator-content__filter-open{display:block}.customhouse-creator-content__filters{position:fixed;z-index:1001;top:0;right:0;width:min(390px,92vw);height:100dvh;overflow:auto;border-radius:0;transform:translateX(105%);transition:transform .2s ease}.customhouse-creator-content__filters.is-open{transform:translateX(0)}.customhouse-creator-content__filter-close{display:block}.customhouse-creator-content__drawer-overlay{position:fixed;z-index:1000;inset:0;display:none;border:0;background:rgba(0,0,0,.72)}.customhouse-creator-content__drawer-overlay.is-open{display:block}.customhouse-creator-content__grid{grid-template-columns:repeat(3,minmax(0,1fr))}}
          @media(max-width:767px){.customhouse-creator-content__container{width:min(100% - 24px,620px)}.customhouse-creator-content__breadcrumb{padding-top:14px}.customhouse-creator-content__hero{display:block;min-height:0}.customhouse-creator-content__hero-copy{padding:34px 24px 28px}.customhouse-creator-content__hero h1{font-size:clamp(48px,17vw,72px)}.customhouse-creator-content__hero-copy>p:last-child{font-size:13px}.customhouse-creator-content__hero-art{min-height:250px}.customhouse-creator-content__hero-shot--1{right:7%;width:58%;height:82%}.customhouse-creator-content__benefits{grid-template-columns:1fr 1fr}.customhouse-creator-content__benefit{grid-template-columns:28px 1fr;min-height:74px;padding:10px}.customhouse-creator-content__benefit b{font-size:18px}.customhouse-creator-content__discovery{padding:26px 0 58px}.customhouse-creator-content__search input{height:52px;font-size:12px}.customhouse-creator-content__section-heading{margin-top:30px}.customhouse-creator-content__section-heading h2{font-size:30px}.customhouse-creator-content__creator{min-width:250px;flex-basis:250px}.customhouse-creator-content__toolbar{align-items:stretch;flex-direction:column}.customhouse-creator-content__toolbar-left{justify-content:space-between}.customhouse-creator-content__toolbar select{width:100%}.customhouse-creator-content__active-filters:empty{display:none}.customhouse-creator-content__grid{grid-template-columns:repeat(2,minmax(0,1fr));gap:9px}.customhouse-creator-content__product-body{padding:10px}.customhouse-creator-content__product h3{font-size:11px}.customhouse-creator-content__product-creator small{display:none}.customhouse-creator-content__buy{font-size:9px}.customhouse-creator-content__price{font-size:11px}}
          @media(max-width:767px){.customhouse-creator-content__hero h1{font-size:clamp(44px,15vw,72px)}}
          @media(max-width:390px){.customhouse-creator-content__container{width:calc(100% - 18px)}.customhouse-creator-content__hero-copy{padding-left:18px;padding-right:18px}.customhouse-creator-content__benefit strong{font-size:10px}.customhouse-creator-content__benefit small{font-size:8px}.customhouse-creator-content__mini-avatar{display:none}}
        </style>
      </head>
      <body>
        ${siteHeader(input.headerAccount, "creatorContent")}
        <main class="customhouse-creator-content-page" data-creator-content-root>
          <div class="customhouse-creator-content__container">
            <nav class="customhouse-creator-content__breadcrumb" aria-label="Breadcrumb"><a href="/">HOME</a><span>›</span><a href="/pages/collections">COLLECTIONS</a><span>›</span><span>CREATOR CONTENT</span></nav>
            <section class="customhouse-creator-content__hero">
              <div class="customhouse-creator-content__hero-copy">
                <p class="customhouse-creator-content__eyebrow">FROM THE COMMUNITY</p>
                <h1>CREATOR <span>CONTENT</span></h1>
                <p>Discover unique designs from CustomHouse creators. Explore their collections and shop published designs with locked Creator artwork.</p>
              </div>
              <div class="customhouse-creator-content__hero-art" aria-hidden="true">${heroArt}</div>
            </section>
            <section class="customhouse-creator-content__benefits" aria-label="Creator Content benefits">
              <div class="customhouse-creator-content__benefit"><b>◇</b><span><strong>CREATOR COLLECTIONS</strong><small>Exclusive creator designs</small></span></div>
              <div class="customhouse-creator-content__benefit"><b>◎</b><span><strong>DISCOVER CREATORS</strong><small>Explore creators and new drops</small></span></div>
              <div class="customhouse-creator-content__benefit"><b>✦</b><span><strong>LIMITED DROPS</strong><small>Creator releases &amp; collaborations</small></span></div>
              <div class="customhouse-creator-content__benefit"><b>▱</b><span><strong>WORLDWIDE SHIPPING</strong><small>Fast and reliable</small></span></div>
            </section>
            <div class="customhouse-creator-content__discovery">
              <label class="customhouse-creator-content__search">
                <input type="search" aria-label="Search creators, collections, designs, or tags" placeholder="Search creators, collections, designs or tags…" autocomplete="off" data-creator-content-search>
                <span aria-hidden="true">⌕</span>
              </label>
              <div class="customhouse-creator-content__chips" aria-label="Creator interests">${categoryChips}</div>
              <div class="customhouse-creator-content__section-heading"><div><p>DISCOVER THE COMMUNITY</p><h2>Featured Creators</h2></div></div>
              <section class="customhouse-creator-content__featured" aria-label="Featured Creators">${featuredCreators}</section>
              <div class="customhouse-creator-content__toolbar">
                <div class="customhouse-creator-content__toolbar-left"><button class="customhouse-creator-content__filter-open" type="button" data-creator-content-filter-open aria-controls="CreatorContentFilters" aria-expanded="false">FILTERS</button><strong><span data-creator-content-count>${input.products.length}</span> PRODUCTS</strong></div>
                <label><span class="visually-hidden">Sort products</span><select data-creator-content-sort><option value="newest">Newest</option><option value="price-asc">Price: low to high</option><option value="price-desc">Price: high to low</option></select></label>
              </div>
              <div class="customhouse-creator-content__active-filters" data-creator-content-active-filters></div>
              <div class="customhouse-creator-content__results">
                <aside id="CreatorContentFilters" class="customhouse-creator-content__filters" data-creator-content-filter-drawer aria-label="Product filters" aria-hidden="true" inert>
                  <div class="customhouse-creator-content__filter-head"><h3>FILTERS</h3><button type="button" data-creator-content-clear>CLEAR ALL</button><button class="customhouse-creator-content__filter-close" type="button" data-creator-content-filter-close aria-label="Close filters">✕</button></div>
                  ${creatorFilters}${productTypeFilters}${sizeFilters}${colorFilters}${priceFilter}${availabilityFilters}
                </aside>
                <div>
                  <div class="customhouse-creator-content__grid" data-creator-content-grid>${productCards}</div>
                  <div class="customhouse-creator-content__empty${input.products.length ? "" : " is-visible"}" data-creator-content-empty><p>No published Creator products match these filters.</p></div>
                  <button class="customhouse-creator-content__load-more" type="button" data-creator-content-load-more data-next-offset="${escapeHtml(String(input.nextOffset ?? ""))}"${input.hasMore ? "" : " hidden"}>LOAD MORE</button>
                </div>
              </div>
            </div>
          </div>
          <button class="customhouse-creator-content__drawer-overlay" type="button" data-creator-content-filter-close aria-label="Close filters"></button>
        </main>
        ${siteFooter()}
        <script>
          (() => {
            const root = document.querySelector("[data-creator-content-root]");
            if (!root) return;
            const search = root.querySelector("[data-creator-content-search]");
            let cards = Array.from(root.querySelectorAll("[data-creator-content-product]"));
            const grid = root.querySelector("[data-creator-content-grid]");
            const count = root.querySelector("[data-creator-content-count]");
            const empty = root.querySelector("[data-creator-content-empty]");
            const sort = root.querySelector("[data-creator-content-sort]");
            const loadMore = root.querySelector("[data-creator-content-load-more]");
            const drawer = root.querySelector("[data-creator-content-filter-drawer]");
            const overlay = root.querySelector(".customhouse-creator-content__drawer-overlay");
            const openButton = root.querySelector("[data-creator-content-filter-open]");
            const mobileFilters = window.matchMedia("(max-width:900px)");
            const activeFilters = root.querySelector("[data-creator-content-active-filters]");
            let activeCategory = "all";
            let serverHasMore = Boolean(loadMore?.dataset.nextOffset);
            let timer = 0;
            let lastDrawerFocus = null;
            const selected = (name) => Array.from(root.querySelectorAll('input[name="' + name + '"]:checked')).map((input) => input.value);
            const values = (card, key) => String(card.dataset[key] || "").split("||").filter(Boolean);
            const intersects = (selectedValues, cardValues) => !selectedValues.length || selectedValues.some((value) => cardValues.includes(value));
            const filterNames = ["creator", "productType", "size", "color", "availability"];
            const syncUrlState = () => {
              const params = new URLSearchParams(window.location.search);
              ["q", "category", "sort", "minPrice", "maxPrice", ...filterNames].forEach((name) => params.delete(name));
              const query = String(search?.value || "").trim();
              if (query) params.set("q", query);
              if (activeCategory !== "all") params.set("category", activeCategory);
              if (sort?.value && sort.value !== "newest") params.set("sort", sort.value);
              filterNames.forEach((name) => selected(name).forEach((value) => params.append(name, value)));
              const minPrice = root.querySelector("[data-creator-content-price-min]")?.value || "";
              const maxPrice = root.querySelector("[data-creator-content-price-max]")?.value || "";
              if (minPrice) params.set("minPrice", minPrice);
              if (maxPrice) params.set("maxPrice", maxPrice);
              const nextUrl = window.location.pathname + (params.size ? "?" + params.toString() : "") + window.location.hash;
              window.history.replaceState(null, "", nextUrl);
            };
            const restoreUrlState = () => {
              const params = new URLSearchParams(window.location.search);
              if (search) search.value = params.get("q") || "";
              activeCategory = String(params.get("category") || "all").toLocaleLowerCase();
              root.querySelectorAll("[data-creator-content-category]").forEach((chip) => {
                const active = String(chip.dataset.creatorContentCategory || "all").toLocaleLowerCase() === activeCategory;
                chip.classList.toggle("is-active", active);
                chip.setAttribute("aria-pressed", active ? "true" : "false");
              });
              filterNames.forEach((name) => {
                const activeValues = params.getAll(name);
                root.querySelectorAll('input[name="' + name + '"]').forEach((input) => { input.checked = activeValues.includes(input.value); });
              });
              if (sort) {
                const sortValue = params.get("sort") || "newest";
                sort.value = ["newest", "price-asc", "price-desc"].includes(sortValue) ? sortValue : "newest";
              }
              const minInput = root.querySelector("[data-creator-content-price-min]");
              const maxInput = root.querySelector("[data-creator-content-price-max]");
              if (minInput) minInput.value = params.get("minPrice") || "";
              if (maxInput) maxInput.value = params.get("maxPrice") || "";
              applyFilters();
            };
            const setDrawer = (open, restoreFocus = true) => {
              if (!drawer || !overlay) return;
              if (!mobileFilters.matches) {
                drawer.classList.remove("is-open");
                overlay.classList.remove("is-open");
                drawer.removeAttribute("aria-hidden");
                drawer.removeAttribute("aria-modal");
                drawer.removeAttribute("role");
                drawer.inert = false;
                openButton?.setAttribute("aria-expanded", "false");
                document.documentElement.style.overflow = "";
                return;
              }
              drawer.classList.toggle("is-open", open);
              overlay.classList.toggle("is-open", open);
              drawer.setAttribute("aria-hidden", open ? "false" : "true");
              drawer.setAttribute("role", "dialog");
              drawer.setAttribute("aria-modal", "true");
              drawer.inert = !open;
              openButton?.setAttribute("aria-expanded", open ? "true" : "false");
              document.documentElement.style.overflow = open ? "hidden" : "";
              if (open) {
                lastDrawerFocus = document.activeElement;
                drawer.querySelector("[data-creator-content-filter-close]")?.focus();
              } else if (restoreFocus && lastDrawerFocus instanceof HTMLElement) {
                lastDrawerFocus.focus();
                lastDrawerFocus = null;
              }
            };
            const renderActiveFilters = () => {
              if (!activeFilters) return;
              const labels = [];
              if (activeCategory !== "all") labels.push(activeCategory);
              root.querySelectorAll("[data-creator-content-filter]:checked").forEach((input) => labels.push(input.parentElement?.innerText.trim() || input.value));
              const min = root.querySelector("[data-creator-content-price-min]")?.value;
              const max = root.querySelector("[data-creator-content-price-max]")?.value;
              if (min) labels.push("Min " + min);
              if (max) labels.push("Max " + max);
              activeFilters.innerHTML = labels.map((label) => '<button type="button" data-creator-content-clear>' + String(label).replace(/[&<>"']/g, "") + ' ×</button>').join("");
            };
            const applyFilters = () => {
              const query = String(search?.value || "").trim().toLocaleLowerCase();
              const creators = selected("creator");
              const productTypes = selected("productType");
              const sizes = selected("size");
              const colors = selected("color");
              const availability = selected("availability");
              const minValue = root.querySelector("[data-creator-content-price-min]")?.value || "";
              const maxValue = root.querySelector("[data-creator-content-price-max]")?.value || "";
              const min = minValue ? Number(minValue) : Number.NaN;
              const max = maxValue ? Number(maxValue) : Number.NaN;
              const matching = cards.filter((card) => {
                const categoryMatch = activeCategory === "all" || values(card, "categories").includes(activeCategory.toLocaleLowerCase());
                const available = card.dataset.available === "true";
                const availabilityMatch = !availability.length || (available && availability.includes("available")) || (!available && availability.includes("unavailable"));
                return (!query || String(card.dataset.search || "").includes(query)) && categoryMatch && intersects(creators, [card.dataset.creator || ""]) && intersects(productTypes, [card.dataset.productType || ""]) && intersects(sizes, values(card, "sizes")) && intersects(colors, values(card, "colors")) && availabilityMatch && (!Number.isFinite(min) || Number(card.dataset.priceMax) >= min) && (!Number.isFinite(max) || Number(card.dataset.priceMin) <= max);
              });
              matching.sort((left, right) => {
                if (sort?.value === "price-asc") return Number(left.dataset.priceMin) - Number(right.dataset.priceMin);
                if (sort?.value === "price-desc") return Number(right.dataset.priceMax) - Number(left.dataset.priceMax);
                return String(right.dataset.published || "").localeCompare(String(left.dataset.published || ""));
              });
              cards.filter((card) => !matching.includes(card)).forEach((card) => { card.hidden = true; });
              matching.forEach((card) => { card.hidden = false; grid?.append(card); });
              if (count) count.textContent = String(matching.length);
              empty?.classList.toggle("is-visible", matching.length === 0);
              if (loadMore) loadMore.hidden = !serverHasMore;
              renderActiveFilters();
              syncUrlState();
            };
            const bindCategoryChip = (chip) => {
              if (chip.dataset.creatorContentBound === "true") return;
              chip.dataset.creatorContentBound = "true";
              chip.addEventListener("click", async () => {
                activeCategory = String(chip.dataset.creatorContentCategory || "all").toLocaleLowerCase();
                root.querySelectorAll("[data-creator-content-category]").forEach((item) => {
                  const active = item === chip;
                  item.classList.toggle("is-active", active);
                  item.setAttribute("aria-pressed", active ? "true" : "false");
                });
                applyFilters();
                await ensureCompleteCatalog();
                restoreUrlState();
              });
            };
            const bindFilterControl = (input) => {
              if (input.dataset.creatorContentBound === "true") return;
              input.dataset.creatorContentBound = "true";
              input.addEventListener("input", async () => {
                applyFilters();
                await ensureCompleteCatalog();
                restoreUrlState();
              });
            };
            root.querySelectorAll("[data-creator-content-category]").forEach(bindCategoryChip);
            root.querySelectorAll("[data-creator-content-filter], [data-creator-content-price-min], [data-creator-content-price-max]").forEach(bindFilterControl);
            let pageRequest = null;
            const loadNextPage = async (applyState = true) => {
              const nextOffset = loadMore.dataset.nextOffset;
              if (!nextOffset) return false;
              if (pageRequest) return pageRequest;
              loadMore.disabled = true;
              loadMore.textContent = "LOADING…";
              pageRequest = (async () => {
                try {
                const pageUrl = new URL(window.location.href);
                pageUrl.searchParams.set("offset", nextOffset);
                const response = await fetch(pageUrl.toString(), { headers: { Accept: "text/html" } });
                if (!response.ok) throw new Error("Creator Content page request failed");
                const parsed = new DOMParser().parseFromString(await response.text(), "text/html");
                const parsedRoot = parsed.querySelector("[data-creator-content-root]");
                if (!parsedRoot) throw new Error("Creator Content page response was invalid");
                const knownProducts = new Set(cards.map((card) => card.dataset.productId));
                parsedRoot.querySelectorAll("[data-creator-content-product]").forEach((card) => {
                  if (knownProducts.has(card.dataset.productId)) return;
                  grid?.append(document.importNode(card, true));
                  knownProducts.add(card.dataset.productId);
                });
                const chipContainer = root.querySelector(".customhouse-creator-content__chips");
                parsedRoot.querySelectorAll("[data-creator-content-category]").forEach((chip) => {
                  const value = chip.dataset.creatorContentCategory;
                  const exists = Array.from(root.querySelectorAll("[data-creator-content-category]")).some((current) => current.dataset.creatorContentCategory === value);
                  if (!exists) chipContainer?.append(document.importNode(chip, true));
                });
                parsedRoot.querySelectorAll(".customhouse-creator-content__filter-group:not(.customhouse-creator-content__filter-group--price)").forEach((sourceGroup) => {
                  const title = sourceGroup.querySelector("legend")?.textContent?.trim();
                  if (!title) return;
                  const targetGroup = Array.from(root.querySelectorAll(".customhouse-creator-content__filter-group")).find((group) => group.querySelector("legend")?.textContent?.trim() === title);
                  if (!targetGroup) {
                    const priceGroup = drawer?.querySelector(".customhouse-creator-content__filter-group--price");
                    drawer?.insertBefore(document.importNode(sourceGroup, true), priceGroup || null);
                    return;
                  }
                  sourceGroup.querySelectorAll("[data-creator-content-filter]").forEach((sourceInput) => {
                    const exists = Array.from(targetGroup.querySelectorAll("[data-creator-content-filter]")).some((current) => current.name === sourceInput.name && current.value === sourceInput.value);
                    const label = sourceInput.closest("label");
                    if (!exists && label) targetGroup.append(document.importNode(label, true));
                  });
                });
                const sourcePriceGroup = parsedRoot.querySelector(".customhouse-creator-content__filter-group--price");
                const targetPriceGroup = root.querySelector(".customhouse-creator-content__filter-group--price");
                if (sourcePriceGroup && !targetPriceGroup) {
                  drawer?.append(document.importNode(sourcePriceGroup, true));
                } else if (sourcePriceGroup && targetPriceGroup) {
                  const sourceMin = sourcePriceGroup.querySelector("[data-creator-content-price-min]");
                  const sourceMax = sourcePriceGroup.querySelector("[data-creator-content-price-max]");
                  const targetMin = targetPriceGroup.querySelector("[data-creator-content-price-min]");
                  const targetMax = targetPriceGroup.querySelector("[data-creator-content-price-max]");
                  if (sourceMin && targetMin) {
                    const minimum = Math.min(Number(targetMin.min), Number(sourceMin.min));
                    targetMin.min = String(minimum);
                    targetMin.placeholder = String(minimum);
                  }
                  if (sourceMax && targetMax) {
                    const maximum = Math.max(Number(targetMax.max), Number(sourceMax.max));
                    targetMax.max = String(maximum);
                    targetMax.placeholder = String(maximum);
                  }
                }
                cards = Array.from(root.querySelectorAll("[data-creator-content-product]"));
                root.querySelectorAll("[data-creator-content-category]").forEach(bindCategoryChip);
                root.querySelectorAll("[data-creator-content-filter], [data-creator-content-price-min], [data-creator-content-price-max]").forEach(bindFilterControl);
                const parsedLoadMore = parsedRoot.querySelector("[data-creator-content-load-more]");
                loadMore.dataset.nextOffset = parsedLoadMore?.dataset.nextOffset || "";
                serverHasMore = Boolean(loadMore.dataset.nextOffset);
                if (applyState) restoreUrlState();
                return true;
                } catch {
                  loadMore.textContent = "TRY AGAIN";
                  return false;
                } finally {
                  loadMore.disabled = false;
                  if (loadMore.textContent !== "TRY AGAIN") loadMore.textContent = "LOAD MORE";
                }
              })();
              try {
                return await pageRequest;
              } finally {
                pageRequest = null;
              }
            };
            const ensureCompleteCatalog = async () => {
              let pageCount = 0;
              while (serverHasMore && pageCount < 1000) {
                const loaded = await loadNextPage(false);
                if (!loaded) break;
                pageCount += 1;
              }
            };
            search?.addEventListener("input", () => {
              window.clearTimeout(timer);
              timer = window.setTimeout(async () => {
                applyFilters();
                await ensureCompleteCatalog();
                restoreUrlState();
              }, 180);
            });
            sort?.addEventListener("change", async () => {
              applyFilters();
              await ensureCompleteCatalog();
              restoreUrlState();
            });
            loadMore?.addEventListener("click", () => { void loadNextPage(true); });
            root.addEventListener("click", (event) => {
              if (!event.target.closest("[data-creator-content-clear]")) return;
              root.querySelectorAll("[data-creator-content-filter]").forEach((input) => { input.checked = false; });
              root.querySelectorAll("[data-creator-content-price-min], [data-creator-content-price-max]").forEach((input) => { input.value = ""; });
              activeCategory = "all";
              root.querySelectorAll("[data-creator-content-category]").forEach((item, index) => { item.classList.toggle("is-active", index === 0); item.setAttribute("aria-pressed", index === 0 ? "true" : "false"); });
              applyFilters();
            });
            openButton?.addEventListener("click", () => setDrawer(true));
            root.querySelectorAll("[data-creator-content-filter-close]").forEach((button) => button.addEventListener("click", () => setDrawer(false)));
            document.addEventListener("keydown", (event) => {
              if (!mobileFilters.matches || !drawer?.classList.contains("is-open")) return;
              if (event.key === "Escape") {
                event.preventDefault();
                setDrawer(false);
                return;
              }
              if (event.key === "Tab") {
                const focusable = Array.from(drawer.querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled]), a[href]'));
                const first = focusable[0];
                const last = focusable[focusable.length - 1];
                if (event.shiftKey && document.activeElement === first) {
                  event.preventDefault();
                  last?.focus();
                } else if (!event.shiftKey && document.activeElement === last) {
                  event.preventDefault();
                  first?.focus();
                }
              }
            });
            const syncFilterBreakpoint = () => setDrawer(false, false);
            mobileFilters.addEventListener?.("change", syncFilterBreakpoint);
            syncFilterBreakpoint();
            const restoreCompleteUrlState = async () => {
              const params = new URLSearchParams(window.location.search);
              const hasDiscoveryState = ["q", "category", "sort", "minPrice", "maxPrice", ...filterNames]
                .some((name) => params.has(name));
              if (hasDiscoveryState) await ensureCompleteCatalog();
              restoreUrlState();
            };
            window.addEventListener("popstate", () => { void restoreCompleteUrlState(); });
            void restoreCompleteUrlState();
          })();
        </script>
        ${siteShellScript()}
      </body>
    </html>`);
}

export function collectionHtml(input: {
  collection: {
    publicHandle: string;
    displayName: string;
    bannerImageUrl?: string | null;
    bannerTitle?: string | null;
    bannerSubtitle?: string | null;
  };
  creator: {
    displayName: string;
    handle: string;
    portfolioUrl?: string | null;
    socialLinksJson?: string | null;
    primaryPlatform?: string | null;
    primaryProfileUrl?: string | null;
  };
  products: Array<{
    id: string;
    title: string;
    description: string | null;
    baseProductTitle: string;
    previewUrl: string | null;
    previewUrls?: string | null;
    publishedShopifyProductUrl?: string | null;
    baseProduct?: {
      priceRange: {
        minVariantPrice: { amount: string; currencyCode: string };
        maxVariantPrice: { amount: string; currencyCode: string };
      };
    };
  }>;
  headerAccount?: SiteHeaderAccount;
}) {
  const collectionName =
    input.collection.displayName?.trim() ||
    `${input.creator.displayName} Designs`;
  const heroTitle = input.collection.bannerTitle?.trim() || collectionName;
  const heroDescription =
    input.collection.bannerSubtitle?.trim() ||
    `Explore every piece from ${input.creator.displayName}. Unique creator designs, ready to purchase.`;
  const heroImageUrl = publicImageUrl(input.collection.bannerImageUrl);
  const productCount = input.products.length;
  const collectionPath = getCreatorCollectionStorefrontUrl(input.collection) || "";
  const shareText = `Shop ${collectionName} on CustomHouse.`;
  const shareTargets = collectionShareTargets(collectionPath, shareText);
  const cards = input.products.length
    ? input.products
        .map((product) => {
          const price = product.baseProduct?.priceRange.minVariantPrice;
          const max = product.baseProduct?.priceRange.maxVariantPrice;
          const priceLabel = price
            ? price.amount === max?.amount
              ? formatMoney(price.amount, price.currencyCode)
              : `${formatMoney(price.amount, price.currencyCode)} - ${formatMoney(max?.amount || price.amount, price.currencyCode)}`
            : "";
          const href = getCreatorProductStorefrontUrl(input.collection, product) || "#";
          const preview = productPreviewImages(product)[0] || product.previewUrl;
          return `<a class="customhouse-public-card" href="${href}">
            <span class="customhouse-public-card-favorite material-symbols-outlined" aria-hidden="true">favorite</span>
            <span class="customhouse-public-card-media">
              ${
                preview
                  ? `<img src="${escapeHtml(preview)}" alt="${escapeHtml(product.title)}">`
                  : `<span aria-hidden="true"></span>`
              }
            </span>
            <span class="customhouse-public-card-body">
              <h3>${escapeHtml(product.title)}</h3>
              <p>${escapeHtml(product.baseProductTitle)}</p>
              ${priceLabel ? `<strong>${priceLabel}</strong>` : ""}
              <span class="customhouse-public-button">View Product</span>
            </span>
          </a>`;
        })
        .join("")
    : `<div class="customhouse-public-empty"><strong>No published products yet</strong><p>This creator collection is getting ready.</p></div>`;
  return html(`<!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>${escapeHtml(input.collection.displayName)}</title>
        <link rel="preconnect" href="https://fonts.googleapis.com">
        <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
        <link href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@24,600,0,0" rel="stylesheet">
        ${publicCss()}
      </head>
      <body>
        ${siteHeader(input.headerAccount)}
        <main class="customhouse-public-page" data-customhouse>
          <header class="customhouse-public-hero${heroImageUrl ? " customhouse-public-hero--with-banner" : ""}"${heroBackgroundAttr(heroImageUrl)}>
            <div class="customhouse-public-hero-copy">
              <h1>${escapeHtml(heroTitle)}</h1>
              <p>${escapeHtml(heroDescription)}</p>
              ${socialLinksHtml(input.creator)}
              <div class="customhouse-public-stats" aria-label="Collection summary">
                <span class="customhouse-public-stat">
                  <span class="customhouse-public-stat-icon material-symbols-outlined" aria-hidden="true">shopping_bag</span>
                  <span><strong>${productCount}</strong><span>${productCount === 1 ? "Product" : "Products"}</span></span>
                </span>
                <span class="customhouse-public-stat">
                  <span class="customhouse-public-stat-icon material-symbols-outlined" aria-hidden="true">groups</span>
                  <span><strong>1</strong><span>Creator</span></span>
                </span>
              </div>
              <div
                class="customhouse-public-share"
                data-customhouse-collection-share
                data-customhouse-share-url="${escapeHtml(collectionPath)}"
                data-customhouse-share-title="${escapeHtml(shareText)}"
              >
                <button class="customhouse-public-share-toggle" type="button" data-customhouse-share-toggle aria-expanded="false">
                  <span class="material-symbols-outlined" aria-hidden="true">ios_share</span>
                  Share my collection
                </button>
                <button class="customhouse-public-share-copy" type="button" data-customhouse-share-copy>Copy link</button>
                <div class="customhouse-public-share-menu" data-customhouse-share-menu role="menu" hidden>
                  <a data-customhouse-share-platform="facebook" role="menuitem" href="${escapeHtml(shareTargets.facebook)}" target="_blank" rel="noopener noreferrer">Facebook</a>
                  <a data-customhouse-share-platform="x" role="menuitem" href="${escapeHtml(shareTargets.x)}" target="_blank" rel="noopener noreferrer">X / Twitter</a>
                  <a data-customhouse-share-platform="whatsapp" role="menuitem" href="${escapeHtml(shareTargets.whatsapp)}" target="_blank" rel="noopener noreferrer">WhatsApp</a>
                  <a data-customhouse-share-platform="linkedin" role="menuitem" href="${escapeHtml(shareTargets.linkedin)}" target="_blank" rel="noopener noreferrer">LinkedIn</a>
                  <button type="button" data-customhouse-share-copy data-customhouse-share-instagram-copy role="menuitem">Copy link for Instagram</button>
                </div>
                <p class="customhouse-public-share-status" data-customhouse-share-status role="status" aria-live="polite"></p>
              </div>
            </div>
          </header>
          <section class="customhouse-public-services" aria-label="Collection features">
            <div class="customhouse-public-service"><span class="customhouse-public-service-icon material-symbols-outlined" aria-hidden="true">workspace_premium</span><span><strong>Premium quality</strong><span>Creator-made products</span></span></div>
            <div class="customhouse-public-service"><span class="customhouse-public-service-icon material-symbols-outlined" aria-hidden="true">public</span><span><strong>Worldwide shipping</strong><span>Fast and reliable delivery</span></span></div>
            <div class="customhouse-public-service"><span class="customhouse-public-service-icon material-symbols-outlined" aria-hidden="true">crown</span><span><strong>Creator collection</strong><span>Unique designs by creators</span></span></div>
            <div class="customhouse-public-service"><span class="customhouse-public-service-icon material-symbols-outlined" aria-hidden="true">edit</span><span><strong>Custom made</strong><span>Designed by the creator</span></span></div>
          </section>
          <div class="customhouse-public-toolbar" aria-label="Collection controls">
            <div class="customhouse-public-filter"><small>Price</small><span>All Prices <span class="material-symbols-outlined" aria-hidden="true">expand_more</span></span></div>
            <div class="customhouse-public-toolbar-right">
              <div class="customhouse-public-sort">Most relevant <span class="material-symbols-outlined" aria-hidden="true">expand_more</span></div>
              <div class="customhouse-public-view" aria-hidden="true"><span class="material-symbols-outlined">grid_view</span><span class="material-symbols-outlined">view_list</span></div>
            </div>
          </div>
          <section class="customhouse-public-grid">${cards}</section>
        </main>
        <script>
          (() => {
            const shareRoot = document.querySelector("[data-customhouse-collection-share]");
            if (!shareRoot) return;
            const status = shareRoot.querySelector("[data-customhouse-share-status]");
            const toggle = shareRoot.querySelector("[data-customhouse-share-toggle]");
            const menu = shareRoot.querySelector("[data-customhouse-share-menu]");
            const sharePath = shareRoot.dataset.customhouseShareUrl || window.location.pathname;
            const shareUrl = new URL(sharePath, window.location.origin).href;
            const shareTitle = shareRoot.dataset.customhouseShareTitle || "Shop this CustomHouse creator collection.";
            const targets = {
              facebook: "https://www.facebook.com/sharer/sharer.php?" + new URLSearchParams({ u: shareUrl }).toString(),
              x: "https://twitter.com/intent/tweet?" + new URLSearchParams({ url: shareUrl, text: shareTitle }).toString(),
              whatsapp: "https://wa.me/?" + new URLSearchParams({ text: shareTitle + " " + shareUrl }).toString(),
              linkedin: "https://www.linkedin.com/sharing/share-offsite/?" + new URLSearchParams({ url: shareUrl }).toString(),
            };
            shareRoot.querySelectorAll("[data-customhouse-share-platform]").forEach((link) => {
              link.href = targets[link.dataset.customhouseSharePlatform] || "#";
            });
            const setStatus = (text) => {
              if (!status) return;
              status.textContent = text || "";
              if (text) window.setTimeout(() => {
                if (status.textContent === text) status.textContent = "";
              }, 2400);
            };
            const copyLink = async () => {
              try {
                if (navigator.clipboard?.writeText) {
                  await navigator.clipboard.writeText(shareUrl);
                } else {
                  const field = document.createElement("textarea");
                  field.value = shareUrl;
                  field.setAttribute("readonly", "");
                  field.style.position = "fixed";
                  field.style.left = "-1000px";
                  document.body.append(field);
                  field.select();
                  document.execCommand("copy");
                  field.remove();
                }
                setStatus("Link copied");
              } catch {
                setStatus("Copy the collection link manually.");
              }
            };
            shareRoot.querySelectorAll("[data-customhouse-share-copy]").forEach((button) => {
              button.addEventListener("click", copyLink);
            });
            toggle?.addEventListener("click", async () => {
              if (navigator.share && window.matchMedia("(max-width: 760px)").matches) {
                try {
                  await navigator.share({ title: "CustomHouse Creator Collection", text: shareTitle, url: shareUrl });
                  return;
                } catch (error) {
                  if (error?.name === "AbortError") return;
                }
              }
              if (!menu) return;
              menu.hidden = !menu.hidden;
              toggle.setAttribute("aria-expanded", menu.hidden ? "false" : "true");
            });
            menu?.querySelectorAll("a").forEach((link) => {
              link.addEventListener("click", () => {
                menu.hidden = true;
                toggle?.setAttribute("aria-expanded", "false");
              });
            });
          })();
        </script>
        ${siteFooter()}
        ${siteShellScript()}
      </body>
    </html>`);
}

function productHtml(input: {
  id: string;
  title: string;
  description: string | null;
  creatorPricingMode?: string | null;
  baseProductTitle: string;
  previewUrl: string | null;
  previewUrls?: string | null;
  creator: { displayName: string; handle: string };
  collection: { publicHandle: string; displayName?: string };
  headerAccount?: SiteHeaderAccount;
  relatedProducts?: Array<{
    id: string;
    title: string;
    description?: string | null;
    baseProductTitle: string;
    previewUrl: string | null;
    previewUrls?: string | null;
    baseProduct?: {
      priceRange: {
        minVariantPrice: { amount: string; currencyCode: string };
        maxVariantPrice: { amount: string; currencyCode: string };
      };
    };
  }>;
  baseProduct?: {
    title: string;
    options: Array<{ name: string; values: string[] }>;
    variants: Array<{
      id: string;
      graphqlId: string;
      cartId: string;
      title: string;
      availableForSale: boolean;
      price: { amount: string; currencyCode: string };
      selectedOptions: Array<{ name: string; value: string }>;
    }>;
  };
  designVariantSelectionsJson: string;
  creatorSetup?: ReturnType<typeof creatorProductSetupFromRecord>;
  productionPricing?: {
    method: string | null;
    fixedColor: string;
    placementCount: number;
    surchargeMinor?: string;
    feeVariantId?: string | null;
    methods?: Array<{
      method: string;
      surchargeMinor: string;
      feeVariantId: string | null;
    }>;
  } | null;
}) {
  const setup =
    input.creatorSetup ||
    creatorProductSetupFromRecord(
      input as unknown as Parameters<typeof creatorProductSetupFromRecord>[0],
    );
  const fixedColor = setup?.fixedColor || input.productionPricing?.fixedColor || "";
  const placementCount = setup?.placementCount || input.productionPricing?.placementCount || 1;
  const productionMethods =
    input.productionPricing?.methods?.length
      ? input.productionPricing.methods
      : input.productionPricing?.method
        ? [
            {
              method: input.productionPricing.method,
              surchargeMinor: input.productionPricing.surchargeMinor || "0",
              feeVariantId: input.productionPricing.feeVariantId || null,
            },
          ]
        : [];
  const fixedProductionMethod = setup?.productionMethod || input.productionPricing?.method || "";
  const fixedProductionMethods = productionMethods.filter(
    (method) => method.method === fixedProductionMethod,
  );
  const defaultProductionMethod = fixedProductionMethod;
  const priceAlreadyBaked = input.creatorPricingMode === "BAKED_IN_V1";
  const defaultProductionSurchargeMinor =
    priceAlreadyBaked
      ? 0n
      : BigInt(productionMethods.find((method) => method.method === defaultProductionMethod)?.surchargeMinor || "0") *
        BigInt(Math.max(1, placementCount));
  const allVariants = input.baseProduct?.variants || [];
  const variants = fixedColor
    ? allVariants.filter((variant) => {
        const color = variant.selectedOptions.find((option) =>
          /^(color|colour|farg|färg)$/i.test(option.name.trim()),
        )?.value;
        return !color || color.trim().toLowerCase() === fixedColor.trim().toLowerCase();
      })
    : allVariants;
  const firstAvailable = variants.find((variant) => variant.availableForSale) || variants[0] || null;
  const variantPriceLabel = (variant: typeof firstAvailable) => {
    if (!variant) return "";
    const baseMinor = BigInt(Math.round(Number(variant.price.amount || 0) * 100));
    return formatMinorAmount(baseMinor + defaultProductionSurchargeMinor, variant.price.currencyCode);
  };
  const optionControls = (input.baseProduct?.options || [])
    .filter((option) => {
      const optionName = option.name.toLowerCase();
      return !(
        optionName.includes("color") ||
        optionName.includes("colour") ||
        optionName.includes("farg") ||
        optionName.includes("production") ||
        optionName.includes("print")
      );
    })
    .map((option, index) => {
      const optionValues = [
        ...new Set(
          variants
            .map((variant) =>
              variant.selectedOptions.find((item) => item.name === option.name)?.value,
            )
            .filter((value): value is string => Boolean(value)),
        ),
      ];
      const selected =
        firstAvailable?.selectedOptions.find((item) => item.name === option.name)?.value ||
        optionValues[0] ||
        "";
      const values = optionValues
        .map(
          (value) =>
            `<option value="${escapeHtml(value)}"${value === selected ? " selected" : ""}>${escapeHtml(value)}</option>`,
        )
        .join("");
      const pills = optionValues
        .map((value) => {
          const active = value === selected;
          return `<button
            class="customhouse-option-pill${active ? " is-active" : ""}"
            type="button"
            data-customhouse-option-pill
            data-option-target="option-${index}"
            data-option-value="${escapeHtml(value)}"
            aria-pressed="${active ? "true" : "false"}"
          ><span>${escapeHtml(value)}</span></button>`;
        })
        .join("");
      return `<label class="customhouse-field">
        <span class="customhouse-option-header">
          <span>${escapeHtml(option.name)}:</span>
          <strong data-customhouse-option-current="option-${index}">${escapeHtml(selected)}</strong>
        </span>
        <select data-customhouse-option data-option-name="${escapeHtml(option.name)}" name="option-${index}" required>${values}</select>
        <span class="customhouse-option-pills" aria-label="${escapeHtml(option.name)} options">${pills}</span>
      </label>`;
    })
    .join("");
  const selectedSizeValue = firstAvailable?.selectedOptions.find((option) =>
    /^(size|storlek|storrelse|størrelse)$/i.test(option.name.trim()),
  )?.value;
  const normalizedSingleSize = String(selectedSizeValue || "").trim();
  const singleSizeLabel =
    normalizedSingleSize && !/^default title$/i.test(normalizedSingleSize)
      ? normalizedSingleSize
      : "One size";
  const sizeControls = optionControls || (firstAvailable
    ? `<label class="customhouse-field customhouse-field--single-option">
        <span class="customhouse-option-header">
          <span>Size:</span>
          <strong>${escapeHtml(singleSizeLabel)}</strong>
        </span>
        <span class="customhouse-option-pills" aria-label="Size options">
          <button class="customhouse-option-pill is-active" type="button" disabled aria-pressed="true"><span>${escapeHtml(singleSizeLabel)}</span></button>
        </span>
      </label>`
    : "");
  const lockedDetails = setup
    ? `<dl class="customhouse-locked-details" aria-label="Creator product details">
        <div>
          <dt>Color</dt>
          <dd><span class="customhouse-swatch" style="--ch-swatch:${swatchColor(fixedColor)}" aria-hidden="true"></span>${escapeHtml(fixedColor)}</dd>
        </div>
        <div>
          <dt>Printing method</dt>
          <dd>${escapeHtml(methodLabel(defaultProductionMethod))}</dd>
        </div>
        <div>
          <dt>Designed placements</dt>
          <dd>${escapeHtml(String(placementCount))}</dd>
        </div>
      </dl>`
    : "";
  const productionMethodControls = fixedProductionMethods.length
    ? `<input data-customhouse-production-method type="hidden" name="selectedProductionMethod" value="${escapeHtml(defaultProductionMethod)}">`
    : `<label class="customhouse-field">
        <span>Printing method</span>
        <select data-customhouse-production-method name="selectedProductionMethod" disabled required>
          <option value="">Unavailable</option>
        </select>
        <span class="customhouse-option-pills" aria-label="Printing method options">
          <button class="customhouse-option-pill" type="button" disabled><span>Unavailable</span></button>
        </span>
      </label>`;
  const productUrl = getCreatorProductStorefrontUrl(input.collection, input) || "";
  const postUrl = `${productUrl}/prepare-cart`;
  const collectionUrl = getCreatorCollectionStorefrontUrl(input.collection) || "/";
  const collectionName = input.collection.displayName || input.creator.displayName;
  const priceLabel = variantPriceLabel(firstAvailable);
  const previewImages = productPreviewImages(input);
  const mainPreviewImage = previewImages[0] || null;
  const thumbnails = previewImages.length
    ? previewImages
        .map(
          (url, index) =>
            `<button
              class="customhouse-product-thumb${index === 0 ? " is-active" : ""}"
              type="button"
              data-customhouse-gallery-thumb
              data-gallery-image="${escapeHtml(url)}"
              aria-label="${escapeHtml(index === 0 ? "Show front preview" : "Show back preview")}"
              aria-pressed="${index === 0 ? "true" : "false"}"
            >
              <img src="${escapeHtml(url)}" alt="${escapeHtml(index === 0 ? "Front preview" : "Back preview")}">
            </button>`,
        )
        .join("")
    : `<span class="customhouse-product-thumb"><span aria-hidden="true"></span></span>`;
  const moreProducts = (input.relatedProducts || [])
    .filter((product) => product.id !== input.id)
    .map((product) => {
      const href = getCreatorProductStorefrontUrl(input.collection, product) || "#";
      const preview = productPreviewImages(product)[0] || null;
      const minPrice = product.baseProduct?.priceRange.minVariantPrice;
      const maxPrice = product.baseProduct?.priceRange.maxVariantPrice;
      const priceLabel = minPrice
        ? minPrice.amount === maxPrice?.amount
          ? formatMoney(minPrice.amount, minPrice.currencyCode)
          : `${formatMoney(minPrice.amount, minPrice.currencyCode)} - ${formatMoney(maxPrice?.amount || minPrice.amount, minPrice.currencyCode)}`
        : "";
      return `<a class="customhouse-more__card" href="${href}" data-customhouse-more-card>
        <span class="customhouse-more__favorite material-symbols-outlined" aria-hidden="true">favorite</span>
        <span class="customhouse-more__image">
          ${
            preview
              ? `<img src="${escapeHtml(preview)}" alt="${escapeHtml(product.title)}">`
              : `<span aria-hidden="true"></span>`
          }
        </span>
        <span class="customhouse-more__body">
          <h3>${escapeHtml(product.title)}</h3>
          ${priceLabel ? `<strong class="customhouse-more__price">${priceLabel}</strong>` : ""}
        </span>
        <span class="customhouse-more__button">View Product</span>
      </a>`;
    })
    .join("");
  const moreSection = moreProducts
    ? `<section class="customhouse-more" data-customhouse-more>
        <header class="customhouse-more__header">
          <span class="customhouse-more__crown" aria-hidden="true">♕</span>
          <h2 class="customhouse-more__title">More from <strong>${escapeHtml(collectionName)}</strong></h2>
        </header>
        <div class="customhouse-more__grid">${moreProducts}</div>
        <div class="customhouse-more__controls" aria-label="More creator products">
          <button class="customhouse-more__arrow" type="button" data-customhouse-more-prev aria-label="Previous creator products">←</button>
          <button class="customhouse-more__arrow" type="button" data-customhouse-more-next aria-label="Next creator products">→</button>
        </div>
      </section>`
    : "";
  return html(`<!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>${escapeHtml(input.title)}</title>
        <link rel="preconnect" href="https://fonts.googleapis.com">
        <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
        <link href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@24,600,0,0" rel="stylesheet">
        ${publicCss()}
      </head>
      <body>
        ${siteHeader(input.headerAccount)}
        <main class="customhouse-product-page" data-customhouse>
          <section class="customhouse-product-layout">
            <div>
              <div class="customhouse-product-gallery">
                <div class="customhouse-product-thumbs">
                  ${thumbnails}
                </div>
                <div class="customhouse-product-media">
                  ${
                    mainPreviewImage
                      ? `<img data-customhouse-gallery-main src="${escapeHtml(mainPreviewImage)}" alt="${escapeHtml(input.title)}">`
                      : `<span aria-hidden="true"></span>`
                  }
                </div>
              </div>
              <div class="customhouse-service-row" aria-label="Order promises">
                <span><strong>Production Time</strong><small>3-5 Business Days</small></span>
                <span><strong>Shipping Time</strong><small>3-7 Business Days</small></span>
                <span><strong>Made to Order</strong><small>Customized creator item</small></span>
              </div>
            </div>
            <div class="customhouse-product-panel">
              <a class="customhouse-public-link customhouse-creator-line" href="${collectionUrl}">
                <span>Custom House</span>
                <strong>by ${escapeHtml(input.creator.displayName)}</strong>
                <span class="customhouse-verified" aria-label="Verified creator">✓</span>
              </a>
              <h1>${escapeHtml(input.title)}</h1>
              ${priceLabel ? `<p class="customhouse-product-price" data-customhouse-variant-price>${priceLabel}</p>` : `<p class="customhouse-product-price" data-customhouse-variant-price></p>`}
              <p class="customhouse-product-description">${escapeHtml(input.description || input.baseProductTitle)}</p>
              <p class="customhouse-locked-note">Creator artwork is locked for purchase.</p>
              ${lockedDetails}
              <form class="customhouse-product-form" data-customhouse-creator-cart data-prepare-url="${postUrl}" data-variants="${jsonAttr(variants)}" data-production-methods="${jsonAttr(productionMethods)}" data-placement-count="${escapeHtml(String(placementCount))}" data-creator-pricing-mode="${escapeHtml(input.creatorPricingMode || "")}">
                ${sizeControls}
                <input type="hidden" name="variantId" value="${escapeHtml(firstAvailable?.cartId || "")}">
                ${productionMethodControls}
                <label class="customhouse-field customhouse-field--quantity">
                  <span>Quantity</span>
                  <span class="customhouse-qty-row">
                    <span class="customhouse-qty">
                      <button type="button" data-customhouse-qty="-1" aria-label="Decrease quantity">-</button>
                      <input name="quantity" type="number" min="1" max="20" value="1" required>
                      <button type="button" data-customhouse-qty="1" aria-label="Increase quantity">+</button>
                    </span>
                  </span>
                </label>
                <p class="customhouse-made-to-order-note">This customized Creator product is made to order and cannot be returned.</p>
                <label class="customhouse-acknowledgement"><input name="nonReturnAcknowledged" type="checkbox" required> <span>I understand that this is a customized / made-to-order product and cannot be returned.</span></label>
                <label class="customhouse-acknowledgement"><input name="termsAccepted" type="checkbox" required> <span>I accept the <a href="/policies/terms-of-service" target="_blank" rel="noopener">Terms &amp; Conditions</a>.</span></label>
                <button class="customhouse-add-button" type="submit">Add to Cart</button>
                <p data-customhouse-cart-message role="status" aria-live="polite"></p>
              </form>
            </div>
          </section>
          ${moreSection}
        </main>
        <script>
          (() => {
            const form = document.querySelector("[data-customhouse-creator-cart]");
            const mainImage = document.querySelector("[data-customhouse-gallery-main]");
            document.querySelectorAll("[data-customhouse-gallery-thumb]").forEach((thumb) => {
              thumb.addEventListener("click", () => {
                const nextImage = thumb.dataset.galleryImage || "";
                if (!mainImage || !nextImage) return;
                mainImage.src = nextImage;
                document.querySelectorAll("[data-customhouse-gallery-thumb]").forEach((item) => {
                  const active = item === thumb;
                  item.classList.toggle("is-active", active);
                  item.setAttribute("aria-pressed", active ? "true" : "false");
                });
              });
            });
            const more = document.querySelector("[data-customhouse-more]");
            if (more) {
              const cards = Array.from(more.querySelectorAll("[data-customhouse-more-card]"));
              const prev = more.querySelector("[data-customhouse-more-prev]");
              const next = more.querySelector("[data-customhouse-more-next]");
              let page = 0;

              function perPage() {
                return window.matchMedia("(max-width: 760px)").matches ? 1 : window.matchMedia("(max-width: 900px)").matches ? 2 : window.matchMedia("(max-width: 1100px)").matches ? 3 : 4;
              }

              function renderMore() {
                const size = perPage();
                const maxPage = Math.max(0, Math.ceil(cards.length / size) - 1);
                page = Math.max(0, Math.min(page, maxPage));
                cards.forEach((card, index) => {
                  card.hidden = index < page * size || index >= page * size + size;
                });
                if (prev) prev.hidden = cards.length <= size;
                if (next) next.hidden = cards.length <= size;
              }

              if (prev) prev.addEventListener("click", () => {
                const size = perPage();
                const maxPage = Math.max(0, Math.ceil(cards.length / size) - 1);
                page = page <= 0 ? maxPage : page - 1;
                renderMore();
              });
              if (next) next.addEventListener("click", () => {
                const size = perPage();
                const maxPage = Math.max(0, Math.ceil(cards.length / size) - 1);
                page = page >= maxPage ? 0 : page + 1;
                renderMore();
              });
              window.addEventListener("resize", renderMore);
              renderMore();
            }
            if (!form) return;
            const message = form.querySelector("[data-customhouse-cart-message]");
            const button = form.querySelector(".customhouse-add-button");
            const variantInput = form.querySelector("[name='variantId']");
            const price = form.querySelector("[data-customhouse-variant-price]");
            const variants = JSON.parse(form.dataset.variants || "[]");
            const productionMethodInput = form.querySelector("[name='selectedProductionMethod']");
            const productionMethods = JSON.parse(form.dataset.productionMethods || "[]");
            const placementCount = Math.max(1, Number(form.dataset.placementCount || 1));
            const creatorPricingMode = String(form.dataset.creatorPricingMode || "");
            let pending = false;

            class CustomHouseCartError extends Error {
              constructor(code, message, meta = {}) {
                super(message);
                this.name = "CustomHouseCartError";
                this.code = code;
                this.meta = meta;
                this.stage = meta.stage || "UNKNOWN";
                this.status = meta.status || null;
              }
            }

            function previewText(value) {
              return String(value || "").replace(/\\s+/g, " ").slice(0, 220);
            }

            function debugCart(meta) {
              console.info("customhouse_creator_cart_debug", {
                stage: meta.stage,
                url: meta.url,
                method: meta.method,
                status: meta.status,
                contentType: meta.contentType,
                redirected: meta.redirected,
                responseUrl: meta.responseUrl,
                responsePreview: meta.responsePreview,
                errorCode: meta.errorCode
              });
            }

            function customerMessage(code, fallback) {
              if (code === "INVALID_VARIANT") return "Please select an available option.";
              if (code === "VARIANT_UNAVAILABLE") return "This option is currently unavailable.";
              if (code === "PITCHPRINT_PROJECT_MISSING" || code === "PITCHPRINT_PREP_FAILED") return "This design is temporarily unavailable.";
              if (code === "NETWORK_ERROR") return "Connection problem. Please try again.";
              return fallback || "This item is temporarily unavailable.";
            }

            function selectedVariant() {
              const selected = Array.from(form.querySelectorAll("[data-customhouse-option]")).map((select) => ({
                name: select.dataset.optionName || "",
                value: select.value
              }));
              return variants.find((variant) =>
                selected.every((option) =>
                  variant.selectedOptions?.some((item) => item.name === option.name && item.value === option.value)
                )
              );
            }

            function selectedProductionMethod() {
              const method = String(productionMethodInput?.value || "").trim();
              return productionMethods.find((item) => item.method === method) || null;
            }

            function customhouseMoney(amount, currencyCode) {
              const minor = Math.round(Number(amount || 0) * 100);
              const sign = minor < 0 ? "-" : "";
              const absolute = Math.abs(minor);
              const major = Math.floor(absolute / 100);
              const cents = String(absolute % 100).padStart(2, "0");
              return sign + major + "." + cents + " " + (currencyCode === "SEK" ? "kr" : currencyCode);
            }

            function customhouseMinorMoney(minor, currencyCode) {
              const sign = minor < 0 ? "-" : "";
              const absolute = Math.abs(minor);
              const major = Math.floor(absolute / 100);
              const cents = String(absolute % 100).padStart(2, "0");
              return sign + major + "." + cents + " " + (currencyCode === "SEK" ? "kr" : currencyCode);
            }

            function syncVariant() {
              const variant = selectedVariant();
              const method = selectedProductionMethod();
              variantInput.value = variant?.cartId ? String(variant.cartId) : "";
              button.disabled = !variant || !variant.availableForSale || !method;
              if (price) {
                const productionSurchargeMinor = creatorPricingMode === "BAKED_IN_V1"
                  ? 0
                  : Number(method?.surchargeMinor || 0) * placementCount;
                price.textContent = variant
                  ? customhouseMinorMoney(
                      Math.round(Number(variant.price.amount || 0) * 100) + (Number.isFinite(productionSurchargeMinor) ? productionSurchargeMinor : 0),
                      variant.price.currencyCode
                    )
                  : "Unavailable";
              }
            }

            form.querySelectorAll("[data-customhouse-option]").forEach((select) => {
              select.addEventListener("change", syncVariant);
            });
            if (productionMethodInput) {
              productionMethodInput.addEventListener("change", syncVariant);
            }
            form.querySelectorAll("[data-customhouse-option-pill]").forEach((button) => {
              button.addEventListener("click", () => {
                const select = form.querySelector('[name="' + button.dataset.optionTarget + '"]');
                if (!select) return;
                select.value = button.dataset.optionValue || "";
                form
                  .querySelectorAll('[data-option-target="' + button.dataset.optionTarget + '"]')
                  .forEach((item) => {
                    const active = item === button;
                    item.classList.toggle("is-active", active);
                    item.setAttribute("aria-pressed", active ? "true" : "false");
                  });
                const current = form.querySelector('[data-customhouse-option-current="' + button.dataset.optionTarget + '"]');
                if (current) current.textContent = button.dataset.optionLabel || button.dataset.optionValue || "";
                select.dispatchEvent(new Event("change", { bubbles: true }));
              });
            });
            form.querySelectorAll("[data-customhouse-qty]").forEach((button) => {
              button.addEventListener("click", () => {
                const input = form.querySelector("[name='quantity']");
                if (!input) return;
                const next = Math.max(1, Math.min(20, Number(input.value || 1) + Number(button.dataset.customhouseQty || 0)));
                input.value = String(next);
              });
            });
            syncVariant();

            async function fetchStage(stage, url, options) {
              try {
                return await fetch(url, { credentials: "same-origin", ...options });
              } catch (error) {
                if (error instanceof TypeError || error?.name === "AbortError") {
                  throw new CustomHouseCartError(
                    "NETWORK_ERROR",
                    "Connection problem. Please try again.",
                    { stage, url, method: options?.method || "GET" }
                  );
                }
                throw error;
              }
            }

            function passwordRedirected(response) {
              return response.url && /\\/password(?:$|[?#])/.test(new URL(response.url, window.location.origin).pathname);
            }

            async function readPrepareCartResponse(response, stage, fallbackMessage) {
              const contentType = response.headers.get("content-type") || "";
              const raw = await response.text();
              const meta = {
                stage,
                url: response.url,
                method: "POST",
                status: response.status,
                contentType,
                redirected: response.redirected,
                responseUrl: response.url,
                responsePreview: previewText(raw)
              };
              let code = "REQUEST_FAILED";
              if (passwordRedirected(response)) {
                code = "STOREFRONT_PASSWORD_REDIRECT";
              } else if (!contentType.includes("application/json")) {
                code = "APP_PROXY_HTML_RESPONSE";
              } else if (response.status === 401 || response.status === 403) {
                code = "APP_PROXY_AUTH_FAILED";
              } else if (response.status === 404) {
                code = "APP_PROXY_NOT_FOUND";
              } else if (response.status === 422) {
                code = "PREPARE_CART_422";
              } else if (response.status >= 500) {
                code = "PREPARE_CART_SERVER_ERROR";
              }
              let parsed = null;
              if (contentType.includes("application/json")) {
                try {
                  parsed = JSON.parse(raw);
                } catch {
                  throw new CustomHouseCartError("INVALID_JSON_RESPONSE", "This item is temporarily unavailable.", meta);
                }
              }
              if (!contentType.includes("application/json")) {
                debugCart({ ...meta, errorCode: code });
                throw new CustomHouseCartError(code, fallbackMessage, meta);
              }
              if (!response.ok || parsed?.ok === false || parsed?.success === false) {
                const exactCode = parsed?.error?.code || parsed?.description || code;
                debugCart({ ...meta, errorCode: exactCode });
                throw new CustomHouseCartError(
                  exactCode,
                  parsed?.error?.message || parsed?.description || parsed?.message || fallbackMessage,
                  meta
                );
              }
              debugCart({ ...meta, errorCode: null });
              return parsed;
            }

            async function readShopifyAjaxResponse(response, stage, fallbackMessage, expectedCartId) {
              const contentType = response.headers.get("content-type") || "";
              const raw = await response.text();
              const meta = {
                stage,
                url: response.url,
                method: "POST",
                status: response.status,
                contentType,
                redirected: response.redirected,
                responseUrl: response.url,
                responsePreview: previewText(raw)
              };
              if (passwordRedirected(response)) {
                debugCart({ ...meta, errorCode: "STOREFRONT_PASSWORD_REDIRECT" });
                throw new CustomHouseCartError(
                  "STOREFRONT_PASSWORD_REDIRECT",
                  "Storefront authentication is required.",
                  meta
                );
              }
              let parsed = null;
              try {
                parsed = raw ? JSON.parse(raw) : null;
              } catch {
                parsed = null;
              }
              if (!response.ok) {
                const code = response.status === 422
                  ? "SHOPIFY_CART_422"
                  : "SHOPIFY_CART_" + response.status;
                debugCart({ ...meta, errorCode: code });
                throw new CustomHouseCartError(
                  code,
                  parsed?.description || parsed?.message || fallbackMessage,
                  meta
                );
              }
              if (!parsed) {
                debugCart({ ...meta, errorCode: "SHOPIFY_CART_INVALID_JSON" });
                throw new CustomHouseCartError(
                  "SHOPIFY_CART_INVALID_JSON",
                  "Shopify returned an invalid cart response.",
                  meta
                );
              }
              if (stage === "SHOPIFY_CART_ADD" && expectedCartId) {
                const items = Array.isArray(parsed.items) ? parsed.items : [parsed];
                const matched = items.some((item) => String(item?.id ?? item?.variant_id ?? "") === String(expectedCartId));
                if (!matched) {
                  debugCart({ ...meta, errorCode: "SHOPIFY_CART_VARIANT_MISMATCH" });
                  throw new CustomHouseCartError(
                    "SHOPIFY_CART_VARIANT_MISMATCH",
                    "Shopify added a different product variant.",
                    meta
                  );
                }
              }
              debugCart({ ...meta, errorCode: null });
              return parsed;
            }

            form.addEventListener("submit", async (event) => {
              event.preventDefault();
              if (pending) return;
              pending = true;
              button.disabled = true;
              message.textContent = "Preparing design...";
              try {
                const prepareUrl = form.dataset.prepareUrl;
                if (!prepareUrl || /undefined/.test(prepareUrl)) {
                  throw new CustomHouseCartError("INVALID_PREPARE_CART_URL", "This item is temporarily unavailable.", {
                    stage: "PREPARE_CART",
                    url: prepareUrl || ""
                  });
                }
                const response = await fetchStage("PREPARE_CART", prepareUrl, {
                  method: "POST",
                  headers: { "Content-Type": "application/json", "Accept": "application/json" },
                  body: JSON.stringify({
                    variantId: form.variantId.value,
                    selectedProductionMethod: productionMethodInput?.value || "",
                    quantity: Number(form.quantity.value || 1),
                    nonReturnAcknowledged: Boolean(form.nonReturnAcknowledged?.checked),
                    termsAccepted: Boolean(form.termsAccepted?.checked)
                  })
                });
                const prepared = await readPrepareCartResponse(response, "PREPARE_CART", "This item is temporarily unavailable.");
                const preparedPayload = prepared?.data || prepared;
                const preparedCart = preparedPayload?.cart || prepared.cart || {};
                const preparedItems = Array.isArray(preparedPayload.items)
                  ? preparedPayload.items
                  : Array.isArray(preparedCart.items)
                    ? preparedCart.items
                    : [];
                const cartId = preparedPayload.variant?.cartId || preparedPayload.cartVariantId || preparedPayload.variantId || preparedCart.variant?.cartId || preparedCart.cartVariantId || preparedCart.variantId;
                const cartItems = preparedItems.length
                  ? preparedItems
                  : [{
                      id: cartId,
                      quantity: preparedPayload.quantity || preparedCart.quantity,
                      properties: preparedPayload.properties || preparedCart.properties
                    }];
                if (!cartId) {
                  throw new CustomHouseCartError("MISSING_CART_VARIANT_ID", "This item is temporarily unavailable.", {
                    stage: "SHOPIFY_CART_ADD"
                  });
                }
                if (String(cartId).startsWith("gid://")) {
                  throw new CustomHouseCartError("INVALID_CART_VARIANT_ID", "This item is temporarily unavailable.", {
                    stage: "SHOPIFY_CART_ADD"
                  });
                }
                if (!cartItems.every((item) => item?.id && !String(item.id).startsWith("gid://"))) {
                  throw new CustomHouseCartError("INVALID_CART_ITEM", "This item is temporarily unavailable.", {
                    stage: "SHOPIFY_CART_ADD"
                  });
                }
                message.textContent = "Adding to cart...";
                const cartAddUrl = (window.Shopify?.routes?.root || "/") + "cart/add.js";
                const cartResponse = await fetchStage("SHOPIFY_CART_ADD", cartAddUrl, {
                  method: "POST",
                  headers: { "Content-Type": "application/json", "Accept": "application/json" },
                  body: JSON.stringify({ items: cartItems })
                });
                await readShopifyAjaxResponse(cartResponse, "SHOPIFY_CART_ADD", "This item is temporarily unavailable.", cartId);
                message.textContent = "Added to cart";
                document.dispatchEvent(new CustomEvent("cart:refresh"));
                document.dispatchEvent(new CustomEvent("customhouse:cart-added"));
                const cartUrl = (window.Shopify?.routes?.root || "/") + "cart.js";
                fetchStage("CART_CONFIRMATION", cartUrl, {
                  method: "GET",
                  headers: { "Accept": "application/json" }
                })
                  .then((cartStateResponse) => readShopifyAjaxResponse(cartStateResponse, "CART_CONFIRMATION", "Unable to refresh cart.", cartId))
                  .then((cartState) => {
                    const lines = Array.isArray(cartState?.items) ? cartState.items : [];
                    const line = lines.find((item) => String(item?.id ?? item?.variant_id ?? "") === String(cartId));
                    debugCart({
                      stage: "CART_CONFIRMATION",
                      url: cartUrl,
                      method: "GET",
                      status: 200,
                      contentType: "parsed",
                      responsePreview: line ? "matching line found" : "matching line not found",
                      errorCode: line ? null : "CART_CONFIRMATION_STALE",
                      attributionPresent: Boolean(line?.properties?._customhouse_attribution),
                      creatorProductPresent: Boolean(line?.properties?._creator_product_id),
                      creatorPreviewPresent: Boolean(line?.properties?._creator_preview_url),
                      pitchprintPresent: Boolean(line?.properties?._pitchprint)
                    });
                  })
                  .catch((error) => {
                    console.info("customhouse_creator_cart_debug", {
                      stage: "CART_CONFIRMATION",
                      code: error?.code || "CART_CONFIRMATION_SKIPPED",
                      status: error?.status || null
                    });
                  });
                window.location.href = (window.Shopify?.routes?.root || "/") + "cart";
              } catch (error) {
                const wrapped = error instanceof CustomHouseCartError
                  ? error
                  : error instanceof TypeError
                    ? new CustomHouseCartError("NETWORK_ERROR", "Connection problem. Please try again.", { stage: "UNKNOWN" })
                    : new CustomHouseCartError("UNKNOWN_CART_ERROR", "Unable to add this item to cart.", { stage: "UNKNOWN" });
                console.warn("customhouse_creator_cart_error", {
                  stage: wrapped.stage,
                  code: wrapped.code,
                  status: wrapped.status
                });
                message.textContent = customerMessage(wrapped.code, wrapped.message);
              } finally {
                button.disabled = false;
                pending = false;
              }
            });
          })();
        </script>
        ${siteFooter()}
        ${siteShellScript()}
      </body>
    </html>`);
}

function safeSegment(value: string, label: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(value).trim();
  } catch {
    throw new DomainError(
      "INVALID_PROXY_PATH",
      `The ${label} is invalid.`,
      400,
    );
  }
  if (
    !decoded ||
    decoded.length > 100 ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(decoded)
  ) {
    throw new DomainError(
      "INVALID_PROXY_PATH",
      `The ${label} is invalid.`,
      400,
    );
  }
  return decoded;
}

export function parseProxyRoute(splat = ""): ProxyRoute {
  const parts = splat.split("/").filter(Boolean);
  if (parts.length === 0) return { kind: "base" };
  if (parts.length === 1 && parts[0] === "creator-content") {
    return { kind: "creatorContent" };
  }
  if (parts.length === 1 && parts[0] === "creators") {
    return { kind: "creators" };
  }
  if (parts.length === 2 && parts[0] === "creator") {
    return {
      kind: "creator",
      creatorHandle: safeSegment(parts[1], "creator handle"),
    };
  }
  if (parts.length === 2 && parts[0] === "creators") {
    return {
      kind: "creator",
      creatorHandle: safeSegment(parts[1], "creator collection handle"),
    };
  }
  if (
    parts.length === 4 &&
    (parts[0] === "creator" || parts[0] === "creators") &&
    parts[2] === "products"
  ) {
    return {
      kind: "creatorProduct",
      creatorHandle: safeSegment(parts[1], "creator handle"),
      creatorProductId: safeSegment(parts[3], "creator product ID"),
    };
  }
  if (
    parts.length === 5 &&
    (parts[0] === "creator" || parts[0] === "creators") &&
    parts[2] === "products" &&
    parts[4] === "prepare-cart"
  ) {
    return {
      kind: "creatorProductCart",
      creatorHandle: safeSegment(parts[1], "creator handle"),
      creatorProductId: safeSegment(parts[3], "creator product ID"),
    };
  }
  if (parts.length === 2 && parts[0] === "design") {
    return {
      kind: "design",
      designSlug: safeSegment(parts[1], "design slug"),
    };
  }
  if (
    parts.length === 3 &&
    parts[0] === "design" &&
    parts[2] === "cart"
  ) {
    return {
      kind: "designCart",
      designId: safeSegment(parts[1], "design ID"),
    };
  }
  return { kind: "notFound" };
}

function isUnsignedBaseHealthRequest(request: Request, route: ProxyRoute) {
  if (route.kind !== "base" || request.method !== "GET") return false;
  const params = new URL(request.url).searchParams;
  return (
    !params.has("signature") &&
    !params.has("shop") &&
    !params.has("timestamp") &&
    !params.has("logged_in_customer_id") &&
    !params.has("path_prefix")
  );
}

async function safeJsonBody(request: Request): Promise<Record<string, unknown>> {
  const contentType = request.headers.get("content-type") || "";
  if (!contentType.toLowerCase().includes("application/json")) {
    throw new DomainError(
      "UNSUPPORTED_MEDIA_TYPE",
      "Send a JSON request body.",
      415,
    );
  }
  let value: unknown;
  try {
    value = await request.json();
  } catch {
    throw new DomainError("INVALID_JSON", "Send valid JSON.", 400);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new DomainError("INVALID_JSON", "Expected a JSON object.", 400);
  }
  return value as Record<string, unknown>;
}

export async function handleStorefrontProxy(
  request: Request,
  splat = "",
  authenticateProxy?: ProxyAuthenticator,
): Promise<Response> {
  try {
    if (request.method !== "GET" && request.method !== "POST") {
      return failure(
        "METHOD_NOT_ALLOWED",
        "This request method is not supported.",
        405,
      );
    }

    const route = parseProxyRoute(splat);
    if (isUnsignedBaseHealthRequest(request, route)) {
      return success({
        message: "Custom House Shopify App Proxy is working",
      });
    }

    if (!new URL(request.url).searchParams.get("signature")) {
      throw new DomainError(
        "MISSING_PROXY_SIGNATURE",
        "The storefront request could not be verified.",
        401,
      );
    }
    if (!authenticateProxy) {
      throw new DomainError(
        "PROXY_AUTHENTICATION_UNAVAILABLE",
        "The storefront request could not be verified.",
        503,
      );
    }
    const context = await authenticateProxy(request);
    const customer = context.customerId
      ? { loggedIn: true, customerId: context.customerId }
      : { loggedIn: false, customerId: null };

    switch (route.kind) {
      case "base":
        return success({
          message: "Custom House Shopify App Proxy is working",
          customer,
        });
      case "creatorContent":
        if (request.method !== "GET") {
          return failure(
            "METHOD_NOT_ALLOWED",
            "Creator Content only supports GET requests.",
            405,
          );
        }
        if (!context.client) {
          throw new DomainError(
            "SHOP_NOT_INSTALLED",
            "The marketplace app is not available.",
            503,
          );
        }
        {
          const requestUrl = new URL(request.url);
          const requestedOffset = Number(requestUrl.searchParams.get("offset") || "0");
          const offset = Number.isInteger(requestedOffset) && requestedOffset >= 0
            ? requestedOffset
            : 0;
          const content = await loadPublicCreatorContent(
            context.shop,
            context.client,
            undefined,
            { offset },
          );
          return wantsJson(request)
            ? success({ route: "creatorContent", ...content })
            : creatorContentHtml({
                ...content,
                headerAccount: await siteHeaderAccount(context),
              });
        }
      case "creators":
        if (request.method !== "GET") {
          return failure(
            "METHOD_NOT_ALLOWED",
            "Creator listings only support GET requests.",
            405,
          );
        }
        {
          const directory = await listPublicCreatorDirectory(context.shop);
          return success({
            route: "creators",
            ready: true,
            ...directory,
            customer: { loggedIn: customer.loggedIn },
          });
        }
      case "creator":
        if (request.method !== "GET") {
          return failure(
            "METHOD_NOT_ALLOWED",
            "Creator profiles only support GET requests.",
            405,
          );
        }
        {
          const { collection, creator, products } = context.client
            ? await publicCreatorCollection(
                context.shop,
                route.creatorHandle,
                context.client,
              )
            : await listPublishedCreatorProductsForHandle(
                context.shop,
                route.creatorHandle,
              );
          const data = {
            route: "creator",
            creator: {
              id: creator.id,
              handle: creator.handle,
              displayName: creator.displayName,
            },
            collection: {
              publicHandle: collection.publicHandle,
              displayName: collection.displayName,
              bannerImageUrl: collection.bannerImageUrl,
              bannerTitle: collection.bannerTitle,
              bannerSubtitle: collection.bannerSubtitle,
              bannerUpdatedAt: collection.bannerUpdatedAt,
              socialLinks: publicSocialLinksRecord(creator),
            },
            products: products.map((product) => ({
              id: product.id,
              title: product.title,
              description: product.description,
              creatorId: product.creatorId,
              baseProductTitle: product.baseProductTitle,
              shopifyProductId: product.shopifyProductId,
              shopifyProductHandle: product.shopifyProductHandle,
              previewUrl: product.previewUrl,
              previewUrls: product.previewUrls,
              publishedAt: product.publishedAt,
              priceRange: (product as {
                baseProduct?: {
                  priceRange?: unknown;
                };
              }).baseProduct?.priceRange,
              viewUrl: getCreatorProductStorefrontUrl(collection, product),
            })),
            customer,
          };
          const jsonResponse = wantsJson(request);
          return jsonResponse
            ? success(data)
            : collectionHtml({
                collection,
                creator,
                products,
                headerAccount: await siteHeaderAccount(context),
              });
        }
      case "creatorProduct":
        if (request.method !== "GET") {
          return failure(
            "METHOD_NOT_ALLOWED",
            "Creator products only support GET requests.",
            405,
          );
        }
        if (!context.client) {
          throw new DomainError(
            "SHOP_NOT_INSTALLED",
            "The marketplace app is not available.",
            503,
          );
        }
        {
          const product = await publicCreatorProductDetail(
            context.shop,
            route.creatorHandle,
            route.creatorProductId,
            context.client,
          );
          const related = await publicCreatorCollection(
            context.shop,
            route.creatorHandle,
            context.client,
          );
          const data = {
            route: "creatorProduct",
            product: {
              id: product.id,
              title: product.title,
              description: product.description,
              creatorId: product.creatorId,
              creator: {
                handle: product.creator.handle,
                displayName: product.creator.displayName,
              },
              collection: {
                publicHandle: product.collection.publicHandle,
                displayName: product.collection.displayName,
              },
              baseProductTitle: product.baseProductTitle,
              shopifyProductId: product.shopifyProductId,
              shopifyProductHandle: product.shopifyProductHandle,
              previewUrl: product.previewUrl,
              previewUrls: product.previewUrls,
              publishedAt: product.publishedAt,
              creatorPricingMode: product.creatorPricingMode,
              baseProduct: product.baseProduct,
              relatedProducts: related.products
                .filter((item) => item.id !== product.id)
                .slice(0, 12)
                .map((item) => {
                  const relatedBase = item as typeof item & {
                    baseProduct?: {
                      priceRange?: unknown;
                    };
                  };
                  return {
                    id: item.id,
                    title: item.title,
                    description: item.description,
                    baseProductTitle: item.baseProductTitle,
                    previewUrl: item.previewUrl,
                    previewUrls: item.previewUrls,
                    priceRange: relatedBase.baseProduct?.priceRange,
                    viewUrl: getCreatorProductStorefrontUrl(product.collection, item),
                  };
                }),
            },
            customer,
          };
          const jsonResponse = wantsJson(request);
          return jsonResponse
            ? success(data)
            : productHtml({
                ...product,
                headerAccount: await siteHeaderAccount(context),
                relatedProducts: related.products
                  .filter((item) => item.id !== product.id)
                  .slice(0, 12),
              });
        }
      case "creatorProductCart":
        if (request.method !== "POST") {
          return failure(
            "METHOD_NOT_ALLOWED",
            "Adding a creator product to cart requires POST.",
            405,
          );
        }
        if (!context.client) {
          throw new DomainError(
            "SHOP_NOT_INSTALLED",
            "The marketplace app is not available.",
            503,
          );
        }
        {
          const body = await safeJsonBody(request);
          console.info("prepare_cart_received", {
            method: request.method,
            pathname: new URL(request.url).pathname,
            shop: context.shop,
            publicHandle: route.creatorHandle,
            creatorProductId: route.creatorProductId,
            status: "received",
          });
          const cart = await prepareCreatorProductCart(
            context.shop,
            {
              creatorHandle: route.creatorHandle,
              creatorProductId: route.creatorProductId,
              selectedVariantId: body.variantId ?? body.selectedVariantId,
              selectedProductionMethod:
                body.selectedProductionMethod ?? body.productionMethod,
              quantity: body.quantity,
              nonReturnAcknowledged: body.nonReturnAcknowledged,
              termsAccepted: body.termsAccepted,
            },
            context.client,
          );
          return success({
            variant: cart.variant,
            variantId: cart.variantId,
            cartVariantId: cart.cartVariantId,
            quantity: cart.quantity,
            properties: cart.properties,
            production: cart.production,
            items: cart.items,
            cart,
          });
        }
      case "design":
        if (request.method !== "GET") {
          return failure(
            "METHOD_NOT_ALLOWED",
            "Creator designs only support GET requests.",
            405,
          );
        }
        {
          const product = await getPublishedCreatorProduct(
            context.shop,
            route.designSlug,
          );
          return success({
          route: "design",
            product: {
              id: product.id,
              title: product.title,
              description: product.description,
              creatorId: product.creatorId,
              baseProductTitle: product.baseProductTitle,
              shopifyProductId: product.shopifyProductId,
              shopifyProductHandle: product.shopifyProductHandle,
              previewUrl: product.previewUrl,
              previewUrls: product.previewUrls,
              publishedAt: product.publishedAt,
            },
          customer,
          });
        }
      case "designCart":
        if (request.method !== "POST") {
          return failure(
            "METHOD_NOT_ALLOWED",
            "Adding a creator design to cart requires POST.",
            405,
          );
        }
        await safeJsonBody(request);
        return failure(
          "DESIGN_CART_NOT_READY",
          "Creator design purchasing is not available yet.",
          501,
        );
      case "notFound":
        return failure(
          "PROXY_ROUTE_NOT_FOUND",
          "The requested storefront route was not found.",
          404,
        );
    }
  } catch (error) {
    if (error instanceof DomainError) {
      return failure(error.code, error.message, error.status);
    }
    if (error instanceof Response && [401, 403].includes(error.status)) {
      return failure(
        "INVALID_PROXY_SIGNATURE",
        "The storefront request could not be verified.",
        error.status,
      );
    }
    console.error("storefront_proxy_error", {
      route: new URL(request.url).pathname,
      category: "request_failed",
    });
    return failure(
      "INTERNAL_ERROR",
      "The storefront request could not be completed.",
      500,
    );
  }
}
