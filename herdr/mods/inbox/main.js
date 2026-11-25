// PO 데스크 (mod id "inbox"): the leaders' reports (~/.herdr-inbox/<leader>.jsonl, written by `report`) and the PO's own lines
// (~/.herdr-inbox/po/<po id>.jsonl).
//  - One PO at a time: a PO terminal carries the labels role=po and po=<id>; the picker lists the live ones and the pick (kept in
//    shared state) decides which leaders' cards, wait counts, "@" menu, chat target and PO lines are shown. A leader belongs to the PO
//    that is its live terminal's parent (else the PO its reports name); the rest sits under "PO 모름", which cannot chat.
//  - The right pane is ONE list: open decision/verify asks pinned on top, then the latest reports (newest first), one short row each
//    (leader, kind badge, first line). A row opens the floating window at that item; the counts are small badges in the pane header.
//  - The window is the chat view, in two lanes:
//  - "결정 필요": leaders whose terminal has a wait label (decision|verify): their last decision/verify report, with
//    "링크 열기", "확인 완료" (verify only) and "답 쓰기".
//  - "결과 보고": every other report (done, stop, ...) as per-leader bubbles, newest first.
// A leader's name opens `terminal.peek` on its terminal. An answer is delivered as real user input: the line goes on the clipboard,
// the PO pane (the leader terminal's parent, only when it has the label role=po) is focused and the clipboard is pasted into it
// (terminal.paste). The answer buttons leave Enter to the person, which doubles as a last check. Files are read by inbox.cjs; this mod
// only reads them.
// The chat box is different: Enter there sends AND submits. The text goes in the same way (clipboard, focus, terminal.paste: the PO sees
// it as the person's own typing), then Enter is pressed with `hc keys <PO> enter` (herdr.d.ts hc(); `hc keys --help`: "Press named
// keys", no <hc from=...> tag, which the tagged send command adds). Shift+Enter is a line break; the line breaks stay in the paste.

import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, TextareaState, Textarea, TextView, ScrollHandle } from "gpui-base";
import { theme, exec, appHome, checking, window, run, hc, terminals, panes, focused, setBadge, shared, setShared, props, openOverlay, closeOverlay, watchFolder, pickFiles, home, readTextFile } from "herdr";

const HELPER = () => `${appHome()}/mods/inbox/inbox.cjs`;
const ICON = (name) => `mods/workspace-chrome/${name}.svg`;
const LOAD_TIMEOUT = 20000, LOAD_STALL_MS = 30000, WINDOW_REFRESH_MS = 5000, PANE_REFRESH_MS = 30000, STATUS_POLL_MS = 1500, WATCH_DEBOUNCE_MS = 250;
const KIND = { done: ["완료", "working"], decision: ["결정", "blocked"], verify: ["확인", "blocked"], stop: ["중단", "idle"], resume: ["재개", "dim"], other: ["알림", "dim"], start: ["시작", "dim"] };
const WINDOW = { mod: "inbox", kind: "window", key: "inbox", keep: true, width: 720, height: 680, props: { mode: "window" } };
const SENT_KEY = "inbox.sent";
const PICK_KEY = "inbox.po"; // the PO id the person picked last (shared, so it also holds across window reopens)
const CHAT_KEY = "inbox.chat"; // the lines the person sent through the chat box [{ts, ms, text, to, po}] (po: the PO id they went to)
const MAX_CHAT = 100, MAX_ENTRIES = 80; // MAX_ENTRIES: the newest timeline entries drawn (a waiting one is always drawn)
const SNAP_KEY = "inbox.snap"; // {<room id>: {seen, ts}}: the "안 읽은 것" base of a room as it was when opened, shared by every copy for a while
const SEEN_KEY = "inbox.seen"; // {<room id>: ms of the newest message the person had on screen when last opening that room}
const WIDE_MIN = 520; // two columns (rooms | room) from this width; narrower: the window shows the rooms as a strip on top, the dock and a pane as the slim column
const ROOM_W = 168, SLIM_W = 58; // the window's room list / the dock's slim room column (initial circle + badges, the project as the tooltip)
const PASTE_SETTLE_MS = 350; // the PO terminal takes the paste before Enter is pressed
const PANE_POLL_MS = 300, PANE_WAIT_MS = 6000; // a send to a PO with no pane: how often / how long to wait for the pane the send opened
const PROMPT_TIMEOUT_MS = 5000; // a screen read that has not answered by then is given up (the next one may start)
const PROMPT_REFRESH_MS = 3000, PROMPT_LINES = 40; // a blocked PO's screen is re-read this often while shown (the last PROMPT_LINES lines are read)
const BADGE_KEY = "inbox.badge"; // {id, ts}: the copy (dock / pane) that writes the app icon badge
const OPEN_KEY = "inbox.expanded"; // cards the person opened ("자세히"), shared so they stay open across re-renders and window reopens
const MAX_OPEN = 60;
const NO_PO = "이 리더의 PO 터미널을 찾지 못했습니다(리더 터미널의 부모가 role=po 라벨이어야 합니다).";
const OTHER_LABEL = "PO 모름";
const OTHER_TIP = "PO를 알 수 없는 리더와 보고: 이미 닫힌 리더인데 보고 줄에 po가 없고 그 PO도 지금 없는 것(이 변경 전에 쓴 보고 줄 등). 여기서는 채팅을 보낼 수 없습니다";
const CLIP = "답을 클립보드에 담아 PO 터미널에 붙여 넣고 Enter까지 눌러 보냅니다(PO가 질문 중이면 붙여 넣기만 합니다). 클립보드 내용이 바뀝니다.";

// Which terminal is a waiting leader. Copied verbatim from inbox.cjs (a test keeps them identical); tabs-mine uses the same line.
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

