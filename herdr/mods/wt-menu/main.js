// Popup for one worktree (opened from the work and prs panels): open it in an installed IDE, switch
// to its Herdr space, show it in Finder/Explorer, copy its path, and open/create its PR or view its branch on GitHub.
// Only opens things; nothing is written to GitHub (the "create PR" item opens GitHub's compare page).

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { run, spaces, theme, exec, window, props, closeOverlay, checking } from "herdr";

// macOS: the .app name in /Applications or ~/Applications. Windows: the launcher on PATH.
const MAC_IDES = [["Visual Studio Code", "VS Code"], ["Cursor", "Cursor"], ["Rider", "Rider"], ["IntelliJ IDEA", "IntelliJ IDEA"], ["IntelliJ IDEA CE", "IntelliJ IDEA CE"], ["WebStorm", "WebStorm"], ["PyCharm", "PyCharm"], ["Android Studio", "Android Studio"], ["Xcode", "Xcode"], ["Zed", "Zed"], ["Sublime Text", "Sublime Text"]];
const WIN_IDES = [["code", "VS Code"], ["cursor", "Cursor"], ["rider64", "Rider"], ["idea64", "IntelliJ IDEA"], ["webstorm64", "WebStorm"], ["pycharm64", "PyCharm"], ["studio64", "Android Studio"], ["zed", "Zed"], ["subl", "Sublime Text"]];
const ps = (s) => `'${String(s).replace(/'/g, "''")}'`;
const platform = () => window()?.platform;

function openUrl(url) {
  const p = platform();
  if (p === "macos") exec("open", [url]);
  else if (p === "windows") exec("powershell.exe", ["-NoProfile", "-Command", `Start-Process ${ps(url)}`]);
  else exec("xdg-open", [url]);
}

async function installedIdes() {
  if (platform() === "macos") {
    const r = await exec("sh", ["-c", 'ls /Applications "$HOME/Applications" 2>/dev/null']);
    const have = new Set(r.stdout.split("\n").filter((x) => x.endsWith(".app")).map((x) => x.slice(0, -4)));
    return MAC_IDES.filter(([app]) => have.has(app)).map(([app, label]) => ({ label, open: (path) => exec("open", ["-a", app, path]) }));
  }
  if (platform() === "windows") {
    const names = WIN_IDES.map(([n]) => ps(n)).join(",");
    const r = await exec("powershell.exe", ["-NoProfile", "-Command", `foreach($x in ${names}){$c=Get-Command $x -ErrorAction SilentlyContinue; if($c){"$x|$($c.Source)"}}`]);
    const found = new Map(r.stdout.split(/\r?\n/).filter(Boolean).map((l) => l.trim().split("|")));
    return WIN_IDES.filter(([n]) => found.has(n)).map(([n, label]) => {
      const exe = found.get(n);
      // Only a .cmd launcher needs its console window hidden.
      const hidden = /\.cmd$/i.test(exe) ? " -WindowStyle Hidden" : "";
      return { label, open: (path) => exec("powershell.exe", ["-NoProfile", "-Command", `Start-Process -FilePath ${ps(exe)} -ArgumentList ${ps(`"${path}"`)}${hidden}`]) };
    });
  }
  return [];
}

export default class WtMenu extends View {
  init(_props, cx) {
    this.ides = null;
    if (checking()) return;
    cx.spawn(async (cx) => {
      try { this.ides = await installedIdes(); } catch { this.ides = []; }
      cx.notify();
    });
  }

  render() {
    const t = theme();
    const { path, branch, slug, pr, overlay } = props() ?? {};
    const done = (fn) => () => { fn(); closeOverlay(overlay); };
    const item = (id, label, fn, hint) => h_flex().id(id).h(28).px(8).gap(8).rounded(6).items_center().text_color(t.foreground)
      .hover((s) => s.bg(t.hover)).on_click(done(fn))
      .child(div().flex_1().min_w(0).truncate().child(label))
      .when(Boolean(hint), (el) => el.child(div().flex_none().text_size(10.5).text_color(t.dim).child(hint)));
    const head = (text) => div().px(8).pt(6).pb(3).text_size(10.5).text_color(t.dim).child(text);
    const space = (spaces() ?? []).find((s) => !s.machine && s.folder && (s.folder === path || path?.startsWith(s.folder + "/")));
    const mac = platform() === "macos";
    const reveal = () => (mac ? exec("open", [path]) : platform() === "windows" ? exec("powershell.exe", ["-NoProfile", "-Command", `Start-Process explorer.exe -ArgumentList ${ps(`"${path}"`)}`]) : exec("xdg-open", [path]));
    // Copies the worktree path (handy for cleaning up a finished worktree by hand; nothing is deleted from here).
    const copyPath = () => (mac ? exec("sh", ["-c", 'printf %s "$1" | pbcopy', "sh", path]) : platform() === "windows" ? exec("powershell.exe", ["-NoProfile", "-Command", `Set-Clipboard -Value ${ps(path)}`]) : exec("sh", ["-c", 'printf %s "$1" | { xclip -selection clipboard 2>/dev/null || wl-copy; }', "sh", path]));
    return v_flex().size_full().p(5).bg(t.popover).text_size(12.5)
      .child(div().px(8).pt(4).pb(2).text_size(11.5).font_medium().truncate().text_color(t.muted).child(String(branch ?? path ?? "")))
      .child(head("IDE로 열기"))
      .when(this.ides === null, (el) => el.child(div().px(8).h(24).text_color(t.dim).child("찾는 중…")))
      .when(this.ides?.length === 0, (el) => el.child(div().px(8).h(24).text_color(t.dim).child("설치된 IDE 없음")))
      .children((this.ides ?? []).map((ide) => item(`ide-${ide.label}`, ide.label, () => ide.open(path))))
      .child(head("이동"))
      .child(space
        ? item("space", "Herdr Space로 이동", () => run("space.select", { id: space.id }), space.name)
        : item("space", "Herdr에서 새 Space로 열기", () => run("space.new", { folder: path, focus: true })))
      .child(item("reveal", mac ? "Finder에서 보기" : "탐색기에서 보기", reveal))
      .child(item("copy-path", "경로 복사", copyPath))
      .when(Boolean(slug), (el) => el.child(head("GitHub"))
        .when(Boolean(pr), (e) => e.child(item("pr", "PR 열기", () => openUrl(pr.url), `#${pr.number}`)))
        .when(!pr && Boolean(branch), (e) => e.child(item("pr-new", "PR 만들기", () => openUrl(`https://github.com/${slug}/compare/${encodeURIComponent(branch)}?expand=1`))))
        .when(Boolean(branch), (e) => e.child(item("branch", "브랜치 보기", () => openUrl(`https://github.com/${slug}/tree/${branch.split("/").map(encodeURIComponent).join("/")}`)))));
  }
}
