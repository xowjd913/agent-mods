#!/usr/bin/env node
// claude-account: the Claude accounts the PO desk can start new sessions with (issue #121).
// One account = one CLAUDE_CONFIG_DIR (~/.claude-accounts/<id>). The default account is the variable UNSET (never ~/.claude spelled out):
// Claude Code names its Keychain entry after the exact CLAUDE_CONFIG_DIR string, so a dir is stored normalized and passed byte-identical.
// The store (~/.herdr-inbox/claude-accounts.json) holds ids, labels and dirs only: never a token, an e-mail or an oauthAccount value.
// Mods cannot require this file; they call it as a CLI (JSON on stdout). Pure helpers are exported for the tests.
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");

const ROOT_NAME = ".claude-accounts";
const STORE_NAME = "claude-accounts.json";
const CACHE_NAME = "claude-accounts-cache.json";
const LOGIN_NAME = "claude-login.json";
const WIN_NOTE = "Windows에서는 아직 지원하지 않습니다(이슈 #121 후속)";
const ID_RE = /^[a-z0-9][a-z0-9-]{0,18}$/;
const LABEL_MAX = 40;
const DEFAULT_LABEL = "기본";
const STATUS_TTL = 5 * 60 * 1000;
const LOGIN_TIMEOUT = 15 * 60 * 1000;
const RUNNING = new Set(["starting", "waiting"]);
// Shared with the default config dir by link. Never shared: .claude.json (the login), projects, sessions, caches, usage-limits.json.
const SHARED = ["CLAUDE.md", "settings.json", "skills", "hooks", "plugins", "output-styles", "keybindings.json", "my-mods", "dev-mods", "po-slack-webhook"];

function makeCtx(over = {}) {
  return {
    env: process.env, platform: process.platform, home: null, now: Date.now(),
    run: (cmd, args, o = {}) => {
      const r = spawnSync(cmd, args, { encoding: "utf8", timeout: o.timeout || 20000, env: o.env, cwd: o.cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      return { status: r.error ? -1 : r.status, stdout: r.stdout || "", stderr: r.stderr || "" };
    },
    ...over,
  };
}
function homeDir(ctx) { return ctx.home || ctx.env.HOME || ctx.env.USERPROFILE || os.homedir(); }
function inboxDir(ctx) { return ctx.env.HERDR_INBOX_DIR || path.join(homeDir(ctx), ".herdr-inbox"); }
function rootDir(ctx) { return path.join(homeDir(ctx), ROOT_NAME); }
function defaultDir(ctx) { return path.join(homeDir(ctx), ".claude"); } // only the seed source and the default usage file; never put in CLAUDE_CONFIG_DIR
function storeFile(ctx) { return path.join(inboxDir(ctx), STORE_NAME); }

// ---- store ----
// An absolute path without a trailing separator. The exact string goes into CLAUDE_CONFIG_DIR, so it is made once, here.
function normDir(p) {
  const r = path.resolve(String(p));
  const root = path.parse(r).root;
  return r.length > root.length ? r.replace(/[\\/]+$/, "") : r;
}
function dirFor(ctx, id) { return normDir(path.join(rootDir(ctx), id)); }
function validLabel(label) {
  const s = String(label ?? "").replace(/\s+/g, " ").trim();
  if (!s) return { ok: false, message: "이름을 입력하세요." };
  if (s.length > LABEL_MAX) return { ok: false, message: `이름은 ${LABEL_MAX}자 이하여야 합니다.` };
  if (/[\u0000-\u001f\u007f]/.test(s)) return { ok: false, message: "이름에 쓸 수 없는 문자가 있습니다." };
  return { ok: true, label: s };
}
// An entry is kept only when its dir is exactly <root>/<id>: a hand-edited store cannot point a session at another folder.
function cleanAccounts(ctx, list) {
  const seen = new Set(), out = [];
  for (const a of Array.isArray(list) ? list : []) {
    if (!a || typeof a.id !== "string" || !ID_RE.test(a.id) || seen.has(a.id)) continue;
    const l = validLabel(a.label);
    if (!l.ok || typeof a.dir !== "string" || a.dir !== dirFor(ctx, a.id)) continue;
    seen.add(a.id);
    out.push({ id: a.id, label: l.label, dir: a.dir });
  }
  return out;
}
function readStore(ctx) {
  let raw = null;
  try { raw = JSON.parse(fs.readFileSync(storeFile(ctx), "utf8")); } catch { /* none or broken: empty store */ }
  const accounts = cleanAccounts(ctx, raw?.accounts);
  const selected = typeof raw?.selected === "string" && accounts.some((a) => a.id === raw.selected) ? raw.selected : null;
  return { accounts, selected };
}
function writeAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, file);
}
function writeStore(ctx, store) {
  writeAtomic(storeFile(ctx), { accounts: cleanAccounts(ctx, store.accounts), selected: store.selected ?? null });
}
function findAccount(store, id) { return store.accounts.find((a) => a.id === id) || null; }
// The dir the desk selection names, or null (= default account = CLAUDE_CONFIG_DIR unset).
function selectedDir(ctx) {
  const s = readStore(ctx);
  return findAccount(s, s.selected)?.dir ?? null;
}
function newId(ctx, label, store) {
  const base = String(label).toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 12) || "acct";
  for (let n = 0; n < 50; n++) {
    const id = `${base}-${crypto.randomBytes(3).toString("hex")}`;
    if (!findAccount(store, id) && !fs.existsSync(dirFor(ctx, id))) return id;
  }
  throw new Error("계정 폴더 이름을 정하지 못했습니다.");
}

