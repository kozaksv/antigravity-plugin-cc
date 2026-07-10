import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ROOT = path.join(ROOT, "plugins", "antigravity");

const { validateAgainstSchema } = await import(
  path.join(PLUGIN_ROOT, "scripts", "lib", "schema-validate.mjs")
);

const { readOutputSchema } = await import(path.join(PLUGIN_ROOT, "scripts", "lib", "antigravity.mjs"));

const REVIEW_SCHEMA_PATH = path.join(PLUGIN_ROOT, "schemas", "review-output.schema.json");

function loadReviewSchema() {
  return readOutputSchema(REVIEW_SCHEMA_PATH);
}

function validSample() {
  return {
    verdict: "needs-attention",
    summary: "Concurrent writers can corrupt state.json.",
    findings: [
      {
        severity: "high",
        title: "Unsynchronized writes",
        body: "Two writers can interleave and truncate the file.",
        file: "plugins/antigravity/scripts/lib/state.mjs",
        line_start: 92,
        line_end: 116,
        confidence: 0.8,
        recommendation: "Take a file lock around the write."
      }
    ],
    next_steps: ["Add a lock around saveState."]
  };
}

test("validateAgainstSchema accepts a valid review-output sample", () => {
  const result = validateAgainstSchema(validSample(), loadReviewSchema());
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  assert.deepEqual(result.errors, []);
});

test("validateAgainstSchema rejects a verdict outside the enum", () => {
  const sample = validSample();
  sample.verdict = "maybe";
  const result = validateAgainstSchema(sample, loadReviewSchema());
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => /verdict/.test(e)));
});

test("validateAgainstSchema rejects an invalid finding severity", () => {
  const sample = validSample();
  sample.findings[0].severity = "catastrophic";
  const result = validateAgainstSchema(sample, loadReviewSchema());
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => /severity/.test(e)));
});

test("validateAgainstSchema rejects a confidence value of the wrong type", () => {
  const sample = validSample();
  sample.findings[0].confidence = "high";
  const result = validateAgainstSchema(sample, loadReviewSchema());
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => /confidence/.test(e)));
});

test("validateAgainstSchema rejects an unexpected top-level property (additionalProperties:false)", () => {
  const sample = validSample();
  sample.extraField = "not allowed";
  const result = validateAgainstSchema(sample, loadReviewSchema());
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => /extraField/.test(e)));
});

test("validateAgainstSchema rejects a finding missing a required field", () => {
  const sample = validSample();
  delete sample.findings[0].recommendation;
  const result = validateAgainstSchema(sample, loadReviewSchema());
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => /recommendation/.test(e)));
});

test("validateAgainstSchema rejects a missing top-level next_steps", () => {
  const sample = validSample();
  delete sample.next_steps;
  const result = validateAgainstSchema(sample, loadReviewSchema());
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => /next_steps/.test(e)));
});

test("validateAgainstSchema enforces numeric maximum: confidence 2 (max 1) fails", () => {
  const sample = validSample();
  sample.findings[0].confidence = 2;
  const result = validateAgainstSchema(sample, loadReviewSchema());
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => /confidence/.test(e) && /maximum|1/.test(e)));
});

test("validateAgainstSchema enforces numeric minimum: line_start 0 (min 1) fails", () => {
  const sample = validSample();
  sample.findings[0].line_start = 0;
  const result = validateAgainstSchema(sample, loadReviewSchema());
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => /line_start/.test(e)));
});

test("validateAgainstSchema accepts numeric values exactly at the schema boundaries", () => {
  const sample = validSample();
  sample.findings[0].confidence = 1; // maximum
  sample.findings[0].line_start = 1; // minimum
  const zeroConfidence = validSample();
  zeroConfidence.findings[0].confidence = 0; // minimum
  assert.equal(validateAgainstSchema(sample, loadReviewSchema()).valid, true);
  assert.equal(validateAgainstSchema(zeroConfidence, loadReviewSchema()).valid, true);
});

test("validateAgainstSchema rejects a non-object top-level value", () => {
  const result = validateAgainstSchema("not an object", loadReviewSchema());
  assert.equal(result.valid, false);
});

test("validateAgainstSchema accepts an empty findings/next_steps array", () => {
  const sample = {
    verdict: "approve",
    summary: "No issues found.",
    findings: [],
    next_steps: []
  };
  const result = validateAgainstSchema(sample, loadReviewSchema());
  assert.equal(result.valid, true, JSON.stringify(result.errors));
});
