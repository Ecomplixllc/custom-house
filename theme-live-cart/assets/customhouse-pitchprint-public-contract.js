/* global globalThis */
(function attachCustomHousePublicPitchPrintContract(global) {
  const CONTRACT_VERSION = 'PUBLIC_CUSTOMIZE_V2';

  const text = (value) => String(value == null ? '' : value).trim();

  const normalizeVariantId = (value) => {
    const valueText = text(value);
    const match = valueText.match(/(\d+)$/);
    return match ? match[1] : valueText;
  };

  const normalizeOptionName = (value) => text(value).toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');

  const semanticOption = (value) => {
    const name = normalizeOptionName(value);
    if (name.includes('color') || name.includes('colour') || name.includes('farg')) return 'color';
    if (name.includes('size') || name.includes('storlek')) return 'size';
    return '';
  };

  const optionIndex = (optionNames, semantic, fallbackPosition) => {
    const semanticIndex = optionNames.findIndex((name) => semanticOption(name) === semantic);
    if (semanticIndex >= 0) return semanticIndex;
    const position = Number(fallbackPosition || 0);
    return Number.isSafeInteger(position) && position > 0 ? position - 1 : -1;
  };

  const priceMinor = (variant) => {
    const value = Number(variant?.priceMinor ?? variant?.price ?? 0);
    return Number.isFinite(value) && value >= 0 ? Math.round(value) : 0;
  };

  function buildVariantMatrix(input) {
    const optionNames = Array.isArray(input?.optionNames)
      ? input.optionNames.map(text)
      : [];
    const colorIndex = optionIndex(optionNames, 'color', input?.colorPosition);
    const sizeIndex = optionIndex(optionNames, 'size', input?.sizePosition);
    const currency = text(input?.currency || 'SEK').toUpperCase();

    return (Array.isArray(input?.variants) ? input.variants : []).map((variant) => {
      const values = Array.isArray(variant?.options)
        ? variant.options.map(text)
        : [variant?.option1, variant?.option2, variant?.option3].map(text);
      const variantId = normalizeVariantId(variant?.variantId || variant?.id);
      const variantGid = text(
        variant?.variantGid ||
        variant?.admin_graphql_api_id ||
        variant?.gid ||
        (variantId ? `gid://shopify/ProductVariant/${variantId}` : '')
      );
      const color = colorIndex >= 0 ? text(values[colorIndex]) : '';
      const size = sizeIndex >= 0 ? text(values[sizeIndex]) : '';
      const optionValues = {};
      optionNames.forEach((name, index) => {
        if (name && values[index]) optionValues[name] = values[index];
      });

      return {
        variantId,
        variantGid,
        id: variantId,
        gid: variantGid,
        title: text(variant?.title),
        options: {
          ...(color ? { Color: color } : {}),
          ...(size ? { Size: size } : {}),
        },
        optionValues,
        color,
        size,
        available: variant?.available !== false,
        priceMinor: priceMinor(variant),
        currency,
      };
    }).filter((variant) => variant.variantId && variant.variantGid);
  }

  function stableValue(value) {
    if (Array.isArray(value)) return value.map(stableValue);
    if (!value || typeof value !== 'object') return value;
    return Object.keys(value).sort().reduce((result, key) => {
      result[key] = stableValue(value[key]);
      return result;
    }, {});
  }

  function revisionFor(value) {
    const serialized = JSON.stringify(stableValue(value));
    let hash = 2166136261;
    for (let index = 0; index < serialized.length; index += 1) {
      hash ^= serialized.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return `${CONTRACT_VERSION}-${(hash >>> 0).toString(16).padStart(8, '0')}`;
  }

  function integrationSettings(revision) {
    return {
      mode: 'PUBLIC_CUSTOMIZE',
      contractVersion: CONTRACT_VERSION,
      configRevision: text(revision),
      variantSelectionMode: 'COLOR_SIZE_MATRIX',
      supportsMultipleVariantSelections: true,
      configRequestMessageType: 'CUSTOMHOUSE_PP_ORDER_CONFIG_REQUEST',
      configResponseMessageType: 'CUSTOMHOUSE_PP_ORDER_CONFIG_DATA',
      configAcknowledgementMessageType: 'CUSTOMHOUSE_PP_ORDER_CONFIG_ACK',
      cartReadyMessageType: 'CUSTOMHOUSE_PP_CART_READY',
      cartAcknowledgementMessageType: 'CUSTOMHOUSE_PP_CART_READY_ACK',
    };
  }

  const positiveInteger = (...values) => {
    for (const value of values) {
      const number = Number(value);
      if (Number.isSafeInteger(number) && number > 0) return number;
    }
    return 0;
  };

  const normalizedOptionValue = (value) => text(value).toLowerCase();

  const optionValueFrom = (item, keys, allowedValues = []) => {
    if (!item || typeof item !== 'object') return '';
    for (const key of keys) {
      const value = normalizedOptionValue(item[key]);
      if (value) return value;
    }
    const allowed = allowedValues.map(normalizedOptionValue).filter(Boolean);
    const values = Object.values(item).map(normalizedOptionValue).filter(Boolean);
    return allowed.find((allowedValue) => values.includes(allowedValue)) || '';
  };

  const canonicalSelection = (item, config) => {
    if (!item || typeof item !== 'object') return null;
    const variants = Array.isArray(config?.variants) ? config.variants : [];
    const variantId = normalizeVariantId(
      item.variantId || item.variantGid || item.variant_id || item.id ||
      item.merchandiseId || item.merchandise_id
    );
    const quantity = positiveInteger(item.quantity, item.qty, item.count, item.amount);
    let variant = variantId
      ? variants.find((candidate) => normalizeVariantId(candidate.variantId || candidate.id) === variantId)
      : null;
    if (!variant) {
      const color = optionValueFrom(
        item,
        ['color', 'colour', 'colorValue', 'colourValue', 'selectedColor', 'selected_colour'],
        config?.colors
      );
      const size = optionValueFrom(
        item,
        ['size', 'sizeValue', 'selectedSize', 'selected_size'],
        config?.sizes
      );
      if (!color && !size) return null;
      variant = variants.find((candidate) => {
        if (color && normalizedOptionValue(candidate.color) !== color) return false;
        if (size && normalizedOptionValue(candidate.size) !== size) return false;
        return true;
      });
    }
    if (!variant || !quantity) return null;
    return {
      variantId: normalizeVariantId(variant.variantId || variant.id),
      variantGid: text(variant.variantGid || variant.gid),
      color: text(variant.color),
      size: text(variant.size),
      quantity,
    };
  };

  const explicitSelectionArray = (value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const explicitKeys = [
      'variantSelections',
      'selectedVariants',
      'selectedVariantSelections',
      'cartSelections',
      'selections',
    ];
    for (const key of explicitKeys) {
      if (Array.isArray(value[key])) return value[key];
    }
    return null;
  };

  const collectCartSelections = (value, config, depth = 0, seen = new Set()) => {
    if (!value || typeof value !== 'object' || depth > 5 || seen.has(value)) return [];
    seen.add(value);
    if (Array.isArray(value)) {
      const direct = value.map((item) => canonicalSelection(item, config)).filter(Boolean);
      return direct.length
        ? direct
        : value.flatMap((item) => collectCartSelections(item, config, depth + 1, seen));
    }
    const explicit = explicitSelectionArray(value);
    if (explicit) return collectCartSelections(explicit, config, depth + 1, seen);
    return Object.entries(value).flatMap(([key, nestedValue]) => {
      const keyText = text(key).toLowerCase();
      if (keyText === 'source') return [];
      if (Array.isArray(nestedValue) && /selection|line|item|variant|colou?r|size/.test(keyText)) {
        return collectCartSelections(nestedValue, config, depth + 1, seen);
      }
      return nestedValue && typeof nestedValue === 'object'
        ? collectCartSelections(nestedValue, config, depth + 1, seen)
        : [];
    });
  };

  function buildCartSelectionContract({ value = {}, source = {}, snapshot = null, config = {} } = {}) {
    const byVariant = new Map();
    const valueSelections = collectCartSelections(value, config);
    const canonicalSelections = valueSelections.length
      ? valueSelections
      : collectCartSelections(source, config);
    for (const selection of canonicalSelections) {
      const existing = byVariant.get(selection.variantId);
      byVariant.set(selection.variantId, {
        ...selection,
        quantity: Number(existing?.quantity || 0) + selection.quantity,
      });
    }
    let selections = Array.from(byVariant.values());
    if (!selections.length) {
      const fallback = canonicalSelection({
        variantId: snapshot?.variantId,
        quantity: snapshot?.quantity,
      }, config);
      selections = fallback ? [fallback] : [];
    }
    return {
      selections,
      selectionCount: selections.length,
      totalQuantity: selections.reduce((sum, selection) => sum + selection.quantity, 0),
    };
  }

  function buildProductionMethodPricing(methods) {
    return (Array.isArray(methods) ? methods : []).reduce((result, method) => {
      const code = text(method?.id).toUpperCase();
      if (!/^[A-Z][A-Z0-9_]{1,63}$/.test(code)) return result;
      const pricing = { ...method };
      delete pricing.id;
      result[code] = pricing;
      return result;
    }, {});
  }

  // Availability comes from the explicit product list, never from registry defaults.
  function normalizeProductionMethods(pricing) {
    const source = Array.isArray(pricing?.productionMethods)
      ? pricing.productionMethods
      : Object.entries(pricing?.productionMethodPricing || {}).map(([id, rate]) => ({ id, ...rate }));
    return source.filter((method) => method && method.enabled !== false).flatMap((method) => {
      const code = text(method.code || method.id || method.method).toUpperCase();
      if (!/^[A-Z][A-Z0-9_]{1,63}$/.test(code)) return [];
      const tiers = method.pricingTiers || method.embroiderySubtypes ||
        (code === 'EMBROIDERY' ? pricing?.embroideryPricing : null);
      return [{
        ...method,
        id: code.toLowerCase(),
        code,
        label: text(method.label || code.replace(/_/g, ' ')),
        enabled: true,
        currency: text(method.currency || pricing?.currency || 'SEK').toUpperCase(),
        ...(tiers ? { pricingTiers: tiers } : {}),
        ...(code === 'EMBROIDERY' && tiers ? { embroiderySubtypes: tiers } : {}),
      }];
    });
  }

  function pricingCompleteness(config) {
    const embroidery = config?.embroideryPricing ||
      config?.productionMethodPricing?.EMBROIDERY?.embroiderySubtypes || {};
    const pricing = config?.productionMethodPricing || {};
    return Object.entries(pricing).reduce((count, [code, rate]) => {
      if (code === 'EMBROIDERY') {
        return count + Object.values(embroidery).filter((item) =>
          Number.isFinite(Number(item?.surchargeMinor))
        ).length;
      }
      return count + (Number.isFinite(Number(rate?.surchargeMinor)) ? 1 : 0);
    }, 0);
  }

  function chooseCanonicalConfig(current, candidate) {
    if (!current) return candidate;
    if (!candidate) return current;
    if (text(current.productId) !== text(candidate.productId)) return candidate;
    if (current.productionMethodsResolved && !candidate.productionMethodsResolved) return current;
    if (candidate.productionMethodsResolved && Array.isArray(candidate.productionMethods)) {
      if (current.productionMethodsResolved && candidate.revision === current.revision) return current;
      // A smaller list (including []) is a valid authoritative admin change.
      return {
        ...candidate,
        variants: (candidate.variants?.length || 0) < (current.variants?.length || 0)
          ? current.variants : candidate.variants,
      };
    }
    const currentCount = Array.isArray(current.variants) ? current.variants.length : 0;
    const candidateCount = Array.isArray(candidate.variants) ? candidate.variants.length : 0;
    if (candidateCount < currentCount) return current;
    if (candidateCount === currentCount && pricingCompleteness(candidate) < pricingCompleteness(current)) {
      return current;
    }
    if (candidate.revision === current.revision) return current;
    return candidate;
  }

  global.CustomHousePublicPitchPrintContract = Object.freeze({
    CONTRACT_VERSION,
    buildCartSelectionContract,
    buildProductionMethodPricing,
    buildVariantMatrix,
    chooseCanonicalConfig,
    integrationSettings,
    normalizeVariantId,
    normalizeProductionMethods,
    revisionFor,
    semanticOption,
  });
})(typeof window !== 'undefined' ? window : globalThis);