// ---- seeding ----
// Link the shared items of the default config dir into a new account dir. A symlink first; where that is not allowed (Windows without
// developer mode) a junction for folders and a copy for files. Items the default dir does not have are skipped; existing targets are left.
function seed(ctx, dir, opts = {}) {
  const src = opts.from || defaultDir(ctx);
  const win = ctx.platform === "win32";
  const sym = ctx.symlink || ((t, p, type) => fs.symlinkSync(t, p, type));
  const cp = ctx.copy || ((a, b) => fs.copyFileSync(a, b));
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch { /* Windows has no mode bits */ }
  const report = { linked: [], junctions: [], copied: [], skipped: [], failed: [] };
  for (const name of SHARED) {
    const from = path.join(src, name), to = path.join(dir, name);
    let st;
    try { st = fs.statSync(from); } catch { report.skipped.push(name); continue; }
    try { fs.lstatSync(to); report.skipped.push(name); continue; } catch { /* free */ }
    const isDir = st.isDirectory();
    try { sym(from, to, win ? (isDir ? "dir" : "file") : undefined); report.linked.push(name); continue; } catch { /* try the fallback */ }
    try {
      if (isDir) { sym(from, to, "junction"); report.junctions.push(name); }
      else { cp(from, to); report.copied.push(name); }
    } catch (e) { report.failed.push(name); }
  }
  return report;
}

// ---- argv / env ----
// The env part of an `env ... claude ...` argv for the account selected on the desk (or for an explicit dir): [] for the default account.
function envArgs(dir) { return dir ? [`CLAUDE_CONFIG_DIR=${normDir(dir)}`] : []; }
// The login command the desk starts in a background terminal (macOS/Linux: env carries the dir; hc run has no --env).
function loginArgv(ctx, dir) {
  return ["env", `PATH=${ctx.env.PATH || ""}`, ...envArgs(dir), "claude", "auth", "login", "--claudeai"];
}
function claudeEnv(ctx, dir) {
  const env = { ...ctx.env };
  delete env.CLAUDE_CONFIG_DIR;
  if (dir) env.CLAUDE_CONFIG_DIR = normDir(dir);
  return env;
}

