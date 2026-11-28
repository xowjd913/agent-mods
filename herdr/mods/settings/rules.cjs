// The profile writer of the settings window's 규칙 section (#126). The window cannot read or write files outside the Herdr folder, so it runs this
// through herdr `exec`: `node rules.cjs show | set <url-encoded json> | reset`. Every command prints ONE JSON line (the state after the command) and exits 0
// unless the process itself broke. It uses the SAME loader as the inbox tools (profile.cjs, copied here by the installer): `set` validates the new
// file with loadProfile BEFORE it replaces the old one, keeps the old file as `<file>.bak`, swaps atomically (temp file + rename) and leaves every key
// it does not edit (unknown keys, kinds, labels, answerLine, ...) as it was. Environment: HERDR_INBOX_PROFILE / HERDR_INBOX_DIR (as profile.cjs).
// No dependencies.
"use strict";
const fs = require("fs");
const path = require("path");
// The loader is shared with the inbox tools. The installer copies it next to this file; in the repository it is the inbox mod's file.
let P = null;
for (const p of ["./profile.cjs", "../inbox/profile.cjs"]) { try { P = require(p); break; } catch (e) { if (e.code !== "MODULE_NOT_FOUND") throw e; } }
if (!P) throw new Error("profile.cjs not found next to rules.cjs");

// The keys the window edits: field id -> path in the profile file. (The rest of the file is edited by hand.)
const FIELDS = {
  "agent.name": ["agent", "name"], "agent.role": ["agent", "role"], "agent.titlePrefix": ["agent", "titlePrefix"], "agent.strip": ["agent", "strip"],
  "hub.role": ["hub", "role"], "hub.id": ["hub", "id"], arrangeScript: ["arrangeScript"],
};
const MAX_VALUE = 300;
const plain = (v) => v && typeof v === "object" && !Array.isArray(v);
const getPath = (o, p) => p.reduce((x, k) => (plain(x) ? x[k] : undefined), o);

// What each preset gives a field when the file does not set it.
function defaultsOf(presetName) {
  const d = P.PRESETS[presetName];
  const out = {};
  for (const [id, p] of Object.entries(FIELDS)) out[id] = id === "arrangeScript" ? (presetName === "po" ? P.PO_ARRANGE_SCRIPT : "") : String(getPath(d, p) ?? "");
  return out;
}

const fileExists = (f) => { try { return fs.statSync(f).isFile(); } catch { return false; } };
const homeOf = (env) => env.HOME || env.USERPROFILE || require("os").homedir();
const expandHome = (p, env) => (/^~(?=$|[\\/])/.test(p) ? homeOf(env) + p.slice(1) : p);

// The state the window shows: which file, whether it is there, the effective preset and why, the values of the edited keys, or the error.
function describe(env = process.env) {
  const file = P.profilePath(env);
  const out = { ok: true, file, source: env.HERDR_INBOX_PROFILE ? "env" : "default", exists: fileExists(file), backup: fileExists(`${file}.bak`), error: null, broken: false,
    preset: null, why: null, presetInFile: null, fields: null, fileValues: {}, defaults: { po: defaultsOf("po"), none: defaultsOf("none") }, arrangeScriptExists: false, names: null };
  let read = null;
  try { read = P.readProfileFile(env); } catch (e) {
    if (!(e instanceof P.ProfileError)) throw e;
    out.error = e.message;
    out.broken = out.exists; // a present file that cannot be read as a profile: only a reset helps (a missing HERDR_INBOX_PROFILE file is simply created by a save)
    return out;
  }
  const raw = read.raw;
  let ex = null;
  try { ex = P.explainPreset(raw, read.text !== null, env); } catch (e) {
    if (!(e instanceof P.ProfileError)) throw e;
    out.error = e.message; // e.g. an unknown preset: still editable, a save fixes it
    out.presetInFile = String(raw.preset);
    ex = { preset: "po", why: "file-default" };
  }
  out.preset = ex.preset;
  out.why = ex.why;
  if (raw.preset !== undefined) out.presetInFile = String(raw.preset);
  const d = defaultsOf(ex.preset);
  out.fields = {};
  for (const [id, p] of Object.entries(FIELDS)) {
    const v = getPath(raw, p);
    if (v !== undefined) out.fileValues[id] = String(v); // what the file itself sets (the window shows these over a preset's defaults)
    out.fields[id] = v !== undefined ? String(v) : d[id];
  }
  out.arrangeScriptExists = Boolean(out.fields.arrangeScript) && fileExists(expandHome(out.fields.arrangeScript, env));
  try { out.names = P.namesOf(P.compileProfile(raw, read.text !== null, env)); } catch (e) {
    if (!(e instanceof P.ProfileError)) throw e;
    out.error = out.error || e.message;
  }
  return out;
}

