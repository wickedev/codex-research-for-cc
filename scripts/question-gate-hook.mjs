#!/usr/bin/env node
// PreToolUse hook on the Workflow tool: when Claude launches the built-in
// deep-research workflow, Codex reviews the research question BEFORE the
// fan-out spends its agent budget. A question with a missing angle is denied
// with concrete fixes as the reason — Claude enriches the question and calls
// Workflow again — so the review/refine loop finishes before any searcher runs.
//
// Whether PreToolUse fires on the Workflow tool is not documented; this hook is
// built fail-open so the answer does not matter for safety: if it never fires,
// nothing changes; if it fires, the gate works. Set
// RESEARCHKEEPER_DEBUG_INPUT=/path/to/log to capture the raw payload and settle
// the question empirically for your Claude Code version.
//
// Fails open by design: judge errors, timeouts, a missing codex CLI, an
// unrecognizable payload, or the iteration cap all let the workflow start with
// a stderr note. A broken judge can never block research forever.

import crypto from "node:crypto";
import fs from "node:fs";
import { readStdinSync } from "./lib/stdin.mjs";
import path from "node:path";
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
import { recentUserRequests } from "./lib/transcript.mjs";
import { parseVerdict } from "./lib/verdict.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROMPT_PATH = path.join(SCRIPT_DIR, "..", "prompts", "question-review.md");
const BRIEF_PATH = path.join(SCRIPT_DIR, "..", "prompts", "brief-note.md");
const JUDGE_TIMEOUT_MS = 10 * 60 * 1000;
const JUDGE_ERROR_CAP = 3;

