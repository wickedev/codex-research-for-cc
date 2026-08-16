# codex-research-for-cc

A Claude Code plugin that strengthens the built-in `/deep-research` workflow **before its
fan-out starts** — without overriding the workflow script.

Third sibling of [codex-goalkeeper-for-cc](https://github.com/wickedev/codex-goalkeeper-for-cc)
(gates *goal completion* at stop time) and
[codex-plankeeper-for-cc](https://github.com/wickedev/codex-plankeeper-for-cc)
(gates *plan quality* at submission time). Researchkeeper gates *research-question quality* at
launch time.

## Why

The built-in deep-research pipeline is Scope → Search fan-out → Fetch/Extract → 3-vote
adversarial Verify → Synthesize. Its verification layers are good — but they all run **after**
the fan-out, and the fan-out is entirely derived from the question text by a single Scope
agent whose output nobody reviews. Two consequences:

- **The question is the orchestration.** The Scope agent reads the question verbatim and
  derives every search from it. An angle that is not in the question text — a recency bound,
  the contrarian side, the primary source — may never be searched, and no downstream verifier
  can recover evidence that was never fetched.
- **Nothing steers before the budget is spent.** By the time adversarial verification kills a
  one-sided claim set, the searcher/fetcher budget is gone.

Researchkeeper moves quality enforcement to the cheapest point: before orchestration.

## How it works

Three layers, shallowest first:

```
you: do deep research on X
        │
        ▼  UserPromptSubmit hook (layer 1 — always on, no judge cost)
   injects the research-brief protocol: decompose into falsifiable sub-questions,
   state what evidence would change the answer, list implied-but-unstated angles,
   then pass an ENRICHED question to the workflow
        │
Claude writes the brief, calls Workflow({name: 'deep-research', args: enrichedQuestion})
        │
        ▼  PreToolUse hook on Workflow (layer 2 — Codex judge, fail-open)
   question-gate-hook.mjs
        ├─ not deep-research / resume / disabled / cap / judge broken → let through
        ├─ identical question already approved this session → let through instantly
        └─ codex exec, read-only sandbox
              ├─ APPROVE: … → workflow launches
              └─ REVISE: 1) … 2) … → deny; the fixes become Claude's instruction
                                      → Claude enriches the question → loop
        │
workflow starts: Scope agent decomposes the question into search angles
        │
        ▼  SubagentStop hook (layer 3 — EXPERIMENTAL, default off)
   scope-gate-hook.mjs recognizes the Scope agent's angles-shaped output,
   Codex reviews the decomposition, and a deficient angle list is blocked
   ONCE with concrete angles to add — before any searcher spawns
        │
fan-out proceeds with a reviewed question and a reviewed decomposition
```

Key mechanics:

- **Layer 1 works even if layer 2 never fires.** The enriched question it produces is what
  actually reaches the Scope agent, so the brief protocol alone already changes what gets
  searched.
- **Deny feeds Claude, not you.** A PreToolUse deny reason is delivered to Claude as feedback,
  so the refine-retry loop needs no extra hooks and never interrupts you.
- **Hash caches keep it cheap.** An approved question re-passes instantly; an unchanged
  question resubmitted after a REVISE is re-denied from cache without a judge run.
- **Anti-perfectionism is in the judge's contract.** APPROVE is the default verdict; REVISE is
  reserved for gaps that would materially change the report, and every REVISE delays the
  research start, so the prompt says each fix must be worth that cost.
- **Scope discrimination is structural, not name-based.** The scope gate recognizes the Scope
  agent by its output shape (`{question, angles: [{label, query}]}`) — the only message in the
  pipeline with those required keys — so the hook stays inert for every searcher, fetcher, and
  voter stop.

## Install

```
/plugin marketplace add wickedev/codex-research-for-cc
/plugin install researchkeeper@codex-research-for-cc
```

Requirements:

- Claude Code with the built-in `/deep-research` workflow (verified against v2.1.224)
- Node.js (any recent version; the plugin has zero dependencies)
- [Codex CLI](https://github.com/openai/codex) installed and authenticated (`codex --version`
  must work) — only needed for layers 2 and 3; layer 1 is judge-free

## Commands

| Command | What it does |
| --- | --- |
| `/researchkeeper:status` | Gate state, judge settings, latest verdict |
| `/researchkeeper:on` / `/researchkeeper:off` | Enable / disable the gate |
| `/researchkeeper:scope-gate [on\|off]` | Toggle the experimental Scope decomposition gate |
| `/researchkeeper:model [slug\|default]` | Pin the judge model, or inherit `~/.codex/config.toml` |
| `/researchkeeper:effort [level\|default]` | Pin the judge reasoning effort (`none`…`ultra`) |

## Configuration

`~/.claude/researchkeeper/config.json`:

| Key             | Default | Meaning                                                        |
| :-------------- | :------ | :------------------------------------------------------------- |
| `enabled`       | `true`  | Master switch (layers 1 and 2)                                 |
| `scopeGate`     | `false` | Layer 3 — experimental, see below                              |
| `maxIterations` | `3`     | Question-review REVISEs per session before launching as-is     |
| `model`         | unset   | Judge model; unset inherits `~/.codex/config.toml`             |
| `effort`        | unset   | Judge reasoning effort; unset inherits the model's own default |
| `sandbox`       | unset   | Judge sandbox; unset means `read-only`                         |

Each of the last three is overridden by `$RESEARCHKEEPER_CODEX_MODEL`,
`$RESEARCHKEEPER_CODEX_EFFORT`, and `$RESEARCHKEEPER_CODEX_SANDBOX` respectively.

## Verifying on your version

Two behaviors this plugin depends on are internal to Claude Code and should be checked once
per version. Both checks use the same switch:

```
RESEARCHKEEPER_DEBUG_INPUT=/tmp/rk-payloads.jsonl claude
# then run a short /deep-research and inspect the file
```

1. **Does PreToolUse fire on the Workflow tool?** If the file gains a payload with
   `tool_name: "Workflow"`, layer 2 is live. If not, layer 2 silently never runs — layer 1
   still works, and nothing breaks (the gate is fail-open by construction).
2. **What does SubagentStop carry?** Inspect the captured payloads for the field holding the
   subagent's final message and confirm the Scope agent's angles JSON appears in it. Only
   after that, and a test run with the block enabled, trust `/researchkeeper:scope-gate on`.
   Until then the scope gate observes and never blocks (default off).

## Failure policy

The gate **fails open**: a missing codex CLI, judge timeout, unparseable verdict, an
unrecognizable payload, or the iteration cap all let the research proceed with a stderr note.
Only an explicit REVISE verdict denies — and the deny carries the concrete fixes, so a denial
always moves the question forward. Two bounds keep a broken judge from looping: `maxIterations`
caps REVISEs per session, and three consecutive judge failures stand the gate down for the
session. The scope gate additionally blocks at most once per session, ever.

## What this plugin deliberately does not do

It does not touch the pipeline's internals — vote counts, prompts, phases, and budgets belong
to the workflow script, and changing those means overriding the workflow (a `.js` file in
`.claude/workflows/`), which is a different tool with a different trade-off: an override owns
the inside but stops tracking the built-in as Claude Code updates it. This plugin only shapes
what enters the pipeline, which survives built-in updates by construction.
