/**
 * pi-ask-user configuration, read from settings files.
 *
 * Reads global (~/.pi/agent/settings.json) and project-level (.pi/settings.json)
 * settings and layers on built-in defaults. Mirrors the pattern used by other
 * extensions in this monorepo.
 *
 * Supported keys (KeyId format, same as ~/.pi/agent/keybindings.json):
 *   - toggleKey: collapse/expand the panel. Default "ctrl+\\".
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface AskUserConfig {
  /** KeyId for the collapse/expand toggle. See pi's keybindings.md for the format. */
  toggleKey: string;
}

export const DEFAULT_CONFIG: AskUserConfig = {
  toggleKey: "ctrl+\\",
};

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

/**
 * Load askUser config from project or global settings over defaults.
 * A present project `askUser` object replaces the global object entirely;
 * missing fields then fall back to DEFAULT_CONFIG.
 * @param cwd - Project working directory (for .pi/settings.json lookup)
 */
export function loadConfig(cwd?: string): AskUserConfig {
  const globalSettings = readSettingsFile(path.join(getAgentDir(), "settings.json"));
  const projectSettings = cwd ? readSettingsFile(path.join(cwd, ".pi", "settings.json")) : {};

  // A project askUser block replaces the global block as a whole. Fields
  // omitted from that selected block fall back to DEFAULT_CONFIG below.
  const globalRaw = globalSettings?.askUser;
  const projectRaw = projectSettings?.askUser;
  const raw = projectRaw ?? globalRaw ?? {};

  return {
    toggleKey:
      typeof raw.toggleKey === "string" && raw.toggleKey.trim().length > 0
        ? raw.toggleKey
        : DEFAULT_CONFIG.toggleKey,
  };
}

/**
 * Format a KeyId for display in hints: "ctrl+\\" → "Ctrl+\\", "shift+tab" → "Shift+Tab".
 * Used so the footer always shows the key that is actually bound.
 */
export function formatKeyId(keyId: string): string {
  return keyId
    .split("+")
    .map((part) => (part.length > 0 ? part.charAt(0).toUpperCase() + part.slice(1) : part))
    .join("+");
}
