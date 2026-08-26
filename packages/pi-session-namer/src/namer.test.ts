/**
 * Tests for side-agent session naming: output limits, name cleaning,
 * instruction placement, per-message truncation, and message windowing.
 * Run: node --test packages/pi-session-namer/src/namer.test.ts
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { generateSessionName } from "./namer.ts";
import type { SessionNamerConfig } from "./types.ts";

const BASE_CONFIG: SessionNamerConfig = { enabled: true, sideAgentRole: "utility", maxLength: 0 };

function fakeRolesApi(reply: string, capture?: { content?: string }) {
  return {
    async completeWithRole(
      _role: string,
      params: { messages: { content: string }[] },
    ) {
      if (capture) capture.content = params.messages[0].content;
      return { content: [{ type: "text", text: reply }] };
    },
  };
}

async function generatedName(maxLength: number): Promise<string> {
  const config: SessionNamerConfig = { ...BASE_CONFIG, maxLength };
  return generateSessionName(fakeRolesApi("A descriptive generated session title") as any, "utility", config, {
    userMessages: ["Name this session"],
  });
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

test("session namer throws when no user messages are given", async () => {
  await assert.rejects(
    generateSessionName(fakeRolesApi("Title") as any, "utility", BASE_CONFIG, {
      userMessages: ["   "],
    }),
    /no user messages/,
  );
});

test("session namer strips echoed XML wrapper tags", async () => {
  assert.equal(
    await generateSessionName(fakeRolesApi("<title>Fix login bug</title>") as any, "utility", BASE_CONFIG, {
      userMessages: ["Name this session"],
    }),
    "Fix login bug",
  );
});

test("session namer strips nested XML wrapper tags", async () => {
  assert.equal(
    await generateSessionName(
      fakeRolesApi("<assistant_reply><title>Fix login bug</title></assistant_reply>") as any,
      "utility",
      BASE_CONFIG,
      { userMessages: ["Name this session"] },
    ),
    "Fix login bug",
  );
});

test("session namer puts the naming instruction in the user turn", async () => {
  const capture: { content?: string } = {};
  await generateSessionName(fakeRolesApi("Title", capture) as any, "utility", { ...BASE_CONFIG, maxLength: 50 }, {
    userMessages: ["Name this session"],
  });
  const captured = capture.content!;

  // The direct instruction must precede the tagged messages, so weak models
  // read the tags as data instead of a request to answer.
  const tagIdx = captured.indexOf("<user_message");
  assert.ok(tagIdx > 0, "instruction should precede the tagged messages");
  const head = captured.slice(0, tagIdx).toLowerCase();
  assert.ok(head.includes("name the coding session"));
  assert.ok(head.includes("max 50 characters"));
  assert.ok(head.includes("not a request to fulfill"));
});

test("session namer keeps wrapper tags closed when truncating long messages", async () => {
  const capture: { content?: string } = {};
  await generateSessionName(fakeRolesApi("Title", capture) as any, "utility", BASE_CONFIG, {
    userMessages: ["x".repeat(5000)],
  });
  const captured = capture.content!;

  assert.ok(captured.includes("<user_message"));
  const open = captured.indexOf("<user_message");
  const close = captured.indexOf("</user_message>");
  assert.ok(close > open, "closing tag must follow the opening tag");
  // The message body must respect the per-message budget, not the raw length.
  assert.ok(captured.length < 1000, `packed prompt should be small, got ${captured.length} chars`);
});

test("session namer packs all messages when within the window limit", async () => {
  const capture: { content?: string } = {};
  await generateSessionName(fakeRolesApi("Title", capture) as any, "utility", BASE_CONFIG, {
    userMessages: Array.from({ length: 10 }, (_, i) => `message ${i + 1}`),
  });
  const captured = capture.content!;

  for (let i = 1; i <= 10; i++) {
    assert.ok(captured.includes(`index="${i}"`), `message ${i} should be packed`);
  }
  assert.ok(!captured.includes("messages omitted"), "no omission marker under the limit");
});

test("session namer windows to first and last messages when over the limit", async () => {
  const capture: { content?: string } = {};
  const messages = Array.from({ length: 12 }, (_, i) => `message ${i + 1}`);
  await generateSessionName(fakeRolesApi("Title", capture) as any, "utility", BASE_CONFIG, {
    userMessages: messages,
  });
  const captured = capture.content!;

  // First 5 and last 5 kept, with original 1-based indexes.
  for (const i of [1, 2, 3, 4, 5, 8, 9, 10, 11, 12]) {
    assert.ok(captured.includes(`index="${i}"`), `message ${i} should be kept`);
  }
  // Middle messages elided with a marker between the windows.
  for (const i of [6, 7]) {
    assert.ok(!captured.includes(`index="${i}"`), `message ${i} should be elided`);
  }
  assert.ok(captured.includes("(2 messages omitted)"), "omission marker should be present");
  // Marker must sit between the two windows.
  const lastFirstWindow = captured.indexOf('index="5"');
  const marker = captured.indexOf("(2 messages omitted)");
  const firstLastWindow = captured.indexOf('index="8"');
  assert.ok(lastFirstWindow < marker && marker < firstLastWindow);
});
