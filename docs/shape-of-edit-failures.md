# The Shape of Edit Failures

*What hashline-style editing actually buys you — and what it doesn't.*

> "They all rely on the model reproducing content it already saw. When it can't — and it often can't — the user blames the model."
>
> — can1357, [*The Harness Problem*](https://blog.can.ac/2026/02/12/the-harness-problem/), February 2026

That diagnosis landed hard, and it deserved to. Every edit format of the era — Claude Code's `str_replace`, Codex's `apply_patch`, the whole family — asks the model to retype the code it wants to change, character-perfect, whitespace included. A model that misremembers one indentation level fails the edit, retries from the same wrong memory, and burns turns in a loop. can1357's fix was **hashline**: tag lines with content hashes at read time, let the model *cite* lines instead of retyping them, and reject any edit whose anchor no longer matches the live file. The line everyone remembers: "You're blaming the pilot for the landing gear."

I maintain a hashline-style editor of my own ([pi-hashline-edit](https://github.com/d3ara1n/pi-extensions/tree/main/packages/pi-hashline-edit)), and after months of real sessions I've come to believe the diagnosis is right but the prescription oversells. The data that convinced me is embarrassing for the format: on DeepSeek V4 Flash, my hashline editor fails on **more** edits than plain string replacement — roughly 80% versus 50% — yet every session finishes faster on hashline. Fewer failures is not what hashline delivers. What it delivers is failures that close in one round instead of spiraling.

The edit format doesn't decide whether a model fails. It decides **what a failure costs**. That distinction — the *shape* of a failure — is what this essay is about.

## Two shapes of failure

Watch what actually happens when DeepSeek V4 Flash fails an edit in each format.

**String replacement.** The model wants to change a line it read twenty minutes ago. It reconstructs the line from memory and sends it as `oldText`. The edit fails: *string not found*. Here is the crucial part — the error contains **no information about the file**:

```
Error: oldText not found in file.
```

That's all a failed match *can* return. The tool has no idea which of the file's thousand lines the model meant; a failed content match is anonymous, so there is nothing to send back but the refusal. The next move belongs to the model, and the model's only source of truth is the same memory that just produced the wrong `oldText`. It guesses again — slightly differently this time, drawn from the same corrupted memory — and fails for the same reason. A re-read would break the loop, but weak models don't reach for it; they tweak. Every retry re-rolls the same defect. Call this a **divergent failure**: the error source lives inside the model, the failure response never touches it, and the loop ends only when something external intervenes.

**Hashline.** The model cites line 12 by hash — `12#AB34` — and the line has drifted since the read. The edit fails, but look at what comes back:

```
Anchor mismatch: 1 rescued.
• op #1 replace anchor (line 12): content shifted to line 14.
  Resend this op with anchor { "line": 14, "hash": "9A2F" }.
```

The live file, distilled to exactly the spot the model pointed at, plus a fresh anchor that is *ready to resend verbatim*. The response is a self-contained repair kit. The retry doesn't consult the model's memory at all — the model can be wrong about everything, copy the anchor it is handed, and succeed. Call this a **convergent failure**: the failure response carries ground truth, so one round-trip closes the loop regardless of what the model misremembered.

The difference is not ergonomics. It's what the two formats are *able* to put in the error. An anchor names a line, so even a wrong anchor is **located** — the tool knows exactly where the model meant to point and can return ground truth for that spot. A failed string match is anonymous, so the tool can only refuse. Cite-by-reference makes failures locatable; locatable failures can return ground truth; ground truth makes retries converge.

This is why 80%-failure hashline beats 50%-failure string replacement on the same weak model. Failure rate measures how often you crash; shape measures how long the rescue takes.

## Three models, three verdicts

Shape theory wasn't a lab result. It came from watching the same three models work in both formats across months of real sessions — field notes, not a benchmark: one environment, my tasks, mid-2026. Directional, not statistical.

| Model | String replace | Hashline | Verdict |
|---|---|---|---|
| GLM 5.2 | Occasional not-found / whitespace friction | 100%, friction gone | The intended pairing |
| Kimi K3 | Excellent | Frequent fabricated anchors | Turn hashline off |
| DeepSeek V4 Flash | ~50% of edits fail; fixes take several rounds | ~80% fail; every fix takes one round | Keep hashline on |

GLM 5.2 is the case hashline essays sell, and it's real. A strong model with **anchor discipline** — it copies hashes verbatim from read output and never invents one — edits 100% cleanly by citation, and the last of the string-replace friction (the occasional misremembered whitespace battle) simply disappears. For this model the format is a strict upgrade.

Kimi K3 is the case that kills "hashline is universally better," because it inverts the DeepSeek pattern: a *stronger* model that is *worse* on hashline. On string replacement Kimi is excellent. On hashline it fabricates anchors — writes a hash it never saw, cites an anchor from the wrong region — and when verification rejects it, it fabricates another. Kimi is divergent on hashline and convergent on string-replace. The missing capability has nothing to do with coding intelligence: anchor discipline comes from training distribution, not raw ability. A model drilled on classic edit formats can be worse at citation editing than a weaker model that just follows the schema as given. omp hit the same wall and keeps an exclusion list — kimi, mimo, deepseek-v4-flash, step-3.7-flash, force-downgraded to plain replace; on a glm-5.1 issue full of wrong-line edits, can1357's own verdict was "ultimately this is a model thing." My field notes agree.

So the first amendment to the shape thesis: **shape is a property of the model × format pair, not of the format.** Before choosing an editor, ask which failure shape *this* model produces in *this* format — never which format wins benchmarks on average.

## The failure no format can see

There is a third failure class, and it is the worst of the three.

DeepSeek V4 Flash, asked to insert a line after an anchor, will sometimes copy the anchor line into the insert body as well. The toolcall is well-formed; the anchor verifies; the edit *succeeds*. The file now contains the line twice. No error, no warning, no signal — the corruption sank in silently, and nothing downstream will flag it, because as far as the protocol is concerned, nothing unusual happened.

This is a **semantic failure**: the model's *intent* was wrong, and intent is the one thing an edit protocol cannot verify. Anchors prove the model is pointing at the right place; they say nothing about whether it understood what the operation does. String replacement has the same blind spot in a different costume — a correctly-matched `oldText` replaced with a semantically wrong `newText` sails through just as silently. No format fixes this. The defenses live outside the edit protocol: tests, review, or a model that understands the operation.

The evidence that this is a model problem rather than a documentation problem is a controlled experiment I never meant to run: GLM 5.2 used `insert_after` correctly back when my tool's description didn't explain the operation at all. DeepSeek V4 Flash still misreads it with the schema explicitly saying "do NOT copy the anchor line into body." Prompt wording is not the variable. omp has fought the same family since its first hashline release — the day-one changelog already strips `LINE:HASH|` display prefixes that models pasted into replacement content, and a later "repair" incident silently swallowed pasted content and replaced a block opener with `}`. Same disease, different strain.

This is where I part ways with the harness-problem framing. can1357's line is "you're blaming the pilot for the landing gear." My field data says: sometimes it *is* the pilot. An edit format can price mechanical failures — retyping, drift, transcription — because those failures are locatable. Semantic failures are not locatable at all; they are invisible to every protocol. Hashline doesn't reduce them, doesn't catch them, doesn't price them. The model that misreads `insert_after` will misread it in any format you hand it.

## Hashline was born twice

To see why two hashline lineages exist at all, you need the history — because the format's most-cited version is not its current one.

Hashline first shipped in omp (Oh My Pi) on February 10, 2026: per-line content hashes in read output, JSON tool parameters, edits citing `LINE#HASH`. Two days later it became the default edit mode, with the blog post that named the harness problem. The results were real — across a 16-model benchmark, 14 models did better on hashline than on unified-diff patches; the weakest model went from 6.7% to 68.3% success; Grok 4 Fast spent 61% fewer output tokens once the retry loops died. The sole loser, notably, was a DeepSeek.

Then omp abandoned its own design. Within four months the per-line hashes were gone, replaced by a whole-file snapshot tag — one 4-hex hash over the entire file in a `[PATH#TAG]` header — and JSON gave way to a text patch language with a constrained-decoding grammar. The motivations are legible in the changelog: identical lines collide when only content is hashed; partial reads fingerprint lines the model never saw; per-line hashes tax every read of every file. The format then churned through at least five breaking generations in six months (JSON → sigil sections → verbs → `SWAP`/`DEL`/`INS` → `PUT`/`CUT`), and it remains the default today — for every model not on the exclusion list.

[pi-hashline-edit](https://github.com/d3ara1n/pi-extensions/tree/main/packages/pi-hashline-edit) is the other lineage: the abandoned road, completed. The two potholes that sank per-line hashing are filled. The line number is folded into the hash, so identical lines — blank lines, closing braces — never collide: uniqueness by construction. Verification stays surgical: only cited lines are re-verified against live content, and a drifted anchor triggers a ±15-line rescan that holds the original line number fixed and re-hashes each candidate; a unique hit comes back as a fresh anchor ready to resend. Unrelated changes elsewhere in the file never block the edit.

## Granularity decides the shape

The two lineages differ exactly where failures are handled, and the difference maps straight onto the shape thesis.

A whole-file tag is a coarse-grained lock — the same trade a database makes when it locks a table instead of a row. While the file is untouched, every anchor in every hunk is implicitly valid, and omp's recovery can even replay a stale patch by re-mapping lines through a diff. But the trigger is file-level: any drift anywhere — including regions the model never cited — invalidates the whole patch, and when recovery can't prove the mapping, the model is sent back to re-read. A weak model lives in that failure path: its own edits shift lines, it edits above stale reads, and each rejection costs a full re-grounding. One omp user measured DeepSeek Flash at 97.7% tag compliance and 90% edit success — the format is learnable — yet 68% of the remaining failures were staleness. That is presumably why omp's exclusion list sends deepseek-v4-flash back to plain replace: at file-level granularity its failures trend divergent, and replace at least fails on content the model can re-derive.

Line-level anchors are a fine-grained lock, and fine-grained locking suits weak models. Only what you cite is verified, so unrelated drift is not your failure; when a cited line has moved, the rescan usually converts the failure into a fresh anchor, and the response is a self-contained repair kit rather than a re-read order. Same model, opposite verdict: omp downgrades DeepSeek to replace; my field notes say keep it on hashline. Both are correct — the file-level coupling that makes DeepSeek divergent under omp's tag doesn't exist under per-line verification.

That is the sharpest form of the thesis: **verification granularity is the design axis that moves failure shape.** File-level buys strong completeness guarantees — nothing stale ever applies — at the price of coupling every failure to a whole-file re-grounding. Line-level buys independence — failures are located exactly where the model pointed — at the price of admitting edits to files that drifted in places nobody cited. Choose per model: the discipline to re-ground after every edit is cheap for a strong model and ruinous for a weak one.

## What the ecosystem learned the hard way

Six months of hashline in the wild also produced a casualty list, worth reading before building one.

**Silent success is worse than loud failure.** opencode's experimental port returned `Updated` for edits whose anchors were stale, while the change landed on the wrong lines or vanished entirely — "the agent receives Updated and continues, never knowing the change didn't persist." A verification layer with holes doesn't degrade to no verification; it manufactures false trust, because the agent stops checking. If you build a hashline editor, the invariant to protect is not the success rate — it's that a reported success is true.

**Repairs that hide the error prevent the learning.** omp's applier accreted silent repairs — boundary balancing, off-by-one keepers, lenient dialects — each fixing the result while hiding from the model that it erred. The prompt now literally instructs the model not to lean on the repairs. And one repair path, fed a malformed paste, silently deleted a statement and replaced a block opener with `}`. When the tool absorbs malformation, the model never receives the signal that would teach it; when the repair itself is wrong, the corruption is invisible. My plugin takes the conservative pole: reject, don't guess — overlapping ranges are refused rather than heuristically disambiguated. That costs a round-trip occasionally. It also means a success means what it says.

**Hash transcription is a universal weakness.** An independent four-model benchmark found the failure even strong models share: "It sees `483:d4` in the input, writes `483:3a` in the output. Every model does this, including Opus." Copying pseudo-random hex is a transcription task, and LLMs are bad at it. Line-level anchors survive this better than it sounds — a mis-transcribed hash still arrives with a line number, so the failure stays located and the response can carry the live content to re-anchor from — but no format should assume its hashes are copied correctly.

**Churn strands the ecosystem.** Five breaking format generations in six months left third-party ports speaking dead dialects: a Rust crate and several pi plugins still parse `SWAP`-era syntax, and one wrapper pinned omp's old engine and now patch-packages it. Even omp's own marketing page still describes the per-line design it abandoned in May. When your format is a protocol, stability is a feature; omp treated it as a product, and its imitators paid the bill.

**The anchor tax is real.** Hash-decorating every read costs tokens and attention on every file, edit or no edit — enough that the author of one early port later built the opposite design, verifying reads in the harness with no read decoration at all. A critique from a Rust port's issue tracker puts it plainly: "to edit, you must first learn our anchor format. This is a tax on every agent."

## What hashline actually buys

The final accounting.

It does not buy competence. DeepSeek V4 Flash fails 80% of its edits through my tool; anyone running it still gets to blame the model, and they're right to. can1357 wanted to stop users from blaming the model. My field data says keep the blame — the harness's job is not to absolve the pilot, but to make every mistake cheap enough to survive.

What it buys is a price on mechanical failure. Every failure a protocol can locate — drift, misremembering, mis-transcription — becomes a one-round repair, because the failure response carries ground truth and a ready-to-resend anchor. On a model with anchor discipline, it buys the disappearance of friction outright. On a weak model that follows schemas, it buys convergence: frequent failures, each costing one round. An independent benchmark concluded that "edit format is not the bottleneck" — model-to-model gaps dwarfed format-to-format gaps. My field notes agree, with one refinement: the format doesn't remove the bottleneck. It sets the exchange rate on passing through it.

What it cannot buy is semantic correctness. Intent errors are invisible to every protocol — anchors prove where you point, never what you mean. The defenses there are tests, review, or a better model.

The buying guide falls out of the shape thesis:

- **Model with anchor discipline** → hashline is a strict upgrade. *(GLM 5.2: occasional string-replace friction → 100%.)*
- **Strong model trained on string-replace, fabricates anchors** → turn hashline off; the built-in edit serves it better. *(Kimi K3. omp's exclusion list is this rule, automated.)*
- **Weak model that follows schemas but misremembers content** → keep hashline on; failures are frequent, each costs one round. *(DeepSeek V4 Flash — on line-level anchors.)*
- **Weak model on file-level anchors** → omp's own answer: downgrade to replace. Same model, different granularity, opposite verdict.

The landing-gear metaphor survives the data — but not the optimism attached to it. A good landing gear will not make a bad pilot good. It decides whether a mistake is a crash or a go-around, and that is worth a lot: a fleet where every mistake is a go-around completes more flights per hour than a fleet with fewer mistakes and more crashes. But the flying is still the pilot's. Choose the gear to match the pilot, audit the gear's success reports harder than its failure reports — and keep the blame where the data puts it.

---

## Sources & field notes

- can1357, [*The Harness Problem*](https://blog.can.ac/2026/02/12/the-harness-problem/) (Feb 2026); [omp](https://github.com/can1357/oh-my-pi) source, changelogs, and model exclusion list; issues [#3772](https://github.com/can1357/oh-my-pi/issues/3772) (DeepSeek Flash field data), [#2241](https://github.com/can1357/oh-my-pi/issues/2241) ("a model thing"), [#2081](https://github.com/can1357/oh-my-pi/issues/2081) (no-op loop).
- Independent benchmarks: [geometricagi, *AST Edits*](https://geometricagi.github.io/2026/04/02/ast-edits.html) (hash transcription, 4 models × 7 formats); [nwyin, *Hashline vs Replace*](https://nwyin.com/blogs/hashline-vs-replace-edit-bench.html) (language-dependent penalty, "not the bottleneck").
- [opencode #15424](https://github.com/anomalyco/opencode/issues/15424) (silent success); [quangdang46/hashline #46](https://github.com/quangdang46/hashline/issues/46) (anchor tax).
- My field notes: the [model-compatibility section](https://github.com/d3ara1n/pi-extensions/tree/main/packages/pi-hashline-edit#model-compatibility--field-notes) of pi-hashline-edit's README; the full omp investigation with per-claim citations lives in [`plans/omp-hashline-investigation.md`](../plans/omp-hashline-investigation.md).
