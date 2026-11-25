#!/usr/bin/env node
// PO hook: runs as a Claude Code hook (Stop and UserPromptSubmit) and mirrors what happens in a PO terminal onto the PO desk,
// so the person never has to read the terminal:
//   Stop              -> {kind:"say", text: the PO's final reply}      (a left PO bubble)
//   UserPromptSubmit  -> {kind:"me",  text: what was typed/pasted}    (a right bubble; the desk drops the ones it sent itself)
// appended to <inbox dir>/po/<po id>.jsonl (HERDR_INBOX_DIR, else ~/.herdr-inbox). Installed by `install.cjs hook`.
// Rules: exit 0 always and print nothing (the hook must never change, block or slow a session); do nothing unless the terminal
// is a PO (labels role=po and a valid po id) - leaders, workers and plain sessions are never written for.
"use strict";
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const WAIT_MS = 1200; // the one `hc get` may take this long; longer means no desk line, not a slow session
const FILE_MAX = 1 << 20; // a PO file past 1 MiB is cut down to its newest KEEP bytes (whole lines) before the next line is added
const KEEP = 256 << 10;

// stdin of a hook is one JSON object. Anything else is nothing to do.
function readPayload() {
  try { const o = JSON.parse(fs.readFileSync(0, "utf8")); return o && typeof o === "object" ? o : null; } catch { return null; }
}

// The labels of this terminal (`hc get` prints one JSON object), or null.
function terminalLabels(id) {
  try {
    const out = execFileSync("hc", ["get", id], { encoding: "utf8", timeout: WAIT_MS, stdio: ["ignore", "pipe", "ignore"], windowsHide: true, maxBuffer: 1 << 20 });
    const t = JSON.parse(out);
    return t && typeof t === "object" ? t : null;
  } catch { return null; }
}

// Appends one line to `file`, which holds plaintext prompts: created 0600 (an older file is tightened to 0600), and cut down to its newest
// whole lines when it grew past FILE_MAX.
function appendLine(file, text) {
  let size = 0;
  try { size = fs.statSync(file).size; } catch {}
  if (size > FILE_MAX) {
    const fd = fs.openSync(file, "r");
    let tail = "";
    try {
      const buf = Buffer.alloc(KEEP);
      const n = fs.readSync(fd, buf, 0, KEEP, size - KEEP);
      tail = buf.toString("utf8", 0, n);
    } finally { fs.closeSync(fd); }
    tail = tail.slice(tail.indexOf("\n") + 1);
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, tail, { mode: 0o600 });
    fs.renameSync(tmp, file);
  }
  const fd = fs.openSync(file, "a", 0o600);
  try { try { fs.fchmodSync(fd, 0o600); } catch {} fs.writeSync(fd, text); } finally { fs.closeSync(fd); }
}

function run(env = process.env, payload = readPayload(), I = require("./inbox.cjs"), get = terminalLabels, now = Date.now()) {
  const id = String(env.HC_TERMINAL_ID ?? "").trim();
  if (!id) return null;
  // The cheap checks come before the `hc` call: most hook runs are other events or lines with nothing to write.
  const line = I.hookLine(payload, now);
  if (!line) return null;
  const t = get(id);
  if (!t || /^lead-/.test(String(t.name ?? "")) || t.parent) return null; // a PO has no name of a leader and no parent terminal
  const po = I.poId(t); // role=po and a valid po=<id> label
  const file = po ? I.poFile(I.inboxDir(), po) : null;
  if (!file) return null;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  appendLine(file, JSON.stringify(line) + "\n");
  return { file, line };
}

module.exports = { run, terminalLabels, appendLine, FILE_MAX, KEEP };

if (require.main === module) {
  try { run(); } catch { /* never fail the session */ }
  process.exit(0);
}
