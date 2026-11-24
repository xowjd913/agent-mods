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
    logins: path.join(dir, "logins.json"),
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

// 규칙 하나를 위(up)나 아래(down)로 한 칸 옮긴다. 먼저 맞는 규칙이 이기므로 순서가 곧 우선순위다. 옮겼으면 true.
function moveRule(map, pattern, dir) {
  const i = map.rules.findIndex((r) => r.match.toLowerCase() === String(pattern).toLowerCase());
  const j = dir === "up" ? i - 1 : dir === "down" ? i + 1 : -1;
  if (i < 0 || j < 0 || j >= map.rules.length) return false;
  [map.rules[i], map.rules[j]] = [map.rules[j], map.rules[i]];
  return true;
}

// 폴더의 원격 저장소. origin 이 github.com 이면 그것, 아니면 github.com 을 가리키는 첫 원격.
// url 은 사용자·비밀번호(https://user:token@...)를 뺀 값이다.
function remoteFromDir(ctx, dir) {
  const env = gitEnv(ctx);
  const o = ctx.run("git", ["remote", "get-url", "origin"], { cwd: dir, env });
  if (o.status === 0) { const url = o.stdout.trim(); const r = parseRepo(url); if (r) return { repo: r, url: safeUrl(url) }; }
  const all = ctx.run("git", ["config", "--get-regexp", "^remote\\..*\\.url$"], { cwd: dir, env });
  if (all.status !== 0) return null;
  for (const line of all.stdout.split("\n")) {
    const url = line.slice(line.indexOf(" ") + 1).trim();
    const r = parseRepo(url);
    if (r) return { repo: r, url: safeUrl(url) };
  }
  return null;
}
function repoFromDir(ctx, dir) {
  const x = remoteFromDir(ctx, dir);
  return x ? x.repo : null;
}
function safeUrl(url) { return String(url).replace(/^([a-z][a-z0-9+.-]*:\/\/)[^@/]+@/i, (m, s) => (/^ssh:/i.test(s) ? m : s)); }
function isSshUrl(url) { return /^ssh:\/\//i.test(url) || /^[^@/:]+@[^/:]+:/.test(url); }

// 폴더가 git 저장소가 아니면(여러 저장소를 담은 폴더) 바로 아래에서 .git 이 있는 폴더를 이만큼까지 본다.
const SCAN_CHILDREN = 50;

// 스페이스 폴더·터미널 폴더들의 github.com 원격을 owner 별로 묶는다.
// 각 저장소에 지금 매핑에서 쓰는 계정을 붙이고, owner/* 규칙이 있으면 그 계정도 붙인다.
// logins(gh 에 로그인된 계정 이름들)에 owner 가 있으면 personal 로 표시한다. 그 계정의 개인 저장소일 수 있다.
function spaceOwners(ctx, dirs, map, logins = []) {
  const repos = new Map();
  const add = (dir) => {
    let r = null;
    try { r = repoFromDir(ctx, dir); } catch { r = null; }
    if (r && !repos.has(`${r.owner}/${r.repo}`.toLowerCase())) repos.set(`${r.owner}/${r.repo}`.toLowerCase(), { ...r, dir });
    return !!r;
  };
  const seen = new Set();
  for (const raw of dirs) {
    if (!raw || typeof raw !== "string") continue;
    const dir = path.resolve(ctx.cwd, raw);
    if (seen.has(dir)) continue;
    seen.add(dir);
    let st;
    try { st = fs.statSync(dir); } catch { continue; }
    if (!st.isDirectory() || add(dir)) continue;
    let kids = [];
    try { kids = fs.readdirSync(dir, { withFileTypes: true }); } catch { kids = []; }
    let n = 0;
    for (const k of kids) {
      if (n >= SCAN_CHILDREN) break;
      if (!k.isDirectory() || k.name.startsWith(".")) continue;
      const sub = path.join(dir, k.name);
      if (!fs.existsSync(path.join(sub, ".git"))) continue;
      n++;
      add(sub);
    }
  }
  const owners = new Map();
  for (const r of [...repos.values()].sort((a, b) => `${a.owner}/${a.repo}`.localeCompare(`${b.owner}/${b.repo}`))) {
    const key = r.owner.toLowerCase();
    if (!owners.has(key)) {
      const rule = map.rules.find((x) => x.match.toLowerCase() === `${key}/*`);
      owners.set(key, { owner: r.owner, personal: logins.some((l) => same(l, r.owner)), rule: rule ? rule.account : null, repos: [] });
    }
    const hit = ownerOverDefault(matchAccount(map, r), r, logins);
    owners.get(key).repos.push({ repo: `${r.owner}/${r.repo}`, dir: r.dir, account: hit ? hit.account : null, by: hit ? hit.by : null, match: hit ? hit.match : null });
  }
  return [...owners.values()];
}

// default 를 로그인된 계정 자신의 저장소에 쓰지 않는 규칙(pickAccount)을 로그인 목록으로 미리 본다. 화면 표시용.
function ownerOverDefault(hit, repo, logins) {
  if (!hit || hit.by !== "default" || same(hit.account, repo.owner)) return hit;
  const login = (logins || []).find((l) => same(l, repo.owner));
  return login ? { account: login, by: "owner", match: null } : hit;
}

// 폴더들에서 찾은 owner 마다 owner/* 규칙을 그 계정으로 바꾼다. account 가 null 이면 그 owner/* 규칙을 지운다.
// owner/repo 처럼 저장소 하나만 정한 규칙은 건드리지 않는다.
// 로그인된 계정과 같은 owner(personal)를 다른 계정으로 묶지는 않는다. 개인 공개 저장소가 다른 계정으로 push 되지 않게 skipped 로 돌려준다.
function assignOwners(map, owners, account) {
  const changed = [], skipped = [];
  for (const o of owners) {
    const pattern = `${o.owner}/*`;
    if (account && o.personal && !same(o.owner, account)) skipped.push(pattern);
    else if (account) { setRule(map, pattern, account); changed.push(pattern); }
    else if (unsetRule(map, pattern)) changed.push(pattern);
  }
  return { changed, skipped };
}

const loginNames = (ctx) => (ghLogins(ctx) || []).map((a) => a.login);

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

// 로그인 이름은 대소문자를 가리지 않는다. sync 때 적어 둔 로그인 목록에서 gh 가 쓰는 이름(대소문자 그대로)을 찾는다.
// gh auth status 는 네트워크를 타므로 git push 나 gh 명령마다 부르지 않고 적어 둔 목록을 쓴다. 없으면 받은 이름 그대로.
function canonicalLogin(ctx, name) {
  const c = readState(paths(ctx).logins);
  const list = c && Array.isArray(c.logins) ? c.logins : [];
  const low = String(name).toLowerCase();
  return list.find((l) => typeof l === "string" && l.toLowerCase() === low) || name;
}

function saveLogins(ctx, logins) {
  const P = paths(ctx);
  const want = JSON.stringify({ logins: logins.map((l) => l.login).filter((l) => typeof l === "string" && LOGIN.test(l)) }) + "\n";
  try {
    if (fs.readFileSync(P.logins, "utf8") === want) return;
  } catch { /* 없음 */ }
  try {
    fs.mkdirSync(P.dir, { recursive: true });
    const tmp = `${P.logins}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, want);
    fs.renameSync(tmp, P.logins);
  } catch { /* 못 써도 받은 이름 그대로 쓴다 */ }
}

function tokenFor(ctx, login) {
  const user = canonicalLogin(ctx, login);
  const r = ctx.run(realGh(ctx), ["auth", "token", "--hostname", HOST, "--user", user], { env: cleanEnv(ctx.env) });
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
  const login = canonicalLogin(ctx, repo.owner);
  const t = tokenFor(ctx, login);
  if (t.ok) return { hit: { account: login, by: "owner", match: null }, token: t.token };
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
// GitHub 의 owner·저장소 이름은 대소문자를 가리지 않지만 git 의 hasconfig 글롭은 가리므로 글자마다 [aA] 로 쓴다.
function anyCase(s) { return s.replace(/[A-Za-z]/g, (c) => `[${c.toLowerCase()}${c.toUpperCase()}]`); }

function urlPatterns(match) {
  const [o, n] = match ? match.split("/").map((x) => (x === "*" ? x : anyCase(x))) : [null, null];
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
  const key = Object.keys(map.accounts).find((k) => k.toLowerCase() === login.toLowerCase());
  const conf = key && map.accounts[key].identity;
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
  // 로그인 목록은 래퍼·도우미가 대소문자가 다른 이름을 gh 의 로그인 이름으로 바꿀 때 쓰도록 적어 둔다.
  const logins = ghLogins(ctx);
  if (logins) saveLogins(ctx, logins);
  let def = map.default ? [{ match: null, account: map.default }] : [];
  const owners = [];
  if (def.length) {
    if (!logins) { log("커밋 신원: gh 로그인 목록을 읽지 못해 기본 계정 신원은 건너뜁니다."); def = []; }
    else for (const l of logins) if (l.login && LOGIN.test(l.login) && l.login.toLowerCase() !== map.default.toLowerCase()) owners.push({ match: `${l.login}/*`, account: l.login, owner: true });
  }
  const order = [...def, ...owners, ...[...map.rules].reverse()].map((r) => ({ ...r, account: canonicalLogin(ctx, r.account) }));
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
        const defFile = done.get(canonicalLogin(ctx, map.default));
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
      // 로그인·로그아웃이 성공하면 로그인된 계정의 커밋 신원을 다시 맞춘다. 실패해도 gh 의 종료 코드는 그대로 돌려준다.
      + `if [ "\${1-}" = auth ] && { [ "\${2-}" = login ] || [ "\${2-}" = logout ]; } && [ -z "$GH_ACCOUNT_OFF" ]; then\n`
      + `  "$REAL" "$@"\n  CODE=$?\n`
      + `  if [ "$CODE" -eq 0 ]; then\n    ${pickNode.trim().replace(/\n/g, "\n    ")}\n`
      + `    if [ -x "$NODE" ] && [ -f "$APP" ]; then GH_ACCOUNT_GH="$REAL" ${runApp} sync >/dev/null 2>&1 </dev/null || echo "gh-account: 커밋 신원을 다시 맞추지 못했습니다. gh-account sync 를 실행하세요." >&2; fi\n`
      + `  fi\n  exit $CODE\nfi\n`
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

// 설치 폴더: --bin, GH_ACCOUNT_BIN, 전에 설치한 폴더, ~/.local/bin 순.
function installBinDir(ctx, opts = {}) {
  const state = readState(paths(ctx).state);
  return path.resolve(opts.bin || ctx.env.GH_ACCOUNT_BIN || (state && state.binDir) || path.join(homeDir(ctx), ".local", "bin"));
}
function uninstallBinDir(ctx, opts = {}) {
  const state = readState(paths(ctx).state);
  return path.resolve(opts.bin || (state && state.binDir) || ctx.env.GH_ACCOUNT_BIN || path.join(homeDir(ctx), ".local", "bin"));
}

// PATH 에서 설치 폴더가 다른 gh 보다 앞에 있는가(래퍼가 쓰이는가). firstGh 는 래퍼가 아닌 첫 gh 의 폴더.
function pathOrder(ctx, binDir) {
  const bin = path.resolve(binDir);
  const dirs = String(ctx.env.PATH || "").split(path.delimiter).filter(Boolean).map((d) => path.resolve(d));
  const at = dirs.indexOf(bin);
  const other = dirs.findIndex((d) => d !== bin && fs.existsSync(path.join(d, "gh")));
  return { inPath: at >= 0, first: at >= 0 && (other < 0 || at < other), firstGh: other >= 0 ? dirs[other] : null };
}

// GUI 앱(Herdr 패널)은 PATH 가 짧을 수 있어, 터미널과 같은 PATH 를 사용자 로그인 셸에서 읽는다. 못 읽으면 null.
function shellPath(ctx) {
  const sh = ctx.env.SHELL && path.isAbsolute(ctx.env.SHELL) ? ctx.env.SHELL : "/bin/sh";
  const r = ctx.run(sh, ["-ilc", 'printf "\\n__GHA_PATH__%s__GHA_PATH__\\n" "$PATH"'], { env: ctx.env, timeout: 8000 });
  const m = String(r.stdout || "").match(/__GHA_PATH__(.*?)__GHA_PATH__/);
  return m && m[1] ? m[1] : null;
}

// 설치하면 바뀔 것. 아무것도 쓰지 않는다.
function planInstall(ctx, opts = {}) {
  const P = paths(ctx);
  const binDir = installBinDir(ctx, opts);
  const files = BIN_FILES.map((f) => {
    const p = path.join(binDir, f);
    return { path: p, action: !fs.existsSync(p) ? "create" : isOurs(p) ? "replace" : "blocked" };
  });
  const gh = realGh(ctx);
  const g = globalConfigPath(ctx);
  const order = pathOrder(ctx, binDir);
  const m = readMap(P.map);
  return {
    supported: ctx.platform !== "win32", binDir, files, blocked: files.filter((f) => f.action === "blocked").map((f) => f.path),
    app: P.app, globalConfig: g, prior: priorHelpers(ctx, g), gh: path.isAbsolute(gh) ? gh : null,
    inPath: order.inPath, wrapperFirst: order.first, firstGh: order.firstGh,
    map: P.map, mapOk: m.ok, installed: !!readState(P.state),
  };
}

// 제거하면 지울 것. 매핑 파일은 남긴다.
function planUninstall(ctx, opts = {}) {
  const P = paths(ctx);
  const binDir = uninstallBinDir(ctx, opts);
  const g = globalConfigPath(ctx);
  let text = "";
  try { text = fs.readFileSync(g, "utf8"); } catch { /* 없음 */ }
  return {
    binDir, files: BIN_FILES.map((f) => path.join(binDir, f)).filter(isOurs),
    globalConfig: g, block: text.includes(BEGIN), remove: [P.identity, P.state, P.app], map: P.map, installed: !!readState(P.state),
  };
}

// 설치 상태. 패널이 설치·업데이트·되돌리기 단추를 고를 때 쓴다.
function statusInfo(ctx) {
  const P = paths(ctx);
  const state = readState(P.state);
  const g = globalConfigPath(ctx);
  let text = "";
  try { text = fs.readFileSync(g, "utf8"); } catch { /* 없음 */ }
  const v = gitVersion(ctx);
  const binDir = state && state.binDir ? state.binDir : null;
  const files = binDir ? BIN_FILES.map((f) => ({ name: f, ok: isOurs(path.join(binDir, f)) })) : [];
  const order = binDir ? pathOrder(ctx, binDir) : { inPath: false, first: false, firstGh: firstGhDir(ctx) };
  let appCurrent = null;
  if (state) {
    try { appCurrent = fs.readFileSync(P.app, "utf8") === fs.readFileSync(__filename, "utf8"); } catch { appCurrent = false; }
  }
  const m = readMap(P.map);
  return {
    installed: !!state, binDir, files, filesOk: !!state && files.every((f) => f.ok),
    block: text.includes(BEGIN), globalConfig: g, git: v ? v.join(".") : null, identity: versionAtLeast(v, MIN_GIT),
    inPath: order.inPath, wrapperFirst: order.first, firstGh: order.firstGh,
    app: P.app, appCurrent,
    map: { path: P.map, ok: m.ok, rules: m.ok ? m.map.rules.length : 0, default: m.ok ? m.map.default : null, error: m.ok ? null : m.error },
  };
}

// gh 에 로그인된 github.com 계정. 읽지 못하면(옛 gh, gh 없음) null.
function activeLogin(accounts) {
  const a = (accounts || []).find((x) => x.active);
  return a ? a.login : null;
}

const same = (a, b) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

// 저장소의 커밋 신원. 폴더가 있으면 git 이 실제로 쓰는 값과 어디서 왔는지, 없으면 매핑 계정의 신원 파일.
function identityOf(ctx, dir, account) {
  const P = paths(ctx);
  if (dir) {
    const get = (key) => {
      const r = ctx.run("git", ["config", "--show-origin", "--get", key], { cwd: dir, env: gitEnv(ctx) });
      if (r.status !== 0) return null;
      const line = r.stdout.trim();
      const i = line.indexOf("\t");
      return i < 0 ? { value: line, origin: "" } : { value: line.slice(i + 1), origin: line.slice(0, i) };
    };
    const name = get("user.name"), email = get("user.email");
    if (!name && !email) return { name: null, email: null, how: "none" };
    const origin = (email || name).origin.replace(/^file:/, "");
    const how = path.resolve(path.dirname(origin)) === path.resolve(P.identity) ? "mapped" : origin === "command line:" ? "env" : "config";
    // 매핑 신원이면 git 이 실제로 읽은 신원 파일의 계정(파일 이름)을 알린다. 매핑 계정과 다를 수 있다.
    const account = how === "mapped" ? path.basename(origin, ".gitconfig") : null;
    return { name: name ? name.value : null, email: email ? email.value : null, how, account, origin: how === "mapped" ? null : origin };
  }
  if (!account) return null;
  let text = "";
  try { text = fs.readFileSync(path.join(P.identity, `${account}.gitconfig`), "utf8"); } catch { return { name: null, email: null, how: "none" }; }
  const pick = (k) => { const m = text.match(new RegExp(`^\\s*${k}\\s*=\\s*"((?:[^"\\\\]|\\\\.)*)"`, "m")); return m ? m[1].replace(/\\(.)/g, "$1") : null; };
  return { name: pick("name"), email: pick("email"), how: "mapped", account };
}

// 이 계정 토큰으로 GitHub 에 물어 본다: 누구로 접속되는지, 이 저장소에 어떤 권한이 있는지. 토큰은 자식 프로세스 환경에만 넣는다.
function accessTest(ctx, login, repo) {
  const t = tokenFor(ctx, login);
  if (!t.ok) return { ok: false, login: null, access: null, message: `${login} 계정 토큰을 받지 못했습니다. gh 에 로그인돼 있는지 보세요.` };
  const env = { ...cleanEnv(ctx.env), GH_TOKEN: t.token };
  const gh = realGh(ctx);
  const u = ctx.run(gh, ["api", "user", "--hostname", HOST, "--jq", ".login"], { env });
  const who = u.status === 0 ? u.stdout.trim() : "";
  if (!who) return { ok: false, login: null, access: null, message: `GitHub 에 ${login} 계정으로 접속하지 못했습니다. 토큰이 만료됐다면 다시 로그인하세요.` };
  let access = null;
  if (repo) {
    const r = ctx.run(gh, ["api", `repos/${repo.owner}/${repo.repo}`, "--hostname", HOST, "--jq", ".permissions"], { env });
    if (r.status === 0) {
      let p = null;
      try { p = JSON.parse(r.stdout || "null"); } catch { p = null; }
      access = !p ? "pull" : p.admin ? "admin" : p.push || p.maintain ? "push" : p.pull || p.triage ? "pull" : "none";
    } else access = /404|Not Found/i.test(r.stderr + r.stdout) ? "notfound" : "error";
  }
  const ok = same(who, login) && (!repo || ["admin", "push", "pull"].includes(access));
  return { ok, login: who, access };
}

// 폴더나 저장소 하나에서 gh, git push, 커밋 신원이 어느 계정을 쓰는지 한 번에 본다.
function check(ctx, { repo, dir, test } = {}) {
  const P = paths(ctx);
  const m = readMap(P.map);
  let remote = null;
  if (!repo && dir) { try { remote = remoteFromDir(ctx, dir); } catch { remote = null; } }
  const target = repo || (remote && remote.repo) || null;
  const accounts = ghLogins(ctx);
  const active = activeLogin(accounts);
  const state = readState(P.state);
  const order = state && state.binDir ? pathOrder(ctx, state.binDir) : null;
  const out = {
    repo: target ? `${target.owner}/${target.repo}` : null, dir: dir || null, remote: remote ? remote.url : null,
    mapOk: m.ok, error: m.ok ? null : m.error, account: null, by: null, match: null,
    active, accounts: accounts ? accounts.map((a) => a.login) : null, loggedIn: null,
    installed: !!state, wrapperFirst: order ? order.first : false,
    gh: null, push: null, identity: null, warn: [], test: null,
  };
  if (!target) return out;
  const hit = m.ok ? ownerOverDefault(matchAccount(m.map, target), target, accounts && accounts.map((a) => a.login)) : null;
  if (hit) Object.assign(out, { account: hit.account, by: hit.by, match: hit.match });
  if (hit && accounts) out.loggedIn = accounts.some((a) => same(a.login, hit.account));
  const used = !!(state && hit);
  out.gh = used && out.wrapperFirst ? { account: hit.account, how: "mapped" } : { account: active, how: used ? "path" : "active" };
  const ssh = remote && isSshUrl(remote.url);
  out.push = ssh ? { account: null, how: "ssh" } : used ? { account: hit.account, how: "mapped" } : { account: null, how: "prior" };
  out.identity = identityOf(ctx, dir || null, hit ? hit.account : null);
  if (!m.ok) out.warn.push(`매핑 파일이 깨져 아무 계정도 고르지 않습니다: ${m.error}`);
  if (!state) out.warn.push("gh-account 도구가 설치돼 있지 않아 매핑이 쓰이지 않습니다. 위에서 설치하세요.");
  else if (!out.wrapperFirst) out.warn.push("gh 래퍼가 PATH 에서 진짜 gh 보다 뒤에 있어 터미널의 gh 명령은 매핑을 따르지 않습니다. git push 와 커밋 신원은 따릅니다.");
  if (hit && out.loggedIn === false) out.warn.push(`${hit.account} 계정이 gh 에 로그인돼 있지 않아 이 저장소의 gh·git push 는 실패합니다. 계정 추가로 로그인하세요.`);
  const ghAcct = out.gh.account;
  // gh·git push·커밋 신원 중 하나라도 owner 와 다른 계정을 쓰면 알린다. 래퍼가 PATH 뒤에 있으면 gh 는 활성 계정이어도 push 는 매핑 계정이다.
  const ownerLogin = accounts && accounts.find((a) => same(a.login, target.owner));
  const idAcct = out.identity && out.identity.how === "mapped" ? out.identity.account : null;
  if (idAcct && hit && !same(idAcct, hit.account)) {
    out.warn.push(`커밋 신원은 ${idAcct} 계정 것인데 이 저장소는 ${hit.account} 계정을 씁니다. gh-account sync 를 실행하고, 그래도 같으면 ${hit.account} 계정의 신원 설정(identity)을 확인하세요.`);
  }
  const others = [...new Set([ghAcct, out.push.account, idAcct].filter((x) => x && ownerLogin && !same(x, ownerLogin.login)))];
  if (others.length) {
    out.warn.push(`${target.owner} 은(는) 로그인된 계정인데 이 저장소는 ${others.join(", ")} 계정을 씁니다. ${ownerLogin.login} 계정의 개인 저장소라면 규칙을 확인하세요.`);
  }
  if (test && ghAcct) out.test = accessTest(ctx, ghAcct, target);
  return out;
}

// ---- 계정 추가(gh auth login) ----
// gh auth login 은 새 계정을 gh 활성 계정으로 바꾸고, 바꾸지 않는 옵션이 없다.
// 다른 세션은 활성 계정으로 일하므로, 로그인이 끝나면 바로 원래 활성 계정으로 한 번 되돌린다(이슈 #28 선택지 A).

const LOGIN_TIMEOUT = 15 * 60 * 1000;
const RUNNING = new Set(["starting", "waiting"]);
function loginFile(ctx) { return path.join(paths(ctx).dir, "login.json"); }
function readLogin(ctx) { return readState(loginFile(ctx)); }
function writeLogin(ctx, st) {
  const f = loginFile(ctx);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(st, null, 2) + "\n");
  fs.renameSync(tmp, f);
}
function alive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}
// 토큰처럼 보이는 문자열과 색 코드를 지운다. gh 출력에는 토큰이 나오지 않지만 메시지에 남기지 않으려고 한 번 더 거른다.
function scrub(s) {
  return String(s || "").replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
    .replace(/\b(gh[opsur]_[A-Za-z0-9_]{10,}|github_pat_[A-Za-z0-9_]{10,})\b/g, "[가림]");
}

