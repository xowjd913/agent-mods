// Cmd-click (Ctrl-click on Windows/Linux) on a file path in a terminal: opens the path menu popup at the pointer.
// URLs are not matched (mod.json only has a file rule), so they keep Herdr's usual opener.

import { hc, home, notify, openOverlay } from "herdr";
import { kindOf, kindsOf, platform } from "./os.js";
import { MAX_GUESSES, ancestors, joinedPaths, pickJoined } from "./wrap.js";

// A path the terminal program broke over several rows arrives as just the clicked piece.
// Read the screen and return the longest joined path that exists, or null (then link.path is used).
// The piece may appear in several places; the joined path is used only when every place agrees on it.
// Any failure here (no hc, odd output, slow check) just means "no joined path": the click keeps working.
async function joinedPath(link, source) {
  try {
    const screen = await hc(["read", source.terminal, "--json"]);
    if (screen.code !== 0) return null;
    const text = JSON.parse(screen.stdout)?.text;
    if (typeof text !== "string") return null;
    // One list of guesses per place the piece appears; link.path itself is the "not joined" answer.
    const places = joinedPaths(text.split("\n"), link.raw, {
      cwd: source.cwd,
      home: home(),
      windows: platform() === "windows",
    }).map((guesses) => guesses.filter((p) => p !== link.path));
    // A place where the piece sits inside its row's text means it may stand alone: keep link.path, check nothing.
    if (!places.length || places.some((g) => !g.length)) return null;
    const all = [...new Set(places.flat())];
    if (all.length > MAX_GUESSES) return null;
    const kinds = await kindsOf(all);
    return kinds ? pickJoined(places, new Map(all.map((p, i) => [p, kinds[i]]))) : null;
  } catch {
    return null;
  }
}

// The nearest existing folder above a missing path, or null.
async function nearestFolder(path) {
  const ups = ancestors(path, { windows: platform() === "windows" });
  const kinds = ups.length ? await kindsOf(ups) : null;
  return kinds ? ups.find((_, i) => kinds[i] === "dir") ?? null : null;
}

export async function handleLink({ link, source }) {
  if (link.kind !== "file") return "pass";
  // Remote or unresolved paths can't be opened here: offer copying the text as shown.
  const local = !source.machine;
  let path = link.path;
  let kind = "remote";
  const joined = local && link.raw ? await joinedPath(link, source) : null;
  if (joined) {
    ({ path, kind } = joined);
  } else if (local && link.path) {
    // A failed check already showed an error toast; still offer copying.
    const found = await kindOf(link.path);
    kind = found ?? "missing";
    if (found === "missing") {
      // Still offer 폴더 열기 for the nearest folder that exists; the header shows that folder.
      const folder = await nearestFolder(link.path);
      notify({ title: "경로를 찾을 수 없음", body: folder ? `${link.path}\n가까운 폴더: ${folder}` : link.path, level: "warning" });
      if (folder) [path, kind] = [folder, "dir"];
    }
  }
  openOverlay({
    mod: "path-menu",
    kind: "popup",
    at: "pointer",
    width: 260,
    height: kind === "file" ? 128 : kind === "dir" ? 100 : 72,
    props: { path: path ?? link.raw, kind },
  });
  return "handled";
}
