import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  auditProductIdFromArgs,
  classifyMissingMappingRecord,
  classifyPublishedCreatorProduct,
  type MissingMappingReconciliationInput,
  type PublishedCreatorProductAuditInput,
} from "../scripts/native-marketplace-audit-classifier.ts";

const creatorProductId = "creator-product-1";
const feeVariantId = "gid://shopify/ProductVariant/fee-1";

test("parses one exact CreatorProduct audit filter", () => {
  assert.equal(
    auditProductIdFromArgs(["node", "audit.ts", "--product=creator-product-1"]),
    "creator-product-1",
  );
  assert.equal(auditProductIdFromArgs(["node", "audit.ts"]), null);
  assert.equal(auditProductIdFromArgs(["node", "audit.ts", "--product="]), null);
});

function compatibleInput(
  overrides: Partial<PublishedCreatorProductAuditInput> = {},
): PublishedCreatorProductAuditInput {
  return {
    creatorProductId,
    shopifyProductId: "gid://shopify/Product/100",
    fixedColor: "Navy Blue",
    fixedProductionMethod: "DTF",
    placementCount: 1,
    shopifyProduct: {
      variants: [
        {
          id: "gid://shopify/ProductVariant/101",
          selectedOptions: [
            { name: "Color", value: "navy blue" },
            { name: "Size", value: "M" },
          ],
        },
      ],
      productOrigin: "creator",
      designMode: "buy_only",
      designStatus: "published",
      productType: "creator_fixed",
      creatorProductId,
      fixedColor: "Navy Blue",
      productionMethod: "DTF",
      designedPlacementCount: "1",
      creatorCartValidation: {
        version: 1,
        creatorProductId,
        feeRequired: true,
        feeVariantId,
        placementCount: 1,
      },
    },
    ...overrides,
  };
}

test("classifies a fully compatible published Creator product as OK", () => {
  const result = classifyPublishedCreatorProduct(compatibleInput());

  assert.equal(result.category, "OK");
  assert.deepEqual(result.issues, []);
  assert.equal(result.variantCount, 1);
  assert.equal(result.allVariantsMatchFixedColor, true);
  assert.equal(result.canonicalMetafieldsPresent, true);
  assert.equal(result.validationContractPresent, true);
});

test("classifies a missing Shopify product mapping as MISSING_MAPPING", () => {
  const result = classifyPublishedCreatorProduct(
    compatibleInput({ shopifyProductId: null, shopifyProduct: null }),
  );

  assert.equal(result.category, "MISSING_MAPPING");
  assert.match(result.issues.join(" "), /mapping/i);
});

test("classifies a mapped but missing Shopify product as NEEDS_REPAIR", () => {
  const result = classifyPublishedCreatorProduct(
    compatibleInput({ shopifyProduct: null }),
  );

  assert.equal(result.category, "NEEDS_REPAIR");
  assert.match(result.issues.join(" "), /not found/i);
});

test("classifies wrong-color variants as NEEDS_REPAIR", () => {
  const input = compatibleInput();
  input.shopifyProduct!.variants.push({
    id: "gid://shopify/ProductVariant/102",
    selectedOptions: [{ name: "Colour", value: "Red" }],
  });

  const result = classifyPublishedCreatorProduct(input);

  assert.equal(result.category, "NEEDS_REPAIR");
  assert.equal(result.allVariantsMatchFixedColor, false);
  assert.match(result.issues.join(" "), /fixed color/i);
});

test("recognizes multilingual color option names", () => {
  for (const name of [
    "Color",
    "Colour",
    "Färg",
    "Farbe",
    "Couleur",
    "Colore",
    "Kleur",
    "Kolor",
    "Cor",
  ]) {
    const input = compatibleInput();
    input.shopifyProduct!.variants = [
      {
        id: `gid://shopify/ProductVariant/${name}`,
        selectedOptions: [{ name, value: "NAVY BLUE" }],
      },
    ];
    assert.equal(
      classifyPublishedCreatorProduct(input).allVariantsMatchFixedColor,
      true,
      name,
    );
  }
});

test("classifies missing canonical identity markers as NEEDS_REPAIR", () => {
  const input = compatibleInput();
  input.shopifyProduct!.designMode = null;

  const result = classifyPublishedCreatorProduct(input);

  assert.equal(result.category, "NEEDS_REPAIR");
  assert.equal(result.canonicalMetafieldsPresent, false);
  assert.match(result.issues.join(" "), /design_mode/i);
});

test("classifies a missing validation contract as NEEDS_REPUBLISH", () => {
  const input = compatibleInput();
  input.shopifyProduct!.creatorCartValidation = null;

  const result = classifyPublishedCreatorProduct(input);

  assert.equal(result.category, "NEEDS_REPUBLISH");
  assert.equal(result.validationContractPresent, false);
});

test("classifies a malformed validation contract as NEEDS_REPUBLISH", () => {
  const input = compatibleInput();
  input.shopifyProduct!.creatorCartValidation = {
    version: 1,
    creatorProductId,
    feeRequired: true,
    feeVariantId: null,
    placementCount: 0,
  };

  const result = classifyPublishedCreatorProduct(input);

  assert.equal(result.category, "NEEDS_REPUBLISH");
  assert.match(result.issues.join(" "), /validation contract/i);
});

