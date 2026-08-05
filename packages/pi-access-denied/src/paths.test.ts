/**
 * Tests for path primitives, bash target extraction, and the PathManager.
 *
 * Zero-dependency: runs on node's built-in test runner.
 *   node --test src/paths.test.ts
 *
 * Node strips TS types natively (v22.6+ with --experimental-strip-types,
 * default since v23.6), so no transpile step is needed.
 *
 * ## Test layering
 *
 * The suite is split into four groups so CI matrix (linux/macos/windows)
 * actually exercises the right behavior per platform:
 *
 * 1. **Cross-platform pure functions** — run on ALL platforms. These test
 *    platform-agnostic helpers (toPosix, posixUnder, underRoot, …) and the
 *    injected-platform variants of isWinDeviceName / msysDrive, so Windows
 *    logic can be verified on any host by passing `platform: "win32"`.
 *
 * 2. **PathManager** — runs on ALL platforms. The longest-prefix-match
 *    decision engine operates on posix-normalized strings, so it can be
 *    exercised cross-platform with literal /aaa/bbb style rule sets. This is
 *    where the unified allow/deny policy (config + session + builtin) is
 *    validated, including the user's redirect use case.
 *
 * 3. **POSIX behavior** — skipped on win32. Tests bash target extraction
 *    (pure syntax recovery of escaping paths) under a POSIX cwd.
 *
 * 4. **Windows behavior** — skipped on non-win32. Exercises the full resolve →
 *    builtin → decide chain under the real `path.win32` module (Git Bash / MSYS
 *    path conventions). This is the only place MSYS drive translation and
 *    `/dev/null`→`\dev\null` normalization are validated end to end — they
 *    cannot be tested on a POSIX host because the global `path` module is
 *    locked to posix at startup.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as os from "node:os";
import * as path from "node:path";

import {
  builtinSafeRoots,
  isWinDeviceName,
  msysDrive,
  posixUnder,
  resolveTarget,
  toPosix,
  underRoot,
} from "./paths.ts";
import { PathManager } from "./path-manager.ts";

// Skip helpers: a truthy value becomes the skip reason shown in the report.
const SKIP_POSIX: true | undefined = process.platform === "win32" ? true : undefined;
const SKIP_WIN32: true | undefined = process.platform !== "win32" ? true : undefined;

// ────────────────────────────────────────────────────────────────────────────
// 1. Cross-platform pure functions (run everywhere)
// ────────────────────────────────────────────────────────────────────────────

describe("toPosix: separator normalization", () => {
  test("backslash form reduces to posix form", () => {
    assert.equal(toPosix("\\dev\\null"), "/dev/null");
    assert.equal(toPosix("\\tmp\\x"), "/tmp/x");
    assert.equal(toPosix("\\dev\\fd\\3"), "/dev/fd/3");
  });
  test("posix form is unchanged", () => {
    assert.equal(toPosix("/dev/null"), "/dev/null");
    assert.equal(toPosix("/tmp/x"), "/tmp/x");
  });
  test("windows drive paths get forward slashes", () => {
    assert.equal(toPosix("C:\\Users\\me"), "C:/Users/me");
  });
  test("string without backslashes is returned as-is", () => {
    assert.equal(toPosix("plain/path"), "plain/path");
    assert.equal(toPosix(""), "");
  });
});

describe("posixUnder: posix-style prefix check", () => {
  test("child path is under root", () => {
    assert.equal(posixUnder("/tmp/x", "/tmp"), true);
    assert.equal(posixUnder("/tmp/deep/nested", "/tmp"), true);
  });
  test("equal path is under root", () => {
    assert.equal(posixUnder("/tmp", "/tmp"), true);
  });
  test("the filesystem root covers every absolute path", () => {
    assert.equal(posixUnder("/", "/"), true);
    assert.equal(posixUnder("/etc/passwd", "/"), true);
  });
  test("Windows drive paths compare case-insensitively", () => {
    assert.equal(posixUnder("C:/Project/Src/file.ts", "c:/project"), true);
    assert.equal(posixUnder("c:/project", "C:/PROJECT"), true);
    assert.equal(posixUnder("C:/Project2/file.ts", "c:/project"), false);
  });
  test("sibling-prefix trap: /tmp2 is NOT under /tmp", () => {
    assert.equal(posixUnder("/tmp2", "/tmp"), false);
    assert.equal(posixUnder("/tm", "/tmp"), false);
  });
});

describe("underRoot: separator-agnostic prefix check", () => {
  test("child is under root, separators normalized", () => {
    assert.equal(underRoot("/a/b/c", "/a/b"), true);
    assert.equal(underRoot("\\a\\b\\c", "/a/b"), true); // backslash target
    assert.equal(underRoot("/a/b", "/a/b"), true); // equal
  });
  test("Windows drive paths are case-insensitive after separator normalization", () => {
    assert.equal(underRoot("C:\\Project\\src\\file.ts", "c:/project"), true);
    assert.equal(underRoot("C:/Project2/file.ts", "c:\\project"), false);
  });
  test("siblings and outside are not under root", () => {
    assert.equal(underRoot("/a/bc", "/a/b"), false); // sibling-prefix trap
    assert.equal(underRoot("/x/y", "/a/b"), false);
  });
});

describe("builtinSafeRoots: always-safe paths (builtin allow rules)", () => {
  const roots = builtinSafeRoots();
  test("includes pseudo-devices", () => {
    assert.ok(roots.includes("/dev/null"));
    assert.ok(roots.includes("/dev/stdin"));
    assert.ok(roots.includes("/dev/stdout"));
    assert.ok(roots.includes("/dev/stderr"));
    assert.ok(roots.includes("/dev/zero"));
    assert.ok(roots.includes("/dev/urandom"));
    assert.ok(roots.includes("/dev/random"));
  });
  test("includes /dev/fd prefix root (trailing slash stripped)", () => {
    assert.ok(roots.includes("/dev/fd"));
  });
  test("includes /tmp and os.tmpdir()", () => {
    assert.ok(roots.includes("/tmp"));
    assert.ok(roots.includes(toPosix(path.normalize(os.tmpdir()))));
  });
  test("does NOT include dangerous devices", () => {
    assert.ok(!roots.includes("/dev/tty")); // can capture keyboard input
    assert.ok(!roots.includes("/dev/sda1")); // block device
    assert.ok(!roots.includes("/dev/disk0"));
  });
  test("macOS /private/tmp symlink is covered", {
    skip: process.platform !== "darwin" ? true : undefined,
  }, () => {
    assert.ok(roots.includes("/private/tmp"));
  });
});

describe("isWinDeviceName: Windows reserved device names", () => {
  // Inject platform: "win32" lets us verify Windows logic on any host.
  test("NUL recognized in all positions", () => {
    assert.equal(isWinDeviceName("NUL", "win32"), true);
    assert.equal(isWinDeviceName("nul", "win32"), true); // case insensitive
    assert.equal(isWinDeviceName("C:\\proj\\NUL", "win32"), true); // under a path
    assert.equal(isWinDeviceName("NUL.txt", "win32"), true); // with extension
  });
  test("other reserved names", () => {
    assert.equal(isWinDeviceName("CON", "win32"), true);
    assert.equal(isWinDeviceName("AUX", "win32"), true);
    assert.equal(isWinDeviceName("PRN", "win32"), true);
    assert.equal(isWinDeviceName("COM1", "win32"), true);
    assert.equal(isWinDeviceName("COM9", "win32"), true);
    assert.equal(isWinDeviceName("LPT1", "win32"), true);
    assert.equal(isWinDeviceName("LPT9", "win32"), true);
  });
  test("ordinary files are not devices", () => {
    assert.equal(isWinDeviceName("C:\\proj\\file.txt", "win32"), false);
    assert.equal(isWinDeviceName("output.log", "win32"), false);
    assert.equal(isWinDeviceName("NULLVALUE", "win32"), false); // not an exact device name
  });
  test("returns false on non-win32 platforms", () => {
    assert.equal(isWinDeviceName("NUL", "darwin"), false);
    assert.equal(isWinDeviceName("NUL", "linux"), false);
  });
  test("defaults to process.platform (no-op on posix host)", () => {
    // On this host (posix CI), the default sees a non-win32 platform → false.
    assert.equal(isWinDeviceName("NUL"), process.platform === "win32");
  });
});

describe("msysDrive: Git Bash drive notation", () => {
  test("single-letter drive resolves to Windows form", () => {
    // path.win32.join used to build the expected value avoids hand-writing
    // backslashes that are easy to get wrong in source.
    assert.equal(msysDrive("/c/Users/me", "win32"), path.win32.join("C:\\Users", "me"));
    assert.equal(msysDrive("/c/proj/src", "win32"), path.win32.join("C:\\proj", "src"));
    assert.equal(msysDrive("/d/data", "win32"), path.win32.join("D:\\data"));
  });
  test("case insensitive (MSYS is posix=0)", () => {
    assert.equal(msysDrive("/C/Users", "win32"), path.win32.join("C:\\Users"));
    assert.equal(msysDrive("/E/foo", "win32"), path.win32.join("E:\\foo"));
  });
  test("bare drive (no trailing path)", () => {
    assert.equal(msysDrive("/c", "win32"), "C:\\");
  });
  test("MSYS built-in paths are NOT drives", () => {
    // /etc, /usr, /tmp, /dev, /var, /bin, /opt — multi-letter or special,
    // the `/x/` or `/x$` pattern does not match (the char after the letter
    // is another letter, not a separator).
    assert.equal(msysDrive("/etc/passwd", "win32"), null);
    assert.equal(msysDrive("/usr/bin", "win32"), null);
    assert.equal(msysDrive("/tmp/x", "win32"), null);
    assert.equal(msysDrive("/dev/null", "win32"), null);
    assert.equal(msysDrive("/var/log", "win32"), null);
    assert.equal(msysDrive("/bin/sh", "win32"), null);
    assert.equal(msysDrive("/opt/home", "win32"), null);
  });
  test("returns null on non-win32 platforms", () => {
    assert.equal(msysDrive("/c/Users/me", "darwin"), null);
    assert.equal(msysDrive("/c/Users/me", "linux"), null);
  });
  test("defaults to process.platform", () => {
    assert.equal(
      msysDrive("/c/Users/me"),
      process.platform === "win32" ? path.win32.join("C:\\Users", "me") : null,
    );
  });
  test("single-letter root /t is treated as drive T: (MSYS heuristics)", () => {
    assert.equal(msysDrive("/t", "win32"), "T:\\");
    assert.equal(msysDrive("/x/file", "win32"), path.win32.join("X:\\", "file"));
  });
});


// ────────────────────────────────────────────────────────────────────────────
// 2. PathManager — the single decision engine (longest-prefix-match)
//    Runs everywhere: rules are posix-normalized strings, so literal /aaa/bbb
//    rule sets exercise the algorithm without touching the host path module.
// ────────────────────────────────────────────────────────────────────────────

describe("PathManager: longest-prefix-match (the core algorithm)", () => {
  // The canonical example: a narrower rule always wins, regardless of
  // decision type or which layer it came from.
  //   allow /aaa/bbb   deny /aaa/bbb/ccc   deny /aaa
  test("the user's worked example", () => {
    const pm = new PathManager("/proj", ["/aaa/bbb"], {
      "/aaa/bbb/ccc": null,
      "/aaa": null,
    });
    assert.equal(pm.decide("/aaa/bbb/ddd").kind, "allow"); // allow /aaa/bbb (depth 2) beats deny /aaa (depth 1)
    assert.equal(pm.decide("/aaa/bbb/ccc/ddd").kind, "deny"); // deny /aaa/bbb/ccc (depth 3) is most specific
    assert.equal(pm.decide("/aaa/ccc").kind, "deny"); // deny /aaa (depth 1), no more specific allow
    assert.equal(pm.decide("/aaa/bbb").kind, "allow"); // exact allow rule
    assert.equal(pm.decide("/aaa/bbb/ccc").kind, "deny"); // exact deny rule
  });

  test("a sibling-prefix trap does not match", () => {
    const pm = new PathManager("/proj", ["/aaa/bbb"], {});
    // /aaa/bbbccd is NOT under /aaa/bbb (must be a path separator boundary)
    assert.equal(pm.decide("/aaa/bbbccd").kind, "outside");
  });
});

describe("PathManager: deny reason propagation (redirect use case)", () => {
  test("config deny surfaces its reason to the agent", () => {
    const pm = new PathManager("/proj", [], {
      "~/.config/X/data": "X 数据已迁到 ~/MyData/X，请用新位置",
    });
    const home = os.homedir();
    const d = pm.decide(path.join(home, ".config/X/data/oldfile"));
    assert.equal(d.kind, "deny");
    assert.equal(d.reason, "X 数据已迁到 ~/MyData/X，请用新位置");
  });

  test("null reason → deny with no reason field", () => {
    const pm = new PathManager("/proj", [], { "/old/y": null });
    const d = pm.decide("/old/y/sub");
    assert.equal(d.kind, "deny");
    assert.equal(d.reason, undefined);
  });

  test("empty-string reason is treated as no reason", () => {
    const pm = new PathManager("/proj", [], { "/old/z": "   " });
    const d = pm.decide("/old/z");
    assert.equal(d.kind, "deny");
    assert.equal(d.reason, undefined);
  });
});

describe("PathManager: builtin safe roots", () => {
  const pm = new PathManager("/proj", [], {});
  test("pseudo-devices are allowed", () => {
    assert.equal(pm.decide("/dev/null").kind, "allow");
    assert.equal(pm.decide("/dev/fd/3").kind, "allow");
    assert.equal(pm.decide("/dev/zero").kind, "allow");
  });
  test("/tmp and os.tmpdir() are allowed", () => {
    assert.equal(pm.decide("/tmp/anything").kind, "allow");
    assert.equal(pm.decide(path.normalize(os.tmpdir()) + "/sub/file").kind, "allow");
  });
  test("dangerous devices are NOT allowed", () => {
    assert.equal(pm.decide("/dev/tty").kind, "outside");
    assert.equal(pm.decide("/dev/sda1").kind, "outside");
  });
});

describe("PathManager: cwd + allowedPaths", () => {
  test("cwd and everything beneath it is allowed", () => {
    const pm = new PathManager("/home/me/proj", [], {});
    assert.equal(pm.decide("/home/me/proj").kind, "allow");
    assert.equal(pm.decide("/home/me/proj/src/foo.ts").kind, "allow");
  });
  test("a root cwd covers the entire filesystem, unless a deeper deny overrides it", () => {
    const pm = new PathManager("/", [], { "/private": "blocked" });
    assert.equal(pm.decide("/etc/passwd").kind, "allow");
    const denied = pm.decide("/private/data");
    assert.equal(denied.kind, "deny");
    assert.equal(denied.reason, "blocked");
  });
  test("sibling of cwd is outside (sibling-prefix trap)", () => {
    const pm = new PathManager("/home/me/proj", [], {});
    assert.equal(pm.decide("/home/me/proj2").kind, "outside"); // proj2 ≠ proj/...
    assert.equal(pm.decide("/home/me/other").kind, "outside");
  });
  test("configured allowedPaths expand the boundary", () => {
    const pm = new PathManager("/proj", ["/opt/data", "~/notes"], {});
    assert.equal(pm.decide("/opt/data/x").kind, "allow");
    assert.equal(pm.decide(path.join(os.homedir(), "notes/sub")).kind, "allow");
  });
  test("an uncovered path is 'outside' (needs authorization)", () => {
    const pm = new PathManager("/proj", [], {});
    assert.equal(pm.decide("/etc/passwd").kind, "outside");
  });
});

describe("PathManager: same-depth allow/deny conflict", () => {
  test("same path allowed AND denied → deny wins (safe default)", () => {
    // A config error (same path in both lists) resolves to deny.
    const pm = new PathManager("/proj", ["/a/b"], { "/a/b": "conflict" });
    const d = pm.decide("/a/b/c");
    assert.equal(d.kind, "deny");
    assert.equal(d.reason, "conflict");
  });
});

describe("PathManager: session rules override config (most specific wins)", () => {
  test("a session allow beneath a config deny wins for that subtree", () => {
    // config deny /a/b  ·  session allow /a/b/c
    //   /a/b/c/d → allow (session depth 3 > config depth 2)
    //   /a/b/d   → deny  (config depth 2, no more specific rule)
    const pm = new PathManager("/proj", [], { "/a/b": "blocked by config" });
    pm.addSessionAllow("/a/b/c");
    assert.equal(pm.decide("/a/b/c/d").kind, "allow");
    const d = pm.decide("/a/b/d");
    assert.equal(d.kind, "deny");
    assert.equal(d.reason, "blocked by config");
  });

  test("session deny with reason is cached and replayed", () => {
    const pm = new PathManager("/proj", [], {});
    pm.addSessionDeny("/secret/dir", "user said no");
    const d = pm.decide("/secret/dir/deep/file");
    assert.equal(d.kind, "deny");
    assert.equal(d.reason, "user said no");
  });

  test("clearSession forgets session rules but keeps config", () => {
    const pm = new PathManager("/proj", [], { "/cfg/deny": "config reason" });
    pm.addSessionAllow("/cfg/deny/sub");
    assert.equal(pm.decide("/cfg/deny/sub/x").kind, "allow"); // session overrides
    pm.clearSession();
    const d = pm.decide("/cfg/deny/sub/x");
    assert.equal(d.kind, "deny"); // back to config deny
    assert.equal(d.reason, "config reason");
  });
});

describe("PathManager: session rule subsumption", () => {
  test("adding a broader allow drops narrower allows beneath it", () => {
    const pm = new PathManager("/proj", [], {});
    pm.addSessionAllow("/a/b/c");
    pm.addSessionAllow("/a/b");
    const rules = pm.getRules().session.filter((r) => r.decision === "allow");
    assert.deepEqual(
      rules.map((r) => r.path),
      ["/a/b"],
    ); // /a/b/c dropped
  });
  test("adding a child under an existing parent allow is a no-op", () => {
    const pm = new PathManager("/proj", [], {});
    pm.addSessionAllow("/a/b");
    pm.addSessionAllow("/a/b/c");
    const rules = pm.getRules().session.filter((r) => r.decision === "allow");
    assert.deepEqual(
      rules.map((r) => r.path),
      ["/a/b"],
    );
  });
  test("a deny and an allow at different depths coexist (not subsumed)", () => {
    // Cross-decision rules are never dropped by subsumption — longest-prefix
    // match handles their interaction. Adding allow /a/b must NOT erase a
    // narrower deny /a/b/c.
    const pm = new PathManager("/proj", [], {});
    pm.addSessionDeny("/a/b/c", "secret");
    pm.addSessionAllow("/a/b");
    assert.equal(pm.decide("/a/b/c/d").kind, "deny"); // narrower deny still wins
    assert.equal(pm.decide("/a/b/d").kind, "allow"); // broader allow
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 4. Windows behavior (skipped on non-win32)
//    Exercises resolveTarget + builtinSafeRoots + decide under the real
//    path.win32 module. Expected values are built with path.win32.* to avoid
//    hand-writing backslashes that drift out of sync.
// ────────────────────────────────────────────────────────────────────────────

describe("Windows behavior (Git Bash / MSYS)", { skip: SKIP_WIN32 }, () => {
  const CWD = path.win32.join("C:", "proj");

  // ── resolveTarget: MSYS drive translation ──────────────────────────

  test("MSYS drive /c/... resolves to the Windows drive", () => {
    assert.equal(resolveTarget("/c/proj/src", CWD), path.win32.join("C:", "proj", "src"));
    assert.equal(resolveTarget("/d/data", CWD), path.win32.join("D:", "data"));
  });

  test("MSYS drive is case insensitive", () => {
    assert.equal(resolveTarget("/E/foo", CWD), path.win32.join("E:", "foo"));
  });

  test("bare /dev/null is not mistaken for a drive (no E: mapping)", () => {
    const resolved = resolveTarget("/dev/null", CWD);
    assert.ok(
      !resolved.startsWith(path.win32.join("D:", "ev")),
      `/dev/null must not resolve to a D: drive path, got: ${resolved}`,
    );
  });

  // ── builtin roots recognized after win32 normalization ───────────

  test("win32-normalized /dev/null is a builtin allow root", () => {
    // builtinSafeRoots are posix; targets come backslash-normalized from
    // resolveTarget. underRoot normalizes both sides, so they match.
    const resolved = resolveTarget("/dev/null", CWD);
    assert.ok(builtinSafeRoots().some((r) => underRoot(resolved, r)));
  });

  test("win32-normalized /tmp is a builtin allow root", () => {
    const resolved = resolveTarget("/tmp/build.log", CWD);
    assert.ok(builtinSafeRoots().some((r) => underRoot(resolved, r)));
  });

  test("win32-normalized /dev/fd/N is a builtin allow root", () => {
    const resolved = resolveTarget("/dev/fd/3", CWD);
    assert.ok(builtinSafeRoots().some((r) => underRoot(resolved, r)));
  });

  test("os.tmpdir() (%TEMP%) is a builtin allow root", () => {
    const tmpFile = path.win32.join(os.tmpdir(), "sub", "file");
    assert.ok(builtinSafeRoots().some((r) => underRoot(tmpFile, r)));
  });

  // ── PathManager decide under win32 ───────────────────────────────

  test("decide(): win32-normalized /dev/null → allow", () => {
    const pm = new PathManager(CWD, [], {});
    const resolved = resolveTarget("/dev/null", CWD);
    assert.equal(pm.decide(resolved).kind, "allow");
  });

  test("decide(): MSYS path under cwd is in-bounds", () => {
    const pm = new PathManager(CWD, [], {});
    const resolved = resolveTarget("/c/proj/src/foo.ts", CWD);
    assert.equal(pm.decide(resolved).kind, "allow");
  });

  test("decide(): MSYS path outside cwd → outside", () => {
    const pm = new PathManager(CWD, [], {});
    const resolved = resolveTarget("/c/Users/me/.ssh/config", CWD);
    assert.equal(pm.decide(resolved).kind, "outside");
  });

  test("decide(): Windows native NUL device → allow", () => {
    const pm = new PathManager(CWD, [], {});
    assert.equal(pm.decide("NUL").kind, "allow");
    assert.equal(pm.decide(path.win32.join(CWD, "NUL")).kind, "allow");
  });

});