// ---- which account is a session on ----
function envTokenDir(argv) {
  if (!Array.isArray(argv)) return undefined;
  for (const t of argv) {
    if (typeof t !== "string") continue;
    if (t === "claude" || t.startsWith("-")) break; // the env part ends at the program
    if (t.startsWith("CLAUDE_CONFIG_DIR=")) return t.slice("CLAUDE_CONFIG_DIR=".length);
  }
  return null;
}
// One variable of `ps eww` output (the process env), nothing else of the line. A path may hold spaces, so the value runs up to the
// next ` NAME=` token (or the end), never up to the next space.
function psConfigDir(ctx, pid) {
  if (!Number.isInteger(pid) || pid <= 0 || ctx.platform === "win32") return undefined;
  const r = ctx.run("ps", ["eww", "-p", String(pid), "-o", "command="]);
  if (r.status !== 0) return undefined;
  const m = /(?:^|\s)CLAUDE_CONFIG_DIR=(.*?)(?=\s+[A-Za-z_][A-Za-z0-9_]*=|\s*$)/.exec(r.stdout.replace(/\r?\n/g, " "));
  return m ? m[1] : null;
}
// The label of a dir: "기본" for none, the account's label, else the folder name (never anything of the contents).
function labelForDir(store, dir) {
  if (dir === null) return DEFAULT_LABEL;
  if (typeof dir !== "string" || !dir.trim()) return DEFAULT_LABEL;
  const n = normDir(dir.trim());
  const a = store.accounts.find((x) => x.dir === n);
  if (a) return a.label;
  return path.basename(n).replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 40) || DEFAULT_LABEL;
}
// info = `hc get --json` of the terminal. argv first; the process env (ps) only when the argv does not carry the variable.
// Returns the label, or null when it cannot be told (Windows without argv, no pid).
function sessionLabel(ctx, store, info) {
  const fromArgv = envTokenDir(info?.argv);
  if (typeof fromArgv === "string") return labelForDir(store, fromArgv);
  const viaPs = psConfigDir(ctx, info?.pid);
  return viaPs === undefined ? null : labelForDir(store, viaPs);
}

// ---- login status ----
// `claude auth status --json` reduced to the two fields the desk shows.
function reduceStatus(stdout) {
  let j;
  try { j = JSON.parse(stdout); } catch { return null; }
  if (!j || typeof j !== "object") return null;
  const m = typeof j.authMethod === "string" ? j.authMethod.replace(/[^\w.-]/g, "").slice(0, 30) : null;
  return { loggedIn: j.loggedIn === true, authMethod: m || null };
}
function readCache(ctx) { try { return JSON.parse(fs.readFileSync(path.join(inboxDir(ctx), CACHE_NAME), "utf8")) || {}; } catch { return {}; } }
function writeCache(ctx, c) { try { writeAtomic(path.join(inboxDir(ctx), CACHE_NAME), c); } catch { /* a cache */ } }
function cachedStatus(ctx, key) {
  const e = readCache(ctx)[key];
  return e && typeof e.at === "number" ? { loggedIn: e.loggedIn === true, authMethod: e.authMethod ?? null, at: e.at, fresh: ctx.now - e.at < STATUS_TTL } : null;
}
function refreshStatus(ctx, key, dir) {
  const r = ctx.run("claude", ["auth", "status", "--json"], { env: claudeEnv(ctx, dir), timeout: 20000 });
  const s = reduceStatus(r.stdout);
  if (!s) return { loggedIn: null, authMethod: null, error: "claude auth status 를 읽지 못했습니다." };
  const c = readCache(ctx);
  c[key] = { ...s, at: ctx.now };
  writeCache(ctx, c);
  return { ...s, at: ctx.now, fresh: true };
}
function dropCache(ctx, key) { const c = readCache(ctx); if (key in c) { delete c[key]; writeCache(ctx, c); } }

