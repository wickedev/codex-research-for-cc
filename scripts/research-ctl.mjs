#!/usr/bin/env node
// CLI used by the plugin commands (and by hand) to inspect and configure the gate.
// Usage:
//   research-ctl.mjs status
//   research-ctl.mjs on
//   research-ctl.mjs off
//   research-ctl.mjs scope-gate [on | off]
//   research-ctl.mjs model  [<model> | default]
//   research-ctl.mjs effort [<effort> | default]

import process from "node:process";
import { latestSessionState, readConfig, resolveJudge, writeConfig } from "./lib/state.mjs";
import { KNOWN_MODELS, REASONING_EFFORTS } from "./lib/codex.mjs";

// Deliberately excludes "none" (a real reasoning effort) and "auto" (not a Codex
// value at all — it gets an explanatory rejection instead of quietly clearing).
const UNSET = new Set(["default", "reset", "clear", "unset"]);

function describe(setting, label) {
  return setting.value
    ? `${label}: ${setting.value} (from ${setting.source})`
    : `${label}: codex default (unset — inherited from ~/.codex/config.toml)`;
}

// `model` and `effort` share one shape: no argument reports, `default` clears,
// anything else is stored after validation.
function setting({ key, label, argv, validate, choices }) {
  const config = readConfig();
  const raw = argv.join(" ").trim();

  if (!raw) {
    const judge = resolveJudge(config);
    const lines = [describe(judge[key], label)];
    if (judge[key].source.startsWith("$") && config[key]) {
      lines.push(`Note: the environment variable overrides the configured value "${config[key]}".`);
    }
    lines.push("", choices, `default — clear the pin and inherit ~/.codex/config.toml`);
    process.stdout.write(`${lines.join("\n")}\n`);
    return 0;
  }

  if (UNSET.has(raw.toLowerCase())) {
    const next = { ...config };
    delete next[key];
    writeConfig(next);
    process.stdout.write(
      `${label} cleared. The judge now inherits it from ~/.codex/config.toml, so changing that ` +
        `file changes how research questions are reviewed.\n`
    );
    return 0;
  }

  const problem = validate?.(raw);
  if (problem) {
    process.stderr.write(`${problem}\n`);
    return 1;
  }

  writeConfig({ ...config, [key]: raw });
  process.stdout.write(`${label} set to ${raw}. Every research review will use it.\n`);
  return 0;
}

function status() {
  const config = readConfig();
  const judge = resolveJudge(config);
  const lines = [
    `researchkeeper: ${config.enabled ? "enabled" : "disabled"}`,
    `scope gate (experimental): ${config.scopeGate ? "on" : "off"}`,
    describe(judge.model, "judge model"),
    describe(judge.effort, "judge effort"),
    describe(judge.sandbox, "judge sandbox"),
    `max question-review iterations: ${config.maxIterations}`
  ];

  const state = latestSessionState();
  if (state) {
    lines.push("", `latest session: status=${state.status}, iterations=${state.iterations}, scopeBlocks=${state.scopeBlocks ?? 0}`);
    const lastVerdict = [...(state.history ?? [])].reverse().find((h) => h.event === "verdict" || h.event === "scope-verdict");
    if (lastVerdict) {
      lines.push(`last verdict (${lastVerdict.event}, ${lastVerdict.at}):`, lastVerdict.detail);
    }
    if (state.lastFeedback && state.status === "revising") {
      lines.push("", "pending feedback:", state.lastFeedback);
    }
  } else {
    lines.push("", "no tracked sessions yet.");
  }
  process.stdout.write(`${lines.join("\n")}\n`);
  return 0;
}

function toggle(enabled) {
  writeConfig({ ...readConfig(), enabled });
  process.stdout.write(
    enabled
      ? "researchkeeper enabled. Deep-research requests get the brief protocol and Codex question review.\n"
      : "researchkeeper disabled. Deep-research runs unreviewed until /researchkeeper:on.\n"
  );
  return 0;
}

function scopeGate(argv) {
  const raw = (argv[0] ?? "").toLowerCase();
  const config = readConfig();
  if (raw !== "on" && raw !== "off") {
    process.stdout.write(
      `scope gate (experimental): ${config.scopeGate ? "on" : "off"}\n` +
        `Usage: scope-gate on|off. When on, Codex reviews the Scope agent's search-angle ` +
        `decomposition at SubagentStop and may block it once for revision. Verify block ` +
        `semantics on your Claude Code version first (see README).\n`
    );
    return 0;
  }
  writeConfig({ ...config, scopeGate: raw === "on" });
  process.stdout.write(`scope gate ${raw}.\n`);
  return 0;
}

const [, , command, ...argv] = process.argv;
switch (command) {
  case "status":
    process.exitCode = status();
    break;
  case "on":
    process.exitCode = toggle(true);
    break;
  case "off":
    process.exitCode = toggle(false);
    break;
  case "scope-gate":
    process.exitCode = scopeGate(argv);
    break;
  case "model":
    process.exitCode = setting({
      key: "model",
      label: "judge model",
      argv,
      choices: `known models (suggestions — unknown slugs are accepted):\n  ${KNOWN_MODELS.join("\n  ")}`
    });
    break;
  case "effort":
    process.exitCode = setting({
      key: "effort",
      label: "judge effort",
      argv,
      validate: (raw) =>
        REASONING_EFFORTS.includes(raw.toLowerCase())
          ? null
          : `"${raw}" is not a Codex reasoning effort. Valid: ${REASONING_EFFORTS.join(", ")} — or "default" to clear.`,
      choices: `valid efforts (cheapest → most thorough):\n  ${REASONING_EFFORTS.join(", ")}`
    });
    break;
  default:
    process.stderr.write("usage: research-ctl.mjs status|on|off|scope-gate|model|effort\n");
    process.exitCode = 1;
}
