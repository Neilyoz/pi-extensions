/**
 * Tests for skill entry normalization.
 * Run: node --test packages/pi-scout/src/skill-inject.test.ts
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { toSkillEntries } from "./skill-inject.ts";

test("toSkillEntries maps the user-only flag without dropping skills", () => {
  const entries = toSkillEntries([
    { name: "llm-skill", description: "d1", filePath: "/a/SKILL.md" },
    { name: "user-only", description: "d2", filePath: "/b/SKILL.md", disableModelInvocation: true },
  ]);
  assert.deepEqual(entries, [
    { name: "llm-skill", description: "d1", filePath: "/a/SKILL.md" },
    { name: "user-only", description: "d2", filePath: "/b/SKILL.md", userOnly: true },
  ]);
});

test("toSkillEntries omits userOnly when the flag is absent or false", () => {
  const entries = toSkillEntries([
    { name: "absent", description: "d", filePath: "/a/SKILL.md" },
    { name: "false-flag", description: "d", filePath: "/b/SKILL.md", disableModelInvocation: false },
  ]);
  assert.equal(entries.length, 2);
  for (const e of entries) assert.equal("userOnly" in e, false);
});

test("toSkillEntries defaults missing description to empty string", () => {
  const entries = toSkillEntries([{ name: "s", filePath: "/p" }]);
  assert.deepEqual(entries, [{ name: "s", description: "", filePath: "/p" }]);
});