// 이 도구에서 gh auth switch 를 부르는 곳은 여기 하나다. 로그인 직후, 활성 계정이 바뀌었을 때만 원래 계정으로 되돌린다.
function restoreActive(ctx, prev, now) {
  if (!prev) return { ok: true, switched: false };
  if (same(prev, now)) return { ok: true, switched: false };
  const r = ctx.run(realGh(ctx), ["auth", "switch", "--hostname", HOST, "--user", prev], { env: cleanEnv(ctx.env) });
  const after = activeLogin(ghLogins(ctx));
  if (r.status !== 0 || !same(after, prev)) {
    return { ok: false, switched: false, message: `gh 활성 계정을 ${prev}(으)로 되돌리지 못했습니다. 터미널에서 gh auth switch --hostname github.com --user ${prev} 를 실행하세요.` };
  }
  return { ok: true, switched: true };
}

function loginStatus(ctx) {
  const st = readLogin(ctx);
  if (!st) return { state: "none" };
  const stale = RUNNING.has(st.state) && (st.pid ? !alive(st.pid) : Date.now() - (st.startedAt || 0) > 30000);
  if (stale) {
    const next = { ...st, state: "failed", message: "로그인 진행이 중간에 멈췄습니다. 다시 시도하세요." };
    writeLogin(ctx, next);
    return next;
  }
  return st;
}

