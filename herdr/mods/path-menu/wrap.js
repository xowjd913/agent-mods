// Rejoin a path that the program in the terminal split with its own line breaks.
// Claude Code (and other full-screen apps) wrap text themselves: a long path is cut and continues on the
// next row after an indent. Herdr then sees two separate links, one per row, and the click only tells us
// the clicked piece (link.raw), not its row. So we look the piece up in the screen text and glue on the
// neighbouring rows' tokens. Where the cut happens can't be told from the row width: a side panel or a box
// border may follow the text, and rows are padded with spaces. So any piece that ends (or starts) its row's
// text is a candidate, and the caller keeps a joined path only if it exists.
// Pure functions: no Herdr imports, so tests can load this file directly.

// Cells a string takes on screen: wide (CJK, Hangul, fullwidth, emoji) characters take 2.
export function cellWidth(s) {
  let w = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (c < 0x20 || (c >= 0x300 && c <= 0x36f) || c === 0x200b) continue;
    w += (c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0xa4cf && c !== 0x303f) ||
      (c >= 0xac00 && c <= 0xd7a3) || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xfe30 && c <= 0xfe4f) ||
      (c >= 0xff00 && c <= 0xff60) || (c >= 0xffe0 && c <= 0xffe6) || (c >= 0x1f300 && c <= 0x1f64f) ||
      (c >= 0x1f900 && c <= 0x1f9ff) || (c >= 0x20000 && c <= 0x3fffd) ? 2 : 1;
  }
  return w;
}

// Rows to follow in each direction; a path longer than this many rows is unlikely and costs more checks.
export const MAX_ROWS = 4;

// Box-drawing borders split a row into areas: the text, a box around it, a side panel after it.
const BORDER = /[│┃║]/;
// What may sit around a row's text inside its area: indent, padding, a "|" border, a tool row's "⎿".
const LEAD = /^[\s|⎿]*/;
const TRAIL = /[\s|]*$/;

// A row's areas: { col, from, text }, col = screen column of the area's left border (0 for the first),
// from = string index where its text starts. The text leaves the borders out.
function areas(line) {
  const out = [];
  let col = 0, i = 0, from = 0, start = 0;
  for (const ch of line) {
    if (BORDER.test(ch)) {
      out.push({ col: start, from, text: line.slice(from, i) });
      from = i + ch.length;
      start = col;
    }
    col += cellWidth(ch);
    i += ch.length;
  }
  out.push({ col: start, from, text: line.slice(from) });
  return out;
}

// A neighbour row's text in the area at the same column as the clicked piece's area, without its indent and padding.
function textAt(line, col) {
  let pick = "";
  for (const a of areas(line)) if (a.col <= col) pick = a.text;
  return pick.replace(LEAD, "").replace(TRAIL, "");
}

// Ways to extend `raw` at each place it appears on screen, one list per place (top to bottom):
// [[{ before, after }, ...], ...], each a string to put in front of / behind raw. Both empty (raw alone)
// is left out, so a place where raw sits inside its row's text gets []. Each list: shortest join first.
// Places stay apart: the click doesn't say which one was clicked, so the caller must not mix them.
export function joinCandidates(lines, raw, { maxRows = MAX_ROWS } = {}) {
  const places = [];
  if (!raw) return places;
  for (let i = 0; i < lines.length; i++) {
    for (let idx = lines[i].indexOf(raw); idx !== -1; idx = lines[i].indexOf(raw, idx + 1)) {
      let area = areas(lines[i])[0];
      for (const a of areas(lines[i])) if (a.from <= idx) area = a;
      const end = area.from + area.text.length;
      const afters = [""];
      // raw ends its row's text: take the next row's first token, and keep going while that token is
      // the whole text of its row.
      if (TRAIL.exec(lines[i].slice(idx + raw.length, end))[0].length === end - idx - raw.length) {
        let acc = "";
        for (let j = i; j + 1 < lines.length && afters.length <= maxRows; j++) {
          const m = textAt(lines[j + 1], area.col).match(/^(\S+)(.*)$/);
          if (!m) break;
          acc += m[1];
          afters.push(acc);
          if (m[2].trim() !== "") break;
        }
      }
      const befores = [""];
      // raw starts its row's text: take the previous row's last token, the same way upward.
      if (LEAD.exec(lines[i].slice(area.from, idx))[0].length === idx - area.from) {
        let acc = "";
        for (let j = i; j > 0 && befores.length <= maxRows; j--) {
          const m = textAt(lines[j - 1], area.col).match(/^(.*?)(\S+)$/);
          if (!m) break;
          acc = m[2] + acc;
          befores.push(acc);
          if (m[1].trim() !== "") break;
        }
      }
      const joins = [];
      for (const before of befores) {
        for (const after of afters) if (before || after) joins.push({ before, after });
      }
      places.push(joins.sort((a, b) => a.before.length + a.after.length - (b.before.length + b.after.length)));
    }
  }
  return places;
}

