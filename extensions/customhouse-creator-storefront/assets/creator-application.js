const STEPS = ["Profile", "Creator Presence", "Review"];

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function icon(name) {
  return `<span class="material-symbols-outlined notranslate" translate="no" aria-hidden="true">${name}</span>`;
}

function renderHeader(root, state = {}, step = 0) {
  const header = root.querySelector("[data-application-header]");
  if (!header) return;
  const rejected = state.state === "REJECTED";
  header.innerHTML = `
    <h1>${rejected ? "Update Your " : "Become a "}<span>Creator</span>${rejected ? " Application" : ""}</h1>
    <p>${rejected ? "Your application was reviewed and needs a few changes before we can approve it." : "Share your creativity with the world. Build your collection. Earn with every sale."}</p>
    <div class="ch-application__rail" aria-label="Application progress">
      ${STEPS.map((label, index) => `
        <button type="button" class="${index === step ? "is-active" : index < step ? "is-complete" : ""}" data-step-jump="${index}">
          <span>${index + 1}</span>
          <small>${escapeHtml(label)}</small>
        </button>
      `).join("")}
    </div>
  `;
}

function hideLegacyPageContent(root) {
  const pageContainers = Array.from(document.querySelectorAll("main, #MainContent"));
  pageContainers.forEach((container) => {
    if (container.contains(root)) {
      Array.from(container.children).forEach((child) => {
        if (child === root || child.contains(root)) return;
        child.hidden = true;
        child.setAttribute("data-customhouse-hidden-legacy-content", "true");
      });
      return;
    }
    container.hidden = true;
    container.setAttribute("data-customhouse-hidden-legacy-content", "true");
  });
}

function renderSidebar(root, state = {}) {
  const side = root.querySelector("[data-application-side]");
  if (!side) return;
  if (state.state === "REJECTED") {
    const application = state.application || {};
    const feedback = application.rejectionReason || "Please update the highlighted details and resubmit your application.";
    side.innerHTML = `
      <section class="ch-application__side-card">
        <h2>Application Status</h2>
        <span class="ch-application__status-pill">${icon("pending")} Needs Changes</span>
        <p>We've reviewed your application and need a few updates.</p>
      </section>
      <section class="ch-application__side-card">
        <div class="ch-application__side-title">
          <h2>Review Feedback</h2>
          <span>1</span>
        </div>
        <p>Please address the following point:</p>
        <ul class="ch-application__feedback">
          <li>${escapeHtml(feedback)}</li>
        </ul>
      </section>
      <section class="ch-application__side-card ch-application__help">
        <h2>${icon("support_agent")} Need Help?</h2>
        <p>If you have any questions, contact our support team.</p>
        <a href="/pages/contact">Contact Support ${icon("arrow_forward")}</a>
      </section>
    `;
    return;
  }
  side.innerHTML = `
    <section class="ch-application__side-card">
      <div class="ch-application__side-icon">${icon("groups")}</div>
      <h2>Why Join Custom House?</h2>
      <ul class="ch-application__benefits">
        <li>${icon("storefront")}<span><strong>Build Your Brand</strong>Create your own collection and showcase unique designs.</span></li>
        <li>${icon("trending_up")}<span><strong>Earn More</strong>Get 10% commission on every sale from your collection.</span></li>
        <li>${icon("public")}<span><strong>Global Exposure</strong>Reach customers who love original designs.</span></li>
        <li>${icon("verified")}<span><strong>Full Support</strong>Our team helps you grow your creator journey.</span></li>
      </ul>
    </section>
    <section class="ch-application__side-card ch-application__tips">
      <h2>Application Tips</h2>
      <ul>
        <li>${icon("check")} Provide accurate information</li>
        <li>${icon("check")} Use your active social profile</li>
        <li>${icon("check")} Add links to your portfolio</li>
        <li>${icon("check")} Tell us about your style</li>
      </ul>
    </section>
    <section class="ch-application__note">${icon("lightbulb")} Our team typically reviews applications within 2-3 business days.</section>
  `;
}

