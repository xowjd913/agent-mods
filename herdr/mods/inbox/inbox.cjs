// PO desk helper: reads the leader reports in ~/.herdr-inbox/<leader>.jsonl (one JSON object per line, written by `report`) and each
// PO's own lines in ~/.herdr-inbox/po/<po id>.jsonl, and sorts them into the panel's two lanes. Pure functions plus one CLI:
// `node inbox.cjs` prints {at, leaders:[...], po:{<po id>:[...]}} as JSON.
// Reader rules (Leader Inbox contract v1): ignore unknown fields and kinds, skip a half-written or broken line, and the newest
// decision/verify line of a leader stays open until a later `answered` line of the same leader.
const fs = require("fs");
const os = require("os");
const path = require("path");

const KINDS = new Set(["start", "done", "decision", "verify", "stop", "resume", "answered", "other"]);
const ASK_KINDS = new Set(["decision", "verify"]);
const MAX_BYTES = 1024 * 1024; // read at most the last 1 MiB of a file: the panel only shows recent lines
const KEEP = 40; // per leader, newest lines kept for the chat view

function inboxDir() { return process.env.HERDR_INBOX_DIR || path.join(os.homedir(), ".herdr-inbox"); }

// Lines of a jsonl text that parse into a report object with a known kind. A last line without a newline may be half written: parse
// failure just skips it, like any other broken line.
function parseLines(text) {
  const out = [];
  for (const line of String(text ?? "").split("\n")) {
    const s = line.trim();
    if (!s) continue;
    let o;
    try { o = JSON.parse(s); } catch { continue; }
    if (!o || typeof o !== "object" || Array.isArray(o)) continue;
    if (!KINDS.has(o.kind)) continue;
    const ts = Date.parse(o.ts);
    out.push({
      ts: Number.isFinite(ts) ? o.ts : null,
      ms: Number.isFinite(ts) ? ts : 0,
      leader: typeof o.leader === "string" ? o.leader : "",
      terminal: typeof o.terminal === "string" ? o.terminal : "",
      kind: o.kind,
      title: typeof o.title === "string" ? unwrapTags(o.title).replace(/\n+/g, " ") : "", // a report that carries the <hc from=...> wrapper shows only its words
      body: typeof o.body === "string" ? unwrapTags(o.body) : "",
      link: typeof o.link === "string" ? o.link : "",
      po: cleanPoId(o.po), // the PO id the leader reports under (optional; "" when absent or not a valid id)
    });
  }
  return out;
}

// Marks each decision/verify line `answered: true` when a later `answered` line of the same leader closed it. An answered line names
// the kind it answers in its body ("decision" | "verify"): it closes the latest still-open ask of that kind; with no such kind (an old
// writer, an empty body) it closes the latest open ask of any kind, so a single answer never leaves the ask open (contract v1).
function markAnswered(items) {
  const open = [];
  for (const it of items) {
    if (ASK_KINDS.has(it.kind)) { it.answered = false; open.push(it); continue; }
    if (it.kind !== "answered" || !open.length) continue;
    const want = it.body.trim().toLowerCase();
    let at = ASK_KINDS.has(want) ? open.map((a) => a.kind).lastIndexOf(want) : -1;
    if (at < 0) at = open.length - 1;
    open[at].answered = true;
    open.splice(at, 1);
  }
  return items;
}

// The newest decision/verify line when no answered line closed it; null otherwise (an older ask is replaced by the newer one).
function openAsk(items) {
  markAnswered(items);
  for (let i = items.length - 1; i >= 0; i--) {
    if (ASK_KINDS.has(items[i].kind)) return items[i].answered ? null : items[i];
  }
  return null;
}

// ---- Readable bodies. A report body is markdown-ish text written by an agent. parseBody turns it into a small list of blocks the
// panel draws (no HTML; anything it does not know stays plain text):
//   {t:"h", segs}                 a heading: "## x", or a short line that ends with ":" ("되돌리기:")
//   {t:"li", segs, mark, depth}   "- x" / "* x" (mark "•") or "1. x" (mark "1."), indented by leading spaces
//   {t:"p", segs}                 a paragraph line
//   {t:"code", text}              a command: a ``` fence, a "$ x" line, a line that is only `x`, or a label line ("되돌리기: x") whose whole rest is one shell command
// segs: [{k:"t", v}] text, [{k:"c", v}] inline `code`, [{k:"l", v:url, label}] a link with its short label.
const URL_RE = /https?:\/\/[^\s<>"'`]+/g;
const CMD_START = /^(cd|git|sh|bash|zsh|curl|wget|npm|npx|node|pnpm|yarn|gh|hc|brew|pip3?|python3?|herdr-app|make|\[|export|sudo|chmod|mkdir|rm|cp|mv|ls|open|echo)(\s|$)/;
const SECTION_LABELS = "되돌리기|따라 하기|아직 못 해 본 것|확인한 것|확인할 것|직접 확인하는 순서|참고|주의";
const HANGUL = /[ㄱ-ㆎ가-힣]/;

// Short label of a URL: "PR #26", "issue #25", "comment" (an #issuecomment anchor), else host/path shortened.
function linkLabel(url) {
  let u;
  try { u = new URL(url); } catch { return String(url).slice(0, 28); }
  if (/^#issuecomment-/.test(u.hash) || /^#discussion_r/.test(u.hash) || /^#pullrequestreview-/.test(u.hash)) return "comment";
  const m = u.pathname.match(/\/(pull|issues)\/(\d+)/);
  if (m) return `${m[1] === "pull" ? "PR" : "issue"} #${m[2]}`;
  const path = (u.host + u.pathname).replace(/\/+$/, "");
  return path.length > 28 ? `${path.slice(0, 27)}…` : path;
}

// Text -> segs: `code` spans and bare URLs (trailing punctuation is not part of the URL).
function inlineSegs(text) {
  const out = [];
  const pushText = (str) => {
    let last = 0, m;
    URL_RE.lastIndex = 0;
    while ((m = URL_RE.exec(str))) {
      let url = m[0];
      const trail = url.match(/[.,;:!?)\]}]+$/)?.[0] ?? "";
      if (trail) url = url.slice(0, -trail.length);
      if (m.index > last) out.push({ k: "t", v: str.slice(last, m.index) });
      out.push({ k: "l", v: url, label: linkLabel(url) });
      last = m.index + url.length;
      URL_RE.lastIndex = last;
    }
    if (last < str.length) out.push({ k: "t", v: str.slice(last) });
  };
  const parts = String(text ?? "").split("`");
  parts.forEach((part, i) => {
    if (!part) return;
    // odd parts sit between a pair of backticks; an unpaired last one is plain text
    if (i % 2 === 1 && i < parts.length - 1) out.push({ k: "c", v: part });
    else pushText(i % 2 === 1 ? "`" + part : part);
  });
  return out;
}

// Is the text after a label ("설치: ...") one whole shell command? Conservative on purpose: it starts with a command word, has no Hangul
// (a sentence in the middle) and no sentence punctuation at the end. The copy box then holds the source text exactly as written;
// anything else stays selectable prose.
function wholeCommand(rest) {
  const v = String(rest ?? "");
  return v.trim() === v && CMD_START.test(v) && !HANGUL.test(v) && !/[.,;:!?。，、]$/.test(v);
}

