(function attachCustomHouseCartSummary(root) {
  'use strict';

  const DEFAULT_SIZES = ['S', 'M', 'L', 'XL'];

  const clean = (value) => String(value == null ? '' : value).trim();
  const positiveInteger = (value, fallback = 1) => {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
  };
  const itemProperties = (item) => item && typeof item.properties === 'object' && item.properties
    ? item.properties
    : {};
  const feeKey = (item) => clean(itemProperties(item)._customhouse_fee_key);
  const isFeeLine = (item) => clean(itemProperties(item)._customhouse_production_fee) === 'true';
  const isPublicBaseLine = (item) => {
    const properties = itemProperties(item);
    return !isFeeLine(item) && (
      clean(properties._customhouse_public_customize) === 'true' ||
      clean(properties._customhouse_public_cart_validation) !== ''
    );
  };
  const lineKey = (item) => clean(item && (item.key || item.id));

  function optionValue(item, names) {
    const expected = new Set(names.map((name) => name.toLowerCase()));
    const options = Array.isArray(item && item.options_with_values)
      ? item.options_with_values
      : [];
    for (const option of options) {
      if (expected.has(clean(option && option.name).toLowerCase())) {
        return clean(option && option.value);
      }
    }
    return '';
  }

  function artworkLabel(value) {
    const normalized = clean(value).toUpperCase();
    if (normalized === 'TEXT_ONLY') return 'Text only';
    if (normalized === 'IMAGE_OR_LOGO' || normalized === 'IMAGE_LOGO') return 'Image / Logo';
    return clean(value);
  }

  function methodLabel(properties) {
    const visible = clean(properties['Printing method']);
    if (visible) return visible;
    const normalized = clean(properties._production_method).toUpperCase();
    if (normalized === 'EMBROIDERY') return 'Embroidery';
    if (normalized === 'DTF') return 'DTF';
    if (normalized === 'DTG') return 'DTG';
    return clean(properties._production_method);
  }

  function groupCartItems(cart) {
    const items = Array.isArray(cart && cart.items) ? cart.items : [];
    const groups = new Map();

    for (const item of items) {
      const key = feeKey(item);
      if (!key || (!isFeeLine(item) && !isPublicBaseLine(item))) continue;
      if (!groups.has(key)) groups.set(key, { baseLines: [], feeLines: [] });
      const group = groups.get(key);
      if (isFeeLine(item)) group.feeLines.push(item);
      else group.baseLines.push(item);
    }

    const summaries = [];
    for (const [key, group] of groups) {
      if (!group.baseLines.length || !group.feeLines.length) continue;

      const lead = group.baseLines[0];
      const leadProperties = itemProperties(lead);
      const sizes = [...DEFAULT_SIZES];
      const colorOrder = [];
      const quantitiesByColor = new Map();
      let totalQuantity = 0;
      let totalMinor = 0;

      for (const item of group.baseLines) {
        const quantity = positiveInteger(item.quantity, 0);
        const color = optionValue(item, ['Color', 'Colour', 'Färg']) || 'Default';
        const size = optionValue(item, ['Size', 'Storlek']) || 'One size';
        if (!sizes.includes(size)) sizes.push(size);
        if (!quantitiesByColor.has(color)) {
          colorOrder.push(color);
          quantitiesByColor.set(color, {});
        }
        const colorQuantities = quantitiesByColor.get(color);
        colorQuantities[size] = Number(colorQuantities[size] || 0) + quantity;
        totalQuantity += quantity;
        totalMinor += Number(item.final_line_price || 0);
      }

      let feeQuantity = 0;
      let feeTotalMinor = 0;
      for (const item of group.feeLines) {
        feeQuantity += positiveInteger(item.quantity, 0);
        feeTotalMinor += Number(item.final_line_price || 0);
      }
      totalMinor += feeTotalMinor;

      summaries.push({
        feeKey: key,
        leadLineKey: lineKey(lead),
        lineKeys: [...group.baseLines, ...group.feeLines].map(lineKey).filter(Boolean),
        productionMethod: methodLabel(leadProperties),
        artworkType: artworkLabel(
          leadProperties['Artwork type'] || leadProperties._embroidery_subtype,
        ),
        printingChargeMinor: feeQuantity > 0 ? Math.round(feeTotalMinor / feeQuantity) : 0,
        placementCount: positiveInteger(leadProperties._designed_placement_count, 1),
        totalQuantity,
        totalMinor,
        sizes,
        colors: colorOrder.map((color) => ({
          color,
          quantities: Object.fromEntries(
            sizes.map((size) => [size, Number(quantitiesByColor.get(color)[size] || 0)]),
          ),
        })),
      });
    }

    return summaries;
  }

  function groupRemovalUpdates(cart, targetFeeKey) {
    const target = clean(targetFeeKey);
    const updates = {};
    if (!target) return updates;
    const items = Array.isArray(cart && cart.items) ? cart.items : [];
    for (const item of items) {
      const key = lineKey(item);
      if (key && feeKey(item) === target) updates[key] = 0;
    }
    return updates;
  }

  function moneyFormatter(currency) {
    try {
      return new Intl.NumberFormat(
        typeof navigator !== 'undefined' ? navigator.language : 'en',
        { style: 'currency', currency: clean(currency) || 'SEK' },
      );
    } catch {
      return { format: (value) => `${Number(value).toFixed(2)} ${clean(currency) || 'SEK'}` };
    }
  }

  function appendDetail(container, label, value) {
    if (!clean(value)) return;
    const row = document.createElement('div');
    row.className = 'customhouse-cart-group__detail';
    const name = document.createElement('strong');
    name.textContent = label;
    const content = document.createElement('span');
    content.textContent = value;
    row.append(name, content);
    container.append(row);
  }

  function renderGroupSummary(container, summary, currency) {
    const formatter = moneyFormatter(currency);
    const panel = document.createElement('div');
    panel.className = 'customhouse-cart-group';

    const details = document.createElement('div');
    details.className = 'customhouse-cart-group__details';
    appendDetail(details, 'Printing method', summary.productionMethod);
    appendDetail(details, 'Artwork type', summary.artworkType);
    appendDetail(
      details,
      'Printing charge',
      `${formatter.format(summary.printingChargeMinor / 100)} / item / placement`,
    );
    panel.append(details);

    const table = document.createElement('table');
    table.className = 'customhouse-cart-group__matrix';
    const head = document.createElement('thead');
    const headRow = document.createElement('tr');
    const colorHeading = document.createElement('th');
    colorHeading.scope = 'col';
    colorHeading.textContent = 'Color';
    headRow.append(colorHeading);
    for (const size of summary.sizes) {
      const heading = document.createElement('th');
      heading.scope = 'col';
      heading.textContent = size;
      headRow.append(heading);
    }
    head.append(headRow);
    table.append(head);

    const body = document.createElement('tbody');
    for (const color of summary.colors) {
      const row = document.createElement('tr');
      const name = document.createElement('th');
      name.scope = 'row';
      name.textContent = color.color;
      row.append(name);
      for (const size of summary.sizes) {
        const quantity = document.createElement('td');
        quantity.textContent = String(color.quantities[size] || 0);
        row.append(quantity);
      }
      body.append(row);
    }
    table.append(body);
    panel.append(table);

    const totals = document.createElement('div');
    totals.className = 'customhouse-cart-group__totals';
    appendDetail(totals, 'Total quantity', String(summary.totalQuantity));
    appendDetail(totals, 'Placements', String(summary.placementCount));
    appendDetail(totals, 'Total', formatter.format(summary.totalMinor / 100));
    panel.append(totals);
    container.append(panel);
  }

  function enhanceCart(cartRoot, cart) {
    if (!cartRoot || typeof cartRoot.querySelectorAll !== 'function') return [];
    const summaries = groupCartItems(cart);
    const rows = Array.from(cartRoot.querySelectorAll('[data-customhouse-cart-line]'));

    for (const summary of summaries) {
      const groupedRows = rows.filter(
        (row) => clean(row.dataset && row.dataset.customhouseFeeKey) === summary.feeKey,
      );
      const lead = groupedRows.find(
        (row) => clean(row.dataset && row.dataset.key) === summary.leadLineKey,
      );
      if (!lead) continue;

      for (const row of groupedRows) {
        if (row !== lead) row.hidden = true;
      }
      lead.classList.add('customhouse-cart__item--grouped');
      lead.dataset.customhouseGroupFeeKey = summary.feeKey;

      const product = lead.querySelector('.customhouse-cart__product');
      if (product) {
        product.querySelectorAll(
          '.customhouse-cart__meta, .customhouse-cart__properties, .customhouse-cart__discounts, .customhouse-cart-group',
        ).forEach((element) => element.remove());
        renderGroupSummary(product, summary, cart && cart.currency);
      }

      const price = lead.querySelector('.customhouse-cart__price');
      if (price) price.textContent = moneyFormatter(cart && cart.currency).format(summary.totalMinor / 100);
      const quantity = lead.querySelector('.customhouse-cart__quantity');
      if (quantity) quantity.hidden = true;
      const remove = lead.querySelector('.customhouse-cart__remove');
      if (remove) {
        remove.dataset.customhouseCartAction = 'remove-group';
        remove.setAttribute('aria-label', 'Remove customized product');
      }
    }

    return summaries;
  }

  root.CustomHouseCartSummary = Object.freeze({
    groupCartItems,
    groupRemovalUpdates,
    enhanceCart,
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
