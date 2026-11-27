// github.cjs: uploads one memo file to a GitHub repository through the GitHub CLI (`gh`), for the memo mod (#144). memo.cjs runs it.
// Login is the person's own `gh auth login`: this code never reads, prints, stores or passes a token and does not touch GH_TOKEN. It only runs `gh` (no shell: argument arrays).
// Flow: checkGh (gh installed and logged in) -> repoInfo (private or public) -> upload (GET the file's sha, then PUT with a JSON body from a temp file via --input).
// Every function that runs gh takes `run(args)` -> {code, stdout, stderr, error}, so tests can pass a mock and never touch GitHub.
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const childProcess = require("node:child_process");

const DEFAULT_FOLDER = "memos";
const MAX_UPLOAD_BYTES = 1024 * 1024; // the same 1 MiB the memo screen opens
const MAX_PATH_CHARS = 240;
const MAX_SEGMENT_CHARS = 100;
const GH_TIMEOUT_MS = 30000;
const GH_HOST = "github.com";
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const BAD_SEGMENT_CHARS = /[<>:"/\\|?*\u0000-\u001f\u007f]/;

const clip = (s, n) => { const a = Array.from(String(s ?? "").replace(/\s+/g, " ").trim()); return a.length > n ? a.slice(0, n - 1).join("") + "…" : a.join(""); };

// ---- setting strings
// "owner/name" (a pasted https://github.com/owner/name(.git) URL is accepted too) -> {owner, repo}.
function parseRepo(raw) {
  let s = String(raw ?? "").trim().replace(/^https:\/\/github\.com\//i, "").replace(/\/+$/, "").replace(/\.git$/i, "");
  if (!s) throw new Error("올릴 저장소를 정하세요(owner/이름)");
  const m = /^([^/]+)\/([^/]+)$/.exec(s);
  if (!m) throw new Error("저장소는 owner/이름 모양으로 쓰세요");
  const [, owner, repo] = m;
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(owner)) throw new Error("owner에는 영문자·숫자·하이픈(-)만 쓸 수 있습니다");
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(repo) || repo === "." || repo === "..") throw new Error("저장소 이름에는 영문자·숫자·점·밑줄·하이픈만 쓸 수 있습니다");
  return { owner, repo };
}

// "" = the repository's default branch. Otherwise a plain branch name (git's ref rules, without the exotic characters).
function parseBranch(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return "";
  const bad = !/^[\p{L}\p{N}._/-]+$/u.test(s) || s.startsWith("-") || s.startsWith("/") || s.endsWith("/") || s.endsWith(".") || s.endsWith(".lock")
    || s.includes("..") || s.includes("//") || s.split("/").some((p) => p.startsWith(".") || p === "");
  if (bad || s.length > 200) throw new Error("브랜치 이름이 올바르지 않습니다");
  return s;
}

// One path part (a folder name or the file name): no "." / "..", no leading dot (so never .git or .github), nothing a Windows checkout would reject.
function checkSegment(seg, what) {
  const s = String(seg ?? "").normalize("NFC");
  if (!s || s === "." || s === "..") throw new Error(`${what}에 빈 이름이나 ‘.’ ‘..’ 은 쓸 수 없습니다`);
  if (s.startsWith(".")) throw new Error(`${what}은 점(.)으로 시작할 수 없습니다`);
  if (BAD_SEGMENT_CHARS.test(s)) throw new Error(`${what}에 못 쓰는 글자가 있습니다(/ \\ : * ? " < > | 와 제어 문자)`);
  if (/[. ]$/.test(s) || WINDOWS_RESERVED.test(s.split(".")[0])) throw new Error(`${what}이 윈도우에서 못 쓰는 이름입니다`);
  if (Array.from(s).length > MAX_SEGMENT_CHARS) throw new Error(`${what}이 너무 깁니다`);
  return s;
}

// Folder inside the repository, "/"-separated, "" = the default. Returns the normalized folder.
function parseFolder(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return DEFAULT_FOLDER;
  if (s.includes("\\")) throw new Error("폴더는 슬래시(/)로 나누어 쓰세요");
  return s.replace(/^\/+|\/+$/g, "").split("/").map((p) => checkSegment(p, "폴더 이름")).join("/") || DEFAULT_FOLDER;
}

// The saved setting {repo, branch, folder} -> validated parts. Throws a Korean message for the screen.
function normalizeSettings(raw) {
  const { owner, repo } = parseRepo(raw?.repo);
  return { owner, repo, repoText: `${owner}/${repo}`, branch: parseBranch(raw?.branch), folder: parseFolder(raw?.folder) };
}

