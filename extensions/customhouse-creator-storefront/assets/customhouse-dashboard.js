/* global PitchPrintClient */
const DASHBOARD_ENDPOINT = "/apps/customhouse/api/creator-dashboard";
const PROFILE_IMAGE_ENDPOINT = "/apps/customhouse/api/creator-profile-upload";
const PROFILE_UPDATE_ENDPOINT = "/apps/customhouse/api/creator-profile";
const COLLECTION_BANNER_ENDPOINT = "/apps/customhouse/api/creator-collection-banner";
const CREATOR_PRODUCTS_ENDPOINT = "/apps/customhouse/api/creator-products";
const CREATOR_BASE_PRODUCTS_ENDPOINT = "/apps/customhouse/api/creator-base-products";
const PAYOUT_METHODS_ENDPOINT = "/apps/customhouse/api/payout-methods";
const PAYOUTS_ENDPOINT = "/apps/customhouse/api/payouts";
const CREATOR_PITCHPRINT_IDENTITY_ENDPOINT =
  "/apps/customhouse/api/creator-pitchprint-identity";
const REFERRAL_CLAIM_ENDPOINT = "/apps/customhouse/api/referral/claim";
const PENDING_REFERRAL_COOKIE = "customhouse_referral_pending";
const PITCHPRINT_CLIENT_SRC = "https://pitchprint.io/rsc/js/client.js";
const JQUERY_SRC = "https://code.jquery.com/jquery-3.7.1.min.js";
let creatorProductsLoadPromise = null;
let creatorBaseProductsLoadPromise = null;

export function resolveDashboardState(data) {
  if (!data || typeof data !== "object") return { state: "CREATOR_RECORD_MISSING", message: "No creator application was found." };
  switch (data.state) {
    case "LOGGED_OUT": return { state: "LOGGED_OUT", message: "Please sign in to access your creator dashboard." };
    case "APPLICATION_NOT_SUBMITTED": return { state: "APPLICATION_NOT_SUBMITTED", message: "No creator application was found. Apply to become a creator." };
    case "NOT_APPLIED": return { state: "NOT_APPLIED", message: "No creator application was found." };
    case "SYNC_CONFLICT": return { state: "SYNC_CONFLICT", message: "Your creator account needs administrator review.", data };
    case "PENDING": return { state: "PENDING", message: "Your creator application is under review.", data };
    case "APPROVED": return { state: "APPROVED", message: `Welcome, ${data.displayName}.`, data };
    case "REJECTED": return { state: "REJECTED", message: data.rejectionReason ? `Your creator application was rejected: ${data.rejectionReason}` : "Your creator application was rejected.", data };
    case "SUSPENDED": return { state: "SUSPENDED", message: data.suspensionReason ? `Your creator account is suspended: ${data.suspensionReason}` : "Your creator account is suspended.", data };
    default: return { state: "CREATOR_RECORD_MISSING", message: "No creator application was found." };
  }
}

export async function loadDashboardState(request, emit, options = {}) {
  if (!options.quiet) emit({ state: "LOADING", loading: true, message: "Loading..." });
  try {
    emit({ ...resolveDashboardState(await request()), loading: false });
  } catch {
    if (!options.quiet) emit({ state: "API_ERROR", loading: false, message: "We couldn't load your creator dashboard. Please try again." });
  } finally {
    if (!options.quiet) emit({ state: "LOADING_COMPLETE", loading: false });
  }
}

async function requestDashboard(options = {}) {
  const url = options.sync ? `${DASHBOARD_ENDPOINT}?sync=1` : DASHBOARD_ENDPOINT;
  const response = await fetch(url, { credentials: "same-origin", headers: { Accept: "application/json" } });
  const body = await response.json();
  if (!response.ok || !body?.ok) throw new Error("Dashboard request failed");
  return body.data;
}

function readCookie(name) {
  return (document.cookie || "")
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))
    ?.slice(name.length + 1) || "";
}

function clearCookie(name) {
  const secure = window.location.protocol === "https:" ? "; Secure" : "";
  document.cookie = `${name}=; Max-Age=0; Path=/; SameSite=Lax${secure}`;
}

async function claimPendingReferralCookie() {
  const token = readCookie(PENDING_REFERRAL_COOKIE);
  if (!token || window.__customHouseReferralClaimAttempted) return;
  window.__customHouseReferralClaimAttempted = true;
  try {
    const response = await fetch(REFERRAL_CLAIM_ENDPOINT, {
      method: "POST",
      credentials: "same-origin",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ token }),
    });
    const body = await response.json().catch(() => null);
    const status = body?.data?.status || body?.status;
    if (
      response.ok &&
      [
        "CLAIMED",
        "ALREADY_ATTRIBUTED",
        "EXISTING_CREATOR",
        "SELF_REFERRAL",
        "TOKEN_INVALID",
        "TOKEN_EXPIRED",
        "REFERRER_INVALID",
        "SHOP_MISMATCH",
      ].includes(status)
    ) {
      clearCookie(PENDING_REFERRAL_COOKIE);
    }
  } catch {
    // Keep the pending cookie so a later dashboard load can retry.
  }
}

async function uploadProfileImage(form) {
  const response = await fetch(PROFILE_IMAGE_ENDPOINT, {
    method: "POST",
    credentials: "same-origin",
    body: new FormData(form),
    headers: { Accept: "application/json" },
  });
  const body = await response.json();
  if (!response.ok || !body?.ok) throw new Error("Profile upload failed");
  return body.data;
}

async function saveCollectionBanner(form) {
  const response = await fetch(COLLECTION_BANNER_ENDPOINT, {
    method: "POST",
    credentials: "same-origin",
    body: new FormData(form),
    headers: { Accept: "application/json" },
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.ok) {
    throw new Error(body?.error?.message || "Collection banner could not be saved.");
  }
  return body.data?.collection;
}

async function removeCollectionBanner() {
  const response = await fetch(COLLECTION_BANNER_ENDPOINT, {
    method: "POST",
    credentials: "same-origin",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ intent: "remove" }),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.ok) {
    throw new Error(body?.error?.message || "Collection banner could not be removed.");
  }
  return body.data?.collection;
}

