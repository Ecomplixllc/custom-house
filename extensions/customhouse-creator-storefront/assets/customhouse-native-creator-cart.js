(() => {
  const PREPARE_ENDPOINT = "/apps/customhouse/api/native-creator-product-cart";

  function messageFor(form, text, isError = false) {
    const message = form.querySelector("[data-customhouse-native-cart-message]");
    if (!message) return;
    message.hidden = !text;
    message.textContent = text || "";
    message.dataset.tone = isError ? "critical" : "neutral";
  }

  async function jsonResponse(response) {
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.toLowerCase().includes("application/json")) {
      throw new Error("The Creator cart service returned an invalid response.");
    }
    const body = await response.json();
    if (!response.ok || !body?.ok) {
      throw new Error(body?.error?.message || "This Creator Product could not be added to cart.");
    }
    return body;
  }

  async function prepareCreatorCart(form) {
    const values = new FormData(form);
    const response = await fetch(PREPARE_ENDPOINT, {
      method: "POST",
      credentials: "same-origin",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        shopifyProductId: form.dataset.productId,
        selectedVariantId: values.get("id"),
        quantity: values.get("quantity"),
        nonReturnAcknowledged: values.get("nonReturnAcknowledged") === "true",
        termsAccepted: values.get("termsAccepted") === "true",
      }),
    });
    const body = await jsonResponse(response);
    return body.data?.cart;
  }

  async function addPreparedLines(cart) {
    if (!Array.isArray(cart?.items) || !cart.items.length) {
      throw new Error("The Creator cart service did not return purchasable lines.");
    }
    const response = await fetch("/cart/add.js", {
      method: "POST",
      credentials: "same-origin",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ items: cart.items }),
    });
    if (!response.ok) {
      let message = "The prepared Creator Product could not be added to cart.";
      try {
        const body = await response.json();
        message = body?.description || body?.message || message;
      } catch {
        // Keep the safe storefront message when Shopify does not return JSON.
      }
      throw new Error(message);
    }
  }

  function bind(form) {
    if (form.dataset.customhouseNativeCartBound === "true") return;
    form.dataset.customhouseNativeCartBound = "true";
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (!form.reportValidity()) return;
      const button = form.querySelector('button[type="submit"]');
      const originalLabel = button?.textContent || "Add to cart";
      if (button) {
        button.disabled = true;
        button.textContent = "Preparing cart…";
      }
      messageFor(form, "Preparing your Creator Product…");
      try {
        const cart = await prepareCreatorCart(form);
        await addPreparedLines(cart);
        messageFor(form, "Added to cart.");
        window.location.assign("/cart");
      } catch (error) {
        messageFor(
          form,
          error instanceof Error
            ? error.message
            : "This Creator Product could not be added to cart.",
          true,
        );
        if (button) {
          button.disabled = false;
          button.textContent = originalLabel;
        }
      }
    });
  }

  function initialize() {
    document
      .querySelectorAll("[data-customhouse-native-creator-cart]")
      .forEach(bind);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initialize, { once: true });
  } else {
    initialize();
  }
})();