// 로그인을 뒤에서 돌리는 프로세스를 띄우고 바로 돌아온다. 진행 상황은 login status 로 읽는다.
function loginStart(ctx) {
  if (ctx.platform === "win32") return { ok: false, message: "gh-account 는 아직 Windows 를 지원하지 않습니다." };
  const cur = loginStatus(ctx);
  if (RUNNING.has(cur.state)) return { ok: false, message: "이미 계정 추가가 진행 중입니다.", login: cur };
  const accounts = ghLogins(ctx);
  if (!accounts) return { ok: false, message: "gh auth status --json 을 읽지 못했습니다. gh 2.60 이상이 설치돼 있는지 보세요." };
  const prev = activeLogin(accounts);
  const gh = realGh(ctx);
  writeLogin(ctx, { state: "starting", prev, pid: null, code: null, url: null, startedAt: Date.now() });
  const spawn = ctx.spawn || require("child_process").spawn;
  const args = [__filename, "login", "run", ...(prev ? ["--prev", prev] : [])];
  const child = spawn(ctx.node || process.execPath, args, {
    detached: true, stdio: "ignore", cwd: homeDir(ctx),
    env: { ...ctx.env, ...(path.isAbsolute(gh) ? { GH_ACCOUNT_GH: gh } : {}) },
  });
  if (child.unref) child.unref();
  return { ok: true, login: readLogin(ctx) };
}

