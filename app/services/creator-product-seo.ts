const SEO_TITLE_LIMIT = 70;
const SEO_DESCRIPTION_LIMIT = 160;
const BRAND_SUFFIX = " | Custom House";

type CreatorProductSeoInput = {
  title: string;
  description?: string | null;
  creatorName?: string | null;
  baseProductTitle?: string | null;
};

function decodeHtmlEntities(value: string) {
  const named: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: '"',
  };
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_match, code: string) =>
      String.fromCodePoint(Number.parseInt(code, 16)),
    )
    .replace(/&#(\d+);/g, (_match, code: string) =>
      String.fromCodePoint(Number.parseInt(code, 10)),
    )
    .replace(
      /&([a-z]+);/gi,
      (match, name: string) => named[name.toLowerCase()] ?? match,
    );
}

function plainText(value: string | null | undefined) {
  return decodeHtmlEntities(String(value || "").replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function truncate(value: string, limit: number) {
  if (value.length <= limit) return value;
  const shortened = value.slice(0, Math.max(1, limit - 1)).trimEnd();
  return `${shortened}…`;
}

function brandedTitle(title: string, creatorName: string) {
  const attributed = creatorName ? `${title} by ${creatorName}` : title;
  if (`${attributed}${BRAND_SUFFIX}`.length <= SEO_TITLE_LIMIT) {
    return `${attributed}${BRAND_SUFFIX}`;
  }
  const available = SEO_TITLE_LIMIT - BRAND_SUFFIX.length;
  return `${truncate(title, available)}${BRAND_SUFFIX}`;
}

export function creatorProductSeo(input: CreatorProductSeoInput) {
  const title = plainText(input.title) || "Creator product";
  const creatorName = plainText(input.creatorName);
  const baseProductTitle = plainText(input.baseProductTitle) || "product";
  const description = plainText(input.description);
  const attribution = creatorName
    ? `Designed by ${creatorName} for Custom House.`
    : "Designed for Custom House.";
  const fallback = creatorName
    ? `Shop this custom ${baseProductTitle} designed by ${creatorName} at Custom House: ${title}. Made to order.`
    : `Shop this custom ${baseProductTitle} from Custom House: ${title}. Made to order.`;

  return {
    title: brandedTitle(title, creatorName),
    description: truncate(
      description ? `${description} ${attribution}` : fallback,
      SEO_DESCRIPTION_LIMIT,
    ),
  };
}
