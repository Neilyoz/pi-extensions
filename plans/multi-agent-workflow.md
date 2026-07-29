# Multi-Agent Workflow: Assistant + Director on the pi Mesh

A two-instance workflow for pi that keeps a mid-tier model resident on the
full conversation while consulting a frontier model on demand with a compressed
slice — so both eat prompt-cache prices, and the expensive model's context
stays small.

> This is a *workflow* built on three composable plugins ([pi-mesh](../packages/pi-mesh),
> [pi-chat-room](../packages/pi-chat-room), [pi-peek-agent](../packages/pi-peek-agent)).
> The plugins provide capability; the workflow itself lives in **role prompts**,
> not in code.

## Why

Frontier models are expensive, and cost scales with context. A single agent
that carries the whole conversation — every clarification, tangent, and tool
dump — pays full price on all of it, every turn.

The usual fix is subagents: spawn a cheap model for research, discard its
context when done. But a subagent is **one-shot** — its context is thrown away,
so it never benefits from **prompt caching** (providers discount stable prefixes,
often to ~10% of input cost). Every subagent call re-pays full price to
re-establish context.

This workflow inverts the split:

> A **mid-tier model stays resident** and carries the full conversation (eating
> cache on it), while a **frontier model is consulted on demand** with a
> compressed, decision-relevant slice. Both are long-lived, both cache. The
> expensive model's context stays small because the assistant filters everything.

## Core idea: split by context type, not by capability

Two long-lived pi instances:

- **Assistant** (mid-tier, e.g. Sonnet / DeepSeek): talks to the user, carries
  the whole messy conversation, coordinates experts.
- **Director / experts** (frontier, e.g. Fable): never faces the user; receives
  only the compressed, decision-relevant task.

The assistant is a **context filter**, not just a router. It strips the noise
(back-and-forth, tangents) and hands the director only what a decision needs.
The director's context stays small and stable → cheap, and cached.

This is **not** "cheap model + subagent." The difference is where the bulk of
context lives:

| | Full context `T` carried by | Expensive model carries |
|---|---|---|
| Subagent (one-shot) | the expensive main agent itself | ≈ `T` (cached but large) |
| This workflow | the **cheap** assistant | `T_director` << `T` |

## Architecture

```
terminal A: pi (mid-tier)            terminal B: pi (frontier)
  role prompt = assistant              role prompt = director
  mesh + chat-room (+ peek)           mesh + chat-room (+ peek)
  mesh_set_profile(assistant)         mesh_set_profile(director)
  faces the user                      never faces the user
        │                                    │
        └──── send_to / [From:] ─────────────┘
```

Three composable, order-agnostic plugins:

- **pi-mesh** — peer discovery + transport + identity + self-declared profile.
  Neutral: knows nothing about roles.
- **pi-chat-room** — `send_to` tool; incoming messages arrive as `[From: NAME]`
  user messages.
- **pi-peek-agent** — `peek` tool; ask another instance without disturbing it
  (read-after-burn, answered by the side utility model).

Each is self-sufficient and combinable: mesh alone discovers peers and declares
roles; +chat-room adds messaging; +peek-agent adds consult. Load order in
`settings.json` is irrelevant.

## Key mechanisms

**1. The assistant compresses.** Anything bound for the director is filtered —
drop the user's rambling, keep only decision-relevant facts. The director never
sees `T`, only `T_director`.

**2. The director can call back.** Mid-task it can `send_to` the assistant for
more material, to confirm something with the user, or to fetch code. The
assistant serves it. This is why the channel is **asynchronous**, not
request/response: a synchronous escalate would deadlock the moment the director
asked back (the assistant would be blocked waiting on the director).

**3. Output dual-channel.** An LLM has no native notion of addressing one
audience vs another in a single output stream. So: the assistant's normal
output goes to the user; anything to another agent **must** go through
`send_to`. Enforced by the tool's `promptGuidelines` — the only reliable
multi-agent routing rule.

**4. Emergent workflow.** There is no `workflow.start()`. When instances
self-declare roles (`mesh_set_profile`) and start messaging, the workflow
exists. The mesh is a neutral transport; who-talks-to-whom and who-faces-the-user
are defined by each instance's role prompt. A hospital has many specialists;
this workflow generalizes to N experts, not just one director.

## Role prompts

**Assistant** (faces user, carries full context):

```
You are the assistant. You serve the user directly and coordinate other experts.

Rules:
- mesh_list to see who's online; mesh_get_profile to learn specialties; route by problem nature.
- Delegate heavy work (architecture, implementation, deep research, clean-context review) via send_to(name, message):
  · the message must be COMPRESSED — strip your back-and-forth with the user, keep only what the expert needs to decide/act
  · state clearly what you want
- When an expert replies ([From: name]): digest it, explain to the user in plain terms.
- When an expert asks you back mid-task (needs material, user confirmation, code fetched): comply, send_to the result back.
- Your normal output is for the user. Anything to another agent MUST go through send_to — never address an agent in your normal output.

You carry the conversation context; experts see only compressed tasks. That's the cost lever.
```

**Director / expert** (never faces user, compact context):

```
You are the director/expert. You take delegated work from the assistant; you never face the user.

Rules:
- On [From: assistant]: execute (decide/implement/analyze).
- Mid-task, if you need more material, user confirmation, or code: send_to(assistant, request). You don't need full context — ask back for what's missing.
- On completion: send_to(assistant, result) — make it complete enough that the assistant can relay it to the user.
- You don't face the user. All communication goes through send_to.

Your context holds only the assistant's compressed task. Focus on quality.
```

## Startup

```bash
# terminal A — assistant (mid-tier model)
pi   # load mesh + chat-room (+ peek); apply assistant prompt; mesh_set_profile(role="assistant", …)

# terminal B — director (frontier model)
pi   # same plugins; apply director prompt; mesh_set_profile(role="director", …)
```

Role prompts can be applied via `SYSTEM.md`, a pi prompt template (`/assistant`,
`/director`), or pasted at startup.

## A full round

```
user → assistant: "refactor auth, focus on security"
assistant: mesh_list → sees director; mesh_get_profile confirms specialty
assistant: send_to(director, "user wants auth refactor, security focus. code in src/auth/,
           key files X/Y, constraint Z. give a refactor plan.")        ← compressed
director: analyzing; finds a gap
director: send_to(assistant, "confirm: JWT or session? is legacy.ts still used?")   ← callback
assistant: [From: director] → asks user → "JWT"
assistant: send_to(director, "JWT. legacy.ts was removed last week.")
director: send_to(assistant, <refactor plan>)                         ← report
assistant: explains the plan to the user                              ← relay
```

This realizes the design: the assistant compresses, the director calls back,
both cache, the assistant relays.

## Why it's cheaper

- **Cache.** Both instances are long-lived with stable prefixes → both eat cache
  prices. One-shot subagents don't.
- **Context transfer.** The expensive model carries `T_director` << `T`. The
  bulk lives on the cheap model.
- **No re-derivation.** The assistant doesn't re-explain background on every
  delegation — it lives in the director's cached context.

Breakeven: this beats single-agent-with-subagents when interaction is frequent
and tasks are related (shared prefix matters). For sparse, independent tasks,
one-shot subagents are simpler.

## A caveat on the assistant's capability

The assistant's job — *accurately* compressing context and routing — is itself a
judgment task. A truly cheap model that mis-filters or mis-routes will starve or
mislead the director. So the assistant is "mid-tier," not "cheap." The savings
still hold: even a Sonnet-class assistant carrying `T` is far cheaper than a
frontier model carrying `T`, and the frontier model only ever sees `T_director`.
