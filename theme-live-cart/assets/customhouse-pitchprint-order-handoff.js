(() => {
  const state = window.__customHousePitchPrintOrderHandoffState = window.__customHousePitchPrintOrderHandoffState || {
    initialized: false,
    listenerBound: false,
    propertyHookInstalled: false,
    propertyHookUnavailable: false,
    snapshot: null,
    config: null,
    configRevision: '',
    acknowledgedRevision: '',
    loggedRevision: '',
    lastSaved: null,
    pendingPublicCart: null,
    publicSaveInFlight: false,
    inFlight: false,
    handledProjects: new Set(),
  };

  if (!(state.handledProjects instanceof Set)) state.handledProjects = new Set();
  if (!('pendingPublicCart' in state)) state.pendingPublicCart = null;
  if (!('publicSaveInFlight' in state)) state.publicSaveInFlight = false;
  if (state.initialized) return;
  state.initialized = true;

  const rootSelector = '[data-customhouse-pitchprint-required="true"]';
  const triggerSelector = '[data-pitchprint-customize-trigger]';
  const formSelector = 'form[data-customhouse-pitchprint-form="true"]';
  const PITCHPRINT_BUTTON_SELECTOR = '#pp_customize_design_btn';
  const PITCHPRINT_BUTTON_LABEL = 'Designa nu';
  const log = (message, detail) => {
    if (detail) {
      console.log(`[CustomHouse PitchPrint] ${message}`, detail);
    } else {
      console.log(`[CustomHouse PitchPrint] ${message}`);
    }
  };
  const warn = (message) => console.warn(`[CustomHouse PitchPrint] ${message}`);
  const publicContract = window.CustomHousePublicPitchPrintContract;
  const PENDING_PUBLIC_SAVE_ID = '__CUSTOMHOUSE_PUBLIC_SAVE_PENDING__';

  const applyPitchPrintButtonLabel = (root = document) => {
    const candidates = [];

    if (root instanceof Element && root.matches(PITCHPRINT_BUTTON_SELECTOR)) {
      candidates.push(root);
    }
    if (typeof root?.querySelectorAll === 'function') {
      candidates.push(...root.querySelectorAll(PITCHPRINT_BUTTON_SELECTOR));
    }

    for (const button of candidates) {
      if (button.textContent?.trim() !== PITCHPRINT_BUTTON_LABEL) {
        button.textContent = PITCHPRINT_BUTTON_LABEL;
      }
      button.setAttribute('aria-label', PITCHPRINT_BUTTON_LABEL);
    }
  };

  const pitchPrintButtonObserver = new MutationObserver((records) => {
    for (const record of records) {
      if (record.target instanceof Element) applyPitchPrintButtonLabel(record.target);
      for (const node of record.addedNodes) {
        if (node instanceof Element) applyPitchPrintButtonLabel(node);
      }
    }
  });

  applyPitchPrintButtonLabel();
  pitchPrintButtonObserver.observe(document.documentElement, { childList: true, subtree: true });

  if (!publicContract) {
    warn('Public customization contract unavailable');
    state.initialized = false;
    return;
  }

  const route = (path) => {
    const root = window.Shopify?.routes?.root || '/';
    return root.replace(/\/?$/, '/') + String(path || '').replace(/^\//, '');
  };

  const PITCHPRINT_ORIGIN = 'https://pitchprint.io';
  const isAllowedMessageOrigin = (origin) => {
    const value = String(origin || '').replace(/\/$/, '');
    return value === PITCHPRINT_ORIGIN || value === String(window.location?.origin || '').replace(/\/$/, '');
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

  const pitchPrintClientIdentity = () => {
    try {
      const vars = window.ppclient?.vars || {};
      const source = vars.projectSource || {};
      const projectId = String(vars.projectId || source.projectId || '').trim();
      const designId = String(vars.designId || source.designId || '').trim();
      if (projectId && designId) {
        return { projectId, designId, pending: false };
      }
    } catch {
      // The client may still be installing its property hook. The explicit
      // pending identity below keeps the public final step recoverable.
    }
    return {
      projectId: PENDING_PUBLIC_SAVE_ID,
      designId: PENDING_PUBLIC_SAVE_ID,
      pending: true,
    };
  };

  const isPendingPublicIdentity = (value) =>
    String(value || '').trim() === PENDING_PUBLIC_SAVE_ID;

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
    if (/^[A-Z][A-Z0-9_]{1,63}$/.test(text)) return text;
    if (text === 'EMBROIDERY PRINTING') return 'EMBROIDERY';
    if (text.includes('EMBROIDERY')) return 'EMBROIDERY';
    if (text.includes('DTF')) return 'DTF';
    if (text.includes('DTG')) return 'DTG';
    return '';
  };

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

  const postJson = (url, payload) => new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();

    request.open('POST', url, true);
    request.withCredentials = true;
    request.setRequestHeader('Accept', 'application/json');
    request.setRequestHeader('Content-Type', 'application/json');
    request.onload = () => {
      const responseData = parseJson(request.responseText || '{}', {});
      if (request.status >= 200 && request.status < 300) {
        if (responseData && typeof responseData === 'object') {
          responseData.__httpStatus = request.status;
        }
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
      error.safeCode = String(responseData?.error?.code || responseData?.code || 'REQUEST_FAILED');
      reject(error);
    };
    request.onerror = () => {
      const error = new Error('A network error occurred while preparing your customized product.');
      error.status = request.status || 0;
      error.safeCode = 'NETWORK_ERROR';
      reject(error);
    };
    request.ontimeout = () => {
      const error = new Error('The cart request timed out. Please try again.');
      error.status = 0;
      error.safeCode = 'REQUEST_TIMEOUT';
      reject(error);
    };
    request.timeout = 20000;
    request.send(JSON.stringify(payload));
  });

  const normalizeProductionMethods = publicContract.normalizeProductionMethods;

  const buildProductConfig = (root) => {
    const actions = root?.querySelector?.('[data-marked-product-actions]');
    if (!actions || actions.dataset.customhousePitchprintRequired !== 'true') return null;

    const rawPricing = actions.querySelector('[data-customhouse-production-pricing-json]')?.textContent || '';
    const productId = String(actions.dataset.productId || '');
    const pricing = state.methodPricing?.get(productId) || parseJson(rawPricing, null);
    const productionMethods = normalizeProductionMethods(pricing);

    const sizePosition = Number(actions.dataset.sizeOptionPosition || 0);
    const colorPosition = Number(actions.dataset.colorOptionPosition || 0);
    const optionNames = parseJson(actions.dataset.productOptionNames, []);
    const currency = String(pricing?.currency || actions.dataset.currency || 'SEK').toUpperCase();
    const variants = publicContract.buildVariantMatrix({
      variants: parseJson(actions.dataset.productVariants, []),
      optionNames,
      colorPosition,
      sizePosition,
      currency,
    });
    const colors = Array.from(new Set(variants.map((variant) => variant.color).filter(Boolean)));
    const sizes = Array.from(new Set(variants.map((variant) => variant.size).filter(Boolean)));
    const projectIdentity = pitchPrintClientIdentity();

    const baseConfig = {
      version: 2,
      flowMode: 'PUBLIC_CUSTOMIZE',
      baseProductId: pricing?.baseProductId || String(actions.dataset.productId || ''),
      productionMethodsResolved: Array.isArray(pricing?.productionMethods) ||
        Boolean(pricing?.version === 1 && pricing?.productionMethodPricing),
      contractVersion: publicContract.CONTRACT_VERSION,
      productId: String(actions.dataset.productId || ''),
      productHandle: String(actions.dataset.productHandle || ''),
      productTitle: String(actions.dataset.productTitle || ''),
      currency,
      optionNames,
      variants,
      colors,
      sizes,
      optionGroups: [
        {
          id: 'color',
          label: 'Color',
          values: colors,
          multiple: true,
        },
        {
          id: 'size',
          label: 'Size',
          values: sizes,
          multiple: true,
        },
      ],
      supportsMultipleSelections: true,
      selectedColor: String(actions.dataset.selectedColor || ''),
      selectedSize: String(actions.dataset.selectedSize || ''),
      initialVariantId: selectedVariantId(actions),
      initialQuantity: selectedQuantity(actions),
      productionMethods,
      embroideryPricing:
        productionMethods.find((method) => method.id === 'embroidery')?.embroiderySubtypes || {},
      productionMethodPricing: publicContract.buildProductionMethodPricing(productionMethods),
      pitchprintProjectId: projectIdentity.projectId,
      pitchprintDesignId: projectIdentity.designId,
      projectIdentityMode: projectIdentity.pending ? 'SAVE_ON_CONTINUE' : 'SAVED',
    };
    const revision = publicContract.revisionFor({
      productId: baseConfig.productId,
      productionMethodsResolved: baseConfig.productionMethodsResolved,
      optionNames,
      variants,
      productionMethods,
      currency,
      pitchprintProjectId: baseConfig.pitchprintProjectId,
      pitchprintDesignId: baseConfig.pitchprintDesignId,
    });
    return {
      ...baseConfig,
      revision,
      configRevision: revision,
      integrationSettings: publicContract.integrationSettings(revision),
    };
  };

  const refreshPublicConfig = () => {
    const root = document.querySelector(rootSelector);
    const candidate = buildProductConfig(root);
    if (!candidate) return state.config;
    const config = publicContract.chooseCanonicalConfig(state.config, candidate);
    state.config = config;
    state.configRevision = config.revision;
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
          embroiderySubtypes: method.embroiderySubtypes || null,
        }));
      },
    };
    if (state.loggedRevision !== config.revision) {
      state.loggedRevision = config.revision;
      const embroideryRates = config.embroideryPricing || {};
      const dtfRate = config.productionMethodPricing?.DTF || {};
      const dtgRate = config.productionMethodPricing?.DTG || {};
      const variantPricesComplete = config.variants.length > 0 && config.variants.every((variant) =>
        Number.isSafeInteger(variant.priceMinor) && variant.priceMinor >= 0 && variant.currency === config.currency
      );
      log('Public PitchPrint config ready', {
        PUBLIC_CONFIG_PRODUCT_ID: config.productId,
        PUBLIC_CONFIG_KEYS: Object.keys(config),
        PUBLIC_CONFIG_VARIANT_COUNT: config.variants.length,
        PUBLIC_CONFIG_COLORS: config.colors,
        PUBLIC_CONFIG_SIZES: config.sizes,
        PUBLIC_CONFIG_CURRENCY: config.currency,
        PUBLIC_CONFIG_EMBROIDERY_TEXT_PRICE: Number(embroideryRates.TEXT_ONLY?.surchargeMinor || 0),
        PUBLIC_CONFIG_EMBROIDERY_IMAGE_PRICE: Number(embroideryRates.IMAGE_OR_LOGO?.surchargeMinor || 0),
        PUBLIC_CONFIG_DTF_PRICE: Number(dtfRate.surchargeMinor || 0),
        PUBLIC_CONFIG_DTG_PRICE: Number(dtgRate.surchargeMinor || 0),
        PUBLIC_CONFIG_HAS_VARIANT_PRICES: variantPricesComplete,
        PUBLIC_PRICE_CONFIG_REVISION: config.revision,
        PUBLIC_PRICE_TEXT: Number(embroideryRates.TEXT_ONLY?.surchargeMinor || 0),
        PUBLIC_PRICE_IMAGE: Number(embroideryRates.IMAGE_OR_LOGO?.surchargeMinor || 0),
        PUBLIC_PRICE_DTF: Number(dtfRate.surchargeMinor || 0),
        PUBLIC_PRICE_DTG: Number(dtgRate.surchargeMinor || 0),
        PUBLIC_PRODUCT_ID: config.productId,
        PUBLIC_VARIANT_COUNT: config.variants.length,
        PUBLIC_OPTION_NAMES: config.optionNames,
        PUBLIC_COLORS: config.colors,
        PUBLIC_SIZES: config.sizes,
        PUBLIC_EMBROIDERY_TEXT_PRICE: Number(embroideryRates.TEXT_ONLY?.surchargeMinor || 0),
        PUBLIC_EMBROIDERY_IMAGE_PRICE: Number(embroideryRates.IMAGE_OR_LOGO?.surchargeMinor || 0),
        PUBLIC_DTF_PRICE: Number(dtfRate.surchargeMinor || 0),
        PUBLIC_DTG_PRICE: Number(dtgRate.surchargeMinor || 0),
        PUBLIC_GENERIC_EMBROIDERY_PRICE_USED: false,
        PUBLIC_PRODUCTION_METHODS: config.productionMethods.map((method) => ({
          id: method.id,
          surchargeMinor: method.surchargeMinor,
          embroiderySubtypes: method.embroiderySubtypes || null,
        })),
        PUBLIC_HAS_INTEGRATION_SETTINGS: Boolean(config.integrationSettings),
        PUBLIC_CONFIG_REVISION: config.revision,
      });
    }
    return config;
  };

  const respondWithProductConfig = (targetWindow, targetOrigin = PITCHPRINT_ORIGIN) => {
    const config = refreshPublicConfig();
    if (!config?.productionMethodsResolved || !targetWindow || typeof targetWindow.postMessage !== 'function' || !isAllowedMessageOrigin(targetOrigin)) return false;
    state.configTargets.set(targetWindow, targetOrigin);
    targetWindow.postMessage({ type: 'CUSTOMHOUSE_PP_FULL_PRODUCT_CONFIG', payload: config }, targetOrigin);
    log('METHOD_HANDOFF', { FLOW_MODE: config.flowMode, PRODUCT_ID: config.productId,
      METHOD_COUNT: config.productionMethods.length, METHOD_CODES: config.productionMethods.map(method => method.code),
      CURRENCY: config.currency, CONFIG_EVENT_TYPE: 'CUSTOMHOUSE_PP_FULL_PRODUCT_CONFIG' });
    targetWindow.postMessage({
      type: 'CUSTOMHOUSE_PP_ORDER_CONFIG_DATA',
      payload: config,
    }, targetOrigin);
    log('PUBLIC_CONFIG_SENT', {
      PUBLIC_CONFIG_REVISION: config.revision,
      PUBLIC_CONFIG_SENT_VARIANTS: config.variants.length,
      PUBLIC_CONFIG_SENT_TEXT_PRICE: Number(config.embroideryPricing?.TEXT_ONLY?.surchargeMinor || 0),
    });
    return true;
  };

  state.methodPricing = new Map();
  state.configTargets = new Map();
  state.methodRequests = new Map();
  const sendLatestProductConfig = () => {
    for (const iframe of document.querySelectorAll('iframe')) {
      try {
        const url = new URL(iframe.src, window.location.href);
        if (url.origin === PITCHPRINT_ORIGIN) state.configTargets.set(iframe.contentWindow, url.origin);
      } catch { /* Ignore frames without an established PitchPrint origin. */ }
    }
    for (const [target, origin] of state.configTargets) respondWithProductConfig(target, origin);
  };
  const loadCanonicalMethods = (force = false) => {
    const config = refreshPublicConfig();
    if (!config?.productId || typeof fetch !== 'function') return Promise.resolve();
    const productId = config.productId;
    const canonicalProductId = /^\d+$/.test(productId) ? `gid://shopify/Product/${productId}` : productId;
    if (state.methodRequests.has(productId)) return state.methodRequests.get(productId);
    if (!force && state.methodPricing.has(productId)) return Promise.resolve();
    const pending = fetch(route('apps/customhouse/api/pitchprint-method-config') + '?productId=' + encodeURIComponent(canonicalProductId), {
      credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' },
    }).then(async response => {
      if (!response.ok) throw new Error('Method configuration unavailable');
      const result = await response.json();
      const pricing = result?.data;
      if (!result.ok || pricing?.productId !== canonicalProductId || !Array.isArray(pricing.productionMethods)) {
        throw new Error('Invalid method configuration');
      }
      state.methodPricing.set(productId, pricing);
      // A response for Product A must not replace Product B after navigation.
      if (refreshPublicConfig()?.productId === productId) sendLatestProductConfig();
    }).catch(() => warn('Canonical method configuration could not be refreshed'))
      .finally(() => state.methodRequests.delete(productId));
    state.methodRequests.set(productId, pending);
    return pending;
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

  const embroiderySubtypeCode = (value) => {
    const raw = String(value || '').trim().toUpperCase();
    const normalized = raw === 'IMAGE_LOGO' ? 'IMAGE_OR_LOGO' : raw;
    return normalized === 'TEXT_ONLY' || normalized === 'IMAGE_OR_LOGO' ? normalized : '';
  };

  const selectedEmbroiderySubtype = (value, source) => {
    const candidates = [
      value?.embroiderySubtype,
      value?.artworkType,
      source?.embroiderySubtype,
      source?.artworkType,
      value?.production?.embroiderySubtype,
      source?.production?.embroiderySubtype,
    ];
    for (const candidate of candidates) {
      const subtype = embroiderySubtypeCode(candidate);
      if (subtype) return subtype;
    }
    return '';
  };

  const firstPositiveInteger = (...values) => {
    for (const value of values) {
      const number = Number(value);
      if (Number.isSafeInteger(number) && number > 0) return number;
    }
    return 0;
  };

  const accepted = (value) => value === true || value === 1 || value === '1' || value === 'true' || value === 'Accepted';

  const legalConfirmationsFrom = (value, source) => {
    const legal = value?.legalConfirmations || source?.legalConfirmations || {};
    const acknowledgements = value?.acknowledgements || source?.acknowledgements || {};
    return {
      rightsAccepted: accepted(
        value?.rightsAccepted ??
        value?.copyrightAccepted ??
        value?.copyrightConfirmed ??
        source?.rightsAccepted ??
        source?.copyrightAccepted ??
        source?.copyrightConfirmed ??
        legal.rightsAccepted ??
        legal.copyrightAccepted ??
        legal.copyrightConfirmed ??
        acknowledgements.rightsAccepted ??
        acknowledgements.copyrightAccepted ??
        acknowledgements.copyrightConfirmed
      ),
      termsAccepted: accepted(
        value?.termsAccepted ??
        value?.nonReturnConfirmed ??
        source?.termsAccepted ??
        source?.nonReturnConfirmed ??
        legal.termsAccepted ??
        legal.termsConfirmed ??
        acknowledgements.termsAccepted ??
        acknowledgements.termsConfirmed ??
        acknowledgements.nonReturnConfirmed
      ),
    };
  };

  const summarizedArtworkSource = (value, source) => {
    const summary = value?.artworkSummary || source?.artworkSummary;
    const placements = Array.isArray(value?.placements)
      ? value.placements
      : Array.isArray(source?.placements)
        ? source.placements
        : [];
    if (!summary || typeof summary !== 'object' || !placements.length) return null;

    const placementCount = firstPositiveInteger(
      value?.placementCount,
      source?.placementCount,
      value?.production?.placementCount,
      source?.production?.placementCount
    );
    const explicitlyDesignedPlacements = placements.filter((placement) => {
      if (!placement || typeof placement !== 'object') return false;
      const record = placement;
      return record.hasArtwork === true ||
        record.designed === true ||
        record.isDesigned === true ||
        firstPositiveInteger(
          record.printableObjectCount,
          record.artworkObjectCount,
          record.objectCount
        ) > 0;
    });
    const placementCandidates = explicitlyDesignedPlacements.length
      ? explicitlyDesignedPlacements
      : placements;
    if (placementCount && placementCandidates.length < placementCount) return null;
    const designedPlacements = placementCount
      ? placementCandidates.slice(0, placementCount)
      : placementCandidates;

    const hasText = summary.hasText === true;
    const hasImage = summary.hasImage === true;
    const printableObjectCount = Number(summary.printableObjectCount);
    if ((!hasText && !hasImage) || !Number.isSafeInteger(printableObjectCount) || printableObjectCount < 1) {
      return null;
    }

    const objects = [];
    if (hasText) objects.push({ type: 'text' });
    if (hasImage) objects.push({ type: 'image', isUserArtwork: true });
    return {
      pages: designedPlacements.map((placement, index) => {
        const record = placement && typeof placement === 'object' ? placement : {};
        const name = String(
          typeof placement === 'string'
            ? placement
            : record.side || record.name || record.label || record.title || record.id || `Saved view ${index + 1}`
        ).trim();
        return {
          name: name || `Saved view ${index + 1}`,
          objects: objects.map((object) => ({ ...object })),
        };
      }),
    };
  };

  const artworkSourceFrom = (value, source) => {
    const candidates = [
      value?.artworkSource,
      value?.projectData,
      value?.savedProject,
      source?.artworkSource,
      source?.projectData,
      source?.savedProject,
    ];
    for (const candidate of candidates) {
      if (candidate && typeof candidate === 'object') return candidate;
    }
    if (Array.isArray(value?.pages) || Array.isArray(value?.canvases) || Array.isArray(value?.surfaces)) return value;
    if (Array.isArray(source?.pages) || Array.isArray(source?.canvases) || Array.isArray(source?.surfaces)) return source;
    return summarizedArtworkSource(value, source);
  };

  const cartFailure = (safeCode, status = 0) => {
    const error = new Error('Public cart request failed');
    error.safeCode = safeCode;
    error.status = status;
    return error;
  };

  const sendCartReadyAcknowledgement = (targetWindow, targetOrigin, projectId, handoffId) => {
    if (!targetWindow || typeof targetWindow.postMessage !== 'function' || !isAllowedMessageOrigin(targetOrigin)) {
      return false;
    }
    targetWindow.postMessage({
      type: 'CUSTOMHOUSE_PP_CART_READY_ACK',
      payload: { ok: true, projectId, ...(handoffId ? { handoffId } : {}) },
    }, targetOrigin);
    log('Cart-ready acknowledgement sent', {
      ACK_SENT: true,
      PUBLIC_CART_PROJECT_ID: projectId,
    });
    return true;
  };

  const sendCartFailureAcknowledgement = (acknowledgement, stage, message) => {
    const targetWindow = acknowledgement?.source;
    const targetOrigin = acknowledgement?.origin;
    if (!targetWindow || typeof targetWindow.postMessage !== 'function' || !isAllowedMessageOrigin(targetOrigin)) {
      return false;
    }
    targetWindow.postMessage({
      type: 'CUSTOMHOUSE_PP_CART_READY_ACK',
      payload: {
        ok: false,
        ...(acknowledgement?.handoffId ? { handoffId: acknowledgement.handoffId } : {}),
        stage,
        error: message,
      },
    }, targetOrigin);
    return true;
  };

  const failPendingPublicSave = (stage, message) => {
    const pending = state.pendingPublicCart;
    state.pendingPublicCart = null;
    state.publicSaveInFlight = false;
    if (pending) sendCartFailureAcknowledgement(pending.acknowledgement, stage, message);
    setStatus(state.snapshot?.root, message, true);
    log('PUBLIC_PROJECT_SAVE_FAILED', { PUBLIC_PROJECT_SAVE_FAILURE_STAGE: stage });
  };

  const requestPendingPublicSave = () => {
    const client = window.ppclient;
    if (!client || typeof client.fire !== 'function') return false;
    state.publicSaveInFlight = true;
    client.fire('start-save', {});
    log('PUBLIC_PROJECT_SAVE_REQUESTED', { PUBLIC_PROJECT_SAVE_REQUESTED: true });
    return true;
  };

  async function addProjectToCart(projectId, previewUrl, value = {}, source = {}, acknowledgement = {}) {
    const snapshot = state.snapshot;
    const root = snapshot?.root;
    const config = refreshPublicConfig() || state.config;

    if (!snapshot) {
      warn('Missing snapshot');
      return;
    }

    const selectionContract = publicContract.buildCartSelectionContract({
      value,
      source,
      snapshot,
      config,
    });
    const selections = selectionContract.selections;
    const totalQuantity = selectionContract.totalQuantity;

    if (!selectionContract.selectionCount || totalQuantity < 1) {
      warn('Invalid variants');
      setStatus(root, 'Unable to add this customization to your cart. Please try again.', true);
      return;
    }

    const productionMethod = selectedProductionMethod(value, source);
    const configuredMethod = config?.productionMethodPricing?.[productionMethod] ||
      (config?.productionMethods || []).find((method) => methodCode(method.id) === productionMethod);
    const embroiderySubtype = productionMethod === 'EMBROIDERY'
      ? selectedEmbroiderySubtype(value, source)
      : '';
    const configuredRate = productionMethod === 'EMBROIDERY'
      ? configuredMethod?.embroiderySubtypes?.[embroiderySubtype]
      : configuredMethod;

    if (!productionMethod || !configuredMethod) {
      warn('Missing production method');
      setStatus(root, 'Unable to add this customization to your cart. Please try again.', true);
      return;
    }

    if (productionMethod === 'EMBROIDERY' && !embroiderySubtype) {
      warn('Missing embroidery artwork type');
      setStatus(root, 'Unable to add this customization to your cart. Please try again.', true);
      return;
    }

    if (
      !configuredRate ||
      !Number.isFinite(Number(configuredRate.surchargeMinor)) ||
      (Number(configuredRate.surchargeMinor || 0) > 0 && !configuredRate.feeVariantId)
    ) {
      warn('Missing production fee variant');
      setStatus(root, 'Unable to add this customization to your cart. Please try again.', true);
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

    const placementCount = firstPositiveInteger(
      value?.placementCount,
      source?.placementCount,
      value?.production?.placementCount,
      source?.production?.placementCount
    );
    const legalConfirmations = legalConfirmationsFrom(value, source);
    const artworkSource = artworkSourceFrom(value, source);
    const pitchprintDesignId = String(
      value?.designId || value?.pitchprintDesignId || source?.designId || source?.pitchprintDesignId || ''
    ).trim();
    const productId = String(config?.productId || snapshot.productId || '').trim();
    const visibleProperties = {
      'Printing method': configuredMethod.label || productionMethod,
      'Printing charge / item': moneyFromMinor(configuredRate.surchargeMinor, config?.currency || 'SEK'),
    };

    state.inFlight = true;
    log('PUBLIC_CART_VALIDATION_STARTED', {
      PUBLIC_CART_PRODUCT_ID: productId,
      PUBLIC_CART_PROJECT_ID: projectId,
      PUBLIC_CART_DESIGN_ID: pitchprintDesignId,
      PUBLIC_CART_METHOD: productionMethod,
      PUBLIC_CART_ARTWORK_TYPE: embroiderySubtype || null,
      PUBLIC_CART_EMBROIDERY_SUBTYPE: embroiderySubtype || null,
      PUBLIC_CART_VARIANT_SELECTIONS: selections.map(({ variantId, color, size, quantity }) => ({ variantId, color, size, quantity })),
      PUBLIC_CART_SELECTION_COUNT: selectionContract.selectionCount,
      PUBLIC_CART_TOTAL_QUANTITY: totalQuantity,
      PUBLIC_CART_PLACEMENT_COUNT: placementCount,
    });
    setStatus(root, 'Adding your custom product to the cart...', false);

    try {
      const prepared = await postJson('/apps/customhouse/api/public-production-cart', {
        shopifyProductId: productId,
        pitchprintProjectId: projectId,
        pitchprintDesignId,
        productionMethod,
        selectedProductionMethod: productionMethod,
        artworkType: embroiderySubtype || null,
        embroiderySubtype: embroiderySubtype || null,
        placementCount,
        placements: value?.placements || source?.placements || [],
        totalQuantity,
        selectedColors: value?.selectedColors || source?.selectedColors || [],
        artworkSource,
        legalConfirmations,
        selections,
        variantSelections: selections,
        previewUrl,
      });
      const preparedData = prepared?.data || prepared;
      const preparedItems = Array.isArray(preparedData?.items) ? preparedData.items : [];
      if (!prepared?.ok || !preparedItems.length) {
        throw cartFailure(String(prepared?.error?.code || 'CART_PREPARATION_REJECTED'), prepared?.__httpStatus || 0);
      }

      log('PUBLIC_CART_VARIANTS_VALIDATED', {
        PUBLIC_CART_SELECTION_COUNT: selections.length,
        PUBLIC_CART_TOTAL_QUANTITY: totalQuantity,
      });
      log('PUBLIC_CART_FEE_RESOLVED', {
        FEE_VARIANT: String(preparedData?.cart?.feeVariantId || configuredRate.feeVariantId || ''),
        FEE_QUANTITY: totalQuantity * placementCount,
      });

      const cartItems = preparedItems.map((item) => {
        const properties = { ...(item.properties || {}) };
        if (!properties._customhouse_fee_key) {
          throw cartFailure('MISSING_FEE_PAIRING');
        }
        properties['Printing method'] = visibleProperties['Printing method'];
        if (properties._customhouse_production_fee !== 'true') {
          properties['Printing charge / item'] = visibleProperties['Printing charge / item'];
        }
        return { id: item.id, quantity: item.quantity, properties };
      });

      log('PUBLIC_CART_ADD_REQUEST_BUILT', {
        CART_LINE_COUNT: cartItems.length,
        CART_LINES: cartItems.map(({ id, quantity }) => ({ id, quantity })),
      });
      const cartResponse = await postJson(route('cart/add.js'), { items: cartItems });
      log('PUBLIC_CART_ADD_HTTP_STATUS', { PUBLIC_CART_ADD_HTTP_STATUS: cartResponse?.__httpStatus || 200 });
      log('PUBLIC_CART_ADD_RESPONSE_SAFE_CODE', { PUBLIC_CART_ADD_RESPONSE_SAFE_CODE: 'OK' });
    } catch (error) {
      state.inFlight = false;
      const safeCode = String(error?.safeCode || 'CART_ADD_FAILED');
      log('PUBLIC_CART_ADD_HTTP_STATUS', { PUBLIC_CART_ADD_HTTP_STATUS: Number(error?.status || 0) });
      log('PUBLIC_CART_ADD_RESPONSE_SAFE_CODE', {
        PUBLIC_CART_ADD_RESPONSE_SAFE_CODE: safeCode,
      });
      sendCartFailureAcknowledgement(
        acknowledgement,
        safeCode,
        'Unable to add this customization to your cart. Please try again.'
      );
      setStatus(root, 'Unable to add this customization to your cart. Please try again.', true);
      return;
    }

    state.handledProjects.add(projectId);
    state.inFlight = false;
    sendCartReadyAcknowledgement(
      acknowledgement.source,
      acknowledgement.origin,
      projectId,
      acknowledgement.handoffId
    );
    setStatus(root, '', false);
    log('PUBLIC_CART_REDIRECT_STARTED', { REDIRECT_TO_CART: true });
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
    state.lastSaved = { projectId, value, source };

    const pending = state.pendingPublicCart;
    if (!pending) {
      setStatus(state.snapshot?.root, 'Design saved. Preparing your cart...', false);
      return;
    }

    const designId = String(
      value?.designId || value?.pitchprintDesignId || source?.designId || source?.pitchprintDesignId || ''
    ).trim();
    if (!projectId || !designId) {
      failPendingPublicSave(
        'PUBLIC_PROJECT_IDENTITY_MISSING',
        'PitchPrint saved the artwork but did not return its project identity. Please try again.'
      );
      return;
    }

    state.pendingPublicCart = null;
    state.publicSaveInFlight = false;
    const mergedSource = {
      ...(pending.source || {}),
      ...(source || {}),
      projectId,
      pitchprintProjectId: projectId,
      designId,
      pitchprintDesignId: designId,
    };
    const mergedValue = {
      ...(pending.value || {}),
      ...(value || {}),
      projectId,
      pitchprintProjectId: projectId,
      designId,
      pitchprintDesignId: designId,
      source: mergedSource,
    };
    log('PUBLIC_PROJECT_SAVE_COMPLETED', {
      PUBLIC_CART_PROJECT_ID: projectId,
      PUBLIC_CART_DESIGN_ID: designId,
    });
    setStatus(state.snapshot?.root, 'Design saved. Preparing your cart...', false);
    addProjectToCart(
      projectId,
      firstPreviewUrl(mergedValue.previews || mergedSource.previews || pending.previewUrl),
      mergedValue,
      mergedSource,
      pending.acknowledgement
    );
  }

  function handleProjectSaveFailed() {
    if (!state.pendingPublicCart) return;
    failPendingPublicSave(
      'PUBLIC_PROJECT_SAVE_FAILED',
      'PitchPrint could not save this design. Please try again.'
    );
  }

  function handleCartReady(event) {
    log('PUBLIC_CART_READY_RECEIVED', { PUBLIC_CART_READY_RECEIVED: true });
    log('PUBLIC_CART_BRIDGE_RECEIVED', { PUBLIC_CART_BRIDGE_RECEIVED: true });
    const message = event?.detail ?? event?.data ?? event ?? {};
    const payload = message?.payload ?? message?.value ?? message?.data ?? message ?? {};
    const savedValue = state.lastSaved?.value || {};
    const value = { ...savedValue, ...payload };
    const source = value?.source ?? state.lastSaved?.source ?? {};
    const projectId = String(
      value?.projectId ||
      value?.pitchprintProjectId ||
      source?.projectId ||
      source?.pitchprintProjectId ||
      state.lastSaved?.projectId ||
      ''
    ).trim();

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
    const designId = String(
      value?.designId || value?.pitchprintDesignId || source?.designId || source?.pitchprintDesignId || ''
    ).trim();
    if (isPendingPublicIdentity(projectId) || isPendingPublicIdentity(designId)) {
      if (state.pendingPublicCart || state.publicSaveInFlight) return;
      state.pendingPublicCart = {
        value,
        source,
        previewUrl: firstPreviewUrl(value.previews || source.previews),
        acknowledgement: {
          source: event?.source,
          origin: event?.origin,
          handoffId: String(value?.handoffId || '').trim(),
        },
      };
      setStatus(state.snapshot?.root, 'Saving your design before adding it to the cart...', false);
      if (!requestPendingPublicSave()) {
        failPendingPublicSave(
          'PUBLIC_PROJECT_SAVE_UNAVAILABLE',
          'PitchPrint is not ready to save this design. Please reopen the customizer and try again.'
        );
      }
      return;
    }
    addProjectToCart(
      projectId,
      firstPreviewUrl(value.previews || source.previews),
      value,
      source,
      {
        source: event?.source,
        origin: event?.origin,
        handoffId: String(value?.handoffId || '').trim(),
      }
    );
  }

  function bindPitchPrintClient(client) {
    if (state.listenerBound) return true;
    if (!client || typeof client.on !== 'function') return false;

    try {
      for (const ready of ['lib-ready', 'before-show', 'app-shown', 'editor-shown']) {
        client.on(ready, () => { sendLatestProductConfig(); void loadCanonicalMethods(); });
      }
      client.on('project-saved', handleProjectSaved);
      client.on('save-failed', handleProjectSaveFailed);
      client.on('cart-ready', handleCartReady);
      client.on('CUSTOMHOUSE_PP_CART_READY', handleCartReady);
      state.listenerBound = true;
      setStatus(state.snapshot?.root, '', false);
      log('Listener bound', {
        LISTENER_EVENT_NAME: 'cart-ready, CUSTOMHOUSE_PP_CART_READY',
        LISTENER_BOUND: true,
      });
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

    state.configTargets.clear();
    void loadCanonicalMethods(true);
    captureSnapshotFromRoot(root, 'Variant snapshot', true);
    if (!ensurePitchPrintListener() && state.propertyHookUnavailable) {
      requestAnimationFrame(ensurePitchPrintListener);
    }
  }, true);

  window.addEventListener('message', (event) => {
    const message = event?.data || {};
    if (message?.type === 'CUSTOMHOUSE_PP_CART_READY') {
      const originAllowed = isAllowedMessageOrigin(event.origin);
      log('PitchPrint message origin checked', {
        MESSAGE_ORIGIN_ALLOWED: originAllowed,
      });
      if (!originAllowed) {
        warn('Rejected cart-ready message origin');
        return;
      }
      handleCartReady(event);
      return;
    }
    if (message?.type === 'CUSTOMHOUSE_PP_ORDER_CONFIG_ACK') {
      if (!isAllowedMessageOrigin(event.origin) || !state.configTargets.has(event.source)) return;
      const acknowledgedRevision = String(
        message?.payload?.configRevision || message?.configRevision || ''
      );
      if (acknowledgedRevision && acknowledgedRevision === state.configRevision) {
        state.acknowledgedRevision = acknowledgedRevision;
        log('PUBLIC_CONFIG_ACKNOWLEDGED', {
          PP_CONFIG_ACK_PRODUCT_ID: state.config?.productId,
          PP_CONFIG_ACK_METHOD_COUNT: state.config?.productionMethods?.length || 0,
          PP_CONFIG_ACK_METHOD_CODES: state.config?.productionMethods?.map(method => method.code) || [],
          PUBLIC_CONFIG_REVISION: acknowledgedRevision,
          PUBLIC_CONFIG_ACK_VARIANTS: state.config?.variants?.length || 0,
          PUBLIC_CONFIG_ACK_TEXT_PRICE: Number(state.config?.embroideryPricing?.TEXT_ONLY?.surchargeMinor || 0),
        });
      }
      return;
    }
    if (!['CUSTOMHOUSE_PP_ORDER_CONFIG_REQUEST', 'CUSTOMHOUSE_PP_FULL_PRODUCT_CONFIG_REQUEST', 'CUSTOMHOUSE_PP_VARIANTS_REQUEST'].includes(message?.type)) return;
    if (!isAllowedMessageOrigin(event.origin) || !event.source) return;
    state.configTargets.set(event.source, event.origin);
    respondWithProductConfig(event.source, event.origin);
    void loadCanonicalMethods();
  });

  window.addEventListener('customhouse:pitchprint-order-config-request', (event) => {
    const detail = event?.detail || {};
    const targetWindow = detail.contentWindow || detail.source || detail.iframe?.contentWindow || detail.targetWindow || null;
    respondWithProductConfig(targetWindow);
  });

  window.addEventListener('CUSTOMHOUSE_PP_CART_READY', handleCartReady);
  window.addEventListener('customhouse:pitchprint-cart-ready', handleCartReady);

  log('Public cart message listener bound', {
    LISTENER_EVENT_NAME: 'CUSTOMHOUSE_PP_CART_READY',
    LISTENER_BOUND: true,
    MESSAGE_ORIGIN_ALLOWED: PITCHPRINT_ORIGIN,
  });

  log('Initialized');
  refreshPublicConfig();
  void loadCanonicalMethods();
  ensurePitchPrintListener();
})();