// Same-account check. To tell whether two folders hold the same Claude account, this reads ONE field, oauthAccount.accountUuid, of
// <dir>/.claude.json (~/.claude.json for the default) and hashes it at once. The id and the hash live only in this call: they are
// never stored, logged, printed or sent anywhere, and nothing else of the file is read.
function fingerprint(ctx, dir) {
  const file = dir ? path.join(dir, ".claude.json") : path.join(homeDir(ctx), ".claude.json");
  try {
    const u = JSON.parse(fs.readFileSync(file, "utf8"))?.oauthAccount?.accountUuid;
    return typeof u === "string" && u ? crypto.createHash("sha256").update(u).digest("hex") : null;
  } catch { return null; }
}
// Ids ("default" or an account id) of the other accounts that are the same Claude account as `dir`.
function sameAs(ctx, store, id) {
  const me = findAccount(store, id);
  const mine = me && fingerprint(ctx, me.dir);
  if (!mine) return [];
  const out = [];
  if (fingerprint(ctx, null) === mine) out.push("default");
  for (const a of store.accounts) if (a.id !== id && fingerprint(ctx, a.dir) === mine) out.push(a.id);
  return out;
}

// ---- usage per account ----
function parseUsage(raw, now) {
  let d;
  try { d = JSON.parse(raw); } catch { return null; }
  const updated = Date.parse(d?.updatedAt ?? "");
  if (!Number.isFinite(updated) || now - updated > 10 * 60 * 1000) return null;
  const L = { five_hour: "5h", seven_day: "7d" };
  const rows = (Array.isArray(d.limits) ? d.limits : []).filter((l) => L[l?.kind] && Number.isFinite(l.percentUsed)).map((l) => ({ label: L[l.kind], percent: Math.round(l.percentUsed) }));
  return rows.length ? rows : null;
}
function usageOf(ctx, dir) {
  try { return parseUsage(fs.readFileSync(path.join(dir || defaultDir(ctx), "usage-limits.json"), "utf8"), ctx.now); } catch { return null; }
}

// ---- commands ----
function list(ctx) {
  const store = readStore(ctx);
  const row = (id, label, dir) => {
    const key = id || "default";
    return { id, label, folder: dir ? path.basename(dir) : null, status: cachedStatus(ctx, key), usage: usageOf(ctx, dir), selected: (store.selected ?? null) === id };
  };
  return { selected: store.selected, accounts: [row(null, "기본 계정", null), ...store.accounts.map((a) => row(a.id, a.label, a.dir))] };
}
function status(ctx, id, force) {
  const store = readStore(ctx);
  const a = id ? findAccount(store, id) : null;
  if (id && !a) return { ok: false, message: "목록에 없는 계정입니다." };
  const key = id || "default";
  const c = cachedStatus(ctx, key);
  if (c && c.fresh && !force) return { ok: true, ...c };
  return { ok: true, ...refreshStatus(ctx, key, a ? a.dir : null) };
}
function add(ctx, label) {
  if (ctx.platform === "win32") return { ok: false, message: WIN_NOTE };
  const l = validLabel(label);
  if (!l.ok) return { ok: false, message: l.message };
  const store = readStore(ctx);
  if (l.label === DEFAULT_LABEL || l.label === "기본 계정" || store.accounts.some((a) => a.label.toLowerCase() === l.label.toLowerCase())) return { ok: false, message: "같은 이름의 계정이 이미 있습니다." };
  const id = newId(ctx, l.label, store);
  const dir = dirFor(ctx, id);
  const report = seed(ctx, dir);
  store.accounts.push({ id, label: l.label, dir });
  writeStore(ctx, store);
  return { ok: true, id, label: l.label, seed: report };
}
function select(ctx, id) {
  if (id && ctx.platform === "win32") return { ok: false, message: WIN_NOTE }; // no half path: a Windows session would not get the account
  const store = readStore(ctx);
  if (id && !findAccount(store, id)) return { ok: false, message: "목록에 없는 계정입니다." };
  store.selected = id || null;
  writeStore(ctx, store);
  // A selected account that is known not to be logged in: new sessions would start at the login screen.
  const c = id ? cachedStatus(ctx, id) : null;
  return c && c.loggedIn === false ? { ok: true, selected: store.selected, warning: "아직 로그인되지 않은 계정입니다. 새 세션이 로그인 화면에서 멈출 수 있습니다." } : { ok: true, selected: store.selected };
}
function remove(ctx, id) {
  const store = readStore(ctx);
  const a = findAccount(store, id);
  if (!a) return { ok: false, message: "목록에 없는 계정입니다." };
  const lg = loginStatus(ctx);
  if (lg.id === id && RUNNING.has(lg.state)) return { ok: false, message: "이 계정의 로그인이 진행 중입니다. 먼저 그만두세요." };
  store.accounts = store.accounts.filter((x) => x.id !== id);
  if (store.selected === id) store.selected = null;
  writeStore(ctx, store);
  dropCache(ctx, id);
  return { ok: true, keptFolder: a.dir }; // the folder stays on disk
}
function logout(ctx, id) {
  const a = findAccount(readStore(ctx), id);
  if (!a) return { ok: false, message: "목록에 없는 계정입니다." };
  const r = ctx.run("claude", ["auth", "logout"], { env: claudeEnv(ctx, a.dir), timeout: 30000 });
  dropCache(ctx, id);
  return r.status === 0 ? { ok: true } : { ok: false, message: "로그아웃하지 못했습니다." };
}

