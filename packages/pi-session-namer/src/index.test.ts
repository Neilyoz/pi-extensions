/**
 * Tests for user-message collection from session branch entries.
 * Run: node --test packages/pi-session-namer/src/index.test.ts
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { collectUserMessages } from "./index.ts";

function msg(role: string, content: unknown, id = Math.random().toString(36).slice(2)) {
  return { type: "message", id, message: { role, content } };
}

test("collectUserMessages keeps only user text in chronological order", () => {
  const entries = [
    msg("user", "read the TODO"),
    msg("assistant", "here is the TODO content"),
    msg("user", "fix the auth middleware"),
    msg("assistant", [{ type: "text", text: "done" }]),
  ];
  assert.deepEqual(collectUserMessages(entries), ["read the TODO", "fix the auth middleware"]);
});

test("collectUserMessages skips slash commands and empty texts", () => {
  const entries = [
    msg("user", "/reload"),
    msg("user", "   "),
    msg("user", "/namer:rename"),
    msg("user", "real request"),
  ];
  assert.deepEqual(collectUserMessages(entries), ["real request"]);
});

test("collectUserMessages ignores tool-result blocks in user messages", () => {
  const entries = [
    msg("user", [{ type: "tool_result", toolCallId: "t1", content: "file contents" }]),
    msg("user", [{ type: "text", text: "what does it say?" }]),
  ];
  assert.deepEqual(collectUserMessages(entries), ["what does it say?"]);
});

test("collectUserMessages skips non-message entries", () => {
  const entries = [
    { type: "compaction", id: "c1" },
    msg("user", "hello"),
  ];
  assert.deepEqual(collectUserMessages(entries), ["hello"]);
});
