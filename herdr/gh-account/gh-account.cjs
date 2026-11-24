#!/usr/bin/env node
// gh-account: 저장소 주인(owner)별로 GitHub 계정을 골라 git 인증, gh 명령, 커밋 신원에 쓴다.
// 토큰은 저장하지 않고 쓸 때마다 `gh auth token --user`로 받는다. gh 활성 계정은 바꾸지 않는다.
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const HOST = "github.com";
const MARK = "gh-account-managed";
const BEGIN = "# >>> gh-account managed block >>>";
const END = "# <<< gh-account managed block <<<";
const MIN_GIT = [2, 36]; // includeIf hasconfig:remote.*.url 이 들어온 버전
const NAME = /^[A-Za-z0-9_.-]+$/;
const LOGIN = /^[A-Za-z0-9_-]+$/;
const PATTERN = /^([A-Za-z0-9_-]+)\/(\*|[A-Za-z0-9_.-]+)$/;
const BIN_FILES = ["gh", "git-credential-gh-account", "gh-account"];
// gh repo <하위 명령> owner/repo 처럼 저장소를 위치 인자로 받는 명령
const REPO_POSITIONAL = new Set(["clone", "view", "fork", "edit", "delete", "archive", "unarchive", "sync", "set-default"]);

function runCmd(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    encoding: "utf8", timeout: opts.timeout || 20000, windowsHide: true,
    env: opts.env, cwd: opts.cwd, input: opts.input,
    stdio: ["pipe", "pipe", opts.inheritErr ? "inherit" : "pipe"],
  });
  return { status: r.error ? -1 : r.status, stdout: r.stdout || "", stderr: r.stderr || "" };
}

function makeCtx(over = {}) {
  return { env: process.env, cwd: process.cwd(), run: runCmd, platform: process.platform, ...over };
}

function homeDir(ctx) { return ctx.env.HOME || os.homedir(); }

function paths(ctx) {
  const home = ctx.env.HERDR_APP_HOME || path.join(homeDir(ctx), ".config", "herdr-app");
  const dir = path.join(home, "gh-account");
  return {
    home, dir,
    map: path.join(home, "gh-accounts.json"),
    state: path.join(dir, "state.json"),
    identity: path.join(dir, "identity"),
    app: path.join(dir, "gh-account.cjs"),
  };
}

// URL, scp 형식(git@github.com:o/r), owner/repo, github.com/o/r 를 {owner, repo}로 바꾼다. github.com 이 아니면 null.
function parseRepo(s) {
  if (!s || typeof s !== "string") return null;
  const t = s.trim();
  let host = HOST, rest, m, bare = false;
  if ((m = t.match(/^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.*)$/i))) { host = m[1]; rest = m[2]; }
  else if ((m = t.match(/^(?:[^@/:]+@)?([^/:]+\.[^/:]+):(?!\/)(.*)$/))) { host = m[1]; rest = m[2]; }
  else { rest = t; bare = true; }
  const parts = rest.split(/[?#]/)[0].split("/").filter(Boolean);
  if (bare) {
    if (parts.length === 3 && parts[0].includes(".")) host = parts.shift();
    if (parts.length !== 2) return null;
  }
  if (!/^(www\.|ssh\.)?github\.com$/i.test(host) || parts.length < 2) return null;
  const owner = parts[0];
  const repo = parts[1].replace(/\.git$/i, "");
  if (!NAME.test(owner) || !NAME.test(repo) || /^\.+$/.test(owner) || /^\.+$/.test(repo)) return null;
  return { owner, repo };
}

function emptyMap() { return { rules: [], default: null, accounts: {} }; }

// 매핑 파일을 읽는다. 없으면 빈 매핑, 깨졌으면 ok:false (도우미와 래퍼는 이때 아무 일도 하지 않는다).
function readMap(file) {
  let raw;
  try { raw = fs.readFileSync(file, "utf8"); } catch (e) {
    if (e.code === "ENOENT") return { ok: true, map: emptyMap() };
    return { ok: false, error: `매핑 파일을 읽지 못했습니다: ${e.message}` };
  }
  let j;
  try { j = JSON.parse(raw); } catch (e) { return { ok: false, error: `매핑 파일이 JSON이 아닙니다: ${e.message}` }; }
  if (!j || typeof j !== "object" || Array.isArray(j)) return { ok: false, error: "매핑 파일 최상위가 객체가 아닙니다." };
  const map = emptyMap();
  for (const r of Array.isArray(j.rules) ? j.rules : []) {
    if (r && typeof r.match === "string" && PATTERN.test(r.match) && typeof r.account === "string" && LOGIN.test(r.account)) {
      map.rules.push({ match: r.match, account: r.account });
    }
  }
  if (typeof j.default === "string" && LOGIN.test(j.default)) map.default = j.default;
  if (j.accounts && typeof j.accounts === "object" && !Array.isArray(j.accounts)) {
    for (const [k, v] of Object.entries(j.accounts)) if (LOGIN.test(k) && v && typeof v === "object") map.accounts[k] = v;
  }
  return { ok: true, map };
}

function writeMap(file, map) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(map, null, 2) + "\n");
  fs.renameSync(tmp, file);
}

// 첫 번째로 맞는 규칙이 이긴다. 맞는 규칙이 없으면 default 계정.
function matchAccount(map, repo) {
  if (!map || !repo) return null;
  const o = repo.owner.toLowerCase(), n = repo.repo.toLowerCase();
  for (const r of map.rules) {
    const [ro, rn] = r.match.toLowerCase().split("/");
    if (ro === o && (rn === "*" || rn === n)) return { account: r.account, by: "rule", match: r.match };
  }
  if (map.default) return { account: map.default, by: "default", match: null };
  return null;
}

