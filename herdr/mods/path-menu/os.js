// OS commands shared by link.js and main.js: check a path, open its folder or file, copy it.
// macOS and Linux pass the path as its own argv entry, so no quoting is involved.
// Windows needs a PowerShell script, and exec has no env or stdin option to hand the path over.
// The path therefore never appears in the script as text: psText() rebuilds it from UTF-16
// char codes (digits and commas only). Escaping quotes would miss PowerShell's other quote
// characters (U+2018..U+201E) and turn file names into commands.

import { exec, notify, window } from "herdr";

export const platform = () => window()?.platform;

// PowerShell expression that evaluates to `s`, built only from digits.
export function psText(s) {
  const codes = Array.from({ length: s.length }, (_, i) => s.charCodeAt(i));
  return `(-join [char[]]@(${codes.join(",")}))`;
}

// Script with $p bound to `path`. Other quotes in the scripts below use [char]34, not text.
const ps = (path, body) => ["-NoProfile", "-NonInteractive", "-Command", `$p = ${psText(String(path))}; ${body}`];

// Runs a command; a start failure or a non-zero exit shows an error toast. Returns stdout, or null on failure.
export async function run(title, command, args) {
  let r;
  try {
    r = await exec(command, args);
  } catch (e) {
    notify({ title, body: `${command}을(를) 실행하지 못했습니다: ${e?.message ?? e}`, level: "error" });
    return null;
  }
  if (r.code !== 0) {
    const why = (r.stderr || r.stdout || "").trim().split("\n")[0];
    notify({ title, body: why || `${command} 종료 코드 ${r.code}`, level: "error" });
    return null;
  }
  return r.stdout;
}

// "dir", "file" or "missing" for a local path; null when the check itself failed.
export async function kindOf(path) {
  const out = platform() === "windows"
    ? await run("경로 확인 실패", "powershell.exe", ps(path, "if (Test-Path -LiteralPath $p -PathType Container) {'dir'} elseif (Test-Path -LiteralPath $p) {'file'} else {'missing'}"))
    : await run("경로 확인 실패", "sh", ["-c", 'if [ -d "$1" ]; then echo dir; elif [ -e "$1" ]; then echo file; else echo missing; fi', "sh", path]);
  if (out === null) return null;
  const kind = out.trim();
  return kind === "dir" || kind === "file" ? kind : "missing";
}

// Kinds of several local paths in one quiet command (no toasts): used to test the joined guesses
// for a split path, where most guesses are expected not to exist. null when the check failed.
export async function kindsOf(paths, { timeout = 5000 } = {}) {
  if (!paths.length) return [];
  let r;
  try {
    r = platform() === "windows"
      ? await exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
        `$ErrorActionPreference = 'Stop'; foreach ($p in @(${paths.map((x) => psText(String(x))).join(",")})) { try { if (Test-Path -LiteralPath $p -PathType Container) {'dir'} elseif (Test-Path -LiteralPath $p) {'file'} else {'missing'} } catch {'missing'} }`], { timeout })
      : await exec("sh", ["-c", 'for p in "$@"; do if [ -d "$p" ]; then echo dir; elif [ -e "$p" ]; then echo file; else echo missing; fi; done', "sh", ...paths], { timeout });
  } catch {
    return null;
  }
  if (r.code !== 0) return null;
  const kinds = r.stdout.split(/\r?\n/).map((k) => k.trim()).filter(Boolean);
  return kinds.length === paths.length ? kinds.map((k) => (k === "dir" || k === "file" ? k : "missing")) : null;
}

// A folder opens itself; a file opens its folder with the file selected (Linux: just the parent folder).
export function openFolder(path, isDir) {
  const p = platform();
  if (p === "macos") return run("폴더 열기 실패", "open", isDir ? [path] : ["-R", path]);
  if (p === "windows") {
    const arg = isDir ? "[char]34 + $p + [char]34" : "'/select,' + [char]34 + $p + [char]34";
    return run("폴더 열기 실패", "powershell.exe", ps(path, `Start-Process explorer.exe -ArgumentList (${arg})`));
  }
  return run("폴더 열기 실패", "xdg-open", [isDir ? path : path.replace(/\/[^/]*$/, "") || "/"]);
}

export function openFile(path) {
  const p = platform();
  if (p === "macos") return run("파일 열기 실패", "open", [path]);
  if (p === "windows") return run("파일 열기 실패", "powershell.exe", ps(path, "Invoke-Item -LiteralPath $p"));
  return run("파일 열기 실패", "xdg-open", [path]);
}

export function copyText(text) {
  const p = platform();
  if (p === "macos") return run("경로 복사 실패", "sh", ["-c", 'printf %s "$1" | pbcopy', "sh", text]);
  if (p === "windows") return run("경로 복사 실패", "powershell.exe", ps(text, "Set-Clipboard -Value $p"));
  return run("경로 복사 실패", "sh", ["-c", 'printf %s "$1" | { xclip -selection clipboard 2>/dev/null || wl-copy; }', "sh", text]);
}
