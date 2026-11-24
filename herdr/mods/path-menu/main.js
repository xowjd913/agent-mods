// Popup opened by link.js for a clicked terminal path: open its folder, open the file, or copy the path.
// Missing, remote or unresolved paths only offer copying.

import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { theme, props, closeOverlay } from "herdr";
import { openFolder, openFile, copyText } from "./os.js";

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
