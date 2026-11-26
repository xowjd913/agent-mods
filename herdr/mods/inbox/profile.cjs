// The profile of the desk inbox (docs/inbox-contract.md §9-§10): the names and labels the writer tool, the desk and the PO hook use to
// recognize things. ONE loader for all of them (tools/inbox-write.cjs and inbox.cjs require this file); it lives in the mod folder so the
// installer copies it. No dependencies.
// The built-in default profile is today's behavior (lead-* agents, role=po hubs). A profile file overrides single keys; a missing
// default file is the default profile, a broken one is an error (never a silent fallback to other names).
// A profile starts from a PRESET (`preset`: "po" = today's names, "none" = no agent names, hub or prefix rules at all) and the file's own keys
// override it. With no `preset` key: no profile file picks "po" when the PO arrange script exists on this PC and "none" otherwise; a profile
// file without a `preset` keeps "po" (what it always meant).
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");

const KINDS = ["start", "done", "decision", "verify", "stop", "resume", "answered", "other"]; // the kinds of the contract: fixed, a profile only adds aliases
const REPORT_KINDS = KINDS.filter((k) => k !== "answered");
// What a name must satisfy whatever the profile says: it becomes a file name, so no separators, no leading dot, no "..", at most 64 characters.
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SAFE_DIR = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;

const DEFAULT_PROFILE = Object.freeze({
  v: 1,
  agent: Object.freeze({ name: "^lead-[a-z0-9_-]+$", role: "leader", titlePrefix: "리더 · ", strip: "^lead-" }), // name pattern of a reporting agent; its `role` label value; what to cut off a title / a name to show it
  hub: Object.freeze({ role: "po", idLabel: "po", id: "^[a-z0-9-]{1,40}$", dir: "po" }), // the terminal that receives answers: role value, id label, id pattern, folder
  labels: Object.freeze({ role: "role", wait: "wait", waitLink: "wait-link", session: "session" }),
  answerLine: 'Panel answer ({kind}) for {agent}: "{text}".{ Target: {link}}', // the line sent to the hub for an answer; a {...{link}} group drops out without a link
  kinds: Object.freeze({}), // alias -> contract kind, e.g. {"question": "decision"}
});

// The "none" preset: nothing is a reporting agent or a hub (patterns that never match, empty role values), so the mods fall back to what they can
// know without anyone's naming rules (parent links, the wait label). The hook for a solo mode (#90) is here: a solo profile starts from "none".
const NONE_PROFILE = Object.freeze({
  v: 1,
  agent: Object.freeze({ name: "(?!)", role: "", titlePrefix: "", strip: "" }),
  hub: Object.freeze({ role: "", idLabel: "po", id: "(?!)", dir: "po" }),
  labels: DEFAULT_PROFILE.labels,
  answerLine: DEFAULT_PROFILE.answerLine,
  kinds: Object.freeze({}),
});
const PRESETS = Object.freeze({ po: DEFAULT_PROFILE, none: NONE_PROFILE });
const PRESET_NAMES = Object.keys(PRESETS);
// The script the PO arrange feature runs (leader-tabs reseats the PO panes with it, prs writes the pane list it reads). `~` is this user's home.
const PO_ARRANGE_SCRIPT = "~/.claude/skills/leader/herdr-team.sh";

class ProfileError extends Error {}

const homeOf = (env = process.env) => env.HOME || env.USERPROFILE || os.homedir();
const expandHome = (p, env = process.env) => (/^~(?=$|[\\/])/.test(p) ? homeOf(env) + p.slice(1) : p);
const fileExists = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };

// Which preset a profile starts from: the file's `preset`, else (no file at all) "po" when the arrange script exists here and "none" otherwise.
function resolvePreset(raw, hasFile, env = process.env) {
  if (raw && raw.preset !== undefined) {
    const name = String(raw.preset);
    if (!PRESETS[name]) throw new ProfileError(`profile: preset must be one of ${PRESET_NAMES.join(", ")} (got ${JSON.stringify(raw.preset)})`);
    return name;
  }
  if (hasFile) return "po";
  return fileExists(expandHome(PO_ARRANGE_SCRIPT, env)) ? "po" : "none";
}

function inboxDir(env = process.env) { return env.HERDR_INBOX_DIR || path.join(os.homedir(), ".herdr-inbox"); }

const plain = (v) => v && typeof v === "object" && !Array.isArray(v);
function regexOf(src, what) {
  try { return new RegExp(String(src)); } catch { throw new ProfileError(`profile: ${what} is not a valid regular expression: ${src}`); }
}
const text1 = (v, what, safe) => {
  const s = String(v ?? "").trim();
  if (!s || (safe && !safe.test(s))) throw new ProfileError(`profile: ${what} must be a simple word (letters, digits, . _ -): "${s}"`);
  return s;
};

// "리더 · " -> /^\s*리더\s*·\s*/: the words of the prefix, each escaped, with any whitespace (or none) between them. "" -> null (nothing is cut).
function prefixRegex(prefix) {
  const words = String(prefix ?? "").trim().split(/\s+/).filter(Boolean).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return words.length ? new RegExp(`^\\s*${words.join("\\s*")}\\s*`) : null;
}

