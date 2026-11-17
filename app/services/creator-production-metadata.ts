export type CreatorProductionMetadata = {
  version: 1;
  pitchprintProjectId: string | null;
  pitchprintMasterProjectId: string | null;
  pitchprintDesignId: string | null;
  fixedColor: string;
  productionMethod: string | null;
  embroiderySubtype: "TEXT_ONLY" | "IMAGE_OR_LOGO" | null;
  placementCount: number;
};

type ShopifyLineAttribute = {
  key?: string;
  name?: string;
  value?: string;
};

function cleanOptionalText(value: unknown, maxLength: number) {
  const text = typeof value === "string" ? value.trim() : "";
  return text ? text.slice(0, maxLength) : null;
}

function attributeValue(attributes: ShopifyLineAttribute[], key: string) {
  return cleanOptionalText(
    attributes.find((attribute) => (attribute.key || attribute.name) === key)?.value,
    3000,
  );
}

export function creatorProductionMetadataFromAttributes(
  value: ShopifyLineAttribute[] | null | undefined,
): CreatorProductionMetadata {
  const attributes = Array.isArray(value) ? value : [];
  const method = String(attributeValue(attributes, "_production_method") || "")
    .trim()
    .toUpperCase();
  const productionMethod = /^[A-Z][A-Z0-9_]{1,63}$/.test(method)
    ? method
    : null;
  const subtype = attributeValue(attributes, "_embroidery_subtype");
  const embroiderySubtype =
    productionMethod === "EMBROIDERY" &&
    ["TEXT_ONLY", "IMAGE_OR_LOGO"].includes(subtype || "")
      ? (subtype as CreatorProductionMetadata["embroiderySubtype"])
      : null;
  const placementCount = Number(
    attributeValue(attributes, "_designed_placement_count"),
  );

  return {
    version: 1,
    pitchprintProjectId: attributeValue(attributes, "_pitchprint"),
    pitchprintMasterProjectId: attributeValue(
      attributes,
      "_creator_master_project_id",
    ),
    pitchprintDesignId: attributeValue(attributes, "_pitchprint_design_id"),
    fixedColor: attributeValue(attributes, "_fixed_color") || "",
    productionMethod,
    embroiderySubtype,
    placementCount:
      Number.isSafeInteger(placementCount) && placementCount > 0 && placementCount <= 20
        ? placementCount
        : 0,
  };
}