// ---- paths and URLs
// Path of a memo inside the repository: <folder>/<file name>, in NFC so a name typed on macOS (NFD) and on Windows (NFC) is the same file.
function remotePath(folder, file) {
  const name = checkSegment(file, "메모 파일 이름");
  const p = `${folder}/${name}`;
  if (p.length > MAX_PATH_CHARS) throw new Error("저장소 안 경로가 너무 깁니다");
  return p;
}
// Per-part percent encoding (Korean, spaces, # ? % and the characters encodeURIComponent keeps: ! ' ( ) *). It also encodes { } : so `gh api` never reads a part as {owner}/:repo.
function encodePath(p) {
  try {
    return String(p).split("/").map((s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)).join("/");
  } catch { throw new Error("경로에 올바르지 않은 글자가 있습니다"); }
}
function contentsEndpoint(owner, repo, remote, branch) {
  return `repos/${owner}/${repo}/contents/${encodePath(remote)}${branch ? `?ref=${encodeURIComponent(branch)}` : ""}`;
}
const commitMessage = (title, update) => `${update ? "메모 수정" : "메모 추가"}: ${clip(title, 60) || "제목 없음"}`;
// The JSON body of the PUT: content is the file's exact bytes in base64; branch only when one is set; sha only when the file exists.
function buildBody({ message, content, branch, sha }) {
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(String(content ?? ""), "utf8");
  return JSON.stringify({ message, content: bytes.toString("base64"), ...(branch ? { branch } : {}), ...(sha ? { sha } : {}) });
}

