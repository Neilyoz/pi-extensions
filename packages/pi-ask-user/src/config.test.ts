/**
 * Tests for pi-ask-user settings loading (config.ts).
 * Run: node --test packages/pi-ask-user/src/config.test.ts
 *
 * Uses PI_AGENT_DIR to redirect the "global" settings location into a temp
 * dir, so tests never touch the real ~/.pi/agent/settings.json.
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DEFAULT_CONFIG, formatKeyId, loadConfig } from "./config.ts";

let agentDir: string;
let projectDir: string;
const previousAgentDir = process.env.PI_AGENT_DIR;

function writeSettings(dir: string, obj: unknown): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify(obj));
  fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify(obj));
}

function writeProjectSettings(obj: unknown): void {
  writeSettings(path.join(projectDir, ".pi"), obj);
}

beforeEach(() => {
  agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "ask-user-agent-"));
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "ask-user-project-"));
  process.env.PI_AGENT_DIR = agentDir;
});

afterEach(() => {
  fs.rmSync(agentDir, { recursive: true, force: true });
  fs.rmSync(projectDir, { recursive: true, force: true });
  if (previousAgentDir === undefined) delete process.env.PI_AGENT_DIR;
  else process.env.PI_AGENT_DIR = previousAgentDir;
});

test("no settings → defaults", () => {
  assert.deepEqual(loadConfig(projectDir), DEFAULT_CONFIG);
});

test("global askUser.toggleKey is honored", () => {
  writeSettings(agentDir, { askUser: { toggleKey: "ctrl+`" } });
  assert.equal(loadConfig(projectDir).toggleKey, "ctrl+`");
});

test("project askUser replaces global askUser entirely", () => {
  writeSettings(agentDir, { askUser: { toggleKey: "ctrl+`" } });
  writeProjectSettings({ askUser: { toggleKey: "ctrl+f1" } });
  assert.equal(loadConfig(projectDir).toggleKey, "ctrl+f1");
});

test("empty project askUser {} falls back to defaults, not to global values", () => {
  // Locked semantics: a present project block replaces the global block as a
  // whole (projectRaw ?? globalRaw), missing fields fall back to DEFAULT_CONFIG.
  writeSettings(agentDir, { askUser: { toggleKey: "ctrl+`" } });
  writeProjectSettings({ askUser: {} });
  assert.equal(loadConfig(projectDir).toggleKey, DEFAULT_CONFIG.toggleKey);
});

test("invalid toggleKey values fall back to the default", () => {
  for (const bad of [42, true, null, [], "", "   "]) {
    writeSettings(agentDir, { askUser: { toggleKey: bad } });
    assert.equal(
      loadConfig(projectDir).toggleKey,
      DEFAULT_CONFIG.toggleKey,
      `expected default for toggleKey = ${JSON.stringify(bad)}`,
    );
  }
});

test("non-object askUser blocks are ignored", () => {
  writeSettings(agentDir, { askUser: "ctrl+\\" });
  assert.deepEqual(loadConfig(projectDir), DEFAULT_CONFIG);
});

test("formatKeyId capitalizes modifier and key parts", () => {
  assert.equal(formatKeyId("ctrl+\\"), "Ctrl+\\");
  assert.equal(formatKeyId("shift+tab"), "Shift+Tab");
  assert.equal(formatKeyId("ctrl+shift+alt+x"), "Ctrl+Shift+Alt+X");
  assert.equal(formatKeyId("escape"), "Escape");
});
