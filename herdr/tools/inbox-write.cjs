#!/usr/bin/env node
// Writer for the desk inbox (contract v1, docs/inbox-contract.md): `report`, `answered` and `say` append one JSON line to
// <inbox dir>/<agent>.jsonl or <inbox dir>/<hub dir>/<hub id>.jsonl, the files the `inbox` mod reads. No dependencies.
// Every name this tool uses (agent name pattern, role/wait labels, hub folder, kind aliases) comes from a profile: the built-in default
// profile is today's behavior (lead-* agents, role=po hubs); a profile.json in the inbox dir (or $HERDR_INBOX_PROFILE) changes it.
// The inbox dir is $HERDR_INBOX_DIR, else ~/.herdr-inbox.
// Exit codes: 0 written, 1 usage/environment, 2 bad content (nothing written), 4 written but label failed.
"use strict";
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const P = require("../mods/inbox/profile.cjs"); // the one profile loader (also read by the desk and the PO hook)
const { KINDS, REPORT_KINDS, SAFE_NAME, DEFAULT_PROFILE, inboxDir } = P;
const ASK_KINDS = ["decision", "verify"];
const SAY_MAX = 2000;
const HC_WAIT_MS = 3000;

const VALUE_FLAGS = new Set(["agent", "leader", "terminal", "hub", "po", "kind", "title", "body", "file", "link", "to", "text", "of"]);
const BOOL_FLAGS = new Set(["no-label", "help"]);
const FLAG_ALIAS = { leader: "agent", po: "hub" }; // the default profile's words for the same flags

const usage = `usage:
  inbox-write.cjs report --kind <${REPORT_KINDS.join("|")}> [--agent NAME] [--title T] [--body B | --file F|-] [--link URL] [--terminal ID] [--hub ID] [--no-label]
  inbox-write.cjs answered [--agent NAME] [--of decision|verify] [--link URL] [--terminal ID] [--hub ID] [--no-label]
  inbox-write.cjs say --hub <id> (--text T | --file F|-) [--to AGENT]
--leader and --po are the same as --agent and --hub. Inbox dir: $HERDR_INBOX_DIR, else ~/.herdr-inbox.
Names: --agent, else $HERDR_INBOX_AGENT (or $HERDR_INBOX_LEADER), else this terminal's name from \`hc get $HC_TERMINAL_ID\`.
Profile (names and labels): $HERDR_INBOX_PROFILE, else <inbox dir>/profile.json, else the built-in default (docs/inbox-contract.md).`;

class Fail extends Error { constructor(code, message) { super(message); this.code = code; } }

// A missing default profile file is the default profile; an unreadable or invalid one is an error (exit 1) so a typo never silently falls back to other names.
function loadProfile(env = process.env) {
  try { return P.loadProfile(env); } catch (e) { if (e instanceof P.ProfileError) throw new Fail(1, e.message); throw e; }
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const flags = {};
  for (let i = 0; i < rest.length; i++) {
    const m = /^--([a-z-]+)$/.exec(rest[i]);
    if (!m) throw new Fail(1, `unexpected argument: ${rest[i]}`);
    const name = FLAG_ALIAS[m[1]] ?? m[1];
    if (BOOL_FLAGS.has(m[1])) { flags[name] = true; continue; }
    if (!VALUE_FLAGS.has(m[1])) throw new Fail(1, `unknown option: --${m[1]}`);
    if (i + 1 >= rest.length) throw new Fail(1, `--${m[1]} needs a value`);
    flags[name] = rest[++i];
  }
  return { command, flags };
}

const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
const trimBlankLines = (s) => String(s).replace(/\r\n?/g, "\n").replace(/^\s*\n/, "").replace(/\s+$/, "");
const lower = (v) => String(v ?? "").trim().toLowerCase();

// `hc get <id>` prints one JSON object (name, parent, labels); null when hc is missing or does not answer.
function hcGet(id, env) {
  try {
    const out = execFileSync("hc", ["get", id], { encoding: "utf8", timeout: HC_WAIT_MS, stdio: ["ignore", "pipe", "ignore"], windowsHide: true, env, maxBuffer: 1 << 20 });
    const t = JSON.parse(out);
    return t && typeof t === "object" ? t : null;
  } catch { return null; }
}

