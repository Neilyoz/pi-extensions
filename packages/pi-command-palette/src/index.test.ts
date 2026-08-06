/**
 * Regression tests for model reference parsing and the partitioned fuzzy
 * filter that keeps scoped models on top while searching.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { parseModelRef, partitionedFuzzyFilter } from "./index.ts";

test("parseModelRef splits provider and model at the first slash", () => {
  assert.deepEqual(parseModelRef("anthropic/claude-sonnet"), {
    provider: "anthropic",
    modelId: "claude-sonnet",
  });
  assert.deepEqual(parseModelRef("openrouter/vendor/model/with/slashes"), {
    provider: "openrouter",
    modelId: "vendor/model/with/slashes",
  });
});

test("parseModelRef preserves empty provider or model segments", () => {
  assert.equal(parseModelRef("model-without-provider"), undefined);
  assert.deepEqual(parseModelRef("/model"), { provider: "", modelId: "model" });
  assert.deepEqual(parseModelRef("provider/"), { provider: "provider", modelId: "" });
});

// ── partitionedFuzzyFilter ─────────────────────────────────────────

test("partitionedFuzzyFilter concatenates partitions unchanged for empty query", () => {
  const primary = [{ label: "A" }, { label: "B" }];
  const secondary = [{ label: "C" }, { label: "D" }];
  const getText = (m: { label: string }) => m.label;

  assert.deepEqual(
    partitionedFuzzyFilter(primary, secondary, "", getText).map((m) => m.label),
    ["A", "B", "C", "D"],
  );
  // Whitespace-only is treated as no query.
  assert.deepEqual(
    partitionedFuzzyFilter(primary, secondary, "   ", getText).map((m) => m.label),
    ["A", "B", "C", "D"],
  );
});

test("partitionedFuzzyFilter keeps the primary partition on top while filtering", () => {
  const primary = [{ label: "alpha-scoped" }, { label: "beta-scoped" }];
  const secondary = [{ label: "alpha-other" }, { label: "beta-other" }];
  const getText = (m: { label: string }) => m.label;

  const result = partitionedFuzzyFilter(primary, secondary, "alpha", getText);

  // Both groups match, but the scoped (primary) match must come first — a
  // single fuzzyFilter pass would have ranked them by score and could flip
  // the order.
  assert.equal(result.length, 2);
  assert.equal(result[0].label, "alpha-scoped");
  assert.equal(result[1].label, "alpha-other");
});

test("partitionedFuzzyFilter drops non-matches independently per partition", () => {
  const primary = [{ label: "keep-scoped" }, { label: "drop-scoped" }];
  const secondary = [{ label: "keep-other" }, { label: "drop-other" }];
  const getText = (m: { label: string }) => m.label;

  const result = partitionedFuzzyFilter(primary, secondary, "keep", getText);

  assert.deepEqual(result.map((m) => m.label), ["keep-scoped", "keep-other"]);
});

test("partitionedFuzzyFilter returns only primary matches when secondary has none", () => {
  const primary = [{ label: "sonnet" }];
  const secondary = [{ label: "gpt-4o" }, { label: "gemini" }];
  const getText = (m: { label: string }) => m.label;

  const result = partitionedFuzzyFilter(primary, secondary, "son", getText);

  assert.deepEqual(result.map((m) => m.label), ["sonnet"]);
});
