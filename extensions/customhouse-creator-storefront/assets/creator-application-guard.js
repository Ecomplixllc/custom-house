const CREATOR_STATES = new Set([
  "PENDING",
  "APPROVED",
  "REJECTED",
  "SUSPENDED",
  "SYNC_CONFLICT",
]);

export function shouldRedirectToCreatorDashboard(data) {
  return Boolean(data && CREATOR_STATES.has(data.state));
}

async function resolveApplicationGuard(root) {
  const content = document.querySelector("main, #MainContent");
  try {
    const response = await fetch(root.dataset.statusEndpoint, {
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    });
    if (!response.headers.get("content-type")?.toLowerCase().includes("application/json")) {
      throw new Error("APPLICATION_NON_JSON_RESPONSE");
    }
    const body = await response.json();
    if (
      response.ok &&
      body?.ok &&
      shouldRedirectToCreatorDashboard(body.data)
    ) {
      window.location.replace(root.dataset.dashboardUrl);
      return;
    }
  } catch {
    // A signed-in customer must not be locked out of the application form
    // because the dashboard status endpoint is temporarily unavailable.
  }
  if (content) content.style.visibility = "visible";
}

if (typeof document !== "undefined") {
  document
    .querySelectorAll("[data-creator-application-guard]")
    .forEach((root) => void resolveApplicationGuard(root));
}
