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
import { formatMinorMoney } from "./money.ts";

const SAFE_HEADERS = {
  "Cache-Control": "no-store",
  "Content-Type": "application/json; charset=utf-8",
  "Referrer-Policy": "same-origin",
  "X-Content-Type-Options": "nosniff",
} as const;

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
  | { kind: "creators" }
  | { kind: "creator"; creatorHandle: string }
  | { kind: "creatorProduct"; creatorHandle: string; creatorProductId: string }
  | { kind: "creatorProductCart"; creatorHandle: string; creatorProductId: string }
  | { kind: "design"; designSlug: string }
  | { kind: "designCart"; designId: string }
  | { kind: "notFound" };

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
    [data-customhouse],[data-customhouse-shell]{--ch-primary:#8a2cff;--ch-primary-2:#5b22e8;--ch-service:#c8ff00;--ch-text:#f8fafc;--ch-muted:#b8bfd0;--ch-border:rgba(255,255,255,.13);--ch-soft:#151515;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:var(--ch-text);letter-spacing:0}
    .material-symbols-outlined{font-family:"Material Symbols Outlined";font-weight:400;font-style:normal;font-size:1.25rem;line-height:1;letter-spacing:normal;text-transform:none;display:inline-flex;align-items:center;justify-content:center;white-space:nowrap;word-wrap:normal;direction:ltr;-webkit-font-feature-settings:"liga";-webkit-font-smoothing:antialiased;font-variation-settings:"FILL" 0,"wght" 600,"GRAD" 0,"opsz" 24}
    body:has([data-customhouse]){margin:0;background:radial-gradient(circle at 78% 4%,#16081f 0,#080808 34%,#030303 100%);color:var(--ch-text)}
    .customhouse-proxy-header{position:sticky;top:0;z-index:20;border-bottom:1px solid rgba(255,255,255,.12);background:rgba(3,3,4,.9);backdrop-filter:blur(16px)}
    .customhouse-proxy-header__inner,.customhouse-proxy-footer__inner{width:min(1180px,calc(100vw - 2rem));margin:0 auto}
    .customhouse-proxy-header__inner{display:grid;grid-template-columns:auto minmax(0,1fr) auto;align-items:center;gap:1rem;min-height:70px}
    .customhouse-proxy-logo{color:#fff;text-decoration:none;font-weight:950;font-size:1.22rem;text-transform:uppercase;letter-spacing:0}
    .customhouse-proxy-logo span{color:var(--ch-service)}
    .customhouse-proxy-nav{display:flex;justify-content:center;gap:1.15rem;min-width:0;overflow:hidden}
    .customhouse-proxy-nav a,.customhouse-proxy-actions a,.customhouse-proxy-footer a{color:#fff;text-decoration:none;font-size:.82rem;font-weight:850;text-transform:uppercase}
    .customhouse-proxy-nav a:hover,.customhouse-proxy-actions a:hover,.customhouse-proxy-footer a:hover{color:var(--ch-service)}
    .customhouse-proxy-actions{display:flex;align-items:center;justify-content:flex-end;gap:.55rem}
    .customhouse-proxy-nav a{white-space:nowrap}
    .customhouse-proxy-actions a{display:grid;place-items:center;width:38px;height:38px;border:1px solid rgba(255,255,255,.14);border-radius:999px;background:rgba(255,255,255,.04)}
    .customhouse-proxy-actions .material-symbols-outlined{font-size:1.25rem}
    .customhouse-proxy-footer{margin-top:2rem;border-top:1px solid rgba(255,255,255,.12);background:#030304}
    .customhouse-proxy-footer__inner{display:grid;grid-template-columns:1fr auto;gap:1.25rem;align-items:center;padding:2rem 0}
    .customhouse-proxy-footer strong{display:block;color:#fff;font-size:1rem;text-transform:uppercase}
    .customhouse-proxy-footer p{margin:.35rem 0 0;color:var(--ch-muted);font-size:.86rem}
    .customhouse-proxy-footer__links{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:1rem}
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
    @media(max-width:900px){.customhouse-public-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.customhouse-product-layout{grid-template-columns:1fr;gap:1.5rem}.customhouse-product-page{padding:1rem 0 2rem}.customhouse-product-gallery{display:flex;flex-direction:column-reverse;gap:.75rem}.customhouse-product-thumbs{display:flex;gap:.65rem;overflow-x:auto;scroll-snap-type:x proximity;padding-bottom:.15rem}.customhouse-product-thumb{width:76px;min-width:76px;scroll-snap-align:start}.customhouse-service-row{grid-template-columns:1fr}.customhouse-service-row span+span{border-left:0;border-top:1px solid var(--ch-border)}.customhouse-more__grid{grid-template-columns:repeat(2,minmax(0,1fr))}.customhouse-more__controls{gap:4rem}}
    @media(max-width:760px){.customhouse-proxy-header__inner{grid-template-columns:1fr auto;align-items:center;gap:.65rem;min-height:62px}.customhouse-proxy-logo{font-size:1.08rem}.customhouse-proxy-actions a{width:36px;height:36px}.customhouse-proxy-nav{grid-column:1/-1;justify-content:flex-start;gap:.85rem;overflow-x:auto;scrollbar-width:none;padding:0 0 .75rem}.customhouse-proxy-nav::-webkit-scrollbar{display:none}.customhouse-proxy-nav a{font-size:.76rem}.customhouse-proxy-footer__inner{grid-template-columns:1fr}.customhouse-proxy-footer__links{justify-content:flex-start}.customhouse-public-page,.customhouse-product-page{width:min(100vw - 1rem,1180px)}.customhouse-public-hero{min-height:auto;padding:1.35rem 1rem 1.5rem;border-radius:0 0 10px 10px}.customhouse-public-hero h1{font-size:clamp(2.5rem,15vw,4rem)}.customhouse-public-socials{gap:.45rem}.customhouse-public-social{width:36px;height:36px}.customhouse-public-stats{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:.65rem}.customhouse-public-stat{min-width:0;padding:.6rem .58rem;gap:.45rem}.customhouse-public-stat-icon.material-symbols-outlined{font-size:1.6rem}.customhouse-public-share{align-items:stretch;flex-direction:column}.customhouse-public-share-toggle,.customhouse-public-share-copy{width:100%}.customhouse-public-share-menu{position:static;width:100%;margin-top:-.2rem}.customhouse-public-services{grid-template-columns:1fr}.customhouse-public-service+.customhouse-public-service{border-left:0;border-top:1px solid var(--ch-border)}.customhouse-public-service{padding:1.05rem}.customhouse-public-service-icon.material-symbols-outlined{font-size:1.7rem}.customhouse-public-toolbar{align-items:stretch;flex-direction:column}.customhouse-public-toolbar-right{width:100%;justify-content:space-between}.customhouse-public-filter,.customhouse-public-sort{width:100%;min-width:0}.customhouse-public-view{flex:0 0 auto}.customhouse-public-grid{grid-template-columns:1fr}.customhouse-product-panel h1{font-size:clamp(1.9rem,10vw,2.8rem)}.customhouse-product-media img{padding:1rem}.customhouse-option-pill{flex:1 1 auto}.customhouse-field--color .customhouse-option-pill{flex:0 1 calc(50% - .4rem)}.customhouse-more{padding:1.5rem .8rem 1rem}.customhouse-more__title::before,.customhouse-more__title::after{width:28px}.customhouse-more__grid{grid-template-columns:1fr}.customhouse-more__image{max-height:170px}.customhouse-more__card h3{font-size:.9rem}.customhouse-more__button{min-height:32px}}
    @media(max-width:420px){.customhouse-proxy-header__inner,.customhouse-proxy-footer__inner{width:min(100vw - 1rem,1180px)}.customhouse-proxy-logo{font-size:1rem}.customhouse-proxy-nav{gap:.72rem}.customhouse-proxy-nav a{font-size:.7rem}.customhouse-proxy-actions a{width:34px;height:34px}.customhouse-proxy-actions .material-symbols-outlined{font-size:1.12rem}}
  </style>`;
}

function siteHeader() {
  return `<header class="customhouse-proxy-header" data-customhouse-shell>
    <div class="customhouse-proxy-header__inner">
      <a class="customhouse-proxy-logo" href="/">CUSTOM<span>HOUSE</span></a>
      <nav class="customhouse-proxy-nav" aria-label="Main navigation">
        <a href="/collections/t-shirts">T-Shirts</a>
        <a href="/collections/hoodies">Hoodies</a>
        <a href="/pages/design-selv">Design Self</a>
        <a href="/blogs/news">News</a>
      </nav>
      <div class="customhouse-proxy-actions" aria-label="Cart">
        <a href="/cart" aria-label="Cart"><span class="material-symbols-outlined" aria-hidden="true">shopping_bag</span></a>
      </div>
    </div>
  </header>`;
}

function siteFooter() {
  return `<footer class="customhouse-proxy-footer" data-customhouse-shell>
    <div class="customhouse-proxy-footer__inner">
      <div>
        <strong>CUSTOMHOUSE</strong>
        <p>Creator products and custom pieces made for everyday wear.</p>
      </div>
      <nav class="customhouse-proxy-footer__links" aria-label="Footer navigation">
        <a href="/pages/about-us">About</a>
        <a href="/pages/contact">Contact</a>
        <a href="/pages/faq">FAQ</a>
        <a href="/pages/become-a-creator">Become a Creator</a>
        <a href="/policies/refund-policy">Returns</a>
      </nav>
    </div>
  </footer>`;
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
          const href =
            (product.publishedShopifyProductUrl?.startsWith("/") || product.publishedShopifyProductUrl?.startsWith("https://")
              ? product.publishedShopifyProductUrl
              : null) || getCreatorProductStorefrontUrl(input.collection, product) || "#";
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
        ${siteHeader()}
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
        ${siteFooter()}
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
      </body>
    </html>`);
}

function productHtml(input: {
  id: string;
  title: string;
  description: string | null;
  baseProductTitle: string;
  previewUrl: string | null;
  previewUrls?: string | null;
  creator: { displayName: string; handle: string };
  collection: { publicHandle: string; displayName?: string };
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
  const defaultProductionSurchargeMinor =
    BigInt(productionMethods.find((method) => method.method === defaultProductionMethod)?.surchargeMinor || "0") *
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
        ${siteHeader()}
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
              <form class="customhouse-product-form" data-customhouse-creator-cart data-prepare-url="${postUrl}" data-variants="${jsonAttr(variants)}" data-production-methods="${jsonAttr(productionMethods)}" data-placement-count="${escapeHtml(String(placementCount))}">
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
        ${siteFooter()}
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
                const productionSurchargeMinor = Number(method?.surchargeMinor || 0) * placementCount;
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
      case "creators":
        if (request.method !== "GET") {
          return failure(
            "METHOD_NOT_ALLOWED",
            "Creator listings only support GET requests.",
            405,
          );
        }
        return success({
          route: "creators",
          ready: false,
          message: "Creator storefront listings are not connected yet.",
          customer,
        });
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
          return wantsJson(request)
            ? success(data)
            : collectionHtml({ collection, creator, products });
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
          return wantsJson(request)
            ? success(data)
            : productHtml({
                ...product,
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