// Tidy the outer ends of a joined path: quotes and brackets around it, sentence punctuation and a
// :line:col after it. Only the ends that came from other rows are touched.
export function trimJoined(text, { start, end }) {
  let s = text;
  if (start) s = s.replace(/^[("'`[{<]+/, "");
  if (end) s = s.replace(/[)"'`\]}>.,;!?]+$/, "").replace(/(:\d+){1,2}$/, "").replace(/[.,;:]+$/, "");
  return s;
}

// The same path without Korean particles glued to its end ("os.js로", "폴더에서"); null when there are none.
export function withoutParticle(text) {
  const s = text.replace(/[가-힣]+$/, "");
  return s && s !== text ? s : null;
}

// At most this many guesses go to the existence check (one command for all of them), per place and in all.
export const MAX_GUESSES = 16;

// Absolute paths the clicked piece may belong to, one list per place on screen, each longest first.
// `cwd` resolves relative text; `home` expands "~/"; `windows` switches to drive letters and "\\".
// `up: false` leaves out joins with an earlier row (the clicked piece is then never a lower piece).
export function joinedPaths(lines, raw, { cwd, home, windows = false, maxRows, up = true } = {}) {
  const abs = (t) => {
    if (windows) {
      if (/^[A-Za-z]:[\\/]/.test(t) || t.startsWith("\\\\")) return t;
    } else if (t.startsWith("/")) return t;
    if (home && (t.startsWith("~/") || (windows && t.startsWith("~\\")))) return home.replace(/[\\/]+$/, "") + t.slice(1);
    if (!cwd || t.startsWith("~")) return null;
    return cwd.replace(/[\\/]+$/, "") + (windows ? "\\" : "/") + t.replace(/^\.[\\/]/, "");
  };
  return joinCandidates(lines, raw, { maxRows }).map((joins) => {
    const out = new Set();
    for (const { before, after } of joins) {
      if (before && !up) continue;
      const text = trimJoined(before + raw + after, { start: before !== "", end: true });
      for (const t of [text, after ? withoutParticle(text) : null]) {
        const p = t && abs(t);
        if (p) out.add(p);
      }
    }
    return [...out].sort((a, b) => b.length - a.length).slice(0, MAX_GUESSES);
  });
}

// The joined path to open, given each place's guesses and what the check found (path -> kind):
// each place takes its longest existing guess. Only when every place has one and they all agree is the
// answer sure; a place with none means raw also stands alone there, so the click may have meant raw itself.
// null then, and the caller keeps link.path.
export function pickJoined(places, kinds) {
  let pick = null;
  for (const guesses of places) {
    const found = guesses.find((p) => (kinds.get(p) ?? "missing") !== "missing");
    if (!found || (pick && pick !== found)) return null;
    pick = found;
  }
  return pick && { path: pick, kind: kinds.get(pick) };
}

// Folders above `path` that may stand in for it, nearest first. Stops before a disk root ("/", "C:\\", a
// "\\\\server\\share" share) and before `home` or any folder above it: opening those is too far from what was
// clicked (a web path like "/api/v1/users" would open the whole disk), so the caller then offers copying only.
// Used when neither the clicked piece nor a joined path exists: the menu then opens the nearest one that does.
export function ancestors(path, { windows = false, home } = {}) {
  const out = [];
  if (!path) return out;
  const sep = windows ? /[\\/]/ : /\//;
  const key = (q) => (windows ? q.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase() : q.replace(/\/+$/, ""));
  const h = home ? key(home) : null;
  const tooFar = (q) => {
    if (!windows ? q === "/" : /^[A-Za-z]:$/.test(q) || /^\\\\[^\\/]*([\\/][^\\/]*)?$/.test(q)) return true;
    const k = key(q);
    return h !== null && (h === k || h.startsWith(k + (windows ? "\\" : "/")));
  };
  let p = path;
  while (out.length < 64) {
    let k = p.length - 1;
    while (k >= 0 && !sep.test(p[k])) k--;
    if (k < 0) break;
    const parent = p.slice(0, k).replace(windows ? /[\\/]+$/ : /\/+$/, "") || (windows ? "" : "/");
    if (!parent || tooFar(parent)) break;
    out.push(parent);
    p = parent;
  }
  return out;
}