function parseBody(text) {
  const blocks = [];
  const src = String(text ?? "").replace(/\r/g, "").split("\n");
  let fence = null;
  const para = (str, kind, extra) => { const segs = inlineSegs(str); if (segs.length) blocks.push({ t: kind, segs, ...extra }); };
  // body text of one line -> blocks (a label + shell command, or a sentence with a command-looking `code` span, or plain)
  const parseRest = (body, kind, mark, depth) => {
    // "설치: <shell command ...>" -> the label as text, the command in a code block under it
    const lab = body.match(/^([^\s:：`][^:：`]{0,18})[:：]\s+(.+)$/);
    if (lab && !/^https?$/i.test(lab[1]) && wholeCommand(lab[2])) {
      para(`${lab[1]}:`, kind, mark ? { mark, depth } : {});
      blocks.push({ t: "code", text: lab[2], depth });
      return;
    }
    // a command-looking `code` span in a sentence moves to its own block so it can be copied whole
    const segs = inlineSegs(body);
    if (segs.some((g) => g.k === "c" && /\s/.test(g.v) && CMD_START.test(g.v))) {
      let acc = [];
      const flushAcc = (first) => { if (acc.length) { blocks.push({ t: first ? kind : "p", segs: acc, ...(first && mark ? { mark, depth } : {}) }); acc = []; } };
      let firstDone = false;
      for (const g of segs) {
        if (g.k === "c" && /\s/.test(g.v) && CMD_START.test(g.v)) { flushAcc(!firstDone); firstDone = true; blocks.push({ t: "code", text: g.v, depth }); }
        else acc.push(g);
      }
      flushAcc(!firstDone);
      return;
    }
    if (segs.length) blocks.push({ t: kind, segs, ...(mark ? { mark, depth } : {}) });
  };
  for (const raw of src) {
    const line = raw.replace(/\s+$/, "");
    if (fence) {
      if (/^\s*```/.test(line)) { if (fence.length) blocks.push({ t: "code", text: fence.join("\n") }); fence = null; } else fence.push(line);
      continue;
    }
    if (/^\s*```/.test(line)) { fence = []; continue; }
    const t = line.trim();
    if (!t) { if (blocks.length && blocks[blocks.length - 1].t !== "gap") blocks.push({ t: "gap" }); continue; }
    let m;
    if ((m = t.match(/^#{1,6}\s+(.+)$/))) { blocks.push({ t: "h", segs: inlineSegs(m[1].replace(/\s*#+$/, "")) }); continue; }
    if ((m = t.match(/^\$\s+(.+)$/))) { blocks.push({ t: "code", text: m[1] }); continue; }
    if ((m = t.match(/^`([^`]+)`$/)) && /\s/.test(m[1])) { blocks.push({ t: "code", text: m[1] }); continue; }
    // a short label line is a section heading: "되돌리기:", "따라 하기(새 터미널에 붙여 넣기):"
    if (t.length <= 40 && /[:：]$/.test(t) && !/https?:/.test(t)) { blocks.push({ t: "h", segs: inlineSegs(t.replace(/[:：]$/, "")) }); continue; }
    let mark = "", depth = 0, body = t;
    if ((m = line.match(/^(\s*)[-*•]\s+(.+)$/))) { mark = "•"; depth = Math.min(3, Math.floor(m[1].length / 2)); body = m[2]; }
    else if ((m = line.match(/^(\s*)(\d{1,3})[.)]\s+(.+)$/))) { mark = `${m[2]}.`; depth = Math.min(3, Math.floor(m[1].length / 2)); body = m[3]; }
    const kind = mark ? "li" : "p";
    // a known section label with its text on the same line ("되돌리기: cd ...", "아직 못 해 본 것: ...") -> heading, then the rest
    if (!mark && (m = t.match(new RegExp(`^(${SECTION_LABELS})\\s*[:：]\\s+(.+)$`)))) {
      blocks.push({ t: "h", segs: inlineSegs(m[1]) });
      if (wholeCommand(m[2])) blocks.push({ t: "code", text: m[2], depth: 0 });
      else parseRest(m[2], "p", "", 0);
      continue;
    }
    parseRest(body, kind, mark, depth);
  }
  if (fence?.length) blocks.push({ t: "code", text: fence.join("\n") });
  while (blocks.length && blocks[blocks.length - 1].t === "gap") blocks.pop();
  return blocks;
}

const plain = (segs) => (segs ?? []).map((g) => (g.k === "l" ? g.label : g.v)).join("").replace(/\s+/g, " ").trim();
const MAX_LEAD = 110;

// What the collapsed card shows: head = the title without a leading "[leader] ", lead = the first meaningful body line (not a heading
// or a command), and whether there is more to open ("long").
// Selectable text: the body goes to the screen as HTML for a selectable TextView (drag to select, Cmd+C), cut at every command block so a
// command keeps its own box and copy button. Everything is escaped here; only our own tags (p, strong, ul, li, code, a) are written.
const escapeHtml = (v) => String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const segsHtml = (segs) => (segs ?? []).map((g) => (g.k === "c" ? `<code>${escapeHtml(g.v)}</code>` : g.k === "l" ? `<a href="${escapeHtml(g.v)}">${escapeHtml(g.label || g.v)}</a>` : escapeHtml(g.v))).join("");
const INDENT = "\u00a0\u00a0\u00a0\u00a0";

// [{t:"prose", html} | {t:"h", html, text} | {t:"code", text, html, depth}]: headings are their own parts (the screen styles them; TextView ignores <strong>), "- " items a real list, numbered items paragraphs that keep their own number.
function toParts(blocks) {
  const parts = [];
  let html = "", list = false, md = [];
  const closeList = () => { if (list) { html += "</ul>"; list = false; } };
  const flush = () => { closeList(); if (html) parts.push({ t: "prose", html, md: md.join("\n") }); html = ""; md = []; };
  // the Markdown source of a prose line (the segments keep the writer's ** and _): used by the bubble, which draws it as Markdown
  const src = (segs) => (segs ?? []).map((x) => x.k === "c" ? "`" + x.v + "`" : x.k === "l" ? x.v : x.v).join("");
  for (const b of blocks ?? []) {
    if (b.t === "code") { flush(); parts.push({ t: "code", text: b.text, html: escapeHtml(b.text), depth: b.depth ?? 0 }); continue; }
    if (b.t === "gap") { closeList(); continue; }
    if (b.t === "h") { flush(); parts.push({ t: "h", html: segsHtml(b.segs), text: plain(b.segs) }); continue; }
    if (b.t === "li" && b.mark === "•" && !b.depth) {
      if (!list) { html += "<ul>"; list = true; }
      html += `<li>${segsHtml(b.segs)}</li>`;
      md.push(`- ${src(b.segs)}`);
      continue;
    }
    closeList();
    const pad = INDENT.repeat(Math.min(b.depth ?? 0, 4));
    html += b.t === "li" ? `<p>${pad}${escapeHtml(b.mark)} ${segsHtml(b.segs)}</p>` : `<p>${pad}${segsHtml(b.segs)}</p>`;
    const mpad = "  ".repeat(Math.min(b.depth ?? 0, 4));
    md.push(b.t === "li" ? `${mpad}${b.mark === "•" ? "-" : b.mark} ${src(b.segs)}` : `${mpad}${src(b.segs)}`);
  }
  flush();
  return parts;
}

function enrich(it) {
  if (!it || it.blocks) return it;
  it.blocks = parseBody(it.body);
  it.parts = toParts(it.blocks);
  it.linkLabel = it.link ? linkLabel(it.link) : "";
  it.linkHtml = it.link ? `<a href="${escapeHtml(it.link)}">${escapeHtml(it.linkLabel)}</a>` : "";
  it.head = it.title.replace(/^\[[^\]]*\]\s*/, "").trim();
  const first = it.blocks.find((b) => b.t === "p" || b.t === "li");
  let lead = first ? plain(first.segs) : "";
  if (!it.head && !lead) lead = plain(it.blocks.find((b) => b.t === "h")?.segs) || it.title;
  it.leadFull = lead.length > MAX_LEAD;
  it.lead = it.leadFull ? `${lead.slice(0, MAX_LEAD - 1)}…` : lead;
  const content = it.blocks.filter((b) => b.t !== "gap");
  it.headHtml = escapeHtml(it.head || it.lead || it.title);
  it.leadHtml = escapeHtml(it.lead);
  // a body that is only one command still opens (the box and its copy button are inside)
  it.long = content.length > 1 || it.leadFull || content[0]?.t === "code";
  return it;
}

// One leader: {leader, terminal, items (newest first, KEEP at most), open (the unanswered decision/verify or null), last (newest item)}.
function summarize(leader, text) {
  const items = markAnswered(parseLines(text));
  const named = leader || items.find((i) => i.leader)?.leader || "";
  const newest = items.slice(-KEEP).reverse();
  newest.forEach(enrich);
  const ask = [...items].reverse().find((i) => ASK_KINDS.has(i.kind)) ?? null; // answered or not
  enrich(ask);
  const open = openAsk(items);
  enrich(open);
  return {
    leader: named,
    terminal: items.length ? items[items.length - 1].terminal : "",
    po: [...items].reverse().find((i) => i.po)?.po ?? "", // the newest PO id the leader named, "" when none
    open,
    ask, // the newest decision/verify even if answered: shown while the wait label is still on
    items: newest,
    last: newest[0] ?? null,
  };
}

function readTail(file) {
  const fd = fs.openSync(file, "r");
  try {
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, MAX_BYTES);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    let text = buf.toString("utf8");
    if (size > len) text = text.slice(text.indexOf("\n") + 1); // drop the cut first line
    return text;
  } finally { fs.closeSync(fd); }
}

const OLD_PO_FILE = "po.jsonl"; // the old single PO file: dropped, never read (and never shown as a leader)
const PO_DIR = "po"; // ~/.herdr-inbox/po/<po id>.jsonl: one file per PO, keyed by its id label (never by terminal address)
const MAX_PO = 100; // newest PO lines kept
const MAX_PO_TEXT = 2000;

// The PO's lines: {ts, kind:"say", text, to?} per line, oldest first. Lenient like parseLines: broken or unknown lines are skipped,
// unknown fields are ignored. `to` is who the line answers (an hc name or "here"), "" when absent. A {kind:"me"} line is what the person
// typed into the PO terminal itself (written by the PO hook): it comes back with `me: true` and is shown as the person's own bubble.
function parsePoLines(text) {
  const out = [];
  const pics = []; // {kind:"img"} lines: the images of a prompt, written by the hook after it read them from the transcript
  for (const raw of String(text ?? "").split("\n")) {
    let o;
    try { o = JSON.parse(raw); } catch { continue; }
    if (o && o.kind === "img" && Array.isArray(o.imgs)) {
      const ms = Date.parse(o.ts);
      const imgs = o.imgs.filter((x) => typeof x === "string" && x).slice(0, 4);
      if (ms > 0 && imgs.length) pics.push({ ms, pid: typeof o.pid === "string" ? o.pid : "", imgs });
      continue;
    }
    if (!o || (o.kind !== "say" && o.kind !== "me") || typeof o.text !== "string") continue;
    const body = unwrapTags(o.text); // no <hc ...> / <pasted_content ...> wrapper tags in what the desk draws or compares
    if (!body.trim()) continue;
    const ms = Date.parse(o.ts);
    if (!(ms > 0)) continue;
    out.push({ ts: new Date(ms).toISOString(), ms, text: body.trim().slice(0, MAX_PO_TEXT), to: typeof o.to === "string" ? o.to.trim() : "", ...(o.kind === "me" ? { me: true } : {}), pid: typeof o.pid === "string" ? o.pid : "" });
  }
  // An image line belongs to the prompt with its prompt id, else to the latest prompt within 2 minutes before it.
  for (const g of pics) {
    const me = out.filter((x) => x.me);
    const hit = (g.pid && me.find((x) => x.pid === g.pid)) || [...me].reverse().find((x) => x.ms <= g.ms && g.ms - x.ms <= 120000);
    if (hit) hit.imgs = g.imgs;
  }
  out.sort((a, b) => a.ms - b.ms);
  return out.slice(-MAX_PO).map(({ pid, ...x }) => x);
}

// ---- picture files (Node side; the pure rules - which path may be drawn - are imgOk/splitImgs in the chat block)
// Every picture lives in <app root>/data/inbox/img/ (the app root is ~/.config/herdr-app): the desk's `image()` only loads paths relative to the
// app root, and data/<mod>/ is Herdr's own per-mod state, which a mod save (hot reload) and the installer leave alone. Written 0600 in a 0700
// folder, named by its content hash (the same picture is the same file, so writing it twice is harmless), at most 5 MB each and 4 per message;
// files older than 14 days are removed on the next save.
const MAX_IMG_BYTES = 5 * 1024 * 1024;
const IMG_KEEP_MS = 14 * 24 * 3600 * 1000;
const MIME_EXT = { "image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp" };
// The app root that `image()` resolves against: HERDR_APP_HOME, else the folder this mod is installed in (<root>/mods/inbox), else ~/.config/herdr-app.
function appRoot() {
  if (process.env.HERDR_APP_HOME) return process.env.HERDR_APP_HOME;
  const up = path.dirname(__dirname);
  if (path.basename(up) === "mods") return path.dirname(up);
  return path.join(os.homedir(), ".config", "herdr-app");
}
const IMG_REL = "data/inbox/img"; // under the app root; what `image()` is given (plus the file name)
const imgDir = (root = appRoot()) => path.join(root, ...IMG_REL.split("/"));
// The extension a picture's own first bytes say, or "" when they are not a PNG / JPEG / GIF / WebP.
function sniffExt(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return "";
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return ".png";
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return ".jpg";
  if (buf.toString("latin1", 0, 3) === "GIF") return ".gif";
  if (buf.toString("latin1", 0, 4) === "RIFF" && buf.toString("latin1", 8, 12) === "WEBP") return ".webp";
  return "";
}
// [width, height] of a PNG / GIF / JPEG / WebP from its first bytes (`buf` = the start of the file; a JPEG's size can sit up to ~64 KB in), or null.
function imgSize(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 24) return null;
  const ok = (w, h) => (w > 0 && h > 0 && w < 100000 && h < 100000 ? [w, h] : null);
  const ext = sniffExt(buf);
  if (ext === ".png") return ok(buf.readUInt32BE(16), buf.readUInt32BE(20));
  if (ext === ".gif") return ok(buf.readUInt16LE(6), buf.readUInt16LE(8));
  if (ext === ".webp") {
    const k = buf.toString("latin1", 12, 16);
    if (k === "VP8X" && buf.length >= 30) return ok(1 + buf.readUIntLE(24, 3), 1 + buf.readUIntLE(27, 3));
    if (k === "VP8L" && buf.length >= 25) { const b = buf.readUInt32LE(21); return ok(1 + (b & 0x3fff), 1 + ((b >> 14) & 0x3fff)); }
    if (k === "VP8 " && buf.length >= 30) return ok(buf.readUInt16LE(26) & 0x3fff, buf.readUInt16LE(28) & 0x3fff);
    return null;
  }
  if (ext === ".jpg") {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i++; continue; }
      const m = buf[i + 1];
      if (m === 0xff) { i++; continue; }
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return ok(buf.readUInt16BE(i + 7), buf.readUInt16BE(i + 5));
      i += 2 + buf.readUInt16BE(i + 2);
    }
  }
  return null;
}
// {<file path>: [w, h]} for the newest 30 pictures of the folder (what the bubbles may draw), so a bubble can be given the picture's shape.
function imageDims(root = appRoot()) {
  const folder = imgDir(root);
  const out = {};
  try {
    const names = fs.readdirSync(folder).filter((n) => IMG_EXT.test(n)).map((n) => { try { return { n, m: fs.statSync(path.join(folder, n)).mtimeMs }; } catch { return null; } }).filter(Boolean).sort((a, b) => b.m - a.m).slice(0, 30);
    for (const { n } of names) {
      try {
        const fd = fs.openSync(path.join(folder, n), "r");
        try { const buf = Buffer.alloc(65536); const k = fs.readSync(fd, buf, 0, buf.length, 0); const d = imgSize(buf.subarray(0, k)); if (d) out[path.join(folder, n)] = d; } finally { fs.closeSync(fd); }
      } catch {}
    }
  } catch {}
  return out;
}
const IMG_TOTAL_MAX = 200 * 1024 * 1024; // the picture folder as a whole: past this the oldest pictures go
function pruneImages(folder, now = Date.now(), total = IMG_TOTAL_MAX) {
  try {
    const files = [];
    for (const n of fs.readdirSync(folder)) {
      if (!/^[0-9a-f]{16}\.(png|jpg|gif|webp)$/.test(n)) continue;
      const f = path.join(folder, n);
      try {
        const st = fs.lstatSync(f);
        if (!st.isFile() || now - st.mtimeMs > IMG_KEEP_MS) { fs.unlinkSync(f); continue; } // an old file, or a link (never followed) goes
        files.push({ f, size: st.size, at: st.mtimeMs });
      } catch {}
    }
    let sum = files.reduce((a, x) => a + x.size, 0);
    for (const x of files.sort((a, b) => a.at - b.at)) {
      if (sum <= total) break;
      try { fs.unlinkSync(x.f); sum -= x.size; } catch {}
    }
  } catch {}
}
// Saves picture bytes as <app root>/data/inbox/img/<hash>.<ext> (0600) and returns the path, or null when it is not a picture or is over 5 MB.
function saveImage(buf, root = appRoot(), now = Date.now()) {
  const ext = sniffExt(buf);
  if (!ext || buf.length > MAX_IMG_BYTES) return null;
  const folder = imgDir(root);
  fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
  const file = path.join(folder, `${require("crypto").createHash("sha256").update(buf).digest("hex").slice(0, 16)}${ext}`);
  let st = null;
  try { st = fs.lstatSync(file); } catch {}
  if (st) { // the same picture is already there: only a plain file is reused (a link in its place is removed, never written through)
    if (st.isFile()) { try { fs.chmodSync(file, 0o600); fs.utimesSync(file, new Date(now), new Date(now)); } catch {} return file; }
    try { fs.unlinkSync(file); } catch { return null; }
  }
  pruneImages(folder, now, Math.max(0, IMG_TOTAL_MAX - buf.length));
  let fd;
  try { fd = fs.openSync(file, "wx", 0o600); } catch { return null; } // "wx": never opens an existing file or link
  try { try { fs.fchmodSync(fd, 0o600); } catch {} fs.writeSync(fd, buf); } finally { fs.closeSync(fd); }
  return file;
}
// A picture file the person picked or dropped -> a copy in the picture folder (path), or null.
function importImage(src, root = appRoot()) {
  try {
    if (!IMG_EXT.test(String(src))) return null;
    const st = fs.statSync(src);
    if (!st.isFile() || st.size > MAX_IMG_BYTES) return null;
    return saveImage(fs.readFileSync(src), root);
  } catch { return null; }
}
// The picture on the system clipboard -> its saved path, or null when there is none (or no tool to read it). macOS: AppleScript writes the
// clipboard's PNG; Windows: PowerShell saves the clipboard bitmap; Linux: wl-paste or xclip.
function clipImage(root = appRoot()) {
  const { execFileSync } = require("child_process");
  const run = (cmd, args, env) => execFileSync(cmd, args, { timeout: 8000, stdio: ["ignore", "pipe", "ignore"], windowsHide: true, maxBuffer: MAX_IMG_BYTES + 1024, env: { ...process.env, ...(env ?? {}) } });
  try {
    if (process.platform === "darwin" || process.platform === "win32") {
      const tmpd = fs.mkdtempSync(path.join(os.tmpdir(), "po-clip-"));
      const tmp = path.join(tmpd, "clip.png");
      try {
        if (process.platform === "darwin") {
          run("osascript", ["-e", "on run argv", "-e", "set f to open for access (POSIX file (item 1 of argv)) with write permission", "-e", "try", "-e", "set eof f to 0", "-e", "write (the clipboard as «class PNGf») to f", "-e", "close access f", "-e", "on error", "-e", "try", "-e", "close access f", "-e", "end try", "-e", "error number -128", "-e", "end try", "-e", "end run", tmp]);
        } else {
          run("powershell", ["-NoProfile", "-NonInteractive", "-Command", "Add-Type -AssemblyName System.Windows.Forms,System.Drawing; $i=[System.Windows.Forms.Clipboard]::GetImage(); if($i){$i.Save($env:PO_CLIP,[System.Drawing.Imaging.ImageFormat]::Png)}"], { PO_CLIP: tmp });
        }
        return saveImage(fs.readFileSync(tmp), root);
      } finally {
        try { fs.unlinkSync(tmp); } catch {}
        try { fs.rmdirSync(tmpd); } catch {}
      }
    }
    for (const [cmd, args] of [["wl-paste", ["--type", "image/png"]], ["xclip", ["-selection", "clipboard", "-t", "image/png", "-o"]]]) {
      try { const p = saveImage(run(cmd, args), root); if (p) return p; } catch {}
    }
  } catch {}
  return null;
}
// The pictures of one prompt in a Claude Code transcript (jsonl): the user entry whose promptId is `promptId` (else the newest user entry that
// carries a picture and whose text starts like `promptText`) holds {type:"image", source:{type:"base64", media_type, data}} blocks next to its
// "[Image #N]" text. Each is saved (capped) and the paths come back. Only the last 32 MiB of the transcript are read.
function transcriptImages(file, promptId, promptText, root = appRoot(), now = Date.now()) {
  let text = "";
  try {
    const st = fs.statSync(file);
    const n = Math.min(st.size, 32 << 20);
    const fd = fs.openSync(file, "r");
    try { const buf = Buffer.alloc(n); fs.readSync(fd, buf, 0, n, st.size - n); text = buf.toString("utf8"); } finally { fs.closeSync(fd); }
  } catch { return []; }
  const head = String(promptText ?? "").replace(/\s+/g, " ").trim().slice(0, 30);
  const lines = text.split("\n");
  let pick = null;
  for (let i = lines.length - 1; i >= 0 && !pick; i--) {
    const ln = lines[i];
    if (!ln.includes('"image"') || !ln.includes('"user"')) continue;
    let o;
    try { o = JSON.parse(ln); } catch { continue; }
    if (o?.type !== "user" || !Array.isArray(o.message?.content)) continue;
    const blocks = o.message.content.filter((b) => b?.type === "image" && b.source?.type === "base64" && typeof b.source.data === "string");
    if (!blocks.length) continue;
    const t = o.message.content.filter((b) => b?.type === "text").map((b) => b.text ?? "").join(" ").replace(/\s+/g, " ").trim();
    if ((promptId && o.promptId === promptId) || (!promptId && head && t.startsWith(head))) pick = blocks;
  }
  const out = [];
  for (const b of (pick ?? []).slice(0, MAX_IMGS)) {
    if (b.source.data.length > MAX_IMG_BYTES * 1.4) continue;
    const p = saveImage(Buffer.from(b.source.data, "base64"), root, now);
    if (p && !out.includes(p)) out.push(p);
  }
  return out;
}
// Prompt ids in a PO's file whose "me" line holds an "[Image #N]" placeholder that has no {kind:"img"} line yet (newest 3), with the prompt text.
function pendingImagePids(file) {
  let text = "";
  try { text = readTail(file); } catch { return []; }
  const asked = new Map();
  const got = new Set();
  for (const ln of text.split("\n")) {
    let o;
    try { o = JSON.parse(ln); } catch { continue; }
    if (!o || typeof o.pid !== "string" || !o.pid) continue;
    if (o.kind === "img") got.add(o.pid);
    else if (o.kind === "me" && typeof o.text === "string" && /\[Image #\d+\]/.test(o.text)) asked.set(o.pid, o.text);
  }
  return [...asked].filter(([pid]) => !got.has(pid)).slice(-3).map(([pid, text]) => ({ pid, text }));
}

// What the PO hook appends for one hook event (`payload` = the hook's stdin JSON), or null when there is nothing to write:
//   Stop (the PO's final reply, `last_assistant_message`; not when a Stop hook keeps the turn going) -> {ts, kind:"say", text, src:"hook", pid}
//   UserPromptSubmit (what was typed or pasted) -> {ts, kind:"me", text, src:"hook", pid}
// `pid` is the prompt id that pairs a prompt with its reply. Control and bidi characters are dropped; a text longer than MAX_PO_TEXT ends
// in "…" (the desk shows at most that much). A prompt that is a harness message (<task-notification>, <system-reminder>, ...) is skipped.
const HARNESS_PROMPT = /^<(system-reminder|task-notification|command-name|command-message|command-args|local-command-stdout|local-command-stderr|user-prompt-submit-hook|bash-input|bash-stdout|bash-stderr)[\s>]/i;
function hookLine(payload, now = Date.now()) {
  const ev = payload?.hook_event_name;
  const stop = ev === "Stop";
  if (!stop && ev !== "UserPromptSubmit") return null;
  if (stop && payload.stop_hook_active) return null;
  let text = cleanText(stop ? payload.last_assistant_message : payload.prompt).trim();
  if (!text || (!stop && HARNESS_PROMPT.test(text))) return null;
  if (text.length > MAX_PO_TEXT) text = text.slice(0, MAX_PO_TEXT - 1) + "…";
  return { ts: new Date(Number(now) || Date.now()).toISOString(), kind: stop ? "say" : "me", text, src: "hook", pid: typeof payload.prompt_id === "string" ? payload.prompt_id.slice(0, 80) : "" };
}

// The file of one PO's lines, or null when `id` is not a valid PO id (so a label can never reach outside the folder).
const poFile = (dir, id) => (cleanPoId(id) ? path.join(dir, PO_DIR, `${cleanPoId(id)}.jsonl`) : null);

// Every PO's lines: {<po id>: [lines]}. A missing folder, an unreadable or empty file, or a file not named <valid id>.jsonl is no replies.
function readPo(dir = inboxDir()) {
  const out = {};
  let names = [];
  try { names = fs.readdirSync(path.join(dir, PO_DIR)); } catch { return out; }
  for (const n of names) {
    const id = n.endsWith(".jsonl") ? n.slice(0, -6) : "";
    const file = poFile(dir, id);
    if (!file) continue;
    try { const lines = parsePoLines(readTail(file)); if (lines.length) out[id] = lines; } catch {}
  }
  return out;
}

function collect(dir = inboxDir()) {
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith(".jsonl") && n !== OLD_PO_FILE); } catch { return { at: new Date().toISOString(), dir, leaders: [], po: {}, imgd: {}, root: appRoot() }; }
  const leaders = [];
  for (const n of names) {
    try {
      const s = summarize(n.replace(/\.jsonl$/, ""), readTail(path.join(dir, n)));
      if (s.items.length) leaders.push(s);
    } catch {}
  }
  leaders.sort((a, b) => (b.last?.ms ?? 0) - (a.last?.ms ?? 0));
  return { at: new Date().toISOString(), dir, root: appRoot(), leaders, po: readPo(dir), imgd: imageDims() };
}

// Which terminal is a waiting leader: a terminal named lead-* with the wait label decision|verify; returns that kind or "".
// ONE rule for the tab-row count (tabs-mine), the summary pane and the Dock badge. The two mods cannot require a .cjs file, so the
// line below is copied verbatim into inbox/main.js and tabs-mine/main.js and a test checks that all three stay identical.
const waitingKind = (t) => (/^lead-/.test(String(t?.name ?? "")) ? (["decision", "verify"].find((k) => k === String(t.labels?.wait ?? "").trim().toLowerCase()) ?? "") : "");

// leaderName:begin
// The name a person knows a leader by: its Herdr session name. ONE rule for the inbox (cards, rows), agent-groups (leader headers), leader-tabs (tab text) and work (session rows).
// The mods cannot require a .cjs file, so this block is copied verbatim between the markers into inbox/main.js and agent-groups/main.js
// (a test keeps them identical). Order: the live terminal title -> the `session` label -> the last name remembered for that leader
// (`memo`, {<hc name>: name}) -> the hc name ("lead-po-inbox" -> "po inbox"). The "리더 · " prefix is dropped: the place already says
// it is a leader, and the name then reads as its task.
const LEADER_PREFIX = /^\s*리더\s*·\s*/;
const sessionName = (s) => String(s ?? "").replace(/^[^\p{L}\p{N}\p{Ps}\p{Pi}]+/u, "").replace(LEADER_PREFIX, "").trim();
const liveName = (term) => [term?.title, term?.labels?.session].map(sessionName).find((n) => n && n !== term?.name && n !== term?.address && n.toLowerCase() !== "claude") ?? "";
const leaderName = (leader, term, memo) => liveName(term) || sessionName(memo?.[leader]) || String(leader ?? "").replace(/^lead-/, "").replace(/-/g, " ").trim() || String(term?.address ?? "");
// The memo with the live names of `terms` merged in; null when nothing changed. At most `max` leaders are kept (oldest dropped).
function rememberNames(memo, terms, max = 60) {
  const next = { ...(memo ?? {}) };
  let changed = false;
  for (const t of terms ?? []) {
    const n = /^lead-/.test(String(t?.name ?? "")) ? liveName(t) : "";
    if (!n || next[t.name] === n) continue;
    delete next[t.name]; // re-added last: the newest stay when the cap drops the oldest
    next[t.name] = n;
    changed = true;
  }
  if (!changed) return null;
  for (const k of Object.keys(next).slice(0, Math.max(0, Object.keys(next).length - max))) delete next[k];
  return next;
}
// leaderName:end

// The PO of a leader: that leader's terminal's parent, accepted only when the parent carries the label role=po. No guessing from
// sibling lead-* terminals: a wrong guess would put an answer into some other agent's prompt. null when there is none.
// `terms` are Herdr's terminals() entries ({address, name, parent, labels}); the leader is found by name, else by `address`.
function findPo(terms, leaderName, address) {
  const list = terms ?? [];
  const leader = (leaderName && list.find((t) => t.name === leaderName)) || (address && list.find((t) => t.address === address)) || null;
  const parent = leader?.parent ? list.find((t) => t.address === leader.parent) : null;
  return parent && String(parent.labels?.role ?? "").trim().toLowerCase() === "po" ? parent.address : null;
}

// The line pasted into the PO terminal. One line (newlines folded to spaces) so the submit keeps it as a single user message.
function answerLine(kind, leader, text, link) {
  const body = String(text ?? "").replace(/\s*\n\s*/g, " ").trim();
  return `Panel answer (${kind}) for ${leader}: "${body}".${link ? ` Target: ${link}` : ""}`;
}

// chat:begin
// The chat box of the window: "@" mentions, the menu of live leaders and which PO a line goes to. Pure. The mods cannot require a
// .cjs file, so this block is copied verbatim between the markers into inbox/main.js (a test keeps them identical).
const MENTION_END = "(?=$|[\\s.,!?:;)])";
const MENTION = new RegExp(`(^|\\s)@(here|lead-[A-Za-z0-9_-]+)${MENTION_END}`, "g");
const HERE = new RegExp(`(^|\\s)@here${MENTION_END}`, "g");
const HERE_PUNCT = /(^|\s)@here(?=[.,!?:;)])/g; // "@here" before punctuation takes its leading space with it: "hi @here, ok" -> "hi, ok"
// The box text with each mention chip written out as its text ("@lead-x"), whether or not the chip's range already holds that text.
function composeChat(content) {
  let text = String(content?.text ?? "");
  for (const s of [...(content?.tokens ?? [])].sort((a, b) => b.range.start - a.range.start)) text = text.slice(0, s.range.start) + String(s.token?.text ?? "") + text.slice(s.range.end);
  return text;
}
// What goes to the PO: the text with its line breaks kept (Shift+Enter in the box), "@here" dropped (it only means "to the PO"), and the
// live leaders (`known`, hc names) it names. `empty` is true when nothing is left once the mentions are taken out, so a lone "@lead-x"
// is not sent. Spaces are tidied per line; runs of blank lines become one blank line; the ends are trimmed.
function parseMention(raw, known = []) {
  const flat = String(raw ?? "").replace(/\r\n?/g, "\n").replace(/[ \t\f\v]+/g, " ").replace(/ ?\n ?/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  const to = [];
  let here = false;
  const empty = flat.replace(MENTION, (m, pre, name) => {
    if (name === "here") here = true;
    else if (known.includes(name)) { if (!to.includes(name)) to.push(name); } else return m;
    return pre;
  }).trim() === "";
  const text = flat.replace(/(^|\n)@here[.,!?:;)]+ ?/g, "$1").replace(HERE_PUNCT, "").replace(HERE, "$1").replace(/[ \t]+/g, " ").replace(/ ?\n ?/g, "\n").replace(/\n{3,}/g, "\n\n").replace(/^[\s,.:;!?)]+/, "").trim();
  return { text, to, here, empty };
}
// What an Enter does in the box: Shift+Enter is a line break, a plain Enter (or Cmd/Ctrl+Enter) sends, any other key nothing.
const enterIntent = (key, shift) => (/^(enter|return)$/i.test(String(key ?? "")) ? (shift ? "newline" : "send") : "");
// The widget may or may not add the line break itself for Shift+Enter, so one is added only when no edit landed around the key press
// (`changedAt`, `at`: ms); and the stray line break a sent Enter leaves in the emptied box is cleared (`sentAt`, `now`).
const needsNewline = (changedAt, at) => !(Number(changedAt) >= Number(at) - 25);
const strayBreak = (value, sentAt, now) => String(value ?? "").length > 0 && String(value).trim() === "" && Number(now) - Number(sentAt) < 200;
// A Korean/Japanese/Chinese IME's confirming Enter reaches the box as a plain Enter (KeyEvent has no composing flag), so the first Enter is held, once, when
// the text was edited within IME_MS before it, or ends in a script an IME composes in; the second Enter (no edit since the held one, give or take the
// commit's own 100 ms edit) sends. `heldAt`: when an Enter was last held (0 = never); `changedAt`, `now`: ms.
const IME_MS = 500;
const IME_TAIL = /[\u1100-\u11FF\u3130-\u318F\uA960-\uA97F\uAC00-\uD7AF\u3040-\u30FF\u3400-\u9FFF]$/;
const imeHold = (value, changedAt, heldAt, now) => {
  if (Number(heldAt) > 0 && Number(changedAt) <= Number(heldAt) + 100) return false;
  if (Number(now) - Number(changedAt) < IME_MS) return true;
  return IME_TAIL.test(String(value ?? "").trimEnd());
};
// The line break the widget itself puts in the box for a held Enter (it may add it before or after the key handler runs): the held Enter
// must not leave it there, or the person sees a blank line appear before the second Enter. `heldAt`, `now`: ms; HELD_BREAK_MS covers both orders.
const HELD_BREAK_MS = 150;
const strayHeld = (value, heldAt, now) => Number(heldAt) > 0 && Number(now) - Number(heldAt) < HELD_BREAK_MS && /\n$/.test(String(value ?? ""));
// The text with its trailing line breaks cut: what "an edit" is measured on (the widget's own line break for an Enter is not an edit).
const editCore = (value) => String(value ?? "").replace(/\n+$/, "");
const holdShown = (changedAt, heldAt) => Number(heldAt) > 0 && Number(changedAt) <= Number(heldAt) + 100; // a held Enter is still waiting for its second one
// The "@query" being typed right before `cursor` (offsets into the box text), or null. Not inside a chip, not in the middle of a word.
function mentionQuery(text, cursor, tokens = []) {
  const before = String(text ?? "").slice(0, cursor);
  const m = /(^|\s)@([^\s@]*)$/.exec(before);
  if (!m) return null;
  const start = before.length - m[2].length - 1;
  if (tokens.some((t) => start >= t.range.start && start < t.range.end)) return null;
  return { start, end: cursor, query: m[2] };
}
// ---- The PO picker. A PO terminal carries the labels role=po and po=<id>; the id is lowercase [a-z0-9-], 1-40 long (never the terminal
// address, which changes on a restart). Everything in the window is for the one picked PO.
const PO_ID = /^[a-z0-9-]{1,40}$/;
const PO_OTHER = "~"; // the pick that holds leaders and reports no live PO owns ("PO 모름"); not a valid id, so it never clashes
const cleanPoId = (v) => { const s = String(v ?? "").trim(); return PO_ID.test(s) ? s : ""; };
const isPoTerm = (t) => String(t?.labels?.role ?? "").trim().toLowerCase() === "po";
const poId = (t) => (isPoTerm(t) ? cleanPoId(t?.labels?.po) : "");
// The project a PO terminal is for: its tab's name "PO · <project>" (`where` is "<space> / <tab>"), else "" (the caller falls back to the id).
const poProject = (t) => {
  const tab = String(t?.where ?? "").split(" / ").slice(1).join(" / ").trim();
  const m = /^PO\s*[·:\-]?\s*(\S.*)$/.exec(tab);
  return m ? m[1].trim() : "";
};
// The live PO terminals that have a po id, in terminal order: [{id, address, label, n}]. `label` is the terminal title ("PO · DevNotes"),
// else the id; `n` the live lead-* terminals under it. Two terminals with the same id: the first one is the PO.
function poList(terms) {
  const list = terms ?? [];
  const out = [];
  for (const t of list) {
    const id = poId(t);
    if (!id || out.some((p) => p.id === id)) continue;
    const title = String(t.title ?? "").trim();
    out.push({ id, address: t.address, label: poProject(t) || id, title: title && title !== t.name && title !== t.address ? title : "", n: list.filter((x) => /^lead-/.test(String(x?.name ?? "")) && x.parent === t.address).length });
  }
  return out;
}
// Which PO a leader belongs to: a live PO's id, else PO_OTHER. A live leader belongs to the PO that is its terminal's parent (the
// terminals are the truth: the id a report names may be old); a leader that is not live, to the PO its reports name (`reportPo`).
// A PO that is not live owns nothing.
function leaderOwner(terms, leaderName, address, reportPo = "") {
  const list = terms ?? [];
  const leader = (leaderName && list.find((t) => t.name === leaderName)) || (address && list.find((t) => t.address === address)) || null;
  const id = leader ? poId(leader.parent ? list.find((t) => t.address === leader.parent) : null) : cleanPoId(reportPo);
  return id && poList(list).some((p) => p.id === id) ? id : PO_OTHER;
}
// The PO shown when the window opens: the last one picked while it is still live (PO_OTHER while something still belongs there), else
// the PO with the most live leaders (the first one on a tie), else PO_OTHER when only that exists, else "".
function choosePick(pos, last, hasOther) {
  const l = String(last ?? "");
  if ((pos ?? []).some((p) => p.id === l) || (l === PO_OTHER && hasOther)) return l;
  const best = (pos ?? []).map((p, i) => ({ p, i })).sort((a, b) => b.p.n - a.p.n || a.i - b.i)[0];
  return best ? best.p.id : hasOther ? PO_OTHER : "";
}
// The "@" menu: "@here" first, then the live leaders of the picked PO (`pick`, a PO id; none for PO_OTHER), by shown name. `query`
// filters by hc name or shown name.
function leaderMenu(terms, memo, query = "", limit = 8, pick = "") {
  const list = terms ?? [];
  const q = String(query ?? "").trim().toLowerCase();
  const leaders = list.filter((t) => pick && pick !== PO_OTHER && /^lead-/.test(String(t?.name ?? "")) && findPo(list, t.name, t.address) && leaderOwner(list, t.name, t.address) === pick)
    .map((t) => ({ id: t.name, label: leaderName(t.name, t, memo), sub: t.name }))
    .filter((x, i, a) => a.findIndex((y) => y.id === x.id) === i)
    .sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0)); // code-unit order: the same on every platform
  return [{ id: "here", label: "here", sub: "" }, ...leaders].filter((x) => !q || x.id.toLowerCase().includes(q) || x.label.toLowerCase().includes(q)).slice(0, limit);
}
// The PO terminal a line is pasted into: the PO of the leaders it names (they must share one), else the picked PO (`pick`, a PO id).
// {po} or {po:null, why:"orphan"|"many"|"none"}.
function chatTarget(terms, to = [], pick = "") {
  const list = terms ?? [];
  if (to.length) {
    const pos = [...new Set(to.map((n) => findPo(list, n)))];
    if (pos.includes(null)) return { po: null, why: "orphan" };
    return pos.length > 1 ? { po: null, why: "many" } : { po: pos[0] };
  }
  const p = pick && pick !== PO_OTHER ? poList(list).find((x) => x.id === pick) : null;
  return p ? { po: p.address } : { po: null, why: "none" };
}
// ---- The messenger timeline of one room (= one PO). Everything below is pure.
// `leaders` [{s, owner}]: s = a leader's summary (s.leader, s.items), owner = its room (a PO id or PO_OTHER). `says`: the PO's own lines
// (po/<id>.jsonl). `mine`: what the person sent through the chat box [{ts, ms, text, to, po}]. `waits` [{leader, ts, kind}]: the leaders
// of this room that wait on a decision/verify (ts = the report time of the waited-on ask, "" when no report is known). Entries come
// oldest first: {key, who ("l:<leader>" | "po" | "me"), ms, ts, s?, leader?, it?, text?, to?, waiting?, wait?}. `waiting` marks the report a
// waiting leader is blocked on (it carries the answer buttons); `wait` is a made-up entry for a waiting leader with no report in the
// list (its label alone), placed at `now` (the newest). Reports of kind answered/start are not messages.
const TL_GAP_MS = 5 * 60 * 1000; // the same sender within this gap shares one header
const tlShown = (it) => Boolean(it) && it.kind !== "answered" && it.kind !== "start";
function timeline(room, leaders, says, mine, waits = [], now = 0) {
  const out = [];
  const seen = new Set();
  for (const { s, owner } of leaders ?? []) {
    if (owner !== room) continue;
    for (const it of s?.items ?? []) {
      const key = `l|${s.leader}|${it.ts}`;
      if (!tlShown(it) || seen.has(key)) continue;
      seen.add(key);
      const w = (waits ?? []).find((x) => x.leader === s.leader && x.ts === it.ts);
      out.push({ key, who: `l:${s.leader}`, ms: Number(it.ms) || 0, ts: it.ts, s, leader: s.leader, it, ...(w ? { waiting: w.kind } : {}) });
    }
  }
  for (const w of waits ?? []) {
    if (out.some((e) => e.leader === w.leader && e.it?.ts === w.ts)) continue;
    const s = (leaders ?? []).find((l) => l.owner === room && l.s?.leader === w.leader)?.s ?? { leader: w.leader, items: [] };
    out.push({ key: `w|${w.leader}`, who: `l:${w.leader}`, ms: Number(now) || 0, ts: "", s, leader: w.leader, waiting: w.kind, wait: true });
  }
  // A line the person typed into the PO terminal itself arrives from the PO hook as {me: true} and is shown as their own bubble. The desk's
  // own sends are pasted into that terminal too, so the hook sees them as well: such a line is dropped when a desk record that reached the PO
  // (not failed / nopane / gone) has the same text (its `line` or its `text`, whitespace ignored) and came from up to 11 minutes (the Enter
  // button's life) before to 1 minute after it. One desk record covers one typed line.
  const sentBy = (mine ?? []).filter((m) => m.po === room && !["failed", "nopane", "gone"].includes(m.status));
  const taken = new Set();
  const tnorm = (v) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, 2000);
  // Compared without wrapper tags (the terminal's paste wrapper must not make a copy look different) and, as a second chance, by words + pictures.
  const full = (v) => tnorm(unwrapTags(v));
  const core = (v) => { const sp = splitImgs(v); return `${tnorm(sp.text)}|${sp.imgs.join(",")}`; };
  if (room && room !== PO_OTHER) for (const x of says ?? []) {
    if (x.me) {
      const t = full(x.text), c = core(x.text);
      const i = sentBy.findIndex((m, j) => !taken.has(j) && (x.ms - (Number(m.ms) || 0)) >= -60000 && (x.ms - (Number(m.ms) || 0)) <= 11 * 60000 && (full(m.line) === t || full(m.text) === t || (c.length > 1 && (core(m.line) === c || core(m.text) === c))));
      if (i >= 0) { taken.add(i); continue; }
      out.push({ key: `me|${x.ms}|${x.text}`, who: "me", id: "", at: Number(x.ms) || 0, ms: Number(x.ms) || 0, ts: x.ts, text: unwrapTags(x.text), to: "", kind: "chat", status: "sent", typed: true, ...(x.imgs?.length ? { imgs: x.imgs } : {}) });
      continue;
    }
    out.push({ key: `po|${x.ms}|${x.text}`, who: "po", ms: Number(x.ms) || 0, ts: x.ts, text: unwrapTags(x.text), to: x.to || "" });
  }
  for (const x of mine ?? []) if (x.po === room) out.push({ key: `me|${x.ms}|${x.text}`, who: "me", id: x.id || "", at: Number(x.at ?? x.ms) || 0, ms: Number(x.ms) || 0, ts: x.ts, text: x.text, to: x.to || "", kind: x.kind || "chat", status: liveStatus(x.status || "sent", x.at ?? x.ms, now), ...(x.imgs?.length ? { imgs: x.imgs } : {}) });
  // Two entries with the same key (the same text at the same ms) would share one element id: the later ones get a #n suffix.
  const used = new Map();
  for (const e of out) {
    const n = used.get(e.key) ?? 0;
    used.set(e.key, n + 1);
    if (n) e.key = `${e.key}#${n}`;
  }
  return out.map((e, i) => ({ e, i })).sort((a, b) => a.e.ms - b.e.ms || a.i - b.i).map((x) => x.e);
}
// What the person sent from the desk, one record per send (answer buttons, option chips and the chat box all go through deliver()):
// {id, ts, ms, text (what the person wrote: "확인 완료", "1안 선택", the answer, the chat line - never the long "Panel answer" wrapper), line (what was
// pasted: the retry sends exactly this), to (leader), po (the room), kind: answer | verify | choice | chat, status}. Null when there is nothing to record.
// status follows the real outcome: sending (pasted, Enter on its way) -> sent | noenter (pasted, Enter did not go);
// opening (no PO pane yet, sent by itself once it opens) -> nopane (it did not open in time); held (PO blocked: pasted only); gone (the Enter button found
// the pasted line no longer in the PO's input: send it again); failed (paste failed).
const CHAT_KINDS = ["answer", "verify", "choice", "chat"];
const CHAT_STATUS = ["sending", "opening", "sent", "noenter", "held", "gone", "nopane", "failed"];
// Control characters (except line break and tab), zero-width and bidi-override characters out of text that is shown or sent: a PO screen read
// back with `hc read` or a typed line must not carry terminal escapes or text-direction tricks into the desk or the PO's input.
const CTRL_CHARS = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u200B-\u200F\u2028\u2029\u202A-\u202E\u2060-\u2069\uFEFF]/g;
const cleanText = (s) => String(s ?? "").replace(/\r\n?/g, "\n").replace(CTRL_CHARS, "");
// ak: the key of the leader's ask card this send answers ("" for none): a resend that goes through marks that card sent again.
function chatRecord(rec, status, now = 0, seq = "") {
  const text = cleanText(rec?.text).trim();
  const imgs = (Array.isArray(rec?.imgs) ? rec.imgs : []).filter((x) => typeof x === "string" && x).slice(0, 4);
  if ((!text && !imgs.length) || !rec?.po) return null;
  const ms = Number(now) || 0;
  return { id: `${ms}-${String(seq ?? "")}`, at: ms, ts: new Date(ms).toISOString(), ms, text, ...(imgs.length ? { imgs } : {}), line: cleanText(rec.line ?? text).slice(0, 4000), to: String(rec.to ?? ""), po: String(rec.po), kind: CHAT_KINDS.includes(rec.kind) ? rec.kind : "chat", ak: String(rec.ak ?? ""), status: CHAT_STATUS.includes(status) ? status : "failed" };
}
// The list with record `id` set to `status` at `now` (null when there is no such record or it already has it).
function setChatStatus(list, id, status, now = 0) {
  if (!CHAT_STATUS.includes(status) || !Array.isArray(list)) return null;
  const i = list.findIndex((x) => x && x.id === id);
  if (i < 0 || list[i].status === status) return null;
  return list.map((x, j) => (j === i ? { ...x, status, at: Number(now) || 0 } : x));
}
// The small dim note under a bubble that is not (fully) sent: "" when it was sent. `blocked`: the PO still waits on a prompt; `age`: ms since
// the status last changed (an Enter button older than ENTER_TTL_MS is gone: the pasted line may not be in the input any more).
const ENTER_TTL_MS = 10 * 60 * 1000;
const MINE_NOTE = { sending: "보내는 중…", opening: "PO 칸을 여는 중 — 열리면 자동으로 보냅니다", held: "PO가 질문 중이라 붙여 넣기만 했습니다 — 아래 질문에 먼저 답하세요", noenter: "붙여 넣었지만 Enter가 눌리지 않았습니다", gone: "보낸 글이 입력창에 없습니다 — 다시 보내세요", nopane: "보내지 못함 — PO 칸이 열리지 않았습니다", failed: "보내지 못함 — 붙여 넣기 실패" };
function mineNote(status, blocked = true, age = 0) {
  const old = Number(age) > ENTER_TTL_MS;
  if (status === "held" && !blocked) return old ? "오래되어 입력창에 없을 수 있습니다 — 다시 보내세요" : "질문에 답했습니다 — Enter를 눌러 보내거나 다시 보내세요";
  if (status === "noenter" && old) return "오래되어 입력창에 없을 수 있습니다 — 다시 보내세요";
  return MINE_NOTE[status] ?? "";
}
// The buttons a bubble offers, in order: "resend" (nothing reached the PO, or its pasted line is gone: send it again) and "enter" (it is pasted
// into a normal prompt: only Enter is missing). A held one offers none while the PO still waits on its question (Enter there would answer the
// question; that is only offered next to the question itself), and Enter and resend after it was answered. An Enter older than ENTER_TTL_MS
// becomes a resend.
function mineActs(status, blocked = false, age = 0) {
  if (status === "nopane" || status === "failed" || status === "gone") return ["resend"];
  const fresh = !(Number(age) > ENTER_TTL_MS);
  if (status === "noenter") return fresh ? ["enter"] : ["resend"];
  if (status === "held" && !blocked) return fresh ? ["enter", "resend"] : ["resend"];
  return [];
}
// A record that stayed "sending" / "opening" (the desk that was sending it went away) no longer waits: sending -> noenter (maybe pasted, Enter
// unknown: the Enter button is safe, an empty Enter does nothing), opening -> nopane.
const SENDING_STALE_MS = 20000;
const liveStatus = (status, ms, now) => (now - (Number(ms) || 0) <= SENDING_STALE_MS ? status : status === "sending" ? "noenter" : status === "opening" ? "nopane" : status);
// Who writes the app icon badge: one copy at a time (`lease` {id, ts}, shared). "write" when this copy holds it or its holder went quiet
// (ttl: a little over two 30 s refreshes, so a closed pane gives the badge to the next copy within about a minute).
const badgeTurn = (lease, id, now, ttl = 65000) => (!lease || lease.id === id || now - (Number(lease.ts) || 0) > ttl ? "write" : "skip");
// A PO that waits on a prompt: the last lines of its screen, and the numbered choices on it ("❯ 1. Yes" / "2. No ..."). The desk shows them and the
// person presses one; nothing is ever pressed by itself. The choices are the last contiguous run of numbered rows (1, 2, ...) once the footer
// (hint lines like "Esc to cancel · Tab to amend", box borders) at the bottom of the screen is skipped; else none.
// A spinner / timer row of the PO ("✻ Waiting (12s)", "✻ Thinking… (3s · esc to interrupt)"): it changes every second without the question
// changing, so it is neither shown nor part of the signature.
const PROMPT_TIMER = /^[\s│┃|]*[^\p{L}\p{N}\s]?\s*\p{L}[\p{L}\s'-]{0,30}[….]*\s*\((?:\d+\s*[hms]\s*)+[^)]*\)[\s│┃|]*$/u;
const promptTail = (text, n = 10) => cleanText(text).split("\n").map((l) => l.replace(/\s+$/, "")).filter((l) => l.trim() && !PROMPT_TIMER.test(l)).slice(-n).map((l) => (l.length > 140 ? `${l.slice(0, 139)}…` : l));
const PROMPT_NUM = /^[\s│┃|]*([❯>›])?\s*(\d{1,2})[.)]\s+(\S.*?)[\s│┃|]*$/;
const promptFooter = (l) => /^[^\p{L}\p{N}]*$/u.test(l) || (l.length <= 140 && /\b(esc|enter|tab|ctrl|shift|alt)\b|^\s*[↑↓←→]|\? for shortcuts/i.test(l));
// {options: [{key, label, on}], head: the up to 2 lines right above the choices}. Options only when they are 1..N (2 or more).
function promptParse(text) {
  const lines = promptTail(text, 24);
  const num = lines.map((l) => PROMPT_NUM.exec(l));
  let end = lines.length - 1;
  for (let skip = 0; end >= 0 && !num[end] && skip < 6 && promptFooter(lines[end]); skip++) end--;
  if (end < 0 || !num[end]) return { options: [], head: [] };
  let start = end;
  while (start > 0 && num[start - 1]) start--;
  const options = num.slice(start, end + 1).map((m) => ({ key: m[2], label: m[3].trim().slice(0, 80), on: m[1] === "❯" || m[1] === "›" }));
  if (options.length < 2 || !options.every((o, i) => Number(o.key) === i + 1)) return { options: [], head: [] };
  return { options: options.slice(0, 6), head: lines.slice(Math.max(0, start - 2), start) };
}
const promptOptions = (text) => promptParse(text).options;
// What identifies the question on screen: the choices (without which one is highlighted) and the lines above them, whitespace squeezed; when
// there are no choices, the last 6 lines. Equal before and after means the same question, whatever the status line below it does.
function promptSig(text) {
  const p = promptParse(text);
  const lines = p.options.length ? [...p.head, ...p.options.map((o) => `${o.key}. ${o.label}`)] : promptTail(text, 6);
  return lines.map((l) => l.replace(/\s+/g, " ").trim()).join("\n");
}
// Whether two reads of a PO's screen show the same thing (the last 40 rows, whitespace squeezed, timer rows left out): then the panel is not redrawn.
const promptSame = (a, b) => promptTail(a, 40).map((l) => l.replace(/\s+/g, " ").trim()).join("\n") === promptTail(b, 40).map((l) => l.replace(/\s+/g, " ").trim()).join("\n");
// Whether the pasted `line` is still in the PO's input: the start or the end of its text is among the last 14 screen lines (box borders and
// whitespace ignored), or, for a long / multi-line paste the PO folds into "[Pasted text …]", that marker is.
function inputHas(screen, line) {
  const squeeze = (s) => s.replace(/[│┃|]/g, " ").replace(/\s+/g, " ").trim();
  const want = squeeze(cleanText(line));
  if (!want) return false;
  const hay = squeeze(cleanText(screen).split("\n").filter((l) => l.trim()).slice(-14).join("\n"));
  if (/\n/.test(cleanText(line).trim()) || want.length > 200) return /\[Pasted text/i.test(hay) || hay.includes(want.slice(0, 24)) || hay.includes(want.slice(-24));
  return hay.includes(want.slice(0, 24)) || hay.includes(want.slice(-24));
}
// Slack-style headers: `head` is true for the first entry and whenever the sender changes or the gap to the entry before is over `gap`.
const groupTimeline = (entries, gap = TL_GAP_MS) => (entries ?? []).map((e, i, a) => ({ ...e, head: i === 0 || a[i - 1].who !== e.who || e.ms - a[i - 1].ms > gap }));
// Messages of a room that came after the person last opened it (`seen`, ms; 0/missing = never opened). The person's own lines and
// the made-up "waiting" entry do not count (a waiting leader has its own count).
const unreadCount = (entries, seen) => (entries ?? []).filter((e) => e.who !== "me" && !e.wait && e.ms > (Number(seen) || 0)).length;
// The new {room: last opened ms} after opening `room` with these entries; null when nothing changes.
function seenNext(seenMap, room, entries) {
  const latest = Math.max(0, ...(entries ?? []).filter((e) => !e.wait).map((e) => e.ms));
  if (!room || !(latest > 0) || (Number(seenMap?.[room]) || 0) >= latest) return null;
  return { ...(seenMap ?? {}), [room]: latest };
}
// The chat filter chips, in order: [key, label]. 전체 = everything; 안 읽은 것 = messages newer than the room's seen marker as it was when the
// room was opened (`seen`, a snapshot: opening a room moves the live marker to now, which would empty this filter at once); the rest are the
// leader reports of one kind (결정 필요 = decision, 최종 확인 요청 = verify, 결과 = done, 멈춤 = stop). resume/start/other show only under
// 전체. The person's own lines are only under 전체; the made-up "waiting" entry (no report) counts by the kind the leader waits on.
const CHAT_FILTERS = [["all", "전체"], ["unread", "안 읽은 것"], ["decision", "결정 필요"], ["verify", "최종 확인 요청"], ["done", "결과"], ["stop", "멈춤"]];
const entryKind = (e) => (e?.who === "po" || e?.who === "me" ? "" : e?.waiting || e?.it?.kind || "");
function filterEntries(entries, filter, seen) {
  const list = entries ?? [];
  if (!filter || filter === "all" || !CHAT_FILTERS.some((f) => f[0] === filter)) return list;
  if (filter === "unread") return list.filter((e) => e.who !== "me" && !e.wait && e.ms > (Number(seen) || 0));
  return list.filter((e) => entryKind(e) === filter);
}
// What the timeline draws under a filter: the filtered entries, and always the pending "waiting" ones (a leader still waiting on the person must not
// vanish because a chip hides its kind). `raw` order is kept. The chip counts are not changed by this.
function keepWaiting(raw, shown) {
  const have = new Set(shown ?? []);
  return (raw ?? []).filter((e) => have.has(e) || e.waiting);
}
// The "안 읽은 것" base, shared by every copy of the mod (Dock, window, pane): {<room>: {seen, ts}}. The first copy to draw a room takes the room's
// last-opened marker before it moves, and the others use that same value for SNAP_TTL_MS after it was last drawn (each draw renews it).
const SNAP_TTL_MS = 30000;
const snapBase = (snaps, room, seen, now, ttl = SNAP_TTL_MS) => {
  const s = snaps?.[room];
  return s && now - (Number(s.ts) || 0) <= ttl ? Number(s.seen) || 0 : Number(seen?.[room]) || 0;
};
// -> {base, next}: `next` = the map to store (expired rooms dropped, this room renewed at most every ttl/3), null when nothing changes.
function snapStep(snaps, room, seen, now, ttl = SNAP_TTL_MS) {
  if (!room) return { base: 0, next: null };
  const cur = snaps && typeof snaps === "object" ? snaps : {};
  const fresh = Object.fromEntries(Object.entries(cur).filter(([, s]) => now - (Number(s?.ts) || 0) <= ttl));
  const had = fresh[room];
  const base = had ? Number(had.seen) || 0 : Number(seen?.[room]) || 0;
  const touch = !had || now - (Number(had.ts) || 0) > ttl / 3;
  if (!touch && Object.keys(fresh).length === Object.keys(cur).length) return { base, next: null };
  return { base, next: { ...fresh, [room]: { seen: base, ts: touch ? now : had.ts } } };
}
// The element id of a timeline row: the entry key, which ends in the "#n" of a duplicate; a long key keeps its start and gets a hash of the whole.
function tlId(key) {
  const k = String(key ?? "");
  if (k.length <= 80) return `tl-${k}`;
  let h = 5381;
  for (const ch of k) h = (Math.imul(h, 33) ^ ch.codePointAt(0)) >>> 0;
  return `tl-${k.slice(0, 64)}~${h.toString(16).padStart(8, "0")}`;
}
// {all, unread, decision, verify, done, stop}: how many entries each chip shows.
const filterCounts = (entries, seen) => Object.fromEntries(CHAT_FILTERS.map(([k]) => [k, filterEntries(entries, k, seen).length]));
// Follow-the-newest rule: scroll to the bottom when the room changes or the window opens (`seen` is the last key drawn, "" at first),
// and when a new message arrived while the list was at its bottom; never while the person has scrolled up to read.
const tlKey = (room, entries) => { const l = (entries ?? [])[(entries ?? []).length - 1]; return `${room}|${(entries ?? []).length}|${l ? `${l.ms}|${l.key}` : ""}`; };
const tlFollow = (seen, key, atEnd) => key !== (seen ?? "") && (String(seen ?? "").split("|")[0] !== key.split("|")[0] || Boolean(atEnd));
// Whether a scroll area is at its end (ScrollPosition: offset().y + viewport height >= content height - 1).
const atBottom = (y, viewport, content) => (Number(y) || 0) + (Number(viewport) || 0) >= (Number(content) || 0) - 1;
// A message text as HTML for a TextView: escaped, one paragraph per line, http(s) links clickable (trailing punctuation stays outside).
const escHtml = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
function chatHtml(text) {
  return unwrapTags(text).replace(/\r\n?/g, "\n").split("\n").map((line) => {
    let out = "", at = 0;
    for (const m of line.matchAll(/https?:\/\/[^\s<>"]+/g)) {
      const url = m[0].replace(/[.,!?:;)\]]+$/, "");
      if (!url) continue;
      out += `${escHtml(line.slice(at, m.index))}<a href="${escHtml(url)}">${escHtml(url)}</a>`;
      at = m.index + url.length;
    }
    return `<p>${out + escHtml(line.slice(at)) || "&nbsp;"}</p>`;
  }).join("");
}
// Where "옆에 열기" puts the PO desk. `here`: the panes of the tab being shown (panes() filtered by tab), `f`: focused(), `terms`: terminals().
// Beside the focused pane if it is a leader, else the newest leader of the tab (created_ms, else the higher base-36 address), else the
// focused terminal, else any focused pane. A tab that already has an inbox mod pane gets that one focused instead (one per tab).
// Returns {action: "focus", pane} | {action: "split", pane?}. Pure.
function dockTarget(here, f, terms) {
  const list = Array.isArray(here) ? here : [];
  const byAddr = new Map((Array.isArray(terms) ? terms : []).map((t) => [t.address, t]));
  const leaders = list.filter((p) => p.terminal && String(byAddr.get(p.terminal)?.labels?.role ?? "").trim().toLowerCase() === "leader");
  const age = (p) => { const ms = Number(byAddr.get(p.terminal)?.created_ms); return Number.isFinite(ms) ? ms : parseInt(String(p.terminal).replace(/^t/, ""), 36) || 0; };
  const leader = leaders.find((p) => p.pane === f?.pane) ?? [...leaders].sort((a, b) => age(b) - age(a))[0];
  const beside = leader ?? list.find((p) => p.pane === f?.pane) ?? list.find((p) => p.focused && p.terminal) ?? list.find((p) => p.focused);
  const have = list.find((p) => p.mod === "inbox");
  if (beside && have) return { action: "focus", pane: have.pane };
  return beside ? { action: "split", pane: beside.pane } : { action: "split" };
}
// The options of a decision report, read strictly from its body (the leader report rule: one "N안: ..." line per option, N = 1..3, and
// optionally a "추천: N안" line). At least two distinct numbers, otherwise none (nothing is guessed: "A:", "1)", "①", "1. step" are not options).
// -> { options: [1, 2], recommended: 2 | 0 }
function decisionOptions(body) {
  const nums = new Set();
  let rec = 0;
  for (const line of String(body ?? "").split(/\r?\n/)) {
    let m = line.match(/^\s*(?:[-*]\s*)?([1-3])안\s*[:：)]\s*\S/);
    if (m) { nums.add(Number(m[1])); continue; }
    m = line.match(/^\s*(?:[-*]\s*)?추천\s*[:：]\s*([1-3])안/);
    if (m && !rec) rec = Number(m[1]);
  }
  const options = [...nums].sort((x, y) => x - y);
  if (options.length < 2) return { options: [], recommended: 0 };
  return { options, recommended: options.includes(rec) ? rec : 0 };
}
// Who is writing right now: the room's PO and its leaders whose terminal status is "working" -> [{who, name}] (PO first, then the leaders by
// shown name). `who` is the timeline owner key ("po" or "l:<hc name>"), the same the entries use. Pure; the dots bubbles read this, never
// the unread counts. For the "PO 모름" room only leaders count (there is no PO terminal to watch).
const isWorking = (t) => String(t?.status ?? "").trim().toLowerCase() === "working";
function typingNow(terms, room, memo) {
  const list = terms ?? [];
  const out = [];
  if (!room) return out;
  if (room !== PO_OTHER) {
    const po = poList(list).find((p) => p.id === room);
    const term = po ? list.find((t) => t.address === po.address) : null;
    if (term && isWorking(term)) out.push({ who: "po", name: po.label });
  }
  const seen = new Set();
  const leaders = [];
  for (const t of list) {
    const n = String(t?.name ?? "");
    if (!/^lead-/.test(n) || seen.has(n) || !isWorking(t) || leaderOwner(list, n, t.address) !== room) continue;
    seen.add(n);
    leaders.push({ who: `l:${n}`, name: leaderName(n, t, memo) });
  }
  leaders.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return [...out, ...leaders];
}
// A short text that changes exactly when something the desk shows from the terminals changes: the status, the wait label and the shown
// name of every PO and leader. The 1.5 s poll redraws a copy only when this differs from the last one (no redraw on a quiet second).
function statusSig(terms) {
  const rows = [];
  for (const t of terms ?? []) {
    const lead = /^lead-/.test(String(t?.name ?? ""));
    if (!lead && !poId(t)) continue;
    rows.push(`${t.address}|${String(t.status ?? "")}|${lead ? waitingKind(t) : ""}|${lead ? liveName(t) : ""}`);
  }
  return rows.sort().join("\n");
}
// ---- images (pasted, picked or dropped in the box; or pasted in the PO terminal and read back by the hook)
// A picture lives in <app root>/data/inbox/img/ (0600, written by this helper); a line of the desk's message names it as "[image: <path> — ...]"
// so the PO (Claude) can open it with Read, and the bubble shows the picture (`image()` takes the path relative to the app root, imgRel).
// Only a path inside that folder is ever drawn.
const IMG_EXT = /\.(png|jpe?g|gif|webp)$/i;
const MAX_IMGS = 4;
const imgLine = (p) => `[image: ${p} — open it with the Read tool]`;
const IMG_LINE = /^\[image: (.+?)(?: — [^\]]*)?\]$/;
const slashed = (x) => String(x ?? "").replace(/\\/g, "/");
const IMG_SUB = "data/inbox/img/";
function imgOk(root, p) {
  const d = slashed(root).replace(/\/+$/, "");
  const s = slashed(p);
  if (!d || !s || s.includes("..") || /[\u0000-\u001F]/.test(s)) return false;
  const pre = `${d}/${IMG_SUB}`;
  return s.startsWith(pre) && IMG_EXT.test(s) && s.length > pre.length && !s.slice(pre.length).includes("/");
}
// The path `image()` loads: relative to the app root ("data/inbox/img/<file>"), or "" when the picture may not be drawn.
function imgRel(root, p) { return imgOk(root, p) ? IMG_SUB + slashed(p).slice(slashed(root).replace(/\/+$/, "").length + 1 + IMG_SUB.length) : ""; }
// Wrapper tags that are not part of a message: <hc from="..."> ... </hc> (a message another terminal sent to this one) and
// <pasted_content id="..."> ... </pasted_content id="..."> (what the terminal puts around a paste), also with the backslash forms
// (<\pasted_content ...>, <\/pasted_content ...>). Only a tag that opens a line, or a closing tag that ends one, is removed: a text that
// merely mentions a tag in the middle of a sentence keeps it. Pure.
const WRAP_OPEN = /^[ \t]*<[\\/]{0,2}(?:hc|pasted_content)\b[^<>\n]*>[ \t]*/gim;
const WRAP_CLOSE = /[ \t]*<\\?\/(?:hc|pasted_content)\b[^<>\n]*>[ \t]*$/gim;
function unwrapTags(text) {
  const t = String(text ?? "");
  if (!t.includes("<")) return t;
  return t.replace(/\r\n?/g, "\n").replace(WRAP_OPEN, "").replace(WRAP_CLOSE, "").replace(/\n{3,}/g, "\n\n").trim();
}
// A message text as Markdown for a TextView.markdown(...).raw_html(false): wrapper tags removed first (they would print literally), a line that
// is only 【...】 made bold, images switched off (![x](y) -> a plain link), and single line breaks kept as line breaks (Markdown would join them).
// Code fences are left as written. Never produces HTML: the view shows tags as text. Pure.
function mdText(text) {
  const src = unwrapTags(text).replace(/\r\n?/g, "\n").split("\n");
  let fence = false;
  const rows = src.map((ln) => {
    if (/^\s*(?:```|~~~)/.test(ln)) { fence = !fence; return { s: ln, flow: false }; }
    if (fence) return { s: ln, flow: false };
    let s = ln.replace(/!\[/g, "!\\[");
    if (/^\s*【[^】\n]*】[:：]?\s*$/.test(s)) s = `**${s.trim()}**`;
    return { s, flow: true };
  });
  return rows.map((r, i) => (r.flow && r.s.trim() && rows[i + 1]?.flow && rows[i + 1].s.trim() && !/ {2}$/.test(r.s) ? r.s + "  " : r.s)).join("\n");
}
// A message text -> {text without its "[image: ...]" lines, imgs: the paths those lines named}.
function splitImgs(text) {
  const imgs = [];
  const keep = [];
  for (const ln of unwrapTags(text).split("\n")) {
    const m = IMG_LINE.exec(ln.trim());
    if (m && imgs.length < MAX_IMGS) imgs.push(m[1]); else keep.push(ln);
  }
  return { text: keep.join("\n").trim(), imgs };
}
// What a bubble draws for `text` (+ `extra`, the paths the hook read back): the words, the pictures that may be drawn, and the numbers of
// "[Image #N]" placeholders (a picture pasted in the PO terminal) that have no picture to show - drawn as a small chip, never as raw text.
function bubbleParts(text, extra, root) {
  const sp = splitImgs(text);
  const nums = [...sp.text.matchAll(/\[Image #(\d+)\]/g)].map((m) => Number(m[1]));
  const words = sp.text.replace(/\[Image #\d+\][ \t]*/g, "").replace(/\n{3,}/g, "\n\n").trim();
  const all = [...sp.imgs, ...(Array.isArray(extra) ? extra : [])].filter((x, i, a) => a.indexOf(x) === i);
  const imgs = all.filter((x) => imgOk(root, x)).slice(0, MAX_IMGS);
  // pictures that may not be drawn (saved by an older version outside the app folder) and placeholders without one stay small chips
  const lost = all.length - imgs.length;
  const chips = [...nums.slice(imgs.length), ...Array.from({ length: Math.max(0, lost - nums.length) }, (_, i) => nums.length + i + 1)].slice(0, MAX_IMGS);
  return { text: words, imgs, chips };
}
// The shape a picture is drawn in: fits [w,h] into maxW x maxH keeping its proportions (never enlarged); unknown size -> 4:3.
function fitImg(w, h, maxW = 240, maxH = 200) {
  if (!(Number(w) > 0 && Number(h) > 0)) return { w: Math.min(200, maxW), h: Math.min(150, maxH) };
  const ow = Number(w), oh = Number(h);
  const k = Math.min(1, maxW / ow, maxH / oh);
  return { w: Math.max(24, Math.round(ow * k)), h: Math.max(18, Math.round(oh * k)) };
}
// The width (px) a message bubble asks for: the text's longest line at 12.5px (Korean and other wide glyphs ~13.5px, Latin ~7.4px) plus the
// bubble's padding and border, never under `min`. The bubble is then `w(this).max_w(80%)`: it hugs a short line and stops at the same
// share of the row as the left bubbles on a long one, and does not depend on how a text view reports its own intrinsic width.
function bubbleWidth(text, min = 64) {
  let widest = 0;
  for (const ln of String(text ?? "").split("\n")) {
    let w = 0;
    for (const ch of ln) w += ch.charCodeAt(0) < 0x250 ? 7.4 : 13.5;
    widest = Math.max(widest, w);
  }
  return Math.max(min, Math.ceil(widest * 1.05) + 28);
}
// ---- scroll: stay pinned to the newest while it is at the bottom
const PIN_SLACK = 40; // "at the bottom" means within this many px of it
// One look at the timeline's scroll handle: `st` = {pinned, ct} from the last look, `o` = {y, vh, ch} (offset, viewport and content height now).
// Content that grew while the view was pinned (a row came, the dots appeared, a picture loaded) -> go: scroll to the end again. A view the
// person scrolled up (nothing grew, yet it is not near the end) is not pinned any more and keeps its place.
function pinStep(st, o) {
  const y = Number(o?.y) || 0, vh = Number(o?.vh) || 0, ch = Number(o?.ch) || 0;
  const was = st ? st.pinned !== false : true;
  const prev = Number(st?.ct) || 0;
  const grew = ch > prev + 1;
  const near = y + vh >= ch - PIN_SLACK;
  if (near) return { pinned: true, ct: ch, go: was && grew && y + vh < ch - 1 };
  if (was && grew) return { pinned: true, ct: ch, go: true };
  return { pinned: false, ct: ch, go: false };
}
// ---- selection: a drag-selected text must not be rebuilt under the pointer
const SEL_HOLD_MS = 120000, PRESS_HOLD_MS = 8000;
// st = {sel: a selection is settled, selAt, press: the pointer is down in the list, pressAt}. While true, background redraws wait.
const quietNow = (st, now) => Boolean((st?.sel && now - (st.selAt || 0) < SEL_HOLD_MS) || (st?.press && now - (st.pressAt || 0) < PRESS_HOLD_MS));

// chat:end

// Diagnostics for the desk (what the pointer and the selection do), kept in a small capped file the leader can read: <app root>/data/inbox/diag.log,
// 0600; past DIAG_MAX it is moved to diag.log.1 (the older half is dropped) and a new one starts. Lines carry ids and lengths only, never message text.
const DIAG_MAX = 64 * 1024;
function diagAppend(lines, root = appRoot()) {
  const dir = path.join(root, "data", "inbox");
  const f = path.join(dir, "diag.log");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  let size = 0;
  try { size = fs.statSync(f).size; } catch {}
  if (size > DIAG_MAX) fs.renameSync(f, f + ".1");
  const text = (Array.isArray(lines) ? lines : []).slice(0, 60).map((x) => String(x).replace(/[\r\n]+/g, " ").slice(0, 300)).join("\n") + "\n";
  const fd = fs.openSync(f, "a", 0o600);
  try { try { fs.fchmodSync(fd, 0o600); } catch {} fs.writeSync(fd, text); } finally { fs.closeSync(fd); }
  return f;
}
module.exports = { unwrapTags, mdText, IMG_TOTAL_MAX, pruneImages, diagAppend, DIAG_MAX, appRoot, imgRel, fitImg, bubbleWidth, imgSize, imageDims, imgDir, sniffExt, saveImage, importImage, clipImage, transcriptImages, pendingImagePids, MAX_IMG_BYTES, imgOk, imgLine, splitImgs, bubbleParts, MAX_IMGS, pinStep, PIN_SLACK, quietNow, PO_OTHER, cleanPoId, poId, poProject, poList, poFile, leaderOwner, choosePick, composeChat, parseMention, enterIntent, needsNewline, strayBreak, imeHold, holdShown, strayHeld, editCore, HELD_BREAK_MS, TL_GAP_MS, timeline, groupTimeline, unreadCount, seenNext, CHAT_FILTERS, filterEntries, filterCounts, tlKey, tlFollow, atBottom, chatHtml, chatRecord, setChatStatus, mineNote, mineActs, ENTER_TTL_MS, liveStatus, badgeTurn, cleanText, promptTail, promptSame, PROMPT_TIMER, typingNow, statusSig, promptOptions, promptSig, inputHas, keepWaiting, snapBase, snapStep, SNAP_TTL_MS, tlId, CHAT_KINDS, CHAT_STATUS, dockTarget, decisionOptions, mentionQuery, leaderMenu, chatTarget, parsePoLines, hookLine, readPo, markAnswered, waitingKind, leaderName, rememberNames, liveName, parseBody, toParts, escapeHtml, inlineSegs, linkLabel, enrich, parseLines, openAsk, summarize, collect, findPo, answerLine, inboxDir, KINDS };

if (require.main === module) {
  // `node inbox.cjs`            -> the panel's data (JSON)
  // `node inbox.cjs clipimg`    -> {"path": <saved picture of the clipboard>|null}
  // `node inbox.cjs addimg <f>` -> {"path": <saved copy of the picture file f>|null}
  const [cmd, arg] = process.argv.slice(2);
  const shown = (p) => { let d = null; try { const buf = fs.readFileSync(p).subarray(0, 65536); d = imgSize(buf); } catch {} return { path: p || null, ...(d ? { w: d[0], h: d[1] } : {}) }; };
  if (cmd === "clipimg") process.stdout.write(JSON.stringify(shown(clipImage())));
  else if (cmd === "diag") { try { diagAppend(JSON.parse(arg)); } catch {} process.stdout.write("{}"); }
  else if (cmd === "addimg") process.stdout.write(JSON.stringify(shown(importImage(arg))));
  else process.stdout.write(JSON.stringify(collect()));
}
