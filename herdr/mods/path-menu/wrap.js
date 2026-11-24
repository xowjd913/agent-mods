// Rejoin a path that the program in the terminal split with its own line breaks.
// Claude Code (and other full-screen apps) wrap text themselves: a long path is cut at the right edge and
// continues on the next row after an indent. Herdr then sees two separate links, one per row, and the
// click only tells us the clicked piece (link.raw), not its row. So we look the piece up in the screen text
// and glue on the neighbouring rows' tokens, as long as the cut row reaches the right edge.
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

// A row "reaches the edge" when its text ends within EDGE_MARGIN cells of the terminal width.
// Measured on a Claude Code screen: text rows end at most at cols - 2 (it keeps a 2-cell right gutter),
// and a wide character that doesn't fit the last cell moves to the next row, leaving one more cell empty.
// A cut row that stops earlier was broken at a space on purpose, so it isn't a split path.
export const EDGE_MARGIN = 3;
// Rows to follow in each direction; a path longer than this many rows is unlikely and costs more checks.
export const MAX_ROWS = 4;

const reaches = (line, cols, margin) => cellWidth(line.trimEnd()) >= cols - margin;

// Ways to extend `raw` with the rows around each place it appears: [{ before, after }], each a string
// to put in front of / behind raw. Both empty (raw alone) is left out. Order: shortest join first.
export function joinCandidates(lines, raw, cols, { margin = EDGE_MARGIN, maxRows = MAX_ROWS } = {}) {
  const out = [];
  const seen = new Set();
  if (!raw || !(cols > 0)) return out;
  for (let i = 0; i < lines.length; i++) {
    for (let idx = lines[i].indexOf(raw); idx !== -1; idx = lines[i].indexOf(raw, idx + 1)) {
      const afters = [""];
      // raw ends its row and the row reaches the edge: take the next row's first token, and keep going
      // while that token fills its whole row (after the indent) and that row reaches the edge too.
      if (lines[i].slice(idx + raw.length).trim() === "") {
        let acc = "";
        for (let j = i; j + 1 < lines.length && afters.length <= maxRows && reaches(lines[j], cols, margin); j++) {
          const m = lines[j + 1].match(/^\s*(\S+)(.*)$/);
          if (!m) break;
          acc += m[1];
          afters.push(acc);
          if (m[2].trim() !== "") break;
        }
      }
      const befores = [""];
      // raw starts its row (after the indent): take the previous row's last token if that row reaches the edge.
      if (lines[i].slice(0, idx).trim() === "") {
        let acc = "";
        for (let j = i; j > 0 && befores.length <= maxRows && reaches(lines[j - 1], cols, margin); j--) {
          const m = lines[j - 1].trimEnd().match(/^(.*?)(\S+)$/);
          if (!m) break;
          acc = m[2] + acc;
          befores.push(acc);
          if (m[1].trim() !== "") break;
        }
      }
      for (const before of befores) {
        for (const after of afters) {
          const key = `${before}\0${after}`;
          if ((before || after) && !seen.has(key)) {
            seen.add(key);
            out.push({ before, after });
          }
        }
      }
    }
  }
  return out.sort((a, b) => a.before.length + a.after.length - (b.before.length + b.after.length));
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

// At most this many guesses go to the existence check (one command for all of them).
export const MAX_GUESSES = 16;

// Absolute paths the clicked piece may belong to, longest first, without duplicates.
// `cwd` resolves relative text; `home` expands "~/"; `windows` switches to drive letters and "\".
export function joinedPaths(lines, raw, cols, { cwd, home, windows = false, margin, maxRows } = {}) {
  const abs = (t) => {
    if (windows) {
      if (/^[A-Za-z]:[\\/]/.test(t) || t.startsWith("\\\\")) return t;
    } else if (t.startsWith("/")) return t;
    if (home && (t.startsWith("~/") || (windows && t.startsWith("~\\")))) return home.replace(/[\\/]+$/, "") + t.slice(1);
    if (!cwd || t.startsWith("~")) return null;
    return cwd.replace(/[\\/]+$/, "") + (windows ? "\\" : "/") + t.replace(/^\.[\\/]/, "");
  };
  const out = new Set();
  for (const { before, after } of joinCandidates(lines, raw, cols, { margin, maxRows })) {
    const text = trimJoined(before + raw + after, { start: before !== "", end: true });
    for (const t of [text, after ? withoutParticle(text) : null]) {
      const p = t && abs(t);
      if (p) out.add(p);
    }
  }
  return [...out].sort((a, b) => b.length - a.length).slice(0, MAX_GUESSES);
}
