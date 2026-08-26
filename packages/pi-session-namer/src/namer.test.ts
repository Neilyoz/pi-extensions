/**
 * Regression tests for session-name cleaning limits.
 * Run: node --test packages/pi-session-namer/src/namer.test.ts
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { generateSessionName } from "./namer.ts";
import type { SessionNamerConfig } from "./types.ts";

async function generatedName(maxLength: number): Promise<string> {
  const rolesApi = {
    async completeWithRole() {
      return { content: [{ type: "text", text: "A descriptive generated session title" }] };
    },
  };
  const config: SessionNamerConfig = { enabled: true, sideAgentRole: "utility", maxLength };
  return generateSessionName(rolesApi as any, "utility", config, { user: "Name this session" });
}

test("session namer treats zero length as unlimited", async () => {
  assert.equal(await generatedName(0), "A descriptive generated session title");
});

test("session namer treats negative length as unlimited", async () => {
  assert.equal(await generatedName(-10), "A descriptive generated session title");
});

test("session namer honors small positive hard limits without ellipsis overflow", async () => {
  assert.equal(await generatedName(1), "A");
  assert.equal(await generatedName(2), "A ");
  assert.equal(await generatedName(3), "A d");
  assert.equal(await generatedName(4), "A...");
});

test("session namer strips echoed XML wrapper tags", async () => {
  const rolesApi = {
    async completeWithRole() {
      return { content: [{ type: "text", text: "<assistant_reply>Fix login bug</assistant_reply>" }] };
    },
  };
  const config: SessionNamerConfig = { enabled: true, sideAgentRole: "utility", maxLength: 0 };
  assert.equal(
    await generateSessionName(rolesApi as any, "utility", config, { user: "Name this session" }),
    "Fix login bug",
  );
});

test("session namer strips nested XML wrapper tags", async () => {
  const rolesApi = {
    async completeWithRole() {
      return {
        content: [{ type: "text", text: "<assistant_reply><title>Fix login bug</title></assistant_reply>" }],
      };
    },
  };
  const config: SessionNamerConfig = { enabled: true, sideAgentRole: "utility", maxLength: 0 };
  assert.equal(
    await generateSessionName(rolesApi as any, "utility", config, { user: "Name this session" }),
    "Fix login bug",
  );
});

test("session namer puts the naming instruction in the user turn", async () => {
  let captured = "";
  const rolesApi = {
    async completeWithRole(_role: string, params: { messages: { content: string }[] }) {
      captured = params.messages[0].content;
      return { content: [{ type: "text", text: "Title" }] };
    },
  };
  const config: SessionNamerConfig = { enabled: true, sideAgentRole: "utility", maxLength: 50 };
  await generateSessionName(rolesApi as any, "utility", config, { user: "Name this session" });

  // The direct instruction must precede the tagged exchange, so weak models
  // read the tags as data instead of a request to answer.
  const tagIdx = captured.indexOf("<user_message>");
  assert.ok(tagIdx > 0, "instruction should precede the tagged exchange");
  const head = captured.slice(0, tagIdx).toLowerCase();
  assert.ok(head.includes("name the coding session"));
  assert.ok(head.includes("max 50 characters"));
  assert.ok(head.includes("not a request to fulfill"));
});

test("session namer keeps wrapper tags closed when truncating long replies", async () => {
  let captured = "";
  const rolesApi = {
    async completeWithRole(_role: string, params: { messages: { content: string }[] }) {
      captured = params.messages[0].content;
      return { content: [{ type: "text", text: "Title" }] };
    },
  };
  const config: SessionNamerConfig = { enabled: true, sideAgentRole: "utility", maxLength: 0 };
  await generateSessionName(rolesApi as any, "utility", config, {
    user: "Name this session",
    assistant: "x".repeat(5000),
  });

  assert.ok(captured.includes("<user_message>"));
  assert.ok(captured.includes("</user_message>"));
  assert.ok(captured.includes("<assistant_reply>"));
  assert.ok(captured.includes("</assistant_reply>"));
  // Closing tags must appear after their opening counterparts.
  assert.ok(captured.indexOf("</assistant_reply>") > captured.indexOf("<assistant_reply>"));
});