const agentOk = (profile, name) => SAFE_NAME.test(name) && profile.agentName.test(name);
const hubOk = (profile, id) => SAFE_NAME.test(id) && profile.hubId.test(id);

// Who is reporting: explicit flags first, then the environment, then `hc get` of this terminal and of its parent (the hub; accepted
// only with the hub's role label, like the reader does). `needMe` asks hc even when everything is named (the caller wants this terminal's labels).
function identity(profile, flags, env, hcLookup = hcGet, needMe = false) {
  const terminal = String(flags.terminal ?? env.HC_TERMINAL_ID ?? "").trim();
  const named = flags.agent ?? env.HERDR_INBOX_AGENT ?? env.HERDR_INBOX_LEADER;
  const me = terminal && (needMe || !named || !flags.hub) ? hcLookup(terminal, env) : null;
  const agent = String(named ?? me?.name ?? "").trim();
  if (!agentOk(profile, agent)) throw new Fail(1, `agent name "${agent}" does not match ${profile.agentName} (profile agent.name). Pass --agent or set HERDR_INBOX_AGENT.`);
  let hub = String(flags.hub ?? "").trim();
  if (!hub && me?.parent) {
    const parent = hcLookup(me.parent, env);
    if (lower(parent?.labels?.[profile.labelRole]) === lower(profile.hubRole)) hub = String(parent.labels?.[profile.hubIdLabel] ?? "").trim();
  }
  if (hub && !hubOk(profile, hub)) { if (flags.hub) throw new Fail(1, `hub id "${hub}" does not match ${profile.hubId} (profile hub.id)`); hub = ""; }
  return { agent, terminal, hub, me };
}

function readContent(flags) {
  if (flags.file !== undefined) {
    try { return fs.readFileSync(flags.file === "-" ? 0 : flags.file, "utf8"); } catch (e) { throw new Fail(2, `cannot read ${flags.file}: ${e.code || e.message}`); }
  }
  return flags.body ?? flags.text ?? "";
}

function reportRecord(profile, flags, env, hcLookup) {
  const kind = profile.kindMap[flags.kind] ?? flags.kind;
  if (!REPORT_KINDS.includes(kind)) throw new Fail(2, `--kind must be one of ${[...REPORT_KINDS, ...Object.keys(profile.kindMap)].join(", ")} (use the answered command for answered)`);
  const id = identity(profile, flags, env, hcLookup);
  const title = String(flags.title ?? "").replace(/\s*\n\s*/g, " ").trim() || `[${id.agent}] ${kind}`;
  const record = { v: 1, ts: nowIso(), leader: id.agent, terminal: id.terminal, kind, title, body: trimBlankLines(readContent(flags)), link: String(flags.link ?? "").trim() };
  if (id.hub) record.po = id.hub;
  return { record, id };
}

function answeredRecord(profile, flags, env, hcLookup) {
  const id = identity(profile, flags, env, hcLookup, flags.of === undefined || flags.link === undefined);
  const wait = lower(flags.of ?? id.me?.labels?.[profile.labelWait]);
  if (flags.of !== undefined && !ASK_KINDS.includes(wait)) throw new Fail(2, "--of must be decision or verify");
  const link = String(flags.link ?? id.me?.labels?.[profile.labelWaitLink] ?? "").trim();
  // An empty body is allowed: the reader then closes the latest open ask of any kind.
  const record = { v: 1, ts: nowIso(), leader: id.agent, terminal: id.terminal, kind: "answered", title: `[${id.agent}] answered`, body: ASK_KINDS.includes(wait) ? wait : "", link };
  if (id.hub) record.po = id.hub;
  return { record, id };
}

