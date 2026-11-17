import { DomainError } from "./domain.ts";
import type {
  ProductProductionConfiguration,
  ProductionMethodDefinition,
  SaveProductProductionConfigurationInput,
} from "./production-method-pricing.server.ts";

export type ProductionPricingMatrixColumn = {
  key: string;
  methodId: string;
  tier?: string;
  groupLabel: string;
  label: string;
};

export type ProductionPricingMatrixProduct = {
  id: string;
  title: string;
  currency: string;
  handle?: string;
  basePrice?: string;
};

export type ProductionPricingMatrixCell = ProductionPricingMatrixColumn & {
  enabled: boolean;
  surcharge: string;
};

export type ProductionPricingMatrixRow = ProductionPricingMatrixProduct & {
  cells: ProductionPricingMatrixCell[];
};

function tierLabel(tier: string) {
  if (tier === "TEXT_ONLY") return "Text";
  if (tier === "IMAGE_OR_LOGO") return "Image / Logo";
  return tier
    .toLowerCase()
    .split("_")
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

export function productionPricingMatrixColumns(
  definitions: ProductionMethodDefinition[],
): ProductionPricingMatrixColumn[] {
  return definitions.filter((definition) => definition.enabled !== false).flatMap(
    (definition) =>
      definition.pricingBehavior === "TIERED"
        ? definition.tiers.map((tier) => ({
            key: `${definition.id}.${tier}`,
            methodId: definition.id,
            tier,
            groupLabel: definition.label,
            label: tierLabel(tier),
          }))
        : [{
            key: definition.id,
            methodId: definition.id,
            groupLabel: definition.label,
            label: "Enabled",
          }],
  );
}

function cellRate(
  configuration: ProductProductionConfiguration | undefined,
  column: ProductionPricingMatrixColumn,
) {
  const method = configuration?.methods[column.methodId];
  if (!method) return { enabled: false, surcharge: "0.00" };
  if (column.tier) {
    if (!("tiers" in method)) return { enabled: false, surcharge: "0.00" };
    return method.tiers[column.tier] || { enabled: false, surcharge: "0.00" };
  }
  return "tiers" in method
    ? { enabled: method.enabled, surcharge: "0.00" }
    : method;
}

function validatedCurrency(value: unknown) {
  const currency = String(value || "").trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new DomainError(
      "INVALID_PRODUCTION_CURRENCY",
      "Choose a valid three-letter production pricing currency.",
      422,
    );
  }
  return currency;
}

function validatedSurcharge(value: FormDataEntryValue | null) {
  const surcharge = String(value ?? "").trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(surcharge)) {
    throw new DomainError(
      "INVALID_SURCHARGE",
      "Production pricing must be a non-negative amount with maximum two decimals.",
      422,
    );
  }
  return surcharge;
}

export function productionPricingMatrixRows(
  products: ProductionPricingMatrixProduct[],
  configurationByProduct: Record<string, ProductProductionConfiguration>,
  columns: ProductionPricingMatrixColumn[],
): ProductionPricingMatrixRow[] {
  return products.map((product) => ({
    ...product,
    cells: columns.map((column) => ({
      ...column,
      ...cellRate(configurationByProduct[product.id], column),
    })),
  }));
}

export function parseProductionPricingBatchForm(
  form: FormData,
  definitions: ProductionMethodDefinition[],
): SaveProductProductionConfigurationInput[] {
  const count = Number(form.get("productCount"));
  if (!Number.isSafeInteger(count) || count < 1 || count > 100) {
    throw new DomainError(
      "PRODUCTION_PRICING_BATCH_INVALID",
      "The production pricing matrix could not be saved.",
      422,
    );
  }
  const products: SaveProductProductionConfigurationInput[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < count; index += 1) {
    const prefix = `products.${index}`;
    const shopifyProductId = String(form.get(`${prefix}.id`) || "").trim();
    const currency = validatedCurrency(form.get(`${prefix}.currency`));
    if (!/^gid:\/\/shopify\/Product\/\d+$/.test(shopifyProductId) || seen.has(shopifyProductId)) {
      throw new DomainError(
        "PRODUCTION_PRICING_BATCH_INVALID",
        "The production pricing matrix contains an invalid product.",
        422,
      );
    }
    seen.add(shopifyProductId);
    const methods: SaveProductProductionConfigurationInput["methods"] = {};
    for (const definition of definitions.filter(
      (item) => item.enabled !== false,
    )) {
      const methodPrefix = `${prefix}.method.${definition.id}`;
      if (definition.pricingBehavior === "TIERED") {
        const tiers: Record<string, { enabled: boolean; surcharge: string }> = {};
        for (const tier of definition.tiers) {
          const surcharge = form.get(`${methodPrefix}.${tier}.surcharge`);
          if (surcharge !== null) {
            tiers[tier] = {
              enabled: form.get(`${methodPrefix}.${tier}.enabled`) === "on",
              surcharge: validatedSurcharge(surcharge),
            };
          }
        }
        if (Object.keys(tiers).length) {
          methods[definition.id] = { enabled: true, tiers };
        }
        continue;
      }
      const surcharge = form.get(`${methodPrefix}.surcharge`);
      if (surcharge !== null) {
        methods[definition.id] = {
          enabled: form.get(`${methodPrefix}.enabled`) === "on",
          surcharge: validatedSurcharge(surcharge),
        };
      }
    }
    products.push({ shopifyProductId, currency, methods });
  }
  return products;
}