function renderStatus(root, title, text, actionLabel, actionHref, reason = "") {
  renderHeader(root, { state: "STATUS" }, 2);
  renderSidebar(root, {});
  const screen = root.querySelector("[data-application-screen]");
  screen.innerHTML = `
    <div class="ch-application__status">
      <span class="ch-application__status-icon">${icon("verified")}</span>
      <h2>${escapeHtml(title)}</h2>
      ${reason ? `<p class="ch-application__reason">${escapeHtml(reason)}</p>` : ""}
      <p>${escapeHtml(text)}</p>
      ${actionHref ? `<a class="ch-application__button" href="${escapeHtml(actionHref)}">${escapeHtml(actionLabel)} ${icon("arrow_forward")}</a>` : ""}
    </div>
  `;
}

function fieldError(name, errors) {
  const message = errors?.[name];
  return message ? `<small class="ch-application__error">${escapeHtml(message)}</small>` : "";
}

function optionTags(values, selected = []) {
  return values
    .map((value) => {
      const checked = selected.includes(value) ? "checked" : "";
      return `<label class="ch-application__chip"><input type="checkbox" name="categories" value="${escapeHtml(value)}" ${checked}> <span>${escapeHtml(value)}</span></label>`;
    })
    .join("");
}

function selectOptions(values, selected = "") {
  return [
    `<option value="">Choose...</option>`,
    ...values.map((value) => {
      const checked = value === selected ? "selected" : "";
      return `<option value="${escapeHtml(value)}" ${checked}>${escapeHtml(value)}</option>`;
    }),
  ].join("");
}

function formValues(form) {
  const data = new FormData(form);
  const hasControl = (name) => Boolean(form.elements[name]);
  const values = {};
  if (hasControl("legalName")) values.legalName = String(data.get("legalName") || "");
  if (hasControl("displayName")) values.displayName = String(data.get("displayName") || "");
  if (hasControl("bio")) values.bio = String(data.get("bio") || "");
  if (hasControl("country")) values.country = String(data.get("country") || "");
  if (hasControl("city")) values.city = String(data.get("city") || "");
  if (hasControl("primaryPlatform")) values.primaryPlatform = String(data.get("primaryPlatform") || "");
  if (hasControl("primaryProfileUrl")) values.primaryProfileUrl = String(data.get("primaryProfileUrl") || "");
  if (hasControl("audienceRange")) values.audienceRange = String(data.get("audienceRange") || "");
  if (hasControl("categories")) values.categories = data.getAll("categories").map(String);
  if (hasControl("portfolioUrl")) values.portfolioUrl = String(data.get("portfolioUrl") || "");
  if (hasControl("aboutWork")) values.aboutWork = String(data.get("aboutWork") || "");
  if (hasControl("referralCode")) values.referralCode = String(data.get("referralCode") || "");
  if (hasControl("accuracyConfirmed")) values.accuracyConfirmed = data.get("accuracyConfirmed") === "on";
  if (hasControl("termsAccepted")) values.termsAccepted = data.get("termsAccepted") === "on";
  return values;
}

function applicationValues(application, customer, referral = {}) {
  return {
    legalName: application.legalName || [customer.firstName, customer.lastName].filter(Boolean).join(" "),
    displayName: application.displayName || [customer.firstName, customer.lastName].filter(Boolean).join(" "),
    email: application.emailSnapshot || customer.email || "",
    bio: application.bio || "",
    country: application.country || "",
    city: application.city || "",
    primaryPlatform: application.primaryPlatform || "",
    primaryProfileUrl: application.primaryProfileUrl || "",
    audienceRange: application.audienceRange || "",
    categories: application.categories || [],
    portfolioUrl: application.portfolioUrl || "",
    aboutWork: application.aboutWork || "",
    referralCode: referral.code || application.referralCode || "",
    accuracyConfirmed: Boolean(application.accuracyConfirmed),
    termsAccepted: Boolean(application.termsAccepted),
  };
}

