// memo.cjs: the helper of the memo mod (#136). The mod (main.js) cannot require a .cjs file, so it runs this with `exec("node", [memo.cjs, <app home>, <command>, ...])`.
// It prints ONE JSON line on stdout ({ok: true, ...} or {ok: false, error}). Text that may hold quotes or line breaks goes in as base64 (exec has no stdin).
//
// One memo = one .md file in the memo folder. The folder is the person's choice (config.json under <app home>/memo/); the default is
// ~/Documents/Herdr Memos (Windows: %USERPROFILE%\Documents\Herdr Memos). Google Drive / OneDrive / iCloud work as a folder inside the sync folder of their desktop app: this code
// never talks to any cloud service and never logs in.
//   config            -> {dir, defaultDir, custom}
//   setdir <b64 dir>  -> saves the folder (created if missing)
//   list              -> {dir, exists, items: [{file, path, title, mtime, size, preview}], truncated}
//   name <b64 text>   -> {file, path}: (text = the start of the memo, its title is taken) a safe file name nobody uses yet in the folder (the folder is created if missing)
//   delete <file> [path] -> deletes one memo file of the folder
//   po <file> [path]  -> the line to paste into the PO terminal: "메모 요청: <title> ..." + body + file path
//   gh-config                         -> {repo, branch, folder, defaultFolder}: the GitHub upload setting
//   gh-set <b64 json {repo, branch, folder}> -> saves it (empty repo clears it)
//   gh-prepare <file> <path>          -> {ready, isPublic, repo, branch, remote} or {ready: false, message}: gh login and public/private check, writes nothing
//   gh-upload <file> <path> <0|1>     -> uploads the memo through `gh api` (1 = the person confirmed a public repository) -> {repo, remote, url, created, unchanged}
//   (the login is the person's own `gh auth login`; no token is ever read, stored or passed here)
// Reading and writing a memo's text is done by the mod itself (readTextFile / writeTextFile: they refuse to overwrite a file that changed meanwhile).
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const github = require("./github.cjs");

const MAX_ITEMS = 500; // files listed (newest first); more are counted as truncated
const HEAD_BYTES = 8192; // read of each file for its title and preview
const MAX_NAME_CHARS = 80; // title part of a file name, in characters (the whole name stays far under the 255-byte limit of every file system)
const MAX_BODY_IN_PO = 1500; // body characters pasted to the PO; the file path always follows, so the PO can read the rest
const UNTITLED = "제목 없음";
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

const defaultDir = () => path.join(os.homedir(), "Documents", "Herdr Memos");
const configFile = (home) => path.join(home, "memo", "config.json");

