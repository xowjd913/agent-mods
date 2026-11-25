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
      title: typeof o.title === "string" ? o.title : "",
      body: typeof o.body === "string" ? o.body : "",
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
  let html = "", list = false;
  const closeList = () => { if (list) { html += "</ul>"; list = false; } };
  const flush = () => { closeList(); if (html) parts.push({ t: "prose", html }); html = ""; };
  for (const b of blocks ?? []) {
    if (b.t === "code") { flush(); parts.push({ t: "code", text: b.text, html: escapeHtml(b.text), depth: b.depth ?? 0 }); continue; }
    if (b.t === "gap") { closeList(); continue; }
    if (b.t === "h") { flush(); parts.push({ t: "h", html: segsHtml(b.segs), text: plain(b.segs) }); continue; }
    if (b.t === "li" && b.mark === "•" && !b.depth) {
      if (!list) { html += "<ul>"; list = true; }
      html += `<li>${segsHtml(b.segs)}</li>`;
      continue;
    }
    closeList();
    const pad = INDENT.repeat(Math.min(b.depth ?? 0, 4));
    html += b.t === "li" ? `<p>${pad}${escapeHtml(b.mark)} ${segsHtml(b.segs)}</p>` : `<p>${pad}${segsHtml(b.segs)}</p>`;
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
// unknown fields are ignored. `to` is who the line answers (an hc name or "here"), "" when absent.
function parsePoLines(text) {
  const out = [];
  for (const raw of String(text ?? "").split("\n")) {
    let o;
    try { o = JSON.parse(raw); } catch { continue; }
    if (!o || o.kind !== "say" || typeof o.text !== "string" || !o.text.trim()) continue;
    const ms = Date.parse(o.ts);
    if (!(ms > 0)) continue;
    out.push({ ts: new Date(ms).toISOString(), ms, text: o.text.trim().slice(0, MAX_PO_TEXT), to: typeof o.to === "string" ? o.to.trim() : "" });
  }
  out.sort((a, b) => a.ms - b.ms);
  return out.slice(-MAX_PO);
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
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith(".jsonl") && n !== OLD_PO_FILE); } catch { return { at: new Date().toISOString(), leaders: [], po: {} }; }
  const leaders = [];
  for (const n of names) {
    try {
      const s = summarize(n.replace(/\.jsonl$/, ""), readTail(path.join(dir, n)));
      if (s.items.length) leaders.push(s);
    } catch {}
  }
  leaders.sort((a, b) => (b.last?.ms ?? 0) - (a.last?.ms ?? 0));
  return { at: new Date().toISOString(), leaders, po: readPo(dir) };
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
// Follow-the-newest rule of the chat lines: scroll to the bottom when the window opens (no key seen yet) or a new line arrived, but
// not while the person has scrolled up to read. `up` is how far (px) the wheel has moved up from the bottom.
const chatKey = (lines) => { const l = (lines ?? [])[(lines ?? []).length - 1]; return l ? `${lines.length}|${l.ms}|${l.me ? 1 : 0}|${l.text}` : ""; };
const chatWheel = (up, dy) => Math.max(0, Math.min(4000, (Number(up) || 0) + (Number(dy) || 0)));
const chatFollow = (seen, key, up) => key !== "" && key !== seen && (Number(up) || 0) <= 4;
// chat:end

module.exports = { PO_OTHER, cleanPoId, poId, poProject, poList, poFile, leaderOwner, choosePick, composeChat, parseMention, enterIntent, needsNewline, strayBreak, imeHold, holdShown, chatKey, chatWheel, chatFollow, mentionQuery, leaderMenu, chatTarget, parsePoLines, readPo, markAnswered, waitingKind, leaderName, rememberNames, liveName, parseBody, toParts, escapeHtml, inlineSegs, linkLabel, enrich, parseLines, openAsk, summarize, collect, findPo, answerLine, inboxDir, KINDS };

if (require.main === module) process.stdout.write(JSON.stringify(collect()));