function validateClient(value) {
  const errors = {};
  if (value.displayName.trim().length < 2) errors.displayName = "Enter your creator display name.";
  if (value.legalName && value.legalName.trim().length < 2) errors.legalName = "Enter your legal name.";
  if (value.bio.trim() && value.bio.trim().length < 10) errors.bio = "Write at least 10 characters or leave this optional field blank.";
  if (value.bio.trim().length > 500) errors.bio = "Keep your bio under 500 characters.";
  if (value.primaryProfileUrl && !/^https:\/\/[^ ]+\.[^ ]+/i.test(value.primaryProfileUrl.trim())) errors.primaryProfileUrl = "Enter a valid HTTPS profile URL.";
  if (!value.categories.length) errors.categories = "Choose at least one category.";
  if (value.portfolioUrl && !/^https:\/\/[^ ]+\.[^ ]+/i.test(value.portfolioUrl.trim())) errors.portfolioUrl = "Portfolio URL must use HTTPS.";
  if (value.aboutWork.length > 1000) errors.aboutWork = "Keep this under 1000 characters.";
  if (!value.accuracyConfirmed) errors.accuracyConfirmed = "Confirm the details are accurate.";
  if (!value.termsAccepted) errors.termsAccepted = "Accept the creator terms.";
  return errors;
}

function field(label, markup, help = "", required = false, error = "") {
  return `
    <label>
      <span>${escapeHtml(label)}${required ? " *" : ""}</span>
      ${markup}
      ${help ? `<small class="ch-application__helptext">${escapeHtml(help)}</small>` : ""}
      ${error}
    </label>
  `;
}

function rejectedNotice(state) {
  if (state.state !== "REJECTED") return "";
  const reason = state.application?.rejectionReason || "Please update your information based on the review feedback and resubmit your application.";
  return `
    <div class="ch-application__alert">
      ${icon("error")}
      <span><strong>Changes requested</strong>${escapeHtml(reason)}</span>
      <button type="button">View Review Summary ${icon("expand_more")}</button>
    </div>
  `;
}

function referralFieldMarkup(state, values, errors) {
  const referral = state.referral || {};
  const locked = Boolean(referral.locked);
  const referrerName = referral.referrerName || "";
  const help = locked
    ? referrerName
      ? `Referred by ${referrerName}. This referral is linked to your account.`
      : "This referral is linked to your account."
    : "Optional. Enter a creator referral code if someone invited you.";
  const input = `<input name="referralCode" value="${escapeHtml(values.referralCode)}" maxlength="100" ${locked ? "readonly aria-readonly=\"true\"" : ""}>`;
  const display = locked && referrerName
    ? `<small class="ch-application__helptext"><strong>Referred by</strong> ${escapeHtml(referrerName)}</small>`
    : "";
  return field(
    locked ? "Referral Code" : "Referral Code",
    `${display}${input}`,
    help,
    false,
    fieldError("referralCode", errors),
  );
}

function applicationErrorMessage(body, fallbackMessage) {
  const code = body?.error?.code;
  if (code === "CUSTOMER_LOGIN_REQUIRED") return "Please sign in before submitting your application.";
  if (code === "VALIDATION_ERROR") return body?.error?.message || "Please check the highlighted fields.";
  if (code === "APPLICATION_NON_JSON_RESPONSE" || code === "APPLICATION_INVALID_JSON") {
    return "We couldn't complete this request. Please refresh and try again.";
  }
  if (code === "APPLICATION_SUBMIT_FAILED") return "Unable to submit the application. Please try again.";
  if (code === "APPLICATION_STATE_FAILED") return "Unable to load the application. Please refresh and try again.";
  return fallbackMessage;
}