async function saveProfileUpdate(payload) {
  const response = await fetch(PROFILE_UPDATE_ENDPOINT, {
    method: "POST",
    credentials: "same-origin",
    keepalive: true,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.ok) throw new Error("Profile update failed");
  return body.data;
}

async function deactivateCreatorAccount() {
  const response = await fetch(PROFILE_UPDATE_ENDPOINT, {
    method: "DELETE",
    credentials: "same-origin",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: "{}",
  });
  const body = await response.json();
  if (!response.ok || !body.ok) {
    throw new Error(body?.error?.message || "Creator account could not be deactivated.");
  }
  return body.data;
}

async function removeProfilePhoto(root, message) {
  const buttons = root.querySelectorAll(
    "[data-dashboard-remove-image], [data-profile-modal-remove-photo]",
  );
  buttons.forEach((button) => {
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
  });
  if (message) {
    message.hidden = false;
    message.textContent = "Removing photo...";
  }
  try {
    await saveProfileUpdate({ removeProfileImage: true });
    clearProfilePhoto(root);
    if (message) {
      message.hidden = false;
      message.textContent = "Profile photo removed.";
    }
  } finally {
    buttons.forEach((button) => {
      button.disabled = false;
      button.removeAttribute("aria-busy");
    });
  }
}

async function requestCreatorProducts() {
  if (!creatorProductsLoadPromise) {
    creatorProductsLoadPromise = (async () => {
      const response = await fetch(CREATOR_PRODUCTS_ENDPOINT, {
        credentials: "same-origin",
        headers: { Accept: "application/json" },
      });
      const body = await response.json();
      if (!response.ok || !body?.ok) throw new Error("Creator products request failed");
      return Array.isArray(body.data?.products) ? body.data.products : [];
    })().finally(() => {
      creatorProductsLoadPromise = null;
    });
  }
  return creatorProductsLoadPromise;
}

async function savePayoutMethod(payload) {
  const response = await fetch(PAYOUT_METHODS_ENDPOINT, {
    method: "POST",
    credentials: "same-origin",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.ok) throw new Error(body?.error?.message || "Unable to save payout method.");
  return body.data;
}

async function requestPayout(payload) {
  const response = await fetch(PAYOUTS_ENDPOINT, {
    method: "POST",
    credentials: "same-origin",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.ok) throw new Error(body?.error?.message || "Unable to request payout.");
  return body.data;
}

async function requestCreatorBaseProducts() {
  if (!creatorBaseProductsLoadPromise) {
    creatorBaseProductsLoadPromise = (async () => {
      const response = await fetch(CREATOR_BASE_PRODUCTS_ENDPOINT, {
        credentials: "same-origin",
        headers: { Accept: "application/json" },
      });
      const body = await response.json();
      if (!response.ok || !body?.ok) throw new Error("Base products request failed");
      return Array.isArray(body.data?.products) ? body.data.products : [];
    })().finally(() => {
      creatorBaseProductsLoadPromise = null;
    });
  }
  return creatorBaseProductsLoadPromise;
}

async function requestPitchPrintIdentity() {
  const response = await fetch(CREATOR_PITCHPRINT_IDENTITY_ENDPOINT, {
    credentials: "same-origin",
    headers: { Accept: "application/json" },
  });
  const body = await response.json();
  if (!response.ok || !body?.ok || !body.data?.userId) {
    throw new Error("Creator identity could not be loaded");
  }
  return body.data;
}

async function createCreatorProductDraft(payload) {
  const response = await fetch(CREATOR_PRODUCTS_ENDPOINT, {
    method: "POST",
    credentials: "same-origin",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.ok) throw new Error(body?.error?.message || "Creator Product draft could not be created");
  return body.data?.product;
}

async function saveCreatorProductPitchPrintProject(productId, payload) {
  const response = await fetch(`${CREATOR_PRODUCTS_ENDPOINT}/${encodeURIComponent(productId)}`, {
    method: "POST",
    credentials: "same-origin",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.ok) {
    throw new Error(body?.error?.message || "PitchPrint project could not be saved");
  }
  return body.data?.product;
}

async function submitCreatorProductForReview(productId) {
  const response = await fetch(`${CREATOR_PRODUCTS_ENDPOINT}/${encodeURIComponent(productId)}`, {
    method: "POST",
    credentials: "same-origin",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ intent: "submit" }),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.ok) {
    throw new Error(body?.error?.message || "Creator Product could not be submitted");
  }
  return body.data?.product;
}

async function updateCreatorProductDetails(productId, payload) {
  const response = await fetch(`${CREATOR_PRODUCTS_ENDPOINT}/${encodeURIComponent(productId)}`, {
    method: "POST",
    credentials: "same-origin",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ action: "update-details", ...payload }),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.ok) {
    const error = new Error(body?.error?.message || "Design details could not be updated.");
    error.code = body?.error?.code || "";
    throw error;
  }
  return body.data?.product;
}

async function performCreatorProductAction(productId, action) {
  const response = await fetch(`${CREATOR_PRODUCTS_ENDPOINT}/${encodeURIComponent(productId)}`, {
    method: "POST",
    credentials: "same-origin",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ action }),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.ok) {
    const error = new Error(body?.error?.message || "Design action could not be completed.");
    error.code = body?.error?.code || "";
    throw error;
  }
  return body.data;
}

function showProfileImage(image, imageUrl, alt) {
  if (!image || !imageUrl?.startsWith("https://")) return false;
  image.src = imageUrl;
  image.alt = alt;
  image.hidden = false;
  return true;
}

function clearProfilePhoto(root) {
  root
    .querySelectorAll(
      "[data-dashboard-image], [data-dashboard-account-image], [data-profile-modal-avatar-image], [data-profile-modal-sidebar-image]",
    )
    .forEach((image) => {
      image.removeAttribute("src");
      image.alt = "Creator profile picture";
      image.hidden = true;
    });
  root
    .querySelectorAll(
      "[data-dashboard-avatar-fallback], [data-profile-modal-avatar-initials], [data-profile-modal-sidebar-initials]",
    )
    .forEach((fallback) => {
      fallback.hidden = false;
    });
}

function dashboardState(root) {
  root.__customHouseDashboardState = root.__customHouseDashboardState || {
    creatorProducts: [],
    baseProducts: [],
    actionLoading: new Set(),
    designFilter: "ACTIVE",
    designSearch: "",
    designSort: "updated",
  };
  return root.__customHouseDashboardState;
}

function customhouseModalRoot() {
  let modalRoot = document.getElementById("customhouse-modal-root");
  if (!modalRoot) {
    modalRoot = document.createElement("div");
    modalRoot.id = "customhouse-modal-root";
    modalRoot.dataset.customhouseModalRoot = "true";
    document.body.append(modalRoot);
  } else if (modalRoot.parentElement !== document.body) {
    document.body.append(modalRoot);
  }
  return modalRoot;
}

function portalDashboardModals(root) {
  const modalRoot = customhouseModalRoot();
  root.__customHouseModalRoot = modalRoot;
  [
    "[data-dashboard-profile-modal]",
    "[data-dashboard-review-modal]",
    "[data-dashboard-details-modal]",
    "[data-dashboard-action-modal]",
    "[data-dashboard-payout-method-modal]",
  ].forEach((selector) => {
    const modal = root.querySelector(selector);
    if (modal && modal.parentElement !== modalRoot) modalRoot.append(modal);
  });
}

function dashboardModalQuery(root, selector) {
  return root.__customHouseModalRoot?.querySelector(selector) || root.querySelector(selector);
}

function dashboardModalQueryAll(root, selector) {
  return [
    ...root.querySelectorAll(selector),
    ...(root.__customHouseModalRoot?.querySelectorAll(selector) || []),
  ];
}

function setActionLoading(button, label) {
  if (!button) return () => {};
  if (!button.dataset.customhouseActionLabel) {
    button.dataset.customhouseActionLabel = button.textContent || "";
  }
  const original = button.dataset.customhouseActionLabel;
  button.disabled = true;
  button.textContent = label;
  return () => {
    button.disabled = false;
    button.textContent = original;
  };
}

function showCreatorToast(root, message, error = false) {
  const target = root.querySelector("[data-dashboard-creator-products-message]") ||
    root.querySelector("[data-dashboard-message]");
  if (!target) return;
  target.dataset.persist = "true";
  target.textContent = message;
  target.classList.toggle("customhouse-error", Boolean(error));
  window.setTimeout(() => {
    target.dataset.persist = "false";
    if (!error && target.textContent === message) target.textContent = "";
  }, 2800);
}

function updateCreatorProductInState(root, product) {
  if (!product?.id) return;
  const state = dashboardState(root);
  const products = state.creatorProducts || [];
  const index = products.findIndex((item) => item.id === product.id);
  state.creatorProducts =
    index >= 0
      ? products.map((item) => (item.id === product.id ? { ...item, ...product } : item))
      : [product, ...products];
  root.__customHouseCreatorProducts = state.creatorProducts;
  const profile = root.querySelector("[data-dashboard-profile]");
  renderCreatorProducts(
    profile?.querySelector("[data-dashboard-creator-products]"),
    profile?.querySelector("[data-dashboard-creator-products-empty]"),
    state.creatorProducts,
  );
  renderRecentSubmissionsFromProducts(root, state.creatorProducts);
}

function removeCreatorProductFromState(root, productId) {
  const state = dashboardState(root);
  state.creatorProducts = (state.creatorProducts || []).filter(
    (item) => item.id !== productId,
  );
  root.__customHouseCreatorProducts = state.creatorProducts;
  const profile = root.querySelector("[data-dashboard-profile]");
  renderCreatorProducts(
    profile?.querySelector("[data-dashboard-creator-products]"),
    profile?.querySelector("[data-dashboard-creator-products-empty]"),
    state.creatorProducts,
  );
  renderRecentSubmissionsFromProducts(root, state.creatorProducts);
}

function creatorProductById(root, productId) {
  return (dashboardState(root).creatorProducts || []).find(
    (item) => item.id === productId,
  );
}

function renderBaseProducts(root, products) {
  const wrap = root.querySelector("[data-dashboard-base-products]");
  if (!wrap) return;
  dashboardState(root).baseProducts = products;
  wrap.replaceChildren();
  if (!products.length) {
    const empty = document.createElement("p");
    empty.className = "customhouse-dashboard-empty";
    empty.textContent = "No eligible base products are configured yet.";
    wrap.append(empty);
    return;
  }
  products.forEach((product) => {
    const card = document.createElement("article");
    card.className = "customhouse-base-product-card ch-design-card ch-design-card--base";

    const top = document.createElement("div");
    top.className = "ch-design-card__top";
    const media = document.createElement("figure");
    media.className = "ch-design-card__preview";
    if (product.imageUrl?.startsWith("https://")) {
      const image = document.createElement("img");
      image.src = product.imageUrl;
      image.alt = "";
      image.loading = "lazy";
      media.append(image);
    } else {
      const fallback = document.createElement("span");
      fallback.textContent = "Product image";
      media.append(fallback);
    }
    top.append(media);

    const copy = document.createElement("div");
    copy.className = "ch-design-card__body customhouse-base-product-card__body";
    const title = document.createElement("strong");
    title.className = "ch-design-card__title";
    title.textContent = product.title || "Base product";
    copy.append(title);
    const colors = optionValuesFromVariants(
      pitchPrintProductVariants(product),
      /^(color|colour|farg|färg)$/i,
    );
    const pricing = parseJsonObject(product.productionMethodPricing);
    const methods = Array.isArray(pricing?.productionMethods)
      ? pricing.productionMethods.filter((item) => ["EMBROIDERY", "DTF", "DTG"].includes(item?.id || item?.method))
      : [];
    const setup = document.createElement("div");
    setup.className = "customhouse-base-product-card__setup";
    const colorLabel = document.createElement("label");
    colorLabel.textContent = "Product Color";
    const colorSelect = document.createElement("select");
    colorSelect.dataset.baseProductColor = product.id || "";
    colorSelect.append(new Option("Choose one color", ""));
    colors.forEach((color) => colorSelect.append(new Option(color, color)));
    colorLabel.append(colorSelect);
    const methodLabel = document.createElement("label");
    methodLabel.textContent = "Printing Method";
    const methodSelect = document.createElement("select");
    methodSelect.dataset.baseProductMethod = product.id || "";
    methodSelect.append(new Option("Choose one method", ""));
    methods.forEach((method) => {
      const value = method.id || method.method;
      methodSelect.append(new Option(method.label || value, value));
    });
    methodLabel.append(methodSelect);
    setup.append(colorLabel, methodLabel);
    copy.append(setup);

    const actions = document.createElement("div");
    actions.className = "ch-design-card__actions";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "ch-design-card__button ch-design-card__button--primary";
    button.dataset.baseProductStart = product.id || "";
    button.textContent = product.pitchprintDesignId
      ? "Start Design"
      : "Unavailable";
    const syncAvailability = () => {
      button.disabled = !product.pitchprintDesignId || !colorSelect.value || !methodSelect.value;
    };
    colorSelect.addEventListener("change", syncAvailability);
    methodSelect.addEventListener("change", syncAvailability);
    syncAvailability();
    actions.append(button);

    card.append(top, copy, actions);
    wrap.append(card);
  });
}

function projectPreviewUrls(product) {
  if (Array.isArray(product.previewUrls)) return product.previewUrls;
  try {
    const parsed = JSON.parse(product.previewUrls || "[]");
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function creatorProductPreviewUrl(product) {
  const previews = projectPreviewUrls(product);
  return (
    (product.previewUrl?.startsWith("https://") && product.previewUrl) ||
    previews.find((url) => url.startsWith("https://")) ||
    (product.baseProductImageUrl?.startsWith("https://") && product.baseProductImageUrl) ||
    null
  );
}

function designFilterLabel(filter) {
  return {
    ACTIVE: "Active",
    ALL: "All",
    DRAFT: "Drafts",
    PENDING: "Pending",
    REJECTED: "Needs Changes",
    PUBLISHED: "Published",
    ARCHIVED: "Archived",
  }[filter] || "All";
}

function filterCreatorProducts(products, state) {
  const query = String(state.designSearch || "").trim().toLowerCase();
  return products
    .filter((product) => {
      const status = String(product.status || "DRAFT").toUpperCase();
      return (
        state.designFilter === "ALL" ||
        (state.designFilter === "ACTIVE" && status !== "ARCHIVED") ||
        status === state.designFilter
      );
    })
    .filter((product) => {
      if (!query) return true;
      return [
        product.title,
        product.description,
        product.baseProductTitle,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(query);
    })
    .sort((a, b) => {
      const sort = state.designSort || "updated";
      const updatedA = new Date(a.updatedAt || a.createdAt || 0).getTime();
      const updatedB = new Date(b.updatedAt || b.createdAt || 0).getTime();
      const createdA = new Date(a.createdAt || 0).getTime();
      const createdB = new Date(b.createdAt || 0).getTime();
      const publishedA = new Date(a.publishedAt || 0).getTime();
      const publishedB = new Date(b.publishedAt || 0).getTime();
      if (sort === "newest") return createdB - createdA;
      if (sort === "oldest") return createdA - createdB;
      if (sort === "published") return publishedB - publishedA || updatedB - updatedA;
      return updatedB - updatedA;
    });
}

function renderDesignFilters(root, products) {
  const wrap = root?.querySelector("[data-dashboard-design-filters]");
  if (!wrap) return;
  const state = dashboardState(root);
  const counts = products.reduce(
    (memo, product) => {
      const status = String(product.status || "DRAFT").toUpperCase();
      memo.ALL += 1;
      memo[status] = (memo[status] || 0) + 1;
      return memo;
    },
    { ACTIVE: 0, ALL: 0, DRAFT: 0, PENDING: 0, REJECTED: 0, PUBLISHED: 0, ARCHIVED: 0 },
  );
  counts.ACTIVE = counts.ALL - counts.ARCHIVED;
  wrap.replaceChildren();
  ["ACTIVE", "DRAFT", "PENDING", "REJECTED", "PUBLISHED", "ARCHIVED", "ALL"].forEach((filter) => {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.designFilter = filter;
    button.className = "ch-designs__filter";
    button.setAttribute("aria-pressed", String(state.designFilter === filter));
    button.textContent = `${designFilterLabel(filter)} ${counts[filter] || 0}`;
    wrap.append(button);
  });
}

function designRelativeDate(product) {
  const value = product.updatedAt || product.submittedAt || product.publishedAt || product.createdAt;
  if (!value) return "Updated recently";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Updated recently";
  const diff = Date.now() - date.getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "Updated just now";
  if (minutes < 60) return `Updated ${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Updated ${hours} hr ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `Updated ${days} day${days === 1 ? "" : "s"} ago`;
  return `Updated ${formatDate(value)}`;
}

function addDesignButton(parent, label, dataset, variant = "") {
  const button = document.createElement("button");
  button.type = "button";
  Object.entries(dataset).forEach(([key, value]) => {
    button.dataset[key] = value;
  });
  button.className = variant ? `ch-design-card__button ${variant}` : "ch-design-card__button";
  button.textContent = label;
  parent.append(button);
  return button;
}

function addDesignLink(parent, label, href) {
  const link = document.createElement("a");
  link.className = "ch-design-card__button";
  link.href = href;
  link.textContent = label;
  parent.append(link);
  return link;
}

function addMenuAction(menu, label, action, productId, destructive = false) {
  const button = document.createElement("button");
  button.type = "button";
  button.dataset.designMenuAction = action;
  button.dataset.creatorProductId = productId;
  button.className = destructive ? "ch-design-menu__item ch-design-menu__item--danger" : "ch-design-menu__item";
  button.setAttribute("role", "menuitem");
  button.textContent = label;
  menu.append(button);
}

function renderCreatorProducts(list, empty, products) {
  if (!list || !empty) return;
  const root = list.closest("[data-customhouse-dashboard]");
  if (root) {
    dashboardState(root).creatorProducts = products;
    root.__customHouseCreatorProducts = products;
  }
  const state = root ? dashboardState(root) : { designFilter: "ACTIVE", designSearch: "", designSort: "updated" };
  if (root) renderDesignFilters(root, products);
  list.replaceChildren();
  const visibleProducts = filterCreatorProducts(products, state);
  empty.hidden = products.length > 0;
  if (products.length > 0 && !visibleProducts.length) {
    const item = document.createElement("li");
    item.className = "ch-designs__empty-result";
    const title = document.createElement("strong");
    const copy = document.createElement("p");
    const clear = document.createElement("button");
    title.textContent = state.designSearch
      ? `No designs match "${state.designSearch}".`
      : `No ${designFilterLabel(state.designFilter).toLowerCase()} designs yet.`;
    copy.textContent = state.designSearch
      ? "Try a different title, description, or base product."
      : "Your designs will appear here when they reach this status.";
    clear.type = "button";
    clear.dataset.designClearSearch = "true";
    clear.textContent = state.designSearch ? "Clear Search" : "Show All";
    item.append(title, copy, clear);
    list.append(item);
    return;
  }
  visibleProducts.forEach((product) => {
    const item = document.createElement("li");
    item.className = "ch-design-card";
    item.dataset.creatorProductCard = product.id;

    const top = document.createElement("div");
    top.className = "ch-design-card__top";
    const media = document.createElement("figure");
    media.className = "ch-design-card__preview";
    const imageUrl = creatorProductPreviewUrl(product);
    if (imageUrl) {
      const image = document.createElement("img");
      image.src = imageUrl;
      image.alt = "";
      image.loading = "lazy";
      media.append(image);
    } else {
      const fallback = document.createElement("span");
      fallback.textContent = "Preview unavailable";
      media.append(fallback);
    }
    const menuWrap = document.createElement("div");
    menuWrap.className = "ch-design-menu";
    const menuButton = document.createElement("button");
    menuButton.type = "button";
    menuButton.className = "ch-design-menu__button";
    menuButton.dataset.designMenuToggle = product.id;
    menuButton.setAttribute("aria-label", "Design actions");
    menuButton.setAttribute("aria-expanded", "false");
    menuButton.setAttribute("aria-haspopup", "menu");
    const menuIcon = document.createElement("span");
    menuIcon.className = "material-symbols-outlined notranslate";
    menuIcon.setAttribute("translate", "no");
    menuIcon.setAttribute("aria-hidden", "true");
    menuIcon.textContent = "more_horiz";
    menuButton.append(menuIcon);
    const menu = document.createElement("div");
    menu.className = "ch-design-menu__panel";
    menu.dataset.designMenu = product.id;
    menu.setAttribute("role", "menu");
    menu.hidden = true;
    const statusValue = String(product.status || "DRAFT").toUpperCase();
    if (statusValue === "PENDING") {
      addMenuAction(menu, "View Details", "details", product.id);
      addMenuAction(menu, "Withdraw to Draft", "withdraw", product.id);
    } else {
      addMenuAction(menu, "Edit Details", "details", product.id);
      if (statusValue === "DRAFT" && product.pitchprintProjectId) {
        addMenuAction(menu, "Submit for Review", "submit", product.id);
      } else if (statusValue === "REJECTED") {
        addMenuAction(menu, "Resubmit for Review", "submit", product.id);
      }
      if (["DRAFT", "REJECTED"].includes(statusValue)) {
        addMenuAction(menu, "Delete Design", "delete", product.id, true);
      } else if (statusValue === "PUBLISHED") {
        addMenuAction(menu, "Archive Design", "archive", product.id, true);
      } else if (statusValue === "ARCHIVED") {
        addMenuAction(menu, "Delete Design", "delete", product.id, true);
      }
    }
    menuWrap.append(menuButton, menu);
    top.append(media, menuWrap);

    const body = document.createElement("div");
    body.className = "ch-design-card__body";
    const status = document.createElement("span");
    status.className = `customhouse-status-badge customhouse-status-badge--${String(
      product.status || "draft",
    ).toLowerCase()}`;
    status.textContent = creatorProductStatusLabel(product.status);
    const title = document.createElement("strong");
    title.className = "ch-design-card__title";
    title.title = product.title || product.baseProductTitle || "Untitled design";
    title.textContent = product.title || product.baseProductTitle || "Untitled design";
    const description = document.createElement("p");
    description.className = "ch-design-card__description";
    description.textContent = product.description || "No description yet.";
    const base = document.createElement("small");
    base.className = "ch-design-card__meta";
    base.textContent = `Base product: ${product.baseProductTitle || "Base product"}`;
    const date = document.createElement("span");
    date.className = "ch-design-card__meta";
    date.textContent = designRelativeDate(product);
    body.append(status, title, description, base, date);
    if (statusValue === "REJECTED") {
      const reason = document.createElement("p");
      reason.className = "ch-design-card__reason";
      reason.textContent = product.rejectionReason || "Changes requested by review.";
      body.append(reason);
    }

    const actions = document.createElement("div");
    actions.className = "ch-design-card__actions";
    const addDesignAction = (label) => {
      addDesignButton(actions, label, { creatorProductDesign: product.id }, "ch-design-card__button--primary");
    };
    if (statusValue === "DRAFT") {
      addDesignAction(product.pitchprintProjectId ? "Edit Design" : "Continue Designing");
    } else if (statusValue === "REJECTED") {
      addDesignAction("Edit Design");
    } else if (statusValue === "PENDING") {
      const pending = document.createElement("span");
      pending.className = "ch-design-card__locked-action";
      pending.textContent = "Pending Review";
      actions.append(pending);
    } else if (statusValue === "PUBLISHED") {
      addDesignLink(
        actions,
        "View Product",
        product.publicProductUrl || `/apps/customhouse/design/${encodeURIComponent(product.id)}`,
      );
      addDesignLink(
        actions,
        "View Collection",
        product.collectionUrl || `/apps/customhouse/creator/${encodeURIComponent(product.creatorHandle || "")}`,
      );
    } else if (statusValue === "ARCHIVED") {
      addDesignButton(actions, "Restore to Draft", { designDirectAction: "restore-to-draft", creatorProductId: product.id });
    }

    item.append(top, body, actions);
    list.append(item);
  });
}

async function refreshCreatorProducts(profile) {
  const list = profile.querySelector("[data-dashboard-creator-products]");
  const empty = profile.querySelector("[data-dashboard-creator-products-empty]");
  const message = profile.querySelector("[data-dashboard-creator-products-message]");
  if (!list || list.dataset.refreshing === "true") return;
  list.dataset.refreshing = "true";
  try {
    const products = await requestCreatorProducts();
    const root = profile.closest("[data-customhouse-dashboard]");
    if (root) {
      dashboardState(root).creatorProducts = products;
      root.__customHouseCreatorProducts = products;
    }
    renderCreatorProducts(list, empty, products);
    renderRecentSubmissionsFromProducts(root, products);
    if (message && message.dataset.persist !== "true") message.textContent = "";
  } catch {
    if (message) message.textContent = "Creator Products could not be loaded.";
  } finally {
    list.dataset.refreshing = "false";
  }
}

async function refreshCreatorBaseProducts(root) {
  const wrap = root.querySelector("[data-dashboard-base-products]");
  if (!wrap || wrap.dataset.refreshing === "true") return;
  wrap.dataset.refreshing = "true";
  try {
    const products = await requestCreatorBaseProducts();
    dashboardState(root).baseProducts = products;
    renderBaseProducts(root, products);
  } catch {
    wrap.textContent = "Eligible base products could not be loaded.";
  } finally {
    wrap.dataset.refreshing = "false";
  }
}

function cleanPitchPrintRuntimeProjectId(value) {
  const projectId = String(value || "").trim();
  if (!projectId || /^(undefined|null)$/i.test(projectId)) return "";
  if (/^gid:\/\//i.test(projectId) || /^https?:\/\//i.test(projectId)) return "";
  return /^[A-Za-z0-9][A-Za-z0-9_.:-]{2,200}$/.test(projectId)
    ? projectId
    : "";
}

function firstPitchPrintRuntimeProjectId(...values) {
  for (const value of values) {
    const projectId = cleanPitchPrintRuntimeProjectId(value);
    if (projectId) return projectId;
  }
  return "";
}

export function normalizePitchPrintSaveEvent(value, options = {}) {
  const data = value?.data && typeof value.data === "object" ? value.data : value;
  const project = data?.project && typeof data.project === "object" ? data.project : {};
  const allowGenericIds = options.allowGenericIds !== false;
  const projectId = firstPitchPrintRuntimeProjectId(
    data?.projectId,
    data?.project_id,
    project?.projectId,
    project?.project_id,
    project?._id,
    project?.id,
    ...(allowGenericIds ? [data?._id, data?.id, data?.tid] : []),
  );
  const previews = Array.isArray(data?.previews)
    ? data.previews
    : Array.isArray(data?.previewUrls)
      ? data.previewUrls
      : Array.isArray(data?.files)
        ? data.files
      : data?.previewUrl
        ? [data.previewUrl]
        : data?.preview
          ? [data.preview]
        : [];
  return {
    projectId,
    previews,
    previewUrl: previews[0] || data?.previewUrl || data?.preview || "",
    designId: data?.designId || data?.design_id || "",
  };
}

export function normalizeCreatorSetupEvent(value) {
  const message = value?.detail || value?.data || value || {};
  const data =
    message?.payload && typeof message.payload === "object"
      ? message.payload
      : message?.value && typeof message.value === "object"
        ? message.value
        : message;
  if (
    message?.type &&
    message.type !== "CUSTOMHOUSE_PP_CREATOR_SETUP_READY"
  ) {
    return null;
  }
  const setup = data?.creatorSetup && typeof data.creatorSetup === "object"
    ? data.creatorSetup
    : data;
  if (
    setup?.creatorContext !== true &&
    setup?.launchContext !== "creator_dashboard" &&
    setup?.interactionMode !== "CREATOR_DESIGN" &&
    setup?.designMode !== "creator_design" &&
    setup?.isCreatorProduct !== true &&
    setup?.flowMode !== "CREATOR_DESIGN"
  ) {
    return null;
  }
  const setupSaveEvent = normalizePitchPrintSaveEvent(setup, {
    allowGenericIds: false,
  });
  const dataSaveEvent = normalizePitchPrintSaveEvent(data, {
    allowGenericIds: false,
  });
  return {
    ...setupSaveEvent,
    projectId:
      setupSaveEvent.projectId ||
      dataSaveEvent.projectId,
    previewUrl:
      setupSaveEvent.previewUrl ||
      dataSaveEvent.previewUrl,
    previews:
      setupSaveEvent.previews?.length
        ? setupSaveEvent.previews
        : dataSaveEvent.previews,
    designId:
      setupSaveEvent.designId ||
      dataSaveEvent.designId,
    creatorSetup: normalizeCreatorSetupPayload(setup),
  };
}

function normalizeCreatorSetupPayload(setup) {
  const record = setup && typeof setup === "object" ? { ...setup } : {};
  const selectedColors = Array.isArray(record.selectedColors)
    ? record.selectedColors
        .map((color) => String(color || "").trim())
        .filter(Boolean)
    : [];
  const fixedColor =
    String(record.fixedColor || "").trim() ||
    String(record.selectedColor || "").trim() ||
    (selectedColors.length === 1 ? selectedColors[0] : "");

  if (fixedColor) {
    record.fixedColor = fixedColor;
    record.selectedColor = fixedColor;
    record.selectedColors = [fixedColor];
  }

  record.flowMode = "CREATOR_DESIGN";
  record.interactionMode = "CREATOR_DESIGN";
  record.productOrigin = "global";
  record.baseProductOrigin = "global";
  record.designMode = "creator_design";
  record.creatorContext = true;
  record.launchContext = "creator_dashboard";
  record.isCreatorProduct = true;
  const fixedProductionMethod = String(
    record.fixedProductionMethod ||
      record.productionMethod ||
      record.selectedProductionMethod ||
      "",
  ).trim().toUpperCase();
  if (fixedProductionMethod) {
    record.selectedProductionMethod = fixedProductionMethod;
    record.productionMethod = fixedProductionMethod;
    record.fixedProductionMethod = fixedProductionMethod;
  }
  return record;
}

function parseCustomHouseArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function pitchPrintProductVariants(product) {
  return parseCustomHouseArray(
    product?.baseProductVariants ||
      product?.variants ||
      product?.baseProductVariantsJson,
  )
    .map((variant) => ({
      id: String(variant?.id || variant?.graphqlId || ""),
      graphqlId: String(variant?.graphqlId || variant?.id || ""),
      variantId: String(variant?.variantId || variant?.cartId || variant?.numericId || ""),
      title: String(variant?.title || variant?.size || "Size"),
      size: String(variant?.size || variant?.title || "Size"),
      selectedOptions: Array.isArray(variant?.selectedOptions)
        ? variant.selectedOptions
            .map((option) => ({
              name: String(option?.name || ""),
              value: String(option?.value || ""),
            }))
            .filter((option) => option.name && option.value)
        : [],
      availableForSale: variant?.availableForSale !== false,
    }))
    .map((variant) => ({
      ...variant,
      options: variant.selectedOptions.map((option) => option.value),
    }))
    .filter((variant, index, variants) =>
      variant.variantId &&
      variant.availableForSale &&
      variants.findIndex((item) => item.variantId === variant.variantId) === index,
    );
}

function baseProductForPitchPrint(root, product) {
  return (dashboardState(root).baseProducts || []).find(
    (item) => item.id === product?.shopifyProductId,
  ) || null;
}

function parseJsonObject(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function creatorSetupForProduct(product) {
  if (product?._customHouseCreatorSetup) return product._customHouseCreatorSetup;
  const setup = parseJsonObject(product?.designVariantSelectionsJson);
  return setup?.schema === "creator_design_setup_v1" ? setup : null;
}

function normalizePitchPrintLaunchId(value) {
  return String(value || "").trim();
}

export function creatorPitchPrintLaunchConfig(product) {
  const designId = normalizePitchPrintLaunchId(product?.pitchprintDesignId);
  const projectId = normalizePitchPrintLaunchId(product?.pitchprintProjectId);
  if (!designId) {
    throw new Error("PitchPrint is not configured for this product.");
  }
  return {
    designId,
    projectId,
    mode: projectId ? "edit" : "new",
  };
}

function optionValuesFromVariants(variants, pattern) {
  return Array.from(new Set(
    variants
      .map((variant) =>
        (variant.selectedOptions || []).find((option) =>
          pattern.test(String(option.name || "").trim()),
        )?.value,
      )
      .filter(Boolean),
  ));
}

function productionPricingForProduct(root, product) {
  const baseProduct = baseProductForPitchPrint(root, product);
  return parseJsonObject(
    baseProduct?.productionMethodPricing ||
      product?.productionMethodPricing ||
      product?.productionMethodPricingJson,
  );
}

async function ensurePitchPrintBaseProductConfig(root, product) {
  const existing = baseProductForPitchPrint(root, product);
  if (existing?.productionMethodPricing && pitchPrintProductVariants(existing).length) {
    return existing;
  }
  const products = await requestCreatorBaseProducts();
  dashboardState(root).baseProducts = products;
  const wrap = root.querySelector("[data-dashboard-base-products]");
  if (wrap && wrap.dataset.refreshing !== "true") renderBaseProducts(root, products);
  return baseProductForPitchPrint(root, product);
}

function creatorPitchPrintConfig(root, product, identity) {
  const hydratedProduct = hydratePitchPrintProduct(root, product);
  const baseProduct = baseProductForPitchPrint(root, hydratedProduct);
  const variants = pitchPrintProductVariants(hydratedProduct);
  const setup = creatorSetupForProduct(product);
  const pricing = productionPricingForProduct(root, hydratedProduct);
  const productionMethods = Array.isArray(pricing?.productionMethods)
    ? pricing.productionMethods
    : [];
  const colorOptionValues = optionValuesFromVariants(variants, /^(color|colour|farg|färg)$/i);
  const sizeOptionValues = optionValuesFromVariants(variants, /^(size|storlek|storrelse)$/i);
  const baseProductOrigin = "global";
  const config = {
    enabled: true,
    flowMode: "CREATOR_DESIGN",
    interactionMode: "CREATOR_DESIGN",
    productOrigin: baseProductOrigin,
    baseProductOrigin,
    designMode: "creator_design",
    creatorContext: true,
    launchContext: "creator_dashboard",
    isCreatorProduct: true,
    creatorProductId: product.id,
    creatorPublicHandle: product.creatorHandle || product.publicHandle || "",
    shopifyProductId: product.shopifyProductId,
    productId: product.shopifyProductId,
    productHandle: product.shopifyProductHandle || baseProduct?.handle || "",
    productTitle: product.baseProductTitle || baseProduct?.title || product.title || "Creator Product",
    variants,
    variantMatrix: variants,
    options: baseProduct?.options || [],
    colorOptionValues,
    colors: colorOptionValues,
    sizeOptionValues,
    sizes: sizeOptionValues,
    optionGroups: [
      {
        id: "color",
        label: "Product color",
        values: colorOptionValues,
        multiple: false,
      },
      {
        id: "size",
        label: "Size",
        values: sizeOptionValues,
        multiple: false,
        hidden: true,
      },
    ],
    selectedColor: setup?.fixedColor || "",
    selectedColors: setup?.fixedColor ? [setup.fixedColor] : [],
    fixedColor: setup?.fixedColor || "",
    selectedProductionMethod: setup?.productionMethod || "",
    productionMethod: setup?.productionMethod || "",
    fixedProductionMethod: setup?.productionMethod || "",
    productionMethods,
    productionMethodPricing: pricing?.productionMethodPricing || {},
    supportsMultipleSelections: false,
    userId: identity?.userId || "",
  };
  window.CustomHouseCreatorPitchPrintConfig = config;
  return config;
}

function hydratePitchPrintProduct(root, product) {
  if (!product) return product;
  const variants = pitchPrintProductVariants(product);
  if (variants.length) return product;
  const baseProduct = (dashboardState(root).baseProducts || []).find(
    (item) => item.id === product.shopifyProductId,
  );
  const baseVariants = pitchPrintProductVariants(baseProduct);
  return baseVariants.length
    ? { ...product, baseProductVariants: baseVariants }
    : product;
}

function maskPitchPrintKey(value) {
  const key = String(value || "").trim();
  if (!key) return "";
  if (key.length <= 8) return `${key.slice(0, 2)}...`;
  return `${key.slice(0, 4)}...${key.slice(-4)}`;
}

function pitchPrintDiagnostics(root, event, detail = {}) {
  root.__customHousePitchPrintDiagnostics =
    root.__customHousePitchPrintDiagnostics || [];
  root.__customHousePitchPrintDiagnostics.push({
    event,
    at: new Date().toISOString(),
    detail,
  });
  root.dispatchEvent(
    new CustomEvent("customhouse:pitchprint", {
      bubbles: true,
      detail: { event, ...detail },
    }),
  );
}

function getPitchPrintClientClass() {
  try {
    if (typeof PitchPrintClient === "function") {
      return PitchPrintClient;
    }
  } catch {
    // PitchPrintClient may not be declared yet.
  }
  if (typeof window.PitchPrintClient === "function") {
    return window.PitchPrintClient;
  }
  return null;
}

// eslint-disable-next-line no-unused-vars
function pitchPrintClientScripts() {
  return Array.from(document.querySelectorAll("script"))
    .map((script) => script.src || "")
    .filter((src) => src.includes("pitchprint"));
}

// eslint-disable-next-line no-unused-vars
function lexicalPitchPrintClientType() {
  try {
    return typeof PitchPrintClient;
  } catch {
    return "unavailable";
  }
}

async function waitForPitchPrintClientClass(timeoutMs = 4000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const Client = getPitchPrintClientClass();
    if (Client) return Client;
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  return getPitchPrintClientClass();
}

async function loadScript(src) {
  await new Promise((resolve, reject) => {
    const scripts = Array.from(document.scripts);
    const existing = scripts.find((script) => script.src === src);
    if (
      existing?.dataset.loaded === "true" ||
      existing?.readyState === "complete" ||
      existing?.readyState === "loaded" ||
      (src === JQUERY_SRC && window.jQuery)
    ) {
      resolve();
      return;
    }
    if (existing) {
      existing.addEventListener("load", resolve, { once: true });
      existing.addEventListener("error", reject, { once: true });
      return;
    }
    const script = document.createElement("script");
    script.src = src;
    script.async = true;
    script.addEventListener(
      "load",
      () => {
        script.dataset.loaded = "true";
        resolve();
      },
      { once: true },
    );
    script.addEventListener("error", reject, { once: true });
    document.head.append(script);
  });
}

async function loadPitchPrintClient(root) {
  const existingClient = getPitchPrintClientClass();
  if (existingClient) return existingClient;
  const src = root.dataset.pitchprintClientSrc || PITCHPRINT_CLIENT_SRC;
  if (!src?.startsWith("https://")) {
    throw new Error("PitchPrint client script is not configured.");
  }
  const existingPitchPrintScript = Array.from(document.querySelectorAll("script")).find(
    (script) => (script.src || "").includes("pitchprint.io/rsc/js/client.js"),
  );
  if (existingPitchPrintScript) {
    const Client = await waitForPitchPrintClientClass();
    if (Client) return Client;
    throw new Error("CLIENT_CONSTRUCTOR_ERROR: PitchPrint client constructor is unavailable.");
  }
  if (!window.jQuery) await loadScript(JQUERY_SRC);
  await loadScript(src);
  const Client = await waitForPitchPrintClientClass();
  if (!Client) {
    throw new Error("CLIENT_CONSTRUCTOR_ERROR: PitchPrint client constructor is unavailable.");
  }
  return Client;
}

function bindPitchPrintManager(root) {
  if (root.__customHousePitchPrintManagerBound) return;
  root.__customHousePitchPrintManagerBound = true;
  const manager = {
    client: null,
    activeCreatorProductId: "",
    activeProjectId: "",
    isDesignerOpening: false,
    token: 0,
    validationTimer: null,
    creatorSetupAbortController: null,
    showAppCalled: false,
    projectSaved: false,
    pendingCreatorSetup: null,
    pendingPitchPrintSave: null,
  };
  root.__customHousePitchPrintManager = manager;

  const clearValidationTimer = () => {
    if (!manager.validationTimer) return;
    window.clearTimeout(manager.validationTimer);
    manager.validationTimer = null;
  };
  const cleanupPitchPrintSession = () => {
    clearValidationTimer();
    if (manager.creatorSetupAbortController) {
      manager.creatorSetupAbortController.abort();
      manager.creatorSetupAbortController = null;
    }
    manager.client = null;
    manager.showAppCalled = false;
    manager.projectSaved = false;
    manager.pendingCreatorSetup = null;
    manager.pendingPitchPrintSave = null;
    manager.isDesignerOpening = false;
  };
  const hidePitchPrint = () => {
    try {
      if (typeof manager.client?.hideApp === "function") manager.client.hideApp();
      else if (typeof manager.client?.closeApp === "function") manager.client.closeApp();
    } catch {
      // PitchPrint close support varies by runtime; the review modal can still open.
    }
  };
  const bindPitchPrintEvent = (client, eventName, token, handler) => {
    if (!client || typeof client.on !== "function") return;
    client.on(eventName, (event) => {
      if (token !== manager.token) return;
      pitchPrintDiagnostics(root, eventName, {
        creatorProductId: manager.activeCreatorProductId,
        hasProjectId: Boolean(manager.activeProjectId),
      });
      handler?.(event);
    });
  };
  const buildCreatorSavePayload = () => {
    const setupEvent = manager.pendingCreatorSetup;
    const saveEvent = manager.pendingPitchPrintSave;
    const projectId = setupEvent?.projectId || saveEvent?.projectId || "";
    if (!projectId || !setupEvent?.creatorSetup) return null;
    const previews = setupEvent.previews?.length
      ? setupEvent.previews
      : saveEvent?.previews || [];
    return {
      ...(saveEvent || {}),
      ...setupEvent,
      projectId,
      previewUrl: setupEvent.previewUrl || saveEvent?.previewUrl || "",
      previews,
      designId: setupEvent.designId || saveEvent?.designId || "",
      creatorSetup: setupEvent.creatorSetup,
    };
  };
  const savePendingCreatorProduct = async (product, token) => {
    if (manager.projectSaved || token !== manager.token) return;
    const savePayload = buildCreatorSavePayload();
    if (!savePayload) {
      pitchPrintDiagnostics(root, "creator-save-pending", {
        creatorProductId: product?.id || "",
        hasCreatorSetup: Boolean(manager.pendingCreatorSetup?.creatorSetup),
        hasProjectId: Boolean(
          manager.pendingCreatorSetup?.projectId ||
            manager.pendingPitchPrintSave?.projectId,
        ),
      });
      return;
    }
    manager.projectSaved = true;
    try {
      const updated = await saveCreatorProductPitchPrintProject(
        product.id,
        savePayload,
      );
      updateCreatorProductInState(root, updated);
      hidePitchPrint();
      showCreatorToast(root, "Design saved.");
      openDesignReviewModal(root, updated);
    } catch (error) {
      manager.projectSaved = false;
      showCreatorToast(
        root,
        error instanceof Error ? error.message : "Design could not be saved.",
        true,
      );
    }
  };
  const handlePitchPrintCreatorSetupReady = async (product, event, token) => {
    if (manager.projectSaved || token !== manager.token) return;
    const setupEvent = normalizeCreatorSetupEvent(event);
    if (!setupEvent) return;
    manager.pendingCreatorSetup = setupEvent;
    await savePendingCreatorProduct(product, token);
  };
  const handlePitchPrintProjectSaved = async (product, event, token) => {
    if (manager.projectSaved || token !== manager.token) return;
    const setupEvent = normalizeCreatorSetupEvent(event);
    if (setupEvent) manager.pendingCreatorSetup = setupEvent;
    const saveEvent = normalizePitchPrintSaveEvent(event);
    if (
      saveEvent.projectId ||
      saveEvent.previewUrl ||
      saveEvent.previews?.length ||
      saveEvent.designId
    ) {
      manager.pendingPitchPrintSave = saveEvent;
    }
    await savePendingCreatorProduct(product, token);
  };
  const bindCreatorSetupWindowEvents = (product, token) => {
    if (manager.creatorSetupAbortController) {
      manager.creatorSetupAbortController.abort();
    }
    const controller = new AbortController();
    manager.creatorSetupAbortController = controller;
    window.addEventListener(
      "message",
      (event) => {
        if (
          event?.data?.type === "CUSTOMHOUSE_PP_CREATOR_CONFIG_REQUEST" ||
          event?.data?.type === "CUSTOMHOUSE_PP_ORDER_CONFIG_REQUEST"
        ) {
          const payload = window.CustomHouseCreatorPitchPrintConfig || null;
          event.source?.postMessage?.({
            type: "CUSTOMHOUSE_PP_CREATOR_CONFIG_DATA",
            payload,
          }, event.origin || "*");
          event.source?.postMessage?.({
            type: "CUSTOMHOUSE_PP_ORDER_CONFIG_DATA",
            payload,
          }, event.origin || "*");
          return;
        }
        if (event?.data?.type !== "CUSTOMHOUSE_PP_CREATOR_SETUP_READY") return;
        void handlePitchPrintCreatorSetupReady(product, event, token);
      },
      { signal: controller.signal },
    );
    window.addEventListener(
      "customhouse:pitchprint-creator-setup-ready",
      (event) => {
        void handlePitchPrintCreatorSetupReady(product, event, token);
      },
      { signal: controller.signal },
    );
  };
  const openPitchPrintDesigner = async (product, sourceButton = null) => {
    if (!product?.id || manager.isDesignerOpening) return;
    cleanupPitchPrintSession();
    manager.isDesignerOpening = true;
    manager.activeCreatorProductId = product.id;
    manager.token += 1;
    const token = manager.token;
    const restoreButton = setActionLoading(sourceButton, "Preparing designer...");
    try {
      const { designId, projectId, mode } = creatorPitchPrintLaunchConfig(product);
      manager.activeProjectId = projectId;
      const apiKey = root.dataset.pitchprintApiKey || "";
      if (!apiKey) throw new Error("PitchPrint public API key is not configured.");
      pitchPrintDiagnostics(root, "config", {
        clientSrc: root.dataset.pitchprintClientSrc || PITCHPRINT_CLIENT_SRC,
        apiKey: maskPitchPrintKey(apiKey),
        designIdPresent: Boolean(designId),
        projectIdPresent: Boolean(projectId),
        designIdLength: designId.length,
        projectIdLength: projectId.length,
        mode,
      });
      const [Client, identity] = await Promise.all([
        loadPitchPrintClient(root),
        requestPitchPrintIdentity(),
        ensurePitchPrintBaseProductConfig(root, product),
      ]);
      if (token !== manager.token) return;
      const customHouseConfig = creatorPitchPrintConfig(root, product, identity);
      const clientOptions = {
        apiKey,
        designId,
        mode,
        userId: identity.userId,
        custom: true,
        isvx: true,
        flowMode: "CREATOR_DESIGN",
        interactionMode: "CREATOR_DESIGN",
        productOrigin: customHouseConfig.productOrigin,
        baseProductOrigin: customHouseConfig.baseProductOrigin,
        designMode: "creator_design",
        creatorContext: true,
        launchContext: "creator_dashboard",
        isCreatorProduct: true,
        creatorProductId: product.id,
        creatorPublicHandle: customHouseConfig.creatorPublicHandle,
        customHouseConfig,
        product: {
          id: product.shopifyProductId,
          title: product.baseProductTitle || product.title || "Creator Product",
          name: product.baseProductTitle || product.title || "Creator Product",
          handle: customHouseConfig.productHandle,
          variants: customHouseConfig.variantMatrix,
          options: customHouseConfig.options,
          flowMode: "CREATOR_DESIGN",
          designMode: "creator_design",
          creatorContext: true,
          launchContext: "creator_dashboard",
          isCreatorProduct: true,
        },
        userData: {
          source: "customhouse_creator_dashboard",
          ...customHouseConfig,
        },
      };
      const client = new Client({
        ...clientOptions,
        ...(projectId ? { projectId } : {}),
      });
      manager.client = client;
      bindCreatorSetupWindowEvents(product, token);
      bindPitchPrintEvent(client, "lib-ready", token);
      bindPitchPrintEvent(client, "before-show", token);
      bindPitchPrintEvent(client, "app-shown", token, () => {
        manager.isDesignerOpening = false;
        restoreButton();
      });
      bindPitchPrintEvent(client, "editor-shown", token, () => {
        manager.isDesignerOpening = false;
        restoreButton();
      });
      bindPitchPrintEvent(client, "project-saved", token, (event) => {
        void handlePitchPrintProjectSaved(product, event, token);
      });
      bindPitchPrintEvent(client, "after-close-app", token, () => {
        manager.isDesignerOpening = false;
        restoreButton();
      });
      bindPitchPrintEvent(client, "error", token, (event) => {
        clearValidationTimer();
        manager.isDesignerOpening = false;
        restoreButton();
        showCreatorToast(root, "Unable to open the designer. Please try again.", true);
        pitchPrintDiagnostics(root, "app-error", { data: event?.data || null });
      });
      bindPitchPrintEvent(client, "app-validated", token, () => {
        clearValidationTimer();
        if (manager.showAppCalled) return;
        manager.showAppCalled = true;
        pitchPrintDiagnostics(root, "showApp", { creatorProductId: product.id });
        client.showApp();
      });
      manager.validationTimer = window.setTimeout(() => {
        if (manager.showAppCalled || token !== manager.token) return;
        manager.isDesignerOpening = false;
        restoreButton();
        showCreatorToast(root, "Unable to open the designer. Please try again.", true);
        pitchPrintDiagnostics(root, "app-validation-timeout", {
          designIdPresent: Boolean(designId),
          projectIdPresent: Boolean(projectId),
          designIdLength: designId.length,
          projectIdLength: projectId.length,
          mode,
        });
      }, 12000);
    } catch (error) {
      manager.isDesignerOpening = false;
      restoreButton();
      showCreatorToast(
        root,
        error instanceof Error ? error.message : "Unable to open the designer. Please try again.",
        true,
      );
      pitchPrintDiagnostics(root, "error", {
        message: error instanceof Error ? error.message : "PitchPrint could not be loaded.",
      });
    }
  };
  root.__customHouseOpenPitchPrintDesigner = openPitchPrintDesigner;
}

function bindCreatorProductSubmission(root) {
  if (root.__customHouseCreatorProductSubmissionBound) return;
  root.__customHouseCreatorProductSubmissionBound = true;
  root.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-creator-product-submit]");
    if (!button) return;
    const restoreButton = setActionLoading(button, "Submitting...");
    try {
      const product = await submitCreatorProductForReview(button.dataset.creatorProductSubmit);
      updateCreatorProductInState(root, product);
      showCreatorToast(root, "Submitted for review.");
    } catch (error) {
      showCreatorToast(
        root,
        error instanceof Error ? error.message : "Creator Product could not be submitted.",
        true,
      );
    } finally {
      restoreButton();
    }
  });
}

function bindCreatorDesignActions(root) {
  if (root.__customHouseCreatorDesignActionsBound) return;
  root.__customHouseCreatorDesignActionsBound = true;
  root.addEventListener("click", async (event) => {
    const startButton = event.target.closest("[data-base-product-start]");
    if (startButton) {
      const state = dashboardState(root);
      const baseProduct = (state.baseProducts || []).find(
        (product) => product.id === startButton.dataset.baseProductStart,
      );
      if (!baseProduct?.pitchprintDesignId) return;
      const key = `start:${baseProduct.id}`;
      if (state.actionLoading.has(key)) return;
      state.actionLoading.add(key);
      const restoreButton = setActionLoading(startButton, "Preparing designer...");
      try {
        const card = startButton.closest(".customhouse-base-product-card");
        const fixedColor = card?.querySelector("[data-base-product-color]")?.value || "";
        const selectedProductionMethod = card?.querySelector("[data-base-product-method]")?.value || "";
        if (!fixedColor || !selectedProductionMethod) {
          throw new Error("Choose exactly one product color and one printing method.");
        }
        const created = await createCreatorProductDraft({
          shopifyProductId: baseProduct.id,
          title: baseProduct.title,
          description: "",
          pitchprintDesignId: baseProduct.pitchprintDesignId,
          fixedColor,
          selectedColors: [fixedColor],
          selectedProductionMethod,
          fixedProductionMethod: selectedProductionMethod,
        });
        created._customHouseCreatorSetup = {
          schema: "creator_design_setup_v1",
          flowMode: "CREATOR_DESIGN",
          interactionMode: "CREATOR_DESIGN",
          productOrigin: "global",
          baseProductOrigin: "global",
          designMode: "creator_design",
          creatorContext: true,
          launchContext: "creator_dashboard",
          isCreatorProduct: true,
          fixedColor,
          selectedColor: fixedColor,
          selectedColors: [fixedColor],
          selectedProductionMethod,
          productionMethod: selectedProductionMethod,
          fixedProductionMethod: selectedProductionMethod,
        };
        updateCreatorProductInState(root, created);
        showCreatorToast(root, "Draft created.");
        await root.__customHouseOpenPitchPrintDesigner?.(created, startButton);
      } catch (error) {
        restoreButton();
        showCreatorToast(
          root,
          error instanceof Error ? error.message : "Unable to open the designer. Please try again.",
          true,
        );
      } finally {
        state.actionLoading.delete(key);
      }
      return;
    }

    const editButton = event.target.closest("[data-creator-product-design]");
    if (!editButton) return;
    const product = creatorProductById(root, editButton.dataset.creatorProductDesign);
    if (product) await root.__customHouseOpenPitchPrintDesigner?.(product, editButton);
  });
}

function lockReviewModalScroll(root) {
  if (!root.__customHousePreviousOverflow) {
    root.__customHousePreviousOverflow = document.body.style.overflow || "";
  }
  document.documentElement.classList.add("customhouse-modal-open");
  document.body.classList.add("customhouse-modal-open");
  document.body.style.overflow = "hidden";
}

function unlockReviewModalScroll(root) {
  document.documentElement.classList.remove("customhouse-modal-open");
  document.body.classList.remove("customhouse-modal-open");
  document.body.style.overflow = root.__customHousePreviousOverflow || "";
  root.__customHousePreviousOverflow = "";
}

function renderReviewPreviews(root, product) {
  const previews = dashboardModalQuery(root, "[data-dashboard-review-previews]");
  if (!previews) return;
  previews.replaceChildren();
  const urls = projectPreviewUrls(product).filter((url) => url.startsWith("https://"));
  if (!urls.length && product.previewUrl?.startsWith("https://")) urls.push(product.previewUrl);
  if (!urls.length) {
    const empty = document.createElement("span");
    empty.className = "ch-creator-modal__preview-empty";
    empty.textContent = "Preview unavailable";
    previews.append(empty);
    return;
  }
  urls.slice(0, 2).forEach((url, index) => {
    const tile = document.createElement("figure");
    tile.className = "ch-creator-modal__preview";
    const image = document.createElement("img");
    image.src = url;
    image.alt = index === 0 ? "Front design preview" : "Back design preview";
    image.loading = "lazy";
    const caption = document.createElement("figcaption");
    caption.textContent = index === 0 ? "Front Preview" : "Back Preview";
    tile.append(image, caption);
    previews.append(tile);
  });
}

function renderReviewVariantSelections(root, product) {
  const summary = dashboardModalQuery(root, "[data-dashboard-review-variants]");
  if (!summary) return;
  summary.replaceChildren();
  const setup = creatorSetupForProduct(product);
  if (!setup) {
    const empty = document.createElement("p");
    empty.className = "ch-creator-modal__variant-empty";
    empty.textContent = "Choose one color and confirm copyright.";
    summary.append(empty);
    return;
  }
  const title = document.createElement("strong");
  title.textContent = "Creator setup";
  const list = document.createElement("ul");
  [
    `Color: ${setup.fixedColor}`,
    `Designed placements: ${setup.placementCount}`,
  ].forEach((text) => {
    const item = document.createElement("li");
    item.textContent = text;
    list.append(item);
  });
  summary.append(title, list);
}

function closeDesignReviewModal(root) {
  const modal = dashboardModalQuery(root, "[data-dashboard-review-modal]");
  if (modal) modal.hidden = true;
  unlockReviewModalScroll(root);
  root.__customHouseReviewProduct = null;
}

function openDesignReviewModal(root, product) {
  const modal = dashboardModalQuery(root, "[data-dashboard-review-modal]");
  if (!modal || !product) return;
  root.__customHouseReviewProduct = product;
  const title = modal.querySelector("#customhouse-review-modal-title");
  const description = modal.querySelector("#customhouse-review-modal-description");
  const productName = modal.querySelector("[data-dashboard-review-product]");
  const status = modal.querySelector("[data-dashboard-review-status]");
  const primary = modal.querySelector("[data-dashboard-review-submit]");
  if (title) title.textContent = product.status === "REJECTED" ? "Changes saved" : "Design saved";
  if (description) description.textContent = "Review your design before submitting it for approval.";
  if (productName) productName.textContent = product.title || product.baseProductTitle || "Creator product";
  if (status) {
    status.className = `customhouse-status-badge customhouse-status-badge--${String(product.status || "DRAFT").toLowerCase()}`;
    status.textContent = creatorProductStatusLabel(product.status);
  }
  if (primary) primary.textContent = product.status === "REJECTED" ? "Resubmit for Review" : "Submit for Review";
  renderReviewPreviews(root, product);
  renderReviewVariantSelections(root, product);
  modal.hidden = false;
  lockReviewModalScroll(root);
  window.setTimeout(() => modal.querySelector("[data-dashboard-review-edit]")?.focus(), 0);
}

function bindDesignReviewModal(root) {
  if (root.__customHouseDesignReviewBound) return;
  root.__customHouseDesignReviewBound = true;
  dashboardModalQueryAll(root, "[data-dashboard-review-close]").forEach((button) => {
    button.addEventListener("click", () => closeDesignReviewModal(root));
  });
  dashboardModalQuery(root, "[data-dashboard-review-draft]")?.addEventListener("click", () => {
    closeDesignReviewModal(root);
    showCreatorToast(root, "Design saved as draft.");
  });
  dashboardModalQuery(root, "[data-dashboard-review-edit]")?.addEventListener("click", async (event) => {
    const product = root.__customHouseReviewProduct;
    closeDesignReviewModal(root);
    if (product) await root.__customHouseOpenPitchPrintDesigner?.(product, event.currentTarget);
  });
  dashboardModalQuery(root, "[data-dashboard-review-submit]")?.addEventListener("click", async (event) => {
    const product = root.__customHouseReviewProduct;
    if (!product?.id) return;
    const restoreButton = setActionLoading(event.currentTarget, "Submitting...");
    try {
      const updated = await submitCreatorProductForReview(product.id);
      updateCreatorProductInState(root, updated);
      closeDesignReviewModal(root);
      showCreatorToast(root, "Submitted for review.");
    } catch (error) {
      showCreatorToast(
        root,
        error instanceof Error ? error.message : "Creator Product could not be submitted.",
        true,
      );
    } finally {
      restoreButton();
    }
  });
  document.addEventListener("keydown", (event) => {
    const modal = dashboardModalQuery(root, "[data-dashboard-review-modal]");
    if (event.key === "Escape" && modal && !modal.hidden) closeDesignReviewModal(root);
  });
}

function creatorProductDetailsPayload(root) {
  const modal = dashboardModalQuery(root, "[data-dashboard-details-modal]");
  return {
    title: modal?.querySelector("[data-dashboard-details-title]")?.value || "",
    description: modal?.querySelector("[data-dashboard-details-description]")?.value || "",
  };
}

function setDetailsSaveState(root) {
  const modal = dashboardModalQuery(root, "[data-dashboard-details-modal]");
  const save = modal?.querySelector("[data-dashboard-details-save]");
  const count = modal?.querySelector("[data-dashboard-details-count]");
  const titleError = modal?.querySelector("[data-dashboard-details-title-error]");
  const product = root.__customHouseDetailsProduct;
  if (!modal || !save || !product) return;
  const payload = creatorProductDetailsPayload(root);
  const title = payload.title.trim();
  const description = payload.description.trim();
  const changed =
    title !== String(product.title || "").trim() ||
    description !== String(product.description || "").trim();
  const valid = title.length >= 2 && title.length <= 120 && description.length <= 1000;
  if (count) count.textContent = String(description.length);
  if (titleError) {
    titleError.textContent =
      title && title.length < 2 ? "Use at least 2 characters." : "";
  }
  save.disabled = !changed || !valid || product.status === "PENDING";
}

function closeDesignDetailsModal(root, force = false) {
  const modal = dashboardModalQuery(root, "[data-dashboard-details-modal]");
  if (!modal || modal.hidden) return;
  const product = root.__customHouseDetailsProduct;
  if (!force && product) {
    const payload = creatorProductDetailsPayload(root);
    const changed =
      payload.title.trim() !== String(product.title || "").trim() ||
      payload.description.trim() !== String(product.description || "").trim();
    if (changed) {
      const discard = modal.querySelector("[data-dashboard-details-discard]");
      if (discard) {
        discard.hidden = false;
        discard.querySelector("[data-dashboard-details-keep-editing]")?.focus();
      }
      return;
    }
  }
  modal.querySelector("[data-dashboard-details-discard]")?.setAttribute("hidden", "");
  modal.hidden = true;
  unlockReviewModalScroll(root);
  root.__customHouseDetailsProduct = null;
  root.__customHouseDetailsReturnFocus?.focus?.();
  root.__customHouseDetailsReturnFocus = null;
}

function openDesignDetailsModal(root, product, sourceButton = null) {
  const modal = dashboardModalQuery(root, "[data-dashboard-details-modal]");
  if (!modal || !product) return;
  root.__customHouseDetailsProduct = product;
  root.__customHouseDetailsReturnFocus = sourceButton;
  const title = modal.querySelector("[data-dashboard-details-title]");
  const description = modal.querySelector("[data-dashboard-details-description]");
  const base = modal.querySelector("[data-dashboard-details-base]");
  const status = modal.querySelector("[data-dashboard-details-status]");
  const lock = modal.querySelector("[data-dashboard-details-lock]");
  const error = modal.querySelector("[data-dashboard-details-error]");
  const pending = product.status === "PENDING";
  if (title) {
    title.value = product.title || product.baseProductTitle || "";
    title.disabled = pending;
  }
  if (description) {
    description.value = product.description || "";
    description.disabled = pending;
  }
  if (base) base.textContent = product.baseProductTitle || "Base product";
  if (status) status.textContent = creatorProductStatusLabel(product.status);
  if (lock) lock.hidden = !pending;
  if (error) {
    error.hidden = true;
    error.textContent = "";
  }
  const discard = modal.querySelector("[data-dashboard-details-discard]");
  if (discard) discard.hidden = true;
  modal.hidden = false;
  lockReviewModalScroll(root);
  setDetailsSaveState(root);
  window.setTimeout(() => (pending ? modal.querySelector("[data-dashboard-details-close]") : title)?.focus(), 0);
}

function actionModalConfig(product, action) {
  const title = product?.title || product?.baseProductTitle || "this design";
  if (action === "delete") {
    return {
      eyebrow: "Delete Design",
      title: "Delete design?",
      description: `"${title}" will be permanently deleted. This cannot be undone.`,
      confirm: "Delete Design",
      destructive: true,
      toast: "Design deleted.",
    };
  }
  if (action === "archive") {
    return {
      eyebrow: "Archive Design",
      title: `Archive "${title}"?`,
      description: "It will be removed from your public collection and unavailable for new purchases. Existing orders and earnings are preserved.",
      confirm: "Archive Design",
      destructive: true,
      toast: "Design archived.",
    };
  }
  if (action === "withdraw") {
    return {
      eyebrow: "Withdraw Design",
      title: `Withdraw "${title}"?`,
      description: "This will cancel the pending review and return the design to Draft.",
      confirm: "Withdraw to Draft",
      destructive: false,
      toast: "Design returned to draft.",
    };
  }
  return {
    eyebrow: "Restore Design",
    title: `Restore "${title}"?`,
    description: "This will return the archived design to Draft. It will not be republished automatically.",
    confirm: "Restore to Draft",
    destructive: false,
    toast: "Design restored to draft.",
  };
}

function closeDesignActionModal(root) {
  const modal = dashboardModalQuery(root, "[data-dashboard-action-modal]");
  if (modal) {
    modal.hidden = true;
    modal.classList.remove("ch-design-delete-modal--withdraw");
    modal.classList.remove("ch-design-delete-modal--delete");
    modal.querySelectorAll("[data-dashboard-withdraw-notice], [data-dashboard-delete-notice]").forEach((notice) => {
      notice.hidden = true;
    });
  }
  unlockReviewModalScroll(root);
  root.__customHouseActionHandler = null;
  root.__customHouseActionKind = "";
  root.__customHouseActionProduct = null;
  root.__customHouseActionName = "";
  root.__customHouseActionReturnFocus?.focus?.();
  root.__customHouseActionReturnFocus = null;
}

function openDashboardActionModal(root, config, sourceButton = null) {
  const modal = dashboardModalQuery(root, "[data-dashboard-action-modal]");
  if (!modal || typeof config?.onConfirm !== "function") return;
  modal.classList.remove("ch-design-delete-modal--withdraw");
  modal.classList.remove("ch-design-delete-modal--delete");
  modal.querySelectorAll("[data-dashboard-withdraw-notice], [data-dashboard-delete-notice]").forEach((notice) => {
    notice.hidden = true;
  });
  root.__customHouseActionHandler = config.onConfirm;
  root.__customHouseActionKind = config.kind || "generic";
  root.__customHouseActionToast = config.toast || "";
  root.__customHouseActionReturnFocus = sourceButton;
  modal.querySelector("[data-dashboard-action-eyebrow]").textContent = config.eyebrow || "Confirm";
  modal.querySelector("[data-dashboard-action-title]").textContent = config.title || "Continue?";
  modal.querySelector("[data-dashboard-action-description]").textContent =
    config.description || "Please confirm this action.";
  const confirm = modal.querySelector("[data-dashboard-action-confirm]");
  if (confirm) {
    confirm.textContent = config.confirm || "Confirm";
    confirm.dataset.loadingLabel = config.loading || "Working...";
    confirm.classList.toggle("ch-design-delete-modal__confirm--safe", !config.destructive);
  }
  const error = modal.querySelector("[data-dashboard-action-error]");
  if (error) {
    error.hidden = true;
    error.textContent = "";
  }
  modal.hidden = false;
  lockReviewModalScroll(root);
  window.setTimeout(() => confirm?.focus(), 0);
}

function openDesignActionModal(root, product, action, sourceButton = null) {
  const modal = dashboardModalQuery(root, "[data-dashboard-action-modal]");
  if (!modal || !product || !action) return;
  const config = actionModalConfig(product, action);
  modal.classList.toggle("ch-design-delete-modal--withdraw", action === "withdraw");
  modal.classList.toggle("ch-design-delete-modal--delete", action === "delete");
  const withdrawNotice = modal.querySelector("[data-dashboard-withdraw-notice]");
  if (withdrawNotice) withdrawNotice.hidden = action !== "withdraw";
  const deleteNotice = modal.querySelector("[data-dashboard-delete-notice]");
  if (deleteNotice) deleteNotice.hidden = action !== "delete";
  root.__customHouseActionProduct = product;
  root.__customHouseActionName = action;
  root.__customHouseActionToast = config.toast;
  root.__customHouseActionReturnFocus = sourceButton;
  modal.querySelector("[data-dashboard-action-eyebrow]").textContent = config.eyebrow;
  modal.querySelector("[data-dashboard-action-title]").textContent = config.title;
  modal.querySelector("[data-dashboard-action-description]").textContent = config.description;
  const confirm = modal.querySelector("[data-dashboard-action-confirm]");
  if (confirm) {
    confirm.textContent = config.confirm;
    confirm.classList.toggle("ch-design-delete-modal__confirm--safe", !config.destructive);
  }
  const error = modal.querySelector("[data-dashboard-action-error]");
  if (error) {
    error.hidden = true;
    error.textContent = "";
  }
  modal.hidden = false;
  lockReviewModalScroll(root);
  window.setTimeout(() => confirm?.focus(), 0);
}

function closeOpenDesignMenus(root, except = null) {
  root.querySelectorAll("[data-design-menu]").forEach((menu) => {
    if (menu === except) return;
    menu.hidden = true;
    const button = root.querySelector(`[data-design-menu-toggle="${menu.dataset.designMenu}"]`);
    button?.setAttribute("aria-expanded", "false");
  });
}

function bindMyDesignsUx(root) {
  if (root.__customHouseMyDesignsUxBound) return;
  root.__customHouseMyDesignsUxBound = true;
  let searchTimer = null;
  root.addEventListener("click", async (event) => {
    const filter = event.target.closest("[data-design-filter]");
    if (filter) {
      dashboardState(root).designFilter = filter.dataset.designFilter || "ACTIVE";
      const profile = root.querySelector("[data-dashboard-profile]");
      renderCreatorProducts(
        profile?.querySelector("[data-dashboard-creator-products]"),
        profile?.querySelector("[data-dashboard-creator-products-empty]"),
        dashboardState(root).creatorProducts || [],
      );
      return;
    }
    if (event.target.closest("[data-design-clear-search]")) {
      const state = dashboardState(root);
      state.designSearch = "";
      state.designFilter = "ACTIVE";
      const input = root.querySelector("[data-dashboard-design-search]");
      if (input) input.value = "";
      const profile = root.querySelector("[data-dashboard-profile]");
      renderCreatorProducts(
        profile?.querySelector("[data-dashboard-creator-products]"),
        profile?.querySelector("[data-dashboard-creator-products-empty]"),
        state.creatorProducts || [],
      );
      return;
    }
    const toggle = event.target.closest("[data-design-menu-toggle]");
    if (toggle) {
      const menu = root.querySelector(`[data-design-menu="${toggle.dataset.designMenuToggle}"]`);
      const nextHidden = !menu?.hidden ? true : false;
      closeOpenDesignMenus(root, menu);
      if (menu) menu.hidden = nextHidden;
      toggle.setAttribute("aria-expanded", String(!nextHidden));
      return;
    }
    if (!event.target.closest(".ch-design-menu")) closeOpenDesignMenus(root);
    const menuAction = event.target.closest("[data-design-menu-action]");
    if (menuAction) {
      closeOpenDesignMenus(root);
      const product = creatorProductById(root, menuAction.dataset.creatorProductId);
      const action = menuAction.dataset.designMenuAction;
      if (action === "details") openDesignDetailsModal(root, product, menuAction);
      else if (action === "submit" && product?.id) {
        const restoreButton = setActionLoading(menuAction, "Submitting...");
        try {
          const updated = await submitCreatorProductForReview(product.id);
          updateCreatorProductInState(root, updated);
          showCreatorToast(root, "Submitted for review.");
        } catch (error) {
          showCreatorToast(
            root,
            error instanceof Error ? error.message : "Creator Product could not be submitted.",
            true,
          );
        } finally {
          restoreButton();
        }
      }
      else openDesignActionModal(root, product, action, menuAction);
      return;
    }
    const directAction = event.target.closest("[data-design-direct-action]");
    if (directAction) {
      const product = creatorProductById(root, directAction.dataset.creatorProductId);
      openDesignActionModal(root, product, directAction.dataset.designDirectAction, directAction);
    }
  });
  root.querySelector("[data-dashboard-design-search]")?.addEventListener("input", (event) => {
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => {
      dashboardState(root).designSearch = event.target.value || "";
      const profile = root.querySelector("[data-dashboard-profile]");
      renderCreatorProducts(
        profile?.querySelector("[data-dashboard-creator-products]"),
        profile?.querySelector("[data-dashboard-creator-products-empty]"),
        dashboardState(root).creatorProducts || [],
      );
    }, 240);
  });
  root.querySelector("[data-dashboard-design-sort]")?.addEventListener("change", (event) => {
    dashboardState(root).designSort = event.target.value || "updated";
    const profile = root.querySelector("[data-dashboard-profile]");
    renderCreatorProducts(
      profile?.querySelector("[data-dashboard-creator-products]"),
      profile?.querySelector("[data-dashboard-creator-products-empty]"),
      dashboardState(root).creatorProducts || [],
    );
  });
  dashboardModalQuery(root, "[data-dashboard-details-title]")?.addEventListener("input", () => setDetailsSaveState(root));
  dashboardModalQuery(root, "[data-dashboard-details-description]")?.addEventListener("input", () => setDetailsSaveState(root));
  dashboardModalQueryAll(root, "[data-dashboard-details-close]").forEach((button) => {
    button.addEventListener("click", () => closeDesignDetailsModal(root));
  });
  dashboardModalQuery(root, "[data-dashboard-details-keep-editing]")?.addEventListener("click", () => {
    const discard = dashboardModalQuery(root, "[data-dashboard-details-discard]");
    if (discard) discard.hidden = true;
    dashboardModalQuery(root, "[data-dashboard-details-title]")?.focus();
  });
  dashboardModalQuery(root, "[data-dashboard-details-discard-confirm]")?.addEventListener("click", () => {
    closeDesignDetailsModal(root, true);
  });
  dashboardModalQuery(root, "[data-dashboard-details-form]")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const product = root.__customHouseDetailsProduct;
    if (!product?.id) return;
    const save = dashboardModalQuery(root, "[data-dashboard-details-save]");
    const error = dashboardModalQuery(root, "[data-dashboard-details-error]");
    const state = dashboardState(root);
    const key = `details:${product.id}`;
    if (state.actionLoading.has(key)) return;
    state.actionLoading.add(key);
    const restoreButton = setActionLoading(save, "Saving...");
    try {
      const updated = await updateCreatorProductDetails(product.id, creatorProductDetailsPayload(root));
      updateCreatorProductInState(root, updated);
      restoreButton();
      if (save) {
        save.disabled = true;
        save.textContent = "Updated";
      }
      window.setTimeout(() => {
        closeDesignDetailsModal(root, true);
        showCreatorToast(root, "Design details updated.");
      }, 250);
    } catch (requestError) {
      if (error) {
        error.hidden = false;
        error.textContent =
          requestError instanceof Error ? requestError.message : "Design details could not be updated.";
      }
      restoreButton();
      setDetailsSaveState(root);
    } finally {
      state.actionLoading.delete(key);
    }
  });
  dashboardModalQueryAll(root, "[data-dashboard-action-close]").forEach((button) => {
    button.addEventListener("click", () => closeDesignActionModal(root));
  });
  dashboardModalQuery(root, "[data-dashboard-action-confirm]")?.addEventListener("click", async (event) => {
    if (typeof root.__customHouseActionHandler === "function") {
      const state = dashboardState(root);
      const key = root.__customHouseActionKind || "generic";
      if (state.actionLoading.has(key)) return;
      state.actionLoading.add(key);
      const restoreButton = setActionLoading(
        event.currentTarget,
        event.currentTarget.dataset.loadingLabel || "Working...",
      );
      const error = dashboardModalQuery(root, "[data-dashboard-action-error]");
      try {
        await root.__customHouseActionHandler();
        const toast = root.__customHouseActionToast || "Action completed.";
        closeDesignActionModal(root);
        showDashboardToast(root, toast, "success");
      } catch (requestError) {
        if (error) {
          error.hidden = false;
          error.textContent =
            requestError instanceof Error ? requestError.message : "Action could not be completed.";
        }
      } finally {
        restoreButton();
        state.actionLoading.delete(key);
      }
      return;
    }
    const product = root.__customHouseActionProduct;
    const action = root.__customHouseActionName;
    if (!product?.id || !action) return;
    const state = dashboardState(root);
    const key = `${action}:${product.id}`;
    if (state.actionLoading.has(key)) return;
    state.actionLoading.add(key);
    const label =
      action === "archive" ? "Archiving..." :
      action === "delete" ? "Deleting..." :
      action === "withdraw" ? "Withdrawing..." :
      "Restoring...";
    const restoreButton = setActionLoading(event.currentTarget, label);
    const error = dashboardModalQuery(root, "[data-dashboard-action-error]");
    try {
      const result = await performCreatorProductAction(product.id, action);
      if (action === "delete" && result?.deleted) {
        removeCreatorProductFromState(root, product.id);
      } else if (result?.product) {
        updateCreatorProductInState(root, result.product);
      }
      closeDesignActionModal(root);
      showCreatorToast(root, root.__customHouseActionToast || "Design updated.");
    } catch (requestError) {
      if (error) {
        error.hidden = false;
        error.textContent =
          requestError instanceof Error ? requestError.message : "Design action could not be completed.";
      }
    } finally {
      restoreButton();
      state.actionLoading.delete(key);
    }
  });
  document.addEventListener("click", (event) => {
    if (!root.contains(event.target)) closeOpenDesignMenus(root);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    closeOpenDesignMenus(root);
    const details = dashboardModalQuery(root, "[data-dashboard-details-modal]");
    const action = dashboardModalQuery(root, "[data-dashboard-action-modal]");
    if (details && !details.hidden) closeDesignDetailsModal(root);
    if (action && !action.hidden) closeDesignActionModal(root);
  });
}

function initials(name) {
  return String(name || "S")
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase() || "S";
}

function formatDate(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(date);
}

function titleCaseStatus(status) {
  return String(status || "Draft")
    .toLowerCase()
    .replace(/_/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function creatorProductStatusLabel(status) {
  const value = String(status || "DRAFT").toUpperCase();
  if (value === "PENDING") return "Pending Review";
  if (value === "REJECTED") return "Needs Changes";
  return titleCaseStatus(value);
}

function referralFor(referralCode) {
  const code = String(referralCode || "").trim();
  if (!code) return { code: "", url: "" };
  return {
    code,
    url: `${window.location.origin}/?ref=${encodeURIComponent(code)}`,
  };
}

function firstProfileLink(value) {
  const input = String(value || "").trim();
  if (!input) return "";
  try {
    const parsed = JSON.parse(input);
    if (Array.isArray(parsed)) {
      return parsed.find((item) => typeof item === "string" && item.startsWith("https://")) || "";
    }
  } catch {
    // Plain text values are normalized below.
  }
  return input
    .split(/[\s,\r\n]+/)
    .map((item) => item.trim())
    .find((item) => item.startsWith("https://")) || "";
}

function accountValue(value, fallback = "Not provided") {
  const text = String(value ?? "").trim();
  return text || fallback;
}

function setAccountText(profile, selector, value, fallback) {
  const node = profile.querySelector(selector);
  if (node) node.textContent = accountValue(value, fallback);
}

function setAccountLink(profile, selector, url, label) {
  const node = profile.querySelector(selector);
  if (!node) return;
  const safeUrl = String(url || "").trim();
  node.textContent = accountValue(label || safeUrl);
  if (safeUrl?.startsWith("https://") || safeUrl?.startsWith("/")) {
    node.href = safeUrl;
    node.hidden = false;
  } else {
    node.removeAttribute("href");
    node.hidden = false;
  }
}

function renderAccountDetails(profile, root, data, displayName, portfolioUrl, collectionUrl) {
  const statusLabel =
    data.status === "APPROVED" ? "Approved Creator" : titleCaseStatus(data.status || "APPROVED");
  const collectionLabel = data.collection?.publicHandle
    ? `${displayName} Designs`
    : "Not provided";
  setAccountText(profile, "[data-dashboard-account-display-name]", displayName);
  setAccountText(profile, "[data-dashboard-account-summary-name]", displayName);
  setAccountText(profile, "[data-dashboard-account-legal-name]", data.legalName);
  setAccountText(profile, "[data-dashboard-account-email]", data.email || root.dataset.shopifyEmail);
  setAccountText(profile, "[data-dashboard-account-city]", data.city);
  setAccountText(profile, "[data-dashboard-account-country]", data.country);
  setAccountText(profile, "[data-dashboard-account-handle]", data.handle);
  setAccountText(profile, "[data-dashboard-account-status]", statusLabel);
  setAccountText(profile, "[data-dashboard-account-summary-status]", statusLabel);
  setAccountText(
    profile,
    "[data-dashboard-account-terms]",
    data.termsAccepted ? "Accepted" : "Not accepted",
  );
  setAccountText(profile, "[data-dashboard-account-collection-name]", collectionLabel);
  setAccountLink(profile, "[data-dashboard-account-portfolio]", portfolioUrl, portfolioUrl ? portfolioUrl.replace(/^https?:\/\//, "") : "Not provided");
  setAccountLink(profile, "[data-dashboard-account-collection]", collectionUrl, collectionUrl ? collectionUrl.replace(/^https?:\/\//, "") : "Not provided");
  setAccountLink(profile, "[data-dashboard-account-handle-link]", collectionUrl, data.handle ? `${window.location.host}/${data.handle}` : "");
  setAccountLink(profile, "[data-dashboard-account-summary-collection]", collectionUrl, collectionLabel);
  setAccountLink(profile, "[data-dashboard-account-learn-more]", collectionUrl, "Learn more about your profile");
  setAccountText(profile, "[data-dashboard-account-bio]", data.bio);
}

function profileUpdateValues(root, data = {}) {
  const legalName = data.legalName || "";
  const displayName = data.displayName || "";
  const bio = data.bio || "";
  const socialUrl = firstProfileLink(data.socialLinksJson) || data.portfolioUrl || "";
  const termsAgreement = data.termsAccepted === true ? "true" : "";
  return {
    "first name": root.dataset.shopifyFirstName || "",
    "last name": root.dataset.shopifyLastName || "",
    "creator display name": displayName,
    "creator_display_name_1": displayName,
    "legal name": legalName,
    "legal_name": legalName,
    country: data.country || "",
    "email address": data.email || root.dataset.shopifyEmail || "",
    email: data.email || root.dataset.shopifyEmail || "",
    city: data.city || "",
    "short creator bio": bio,
    "short_creator_bio": bio,
    "creator bio": bio,
    bio,
    "social/portfolio url": socialUrl,
    "socialportfolio_url": socialUrl,
    "social portfolio url": socialUrl,
    "portfolio url": socialUrl,
    primaryPlatform: data.primaryPlatform || "",
    primaryProfileUrl: data.primaryProfileUrl || "",
    socialLinks: (() => {
      try {
        return JSON.parse(data.socialLinksJson || "[]").filter(Boolean).join("\n");
      } catch {
        return "";
      }
    })(),
    "terms agreement": termsAgreement,
    "terms_agreement": termsAgreement,
    "terms accepted": termsAgreement,
  };
}

function profileUpdateFieldPlan(values) {
  return [
    { aliases: ["first name", "firstname"], value: values["first name"] },
    { aliases: ["last name", "lastname"], value: values["last name"] },
    {
      aliases: ["creator display name", "creator_display_name_1", "creatordisplayname"],
      value: values["creator_display_name_1"],
    },
    { aliases: ["legal name", "legal_name", "legalname"], value: values["legal_name"] },
    { aliases: ["country"], value: values.country },
    { aliases: ["email address", "email"], value: values["email address"] },
    { aliases: ["city"], value: values.city },
    {
      aliases: ["creator profile photo", "creator_profile_photo_1", "profile photo"],
      value: "",
      skip: true,
    },
    {
      aliases: ["short creator bio", "short_creator_bio", "creator bio", "bio"],
      value: values["short_creator_bio"],
    },
    {
      aliases: ["social/portfolio url", "socialportfolio_url", "social portfolio url", "portfolio url"],
      value: values["socialportfolio_url"],
    },
    {
      aliases: ["terms agreement", "terms_agreement", "terms accepted"],
      value: values["terms_agreement"],
    },
  ];
}

function normalizeFieldText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function nearbyFieldText(field) {
  const pieces = [];
  let node = field;
  for (let depth = 0; depth < 4 && node; depth += 1) {
    const previous = node.previousElementSibling;
    if (previous) {
      pieces.push(previous.getAttribute("data-field"));
      pieces.push(previous.getAttribute("data-key"));
      pieces.push(previous.getAttribute("data-name"));
      if (/label/i.test(previous.tagName) || previous.matches("[class*='label'], [class*='title']")) {
        pieces.push(previous.textContent);
      }
    }
    const parent = node.parentElement;
    if (parent) {
      pieces.push(
        parent.getAttribute("data-field"),
        parent.getAttribute("data-key"),
        parent.getAttribute("data-name"),
      );
      const parentPrevious = parent.previousElementSibling;
      if (parentPrevious) {
        pieces.push(parentPrevious.getAttribute("data-field"));
        pieces.push(parentPrevious.getAttribute("data-key"));
        pieces.push(parentPrevious.getAttribute("data-name"));
        if (/label/i.test(parentPrevious.tagName) || parentPrevious.matches("[class*='label'], [class*='title']")) {
          pieces.push(parentPrevious.textContent);
        }
      }
    }
    node = parent;
  }
  return pieces.filter(Boolean).join(" ");
}

function fieldLabelText(field) {
  const id = field.id;
  const escapedId =
    id && typeof CSS !== "undefined" && typeof CSS.escape === "function"
      ? CSS.escape(id)
      : id?.replace(/"/g, '\\"');
  const label = escapedId ? document.querySelector(`label[for="${escapedId}"]`) : null;
  const closest = field.closest("label, .cf-field, [class*='field'], [data-field], [data-key], [data-name]");
  return [
    label?.textContent,
    closest?.tagName === "LABEL" ? closest.textContent : null,
    closest?.getAttribute("data-field"),
    closest?.getAttribute("data-key"),
    closest?.getAttribute("data-name"),
    nearbyFieldText(field),
    field.getAttribute("aria-label"),
    field.getAttribute("placeholder"),
    field.getAttribute("data-field"),
    field.getAttribute("data-key"),
    field.getAttribute("data-name"),
    field.id,
    field.name,
  ]
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function fieldIdentityText(field) {
  return [
    field.name,
    field.id,
    field.getAttribute("data-field"),
    field.getAttribute("data-key"),
    field.getAttribute("data-name"),
  ]
    .filter(Boolean)
    .join(" ");
}

function fieldMatchesValue(label, key, field) {
  const spacedKey = key.replace(/_/g, " ");
  const identity = field ? normalizeFieldText(fieldIdentityText(field)) : "";
  const normalizedKey = normalizeFieldText(key);
  const normalizedSpacedKey = normalizeFieldText(spacedKey);
  if (identity && (identity === normalizedKey || identity.includes(normalizedKey))) {
    return true;
  }
  return (
    label.includes(key) ||
    label.includes(spacedKey) ||
    normalizeFieldText(label).includes(normalizedKey) ||
    normalizeFieldText(label).includes(normalizedSpacedKey)
  );
}

function findPlanEntry(plan, alias) {
  return plan.find((entry) => entry.aliases.includes(alias));
}

function setNativeFieldValue(field, value, force = false) {
  if (!value || !field || field.type === "file" || field.type === "hidden") return false;
  if (field.type === "checkbox" || field.type === "radio") {
    const shouldCheck = /^(true|yes|1|on|accepted)$/i.test(String(value).trim());
    if (!force && field.checked === shouldCheck) return false;
    field.checked = shouldCheck;
    field.dispatchEvent(new Event("input", { bubbles: true }));
    field.dispatchEvent(new Event("change", { bubbles: true }));
    field.dispatchEvent(new Event("blur", { bubbles: true }));
    return true;
  }
  if (field.tagName === "SELECT") {
    const normalizedValue = String(value).trim().toLowerCase();
    const option = Array.from(field.options || []).find(
      (item) =>
        String(item.value || "").trim().toLowerCase() === normalizedValue ||
        String(item.textContent || "").trim().toLowerCase() === normalizedValue,
    );
    if (option) value = option.value;
  }
  if (!force && String(field.value || "").trim()) return false;
  const previousValue = field.value;
  const prototype = Object.getPrototypeOf(field);
  const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
  if (descriptor?.set) {
    descriptor.set.call(field, value);
  } else {
    field.value = value;
  }
  field.dispatchEvent(new Event("input", { bubbles: true }));
  field.dispatchEvent(new Event("change", { bubbles: true }));
  field.dispatchEvent(new Event("blur", { bubbles: true }));
  return previousValue !== value || force;
}

// eslint-disable-next-line no-unused-vars
function hydrateProfileUpdateForm(root, data, options = {}) {
  const wrap = root.querySelector("[data-dashboard-profile-form-wrap]");
  if (!wrap) return;
  const values = options.values || profileUpdateValues(root, data);
  const plan = profileUpdateFieldPlan(values);
  const fields = Array.from(wrap.querySelectorAll("input, textarea, select")).filter(
    (field) => field.type !== "hidden",
  );
  const matchedFields = new Set();
  fields.forEach((field) => {
    const label = fieldLabelText(field);
    const match = plan.find((entry) =>
      !entry.skip && entry.aliases.some((key) => fieldMatchesValue(label, key, field)),
    );
    if (!match) return;
    if (setNativeFieldValue(field, match.value, Boolean(options.force))) matchedFields.add(field);
  });

  const bioEntry = findPlanEntry(plan, "short_creator_bio");
  const socialEntry = findPlanEntry(plan, "socialportfolio_url");
  const termsEntry = findPlanEntry(plan, "terms_agreement");
  const textareas = fields.filter((field) => field.tagName === "TEXTAREA");
  const bioField =
    textareas.find((field) => !matchedFields.has(field) && fieldLabelText(field).includes("bio")) ||
    textareas.at(-1);
  if (bioEntry && bioField && setNativeFieldValue(bioField, bioEntry.value, Boolean(options.force))) {
    matchedFields.add(bioField);
  }

  const bioIndex = bioField ? fields.indexOf(bioField) : -1;
  const socialField =
    fields.find((field) => {
      if (matchedFields.has(field) || field.type === "file" || field.type === "checkbox" || field.type === "radio") {
        return false;
      }
      const label = fieldLabelText(field);
      return /social|portfolio|url/.test(label) || field.type === "url";
    }) ||
    fields.find((field, index) => {
      if (index <= bioIndex || matchedFields.has(field)) return false;
      return field.tagName !== "TEXTAREA" && field.type !== "file" && field.type !== "checkbox" && field.type !== "radio";
    });
  if (socialEntry && socialField && setNativeFieldValue(socialField, socialEntry.value, Boolean(options.force))) {
    matchedFields.add(socialField);
  }

  const termsField =
    fields.find((field) => {
      if (field.type !== "checkbox" && field.type !== "radio") return false;
      return /terms|agreement|accept/.test(fieldLabelText(field));
    }) ||
    fields.filter((field) => field.type === "checkbox" || field.type === "radio").at(-1);
  if (termsEntry && termsField && setNativeFieldValue(termsField, termsEntry.value, Boolean(options.force))) {
    matchedFields.add(termsField);
  }

  fields.forEach((field, index) => {
    if (matchedFields.has(field)) return;
    const entry = plan[index];
    if (!entry || entry.skip || field.type === "file") return;
    setNativeFieldValue(field, entry.value, Boolean(options.force));
  });
}

// eslint-disable-next-line no-unused-vars
function readProfileUpdateFormValues(root) {
  const submittedValues = profileUpdateValues(root, {});
  const plan = profileUpdateFieldPlan(submittedValues);
  const wrap = dashboardModalQuery(root, "[data-dashboard-profile-form-wrap]");
  wrap?.querySelectorAll("input, textarea, select").forEach((field, index) => {
    if (field.type === "file" || field.type === "hidden") return;
    const label = fieldLabelText(field);
    const match =
      plan.find((entry) => entry.aliases.some((key) => fieldMatchesValue(label, key, field))) ||
      plan[index];
    if (!match || match.skip) return;
    const value = field.type === "checkbox" ? (field.checked ? "true" : "") : field.value;
    if (String(value || "").trim()) {
      match.aliases.forEach((key) => {
        submittedValues[key] = value;
      });
    }
  });
  return {
    displayName: submittedValues["creator_display_name_1"],
    legalName: submittedValues["legal_name"],
    country: submittedValues.country,
    city: submittedValues.city,
    bio: submittedValues["short_creator_bio"],
    portfolioUrl: submittedValues["socialportfolio_url"],
    termsAccepted: submittedValues["terms_agreement"],
    values: submittedValues,
  };
}

function setProfileField(form, name, value) {
  const field = form?.querySelector(`[data-profile-field="${name}"]`);
  if (!field) return;
  if (field.type === "checkbox") {
    field.checked = /^(true|yes|1|on|accepted)$/i.test(String(value || ""));
    return;
  }
  field.value = value || "";
}

function updateNativeProfileModalSummary(root, values = {}, data = {}) {
  const displayName =
    values["creator_display_name_1"] ||
    data.displayName ||
    data.legalName ||
    [root.dataset.shopifyFirstName, root.dataset.shopifyLastName].filter(Boolean).join(" ") ||
    "Creator";
  const creatorInitials = initials(displayName);
  dashboardModalQueryAll(root, "[data-profile-modal-avatar-initials], [data-profile-modal-sidebar-initials]").forEach((item) => {
    item.textContent = creatorInitials;
    item.hidden = false;
  });
  const modalImages = [
    dashboardModalQuery(root, "[data-profile-modal-avatar-image]"),
    dashboardModalQuery(root, "[data-profile-modal-sidebar-image]"),
  ];
  modalImages.forEach((image) => {
    if (!image) return;
    const loaded = showProfileImage(image, data.profileImageUrl, `${displayName} profile`);
    if (!loaded) image.hidden = true;
  });
  if (data.profileImageUrl?.startsWith("https://")) {
    dashboardModalQueryAll(root, "[data-profile-modal-avatar-initials], [data-profile-modal-sidebar-initials]").forEach((item) => {
      item.hidden = true;
    });
  }
  dashboardModalQueryAll(root, "[data-profile-modal-avatar], [data-profile-modal-sidebar-avatar]").forEach((item) => {
    item.setAttribute("aria-label", `${displayName} profile picture`);
  });
  const summaryName = dashboardModalQuery(root, "[data-profile-modal-summary-name]");
  if (summaryName) summaryName.textContent = displayName;
  const collectionName = dashboardModalQuery(root, "[data-profile-modal-summary-collection]");
  if (collectionName) {
    collectionName.textContent = data.collection?.displayName || `${displayName} Designs`;
  }
  const collectionLink = dashboardModalQuery(root, "[data-dashboard-modal-collection-link]");
  if (collectionLink) {
    const href = data.collectionUrl || "/apps/customhouse/creators";
    collectionLink.href = href;
  }
  const termsAccepted = /^(true|yes|1|on|accepted)$/i.test(String(values["terms_agreement"] || ""));
  const filled = [
    values["creator_display_name_1"],
    values["legal_name"],
    values.email || values["email address"],
    values.city,
    values.country,
    values["short_creator_bio"],
    values["socialportfolio_url"],
    termsAccepted ? "accepted" : "",
  ].filter((value) => String(value || "").trim()).length;
  const percent = Math.max(10, Math.round((filled / 8) * 100));
  const progress = dashboardModalQuery(root, "[data-profile-modal-progress]");
  const progressLabel = dashboardModalQuery(root, "[data-profile-modal-progress-label]");
  if (progress) progress.value = percent;
  if (progressLabel) progressLabel.textContent = `${percent}%`;
}

function hydrateNativeProfileForm(root, data = {}) {
  const form = dashboardModalQuery(root, "[data-dashboard-profile-update-form]");
  if (!form) return;
  const values = profileUpdateValues(root, data);
  setProfileField(form, "displayName", values["creator_display_name_1"]);
  setProfileField(form, "legalName", values["legal_name"]);
  setProfileField(form, "email", values.email || values["email address"]);
  setProfileField(form, "city", values.city);
  setProfileField(form, "country", values.country);
  setProfileField(form, "portfolioUrl", values["socialportfolio_url"]);
  setProfileField(form, "primaryPlatform", data.primaryPlatform || "");
  setProfileField(form, "primaryProfileUrl", data.primaryProfileUrl || "");
  setProfileField(form, "socialLinks", values.socialLinks);
  setProfileField(form, "bio", values["short_creator_bio"]);
  setProfileField(form, "termsAccepted", values["terms_agreement"]);
  updateNativeProfileModalSummary(root, values, data);
}

function nativeProfilePayload(form) {
  const data = new FormData(form);
  return {
    displayName: String(data.get("displayName") || ""),
    legalName: String(data.get("legalName") || ""),
    city: String(data.get("city") || ""),
    country: String(data.get("country") || ""),
    portfolioUrl: String(data.get("portfolioUrl") || ""),
    primaryPlatform: String(data.get("primaryPlatform") || ""),
    primaryProfileUrl: String(data.get("primaryProfileUrl") || ""),
    socialLinks: String(data.get("socialLinks") || "")
      .split(/[\r\n,]+/)
      .map((value) => value.trim())
      .filter(Boolean),
    bio: String(data.get("bio") || ""),
    termsAccepted: data.get("termsAccepted") === "on",
  };
}

function bindProfileUpdateModal(root, refreshDashboard, getDashboardData) {
  const modal = dashboardModalQuery(root, "[data-dashboard-profile-modal]");
  const message = dashboardModalQuery(root, "[data-dashboard-profile-modal-message]");
  const form = dashboardModalQuery(root, "[data-dashboard-profile-update-form]");
  const triggers = root.querySelectorAll(
    "[data-dashboard-edit-profile], [data-dashboard-edit-profile-icon]",
  );
  const closeButtons = dashboardModalQueryAll(root, "[data-dashboard-profile-modal-close]");

  const close = () => {
    if (modal) modal.hidden = true;
    unlockReviewModalScroll(root);
  };

  const open = () => {
    if (message) {
      message.hidden = true;
      message.textContent = "";
    }
    hydrateNativeProfileForm(root, getDashboardData?.() || {});
    if (modal) modal.hidden = false;
    lockReviewModalScroll(root);
    if (typeof refreshDashboard === "function") {
      void refreshDashboard({ quiet: true }).then(() => {
        hydrateNativeProfileForm(root, getDashboardData?.() || {});
      });
    }
  };

  triggers.forEach((trigger) => {
    trigger.addEventListener("click", (event) => {
      event.preventDefault();
      open();
    });
  });
  closeButtons.forEach((button) => button.addEventListener("click", close));
  form?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = form.querySelector('button[type="submit"]');
    if (message) {
      message.hidden = true;
      message.textContent = "";
    }
    if (button) {
      button.disabled = true;
      button.dataset.originalLabel ||= button.textContent || "Update account";
      button.textContent = "Updating...";
    }
    try {
      await saveProfileUpdate(nativeProfilePayload(form));
      if (typeof refreshDashboard === "function") {
        await refreshDashboard({ quiet: true });
      }
      if (message) {
        message.hidden = false;
        message.textContent = "Profile details updated.";
      }
      window.setTimeout(close, 650);
    } catch {
      if (message) {
        message.hidden = false;
        message.textContent = "Profile details could not be updated. Please check the fields and try again.";
      }
    } finally {
      if (button) {
        button.disabled = false;
        button.textContent = button.dataset.originalLabel || "Update account";
      }
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && modal && !modal.hidden) close();
  });
}

function bindCreatorAccountDeactivation(root, refreshDashboard) {
  const button = root.querySelector("[data-dashboard-deactivate-creator]");
  if (!button || button.dataset.bound === "true") return;
  button.dataset.bound = "true";
  button.addEventListener("click", async () => {
    const confirmation = window.prompt(
      "This deactivates your Creator profile but keeps your Shopify customer account and financial history. Type DEACTIVATE to continue.",
    );
    if (confirmation !== "DEACTIVATE") return;
    const restore = setActionLoading(button, "Deactivating...");
    try {
      await deactivateCreatorAccount();
      await refreshDashboard?.();
    } catch (error) {
      restore();
      showDashboardToast(
        root,
        error instanceof Error ? error.message : "Creator account could not be deactivated.",
        "error",
      );
    }
  });
}

function bindCreatorNotifications(root) {
  const wrap = root.querySelector("[data-dashboard-notifications]");
  const toggle = wrap?.querySelector("[data-dashboard-notification-toggle]");
  const panel = wrap?.querySelector("[data-dashboard-notification-panel]");
  if (!wrap || !toggle || !panel || wrap.dataset.bound === "true") return;
  wrap.dataset.bound = "true";
  const close = () => {
    panel.hidden = true;
    toggle.setAttribute("aria-expanded", "false");
  };
  toggle.addEventListener("click", (event) => {
    event.stopPropagation();
    panel.hidden = !panel.hidden;
    toggle.setAttribute("aria-expanded", String(!panel.hidden));
  });
  wrap.querySelector("[data-dashboard-notification-close]")?.addEventListener("click", close);
  document.addEventListener("click", (event) => {
    if (!panel.hidden && !wrap.contains(event.target)) close();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !panel.hidden) close();
  });
}

function collectionBannerData(data = {}) {
  const collection = data.collection || {};
  return {
    bannerImageUrl: collection.bannerImageUrl || null,
    bannerTitle: collection.bannerTitle || "",
    bannerSubtitle: collection.bannerSubtitle || "",
    bannerUpdatedAt: collection.bannerUpdatedAt || null,
  };
}

function formatBannerUpdatedAt(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return `Updated ${date.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
}

function setBannerMessage(message, text, tone = "neutral", persist = true) {
  if (!message) return;
  message.textContent = text || "";
  message.dataset.tone = tone;
  message.dataset.persist = persist ? "true" : "false";
  message.hidden = !text;
}

function renderCollectionBannerPreview(root, banner) {
  const image = root.querySelector("[data-dashboard-banner-preview-image]");
  const empty = root.querySelector("[data-dashboard-banner-preview-empty]");
  const title = root.querySelector("[data-dashboard-banner-preview-title]");
  const subtitle = root.querySelector("[data-dashboard-banner-preview-subtitle]");
  const uploadLabel = root.querySelector("[data-dashboard-banner-upload-label]");
  const selected = root.querySelector("[data-dashboard-banner-selected]");
  const updated = root.querySelector("[data-dashboard-banner-updated]");
  const hasImage = banner.bannerImageUrl?.startsWith("https://") || banner.bannerImageUrl?.startsWith("blob:");
  if (image) {
    image.hidden = !hasImage;
    if (hasImage) {
      image.src = banner.bannerImageUrl;
      image.alt = banner.bannerTitle || "Collection banner preview";
    }
  }
  if (empty) empty.hidden = hasImage;
  if (title) {
    title.textContent = banner.bannerTitle || "";
    title.hidden = !banner.bannerTitle;
  }
  if (subtitle) {
    subtitle.textContent = banner.bannerSubtitle || "";
    subtitle.hidden = !banner.bannerSubtitle;
  }
  if (uploadLabel) uploadLabel.textContent = hasImage ? "Change image" : "Upload banner";
  if (selected && !selected.textContent) selected.hidden = true;
  if (updated) {
    const label = formatBannerUpdatedAt(banner.bannerUpdatedAt);
    updated.textContent = label;
    updated.hidden = !label;
  }
}

function hydrateCollectionBannerManager(root, data = {}) {
  const banner = collectionBannerData(data);
  const form = root.querySelector("[data-dashboard-banner-form]");
  const title = root.querySelector("[data-dashboard-banner-title]");
  const subtitle = root.querySelector("[data-dashboard-banner-subtitle]");
  const remove = root.querySelector("[data-dashboard-banner-remove]");
  const message = root.querySelector("[data-dashboard-banner-message]");
  if (title && document.activeElement !== title) title.value = banner.bannerTitle;
  if (subtitle && document.activeElement !== subtitle) subtitle.value = banner.bannerSubtitle;
  if (form) form.dataset.hasBanner = String(Boolean(banner.bannerImageUrl));
  if (remove) {
    remove.hidden = !banner.bannerImageUrl;
    remove.disabled = !banner.bannerImageUrl;
  }
  if (message && message.dataset.persist !== "true") setBannerMessage(message, "", "neutral", false);
  renderCollectionBannerPreview(root, banner);
}

function bindCollectionBannerManager(root, refreshDashboard, getDashboardData) {
  if (root.__customHouseCollectionBannerBound) return;
  root.__customHouseCollectionBannerBound = true;
  const form = root.querySelector("[data-dashboard-banner-form]");
  const input = root.querySelector("[data-dashboard-banner-input]");
  const title = root.querySelector("[data-dashboard-banner-title]");
  const subtitle = root.querySelector("[data-dashboard-banner-subtitle]");
  const message = root.querySelector("[data-dashboard-banner-message]");
  const save = root.querySelector("[data-dashboard-banner-save]");
  const remove = root.querySelector("[data-dashboard-banner-remove]");
  const selected = root.querySelector("[data-dashboard-banner-selected]");
  const bannerDraft = (root.__customHouseBannerDraft ||= {});
  const updatePreviewText = () => {
    const current = collectionBannerData(getDashboardData?.() || {});
    renderCollectionBannerPreview(root, {
      ...current,
      ...(bannerDraft.bannerImageUrl ? { bannerImageUrl: bannerDraft.bannerImageUrl } : {}),
      bannerTitle: title?.value || "",
      bannerSubtitle: subtitle?.value || "",
    });
  };
  title?.addEventListener("input", updatePreviewText);
  subtitle?.addEventListener("input", updatePreviewText);
  input?.addEventListener("change", () => {
    const file = input.files?.[0];
    if (!file) return;
    if (bannerDraft.bannerImageUrl?.startsWith("blob:")) URL.revokeObjectURL(bannerDraft.bannerImageUrl);
    bannerDraft.bannerImageUrl = URL.createObjectURL(file);
    renderCollectionBannerPreview(root, {
      bannerImageUrl: bannerDraft.bannerImageUrl,
      bannerTitle: title?.value || "",
      bannerSubtitle: subtitle?.value || "",
    });
    if (selected) {
      selected.textContent = `Selected: ${file.name}`;
      selected.hidden = false;
    }
    setBannerMessage(message, "Image selected. Save changes to publish it.", "neutral");
  });
  form?.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (form.dataset.saving === "true") return;
    form.dataset.saving = "true";
    const restoreButton = setActionLoading(save, "Saving...");
    setBannerMessage(message, "Saving collection banner...", "neutral");
    try {
      const collection = await saveCollectionBanner(form);
      if (bannerDraft.bannerImageUrl?.startsWith("blob:")) URL.revokeObjectURL(bannerDraft.bannerImageUrl);
      bannerDraft.bannerImageUrl = "";
      if (input) input.value = "";
      if (selected) {
        selected.textContent = "";
        selected.hidden = true;
      }
      hydrateCollectionBannerManager(root, { collection });
      if (typeof refreshDashboard === "function") {
        await refreshDashboard({ quiet: true });
      }
      setBannerMessage(message, "Collection banner updated.", "success");
      showDashboardToast(root, "Collection banner updated.", "success");
    } catch (error) {
      const text = error instanceof Error ? error.message : "Collection banner could not be saved.";
      setBannerMessage(message, text, "error");
      showDashboardToast(root, text, "error");
    } finally {
      form.dataset.saving = "false";
      restoreButton();
      if (message) {
        window.setTimeout(() => {
          message.dataset.persist = "false";
        }, 2200);
      }
    }
  });
  remove?.addEventListener("click", () => {
    openDashboardActionModal(
      root,
      {
        kind: "collection-banner-remove",
        eyebrow: "Collection Banner",
        title: "Remove collection banner?",
        description: "This clears the banner image, title, and description from your public collection.",
        confirm: "Remove Banner",
        loading: "Removing...",
        destructive: true,
        toast: "Collection banner removed.",
        onConfirm: async () => {
          const collection = await removeCollectionBanner();
          if (bannerDraft.bannerImageUrl?.startsWith("blob:")) URL.revokeObjectURL(bannerDraft.bannerImageUrl);
          bannerDraft.bannerImageUrl = "";
          if (input) input.value = "";
          hydrateCollectionBannerManager(root, { collection });
          if (typeof refreshDashboard === "function") {
            await refreshDashboard({ quiet: true });
          }
        },
      },
      remove,
    );
  });
}

function setCopyFeedback(button, text, tone = "success") {
  const labelNode = Array.from(button.children || []).find(
    (child) => !child.classList?.contains("material-symbols-outlined"),
  );
  const currentLabel = labelNode?.textContent || button.textContent || "Copy Link";
  const originalLabel = button.dataset.copyOriginalLabel || currentLabel;
  button.dataset.copyOriginalLabel = originalLabel;
  const explicitTarget = button.dataset.dashboardCopyMessageTarget
    ? document.querySelector(button.dataset.dashboardCopyMessageTarget)
    : null;
  const localTarget =
    explicitTarget ||
    button.parentElement?.querySelector("[data-dashboard-copy-store-message], [data-dashboard-copy-referral-message]");
  if (localTarget) {
    localTarget.textContent = text;
    localTarget.dataset.copyTone = tone;
  }
  const nextLabel = tone === "success" ? "Copied" : "Copy";
  if (labelNode) {
    labelNode.textContent = nextLabel;
  } else {
    button.textContent = nextLabel;
  }
  window.setTimeout(() => {
    if (localTarget && localTarget.textContent === text) {
      localTarget.textContent = "";
      delete localTarget.dataset.copyTone;
    }
    const activeLabelNode = Array.from(button.children || []).find(
      (child) => !child.classList?.contains("material-symbols-outlined"),
    );
    const activeLabel = activeLabelNode?.textContent || button.textContent;
    if (activeLabel === "Copied" || activeLabel === "Copy") {
      if (activeLabelNode) {
        activeLabelNode.textContent = button.dataset.copyOriginalLabel || "Copy Link";
      } else {
        button.textContent = button.dataset.copyOriginalLabel || "Copy Link";
      }
    }
  }, 2600);
}

function bindReferralCopy(root, url, message) {
  root.querySelectorAll("[data-dashboard-copy-referral]").forEach((button) => {
    button.disabled = !url;
    button.onclick = async () => {
      if (!url) return;
      try {
        await navigator.clipboard.writeText(url);
        if (message) message.textContent = "Referral link copied.";
        setCopyFeedback(button, "Referral link copied.");
      } catch {
        if (message) message.textContent = "Copy the referral link manually.";
        setCopyFeedback(button, "Copy the referral link manually.", "error");
      }
    };
  });
}

function bindStoreCopy(root, url, message) {
  root.querySelectorAll("[data-dashboard-copy-store]").forEach((button) => {
    button.disabled = !url;
    button.onclick = async () => {
      if (!url) return;
      try {
        await copyStoreUrl(button, url);
        if (message) message.textContent = "";
      } catch {
        if (message) message.textContent = "";
        setCopyFeedback(button, "Copy failed.", "error");
      }
    };
  });
}

function storeShareTargets(url, title) {
  const encodedUrl = encodeURIComponent(url);
  const encodedTitle = encodeURIComponent(title || "Custom House creator collection");
  return {
    facebook: `https://www.facebook.com/sharer/sharer.php?u=${encodedUrl}`,
    x: `https://twitter.com/intent/tweet?url=${encodedUrl}&text=${encodedTitle}`,
    whatsapp: `https://wa.me/?text=${encodedTitle}%20${encodedUrl}`,
    linkedin: `https://www.linkedin.com/sharing/share-offsite/?url=${encodedUrl}`,
  };
}

async function copyStoreUrl(button, url) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(url);
  } else {
    const textarea = document.createElement("textarea");
    textarea.value = url;
    textarea.setAttribute("readonly", "readonly");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.append(textarea);
    textarea.select();
    const copied = document.execCommand("copy");
    textarea.remove();
    if (!copied) throw new Error("Copy failed");
  }
  setCopyFeedback(button, "");
}

function bindStoreShare(root, url, title) {
  const targets = url ? storeShareTargets(url, title) : null;
  const menu = root.querySelector("[data-dashboard-share-menu]");
  const button = root.querySelector("[data-dashboard-share-store]");
  const instagramCopy = root.querySelector("[data-dashboard-share-instagram-copy]");
  const links = {
    facebook: root.querySelector("[data-dashboard-share-facebook]"),
    x: root.querySelector("[data-dashboard-share-x]"),
    whatsapp: root.querySelector("[data-dashboard-share-whatsapp]"),
    linkedin: root.querySelector("[data-dashboard-share-linkedin]"),
  };

  Object.entries(links).forEach(([key, link]) => {
    if (!link) return;
    if (targets?.[key]) {
      link.href = targets[key];
      link.hidden = false;
    } else {
      link.removeAttribute("href");
      link.hidden = true;
    }
  });
  if (instagramCopy) instagramCopy.disabled = !url;
  if (button) {
    button.disabled = !url;
    button.onclick = async () => {
      if (!url) return;
      if (navigator.share) {
        try {
          await navigator.share({ title, text: title, url });
          return;
        } catch (error) {
          if (error?.name === "AbortError") return;
        }
      }
      if (!menu) {
        try {
          await copyStoreUrl(button, url);
        } catch {
          setCopyFeedback(button, "Copy failed.", "error");
        }
        return;
      }
      menu.hidden = !menu.hidden;
      button.setAttribute("aria-expanded", menu.hidden ? "false" : "true");
    };
  }
  if (instagramCopy) {
    instagramCopy.onclick = async () => {
      if (!url) return;
      try {
        await copyStoreUrl(instagramCopy, url);
      } catch {
        setCopyFeedback(instagramCopy, "Copy failed.", "error");
      }
    };
  }
}

function activateDashboardTab(root, tabName = "overview") {
  const nextTab = tabName || "overview";
  root.querySelectorAll("[data-dashboard-tab-target]").forEach((trigger) => {
    const active = trigger.dataset.dashboardTabTarget === nextTab;
    trigger.classList.toggle("is-active", active);
    trigger.setAttribute("aria-selected", active ? "true" : "false");
  });
  root.querySelectorAll("[data-dashboard-tab-panel]").forEach((panel) => {
    const active = panel.dataset.dashboardTabPanel === nextTab;
    panel.classList.toggle("is-active", active);
    panel.hidden = !active;
  });
}

function dashboardIsMobile() {
  return (
    typeof window !== "undefined" &&
    window.matchMedia("(max-width: 1100px)").matches
  );
}

function resetDashboardHorizontalScroll() {
  if (!dashboardIsMobile() || !window.scrollX) return;
  document.documentElement.scrollLeft = 0;
  document.body.scrollLeft = 0;
}

function setDashboardMobileNav(root, open) {
  const isOpen = Boolean(open);
  root.classList.toggle("customhouse-dashboard-nav-open", isOpen);
  root.querySelector(".customhouse-dashboard-sidebar")?.setAttribute(
    "aria-hidden",
    String(dashboardIsMobile() ? !isOpen : root.classList.contains("customhouse-dashboard-sidebar-collapsed")),
  );
}

function setDashboardSidebarCollapsed(root, collapsed) {
  const isCollapsed = Boolean(collapsed);
  root.classList.toggle("customhouse-dashboard-sidebar-collapsed", isCollapsed);
  root.querySelector(".customhouse-dashboard-menu")?.setAttribute(
    "aria-expanded",
    String(dashboardIsMobile() ? root.classList.contains("customhouse-dashboard-nav-open") : !isCollapsed),
  );
  root.querySelector(".customhouse-dashboard-sidebar")?.setAttribute(
    "aria-hidden",
    String(dashboardIsMobile() ? !root.classList.contains("customhouse-dashboard-nav-open") : isCollapsed),
  );
}

function bindDashboardMobileNav(root) {
  if (root.__customHouseMobileNavBound) return;
  root.__customHouseMobileNavBound = true;
  const menuButton = root.querySelector(".customhouse-dashboard-menu");
  const sidebar = root.querySelector(".customhouse-dashboard-sidebar");
  if (!menuButton || !sidebar) return;
  menuButton.setAttribute("aria-expanded", dashboardIsMobile() ? "false" : "true");
  menuButton.setAttribute("aria-controls", "customhouse-dashboard-sidebar");
  sidebar.id ||= "customhouse-dashboard-sidebar";

  menuButton.addEventListener("click", () => {
    if (dashboardIsMobile()) {
      setDashboardMobileNav(
        root,
        !root.classList.contains("customhouse-dashboard-nav-open"),
      );
      menuButton.setAttribute(
        "aria-expanded",
        String(root.classList.contains("customhouse-dashboard-nav-open")),
      );
      return;
    }
    setDashboardSidebarCollapsed(
      root,
      !root.classList.contains("customhouse-dashboard-sidebar-collapsed"),
    );
  });
  root.addEventListener("click", (event) => {
    if (
      root.classList.contains("customhouse-dashboard-nav-open") &&
      !event.target.closest(".customhouse-dashboard-sidebar") &&
      !event.target.closest(".customhouse-dashboard-menu")
    ) {
      setDashboardMobileNav(root, false);
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") setDashboardMobileNav(root, false);
  });
  const mobileQuery = window.matchMedia("(max-width: 1100px)");
  if (typeof mobileQuery.addEventListener === "function") {
    mobileQuery.addEventListener("change", () => {
      setDashboardMobileNav(root, false);
      setDashboardSidebarCollapsed(root, false);
    });
  } else if (typeof mobileQuery.addListener === "function") {
    mobileQuery.addListener(() => {
      setDashboardMobileNav(root, false);
      setDashboardSidebarCollapsed(root, false);
    });
  }
  setDashboardMobileNav(root, false);
  setDashboardSidebarCollapsed(root, false);
  resetDashboardHorizontalScroll();
  window.addEventListener("resize", resetDashboardHorizontalScroll);
}

function bindDashboardTabs(root) {
  root.querySelectorAll("[data-dashboard-tab-target]").forEach((trigger) => {
    trigger.addEventListener("click", (event) => {
      const tabName = trigger.dataset.dashboardTabTarget;
      if (!tabName) return;
      event.preventDefault();
      activateDashboardTab(root, tabName);
      setDashboardMobileNav(root, false);
      root.querySelector(".customhouse-dashboard-main")?.scrollIntoView({
        block: "start",
        behavior: "smooth",
      });
    });
  });
  activateDashboardTab(root, "overview");
}

function fallbackEarningsSeries(totalLabel) {
  const today = new Date();
  return [4, 3, 2, 1, 0].map((offset) => {
    const date = new Date(today);
    date.setDate(today.getDate() - offset * 7);
    const label = new Intl.DateTimeFormat("en-GB", {
      day: "2-digit",
      month: "short",
    }).format(date);
    const isLatest = offset === 0;
    const value = isLatest
      ? Number(String(totalLabel || "0").replace(/[^0-9.,-]/g, "").replace(",", ".")) || 0
      : 0;
    return {
      label,
      value,
      valueLabel: isLatest ? String(totalLabel || "0.00") : "0.00",
    };
  });
}

function renderEarningsCharts(root, overview = {}) {
  const source =
    Array.isArray(overview.earningsSeries) && overview.earningsSeries.length
      ? overview.earningsSeries
      : fallbackEarningsSeries(overview.totalEarnings);
  const rawMaxValue = Math.max(
    ...source.map((item) => Number(item.value) || 0),
    1,
  );
  const tickStep = Math.max(1, Math.ceil(rawMaxValue / 4 / 10) * 10);
  const maxValue = Math.max(tickStep * 4, rawMaxValue);
  root.querySelectorAll("[data-dashboard-earnings-chart]").forEach((chart) => {
    chart.replaceChildren();
    const svgNamespace = "http://www.w3.org/2000/svg";
    const compact = typeof window !== "undefined" && window.matchMedia("(max-width: 520px)").matches;
    const width = compact ? Math.max(360, source.length * 70) : Math.max(720, source.length * 104);
    const height = compact ? 230 : 250;
    const padding = compact
      ? { top: 32, right: 34, bottom: 42, left: 42 }
      : { top: 32, right: 42, bottom: 46, left: 48 };
    const plotWidth = width - padding.left - padding.right;
    const plotHeight = height - padding.top - padding.bottom;
    const baseline = padding.top + plotHeight;
    const points = source.map((item, index) => {
      const x =
        source.length === 1
          ? padding.left + plotWidth / 2
          : padding.left + (plotWidth / (source.length - 1)) * index;
      const value = Math.max(Number(item.value) || 0, 0);
      const y = baseline - (value / maxValue) * plotHeight;
      return { ...item, x, y, value };
    });
    const pointPath = points.map((point) => `${point.x},${point.y}`).join(" ");
    const areaPath = `${padding.left},${baseline} ${pointPath} ${
      padding.left + plotWidth
    },${baseline}`;

    const svg = document.createElementNS(svgNamespace, "svg");
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", "Commission earnings line chart");

    const defs = document.createElementNS(svgNamespace, "defs");
    const gradient = document.createElementNS(svgNamespace, "linearGradient");
    gradient.id = `customhouse-earnings-fill-${Math.random()
      .toString(36)
      .slice(2)}`;
    gradient.setAttribute("x1", "0");
    gradient.setAttribute("x2", "0");
    gradient.setAttribute("y1", "0");
    gradient.setAttribute("y2", "1");
    const stopTop = document.createElementNS(svgNamespace, "stop");
    stopTop.setAttribute("offset", "0%");
    stopTop.setAttribute("stop-color", "#6d28f5");
    stopTop.setAttribute("stop-opacity", ".18");
    const stopBottom = document.createElementNS(svgNamespace, "stop");
    stopBottom.setAttribute("offset", "100%");
    stopBottom.setAttribute("stop-color", "#6d28f5");
    stopBottom.setAttribute("stop-opacity", "0");
    gradient.append(stopTop, stopBottom);
    defs.append(gradient);
    svg.append(defs);

    [0, 1, 2, 3, 4].forEach((tick) => {
      const y = padding.top + (plotHeight / 4) * tick;
      const valueLabel = String(maxValue - tickStep * tick);
      const axis = document.createElementNS(svgNamespace, "text");
      axis.setAttribute("x", String(padding.left - 14));
      axis.setAttribute("y", String(y + 4));
      axis.setAttribute("class", "customhouse-earnings-axis");
      axis.textContent = valueLabel;
      svg.append(axis);

      const grid = document.createElementNS(svgNamespace, "line");
      grid.setAttribute("x1", String(padding.left));
      grid.setAttribute("x2", String(padding.left + plotWidth));
      grid.setAttribute("y1", String(y));
      grid.setAttribute("y2", String(y));
      grid.setAttribute("class", "customhouse-earnings-gridline");
      svg.append(grid);
    });

    const area = document.createElementNS(svgNamespace, "polygon");
    area.setAttribute("points", areaPath);
    area.setAttribute("fill", `url(#${gradient.id})`);
    svg.append(area);

    const line = document.createElementNS(svgNamespace, "polyline");
    line.setAttribute("points", pointPath);
    line.setAttribute("class", "customhouse-earnings-line");
    svg.append(line);

    points.forEach((point, index) => {
      if (index > 0 && index < points.length - 1) {
        const guide = document.createElementNS(svgNamespace, "line");
        guide.setAttribute("x1", String(point.x));
        guide.setAttribute("x2", String(point.x));
        guide.setAttribute("y1", String(padding.top));
        guide.setAttribute("y2", String(baseline));
        guide.setAttribute("class", "customhouse-earnings-guide");
        svg.append(guide);
      }

      const dot = document.createElementNS(svgNamespace, "circle");
      dot.setAttribute("cx", String(point.x));
      dot.setAttribute("cy", String(point.y));
      dot.setAttribute("r", "5");
      dot.setAttribute("class", "customhouse-earnings-dot");
      svg.append(dot);

      const isLatestValue = index === points.length - 1 && point.value > 0;
      if (isLatestValue) {
        const value = document.createElementNS(svgNamespace, "text");
        value.setAttribute("x", String(point.x));
        value.setAttribute("y", String(Math.max(18, point.y - 14)));
        value.setAttribute("class", "customhouse-earnings-value");
        value.textContent = point.valueLabel || "0.00";
        svg.append(value);
      }

      const label = document.createElementNS(svgNamespace, "text");
      label.setAttribute("x", String(point.x));
      label.setAttribute("y", String(height - 14));
      label.setAttribute("class", "customhouse-earnings-label");
      label.textContent = point.label || "";
      svg.append(label);
    });

    chart.append(svg);
  });
}

function renderTopProducts(list, empty, products) {
  if (!list || !empty) return;
  list.replaceChildren();
  empty.hidden = products.length > 0;
  products.forEach((product) => {
    const item = document.createElement("li");
    const title = document.createElement("strong");
    const meta = document.createElement("span");
    title.textContent = product.title || "Product";
    meta.textContent = `${product.unitsSold ?? 0} sold`;
    item.append(title, meta);
    list.append(item);
  });
}

function submissionTimestamp(product) {
  const status = String(product.status || "").toUpperCase();
  return (
    (status === "PUBLISHED" && product.publishedAt) ||
    (status === "REJECTED" && product.rejectedAt) ||
    (status === "ARCHIVED" && product.updatedAt) ||
    product.submittedAt ||
    product.updatedAt ||
    product.createdAt ||
    ""
  );
}

// eslint-disable-next-line no-unused-vars
function submissionDateLabel(product) {
  const status = String(product.status || "").toUpperCase();
  const prefix =
    status === "PUBLISHED" ? "Published" :
    status === "REJECTED" ? "Rejected" :
    status === "ARCHIVED" ? "Archived" :
    "Submitted";
  return `${prefix} ${formatDate(submissionTimestamp(product))}`;
}

function recentSubmissionProducts(products, limit = 5) {
  const allowed = new Set(["PENDING", "REJECTED", "PUBLISHED", "ARCHIVED"]);
  return (Array.isArray(products) ? products : [])
    .filter((product) => allowed.has(String(product.status || "").toUpperCase()))
    .sort((a, b) => {
      const aTime = new Date(submissionTimestamp(a) || 0).getTime();
      const bTime = new Date(submissionTimestamp(b) || 0).getTime();
      return bTime - aTime;
    })
    .slice(0, limit);
}

function renderRecentSubmissionsFromProducts(root, products) {
  const list = root?.querySelector("[data-dashboard-submissions]");
  renderSubmissions(list, recentSubmissionProducts(products));
}

function renderSubmissions(list, submissions) {
  if (!list) return;
  list.replaceChildren();
  if (!submissions.length) {
    const item = document.createElement("li");
    item.className = "customhouse-submission-empty";
    const title = document.createElement("strong");
    const copy = document.createElement("span");
    title.textContent = "No submissions yet.";
    copy.textContent = "Designs you submit for review will appear here.";
    item.append(title, copy);
    list.append(item);
    return;
  }

  submissions.forEach((submission) => {
    const item = document.createElement("li");
    item.className = "customhouse-submission-row";
    item.setAttribute("role", "row");

    const product = document.createElement("span");
    product.className = "customhouse-submission-product";
    if (submission.previewUrl?.startsWith("https://")) {
      const image = document.createElement("img");
      image.src = submission.previewUrl;
      image.alt = "";
      image.loading = "lazy";
      product.append(image);
    } else {
      const thumb = document.createElement("i");
      thumb.setAttribute("aria-hidden", "true");
      product.append(thumb);
    }
    const copy = document.createElement("span");
    const title = document.createElement("strong");
    const type = document.createElement("small");
    title.textContent = submission.title || submission.baseProductTitle || "Untitled design";
    type.textContent = submission.baseProductTitle || "Design";
    copy.append(title, type);
    product.append(copy);

    const status = document.createElement("span");
    status.className = `customhouse-status-badge customhouse-status-badge--${String(
      submission.status || "draft",
    ).toLowerCase()}`;
    status.textContent = creatorProductStatusLabel(submission.status);

    const action = document.createElement("span");
    action.className = "customhouse-submission-action";
    const statusValue = String(submission.status || "").toUpperCase();
    if (statusValue === "REJECTED") {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.creatorProductDesign = submission.id;
      button.textContent = "Edit Design";
      action.append(button);
    } else if (statusValue === "PUBLISHED") {
      const link = document.createElement("a");
      link.href =
        submission.publicProductUrl || `/apps/customhouse/design/${encodeURIComponent(submission.id)}`;
      link.textContent = "View Product";
      action.append(link);
    } else {
      action.textContent = statusValue === "ARCHIVED" ? "Archived" : "View status";
    }

    item.append(product, status, action);
    list.append(item);
  });
}

function afterFirstPaint(callback) {
  if (typeof requestAnimationFrame !== "function") {
    setTimeout(callback, 0);
    return;
  }
  requestAnimationFrame(() => {
    if ("requestIdleCallback" in window) {
      window.requestIdleCallback(callback, { timeout: 2500 });
      return;
    }
    setTimeout(callback, 400);
  });
}

function referralTotalLabel(totals, field, fallback = "0.00 kr") {
  if (!Array.isArray(totals) || !totals.length) return fallback;
  return totals
    .map((total) => total?.[field])
    .filter(Boolean)
    .join(" + ") || fallback;
}

function setReferralText(profile, selector, value) {
  profile.querySelectorAll(selector).forEach((node) => {
    node.textContent = String(value ?? "0");
  });
}

function renderReferralCreators(profile, referrals = {}) {
  const list = profile.querySelector("[data-dashboard-referral-creators]");
  const empty = profile.querySelector("[data-dashboard-referral-creators-empty]");
  if (!list) return;
  const creators = Array.isArray(referrals.referredCreators) ? referrals.referredCreators : [];
  list.innerHTML = "";
  if (empty) empty.hidden = creators.length > 0;
  creators.slice(0, 25).forEach((creator) => {
    const item = document.createElement("li");
    item.className = "customhouse-referral-list-item";
    const title = document.createElement("strong");
    title.textContent = creator.displayName || "Unnamed creator";
    const meta = document.createElement("span");
    meta.textContent = `${titleCaseStatus(creator.status)} • ${creator.saleCount || 0} sale${creator.saleCount === 1 ? "" : "s"}`;
    const value = document.createElement("b");
    value.textContent = referralTotalLabel(creator.totals, "final");
    item.append(title, meta, value);
    list.append(item);
  });
}

function renderReferralEarnings(profile, referrals = {}) {
  const list = profile.querySelector("[data-dashboard-referral-earnings]");
  const empty = profile.querySelector("[data-dashboard-referral-earnings-empty]");
  if (!list) return;
  const rows = Array.isArray(referrals.rows) ? referrals.rows : [];
  list.innerHTML = "";
  if (empty) empty.hidden = rows.length > 0;
  rows.slice(0, 25).forEach((row) => {
    const item = document.createElement("li");
    item.className = "customhouse-referral-list-item";
    const title = document.createElement("strong");
    title.textContent = row.referredCreator?.displayName || "Referred creator";
    const meta = document.createElement("span");
    meta.textContent = `${formatDate(row.createdAt)} • ${row.ratePercent || "2%"} of eligible creator earnings`;
    const value = document.createElement("b");
    value.textContent = row.finalEntitlement || "0.00";
    item.append(title, meta, value);
    if (Array.isArray(row.adjustments) && row.adjustments.length) {
      const adjustment = document.createElement("small");
      adjustment.textContent = `Refund adjustments: ${row.adjustmentsTotal}`;
      item.append(adjustment);
    }
    list.append(item);
  });
}

function renderReferralFinancials(profile, referrals = {}) {
  const summary = referrals.summary || {};
  const totals = Array.isArray(summary.totals) ? summary.totals : [];
  const counts = summary.referralStatusCounts || {};
  setReferralText(profile, "[data-dashboard-referral-total-creators]", summary.totalReferrals || 0);
  setReferralText(profile, "[data-dashboard-referral-original]", referralTotalLabel(totals, "original"));
  setReferralText(profile, "[data-dashboard-referral-adjustments]", referralTotalLabel(totals, "adjustments"));
  setReferralText(profile, "[data-dashboard-referral-final]", referralTotalLabel(totals, "final"));
  setReferralText(profile, "[data-dashboard-referral-pending]", counts.PENDING || 0);
  setReferralText(profile, "[data-dashboard-referral-approved]", counts.APPROVED || 0);
  setReferralText(profile, "[data-dashboard-referral-rejected]", counts.REJECTED || 0);
  setReferralText(profile, "[data-dashboard-referral-suspended]", counts.SUSPENDED || 0);
  renderReferralCreators(profile, referrals);
  renderReferralEarnings(profile, referrals);
}

function selectedPayoutBalance(payouts = {}) {
  const currencies = Array.isArray(payouts.balance?.currencies)
    ? payouts.balance.currencies
    : [];
  return currencies[0] || null;
}

function payoutMethodTypeLabel(type) {
  return type === "BANK_TRANSFER" ? "Bank Transfer" : "PayPal";
}

function payoutMethodOptionLabel(method) {
  return `${payoutMethodTypeLabel(method.type)} • ${method.displayLabel || "Saved destination"}`;
}

function payoutMethodStatusMessage(method) {
  const type = payoutMethodTypeLabel(method.type);
  if (method.status === "VERIFIED") return `${type} is active.`;
  if (method.status === "DISABLED") return "Disabled";
  return `${type} is not active yet.`;
}

function payoutMethodIconLabel(type) {
  return type === "BANK_TRANSFER" ? "account_balance" : "payments";
}

function payoutMethodShortLabel(method) {
  return method.displayLabel || "Saved destination";
}

function payoutMethodEditDetails(method) {
  return method?.editDetails && typeof method.editDetails === "object"
    ? method.editDetails
    : {};
}

function setPayoutInputValue(form, name, value) {
  const input = form?.querySelector(`[name="${name}"]`);
  if (!input) return;
  input.value = value || "";
}

function appendPayoutCell(row, label, value, className = "") {
  const cell = document.createElement("td");
  cell.dataset.label = label;
  if (className) cell.className = className;
  if (value instanceof Node) {
    cell.append(value);
  } else {
    cell.textContent = String(value || "");
  }
  row.append(cell);
  return cell;
}

function showDashboardToast(root, message, tone = "success") {
  const target = root.querySelector("[data-dashboard-message]");
  if (!target) return;
  window.clearTimeout(root.__customHouseDashboardToastTimer);
  target.hidden = false;
  target.textContent = message;
  target.dataset.toast = "true";
  target.dataset.tone = tone;
  target.classList.toggle("customhouse-error", tone === "error");
  target.classList.toggle("customhouse-success", tone === "success");
  root.__customHouseDashboardToastTimer = window.setTimeout(() => {
    if (target.dataset.toast === "true" && target.textContent === message) {
      target.hidden = true;
      target.textContent = "";
      target.dataset.toast = "";
      target.dataset.tone = "";
      target.classList.remove("customhouse-error", "customhouse-success");
    }
  }, 4200);
}

function resetPayoutMethodForm(root) {
  const form = root.querySelector("[data-dashboard-payout-method-form]");
  const methodId = root.querySelector("[data-payout-method-id]");
  const methodType = root.querySelector("[data-payout-method-type]");
  const title = root.querySelector("[data-dashboard-payout-method-form-title]");
  const submit = root.querySelector("[data-dashboard-payout-method-submit]");
  const cancel = root.querySelector("[data-dashboard-payout-method-cancel]");
  if (form) form.reset();
  if (methodId) methodId.value = "";
  if (methodType) {
    methodType.value = "PAYPAL";
    methodType.disabled = false;
    methodType.dispatchEvent(new Event("change"));
  }
  if (title) title.textContent = "Add Payout Method";
  if (submit) submit.textContent = "Save Method";
  if (cancel) cancel.hidden = true;
}

function payoutMethodModal(root) {
  return dashboardModalQuery(root, "[data-dashboard-payout-method-modal]");
}

function closePayoutMethodModal(root) {
  const modal = payoutMethodModal(root);
  const form = dashboardModalQuery(root, "[data-dashboard-payout-method-modal-form]");
  const message = dashboardModalQuery(root, "[data-dashboard-payout-method-modal-message]");
  if (form) form.reset();
  if (message) {
    message.hidden = true;
    message.textContent = "";
    message.classList.remove("customhouse-error", "customhouse-success");
  }
  if (modal) modal.hidden = true;
  document.body.classList.remove("customhouse-modal-open");
}

function editPayoutMethod(root, method) {
  const modal = payoutMethodModal(root);
  const form = dashboardModalQuery(root, "[data-dashboard-payout-method-modal-form]");
  const methodId = dashboardModalQuery(root, "[data-payout-method-modal-id]");
  const methodType = dashboardModalQuery(root, "[data-payout-method-modal-type]");
  const title = dashboardModalQuery(root, "[data-dashboard-payout-method-modal-title]");
  const summary = dashboardModalQuery(root, "[data-dashboard-payout-method-modal-summary]");
  const current = dashboardModalQuery(root, "[data-payout-method-modal-current]");
  const currentIcon = dashboardModalQuery(root, "[data-payout-method-modal-current-icon]");
  const paypalField = dashboardModalQuery(root, "[data-payout-modal-paypal-field]");
  const bankFields = dashboardModalQuery(root, "[data-payout-modal-bank-fields]");
  const isDefault = form?.querySelector('input[name="isDefault"]');
  const isBank = method.type === "BANK_TRANSFER";
  const displayLabel = payoutMethodShortLabel(method);
  const editDetails = payoutMethodEditDetails(method);
  form?.reset();
  if (methodId) methodId.value = method.id || "";
  if (methodType) methodType.value = method.type || "PAYPAL";
  if (isDefault) isDefault.checked = Boolean(method.isDefault);
  if (title) title.textContent = `Edit ${payoutMethodTypeLabel(method.type)} Method`;
  if (summary) summary.textContent = "Review the saved details below and update only what needs to change.";
  if (current) current.textContent = displayLabel;
  if (currentIcon) currentIcon.textContent = payoutMethodIconLabel(method.type);
  if (paypalField) paypalField.hidden = isBank;
  if (bankFields) bankFields.hidden = !isBank;
  const paypalEmail = form?.querySelector('input[name="paypalEmail"]');
  const iban = form?.querySelector('input[name="iban"]');
  setPayoutInputValue(form, "accountHolderName", editDetails.accountHolderName);
  if (paypalEmail && !isBank) paypalEmail.placeholder = editDetails.paypalEmail ? "you@example.com" : "Enter PayPal email";
  if (iban && isBank) iban.placeholder = editDetails.iban ? "IBAN" : "Enter IBAN or use local account details";
  if (!isBank) {
    setPayoutInputValue(form, "paypalEmail", editDetails.paypalEmail);
  } else {
    setPayoutInputValue(form, "bankName", editDetails.bankName);
    setPayoutInputValue(form, "country", editDetails.country);
    setPayoutInputValue(form, "iban", editDetails.iban);
    setPayoutInputValue(form, "swiftBic", editDetails.swiftBic);
    setPayoutInputValue(form, "accountNumber", editDetails.accountNumber);
    setPayoutInputValue(form, "routingNumber", editDetails.routingNumber);
  }
  if (modal) {
    modal.hidden = false;
    document.body.classList.add("customhouse-modal-open");
    const firstInput = isBank
      ? bankFields?.querySelector("input")
      : paypalField?.querySelector("input");
    firstInput?.focus();
  }
}

function renderPayoutMethods(profile, payouts = {}) {
  const list = profile.querySelector("[data-dashboard-payout-methods]");
  const empty = profile.querySelector("[data-dashboard-payout-methods-empty]");
  const note = profile.querySelector("[data-dashboard-payout-method-note]");
  const requestNote = profile.querySelector("[data-dashboard-payout-request-note]");
  const select = profile.querySelector("[data-dashboard-payout-method-select]");
  const button = profile.querySelector("[data-dashboard-payout-request-button]");
  const addForm = profile.querySelector("[data-dashboard-payout-method-form]");
  const addFormTitle = profile.querySelector("[data-dashboard-payout-method-form-title]");
  const saveMessage = profile.querySelector("[data-dashboard-payout-method-save-message]");
  const methods = Array.isArray(payouts.methods) ? payouts.methods : [];
  profile.__customHousePayoutMethods = methods;
  const dashboardRoot = profile.closest("[data-customhouse-dashboard]");
  if (dashboardRoot) dashboardRoot.__customHousePayoutMethods = methods;
  const activeMethods = methods.filter((method) => method.status === "VERIFIED");
  const inactiveMethods = methods.filter((method) => method.status !== "VERIFIED");
  const savedTypes = new Set(methods.map((method) => method.type));
  const hasAllMethodTypes = savedTypes.has("PAYPAL") && savedTypes.has("BANK_TRANSFER");
  if (addForm) addForm.hidden = hasAllMethodTypes;
  if (addFormTitle) {
    addFormTitle.hidden = false;
    addFormTitle.textContent = hasAllMethodTypes
      ? "All payout methods saved"
      : "Add Payout Method";
  }
  if (saveMessage && hasAllMethodTypes) {
    saveMessage.hidden = false;
    saveMessage.textContent = "Use the 3-dot button on a saved method to edit its details.";
  } else if (saveMessage && saveMessage.textContent === "Use the 3-dot button on a saved method to edit its details.") {
    saveMessage.hidden = true;
    saveMessage.textContent = "";
  }
  if (list) {
    list.innerHTML = "";
    if (empty) empty.hidden = methods.length > 0;
    methods.forEach((method) => {
      const item = document.createElement("li");
      item.className = "customhouse-payout-method-item";
      item.dataset.payoutMethodId = method.id || "";
      const icon = document.createElement("span");
      icon.className = "material-symbols-outlined notranslate customhouse-payout-method-icon";
      icon.setAttribute("translate", "no");
      icon.setAttribute("aria-hidden", "true");
      icon.textContent = payoutMethodIconLabel(method.type);
      const copy = document.createElement("span");
      copy.className = "customhouse-payout-method-copy";
      const title = document.createElement("strong");
      title.textContent = payoutMethodTypeLabel(method.type);
      const meta = document.createElement("span");
      meta.textContent = payoutMethodShortLabel(method);
      copy.append(title, meta);
      const badges = document.createElement("span");
      badges.className = "customhouse-payout-method-badges";
      if (method.isDefault) {
        const defaultBadge = document.createElement("small");
        defaultBadge.className = "customhouse-payout-badge customhouse-payout-badge-neutral";
        defaultBadge.textContent = "Default";
        badges.append(defaultBadge);
      }
      const value = document.createElement("b");
      value.className = `customhouse-payout-badge ${method.status === "VERIFIED" ? "customhouse-payout-badge-success" : "customhouse-payout-badge-neutral"}`;
      value.textContent = method.status === "VERIFIED" ? "Active" : titleCaseStatus(method.status || "DISABLED");
      badges.append(value);
      item.append(icon, copy, badges);
      if (method.status === "DISABLED") {
        const statusMessage = document.createElement("small");
        statusMessage.className = "customhouse-payout-method-helper";
        statusMessage.textContent = "Disabled methods cannot be used for withdrawals.";
        item.append(statusMessage);
      }
      const actions = document.createElement("div");
      actions.className = "customhouse-payout-method-actions";
      const edit = document.createElement("button");
      edit.type = "button";
      edit.className = "customhouse-payout-method-edit-button";
      edit.setAttribute("aria-label", `Edit ${payoutMethodTypeLabel(method.type)} payout method`);
      edit.innerHTML = '<span class="material-symbols-outlined notranslate" translate="no" aria-hidden="true">more_horiz</span>';
      edit.dataset.payoutMethodEdit = method.id || "";
      actions.append(edit);
      item.append(actions);
      list.append(item);
    });
  }
  if (note) {
    if (activeMethods.length) {
      note.hidden = false;
      note.textContent = "Active payout methods can be selected for withdrawals.";
    } else if (inactiveMethods.length) {
      note.hidden = false;
      note.textContent = inactiveMethods
        .map(payoutMethodStatusMessage)
        .join(" ");
    } else {
      note.hidden = false;
      note.textContent = "Add a payout method before requesting a withdrawal.";
    }
  }
  if (select) {
    select.innerHTML = "";
    if (!activeMethods.length) {
      const option = document.createElement("option");
      option.value = "";
      option.textContent = methods.length ? "No active payout method available" : "Add a payout method first";
      select.append(option);
      select.disabled = true;
    } else {
      select.disabled = false;
      activeMethods
        .sort((left, right) => Number(Boolean(right.isDefault)) - Number(Boolean(left.isDefault)))
        .forEach((method) => {
        const option = document.createElement("option");
        option.value = method.id;
        option.textContent = payoutMethodOptionLabel(method);
        option.selected = Boolean(method.isDefault);
        select.append(option);
      });
    }
  }
  if (requestNote) {
    requestNote.hidden = activeMethods.length > 0;
    requestNote.textContent = methods.length
      ? "No active payout method is available. Edit or add a valid payout method before requesting a withdrawal."
      : "Add a payout method before requesting a withdrawal.";
  }
  if (button) {
    button.dataset.hasVerifiedPayoutMethod = activeMethods.length ? "true" : "false";
  }
}

function renderPayoutBalance(profile, payouts = {}) {
  const balance = selectedPayoutBalance(payouts);
  const values = {
    "[data-dashboard-payout-available]": balance?.available || "0.00 kr",
    "[data-dashboard-payout-reserved]": balance?.reserved || "0.00 kr",
    "[data-dashboard-payout-paid]": balance?.paid || "0.00 kr",
    "[data-dashboard-payout-total-earned]": balance?.totalEarned || "0.00 kr",
    "[data-dashboard-payout-product]": balance?.productEarnings || "0.00 kr",
    "[data-dashboard-payout-referral]": balance?.referralEarnings || "0.00 kr",
    "[data-dashboard-payout-currency]": balance?.currency || "Balance",
  };
  Object.entries(values).forEach(([selector, value]) => {
    profile.querySelectorAll(selector).forEach((node) => {
      node.textContent = String(value);
    });
  });
  const currencySelect = profile.querySelector("[data-dashboard-payout-currency-select]");
  if (currencySelect) {
    const currencies = Array.isArray(payouts.balance?.currencies)
      ? payouts.balance.currencies
      : [];
    const selectedCurrency = balance?.currency || currencies[0]?.currency || "";
    if (currencySelect.tagName === "SELECT") {
      currencySelect.innerHTML = "";
      currencies.forEach((item) => {
        const option = document.createElement("option");
        option.value = item.currency;
        option.textContent = `${item.currency} (${item.available})`;
        currencySelect.append(option);
      });
    } else {
      currencySelect.value = selectedCurrency;
    }
  }
  const requestCurrency = profile.querySelector("[data-dashboard-payout-request-currency]");
  if (requestCurrency) {
    requestCurrency.textContent = balance?.currency
      ? `${balance.currency} available: ${balance.available || "0.00 kr"}`
      : "Available balance";
  }
  const button = profile.querySelector("[data-dashboard-payout-request-button]");
  if (button) {
    button.disabled =
      !balance ||
      !balance.canWithdraw ||
      button.dataset.hasVerifiedPayoutMethod === "false";
  }
}

function renderPayoutHistory(profile, payouts = {}) {
  const tableBody = profile.querySelector("[data-dashboard-payout-history]");
  const empty = profile.querySelector("[data-dashboard-payout-history-empty]");
  if (!tableBody) return;
  const rows = Array.isArray(payouts.payouts) ? payouts.payouts : [];
  tableBody.innerHTML = "";
  if (empty) empty.hidden = rows.length > 0;
  rows.forEach((payout) => {
    const row = document.createElement("tr");
    row.className = "customhouse-payout-history-row";
    const status = document.createElement("span");
    const rawStatus = payout.status || "REQUESTED";
    status.className = `customhouse-payout-badge customhouse-payout-history-status customhouse-payout-status-${String(rawStatus).toLowerCase()}`;
    status.textContent = titleCaseStatus(rawStatus);
    const method = document.createElement("span");
    method.className = "customhouse-payout-history-method";
    const methodIcon = document.createElement("span");
    methodIcon.className = "material-symbols-outlined notranslate customhouse-payout-history-method-icon";
    methodIcon.setAttribute("translate", "no");
    methodIcon.setAttribute("aria-hidden", "true");
    methodIcon.textContent = String(payout.method || "").toLowerCase().includes("bank") ? "account_balance" : "payments";
    const methodText = document.createElement("span");
    methodText.textContent = payout.method || "Payout method";
    method.append(methodIcon, methodText);
    appendPayoutCell(row, "Amount", payout.amount || payout.requestedAmount || "0.00 kr", "customhouse-payout-history-amount");
    appendPayoutCell(row, "Type", status);
    appendPayoutCell(row, "Reference", payout.transactionReference ? `Reference: ${payout.transactionReference}` : "-");
    appendPayoutCell(row, "Method", method);
    appendPayoutCell(row, "Date", formatDate(payout.requestedAt));
    if (payout.rejectionReason) {
      row.title = `Rejected: ${payout.rejectionReason}`;
    }
    tableBody.append(row);
  });
}

function renderPayouts(profile, payouts = {}) {
  renderPayoutMethods(profile, payouts);
  renderPayoutBalance(profile, payouts);
  renderPayoutHistory(profile, payouts);
}

function bindPayoutForms(root, refreshDashboard) {
  if (root.dataset.payoutFormsBound === "true") return;
  root.dataset.payoutFormsBound = "true";
  const methodForm = root.querySelector("[data-dashboard-payout-method-form]");
  const methodModalForm = dashboardModalQuery(root, "[data-dashboard-payout-method-modal-form]");
  const savedMethods = root.querySelector("[data-dashboard-payout-methods]");
  const methodType = root.querySelector("[data-payout-method-type]");
  const paypalField = root.querySelector("[data-payout-paypal-field]");
  const bankFields = root.querySelector("[data-payout-bank-fields]");
  const syncMethodFields = () => {
    const bank = methodType?.value === "BANK_TRANSFER";
    if (paypalField) paypalField.hidden = bank;
    if (bankFields) bankFields.hidden = !bank;
  };
  methodType?.addEventListener("change", syncMethodFields);
  syncMethodFields();
  root.querySelector("[data-dashboard-payout-method-cancel]")?.addEventListener("click", () => {
    resetPayoutMethodForm(root);
  });
  dashboardModalQueryAll(root, "[data-dashboard-payout-method-modal-close]").forEach((button) => {
    button.addEventListener("click", () => closePayoutMethodModal(root));
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !payoutMethodModal(root)?.hidden) {
      closePayoutMethodModal(root);
    }
  });
  savedMethods?.addEventListener("click", (event) => {
    const target = event.target instanceof HTMLElement
      ? event.target.closest("[data-payout-method-edit]")
      : null;
    if (!target) return;
    const profile = root.querySelector("[data-dashboard-profile]");
    const methods = profile?.__customHousePayoutMethods || root.__customHousePayoutMethods || [];
    const method = methods.find((item) => item.id === target.dataset.payoutMethodEdit);
    if (method) {
      editPayoutMethod(root, method);
    } else {
      showDashboardToast(root, "We could not open this payout method. Refresh and try again.", "error");
    }
  });
  methodModalForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const formData = new FormData(methodModalForm);
    const payoutMethodId = String(formData.get("payoutMethodId") || "");
    const details = Object.fromEntries(formData.entries());
    const message = dashboardModalQuery(root, "[data-dashboard-payout-method-modal-message]");
    try {
      if (message) {
        message.hidden = false;
        message.textContent = "Saving changes...";
        message.classList.remove("customhouse-error", "customhouse-success");
      }
      await savePayoutMethod({
        payoutMethodId,
        type: String(formData.get("type") || "PAYPAL"),
        isDefault: formData.get("isDefault") === "on",
        details,
      });
      if (typeof refreshDashboard === "function") {
        await refreshDashboard({ quiet: true });
      }
      closePayoutMethodModal(root);
      showDashboardToast(root, "Payout method updated successfully.", "success");
    } catch (error) {
      if (message) {
        message.hidden = false;
        message.textContent = error instanceof Error ? error.message : "Unable to update payout method.";
        message.classList.add("customhouse-error");
      } else {
        showDashboardToast(
          root,
          error instanceof Error ? error.message : "Unable to update payout method.",
          "error",
        );
      }
    }
  });
  methodForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const formData = new FormData(methodForm);
    const type = String(formData.get("type") || "PAYPAL");
    const payoutMethodId = String(formData.get("payoutMethodId") || "");
    const details = Object.fromEntries(formData.entries());
    const saveMessage = root.querySelector("[data-dashboard-payout-method-save-message]");
    try {
      if (saveMessage) {
        saveMessage.hidden = false;
        saveMessage.textContent = "Saving payout method...";
      }
      await savePayoutMethod({
        payoutMethodId,
        type,
        isDefault: formData.get("isDefault") === "on",
        details,
      });
      resetPayoutMethodForm(root);
      if (typeof refreshDashboard === "function") {
        await refreshDashboard({ quiet: true });
      }
      if (saveMessage) {
        saveMessage.hidden = true;
        saveMessage.textContent = "";
      }
      showDashboardToast(
        root,
        payoutMethodId ? "Payout method updated successfully." : "Payout method saved successfully.",
        "success",
      );
    } catch (error) {
      if (saveMessage) saveMessage.hidden = true;
      showDashboardToast(
        root,
        error instanceof Error ? error.message : "Unable to save payout method.",
        "error",
      );
    }
  });
  const requestForm = root.querySelector("[data-dashboard-payout-request-form]");
  requestForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const formData = new FormData(requestForm);
    try {
      const payoutMethodId = String(formData.get("payoutMethodId") || "");
      if (!payoutMethodId) {
        throw new Error("Add a payout method before requesting a withdrawal.");
      }
      await requestPayout({
        payoutMethodId,
        currency: String(formData.get("currency") || ""),
        amount: String(formData.get("amount") || ""),
        creatorNote: String(formData.get("creatorNote") || ""),
      });
      requestForm.reset();
      if (typeof refreshDashboard === "function") {
        await refreshDashboard({ quiet: true });
      }
      showDashboardToast(root, "Withdrawal request submitted successfully.", "success");
    } catch (error) {
      showDashboardToast(
        root,
        error instanceof Error ? error.message : "Unable to request withdrawal.",
        "error",
      );
    }
  });
}