function setRule(map, pattern, account) {
  if (!PATTERN.test(pattern)) throw new Error(`규칙은 owner/* 나 owner/repo 모양이어야 합니다: ${pattern}`);
  if (!LOGIN.test(account)) throw new Error(`계정 이름이 올바르지 않습니다: ${account}`);
  const i = map.rules.findIndex((r) => r.match.toLowerCase() === pattern.toLowerCase());
  if (i >= 0) map.rules[i] = { match: pattern, account };
  else map.rules.push({ match: pattern, account });
  return map;
}

function unsetRule(map, pattern) {
  const before = map.rules.length;
  map.rules = map.rules.filter((r) => r.match.toLowerCase() !== pattern.toLowerCase());
  return before !== map.rules.length;
}

// 폴더의 원격 저장소. origin 이 github.com 이면 그것, 아니면 github.com 을 가리키는 첫 원격.
function repoFromDir(ctx, dir) {
  const env = gitEnv(ctx);
  const o = ctx.run("git", ["remote", "get-url", "origin"], { cwd: dir, env });
  if (o.status === 0) { const r = parseRepo(o.stdout.trim()); if (r) return r; }
  const all = ctx.run("git", ["config", "--get-regexp", "^remote\\..*\\.url$"], { cwd: dir, env });
  if (all.status !== 0) return null;
  for (const line of all.stdout.split("\n")) {
    const r = parseRepo(line.slice(line.indexOf(" ") + 1));
    if (r) return r;
  }
  return null;
}