function loginCancel(ctx) {
  const st = loginStatus(ctx);
  if (!RUNNING.has(st.state)) return { ok: false, message: "진행 중인 계정 추가가 없습니다.", login: st };
  if (st.pid && alive(st.pid)) { try { process.kill(st.pid, "SIGTERM"); } catch { /* 이미 끝남 */ } }
  else writeLogin(ctx, { ...st, state: "cancelled", message: "계정 추가를 그만뒀습니다." });
  return { ok: true };
}

// gh auth login --web 을 돌리며 일회용 코드와 주소를 상태 파일에 적고, 끝나면 활성 계정을 되돌린다.
function loginRun(ctx, prev, opts = {}) {
  return new Promise((done) => {
    const startedAt = (readLogin(ctx) || {}).startedAt || Date.now();
    let st = { state: "waiting", prev: prev || null, pid: process.pid, code: null, url: null, startedAt };
    writeLogin(ctx, st);
    const spawn = ctx.spawn || require("child_process").spawn;
    let child, buf = "", cancelled = false, timedOut = false, finished = false;
    try {
      child = spawn(realGh(ctx), ["auth", "login", "--hostname", HOST, "--web", "--git-protocol", "https"], { env: cleanEnv(ctx.env), stdio: ["pipe", "pipe", "pipe"] });
    } catch (e) { child = null; }
    const finish = (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      process.removeListener("SIGTERM", onTerm);
      if (code !== 0) {
        const last = scrub(buf).split("\n").map((l) => l.trim()).filter(Boolean).pop() || "";
        const why = cancelled ? "계정 추가를 그만뒀습니다." : timedOut ? "15분 안에 브라우저 승인이 끝나지 않아 멈췄습니다." : `gh auth login 이 실패했습니다${last ? `: ${last}` : "."}`;
        st = { ...st, state: cancelled ? "cancelled" : "failed", message: why };
        writeLogin(ctx, st);
        done(1);
        return;
      }
      const now = activeLogin(ghLogins(ctx));
      const back = restoreActive(ctx, st.prev, now);
      // 진짜 gh 를 바로 돌렸으므로 래퍼의 다시 맞추기가 돌지 않는다. 새 계정의 커밋 신원을 여기서 맞춘다.
      // 설치돼 있을 때만: 되돌린 뒤(매핑 파일은 남는다)나 설치 전에 git 블록과 신원 파일을 새로 쓰면 안 된다.
      let synced = null;
      const P = paths(ctx);
      if (readState(P.state)) { try { synced = sync(ctx); } catch { synced = false; } }
      const note = synced === false ? "커밋 신원을 다시 맞추지 못했습니다. gh-account sync 를 실행하세요." : null;
      st = { ...st, state: "done", added: now, restored: back.ok, switched: back.switched, synced, message: [back.message, note].filter(Boolean).join(" ") || null };
      writeLogin(ctx, st);
      done(back.ok ? 0 : 1);
    };
    const onTerm = () => { cancelled = true; if (child) child.kill("SIGTERM"); else finish(1); };
    process.on("SIGTERM", onTerm);
    const timer = setTimeout(() => { timedOut = true; if (child) child.kill("SIGTERM"); }, opts.timeout || LOGIN_TIMEOUT);
    if (!child) { finish(-1); return; }
    const onData = (d) => {
      buf = (buf + d.toString()).slice(-20000);
      const text = scrub(buf);
      const c = text.match(/\b([A-Z0-9]{4}-[A-Z0-9]{4})\b/);
      const u = text.match(/https:\/\/github\.com\/login\/device[^\s"']*/);
      const code = c ? c[1] : st.code, url = u ? u[0] : st.url;
      if (code !== st.code || url !== st.url) { st = { ...st, code, url }; writeLogin(ctx, st); }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.stdin.on("error", () => {});
    child.stdin.end("\n");
    child.on("error", () => finish(-1));
    child.on("close", (code) => finish(code));
  });
}

function install(ctx, opts, log) {
  if (ctx.platform === "win32") { log("gh-account 는 아직 Windows 를 지원하지 않습니다."); return 1; }
  const P = paths(ctx);
  const binDir = installBinDir(ctx, opts);
  for (const f of BIN_FILES) {
    const t = path.join(binDir, f);
    if (fs.existsSync(t) && !isOurs(t)) { log(`${t} 에 다른 파일이 있어 설치를 멈춥니다. 그 파일을 옮긴 뒤 다시 실행하세요.`); return 1; }
  }
  const gh = realGh(ctx);
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
  const order = pathOrder(ctx, binDir);
  if (!order.first) {
    const why = order.inPath ? `${order.firstGh} 의 gh 가 먼저 찾혀` : `${binDir} 가 PATH 에 없어`;
    log(`주의: PATH 에서 ${why} 터미널의 gh 명령은 래퍼를 쓰지 않습니다(git push 와 커밋 신원은 매핑을 따릅니다). 셸 설정에 export PATH="${binDir}:$PATH" 를 더하세요.`);
  }
  if (!readMap(P.map).ok) log(`매핑 파일(${P.map})이 깨져 있어 지금은 아무 계정도 고르지 않습니다.`);
  return 0;
}

function uninstall(ctx, opts, log) {
  const P = paths(ctx);
  const binDir = uninstallBinDir(ctx, opts);
  for (const f of BIN_FILES) {
    const t = path.join(binDir, f);
    if (isOurs(t)) { fs.rmSync(t, { force: true }); log(`지움: ${t}`); }
  }
  writeBlock(globalConfigPath(ctx), null);
  fs.rmSync(P.identity, { recursive: true, force: true });
  fs.rmSync(P.state, { force: true });
  fs.rmSync(P.logins, { force: true });
  fs.rmSync(P.app, { force: true });
  // 진행 중인 계정 추가의 상태 파일은 남긴다. 끝난 기록만 지운다.
  if (!RUNNING.has(loginStatus(ctx).state)) fs.rmSync(loginFile(ctx), { force: true });
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
  move <owner/* | owner/repo> <up|down>  규칙 순서를 한 칸 옮긴다(위에 있을수록 먼저 맞는다)
  default <계정 | none>                  규칙에 없는 저장소에 쓸 계정
  space [--json] <폴더..>                폴더들의 저장소를 owner 별로 묶어 지금 쓰는 계정을 보여 준다
  assign <계정 | none> <폴더..> [--json] 폴더들에서 찾은 owner 마다 owner/* 규칙을 그 계정으로 정한다(none: 지움). 로그인된 계정과 같은 owner 는 건너뜀
  identity <계정> [--name 이름] [--email 주소] [--off | --auto]  커밋 신원
  sync                                 신원 파일과 git 전역 설정 블록을 다시 만든다
  check [폴더 | -R owner/repo] [--test] [--json]  gh, git push, 커밋 신원이 쓸 계정을 한 번에 보여 준다(--test: GitHub 에 접속해 본다)
  login start | status | cancel [--json]  gh auth login --web 으로 계정을 더한다. 끝나면 gh 활성 계정을 원래대로 되돌린다
  install [--bin 폴더] [--dry-run] [--json]  설치한다(--dry-run: 바뀔 것만 보여 준다)
  uninstall [--dry-run] [--json]        설치 전으로 되돌린다(매핑 파일은 남긴다)
  status [--json]                      설치·PATH·git 버전 점검
  shell-path                           로그인 셸의 PATH 를 출력한다(GUI 앱이 터미널과 같은 gh 를 찾게 할 때)`;

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

function checkText(io, c) {
  if (!c.repo) { io.out(`${c.dir || "이 폴더"}: github.com 원격을 찾지 못했습니다. gh 와 git 은 원래 계정을 씁니다.`); }
  else {
    io.out(`${c.repo}${c.remote ? ` (${c.remote})` : ""}`);
    io.out(`  매핑: ${c.account ? `${c.account} (${c.by === "rule" ? `규칙 ${c.match}` : c.by === "owner" ? "로그인된 계정의 저장소" : "default"})` : "없음"}`);
    io.out(`  gh: ${c.gh.account || "(활성 계정 없음)"}${c.gh.how === "active" ? " (gh 활성 계정)" : c.gh.how === "path" ? " (래퍼가 쓰이지 않아 gh 활성 계정)" : ""}`);
    io.out(`  git push: ${c.push.how === "ssh" ? "SSH 키" : c.push.how === "prior" ? "원래 자격 증명(키체인 등)" : c.push.account}`);
    const id = c.identity;
    io.out(`  커밋 신원: ${!id || id.how === "none" ? "정해지지 않음" : `${id.name || "?"} <${id.email || "?"}>${id.how === "mapped" ? ` (${id.account ? `${id.account} 계정 ` : ""}매핑)` : id.origin ? ` (${id.origin})` : ""}`}`);
  }
  for (const w of c.warn) io.out(`주의: ${w}`);
  if (c.test) {
    const t = c.test;
    io.out(`접속 시험: ${t.ok ? "성공" : "실패"}${t.login ? ` · ${t.login} 로 접속` : ""}${t.access ? ` · 권한 ${t.access}` : ""}${t.message ? ` · ${t.message}` : ""}`);
  }
}

function planText(io, p, kind) {
  if (kind === "install") {
    io.out(`설치 폴더: ${p.binDir}`);
    for (const f of p.files) io.out(`  ${f.action === "create" ? "새로 만듦" : f.action === "replace" ? "바꿈" : "다른 파일이 있어 멈춤"}: ${f.path}`);
    io.out(`git 전역 설정: ${p.globalConfig} 에 gh-account 블록(자격 증명 도우미, 커밋 신원 includeIf)을 씀`);
    io.out(`원래 자격 증명 도우미 ${p.prior.length}개는 블록 뒤에 그대로 둠`);
    io.out(`도구 사본: ${p.app}`);
    io.out(`진짜 gh: ${p.gh || "찾지 못함"}`);
    if (!p.wrapperFirst) io.out(`주의: PATH 에서 ${p.inPath ? `${p.firstGh} 의 gh 가 먼저 찾혀` : `${p.binDir} 가 없어`} 터미널의 gh 명령은 래퍼를 쓰지 않습니다.`);
  } else {
    io.out(`지울 파일: ${p.files.length ? p.files.join(", ") : "없음"}`);
    io.out(`git 전역 설정 블록: ${p.block ? `${p.globalConfig} 에서 지움` : "없음"}`);
    io.out(`지울 것: 커밋 신원 파일(${p.remove[0]}), 설치 기록(${p.remove[1]}), 도구 사본(${p.remove[2]})`);
    io.out(`남기는 것: 매핑 파일 ${p.map}, gh 로그인(계정은 그대로)`);
  }
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
    case "move": {
      const [pattern, dir] = args;
      if (!pattern || (dir !== "up" && dir !== "down")) { io.err(USAGE); return 2; }
      return editMap(ctx, io, (map) => (moveRule(map, pattern, dir) ? `규칙을 옮겼습니다: ${pattern} ${dir === "up" ? "위로" : "아래로"}` : `옮길 수 없습니다: ${pattern}`));
    }
    case "default": {
      const a = args[0];
      if (!a || (a !== "none" && !LOGIN.test(a))) { io.err(USAGE); return 2; }
      const code = editMap(ctx, io, (map) => { map.default = a === "none" ? null : a; return `default: ${map.default || "(없음)"}${map.default ? "\n  로그인된 계정 자신의 저장소(owner 가 그 계정 이름)는 default 가 아니라 그 계정을 씁니다." : ""}`; });
      if (code === 0 && a !== "none") warnLogin(ctx, io, a);
      return code;
    }
    case "space": {
      const json = args.includes("--json");
      const dirs = args.filter((a) => a !== "--json");
      const m = readMap(P.map);
      if (!m.ok) {
        if (json) { io.out(JSON.stringify({ owners: [], error: m.error })); return 0; }
        io.err(m.error); return 1;
      }
      const owners = spaceOwners(ctx, dirs.length ? dirs : [ctx.cwd], m.map, loginNames(ctx));
      if (json) { io.out(JSON.stringify({ owners, error: null })); return 0; }
      if (!owners.length) { io.out("이 폴더들에서 github.com 원격을 찾지 못했습니다."); return 0; }
      for (const o of owners) {
        io.out(`${o.owner}/*: ${o.rule || "(규칙 없음)"}${o.personal ? " (로그인된 계정)" : ""}`);
        for (const r of o.repos) io.out(`  ${r.repo} -> ${r.account || "(매핑 없음)"}${r.by === "rule" && r.match !== `${o.owner}/*` ? ` (규칙 ${r.match})` : r.by === "default" ? " (default)" : r.by === "owner" ? " (로그인된 계정의 저장소)" : ""}`);
      }
      return 0;
    }
    case "assign": {
      const json = args.includes("--json");
      for (let i = args.indexOf("--json"); i >= 0; i = args.indexOf("--json")) args.splice(i, 1);
      const a = args.shift();
      if (!a || (a !== "none" && !LOGIN.test(a)) || !args.length) { io.err(USAGE); return 2; }
      const account = a === "none" ? null : a;
      const m = readMap(P.map);
      if (!m.ok) { io.err(`${m.error}\n파일을 고치거나 지운 뒤 다시 실행하세요: ${P.map}`); return 1; }
      const owners = spaceOwners(ctx, args, m.map, account ? loginNames(ctx) : []);
      if (!owners.length) { io.err("이 폴더들에서 github.com 원격을 찾지 못해 바꾼 규칙이 없습니다."); return 1; }
      let res = { changed: [], skipped: [] };
      const notes = [];
      const sub = json ? { ...io, out: (l) => notes.push(l) } : io;
      const code = editMap(ctx, sub, (map) => {
        res = assignOwners(map, owners, account);
        const msg = [];
        if (!res.changed.length) msg.push("바꾼 규칙이 없습니다.");
        else msg.push(account ? `규칙: ${res.changed.join(", ")} -> ${account}` : `규칙을 지웠습니다: ${res.changed.join(", ")}`);
        if (res.skipped.length) msg.push(`주의: ${res.skipped.join(", ")} 은(는) 로그인된 계정이라 개인 저장소일 수 있어 ${account} 로 바꾸지 않았습니다. 정말 바꾸려면 그 owner 만 따로 정하세요(gh-account set <owner>/* <계정>).`);
        return msg.join("\n");
      });
      if (code === 0 && account) warnLogin(ctx, sub, account);
      if (json && code === 0) io.out(JSON.stringify({ ...res, account, notes }));
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
    case "uninstall": {
      const json = args.includes("--json"), dry = args.includes("--dry-run");
      const opts = { bin: flag(args, "--bin") };
      if (dry) {
        const plan = cmd === "install" ? planInstall(ctx, opts) : planUninstall(ctx, opts);
        const lines = [];
        planText({ out: (l) => lines.push(l) }, plan, cmd);
        if (json) io.out(JSON.stringify({ ...plan, lines })); else lines.forEach((l) => io.out(l));
        return 0;
      }
      return cmd === "install" ? install(ctx, opts, io.out) : uninstall(ctx, opts, io.out);
    }
    case "status": {
      const s = statusInfo(ctx);
      if (args.includes("--json")) { io.out(JSON.stringify(s)); return 0; }
      io.out(`설치: ${s.installed ? s.binDir : "안 됨"}${s.installed && !s.filesOk ? " (파일 일부가 없음: 다시 설치하세요)" : ""}`);
      io.out(`git 전역 설정 블록: ${s.block ? "있음" : "없음"} (${s.globalConfig})`);
      io.out(`git ${s.git || "?"}: 커밋 신원 ${s.identity ? "가능" : "불가(2.36 이상 필요)"}`);
      if (s.installed) {
        io.out(`gh 래퍼: ${s.wrapperFirst ? "PATH 에서 먼저 찾힘" : `쓰이지 않음(${s.inPath ? `먼저 찾히는 gh: ${s.firstGh}` : `${s.binDir} 가 PATH 에 없음`})`}`);
        if (s.appCurrent === false) io.out("도구 사본이 이 버전과 다릅니다. 다시 설치하면 맞춰집니다.");
      }
      io.out(`매핑: ${s.map.ok ? `규칙 ${s.map.rules}개, default ${s.map.default || "없음"}` : s.map.error}`);
      return 0;
    }
    case "check": {
      const json = args.includes("--json"), test = args.includes("--test");
      const rest = args.filter((a) => a !== "--json" && a !== "--test");
      const R = flag(rest, "-R") || flag(rest, "--repo");
      let repo = null;
      if (R) { repo = parseRepo(R); if (!repo) { io.err(`github.com 저장소가 아닙니다: ${R}`); return 2; } }
      const raw = rest[0] && /^~(\/|$)/.test(rest[0]) ? path.join(homeDir(ctx), rest[0].slice(1)) : rest[0];
      const dir = repo ? null : path.resolve(ctx.cwd, raw || ".");
      const c = check(ctx, { repo, dir, test });
      if (json) io.out(JSON.stringify(c)); else checkText(io, c);
      return 0;
    }
    case "shell-path": {
      const p = shellPath(ctx);
      if (!p) { io.err("로그인 셸의 PATH 를 읽지 못했습니다."); return 1; }
      io.out(p);
      return 0;
    }
    case "login": {
      const sub = args.shift();
      const json = args.includes("--json");
      const show = (r) => {
        if (json) { io.out(JSON.stringify(r)); return; }
        const st = r.login || r;
        if (r.message) io.out(r.message);
        if (st.code) io.out(`일회용 코드: ${st.code}  주소: ${st.url || "https://github.com/login/device"}`);
        if (st.state) io.out(`상태: ${st.state}${st.added ? ` · 더한 계정 ${st.added}` : ""}${st.message && st !== r ? ` · ${st.message}` : ""}`);
      };
      if (sub === "start") { const r = loginStart(ctx); show(r); return r.ok ? 0 : 1; }
      if (sub === "status") { show(loginStatus(ctx)); return 0; }
      if (sub === "cancel") { const r = loginCancel(ctx); show(r); return r.ok ? 0 : 1; }
      if (sub === "run") return loginRun(ctx, flag(args, "--prev") || null);
      io.err(USAGE);
      return 2;
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
  if (code && typeof code.then === "function") {
    code.then((c) => { process.exitCode = c; }, (e) => { io.err(`gh-account: ${e.message}`); process.exitCode = 1; });
  } else process.exitCode = code;
}

module.exports = {
  HOST, MARK, BEGIN, END, paths, parseRepo, readMap, writeMap, emptyMap, matchAccount, setRule, unsetRule, moveRule,
  repoFromDir, spaceOwners, assignOwners, repoFromGhArgs, realGh, tokenFor, resolve, ghToken, credential, parseCredInput, credRepo,
  ourCredential, priorCommand, priorHelper,
  globalConfigPath, stripBlock, writeBlock, buildBlock, urlPatterns, priorHelpers, identityFor, sync,
  scripts, install, uninstall, main, makeCtx,
  remoteFromDir, safeUrl, isSshUrl, pathOrder, shellPath, planInstall, planUninstall, statusInfo,
  ghAccounts: ghLogins, ghLogins, identityOf, accessTest, check, scrub, restoreActive, readLogin, writeLogin, loginStatus, loginStart, loginCancel, loginRun,
};
