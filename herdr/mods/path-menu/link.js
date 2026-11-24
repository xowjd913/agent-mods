// Cmd-click (Ctrl-click on Windows/Linux) on a file path in a terminal: opens the path menu popup at the pointer.
// URLs are not matched (mod.json only has a file rule), so they keep Herdr's usual opener.

import { notify, openOverlay } from "herdr";
import { kindOf } from "./os.js";

export async function handleLink({ link, source }) {
  if (link.kind !== "file") return "pass";
  // Remote or unresolved paths can't be opened here: offer copying the text as shown.
  const local = Boolean(link.path) && !source.machine;
  let kind = "remote";
  if (local) {
    // A failed check already showed an error toast; still offer copying.
    const found = await kindOf(link.path);
    kind = found ?? "missing";
    if (found === "missing") notify({ title: "경로를 찾을 수 없음", body: link.path, level: "warning" });
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