// Applies { preset, fields } to a copy of `raw`: a field equal to the new preset's default is removed from the file (the preset supplies it), any other
// value is written. Fields that are not in `fields` stay as they are.
function applyPatch(raw, patch) {
  if (!plain(patch)) throw new P.ProfileError("nothing to save");
  const next = JSON.parse(JSON.stringify(raw));
  if (patch.preset !== undefined) {
    if (!P.PRESETS[String(patch.preset)]) throw new P.ProfileError(`preset must be one of ${Object.keys(P.PRESETS).join(", ")}`);
    next.preset = String(patch.preset);
  }
  const preset = next.preset !== undefined ? String(next.preset) : "po";
  const d = P.PRESETS[preset] ? defaultsOf(preset) : defaultsOf("po");
  for (const [id, value] of Object.entries(plain(patch.fields) ? patch.fields : {})) {
    const p = FIELDS[id];
    if (!p) throw new P.ProfileError(`unknown field ${id}`);
    if (typeof value !== "string") throw new P.ProfileError(`${id} must be text`);
    if (value.length > MAX_VALUE) throw new P.ProfileError(`${id} is longer than ${MAX_VALUE} characters`);
    const v = id === "arrangeScript" ? value.trim() : value;
    const parent = p.length === 2 ? (plain(next[p[0]]) ? next[p[0]] : (next[p[0]] = {})) : next;
    const key = p[p.length - 1];
    if (v === d[id]) delete parent[key]; else parent[key] = v;
    if (p.length === 2 && Object.keys(parent).length === 0) delete next[p[0]];
  }
  if (next.v === undefined) next.v = 1;
  return next;
}

function save(patch, env = process.env) {
  const file = P.profilePath(env);
  let raw = {};
  try { raw = P.readProfileFile(env).raw; } catch (e) {
    if (!(e instanceof P.ProfileError)) throw e;
    if (fileExists(file)) return { ...describe(env), ok: false, error: `${e.message}. 기본값으로 되돌린 뒤 저장하세요.` }; // unreadable / not JSON: never overwrite it blindly
  }
  const tmp = `${file}.tmp-${process.pid}`;
  try {
    const next = applyPatch(raw, patch);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
    P.loadProfile({ ...env, HERDR_INBOX_PROFILE: tmp }); // the real loader on exactly what would be written; throws a ProfileError for anything it rejects
    if (fileExists(file)) fs.copyFileSync(file, `${file}.bak`);
    fs.renameSync(tmp, file);
    return { ...describe(env), saved: true };
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch {}
    if (!(e instanceof P.ProfileError)) return { ...describe(env), ok: false, error: `저장하지 못했습니다: ${String(e.message || e).slice(0, 160)}` };
    return { ...describe(env), ok: false, error: e.message.replace(tmp, file) };
  }
}

// Back to the defaults: the profile file is renamed to `<file>.bak` (an older .bak is replaced), so the inbox tools see no file again.
function reset(env = process.env) {
  const file = P.profilePath(env);
  try {
    if (fileExists(file)) fs.renameSync(file, `${file}.bak`);
    return { ...describe(env), reset: true };
  } catch (e) { return { ...describe(env), ok: false, error: `되돌리지 못했습니다: ${String(e.message || e).slice(0, 160)}` }; }
}

function main(argv, env = process.env) {
  const [cmd, arg] = argv;
  if (cmd === "show") return describe(env);
  if (cmd === "set") {
    let patch;
    try { patch = JSON.parse(decodeURIComponent(String(arg ?? ""))); } catch { return { ...describe(env), ok: false, error: "set needs a URL-encoded JSON patch" }; } // URL-encoded: plain ASCII, so no shell or argument quoting can change it
    return save(patch, env);
  }
  if (cmd === "reset") return reset(env);
  return { ok: false, error: "usage: node rules.cjs show | set <url-encoded json> | reset" };
}

if (require.main === module) {
  try { process.stdout.write(`${JSON.stringify(main(process.argv.slice(2)))}\n`); } catch (e) { process.stdout.write(`${JSON.stringify({ ok: false, error: String(e.message || e) })}\n`); process.exitCode = 1; }
}
module.exports = { main, describe, save, reset, applyPatch, FIELDS, defaultsOf };