// ---- the folder setting
function expandHome(p) {
  const s = String(p ?? "").trim();
  if (s === "~") return os.homedir();
  if (/^~[\\/]/.test(s)) return path.join(os.homedir(), s.slice(2));
  return s;
}
function readConfig(home) {
  try {
    const j = JSON.parse(fs.readFileSync(configFile(home), "utf8"));
    return j && typeof j === "object" && !Array.isArray(j) ? j : {};
  } catch { return {}; }
}
// The memo folder in use: the saved one when it is a usable absolute path, else the default.
function memoDir(home) {
  const saved = expandHome(readConfig(home).dir);
  return saved && path.isAbsolute(saved) ? path.normalize(saved) : defaultDir();
}
function configInfo(home) {
  const dir = memoDir(home);
  return { dir, defaultDir: defaultDir(), custom: dir !== defaultDir() };
}
// Saves the folder. "" goes back to the default. A relative path or a file is refused (the picker always gives an absolute folder).
function setDir(home, raw) {
  const s = expandHome(raw);
  const cfg = readConfig(home);
  if (!s) delete cfg.dir;
  else {
    if (!path.isAbsolute(s)) throw new Error("폴더는 절대 경로여야 합니다");
    const dir = path.normalize(s);
    let st = null;
    try { st = fs.statSync(dir); } catch {}
    if (st && !st.isDirectory()) throw new Error("파일이 있는 자리입니다. 폴더를 고르세요");
    if (!st) fs.mkdirSync(dir, { recursive: true });
    cfg.dir = dir;
  }
  writeConfig(home, cfg);
  return configInfo(home);
}
// Atomic write (tmp + rename) of the whole config; the caller passes the object it read so keys of other settings stay.
function writeConfig(home, cfg) {
  fs.mkdirSync(path.dirname(configFile(home)), { recursive: true });
  const tmp = `${configFile(home)}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + "\n");
  fs.renameSync(tmp, configFile(home));
}

// ---- the GitHub setting (#144): config.json "github": {repo: "owner/name", branch, folder}. The upload itself is github.cjs.
function ghConfig(home) {
  const g = readConfig(home).github;
  const o = g && typeof g === "object" && !Array.isArray(g) ? g : {};
  const str = (v) => (typeof v === "string" ? v : "");
  return { repo: str(o.repo), branch: str(o.branch), folder: str(o.folder), defaultFolder: github.DEFAULT_FOLDER };
}
// Saves the three fields after checking them. An empty repo clears the whole setting (the upload button then asks for one).
function setGhConfig(home, raw) {
  const cfg = readConfig(home);
  if (!String(raw?.repo ?? "").trim()) delete cfg.github;
  else {
    const n = github.normalizeSettings(raw);
    cfg.github = { repo: n.repoText, branch: n.branch, folder: String(raw.folder ?? "").trim() ? n.folder : "" };
  }
  writeConfig(home, cfg);
  return ghConfig(home);
}
// Everything the upload needs, validated: settings, the memo's real path, and the path it will have in the repository.
function ghTarget(home, dir, file, given) {
  const s = github.normalizeSettings(ghConfig(home));
  const p = pathChecked(dir, file, given);
  const st = fs.statSync(p);
  if (!st.isFile()) throw new Error("파일이 아닙니다");
  if (st.size > github.MAX_UPLOAD_BYTES) throw new Error("1 MiB보다 큰 메모는 올리지 않습니다");
  return { settings: s, path: p, remote: github.remotePath(s.folder, file) };
}
// Step 1 of "GitHub에 올리기": gh ready? repository public? Nothing is written anywhere.
function ghPrepare(home, dir, file, given, run) {
  if (!String(ghConfig(home).repo).trim()) throw new Error("먼저 설정에서 올릴 저장소(owner/이름)를 정하세요");
  const t = ghTarget(home, dir, file, given);
  const g = github.checkGh(run);
  if (!g.ready) return { ok: true, ready: false, reason: g.reason, message: g.message };
  const info = github.repoInfo(t.settings.owner, t.settings.repo, run);
  return { ok: true, ready: true, isPublic: info.isPublic, repo: t.settings.repoText, branch: t.settings.branch, remote: t.remote };
}
// Step 2: checks everything again (the screen may be minutes old), refuses a public repository that was not confirmed, then uploads.
function ghUpload(home, dir, file, given, confirmedPublic, run) {
  if (!String(ghConfig(home).repo).trim()) throw new Error("먼저 설정에서 올릴 저장소(owner/이름)를 정하세요");
  const t = ghTarget(home, dir, file, given);
  const g = github.checkGh(run);
  if (!g.ready) throw new Error(g.message);
  const info = github.repoInfo(t.settings.owner, t.settings.repo, run);
  if (info.isPublic && !confirmedPublic) throw new Error("공개 저장소입니다. 확인 없이는 올리지 않습니다");
  const bytes = fs.readFileSync(t.path);
  const r = github.upload(t.settings, { file, title: titleOf(bytes.toString("utf8")), content: bytes }, run);
  return { ok: true, repo: t.settings.repoText, remote: t.remote, isPublic: info.isPublic, ...r };
}

// ---- titles and file names
// The title of a memo: its first "# " heading (not inside a code fence), else its first non-empty line without markdown marks.
function titleOf(text) {
  const lines = String(text ?? "").replace(/^\uFEFF/, "").split(/\r?\n/);
  let fence = null, first = "";
  for (const raw of lines) {
    const line = raw.trim();
    const f = /^(```|~~~)/.exec(line);
    if (f) { fence = fence ? (fence === f[1] ? null : fence) : f[1]; continue; }
    if (fence || !line) continue;
    const h = /^#\s+(.*?)\s*#*\s*$/.exec(line);
    if (h && h[1]) return clip(h[1], 120);
    if (!first) first = line.replace(/^#{1,6}\s*/, "").replace(/^[-*+>]\s+/, "").replace(/^\[[ xX]\]\s*/, "");
  }
  return clip(first, 120) || UNTITLED;
}
function clip(s, n) {
  const a = Array.from(String(s ?? "").replace(/\s+/g, " ").trim());
  return a.length > n ? a.slice(0, n - 1).join("") + "…" : a.join("");
}
// A memo's second line in the list: the first lines of the body after the title line, flattened.
function previewOf(text, title) {
  const lines = String(text ?? "").replace(/^\uFEFF/, "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const rest = lines.filter((l) => l.replace(/^#{1,6}\s*/, "") !== title);
  return clip(rest.join(" "), 100);
}
// The part of a file name made from a title: no character that is illegal on Windows or macOS (<>:"/\|?* and control characters), no trailing dots or spaces,
// no reserved device name (CON, NUL, COM1 ...), at most MAX_NAME_CHARS characters, never empty.
function safeName(title) {
  let s = String(title ?? "").normalize("NFC").replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  s = Array.from(s).slice(0, MAX_NAME_CHARS).join("").replace(/[. ]+$/, "").replace(/^[. ]+/, "");
  if (!s || WINDOWS_RESERVED.test(s.split(".")[0])) s = s ? `_${s}` : UNTITLED;
  return s;
}
const two = (n) => String(n).padStart(2, "0");
// "2026-11-27 1530 <title>.md": the date keeps the folder in order and keeps two memos with one title apart.
function fileNameFor(title, now = new Date()) {
  return `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())} ${two(now.getHours())}${two(now.getMinutes())} ${safeName(title)}.md`;
}
// A name that is not taken in `dir` (case-insensitively: macOS and Windows file systems ignore case): " (2)", " (3)" ... before ".md". A memo file is never overwritten.
function uniqueName(dir, wanted) {
  let taken = new Set();
  try { taken = new Set(fs.readdirSync(dir).map((f) => f.toLowerCase())); } catch {}
  if (!taken.has(wanted.toLowerCase())) return wanted;
  const stem = wanted.replace(/\.md$/i, "");
  for (let i = 2; i < 10000; i++) {
    const n = `${stem} (${i}).md`;
    if (!taken.has(n.toLowerCase())) return n;
  }
  throw new Error("같은 이름의 메모가 너무 많습니다");
}
// Only a plain file name of the memo folder is accepted: no separators, no "..", a .md name, not hidden.
function isMemoFile(file) {
  const f = String(file ?? "");
  return f.length > 3 && f.length <= 255 && !/[\\/\u0000]/.test(f) && f !== ".." && !f.startsWith(".") && /\.md$/i.test(f);
}
function pathOf(dir, file) {
  if (!isMemoFile(file)) throw new Error("메모 파일 이름이 올바르지 않습니다");
  return path.join(dir, file);
}

// The screen passes the full path it opened as well: when the memo folder was changed meanwhile (another window, config.json), a bare file name would point at
// the same name in the NEW folder, so a delete or a send is refused unless the path still lies in the folder now in use.
function pathChecked(dir, file, given) {
  const p = pathOf(dir, file);
  if (typeof given !== "string" || given === "") throw new Error("메모 경로가 없습니다. 목록을 새로 읽고 다시 하세요");
  if (path.normalize(given) !== path.normalize(p) || path.dirname(path.resolve(p)) !== path.resolve(dir)) throw new Error("메모 폴더가 바뀌었습니다. 목록을 새로 읽고 다시 하세요");
  return p;
}

// ---- the list
function listMemos(dir) {
  let names;
  try { names = fs.readdirSync(dir); } catch (e) {
    if (e && e.code === "ENOENT") return { exists: false, items: [], truncated: false };
    throw e;
  }
  const found = [];
  for (const file of names) {
    if (!isMemoFile(file)) continue;
    let st;
    try { st = fs.statSync(path.join(dir, file)); } catch { continue; }
    if (st.isFile()) found.push({ file, path: path.join(dir, file), mtime: st.mtimeMs, size: st.size });
  }
  found.sort((a, b) => b.mtime - a.mtime || a.file.localeCompare(b.file));
  const items = found.slice(0, MAX_ITEMS).map((x) => {
    let head = "";
    try {
      const fd = fs.openSync(path.join(dir, x.file), "r");
      try { const buf = Buffer.alloc(Math.min(HEAD_BYTES, x.size)); const n = fs.readSync(fd, buf, 0, buf.length, 0); head = buf.subarray(0, n).toString("utf8"); } finally { fs.closeSync(fd); }
    } catch {}
    const title = titleOf(head);
    return { ...x, title, preview: previewOf(head, title) };
  });
  return { exists: true, items, truncated: found.length > MAX_ITEMS };
}

// ---- the line for the PO
// One line (a PO terminal takes one submitted message; line breaks fold to " ⏎ "): "메모 요청: <title> — <body> (파일: <path>)". The body is cut at MAX_BODY_IN_PO characters; the path is always there.
function poMessage(title, body, filePath) {
  const flat = String(body ?? "").replace(/^\uFEFF/, "").replace(/\r?\n+/g, " ⏎ ").replace(/[\u0000-\u0008\u000b-\u001f\u007f\u202A-\u202E\u2066-\u2069]/g, " ").replace(/\s+/g, " ").trim();
  const chars = Array.from(flat);
  const cut = chars.length > MAX_BODY_IN_PO;
  const text = chars.slice(0, MAX_BODY_IN_PO).join("") + (cut ? " …(이하 생략, 파일 참고)" : "");
  const head = `메모 요청: ${clip(title, 120)}`;
  return `${head}${text ? ` — ${text}` : ""} (파일: ${filePath})`;
}

// ---- command line
function out(o) { process.stdout.write(JSON.stringify(o) + "\n"); }
const unb64 = (s) => Buffer.from(String(s ?? ""), "base64").toString("utf8");

function main(argv) {
  const [home, cmd, ...a] = argv;
  try {
    if (!home || !cmd) throw new Error("usage: memo.cjs <app home> <config|setdir|list|name|delete|po|gh-config|gh-set|gh-prepare|gh-upload> ...");
    if (cmd === "config") return out({ ok: true, ...configInfo(home) });
    if (cmd === "gh-config") return out({ ok: true, ...ghConfig(home) });
    if (cmd === "gh-set") {
      let raw = null;
      try { raw = JSON.parse(unb64(a[0])); } catch {}
      if (!raw || typeof raw !== "object") throw new Error("설정 값이 올바르지 않습니다");
      return out({ ok: true, ...setGhConfig(home, raw) });
    }
    if (cmd === "setdir") return out({ ok: true, ...setDir(home, unb64(a[0])) });
    const dir = memoDir(home);
    if (cmd === "list") return out({ ok: true, dir, ...listMemos(dir) });
    if (cmd === "name") {
      fs.mkdirSync(dir, { recursive: true });
      const file = uniqueName(dir, fileNameFor(titleOf(unb64(a[0]))));
      return out({ ok: true, dir, file, path: path.join(dir, file) });
    }
    if (cmd === "delete") {
      const p = pathChecked(dir, a[0], a[1]);
      if (!fs.statSync(p).isFile()) throw new Error("파일이 아닙니다");
      fs.unlinkSync(p);
      return out({ ok: true });
    }
    if (cmd === "po") {
      const p = pathChecked(dir, a[0], a[1]);
      const text = fs.readFileSync(p, "utf8");
      return out({ ok: true, title: titleOf(text), path: p, text: poMessage(titleOf(text), text, p) });
    }
    if (cmd === "gh-prepare") return out(ghPrepare(home, dir, a[0], a[1]));
    if (cmd === "gh-upload") return out(ghUpload(home, dir, a[0], a[1], a[2] === "1"));
    throw new Error(`unknown command: ${cmd}`);
  } catch (e) {
    out({ ok: false, error: e && e.code === "ENOENT" ? "파일이나 폴더를 찾지 못했습니다" : String((e && e.message) || e).slice(0, 200) });
  }
}

if (require.main === module) main(process.argv.slice(2));
module.exports = { defaultDir, memoDir, configInfo, setDir, ghConfig, setGhConfig, ghPrepare, ghUpload, titleOf, previewOf, safeName, fileNameFor, uniqueName, isMemoFile, pathOf, pathChecked, listMemos, poMessage, UNTITLED, MAX_BODY_IN_PO };
