import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import {
  getCreatorApplicationState,
  submitCreatorApplication,
} from "../services/creator-application.server";
import { DomainError } from "../services/domain";
import {
  jsonBody,
  proxyContext,
  proxyJson,
  proxyJsonError,
} from "../services/proxy.server";
import { enforceRateLimit } from "../services/rate-limit.server";

function safeCreatorApplicationError(error: unknown) {
  if (error instanceof Error) {
    const maybeCode = (error as { code?: unknown }).code;
    const maybeMeta = (error as { meta?: unknown }).meta;
    return {
      errorName: error.name,
      errorMessage: error.message.slice(0, 500),
      prismaCode: typeof maybeCode === "string" ? maybeCode : null,
      metaKeys:
        maybeMeta && typeof maybeMeta === "object"
          ? Object.keys(maybeMeta as Record<string, unknown>).slice(0, 20)
          : [],
    };
  }
  return {
    errorName: typeof error,
    errorMessage: "Non-Error exception",
    prismaCode: null,
    metaKeys: [],
  };
}

export async function loader({ request }: LoaderFunctionArgs) {
  const { shop, customerId, client } = await proxyContext(request, false);
  console.info("creator_application_proxy_request", {
    method: request.method,
    pathname: new URL(request.url).pathname,
    authenticatedProxy: true,
    shop,
    loggedInCustomerPresent: Boolean(customerId),
    operation: "state",
  });

  try {
    if (customerId) {
      enforceRateLimit(`${shop}:${customerId}:creator-application-state`, 60, 60 * 1000);
    }
    const data = await getCreatorApplicationState(shop, customerId, client);
    console.info("creator_application_proxy_response", {
      operation: "state",
      ok: true,
      errorCode: null,
      statusReturned: 200,
      contentType: "application/json; charset=utf-8",
    });
    return proxyJson({ ok: true, data });
  } catch (error) {
    if (!(error instanceof DomainError)) {
      console.error("creator_application_state_failed", {
        pathname: new URL(request.url).pathname,
      });
    }
    const known = error instanceof DomainError;
    const response = proxyJsonError(
      known
        ? error
        : new DomainError(
            "APPLICATION_STATE_FAILED",
            "Unable to load the application. Please try again.",
            500,
          ),
    );
    console.info("creator_application_proxy_response", {
      operation: "state",
      ok: false,
      errorCode: known ? error.code : "APPLICATION_STATE_FAILED",
      statusReturned: 200,
      contentType: "application/json; charset=utf-8",
    });
    return response;
  }
}

export async function action({ request }: ActionFunctionArgs) {
  if (!["POST", "PATCH"].includes(request.method)) {
    return proxyJsonError(
      new DomainError("METHOD_NOT_ALLOWED", "Use POST to submit an application.", 405),
    );
  }

  const { shop, customerId, client } = await proxyContext(request, false);
  console.info("creator_application_proxy_request", {
    method: request.method,
    pathname: new URL(request.url).pathname,
    authenticatedProxy: true,
    shop,
    loggedInCustomerPresent: Boolean(customerId),
    operation: "submit",
  });

  if (!customerId) {
    return proxyJsonError(
      new DomainError(
        "CUSTOMER_LOGIN_REQUIRED",
        "Please sign in before submitting your application.",
        401,
      ),
    );
  }

  try {
    console.info("creator_application_submit_stage", {
      stage: "PARSE_BODY",
      shop,
      loggedInCustomerPresent: true,
    });
    enforceRateLimit(`${shop}:${customerId}:creator-application-submit`, 8, 60 * 60 * 1000);
    const body = await jsonBody(request);
    const application = await submitCreatorApplication(
      shop,
      customerId,
      {
        legalName: typeof body.legalName === "string" ? body.legalName : undefined,
        displayName: String(body.displayName || ""),
        bio: String(body.bio || ""),
        country: typeof body.country === "string" ? body.country : undefined,
        city: typeof body.city === "string" ? body.city : undefined,
        primaryPlatform:
          typeof body.primaryPlatform === "string" ? body.primaryPlatform : undefined,
        primaryProfileUrl:
          typeof body.primaryProfileUrl === "string" ? body.primaryProfileUrl : undefined,
        audienceRange:
          typeof body.audienceRange === "string" ? body.audienceRange : undefined,
        categories: Array.isArray(body.categories)
          ? body.categories.filter((item): item is string => typeof item === "string")
          : [],
        portfolioUrl:
          typeof body.portfolioUrl === "string" ? body.portfolioUrl : undefined,
        aboutWork: typeof body.aboutWork === "string" ? body.aboutWork : undefined,
        referralCode:
          typeof body.referralCode === "string" ? body.referralCode : undefined,
        termsReadConfirmed: body.termsReadConfirmed === true,
        termsAccepted: body.termsAccepted === true,
        accuracyConfirmed: body.accuracyConfirmed === true,
      },
      client,
    );
    console.info("creator_application_proxy_response", {
      operation: "submit",
      ok: true,
      errorCode: null,
      statusReturned: 200,
      contentType: "application/json; charset=utf-8",
    });
    return proxyJson({ ok: true, application });
  } catch (error) {
    if (!(error instanceof DomainError)) {
      console.error("creator_application_submit_failed", {
        pathname: new URL(request.url).pathname,
        shop,
        loggedInCustomerPresent: Boolean(customerId),
        operation: "submit",
        ...safeCreatorApplicationError(error),
      });
    }
    const known = error instanceof DomainError;
    const response = proxyJsonError(
      known
        ? error
        : new DomainError(
            "APPLICATION_SUBMIT_FAILED",
            "Unable to submit the application. Please try again.",
            500,
          ),
    );
    console.info("creator_application_proxy_response", {
      operation: "submit",
      ok: false,
      errorCode: known ? error.code : "APPLICATION_SUBMIT_FAILED",
      statusReturned: 200,
      contentType: "application/json; charset=utf-8",
    });
    return response;
  }
}
