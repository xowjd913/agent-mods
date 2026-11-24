// Popup opened by link.js for a clicked terminal path: open its folder, open the file, or copy the path.
// Missing, remote or unresolved paths only offer copying.

import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { theme, exec, window, props, closeOverlay } from "herdr";

const ps = (s) => `'${String(s).replace(/'/g, "''")}'`;
const platform = () => window()?.platform;

// A folder opens itself; a file opens its folder with the file selected.
export function openFolder(path, isDir) {
  const p = platform();
  if (p === "macos") return exec("open", isDir ? [path] : ["-R", path]);
  if (p === "windows") return exec("powershell.exe", ["-NoProfile", "-Command", `Start-Process explorer.exe -ArgumentList ${ps(isDir ? `"${path}"` : `/select,"${path}"`)}`]);
  return exec("sh", ["-c", 'xdg-open "$1"', "sh", isDir ? path : path.replace(/\/[^/]*$/, "") || "/"]);
}

export function openFile(path) {
  const p = platform();
  if (p === "macos") return exec("open", [path]);
  if (p === "windows") return exec("powershell.exe", ["-NoProfile", "-Command", `Invoke-Item -LiteralPath ${ps(path)}`]);
  return exec("xdg-open", [path]);
}

export function copyText(text) {
  const p = platform();
  if (p === "macos") return exec("sh", ["-c", 'printf %s "$1" | pbcopy', "sh", text]);
  if (p === "windows") return exec("powershell.exe", ["-NoProfile", "-Command", `Set-Clipboard -Value ${ps(text)}`]);
  return exec("sh", ["-c", 'printf %s "$1" | { xclip -selection clipboard 2>/dev/null || wl-copy; }', "sh", text]);
}

export default class PathMenu extends View {
  render() {
    const t = theme();
    const { path = "", kind, overlay } = props() ?? {};
    const done = (fn) => () => { fn(); closeOverlay(overlay); };
    const item = (id, label, fn) => h_flex().id(id).h(28).px(8).gap(8).rounded(6).items_center().text_color(t.foreground)
      .hover((s) => s.bg(t.hover)).on_click(done(fn))
      .child(div().flex_1().min_w(0).truncate().child(label));
    const openable = kind === "dir" || kind === "file";
    return v_flex().size_full().p(5).bg(t.popover).text_size(12.5)
      .child(div().px(8).pt(4).pb(2).text_size(11.5).font_medium().truncate().text_color(t.muted).child(String(path)))
      .when(openable, (el) => el
        .child(item("folder", "폴더 열기", () => openFolder(path, kind === "dir")))
        .when(kind === "file", (e) => e.child(item("file", "파일 열기", () => openFile(path)))))
      .child(item("copy", "경로 복사", () => copyText(path)));
  }
}