// ---- running gh
// GUI apps start with a short PATH: add the usual install folders of gh after the existing ones (never before them).
function ghEnv(env, platform) {
  const win = platform === "win32";
  const extra = win ? [env.ProgramFiles && `${env.ProgramFiles}\\GitHub CLI`, env.LOCALAPPDATA && `${env.LOCALAPPDATA}\\Programs\\GitHub CLI`]
    : platform === "darwin" ? ["/opt/homebrew/bin", "/usr/local/bin"] : ["/usr/local/bin"];
  const key = Object.keys(env).find((k) => k.toLowerCase() === "path") ?? "PATH";
  const sep = win ? ";" : ":";
  const have = String(env[key] ?? "").split(sep).filter(Boolean);
  const add = extra.filter((d) => d && !have.includes(d));
  return { ...env, [key]: [...have, ...add].join(sep) };
}
// `gh` with no shell and no stdin (gh.exe on Windows is found by CreateProcess). Never throws: {code, stdout, stderr, error}.
function ghRun(args, timeout = GH_TIMEOUT_MS) {
  const r = childProcess.spawnSync("gh", args, { encoding: "utf8", timeout, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 16 * 1024 * 1024, env: ghEnv(process.env, process.platform) });
  return { code: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", error: r.error ?? null };
}

const LOGIN_HELP = "터미널에서 gh auth login 을 한 뒤 다시 올리세요";
// A failed gh result -> {kind, status, message}. status comes from gh's "(HTTP 404)" line; message is GitHub's own "message" field (never raw output).
function parseFailure(r) {
  const stderr = String(r?.stderr ?? "");
  const status = Number((/\(HTTP (\d{3})\)/.exec(stderr) ?? [])[1]) || 0;
  let message = "";
  try { const j = JSON.parse(String(r?.stdout ?? "")); if (j && typeof j.message === "string") message = j.message; } catch {}
  let kind = "other";
  if (r?.error?.code === "ENOENT") kind = "nogh";
  else if (r?.error?.code === "ETIMEDOUT") kind = "timeout";
  else if (status === 401 || /gh auth login|not logged in|authentication required/i.test(stderr)) kind = "login";
  else if (!status && /error connecting|dial tcp|no such host|i\/o timeout|connection (refused|reset)/i.test(stderr)) kind = "network";
  return { kind, status, message };
}
// stage: "repo" (looking up the repository), "lookup" (looking up the file), "put" (writing it). Short Korean text for the memo screen.
function mapGhError(f, stage) {
  if (f.kind === "nogh") return "gh(GitHub CLI)를 찾지 못했습니다. cli.github.com 에서 설치한 뒤 " + LOGIN_HELP;
  if (f.kind === "login") return `gh에 로그인돼 있지 않습니다. ${LOGIN_HELP}`;
  if (f.kind === "timeout") return "GitHub 응답이 너무 늦습니다. 잠시 뒤 다시 하세요";
  if (f.kind === "network") return "GitHub에 연결하지 못했습니다. 인터넷 연결을 확인하세요";
  if (f.status === 403) return "권한이 없습니다(403). 이 저장소에 쓸 수 있는 계정으로 gh에 로그인했는지, 브랜치가 보호돼 있지 않은지 확인하세요";
  if (f.status === 404) return stage === "put" || /No commit found for the ref/i.test(f.message) ? "저장소나 브랜치를 찾지 못했습니다(404). 브랜치 이름을 확인하세요"
    : "저장소를 찾지 못했습니다(404). owner/이름 철자와, 비공개 저장소라면 gh 로그인 계정의 접근 권한을 확인하세요";
  if (f.status === 409) return "그 사이 같은 파일이 바뀌었습니다(409). 다시 올리면 최신 파일 기준으로 고칩니다";
  if (f.status === 422) return /sha/i.test(f.message) ? "이미 있는 파일의 버전이 맞지 않습니다(422). 다시 올리면 최신 파일 기준으로 고칩니다" : `올릴 수 없습니다(422)${f.message ? `: ${clip(f.message, 80)}` : ""}`;
  if (f.status >= 500) return `GitHub 서버 오류입니다(${f.status}). 잠시 뒤 다시 하세요`;
  return `GitHub 요청이 실패했습니다${f.status ? `(${f.status})` : ""}${f.message ? `: ${clip(f.message, 80)}` : ""}`;
}
const fail = (r, stage) => new Error(mapGhError(parseFailure(r), stage));

// ---- the steps
// {ready: true} or {ready: false, reason: "nogh" | "login", message}. gh missing, or `gh auth status` not succeeding -> the guide, and the caller stops.
function checkGh(run = ghRun) {
  const r = run(["auth", "status", "--hostname", GH_HOST]);
  if (r.error?.code === "ENOENT") return { ready: false, reason: "nogh", message: mapGhError({ kind: "nogh" }) };
  if (r.code !== 0) return { ready: false, reason: "login", message: `gh가 로그인돼 있지 않거나 GitHub에 닿지 못했습니다. 터미널에서 gh auth status 로 확인하고, 필요하면 gh auth login 을 하세요` };
  return { ready: true };
}
// {isPublic}: `gh api repos/{o}/{r} --jq .private`.
function repoInfo(owner, repo, run = ghRun) {
  const r = run(["api", `repos/${owner}/${repo}`, "--jq", ".private"]);
  if (r.code !== 0) throw fail(r, "repo");
  const v = String(r.stdout).trim();
  if (v !== "true" && v !== "false") throw new Error("저장소가 공개인지 비공개인지 알 수 없어 올리지 않습니다");
  return { isPublic: v === "false" };
}
// Uploads `content` (Buffer) as <folder>/<file>: creates it, or updates it with the sha it has now. Returns {url, created, unchanged}.
function upload({ owner, repo, branch, folder }, { file, title, content }, run = ghRun, tmpRoot = os.tmpdir()) {
  if (content.length > MAX_UPLOAD_BYTES) throw new Error("1 MiB보다 큰 메모는 올리지 않습니다");
  const remote = remotePath(folder, file);
  let sha = null;
  const got = run(["api", contentsEndpoint(owner, repo, remote, branch)]);
  if (got.code === 0) {
    let j = null;
    try { j = JSON.parse(got.stdout); } catch {}
    if (Array.isArray(j)) throw new Error("저장소에 같은 이름의 폴더가 있어 올릴 수 없습니다");
    if (!j || j.type !== "file" || typeof j.sha !== "string") throw new Error("저장소의 같은 이름 항목이 일반 파일이 아니라 올릴 수 없습니다");
    if (typeof j.content === "string" && j.content.replace(/\s+/g, "") === content.toString("base64")) return { url: htmlUrl(j.html_url), created: false, unchanged: true };
    sha = j.sha;
  } else {
    const f = parseFailure(got);
    if (!(f.status === 404 && !/No commit found for the ref/i.test(f.message))) throw new Error(mapGhError(f, "lookup")); // a plain 404 = the file is new
  }
  const dir = fs.mkdtempSync(path.join(tmpRoot, "memo-gh-"));
  try {
    const bodyFile = path.join(dir, "body.json");
    fs.writeFileSync(bodyFile, buildBody({ message: commitMessage(title, Boolean(sha)), content, branch, sha }), { mode: 0o600 });
    const put = run(["api", "-X", "PUT", contentsEndpoint(owner, repo, remote, ""), "--input", bodyFile]);
    if (put.code !== 0) throw fail(put, "put");
    let j = null;
    try { j = JSON.parse(put.stdout); } catch {}
    return { url: htmlUrl(j?.content?.html_url), created: !sha, unchanged: false };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
const htmlUrl = (u) => (typeof u === "string" && u.startsWith(`https://${GH_HOST}/`) ? u : "");

module.exports = { DEFAULT_FOLDER, MAX_UPLOAD_BYTES, parseRepo, parseBranch, parseFolder, checkSegment, normalizeSettings, remotePath, encodePath, contentsEndpoint, commitMessage, buildBody, ghEnv, ghRun, parseFailure, mapGhError, checkGh, repoInfo, upload };
