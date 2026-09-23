(() => {
  const api = (path, options = {}) => fetch(`/apps/customhouse/api/${path}`, {
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    ...options,
  }).then(async (response) => {
    const body = await response.json();
    if (!response.ok || !body.ok) throw new Error(body.error?.message || "Request failed");
    return body.data;
  });

  const message = (element, text, error = false) => {
    if (!element) return;
    element.hidden = false;
    element.textContent = text;
    element.classList.toggle("customhouse-error", error);
  };

  document.querySelectorAll("[data-customhouse-submission]").forEach(async (element) => {
    const status = element.querySelector("[data-status]");
    try {
      const me = await api("me");
      if (!me.creator || me.creator.status !== "APPROVED") { message(status, "Only approved creators can submit designs."); return; }
      element.querySelector("form").hidden = false;
    } catch (error) {
      message(status, error instanceof Error ? error.message : "Request failed", true);
    }
    element.querySelector("form")?.addEventListener("submit", async (event) => {
      event.preventDefault();
      const data = Object.fromEntries(new FormData(event.currentTarget));
      data.baseProductId = element.dataset.productGid;
      try {
        await api("design-submissions", { method: "POST", body: JSON.stringify(data) });
        message(status, "Design submitted for review.");
        event.currentTarget.reset();
      } catch (error) {
        message(status, error instanceof Error ? error.message : "Request failed", true);
      }
    });
  });

  const customizeText = /\b(customize|customise|open pitchprint|edit artwork|edit design|upload artwork|design now)\b/i;
  const customizeSelector = [
    "[data-pitchprint-customize-trigger]",
    "[data-customhouse-pitchprint-trigger]",
    "[data-customize]",
    "[data-customizer]",
    "[data-designlab]",
    "[href*='pitchprint']",
    "[src*='pitchprint']",
    ".pitchprint",
    ".pitchprint-button",
    ".pp-button",
    ".inkybay",
    ".inkybay-button",
  ].join(",");

  function configuredSelectors(element) {
    try {
      const parsed = JSON.parse(element.dataset.selectors || "[]");
      return Array.isArray(parsed) ? parsed.filter((item) => typeof item === "string") : [];
    } catch {
      return [];
    }
  }

  function suppressNode(node) {
    if (!(node instanceof Element)) return;
    if (node.matches("[data-add-to-cart-button], [name='add'], form[action*='/cart/add'] button")) return;
    node.setAttribute("data-customhouse-creator-locked-hidden", "true");
    node.setAttribute("aria-hidden", "true");
    if (node instanceof HTMLButtonElement || node instanceof HTMLAnchorElement) {
      node.tabIndex = -1;
    }
  }

  function suppressCustomizeControls(root, selectors) {
    selectors.forEach((selector) => {
      try {
        document.querySelectorAll(selector).forEach(suppressNode);
      } catch {
        // Ignore invalid merchant selectors.
      }
    });
    document.querySelectorAll(customizeSelector).forEach(suppressNode);
    root.querySelectorAll("a, button, input[type='button'], input[type='submit']").forEach((node) => {
      const label = [
        node.textContent,
        node.getAttribute("aria-label"),
        node.getAttribute("value"),
        node.getAttribute("title"),
      ].filter(Boolean).join(" ");
      if (customizeText.test(label)) suppressNode(node);
    });
  }

  document.querySelectorAll("[data-customhouse-buy-only][data-customhouse-product-mode='creator-locked']").forEach((element) => {
    document.body.classList.add("customhouse-buy-only");
    const selectors = configuredSelectors(element);
    const run = () => suppressCustomizeControls(document.body, selectors);
    run();
    const observer = new MutationObserver(run);
    observer.observe(document.body, { childList: true, subtree: true });
    setTimeout(() => {
      run();
      observer.disconnect();
    }, 6000);
  });
})();
