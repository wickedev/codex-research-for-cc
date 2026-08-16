#!/usr/bin/env node
// UserPromptSubmit hook: when the user asks for deep research, inject the
// research-brief protocol as additional context. This is the cheapest layer of
// the gate — no judge run, no state — and it works even if the PreToolUse gate
// never fires on this Claude Code version: the enriched question it produces
// is what actually reaches the workflow's Scope agent.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { readConfig } from "./lib/state.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const NOTE_PATH = path.join(SCRIPT_DIR, "..", "prompts", "brief-note.md");

// Deliberately narrow: only prompts that clearly ask for deep research. A false
// positive injects ~20 lines of protocol into an unrelated turn, so "research"
// alone does not match.
const RESEARCH_INTENT = /(^|\s)\/deep-research\b|deep[\s-]?research|딥\s*리서치/i;

function main() {
  const raw = fs.readFileSync(0, "utf8").trim();
  const input = raw ? JSON.parse(raw) : {};

  if (!readConfig().enabled) {
    return;
  }
  const prompt = String(input.prompt ?? "");
  if (!RESEARCH_INTENT.test(prompt)) {
    return;
  }

  const note = fs.readFileSync(NOTE_PATH, "utf8").trim();
  process.stdout.write(
    `${JSON.stringify({
      hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: note }
    })}\n`
  );
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`researchkeeper: ${message}\n`);
  process.exitCode = 1; // non-blocking — a crashed hook must never eat the prompt
}