function renderDashboard(root, view, refreshDashboard) {
  const loading = root.querySelector("[data-dashboard-loading]");
  if (view.state === "LOADING_COMPLETE") {
    if (loading) loading.hidden = true;
    return;
  }
  root.dataset.dashboardState = view.state.toLowerCase();
  if (loading) loading.hidden = !view.loading;
  const message = root.querySelector("[data-dashboard-message]");
  if (message) {
    if (message.dataset.toast === "true" && view.state === "APPROVED") {
      message.hidden = false;
    } else {
      const showStatusMessage = !["LOADING", "APPROVED"].includes(view.state);
      message.hidden = !showStatusMessage;
      message.textContent = showStatusMessage ? view.message : "";
      message.dataset.toast = "";
      message.dataset.tone = "";
      message.classList.toggle("customhouse-error", view.state === "API_ERROR");
      message.classList.remove("customhouse-success");
    }
  }
  const login = root.querySelector("[data-dashboard-login]");
  const apply = root.querySelector("[data-dashboard-apply]");
  if (login) login.hidden = view.state !== "LOGGED_OUT";
  if (apply) {
    apply.hidden = ![
      "NOT_APPLIED",
      "APPLICATION_NOT_SUBMITTED",
      "CREATOR_RECORD_MISSING",
      "REJECTED",
    ].includes(view.state);
  }

  const profile = root.querySelector("[data-dashboard-profile]");
  if (!profile) return;
  profile.hidden = view.state !== "APPROVED";
  if (view.state !== "APPROVED") return;
  const displayName =
    view.data.displayName ||
    view.data.legalName ||
    [root.dataset.shopifyFirstName, root.dataset.shopifyLastName].filter(Boolean).join(" ") ||
    "Creator";
  const profileImageUrl = view.data.profileImageUrl;
  const heading = root.querySelector("[data-dashboard-heading]");
  if (heading) {
    heading.textContent = displayName;
    heading.setAttribute("aria-label", `${displayName} creator dashboard overview`);
  }
  root.querySelectorAll("[data-dashboard-top-name]").forEach((item) => {
    item.textContent = displayName;
  });
  root.querySelectorAll("[data-dashboard-top-initials]").forEach((item) => {
    item.textContent = initials(displayName);
  });
  const name = profile.querySelector("[data-dashboard-name]");
  if (name) name.textContent = displayName;
  const heroStatus = root.querySelector("[data-dashboard-hero-status]");
  if (heroStatus) {
    heroStatus.textContent =
      view.data.status === "APPROVED"
        ? "Approved Creator"
        : titleCaseStatus(view.data.status || "APPROVED");
    heroStatus.hidden = false;
  }
  const fallback = profile.querySelector("[data-dashboard-avatar-fallback]");
  if (fallback) fallback.textContent = initials(displayName);
  const accountFallback = profile.querySelector("[data-dashboard-account-avatar-fallback]");
  if (accountFallback) accountFallback.textContent = initials(displayName);
  const overview = view.data.overview || {};
  profile.querySelectorAll("[data-dashboard-total-sales]").forEach((totalSales) => {
    totalSales.textContent =
      overview.totalSales == null ? "Not configured" : String(overview.totalSales);
  });
  profile.querySelectorAll("[data-dashboard-total-earnings]").forEach((totalEarnings) => {
    totalEarnings.textContent =
      overview.totalEarnings == null
        ? "Not configured"
        : String(overview.totalEarnings);
  });
  profile.querySelectorAll("[data-dashboard-product-earnings]").forEach((productEarnings) => {
    productEarnings.textContent =
      overview.productEarnings == null
        ? "0.00 kr"
        : String(overview.productEarnings);
  });
  profile.querySelectorAll("[data-dashboard-referral-earnings-total]").forEach((referralEarnings) => {
    referralEarnings.textContent =
      overview.referralEarnings == null
        ? "0.00 kr"
        : String(overview.referralEarnings);
  });
  profile.querySelectorAll("[data-dashboard-commission-rate]").forEach((commissionRate) => {
    commissionRate.textContent =
      overview.commissionRatePercent == null
        ? "Not configured"
        : `${overview.commissionRatePercent}%`;
  });
  profile.querySelectorAll("[data-dashboard-orders]").forEach((orders) => {
    orders.textContent =
      overview.ordersCount == null ? "Not configured" : String(overview.ordersCount);
  });
  renderEarningsCharts(root, overview);
  profile.querySelectorAll("[data-dashboard-items-sold]").forEach((itemsSold) => {
    itemsSold.textContent = String(overview.itemsSoldCount ?? 0);
  });
  const collections = profile.querySelector("[data-dashboard-collections]");
  const products = profile.querySelector("[data-dashboard-products]");
  if (collections) collections.textContent = String(overview.collectionsCount ?? 0);
  if (products) products.textContent = String(overview.publishedProductsCount ?? 0);
  if (root.dataset.relatedDashboardLoaded !== "true") {
    root.dataset.relatedDashboardLoaded = "true";
    afterFirstPaint(() => refreshCreatorProducts(profile));
    afterFirstPaint(() => refreshCreatorBaseProducts(root));
  }
  const bio = profile.querySelector("[data-dashboard-bio]");
  const bioText = view.data.bio || "";
  if (bio) {
    bio.textContent = bioText;
    bio.hidden = !bioText;
  }
  const image = profile.querySelector("[data-dashboard-image]");
  if (!showProfileImage(image, profileImageUrl, `${displayName} profile`)) {
    image.hidden = true;
  }
  const accountImage = profile.querySelector("[data-dashboard-account-image]");
  if (!showProfileImage(accountImage, profileImageUrl, `${displayName} profile`)) {
    accountImage.hidden = true;
  }
  const publicLink = profile.querySelector("[data-dashboard-public-link]");
  const storeCopyUrl = view.data.collectionUrl
    ? new URL(view.data.collectionUrl, window.location.origin).href
    : "";
  if (publicLink) {
    publicLink.textContent = storeCopyUrl
      ? storeCopyUrl.replace(/^https?:\/\//, "")
      : `customhouse.se/${view.data.handle || ""}`;
    publicLink.href = view.data.collectionUrl || "/";
    publicLink.hidden = !view.data.handle && !view.data.collectionUrl;
  }
  const viewStore = profile.querySelector("[data-dashboard-view-store]");
  if (viewStore) {
    viewStore.hidden = !view.data.collectionUrl;
    if (view.data.collectionUrl) viewStore.href = view.data.collectionUrl;
  }
  bindStoreCopy(root, storeCopyUrl, profile.querySelector("[data-dashboard-copy-store-message]"));
  bindStoreShare(root, storeCopyUrl, `${displayName}'s Custom House collection`);
  const socialLink = profile.querySelector("[data-dashboard-social-link]");
  const portfolioUrl =
    firstProfileLink(view.data.socialLinksJson) ||
    view.data.portfolioUrl ||
    "";
  if (socialLink) {
    socialLink.textContent = portfolioUrl;
    socialLink.href = portfolioUrl || "#";
    socialLink.hidden = !portfolioUrl?.startsWith("https://");
  }
  const collection = profile.querySelector("[data-dashboard-collection]");
  if (collection) {
    collection.hidden = !view.data.collectionUrl;
    if (view.data.collectionUrl) collection.href = view.data.collectionUrl;
  }
  renderAccountDetails(
    profile,
    root,
    view.data,
    displayName,
    portfolioUrl,
    storeCopyUrl || view.data.collectionUrl || "",
  );
  hydrateCollectionBannerManager(root, view.data);
  const newProduct = profile.querySelector("[data-dashboard-new-product]");
  const manageCollection = profile.querySelector("[data-dashboard-manage-collection]");
  const viewSubmissions = profile.querySelector("[data-dashboard-view-submissions]");
  const viewProducts = profile.querySelector("[data-dashboard-view-products]");
  [newProduct, manageCollection, viewSubmissions, viewProducts].forEach((link) => {
    if (link && view.data.collectionUrl && "href" in link) link.href = view.data.collectionUrl;
  });
  const referral = referralFor(view.data.referralCode || view.data.handle);
  profile.querySelectorAll("[data-dashboard-referral-link]").forEach((referralInput) => {
    referralInput.value = referral.url;
  });
  profile.querySelectorAll("[data-dashboard-referral-code]").forEach((referralCode) => {
    referralCode.textContent = referral.code;
  });
  renderReferralFinancials(profile, view.data.referrals || {});
  renderPayouts(profile, view.data.payouts || {});
  bindPayoutForms(root, refreshDashboard);
  bindReferralCopy(root, referral.url, root.querySelector("[data-dashboard-message]"));
  const topProducts = Array.isArray(view.data.topSellingProducts)
    ? view.data.topSellingProducts
    : [];
  const topProductsList = profile.querySelector("[data-dashboard-top-products]");
  const topProductsEmpty = profile.querySelector(
    "[data-dashboard-top-products-empty]",
  );
  renderTopProducts(topProductsList, topProductsEmpty, topProducts);
  renderRecentSubmissionsFromProducts(root, dashboardState(root).creatorProducts || []);
}

async function refreshUploadedProfileImage(root, avatar, message) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    try {
      const dashboard = await requestDashboard();
      const imageUrl = dashboard?.profileImageUrl;
      if (showProfileImage(avatar, imageUrl, "Creator profile picture")) {
        message.textContent = "Profile picture uploaded successfully.";
        return;
      }
    } catch {
      break;
    }
  }
  message.textContent =
    "Profile picture uploaded. It may take a moment to finish processing in Shopify.";
}