test("classifies missing saved setup fields as NEEDS_REPAIR", () => {
  const result = classifyPublishedCreatorProduct(
    compatibleInput({ fixedProductionMethod: null }),
  );

  assert.equal(result.category, "NEEDS_REPAIR");
  assert.match(result.issues.join(" "), /production method/i);
});

test("classifies mismatched Shopify fixed setup metadata as NEEDS_REPAIR", () => {
  const result = classifyPublishedCreatorProduct(
    compatibleInput({
      shopifyProduct: {
        ...compatibleInput().shopifyProduct!,
        fixedColor: null,
        productionMethod: null,
        designedPlacementCount: null,
      },
    }),
  );

  assert.equal(result.category, "NEEDS_REPAIR");
  assert.match(result.issues.join(" "), /fixed color metadata/i);
  assert.match(result.issues.join(" "), /production method metadata/i);
  assert.match(result.issues.join(" "), /placement count metadata/i);
});

test("the executable audit remains read-only", () => {
  const source = readFileSync(
    new URL("../scripts/native-marketplace-audit.ts", import.meta.url),
    "utf8",
  );

  assert.doesNotMatch(source, /#graphql\s+mutation\b/i);
  assert.doesNotMatch(
    source,
    /\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\s*\(/,
  );
});

test("the production audit emits the complete reconciliation evidence contract", () => {
  const source = readFileSync(
    new URL("../scripts/native-marketplace-audit.ts", import.meta.url),
    "utf8",
  );

  for (const field of [
    "creatorStatus",
    "baseShopifyProductId",
    "creatorPublicHandle",
    "placementCount",
    "pitchprintProjectId",
    "nativeShopifyProductCandidates",
    "creatorCartValidation",
    "variantCount",
    "allVariantsMatchFixedColor",
    "missingMappingClassification",
  ]) {
    assert.match(source, new RegExp(`\\b${field}\\b`), field);
  }
  assert.match(source, /classifyMissingMappingRecord\s*\(/);
  assert.match(source, /metafields\.customhouse\.creator_product_id/);
});

function missingMappingInput(
  overrides: Partial<MissingMappingReconciliationInput> = {},
): MissingMappingReconciliationInput {
  return {
    creatorProductId,
    status: "PUBLISHED",
    creatorId: "creator-1",
    creatorStatus: "APPROVED",
    baseShopifyProductId: "gid://shopify/Product/base-1",
    fixedColor: "Black",
    fixedProductionMethod: "DTF",
    placementCount: 1,
    pitchprintProjectId: "project-1",
    pitchprintDesignId: null,
    previewPresent: true,
    candidates: [],
    ...overrides,
  };
}

function exactNativeCandidate(id = "gid://shopify/Product/native-1") {
  return {
    id,
    title: "Creator shirt",
    handle: "creator-shirt",
    productOrigin: "creator",
    designMode: "buy_only",
    designStatus: "published",
    productType: "creator_fixed",
    creatorId: "creator-1",
    creatorProductId,
  };
}

test("classifies one exact canonical native product as mapping repairable", () => {
  const result = classifyMissingMappingRecord(
    missingMappingInput({ candidates: [exactNativeCandidate()] }),
  );

  assert.equal(result.category, "EXISTING_NATIVE_PRODUCT_FOUND");
  assert.equal(result.proposedShopifyProductId, "gid://shopify/Product/native-1");
  assert.match(result.reason, /canonical/i);
});

test("classifies a complete published record with no candidate as republishable", () => {
  const result = classifyMissingMappingRecord(missingMappingInput());

  assert.equal(result.category, "PUBLISHED_BUT_NATIVE_PRODUCT_MISSING");
  assert.equal(result.proposedShopifyProductId, null);
});

test("classifies multiple exact canonical candidates as manual review", () => {
  const result = classifyMissingMappingRecord(
    missingMappingInput({
      candidates: [
        exactNativeCandidate("gid://shopify/Product/native-1"),
        exactNativeCandidate("gid://shopify/Product/native-2"),
      ],
    }),
  );

  assert.equal(result.category, "MANUAL_REVIEW_REQUIRED");
  assert.match(result.reason, /multiple/i);
});

test("never treats a title or handle match as deterministic identity", () => {
  const result = classifyMissingMappingRecord(
    missingMappingInput({
      candidates: [
        {
          ...exactNativeCandidate(),
          productOrigin: null,
          designMode: null,
          designStatus: null,
          productType: null,
          creatorId: null,
          creatorProductId: null,
        },
      ],
    }),
  );

  assert.equal(result.category, "MANUAL_REVIEW_REQUIRED");
  assert.match(result.reason, /canonical identity/i);
});

test("classifies incomplete published records as manual review instead of guessing", () => {
  const result = classifyMissingMappingRecord(
    missingMappingInput({ fixedColor: null, placementCount: null }),
  );

  assert.equal(result.category, "MANUAL_REVIEW_REQUIRED");
  assert.match(result.reason, /fixedColor/);
  assert.match(result.reason, /placementCount/);
});

test("classifies only explicit non-live lifecycle records as stale or test", () => {
  const result = classifyMissingMappingRecord(
    missingMappingInput({ status: "ARCHIVED", creatorStatus: "SUSPENDED" }),
  );

  assert.equal(result.category, "STALE_OR_TEST_RECORD");
  assert.match(result.reason, /ARCHIVED/);
});
