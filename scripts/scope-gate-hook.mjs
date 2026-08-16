#!/usr/bin/env node
// SubagentStop hook (EXPERIMENTAL, default off — /researchkeeper:scope-gate on):
// the deepest pre-orchestration point reachable without owning the workflow
// script. The built-in deep-research pipeline awaits its Scope agent — the one
// that decomposes the question into search angles — before spawning any
// searcher. When that agent tries to finish, this hook recognizes its
// angles-shaped output, has Codex review the decomposition, and blocks the stop
// once with concrete missing angles so the Scope agent revises its list before
// the fan-out begins.
//
// Why default off: SubagentStop is documented to fire for workflow agents, but
// whether a *block* composes safely with the workflow runner's schema-forced
// returns is not documented. Until verified on your Claude Code version, the
// hook only observes. Set RESEARCHKEEPER_DEBUG_INPUT=/path/to/log to capture
// payloads (this works even while the gate is off — that is how you verify).
//
// Guard rails when enabled: only ever blocks an output that parses as a scope
// decomposition (question + angles[label,query]); blocks at most once per
// session; every failure path lets the agent finish.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { codexAvailable, runCodexJudge } from "./lib/codex.mjs";
import {
  newSessionState,
  pushHistory,
  readConfig,
  readSessionState,
  resolveJudge,
  writeSessionState
} from "./lib/state.mjs";
import { parseVerdict } from "./lib/verdict.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROMPT_PATH = path.join(SCRIPT_DIR, "..", "prompts", "scope-review.md");
const JUDGE_TIMEOUT_MS = 5 * 60 * 1000;

function readHookInput() {
  const raw = fs.readFileSync(0, "utf8").trim();
  const debugPath = process.env.RESEARCHKEEPER_DEBUG_INPUT;
  if (debugPath && raw) {
    try {
      fs.appendFileSync(debugPath, `${raw}\n`);
    } catch {
      // ignore
    }
  }
  return raw ? JSON.parse(raw) : {};
}

function note(message) {
  if (message) {
    process.stderr.write(`${message}\n`);
  }
}

// The payload field carrying the subagent's final text is internal to Claude
// Code; try the plausible spellings and fall back to nothing (= pass through).
function lastMessageOf(input) {
  for (const key of ["last_assistant_message", "lastAssistantMessage", "agent_message", "output"]) {
    if (typeof input[key] === "string" && input[key].trim()) {
      return input[key];
    }
  }
  return "";
}

// A Scope output is the only workflow message shaped like
// {question, angles: [{label, query}, ...]}. Search results, extractions, and
// verdicts all have different required keys, so this shape test — not the agent
// name — is what scopes the gate to the one agent it is for.
function parseScopeOutput(text) {
  const start = text.indexOf("{");
  if (start === -1) {
    return null;
  }
  for (const candidate of [text.slice(start), text]) {
    try {
      const parsed = JSON.parse(candidate.trim());
      if (
        typeof parsed?.question === "string" &&
        Array.isArray(parsed?.angles) &&
        parsed.angles.length > 0 &&
        parsed.angles.every((a) => typeof a?.label === "string" && typeof a?.query === "string")
      ) {
        return parsed;
      }
    } catch {
      // fall through
    }
  }
  return null;
}

function buildPrompt(scope) {
  const template = fs.readFileSync(PROMPT_PATH, "utf8");
  const angles = scope.angles
    .map((a) => `- ${a.label} — \`${a.query}\`${a.rationale ? ` (${a.rationale})` : ""}`)
    .join("\n");
  return template.replace("{{QUESTION}}", () => scope.question).replace("{{ANGLES}}", () => angles);
}

function main() {
  const input = readHookInput();
  const config = readConfig();
  if (!config.enabled || !config.scopeGate) {
    return;
  }

  const sessionId = input.session_id;
  if (!sessionId) {
    return;
  }

  const scope = parseScopeOutput(lastMessageOf(input));
  if (!scope) {
    return; // not the Scope agent — the common case for every other SubagentStop
  }

  let state = readSessionState(sessionId) ?? newSessionState();
  if ((state.scopeBlocks ?? 0) >= 1) {
    note("researchkeeper: scope already reviewed once this session — letting it through.");
    return;
  }

  if (!codexAvailable()) {
    note("researchkeeper: codex CLI not found; letting the scope through unreviewed.");
    return;
  }

  const cwd = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const settings = resolveJudge(config);
  const judge = runCodexJudge(cwd, buildPrompt(scope), {
    timeoutMs: JUDGE_TIMEOUT_MS,
    sandbox: settings.sandbox.value || "read-only",
    model: settings.model.value,
    effort: settings.effort.value
  });

  const verdict = judge.ok ? parseVerdict(judge.lastMessage) : null;
  if (!verdict) {
    note(`researchkeeper: scope judge failed (${judge.ok ? "unparseable verdict" : judge.error}); letting the scope through.`);
    return;
  }

  pushHistory(state, "scope-verdict", `${verdict.kind}: ${verdict.detail}`);

  if (verdict.kind === "APPROVE") {
    writeSessionState(sessionId, state);
    note(`researchkeeper: scope decomposition approved by Codex — ${verdict.detail}`);
    return;
  }

  // REVISE — block exactly once so the Scope agent amends its angle list.
  state.scopeBlocks = (state.scopeBlocks ?? 0) + 1;
  writeSessionState(sessionId, pushHistory(state, "scope-block", "blocked scope stop for revision"));
  process.stdout.write(
    `${JSON.stringify({
      decision: "block",
      reason:
        `Codex scope review: the search-angle decomposition has material gaps. Revise your angle ` +
        `list to address each item below (replace a redundant angle rather than exceeding the ` +
        `angle cap), then return the full structured output again.\n\n${verdict.detail}`
    })}\n`
  );
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`researchkeeper: ${message}\n`);
  process.exitCode = 1; // non-blocking — a crashed gate lets the agent finish
}