// ---- login (a background hc terminal runs `claude auth login --claudeai`) ----
function loginFile(ctx) { return path.join(inboxDir(ctx), LOGIN_NAME); }
function readLogin(ctx) { try { return JSON.parse(fs.readFileSync(loginFile(ctx), "utf8")); } catch { return null; } }
function writeLogin(ctx, st) { writeAtomic(loginFile(ctx), st); }
// The first https URL of the screen text. The terminal wraps a long URL over rows: the rows after it without spaces are its rest.
function parseLoginUrl(text) {
  const rows = String(text || "").replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").split("\n").map((l) => l.replace(/\s+$/, ""));
  for (let i = 0; i < rows.length; i++) {
    const m = rows[i].match(/https:\/\/\S+/);
    if (!m) continue;
    let url = m[0];
    if (m.index + m[0].length === rows[i].length) {
      for (let j = i + 1; j < rows.length && rows[j] && !/\s/.test(rows[j].trim()) && !/^\s/.test(rows[j]); j++) url += rows[j].trim();
    }
    return url.length <= 4000 ? url : null;
  }
  return null;
}
function hcJson(ctx, args) {
  if (!ctx.hc) return null;
  const r = ctx.hc(args);
  if (r.status !== 0) return null;
  try { return JSON.parse(r.stdout); } catch { return null; }
}
function loginStart(ctx, id) {
  if (ctx.platform === "win32") return { ok: false, message: WIN_NOTE };
  const store = readStore(ctx);
  const a = findAccount(store, id);
  if (!a) return { ok: false, message: "목록에 없는 계정입니다." };
  const cur = loginStatus(ctx);
  if (RUNNING.has(cur.state)) return { ok: false, message: "이미 로그인이 진행 중입니다.", login: cur };
  seed(ctx, a.dir); // a dir whose shared links were removed gets them again
  const r = ctx.hc(["run", "--bg", "--json", "--no-parent", "--cwd", a.dir, "--label", `claude-login=${a.id}`, "--", ...loginArgv(ctx, a.dir)]);
  let addr = null;
  try { addr = JSON.parse(r.stdout)?.address ?? null; } catch { /* below */ }
  if (r.status !== 0 || !addr) return { ok: false, message: "로그인 터미널을 열지 못했습니다. Herdr 가 켜져 있는지 보세요." };
  writeLogin(ctx, { id: a.id, label: a.label, terminal: addr, state: "starting", url: null, startedAt: ctx.now, message: null, duplicate: false });
  return { ok: true, login: readLogin(ctx) };
}
function loginStatus(ctx) {
  const st = readLogin(ctx);
  if (!st) return { state: "none" };
  if (!RUNNING.has(st.state)) return st;
  const info = hcJson(ctx, ["get", st.terminal, "--json"]);
  const gone = !info;
  if (!gone && info.state === "live") {
    if (ctx.now - st.startedAt > LOGIN_TIMEOUT) {
      ctx.hc(["kill", st.terminal]);
      return endLogin(ctx, st, "failed", "15분 안에 로그인이 끝나지 않아 멈췄습니다.", st.terminal);
    }
    const scr = hcJson(ctx, ["read", st.terminal, "--json", "--lines", "20"]);
    const url = parseLoginUrl(scr?.text);
    if (url && (url !== st.url || st.state !== "waiting")) { const next = { ...st, state: "waiting", url }; writeLogin(ctx, next); return next; }
    return st;
  }
  if (gone) return endLogin(ctx, st, "failed", "로그인 터미널을 찾지 못했습니다. 다시 시도하세요.", null);
  if (info.exit_code === 0) {
    const store = readStore(ctx);
    const s = refreshStatus(ctx, st.id, findAccount(store, st.id)?.dir ?? null);
    if (s.loggedIn === true) {
      const dup = sameAs(ctx, store, st.id).length > 0;
      return endLogin(ctx, st, "done", dup ? "이미 등록된 계정과 같음: 같은 Claude 계정을 또 로그인했습니다." : null, st.terminal, { duplicate: dup });
    }
    return endLogin(ctx, st, "failed", "로그인 명령은 끝났지만 로그인된 계정을 확인하지 못했습니다.", st.terminal);
  }
  return endLogin(ctx, st, "failed", "로그인에 실패했습니다.", st.terminal);
}
function endLogin(ctx, st, state, message, terminal, extra = {}) {
  const next = { ...st, state, message, url: null, ...extra };
  writeLogin(ctx, next);
  if (terminal && ctx.hc) ctx.hc(["rm", terminal]);
  return next;
}
function loginCancel(ctx) {
  const st = loginStatus(ctx);
  if (!RUNNING.has(st.state)) return { ok: false, message: "진행 중인 로그인이 없습니다." };
  if (ctx.hc) ctx.hc(["kill", st.terminal]);
  endLogin(ctx, st, "cancelled", "로그인을 그만뒀습니다.", st.terminal);
  return { ok: true };
}

