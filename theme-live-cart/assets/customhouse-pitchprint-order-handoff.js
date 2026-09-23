(() => {
  const state = window.__customHousePitchPrintOrderHandoffState = window.__customHousePitchPrintOrderHandoffState || {
    initialized: false,
    listenerBound: false,
    propertyHookInstalled: false,
    propertyHookUnavailable: false,
    snapshot: null,
    config: null,
    inFlight: false,
    handledProjects: new Set(),
  };

  if (!(state.handledProjects instanceof Set)) state.handledProjects = new Set();
  if (state.initialized) return;
  state.initialized = true;

  const rootSelector = '[data-customhouse-pitchprint-required="true"]';
  const triggerSelector = '[data-pitchprint-customize-trigger]';
  const formSelector = 'form[data-customhouse-pitchprint-form="true"]';
  const log = (message, detail) => {
    if (detail) {
      console.log(`[CustomHouse PitchPrint] ${message}`, detail);
    } else {
      console.log(`[CustomHouse PitchPrint] ${message}`);
    }
  };
  const warn = (message) => console.warn(`[CustomHouse PitchPrint] ${message}`);

  const route = (path) => {
    const root = window.Shopify?.routes?.root || '/';
    return root.replace(/\/?$/, '/') + String(path || '').replace(/^\//, '');
  };

  const setStatus = (root, message = '', isError = false) => {
    const status = root?.querySelector?.('[data-cart-status]');
    if (!status) return;
    status.textContent = message;
    status.classList.toggle('is-error', Boolean(isError));
    status.hidden = !message;
  };

  const validUrl = (value) => {
    const url = String(value || '').trim();
    if (!/^https?:\/\//i.test(url)) return '';
    try {
      const parsed = new URL(url);
      return /^https?:$/i.test(parsed.protocol) ? parsed.href : '';
    } catch {
      return '';
    }
  };

  const previewFrom = (value) => {
    const direct = validUrl(value);
    if (direct || !value || typeof value !== 'object') return direct;
    for (const key of ['url', 'src', 'preview', 'image']) {
      const found = validUrl(value[key]);
      if (found) return found;
    }
    return '';
  };

  const firstPreviewUrl = (previews) => {
    for (const preview of (Array.isArray(previews) ? previews : [previews])) {
      const found = previewFrom(preview);
      if (found) return found;
    }
    return '';
  };

  const getRootProductId = (root) => String(root?.querySelector?.('[data-marked-product-actions]')?.dataset.productId || '').trim();

  const METHOD_DETAILS = {
    EMBROIDERY: {
      id: 'embroidery',
      label: 'Embroidery',
      maxWidthCm: 8,
      maxHeightCm: 8,
    },
    DTF: {
      id: 'dtf',
      label: 'DTF printing',
      maxWidthCm: 35,
      maxHeightCm: 40,
    },
    DTG: {
      id: 'dtg',
      label: 'DTG printing',
      maxWidthCm: 35,
      maxHeightCm: 40,
    },
  };

  const parseJson = (value, fallback = null) => {
    try {
      return JSON.parse(value || '');
    } catch {
      return fallback;
    }
  };

  const normalizeVariantId = (value) => {
    const text = String(value || '').trim();
    const match = text.match(/(\d+)$/);
    return match ? match[1] : text;
  };

  const optionValues = (actions, position, selector) => {
    if (!Number.isFinite(position) || position <= 0) return [];
    const values = Array.from(actions.querySelectorAll(selector))
      .map((element) => String(element.dataset.colorOptionValue || element.dataset.sizeOptionValue || '').trim())
      .filter(Boolean);
    return Array.from(new Set(values));
  };

  const selectedVariantId = (actions) => {
    const form = actions?.querySelector?.(formSelector);
    return String(
      form?.querySelector?.('input[name="id"]')?.value ||
      actions?.dataset.initialVariantId ||
      ''
    ).trim();
  };

  const selectedQuantity = (actions) => {
    const form = actions?.querySelector?.(formSelector);
    const quantityInput = form?.querySelector?.('input[name="quantity"]') || actions?.querySelector?.('.marked-product-actions__qty-input[name="quantity"]');
    const quantity = Number(quantityInput?.value || actions?.dataset.initialQuantity || 1);
    return Number.isFinite(quantity) && quantity > 0 ? Math.floor(quantity) : 1;
  };

  const moneyFromMinor = (minor, currency) => {
    const amount = Number(minor || 0) / 100;
    try {
      return new Intl.NumberFormat(undefined, {
        style: 'currency',
        currency: currency || 'SEK',
      }).format(amount);
    } catch {
      return `${amount.toFixed(2)} ${currency || 'SEK'}`;
    }
  };

  const methodCode = (value) => {
    const text = String(value || '').trim().toUpperCase();
    if (text === 'EMBROIDERY' || text === 'DTF' || text === 'DTG') return text;
    if (text === 'EMBROIDERY PRINTING') return 'EMBROIDERY';
    if (text.includes('EMBROIDERY')) return 'EMBROIDERY';
    if (text.includes('DTF')) return 'DTF';
    if (text.includes('DTG')) return 'DTG';
    return '';
  };

  const normalizedOptionValue = (value) => String(value || '').trim().toLowerCase();

  const directProductionMethod = (record) => {
    if (!record || typeof record !== 'object') return '';
    const candidates = [
      record.productionMethod,
      record.production_method,
      record.method,
      record.printMethod,
      record.print_method,
      record.printingMethod,
      record.printing_method,
      record.selectedProductionMethod,
      record.selected_production_method,
    ];
    for (const candidate of candidates) {
      const code = methodCode(candidate);
      if (code) return code;
    }
    return '';
  };

  const findProductionMethodDeep = (value, depth = 0, seen = new Set()) => {
    const direct = methodCode(value);
    if (direct) return direct;
    if (!value || typeof value !== 'object' || depth > 5 || seen.has(value)) return '';
    seen.add(value);

    const recordDirect = directProductionMethod(value);
    if (recordDirect) return recordDirect;

    const entries = Array.isArray(value)
      ? value.map((item, index) => [String(index), item])
      : Object.entries(value);
    for (const [key, entryValue] of entries) {
      const keyText = String(key || '').toLowerCase();
      if (
        keyText.includes('method') ||
        keyText.includes('printing') ||
        keyText.includes('print') ||
        keyText.includes('production')
      ) {
        const keyed = methodCode(entryValue);
        if (keyed) return keyed;
      }
      const nested = findProductionMethodDeep(entryValue, depth + 1, seen);
      if (nested) return nested;
    }
    return '';
  };

  const selectedProductionMethod = (value, source) => {
    for (const candidate of [value, source]) {
      const code = findProductionMethodDeep(candidate);
      if (code) return code;
    }
    return '';
  };

  const numberFrom = (...values) => {
    for (const value of values) {
      const number = Number(value);
      if (Number.isFinite(number) && number > 0) return Math.floor(number);
    }
    return 0;
  };

  const optionValueFrom = (item, keys, allowedValues = []) => {
    if (!item || typeof item !== 'object') return '';
    for (const key of keys) {
      const value = normalizedOptionValue(item[key]);
      if (value) return value;
    }
    const allowed = allowedValues.map(normalizedOptionValue).filter(Boolean);
    if (!allowed.length) return '';
    const values = Object.values(item).map(normalizedOptionValue).filter(Boolean);
    return allowed.find((allowedValue) => values.includes(allowedValue)) || '';
  };

  const selectionFromOptions = (item, config) => {
    if (!item || typeof item !== 'object' || !config) return null;
    const quantity = numberFrom(item.quantity, item.qty, item.count, item.amount, 1);
    const color = optionValueFrom(
      item,
      ['color', 'colour', 'colorValue', 'colourValue', 'selectedColor', 'selected_colour'],
      config.colors
    );
    const size = optionValueFrom(
      item,
      ['size', 'sizeValue', 'selectedSize', 'selected_size'],
      config.sizes
    );
    if (!color && !size) return null;
    const variant = (config.variants || []).find((candidate) => {
      const options = (candidate.options || []).map(normalizedOptionValue);
      if (color && !options.includes(color)) return false;
      if (size && !options.includes(size)) return false;
      return true;
    });
    if (!variant) return null;
    return {
      variantId: normalizeVariantId(variant.id),
      quantity,
    };
  };

  const selectionFrom = (item, config) => {
    if (!item || typeof item !== 'object') return null;
    const variantId = normalizeVariantId(item.variantId || item.variant_id || item.id || item.merchandiseId || item.merchandise_id);
    const quantity = numberFrom(item.quantity, item.qty, item.count, item.amount);
    if (variantId && quantity) {
      return {
        variantId,
        quantity,
      };
    }
    return selectionFromOptions(item, config);
  };

  const mergeSelections = (selections) => {
    const byVariant = new Map();
    for (const selection of selections) {
      if (!selection?.variantId || !selection.quantity) continue;
      byVariant.set(
        selection.variantId,
        (byVariant.get(selection.variantId) || 0) + selection.quantity
      );
    }
    return Array.from(byVariant, ([variantId, quantity]) => ({ variantId, quantity }));
  };

  const collectSelections = (value, config, depth = 0, seen = new Set()) => {
    if (!value || typeof value !== 'object' || depth > 5 || seen.has(value)) return [];
    seen.add(value);

    if (Array.isArray(value)) {
      const direct = value.map((item) => selectionFrom(item, config)).filter(Boolean);
      if (direct.length) return direct;
      return value.flatMap((item) => collectSelections(item, config, depth + 1, seen));
    }

    const selections = [];
    for (const [key, nestedValue] of Object.entries(value)) {
      const keyText = String(key || '').toLowerCase();
      if (
        Array.isArray(nestedValue) &&
        (
          keyText.includes('selection') ||
          keyText.includes('line') ||
          keyText.includes('item') ||
          keyText.includes('variant') ||
          keyText.includes('color') ||
          keyText.includes('colour') ||
          keyText.includes('size')
        )
      ) {
        selections.push(...collectSelections(nestedValue, config, depth + 1, seen));
      } else if (nestedValue && typeof nestedValue === 'object') {
        selections.push(...collectSelections(nestedValue, config, depth + 1, seen));
      }
    }
    return selections;
  };

  const savedSelections = (value, source, snapshot, config) => {
    const selections = mergeSelections([
      ...collectSelections(value, config),
      ...collectSelections(source, config),
    ]);
    if (selections.length) return selections;
    return [
      {
        variantId: String(snapshot.variantId),
        quantity: snapshot.quantity,
      },
    ];
  };

  const postJson = (url, payload) => new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();

    request.open('POST', url, true);
    request.withCredentials = true;
    request.setRequestHeader('Accept', 'application/json');
    request.setRequestHeader('Content-Type', 'application/json');
    request.onload = () => {
      const responseData = parseJson(request.responseText || '{}', {});
      if (request.status >= 200 && request.status < 300) {
        resolve(responseData);
        return;
      }

      const message =
        responseData?.error?.message ||
        responseData?.description ||
        responseData?.message ||
        `Request failed with status ${request.status}`;
      const error = new Error(message);
      error.status = request.status;
      reject(error);
    };
    request.onerror = () => {
      const error = new Error('A network error occurred while preparing your customized product.');
      error.status = request.status || 0;
      reject(error);
    };
    request.ontimeout = () => {
      const error = new Error('The cart request timed out. Please try again.');
      error.status = 0;
      reject(error);
    };
    request.timeout = 20000;
    request.send(JSON.stringify(payload));
  });

  const normalizeProductionMethods = (pricing) => {
    const methods = pricing?.productionMethodPricing || {};
    return Object.keys(METHOD_DETAILS).map((code) => {
      const detail = METHOD_DETAILS[code];
      const configured = methods[code] || (Array.isArray(pricing?.productionMethods)
        ? pricing.productionMethods.find((method) => String(method?.id || '').toUpperCase() === code)
        : null);
      const surchargeMinor = Number(configured?.surchargeMinor || 0);
      const feeVariantGid = String(configured?.feeVariantGid || configured?.productionFeeVariantId || configured?.shopifyFeeVariantId || '').trim();
      const feeVariantId = String(configured?.feeVariantId || normalizeVariantId(feeVariantGid)).trim();
      return {
        id: detail.id,
        label: detail.label,
        surchargeMinor: Number.isFinite(surchargeMinor) && surchargeMinor > 0 ? Math.round(surchargeMinor) : 0,
        ...(feeVariantId ? { feeVariantId } : {}),
        ...(feeVariantGid ? { feeVariantGid } : {}),
        maxWidthCm: detail.maxWidthCm,
        maxHeightCm: detail.maxHeightCm,
      };
    });
  };

  const buildProductConfig = (root) => {
    const actions = root?.querySelector?.('[data-marked-product-actions]');
    if (!actions || actions.dataset.customhousePitchprintRequired !== 'true') return null;

    const rawPricing = actions.querySelector('[data-customhouse-production-pricing-json]')?.textContent || '';
    const pricing = parseJson(rawPricing, null);
    const productionMethods = normalizeProductionMethods(pricing);
    if (!productionMethods.some((method) => method.surchargeMinor > 0)) return null;

    const variants = parseJson(actions.dataset.productVariants, []).map((variant) => ({
      id: normalizeVariantId(variant.id),
      gid: String(variant.admin_graphql_api_id || variant.gid || ''),
      title: variant.title || '',
      price: variant.price,
      priceMinor: Number(variant.price || 0),
      available: variant.available !== false,
      options: Array.isArray(variant.options) ? variant.options : [variant.option1, variant.option2, variant.option3].filter(Boolean),
    }));
    const sizePosition = Number(actions.dataset.sizeOptionPosition || 0);
    const colorPosition = Number(actions.dataset.colorOptionPosition || 0);

    return {
      version: 1,
      productId: String(actions.dataset.productId || ''),
      productHandle: String(actions.dataset.productHandle || ''),
      productTitle: String(actions.dataset.productTitle || ''),
      currency: String(pricing?.currency || actions.dataset.currency || 'SEK').toUpperCase(),
      variants,
      colors: optionValues(actions, colorPosition, '[data-color-option-value]'),
      sizes: optionValues(actions, sizePosition, '[data-size-option-value]'),
      optionGroups: [
        {
          id: 'color',
          label: 'Color',
          values: optionValues(actions, colorPosition, '[data-color-option-value]'),
          multiple: true,
        },
        {
          id: 'size',
          label: 'Size',
          values: optionValues(actions, sizePosition, '[data-size-option-value]'),
          multiple: true,
        },
      ],
      supportsMultipleSelections: true,
      selectedColor: String(actions.dataset.selectedColor || ''),
      selectedSize: String(actions.dataset.selectedSize || ''),
      initialVariantId: selectedVariantId(actions),
      initialQuantity: selectedQuantity(actions),
      productionMethods,
      productionMethodPricing: Object.fromEntries(
        productionMethods.map((method) => [
          method.id,
          {
            label: method.label,
            surchargeMinor: method.surchargeMinor,
            ...(method.feeVariantId ? { feeVariantId: method.feeVariantId } : {}),
            ...(method.feeVariantGid ? { feeVariantGid: method.feeVariantGid } : {}),
            maxWidthCm: method.maxWidthCm,
            maxHeightCm: method.maxHeightCm,
          },
        ])
      ),
    };
  };

  const refreshPublicConfig = () => {
    const root = document.querySelector(rootSelector);
    const config = buildProductConfig(root);
    if (!config) return null;
    state.config = config;
    window.CustomHousePublicPitchPrintConfig = config;
    window.CustomHousePitchPrintBridgeDebug = {
      getFeeMappings() {
        const currentConfig = refreshPublicConfig() || state.config;
        return (currentConfig?.productionMethods || []).map((method) => ({
          id: method.id,
          label: method.label,
          surchargeMinor: method.surchargeMinor,
          feeVariantId: method.feeVariantId || '',
          feeVariantGid: method.feeVariantGid || '',
        }));
      },
    };
    log('Public PitchPrint config ready', {
      productId: config.productId,
      productionMethods: config.productionMethods.map((method) => ({
        id: method.id,
        surchargeMinor: method.surchargeMinor,
      })),
    });
    return config;
  };

  const respondWithProductConfig = (targetWindow) => {
    const config = refreshPublicConfig();
    if (!config || !targetWindow || typeof targetWindow.postMessage !== 'function') return false;
    targetWindow.postMessage({
      type: 'CUSTOMHOUSE_PP_ORDER_CONFIG_DATA',
      payload: config,
    }, '*');
    return true;
  };

  const captureSnapshotFromRoot = (root, message = 'Variant snapshot', triggerMatched = false) => {
    const form = root?.querySelector?.(formSelector);
    const variantInput = form?.querySelector?.('input[name="id"]');
    const variantId = Number(variantInput?.value || 0);
    const quantityInput = form?.querySelector?.('input[name="quantity"]') || root?.querySelector?.('.marked-product-actions__qty-input[name="quantity"]');
    const quantity = Math.max(1, Number(quantityInput?.value || 1));
    const detail = {
      variantId,
      quantity,
      triggerMatched,
      formMatched: Boolean(form),
    };

    if (!root || !form || !Number.isFinite(variantId) || variantId <= 0 || !Number.isFinite(quantity)) {
      warn('Missing snapshot');
      setStatus(root, 'Please select a valid product option before customizing.', true);
      return null;
    }

    state.snapshot = { root, form, variantId, quantity, productId: getRootProductId(root) };
    log(message, detail);
    setStatus(root, '', false);
    return state.snapshot;
  };

  const recoverSnapshotAtProjectSave = (source, value) => {
    const pitchPrintProductId = String(source.productId || source.product?.id || value.productId || '').trim();
    const roots = Array.from(document.querySelectorAll(rootSelector));
    let matchedRoots = [];

    if (pitchPrintProductId) {
      matchedRoots = roots.filter((root) => getRootProductId(root) === pitchPrintProductId);
    }

    if (matchedRoots.length !== 1) {
      matchedRoots = roots.length === 1 && roots[0].querySelectorAll(formSelector).length === 1 ? roots : [];
    }

    if (matchedRoots.length !== 1) return null;
    return captureSnapshotFromRoot(matchedRoots[0], 'Snapshot recovered at project save', false);
  };

  async function addProjectToCart(projectId, previewUrl, value = {}, source = {}) {
  const snapshot = state.snapshot;
  const root = snapshot?.root;
  const config = refreshPublicConfig() || state.config;

  if (!snapshot) {
    warn('Missing snapshot');
    return;
  }

  const variantId = Number(snapshot.variantId);
  const quantity = Number(snapshot.quantity);

  if (
    !Number.isFinite(variantId) ||
    variantId <= 0 ||
    !Number.isFinite(quantity) ||
    quantity < 1
  ) {
    warn('Invalid variant');
    setStatus(
      root,
      'Please select a valid product option before customizing.',
      true
    );
    return;
  }

  const productionMethod = selectedProductionMethod(value, source);
  const configuredMethod = config?.productionMethodPricing?.[productionMethod] ||
    (config?.productionMethods || []).find((method) => methodCode(method.id) === productionMethod);

  if (!productionMethod || !configuredMethod) {
    warn('Missing production method');
    setStatus(
      root,
      'Choose a printing method before adding this custom product to the cart.',
      true
    );
    return;
  }

  if (Number(configuredMethod.surchargeMinor || 0) > 0 && !configuredMethod.feeVariantId) {
    warn('Missing production fee variant');
    setStatus(
      root,
      'This printing method is temporarily unavailable. Please choose another method or try again later.',
      true
    );
    return;
  }

  if (state.inFlight) {
    warn('Request already in flight');
    return;
  }

  if (state.handledProjects.has(projectId)) {
    warn('Project already handled');
    return;
  }

  const selections = savedSelections(value, source, snapshot, config);
  const visibleProperties = {
    'Printing method': configuredMethod.label || productionMethod,
    'Printing charge / item': moneyFromMinor(configuredMethod.surchargeMinor, config?.currency || 'SEK'),
  };

  state.inFlight = true;

  log('Cart add started', { productionMethod, selections });

  setStatus(
    root,
    'Adding your custom product to the cart...',
    false
  );

  try {
    const prepared = await postJson('/apps/customhouse/api/public-production-cart', {
      shopifyProductId: config?.productId || snapshot.productId,
      pitchprintProjectId: projectId,
      productionMethod,
      selections,
      previewUrl,
    });
    const preparedItems = Array.isArray(prepared?.items) ? prepared.items : [];
    if (!prepared?.ok || !preparedItems.length) {
      throw new Error(prepared?.error?.message || 'Production pricing could not be prepared.');
    }

    const cartItems = preparedItems.map((item) => {
      const properties = {
        ...(item.properties || {}),
      };
      if (!properties._customhouse_fee_key) {
        throw new Error('Production fee pairing could not be prepared.');
      }
      if (properties._customhouse_production_fee === 'true') {
        properties['Printing method'] = visibleProperties['Printing method'];
      } else {
        properties['Printing method'] = visibleProperties['Printing method'];
        properties['Printing charge / item'] = visibleProperties['Printing charge / item'];
      }
      return {
        id: item.id,
        quantity: item.quantity,
        properties,
      };
    });

    await postJson(route('cart/add.js'), { items: cartItems });
  } catch (error) {
    state.inFlight = false;

    console.warn(
      '[CustomHouse PitchPrint] Cart add failed',
      {
        status: error?.status,
        message: error?.message || 'request failed',
      }
    );

    setStatus(
      root,
      error?.message || 'We could not add your custom product to the cart. Please try again.',
      true
    );

    return;
  }

  // The Shopify request has definitely succeeded at this point.
  state.handledProjects.add(projectId);
  state.inFlight = false;

  log('Cart add succeeded');
  setStatus(root, '', false);

  // Keep navigation outside the request error boundary.
  window.location.href = route('cart');
}

  function handleProjectSaved(event) {
    log('Project saved');
    const message = event?.data ?? event ?? {};
    const value = message?.value ?? message ?? {};
    const source = value?.source ?? {};
    const projectId = String(source.projectId || value.projectId || '').trim();

    if (!state.snapshot && !recoverSnapshotAtProjectSave(source, value)) {
      warn('Missing snapshot');
      setStatus(state.snapshot?.root, 'Please customize this product again before adding it to the cart.', true);
      return;
    }

    if (!projectId) {
      warn('Missing project ID');
      setStatus(state.snapshot?.root, 'We could not receive your saved design. Please try submitting it again.', true);
      return;
    }

    addProjectToCart(projectId, firstPreviewUrl(value.previews), value, source);
  }

  function bindPitchPrintClient(client) {
    if (state.listenerBound) return true;
    if (!client || typeof client.on !== 'function') return false;

    try {
      client.on('project-saved', handleProjectSaved);
      state.listenerBound = true;
      setStatus(state.snapshot?.root, '', false);
      log('Listener bound');
      return true;
    } catch (error) {
      warn(`Client unavailable: ${error?.message || 'listener registration failed'}`);
      return false;
    }
  }

  function installPitchPrintClientHook() {
    if (state.propertyHookInstalled || state.listenerBound) return;

    const descriptor = Object.getOwnPropertyDescriptor(window, 'ppclient');
    if (descriptor && descriptor.configurable === false) {
      state.propertyHookUnavailable = true;
      warn('Client unavailable');
      return;
    }

    let storedValue = descriptor && 'value' in descriptor ? descriptor.value : undefined;
    const readValue = () => descriptor?.get ? descriptor.get.call(window) : storedValue;

    state.propertyHookInstalled = true;
    Object.defineProperty(window, 'ppclient', {
      configurable: true,
      enumerable: descriptor ? descriptor.enumerable : true,
      get() {
        return readValue();
      },
      set(value) {
        if (descriptor?.set) {
          descriptor.set.call(window, value);
        } else if (!descriptor || descriptor.writable !== false) {
          storedValue = value;
        }
        bindPitchPrintClient(value);
      },
    });

    bindPitchPrintClient(readValue());
  }

  function ensurePitchPrintListener() {
    if (state.listenerBound) return true;
    if (bindPitchPrintClient(window.ppclient)) return true;
    installPitchPrintClientHook();
    return state.listenerBound;
  }

  document.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const root = target?.closest(triggerSelector)?.closest?.(rootSelector);
    if (!root) return;

    captureSnapshotFromRoot(root, 'Variant snapshot', true);
    if (!ensurePitchPrintListener() && state.propertyHookUnavailable) {
      requestAnimationFrame(ensurePitchPrintListener);
    }
  }, true);

  window.addEventListener('message', (event) => {
    const message = event?.data || {};
    if (message?.type !== 'CUSTOMHOUSE_PP_ORDER_CONFIG_REQUEST') return;
    respondWithProductConfig(event.source);
  });

  window.addEventListener('customhouse:pitchprint-order-config-request', (event) => {
    const detail = event?.detail || {};
    const targetWindow = detail.contentWindow || detail.source || detail.iframe?.contentWindow || detail.targetWindow || null;
    respondWithProductConfig(targetWindow);
  });

  log('Initialized');
  refreshPublicConfig();
  ensurePitchPrintListener();
})();
