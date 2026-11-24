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

// One leader: {leader, terminal, items (newest first, KEEP at most), open (the unanswered decision/verify or null), last (newest item)}.
function summarize(leader, text) {
  const items = parseLines(text);
  const named = leader || items.find((i) => i.leader)?.leader || "";
  const newest = items.slice(-KEEP).reverse();
  return {
    leader: named,
    terminal: items.length ? items[items.length - 1].terminal : "",
    open: openAsk(items),
    ask: [...items].reverse().find((i) => ASK_KINDS.has(i.kind)) ?? null, // the newest decision/verify even if answered: shown while the wait label is still on
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

// The PO: the terminal that the lead-* terminals hang under. `terms` are Herdr's terminals() entries ({address, name, parent}).
// Prefer the parent shared by most leaders; ties go to the claude-code one. null when no lead-* terminal has a live parent.
function findPo(terms, leaderName) {
  const list = terms ?? [];
  const byAddr = new Map(list.map((t) => [t.address, t]));
  const count = new Map();
  for (const t of list) {
    if (!/^lead-/.test(String(t.name ?? "")) || !t.parent || !byAddr.has(t.parent)) continue;
    count.set(t.parent, (count.get(t.parent) ?? 0) + 1);
  }
  const own = list.find((t) => leaderName && t.name === leaderName)?.parent;
  if (own && byAddr.has(own)) return byAddr.get(own).address;
  const ranked = [...count.entries()].sort((a, b) => b[1] - a[1]);
  return ranked[0]?.[0] ?? null;
}

// The line typed into the PO terminal. One line (newlines folded to spaces) so the submit keeps it as a single user message.
function answerLine(kind, leader, text, link) {
  const body = String(text ?? "").replace(/\s*\n\s*/g, " ").trim();
  return `Panel answer (${kind}) for ${leader}: "${body}".${link ? ` Target: ${link}` : ""}`;
}

module.exports = { parseLines, openAsk, summarize, collect, findPo, answerLine, inboxDir, KINDS };

if (require.main === module) process.stdout.write(JSON.stringify(collect()));
