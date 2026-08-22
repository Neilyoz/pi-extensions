/**
 * Unit tests for the background-run inbox reminder.
 *
 * Zero-dependency: runs on node's built-in test runner.
 *   node --test packages/pi-subagent/src/reminder.test.ts
 *
 * Coverage: row formatting per state (queued/running/finished/failed/budget),
 * byte-stability between calls (the cache-prefix contract), empty-inbox
 * no-op, and cache-stable head injection (string content, block content,
 * non-user first message, empty transcript).
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { buildInboxReminder, injectReminder, type InboxEntry } from "./reminder.ts";
import type { SubagentResult } from "./types.ts";
import { emptyUsage } from "./utils.ts";

function frame(partial: Partial<SubagentResult>): SubagentResult {
  return {
    role: "worker",
    task: "task",
    exitCode: 0,
    output: "",
    stderr: "",
    usage: emptyUsage(),
    activityLog: [],
    ...partial,
  };
}

function entry(partial: Partial<InboxEntry> & Pick<InboxEntry, "id" | "state">): InboxEntry {
  return {
    role: "worker",
    task: "Investigate flaky tests in packages/pi-subagent",
    snapshot: frame({}),
    ...partial,
  };
}

describe("buildInboxReminder", () => {
  test("empty inbox returns undefined (zero injection)", () => {
    assert.equal(buildInboxReminder([]), undefined);
  });

  test("queued and running rows carry no time-derived detail", () => {
    const text = buildInboxReminder([
      entry({ id: "sub-3", state: "queued", snapshot: frame({ exitCode: -1, queued: true }) }),
      entry({
        id: "sub-2",
        state: "running",
        // Live frame: startTime present — a naive formatter would derive elapsed from it.
        snapshot: frame({ exitCode: -1, startTime: Date.now() - 60_000 }),
      }),
    ])!;
    assert.match(text, /\n- sub-3 \(worker\) — queued — "Investigate flaky tests/);
    assert.match(text, /\n- sub-2 \(worker\) — running — "Investigate flaky tests/);
    // No seconds anywhere on live rows — byte-stability contract.
    assert.doesNotMatch(text, /\d+s/);
  });

  test("finished row freezes duration from elapsedMs", () => {
    const text = buildInboxReminder([
      entry({
        id: "sub-1",
        state: "finished",
        snapshot: frame({ exitCode: 0, elapsedMs: 192_000 }),
      }),
    ])!;
    assert.match(text, /\n- sub-1 \(worker\) — finished \(ran 3m12s\) — "Investigate flaky tests/);
  });

  test("budget-stopped finished row is flagged partial", () => {
    const text = buildInboxReminder([
      entry({
        id: "sub-1",
        state: "finished",
        snapshot: frame({ exitCode: 0, elapsedMs: 300_000, stopReason: "budget_exceeded" }),
      }),
    ])!;
    assert.match(text, /— finished, partial — budget exceeded \(ran 5m\) —/);
  });

  test("failed row carries the error preview, first line only", () => {
    const text = buildInboxReminder([
      entry({
        id: "sub-4",
        state: "failed",
        snapshot: frame({
          exitCode: 1,
          elapsedMs: 5_000,
          errorMessage: "provider timeout\nretry hint: check quota",
        }),
      }),
    ])!;
    assert.match(text, /— failed — provider timeout \(ran 5s\) —/);
    assert.doesNotMatch(text, /retry hint/);
  });

  test("cancelled row carries the cancel label, not failed", () => {
    const text = buildInboxReminder([
      entry({
        id: "sub-5",
        state: "failed",
        snapshot: frame({
          exitCode: 1,
          stopReason: "cancelled",
          elapsedMs: 7_000,
          errorMessage: "user: wrong direction after review",
        }),
      }),
    ])!;
    assert.match(text, /— cancelled — user: wrong direction after review \(ran 7s\) —/);
  });

  test("byte-stable: identical state produces identical text", () => {
    const entries = [
      entry({ id: "sub-1", state: "finished", snapshot: frame({ exitCode: 0, elapsedMs: 42_000 }) }),
      entry({ id: "sub-2", state: "running", snapshot: frame({ exitCode: -1, startTime: 123 }) }),
    ];
    assert.equal(buildInboxReminder(entries), buildInboxReminder(entries));
  });

  test("long task text is truncated to the shared 70-char preview cap", () => {
    const long = "x".repeat(120);
    const text = buildInboxReminder([entry({ id: "sub-9", state: "running", task: long })])!;
    assert.ok(text.includes(`"${"x".repeat(70)}..."`));
  });

  test("header explains pull-only collection semantics", () => {
    const text = buildInboxReminder([entry({ id: "sub-1", state: "running" })])!;
    assert.match(text, /^\[background subagent runs — results are pull-only for the model/);
    assert.match(text, /already collected\]/);
  });
});

describe("injectReminder", () => {
  const reminder = "[background subagent runs]\n- sub-1 (worker) — running";

  test("string content: reminder prepended, rest of transcript identical", () => {
    const messages = [
      { role: "user" as const, content: "original prompt", timestamp: 1 },
      { role: "assistant" as const, content: [{ type: "text" as const, text: "answer" }] },
    ];
    const out = injectReminder(messages as any, reminder);
    assert.equal(out.length, 2);
    assert.equal(out[0].role, "user");
    assert.equal((out[0] as any).content, `${reminder}\n\noriginal prompt`);
    assert.deepEqual(out[1], messages[1]);
  });

  test("block content: reminder becomes the first text block", () => {
    const messages = [
      {
        role: "user" as const,
        content: [
          { type: "text" as const, text: "original" },
          { type: "text" as const, text: "blocks" },
        ],
        timestamp: 1,
      },
    ];
    const out = injectReminder(messages as any, reminder);
    const content = (out[0] as any).content;
    assert.equal(content[0].type, "text");
    assert.equal(content[0].text, reminder);
    assert.equal(content.length, 3);
  });

  test("non-user first message: synthetic leading user message", () => {
    const messages = [{ role: "assistant" as const, content: [{ type: "text" as const, text: "hi" }] }];
    const out = injectReminder(messages as any, reminder);
    assert.equal(out.length, 2);
    assert.equal(out[0].role, "user");
    assert.equal((out[0] as any).content, reminder);
    assert.deepEqual(out[1], messages[0]);
  });

  test("empty transcript: single injected user message", () => {
    const out = injectReminder([] as any, reminder);
    assert.equal(out.length, 1);
    assert.equal(out[0].role, "user");
    assert.equal((out[0] as any).content, reminder);
  });

  test("input messages are not mutated", () => {
    const messages = [{ role: "user" as const, content: "original", timestamp: 1 }];
    injectReminder(messages as any, reminder);
    assert.equal(messages[0].content, "original");
  });
});
