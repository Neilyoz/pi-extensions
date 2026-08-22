/**
 * Unit tests for spawn-side pure logic.
 *
 *   node --test packages/pi-subagent/src/spawn.test.ts
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { composeInitialMessage } from "./spawn.ts";

describe("composeInitialMessage", () => {
  test("wraps reference files in <file> blocks ahead of context and task", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-sub-test-"));
    try {
      const fileA = path.join(dir, "a.md");
      fs.writeFileSync(fileA, "alpha content");
      const message = await composeInitialMessage([fileA], "some ctx", "do the thing");
      assert.equal(
        message,
        `<file name="${fileA}">\nalpha content\n</file>\n\n<context>\nsome ctx\n</context>\n\n<task>\ndo the thing\n</task>`,
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("omits absent channels and preserves relative block order", async () => {
    const message = await composeInitialMessage(undefined, undefined, "only a task");
    assert.equal(message, "<task>\nonly a task\n</task>");
    const ctxOnly = await composeInitialMessage(undefined, "ctx body", "");
    assert.equal(ctxOnly, "<context>\nctx body\n</context>");
  });

  test("unreadable files degrade to a placeholder instead of failing the run", async () => {
    const missing = path.join(os.tmpdir(), "pi-sub-test-does-not-exist.md");
    const message = await composeInitialMessage([missing], undefined, "t");
    assert.match(message, /^\[?<file name="/);
    assert.match(message, /failed to read file/);
    assert.match(message, /\n\n<task>\nt\n<\/task>$/);
  });

  test("blank (whitespace-only) context is dropped", async () => {
    const message = await composeInitialMessage(undefined, "   \n\t", "t");
    assert.equal(message, "<task>\nt\n</task>");
  });
});