// gh 인자에서 대상 저장소: -R/--repo, GitHub URL, gh repo <명령> o/r, gh api repos/o/r, GH_REPO 순.
function repoFromGhArgs(args, env = {}) {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--") break;
    if (a === "-R" || a === "--repo") return parseRepo(args[i + 1]);
    if (a.startsWith("--repo=")) return parseRepo(a.slice(7));
    if (/^-R[^-]/.test(a)) return parseRepo(a.slice(2));
  }
  for (const a of args) {
    if (/^https?:\/\/(www\.)?github\.com\//i.test(a)) { const r = parseRepo(a); if (r) return r; }
  }
  if (args[0] === "repo" && REPO_POSITIONAL.has(args[1])) {
    for (const a of args.slice(2)) {
      if (a.startsWith("-")) continue;
      if (a.split("/").length === 2) { const r = parseRepo(a); if (r) return r; }
    }
  }
  if (args[0] === "api") {
    for (const a of args.slice(1)) {
      const m = a.match(/^\/?repos\/([^/]+)\/([^/?#]+)/);
      if (m) { const r = parseRepo(`${m[1]}/${m[2]}`); if (r) return r; }
    }
  }
  if (env.GH_REPO) return parseRepo(env.GH_REPO);
  return null;
}

// 래퍼·도우미가 고른 PATH 위의 진짜 gh. 우리 래퍼(표시 문자열이 든 파일)는 건너뛴다.
// PATH 에 없으면(GUI git 클라이언트, launchd 처럼 PATH 가 짧은 곳) 설치할 때 기록한 경로를 쓴다.
function realGh(ctx) {
  if (ctx.env.GH_ACCOUNT_GH) return ctx.env.GH_ACCOUNT_GH;
  const exts = ctx.platform === "win32" ? [".exe", ".cmd", ""] : [""];
  for (const d of String(ctx.env.PATH || "").split(path.delimiter)) {
    if (!d) continue;
    for (const ext of exts) {
      const f = path.join(d, "gh" + ext);
      try {
        if (!fs.statSync(f).isFile()) continue;
        const fd = fs.openSync(f, "r");
        const buf = Buffer.alloc(512);
        const n = fs.readSync(fd, buf, 0, 512, 0);
        fs.closeSync(fd);
        if (buf.subarray(0, n).toString("latin1").includes(MARK)) continue;
        return f;
      } catch { /* 없는 파일 */ }
    }
  }
  const state = readState(paths(ctx).state);
  if (state && typeof state.gh === "string" && path.isAbsolute(state.gh) && fs.existsSync(state.gh)) return state.gh;
  return "gh";
}

// 토큰 환경 변수를 뺀 환경. 다른 계정 토큰이 섞여 들어가지 않게 한다.
function cleanEnv(env) {
  const e = { ...env, GH_ACCOUNT_OFF: "1" };
  for (const k of ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"]) delete e[k];
  return e;
}

function gitEnv(ctx) {
  const e = { ...ctx.env };
  delete e.GIT_TRACE;
  return e;
}

function tokenFor(ctx, login) {
  const r = ctx.run(realGh(ctx), ["auth", "token", "--hostname", HOST, "--user", login], { env: cleanEnv(ctx.env) });
  // gh 를 실행하지 못함: ENOENT(-1) 또는 PATH 의 우리 래퍼가 진짜 gh 를 못 찾음(127)
  if (r.status === -1 || r.status === 127) return { ok: false, missing: true };
  const token = r.stdout.trim();
  if (r.status !== 0 || !token || /\s/.test(token)) return { ok: false };
  return { ok: true, token };
}

// gh 에 로그인된 github.com 계정 목록. 읽지 못하면 null.
function ghLogins(ctx) {
  const r = ctx.run(realGh(ctx), ["auth", "status", "--hostname", HOST, "--json", "hosts"], { env: cleanEnv(ctx.env) });
  try { return (JSON.parse(r.stdout).hosts[HOST] || []).map((h) => ({ login: h.login, active: !!h.active, state: h.state })); } catch { return null; }
}

// 규칙 다음에 계정을 고른다. default 는 로그인된 계정 자신의 저장소(owner 가 그 로그인 이름)에는 쓰지 않고 그 계정을 쓴다.
// 로그인 여부는 gh auth token(로컬)으로 본다. 그 계정이 로그인돼 있지 않으면 default 를 쓴다.
function pickAccount(ctx, map, repo) {
  const hit = matchAccount(map, repo);
  if (!hit || hit.by !== "default" || hit.account.toLowerCase() === repo.owner.toLowerCase() || !LOGIN.test(repo.owner)) return { hit };
  const t = tokenFor(ctx, repo.owner);
  if (t.ok) return { hit: { account: repo.owner, by: "owner", match: null }, token: t.token };
  return { hit };
}

function notLoggedIn(repo, hit) {
  const how = hit.match ? `gh-account unset ${hit.match}` : "gh-account default none";
  return `gh-account: ${repo.owner}/${repo.repo} 은(는) ${hit.account} 계정으로 매핑돼 있지만 이 계정은 gh에 로그인돼 있지 않습니다.\n`
    + `  로그인: gh auth login   매핑 지우기: ${how}   잠깐 끄기: GH_ACCOUNT_OFF=1`;
}

// 저장소 → 계정. 매핑이 없거나 깨졌으면 null.
function resolve(ctx, { repo, dir } = {}) {
  const P = paths(ctx);
  const m = readMap(P.map);
  if (!m.ok) return { error: m.error };
  const target = repo || repoFromDir(ctx, dir || ctx.cwd);
  if (!target) return { repo: null, hit: null };
  return { repo: target, hit: pickAccount(ctx, m.map, target).hit };
}

// gh 래퍼용: 매핑된 계정 토큰을 돌려준다. code 3 은 매핑됐지만 로그인 안 됨.
function ghToken(ctx, args) {
  if (ctx.env.GH_ACCOUNT_OFF) return { code: 0 };
  if (ctx.env.GH_HOST && ctx.env.GH_HOST.toLowerCase() !== HOST) return { code: 0 };
  const P = paths(ctx);
  const m = readMap(P.map);
  if (!m.ok) return { code: 0 };
  const repo = repoFromGhArgs(args, ctx.env) || repoFromDir(ctx, ctx.cwd);
  const pick = pickAccount(ctx, m.map, repo);
  const hit = pick.hit;
  if (!hit) return { code: 0 };
  const t = pick.token ? { ok: true, token: pick.token } : tokenFor(ctx, hit.account);
  if (!t.ok) return { code: 3, message: notLoggedIn(repo, hit) };
  return { code: 0, token: t.token };
}

function parseCredInput(text) {
  const a = {};
  for (const line of String(text || "").split("\n")) {
    const i = line.indexOf("=");
    if (i > 0 && !line.slice(0, i).endsWith("[]")) a[line.slice(0, i)] = line.slice(i + 1);
  }
  return a;
}

// 자격 증명 요청의 저장소. git 이 넘긴 path(useHttpPath)가 먼저고, 없으면 지금 저장소의 원격.
// path 는 o/r.git 이나 o/r.git/info/lfs 처럼 올 수 있어 앞 두 칸만 본다.
function credRepo(ctx, a) {
  if (a.path) {
    const r = parseRepo(String(a.path).split("/").filter(Boolean).slice(0, 2).join("/"));
    if (r) return r;
  }
  return repoFromDir(ctx, ctx.cwd);
}

// git 자격 증명 도우미. 매핑이 없거나 오류면 빈 문자열(다음 도우미가 맡는다).
function credential(ctx, op, input) {
  if (op !== "get" || ctx.env.GH_ACCOUNT_OFF) return { out: "" };
  try {
    const a = parseCredInput(input);
    if (a.protocol !== "https" || String(a.host || "").toLowerCase() !== HOST) return { out: "" };
    const m = readMap(paths(ctx).map);
    if (!m.ok) return { out: "" };
    const repo = credRepo(ctx, a);
    const pick = pickAccount(ctx, m.map, repo);
    const hit = pick.hit;
    if (!hit) return { out: "" };
    if (a.username && a.username.toLowerCase() !== hit.account.toLowerCase()) return { out: "" };
    const t = pick.token ? { ok: true, token: pick.token } : tokenFor(ctx, hit.account);
    if (t.missing) return { out: "", message: GH_MISSING };
    if (!t.ok) return { out: "quit=1\n", message: notLoggedIn(repo, hit) };
    return { out: `username=${hit.account}\npassword=${t.token}\n` };
  } catch {
    return { out: "" };
  }
}

const GH_MISSING = "gh-account: gh 를 찾지 못해 이 요청은 원래 자격 증명 도우미에 넘깁니다. gh 를 설치했다면 sh herdr/install.sh --gh-account 를 다시 실행하세요.";

// 이 도구가 내준 자격 증명인가: 사용자 이름이 매핑에 쓰인 계정이고, 지금 저장소가 그 계정에 매핑됐거나 비밀번호가 그 계정 토큰과 같다.
function ourCredential(ctx, a) {
  const user = String(a.username || "").toLowerCase();
  if (!user) return false;
  const m = readMap(paths(ctx).map);
  if (!m.ok) return false;
  const repo = credRepo(ctx, a);
  const hit = pickAccount(ctx, m.map, repo).hit;
  if (hit && hit.account.toLowerCase() === user) return true;
  const account = [m.map.default, ...m.map.rules.map((r) => r.account)].find((x) => x && x.toLowerCase() === user);
  if (!account) return false;
  if (!a.password) return false;
  const t = tokenFor(ctx, account);
  return t.ok && t.token === a.password;
}

// 원래 도우미 명령. git 과 같은 규칙: ! 로 시작하면 셸 명령, 절대 경로면 그대로, 아니면 git credential-<이름>.
function priorCommand(helper, op) {
  const h = String(helper);
  const cmd = h.startsWith("!") ? h.slice(1) : path.isAbsolute(h) ? h : `git credential-${h}`;
  return `${cmd} ${op}`;
}

// 원래 도우미를 감싸 부른다. 이 도구가 내준 자격 증명의 store·erase 는 넘기지 않는다
// (git 은 인증에 성공하면 모든 도우미에 store 를 보내므로, 감싸지 않으면 키체인 등에 매핑 계정 토큰이 남는다).
// path 줄은 빼서 넘긴다. 이 블록이 useHttpPath 를 켜도 원래 도우미는 전처럼 호스트 기준으로 저장·조회한다.
function priorHelper(ctx, helper, op, input) {
  if (!helper || !["get", "store", "erase"].includes(op)) return { out: "" };
  const text = String(input || "");
  if (op !== "get" && !ctx.env.GH_ACCOUNT_OFF) {
    let drop = false;
    try {
      const a = parseCredInput(text);
      drop = a.protocol === "https" && String(a.host || "").toLowerCase() === HOST && ourCredential(ctx, a);
    } catch { drop = false; }
    if (drop) return { out: "" };
  }
  const stripped = text.split("\n").filter((l) => !l.startsWith("path=")).join("\n");
  const r = ctx.run("/bin/sh", ["-c", priorCommand(helper, op)], { input: stripped, env: ctx.env, cwd: ctx.cwd, timeout: 600000, inheritErr: true });
  return { out: op === "get" ? r.stdout : "" };
}

// ---- git 설정: 커밋 신원 includeIf 와 자격 증명 도우미 블록 ----

function globalConfigPath(ctx) {
  if (ctx.env.GIT_CONFIG_GLOBAL) return ctx.env.GIT_CONFIG_GLOBAL;
  const home = homeDir(ctx);
  const dot = path.join(home, ".gitconfig");
  if (fs.existsSync(dot)) return dot;
  const xdg = path.join(ctx.env.XDG_CONFIG_HOME || path.join(home, ".config"), "git", "config");
  return fs.existsSync(xdg) ? xdg : dot;
}

function stripBlock(text) {
  const re = new RegExp(`\\n*${esc(BEGIN)}[\\s\\S]*?${esc(END)}[^\\n]*\\n?`, "g");
  const out = text.replace(re, "\n");
  return out === "\n" ? "" : out;
}
function esc(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

function writeBlock(file, block) {
  let text = "";
  try { text = fs.readFileSync(file, "utf8"); } catch { /* 처음 */ }
  let next = stripBlock(text);
  if (block) next = (next.trim() ? next.replace(/\n*$/, "\n\n") : "") + block + "\n";
  if (next === text) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, next);
  return true;
}

function quoteValue(v) { return `"${String(v).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`; }

function gitVersion(ctx) {
  const r = ctx.run("git", ["version"], { env: gitEnv(ctx) });
  const m = r.status === 0 && r.stdout.match(/(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2])] : null;
}
function versionAtLeast(v, min) { return !!v && (v[0] > min[0] || (v[0] === min[0] && v[1] >= min[1])); }

// 우리 블록을 빼고 본 지금 github.com 자격 증명 도우미 목록(설정 순서대로, 빈 값은 목록을 비운다).
function priorHelpers(ctx, globalFile) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gh-account-"));
  try {
    let text = "";
    try { text = fs.readFileSync(globalFile, "utf8"); } catch { /* 없음 */ }
    const g = path.join(tmp, "global");
    fs.writeFileSync(g, stripBlock(text));
    const env = { ...gitEnv(ctx), GIT_CONFIG_GLOBAL: g };
    delete env.GIT_DIR;
    const r = ctx.run("git", ["config", "-z", "--includes", "--get-regexp", "^credential\\..*helper$"], { cwd: tmp, env });
    const list = [];
    if (r.status !== 0) return list;
    for (const ent of r.stdout.split("\0")) {
      if (!ent) continue;
      const i = ent.indexOf("\n");
      const key = i < 0 ? ent : ent.slice(0, i);
      const val = i < 0 ? "" : ent.slice(i + 1);
      const m = key.match(/^credential\.(.*)\.helper$/i);
      const url = m ? m[1] : null;
      if (!/^credential\.helper$/i.test(key) && !(url && /^(https:\/\/)?github\.com\/?$/i.test(url))) continue;
      if (val === "") list.length = 0;
      else if (!val.includes("git-credential-gh-account")) list.push(val);
    }
    return list;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// 규칙 하나를 https·ssh 원격 URL 패턴으로. 저장소 규칙은 .git 이 붙은 주소도 넣는다.
function urlPatterns(match) {
  const [o, n] = match ? match.split("/") : [null, null];
  const tails = !o ? ["**"] : n === "*" ? [`${o}/**`] : [`${o}/${n}`, `${o}/${n}.git`];
  const out = [];
  for (const t of tails) {
    out.push(`https://github.com/${t}`, `https://*@github.com/${t}`, `git@github.com:${t}`, `ssh://git@github.com/${t}`);
  }
  return out;
}

function helperValue(file) {
  return /^[A-Za-z0-9_./-]+$/.test(file) ? file : `!'${file.replace(/'/g, "'\\''")}'`;
}

// 원래 도우미는 우리 도우미로 감싸(prior '<원래 값>') store 를 거른다. useHttpPath 로 git 이 저장소 path 를 넘기게 한다.
function buildBlock({ helper, prior, includes }) {
  if (!helper && !includes.length) return null;
  const L = [BEGIN, "# gh-account 가 관리하는 블록입니다. 직접 고치지 말고 gh-account 명령을 쓰세요."];
  if (helper) {
    const ours = helperValue(helper);
    L.push('[credential "https://github.com"]', "\thelper =", `\thelper = ${quoteValue(ours)}`);
    for (const h of prior) L.push(`\thelper = ${quoteValue(`${ours} prior ${shQuote(h)}`)}`);
    L.push("\tuseHttpPath = true");
  }
  // git 설정은 뒤에 온 값이 이기므로 default 를 먼저, 규칙은 거꾸로 써서 첫 규칙이 이기게 한다.
  for (const inc of includes) {
    for (const p of urlPatterns(inc.match)) L.push(`[includeIf "hasconfig:remote.*.url:${p}"]`, `\tpath = ${quoteValue(inc.file)}`);
  }
  L.push(END);
  return L.join("\n");
}

// 계정의 커밋 신원. 매핑에 적은 값이 우선이고, 없으면 그 계정 토큰으로 noreply 주소를 만든다.
function identityFor(ctx, map, login) {
  const conf = map.accounts[login] && map.accounts[login].identity;
  if (conf === false) return { off: true };
  const want = conf && typeof conf === "object" ? conf : {};
  if (want.name && want.email) return { name: want.name, email: want.email };
  const t = tokenFor(ctx, login);
  if (!t.ok) return { error: `${login} 계정이 gh에 로그인돼 있지 않습니다` };
  const env = { ...cleanEnv(ctx.env), GH_TOKEN: t.token };
  const r = ctx.run(realGh(ctx), ["api", "user", "--hostname", HOST], { env });
  let u;
  try { u = JSON.parse(r.stdout); } catch { u = null; }
  if (r.status !== 0 || !u || !u.id || !u.login) return { error: `${login} 계정 정보를 읽지 못했습니다(gh api user)` };
  return { name: want.name || u.name || u.login, email: want.email || `${u.id}+${u.login}@users.noreply.github.com` };
}

function readState(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

// 매핑과 설치 상태로 신원 파일과 전역 git 설정 블록을 다시 만든다.
function sync(ctx, log = () => {}) {
  const P = paths(ctx);
  const m = readMap(P.map);
  if (!m.ok) { log(m.error); return false; }
  const map = m.map;
  const state = readState(P.state);
  const includes = [];
  const keep = new Set();
  // default 는 로그인된 계정 자신의 저장소에 쓰지 않으므로, 그 계정마다 login/* 신원을 default 뒤(규칙 앞)에 둔다.
  // 로그인 목록을 읽지 못하면 default 신원은 넣지 않는다(개인 저장소에 다른 계정 신원이 붙지 않게).
  let def = map.default ? [{ match: null, account: map.default }] : [];
  const owners = [];
  if (def.length) {
    const logins = ghLogins(ctx);
    if (!logins) { log("커밋 신원: gh 로그인 목록을 읽지 못해 기본 계정 신원은 건너뜁니다."); def = []; }
    else for (const l of logins) if (l.login && LOGIN.test(l.login) && l.login.toLowerCase() !== map.default.toLowerCase()) owners.push({ match: `${l.login}/*`, account: l.login, owner: true });
  }
  const order = [...def, ...owners, ...[...map.rules].reverse()];
  if (order.length) {
    const v = gitVersion(ctx);
    if (!versionAtLeast(v, MIN_GIT)) {
      log(`git ${v ? v.join(".") : "(버전 모름)"} 은(는) includeIf hasconfig 를 몰라 커밋 신원은 건너뜁니다(2.36 이상 필요). 인증은 그대로 됩니다.`);
    } else {
      const done = new Map();
      let ownerGap = false;
      for (const r of order) {
        if (!done.has(r.account)) {
          const file = path.join(P.identity, `${r.account}.gitconfig`);
          const id = identityFor(ctx, map, r.account);
          if (id.off) done.set(r.account, null);
          else if (id.error) {
            const had = fs.existsSync(file);
            log(`커밋 신원: ${id.error}. ${had ? "전에 만든 파일을 그대로 씁니다." : "이 계정은 신원을 건너뜁니다."}`);
            done.set(r.account, had ? file : null);
          } else {
            fs.mkdirSync(P.identity, { recursive: true });
            fs.writeFileSync(file, `# gh-account 가 만든 파일입니다. 바꾸려면 gh-account identity ${r.account} 를 쓰세요.\n[user]\n\tname = ${quoteValue(id.name)}\n\temail = ${quoteValue(id.email)}\n`);
            done.set(r.account, file);
          }
        }
        const file = done.get(r.account);
        if (file) { includes.push({ match: r.match, file }); keep.add(path.basename(file)); }
        else if (r.owner) ownerGap = true;
      }
      // 로그인된 계정의 신원을 만들지 못하면 그 계정 저장소에 default 신원이 붙으므로 default 신원을 뺀다.
      if (ownerGap && def.length) {
        log("커밋 신원: 로그인된 계정의 신원을 만들지 못한 것이 있어 기본 계정 신원은 건너뜁니다.");
        const defFile = done.get(map.default);
        const i = includes.findIndex((x) => x.match === null);
        if (i >= 0) includes.splice(i, 1);
        if (defFile && !includes.some((x) => x.file === defFile)) keep.delete(path.basename(defFile));
      }
    }
  }
  try {
    for (const f of fs.readdirSync(P.identity)) if (!keep.has(f)) fs.rmSync(path.join(P.identity, f), { force: true });
  } catch { /* 폴더 없음 */ }
  const helper = state && state.binDir ? path.join(state.binDir, "git-credential-gh-account") : null;
  const file = globalConfigPath(ctx);
  writeBlock(file, buildBlock({ helper, prior: (state && state.prior) || [], includes }));
  return true;
}

// ---- 설치 ----

function shQuote(s) { return `'${String(s).replace(/'/g, "'\\''")}'`; }

function scripts({ app, node, binDir, home, gh }) {
  const head = (what) => `#!/bin/sh\n# ${MARK}: ${what}\n# 지우기: gh-account uninstall   잠깐 끄기: GH_ACCOUNT_OFF=1\nAPP=${shQuote(app)}\nNODE_BIN=${shQuote(node)}\nAPP_HOME=${shQuote(home)}\n`;
  const runApp = `HERDR_APP_HOME="$APP_HOME" "$NODE" "$APP"`;
  const pickNode = `NODE=$(command -v node 2>/dev/null) || NODE=""\n[ -n "$NODE" ] || NODE="$NODE_BIN"\n`;
  return {
    gh: head("저장소에 매핑된 계정 토큰을 GH_TOKEN 으로 넘겨 진짜 gh 를 실행한다.")
      + `SELF_DIR=${shQuote(binDir)}\nREAL=""\nset -f\nOLD_IFS=$IFS\nIFS=:\n`
      + `for d in $PATH; do\n  [ -n "$d" ] && [ "$d" != "$SELF_DIR" ] || continue\n  [ -f "$d/gh" ] && [ -x "$d/gh" ] || continue\n  [ "$d/gh" -ef "$0" ] && continue\n  REAL="$d/gh"\n  break\ndone\nIFS=$OLD_IFS\nset +f\n`
      + `GH_FALLBACK=${shQuote(gh || "")}\n`
      + `[ -z "$REAL" ] && [ -n "$GH_FALLBACK" ] && [ -x "$GH_FALLBACK" ] && REAL=$GH_FALLBACK\n`
      + `if [ -z "$REAL" ]; then echo "gh-account: PATH 에서 진짜 gh 를 찾지 못했습니다." >&2; exit 127; fi\n`
      + `# 저장소와 상관없는 명령은 계정을 고르지 않고 그대로 넘긴다\n`
      + `case "\${1-}" in ""|-h|--help|help|--version|version|auth|completion|config|extension|extensions|ext|alias) exec "$REAL" "$@" ;; esac\n`
      + `[ -n "$GH_TOKEN$GITHUB_TOKEN$GH_ACCOUNT_OFF" ] && exec "$REAL" "$@"\n`
      + pickNode
      + `{ [ -x "$NODE" ] && [ -f "$APP" ]; } || exec "$REAL" "$@"\n`
      + `TOKEN=$(GH_ACCOUNT_GH="$REAL" ${runApp} gh-token -- "$@" </dev/null)\nCODE=$?\n`
      + `[ "$CODE" -eq 3 ] && exit 1\n`
      + `if [ "$CODE" -eq 0 ] && [ -n "$TOKEN" ]; then GH_TOKEN=$TOKEN; export GH_TOKEN; fi\n`
      + `exec "$REAL" "$@"\n`,
    "git-credential-gh-account": head("git 자격 증명 도우미. 매핑이 없거나 오류면 아무것도 출력하지 않는다.")
      + pickNode
      // prior '<원래 도우미>' <op>: 원래 도우미를 감싸 부른다. node 가 없거나 꺼져 있으면 path 줄만 빼고 그대로 부른다.
      + `if [ "\${1-}" = "prior" ]; then\n`
      + `  if [ -z "$GH_ACCOUNT_OFF" ] && [ -x "$NODE" ] && [ -f "$APP" ]; then ${runApp} credential "$@"; exit 0; fi\n`
      + `  case "\${3-}" in get|store|erase) ;; *) exit 0 ;; esac\n`
      + `  case "$2" in "!"*) C=\${2#!} ;; /*) C=$2 ;; *) C="git credential-$2" ;; esac\n`
      + `  grep -v '^path=' | sh -c "$C $3"\n  exit 0\nfi\n`
      + `[ -n "$GH_ACCOUNT_OFF" ] && exit 0\n`
      + `{ [ -x "$NODE" ] && [ -f "$APP" ]; } || exit 0\n${runApp} credential "$@"\nexit 0\n`,
    "gh-account": head("매핑 보기·바꾸기 명령.") + pickNode + `exec env ${runApp} "$@"\n`,
  };
}

function isOurs(file) {
  try { return fs.readFileSync(file, "utf8").slice(0, 512).includes(MARK); } catch { return false; }
}

// PATH 에서 처음 찾히는 gh 의 폴더
function firstGhDir(ctx) {
  for (const d of String(ctx.env.PATH || "").split(path.delimiter)) {
    if (d && fs.existsSync(path.join(d, "gh"))) return d;
  }
  return null;
}

function install(ctx, opts, log) {
  if (ctx.platform === "win32") { log("gh-account 는 아직 Windows 를 지원하지 않습니다."); return 1; }
  const P = paths(ctx);
  const binDir = path.resolve(opts.bin || ctx.env.GH_ACCOUNT_BIN || path.join(homeDir(ctx), ".local", "bin"));
  for (const f of BIN_FILES) {
    const t = path.join(binDir, f);
    if (fs.existsSync(t) && !isOurs(t)) { log(`${t} 에 다른 파일이 있어 설치를 멈춥니다. 그 파일을 옮긴 뒤 다시 실행하세요.`); return 1; }
  }
  const gh = realGh({ ...ctx, env: { ...ctx.env, GH_ACCOUNT_GH: "" } });
  if (!path.isAbsolute(gh)) log("PATH 에서 gh 를 찾지 못했습니다. GitHub CLI 를 설치하고 로그인해야 계정을 고를 수 있습니다.");
  fs.mkdirSync(P.dir, { recursive: true });
  const src = opts.src || __filename;
  if (path.resolve(src) !== path.resolve(P.app)) fs.copyFileSync(src, P.app);
  fs.mkdirSync(binDir, { recursive: true });
  const ghPath = path.isAbsolute(gh) ? gh : null;
  const files = scripts({ app: P.app, node: opts.node || process.execPath, binDir, home: P.home, gh: ghPath });
  for (const f of BIN_FILES) {
    fs.writeFileSync(path.join(binDir, f), files[f]);
    fs.chmodSync(path.join(binDir, f), 0o755);
  }
  const prior = priorHelpers(ctx, globalConfigPath(ctx));
  fs.writeFileSync(P.state, JSON.stringify({ binDir, prior, gh: ghPath }, null, 2) + "\n");
  sync(ctx, log);
  log(`설치: ${binDir} 에 gh, git-credential-gh-account, gh-account`);
  log(`git 전역 설정(${globalConfigPath(ctx)})에 gh-account 블록을 썼습니다. 원래 자격 증명 도우미 ${prior.length}개는 그 뒤에 그대로 둡니다.`);
  const first = firstGhDir(ctx);
  if (first !== binDir) {
    log(`주의: PATH 에서 ${first || "(없음)"} 의 gh 가 먼저 찾혀 래퍼가 쓰이지 않습니다. 셸 설정에 export PATH="${binDir}:$PATH" 를 더하세요.`);
  }
  if (!readMap(P.map).ok) log(`매핑 파일(${P.map})이 깨져 있어 지금은 아무 계정도 고르지 않습니다.`);
  return 0;
}

function uninstall(ctx, opts, log) {
  const P = paths(ctx);
  const state = readState(P.state);
  const binDir = path.resolve(opts.bin || (state && state.binDir) || ctx.env.GH_ACCOUNT_BIN || path.join(homeDir(ctx), ".local", "bin"));
  for (const f of BIN_FILES) {
    const t = path.join(binDir, f);
    if (isOurs(t)) { fs.rmSync(t, { force: true }); log(`지움: ${t}`); }
  }
  writeBlock(globalConfigPath(ctx), null);
  fs.rmSync(P.identity, { recursive: true, force: true });
  fs.rmSync(P.state, { force: true });
  fs.rmSync(P.app, { force: true });
  try { fs.rmdirSync(P.dir); } catch { /* 남은 파일 있음 */ }
  log(`git 전역 설정에서 gh-account 블록을 지웠습니다. 매핑 파일(${P.map})은 남겨 둡니다.`);
  return 0;
}

// ---- 명령줄 ----

const USAGE = `사용법: gh-account <명령>
  resolve [폴더 | -R owner/repo] [--json]  이 저장소에 쓸 계정을 보여 준다
  list [--json]                        gh 에 로그인된 계정과 매핑 규칙을 보여 준다
  set <owner/* | owner/repo> <계정>     규칙을 더하거나 바꾼다(먼저 적힌 규칙이 이긴다)
  unset <owner/* | owner/repo>          규칙을 지운다
  default <계정 | none>                  규칙에 없는 저장소에 쓸 계정
  identity <계정> [--name 이름] [--email 주소] [--off | --auto]  커밋 신원
  sync                                 신원 파일과 git 전역 설정 블록을 다시 만든다
  install [--bin 폴더] | uninstall | status`;

function flag(args, name) {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
}

function editMap(ctx, io, fn) {
  const P = paths(ctx);
  const m = readMap(P.map);
  if (!m.ok) { io.err(`${m.error}\n파일을 고치거나 지운 뒤 다시 실행하세요: ${P.map}`); return 1; }
  const msg = fn(m.map);
  writeMap(P.map, m.map);
  if (msg) io.out(msg);
  sync(ctx, io.out);
  return 0;
}

function warnLogin(ctx, io, login) {
  if (!tokenFor(ctx, login).ok) io.out(`주의: ${login} 계정이 gh 에 로그인돼 있지 않습니다. 이 계정으로 매핑된 저장소는 로그인할 때까지 실패합니다(gh auth login).`);
}

function main(argv, ctx, io) {
  const args = [...argv];
  const cmd = args.shift();
  const P = paths(ctx);
  switch (cmd) {
    case "credential": {
      if (args[0] === "prior") {
        const r = priorHelper(ctx, args[1], args[2], io.stdin());
        io.raw(r.out);
        return 0;
      }
      const r = credential(ctx, args[0], io.stdin());
      if (r.message) io.err(r.message);
      io.raw(r.out);
      return 0;
    }
    case "gh-token": {
      if (io.isTTY) { io.err("토큰은 터미널에 출력하지 않습니다(gh 래퍼 전용 명령)."); return 2; }
      if (args[0] === "--") args.shift();
      let r;
      try { r = ghToken(ctx, args); } catch { r = { code: 0 }; }
      if (r.message) io.err(r.message);
      if (r.token) io.raw(r.token);
      return r.code;
    }
    case "resolve": {
      const json = args.includes("--json");
      const rest = args.filter((a) => a !== "--json");
      const R = flag(rest, "-R") || flag(rest, "--repo");
      let repo = null;
      if (R) { repo = parseRepo(R); if (!repo) { io.err(`github.com 저장소가 아닙니다: ${R}`); return 2; } }
      const res = resolve(ctx, { repo, dir: rest[0] ? path.resolve(ctx.cwd, rest[0]) : ctx.cwd });
      if (res.error) { io.err(res.error); return 1; }
      if (json) { io.out(JSON.stringify({ repo: res.repo ? `${res.repo.owner}/${res.repo.repo}` : null, account: res.hit ? res.hit.account : null, by: res.hit ? res.hit.by : null, match: res.hit ? res.hit.match : null })); return 0; }
      if (!res.repo) { io.out("github.com 원격이 없는 폴더입니다. gh 와 git 은 원래 계정을 씁니다."); return 0; }
      const name = `${res.repo.owner}/${res.repo.repo}`;
      if (!res.hit) io.out(`${name}: 매핑 없음. gh 와 git 은 원래 계정(gh 활성 계정 등)을 씁니다.`);
      else io.out(`${name}: ${res.hit.account} (${res.hit.by === "rule" ? `규칙 ${res.hit.match}` : res.hit.by === "owner" ? "로그인된 계정의 저장소" : "default"})`);
      return 0;
    }
    case "list": {
      const json = args.includes("--json");
      const accounts = ghLogins(ctx);
      const m = readMap(P.map);
      if (json) { io.out(JSON.stringify({ accounts, map: m.ok ? m.map : null, error: m.ok ? null : m.error })); return 0; }
      if (!accounts) io.out("gh auth status --json 을 읽지 못했습니다(gh 2.60 이상 필요). gh auth status 로 직접 확인하세요.");
      else {
        io.out("gh 에 로그인된 github.com 계정:");
        for (const a of accounts) io.out(`  ${a.login}${a.active ? " (활성)" : ""}${a.state && a.state !== "success" ? ` [${a.state}]` : ""}`);
      }
      if (!m.ok) { io.out(m.error); return 1; }
      io.out(`매핑(${P.map}):`);
      if (!m.map.rules.length) io.out("  (규칙 없음)");
      m.map.rules.forEach((r2, i) => io.out(`  ${i + 1}. ${r2.match} -> ${r2.account}`));
      io.out(`  default: ${m.map.default || "(없음)"}`);
      return 0;
    }
    case "set": {
      const [pattern, account] = args;
      if (!pattern || !account) { io.err(USAGE); return 2; }
      try { setRule(readMap(P.map).map || emptyMap(), pattern, account); } catch (e) { io.err(e.message); return 2; }
      const code = editMap(ctx, io, (map) => { setRule(map, pattern, account); return `규칙: ${pattern} -> ${account}`; });
      if (code === 0) warnLogin(ctx, io, account);
      return code;
    }
    case "unset": {
      if (!args[0]) { io.err(USAGE); return 2; }
      return editMap(ctx, io, (map) => (unsetRule(map, args[0]) ? `규칙을 지웠습니다: ${args[0]}` : `그런 규칙이 없습니다: ${args[0]}`));
    }
    case "default": {
      const a = args[0];
      if (!a || (a !== "none" && !LOGIN.test(a))) { io.err(USAGE); return 2; }
      const code = editMap(ctx, io, (map) => { map.default = a === "none" ? null : a; return `default: ${map.default || "(없음)"}${map.default ? "\n  로그인된 계정 자신의 저장소(owner 가 그 계정 이름)는 default 가 아니라 그 계정을 씁니다." : ""}`; });
      if (code === 0 && a !== "none") warnLogin(ctx, io, a);
      return code;
    }
    case "identity": {
      const login = args.shift();
      if (!login || !LOGIN.test(login)) { io.err(USAGE); return 2; }
      const off = args.includes("--off"), auto = args.includes("--auto");
      const name = flag(args, "--name"), email = flag(args, "--email");
      return editMap(ctx, io, (map) => {
        const acc = map.accounts[login] || {};
        if (off) acc.identity = false;
        else if (auto) delete acc.identity;
        else if (name || email) acc.identity = { ...(acc.identity || {}), ...(name ? { name } : {}), ...(email ? { email } : {}) };
        map.accounts[login] = acc;
        if (!Object.keys(acc).length) delete map.accounts[login];
        const id = acc.identity;
        return `${login} 커밋 신원: ${id === false ? "끔" : id ? `${id.name || "(gh 이름)"} <${id.email || "(noreply)"}>` : "자동(gh 이름, noreply 주소)"}`;
      });
    }
    case "sync":
      return sync(ctx, io.out) ? 0 : 1;
    case "install":
      return install(ctx, { bin: flag(args, "--bin") }, io.out);
    case "uninstall":
      return uninstall(ctx, { bin: flag(args, "--bin") }, io.out);
    case "status": {
      const state = readState(P.state);
      const g = globalConfigPath(ctx);
      let text = "";
      try { text = fs.readFileSync(g, "utf8"); } catch { /* 없음 */ }
      const v = gitVersion(ctx);
      io.out(`설치: ${state ? state.binDir : "안 됨"}`);
      io.out(`git 전역 설정 블록: ${text.includes(BEGIN) ? "있음" : "없음"} (${g})`);
      io.out(`git ${v ? v.join(".") : "?"}: 커밋 신원 ${versionAtLeast(v, MIN_GIT) ? "가능" : "불가(2.36 이상 필요)"}`);
      if (state) {
        const first = firstGhDir(ctx);
        io.out(`gh 래퍼: ${first === state.binDir ? "PATH 맨 앞" : `쓰이지 않음(먼저 찾히는 gh: ${first || "없음"})`}`);
      }
      const m = readMap(P.map);
      io.out(`매핑: ${m.ok ? `규칙 ${m.map.rules.length}개, default ${m.map.default || "없음"}` : m.error}`);
      return 0;
    }
    case undefined: case "-h": case "--help": case "help":
      io.out(USAGE);
      return cmd ? 0 : 2;
    default:
      io.err(`알 수 없는 명령: ${cmd}\n${USAGE}`);
      return 2;
  }
}

if (require.main === module) {
  const io = {
    out: (s) => process.stdout.write(s + "\n"),
    err: (s) => process.stderr.write(s + "\n"),
    raw: (s) => process.stdout.write(s),
    stdin: () => { try { return fs.readFileSync(0, "utf8"); } catch { return ""; } },
    isTTY: !!process.stdout.isTTY,
  };
  let code;
  try { code = main(process.argv.slice(2), makeCtx(), io); } catch (e) {
    const cmd = process.argv[2];
    if (cmd === "credential" || cmd === "gh-token") code = 0; // 도우미·래퍼는 오류로 push·gh 를 막지 않는다
    else { io.err(`gh-account: ${e.message}`); code = 1; }
  }
  process.exitCode = code;
}

module.exports = {
  HOST, MARK, BEGIN, END, paths, parseRepo, readMap, writeMap, emptyMap, matchAccount, setRule, unsetRule,
  repoFromDir, repoFromGhArgs, realGh, tokenFor, resolve, ghToken, credential, parseCredInput, credRepo,
  ourCredential, priorCommand, priorHelper,
  globalConfigPath, stripBlock, writeBlock, buildBlock, urlPatterns, priorHelpers, identityFor, sync,
  scripts, install, uninstall, main, makeCtx,
};