function sayRecord(profile, flags) {
  const hub = String(flags.hub ?? "").trim();
  if (!hubOk(profile, hub)) throw new Fail(1, `say needs --hub <id> matching ${profile.hubId} (profile hub.id)`);
  const text = trimBlankLines(readContent(flags));
  if (!text.trim()) throw new Fail(2, "text is empty");
  // UTF-16 units, like the desk reader's `slice(0, 2000)`: a text this accepts is never cut by the reader.
  if (text.length > SAY_MAX) throw new Fail(2, `text is over ${SAY_MAX} characters (UTF-16 units; an emoji counts 2)`);
  const record = { ts: nowIso(), kind: "say", text };
  if (flags.to !== undefined) {
    if (!agentOk(profile, flags.to)) throw new Fail(1, `--to must match ${profile.agentName} (profile agent.name)`);
    record.to = flags.to;
  }
  return { record, hub };
}

// Appends one line; a half-written last line (no newline) is closed first so the new line stays whole. Files 0600, folders 0700.
function appendRecord(file, record) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  let prefix = "";
  try {
    const fd = fs.openSync(file, "r");
    try {
      const size = fs.fstatSync(fd).size;
      if (size > 0) { const last = Buffer.alloc(1); fs.readSync(fd, last, 0, 1, size - 1); if (last[0] !== 0x0a) prefix = "\n"; }
    } finally { fs.closeSync(fd); }
  } catch {}
  fs.appendFileSync(file, `${prefix}${JSON.stringify(record)}\n`, { mode: 0o600 });
}

// The labels of this terminal that go with a record: decision/verify wait for an answer, answered clears the wait. Other kinds set none.
function labelArgs(profile, record) {
  if (ASK_KINDS.includes(record.kind)) return [`${profile.labelWait}=${record.kind}`, `${profile.labelWaitLink}=${record.link}`];
  if (record.kind === "answered") return [`${profile.labelWait}=`, `${profile.labelWaitLink}=`];
  return null;
}

function applyLabels(profile, record, terminal, env) {
  const args = labelArgs(profile, record);
  if (!args) return "";
  if (!terminal) return "labels skipped: no terminal (HC_TERMINAL_ID or --terminal)\n";
  try {
    execFileSync("hc", ["label", terminal, ...args], { stdio: "ignore", timeout: HC_WAIT_MS, windowsHide: true, env });
    return "";
  } catch (e) { throw new Fail(4, `record written, but \`hc label ${terminal} ${args.join(" ")}\` failed (${e.code || e.message}); set the label by hand`); }
}

// run(argv, env) -> { code, out, err }; never throws, never exits.
function run(argv, env = process.env, hcLookup = hcGet) {
  let out = "", err = "";
  try {
    const { command, flags } = parseArgs(argv);
    if (!command || command === "--help" || command === "help" || flags.help) return { code: command ? 0 : 1, out: command ? usage + "\n" : "", err: command ? "" : usage + "\n" };
    if (!["report", "answered", "say"].includes(command)) throw new Fail(1, `unknown command: ${command}`);
    const dir = inboxDir(env);
    const profile = loadProfile(env);
    if (command === "say") {
      const { record, hub } = sayRecord(profile, flags);
      const file = path.join(dir, profile.hubDir, `${hub}.jsonl`);
      appendRecord(file, record);
      return { code: 0, out: `written ${file}\n`, err };
    }
    const { record, id } = command === "report" ? reportRecord(profile, flags, env, hcLookup) : answeredRecord(profile, flags, env, hcLookup);
    const file = path.join(dir, `${id.agent}.jsonl`);
    appendRecord(file, record);
    out = `written ${file}\n`;
    if (!flags["no-label"]) err += applyLabels(profile, record, id.terminal, env);
    return { code: 0, out, err };
  } catch (e) {
    if (e instanceof Fail) return { code: e.code, out, err: `${e.message}\n` };
    return { code: 1, out, err: `${e.message}\n` };
  }
}

if (require.main === module) {
  const r = run(process.argv.slice(2));
  process.stdout.write(r.out);
  process.stderr.write(r.err);
  process.exitCode = r.code;
}

module.exports = { run, parseArgs, loadProfile, identity, reportRecord, answeredRecord, sayRecord, appendRecord, labelArgs, inboxDir, DEFAULT_PROFILE, KINDS, REPORT_KINDS };
