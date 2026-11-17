import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const appRoute = readFileSync(
  new URL("../app/routes/app.tsx", import.meta.url),
  "utf8",
);
const creatorProductsRoute = readFileSync(
  new URL("../app/routes/app.creator-products.tsx", import.meta.url),
  "utf8",
);
const compatibilityRoute = readFileSync(
  new URL("../app/routes/app.creator-products_.compatibility.tsx", import.meta.url),
  "utf8",
);

const routesConfig = readFileSync(
  new URL("../app/routes.ts", import.meta.url),
  "utf8",
);

const internalTarget = "/app/creator-products/compatibility";

test("embedded Admin navigation exposes Compatibility / Legacy Repair", () => {
  assert.match(
    appRoute,
    /<s-link href="\/app\/creator-products\/compatibility">\s*Compatibility \/ Legacy Repair\s*<\/s-link>/,
  );
});

test("compatibility route opts out of the non-layout Creator Products parent", () => {
  assert.match(routesConfig, /flatRoutes\(\)/);
  assert.match(
    compatibilityRoute,
    /export default function CreatorProductCompatibilityAdmin/,
  );
  assert.doesNotMatch(
    creatorProductsRoute,
    /<Outlet\s*\/?\s*>/,
  );
});

test("Creator Products exposes the same internal compatibility target", () => {
  assert.match(creatorProductsRoute, /to="\/app\/creator-products\/compatibility"/);
  assert.match(creatorProductsRoute, /Compatibility \/ Legacy Repair/);
});

test("compatibility navigation never uses an absolute Vercel URL", () => {
  for (const source of [appRoute, creatorProductsRoute, compatibilityRoute]) {
    assert.ok(source.includes(internalTarget) || source === compatibilityRoute);
    assert.doesNotMatch(
      source,
      /https:\/\/custom-house(?:-[^\s"']+)?\.vercel\.app\/app\/creator-products\/compatibility/,
    );
  }
});

test("authenticated compatibility loader establishes Admin context before loading data", () => {
  const loaderStart = compatibilityRoute.indexOf("export async function loader");
  const actionStart = compatibilityRoute.indexOf("export async function action");
  const loaderSource = compatibilityRoute.slice(loaderStart, actionStart);
  const authIndex = loaderSource.indexOf("await authenticate.admin(request)");
  const dataIndex = loaderSource.indexOf("listLegacyCompatibilityRecords");
  assert.ok(authIndex >= 0);
  assert.ok(dataIndex > authIndex);
  assert.match(loaderSource, /new AdminGraphqlClient\(admin\)/);
  assert.match(loaderSource, /return \{ overview, detail \}/);
});

test("unauthenticated requests cannot reach compatibility data or mutations", () => {
  const parentAuth = appRoute.indexOf("await authenticate.admin(request)");
  const parentRender = appRoute.indexOf("<Outlet />");
  assert.ok(parentAuth >= 0 && parentRender > parentAuth);

  const actionStart = compatibilityRoute.indexOf("export async function action");
  const actionSource = compatibilityRoute.slice(actionStart);
  const actionAuth = actionSource.indexOf("await authenticate.admin(request)");
  const actionMutation = actionSource.indexOf("applyLegacyCreatorProductRepair");
  assert.ok(actionAuth >= 0 && actionMutation > actionAuth);
  assert.match(compatibilityRoute, /boundary\.headers\(headersArgs\)/);
});

test("existing embedded navigation and compatibility back navigation remain intact", () => {
  for (const label of [
    "Dashboard",
    "Creators",
    "Referrals",
    "Products",
    "Creator Products",
    "Creator Orders",
    "Payouts",
    "Settings",
  ]) {
    assert.ok(appRoute.includes(`>${label}</s-link>`));
  }
  assert.match(
    compatibilityRoute,
    /Creator Products → Compatibility \/ Legacy Repair/,
  );
  assert.match(
    compatibilityRoute,
    /to="\/app\/creator-products">Back to Creator Products<\/Link>/,
  );
});