// ---- CLI ----
function flag(args, name) { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; }
function main(argv, over = {}) {
  const ctx = makeCtx({ hc: (a, o) => makeCtx().run("hc", a, o), ...over });
  const [cmd, ...rest] = argv;
  const out = (o) => { process.stdout.write(JSON.stringify(o) + "\n"); return o.ok === false ? 1 : 0; };
  const id = flag(rest, "--id");
  switch (cmd) {
    case "list": return out(list(ctx));
    case "status": return out(status(ctx, id, rest.includes("--refresh")));
    case "add": return out(add(ctx, flag(rest, "--label")));
    case "select": return out(select(ctx, id));
    case "remove": return out(remove(ctx, id));
    case "logout": return out(logout(ctx, id));
    case "login": {
      const [sub, ...a] = rest;
      if (sub === "start") return out(loginStart(ctx, flag(a, "--id")));
      if (sub === "status") return out(loginStatus(ctx));
      if (sub === "cancel") return out(loginCancel(ctx));
      break;
    }
    case "label": {
      // `label --info <json>`: {argv, pid} of a terminal (from `hc get --json`; the desk reads it, this tool has no hc). The account its claude runs on, or null.
      let info = null;
      try { info = JSON.parse(flag(rest, "--info") ?? "null"); } catch { /* none */ }
      process.stdout.write(JSON.stringify({ label: info && typeof info === "object" ? sessionLabel(ctx, readStore(ctx), info) : null }) + "\n");
      return 0;
    }
    default: break;
  }
  process.stderr.write("usage: claude-account list|status|add|select|remove|logout|login start|status|cancel|label --info <json>\n");
  return 2;
}

module.exports = {
  SHARED, WIN_NOTE, ID_RE, DEFAULT_LABEL, normDir, dirFor, validLabel, cleanAccounts, readStore, writeStore, selectedDir, newId,
  seed, envArgs, loginArgv, claudeEnv, envTokenDir, psConfigDir, labelForDir, sessionLabel, reduceStatus, fingerprint, sameAs,
  parseUsage, usageOf, parseLoginUrl, list, status, add, select, remove, logout, loginStart, loginStatus, loginCancel, makeCtx, main,
};
if (require.main === module) process.exitCode = main(process.argv.slice(2));
