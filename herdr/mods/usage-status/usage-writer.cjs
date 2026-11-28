#!/usr/bin/env node
// Claude Code statusLine command that records the 5-hour / 7-day usage for the usage-status mod.
//   Claude Code runs this on every status line update and pipes a JSON object to stdin (see https://code.claude.com/docs/en/statusline):
//     rate_limits.five_hour|seven_day.used_percentage  0..100
//     rate_limits.five_hour|seven_day.resets_at        Unix epoch seconds
//     cost.total_cost_usd                              estimated session cost in USD
//   `rate_limits` only exists for claude.ai Pro/Max/Ultra and only after the first API response, so a missing window writes nothing.
// Output: ~/.claude/usage-limits.json, the same shape the private Claude Code mod writes, so both writers can coexist:
//     { updatedAt, limits: [{ kind: "five_hour"|"seven_day", percentUsed, resetsAt (ISO) }], costUsd }
//   The file is replaced atomically (temp file + rename), so a reader never sees half a file.
// Usage: node usage-writer.cjs [--chain <file>]
//   --chain <file>: the file holds {"original": <the user's previous statusLine object>}. The same stdin is forwarded to that command and
//   its stdout becomes the status line, so an existing status line keeps working. Without --chain a short "5h 12% · 7d 68%" is printed.
// No dependencies, no network. It always exits 0 so a problem here never breaks the status line.
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const KINDS = ["five_hour", "seven_day"];
const SHORT = { five_hour: "5h", seven_day: "7d" };
const CHAIN_TIMEOUT_MS = 5000;

const limitsFile = (home = os.homedir()) => path.join(home, ".claude", "usage-limits.json");

// The usage object to write, or null when the input has no usable window (nothing is written then).
// Windows that already reset (resets_at <= now) are dropped; Claude Code drops them too, this only guards a stale payload.
function buildUsage(input, nowMs = Date.now()) {
  const rl = input && typeof input === "object" ? input.rate_limits : null;
  if (!rl || typeof rl !== "object") return null;
  const limits = [];
  for (const kind of KINDS) {
    const w = rl[kind];
    if (!w || typeof w !== "object" || typeof w.used_percentage !== "number" || !Number.isFinite(w.used_percentage)) continue;
    const entry = { kind, percentUsed: Math.max(0, Math.round(w.used_percentage)) };
    if (typeof w.resets_at === "number" && Number.isFinite(w.resets_at)) {
      const ms = w.resets_at * 1000;
      if (ms <= nowMs) continue;
      entry.resetsAt = new Date(ms).toISOString();
    }
    limits.push(entry);
  }
  if (!limits.length) return null;
  const cost = input.cost && typeof input.cost === "object" ? input.cost.total_cost_usd : undefined;
  const usage = { limits };
  if (typeof cost === "number" && Number.isFinite(cost)) usage.costUsd = cost;
  return usage;
}

const fileText = (usage, nowMs) => `${JSON.stringify({ updatedAt: new Date(nowMs).toISOString(), ...usage }, null, 2)}\n`;

// Replace the file in one step. If the rename is refused (Windows while a reader holds the file), write in place.
function writeUsage(file, usage, nowMs = Date.now()) {
  const body = fileText(usage, nowMs);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(tmp, body);
    fs.renameSync(tmp, file);
  } catch {
    try { fs.rmSync(tmp, { force: true }); } catch {}
    fs.writeFileSync(file, body);
  }
}

const summary = (usage) => usage.limits.map((l) => `${SHORT[l.kind]} ${l.percentUsed}%`).join(" · ");

// The user's previous status line command from the chain file, or null. A command that is this script is ignored (no loop).
function chainCommand(chainFile) {
  try {
    const cmd = JSON.parse(fs.readFileSync(chainFile, "utf8"))?.original?.command;
    return typeof cmd === "string" && cmd.trim() && !/usage-writer\.cjs/.test(cmd) ? cmd : null;
  } catch { return null; }
}

function main(argv, stdinText, env = {}) {
  const i = argv.indexOf("--chain");
  const chainFile = i >= 0 ? argv[i + 1] : null;
  let input = null;
  try { input = JSON.parse(stdinText); } catch {}
  let usage = null;
  try {
    usage = buildUsage(input);
    if (usage) writeUsage(limitsFile(env.home), usage);
  } catch {}
  const cmd = chainFile ? chainCommand(chainFile) : null;
  if (cmd) {
    const r = spawnSync(cmd, { shell: true, input: stdinText, encoding: "utf8", timeout: CHAIN_TIMEOUT_MS, windowsHide: true });
    return r.stdout || "";
  }
  return usage ? `${summary(usage)}\n` : "";
}

module.exports = { KINDS, limitsFile, buildUsage, writeUsage, chainCommand, summary, main };

if (require.main === module) {
  let text = "";
  try { text = fs.readFileSync(0, "utf8"); } catch {}
  try { process.stdout.write(main(process.argv.slice(2), text)); } catch {}
}
