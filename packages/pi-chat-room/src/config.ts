/**
 * Read chatRoom configuration from settings files.
 *
 * Reads global (~/.pi/agent/settings.json) and project-level (.pi/settings.json)
 * settings; a present project `chatRoom` block replaces the global block
 * entirely, and omitted fields fall back to DEFAULT_CONFIG.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DEFAULT_CONFIG, type ChatRoomConfig, type DeliveryMode } from "./types.ts";

/** Get the pi agent directory path. Honors PI_AGENT_DIR override. */
function getAgentDir(): string {
  const envDir = process.env.PI_AGENT_DIR;
  if (envDir) return envDir;
  return path.join(os.homedir(), ".pi", "agent");
}

/** Read and parse a settings.json file. Returns parsed object or {}. */
function readSettingsFile(filePath: string): any {
  try {
    if (!fs.existsSync(filePath)) return {};
    const content = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(content);
  } catch {
    return {};
  }
}

const VALID_MODES: ReadonlySet<DeliveryMode> = new Set(["steer", "followUp"]);

function asDeliveryMode(value: unknown): DeliveryMode | undefined {
  return typeof value === "string" && VALID_MODES.has(value as DeliveryMode)
    ? (value as DeliveryMode)
    : undefined;
}

/**
 * Load chatRoom config from project or global settings over defaults.
 * A present project `chatRoom` object replaces the global object entirely;
 * missing fields then fall back to DEFAULT_CONFIG.
 * @param cwd - Project working directory (for .pi/settings.json lookup)
 */
export function loadConfig(cwd?: string): ChatRoomConfig {
  const globalSettings = readSettingsFile(path.join(getAgentDir(), "settings.json"));
  const projectSettings = cwd ? readSettingsFile(path.join(cwd, ".pi", "settings.json")) : {};

  // A project chatRoom block replaces the global block as a whole. Fields
  // omitted from that selected block fall back to DEFAULT_CONFIG below.
  const globalRaw = globalSettings?.chatRoom;
  const projectRaw = projectSettings?.chatRoom;
  const raw = projectRaw ?? globalRaw ?? {};

  return {
    deliveryMode: asDeliveryMode(raw.deliveryMode) ?? DEFAULT_CONFIG.deliveryMode,
  };
}