async function readJsonResponse(response, context) {
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.toLowerCase().includes("application/json")) {
    const preview = await response.text();
    console.error("creator_application_non_json_response", {
      context,
      url: response.url,
      status: response.status,
      contentType,
      responsePreview: preview.slice(0, 300),
    });
    return {
      ok: false,
      error: {
        code: "APPLICATION_NON_JSON_RESPONSE",
        message: "We couldn't complete this request. Please refresh and try again.",
      },
    };
  }
  try {
    return await response.json();
  } catch (error) {
    console.error("creator_application_invalid_json", {
      context,
      status: response.status,
      contentType,
    });
    return {
      ok: false,
      error: {
        code: "APPLICATION_INVALID_JSON",
        message: "We couldn't complete this request. Please refresh and try again.",
      },
    };
  }
}

function renderForm(root, state, step = 0, errors = {}) {
  renderHeader(root, state, step);
  renderSidebar(root, state);
  const screen = root.querySelector("[data-application-screen]");
  const application = state.application || {};
  const customer = state.customer || {};
  const options = state.options || { platforms: [], audienceRanges: [], categories: [] };
  const values = applicationValues(application, customer, state.referral);
  const title = step === 0 ? "Tell us about you" : step === 1 ? "Creator Presence" : "Review Application";
  const subtitle = step === 0 ? "Update your basic information." : step === 1 ? "Your platforms, audience, and content." : "Review your details before submitting.";
  const stepMarkup = [
    `<div class="ch-application__step">
      ${field("Creator Display Name", `<input name="displayName" value="${escapeHtml(values.displayName)}" required maxlength="80">`, "This will be visible on your creator profile and collection.", true, fieldError("displayName", errors))}
      ${field("Legal Name", `<input name="legalName" value="${escapeHtml(values.legalName)}" maxlength="120">`, "Used only for creator account review.", false, fieldError("legalName", errors))}
      ${field("Email Address", `<div class="ch-application__verified-field"><input value="${escapeHtml(values.email)}" readonly>${icon("lock")}<b>Verified</b></div>`, "We'll use your account email.", false)}
      ${referralFieldMarkup(state, values, errors)}
      <div class="ch-application__split">
        ${field("Country / Region", `<input name="country" value="${escapeHtml(values.country)}" maxlength="80">`, "", false)}
        ${field("City", `<input name="city" value="${escapeHtml(values.city)}" maxlength="100">`, "", false)}
      </div>
      <label class="ch-application__full">
        <span>Creator Bio <small>(optional)</small></span>
        <textarea name="bio" maxlength="500">${escapeHtml(values.bio)}</textarea>
        <small class="ch-application__counter"><span>Optional. Tell customers about your style and what inspires your work.</span><b>${values.bio.length} / 500</b></small>
        ${fieldError("bio", errors)}
      </label>
    </div>`,
    `<div class="ch-application__step">
      ${field("Primary Platform", `<select name="primaryPlatform">${selectOptions(options.platforms, values.primaryPlatform)}</select>`, "Optional. You can add or change this later in Creator Dashboard → Account.", false, fieldError("primaryPlatform", errors))}
      ${field("Primary Profile URL", `<input name="primaryProfileUrl" type="url" inputmode="url" value="${escapeHtml(values.primaryProfileUrl)}">`, "Optional. A social presence is not required to apply.", false, fieldError("primaryProfileUrl", errors))}
      ${field("Audience Size", `<select name="audienceRange">${selectOptions(options.audienceRanges, values.audienceRange)}</select>`, "", false)}
      ${field("Portfolio / Website", `<input name="portfolioUrl" type="url" inputmode="url" value="${escapeHtml(values.portfolioUrl)}">`, "Optional, but helpful for review.", false, fieldError("portfolioUrl", errors))}
      <fieldset class="ch-application__full">
        <legend>Creator / Design Categories *</legend>
        <div class="ch-application__chips">${optionTags(options.categories, values.categories)}</div>
        ${fieldError("categories", errors)}
      </fieldset>
      <label class="ch-application__full">
        <span>About Your Work</span>
        <textarea name="aboutWork" maxlength="1000">${escapeHtml(values.aboutWork)}</textarea>
        <small class="ch-application__helptext">Share collection ideas, design style, or products you want to create.</small>
        ${fieldError("aboutWork", errors)}
      </label>
    </div>`,
    `<div class="ch-application__step">
      <div class="ch-application__summary">
        <span><strong>Creator Name</strong>${escapeHtml(values.displayName || "Not entered")}</span>
        <span><strong>Legal Name</strong>${escapeHtml(values.legalName || "Not provided")}</span>
        <span><strong>Email</strong>${escapeHtml(values.email || "Not available")}</span>
        <span><strong>Location</strong>${escapeHtml([values.city, values.country].filter(Boolean).join(", ") || "Not provided")}</span>
        <span><strong>Platform</strong>${escapeHtml(values.primaryPlatform || "Not chosen")}</span>
        <span><strong>Profile</strong>${escapeHtml(values.primaryProfileUrl || "Not entered")}</span>
        <span><strong>Audience</strong>${escapeHtml(values.audienceRange || "Not provided")}</span>
        <span><strong>Categories</strong>${escapeHtml(values.categories.join(", ") || "Not chosen")}</span>
        <span><strong>Portfolio</strong>${escapeHtml(values.portfolioUrl || "Not provided")}</span>
        <span><strong>Referral Code</strong>${escapeHtml(values.referralCode || "Not provided")}</span>
        <span><strong>Bio</strong>${escapeHtml(values.bio || "Not entered")}</span>
      </div>
      <label class="ch-application__check"><input type="checkbox" name="accuracyConfirmed" ${values.accuracyConfirmed ? "checked" : ""}> <span>I confirm that the information provided is accurate.</span></label>${fieldError("accuracyConfirmed", errors)}
      <label class="ch-application__check"><input type="checkbox" name="termsAccepted" ${values.termsAccepted ? "checked" : ""}> <span>I agree to the Creator Terms.</span></label>${fieldError("termsAccepted", errors)}
    </div>`,
  ];
  screen.innerHTML = `
    <form class="ch-application__form" novalidate>
      ${rejectedNotice(state)}
      <section class="ch-application__panel">
        <header class="ch-application__panel-head">
          <span>${icon(step === 0 ? "person" : step === 1 ? "campaign" : "fact_check")} Step ${step + 1} of 3</span>
          <h2>${title}</h2>
          <p>${subtitle}</p>
        </header>
        ${stepMarkup[step]}
        <div class="ch-application__actions">
          <button type="button" class="ch-application__secondary" data-back ${step === 0 ? "disabled" : ""}>Back</button>
          <button type="${step === 2 ? "submit" : "button"}" class="ch-application__button" ${step === 2 ? "data-submit" : "data-next"}>${step === 2 ? (state.state === "REJECTED" ? "Resubmit Application" : "Submit Application") : `Continue ${icon("arrow_forward")}`}</button>
        </div>
      </section>
      <p class="ch-application__message" data-message></p>
    </form>
  `;
  const form = screen.querySelector("form");
  root.querySelectorAll("[data-step-jump]").forEach((button) => {
    button.addEventListener("click", () => renderForm(root, { ...state, application: { ...application, ...formValues(form) } }, Number(button.dataset.stepJump), errors));
  });
  screen.querySelector("[data-back]").addEventListener("click", () => renderForm(root, { ...state, application: { ...application, ...formValues(form) } }, Math.max(0, step - 1), errors));
  const goNext = () => {
    const value = { ...applicationValues(application, customer, state.referral), ...formValues(form) };
    const nextErrors = validateClient(value);
    const stepHasError = step === 0 ? nextErrors.displayName || nextErrors.legalName || nextErrors.bio : nextErrors.primaryPlatform || nextErrors.primaryProfileUrl || nextErrors.categories || nextErrors.portfolioUrl || nextErrors.aboutWork;
    if (stepHasError) {
      renderForm(root, { ...state, application: { ...application, ...value } }, step, nextErrors);
      const invalid = screen.querySelector(".ch-application__error");
      invalid?.scrollIntoView({ block: "center", behavior: "smooth" });
      return;
    }
    renderForm(root, { ...state, application: { ...application, ...value } }, step + 1, {});
  };
  screen.querySelector("[data-next]")?.addEventListener("click", goNext);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (step !== 2) {
      goNext();
      return;
    }
    console.count("customhouse_creator_application_submit");
    const current = screen.querySelector("[data-submit]");
    if (!current || current.disabled) return;
    const value = { ...applicationValues(application, customer, state.referral), ...formValues(form) };
    const nextErrors = validateClient(value);
    if (Object.keys(nextErrors).length) {
      renderForm(root, { ...state, application: { ...application, ...value } }, step, nextErrors);
      const invalid = screen.querySelector(".ch-application__error");
      invalid?.scrollIntoView({ block: "center", behavior: "smooth" });
      return;
    }
    current.disabled = true;
    current.textContent = state.state === "REJECTED" ? "Resubmitting..." : "Submitting...";
    try {
      const response = await fetch(root.dataset.submitEndpoint || root.dataset.endpoint, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Accept": "application/json", "Content-Type": "application/json" },
        body: JSON.stringify(value),
      });
      const body = await readJsonResponse(response, "submit");
      if (!body?.ok) {
        if (
          [
            "INVALID_REFERRAL_CODE",
            "SELF_REFERRAL_NOT_ALLOWED",
          ].includes(body?.error?.code)
        ) {
          renderForm(
            root,
            { ...state, application: { ...application, ...value } },
            0,
            { referralCode: body?.error?.message || "Enter a valid referral code." },
          );
          const invalid = root.querySelector(".ch-application__error");
          invalid?.scrollIntoView({ block: "center", behavior: "smooth" });
          return;
        }
        screen.querySelector("[data-message]").textContent = applicationErrorMessage(
          body,
          "Application could not be submitted. Please refresh and try again.",
        );
        current.disabled = false;
        current.textContent = state.state === "REJECTED" ? "Resubmit Application" : "Submit Application";
        return;
      }
      renderStatus(root, "Application Under Review", "We're reviewing your application. You'll see your status here when a decision has been made.", "Return to Account", "/account");
    } catch (error) {
      console.error("creator_application_submit_exception", error);
      screen.querySelector("[data-message]").textContent = "Something went wrong. Please try again.";
      current.disabled = false;
      current.textContent = state.state === "REJECTED" ? "Resubmit Application" : "Submit Application";
    }
  });
}