function enableDashboardStatCards(root) {
  root.querySelectorAll(".customhouse-dashboard-stat").forEach((card) => {
    card.addEventListener("click", (event) => {
      if (
        event.target.closest(
          "summary,a,button,input,select,textarea,label",
        )
      ) {
        return;
      }
      card.open = !card.open;
    });
  });
}

function bindAccountMobileSections(root) {
  root.querySelectorAll("[data-dashboard-account-toggle]").forEach((button) => {
    const header = button.closest(".customhouse-account-section-heading");
    const section = button.closest(
      ".customhouse-account-details, .customhouse-profile-actions",
    );
    if (!header || !section) return;

    const toggleSection = () => {
      if (!window.matchMedia("(max-width: 600px)").matches) return;
      const expanded = !section.classList.contains("is-mobile-open");
      section.classList.toggle("is-mobile-open", expanded);
      button.setAttribute("aria-expanded", String(expanded));
      const icon = button.querySelector(".material-symbols-outlined");
      if (icon) icon.textContent = expanded ? "expand_more" : "chevron_right";
    };

    header.addEventListener("click", toggleSection);
  });
}

if (typeof document !== "undefined") {
  document.querySelectorAll("[data-customhouse-dashboard]").forEach((root) => {
    if (root.dataset.customhouseInitialized === "true") return;
    root.dataset.customhouseInitialized = "true";
    portalDashboardModals(root);
    enableDashboardStatCards(root);
    bindAccountMobileSections(root);
    bindDashboardMobileNav(root);
    bindDashboardTabs(root);
    let latestDashboardData = {};
    const emitDashboard = (view) => {
      try {
        if (view?.data) latestDashboardData = view.data;
        renderDashboard(root, view, refreshDashboard);
      } catch {
        const loading = root.querySelector("[data-dashboard-loading]");
        const message = root.querySelector("[data-dashboard-message]");
        if (loading) loading.hidden = true;
        if (message) {
          message.hidden = false;
          message.textContent =
            "We couldn't display your creator dashboard. Please refresh the page.";
          message.classList.add("customhouse-error");
        }
      }
    };
    const refreshDashboard = (options = {}) =>
      loadDashboardState(
        () => requestDashboard({ sync: Boolean(options.sync) }),
        emitDashboard,
        { quiet: Boolean(options.quiet) },
      );
    bindProfileUpdateModal(root, refreshDashboard, () => latestDashboardData);
    bindCreatorAccountDeactivation(root, refreshDashboard);
    bindCreatorNotifications(root);
    bindCollectionBannerManager(root, refreshDashboard, () => latestDashboardData);
    bindPitchPrintManager(root);
    bindCreatorDesignActions(root);
    bindCreatorProductSubmission(root);
    bindDesignReviewModal(root);
    bindMyDesignsUx(root);
    void claimPendingReferralCookie();
    void refreshDashboard();
    const form = root.querySelector("[data-dashboard-image-form]");
    const message = root.querySelector("[data-dashboard-image-message]");
    const input = form?.querySelector("[data-dashboard-image-input]");
    const avatar = root.querySelector("[data-dashboard-image]");
    input?.addEventListener("change", () => {
      const file = input.files?.[0];
      if (!file) return;
      avatar.src = URL.createObjectURL(file);
      avatar.alt = "Selected profile picture";
      avatar.hidden = false;
      message.textContent = "Image selected. Click upload to save it.";
    });
    form?.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (!input?.files?.length) {
        message.textContent = "Choose an image first.";
        return;
      }
      message.textContent = "Uploading...";
      try {
        const uploaded = await uploadProfileImage(form);
        if (
          showProfileImage(
            avatar,
            uploaded?.profileImageUrl,
            "Creator profile picture",
          )
        ) {
          message.textContent =
            "Profile picture uploaded successfully.";
        } else {
          await refreshUploadedProfileImage(root, avatar, message);
        }
      } catch {
        message.textContent =
          "Profile picture could not be uploaded. Use a JPG, PNG, or WebP under 5 MB.";
      }
    });
    root.querySelectorAll("[data-dashboard-remove-image], [data-profile-modal-remove-photo]").forEach((button) => {
      button.addEventListener("click", async () => {
        const modalMessage = dashboardModalQuery(root, "[data-dashboard-profile-modal-message]");
        const targetMessage = button.matches("[data-profile-modal-remove-photo]")
          ? modalMessage
          : message;
        try {
          await removeProfilePhoto(root, targetMessage);
          if (typeof refreshDashboard === "function") {
            await refreshDashboard({ quiet: true });
          }
        } catch {
          if (targetMessage) {
            targetMessage.hidden = false;
            targetMessage.textContent = "Profile photo could not be removed. Please try again.";
          }
        }
      });
    });
  });
}