// The arrange script path as configured (`~` kept, the shell and the mods expand it), or "" when none is configured or the file is missing:
// a feature whose script is not there is hidden rather than failing.
function arrangeScript(configured, env) {
  const c = String(configured ?? "").trim();
  return c && fileExists(expandHome(c, env)) ? c : "";
}

// Reads the profile (see DEFAULT_PROFILE) and returns it ready to use: patterns compiled, names checked. Unknown keys are ignored.
// A missing file is the default; an unreadable or invalid one is an error so a typo never silently falls back to other names.
function loadProfile(env = process.env) {
  const file = env.HERDR_INBOX_PROFILE || path.join(inboxDir(env), "profile.json");
  let raw = {};
  let text = null;
  try { text = fs.readFileSync(file, "utf8"); } catch (e) {
    if (!(e.code === "ENOENT" || e.code === "ENOTDIR") || env.HERDR_INBOX_PROFILE) throw new ProfileError(`cannot read profile ${file}: ${e.code || e.message}`); // only the default location may be absent
  }
  if (text !== null) {
    try { raw = JSON.parse(text.replace(/^﻿/, "")); } catch { throw new ProfileError(`profile ${file} is not valid JSON`); }
    if (!plain(raw)) throw new ProfileError(`profile ${file} must be a JSON object`);
    if (raw.v !== undefined && raw.v !== 1) throw new ProfileError(`profile ${file}: only v 1 is known (got ${JSON.stringify(raw.v)})`);
  }
  const preset = resolvePreset(raw, text !== null, env);
  const d = PRESETS[preset];
  const pick = (key) => ({ ...d[key], ...(plain(raw[key]) ? raw[key] : {}) });
  const agent = pick("agent"), hub = pick("hub"), labels = pick("labels");
  const aliases = plain(raw.kinds) ? raw.kinds : {};
  const kindMap = {};
  for (const [alias, kind] of Object.entries(aliases)) {
    if (!REPORT_KINDS.includes(kind)) throw new ProfileError(`profile: kinds.${alias} must map to one of ${REPORT_KINDS.join(", ")}`);
    if (KINDS.includes(alias)) throw new ProfileError(`profile: kinds.${alias} is already a contract kind`);
    kindMap[alias] = kind;
  }
  const answerLine = raw.answerLine === undefined ? d.answerLine : String(raw.answerLine);
  for (const slot of ["{kind}", "{agent}", "{text}"]) if (!answerLine.includes(slot)) throw new ProfileError(`profile: answerLine must contain ${slot}`);
  const strip = String(agent.strip ?? "");
  return {
    agentName: regexOf(agent.name, "agent.name"),
    agentRole: String(agent.role ?? "").trim(),
    preset,
    arrangeScript: arrangeScript(raw.arrangeScript === undefined ? (preset === "po" ? PO_ARRANGE_SCRIPT : "") : raw.arrangeScript, env),
    agentTitlePrefix: String(agent.titlePrefix ?? ""),
    agentStrip: strip ? regexOf(strip, "agent.strip") : null,
    hubRole: preset === "none" && !String(hub.role ?? "").trim() ? "" : text1(hub.role, "hub.role"), // only "none" has no hub; the others need a role value
    hubIdLabel: text1(hub.idLabel, "hub.idLabel", SAFE_NAME),
    hubId: regexOf(hub.id, "hub.id"),
    hubDir: text1(hub.dir, "hub.dir", SAFE_DIR),
    labelRole: text1(labels.role, "labels.role", SAFE_NAME),
    labelWait: text1(labels.wait, "labels.wait", SAFE_NAME),
    labelWaitLink: text1(labels.waitLink, "labels.waitLink", SAFE_NAME),
    labelSession: text1(labels.session, "labels.session", SAFE_NAME),
    answerLine,
    kindMap,
  };
}

// The part of a loaded profile the desk needs, as plain JSON (patterns as their source text): what `node inbox.cjs` prints as `names`,
// and what the desk (which cannot require this file) compiles again. The defaults here and in the desk's names block must match (a test).
function namesOf(p) {
  return {
    agentName: p.agentName.source, agentRole: p.agentRole, titlePrefix: (prefixRegex(p.agentTitlePrefix) ?? { source: "" }).source, titlePrefixText: p.agentTitlePrefix, strip: p.agentStrip ? p.agentStrip.source : "",
    hubRole: p.hubRole, hubIdLabel: p.hubIdLabel, hubId: p.hubId.source, hubDir: p.hubDir,
    labelRole: p.labelRole, labelWait: p.labelWait, labelWaitLink: p.labelWaitLink, labelSession: p.labelSession, answerLine: p.answerLine,
    preset: p.preset, arrangeScript: p.arrangeScript,
  };
}

module.exports = { loadProfile, namesOf, prefixRegex, inboxDir, resolvePreset, ProfileError, DEFAULT_PROFILE, NONE_PROFILE, PRESETS, PO_ARRANGE_SCRIPT, KINDS, REPORT_KINDS, SAFE_NAME, SAFE_DIR };