function readHookInput() {
  const raw = readStdinSync().trim();
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

function deny(reason) {
  process.stdout.write(
    `${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason
      }
    })}\n`
  );
}

// The built-in workflow takes the question as a plain string in args; a custom
// override may take {question: "..."}. Anything else is not a research launch
// this gate understands, and passes through untouched.
function resolveQuestion(toolInput) {
  if (typeof toolInput?.args === "string" && toolInput.args.trim()) {
    return toolInput.args.trim();
  }
  if (typeof toolInput?.args?.question === "string" && toolInput.args.question.trim()) {
    return toolInput.args.question.trim();
  }
  return null;
}

function reviseReason(feedback, iteration, maxIterations) {
  // On the first denial, ship the full brief protocol along with the fixes:
  // this launch may have been caught only here (the UserPromptSubmit keyword
  // layer is deliberately narrow), and the workflow-start catch must be
  // self-sufficient — Claude should not need to have seen the protocol before.
  let brief = "";
  if (iteration === 1) {
    try {
      brief = `\n\nFull protocol for reference:\n${fs.readFileSync(BRIEF_PATH, "utf8").trim()}`;
    } catch {
      // the fixes alone are still actionable
    }
  }
  return (
    `Codex research-question review (iteration ${iteration}/${maxIterations}): the question was ` +
    `NOT approved for fan-out. An independent reviewer found the gaps below. The workflow's ` +
    `Scope agent reads the question verbatim, so fold each fix into the question text itself, ` +
    `then call the Workflow tool again with the enriched question. Preserve the user's intent, ` +
    `do not narrow the scope, do not ask the user, and do not abandon the research.\n\n${feedback}${brief}`
  );
}

function buildPrompt(question, state, input) {
  const template = fs.readFileSync(PROMPT_PATH, "utf8");
  const requests = recentUserRequests(input.transcript_path);
  const userRequestBlock = requests.length
    ? `The user's request (most recent messages, oldest first):\n${requests.join("\n---\n")}`
    : "";
  const previousFeedbackBlock = state.lastFeedback
    ? `Your previous review of an earlier version of this question required these fixes — check ` +
      `whether they were addressed instead of inventing new requirements:\n${state.lastFeedback}`
    : "";
  // Function replacements so `$&`-style sequences inside the question are inert.
  return template
    .replace("{{QUESTION}}", () => question)
    .replace("{{USER_REQUEST_BLOCK}}", () => userRequestBlock)
    .replace("{{PREVIOUS_FEEDBACK_BLOCK}}", () => previousFeedbackBlock)
    .replace("{{ITERATION}}", String(state.iterations + 1))
    .replace("{{MAX_ITERATIONS}}", String(state.maxIterations));
}

function main() {
  const input = readHookInput();
  const config = readConfig();
  if (!config.enabled) {
    return;
  }

  const toolInput = input.tool_input ?? {};
  // Gate only the deep-research launch. Everything else that goes through the
  // Workflow tool — custom scripts, other named workflows, resumes — is out of
  // scope and passes untouched. Resumes re-enter an already-reviewed run.
  if (toolInput.name !== "deep-research" || toolInput.resumeFromRunId) {
    return;
  }

  const sessionId = input.session_id;
  if (!sessionId) {
    return;
  }

  const question = resolveQuestion(toolInput);
  if (!question) {
    note("researchkeeper: could not locate the research question; letting the workflow start unreviewed.");
    return;
  }
  const hash = crypto.createHash("sha256").update(question).digest("hex");

  let state = readSessionState(sessionId) ?? newSessionState();
  state.maxIterations = state.maxIterations ?? config.maxIterations;

  if ((state.approvedHashes ?? []).includes(hash)) {
    note("researchkeeper: this exact question was already approved — skipping re-review.");
    return;
  }

  if (state.status === "stood-down") {
    note("researchkeeper: judge stood down earlier this session; letting the workflow start unreviewed.");
    return;
  }

  if (state.iterations >= state.maxIterations) {
    // Never permanently block research: on cap, launch as-is and reset so a
    // genuinely new question later gets a fresh review budget.
    state.status = "capped";
    state.iterations = 0;
    state.lastDeniedHash = null;
    state.lastFeedback = null;
    writeSessionState(sessionId, pushHistory(state, "capped", `hit max iterations (${state.maxIterations})`));
    note(
      `researchkeeper: review cap (${state.maxIterations}) reached without approval — launching ` +
        `the workflow as-is. Check /researchkeeper:status for the last feedback.`
    );
    return;
  }

  if (state.lastDeniedHash === hash && state.lastFeedback) {
    // Unchanged question resubmitted after a REVISE: repeat the feedback
    // without a judge run. The iteration still advances, so this cannot loop
    // past the cap.
    state.iterations += 1;
    state.status = "revising";
    writeSessionState(sessionId, pushHistory(state, "repeat-deny", `unchanged question ${hash.slice(0, 12)}`));
    deny(
      `${reviseReason(state.lastFeedback, state.iterations, state.maxIterations)}\n\n` +
        `Note: this question is byte-identical to the version already reviewed — it must actually change.`
    );
    return;
  }

  if (!codexAvailable()) {
    note("researchkeeper: codex CLI not found; letting the workflow start unreviewed.");
    return;
  }

  const cwd = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const settings = resolveJudge(config);
  const judge = runCodexJudge(cwd, buildPrompt(question, state, input), {
    timeoutMs: JUDGE_TIMEOUT_MS,
    sandbox: settings.sandbox.value || "read-only",
    model: settings.model.value,
    effort: settings.effort.value
  });

  const verdict = judge.ok ? parseVerdict(judge.lastMessage) : null;
  if (!verdict) {
    const reason = judge.ok ? "unparseable verdict" : judge.error;
    state.judgeErrors = (state.judgeErrors ?? 0) + 1;
    pushHistory(state, "judge-error", reason);
    if (state.judgeErrors >= JUDGE_ERROR_CAP) {
      state.status = "stood-down";
      writeSessionState(sessionId, pushHistory(state, "stood-down", `${state.judgeErrors} consecutive judge failures`));
      note(
        `researchkeeper: judge failed ${state.judgeErrors} times in a row (${reason}). Standing down ` +
          `for this session — research launches unreviewed. Check /researchkeeper:status.`
      );
      return;
    }
    writeSessionState(sessionId, state);
    note(
      `researchkeeper: judge failed (${reason}); letting the workflow start unreviewed ` +
        `(${state.judgeErrors}/${JUDGE_ERROR_CAP} before standing down).`
    );
    return;
  }

  state.judgeErrors = 0;
  pushHistory(state, "verdict", `${verdict.kind}: ${verdict.detail}`);

  if (verdict.kind === "APPROVE") {
    state.approvedHashes = [...(state.approvedHashes ?? []), hash].slice(-20);
    state.status = "approved";
    state.iterations = 0;
    state.lastDeniedHash = null;
    state.lastFeedback = null;
    writeSessionState(sessionId, state);
    note(`researchkeeper: research question approved by Codex — ${verdict.detail}`);
    return;
  }

  // REVISE
  state.iterations += 1;
  state.status = "revising";
  state.lastDeniedHash = hash;
  state.lastFeedback = verdict.detail;
  writeSessionState(sessionId, state);
  deny(reviseReason(verdict.detail, state.iterations, state.maxIterations));
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`researchkeeper: ${message}\n`);
  // Exit 1 is non-blocking for PreToolUse (only exit 2 blocks), so a crashed
  // gate fails open too.
  process.exitCode = 1;
}
