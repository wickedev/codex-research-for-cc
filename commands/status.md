---
description: Show the researchkeeper gate state and the latest Codex verdict
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/research-ctl.mjs" status
```

Relay the output to the user. Add context for two statuses: `capped` means the question-review
loop hit its iteration limit and the workflow was launched without Codex approval;
`stood-down` means the judge failed repeatedly (auth, usage limit, timeouts) and the gate
stopped reviewing for that session. Both reset with a new session, and `/researchkeeper:on`
re-enables a disabled gate.
