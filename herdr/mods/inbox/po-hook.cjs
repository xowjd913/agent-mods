#!/usr/bin/env node
// PO hook: runs as a Claude Code hook (Stop and UserPromptSubmit) and mirrors what happens in a PO terminal onto the PO desk,
// so the person never has to read the terminal:
//   Stop              -> {kind:"say", text: the PO's final reply}      (a left PO bubble)
//   UserPromptSubmit  -> {kind:"me",  text: what was typed/pasted}    (a right bubble; the desk drops the ones it sent itself)
//   a prompt with "[Image #N]" (a picture pasted in the terminal) also gets {kind:"img", pid, imgs:[<0600 files in <app root>/data/inbox/img/>]}: the prompt
//   carries only the placeholder, so the pictures are read from the transcript (transcript_path) by a short detached worker that waits for the
//   transcript to hold the prompt, and once more at Stop. A picture that cannot be found stays a small "picture" chip on the desk.
// appended to <inbox dir>/po/<po id>.jsonl (HERDR_INBOX_DIR, else ~/.herdr-inbox). Installed by `install.cjs hook`.
// Rules: exit 0 always and print nothing (the hook must never change, block or slow a session); do nothing unless the terminal
// is a PO (labels role=po and a valid po id) - leaders, workers and plain sessions are never written for.
"use strict";
const fs = require("fs");
const path = require("path");
const { execFileSync, spawn } = require("child_process");

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

const IMG_WAIT_MS = 25000, IMG_POLL_MS = 1000;

// Reads the pictures of every pending "[Image #N]" prompt of `file` from the transcript and appends one {kind:"img"} line per prompt that has some.
// Returns how many prompts are still without pictures.
function fillImages(file, transcript, I = require("./inbox.cjs"), now = Date.now()) {
  const root = I.appRoot();
  let left = 0;
  for (const { pid, text } of I.pendingImagePids(file)) {
    const imgs = transcript ? I.transcriptImages(transcript, pid, text.replace(/\[Image #\d+\]/g, "").trim() || text, root, now) : [];
    if (imgs.length) appendLine(file, JSON.stringify({ ts: new Date(now).toISOString(), kind: "img", pid, imgs, src: "hook" }) + "\n");
    else left++;
  }
  return left;
}

// Detached worker: polls the transcript until the pictures of the pending prompts are in it (or IMG_WAIT_MS passed).
function imageWorker(file, transcript) {
  const t0 = Date.now();
  const tick = () => {
    let left = 0;
    try { left = fillImages(file, transcript); } catch { left = 0; }
    if (left > 0 && Date.now() - t0 < IMG_WAIT_MS) setTimeout(tick, IMG_POLL_MS); else process.exit(0);
  };
  tick();
}

function startWorker(file, transcript) {
  try {
    const c = spawn(process.execPath, [__filename, "--images", file, transcript], { detached: true, stdio: "ignore", windowsHide: true, env: process.env });
    c.on("error", () => {});
    c.unref();
  } catch {}
}

function run(env = process.env, payload = readPayload(), I = require("./inbox.cjs"), get = terminalLabels, now = Date.now(), spawnWorker = startWorker) {
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
  // A prompt with a picture placeholder gets its pictures from the transcript (a worker, since the transcript may not hold it yet);
  // Stop tries once more for any prompt still without (the hook of this very event has nothing to wait for).
  const tp = typeof payload?.transcript_path === "string" ? payload.transcript_path : "";
  if (tp && line.kind === "me" && /\[Image #\d+\]/.test(line.text)) { if (spawnWorker) spawnWorker(file, tp); }
  else if (tp && line.kind === "say") { try { fillImages(file, tp, I, now); } catch {} }
  return { file, line };
}

module.exports = { run, fillImages, terminalLabels, appendLine, FILE_MAX, KEEP };

if (require.main === module) {
  if (process.argv[2] === "--images") {
    try { imageWorker(process.argv[3], process.argv[4]); } catch { process.exit(0); } // the worker exits itself when done
  } else {
    try { run(); } catch { /* never fail the session */ }
    process.exit(0);
  }
}
