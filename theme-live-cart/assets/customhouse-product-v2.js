(() => {
    const initProduct = (section) => {
      if (!section || section.dataset.productReady === "true") return;
      section.dataset.productReady = "true";

      const productDataElement = section.querySelector("[data-product-json]");
      const product = productDataElement ? JSON.parse(productDataElement.textContent) : null;
      const variantDataElement = section.querySelector("[data-variant-json]");
      const variants = variantDataElement ? JSON.parse(variantDataElement.textContent) : (product ? product.variants : []);
      const form = section.querySelector(".customhouse-product-v2__form");
      const variantInput = section.querySelector("[data-variant-id]");
      const addButton = section.querySelector("[data-add-to-cart]");
      const addText = section.querySelector("[data-add-to-cart-text]");
      const stickyAddButton = section.querySelector("[data-sticky-add-to-cart]");
      const stickyAddText = section.querySelector("[data-sticky-add-to-cart-text]");
      const price = section.querySelector("[data-product-price]");
      const comparePrice = section.querySelector("[data-compare-price]");
      const savingBadge = section.querySelector("[data-saving-badge]");
      const message = section.querySelector("[data-product-message]");
      const addLabel = section.dataset.addToCartLabel || "Add to Cart";
      const soldOutLabel = section.dataset.soldOutLabel || "Sold Out";
      const unavailableLabel = section.dataset.unavailableLabel || "Unavailable";

      const mediaButtons = Array.from(section.querySelectorAll("[data-media-target]"));
      const mediaItems = Array.from(section.querySelectorAll("[data-media-id]"));

      const activateMedia = (target) => {
        if (!target) return;
        const targetId = String(target);
        const hasMedia = mediaItems.some((item) => item.dataset.mediaId === targetId);
        if (!hasMedia) return;
        mediaButtons.forEach((button) => {
          button.setAttribute("aria-current", button.dataset.mediaTarget === targetId ? "true" : "false");
        });
        mediaItems.forEach((item) => {
          item.classList.toggle("is-active", item.dataset.mediaId === targetId);
        });
      };

      const selectedOptions = () => Array.from(section.querySelectorAll("[data-option-index]")).map((fieldset) => {
        const checked = fieldset.querySelector("[data-option-input]:checked");
        return checked ? checked.value : "";
      });

      const findVariant = () => {
        if (!variants || !variants.length) return null;
        const options = selectedOptions();
        if (!options.length) {
          return variants.find((variant) => variantInput && String(variant.id) === String(variantInput.value)) || variants[0] || null;
        }
        return variants.find((variant) => variant.options.every((option, index) => option === options[index]));
      };

      const setButtonState = (variant) => {
        const isAvailable = Boolean(variant && variant.available);
        const label = variant ? (isAvailable ? addLabel : soldOutLabel) : unavailableLabel;
        [addButton, stickyAddButton].forEach((button) => {
          if (button) button.disabled = !isAvailable;
        });
        [addText, stickyAddText].forEach((target) => {
          if (target) target.textContent = label;
        });
        if (message) message.textContent = variant ? "" : unavailableLabel;
      };

      const syncVariant = () => {
        const variant = findVariant();
        if (variantInput && variant) variantInput.value = variant.id;
        if (price && variant) price.textContent = variant.price || "";
        if (comparePrice && variant) {
          const hasCompare = Boolean(variant.compareAtPrice);
          comparePrice.hidden = !hasCompare;
          comparePrice.textContent = hasCompare ? variant.compareAtPrice : "";
        }
        if (savingBadge && variant) {
          const hasSaving = Boolean(variant.saving);
          savingBadge.hidden = !hasSaving;
          savingBadge.textContent = hasSaving ? variant.saving : "";
        }
        if (variant && variant.featuredMediaId) activateMedia(variant.featuredMediaId);
        section.querySelectorAll("[data-option-index]").forEach((fieldset) => {
          const selected = fieldset.querySelector("[data-option-input]:checked");
          const label = fieldset.querySelector("[data-selected-option]");
          if (selected && label) label.textContent = selected.value;
        });
        setButtonState(variant);
      };

      section.querySelectorAll("[data-option-input]").forEach((input) => {
        input.addEventListener("change", syncVariant);
      });

      section.querySelectorAll("[data-quantity-minus], [data-quantity-plus]").forEach((button) => {
        button.addEventListener("click", () => {
          const input = section.querySelector("[data-quantity-input]");
          if (!input) return;
          const current = Math.max(1, parseInt(input.value || "1", 10));
          const next = button.hasAttribute("data-quantity-plus") ? current + 1 : Math.max(1, current - 1);
          input.value = next;
          input.dispatchEvent(new Event("change", { bubbles: true }));
        });
      });

      mediaButtons.forEach((button) => {
        button.addEventListener("click", () => {
          activateMedia(button.dataset.mediaTarget);
        });
      });

      if (mediaItems.length && !mediaItems.some((item) => item.classList.contains("is-active"))) {
        activateMedia(mediaItems[0].dataset.mediaId);
      }

      section.querySelectorAll("[data-customhouse-customizer-trigger]").forEach((trigger) => {
        trigger.addEventListener("click", (event) => {
          if (trigger.tagName === "A" && trigger.getAttribute("href")) return;
          const hook = trigger.dataset.customhouseCustomizerHook || "customhouse-customizer";
          document.dispatchEvent(new CustomEvent("customhouse:customizer:open", {
            detail: {
              hook,
              productId: section.dataset.productId,
              variantId: variantInput ? variantInput.value : null,
              formId: form ? form.id : null
            }
          }));
        });
      });

      syncVariant();
    };

    const initAccordion = (section) => {
      if (!section || section.dataset.accordionReady === "true") return;
      section.dataset.accordionReady = "true";
      const items = Array.from(section.querySelectorAll("[data-accordion-item]"));

      const close = (item) => {
        const button = item.querySelector(".customhouse-product-v2__accordion-button");
        const panel = item.querySelector(".customhouse-product-v2__accordion-panel");
        item.classList.remove("is-active");
        if (button) button.setAttribute("aria-expanded", "false");
        if (panel) panel.style.height = "0px";
      };

      const open = (item) => {
        items.forEach((candidate) => {
          if (candidate !== item) close(candidate);
        });
        const button = item.querySelector(".customhouse-product-v2__accordion-button");
        const panel = item.querySelector(".customhouse-product-v2__accordion-panel");
        item.classList.add("is-active");
        if (button) button.setAttribute("aria-expanded", "true");
        if (panel) panel.style.height = `${panel.scrollHeight}px`;
      };

      items.forEach((item) => {
        const button = item.querySelector(".customhouse-product-v2__accordion-button");
        if (!button) return;
        button.addEventListener("click", () => {
          const isOpen = item.classList.contains("is-active");
          items.forEach(close);
          if (!isOpen) open(item);
        });
      });

      const active = items.find((item) => item.classList.contains("is-active")) || items[0];
      if (active) open(active);
      window.addEventListener("resize", () => {
        const openItem = items.find((item) => item.classList.contains("is-active"));
        const panel = openItem && openItem.querySelector(".customhouse-product-v2__accordion-panel");
        if (panel) panel.style.height = `${panel.scrollHeight}px`;
      });
    };

    const initRecommendations = (section) => {
      const recommendationSection = section.querySelector("[data-recommendations-section]");
      if (!recommendationSection || recommendationSection.dataset.recommendationsReady === "true") return;
      recommendationSection.dataset.recommendationsReady = "true";
      const empty = recommendationSection.querySelector(".customhouse-product-v2__recommendations-empty");
      if (!empty || !window.fetch) return;
      const sectionId = section.dataset.sectionId;
      const productId = section.dataset.productId;
      const url = `${window.Shopify && window.Shopify.routes ? window.Shopify.routes.root : "/"}recommendations/products?section_id=${sectionId}&product_id=${productId}&limit=4`;
      fetch(url)
        .then((response) => response.text())
        .then((html) => {
          const doc = new DOMParser().parseFromString(html, "text/html");
          const fresh = doc.querySelector(`#${CSS.escape(section.id)} [data-recommendations-inner]`);
          const current = recommendationSection.querySelector("[data-recommendations-inner]");
          if (fresh && current && fresh.querySelector(".customhouse-product-v2__product-card")) {
            current.innerHTML = fresh.innerHTML;
          }
        })
        .catch(() => {});
    };

    const boot = (root = document) => {
      root.querySelectorAll("[data-customhouse-product-v2]").forEach((section) => {
        initProduct(section);
        initAccordion(section);
        initRecommendations(section);
      });
    };

    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", () => boot());
    } else {
      boot();
    }

    document.addEventListener("shopify:section:load", (event) => boot(event.target));
  })();
