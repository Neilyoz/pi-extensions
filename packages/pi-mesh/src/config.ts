/**
 * Read pi-mesh configuration from the `mesh` settings block.
 *
 * Project config replaces global wholesale; per-field `?? DEFAULT` fills any
 * gap. No field-level merge — consistent with pi's own config semantics and
 * pi-access-denied's tested behavior.
 */

import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { MeshConfig } from "./types.ts";
import { DEFAULT_MESH_CONFIG } from "./types.ts";

function getAgentDir(): string {
  const envDir = process.env["PI_AGENT_DIR"];
  if (envDir) return envDir;
  return path.join(os.homedir(), ".pi", "agent");
}

function readSettingsFile(filePath: string): any {
  // Standard JSON — parse directly, let errors degrade to {}. Never strip
  // comments with a regex: that silently truncates string literals containing
  // `//` (e.g. URLs) and leaves malformed JSON.
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(content);
  } catch {
    return {};
  }
}

/** Read the `mesh` block from a settings file. */
function readMesh(filePath: string): Record<string, any> | undefined {
  const raw = readSettingsFile(filePath)?.mesh;
  return raw && typeof raw === "object" ? raw : undefined;
}

function positiveNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * Load pi-mesh config. Project overrides global wholesale; per-field `?? DEFAULT`
 * fills any gap. (No field-level merge — project replaces global.)
 */
export function loadMeshConfig(cwd?: string): MeshConfig {
  const globalRaw = readMesh(path.join(getAgentDir(), "settings.json"));
  const projectRaw = cwd ? readMesh(path.join(cwd, CONFIG_DIR_NAME, "settings.json")) : undefined;
  const raw = projectRaw ?? globalRaw;
  if (!raw) return { ...DEFAULT_MESH_CONFIG };

  return {
    registryDir:
      typeof raw.registryDir === "string" && raw.registryDir.trim() ? raw.registryDir : undefined,
    heartbeatMs: positiveNumber(raw.heartbeatMs, DEFAULT_MESH_CONFIG.heartbeatMs),
  };
}
