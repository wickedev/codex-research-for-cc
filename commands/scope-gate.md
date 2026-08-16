---
description: Toggle the experimental Scope-agent decomposition gate (SubagentStop)
argument-hint: "[on | off]"
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/research-ctl.mjs" scope-gate $ARGUMENTS
```

Relay the output to the user. If the user is turning it on for the first time, mention that
SubagentStop block semantics for workflow agents are unverified on their Claude Code version —
the README's "Verifying on your version" section explains how to check with
RESEARCHKEEPER_DEBUG_INPUT before trusting it.
