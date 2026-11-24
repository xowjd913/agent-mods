// Inbox helper: reads the leader reports in ~/.herdr-inbox/<leader>.jsonl (one JSON object per line, written by `report`)
// and sorts them into the panel's two lanes. Pure functions plus one CLI: `node inbox.cjs` prints {at, leaders:[...]} as JSON.
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
    });
  }
  return out;
}

// The newest decision/verify line that no later `answered` line closed; null when there is none.
function openAsk(items) {
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i].kind === "answered") return null;
    if (ASK_KINDS.has(items[i].kind)) return items[i];
  }
  return null;
}

// ---- Readable bodies. A report body is markdown-ish text written by an agent. parseBody turns it into a small list of blocks the
// panel draws (no HTML; anything it does not know stays plain text):
//   {t:"h", segs}                 a heading: "## x", or a short line that ends with ":" ("되돌리기:")
//   {t:"li", segs, mark, depth}   "- x" / "* x" (mark "•") or "1. x" (mark "1."), indented by leading spaces
//   {t:"p", segs}                 a paragraph line
//   {t:"code", text}              a command: a ``` fence, a "$ x" line, a line that is only `x`, or a shell command after "설치:"
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

// Splits "cmd cmd cmd 한글 설명 cmd2 ..." into command and prose pieces: a command starts at a command word and runs until the next
// token with Hangul in it. Returns [{cmd:boolean, v}]; only used right after a label such as "설치:".
function splitCommands(rest) {
  const toks = String(rest).trim().split(/\s+/);
  const out = [];
  let cur = null;
  const flush = () => { if (cur?.v.length) out.push({ cmd: cur.cmd, v: cur.v.join(" ").replace(/[,;]$/, "") }); cur = null; };
  for (let i = 0; i < toks.length; i++) {
    const tk = toks[i];
    const hangul = HANGUL.test(tk);
    if (cur?.cmd) {
      if (hangul) { flush(); cur = { cmd: false, v: [tk] }; } else cur.v.push(tk);
    } else if (!hangul && !cur && CMD_START.test(toks.slice(i, i + 2).join(" ")) ) cur = { cmd: true, v: [tk] };
    else if (!hangul && cur && !cur.cmd && CMD_START.test(toks.slice(i, i + 2).join(" "))) { flush(); cur = { cmd: true, v: [tk] }; }
    else { cur ??= { cmd: false, v: [] }; cur.v.push(tk); }
  }
  flush();
  return out;
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
    if (lab && !/^https?$/i.test(lab[1]) && CMD_START.test(lab[2])) {
      const pieces = splitCommands(lab[2]);
      if (pieces.some((x) => x.cmd)) {
        para(`${lab[1]}:`, kind, mark ? { mark, depth } : {});
        for (const x of pieces) { if (x.cmd) blocks.push({ t: "code", text: x.v, depth }); else para(x.v, "p", { depth }); }
        return;
      }
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
      const pieces = CMD_START.test(m[2]) ? splitCommands(m[2]) : [];
      if (pieces.some((x) => x.cmd)) for (const x of pieces) { if (x.cmd) blocks.push({ t: "code", text: x.v, depth: 0 }); else para(x.v, "p", {}); }
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
function enrich(it) {
  if (!it || it.blocks) return it;
  it.blocks = parseBody(it.body);
  it.head = it.title.replace(/^\[[^\]]*\]\s*/, "").trim();
  const first = it.blocks.find((b) => b.t === "p" || b.t === "li");
  let lead = first ? plain(first.segs) : "";
  if (!it.head && !lead) lead = plain(it.blocks.find((b) => b.t === "h")?.segs) || it.title;
  it.leadFull = lead.length > MAX_LEAD;
  it.lead = it.leadFull ? `${lead.slice(0, MAX_LEAD - 1)}…` : lead;
  const content = it.blocks.filter((b) => b.t !== "gap");
  it.long = content.length > 1 || it.leadFull;
  return it;
}

// One leader: {leader, terminal, items (newest first, KEEP at most), open (the unanswered decision/verify or null), last (newest item)}.
function summarize(leader, text) {
  const items = parseLines(text);
  const named = leader || items.find((i) => i.leader)?.leader || "";
  const newest = items.slice(-KEEP).reverse();
  newest.forEach(enrich);
  const ask = [...items].reverse().find((i) => ASK_KINDS.has(i.kind)) ?? null;
  enrich(ask);
  const open = openAsk(items);
  enrich(open);
  return {
    leader: named,
    terminal: items.length ? items[items.length - 1].terminal : "",
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

function collect(dir = inboxDir()) {
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith(".jsonl")); } catch { return { at: new Date().toISOString(), leaders: [] }; }
  const leaders = [];
  for (const n of names) {
    try {
      const s = summarize(n.replace(/\.jsonl$/, ""), readTail(path.join(dir, n)));
      if (s.items.length) leaders.push(s);
    } catch {}
  }
  leaders.sort((a, b) => (b.last?.ms ?? 0) - (a.last?.ms ?? 0));
  return { at: new Date().toISOString(), leaders };
}

// Which terminal is a waiting leader: a terminal named lead-* with the wait label decision|verify; returns that kind or "".
// ONE rule for the tab-row count (tabs-mine), the summary pane and the Dock badge. The two mods cannot require a .cjs file, so the
// line below is copied verbatim into inbox/main.js and tabs-mine/main.js and a test checks that all three stay identical.
const waitingKind = (t) => (/^lead-/.test(String(t?.name ?? "")) ? (["decision", "verify"].find((k) => k === String(t.labels?.wait ?? "").trim().toLowerCase()) ?? "") : "");

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

module.exports = { waitingKind, parseBody, inlineSegs, linkLabel, enrich, parseLines, openAsk, summarize, collect, findPo, answerLine, inboxDir, KINDS };

if (require.main === module) process.stdout.write(JSON.stringify(collect()));