// The PO of a leader: its terminal's parent, only when that parent has the label role=po (no guessing). Same rule as inbox.cjs
// findPo; kept here because the mod cannot require a .cjs file.
function findPo(terms, leaderName, address) {
  const list = terms ?? [];
  const leader = (leaderName && list.find((t) => t.name === leaderName)) || (address && list.find((t) => t.address === address)) || null;
  const parent = leader?.parent ? list.find((t) => t.address === leader.parent) : null;
  return parent && String(parent.labels?.role ?? "").trim().toLowerCase() === "po" ? parent.address : null;
}

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
// Memo for the text work a redraw repeats (#47): every render compares each of the person's messages with each sent record and strips the
// wrapper tags (regex) of every bubble again; one very long paste made that slow enough that the host cut the render off ("interrupted").
// Keyed by kind + the text itself, bounded (cleared when full). Only for pure functions of the text.
const TL_MEMO_MAX = 2000;
const tlMemo = new Map(); // kind -> Map(text -> result); the text itself is the key (no joined key string built per lookup)
function tlMemoGet(kind, v, make) {
  const s = String(v ?? "");
  let m = tlMemo.get(kind);
  if (!m) tlMemo.set(kind, (m = new Map()));
  let r = m.get(s);
  if (r !== undefined) return r;
  r = make(s);
  if (m.size >= TL_MEMO_MAX) m.clear();
  m.set(s, r);
  return r;
}
const TL_CUT_MIN = 500;
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
  const full = (v) => tlMemoGet("f", v, (s) => tnorm(unwrapTags(s)));
  const core = (v) => tlMemoGet("c", v, (s) => { const sp = splitImgs(s); return `${tnorm(sp.text)}|${sp.imgs.join(",")}`; });
  // The PO hook keeps at most 2000 characters of a typed line and ends a longer one in "…" (#49), so its copy of a long desk send is only the
  // start of that send: a line ending in "…" also matches a record whose text starts with what is left (at least TL_CUT_MIN characters after
  // whitespace is squeezed, so a short line that merely ends in "…" does not hide a longer send). "" when the line is not such a cut.
  const cut = (v) => { const s = String(v ?? ""); if (!s.endsWith("…")) return ""; const p = full(s.slice(0, -1)); return p.length >= TL_CUT_MIN ? p : ""; };
  if (room && room !== PO_OTHER) for (const x of says ?? []) {
    if (x.me) {
      const t = full(x.text), c = core(x.text), p = cut(x.text);
      const i = sentBy.findIndex((m, j) => !taken.has(j) && (x.ms - (Number(m.ms) || 0)) >= -60000 && (x.ms - (Number(m.ms) || 0)) <= 11 * 60000 && (full(m.line) === t || full(m.text) === t || (c.length > 1 && (core(m.line) === c || core(m.text) === c)) || (p && (full(m.line).startsWith(p) || full(m.text).startsWith(p)))));
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
const promptTail = (text, n = 10) => cleanText(text).split("\n").map((l) => l.trimEnd()).filter((l) => l.trim() && !PROMPT_TIMER.test(l)).slice(-n).map((l) => (l.length > 140 ? `${l.slice(0, 139)}…` : l));
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
function chatHtml(text) { return tlMemoGet("h", text, chatHtmlRaw); }
function chatHtmlRaw(text) {
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
// Who is writing right now: the room's PO (its own terminal is working) and its leaders that have work going on -> [{who, name}] (PO first,
// then the leaders by shown name). `who` is the timeline owner key ("po" or "l:<hc name>"), the same the entries use. Pure; the dots
// bubbles read this, never the unread counts. For the "PO 모름" room only leaders count (there is no PO terminal to watch).
// A leader's own hc status is "working" only during its own turns: while it waits for a team member it reads "done" or idle. So a leader has
// work going on when its terminal OR any terminal below it (the `parent` chain) is working or blocked (waiting for a permission), and for
// TYPING_GRACE_MS after the last such moment (`track`, kept by typingSync) so a short gap does not make the dots flicker. The grace ends
// earlier when the leader posts a report (the report bubble replaces the dots) or its terminal is gone. Status only, never screen text.
const isWorking = (t) => String(t?.status ?? "").trim().toLowerCase() === "working";
const isBusy = (t) => { const s = String(t?.status ?? "").trim().toLowerCase(); return s === "working" || s === "blocked"; };
const TYPING_GRACE_MS = 30000;
const TYPING_HOPS = 8; // how far up the parent chain a busy terminal marks its owners (and a loop guard)
// The addresses with work at or below them: every busy terminal and each terminal on its parent chain.
function busyAddrs(terms) {
  const list = terms ?? [];
  const byAddr = new Map();
  for (const t of list) if (t?.address) byAddr.set(t.address, t);
  const hot = new Set();
  for (const t of list) {
    if (!isBusy(t) || !t.address) continue;
    let cur = t;
    for (let i = 0; cur && i <= TYPING_HOPS; i++) {
      if (hot.has(cur.address)) break; // its owners are marked already (also ends a loop)
      hot.add(cur.address);
      cur = cur.parent ? byAddr.get(cur.parent) : null;
    }
  }
  return hot;
}
// What each address has at or below it, from the hc status of the terminals only: Map<address, {self, work, block}> where self is its own
// "working"/"blocked" (or null), work/block say that it or any terminal below it (the `parent` chain) is working / blocked.
function workStates(terms) {
  const list = terms ?? [];
  const byAddr = new Map();
  for (const t of list) if (t?.address) byAddr.set(t.address, t);
  const st = new Map();
  const get = (a) => { let e = st.get(a); if (!e) { e = { self: null, work: false, block: false }; st.set(a, e); } return e; };
  for (const t of list) {
    if (!isBusy(t) || !t.address) continue;
    const s = String(t.status).trim().toLowerCase();
    get(t.address).self = s;
    let cur = t;
    for (let i = 0; cur && i <= TYPING_HOPS; i++) {
      const e = get(cur.address);
      if (s === "blocked") e.block = true; else e.work = true;
      cur = cur.parent ? byAddr.get(cur.parent) : null;
    }
  }
  return st;
}
// The short label (5 chars at most) beside the dots, from real status only; "" when nothing is worth saying. Priority: waiting for an
// approval (itself or a member) > its own work > a team member's work > only the grace of the last work left (nobody works now).
const LABEL_BLOCKED = "승인 대기", LABEL_WORKING = "작업중", LABEL_TEAM = "팀원 작업", LABEL_GRACE = "잠시 대기";
function typingLabel(states, address) {
  const e = states?.get(address);
  if (e?.block) return LABEL_BLOCKED;
  if (e?.self === "working") return LABEL_WORKING;
  if (e?.work) return LABEL_TEAM;
  return LABEL_GRACE;
}
// The newest shown report of every leader as ms: Map<hc name, ms> from the loaded summaries [{leader, items}].
function leaderSaid(leaders) {
  const m = new Map();
  for (const s of leaders ?? []) {
    let x = 0;
    for (const it of s?.items ?? []) if (tlShown(it)) x = Math.max(x, Number(it.ms) || 0);
    if (x && s?.leader) m.set(s.leader, x);
  }
  return m;
}
// Keeps `track` (Map<hc name, {at, rep, stop, on}>) up to date: at = when work was last seen, on = it was seen at the last sync, rep = the newest
// report seen, stop = a report came after the work began (no grace). Call it with the same terminals and `said` (leaderSaid) the dots are drawn from.
function typingSync(track, terms, said, now) {
  const list = terms ?? [];
  const hot = busyAddrs(list);
  const busy = new Set(), live = new Set();
  for (const t of list) {
    const n = String(t?.name ?? "");
    if (!/^lead-/.test(n)) continue;
    live.add(n);
    if (hot.has(t.address)) busy.add(n);
  }
  for (const n of live) {
    const r = Number(said?.get(n)) || 0;
    let e = track.get(n);
    if (!e) {
      if (!busy.has(n)) continue;
      e = { at: 0, rep: r, stop: false, on: false };
      track.set(n, e);
    }
    if (busy.has(n) && !e.on) e.stop = false; // new work after a quiet moment starts a fresh grace
    if (r > e.rep) { e.rep = r; e.stop = true; }
    if (busy.has(n)) { e.on = true; e.at = now; }
    else { e.on = false; if (e.stop || now - e.at > TYPING_GRACE_MS) track.delete(n); }
  }
  for (const n of [...track.keys()]) if (!live.has(n)) track.delete(n); // the terminal is gone
}
const typingGrace = (e, now) => Boolean(e) && !e.on && !e.stop && e.at > 0 && now - e.at <= TYPING_GRACE_MS;
// The leaders that are only in their grace now, as one text: the poll adds it to statusSig so the dots go away at the end of the grace.
function graceKey(track, now) {
  const out = [];
  for (const [n, e] of track ?? []) if (typingGrace(e, now)) out.push(n);
  return out.sort().join(",");
}
function typingNow(terms, room, memo, track = null, now = 0) {
  const list = terms ?? [];
  const out = [];
  if (!room) return out;
  if (room !== PO_OTHER) {
    const po = poList(list).find((p) => p.id === room);
    const term = po ? list.find((t) => t.address === po.address) : null;
    if (term && isWorking(term)) out.push({ who: "po", name: po.label, label: LABEL_WORKING });
  }
  const hot = busyAddrs(list), states = workStates(list);
  const seen = new Set();
  const leaders = [];
  for (const t of list) {
    const n = String(t?.name ?? "");
    if (!/^lead-/.test(n) || seen.has(n) || leaderOwner(list, n, t.address) !== room) continue;
    if (!hot.has(t.address) && !typingGrace(track?.get(n), now)) continue;
    seen.add(n);
    leaders.push({ who: `l:${n}`, name: leaderName(n, t, memo), label: typingLabel(states, t.address) });
  }
  leaders.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return [...out, ...leaders];
}
// A short text that changes exactly when something the desk shows from the terminals changes: the status, the wait label and the shown
// name of every PO and leader, and whether a leader has work below it (a team member working). The 1.5 s poll redraws a copy only when this
// differs from the last one (no redraw on a quiet second).
function statusSig(terms) {
  const rows = [];
  const hot = busyAddrs(terms), states = workStates(terms);
  for (const t of terms ?? []) {
    const lead = /^lead-/.test(String(t?.name ?? ""));
    if (!lead && !poId(t)) continue;
    rows.push(`${t.address}|${String(t.status ?? "")}|${lead ? waitingKind(t) : ""}|${lead ? liveName(t) : ""}|${lead && hot.has(t.address) ? 1 : 0}|${lead && hot.has(t.address) ? typingLabel(states, t.address) : ""}`);
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
// merely mentions a tag in the middle of a sentence keeps it. Pure. WRAP_CLOSE starts with (?<![ \t]) so a long run of blanks is tried from its
// first blank only (without it every blank starts a new attempt that runs to the end: quadratic).
const WRAP_OPEN = /^[ \t]*<[\\/]{0,2}(?:hc|pasted_content)\b[^<>\n]*>[ \t]*/gim;
const WRAP_CLOSE = /(?<![ \t])[ \t]*<\\?\/(?:hc|pasted_content)\b[^<>\n]*>[ \t]*$/gim;
function unwrapTags(text) {
  const t = String(text ?? "");
  if (!t.includes("<")) return t;
  return tlMemoGet("u", t, (s) => s.replace(/\r\n?/g, "\n").replace(WRAP_OPEN, "").replace(WRAP_CLOSE, "").replace(/\n{3,}/g, "\n\n").trim());
}
// A long message drawn in a bubble (#47): at most LONG_LINES lines and LONG_CHARS characters until the person presses "더 보기", so one huge
// paste (a whole log) cannot make every redraw lay out thousands of lines. -> {text, cut: true when something was left out, more: chars left out}.
// The 복사 chip still copies the whole text. Pure.
const LONG_LINES = 14, LONG_CHARS = 1500;
function clipLong(text) {
  const s = String(text ?? "");
  let end = Math.min(s.length, LONG_CHARS), n = 0, i = -1;
  while ((i = s.indexOf("\n", i + 1)) !== -1 && i < end) if (++n >= LONG_LINES) { end = i; break; }
  if (end >= s.length) return { text: s, cut: false, more: 0 };
  return { text: s.slice(0, end).trimEnd(), cut: true, more: s.length - end };
}
const moreLabel = (more) => `더 보기 · ${String(Math.max(0, Number(more) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}자 더`;
// Where the **bold** runs of a Markdown text (the string given to TextView.markdown) sit, as [{start,end}] UTF-16 offsets into that same string,
// markers included. The TextView draws no heavier weight for them (it ignores bold), so main.js paints a tint behind these ranges instead.
// Fenced blocks and `code spans` are skipped, a \\* is not a marker, an opening ** must be followed and a closing ** preceded by a non-blank.
// Bounded: a line over 2000 chars, work past 20000 chars or more than 100 ranges is left plain. Pure.
function boldRanges(md) {
  const out = [];
  let fence = false, pos = 0, work = 0;
  for (const ln of String(md ?? "").split("\n")) {
    const at = pos;
    pos += ln.length + 1;
    if (/^\s*(?:```|~~~)/.test(ln)) { fence = !fence; continue; }
    if (fence || ln.length > 2000 || !ln.includes("**")) continue;
    work += ln.length;
    if (work > 20000 || out.length >= 100) break;
    let m = ln, i = 0;
    while (i < m.length) { // blank out the code spans (same length, so the offsets stay)
      if (m[i] === "\\") { i += 2; continue; }
      if (m[i] !== "`") { i++; continue; }
      let n = 1;
      while (m[i + n] === "`") n++;
      const run = "`".repeat(n);
      let j = m.indexOf(run, i + n);
      while (j !== -1 && m[j + n] === "`") j = m.indexOf(run, j + n + 1);
      if (j === -1) { i += n; continue; }
      m = m.slice(0, i) + " ".repeat(j + n - i) + m.slice(j + n);
      i = j + n;
    }
    i = 0;
    while (i < m.length - 1 && out.length < 100) {
      if (m[i] === "\\") { i += 2; continue; }
      if (m[i] === "*" && m[i + 1] === "*" && i + 2 < m.length && !/[\s*]/.test(m[i + 2])) {
        let j = m.indexOf("**", i + 2);
        while (j !== -1 && (/\s/.test(m[j - 1]) || m[j - 1] === "\\" || m[j + 2] === "*")) j = m.indexOf("**", j + 1);
        if (j !== -1) { out.push({ start: at + i, end: at + j + 2 }); i = j + 2; continue; }
        i += 2; continue;
      }
      i++;
    }
  }
  return out;
}
// A message text as Markdown for a TextView.markdown(...).raw_html(false): wrapper tags removed first (they would print literally), a line that
// is only 【...】 made bold, images switched off (![x](y) -> a plain link), and single line breaks kept as line breaks (Markdown would join them).
// Code fences are left as written. Never produces HTML: the view shows tags as text. Pure.
function mdText(text) { return tlMemoGet("m", text, mdTextRaw); }
function mdTextRaw(text) {
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
function splitImgs(text) { return tlMemoGet("s", unwrapTags(text), splitImgsRaw); }
function splitImgsRaw(text) {
  const imgs = [];
  const keep = [];
  for (const ln of String(text).split("\n")) {
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

// ---- highlight colours: the band behind **bold** runs, from the theme's own tokens.
// A colour is "#rrggbb" + an alpha byte. The alpha starts strong (so the area is clearly visible) and steps down only while the text colour
// would stop being readable on the blended result (contrast < HL_MIN_CONTRAST), so it holds on a light and a dark theme alike.
const HL_MIN_CONTRAST = 3.5;
const HL_KINDS = {
  bold: { alpha: 0x73, floor: 0x40, tokens: ["accent", "ansi4", "foreground"] }, // about 45%
};
const HEX6 = /^#[0-9a-f]{6}$/i;
// A theme colour as "#rrggbb": "#rgb" is expanded and "#rrggbbaa" loses its alpha (the tint sets its own); anything else -> null.
const hex6 = (c) => {
  if (typeof c !== "string") return null;
  if (HEX6.test(c)) return c.toLowerCase();
  if (/^#[0-9a-f]{3}$/i.test(c)) return "#" + [...c.slice(1)].map((x) => x + x).join("").toLowerCase();
  if (/^#[0-9a-f]{8}$/i.test(c)) return c.slice(0, 7).toLowerCase();
  return null;
};
const rgbOf = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const lumOf = (h) => {
  const [r, g, b] = rgbOf(h).map((v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrastOf = (a, b) => { const x = lumOf(a), y = lumOf(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
const blendHex = (top, under, a) => { const u = rgbOf(under); return "#" + rgbOf(top).map((v, i) => Math.round(v * a + u[i] * (1 - a)).toString(16).padStart(2, "0")).join(""); };
// kind -> "#rrggbbaa", or null when the theme has no usable token (the caller then paints nothing and logs it once, see tintMiss).
function tintHex(t, kind) {
  const k = HL_KINDS[kind];
  const base = k && k.tokens.map((n) => hex6(t?.[n])).find(Boolean);
  if (!base) return null;
  let a = k.alpha;
  const bg = hex6(t.background), fg = hex6(t.foreground);
  if (bg && fg) {
    while (a > k.floor && contrastOf(fg, blendHex(base, bg, a / 255)) < HL_MIN_CONTRAST) a = Math.max(k.floor, a - 8);
  }
  return base + a.toString(16).padStart(2, "0");
}
// Why tintHex gave nothing: the tokens it looked at and what they held (colours only), for one diag line.
const tintMiss = (t, kind) => `highlight ${kind}: no usable theme token (${(HL_KINDS[kind]?.tokens ?? []).map((n) => `${n}=${JSON.stringify(t?.[n] ?? null)}`).join(" ")}); nothing painted`;
// A TextView selection event -> {start, end} (UTF-16 offsets into the Markdown source), or null when it carries no usable range.
// `len` is the length of the string the view was given: a range past it belongs to an older text and is dropped.
function selRangeOf(sel, len) {
  const r = sel?.range ?? sel;
  const a = Number(r?.start), b = Number(r?.end);
  return Number.isInteger(a) && Number.isInteger(b) && a >= 0 && b > a && b <= len ? { start: a, end: b } : null;
}

// ---- bubble width: every message bubble (mine on the right, the PO's and the leaders' on the left) stops at a share of the chat column, so a long
// text wraps inside it and never reaches the opposite edge. `colW` is the chat column's width in px (null = not known yet).
const BUBBLE_SHARE = 0.75, BUBBLE_SIDE = 90, BUBBLE_MIN_CAP = 40;
// The chat column: the view's width less the room list beside it (none in a strip).
const chatColW = (winW, strip, narrow, roomW, slimW) => { const w = Number(winW); return Number.isFinite(w) && w > 0 ? Math.max(0, w - (strip ? 0 : narrow ? slimW : roomW)) : null; };
// The px a bubble may take: 75% of the column, and always leaving BUBBLE_SIDE px (the copy chip, the time, the gutters) on its other side, so
// the bubble and its chip fit the column down to narrow docks (150px column -> 60, 200 -> 110, 260 -> 170); only a column under ~130px gets the
// BUBBLE_MIN_CAP floor (a few characters), and the cap is never wider than the column itself. `minInner` is the widest picture (with its padding):
// when it fits beside the chip (minInner <= column - BUBBLE_SIDE) the cap is raised to it, as before; a column narrower than that keeps the cap
// and the caller scales the pictures down to it. null: width unknown, the caller uses a percentage.
function bubbleCap(colW, minInner = 0) {
  const w = Number(colW);
  if (!(Number.isFinite(w) && w > 0)) return null;
  const room = Math.floor(w - BUBBLE_SIDE);
  const cap = Math.min(Math.floor(w), Math.max(BUBBLE_MIN_CAP, Math.min(Math.floor(w * BUBBLE_SHARE), room)));
  const pic = Math.ceil(Number(minInner) || 0);
  return pic > cap && pic <= room ? pic : cap;
}

// chat:end

// The pending-question card: the screen lines scroll inside it (all options stay reachable), the buttons stay under them.
const PROMPT_LINES_H = 240, PROMPT_MAX_H = 340;
const DIAG_FLUSH_MS = 2000; // the diag queue is written out this often (one timer started in init)
const PIN_TICK_MS = 250; // how often the timeline checks that it still sits at the newest
const LOAD_REDRAW_MS = 25000; // an unchanged load still redraws this often (the "5분 전" clocks)

// Opens an http(s) link with the app's own open_url when a context is at hand, else through the system opener.
function openUrl(url, cx) {
  if (!/^https?:\/\//i.test(url)) return;
  if (cx?.open_url) { try { cx.open_url(url); return; } catch {} }
  const p = window()?.platform;
  if (p === "macos") exec("open", [url]);
  else if (p === "windows") exec("powershell.exe", ["-NoProfile", "-Command", `Start-Process '${url.replace(/'/g, "''")}'`]);
  else exec("xdg-open", [url]);
}

// Opens a local file (a picture of a bubble) with the system's viewer.
function openFile(path) {
  const f = String(path ?? "");
  if (!f || /[\0\n]/.test(f)) return;
  const p = window()?.platform;
  if (p === "macos") exec("open", [f]);
  else if (p === "windows") exec("powershell.exe", ["-NoProfile", "-Command", `Start-Process -LiteralPath '${f.replace(/'/g, "''")}'`]);
  else exec("xdg-open", [f]);
}

// usageLine:begin
// The Claude usage line under the room title: "Claude 5h ▬ 54% · 7d ▬ 34%". It reads ~/.claude/usage-limits.json (written by the Claude Code
// status line; no network, no exec). The parsing is parseUsage of the usage-status mod plus the reset time; the mods cannot require each
// other, so it is a copy (a test keeps the rows of both equal). A file not updated for USAGE_STALE_MS is Unknown (null).
const USAGE_FILE = ".claude/usage-limits.json", USAGE_REFRESH_MS = 60 * 1000, USAGE_STALE_MS = 10 * 60 * 1000;
const USAGE_WARN = 80, USAGE_LABEL = { five_hour: "5h", seven_day: "7d" };
const USAGE_TRACK_W = 40, USAGE_TRACK_H = 3, USAGE_MIN_FILL = 2;
// The filled width (px) of a bar: 0 for <= 0 and NaN, at least USAGE_MIN_FILL above 0, never past the track.
function usageFill(percent, track = USAGE_TRACK_W) {
  const p = Number.isFinite(percent) ? Math.max(0, percent) : 0;
  return p === 0 ? 0 : Math.min(track, Math.max(USAGE_MIN_FILL, Math.round((p / 100) * track)));
}
// The file's text -> [{label, percent, resetsAt}] (resetsAt in ms, 0 when unknown) or null (Unknown: none, broken, stale, no 5h/7d row).
function parseUsage(raw, now) {
  if (!raw) return null;
  let data;
  try { data = JSON.parse(raw); } catch { return null; }
  const updated = Date.parse(data?.updatedAt ?? "");
  if (!Number.isFinite(updated) || now - updated > USAGE_STALE_MS) return null;
  const rows = (Array.isArray(data.limits) ? data.limits : [])
    .filter((l) => USAGE_LABEL[l?.kind] && Number.isFinite(l.percentUsed))
    .map((l) => ({ label: USAGE_LABEL[l.kind], percent: Math.round(l.percentUsed), resetsAt: Math.max(0, Date.parse(l.resetsAt ?? "") || 0) }));
  return rows.length ? rows : null;
}
// The time left until a reset as "2시간 15분" / "5일 4시간 41분" (zero units dropped); "1분 미만" under a minute, "" when unknown or past.
function usageLeft(ms, now) {
  const mins = Math.floor((ms - now) / 60000);
  if (!ms || !Number.isFinite(mins) || mins < 0) return "";
  if (mins === 0) return "1분 미만";
  const unit = [[Math.floor(mins / 1440), "일"], [Math.floor(mins / 60) % 24, "시간"], [mins % 60, "분"]];
  return unit.filter(([n]) => n > 0).map(([n, u]) => n + u).join(" ");
}
// The tooltip: the time left until the reset of every row that has one ("5h 초기화까지 2시간 15분 · 7d 초기화까지 5일 4시간 41분"), or why there are no numbers.
// It is computed when the line is drawn, so it is as fresh as the last redraw.
function usageTip(rows, now) {
  if (!rows) return "사용률을 알 수 없습니다: ~/.claude/usage-limits.json이 없거나 10분 넘게 갱신되지 않았습니다";
  const parts = rows.filter((r) => r.resetsAt).map((r) => { const left = usageLeft(r.resetsAt, now); return left ? `${r.label} 초기화까지 ${left}` : `${r.label} 초기화 시각이 지났습니다`; });
  return parts.length ? parts.join(" · ") : "초기화 시각 정보가 없습니다";
}
// usageLine:end

// costLine:begin
// One PO's current-session cost, shown after the usage line: "이 세션 약 4,300원". The numbers come from inbox.cjs (poCosts: the usage fields of the
// session transcript x the price table there x the fixed KRW rate there) as {usd, unknown, sub, partial, rate, rateNote}; this block only words them.
// It is an API-equivalent estimate, not the subscription bill. `unknown` lists the model ids that are not in the price table: the label is then
// "?원" (no guess). Copied between the markers into inbox/main.js and inbox.cjs (a test keeps them identical).
function costLabel(c) {
  if (!c || !Number.isFinite(c.usd)) return "";
  if ((Array.isArray(c.unknown) && c.unknown.length) || !(c.rate > 0)) return "?원";
  return `약 ${Math.round(c.usd * c.rate).toLocaleString("en-US")}원`;
}
function costTip(c) {
  if (!c || !Number.isFinite(c.usd)) return "";
  const unk = Array.isArray(c.unknown) && c.unknown.length;
  return [
    "이 PO의 현재 세션에서 쓴 금액: API 기준 추정 금액, 구독 청구액 아님",
    unk ? "" : `달러로는 $${c.usd >= 1000 ? Math.round(c.usd).toLocaleString("en-US") : c.usd.toFixed(2)}`,
    c.rate > 0 ? `환율 ${Number(c.rate).toLocaleString("en-US")}원/$ (${c.rateNote || "고정값"})` : "",
    c.sub > 0 ? "서브에이전트 포함" : "메인 세션만",
    unk ? `가격표에 없는 모델이라 합계를 내지 않았습니다: ${c.unknown.slice(0, 3).join(", ")}` : "",
    c.partial ? "아직 다 읽지 못해 더 늘 수 있습니다" : "",
    "빠른 모드·미국 데이터 거주 가격·웹 검색 같은 서버 도구 요금은 계산하지 않아 실제보다 적을 수 있습니다",
    "/clear 하면 0부터 다시 셉니다",
  ].filter(Boolean).join(" · ");
}
// costLine:end

function ago(iso) {
  const m = Math.floor((Date.now() - Date.parse(iso)) / 60000);
  if (!(m >= 0)) return "";
  if (m < 1) return "방금";
  if (m < 60) return `${m}분 전`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}시간 전` : `${Math.floor(h / 24)}일 전`;
}

// The time a message was written: HH:MM today, else month/day HH:MM (local time).
function clock(ms) {
  const d = new Date(Number(ms));
  if (Number.isNaN(d.getTime())) return "";
  const p = (n) => String(n).padStart(2, "0");
  const hm = `${p(d.getHours())}:${p(d.getMinutes())}`;
  return Date.now() - d.getTime() < 20 * 3600 * 1000 ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}

// A stable color per leader name, from the theme's ANSI colors.
function tint(t, name) {
  const pool = [t.ansi4, t.ansi5, t.ansi6, t.ansi2, t.ansi3, t.ansi1].filter(Boolean);
  if (!pool.length) return t.muted;
  let h = 0;
  for (const c of String(name)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return pool[h % pool.length];
}

const safeProps = () => { try { return props() ?? {}; } catch { return {}; } };
// A press the mod handles must not start a drag of the floating window.
const stop = (_e, cx) => cx.stop_propagation();

const NAMES_KEY = "leader.names"; // {<hc name>: session name}, shared with agent-groups: a closed leader keeps a readable name
const namesMemo = () => { try { return shared(NAMES_KEY) ?? {}; } catch { return {}; } };
// The shown name of a leader (by hc name): live terminal, else remembered, else the hc name.
function shortName(leader) {
  let list = [];
  try { list = terminals() ?? []; } catch {}
  return leaderName(leader, list.find((t) => t.name === leader), namesMemo());
}
// Remember the live names (only changes are written).
function rememberLeaders() {
  try {
    const next = rememberNames(namesMemo(), terminals() ?? []);
    if (next) setShared(NAMES_KEY, next);
  } catch {}
}

// One view, three places: the right Dock panel (no props; "창 열기", "옆에 열기"), a pane beside a terminal (`pane.split {mod: "inbox",
// props: {mode: "pane"}}`, closed by the pane's own header) and the floating window (an overlay, props().mode === "window"). Same
// timeline and chat box everywhere; the rooms are the full list from WIDE_MIN wide (a narrow window: a strip), else the slim column.
export default class Inbox extends View {
  init(_props, cx) {
    const mode = safeProps().mode;
    this.windowed = mode === "window"; // the floating window
    this.paned = mode === "pane"; // a pane of its own; neither is the Dock (no props), which owns the app-icon badge and the slow refresh
    this.badged = ""; // what this app's icon badge shows: only changes are sent, and a 0 at start leaves other mods' badges alone
    this.data = null;
    this.error = null;
    this.busy = false;
    this.busyAt = 0;
    this.gen = 0;
    this.compact = false;
    this.narrow = !this.windowed; // narrower than WIDE_MIN (until the first size report: the dock and a pane start narrow, the window wide)
    this.writing = null; // leader whose answer box is open
    this.inputs = new Map(); // leader -> InputState
    this.msg = null; // {text, bad}
    this.copied = null; // key of the command whose 복사 button just ran
    this.more = new Set(); // bubble ids the person opened with "더 보기" (#47: long messages start folded)
    this.chat = TextareaState.new({ value: "", rows: 1, placeholder: "PO에게 말하기 — Enter로 보내기, Shift+Enter로 줄바꿈, @로 리더 부르기, 그림은 붙여넣기" });
    try { this.chat.set_auto_grow(1, 6); } catch {}
    this.menu = null; // the open "@" menu: {start, end, query, items, sel}
    this.changedAt = 0; // the last edit of the box (ms)
    this.sentAt = 0; // the last send (ms)
    this.uid = Math.random().toString(36).slice(2, 8); // this copy of the desk (the badge lease, record ids)
    this.seq = 0;
    this.opening = new Set(); // PO terminals a send is waiting on (their pane is opening): one send per PO at a time
    this.backs = new Map(); // record id -> the pane that had the keyboard before the send (given back after Enter)
    this.prompt = null; // {po, at, text}: the screen tail of the picked room's PO while it waits on a prompt
    this.promptBusy = false;
    this.promptBusyAt = 0;
    this.promptGen = 0;
    this.promptChain = 0; // the newest scheduled re-read of the screen; an older one does nothing
    this.filt = new Map(); // room -> the chat filter chip picked there (전체 when missing); not saved: a restart shows every message again
    this.heldAt = 0; // the last Enter held back as a possible IME confirm (ms)
    this.nlAt = 0; // the last Shift+Enter handled (ms)
    this.core = ""; // the box text without trailing line breaks, as of the last change
    this.editAt = 0; // the last time that text changed (ms); the IME hold reads this, not changedAt
    this.pics = []; // pictures waiting in the box: [{path, w, h}] (saved under the inbox's po/img by the helper)
    this.picBusy = 0; // pictures being read from the clipboard / a file right now
    this.replyPics = new Map(); // leader -> pictures waiting in that leader's answer box (same shape as this.pics)
    this.replyBusy = new Map(); // leader -> pictures being read for that answer box
    this.imgd = new Map(); // path -> [w, h] of pictures added here (the helper's list covers the others)
    this.ui = { sels: new Map(), sel: false, selAt: 0, press: false, pressAt: 0 }; // a drag-select in the list: redraws wait while it is held
    this.dirty = false; // a redraw was held back
    this.pin = { pinned: true, ct: 0 }; // the timeline's pin to the newest (see pinStep)
    this.lastIdx = 0; // index of the last child of the list
    this.sigData = ""; // what the last load drew (without its clock)
    this.errSig = "";
    this.chat.on("paste_other", (_e, c) => this.pastePic(c)); // Cmd+V found no text: take a picture from the clipboard
    this.chat.on("change", (_e, c) => {
      this.changedAt = Date.now();
      let value = "";
      try { value = this.chat.value(); } catch {}
      const core = editCore(value); // an edit is a change of the text itself: the widget's own line break for an Enter is not one
      if (core !== this.core) { this.core = core; this.editAt = this.changedAt; }
      this.heldTick(c);
      if (strayBreak(value, this.sentAt, this.changedAt)) { try { this.chat.set_value(""); } catch {} return; } // the Enter that sent left a line break
      if (strayHeld(value, this.heldAt, this.changedAt)) { this.dropBreak(value); return; } // the held Enter left a line break
      this.syncMenu(c);
    });
    // The widget's own submit event: with Shift it is a line break, otherwise Enter. Both also arrive as a key press (inputKey); each
    // handler dedupes, so whichever the widget raises, one send / one line break happens.
    this.chat.on("submit", (e, c) => { if (this.menu) this.pickMenu(this.menu.sel, c); else this.enterBox(e?.shift ? "newline" : "send", c); });
    this.pickedAt = 0; // a menu pick just now: the Enter that made it must not also send
    this.tlSeen = ""; // tlKey of the timeline last drawn (follow-the-newest)
    this.drawnAt = 0; // the last time render ran: a view that is not drawn (hidden dock / window) is not reading
    // The scroll position of both lists is held by handles the view owns (not only by the element id), and every press that changes the
    // height of a card or a section asks for that spot to stay in view (see reveal).
    this.scroll = null; // the timeline
    try { this.scroll = ScrollHandle.new(); } catch {}
    this.at = new Map(); // spot key -> index of that child in the window's list, rebuilt on every frame
    if (checking()) return;
    this.watch = null; // the pending watchFolder call on the inbox folder (null: not watching)
    this.watchGen = 0;
    this.debounced = false;
    this.again = false; // a load was asked for while one ran: run it again when that one ends
    this.sig = null; // statusSig of the terminals at the last status poll
    this.typingAt = new Map(); // leader hc name -> {at, rep, stop, on}: who worked lately (the grace of the "···" bubble), see typingSync
    this.load(cx);
    // The Dock owns the slow refresh and (with any pane) the badge; the window and a pane are read on screen, so they refresh faster,
    // a pane only while it is being drawn (a pane in a tab nobody looks at does not poll).
    cx.timer.every(this.refreshMs(), (cx) => { if (!this.paned || this.drawing()) this.load(cx); });
    // The folder watch makes a new report or PO line appear at once; the timer above stays as the fallback (a watch that cannot start or
    // dies). The status poll makes the "···" bubbles, the blocked dots and the names follow the terminals within seconds.
    cx.timer.every(STATUS_POLL_MS, (cx) => this.pollStatus(cx));
    // The timeline keeps its place at the newest: the handle's numbers are those of the last layout, so content that grew after a draw (a
    // row, the dots, a picture that finished loading) is seen here and the view goes back to the bottom. A held-back redraw is let go
    // once the selection / press is over.
    cx.timer.every(PIN_TICK_MS, (cx) => this.pinTick(cx));
    cx.timer.every(DIAG_FLUSH_MS, () => this.flushDiag());
    this.usage = undefined; // the rows of the usage line: undefined before the first read, null = Unknown, else [{label, percent, resetsAt}]
    this.usageSig = "";
    this.loadUsage(cx);
    cx.timer.every(USAGE_REFRESH_MS, (cx) => this.loadUsage(cx));
    this.diag(`init: ${this.windowed ? "window" : this.paned ? "pane" : "dock"}`);
  }

  // Reads the usage file (a file read only) and redraws only when what the line shows (the rows or the tooltip text) changed: a redraw drops a drag-select.
  loadUsage(cx) {
    cx.spawn(async (cx) => {
      let raw = null;
      try { raw = await readTextFile(`${home()}/${USAGE_FILE}`); } catch {}
      const rows = parseUsage(raw, Date.now());
      const sig = JSON.stringify([rows, usageTip(rows, Date.now())]);
      this.usage = rows;
      if (sig === this.usageSig) return;
      this.usageSig = sig;
      this.softNotify(cx);
    });
  }

  // The usage line under the room title ("Claude 5h ▬ 54% · 7d ▬ 34%"); 80% and over is drawn in the warning color, the tooltip has the
  // time left until each reset. Nothing before the first read.
  usageLine(t, pick = "") {
    const rows = this.usage;
    // The picked PO's session cost ("이 세션 약 4,300원"), from the helper's data; nothing when the PO has no recorded session (or is the "PO 모름" room).
    const c = pick && pick !== PO_OTHER ? this.data?.cost?.[pick] : null;
    const cost = costLabel(c);
    const withCost = (el) => (cost ? el.child(div().flex_none().child("·")).child(div().id("inbox-cost").flex_none().tooltip(costTip(c)).child(`이 세션 ${cost}`)) : el);
    if (rows === undefined) return cost ? withCost(h_flex().id("inbox-usage").flex_none().h(22).px(this.compact ? 10 : 14).gap(6).items_center().overflow_hidden().text_size(11).text_color(t.dim)) : null;
    const track = this.narrow ? 28 : USAGE_TRACK_W;
    const line = h_flex().id("inbox-usage").flex_none().h(22).px(this.compact ? 10 : 14).gap(6).items_center().overflow_hidden().text_size(11).text_color(t.dim)
      .tooltip(usageTip(rows, Date.now())).child(div().flex_none().child("Claude"));
    if (!rows) return withCost(line.child(div().flex_none().text_color(t.muted).child("Unknown")));
    return withCost(rows.reduce((el, u, i) => {
      const warn = u.percent >= USAGE_WARN;
      return el
        .when(i > 0, (x) => x.child(div().flex_none().child("·")))
        .child(div().flex_none().child(u.label))
        .child(div().flex_none().w(track).h(USAGE_TRACK_H).rounded(USAGE_TRACK_H).bg(t.border)
          .child(div().h(USAGE_TRACK_H).w(usageFill(u.percent, track)).rounded(USAGE_TRACK_H).bg(warn ? t.blocked : t.foreground)))
        .child(div().flex_none().text_color(warn ? t.blocked : t.muted).child(`${u.percent}%`));
    }, line));
  }

  // ---- redraw gating (a drag-select must not be rebuilt under the pointer) and the pin to the newest
  pinTick(cx) {
    if (this.dirty && !quietNow(this.ui, Date.now())) { this.dirty = false; try { cx.notify(); } catch {} }
    if (!this.scroll || !this.drawnAt) return;
    try {
      const o = this.scroll.offset(), vp = this.scroll.viewport_size(), ct = this.scroll.content_size();
      const r = pinStep(this.pin, { y: o.y, vh: vp.height, ch: ct.height });
      // A scroll that is held back (drag / selection) leaves the pin as it was: pinned and the old content height stay, so the next tick after the
      // release still sees the growth and goes to the bottom (storing r.ct now would turn it into "pinned: false").
      if (r.go && quietNow(this.ui, Date.now())) return;
      this.pin = { pinned: r.pinned, ct: r.ct };
      if (r.go) this.scroll.scroll_to_item(this.lastIdx);
    } catch {}
  }

  // The pointer, seen by the window itself (passively, even over a TextView that takes its own presses): a left button held anywhere in the
  // desk is a press, so redraws and the bottom pin wait until it is released. The press gate used to live on the list's own mouse-down,
  // which a TextView that handles the press itself never lets through - the pin and redraws then ran under a drag and dropped the selection.
  pointer(e, cx) {
    if (e?.pressed_button === "left") { if (!this.ui.press) this.diag("press (left held, window move)", cx); this.ui.press = true; this.ui.pressAt = Date.now(); return; }
    if (this.ui.press) { this.diag("release (move without button)", cx); this.ui.press = false; if (this.dirty) this.softNotify(cx); }
  }
  // Diagnostics for the leader (the person does not read consoles): lines are buffered and written by inbox.cjs in one call at most every 2s
  // to <app root>/data/inbox/diag.log (capped, 0600). Ids and lengths only, never message text.
  // A view id for the diagnostics: a kind (its leading letters, "tl", "pp"...) and an 8-hex hash. Never the id itself: a timeline id holds the message text.
  diagId(id) {
    const s = String(id ?? "");
    let h = 5381;
    for (const ch of s) h = (Math.imul(h, 33) ^ ch.codePointAt(0)) >>> 0;
    return `${s.match(/^[A-Za-z]{1,8}/)?.[0] ?? "?"}~${h.toString(16).padStart(8, "0")}`;
  }
  // Only queues a line; flushDiag (a timer started in init, on the view's own cx) writes it. A caller never needs a timer of its own: render,
  // selection and pointer callbacks may carry a cx without .timer, which once made every line vanish.
  diag(msg, _cx) {
    try {
      const q = (this.diagQ ??= []);
      if (q.length < 40) q.push(`${new Date().toISOString()} ${msg}`);
    } catch {}
  }
  flushDiag() {
    try {
      if (this.diagBusy && Date.now() - (this.diagBusyAt ?? 0) < 15000) return; // a write that hung does not block the log for good
      const out = (this.diagQ ??= []).splice(0);
      if (!out.length) return;
      this.diagBusy = true;
      this.diagBusyAt = Date.now();
      Promise.resolve(exec("node", [HELPER(), "diag", JSON.stringify(out)], { timeout: 5000 })).catch(() => {}).then(() => { this.diagBusy = false; });
    } catch { this.diagBusy = false; }
  }
  // A press the list itself got (one a TextView did not take): counted against a settled selection and logged.
  listDown(e) {
    if (this.selMark) this.selMark.downs++;
    this.diag(`press (list mouse down), click ${e?.click_count ?? "?"}${this.ui.selAt && this.selMark ? `, ${Date.now() - this.ui.selAt}ms after the last settle` : ""}`);
  }
  // A held Enter whose second Enter never came (the person kept typing): the "한 번 더 Enter" hint goes away. The redraw respects the selection hold.
  heldTick(c) {
    if (this.heldAt && !holdShown(this.editAt, this.heldAt)) { this.heldAt = 0; this.softNotify(c); }
  }

  // The mod's own clear of a list selection (a press in the list, a press outside): the selection state and the diag mark go together, so no
  // "redraw while a selection is settled" line is written for a selection that is already gone.
  dropSel() {
    this.ui.sels.clear();
    this.ui.sel = false;
    this.selMark = null;
  }

  // One count per draw; a draw under a settled selection is logged (it would show a redraw that could clear the selection).
  noteRedraw(cx) {
    this.renderN = (this.renderN ?? 0) + 1;
    if (this.selMark) this.diag(`redraw #${this.renderN} while a selection is settled (${Date.now() - this.ui.selAt}ms after the settle)`, cx);
  }

  pointerUp(cx, e) {
    // A release seen after a settled selection is the clue to what cleared it: a press-and-release a moment after the settle is a second click
    // (the native view clears a selection on any press), not a redraw. Counts and ms only.
    const m = this.selMark, ago = this.ui.selAt ? Date.now() - this.ui.selAt : -1;
    if (m) { m.ups++; m.click = e?.click_count ?? 0; }
    this.diag(`release (window mouse up)${e?.click_count ? `, click ${e.click_count}` : ""}${m && ago >= 0 ? `, ${ago}ms after the last settle` : ""}`, cx);
    this.ui.press = false;
    if (this.dirty && !this.ui.sel) this.softNotify(cx);
  }

  // A background redraw: held back while a selection or a press is held (pinTick lets it go afterwards).
  softNotify(cx) {
    if (quietNow(this.ui, Date.now())) { this.dirty = true; return; }
    this.dirty = false;
    try { cx.notify(); } catch {}
  }

  // One diag line per kind when the theme gave nothing to paint with (the next redraws stay quiet).
  tintWarn(t, kind) {
    const w = (this.tintWarned ??= new Set());
    if (w.has(kind)) return;
    w.add(kind);
    this.diag(tintMiss(t, kind));
  }

  // A TextView's selection settled (sel) or cleared (null): only the hold on background redraws (ui.sel / selAt) and the diag.log lines, which
  // show whether a drag-copy sees the selection come and go (the range is logged when the app sends one). Nothing is painted for a selection.
  onSel(id, sel, cx) {
    this.ui.selEvents = (this.ui.selEvents ?? 0) + 1; // how often a TextView reported a selection at all (see the console line)
    const did = this.diagId(id), now = Date.now();
    const held = this.ui.selAt ? now - this.ui.selAt : -1; // ms since the last settle (a clear's age)
    const rg = sel ? selRangeOf(sel, Infinity) : null;
    this.diag(sel
      ? `selection settled in ${did} id=${String(id).slice(0, 40)}: ${String(sel.text ?? "").length} chars, range ${rg ? `${rg.start}-${rg.end}` : "missing"} (#${this.ui.selEvents})`
      : `selection cleared in ${did} id=${String(id).slice(0, 40)}${held >= 0 ? `, ${held}ms after the last settle` : ""}${this.selMark ? `; since the settle: ${(this.renderN ?? 0) - this.selMark.renders} redraws, ${this.selMark.ups} mouse ups, ${this.selMark.downs} list presses${this.selMark.click ? `, last click ${this.selMark.click}` : ""}` : ""} (#${this.ui.selEvents})`, cx);
    try { console.log(`[inbox] selection ${sel ? `settled in ${did}: ${String(sel.text ?? "").length} chars` : `cleared in ${did}`} (#${this.ui.selEvents})`); } catch {}
    if (sel) this.ui.sels.set(id, true); else this.ui.sels.delete(id);
    this.ui.sel = this.ui.sels.size > 0;
    if (sel) { this.ui.selAt = now; this.selMark = { renders: this.renderN ?? 0, ups: 0, downs: 0, click: 0 }; } else this.selMark = null;
    this.ui.press = false;
    if (this.dirty) this.softNotify(cx); // a redraw held back by the selection or a press goes out once nothing holds it (pinTick too)
  }

  // ---- pictures in the box
  // `key` is null for the PO box, or a leader name for that leader's answer box: every picture path below takes it, so the two boxes share one code.
  picsOf(key = null) { return key == null ? this.pics : (this.replyPics.get(key) ?? []); }
  busyOf(key = null) { return key == null ? this.picBusy : (this.replyBusy.get(key) ?? 0); }
  setPics(key, list) {
    if (key == null) this.pics = list;
    else if (list.length) this.replyPics.set(key, list);
    else this.replyPics.delete(key);
  }
  bumpBusy(key, n) {
    if (key == null) { this.picBusy = Math.max(0, this.picBusy + n); return; }
    const v = Math.max(0, (this.replyBusy.get(key) ?? 0) + n);
    if (v) this.replyBusy.set(key, v); else this.replyBusy.delete(key);
  }
  async addPic(args, c, key = null) {
    this.bumpBusy(key, 1);
    try { c.notify(); } catch {}
    try {
      const r = await exec("node", [HELPER(), ...args], { timeout: 20000 });
      if (r.code !== 0) throw new Error((r.stderr || "").trim().split("\n").pop() || `종료 코드 ${r.code}`);
      const o = JSON.parse(r.stdout);
      if (!o?.path) throw new Error("그림이 없습니다");
      if (o.w > 0 && o.h > 0) this.imgd.set(o.path, [o.w, o.h]);
      const cur = this.picsOf(key);
      if (cur.length >= MAX_IMGS) this.say(`그림은 한 번에 ${MAX_IMGS}장까지 붙일 수 있습니다.`, true);
      else if (!cur.some((x) => x.path === o.path)) this.setPics(key, [...cur, { path: o.path, w: o.w ?? 0, h: o.h ?? 0 }]);
      this.msg = null;
    } catch (e) { this.say(`그림을 붙이지 못했습니다: ${String(e?.message ?? e).slice(0, 140)}`, true); }
    finally { this.bumpBusy(key, -1); try { c.notify(); } catch {} }
  }
  pastePic(c, key = null) { return this.addPic(["clipimg"], c, key); }
  async pickPics(c, key = null) {
    let files = null;
    try { files = await pickFiles({ prompt: "그림 붙이기", multiple: true }); } catch (e) { this.say(`파일을 고르지 못했습니다: ${String(e?.message ?? e).slice(0, 120)}`, true); try { c.notify(); } catch {} return; }
    for (const f of (files ?? []).slice(0, MAX_IMGS)) await this.addPic(["addimg", f], c, key);
  }
  dropPics(paths, c, key = null) { for (const f of (paths ?? []).slice(0, MAX_IMGS)) this.addPic(["addimg", f], c, key); }
  removePic(i, c, key = null) { this.setPics(key, this.picsOf(key).filter((_x, k) => k !== i)); try { c.notify(); } catch {} }

  // The thumbnail chips of a box (with ✕) and the "reading…" note, or null when it holds nothing. One drawing for both boxes; `pre` keeps the ids apart.
  picRow(t, key = null) {
    const pics = this.picsOf(key);
    const busy = this.busyOf(key);
    if (!pics.length && !busy) return null;
    const pre = key == null ? "pic" : `rpic-${key}`;
    return h_flex().gap(6).items_center().flex_wrap()
      .children(pics.map((x, i) => h_flex().id(`${pre}-${i}`).flex_none().h(44).pl(4).pr(6).gap(6).items_center().rounded(8).bg(t.raised).border(1).border_color(t.border)
        .child(this.thumb(t, x))
        .child(div().max_w(110).truncate().text_size(10.5).text_color(t.muted).child(String(x.path).split(/[\\/]/).pop()))
        .child(div().id(`${pre}-x-${i}`).px(4).rounded(5).text_size(12).text_color(t.dim).cursor_pointer().on_mouse_down("left", stop)
          .hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click((_e, c) => this.removePic(i, c, key)).tooltip("이 그림 빼기").child("✕"))))
      .when(busy > 0, (x) => x.child(div().text_size(10.5).text_color(t.dim).child("그림을 읽는 중…")));
  }

  // The watch runs only while this copy is drawn; a copy nobody looks at releases it (a closed copy is released by the runtime).
  stopWatch() {
    this.watchGen++;
    const w = this.watch;
    this.watch = null;
    try { w?.cancel(); } catch {}
  }

  // Starts watching the inbox folder (its path comes from the collector) unless it already is. A change reloads after a short quiet
  // time (a burst of writes is one load). An error or a watch that ended on its own leaves the timer to read and the next poll to retry.
  startWatch(cx) {
    const dir = this.data?.dir;
    if (this.watch || !dir || typeof dir !== "string") return;
    const mine = ++this.watchGen;
    cx.spawn(async (cx) => {
      while (mine === this.watchGen) {
        let w;
        try { w = watchFolder(dir); } catch { break; }
        this.watch = w;
        let paths = [];
        try { paths = await w; } catch { paths = []; }
        if (mine !== this.watchGen) return; // cancelled (not drawn, or a newer watch took over)
        if (!Array.isArray(paths) || !paths.length) break;
        if (!this.debounced) {
          this.debounced = true;
          try { cx.timer.after(WATCH_DEBOUNCE_MS, (c) => { this.debounced = false; if (mine === this.watchGen) this.load(c); }); } catch { this.debounced = false; }
        }
      }
      if (mine === this.watchGen) this.watch = null;
    });
  }

  // Every STATUS_POLL_MS: keep the watch while drawn (release it when not), and redraw only when what the desk shows from the terminals
  // (statuses, wait labels, names) changed since the last poll.
  pollStatus(cx) {
    if (!this.drawing()) { this.stopWatch(); return; }
    this.startWatch(cx);
    let sig = "";
    try {
      const terms = this.liveTerms(), now = Date.now();
      this.syncTyping(terms, now);
      sig = `${statusSig(terms)}\n~${graceKey(this.typingAt, now)}`; // the grace running out changes this, so the dots are redrawn away
    } catch { return; }
    if (sig === this.sig) return;
    const first = this.sig === null;
    this.sig = sig;
    if (first) return;
    this.badge();
    this.softNotify(cx);
  }

  refreshMs() { return this.windowed || this.paned ? WINDOW_REFRESH_MS : PANE_REFRESH_MS; }
  // Was this copy drawn lately (within two refreshes)? A view that is not drawn is not being read. Never drawn yet counts as drawing.
  drawing() { return !this.drawnAt || Date.now() - this.drawnAt <= this.refreshMs() * 2 + 2000; }

  // The "···" memory from the live terminals and the reports loaded so far (see typingSync).
  syncTyping(terms, now) { try { typingSync(this.typingAt, terms, leaderSaid(this.data?.leaders), now); } catch {} }
  // Who is writing now in the picked room: working (or blocked) leaders, those with a team member working, and those in their grace.
  typing(v) {
    const now = Date.now();
    this.syncTyping(v.terms, now);
    return typingNow(v.terms, v.pick, namesMemo(), this.typingAt, now);
  }

  // The number of leaders that wait on a decision, on the app icon badge. ONE copy writes it at a time: the Dock or a pane, whichever holds
  // the lease in shared state (BADGE_KEY; renewed while it keeps loading, taken over when its holder went quiet); the window never writes.
  // tabs-mine counts the wait labels itself for the tab-row button (even with the panel closed).
  badge() {
    if (this.windowed) return;
    const asks = this.asks();
    this.pruneSent(asks);
    const n = asks.length;
    const text = n > 0 ? String(n) : "";
    try {
      const now = Date.now(), lease = shared(BADGE_KEY);
      if (badgeTurn(lease, this.uid, now) !== "write") return;
      if (lease?.id !== this.uid) this.badged = null; // just took over: write the number again
      if (lease?.id !== this.uid || now - (Number(lease.ts) || 0) > 20000) setShared(BADGE_KEY, { id: this.uid, ts: now });
    } catch {}
    if (text !== this.badged) { this.badged = text; try { setBadge(text || null); } catch {} }
  }

  // The "pasted into the PO" marker lives in shared state (keyed by leader), so the window and the pane see the same one even after
  // the window closed and reopened. It matches only the same ask (kind, report time, link); the pane drops it once the leader stops waiting.
  askKey(a) { return `${a.kind}|${a.item?.ts ?? ""}|${a.link}`; }
  // "sent" (Enter was pressed), "held" (pasted only, the person presses Enter) or "" (nothing delivered for this ask).
  sentOf(a) { try { const v = shared(SENT_KEY)?.[a.s.leader], k = this.askKey(a); return v === k ? "sent" : v === k + "|held" ? "held" : ""; } catch { return ""; } }
  // The pictures (and reads in flight) of an answer box whose leader is no longer waiting are dropped, so the two Maps never grow with old leaders.
  pruneReply(asks) {
    const live = new Set(asks.map((a) => a.s.leader));
    for (const m of [this.replyPics, this.replyBusy]) for (const k of [...m.keys()]) if (!live.has(k)) m.delete(k);
    for (const [k, st] of [...this.inputs]) if (!live.has(k)) { try { if (String(st.value() ?? "") !== "") st.set_value(""); } catch {} } // an old draft must not reappear on the leader's next card
  }
  pruneSent(asks) {
    try {
      const cur = shared(SENT_KEY) ?? {};
      const keep = Object.fromEntries(Object.entries(cur).filter(([k]) => asks.some((a) => a.s.leader === k)));
      if (Object.keys(keep).length !== Object.keys(cur).length) setShared(SENT_KEY, keep);
    } catch {}
  }

  // Which cards are open ("자세히"): shared state keyed by leader|report time, newest MAX_OPEN kept.
  cardKey(s, it) { return `${s.leader}|${it?.ts ?? ""}`; }
  isOpen(s, it) { try { return Boolean(shared(OPEN_KEY)?.[this.cardKey(s, it)]); } catch { return false; } }
  toggleOpen(s, it) {
    try {
      const cur = { ...(shared(OPEN_KEY) ?? {}) };
      const k = this.cardKey(s, it);
      if (cur[k]) delete cur[k]; else cur[k] = 1;
      const keys = Object.keys(cur);
      for (const old of keys.slice(0, Math.max(0, keys.length - MAX_OPEN))) delete cur[old];
      setShared(OPEN_KEY, cur);
    } catch {}
  }

  // Keeps the spot a press changed (a card that opened or closed, a section that folded, an answer box) in view: scroll_to_item moves
  // nothing while the child is already visible, so a list that kept its place stays still, and one that lost it comes back to that spot
  // instead of the top. No pixel offset is readable from the handle, so "in view" is the most this can promise.
  reveal(key) {
    try { const i = this.at.get(key); if (i !== undefined) this.scroll?.scroll_to_item(i); } catch {}
  }
  spot(s, it) { return `c|${this.cardKey(s, it)}`; }

  // A command's copy button: exactly that text goes on the clipboard (no paste, no send); the button says "복사됨" for a moment.
  copy(key, text, cx) {
    try { cx.write_to_clipboard(String(text)); } catch (e) { this.say(`복사하지 못했습니다: ${String(e?.message ?? e).slice(0, 120)}`, true); this.softNotify(cx); return; }
    this.copied = key;
    this.softNotify(cx); // a selection held in another bubble is not rebuilt by this
    try { cx.timer.after(1800, (c) => { if (this.copied === key) { this.copied = null; this.softNotify(c); } }); } catch {}
  }

  // "옆에 열기": the PO desk as a pane beside the tab's leader (else the focused terminal); a tab that has one already focuses it.
  // From the window the window closes after (the pane would otherwise be hidden under it).
  openBeside() {
    this.msg = null;
    try {
      const f = focused();
      const here = (panes() ?? []).filter((p) => p.tab === f?.tab); // panes() lists every tab: only the one being shown
      const d = dockTarget(here, f, terminals() ?? []);
      if (d.action === "focus") run("pane.focus", { pane: d.pane });
      else run("pane.split", { direction: "right", mod: "inbox", props: { mode: "pane" }, ...(d.pane ? { pane: d.pane } : {}) });
      if (this.windowed) { try { closeOverlay(safeProps().overlay); } catch {} }
    } catch (e) { this.say(`옆에 열지 못했습니다: ${String(e?.message ?? e).slice(0, 120)}`, true); }
  }

  openWindow() {
    this.msg = null;
    try { openOverlay(WINDOW); } catch (e) { this.say(`창을 열지 못했습니다: ${String(e?.message ?? e).slice(0, 120)}`, true); }
  }

  load(cx) {
    if (this.busy && Date.now() - this.busyAt < LOAD_STALL_MS) { this.again = true; return; }
    this.again = false;
    const gen = ++this.gen;
    this.busy = true;
    this.busyAt = Date.now();
    cx.spawn(async (cx) => {
      try {
        const r = await exec("node", [HELPER()], { timeout: LOAD_TIMEOUT });
        if (r.code !== 0) throw new Error(`수집기 종료 코드 ${r.code} ${(r.stderr || "").trim()}`);
        const d = JSON.parse(r.stdout);
        if (gen !== this.gen) return;
        // The cost enters the signature as what is drawn (label + tooltip, whole cents), never the raw numbers, so a working PO's tokens do not redraw the desk.
        const shown = {};
        for (const [po, c] of Object.entries(d?.cost ?? {})) shown[po] = [costLabel(c), costTip(c)];
        const sig = JSON.stringify({ ...d, cost: shown, at: 0 });
        this.changed = sig !== this.sigData || Boolean(this.error) || !this.data || Date.now() - this.drawnAt > LOAD_REDRAW_MS;
        this.sigData = sig;
        this.data = d;
        this.error = null;
        rememberLeaders();
        this.markSeen();
        if (this.drawing()) this.startWatch(cx);
      } catch (e) { if (gen === this.gen) { this.error = `불러오기 실패: ${String(e?.message ?? e).slice(0, 180)}`; this.changed = true; } }
      finally {
        if (gen === this.gen) {
          this.busy = false;
          this.badge();
          // An unchanged answer is not redrawn (a redraw rebuilds every row and drops a drag-select); the clock still moves now and then.
          if (this.changed || !this.drawnAt) this.softNotify(cx);
          if (this.again) this.load(cx);
        }
      }
    });
  }

  // The live terminal of a leader: by name first, else by the address its reports carry.
  terminalOf(s) {
    const list = terminals() ?? [];
    return list.find((t) => t.name === s.leader) ?? list.find((t) => t.address === s.terminal) ?? null;
  }

  // Leaders whose terminal carries a wait label: [{s, term, kind, link, item}]. A leader is a live terminal named lead-* (the same rule
  // tabs-mine uses for the tab-row count). The text is its last decision/verify report; with no report file the label alone makes the
  // card (kind and wait-link only), as the contract says.
  asks() {
    const out = [];
    const list = terminals() ?? [];
    for (const term of list) {
      const kind = waitingKind(term);
      if (!kind) continue;
      const s = (this.data?.leaders ?? []).find((l) => l.leader === term.name) ?? (this.data?.leaders ?? []).find((l) => l.terminal === term.address)
        ?? { leader: term.name, terminal: term.address, open: null, ask: null, items: [], last: null };
      const item = s.ask ?? s.open;
      out.push({ s, term, kind, item, po: findPo(list, term.name, term.address), owner: leaderOwner(list, term.name, term.address, s.po), link: String(term?.labels?.["wait-link"] ?? "").trim() || item?.link || "" });
    }
    return out.sort((a, b) => (b.item?.ms ?? 0) - (a.item?.ms ?? 0));
  }

  // Everything else, newest first: not start/answered lines, and not the report a lane-1 card already shows. Each carries its owner PO.
  reports(asks) {
    const shown = new Set(asks.map((a) => `${a.s.leader}|${a.item?.ts}`));
    const list = this.liveTerms();
    const out = [];
    for (const s of this.data?.leaders ?? []) {
      const owner = leaderOwner(list, s.leader, s.terminal, s.po);
      for (const it of s.items) {
        if (it.kind === "answered" || it.kind === "start" || shown.has(`${s.leader}|${it.ts}`)) continue;
        out.push({ s, it, owner });
      }
    }
    return out.sort((a, b) => b.it.ms - a.it.ms);
  }

  // What the window shows: the rooms (the live POs, plus "PO 모름" while a leader or report belongs to none), the picked one with its
  // timeline, and the dock's lists. `tabs` [{id, label, title, blocked, n, unread}]: blocked = the room's PO waits on a prompt, n = the waiting leaders of that room, unread = its messages newer
  // than the last time the window had it open (0 for the room on screen). `entries` = the picked room's grouped timeline (newest last);
  // `raw` = all of it, before the cut to MAX_ENTRIES.
  view() {
    const terms = this.liveTerms();
    const pos = poList(terms);
    const all = this.asks();
    this.pruneReply(all);
    const reps = this.reports(all);
    const hasOther = all.some((a) => a.owner === PO_OTHER) || reps.some((r) => r.owner === PO_OTHER);
    let last = "";
    try { last = shared(PICK_KEY) ?? ""; } catch {}
    const pick = choosePick(pos, last, hasOther);
    let mine = [], seen = {};
    try { mine = shared(CHAT_KEY) ?? []; } catch {}
    try { seen = shared(SEEN_KEY) ?? {}; } catch {}
    const leaders = (this.data?.leaders ?? []).map((s) => ({ s, owner: leaderOwner(terms, s.leader, s.terminal, s.po) }));
    const now = Date.now();
    const waits = (id) => all.filter((a) => a.owner === id).map((a) => ({ leader: a.s.leader, ts: a.item?.ts ?? "", kind: a.kind }));
    const room = (id) => timeline(id, leaders, id === PO_OTHER ? [] : this.data?.po?.[id] ?? [], mine, waits(id), now);
    const rooms = pos.map((p) => ({ id: p.id, label: p.label, title: p.title, blocked: this.isBlocked(p.address) }));
    if (hasOther) rooms.push({ id: PO_OTHER, label: OTHER_LABEL, title: "", blocked: false });
    let raw = [];
    const tabs = rooms.map((r) => {
      const entries = room(r.id);
      if (r.id === pick) raw = entries;
      return { ...r, n: all.filter((a) => a.owner === r.id).length, unread: r.id === pick ? 0 : unreadCount(entries, seen[r.id]) };
    });
    const filter = pick ? this.filt.get(pick) ?? "all" : "all";
    let snaps = {};
    try { snaps = shared(SNAP_KEY) ?? {}; } catch {}
    const base = snapBase(snaps, pick, seen, now); // opening a room moves `seen` to now: filter by the marker from before (the same one in every copy)
    const shown = filterEntries(raw, filter, base);
    const keep = keepWaiting(raw, shown); // a leader still waiting on the person stays visible under any chip
    const entries = groupTimeline(keep.filter((e, i) => i >= keep.length - MAX_ENTRIES || e.waiting));
    return { terms, tabs, pick, raw, shown, filter, counts: filterCounts(raw, base), entries, asks: all.filter((a) => a.owner === pick), reports: reps.filter((r) => r.owner === pick) };
  }

  // Remembers that the person has the picked room's newest message on screen. Both the window and the dock show a room, so both
  // count — but only while the view is being drawn (a hidden dock keeps loading; that is not reading).
  markSeen() {
    if (!this.drawnAt || !this.drawing()) return; // never drawn, or not drawn lately: nobody has seen it
    try {
      const v = this.view();
      const was = shared(SEEN_KEY) ?? {};
      if (v.pick) { const st = snapStep(shared(SNAP_KEY), v.pick, was, Date.now()); if (st.next) setShared(SNAP_KEY, st.next); } // taken before the marker moves
      const next = seenNext(was, v.pick, v.raw);
      if (next) setShared(SEEN_KEY, next);
    } catch {}
  }

  setFilter(room, key, c) {
    if (!room) return;
    this.filt.set(room, key);
    c.notify();
  }

  // The chips above a room's timeline: 전체 | 안 읽은 것 | 결정 필요 | 최종 확인 요청 | 결과 | 멈춤, each with its count (0 = dim, still pressable).
  filterBar(t, v) {
    if (!v.pick || !v.raw.length) return null;
    return h_flex().flex_none().min_w(0).px(10).py(5).gap(5).items_center().flex_wrap().border_b(1).border_color(t.border)
      .children(CHAT_FILTERS.map(([k, label]) => {
        const on = v.filter === k, n = v.counts?.[k] ?? 0;
        return div().id(`flt-${k}`).flex_none().h(22).px(8).rounded(11).flex().items_center().cursor_pointer().text_size(11).on_mouse_down("left", stop)
          .bg(on ? t.selected : t.raised).border(1).border_color(on ? t.foreground + "40" : t.border).text_color(on ? t.foreground : n ? t.muted : t.dim)
          .when(!on && !n, (el) => el.opacity(0.6)).hover((x) => x.bg(t.hover).text_color(t.foreground))
          .on_click((_e, c) => this.setFilter(v.pick, k, c)).tooltip(k === "unread" ? "이 방을 열 때 아직 읽지 않았던 글만" : k === "all" ? "모든 글" : `${label}만 보기`).child(`${label} ${n}`);
      }));
  }

  pickPo(id, c) {
    this.heldAt = 0;
    try { setShared(PICK_KEY, id); } catch {}
    this.menu = null;
    this.markSeen();
    c.notify();
  }

  peek(s) {
    const term = this.terminalOf(s);
    if (term?.address) run("terminal.peek", { terminal: term.address });
    else this.say("그 리더 터미널이 지금 없습니다.", true);
  }

  say(text, bad = false) { this.msg = { text, bad }; }

  // The ONE way the panel puts text into a PO terminal (answer buttons, the answer box, option chips and the chat box):
  // clipboard -> focus the PO pane -> terminal.paste -> Enter after PASTE_SETTLE_MS (submitPo) -> the keyboard goes back to where it was.
  // Returns what happened to this call:
  //   "sent"    pasted and Enter is on its way (the record turns "sent" once the Enter went through, "noenter" if it did not)
  //   "held"    the PO is blocked on a prompt (Enter would answer it): pasted only, the person answers the prompt first
  //   "opening" the PO has no pane: it is opened and the text is delivered by itself once the pane exists (`ok(r)` runs then)
  //   "nopane"  the pane did not open in time / vanished again: nothing sent ("다시 보내기" on the bubble)
  //   "failed"  the paste command failed: nothing sent ("다시 보내기" on the bubble)
  //   "busy"    a send to this PO is still waiting for its pane: this one was not started
  // `rec` {text, line, to, po (the room), kind}: what the person wrote, recorded once at "sending" and moved on as the real outcome is known.
  // `id`/`opened`: a resend of that record / the second pass after the pane opened (never opens a pane a second time).
  deliver(po, text, c, rec = null, ok = null, id = "", opened = false) {
    text = cleanText(text); // nothing but plain text is pasted into a PO
    if (!opened && this.opening.has(po)) { this.say(`PO(${po})의 칸을 여는 중입니다. 열리면 먼저 보낸 글이 자동으로 갑니다.`, true); return "busy"; }
    if (!id) id = this.record({ ...rec, line: text }, "sending");
    try {
      c.write_to_clipboard(text);
      if (!this.backs.has(id)) { let fp = ""; try { fp = focused()?.pane ?? ""; } catch {} this.backs.set(id, fp); } // where the keyboard is now: given back after Enter
      const back = this.backs.get(id) ?? "";
      if (!(panes() ?? []).some((p) => p.terminal === po)) {
        if (opened) { this.mark(id, "nopane"); this.backs.delete(id); this.say(`PO(${po})의 칸이 열리지 않아 보내지 못했습니다. 말풍선의 '다시 보내기'를 누르세요.`, true); return "nopane"; }
        run("terminal.keep", { terminal: po }); // finishes in the background
        this.awaitPane(po, text, c, rec, ok, id);
        this.say(`PO(${po})에 칸이 없어 여는 중입니다. 열리면 자동으로 보냅니다.`);
        return "opening";
      }
      const blocked = this.isBlocked(po); // a prompt waits there: Enter would answer it
      run("pane.focus", { terminal: po }); // terminal.paste has no terminal argument: it pastes into the focused terminal
      try { run("terminal.paste", {}); }
      catch { this.mark(id, "failed"); this.restore(back, c, id); this.say(`PO(${po})에 붙여 넣지 못해 보내지 않았습니다. 말풍선의 '다시 보내기'를 누르세요.`, true); return "failed"; }
      if (blocked) { this.mark(id, "held"); this.restore(back, c, id, PASTE_SETTLE_MS); this.say(`PO(${po})가 질문에 답을 기다리는 중이라 붙여 넣기만 했습니다. 아래 질문에 먼저 답하세요.`); return "held"; }
      this.submitPo(po, c, PASTE_SETTLE_MS + Math.min(600, Math.floor(String(text).length / 2)), back, id); // a longer paste gets longer to land
      this.say(`PO(${po})에 보냈습니다.`);
      return "sent";
    } catch (e) { this.mark(id, "failed"); this.backs.delete(id); throw e; }
  }

  // A send to a PO with no pane: the pane is opening. Polls for it (PANE_POLL_MS, up to PANE_WAIT_MS) and delivers once, or gives up with "nopane".
  awaitPane(po, text, c, rec, ok, id) {
    this.opening.add(po);
    this.mark(id, "opening");
    const t0 = Date.now();
    const giveUp = (cx) => {
      this.opening.delete(po); this.backs.delete(id); this.mark(id, "nopane");
      this.say(`PO(${po})의 칸이 열리지 않아 보내지 못했습니다. 말풍선의 '다시 보내기'를 누르세요.`, true);
      try { cx.notify(); } catch {}
    };
    const poll = (cx) => {
      let has = false;
      try { has = (panes() ?? []).some((p) => p.terminal === po); } catch {}
      if (!has) {
        if (Date.now() - t0 >= PANE_WAIT_MS) { giveUp(cx); return; }
        try { cx.timer.after(PANE_POLL_MS, poll); } catch { giveUp(cx); }
        return;
      }
      const go = (c2) => { // `opening` stays set until the delivery is done: a second send in the settle gap is "busy", not a race
        try { const r = this.deliver(po, text, c2, rec, ok, id, true); if (r === "sent" || r === "held") { try { ok?.(r); } catch {} } }
        catch (e) { this.say(`붙여 넣지 못했습니다: ${String(e?.message ?? e).slice(0, 160)}`, true); }
        this.opening.delete(po);
        try { c2.notify(); } catch {}
      };
      try { cx.timer.after(PASTE_SETTLE_MS, go); } catch { go(cx); } // the new pane's terminal needs a moment before it takes a paste
    };
    try { c.timer.after(PANE_POLL_MS, poll); } catch { giveUp(c); }
  }

  isBlocked(po) { return String(this.liveTerms().find((t) => t.address === po)?.status ?? "").toLowerCase() === "blocked"; }

  // Gives the keyboard back after a send (Dock, window and pane alike): the pane that had it before, then this desk's box.
  restore(back, c, id = "", after = 0) {
    const go = (cx) => {
      if (id) this.backs.delete(id);
      if (back) { try { run("pane.focus", { pane: back }); } catch {} }
      try { this.chat.focus(); } catch {}
      try { cx.notify(); } catch {}
    };
    if (after > 0) { try { c.timer.after(after, go); return; } catch {} }
    go(c);
  }

  // One line of the person's own history per desk send (the timeline draws it as the right-hand bubble). Returns its id ("" when nothing was recorded).
  record(rec, status) {
    try {
      const x = chatRecord(rec, status, Date.now(), `${this.uid}${++this.seq}`);
      if (!x) return "";
      setShared(CHAT_KEY, [...(shared(CHAT_KEY) ?? []), x].slice(-MAX_CHAT));
      return x.id;
    } catch { return ""; }
  }
  // Moves record `id` to `status` (a no-op when it already has it).
  mark(id, status) {
    if (!id) return;
    try { const next = setChatStatus(shared(CHAT_KEY) ?? [], id, status, Date.now()); if (next) setShared(CHAT_KEY, next); } catch {}
  }
  recordOf(id) { try { return (shared(CHAT_KEY) ?? []).find((x) => x?.id === id) ?? null; } catch { return null; } }

  // The ask card a send answered (record field `ak`) is marked sent / held, so a resend or Enter that went through closes it like the first send.
  markAsk(r, how) {
    if (!r?.ak || !r?.to) return;
    try { setShared(SENT_KEY, { ...(shared(SENT_KEY) ?? {}), [r.to]: r.ak + (how === "held" ? "|held" : "") }); } catch {}
  }

  // The PO terminal a record goes to, and the buttons its bubble offers right now (its status, whether the PO is blocked, the age of the status).
  recordPo(r) { return chatTarget(this.liveTerms(), r.to ? [r.to] : [], r.po).po || chatTarget(this.liveTerms(), [], r.po).po; }
  recordActs(r, po, now = Date.now()) {
    const at = Number(r.at ?? r.ms) || 0;
    return mineActs(liveStatus(r.status, at, now), po ? this.isBlocked(po) : false, now - at);
  }

  // The bubble's "다시 보내기": the same text to the same PO, on the same record (no second bubble). Only when nothing reached the PO, or the pasted
  // line is gone. The record is "sending" before anything is pasted, so a second click (still "sending") does nothing: no double paste + Enter.
  resend(id, c) {
    const r = this.recordOf(id);
    if (!r) return;
    const po = this.recordPo(r);
    if (!this.recordActs(r, po).includes("resend")) return;
    if (!po) { this.say(NO_PO, true); c.notify(); return; }
    const before = r.status;
    this.mark(id, "sending");
    try {
      const out = this.deliver(po, r.line || r.text, c, r, (r2) => this.markAsk(r, r2), id);
      if (out === "busy") this.mark(id, before);
      else if (out === "sent" || out === "held") this.markAsk(r, out);
    } catch (e) { this.say(`붙여 넣지 못했습니다: ${String(e?.message ?? e).slice(0, 160)}`, true); }
    c.notify();
  }

  // The bubble's "Enter 누르기": the text is in the PO's normal prompt and only Enter is missing. Before the key goes, the PO's screen is read and the
  // pasted line must still be in its input (else "gone": send it again); refused when the PO now waits on a question (at the click and again right before the key).
  enterNow(id, c) {
    const r = this.recordOf(id);
    if (!r) return;
    const po = this.recordPo(r);
    if (!this.recordActs(r, po).includes("enter")) return;
    if (!po) { this.say(NO_PO, true); c.notify(); return; }
    if (this.isBlocked(po)) { this.say(`PO(${po})가 지금 질문 중이라 Enter를 누르지 않았습니다. 질문에 먼저 답하세요.`, true); c.notify(); return; }
    const before = r.status;
    const back = (st, msg) => { this.mark(id, st); if (msg) this.say(msg, true); try { c.notify(); } catch {} };
    this.mark(id, "sending");
    let rd;
    try { rd = hc(["read", po, "--lines", String(PROMPT_LINES)]); } catch { back(before, `PO(${po})의 화면을 읽지 못해 Enter를 누르지 않았습니다.`); return; }
    Promise.resolve(rd).then((o) => {
      if (!(o && o.code === 0)) { back(before, `PO(${po})의 화면을 읽지 못해 Enter를 누르지 않았습니다.`); return null; }
      if (!inputHas(String(o.stdout ?? ""), r.line || r.text)) { back("gone", `PO(${po})의 입력창에 보낸 글이 없어 Enter를 누르지 않았습니다. '다시 보내기'를 누르세요.`); return null; }
      if (this.isBlocked(po)) { back(before, `PO(${po})가 질문 중이 되어 Enter를 누르지 않았습니다. 질문에 먼저 답하세요.`); return null; }
      return hc(["keys", po, "enter"]);
    }).then((k) => {
      if (k === null) return;
      const okk = Boolean(k && k.code === 0);
      this.mark(id, okk ? "sent" : "noenter");
      if (okk) this.markAsk(r, "sent");
    }).catch(() => back("noenter", "")).then(() => { try { c.notify(); } catch {} });
  }

  // ---- A blocked PO's screen in the desk (so the person answers it without opening the terminal). Only shown while the room's PO is "blocked".
  // The desk reads the last lines (`hc read`) and offers the numbered choices it finds, Enter and Esc. Every key is pressed by the person's click, never by
  // the desk itself, and refused unless the PO is still blocked (a stale panel must not answer a different prompt).
  readPrompt(po, cx) {
    const now = Date.now();
    if ((this.promptBusy && now - this.promptBusyAt < PROMPT_TIMEOUT_MS) || (this.prompt?.po === po && now - this.prompt.at < PROMPT_REFRESH_MS)) return;
    const gen = ++this.promptGen; // a read that comes back after it was given up (or replaced) is ignored
    this.promptBusy = true;
    this.promptBusyAt = now;
    let done = false;
    const fin = (text) => {
      if (done || gen !== this.promptGen) return;
      done = true;
      this.promptBusy = false;
      // The same screen again (only a timer row moved): no new state and no redraw, so a drag-select in the panel is not cut. Either way the next read is
      // scheduled here (one chain: a newer read replaces the older chain), and only while the PO still waits.
      const same = this.prompt?.po === po && promptSame(this.prompt.text, text);
      this.prompt = same ? { ...this.prompt, at: Date.now() } : { po, at: Date.now(), text };
      const chain = ++this.promptChain;
      try {
        if (!same) this.softNotify(cx);
        cx.timer.after(PROMPT_REFRESH_MS + 100, (c2) => { if (chain === this.promptChain && this.isBlocked(po)) this.readPrompt(po, c2); });
      } catch {}
    };
    try { cx.timer.after(PROMPT_TIMEOUT_MS, (c2) => { if (!done && gen === this.promptGen) { this.promptBusy = false; try { c2.notify(); } catch {} } }); } catch {}
    let r;
    try { r = hc(["read", po, "--lines", String(PROMPT_LINES)]); } catch { fin(""); return; }
    Promise.resolve(r).then((o) => fin(o && o.code === 0 ? String(o.stdout ?? "") : "")).catch(() => fin(""));
  }
  // A key press from the question panel. Never on a stale panel: the PO must still be blocked, and its screen is read again right before the key
  // and must show the same question the buttons were built from (else the panel is refreshed and no key goes).
  pressPrompt(po, key, c) {
    const say = (text, bad = true) => { this.say(text, bad); try { c.notify(); } catch {} };
    if (!this.isBlocked(po)) { this.prompt = null; say(`PO(${po})가 이제 질문 중이 아니라 ${key}를 누르지 않았습니다.`); return; }
    const shown = this.prompt?.po === po ? this.prompt : null;
    if (!shown) { say(`PO(${po})의 화면을 아직 읽지 못해 ${key}를 누르지 않았습니다. 잠시 뒤 다시 누르세요.`); return; }
    const want = promptSig(shown.text);
    const fail = () => say(`PO(${po})의 화면을 다시 읽지 못해 ${key}를 누르지 않았습니다.`);
    let rd;
    try { rd = hc(["read", po, "--lines", String(PROMPT_LINES)]); } catch { fail(); return; }
    Promise.resolve(rd).then((o) => {
      if (!(o && o.code === 0)) { fail(); return null; }
      const text = String(o.stdout ?? "");
      if (promptSig(text) !== want) { this.prompt = { po, at: Date.now(), text }; say("질문이 바뀌었습니다, 다시 확인하세요"); return null; }
      if (!this.isBlocked(po)) { this.prompt = null; say(`PO(${po})가 이제 질문 중이 아니라 ${key}를 누르지 않았습니다.`); return null; }
      return hc(["keys", po, key]);
    }).then((k) => {
      if (k === null) return;
      const okk = Boolean(k && k.code === 0);
      say(okk ? `PO(${po})에 ${key}를 눌렀습니다.` : `PO(${po})에 ${key}를 누르지 못했습니다.`, !okk);
      if (this.prompt) this.prompt.at = 0;
    }).catch(() => say(`PO(${po})에 ${key}를 누르지 못했습니다.`));
  }
  promptPanel(t, v, cx) {
    const po = v.pick && v.pick !== PO_OTHER ? chatTarget(v.terms, [], v.pick).po : "";
    if (!po || !this.isBlocked(po)) { this.prompt = null; return null; }
    this.readPrompt(po, cx);
    const shown = this.prompt?.po === po ? this.prompt : null;
    const lines = shown ? promptTail(shown.text, 40) : [];
    const opts = shown ? promptOptions(shown.text) : [];
    const key = (k, label, tip, primary) => this.button(t, `pp-${k}`, label, (c) => this.pressPrompt(po, k === "esc" ? "esc" : k === "enter" ? "enter" : k, c), { primary, tip });
    return v_flex().id("po-prompt").flex_none().min_w(0).max_h(PROMPT_MAX_H).mx(10).mb(6).p(10).gap(8).rounded(8).bg(t.blocked + "14").border(1).border_color(t.blocked + "55").on_mouse_down("left", stop)
      .child(div().min_w(0).truncate().text_size(11).font_semibold().text_color(t.blocked).child("PO가 질문 중입니다 — 화면 끝"))
      .child(v_flex().id("po-prompt-lines").min_w(0).min_h(0).max_h(PROMPT_LINES_H).overflow_y_scrollbar().gap(2)
        .children(lines.length ? lines.map((l, i) => div().min_w(0).text_size(11).text_color(t.muted).child(this.text(`pp-l${i}`, chatHtml(l)))) : [div().text_size(11).text_color(t.dim).child(shown ? "화면을 읽지 못했습니다. 아래 버튼은 PO가 질문 중일 때만 눌립니다." : "화면을 읽는 중…")]))
      .child(h_flex().min_w(0).gap(6).items_center().flex_wrap()
        .children(opts.map((o) => this.button(t, `pp-${o.key}`, `${o.key}. ${o.label.length > 32 ? `${o.label.slice(0, 31)}…` : o.label}`, (c) => this.pressPrompt(po, o.key, c), { primary: o.on, tip: o.label })))
        .child(key("enter", "Enter", "화면에서 강조된 선택지를 확정합니다(PO가 질문 중일 때만)"))
        .child(key("esc", "Esc", "질문을 취소합니다(PO가 질문 중일 때만)")));
  }

  // A panel answer: the answer line goes through deliver(). The box is cleared and the ask marked once it reached the PO (or, when the PO had
  // no pane, once the pane opened and it was delivered).
  send(a, text, cx, kind = "answer") {
    // Only a written answer takes the pictures of its box along; the option / 확인 완료 buttons send their fixed word and leave them there.
    const pics = kind === "answer" ? this.picsOf(a.s.leader).slice(0, MAX_IMGS) : [];
    const body = String(text ?? "").trim();
    // A picture still being read must not miss this answer and ride on the next one, so even a text-only answer waits (as the PO box does).
    if (kind === "answer" && this.busyOf(a.s.leader)) { this.say("그림을 읽는 중입니다. 잠시 뒤에 다시 보내세요.", true); cx.notify(); return; }
    if (!body && !pics.length) { this.say("답을 먼저 적어 주세요.", true); cx.notify(); return; }
    const po = a.po;
    if (!po) { this.say(NO_PO, true); cx.notify(); return; }
    try {
      // The PO reads a picture from its file: each path goes in the answer as a line it can open with the Read tool (as the PO box does).
      const line = [answerLine(a.kind, a.s.leader, body || "(picture only)", a.link), ...pics.map((x) => imgLine(x.path))].join("\n");
      const sent = { text: body, imgs: pics.map((x) => x.path) };
      const r = this.deliver(po, line, cx, { text: body, imgs: pics.map((x) => x.path), to: a.s.leader, po: a.owner, kind, ak: this.askKey(a) }, (r2) => { this.clearBox(a, r2, sent); });
      if (r === "sent" || r === "held") this.clearBox(a, r, sent);
    } catch (e) { this.say(`붙여 넣지 못했습니다: ${String(e?.message ?? e).slice(0, 160)}`, true); }
    cx.notify();
  }

  // `sent` = what went out ({text, imgs}). The late call (the pane opened after the answer was held) clears only that: words typed or
  // pictures added meanwhile stay in the box. Without `sent` the whole box is cleared.
  clearBox(a, how = "sent", sent = null) {
    const leader = a.s.leader;
    try { setShared(SENT_KEY, { ...(shared(SENT_KEY) ?? {}), [leader]: this.askKey(a) + (how === "held" ? "|held" : "") }); } catch {}
    const st = this.inputs.get(leader);
    if (st && (!sent || String(st.value() ?? "").trim() === sent.text)) st.set_value("");
    this.setPics(leader, sent ? this.picsOf(leader).filter((x) => !sent.imgs.includes(x.path)) : []);
    if (this.writing === a.s.leader) this.writing = null;
  }

  box(leader, cx) {
    let s = this.inputs.get(leader);
    if (!s) {
      s = InputState.new({ value: "", placeholder: "답을 적고 Enter" });
      s.on("submit", (_e, c) => { const a = this.asks().find((x) => x.s.leader === leader); if (a) this.send(a, s.value(), c); });
      s.on("paste_other", (_e, c) => this.pastePic(c, leader)); // Cmd+V found no text: take a picture from the clipboard, as the PO box does
      this.inputs.set(leader, s);
    }
    return s;
  }

  // ---- PO chat: the text goes to the PO's prompt through deliver(), the same path as a panel answer.
  liveTerms() { try { return terminals() ?? []; } catch { return []; } }

  // Opens, updates or closes the "@" menu from the text before the cursor.
  syncMenu(c) {
    let next = null;
    try {
      const content = this.chat.content();
      const q = mentionQuery(content.text, this.chat.selected_range().end, content.tokens);
      const items = q ? leaderMenu(this.liveTerms(), namesMemo(), q.query, 8, this.view().pick) : [];
      if (q && items.length) next = { ...q, items, sel: Math.min(this.menu?.sel ?? 0, items.length - 1) };
    } catch {}
    this.menu = next;
    c.notify();
  }

  // Puts the picked mention into the box as a chip ("@lead-x "); a plain "@lead-x " when the chip cannot be made.
  pickMenu(i, c) {
    const m = this.menu, item = m?.items[i];
    if (!item) return;
    const range = { start: m.start, end: m.end };
    const token = { id: item.id, text: `@${item.id} `, label: `@${item.label}` };
    this.menu = null;
    this.pickedAt = Date.now();
    try { this.chat.replace_range_with_token(range, token); }
    catch {
      try {
        const text = composeChat(this.chat.content());
        this.chat.set_value(text.slice(0, range.start) + token.text + text.slice(range.end));
        this.chat.set_selected_range({ start: range.start + token.text.length, end: range.start + token.text.length });
      } catch {}
    }
    try { this.chat.focus(); } catch {}
    c.notify();
  }

  // Enter in the box: "send" (once per press, never right after a menu pick) or "newline" (added only if the widget did not add it).
  enterBox(intent, c) {
    const now = Date.now();
    if (intent === "send") {
      if (now - this.pickedAt <= 250 || now - this.sentAt <= 250 || now - this.heldAt < 150) return; // (the key and the submit event of one press are one Enter)
      let value = "";
      try { value = this.chat.value(); } catch {}
      if (value.trim() && imeHold(value, this.editAt, this.heldAt, now)) { // maybe the IME's confirming Enter: only this once
        this.heldAt = now;
        if (strayHeld(value, now, now) && now - this.changedAt <= 25) this.dropBreak(value); // the widget already added its line break
        c.notify();
        return;
      }
      this.sendChat(c);
    } else if (intent === "newline" && now - this.nlAt > 80) {
      this.nlAt = now;
      try { c.timer.after(40, () => { if (needsNewline(this.changedAt, now)) { try { this.chat.replace("\n"); } catch {} } }); } catch {}
    }
  }

  // Takes the one trailing line break the widget added out of the box (the cursor goes to the end, where it was).
  dropBreak(value) {
    try {
      const next = String(value).replace(/\n$/, "");
      this.chat.set_value(next);
      this.chat.set_selected_range({ start: next.length, end: next.length });
    } catch {}
  }

  // Keys of the box: the open menu's keys first, then Enter / Shift+Enter.
  inputKey(e, c) {
    if (this.menu) { this.menuKey(e, c); return; }
    const intent = enterIntent(e?.key, Boolean(e?.modifiers?.shift));
    if (!intent) return;
    if (intent === "send") { try { c.stop_propagation(); } catch {} }
    this.enterBox(intent, c);
  }

  // Keys the open menu handles stop here, so they do not also move the cursor, the focus or close the window.
  menuKey(e, c) {
    const m = this.menu;
    if (!m) return;
    const key = String(e?.key ?? "").toLowerCase().replace(/^arrow/, "");
    if (key === "down" || key === "up") m.sel = (m.sel + (key === "down" ? 1 : m.items.length - 1)) % m.items.length;
    else if (key === "escape") this.menu = null;
    else if (/^(tab|enter)$/.test(key)) this.pickMenu(m.sel, c);
    else return;
    try { c.stop_propagation(); } catch {}
    c.notify();
  }

  // Presses Enter in the PO terminal once the paste has landed (`hc keys`, no <hc ...> tag; it needs no focus). The record turns "sent" only
  // when that press went through ("noenter" + a message otherwise), then the keyboard goes back (`back`, any pane, in every mode). The desk
  // itself is never closed by a send: the dock, the window and the pane all stay open.
  submitPo(po, c, settle = PASTE_SETTLE_MS, back = "", id = "") {
    const fail = (cx, why) => { this.mark(id, "noenter"); this.say(`PO(${po})에 글은 넣었지만 Enter를 누르지 못했습니다${why ? `(${why})` : ""}. 말풍선의 'Enter 누르기'를 누르세요.`, true); try { cx.notify(); } catch {} };
    const press = (cx) => {
      if (this.isBlocked(po)) { // a question opened since the paste: Enter would answer it, so the line stays pasted and waits
        this.mark(id, "held");
        this.markAsk(this.recordOf(id), "held");
        this.say(`PO(${po})가 그 사이 질문 중이 되어 Enter를 누르지 않았습니다. 질문에 먼저 답하세요.`, true);
        try { cx.notify(); } catch {}
        this.restore(back, cx, id);
        return;
      }
      let r;
      try { r = hc(["keys", po, "enter"]); } catch { fail(cx, ""); this.restore(back, cx, id); return; }
      Promise.resolve(r).then((o) => { if (o && o.code !== 0) fail(cx, String(o.stderr ?? "").trim().slice(0, 80)); else this.mark(id, "sent"); }).catch(() => fail(cx, "")).then(() => this.restore(back, cx, id));
    };
    try { c.timer.after(settle, press); } catch { press(c); }
  }

  sendChat(c) {
    this.sentAt = Date.now();
    this.heldAt = 0;
    const v = this.view();
    const terms = v.terms;
    const known = v.pick === PO_OTHER ? [] : terms.filter((t) => /^lead-/.test(String(t.name ?? "")) && leaderOwner(terms, t.name, t.address) === v.pick).map((t) => t.name);
    let p;
    try { p = parseMention(composeChat(this.chat.content()), known); } catch { p = { empty: true }; }
    const pics = this.pics.slice(0, MAX_IMGS);
    if (p.empty && !pics.length) { this.say("PO에게 보낼 글을 먼저 적어 주세요.", true); c.notify(); return; }
    if (this.picBusy) { this.say("그림을 읽는 중입니다. 잠시 뒤에 다시 보내세요.", true); c.notify(); return; }
    if (p.empty) p = { text: "", to: [], empty: false };
    p.to = p.to ?? [];
    const tgt = chatTarget(terms, p.to, v.pick);
    if (!tgt.po) {
      this.say(tgt.why === "many" ? "부른 리더들의 PO가 서로 다릅니다. 한 PO의 리더만 함께 부르세요." : tgt.why === "orphan" ? NO_PO
        : "받을 PO를 먼저 고르세요(role=po, po=<id> 라벨이 붙은 PO 터미널만 고를 수 있습니다).", true);
      c.notify();
      return;
    }
    const po = tgt.po;
    try {
      // The PO reads a picture from its file: each path goes in the message as a line it can open with the Read tool.
      const line = [p.text, ...pics.map((x) => imgLine(x.path))].filter(Boolean).join("\n");
      const r = this.deliver(po, line, c, { text: p.text, imgs: pics.map((x) => x.path), to: p.to[0] ?? "", po: v.pick, kind: "chat" });
      if (r === "sent" || r === "held" || r === "opening") { // opening: the bubble holds the text and sends it by itself once the pane opens
        this.chat.set_value("");
        this.pics = [];
        this.menu = null;
      }
    } catch (e) { this.say(`붙여 넣지 못했습니다: ${String(e?.message ?? e).slice(0, 160)}`, true); }
    c.notify();
  }

  // The chat footer: the "@" menu, the input with mention chips, the send button. The room has no box while it is "PO 모름" (no PO to send to).
  chatBox(t, v) {
    if (v.pick === PO_OTHER) {
      return div().id("chat-none").flex_none().px(12).py(8).border_t(1).border_color(t.border).text_size(11.5).text_color(t.dim)
        .child("PO를 알 수 없는 방이라 여기서는 보낼 곳이 없습니다. 왼쪽에서 PO 방을 고르세요.");
    }
    const menu = this.menu && v_flex().id("chat-menu").flex_none().p(4).gap(2).rounded(8).bg(t.raised).border(1).border_color(t.border)
      .children(this.menu.items.map((it, i) => h_flex().id(`mn-${it.id}`).h(26).px(8).gap(8).items_center().rounded(6).cursor_pointer()
        .bg(i === this.menu.sel ? t.selected : t.raised).hover((x) => x.bg(t.hover))
        .on_mouse_down("left", stop).on_click((_e, c) => this.pickMenu(i, c))
        .child(div().text_size(12.5).font_semibold().text_color(it.id === "here" ? t.muted : tint(t, it.id)).child(`@${it.label}`))
        .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(it.id === "here" ? "PO에게 그냥 보내기" : it.sub))));
    const target = v.tabs.find((x) => x.id === v.pick && x.id !== PO_OTHER);
    const chip = (ctx) => div().h(ctx.line_height).px(5).rounded(5).flex().items_center().bg(t.working + "26").text_color(t.working).text_size(12.5).font_semibold()
      .child(ctx.token.label ?? ctx.token.text.trim());
    return v_flex().flex_none().px(10).pb(10).pt(6).gap(6).border_t(1).border_color(t.border)
      .on_key_down((e, c) => this.inputKey(e, c))
      .when(Boolean(menu), (el) => el.child(menu))
      .when(holdShown(this.changedAt, this.heldAt), (el) => el.child(div().text_size(11).text_color(t.working).child("한 번 더 Enter로 보냅니다")))
      .child(div().truncate().text_size(10.5).text_color(t.dim).child(target ? `받는 PO: ${target.label}` : "받는 PO가 없습니다 — PO를 고르세요"))
      .when(this.pics.length > 0 || this.picBusy > 0, (el) => el.child(this.picRow(t, null)))
      .child(h_flex().gap(6).items_center()
        .on_drop((ev, c) => this.dropPics(ev?.paths, c))
        .child(this.button(t, "chat-attach", "그림", (c) => { this.pickPics(c); }, { tip: "그림 파일을 골라 붙입니다(Cmd+V로 붙여넣거나 파일을 끌어다 놓아도 됩니다). 보내면 PO가 파일을 열어 봅니다" }))
        .child(div().flex_1().min_w(0).on_mouse_down("left", stop)
          .child(Textarea.new(this.chat).token((ctx) => chip(ctx)).min_h(30).px(10).py(5).rounded(8).border(1).border_color(t.input).bg(t.background).text_size(12.5).text_color(t.foreground)))
        .child(this.button(t, "chat-send", "PO에 보내기", (c) => this.sendChat(c), { primary: true, tip: "고른 PO 터미널에 글을 붙여 넣고 Enter까지 눌러 보냅니다(글은 클립보드를 거칩니다). Shift+Enter는 줄바꿈" })));
  }

  poHint(t) {
    return div().id("po-hint").flex_none().px(this.compact ? 10 : 14).pb(6).text_size(11).text_color(t.muted)
      .child("PO 터미널에 role=po, po=<id> 라벨을 달면 PO별로 나뉩니다. 지금은 PO가 없어 채팅을 보낼 수 없습니다.");
  }

  // The count badges of a room: unread (green) and waiting leaders (red).
  roomBadges(t, x) {
    return [
      x.blocked ? div().flex_none().px(5).h(15).rounded(8).bg(t.blocked + "26").flex().items_center().text_size(10).font_semibold().text_color(t.blocked).child("질문") : null,
      x.unread > 0 ? div().flex_none().px(5).h(15).rounded(8).bg(t.working).flex().items_center().text_size(10).font_semibold().text_color(t.chrome).child(String(x.unread)) : null,
      x.n > 0 ? div().flex_none().px(5).h(15).rounded(8).bg(t.blocked + "26").flex().items_center().text_size(10).text_color(t.blocked).child(String(x.n)) : null,
    ].filter(Boolean);
  }

  // The room strip (the dock, and the window when narrow): one chip per room — the live POs by project, and "PO 모름" while something belongs to none.
  picker(t, v) {
    if (!v.tabs.some((x) => x.id !== PO_OTHER)) return this.poHint(t);
    return h_flex().id("po-picker").flex_none().px(this.compact ? 10 : 14).pb(6).gap(5).flex_wrap().items_center()
      .child(div().flex_none().text_size(10.5).font_semibold().text_color(t.dim).child("PO"))
      .children(v.tabs.map((x) => {
        const on = x.id === v.pick;
        return h_flex().id(`po-${x.id}`).h(24).px(9).gap(5).items_center().rounded(12).cursor_pointer().on_mouse_down("left", stop)
          .bg(on ? t.selected : t.raised).border(1).border_color(on ? t.foreground + "40" : t.border)
          .hover((s) => s.bg(on ? t.selected : t.hover)).on_click((_e, c) => this.pickPo(x.id, c))
          .tooltip(x.id === PO_OTHER ? OTHER_TIP : `po=${x.id}${x.title ? ` · 세션: ${x.title}` : ""}`)
          .child(div().max_w(150).truncate().text_size(11.5).font_semibold().text_color(on ? t.foreground : t.muted).child(x.label))
          .children(this.roomBadges(t, x));
      }));
  }

  // The dock's room column: one slim cell per room — the initial circle with its badges under it. The project is the tooltip.
  slimRooms(t, v) {
    return v_flex().id("po-rooms").flex_none().w(SLIM_W).h_full().min_h(0).py(6).px(4).gap(3).border_r(1).border_color(t.border).overflow_y_scrollbar()
      .children(v.tabs.map((x) => {
        const on = x.id === v.pick;
        const color = x.id === PO_OTHER ? t.dim : tint(t, x.id);
        const badges = this.roomBadges(t, x);
        return v_flex().id(`po-${x.id}`).flex_none().items_center().py(5).gap(3).rounded(8).cursor_pointer().on_mouse_down("left", stop)
          .bg(on ? t.selected : t.chrome).hover((s) => s.bg(on ? t.selected : t.hover)).on_click((_e, c) => this.pickPo(x.id, c))
          .tooltip(x.id === PO_OTHER ? OTHER_TIP : `${x.label} · po=${x.id}${x.title ? ` · 세션: ${x.title}` : ""}`)
          .child(this.circle(t, color, x.id === PO_OTHER ? "?" : String(x.label).slice(0, 1).toUpperCase()))
          .child(div().w(SLIM_W - 10).truncate().text_center().text_size(9.5).text_color(on ? t.foreground : t.dim).child(x.label))
          .when(badges.length > 0, (el) => el.child(h_flex().gap(3).items_center().children(badges)));
      }));
  }

  // The room list (the wide window): one row per room — a colored initial circle, the project, its badges.
  roomList(t, v) {
    return v_flex().id("po-rooms").flex_none().w(ROOM_W).h_full().min_h(0).p(6).gap(3).border_r(1).border_color(t.border).overflow_y_scrollbar()
      .children(v.tabs.map((x) => {
        const on = x.id === v.pick;
        const color = x.id === PO_OTHER ? t.dim : tint(t, x.id);
        return h_flex().id(`po-${x.id}`).flex_none().h(44).px(8).gap(8).items_center().rounded(8).cursor_pointer().on_mouse_down("left", stop)
          .bg(on ? t.selected : t.chrome).hover((s) => s.bg(on ? t.selected : t.hover)).on_click((_e, c) => this.pickPo(x.id, c))
          .tooltip(x.id === PO_OTHER ? OTHER_TIP : `po=${x.id}${x.title ? ` · 세션: ${x.title}` : ""}`)
          .child(this.circle(t, color, x.id === PO_OTHER ? "?" : String(x.label).slice(0, 1).toUpperCase()))
          .child(v_flex().flex_1().min_w(0)
            .child(div().min_w(0).truncate().text_size(12.5).font_semibold().text_color(on ? t.foreground : t.muted).child(x.label))
            .child(div().min_w(0).truncate().text_size(10).text_color(t.dim).child(x.id === PO_OTHER ? "채팅 없음" : "PO")))
          .children(this.roomBadges(t, x));
      }));
  }

  // ---- parts
  button(t, id, label, onClick, o = {}) {
    if (o.disabled) {
      return div().id(id).flex_none().h(24).px(10).rounded(12).flex().items_center().text_size(11.5).on_mouse_down("left", stop)
        .bg(t.raised).border(1).border_color(t.border).text_color(t.dim).opacity(0.5).tooltip(o.disabled).child(label);
    }
    return div().id(id).flex_none().h(24).px(10).rounded(12).flex().items_center().text_size(11.5).cursor_pointer()
      .on_mouse_down("left", stop).bg(o.primary ? t.selected : t.raised).border(1).border_color(o.primary ? t.foreground + "40" : t.border)
      .text_color(o.primary ? t.foreground : t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click((_e, cx) => onClick(cx)).when(Boolean(o.tip), (el) => el.tooltip(o.tip)).child(label);
  }

  tag(t, text, color) {
    return div().flex_none().px(6).h(17).rounded(5).bg((t[color] ?? t.dim) + "26").text_size(10.5).text_color(t[color] ?? t.dim).flex().items_center().child(text);
  }

  // The kind tag of a report. Red (the kind's own color) only while the leader is still waiting on it; a decision/verify line that is not
  // waiting any more is neutral, and "· 답함" when an answered line closed it.
  kindTag(t, it, kind, waiting) {
    const kk = kind ?? it?.kind;
    const k = KIND[kk] ?? KIND.other;
    if (waiting || (kk !== "decision" && kk !== "verify")) return this.tag(t, k[0], k[1]);
    return this.tag(t, it?.answered ? `${k[0]} · 답함` : k[0], "dim");
  }

  // A round initial badge (a leader, the PO or a room): a tint of its color behind the letter.
  circle(t, color, letter) {
    return div().flex_none().size(28).rounded(14).bg(color + "33").flex().items_center().justify_center().text_size(12).font_semibold().text_color(color).child(letter);
  }

  avatar(t, leader) { return this.circle(t, tint(t, leader), shortName(leader).slice(0, 1).toUpperCase()); }

  // ---- report text. Collapsed (default): the headline, the first meaningful line and the short link. Open: the structured body
  // (blocks come parsed from inbox.cjs): headings, indented list rows, command blocks with a copy button, short link labels.
  mono() { return window()?.platform === "windows" ? "Consolas" : window()?.platform === "macos" ? "Menlo" : "monospace"; }

  // Card text you can drag-select and copy with Cmd+C. Links inside open through openUrl. A press here must not drag the window or toggle anything.
  // The small picture of a pending image in the box (above the input). image() loads only paths under the app folder: the picture was saved by the
  // helper in data/inbox/img, so it is given as that relative path; one that cannot be drawn stays an empty frame.
  thumb(t, x) {
    const f = fitImg(x.w, x.h, 52, 36);
    const rel = imgRel(this.data?.root ?? "", x.path);
    return rel
      ? div().flex_none().w(f.w).h(f.h).rounded(4).overflow_hidden().child(image(rel).w(f.w).h(f.h))
      : div().flex_none().w(f.w).h(f.h).rounded(4).bg(t.hover);
  }

  // A message as Markdown (bold, headings, lists, `code`, links; no raw HTML: tags show as text). The wrapper tags are removed first (mdText).
  // Selectable like text(); a link opens only when it is http(s) (openUrl ignores everything else).
  // The TextView draws **bold** at the normal weight (it ignores bold and the weight around it), so each bold run also gets a tint behind it
  // (highlight_range, offsets into the very string given to markdown): bold stays visible without a weight.
  md(id, src, t) {
    this.tvN = (this.tvN ?? 0) + 1;
    const m = mdText(src);
    let tv = TextView.markdown(id, m).raw_html(false).selectable(true).on_link_click((url, c) => openUrl(url, c)).on_selection_change((sel, c) => this.onSel(id, sel, c));
    if (t) {
      try {
        const bc = tintHex(t, "bold"); // theme accent at ~45% (less when the text would stop being readable), see HL_KINDS
        if (bc) for (const r of boldRanges(m)) tv = tv.highlight_range(r.start, r.end, bc);
        else this.tintWarn(t, "bold");
      } catch {}
    }
    return tv;
  }

  // A PO message folded like the person's own (#47): a long one shows its first lines and a "더 보기" under them.
  mdFolded(id, src, t) {
    const lc = clipLong(unwrapTags(src)), open = lc.cut && this.more.has(id);
    if (!lc.cut) return this.md(id, src, t);
    return v_flex().min_w(0).gap(6).child(this.md(id, open ? src : lc.text, t)).child(this.moreToggle(t, id, lc, open));
  }

  // "더 보기 · N자 더" / "접기" under a folded bubble. Only this bubble opens; the 복사 chip copies the whole text either way.
  moreToggle(t, id, lc, open) {
    return div().id(`${id}-more`).flex_none().text_size(11).cursor_pointer().text_color(t.working).hover((s) => s.text_color(t.foreground))
      .on_mouse_down("left", stop)
      .on_click((_e, cx) => { if (this.more.has(id)) this.more.delete(id); else this.more.add(id); try { cx.notify(); } catch {} })
      .tooltip(open ? "다시 접습니다" : "이 메시지 전체를 펼칩니다").child(open ? "접기" : moreLabel(lc.more));
  }

  text(id, html) {
    this.tvN = (this.tvN ?? 0) + 1;
    return TextView.html(id, html).selectable(true).on_link_click((url, c) => openUrl(url, c)).on_selection_change((sel, c) => this.onSel(id, sel, c));
  }

  // A small "복사" under a bubble: its whole text (wrapper tags removed) goes on the clipboard, so a message can be copied even when a drag-select
  // cannot be made. `ms` is the time label beside it.
  sideTools(t, id, text, ms) {
    const key = `bc-${id}`;
    const done = this.copied === key;
    return v_flex().flex_none().items_end().gap(2)
      .child(div().id(key).flex_none().px(6).h(17).rounded(5).flex().items_center().text_size(10).cursor_pointer().text_color(done ? t.working : t.dim)
        .hover((x) => x.bg(t.hover).text_color(t.foreground)).on_mouse_down("left", stop)
        .on_click((_e, cx) => this.copy(key, unwrapTags(text), cx)).tooltip("이 말풍선의 글 전체를 클립보드에 복사합니다").child(done ? "복사됨" : "복사"))
      .child(div().flex_none().pb(1).text_size(10).text_color(t.dim).child(ms ? clock(ms) : ""));
  }

  codeBlock(t, text, html, id) {
    const done = this.copied === id;
    return h_flex().min_w(0).gap(6).items_start().px(8).py(5).rounded(6).bg(t.background).border(1).border_color(t.border)
      .child(div().flex_1().min_w(0).font_family(this.mono()).text_size(11.5).text_color(t.foreground).child(this.text(`${id}-t`, `<p><code>${html}</code></p>`)))
      .child(div().id(id).flex_none().px(7).h(20).rounded(10).flex().items_center().text_size(10.5).cursor_pointer().bg(t.raised).border(1).border_color(t.border)
        .text_color(done ? t.working : t.muted).hover((x) => x.bg(t.hover).text_color(t.foreground)).on_mouse_down("left", stop)
        .on_click((_e, cx) => this.copy(id, text, cx)).tooltip("이 명령만 클립보드에 복사합니다(붙여 넣거나 보내지 않습니다)").child(done ? "복사됨" : "복사"));
  }

  // Card title and section headings: the TextView ignores bold tags and the weight of the box around it, so the style goes on the
  // TextView element itself (still selectable).
  heading_text(t, id, html, size = 14) {
    return this.text(id, `<p>${html}</p>`).font_weight(700).text_size(size).text_color(t.foreground);
  }

  // The body as parts: prose (one selectable text, so a drag can run across headings, lists and lines) and command blocks (own box + 복사).
  body(t, it, id) {
    return v_flex().min_w(0).gap(5).children(it.parts.map((p, i) => {
      const key = `${id}-${i}`;
      if (p.t === "code") return div().min_w(0).pl(p.depth ? p.depth * 14 + 18 : 0).child(this.codeBlock(t, p.text, p.html, `copy-${key}`));
      if (p.t === "h") return div().min_w(0).pt(4).child(this.heading_text(t, key, p.html, 14.5));
      return div().min_w(0).text_size(12.5).text_color(t.foreground).child(typeof p.md === "string" && p.md ? this.md(key, p.md, t) : this.text(key, p.html));
    }));
  }

  // A speech bubble. Reports with more than a line start collapsed; "자세히" / "접기" flips it (kept per card in shared state).
  bubble(t, s, it, accent) {
    const open = it.long && this.isOpen(s, it);
    const id = `b-${s.leader}-${it.ts}`;
    const toggle = it.long ? div().id(`tg-${s.leader}-${it.ts}`).flex_none().px(8).h(20).rounded(10).flex().items_center().text_size(10.5).cursor_pointer().bg(t.raised)
      .border(1).border_color(t.border).text_color(t.muted).hover((x) => x.bg(t.hover).text_color(t.foreground)).on_mouse_down("left", stop)
      .on_click((_e, c) => { this.toggleOpen(s, it); this.reveal(this.spot(s, it)); c.notify(); }).child(open ? "접기" : "자세히") : null;
    const box = v_flex().min_w(0).px(12).py(9).gap(6).rounded(12).bg(accent ? accent + "1f" : t.raised).border(1).border_color(accent ? accent + "55" : t.border)
      .text_size(12.5).text_color(t.foreground);
    const headline = it.head || it.lead || it.title;
    box.child(div().min_w(0).child(this.heading_text(t, `${id}-h`, it.headHtml, 16)));
    if (!open) {
      if (it.lead && it.lead !== headline) box.child(div().min_w(0).max_h(34).overflow_hidden().text_size(12).text_color(t.muted).child(this.text(`${id}-lead`, `<p>${it.leadHtml}</p>`)));
    } else box.child(this.body(t, it, id));
    if (it.linkLabel || toggle) {
      box.child(h_flex().gap(6).items_center().flex_wrap()
        .when(Boolean(it.link), (el) => el.child(div().flex_none().px(6).rounded(5).bg(t.hover).text_size(11).text_color(t.ansi4 ?? t.foreground).child(this.text(`${id}-link`, it.linkHtml))))
        .child(div().flex_1())
        .when(Boolean(toggle), (el) => el.child(toggle)));
    }
    return box;
  }

  // A message header: the leader's name (left out when `bare`, a follow-up line), the kind tag and the time.
  nameRow(t, s, it, extra, waiting, bare) {
    return h_flex().gap(6).items_center().min_w(0)
      .when(!bare, (el) => el.child(div().id(`peek-${s.leader}-${it?.ts ?? ""}`).min_w(0).truncate().text_size(12).font_semibold().text_color(tint(t, s.leader)).cursor_pointer()
        .hover((x) => x.text_color(t.foreground)).on_mouse_down("left", stop).on_click(() => this.peek(s)).tooltip("그 리더 터미널 들여다보기").child(shortName(s.leader))))
      .when(!bare && Boolean(it?.linkRef), (el) => el.child(div().min_w(0).max_w(150).truncate().text_size(10.5).text_color(t.dim).child(it.linkRef)))
      .when(Boolean(it), (el) => el.child(this.kindTag(t, it, it.kind, waiting)))
      .when(!bare, (el) => el.child(div().flex_1()))
      .when(Boolean(extra), (el) => el.child(extra));
  }

  // What a waiting leader's message offers: 링크 열기, 확인 완료 (verify), 답 쓰기 with its answer box, and what an answer does.
  askActions(t, a, cx) {
    const { s, kind, item, link } = a;
    const writing = this.writing === s.leader;
    const done = this.sentOf(a);
    const opts = kind === "decision" ? decisionOptions(item?.body) : { options: [], recommended: 0 }; // once: the chips and the recommended one read the same list
    const box = v_flex().min_w(0).gap(6)
      .child(h_flex().gap(6).items_center().flex_wrap()
        .when(Boolean(link) && link !== item?.link, (el) => el.child(this.button(t, `link-${s.leader}`, "링크 열기", (c) => openUrl(link, c))))
        .children(kind === "decision" ? opts.options.map((n) => this.button(t, `opt-${s.leader}-${n}`, `${n}안 선택`, (c) => this.send(a, `${n}안 선택`, c, "choice"), { primary: n === opts.recommended, disabled: a.po ? "" : NO_PO, tip: CLIP })) : [])
        .when(kind === "verify", (el) => el.child(this.button(t, `ok-${s.leader}`, "확인 완료", (c) => this.send(a, "확인 완료", c, "verify"), { primary: true, disabled: a.po ? "" : NO_PO, tip: CLIP })))
        .child(this.button(t, `write-${s.leader}`, writing ? "닫기" : "답 쓰기", (c) => { this.writing = writing ? null : s.leader; if (!writing) this.box(s.leader, c); this.reveal(this.spot(s, item)); c.notify(); }, { disabled: a.po ? "" : NO_PO }))
        .child(div().text_size(11).text_color(done === "sent" ? t.working : done === "held" ? t.blocked : t.dim).child(done === "sent" ? "PO에 보냄 — 리더가 받으면 사라집니다" : done === "held" ? (this.isBlocked(a.po) ? "PO에 넣음 — PO가 질문 중입니다. 방의 질문에 먼저 답하세요" : "PO에 넣음 — 말풍선의 'Enter 누르기'로 보내세요") : "누르면 PO에 바로 보내고, 리더가 받으면 사라집니다")));
    if (!a.po) box.child(div().text_size(11).text_color(t.dim).child(NO_PO));
    if (writing) {
      const input = this.box(s.leader, cx);
      const row = this.picRow(t, s.leader);
      if (row) box.child(row);
      box.child(h_flex().gap(6).items_center()
        .on_drop((ev, c) => this.dropPics(ev?.paths, c, s.leader))
        .child(this.button(t, `attach-${s.leader}`, "그림", (c) => { this.pickPics(c, s.leader); }, { tip: "그림 파일을 골라 붙입니다(Cmd+V로 붙여넣거나 파일을 끌어다 놓아도 됩니다). 보내면 PO가 파일을 열어 봅니다" }))
        .child(div().flex_1().min_w(0).on_mouse_down("left", stop).child(Input.new(input).h(30).px(10).items_center().rounded(8).border(1).border_color(t.input).bg(t.background).text_size(12.5).text_color(t.foreground)))
        .child(this.button(t, `send-${s.leader}`, "보내기", (c) => this.send(a, input.value(), c), { primary: true, disabled: a.po ? "" : NO_PO, tip: CLIP })));
    }
    return box;
  }

  // The window's width changed: remember it, and redraw (softNotify: held while selecting) when the layout class changed or the width moved to
  // another 16px step, which is what the bubble cap follows (a redraw per step, not per pixel).
  onSize(width, cx) {
    const x = width < 360, n = width < WIDE_MIN;
    const wb = Math.round(width / 16);
    const grew = wb !== this.winB;
    this.winW = width; this.winB = wb;
    if (x !== this.compact || n !== this.narrow || grew) { this.compact = x; this.narrow = n; this.softNotify(cx); }
  }

  // The most px a message bubble may take (see bubbleCap). null before the first size report: the bubbles then use a percentage.
  capOf(minInner = 0) {
    const strip = this.windowed && this.narrow;
    return bubbleCap(chatColW(this.winW, strip, this.narrow, ROOM_W, SLIM_W), minInner);
  }

  // One timeline entry (a grouped entry: `head` says whether the sender's name line is drawn). Leaders and the PO are on the left with a
  // circle, the person ("나") on the right. A leader's message that it waits on is red and carries its answer buttons.
  entryRow(t, e, v, cx) {
    const top = e.head ? 18 : 8; // a new sender gets more air than a follow-up of the same sender
    const id = tlId(e.key);
    // The time sits at the bubble's bottom, on its outer side: left of mine, right of everyone else's.
    const when = (ms) => div().flex_none().pb(1).text_size(10).text_color(t.dim).child(ms ? clock(ms) : "");
    if (e.who === "me") {
      const blockedNow = Boolean(v.tabs.find((x) => x.id === v.pick)?.blocked);
      const age = Date.now() - (Number(e.at) || Number(e.ms) || 0);
      const note = mineNote(e.status, blockedNow, age);
      const bad = e.status === "nopane" || e.status === "failed" || e.status === "noenter" || e.status === "gone" || (e.status === "held" && !blockedNow);
      const acts = mineActs(e.status, blockedNow, age);
      const ACT = { resend: ["다시 보내기", "같은 글을 같은 PO에게 다시 보냅니다(말풍선은 늘지 않습니다)", (c) => this.resend(e.id, c)], enter: ["Enter 누르기", "PO의 입력창에 보낸 글이 아직 있는지 확인한 뒤 Enter만 누릅니다(PO가 질문 중이면 누르지 않습니다)", (c) => this.enterNow(e.id, c)] };
      const root = this.data?.root ?? "";
      const bp = bubbleParts(e.text, e.imgs, root);
      const dims = bp.imgs.map((p) => this.data?.imgd?.[p] ?? this.imgd.get(p));
      let sizes = dims.map((d) => fitImg(d?.[0], d?.[1], 240, 180));
      // The bubble asks for its text's width (up to 80% of the row, like the left bubbles) and never less than its widest picture: a
      // percentage max inside a content-sized box collapsed to ~3 characters, so the row is full width and the bubble has a width of its own.
      // It is also capped (capOf: 75% of the chat column, in px): a long message wraps inside the cap and never reaches the left side, so the
      // bubble, with the 복사 chip and the time on its left, always reads as right-aligned. A picture keeps its own width as the floor.
      let pics = Math.max(0, ...sizes.map((f) => f.w + 26));
      const cap = this.capOf(pics);
      // Only a column too narrow for the picture and the chip (the cap stayed below the picture) scales the pictures down to the cap.
      if (cap != null && pics > cap) { sizes = dims.map((d) => fitImg(d?.[0], d?.[1], Math.max(24, cap - 26), 180)); pics = Math.max(0, ...sizes.map((f) => f.w + 26)); }
      const lc = clipLong(bp.text), open = lc.cut && this.more.has(id), words = open ? bp.text : lc.text;
      const width = Math.min(Math.max(bubbleWidth(words), pics, 64), cap ?? Infinity);
      return v_flex().id(id).flex_none().px(10).pt(top).gap(2).items_end()
        .when(Boolean(e.to), (el) => el.child(div().max_w("85%").min_w(0).truncate().text_size(10).text_color(t.dim).child(`→ ${shortName(e.to)}`)))
        .child(h_flex().w_full().min_w(0).gap(6).items_end().justify_end() // always the right edge: the chip and the time are left of the bubble
          .child(this.sideTools(t, id, e.text, e.ms))
          .child(v_flex().flex_none().w(width).max_w(cap ?? "75%").min_w(0).px(12).py(9).gap(6).rounded(12).bg(t.working + "33").border(1).border_color((bad ? t.blocked : t.working) + "66").text_size(12.5).text_color(t.foreground)
            .children(bp.imgs.map((p, i) => div().id(`${id}-img${i}`).flex_none().w(sizes[i].w).h(sizes[i].h).rounded(6).overflow_hidden().cursor_pointer().on_mouse_down("left", stop)
              .on_click(() => openFile(p)).tooltip("눌러서 그림 열기")
              .child(image(imgRel(root, p)).w(sizes[i].w).h(sizes[i].h)))) // image() loads only paths under the app folder: data/inbox/img/<file>
            .when(bp.chips.length > 0, (el) => el.child(h_flex().gap(4).flex_wrap().children(bp.chips.map((n) => div().flex_none().px(6).h(17).rounded(5).flex().items_center().bg(t.raised).text_size(10.5).text_color(t.muted).child(`사진 #${n}`)))))
            .when(Boolean(bp.text), (el) => el.child(this.text(`${id}-t`, chatHtml(words))))
            .when(lc.cut, (el) => el.child(this.moreToggle(t, id, lc, open)))))
        .when(Boolean(note), (el) => el.child(h_flex().max_w("100%").min_w(0).gap(6).items_center().flex_wrap().justify_end()
          .child(div().min_w(0).text_size(10.5).text_color(bad ? t.blocked : t.dim).child(note))
          .children(Boolean(e.id) ? acts.map((k, i) => this.button(t, `ma-${k}-${e.id}`, ACT[k][0], ACT[k][2], { primary: i === 0, tip: ACT[k][1] })) : [])));
    }
    if (e.who === "po") {
      return h_flex().flex_none().px(10).pt(top).gap(8).items_start()
        .child(e.head ? this.circle(t, t.working, "P") : div().flex_none().w(28))
        .child(v_flex().flex_1().min_w(0).gap(3)
          .when(e.head, (el) => el.child(h_flex().gap(6).items_center()
            .child(div().text_size(12).font_semibold().text_color(t.working).child("PO"))
            .when(Boolean(e.to), (x) => x.child(div().min_w(0).truncate().text_size(10.5).text_color(t.dim).child(`→ ${shortName(e.to)}`)))))
          .child(h_flex().min_w(0).gap(6).items_end()
            .child(div().flex_1().min_w(0).max_w(this.capOf() ?? "75%").px(12).py(9).rounded(12).bg(t.raised).border(1).border_color(t.border).text_size(12.5).text_color(t.foreground)
              .child(this.mdFolded(id, e.text, t)))
            .child(this.sideTools(t, id, e.text, e.ms))));
    }
    const a = e.waiting ? v.asks.find((x) => x.s.leader === e.leader) : null;
    const wait = e.it ? { ...e.it, kind: e.waiting || e.it.kind } : null;
    const hdr = e.it
      ? this.nameRow(t, e.s, e.it, null, Boolean(e.waiting), !e.head)
      : this.nameRow(t, e.s, e.waiting ? { kind: e.waiting, ms: 0 } : null, null, true, !e.head);
    return h_flex().id(this.spot(e.s, e.it)).flex_none().px(10).pt(top).gap(8).items_start()
      .child(e.head ? this.avatar(t, e.leader) : div().flex_none().w(28))
      .child(v_flex().flex_1().min_w(0).gap(4)
        .child(hdr)
        .child(e.it ? h_flex().min_w(0).gap(6).items_end()
          .child(div().flex_1().min_w(0).max_w(this.capOf() ?? "75%").child(this.bubble(t, e.s, wait, e.waiting ? t.blocked : null)))
          .child(when(e.it.ms))
          : div().text_size(12).text_color(t.dim).child("보고 기록 없이 대기 표시만 있습니다. 링크를 열거나 터미널을 들여다보세요."))
        .when(Boolean(a), (el) => el.child(this.askActions(t, a, cx))));
  }

  // One "···" bubble: a PO or leader that is writing now. A plain div (no text view): nothing in it can be selected or steal a drag.
  typingRow(t, x) {
    const po = x.who === "po";
    const color = po ? t.working : tint(t, x.who.slice(2));
    return h_flex().id(`typing-${tlId(x.who)}`).flex_none().px(10).pt(18).gap(8).items_start()
      .child(po ? this.circle(t, t.working, "P") : this.avatar(t, x.who.slice(2)))
      .child(v_flex().min_w(0).gap(3)
        .child(div().min_w(0).truncate().text_size(12).font_semibold().text_color(color).child(po ? "PO" : x.name))
        .child(h_flex().min_w(0).gap(6).items_center()
          .child(div().px(14).py(5).rounded(12).bg(t.raised).border(1).border_color(t.border).text_size(16).text_color(t.dim).child("···"))
          .child(x.label ? div().flex_none().text_size(11).text_color(x.label === LABEL_BLOCKED ? t.blocked : t.dim).child(x.label) : div())));
  }

  render(cx) { return this.full(cx); }

  // The messenger view: rooms (one per PO) beside one room's timeline, and the chat box under it. Narrow: the rooms are a strip on top.
  full(cx) {
    this.tvN = 0;
    this.noteRedraw(cx);
    Promise.resolve().then(() => { // once per draw (only when the count changed or 10s passed, so a busy desk does not flood the file)
      const now = Date.now();
      if (this.tvLast !== this.tvN || now - (this.tvLogAt ?? 0) > 10000) { this.tvLast = this.tvN; this.tvLogAt = now; this.diag(`draw: ${this.tvN} selectable TextView(s)`, cx); }
    });
    const t = theme();
    const v = this.view();
    this.drawnAt = Date.now();
    const strip = this.windowed && this.narrow; // a narrow window: the rooms are a strip on top; the dock and a pane use the slim column when narrow
    const blocks = [];
    const at = new Map(); // spot key -> index in blocks (the direct children of the scroll list)
    this.at = at;
    v.entries.forEach((e) => {
      if (e.who !== "po" && e.who !== "me" && e.it) {
        const k = this.spot(e.s, e.it);
        at.set(k, blocks.length);
      }
      blocks.push(this.entryRow(t, e, v, cx));
    });
    if (!blocks.length && v.pick && v.filter !== "all" && v.raw.length) {
      blocks.push(h_flex().flex_none().p(14).gap(8).items_center()
        .child(div().text_size(12).text_color(t.dim).child("해당 메시지 없음 —"))
        .child(this.button(t, "flt-reset", "전체 보기", (c) => this.setFilter(v.pick, "all", c), { primary: true })));
    }
    if (!blocks.length) {
      blocks.push(div().flex_none().p(14).text_size(12).text_color(t.dim)
        .child(!this.data ? "불러오는 중…" : v.pick ? "이 방에는 아직 대화가 없습니다." : "PO가 없습니다."));
    }
    // The "···" bubbles of whoever is writing now (the room's PO and leaders whose hc status is working): in EVERY filter (a chip hides
    // messages, not what is happening), after the last message, and nothing else reads them (not the unread counts, not `seenNext`, not the
    // follow key, not the spot map).
    for (const x of this.typing(v)) blocks.push(this.typingRow(t, x));
    // Follow the newest: a new message scrolls to the bottom when the room just opened or the person already was at the bottom;
    // a person who scrolled up keeps their place. The handle's numbers are those of the last layout.
    const key = tlKey(`${v.pick}~${v.filter}`, v.shown); // a new filter scrolls to the newest like a new room
    this.lastIdx = Math.max(0, blocks.length - 1);
    if (this.scroll) {
      let atEnd = true;
      try {
        const o = this.scroll.offset(), vp = this.scroll.viewport_size(), ct = this.scroll.content_size();
        atEnd = atBottom(o.y, vp.height, ct.height);
      } catch {}
      if (tlFollow(this.tlSeen, key, atEnd)) {
        const last = blocks.length - 1;
        const go = () => { try { this.scroll?.scroll_to_item(last); } catch {} };
        go();
        try { cx.timer.after(80, () => go()); } catch {}
      }
    }
    this.tlSeen = key;
    // Re-pin after this draw: the person was at the bottom (within PIN_SLACK) and the content may have changed height (a row, the dots, a
    // picture); the handle still holds the last layout, so go to the end now and again once the new layout exists.
    if (this.scroll && this.pin.pinned && !quietNow(this.ui, Date.now())) {
      const last = blocks.length - 1;
      const go = () => { try { if (!quietNow(this.ui, Date.now())) this.scroll?.scroll_to_item(last); } catch {} };
      try { cx.timer.after(60, () => go()); cx.timer.after(220, () => go()); } catch {}
    }
    const waiting = v.tabs.reduce((n, x) => n + x.n, 0); // leaders waiting on a decision, over every room
    const head = v.pick === PO_OTHER ? OTHER_LABEL : v.tabs.find((x) => x.id === v.pick)?.label ?? "";
    const lines = v_flex().id("inbox-list").flex_1().min_h(0).pb(8).overflow_y_scrollbar().mode("always")
      .on_mouse_down("left", (e, c) => { this.listDown(e); this.ui.press = true; this.ui.pressAt = Date.now(); this.dropSel(); c.stop_propagation(); })
      .on_mouse_up("left", () => { this.ui.press = false; })
      .on_mouse_down_out((_e, c) => { this.ui.press = false; if (this.ui.sel) this.dropSel(); if (this.dirty) this.softNotify(c); })
      .when(Boolean(this.scroll), (el) => el.track_scroll(this.scroll)).children(blocks);
    const bar = this.filterBar(t, v);
    const usage = this.usageLine(t, v.pick); // null before the first read (and when there is no cost to show either)
    const panel = this.promptPanel(t, v, cx); // a blocked PO's screen + its keys (null while the room's PO is not waiting on a prompt)
    const room = v_flex().flex_1().min_w(0).min_h(0).when(!strip, (el) => el.h_full()) // beside the rooms the column must fill the row (h_flex centers children)
      .when(!strip && Boolean(head), (el) => el.child(h_flex().flex_none().h(30).px(14).gap(6).items_center().border_b(1).border_color(t.border)
        .child(div().min_w(0).truncate().text_size(13).font_semibold().text_color(t.foreground).child(head))
        .child(div().flex_none().text_size(10.5).text_color(t.dim).child(v.pick === PO_OTHER ? "채팅 없음" : `리더 ${new Set(v.raw.filter((e) => e.leader).map((e) => e.leader)).size}명`))))
      .when(Boolean(usage), (el) => el.child(usage))
      .when(Boolean(bar), (el) => el.child(bar))
      .child(lines)
      .when(Boolean(panel), (el) => el.child(panel))
      .child(this.chatBox(t, v));
    return v_flex().size_full().min_h(0).bg(t.chrome).text_size(13)
      .on_window_mouse_move((e, c) => this.pointer(e, c))
      .on_window_mouse_up("left", (e, c) => this.pointerUp(c, e))
      .on_size_change((size, c) => this.onSize(size.width, c))
      .child(h_flex().h(38).px(this.compact ? 10 : 14).flex_none().items_center().justify_between()
        .child(h_flex().gap(6).items_center()
          .when(!this.paned, (el) => el.child(div().text_size(15).font_semibold().text_color(t.foreground).child("PO 데스크"))) // a pane's own header already says it
          .when(!this.windowed && waiting > 0, (el) => el.child(this.tag(t, `대기 ${waiting}`, "blocked")))
          .child(div().id("inbox-refresh").p(3).rounded(5).text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground))
            .on_mouse_down("left", stop).on_click((_e, c) => { this.gen++; this.busy = false; this.load(c); }).tooltip("새로고침")
            .child(this.busy ? svg(ICON("spinner")).size(13).spin(900) : div().text_size(14).child("↻"))))
        .child(h_flex().gap(8).items_center()
          .child(div().text_size(11).text_color(t.dim).child(this.data ? ago(this.data.at) : ""))
          .when(!this.paned, (el) => el.child(this.button(t, "inbox-beside", "옆에 열기", (c) => { this.openBeside(); c.notify(); }, { tip: "리더 옆 창(페인)으로 엽니다. 리더가 없으면 지금 터미널 옆, 이 탭에 이미 있으면 그쪽으로 갑니다" })))
          .when(!this.windowed, (el) => el.child(this.button(t, "inbox-open", "창 열기", (c) => { this.openWindow(); c.notify(); }, { tip: "PO 데스크 창을 엽니다" })))
          .when(this.windowed, (el) => el.child(div().id("inbox-close").p(4).rounded(5).text_color(t.dim).cursor_pointer().hover((x) => x.bg(t.hover).text_color(t.foreground))
            .on_mouse_down("left", stop).on_click((_e, c) => { try { closeOverlay(safeProps().overlay); } catch {} c.notify(); }).tooltip("닫기")
            .child(svg("mods/pane/close.svg").size(13))))))
      .when(strip, (el) => el.child(this.picker(t, v)))
      .when(!strip && !v.tabs.some((x) => x.id !== PO_OTHER), (el) => el.child(this.poHint(t)))
      .when(Boolean(this.error), (el) => el.child(div().px(14).pb(6).text_size(11).text_color(t.blocked).max_h(48).overflow_hidden().child(this.error)))
      .when(Boolean(this.msg), (el) => el.child(div().id("inbox-msg").px(14).pb(6).text_size(11.5).cursor_pointer().text_color(this.msg.bad ? t.blocked : t.working)
        .on_mouse_down("left", stop).on_click((_e, c) => { this.msg = null; c.notify(); }).child(this.msg.text)))
      .child(strip ? room : h_flex().flex_1().min_h(0).items_stretch().child(this.narrow ? this.slimRooms(t, v) : this.roomList(t, v)).child(room));
  }
}
