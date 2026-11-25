// PO 데스크 (mod id "inbox"): the leaders' reports (~/.herdr-inbox/<leader>.jsonl, written by `report`) and the PO's own lines
// (~/.herdr-inbox/po/<po id>.jsonl).
//  - One PO at a time: a PO terminal carries the labels role=po and po=<id>; the picker lists the live ones and the pick (kept in
//    shared state) decides which leaders' cards, wait counts, "@" menu, chat target and PO lines are shown. A leader belongs to the PO
//    that is its live terminal's parent (else the PO its reports name); the rest sits under "기타", which cannot chat.
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

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, TextareaState, Textarea, TextView, ScrollHandle } from "gpui-base";
import { theme, exec, appHome, checking, window, run, hc, terminals, panes, setBadge, shared, setShared, props, openOverlay, closeOverlay } from "herdr";

const HELPER = () => `${appHome()}/mods/inbox/inbox.cjs`;
const ICON = (name) => `mods/workspace-chrome/${name}.svg`;
const LOAD_TIMEOUT = 20000, LOAD_STALL_MS = 30000, WINDOW_REFRESH_MS = 5000, PANE_REFRESH_MS = 30000, MAX_BUBBLES = 40;
const KIND = { done: ["완료", "working"], decision: ["결정", "blocked"], verify: ["확인", "blocked"], stop: ["중단", "idle"], resume: ["재개", "dim"], other: ["알림", "dim"], start: ["시작", "dim"] };
const WINDOW = { mod: "inbox", kind: "window", key: "inbox", keep: true, width: 480, height: 680, props: { mode: "window" } };
const SENT_KEY = "inbox.sent";
const PICK_KEY = "inbox.po"; // the PO id the person picked last (shared, so it also holds across window reopens)
const CHAT_KEY = "inbox.chat"; // the lines the person sent through the chat box [{ts, ms, text, to, po}] (po: the PO id they went to)
const MAX_CHAT = 30, SHOW_CHAT = 6;
const PASTE_SETTLE_MS = 350; // the PO terminal takes the paste before Enter is pressed
const OPEN_KEY = "inbox.expanded"; // cards the person opened ("자세히"), shared so they stay open across re-renders and window reopens
const MAX_OPEN = 60;
const FOCUS_KEY = "inbox.focus"; // "<leader>|<report time>" the window should show first and open (set by a pane row), "" for none
const SECT_KEY = "inbox.sections"; // {ask:{c,n}, rep:{c}}: which window sections the person collapsed (c) and, for "결정 필요", at which count (n)
const MAX_ROWS = 20; // pane rows below the pinned asks; the rest is in the window
const NO_PO = "이 리더의 PO 터미널을 찾지 못했습니다(리더 터미널의 부모가 role=po 라벨이어야 합니다).";
const OTHER_LABEL = "기타";
const CLIP = "답을 클립보드에 담아 PO 터미널에 붙여 넣습니다(Enter는 직접 누르세요). 클립보드 내용이 바뀝니다.";

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
const PO_OTHER = "~"; // the pick that holds leaders and reports no live PO owns ("기타"); not a valid id, so it never clashes
const cleanPoId = (v) => { const s = String(v ?? "").trim(); return PO_ID.test(s) ? s : ""; };
const isPoTerm = (t) => String(t?.labels?.role ?? "").trim().toLowerCase() === "po";
const poId = (t) => (isPoTerm(t) ? cleanPoId(t?.labels?.po) : "");
// The live PO terminals that have a po id, in terminal order: [{id, address, label, n}]. `label` is the terminal title ("PO · DevNotes"),
// else the id; `n` the live lead-* terminals under it. Two terminals with the same id: the first one is the PO.
function poList(terms) {
  const list = terms ?? [];
  const out = [];
  for (const t of list) {
    const id = poId(t);
    if (!id || out.some((p) => p.id === id)) continue;
    const title = String(t.title ?? "").trim();
    out.push({ id, address: t.address, label: title && title !== t.name && title !== t.address ? title : id, n: list.filter((x) => /^lead-/.test(String(x?.name ?? "")) && x.parent === t.address).length });
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

// Opens an http(s) link with the app's own open_url when a context is at hand, else through the system opener.
function openUrl(url, cx) {
  if (!/^https?:\/\//i.test(url)) return;
  if (cx?.open_url) { try { cx.open_url(url); return; } catch {} }
  const p = window()?.platform;
  if (p === "macos") exec("open", [url]);
  else if (p === "windows") exec("powershell.exe", ["-NoProfile", "-Command", `Start-Process '${url.replace(/'/g, "''")}'`]);
  else exec("xdg-open", [url]);
}

function ago(iso) {
  const m = Math.floor((Date.now() - Date.parse(iso)) / 60000);
  if (!(m >= 0)) return "";
  if (m < 1) return "방금";
  if (m < 60) return `${m}분 전`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}시간 전` : `${Math.floor(h / 24)}일 전`;
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

// Two shapes of one mod: the small summary pane (lane counts, opens the window) and the full chat view, which runs in a floating
// window (props().mode === "window") and works the same as a pane.
export default class Inbox extends View {
  init(_props, cx) {
    this.windowed = safeProps().mode === "window";
    this.badged = ""; // what this app's icon badge shows: only changes are sent, and a 0 at start leaves other mods' badges alone
    this.data = null;
    this.error = null;
    this.busy = false;
    this.busyAt = 0;
    this.gen = 0;
    this.compact = false;
    this.writing = null; // leader whose answer box is open
    this.inputs = new Map(); // leader -> InputState
    this.msg = null; // {text, bad}
    this.copied = null; // key of the command whose 복사 button just ran
    this.chat = TextareaState.new({ value: "", rows: 1, placeholder: "PO에게 말하기 — Enter로 보내기, Shift+Enter로 줄바꿈, @로 리더 부르기" });
    try { this.chat.set_auto_grow(1, 6); } catch {}
    this.menu = null; // the open "@" menu: {start, end, query, items, sel}
    this.changedAt = 0; // the last edit of the box (ms)
    this.sentAt = 0; // the last send (ms)
    this.heldAt = 0; // the last Enter held back as a possible IME confirm (ms)
    this.nlAt = 0; // the last Shift+Enter handled (ms)
    this.chat.on("change", (_e, c) => {
      this.changedAt = Date.now();
      if (this.heldAt && !holdShown(this.changedAt, this.heldAt)) { this.heldAt = 0; try { c.notify(); } catch {} }
      try { if (strayBreak(this.chat.value(), this.sentAt, this.changedAt)) { this.chat.set_value(""); return; } } catch {} // the Enter that sent left a line break
      this.syncMenu(c);
    });
    // The widget's own submit event: with Shift it is a line break, otherwise Enter. Both also arrive as a key press (inputKey); each
    // handler dedupes, so whichever the widget raises, one send / one line break happens.
    this.chat.on("submit", (e, c) => { if (this.menu) this.pickMenu(this.menu.sel, c); else this.enterBox(e?.shift ? "newline" : "send", c); });
    this.pickedAt = 0; // a menu pick just now: the Enter that made it must not also send
    this.chatScroll = null; // the chat lines' scroll handle
    try { this.chatScroll = ScrollHandle.new(); } catch {}
    this.chatSeen = null; // chatKey of the last drawn lines
    this.chatUp = 0; // px the person has wheeled up from the bottom of the chat lines
    // The scroll position of both lists is held by handles the view owns (not only by the element id), and every press that changes the
    // height of a card or a section asks for that spot to stay in view (see reveal).
    this.scroll = null; // the window's list
    this.rowsScroll = null; // the pane's list
    try { this.scroll = ScrollHandle.new(); this.rowsScroll = ScrollHandle.new(); } catch {}
    this.at = new Map(); // spot key -> index of that child in the window's list, rebuilt on every frame
    if (checking()) return;
    this.load(cx);
    // The always-on summary pane owns the slow refresh and the badge; the window refreshes faster while it is open.
    cx.timer.every(this.windowed ? WINDOW_REFRESH_MS : PANE_REFRESH_MS, (cx) => this.load(cx));
  }

  // The number of leaders that wait on a decision, on the app icon badge. Only the summary pane sets it (the window would repeat
  // the same number); tabs-mine counts the wait labels itself for the tab-row button (even with the panel closed).
  badge() {
    if (this.windowed) return;
    const asks = this.asks();
    this.pruneSent(asks);
    const n = asks.length;
    const text = n > 0 ? String(n) : "";
    if (text !== this.badged) { this.badged = text; try { setBadge(text || null); } catch {} }
  }

  // The "pasted into the PO" marker lives in shared state (keyed by leader), so the window and the pane see the same one even after
  // the window closed and reopened. It matches only the same ask (kind, report time, link); the pane drops it once the leader stops waiting.
  askKey(a) { return `${a.kind}|${a.item?.ts ?? ""}|${a.link}`; }
  sentOf(a) { try { return shared(SENT_KEY)?.[a.s.leader] === this.askKey(a); } catch { return false; } }
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
    try { cx.write_to_clipboard(String(text)); } catch (e) { this.say(`복사하지 못했습니다: ${String(e?.message ?? e).slice(0, 120)}`, true); cx.notify(); return; }
    this.copied = key;
    cx.notify();
    try { cx.timer.after(1800, (c) => { if (this.copied === key) { this.copied = null; c.notify(); } }); } catch {}
  }

  // A pane row: open that card (expanded) and show the window with it first. The window reads FOCUS_KEY, so it also follows a row
  // pressed while it is already open (at its next refresh at the latest). Without an item the window just opens.
  openCard(s, it) {
    try {
      if (it) {
        const cur = { ...(shared(OPEN_KEY) ?? {}) };
        const k = this.cardKey(s, it);
        if (it.long && !cur[k]) { cur[k] = 1; const keys = Object.keys(cur); for (const old of keys.slice(0, Math.max(0, keys.length - MAX_OPEN))) delete cur[old]; setShared(OPEN_KEY, cur); }
      }
      setShared(FOCUS_KEY, it ? this.cardKey(s, it) : "");
    } catch {}
    this.openWindow();
  }
  focusKey() { try { return String(shared(FOCUS_KEY) ?? ""); } catch { return ""; } }
  clearFocus() { try { setShared(FOCUS_KEY, ""); } catch {} }

  // Section collapse for the window. "결정 필요" starts open and folds itself while it is empty; a click on its header wins until the
  // number of waiting asks changes, then the default applies again. "결과 보고" starts open and keeps the person's click for good.
  // The section holding the item a pane row opened is never folded.
  collapsed(name, count, force) {
    if (force) return false;
    let st = null;
    try { st = shared(SECT_KEY)?.[name] ?? null; } catch {}
    if (st && (name !== "ask" || st.n === count)) return Boolean(st.c);
    return name === "ask" && count === 0;
  }
  toggleSection(name, count, now) {
    try { setShared(SECT_KEY, { ...(shared(SECT_KEY) ?? {}), [name]: { c: !now, n: count } }); } catch {}
  }

  openWindow() {
    this.msg = null;
    try { openOverlay(WINDOW); } catch (e) { this.say(`창을 열지 못했습니다: ${String(e?.message ?? e).slice(0, 120)}`, true); }
  }

  load(cx) {
    if (this.busy && Date.now() - this.busyAt < LOAD_STALL_MS) return;
    const gen = ++this.gen;
    this.busy = true;
    this.busyAt = Date.now();
    cx.spawn(async (cx) => {
      try {
        const r = await exec("node", [HELPER()], { timeout: LOAD_TIMEOUT });
        if (r.code !== 0) throw new Error(`수집기 종료 코드 ${r.code} ${(r.stderr || "").trim()}`);
        const d = JSON.parse(r.stdout);
        if (gen !== this.gen) return;
        this.data = d;
        this.error = null;
        rememberLeaders();
      } catch (e) { if (gen === this.gen) this.error = `불러오기 실패: ${String(e?.message ?? e).slice(0, 180)}`; }
      finally { if (gen === this.gen) { this.busy = false; this.badge(); cx.notify(); } }
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

  // What the window shows: the live POs (plus "기타" while a leader or report belongs to none), the picked one, and its asks and reports.
  // `tabs` [{id, label, n}]: n = the waiting leaders of that PO.
  view() {
    const terms = this.liveTerms();
    const pos = poList(terms);
    const all = this.asks();
    const reps = this.reports(all);
    const hasOther = all.some((a) => a.owner === PO_OTHER) || reps.some((r) => r.owner === PO_OTHER);
    let last = "";
    try { last = shared(PICK_KEY) ?? ""; } catch {}
    const pick = choosePick(pos, last, hasOther);
    const waiting = (id) => all.filter((a) => a.owner === id).length;
    const tabs = pos.map((p) => ({ id: p.id, label: p.label, n: waiting(p.id) }));
    if (hasOther) tabs.push({ id: PO_OTHER, label: OTHER_LABEL, n: waiting(PO_OTHER) });
    return { terms, tabs, pick, asks: all.filter((a) => a.owner === pick), reports: reps.filter((r) => r.owner === pick) };
  }

  pickPo(id, c) {
    this.heldAt = 0;
    try { setShared(PICK_KEY, id); } catch {}
    this.menu = null;
    this.chatSeen = null; // the other PO's lines: scroll to their bottom
    this.chatUp = 0;
    c.notify();
  }

  peek(s) {
    const term = this.terminalOf(s);
    if (term?.address) run("terminal.peek", { terminal: term.address });
    else this.say("그 리더 터미널이 지금 없습니다.", true);
  }

  say(text, bad = false) { this.msg = { text, bad }; }

  // Delivers the answer as the person's own input: clipboard -> focus the PO pane -> paste. Enter is left to the person.
  send(a, text, cx) {
    const body = String(text ?? "").trim();
    if (!body) { this.say("답을 먼저 적어 주세요.", true); cx.notify(); return; }
    const po = a.po;
    if (!po) { this.say(NO_PO, true); cx.notify(); return; }
    const line = answerLine(a.kind, a.s.leader, body, a.link);
    try {
      cx.write_to_clipboard(line);
      if (!(panes() ?? []).some((p) => p.terminal === po)) {
        run("terminal.keep", { terminal: po }); // finishes in the background: the person focuses the pane and pastes
        this.clearBox(a);
        this.say(`PO(${po})에 창이 없어 열었습니다. 다른 것을 복사하기 전에 PO 터미널에서 붙여넣고 Enter를 누르세요(글은 클립보드에 있습니다).`);
      } else {
        run("pane.focus", { terminal: po });
        try { run("terminal.paste", {}); this.say(`PO(${po})에 붙여 넣었습니다. PO 터미널에서 Enter를 눌러 보내세요.`); }
        catch { this.say(`PO(${po})를 열었습니다. 글은 클립보드에 있으니 붙여넣고 Enter를 누르세요.`); }
        this.clearBox(a);
        if (this.windowed) { try { closeOverlay(safeProps().overlay); } catch {} } // the PO pane takes the keyboard
      }
    } catch (e) { this.say(`붙여 넣지 못했습니다: ${String(e?.message ?? e).slice(0, 160)}`, true); }
    cx.notify();
  }

  clearBox(a) {
    try { setShared(SENT_KEY, { ...(shared(SENT_KEY) ?? {}), [a.s.leader]: this.askKey(a) }); } catch {}
    this.inputs.get(a.s.leader)?.set_value("");
    if (this.writing === a.s.leader) this.writing = null;
  }

  box(leader, cx) {
    let s = this.inputs.get(leader);
    if (!s) {
      s = InputState.new({ value: "", placeholder: "답을 적고 Enter" });
      s.on("submit", (_e, c) => { const a = this.asks().find((x) => x.s.leader === leader); if (a) this.send(a, s.value(), c); });
      this.inputs.set(leader, s);
    }
    return s;
  }

  // ---- PO chat: the text goes to the PO's prompt the same way a panel answer does, then Enter is pressed for the person (submitPo).
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
      if (value.trim() && imeHold(value, this.changedAt, this.heldAt, now)) { this.heldAt = now; c.notify(); return; } // maybe the IME's confirming Enter: only this once
      this.sendChat(c);
    } else if (intent === "newline" && now - this.nlAt > 80) {
      this.nlAt = now;
      try { c.timer.after(40, () => { if (needsNewline(this.changedAt, now)) { try { this.chat.replace("\n"); } catch {} } }); } catch {}
    }
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

  // The chat lines of the picked PO: what the person sent to it and what it said (its own file).
  chatLines(pick) {
    let mine = [];
    try { mine = shared(CHAT_KEY) ?? []; } catch {}
    const said = pick && pick !== PO_OTHER ? this.data?.po?.[pick] ?? [] : [];
    return [...mine.filter((x) => x.po === pick).map((x) => ({ ...x, me: true })), ...said].sort((a, b) => a.ms - b.ms).slice(-SHOW_CHAT);
  }

  // Presses Enter in the PO terminal once the paste has landed (`hc keys`, no <hc ...> tag), and reports a failure in the box's message.
  // The window stays open until then (closing it could drop the timer) and is closed afterwards.
  submitPo(po, c) {
    const fail = (cx, why) => { this.say(`PO(${po})에 글은 넣었지만 Enter를 누르지 못했습니다${why ? `(${why})` : ""}. PO 터미널에서 직접 누르세요.`, true); cx.notify(); };
    const done = () => { if (this.windowed) { try { closeOverlay(safeProps().overlay); } catch {} } };
    const press = (cx) => {
      let r;
      try { r = hc(["keys", po, "enter"]); } catch { fail(cx, ""); done(); return; }
      Promise.resolve(r).then((o) => { if (o && o.code !== 0) fail(cx, String(o.stderr ?? "").trim().slice(0, 80)); }).catch(() => fail(cx, "")).then(done);
    };
    try { c.timer.after(PASTE_SETTLE_MS, press); } catch { press(c); }
  }

  sendChat(c) {
    this.sentAt = Date.now();
    this.heldAt = 0;
    const v = this.view();
    const terms = v.terms;
    const known = v.pick === PO_OTHER ? [] : terms.filter((t) => /^lead-/.test(String(t.name ?? "")) && leaderOwner(terms, t.name, t.address) === v.pick).map((t) => t.name);
    let p;
    try { p = parseMention(composeChat(this.chat.content()), known); } catch { p = { empty: true }; }
    if (p.empty) { this.say("PO에게 보낼 글을 먼저 적어 주세요.", true); c.notify(); return; }
    const tgt = chatTarget(terms, p.to, v.pick);
    if (!tgt.po) {
      this.say(tgt.why === "many" ? "부른 리더들의 PO가 서로 다릅니다. 한 PO의 리더만 함께 부르세요." : tgt.why === "orphan" ? NO_PO
        : "받을 PO를 먼저 고르세요(role=po, po=<id> 라벨이 붙은 PO 터미널만 고를 수 있습니다).", true);
      c.notify();
      return;
    }
    const po = tgt.po;
    let later = false; // the window is closed by submitPo, after Enter
    try {
      c.write_to_clipboard(p.text);
      if (!(panes() ?? []).some((x) => x.terminal === po)) {
        run("terminal.keep", { terminal: po });
        this.say(`PO(${po})에 창이 없어 열었습니다. 다른 것을 복사하기 전에 PO 터미널에서 붙여넣고 Enter를 누르세요(글은 클립보드에 있습니다).`);
      } else {
        const blocked = String(terms.find((t) => t.address === po)?.status ?? "").toLowerCase() === "blocked"; // a prompt waits there: Enter would answer it
        run("pane.focus", { terminal: po });
        try {
          run("terminal.paste", {});
          if (blocked) this.say(`PO(${po})가 질문에 답을 기다리는 중이라 붙여 넣기만 했습니다. PO 터미널에서 확인하고 Enter를 누르세요.`);
          else { this.submitPo(po, c); later = true; this.say(`PO(${po})에 보냈습니다.`); }
        } catch { this.say(`PO(${po})를 열었습니다. 글은 클립보드에 있으니 붙여넣고 Enter를 누르세요.`); }
      }
      try {
        const now = Date.now();
        setShared(CHAT_KEY, [...(shared(CHAT_KEY) ?? []), { ts: new Date(now).toISOString(), ms: now, text: p.text, to: p.to[0] ?? "", po: v.pick }].slice(-MAX_CHAT));
      } catch {}
      this.chat.set_value("");
      this.menu = null;
      if (this.windowed && !later) { try { closeOverlay(safeProps().overlay); } catch {} } // the PO pane takes the keyboard
    } catch (e) { this.say(`붙여 넣지 못했습니다: ${String(e?.message ?? e).slice(0, 160)}`, true); }
    c.notify();
  }

  // The chat footer: the last few lines (the person's and the PO's), the "@" menu, the input with mention chips.
  chatBox(t, v) {
    const lines = this.chatLines(v.pick);
    const key = chatKey(lines);
    if (chatFollow(this.chatSeen, key, this.chatUp)) { try { this.chatScroll?.scroll_to_item(lines.length - 1); } catch {} }
    this.chatSeen = key;
    const bubble = (x, i) => {
      const who = x.me ? null : h_flex().gap(5).items_center()
        .child(div().text_size(10.5).font_semibold().text_color(t.working).child("PO"))
        .when(Boolean(x.to), (el) => el.child(div().text_size(10.5).text_color(t.dim).child(`→ ${shortName(x.to)}`)));
      return h_flex().flex_none().px(4).justify_start().when(x.me, (el) => el.justify_end())
        .child(v_flex().id(`chat-${i}`).max_w("85%").min_w(0).gap(2).px(10).py(5).rounded(10).bg(x.me ? t.selected : t.raised).border(1).border_color(t.border)
          .when(Boolean(who), (el) => el.child(who))
          .child(div().min_w(0).text_size(12.5).text_color(t.foreground).child(x.text))
          .child(div().text_size(10).text_color(t.dim).child(ago(x.ts))));
    };
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
      .when(lines.length > 0, (el) => el.child(v_flex().id("chat-lines").max_h(190).gap(5).overflow_y_scrollbar()
        .on_scroll_wheel((e) => { this.chatUp = chatWheel(this.chatUp, e?.delta?.y); }) // wheel up = positive y
        .when(Boolean(this.chatScroll), (x) => x.track_scroll(this.chatScroll)).children(lines.map(bubble))))
      .when(Boolean(menu), (el) => el.child(menu))
      .when(holdShown(this.changedAt, this.heldAt), (el) => el.child(div().text_size(11).text_color(t.working).child("한 번 더 Enter로 보냅니다")))
      .child(div().truncate().text_size(10.5).text_color(t.dim).child(target ? `받는 PO: ${target.label}` : "받는 PO가 없습니다 — PO를 고르세요"))
      .child(h_flex().gap(6).items_center()
        .child(div().flex_1().min_w(0).on_mouse_down("left", stop)
          .child(Textarea.new(this.chat).token((ctx) => chip(ctx)).min_h(30).px(10).py(5).rounded(8).border(1).border_color(t.input).bg(t.background).text_size(12.5).text_color(t.foreground)))
        .child(this.button(t, "chat-send", "PO에 보내기", (c) => this.sendChat(c), { primary: true, tip: "고른 PO 터미널에 글을 붙여 넣고 Enter까지 눌러 보냅니다(글은 클립보드를 거칩니다). Shift+Enter는 줄바꿈" })));
  }

  // The PO picker: one chip per live PO (title or id, the waiting count in red) and "기타" while something belongs to no live PO.
  picker(t, v) {
    if (!v.tabs.some((x) => x.id !== PO_OTHER)) {
      return div().id("po-hint").flex_none().px(this.compact ? 10 : 14).pb(6).text_size(11).text_color(t.muted)
        .child("PO 터미널에 role=po, po=<id> 라벨을 달면 PO별로 나뉩니다. 지금은 PO가 없어 채팅을 보낼 수 없습니다.");
    }
    return h_flex().id("po-picker").flex_none().px(this.compact ? 10 : 14).pb(6).gap(5).flex_wrap()
      .children(v.tabs.map((x) => {
        const on = x.id === v.pick;
        return h_flex().id(`po-${x.id}`).h(24).px(9).gap(5).items_center().rounded(12).cursor_pointer().on_mouse_down("left", stop)
          .bg(on ? t.selected : t.raised).border(1).border_color(on ? t.foreground + "40" : t.border)
          .hover((s) => s.bg(on ? t.selected : t.hover)).on_click((_e, c) => this.pickPo(x.id, c))
          .tooltip(x.id === PO_OTHER ? "PO를 알 수 없는 리더와 보고(채팅은 보낼 수 없습니다)" : `po=${x.id}`)
          .child(div().max_w(150).truncate().text_size(11.5).font_semibold().text_color(on ? t.foreground : t.muted).child(x.label))
          .when(x.n > 0, (el) => el.child(div().flex_none().px(5).h(15).rounded(8).bg(t.blocked + "26").flex().items_center().text_size(10).text_color(t.blocked).child(String(x.n))));
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

  // A window section header: press it to fold or unfold the section (chevron + title + count that stays visible when folded).
  heading(t, text, count, first, o = {}) {
    const el = h_flex().id(o.id ?? `sec-${text}`).h(first ? 30 : 38).px(8).pt(first ? 4 : 14).items_center().gap(7).flex_none().cursor_pointer()
      .when(!first, (x) => x.border_t(1).border_color(t.border).mt(6))
      .on_mouse_down("left", stop).on_click((_e, c) => { o.toggle?.(); this.reveal(o.id); c.notify(); }).tooltip(o.folded ? "눌러서 펼칩니다" : "눌러서 접습니다")
      .child(div().flex_none().w(12).text_size(11).text_color(t.dim).child(o.folded ? "▸" : "▾"))
      .child(div().min_w(0).truncate().text_size(13).font_semibold().text_color(t.foreground).child(text))
      .child(div().flex_none().px(6).h(16).rounded(8).bg(o.hot && count > 0 ? t.blocked + "26" : t.raised).flex().items_center().text_size(10.5)
        .text_color(o.hot && count > 0 ? t.blocked : t.muted).child(String(count)));
    return el;
  }

  avatar(t, leader) {
    const c = tint(t, leader);
    return div().flex_none().size(28).rounded(14).bg(c + "33").flex().items_center().justify_center().text_size(12).font_semibold().text_color(c)
      .child(shortName(leader).slice(0, 1).toUpperCase());
  }

  // ---- report text. Collapsed (default): the headline, the first meaningful line and the short link. Open: the structured body
  // (blocks come parsed from inbox.cjs): headings, indented list rows, command blocks with a copy button, short link labels.
  mono() { return window()?.platform === "windows" ? "Consolas" : window()?.platform === "macos" ? "Menlo" : "monospace"; }

  // Card text you can drag-select and copy with Cmd+C. Links inside open through openUrl. A press here must not drag the window or toggle anything.
  text(id, html) {
    return TextView.html(id, html).selectable(true).on_link_click((url, c) => openUrl(url, c));
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
      return div().min_w(0).text_size(12.5).text_color(t.foreground).child(this.text(key, p.html));
    }));
  }

  // A speech bubble. Reports with more than a line start collapsed; "자세히" / "접기" flips it (kept per card in shared state).
  bubble(t, s, it, accent) {
    const open = it.long && this.isOpen(s, it);
    const id = `b-${s.leader}-${it.ts}`;
    const toggle = it.long ? div().id(`tg-${s.leader}-${it.ts}`).flex_none().px(8).h(20).rounded(10).flex().items_center().text_size(10.5).cursor_pointer().bg(t.raised)
      .border(1).border_color(t.border).text_color(t.muted).hover((x) => x.bg(t.hover).text_color(t.foreground)).on_mouse_down("left", stop)
      .on_click((_e, c) => { this.toggleOpen(s, it); this.reveal(this.spot(s, it)); c.notify(); }).child(open ? "접기" : "자세히") : null;
    const box = v_flex().min_w(0).px(10).py(7).gap(5).rounded(10).bg(accent ? accent + "1f" : t.raised).border(1).border_color(accent ? accent + "55" : t.border)
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

  nameRow(t, s, it, extra, waiting) {
    return h_flex().gap(6).items_center().min_w(0)
      .child(div().id(`peek-${s.leader}-${it?.ts ?? ""}`).min_w(0).truncate().text_size(12).font_semibold().text_color(tint(t, s.leader)).cursor_pointer()
        .hover((x) => x.text_color(t.foreground)).on_mouse_down("left", stop).on_click(() => this.peek(s)).tooltip("그 리더 터미널 들여다보기").child(shortName(s.leader)))
      .when(Boolean(it), (el) => el.child(this.kindTag(t, it, it.kind, waiting)))
      .child(div().flex_1())
      .when(Boolean(it?.ts), (el) => el.child(div().flex_none().text_size(10.5).text_color(t.dim).child(ago(it.ts))))
      .when(Boolean(extra), (el) => el.child(extra));
  }

  askCard(t, a, cx) {
    const { s, kind, item, link } = a;
    const writing = this.writing === s.leader;
    const done = this.sentOf(a);
    const card = v_flex().id(`ask-${s.leader}`).flex_none().mx(4).mb(8).p(8).gap(6).rounded(10).bg(t.raised).border(1).border_color(t.blocked + "66");
    const head = h_flex().gap(8).items_start()
      .child(this.avatar(t, s.leader))
      .child(v_flex().flex_1().min_w(0).gap(4)
        .child(this.nameRow(t, s, item ? { ...item, kind } : null, null, true))
        .child(item ? this.bubble(t, s, item, t.blocked) : div().text_size(12).text_color(t.dim).child("보고 기록 없이 대기 표시만 있습니다. 링크를 열거나 터미널을 들여다보세요.")));
    const actions = h_flex().gap(6).pl(this.compact ? 0 : 36).items_center().flex_wrap()
      .when(Boolean(link) && link !== item?.link, (el) => el.child(this.button(t, `link-${s.leader}`, "링크 열기", (c) => openUrl(link, c))))
      .when(kind === "verify", (el) => el.child(this.button(t, `ok-${s.leader}`, "확인 완료", (c) => this.send(a, "확인 완료", c), { primary: true, disabled: a.po ? "" : NO_PO, tip: CLIP })))
      .child(this.button(t, `write-${s.leader}`, writing ? "닫기" : "답 쓰기", (c) => { this.writing = writing ? null : s.leader; if (!writing) this.box(s.leader, c); this.reveal(this.spot(s, item)); c.notify(); }, { disabled: a.po ? "" : NO_PO }))
      .child(div().text_size(11).text_color(done ? t.working : t.dim).child(done ? "PO에 넣음 — PO에서 Enter로 보내면 사라집니다" : "PO에서 Enter로 보내면 리더가 받고 사라집니다"));
    card.child(head).child(actions);
    if (!a.po) card.child(div().pl(this.compact ? 0 : 36).text_size(11).text_color(t.dim).child(NO_PO));
    if (writing) {
      const input = this.box(s.leader, cx);
      card.child(h_flex().gap(6).pl(this.compact ? 0 : 36).items_center()
        .child(div().flex_1().min_w(0).on_mouse_down("left", stop).child(Input.new(input).h(30).px(10).items_center().rounded(8).border(1).border_color(t.input).bg(t.background).text_size(12.5).text_color(t.foreground)))
        .child(this.button(t, `send-${s.leader}`, "보내기", (c) => this.send(a, input.value(), c), { primary: true, disabled: a.po ? "" : NO_PO, tip: CLIP })));
    }
    return card;
  }

  chatRow(t, r) {
    const { s, it } = r;
    return h_flex().flex_none().px(8).py(4).gap(8).items_start()
      .child(this.avatar(t, s.leader))
      .child(v_flex().flex_1().min_w(0).gap(4).child(this.nameRow(t, s, it)).child(this.bubble(t, s, it)))
  }

  render(cx) { return this.windowed ? this.full(cx) : this.summary(cx); }

  // One pane row: leader, kind badge, first line (ellipsized). A press opens the window at this item. Plain text: the cards in the window
  // are the selectable ones.
  paneRow(t, s, it, kind, ask) {
    const parts = it ? [it.head, it.lead].filter((x, n, a) => x && a.indexOf(x) === n) : [];
    const text = (parts.join(" — ") || (it?.title ?? "")) || "보고 기록 없이 대기 표시만 있습니다";
    const key = this.cardKey(s, it);
    return h_flex().id(`row-${key}`).flex_none().h(30).px(8).gap(7).items_center().rounded(8).cursor_pointer()
      .bg(ask ? t.blocked + "14" : t.raised).border(1).border_color(ask ? t.blocked + "55" : t.border)
      .hover((x) => x.bg(t.hover)).on_click((_e, c) => { this.openCard(s, it); c.notify(); }).tooltip("누르면 이 보고를 창에서 엽니다")
      .child(div().flex_none().w(74).truncate().text_size(12).font_semibold().text_color(tint(t, s.leader)).child(shortName(s.leader)))
      .child(this.kindTag(t, it, kind ?? it?.kind, ask))
      .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.foreground).child(text))
      .child(div().flex_none().text_size(10.5).text_color(t.dim).child(it?.ts ? ago(it.ts) : ""));
  }

  // The small pane: ONE list, no category step. Open asks pinned on top, then the latest reports; the counts are small badges in the header.
  summary(cx) {
    const t = theme();
    const v = this.view();
    const asks = v.asks;
    const all = v.reports;
    const rows = all.slice(0, MAX_ROWS);
    const badge = (label, n, color) => h_flex().flex_none().h(18).px(7).gap(4).items_center().rounded(9).text_size(10.5)
      .bg(n > 0 && color ? color + "26" : t.raised).text_color(n > 0 && color ? color : t.muted)
      .child(label).child(div().font_semibold().child(String(n)));
    const list = [];
    asks.forEach((a) => list.push(this.paneRow(t, a.s, a.item, a.kind, true)));
    rows.forEach((r) => list.push(this.paneRow(t, r.s, r.it, r.it.kind, false)));
    if (!list.length) list.push(div().px(4).text_size(12).text_color(t.dim).child(this.data ? "받은 보고가 없습니다." : "불러오는 중…"));
    if (all.length > rows.length) {
      list.push(div().id("inbox-more").flex_none().px(8).h(26).flex().items_center().rounded(8).cursor_pointer().text_size(11.5).text_color(t.muted)
        .hover((x) => x.bg(t.hover).text_color(t.foreground)).on_click((_e, c) => { try { setShared(FOCUS_KEY, ""); } catch {} this.openWindow(); c.notify(); })
        .child(`나머지 ${all.length - rows.length}개는 창에서 열 수 있습니다`));
    }
    return v_flex().id("inbox-summary").size_full().min_h(0).bg(t.chrome).p(12).gap(8)
      .child(h_flex().items_center().gap(7)
        .child(div().text_size(14).font_semibold().text_color(t.foreground).child("PO 데스크"))
        .child(badge("결정", asks.length, t.blocked))
        .child(badge("보고", all.length, null))
        .child(div().flex_1())
        .child(div().flex_none().text_size(11).text_color(t.dim).child(this.data ? ago(this.data.at) : "불러오는 중…"))
        .child(this.button(t, "inbox-open", "창 열기", (c) => { this.clearFocus(); this.openWindow(); c.notify(); }, { tip: "PO 데스크 창을 엽니다" })))
      .when(v.tabs.length > 1 || v.pick === PO_OTHER, (el) => el.child(this.picker(t, v)))
      .when(Boolean(this.error), (el) => el.child(div().text_size(11).text_color(t.blocked).max_h(48).overflow_hidden().child(this.error)))
      .when(Boolean(this.msg), (el) => el.child(div().text_size(11.5).text_color(this.msg.bad ? t.blocked : t.working).child(this.msg.text)))
      .child(v_flex().id("inbox-rows").flex_1().min_h(0).gap(4).overflow_y_scrollbar().mode("always").when(Boolean(this.rowsScroll), (el) => el.track_scroll(this.rowsScroll)).children(list));
  }

  // The full chat view (pane or window): both lanes.
  full(cx) {
    const t = theme();
    const v = this.view();
    const asks = v.asks;
    let reports = v.reports.slice(0, MAX_BUBBLES);
    const blocks = [];
    const at = new Map(); // spot key -> index in blocks (the direct children of the scroll list)
    this.at = at;
    const add = (el, key) => { if (key) at.set(key, blocks.length); blocks.push(el); };
    // The item a pane row opened goes first (the first pass has no scroll-to; once drawn, reveal() keeps a pressed spot in view): an ask is moved to the top of its lane, a report gets its own
    // spot above the lanes. Its card was opened by the row; "모두 보기" drops the choice.
    const f = this.focusKey();
    const fa = f ? asks.findIndex((a) => this.cardKey(a.s, a.item) === f) : -1;
    if (fa > 0) asks.unshift(...asks.splice(fa, 1));
    const fr = f && fa < 0 ? reports.findIndex((r) => this.cardKey(r.s, r.it) === f) : -1;
    if (fr >= 0) {
      const [pick] = reports.splice(fr, 1);
      blocks.push(h_flex().h(30).px(8).pt(4).items_center().gap(7).flex_none()
        .child(div().min_w(0).truncate().text_size(13).font_semibold().text_color(t.foreground).child("선택한 보고"))
        .child(div().flex_1())
        .child(this.button(t, "focus-clear", "모두 보기", (c) => { this.clearFocus(); c.notify(); })));
      add(this.chatRow(t, pick), this.spot(pick.s, pick.it));
    }
    const askFold = this.collapsed("ask", asks.length, fa >= 0);
    add(this.heading(t, "결정 필요", asks.length, fr < 0, { id: "sec-ask", hot: true, folded: askFold, toggle: () => this.toggleSection("ask", asks.length, askFold) }), "sec-ask");
    if (!askFold) {
      if (asks.length) asks.forEach((a) => add(this.askCard(t, a, cx), this.spot(a.s, a.item)));
      else blocks.push(div().flex_none().px(10).pb(8).text_size(12).text_color(t.dim).child(this.data ? "기다리는 결정·확인이 없습니다." : "불러오는 중…"));
    }
    const repFold = this.collapsed("rep", reports.length, false);
    add(this.heading(t, "결과 보고", reports.length + (fr >= 0 ? 1 : 0), false, { id: "sec-rep", folded: repFold, toggle: () => this.toggleSection("rep", reports.length, repFold) }), "sec-rep");
    if (!repFold) {
      if (reports.length) reports.forEach((r) => add(this.chatRow(t, r), this.spot(r.s, r.it)));
      else blocks.push(div().flex_none().px(10).text_size(12).text_color(t.dim).child(this.data ? "받은 보고가 없습니다." : ""));
    }
    return v_flex().size_full().min_h(0).bg(t.chrome).text_size(13)
      .on_size_change((size, c) => { const x = size.width < 360; if (x !== this.compact) { this.compact = x; c.notify(); } })
      .child(h_flex().h(38).px(this.compact ? 10 : 14).flex_none().items_center().justify_between()
        .child(h_flex().gap(6).items_center()
          .child(div().text_size(15).font_semibold().text_color(t.foreground).child("PO 데스크"))
          .child(div().id("inbox-refresh").p(3).rounded(5).text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground))
            .on_mouse_down("left", stop).on_click((_e, c) => { this.gen++; this.busy = false; this.load(c); }).tooltip("새로고침")
            .child(this.busy ? svg(ICON("spinner")).size(13).spin(900) : div().text_size(14).child("↻"))))
        .child(h_flex().gap(8).items_center()
          .child(div().text_size(11).text_color(t.dim).child(this.data ? ago(this.data.at) : ""))
          .when(this.windowed, (el) => el.child(div().id("inbox-close").p(4).rounded(5).text_color(t.dim).cursor_pointer().hover((x) => x.bg(t.hover).text_color(t.foreground))
            .on_mouse_down("left", stop).on_click((_e, c) => { this.clearFocus(); try { closeOverlay(safeProps().overlay); } catch {} c.notify(); }).tooltip("닫기")
            .child(svg("mods/pane/close.svg").size(13))))))
      .child(this.picker(t, v))
      .when(Boolean(this.error), (el) => el.child(div().px(14).pb(6).text_size(11).text_color(t.blocked).max_h(48).overflow_hidden().child(this.error)))
      .when(Boolean(this.msg), (el) => el.child(div().id("inbox-msg").px(14).pb(6).text_size(11.5).cursor_pointer().text_color(this.msg.bad ? t.blocked : t.working)
        .on_mouse_down("left", stop).on_click((_e, c) => { this.msg = null; c.notify(); }).child(this.msg.text)))
      .child(v_flex().id("inbox-list").on_mouse_down("left", stop).flex_1().min_h(0).px(4).overflow_y_scrollbar().mode("always").when(Boolean(this.scroll), (el) => el.track_scroll(this.scroll)).children(blocks))
      .child(this.chatBox(t, v));
  }
}
