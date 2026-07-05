import test from "node:test";
import assert from "node:assert/strict";

import { renderNativeReviewResult, renderReviewResult, renderStoredJobResult } from "../plugins/antigravity/scripts/lib/render.mjs";

test("renderReviewResult degrades gracefully when JSON is missing required review fields", () => {
  const output = renderReviewResult(
    {
      parsed: {
        verdict: "approve",
        summary: "Looks fine."
      },
      rawOutput: JSON.stringify({
        verdict: "approve",
        summary: "Looks fine."
      }),
      parseError: null
    },
    {
      reviewLabel: "Adversarial Review",
      targetLabel: "working tree diff"
    }
  );

  assert.match(output, /Antigravity returned JSON with an unexpected review shape\./);
  assert.match(output, /Missing array `findings`\./);
  assert.match(output, /Raw final message:/);
});

test("renderNativeReviewResult surfaces the error message when there is no stdout", () => {
  const output = renderNativeReviewResult(
    {
      status: 1,
      stdout: "",
      stderr: "",
      error: { code: "QUOTA_EXHAUSTED", message: "Antigravity quota exhausted. Resets in 3h59m59s.", retryable: false }
    },
    { reviewLabel: "Review", targetLabel: "working tree diff" }
  );

  // Before this fix, an empty stdout/stderr with a failed status rendered only
  // the generic "Antigravity review failed." — the real reason was silently
  // dropped even though runOneShot had already computed a clear error.message.
  assert.match(output, /Antigravity quota exhausted\. Resets in 3h59m59s\./);
  assert.doesNotMatch(output, /^Antigravity review failed\.$/m);
});

test("renderStoredJobResult prefers rendered output for structured review jobs", () => {
  const output = renderStoredJobResult(
    {
      id: "review-123",
      status: "completed",
      title: "Antigravity Adversarial Review",
      jobClass: "review",
      threadId: "thr_123"
    },
    {
      threadId: "thr_123",
      rendered: "# Antigravity Adversarial Review\n\nTarget: working tree diff\nVerdict: needs-attention\n",
      result: {
        result: {
          verdict: "needs-attention",
          summary: "One issue.",
          findings: [],
          next_steps: []
        },
        rawOutput:
          '{"verdict":"needs-attention","summary":"One issue.","findings":[],"next_steps":[]}'
      }
    }
  );

  assert.match(output, /^# Antigravity Adversarial Review/);
  assert.doesNotMatch(output, /^\{/);
  assert.match(output, /Antigravity session ID: thr_123/);
  assert.match(output, /Resume in Antigravity: agy --conversation thr_123/);
});
