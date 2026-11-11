import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const template = readFileSync(
  "pitchprint-template-v10.84-CREATOR-SUBMIT-DRAFT-FIX.txt",
  "utf8",
);

test("Creator final step exposes submission copy while retaining the native final-save handoff", () => {
  assert.match(template, /window\.ppLayoutVersion = 10\.84;/);
  assert.match(
    template,
    /heading\.textContent = creatorDesign \? "Submit Design" : "Order details"/,
  );
  assert.match(
    template,
    /continueButton\.textContent = creatorDesign\s*\? "Submit Design"\s*: "Continue to cart"/,
  );
  assert.match(template, /submitting this Creator design for admin review/);
  assert.match(template, /submitted for admin review with the active garment color/);
  assert.match(template, /before submitting this Creator design/);
  assert.doesNotMatch(
    template,
    /(?:heading|continueButton)\.textContent = creatorDesign[\s\S]{0,40}"Save design"/,
  );

  assert.match(
    template,
    /function requestCreatorFinalSubmit\(nativeOk\) \{[\s\S]*?postToHost\("CUSTOMHOUSE_PP_CREATOR_FINAL_SUBMIT_INTENT",/,
  );
  assert.match(
    template,
    /function acknowledgeCreatorFinalSubmit\(payload\) \{[\s\S]*?request\.nativeOk\.click\(\);/,
  );
  assert.match(
    template,
    /if \(isCreatorDesignFlow\(\)\) \{[\s\S]*?return !!requestCreatorFinalSubmit\(nativeOk\);/,
  );
});

test("PitchPrint public customization copy and handler remain unchanged", () => {
  assert.match(template, /creatorDesign \? "Submit Design" : "Order details"/);
  assert.match(template, /\? "Submit Design"\s*: "Continue to cart"/);
  assert.match(
    template,
    /else \{\s*return !!publishCartReady\(\);\s*\}/,
  );
});
