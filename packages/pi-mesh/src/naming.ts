/**
 * Identity derivation — stable, memorable names + IPC endpoint paths.
 *
 * The name is a PURE FUNCTION of the session id (hash → pool index), so the
 * same session always gets the same name — across /reload, across restarts,
 * across machines. No persistence needed: re-deriving is cheaper and can't
 * drift. PI_MESH_NAME still wins if set. Renameable at runtime via
 * MeshAPI.setName() (identity, not to be confused with profile).
 */

import { execSync } from "node:child_process";
import { defaultSockDir } from "./types.ts";

// Short, memorable names. Single-word so they collide rarely and read cleanly.
// Deterministically indexed by a hash of the session id (see deriveName), so
// the same session always gets the same name. ~3600 distinct combos:
// birthday-paradox collision only beyond ~70 sessions.
const ADJECTIVES = [
  "Amber", "Azure", "Bold", "Brave", "Bright", "Brisk", "Bronze", "Calm",
  "Clear", "Cool", "Coral", "Cosmic", "Crisp", "Dark", "Deep", "Dry",
  "Fair", "Fierce", "Fresh", "Frost", "Glass", "Gold", "Grand", "Hard",
  "High", "Indigo", "Iron", "Jade", "Keen", "Lone", "Lunar", "Mellow",
  "Merry", "Misty", "Mossy", "Neon", "Noble", "Olive", "Onyx", "Pale",
  "Prime", "Pure", "Quiet", "Rapid", "Rich", "Ruby", "Sandy", "Sharp",
  "Silver", "Slow", "Soft", "Solar", "Steady", "Steel", "Still", "Stone",
  "Stormy", "Sunny", "Swift", "Vast", "Vivid", "Warm", "Wet", "Wild",
  "Wise",
];
const NOUNS = [
  "Ash", "Aspen", "Badger", "Bear", "Bee", "Birch", "Brook", "Cedar",
  "Cliff", "Clover", "Crag", "Crane", "Creek", "Dick", "Doe", "Dune",
  "Elm", "Falcon", "Fern", "Finch", "Flax", "Fox", "Gale", "Glen",
  "Grove", "Hare", "Hawk", "Heron", "Holly", "Iris", "Juniper", "Lark",
  "Laurel", "Lotus", "Lynx", "Magpie", "Maple", "Marsh", "Meadow", "Moth",
  "Newt", "Oak", "Orchid", "Otter", "Owl", "Peak", "Pika", "Pine",
  "Pond", "Pussy", "Raven", "Reed", "Ridge", "River", "Robin", "Sage",
  "Seal", "Spruce", "Stoat", "Thyme", "Tide", "Vale", "Willow", "Wolf",
  "Wren",
];

/**
 * Derive a stable, memorable name from a session id.
 *
 * FNV-1a over the sessionId → two independent 16-bit indices. The same session
 * id always maps to the same name; PI_MESH_NAME overrides at the call site.
 */
export function deriveName(sessionId: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x811c9dc5;
  for (let i = 0; i < sessionId.length; i++) {
    const c = sessionId.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ (c + 0x9e3779b9), 0x01000193) >>> 0;
  }
  const adj = ADJECTIVES[h1 % ADJECTIVES.length] ?? "Mesh";
  const noun = NOUNS[h2 % NOUNS.length] ?? "";
  return noun ? `${adj}${noun}` : "Mesh";
}

/**
 * Build the IPC endpoint path for this session.
 *
 * On Windows we use a named pipe (`\\.\pipe\pi-mesh-<id>`) — Node/Bun's
 * `node:net` transparently uses named pipes when the path is in the
 * `\\.\pipe\` / `\\?\pipe\` namespace, and Windows removes the pipe
 * automatically when the owning process exits (no unlink needed).
 *
 * On POSIX we use a Unix domain socket file under the temp dir. macOS limits
 * UDS paths to ~104 chars (sun_path), so we fall back to /tmp if too long.
 */
export function makeSockPath(sessionId: string): string {
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\pi-mesh-${sessionId}`;
  }
  const candidate = `${defaultSockDir()}/pi-mesh-${sessionId}.sock`;
  if (candidate.length <= 100) return candidate;
  return `/tmp/pi-mesh-${sessionId}.sock`;
}

/** Best-effort current git branch for the working directory. */
export function getGitBranch(cwd: string): string | undefined {
  try {
    const out = execSync("git rev-parse --abbrev-ref HEAD", {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
      timeout: 2000,
    });
    const b = out.trim();
    return b || undefined;
  } catch {
    return undefined;
  }
}
