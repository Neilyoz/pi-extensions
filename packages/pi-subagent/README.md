# @d3ara1n/pi-subagent

Role-based subagent orchestration for [pi](https://github.com/earendil-works/pi).

Provides a `subagent_delegate` tool that lets the main model offload tasks to specialized pi child processes with configurable model roles, real-time TUI progress, and AI-generated summaries. Runs can be foreground (blocking) or background (asynchronous, collected later via `subagent_wait`/`subagent_check`).

## Design Philosophy

**The main model is the decision maker; subagents are executors.**

Your primary AI has the most complete context — it knows the full conversation history, project structure, and task at hand. Subagents are spawned with **clean, isolated contexts** to handle specific, well-defined tasks without polluting the main model's context window.

This means:
- **Subagents don't plan** — the main model decides what needs to be done and provides a clear task description
- **Subagents don't orchestrate the overall plan** — the main model decides what to do and examines each result to pick the next move; nested delegation (worker → explorer) only offloads self-contained exploration/research inside one task
- **Subagents don't inherit history** — they don't need the full conversation; just a precise task description
- **Multiple subagents can run in parallel** — emit multiple `subagent_delegate` calls in one turn; pi executes them concurrently
- **Subagents can nest subagents** — a `worker` can delegate exploration to `explorer` without returning to the main model

> This design currently focuses on single-task delegation rather than chain pipelines or context-forking — those patterns fit better when subagents act as advisors (planner, oracle) rather than executors.

## How it works

1. Main model calls the `subagent_delegate` tool with a role and task description
2. The extension resolves the role to a model via pi-model-roles
3. Spawns an isolated pi child process with the configured model, tools, and system prompt
4. **Real-time TUI progress** shows tool calls, turns, and elapsed time as the subagent runs
5. After completion, an **AI-generated one-line summary** is produced for compact display
6. Returns the result to the main model with usage statistics (turns, tokens, cost)

## Built-in Roles

| Role | Model Role | Timeout | Tools | Can Delegate To | Description |
|------|-----------|---------|-------|-----------------|-------------|
| `explorer` | fast | 900s | read, find, grep | — | Fast code search (read-only, no bash) |
| `reviewer` | heavy | 3600s | read, bash, grep, find | — | Deep code review (read-only, bash for git/log) |
| `worker` | default | 2400s | read, bash, edit, write, grep, find, delegate | explorer, researcher | Implementation — the only role that can modify files |
| `researcher` | fast | 2400s | web_search, fetch_content, read, bash, delegate | explorer | Web research + GitHub repo analysis |

**Nested delegation**: `worker` and `researcher` can spawn their own subagents. This keeps the main model's context clean — a worker can explore unfamiliar code via an `explorer` subagent without returning intermediate results to the main model.

**Parallel execution**: To run multiple subagents concurrently, emit multiple `subagent_delegate` calls in a single turn. Pi's framework executes them in parallel automatically, with each subagent getting its own TUI progress display.

## TUI Display

- **During execution**: the task's first line with a ⏳ (or ⏸ queued) indicator, a live stream of thinking blocks and tool calls (latest 5 collapsed, everything expanded), and a usage line (elapsed/budget time, turns, tokens, peak context, cost, model)
- **Collapsed result**: the task's first line, then `✓` + the AI-generated summary (or the first line of the output), then the usage line — no activity replay
- **Expanded result** (Ctrl+O): reference files, context size, the full task, the complete activity stream, the final output as rendered Markdown, and usage details
- **Fallback trace**: when a provider error (429, quota, timeout, ...) kills a run and it is retried on the role's `fallbackRole`, a `⚠ fallback: first attempt <model> failed (<reason>)` line appears in both views — also while the retry is running (see [Fallback observability](#fallback-observability))

## Commands

| Command | Description |
|---------|-------------|
| `/subagent:doctor` | Diagnose pi invocation, model-role resolution, configuration, and role references |
| `/subagent:status` | List background subagent runs and their current state |

## Dependencies

- [`@d3ara1n/pi-model-roles`](../pi-model-roles) — model role resolution

## Installation

```bash
pi install npm:@d3ara1n/pi-model-roles
pi install npm:@d3ara1n/pi-subagent
```

Or add to `~/.pi/agent/settings.json`:

```jsonc
{
  "extensions": [
    "/absolute/path/to/pi-extensions/packages/pi-model-roles",
    "/absolute/path/to/pi-extensions/packages/pi-subagent"
  ]
}
```

## Configuration

Edit `~/.pi/agent/settings.json`:

```json
{
  "subagent": {
    "maxConcurrency": 4,
    "maxDepth": 3,
    "maxTurns": 0,
    "maxCost": 0,
    "history": {
      "enabled": true
    },
    "summary": {
      "role": "utility",
      "enabled": true
    }
  }
}
```

All fields are optional. Defaults: `maxConcurrency: 4`, `maxDepth: 3`, `maxTurns: 0` (unlimited), `maxCost: 0` (unlimited), `history.enabled: true`, `summary.role: "utility"`, `summary.enabled: true`.

Timeouts are defined per role. Built-in defaults are `explorer: 900`, `reviewer: 3600`, `worker: 2400`, and `researcher: 2400` seconds. The timeout is active time — the clock pauses while the child is inside a nested `subagent_delegate` call, so delegate-capable roles need no extra headroom.

All numeric limits accept `0` for unlimited: `maxConcurrency`, `maxDepth`, `maxTurns`, `maxCost`, and per-role `timeout`. Negative values are normalized to `0`; non-numeric or non-finite values fall back to their defaults. `maxConcurrency: 0` runs delegates without queuing, and `maxDepth: 0` permits unrestricted nesting.

### Agent Overrides

Override, disable, or add subagent roles via `agentOverrides`. Built-in and custom roles are treated equally — all descriptions, examples, and decision triggers feed into the LLM's prompt dynamically.

```json
{
  "subagent": {
    "agentOverrides": {
      "worker": {
        "role": "heavy",
        "timeout": 1500,
        "maxTurns": 50,
        "maxCost": 1.0
      },
      "reviewer": {
        "disabled": true
      },
      "tester": {
        "role": "default",
        "description": "Test automation & QA — write and run tests, validate fixes. Tools: read, bash, edit, write, grep. Can delegate to explorer.",
        "examples": [
          "Write unit tests for the auth module",
          "Run the test suite and fix failing tests"
        ],
        "decisionTrigger": "Task writes or runs tests?",
        "tools": ["read", "bash", "edit", "write", "grep"],
        "systemPrompt": "QA engineer. Write tests, run them, fix failures. After each change, re-run affected tests."
      }
    }
  }
}
```

**Required fields for custom roles:** `role`, `description`, `examples`, `decisionTrigger`, `tools`, `systemPrompt`.

**Optional fields:** `subagentRoles` (roles this role can spawn via delegate), `timeout` (per-role active-time timeout in seconds; unset or `0` is unlimited, negative values normalize to `0`), `maxTurns` / `maxCost` (per-role budget overrides; unset uses the top-level `maxTurns` / `maxCost` setting, `0` is unlimited, negative values normalize to `0`), `fallbackRole` (backup pi-model-roles role the whole run is retried on after a provider error; unset means no retry — see [Fallback observability](#fallback-observability)).

Invalid custom roles (missing required fields) are silently skipped with an error notification at session start.

## Usage (by the main model)

Delegate tasks that would generate many tool calls or verbose output to keep your own context clean:

```json
{
  "role": "explorer",
  "task": "Find all files that import the ModelRegistry and trace how they use it"
}
```

**Role-specific examples:**

| Role | Example task | Why delegate? |
|------|-------------|---------------|
| `explorer` | `"Map the routing structure of src/api/"` | You only need the conclusion, not every grep result |
| `reviewer` | `"Review error handling in auth.ts for security issues"` | Review output is longform; keep it isolated |
| `worker` | `"Rename all snake_case fields to camelCase in src/models/"` | Your context stays focused on high-level intent |
| `researcher` | `"Find the React 19 migration guide and summarize breaking changes"` | Search results are noisy; get a clean summary |

**Parallel usage:** emit multiple `subagent_delegate` calls in a single turn:

```json
[
  { "role": "explorer", "task": "Map the repository structure" },
  { "role": "researcher", "task": "Find latest docs on the library used here" }
]
```

## Background Delegation

Foreground and background delegation share one async run engine — foreground is simply background-but-blocking. With `background: true`, `subagent_delegate` returns immediately with a run id, and two companion tools collect the outcome:

| Tool | Purpose | Returns to the model |
|------|---------|---------------------|
| `subagent_delegate(background: true)` | Start an async run | Just the id (`sub-N`) |
| `subagent_wait(ids?, timeout_ms?)` | Block until **all** listed runs finish (omit `ids` for all current background runs) | Statuses only, one `id (role): finished/failed` line per run — never results; errors when the timeout hits with runs unfinished |
| `subagent_check(id)` | One-shot snapshot of a single run | `queued` / `running` + current activity / the **full output** once finished / failure reason + partial output. Checking a terminal run **collects** it: the output is returned once and the run leaves the registry |

Typical flow:

```json
[
  { "role": "worker", "task": "Implement the export module", "background": true },
  { "role": "researcher", "task": "Find the CSV escaping spec", "background": true }
]
```

…continue other work, then:

```json
{ "ids": ["sub-1", "sub-2"] }
```

(call `subagent_wait`), and finally `subagent_check` each finished id to fetch its result. `subagent_check` accepts one id per call because results can be large.

Semantics worth knowing:

- **Background runs survive turn cancellation** and are unaffected by a cancelled `subagent_wait` — cancelling the wait never cancels the runs; call `subagent_wait` or `subagent_check` again later.
- **Read-once collection:** `subagent_check` on a terminal run returns the result and frees it — the output now lives in the conversation history, and only a lightweight tombstone stays in the registry (`/subagent:status` lists it under "Collected"). Re-checking a collected id explains that its result is already in the history.
- **Inbox reminder:** every LLM call carries a `[background subagent runs]` system reminder listing the unclaimed runs (queued, running, and finished-but-unchecked alike), injected at a cache-stable head position. Runs missing from the list were already collected — so a finished run the model forgot to check keeps surfacing until it does.
- **`timeout_ms` is optional.** Without it, `subagent_wait` blocks until every run finishes; each run is still bounded by its own role timeout.
- Background runs share the global `maxConcurrency` gate — extra runs show up as `queued` in wait/check views.
- **Top-level only:** nested subagents cannot delegate in the background (a subagent process exits when its task finishes, which would orphan the run).
- The run registry lives in the pi process: a `/reload` or restart orphans in-flight background runs (their ids stop resolving). `/subagent:status` lists every registered run (active + collected) and its current state.

### Background TUI display

Each tool row renders one aspect of the same decomposition the foreground row shows all at once (input · process · result · usage):

- **Background subagent_delegate row = input only.** Collapsed: `▶ sub-1 <task first line>`. Expanded: plus `@file` references, context size, and the full task text. Static — the run progresses invisibly until a subagent_wait/subagent_check row picks it up.
- **subagent_wait row = process + usage.** One block per watched run: status line (`⏸ queued / ⏳ running` + id + task preview; bare, icon-free once terminal), a live activity stream (collapsed keeps the latest 5 items with a leading ellipsis; expanded shows everything) and a ticking usage bar. Once a run finishes, its process stream is replaced by a **status-only** result line (`✓ finished` / `⏲ budget-exceeded with the reason` / `✗ <reason>`) — the output itself never appears in a subagent_wait row; expanded keeps the full process stream instead. A timed-out wait freezes the view.
- **subagent_check row = the result view.** Same block shape as subagent_wait's single-run view (no id — there is only one), but the result line shows `✓ <AI summary>` (or the budget/failure reason when the run stopped early) and the expanded view renders the **full output** — subagent_check is where the conclusion lives.

### Passing context and reference files

pi-subagent delivers context to the child as **independent channels**, never fused into the task string. This keeps the task an unambiguous directive and lets each channel be sized independently.

#### `context` (inline text)

Hand the subagent precise context — selected code, a prior delegate's result, a file list, a git diff — without inflating the `task` string. It's delivered as a separate channel:

```json
{
  "role": "worker",
  "task": "Add input validation to the login function",
  "context": "Current implementation (src/auth.ts:42-70):\n```ts\nasync function login(email, pw) { ... }\n```\nValidation must reject empty/invalid emails and enforce a min 8-char password."
}
```

The stored/displayed task stays as the original `task`. When small, `context` inlines as a `<context>` block; when large (over 8,000 chars) it spills to a temp file injected via `@file`, so a large context never drags a short task into a spill.

#### `files` (reference paths)

```json
{
  "role": "explorer",
  "task": "Report the public API of the auth module",
  "files": ["src/auth.ts", "src/auth.types.ts"]
}
```

Each path is injected as an independent `@file` attachment the subagent reads directly. **File contents stay out of your context window** — you pass only the paths. Prefer this over pasting file contents into `context`, since the child receives the content on its first turn without spending a tool call to read it.

### Budget enforcement

`maxTurns` / `maxCost` cap a run. When exceeded, the child is killed and the last completed output is returned with `stopReason: "budget_exceeded"`. Budget stops are **intentional finishes** — the output is partial but valid: the TUI marks the run with a ⏲ line stating the reason, `subagent_wait` reports `finished (budget exceeded — output is partial)`, and the tool result (and `subagent_check`) append a `--- Budget exceeded (...) ---` note so the model knows to treat the output as partial. Defaults are unlimited (`0`); set global defaults in config or per-role overrides in `agentOverrides`. Negative values are normalized to `0`.

### Oversized outputs

When a run's output exceeds the size limit (50,000 chars), pi-subagent first tries to **compress** it with the summary model (same role configured under `summary.role`) into a compact form that preserves conclusions, code, file paths, and errors. If compression fails or doesn't shrink enough, it falls back to mechanical head+tail truncation. The prepared text is what the main model receives and what the expanded TUI renders; a hint line notes which method was used. The **full raw output is always kept in the history file** for auditing.

### Fallback observability

When a provider error (429, quota, timeout, ...) kills a run and the whole task is retried on the role's `fallbackRole`, the retry no longer hides the failure. The first attempt's model, stop reason, error message, and a stderr tail are snapshotted into `fallbackFrom` and surfaced everywhere: a `⚠ fallback:` line in the TUI (collapsed and expanded, including while the retry runs), a `--- fallback: ... ---` note in the tool result the main model reads (on success and failure alike — foreground delegate results and `subagent_check` snapshots), and a `fallbackFrom` field in the history file. When the child dies before its first message (e.g. an instant 429), the reason is recovered from stderr and the model name from what the parent requested.

### Run history

Every **spawned** delegate run is written (best-effort) to `~/.pi/subagent/history/{sessionId}/{toolCallId}.json` — finished, failed, and aborted alike (an aborted run already consumed tokens, so its partial activity and cost stay auditable). Records cover role, task, usage, activity log, the **full raw output** (even when the main model saw a compressed/truncated version), and the `fallbackFrom` snapshot when the run was retried on the fallback role. Runs that never spawned (cancelled while queued, role/model resolution failures) are not recorded. Useful for auditing what subagents did and how much they cost. Disable with `history.enabled: false`.

## License

MIT