async function boot(root) {
  hideLegacyPageContent(root);
  try {
    const response = await fetch(root.dataset.endpoint, { credentials: "same-origin", headers: { Accept: "application/json" } });
    const body = await readJsonResponse(response, "state");
    if (!body?.ok) {
      renderStatus(
        root,
        "Application unavailable",
        applicationErrorMessage(body, "Application status is unavailable. Please refresh the page."),
        "",
        "",
      );
      return;
    }
    const state = body.data;
    if (state.state === "LOGGED_OUT") {
      renderStatus(root, "Become a Creator", "Sign in to submit your creator application.", "Sign In", root.dataset.loginUrl);
    } else if (state.state === "PENDING") {
      renderStatus(root, "Application Under Review", "We're reviewing your application. You'll see your status here when a decision has been made.", "Return to Account", "/account");
    } else if (state.state === "APPROVED") {
      renderStatus(root, "You're a Creator", "Your creator account is approved.", "Open Creator Dashboard", root.dataset.dashboardUrl);
    } else if (state.state === "SUSPENDED") {
      renderStatus(root, "Creator Status", "Your creator account is currently suspended. Contact support if you need help.", "Return to Account", "/account");
    } else {
      renderForm(root, state, 0, {});
    }
  } catch (error) {
    console.error("creator_application_state_exception", error);
    renderStatus(root, "Application unavailable", "Something went wrong. Please refresh and try again.", "", "");
  }
}

document.querySelectorAll("[data-customhouse-creator-application]").forEach((root) => {
  if (root.dataset.customhouseInitialized === "true") return;
  root.dataset.customhouseInitialized = "true";
  boot(root);
});
