import { readFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

test("admin dashboard header icons and compact list alignment are explicit", () => {
  const route = readFileSync("app/routes/app._index.tsx", "utf8");
  const styles = readFileSync("app/styles/admin.css", "utf8");

  assert.match(route, /className="admin-date-pill-icon"/);
  assert.match(route, /className="admin-bell-icon"/);
  assert.doesNotMatch(route, />□<\/span>/);
  assert.doesNotMatch(route, />●<\/span>/);
  assert.match(styles, /--admin-tool-icon/);
  assert.match(styles, /admin-date-pill-icon/);
  assert.match(styles, /admin-bell-icon/);
  assert.match(styles, /Compact, production admin dashboard polish/);
  assert.match(styles, /min-height: 124px/);
  assert.match(styles, /max-height: 126px/);
  assert.match(styles, /grid-template-columns: 24px minmax\(220px, 1fr\) minmax\(120px, 170px\) minmax\(96px, 140px\)/);
  assert.match(styles, /white-space: nowrap/);
});

test("admin pages use the final full-width layout override", () => {
  const productsRoute = readFileSync("app/routes/app.products.tsx", "utf8");
  const submissionsRoute = readFileSync("app/routes/app.submissions.tsx", "utf8");
  const styles = readFileSync("app/styles/admin.css", "utf8");

  assert.match(productsRoute, /<s-page heading="Marketplace products"><AdminStyles \/><s-section>/);
  assert.match(submissionsRoute, /<s-page heading="Design submissions">/);
  assert.match(styles, /Global full-width admin page override/);
  assert.match(styles, /s-page > s-section,[\s\S]*width: calc\(100vw - 40px\)/);
  assert.match(styles, /\.admin-dashboard,[\s\S]*\.setup-admin-page[\s\S]*width: calc\(100vw - 40px\)/);
  assert.match(styles, /\.admin-dashboard,[\s\S]*\.setup-admin-page[\s\S]*padding: 16px clamp\(20px, 2\.5vw, 36px\) 28px/);
  assert.match(styles, /@media \(min-width: 1600px\)[\s\S]*width: calc\(100vw - 56px\)/);
  assert.match(styles, /@media \(max-width: 520px\)[\s\S]*width: 100%/);
});
