// Cmd-click (Ctrl-click on Windows/Linux) on a file path in a terminal: opens the path menu popup at the pointer.
// URLs are not matched (mod.json only has a file rule), so they keep Herdr's usual opener.

import { exec, notify, openOverlay, window } from "herdr";

// "dir", "file" or "missing" for a local path.
async function kindOf(path) {
  if (window()?.platform === "windows") {
    const q = `'${path.replace(/'/g, "''")}'`;
    const r = await exec("powershell.exe", ["-NoProfile", "-Command", `if(Test-Path -LiteralPath ${q} -PathType Container){'dir'}elseif(Test-Path -LiteralPath ${q}){'file'}else{'missing'}`]);
    return r.stdout.trim() || "missing";
  }
  const r = await exec("sh", ["-c", 'if [ -d "$1" ]; then echo dir; elif [ -e "$1" ]; then echo file; else echo missing; fi', "sh", path]);
  return r.stdout.trim() || "missing";
}

export async function handleLink({ link, source }) {
  if (link.kind !== "file") return "pass";
  // Remote or unresolved paths can't be opened here: offer copying the text as shown.
  const local = Boolean(link.path) && !source.machine;
  let kind = "remote";
  if (local) {
    try { kind = await kindOf(link.path); } catch { kind = "missing"; }
    if (kind === "missing") notify({ title: "경로를 찾을 수 없음", body: link.path, level: "warning" });
  }
  openOverlay({
    mod: "path-menu",
    kind: "popup",
    at: "pointer",
    width: 260,
    height: kind === "file" ? 128 : kind === "dir" ? 100 : 72,
    props: { path: link.path ?? link.raw, kind },
  });
  return "handled";
}
