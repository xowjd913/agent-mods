// UI 모드 (mod id "inbox"): the leaders' reports (~/.herdr-inbox/<leader>.jsonl, written by `report`) and the PO's own lines
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
import { theme, exec, appHome, checking, window, run, hc, terminals, panes, focused, setBadge, shared, layouts, setShared, props, openOverlay, closeOverlay, watchFolder, pickFiles, home, readTextFile } from "herdr";

const HELPER = () => `${appHome()}/mods/inbox/inbox.cjs`;
const ICON = (name) => `mods/workspace-chrome/${name}.svg`;
const LOAD_TIMEOUT = 20000, LOAD_STALL_MS = 30000, WINDOW_REFRESH_MS = 5000, PANE_REFRESH_MS = 30000, STATUS_POLL_MS = 1500, WATCH_DEBOUNCE_MS = 250;
const KIND = { done: ["완료", "working"], decision: ["결정", "blocked"], verify: ["확인", "blocked"], stop: ["중단", "idle"], resume: ["재개", "dim"], other: ["알림", "dim"], start: ["시작", "dim"] };
const WINDOW = { mod: "inbox", kind: "window", key: "inbox", keep: true, width: 720, height: 680, props: { mode: "window" } };
const SENT_KEY = "inbox.sent";
const SOLO_PICK_KEY = "inbox.solo"; // #90: the room picked in solo mode (kept apart, so a PO appearing for a moment does not lose the PO pick)
const PICK_KEY = "inbox.po"; // the PO id the person picked last (shared, so it also holds across window reopens)
const CHAT_KEY = "inbox.chat"; // the lines the person sent through the chat box [{ts, ms, text, to, po}] (po: the PO id they went to)
const MAX_CHAT = 100, MAX_ENTRIES = 80; // MAX_ENTRIES: the newest timeline entries drawn (a waiting one is always drawn)
const SNAP_KEY = "inbox.snap"; // {<room id>: {seen, ts}}: the "안 읽은 것" base of a room as it was when opened, shared by every copy for a while
const SEEN_KEY = "inbox.seen"; // {<room id>: ms of the newest message the person had on screen when last opening that room}
const WIDE_MIN = 520; // two columns (rooms | room) from this width; narrower: the window shows the rooms as a strip on top, the dock and a pane as the slim column
const ROOM_W = 168, SLIM_W = 58; // the window's room list / the dock's slim room column (initial circle + badges, the project as the tooltip)
const PASTE_SETTLE_MS = 350; // the PO terminal takes the paste before Enter is pressed
const PANE_POLL_MS = 300, PANE_WAIT_MS = 6000; // a send to a PO with no pane: how often / how long to wait for the pane the send opened
const PROMPT_TIMEOUT_MS = 5000, PROMPT_RETRY_MS = 2000; // a screen read that has not answered by then ends as "could not read" and is tried again after PROMPT_RETRY_MS
const BANG_READ_MS = 6000; // a '!' command's screen read must answer within this, else it is refused and the busy flag is released
const PROMPT_REFRESH_MS = 3000, PROMPT_LINES = 40; // a blocked PO's screen is re-read this often while shown (the last PROMPT_LINES lines are read)
const BADGE_KEY = "inbox.badge"; // {id, ts}: the copy (dock / pane) that writes the app icon badge
const OPEN_KEY = "inbox.expanded"; // cards the person opened ("자세히"), shared so they stay open across re-renders and window reopens
const MAX_OPEN = 60;
// The labels that make a hub terminal (profile: labels.role = hub.role, hub.idLabel = <id>); text built when shown, since the profile loads after the module.
const hubTag = () => `${NAMES.labelRole}=${NAMES.hubRole}`;
const NO_PO = () => `이 리더의 PO 터미널을 찾지 못했습니다(리더 터미널의 부모가 ${hubTag()} 라벨이어야 합니다).`;
const OTHER_LABEL = "PO 모름";
const OTHER_TIP = "PO를 알 수 없는 리더와 보고: 이미 닫힌 리더인데 보고 줄에 po가 없고 그 PO도 지금 없는 것(이 변경 전에 쓴 보고 줄 등). 여기서는 채팅을 보낼 수 없습니다";
const CLIP = "답을 클립보드에 담아 PO 터미널에 붙여 넣고 Enter까지 눌러 보냅니다(PO가 질문 중이면 붙여 넣기만 합니다). 클립보드 내용이 바뀝니다.";

// names:begin
// The names this desk recognizes: which terminals are reporting agents and hubs, the labels it reads, the answer line (the profile, docs/inbox-contract.md
// §9-§10). The defaults are today's behavior; `node inbox.cjs` prints the loaded profile as `names` (profile.cjs namesOf) and the desk applies it
// with setNames(). The mods cannot require a .cjs file, so this block is copied verbatim between the markers into inbox/main.js and every other mod that reads names
// (leader-tabs, agent-groups, work, tabs-mine, prs; a test keeps them identical and checks DEFAULT_NAMES against profile.cjs).
const DEFAULT_NAMES = Object.freeze({
  agentName: "^lead-[a-z0-9_-]+$", agentRole: "leader", titlePrefix: "^\\s*리더\\s*·\\s*", titlePrefixText: "리더 · ", strip: "^lead-", // a reporting agent: its name, its `role` label value, what is cut off a title (pattern + the literal text to put back) / a name
  hubRole: "po", hubIdLabel: "po", hubId: "^[a-z0-9-]{1,40}$", hubDir: "po", // the hub (PO): its `role` value, id label, id pattern, folder
  labelRole: "role", labelWait: "wait", labelWaitLink: "wait-link", labelSession: "session",
  answerLine: 'Panel answer ({kind}) for {agent}: "{text}".{ Target: {link}}',
});
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/; // a hub id becomes a file name whatever its pattern says
function compileNames(n) {
  const re = (s) => { try { return new RegExp(s); } catch { return null; } };
  const c = { ...n, agentRe: re(n.agentName), stripRe: n.strip ? re(n.strip) : null, prefixRe: n.titlePrefix ? re(n.titlePrefix) : null, hubIdRe: re(n.hubId) };
  return c.agentRe && c.hubIdRe && (!n.strip || c.stripRe) && (!n.titlePrefix || c.prefixRe) ? c : null;
}
let NAMES = compileNames(DEFAULT_NAMES);
let NAMES_JSON = "";
// Applies the names the profile gave (null = defaults). Compiles only when they changed (the mods call this on every render); true when they did.
const setNames = (n) => {
  const key = JSON.stringify(n ?? null);
  if (key === NAMES_JSON && NAMES) return false;
  NAMES_JSON = key;
  NAMES = compileNames({ ...DEFAULT_NAMES, ...(n && typeof n === "object" ? n : {}) }) ?? compileNames(DEFAULT_NAMES);
  return true;
};
// Sharing: the desk and the work board load the profile (their helper prints `names`) and publish it; every other mod follows what is shared. In the helper
// (node) there is no `shared`, so both are inert there.
const NAMES_SHARED = "inbox.names";
const adoptNames = (n) => {
  const changed = setNames(n);
  try { if (typeof setShared === "function" && JSON.stringify(shared(NAMES_SHARED) ?? {}) !== JSON.stringify(n ?? {})) setShared(NAMES_SHARED, n ?? {}); } catch {}
  return changed;
};
const syncNames = () => { try { return typeof shared === "function" ? setNames(shared(NAMES_SHARED)) : false; } catch { return false; } };
const isAgentName = (v) => NAMES.agentRe.test(String(v ?? ""));
const labelOf = (t, key) => String(t?.labels?.[NAMES[key]] ?? "").trim(); // key: labelRole | labelWait | labelWaitLink | labelSession | hubIdLabel
const roleIs = (t, role) => Boolean(role) && labelOf(t, "labelRole").toLowerCase() === String(role).toLowerCase();
const isHubTerm = (t) => roleIs(t, NAMES.hubRole);
const isAgentTerm = (t) => roleIs(t, NAMES.agentRole);
const cleanPoId = (v) => { const s = String(v ?? "").trim(); return SAFE_ID.test(s) && NAMES.hubIdRe.test(s) ? s : ""; };
const poId = (t) => (isHubTerm(t) ? cleanPoId(labelOf(t, "hubIdLabel")) : "");
// The line pasted into the hub terminal. One line (newlines folded to spaces) so the submit keeps it as a single user message. A `{… {link} …}`
// group of the template is kept (without its braces) only when there is a link.
function answerLine(kind, leader, text, link) {
  const body = String(text ?? "").replace(/\s*\n\s*/g, " ").trim();
  const vals = { kind: String(kind ?? ""), agent: String(leader ?? ""), text: body, link: String(link ?? "") };
  return NAMES.answerLine.replace(/\{([^{}]*)\{link\}([^{}]*)\}/g, (_, a, b) => (vals.link ? `${a}{link}${b}` : "")).replace(/\{(kind|agent|text|link)\}/g, (_, k) => vals[k]);
}
// names:end

// Which terminal is a waiting leader. Copied verbatim from inbox.cjs (a test keeps them identical); tabs-mine uses the same line.
const waitingKind = (t) => (isAgentName(t?.name) ? (["decision", "verify"].find((k) => k === labelOf(t, "labelWait").toLowerCase()) ?? "") : "");

// leaderName:begin
// The name a person knows a leader by: its Herdr session name. ONE rule for the inbox (cards, rows), agent-groups (leader headers), leader-tabs (tab text) and work (session rows).
// The mods cannot require a .cjs file, so this block is copied verbatim between the markers into inbox/main.js, agent-groups, leader-tabs and work
// (a test keeps them identical). Order: the live terminal title -> the `session` label -> the last name remembered for that leader
// (`memo`, {<hc name>: name}) -> the hc name ("lead-po-inbox" -> "po inbox"). The "리더 · " prefix is dropped: the place already says
// it is a leader, and the name then reads as its task.
const sessionName = (s) => String(s ?? "").replace(/^[^\p{L}\p{N}\p{Ps}\p{Pi}]+/u, "").replace(NAMES.prefixRe ?? /$^/, "").trim();
const liveName = (term) => [term?.title, labelOf(term, "labelSession")].map(sessionName).find((n) => n && n !== term?.name && n !== term?.address && n.toLowerCase() !== "claude") ?? "";
const leaderName = (leader, term, memo) => liveName(term) || sessionName(memo?.[leader]) || String(leader ?? "").replace(NAMES.stripRe ?? /$^/, "").replace(/-/g, " ").trim() || String(term?.address ?? "");
// The memo with the live names of `terms` merged in; null when nothing changed. At most `max` leaders are kept (oldest dropped).
function rememberNames(memo, terms, max = 60) {
  const next = { ...(memo ?? {}) };
  let changed = false;
  for (const t of terms ?? []) {
    const n = isAgentName(t?.name) ? liveName(t) : "";
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
  return parent && isHubTerm(parent) ? parent.address : null;
}


// chat:begin
// The chat box of the window: "@" mentions, the menu of live leaders and which PO a line goes to. Pure. The mods cannot require a
// .cjs file, so this block is copied verbatim between the markers into inbox/main.js (a test keeps them identical).
const MENTION_END = "(?=$|[\\s.,!?:;)])";
// The agent pattern without its anchors, for finding "@<name>" inside a text.
const mentionRe = () => new RegExp(`(^|\\s)@(here|(?:${NAMES.agentName.replace(/^\^/, "").replace(/(?<!\\)\$$/, "")}))${MENTION_END}`, "g");
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
  const empty = flat.replace(mentionRe(), (m, pre, name) => {
    if (name === "here") here = true;
    else if (known.includes(name)) { if (!to.includes(name)) to.push(name); } else return m;
    return pre;
  }).trim() === "";
  const text = flat.replace(/(^|\n)@here[.,!?:;)]+ ?/g, "$1").replace(HERE_PUNCT, "").replace(HERE, "$1").replace(/[ \t]+/g, " ").replace(/ ?\n ?/g, "\n").replace(/\n{3,}/g, "\n\n").replace(/^[\s,.:;!?)]+/, (m) => (flat.startsWith("!") ? m : "")).trim(); // a "!" the person started with is theirs (a "!cmd" line, #93); only punctuation left by a removed mention goes
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
const imeHold = (value, changedAt, heldAt, now, atEnd = true) => {
  if (Number(heldAt) > 0 && Number(changedAt) <= Number(heldAt) + 100) return false;
  if (Number(now) - Number(changedAt) < IME_MS) return true;
  return atEnd !== false && IME_TAIL.test(String(value ?? "").trimEnd()); // a syllable still being composed sits at the cursor: with the cursor inside the text the tail is settled
};
// The line break the widget itself puts in the box for a held Enter (it may add it before or after the key handler runs): the held Enter
// must not leave it there, or the person sees a blank line appear before the second Enter. `heldAt`, `now`: ms; HELD_BREAK_MS covers both orders.
const HELD_BREAK_MS = 150;
const strayHeld = (value, heldAt, now) => Number(heldAt) > 0 && Number(now) - Number(heldAt) < HELD_BREAK_MS && /\n$/.test(String(value ?? ""));
// The text with its trailing line breaks cut: what "an edit" is measured on (the widget's own line break for an Enter is not an edit).
const editCore = (value) => String(value ?? "").replace(/\n+$/, "");
// #83: Enter sends from any cursor position. The widget may also put its own line break at the cursor (anywhere in the text, not only at the end):
// `strayAt(prev, value)` is where exactly one "\n" was inserted into `prev` (-1 if the change is anything else), `withoutAt` takes it out again,
// `enterPending(enterAt, now)` says an Enter was pressed just before (or up to 25 ms after) `now`, and `atTextEnd(value, cursor)` is whether the
// cursor is at the end of the text (an unknown cursor counts as the end, the careful side for the IME hold).
const strayAt = (prev, value) => {
  const a = String(prev ?? ""), b = String(value ?? "");
  if (b.length !== a.length + 1) return -1;
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  return b[i] === "\n" && b.slice(0, i) + b.slice(i + 1) === a ? i : -1;
};
const withoutAt = (value, i) => String(value ?? "").slice(0, i) + String(value ?? "").slice(i + 1);
// An Enter pressed with text selected makes the widget REPLACE the selection by "\n" (not insert one): `replacedAt(prev, value)` is {idx, end} when
// `value` is `prev` with the span [idx, end) (at least one character) swapped for one "\n", else null. The span is the selected text to put back.
const replacedAt = (prev, value) => {
  const a = String(prev ?? ""), b = String(value ?? "");
  for (let i = b.indexOf("\n"); i >= 0; i = b.indexOf("\n", i + 1)) {
    const end = a.length - (b.length - i - 1);
    if (end > i && b.slice(0, i) === a.slice(0, i) && b.slice(i + 1) === a.slice(end)) return { idx: i, end };
  }
  return null;
};
const enterPending = (enterAt, now) => Number(enterAt) > 0 && Number(now) - Number(enterAt) >= -25 && Number(now) - Number(enterAt) < HELD_BREAK_MS;
const atTextEnd = (value, cursor) => cursor == null || !Number.isFinite(Number(cursor)) || Number(cursor) >= editCore(value).length;
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
const PO_OTHER = "~"; // the pick that holds leaders and reports no live PO owns ("PO 모름"); not a valid id, so it never clashes
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
    out.push({ id, address: t.address, label: poProject(t) || id, title: title && title !== t.name && title !== t.address ? title : "", n: list.filter((x) => isAgentName(x?.name) && x.parent === t.address).length });
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

// #57: the room the person picked stays until they pick another. The PO list comes from `terminals()`, which can miss a PO for a moment
// (a redraw, a restart of its pane): `choosePick` would then fall to another room, and the chat box would aim at that PO. A picked room
// that was live within PICK_GRACE_MS is held as a "ghost" room (no PO to send to, but the pick, the draft and the room list stay).
// `liveAt` = the last time `last` was seen live (ms, 0 = unknown). -> {pick, ghost}
const PICK_GRACE_MS = 30000;
function settlePick(pos, last, hasOther, liveAt, now) {
  const l = String(last ?? "");
  const pick = choosePick(pos, last, hasOther);
  if (pick === l || !l || !(liveAt > 0) || now - liveAt >= PICK_GRACE_MS) return { pick, ghost: false };
  return { pick: l, ghost: true };
}
// #57: an answer-box draft of a leader that stopped waiting is cleared only after the leader has been gone for DRAFT_GRACE_MS (a leader
// missing from one poll must not wipe what the person was typing). `seen`: leader -> last ms it was waiting. -> the leaders to clear.
const DRAFT_GRACE_MS = 60000;
function staleDrafts(keys, live, seen, now) {
  return [...keys].filter((k) => !live.has(k) && !(now - (seen.get(k) ?? 0) < DRAFT_GRACE_MS));
}
// #74: a draft mirror. Every change of a text box is copied (`mirror`: {text, content, range}); when the box comes back empty without the
// person's own key press (`keyAt`, within DRAFT_KEY_MS) and without a clear of ours (which empties the mirror first), the text is put back.
const DRAFT_KEY_MS = 1000;
const draftWiped = (mirror, value, keyAt, now) => Boolean(mirror) && String(mirror.text ?? "") !== "" && String(value ?? "") === "" && !(Number(now) - Number(keyAt) < DRAFT_KEY_MS);
// #66 (draft per room): the unsent chat text each room holds while another room is shown. `cur` = what the box holds now {text, content, range, pics};
// leaving `from` stores it there (nothing to keep = the room's entry goes), arriving at `to` takes that room's entry out (it is the box again) and
// returns it as `load` (null = an empty box). A room that was left empty keeps no entry; the map is capped (oldest dropped). Pure (no mutation of `map`).
const ROOM_DRAFTS_MAX = 24;
function swapDraft(map, from, to, cur) {
  const out = new Map(map);
  if (from != null) {
    out.delete(from);
    if (cur && (String(cur.text ?? "") !== "" || (cur.pics ?? []).length > 0)) out.set(from, cur);
  }
  const load = to != null && to !== from ? out.get(to) ?? null : null;
  if (to != null && to !== from) out.delete(to);
  while (out.size > ROOM_DRAFTS_MAX) out.delete(out.keys().next().value);
  return { map: out, load };
}
// The "@" menu: "@here" first, then the live leaders of the picked PO (`pick`, a PO id; none for PO_OTHER), by shown name. `query`
// filters by hc name or shown name.
function leaderMenu(terms, memo, query = "", limit = 8, pick = "") {
  const list = terms ?? [];
  const q = String(query ?? "").trim().toLowerCase();
  const leaders = list.filter((t) => pick && pick !== PO_OTHER && isAgentName(t?.name) && findPo(list, t.name, t.address) && leaderOwner(list, t.name, t.address) === pick)
    .map((t) => ({ id: t.name, label: leaderName(t.name, t, memo), sub: t.name }))
    .filter((x, i, a) => a.findIndex((y) => y.id === x.id) === i)
    .sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0)); // code-unit order: the same on every platform
  return [{ id: "here", label: "here", sub: "" }, ...leaders].filter((x) => !q || x.id.toLowerCase().includes(q) || x.label.toLowerCase().includes(q)).slice(0, limit);
}
// #90 solo mode: with NO live PO and NO live lead-* leader, every plain Claude terminal the hook has written lines for is a room of its own (the room id
// is the terminal's address). One PO or one leader anywhere and the desk is the PO structure again (solo rooms are hidden, nothing else changes).
const soloMode = (terms) => { const l = terms ?? []; return poList(l).length === 0 && !l.some((t) => isAgentName(t?.name)); };
// A terminal the solo hook records: no agent name, no parent, no role label (the same test the hook makes).
const soloTerm = (t) => Boolean(t?.address) && !isAgentName(t.name) && !t.parent && !t.labels?.role;
// The solo rooms, in terminal order, as poList's rows ({id, address, label, title, n}): a live plain terminal with at least one recorded line
// (`solo` = the collector's {<terminal id>: [lines]}). The name is the terminal's name, else its title, else its address. A closed terminal has no room (its file stays).
function soloRooms(terms, solo) {
  const have = solo ?? {};
  const out = [];
  for (const t of terms ?? []) {
    if (!soloTerm(t) || !Array.isArray(have[t.address]) || !have[t.address].length || out.some((r) => r.id === t.address)) continue;
    const name = String(t.name ?? "").trim(), title = String(t.title ?? "").trim();
    out.push({ id: t.address, address: t.address, label: name || (title && title !== t.address ? title : "") || t.address, title: "", n: 0 });
  }
  return out;
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
  if (p) return { po: p.address };
  const s = pick && pick !== PO_OTHER && soloMode(list) ? list.find((t) => t.address === pick && soloTerm(t)) : null; // #90: a solo room's terminal
  return s ? { po: s.address } : { po: null, why: "none" };
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
  // The PO's reply to a line the desk sent to a leader (#58): the hook gives a prompt and its reply the same pid, and the prompt matched a desk
  // record that has a `to`. Only the 1:1 view reads it (`about`); the bubble does not say "→ leader", since the reply is to the person.
  const about = new Map();
  if (room && room !== PO_OTHER) for (const x of says ?? []) {
    if (x.me) {
      const t = full(x.text), c = core(x.text), p = cut(x.text);
      const i = sentBy.findIndex((m, j) => !taken.has(j) && (x.ms - (Number(m.ms) || 0)) >= -60000 && (x.ms - (Number(m.ms) || 0)) <= 11 * 60000 && (full(m.line) === t || full(m.text) === t || (c.length > 1 && (core(m.line) === c || core(m.text) === c)) || (p && (full(m.line).startsWith(p) || full(m.text).startsWith(p)))));
      if (i >= 0) { taken.add(i); if (x.pid && sentBy[i].to) about.set(x.pid, sentBy[i].to); continue; }
      out.push({ key: `me|${x.ms}|${x.text}`, who: "me", id: "", at: Number(x.ms) || 0, ms: Number(x.ms) || 0, ts: x.ts, text: unwrapTags(x.text), to: "", kind: "chat", status: "sent", typed: true, ...(x.imgs?.length ? { imgs: x.imgs } : {}) });
      continue;
    }
    out.push({ key: `po|${x.ms}|${x.text}`, who: "po", ms: Number(x.ms) || 0, ts: x.ts, text: unwrapTags(x.text), to: x.to || "", ...(!x.to && x.pid && about.get(x.pid) ? { about: about.get(x.pid) } : {}) });
  }
  for (const x of mine ?? []) if (x.po === room) out.push({ key: `me|${x.ms}|${x.text}`, who: "me", id: x.id || "", at: Number(x.at ?? x.ms) || 0, ms: Number(x.ms) || 0, ts: x.ts, text: x.text, to: x.to || "", ...(x.tos?.length ? { tos: x.tos } : {}), kind: x.kind || "chat", status: liveStatus(x.status || "sent", x.at ?? x.ms, now), ...(x.imgs?.length ? { imgs: x.imgs } : {}) });
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
  const tos = [...new Set((Array.isArray(rec?.tos) ? rec.tos : []).map((x) => String(x ?? "")).filter(Boolean))].slice(0, 8); // every leader the line names (#58); `to` stays the first
  return { id: `${ms}-${String(seq ?? "")}`, at: ms, ts: new Date(ms).toISOString(), ms, text, ...(imgs.length ? { imgs } : {}), line: cleanText(rec.line ?? text).slice(0, 4000), to: String(rec.to ?? ""), ...(tos.length > 1 ? { tos } : {}), po: String(rec.po), kind: CHAT_KINDS.includes(rec.kind) ? rec.kind : "chat", ak: String(rec.ak ?? ""), status: CHAT_STATUS.includes(status) ? status : "failed" };
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
// {options: [{key, label, on}], head: the up to 2 lines right above the choices, tabs: the tab bar line of a multi-question prompt or ""}.
// Options only when they are 1..N (2 or more). A choice may carry description lines under it (AskUserQuestion: the row is indented deeper than the
// number): those belong to the choice above and do not break the run. The tab bar ("← ☐ Scope  ☐ Priority  ✔ Submit →") is the line with arrows and
// checkbox marks somewhere above the choices; it is kept so the desk can offer the tab keys.
const promptCol = (l) => l.length - l.replace(/^[\s│┃|]*/, "").length;
const PROMPT_TABS = /←.*→|→.*←/; // the bar has both arrows (and a checkbox mark, below)
const PROMPT_MARK = /[☐☒☑✔✓□■]/;
function promptParse(text) {
  const lines = promptTail(text, 24);
  const num = lines.map((l) => PROMPT_NUM.exec(l));
  const none = { options: [], head: [], tabs: "" };
  // the numbered row that owns line i: itself, or the one up to 4 lines above it when every line between is a description (indented deeper than its number)
  const owner = (i) => {
    for (let j = i; j >= 0 && i - j <= 4; j--) {
      if (!num[j]) continue;
      const col = lines[j].search(/\d/);
      for (let k = j + 1; k <= i; k++) if (promptCol(lines[k]) <= col && !/^[^\p{L}\p{N}]*$/u.test(lines[k])) return -1; // a rule line (no letters or digits) between choices is skipped
      return j;
    }
    return -1;
  };
  let end = lines.length - 1;
  for (let skip = 0; end >= 0 && !num[end] && skip < 6 && promptFooter(lines[end]); skip++) end--;
  if (end < 0) return none;
  end = owner(end);
  if (end < 0) return none;
  const rows = [end];
  while (Number(num[rows[rows.length - 1]][2]) > 1) {
    const prev = owner(rows[rows.length - 1] - 1);
    if (prev < 0) break;
    rows.push(prev);
  }
  rows.reverse();
  const options = rows.map((j) => { const m = num[j]; return { key: m[2], label: m[3].trim().slice(0, 80), on: m[1] === "❯" || m[1] === "›" }; });
  if (options.length < 2 || !options.every((o, i) => Number(o.key) === i + 1)) return none;
  const start = rows[0];
  const tabs = lines.slice(Math.max(0, start - 5), start).reverse().find((l) => PROMPT_TABS.test(l) && PROMPT_MARK.test(l)) ?? ""; // only near the question: an arrow line far up is output
  return { options: options.slice(0, 8), head: lines.slice(Math.max(0, start - 2), start), tabs: tabs.replace(/[│┃|]/g, " ").replace(/\s+/g, " ").trim() };
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
  const want = squeeze(cleanText(line)).replace(/^!\s*/, ""); // bash mode draws the "!" apart from the command
  if (!want) return false;
  const hay = squeeze(cleanText(screen).split("\n").filter((l) => l.trim()).slice(-14).join("\n"));
  if (/\n/.test(cleanText(line).trim()) || want.length > 200) return /\[Pasted text/i.test(hay) || hay.includes(want.slice(0, 24)) || hay.includes(want.slice(-24));
  return hay.includes(want.slice(0, 24)) || hay.includes(want.slice(-24));
}
// A desk line that is a shell command for the PO's own prompt ("!ls": Claude Code's bash mode starts with "!"). null for any other text,
// "" for a bare "!"; "!!" is not one. The command is the rest of the line, trimmed.
const bangCommand = (text) => { const m = /^\s*!(?!!)([\s\S]*)$/.exec(String(text ?? "")); return m ? m[1].trim() : null; };
// What stands in the PO's input box on its screen: the text after the last prompt mark (❯ > ›) among the last 14 lines (box borders ignored), "" for an empty
// box, null when no prompt line is there. A dim placeholder hint reads as text (colors are not on the screen), so the desk then refuses: it never types over text.
function promptInput(screen) {
  const lines = cleanText(screen).split("\n").filter((l) => l.trim()).slice(-14);
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = /^[\s│┃|]*([❯>›])(?:\s+(.*?))?[\s│┃|]*$/.exec(lines[i]);
    if (m) return (m[2] ?? "").trim();
  }
  return null;
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
// #58: "특정 리더만" — the 1:1 view of one leader inside the picked room, on top of the chips (the chip then filters that leader's entries).
// A leader's entries are its reports (who "l:<leader>", also the made-up waiting one) and the person's lines to it (who "me", `to` = the leader).
const entryLeader = (e) => (String(e?.who ?? "").startsWith("l:") ? String(e.who).slice(2) : "");
// The leaders that have an entry in the room, by shown name: [{id, label, waiting}] (waiting = one of its entries waits on the person).
function roomLeaders(entries, label = (id) => id) {
  const out = [];
  for (const e of entries ?? []) {
    const id = entryLeader(e);
    if (!id) continue;
    const had = out.find((x) => x.id === id);
    if (had) had.waiting = had.waiting || Boolean(e.waiting);
    else out.push({ id, label: String(label(id) ?? id), waiting: Boolean(e.waiting) });
  }
  return out.sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
}
// The leader to filter by: `leader` while the room still has it, else "" (= everyone; a leader that left the room goes back to 전체).
const settleLeader = (choices, leader) => (leader && (choices ?? []).length >= 1 && (choices ?? []).some((x) => x.id === leader) ? String(leader) : "");
// Only the leaders whose terminal is open now stay as choices (a closed leader's session is gone: its history stays under "전체"). A leader is live when a
// terminal carries its hc name, or sits at the address its summary recorded. `sums` = [{leader, terminal}].
const aliveLeaders = (choices, terms, sums) => (choices ?? []).filter((c) => (terms ?? []).some((t) => t.name === c.id || (t.address && (sums ?? []).some((s) => s.leader === c.id && s.terminal === t.address))));
// Attributed by a field only, never by guessing from the text: the person's line whose `to` / `tos` names the leader (a chat with @lead-x, an
// answer button of its card), and the PO's line whose `to` names it or whose `about` does (its reply to a prompt the desk sent to that leader).
const leaderEntries = (entries, leader) => (leader ? (entries ?? []).filter((e) => entryLeader(e) === leader
  || (e?.who === "me" && (e.to === leader || (e.tos ?? []).includes(leader))) || (e?.who === "po" && (e.to === leader || e.about === leader))) : entries ?? []);
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
  const leaders = list.filter((p) => p.terminal && isAgentTerm(byAddr.get(p.terminal)));
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
// "추천"/"권장"/"recommend" mark a recommended option, but not when negated: "비추천", "비권장", "추천하지 않", "권장하지 않", "not recommended",
// "don't recommend" (a negated option is one the report says NOT to pick, so it never gets the "(추천)" mark).
const REC_MARK = /추천|권장|recommend/i;
const REC_NEG = /비\s*추천|비\s*권장|(?:추천|권장)\s*(?:하지\s*(?:않|말)|안\s*함|드리지\s*않|할\s*수\s*없)|(?:not|n['’]t|never)\s+(?:be\s+)?recommend|un-?recommend/i;
const recMarked = (txt) => REC_MARK.test(String(txt ?? "")) && !REC_NEG.test(String(txt ?? ""));
function decisionOptions(body) {
  const nums = new Set();
  let rec = 0;
  for (const line of String(body ?? "").split(/\r?\n/)) {
    // "1안: …", "1안) …", and with a marker between the number and the colon: "1안(추천): …", "1안 (추천): …", "**1안** [권장]: …"
    let m = line.match(/^\s*(?:[-*]\s*)?(?:\*\*)?([1-3])안(?:\*\*)?\s*(?:[(（\[［]([^)）\]］\n]{0,24})[)）\]］])?\s*(?:\*\*)?\s*[:：)]\s*\S/);
    if (m) {
      const n = Number(m[1]);
      nums.add(n);
      // the recommendation marked on the option itself: "1안(추천):" or "… (추천)" / "★" at the end of its line
      if (!rec && (recMarked(m[2]) || recMarked(line.match(/[(（\[［]([^)）\]］\n]{0,24})[)）\]］]\s*$/)?.[1]) || /[★⭐]\s*$/.test(line))) rec = n;
      continue;
    }
    m = line.match(/^\s*(?:[-*]\s*)?추천\s*[:：]\s*([1-3])안/);
    if (m && !rec) rec = Number(m[1]);
  }
  const options = [...nums].sort((x, y) => x - y);
  if (options.length < 2) return { options: [], recommended: 0 };
  return { options, recommended: options.includes(rec) ? rec : 0 };
}
// What a decision report offers when it has no "N안:" lines (#62): its "추천: ..." and "답: ..." lines, shown on the card without opening it,
// and the quoted answers after "답:" ("둘 다 진행" / "#59만" / "보류", also “…” and 「…」) as answer buttons when there are at least two.
// Read strictly from the body; "답" must start a word (not "정답:" / "답변:"). The "추천" line may carry the "답:" part after it on the same line.
// -> { lines: ["추천: ...", "답: ..."], answers: ["둘 다 진행", ...], recommended: "<the answer the 추천 text names>" | "" }
function decisionHints(body) {
  const lines = [];
  let answers = [];
  let rec = "";
  const cut = (s) => (s.length > 160 ? `${s.slice(0, 159)}…` : s);
  for (const raw of String(body ?? "").split(/\r?\n/)) {
    const line = raw.replace(/^\s*(?:[-*]\s*)?/, "").trim();
    const r = line.match(/^추천\s*[:：]\s*(.*?)(?:\s*[.。]?\s+답\s*[:：].*)?$/);
    if (r && r[1] && !rec) { rec = r[1].trim(); lines.push(cut(`추천: ${rec}`)); }
    const a = line.match(/(?:^|[\s.。,)])답\s*[:：]\s*(\S.*)$/);
    if (a && !answers.length && !lines.some((x) => x.startsWith("답:"))) {
      const got = [];
      for (const m of a[1].matchAll(/"([^"\n]{1,40})"|“([^”\n]{1,40})”|「([^」\n]{1,40})」/g)) {
        const w = (m[1] ?? m[2] ?? m[3]).trim();
        if (w && !got.includes(w)) got.push(w);
      }
      answers = got.length >= 2 && got.length <= 6 ? got : [];
      lines.push(cut(`답: ${a[1].trim()}`));
    }
  }
  return { lines, answers, recommended: rec ? (answers.find((w) => rec.includes(w)) ?? "") : "" };
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
    if (!isAgentName(n)) continue;
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
  if (soloMode(list)) { // #90: the room is one plain Claude terminal: a single "working" line while it works, and nothing about leaders
    const row = soloRooms(list, { [room]: [""] })[0];
    const term = row ? list.find((t) => t.address === row.address) : null;
    return term && isWorking(term) ? [{ who: "po", solo: true, name: row.label, label: LABEL_WORKING }] : [];
  }
  const hot = busyAddrs(list), states = workStates(list);
  const seen = new Set();
  const leaders = [];
  for (const t of list) {
    const n = String(t?.name ?? "");
    if (!isAgentName(n) || seen.has(n) || leaderOwner(list, n, t.address) !== room) continue;
    if (!hot.has(t.address) && !typingGrace(track?.get(n), now)) continue;
    seen.add(n);
    leaders.push({ who: `l:${n}`, name: leaderName(n, t, memo), label: typingLabel(states, t.address) });
  }
  leaders.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return [...out, ...leaders];
}
// #69: the rooms with work going on, as a Set of room ids (a PO's id, or PO_OTHER): a room is working when its PO, a leader of it, or a team
// member below them is "working" right now. Status only (the terminals the poll already reads), no grace: it goes out as soon as all stop.
// Waiting for an approval ("blocked") is not working: the room's red count / "질문" chip says that.
function roomWorking(terms) {
  const list = terms ?? [];
  const out = new Set();
  const states = workStates(list);
  for (const p of poList(list)) if (states.get(p.address)?.work) out.add(p.id);
  for (const t of list) {
    if (!isAgentName(t?.name) || !states.get(t.address)?.work) continue;
    if (leaderOwner(list, t.name, t.address) === PO_OTHER) { out.add(PO_OTHER); break; }
  }
  return out;
}
// A short text that changes exactly when something the desk shows from the terminals changes: the status, the wait label and the shown
// name of every PO and leader, and whether a leader has work below it (a team member working). The 1.5 s poll redraws a copy only when this
// differs from the last one (no redraw on a quiet second).
function statusSig(terms) {
  const rows = [];
  const hot = busyAddrs(terms), states = workStates(terms);
  for (const t of terms ?? []) {
    const lead = isAgentName(t?.name);
    if (!lead && !poId(t)) continue;
    rows.push(`${t.address}|${String(t.status ?? "")}|${lead ? waitingKind(t) : ""}|${lead ? liveName(t) : ""}|${lead && hot.has(t.address) ? 1 : 0}|${lead && hot.has(t.address) ? typingLabel(states, t.address) : ""}`);
  }
  const w = [...roomWorking(terms)].sort().join(",");
  return rows.sort().join("\n") + (w ? `\n#w:${w}` : ""); // #69: a working terminal that is no PO/leader (a member right under a PO) still moves a room dot
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
// A list item line of a Markdown source: "-", "*" or "+", or "1." / "1)", then a blank and some text.
const MD_ITEM = /^\s*(?:[-*+]|(\d{1,9})[.)])\s+\S/;
// A first line like "[lead-po-inbox] 최종 확인 요청": a [tag], a blank, a short title.
const MD_HEAD = /^\s*\[(?![ xX✓✔]?\])[^\]\n]{1,60}\][ \t]+\S[^\n]{0,60}$/; // not a checkbox line: "[ ] 할 일", "[x] 끝"
// A message text as Markdown for a TextView.markdown(...).raw_html(false): wrapper tags removed first (they would print literally), a line that
// is only 【...】 made bold, images switched off (![x](y) -> a plain link), single line breaks kept as line breaks (Markdown would join them), and
// the list marks people type ("•", "1)") written as real Markdown items with a blank line before the list and after it (#66), so the view draws
// them as a list whose wrapped lines sit under the item text. The words themselves are never changed. Code fences are left as written.
// Never produces HTML: the view shows tags as text. Pure.
// A single "~" is written "\~" so the view does not strike text through between two of them ("3~4.5일 ... 1.5~2일" is a range, not a
// strikethrough); "~~text~~" stays a strikethrough. `code` spans and links/URLs are left as they are (an escape would show inside them). Pure.
const TILDE_KEEP = /(`+[^`\n]*`+|\]\([^)\n]*\)|<?(?:https?:\/\/|www\.)[^\s<>)]*>?)/;
function escTilde(ln) {
  if (!ln.includes("~")) return ln;
  return ln.split(TILDE_KEEP).map((seg, i) => (i % 2 ? seg : seg.replace(/(?<![~\\])~(?!~)/g, "\\~"))).join("");
}
function mdText(text) { return tlMemoGet("m", text, mdTextRaw); }
function mdTextRaw(text) {
  const norm = (ln) => ln.replace(/!\[/g, "!\\[").replace(/^(\s*)[•‣▪◦●・]\s+/, "$1- ").replace(/^(\s*)(\d{1,3})[)）]\s+/, "$1$2. ");
  const src = unwrapTags(text).replace(/\r\n?/g, "\n").split("\n");
  // a first line like "[이름] 종류" over more text is the header of the message: shown bold, as a line of its own
  const first = src.findIndex((l) => l.trim());
  const head = first >= 0 && src.length > first + 1 && src.slice(first + 1).some((l) => l.trim()) && MD_HEAD.test(src[first]) && !src[first].includes("**") && !MD_ITEM.test(norm(src[first]));
  let fence = false, inList = false;
  const rows = [];
  for (let i = 0; i < src.length; i++) {
    const ln = src[i];
    if (/^\s*(?:```|~~~)/.test(ln)) { fence = !fence; inList = false; rows.push({ s: ln, flow: false }); continue; }
    if (fence) { rows.push({ s: ln, flow: false }); continue; }
    let s = escTilde(norm(ln));
    if (head && i === first) s = `**${s.trim()}**`;
    else if (/^\s*【[^】\n]*】[:：]?\s*$/.test(s)) s = `**${s.trim()}**`;
    const m = MD_ITEM.exec(s);
    const item = Boolean(m) && (inList || m[1] === undefined || m[1] === "1"); // a "2025. 11" line is text, not a list that starts at 2025
    const prev = rows[rows.length - 1];
    const blank = !s.trim();
    // blank lines between two items of one list are dropped: a list with a gap between its items is drawn as paragraphs, and a numbered
    // list people write as "1. a", blank, "2. b" must look like the "-" list (compact); a gap only separates real paragraphs
    if (blank && inList) {
      let j = i + 1;
      while (j < src.length && !src[j].trim()) j++;
      if (j < src.length && !/^\s*(?:```|~~~)/.test(src[j]) && MD_ITEM.test(norm(src[j]))) continue;
    }
    // a list needs a blank line before it to be one, and the line after it a blank line to be out of it again
    if (prev?.flow && prev.s.trim() && ((item && !inList) || (!item && !blank && inList && !/^\s/.test(s)))) rows.push({ s: "", flow: true });
    if (blank) inList = false;
    else if (item) inList = true;
    else if (!/^\s{2,}/.test(s)) inList = false;
    rows.push({ s, flow: true, item });
  }
  return rows.map((r, i) => (r.flow && r.s.trim() && rows[i + 1]?.flow && rows[i + 1].s.trim() && !rows[i + 1].item && !/ {2}$/.test(r.s) ? r.s + "  " : r.s)).join("\n");
}
// A whole line that is only **bold** text.
const BOLD_LINE = /^\*\*(\S(?:(?:(?!\*\*).)*?\S)?)\*\*[ \t]*$/;
// The mdText source cut into what is drawn as its own TextView: [{s, bold}]. A line that is only **bold** text is its own block (bold: true, the
// ** removed), because the TextView draws no heavier weight inside a text but the whole view can be given one. Everything between stays
// Markdown as one block. A **bold** run inside a sentence is shown at the normal weight, without markers. Fences are skipped. Pure.
function mdBlocks(md) {
  const out = [];
  let cur = [], fence = false;
  const flush = () => { const s = cur.join("\n").replace(/^\n+|\n+$/g, ""); if (s.trim()) out.push({ s, bold: false }); cur = []; };
  for (const ln of String(md ?? "").split("\n")) {
    if (/^\s*(?:```|~~~)/.test(ln)) { fence = !fence; cur.push(ln); continue; }
    const m = fence ? null : BOLD_LINE.exec(ln);
    if (m) { flush(); out.push({ s: m[1], bold: true }); continue; }
    cur.push(ln);
  }
  flush();
  return out;
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
  // The growth only counts for a view that was at the END OF WHAT IT SHOWED before it (the handle's y is still the old layout's): a person
  // reading higher up (an expanded long bubble) is not dragged down by a new row, however often the content grows (#54).
  const nearPrev = prev > 0 ? y + vh >= prev - PIN_SLACK : true;
  // #67: the viewport got shorter (the input box grew under the list) while the view sat at the end of its old size: the end must stay on screen,
  // so it goes to the end again. A view reading higher up (not pinned, or not near the old end) keeps its place.
  const pvh = Number(st?.vh) || 0;
  const shrunk = pvh > 0 && vh < pvh - 1 && y + pvh >= (prev > 0 ? prev : ch) - PIN_SLACK;
  if (near) return { pinned: true, ct: ch, vh, go: was && (grew || shrunk) && y + vh < ch - 1 };
  if (was && grew && nearPrev) return { pinned: true, ct: ch, vh, go: true };
  if (was && shrunk) return { pinned: true, ct: ch, vh, go: true };
  return { pinned: false, ct: ch, vh, go: false };
}
// #72: the "jump to the newest" button shows while the view is scrolled up by more than JUMP_MIN px from the end (more than PIN_SLACK, so it is never
// there while the view follows), and a list that fits its viewport never shows it.
const JUMP_MIN = 80;
const jumpShown = (y, vh, ch) => (Number(ch) || 0) > (Number(vh) || 0) + 1 && (Number(y) || 0) + (Number(vh) || 0) < (Number(ch) || 0) - JUMP_MIN;
// #67: the box grows to this many rows, then scrolls inside itself (the list above keeps the rest of the height).
const INPUT_MAX_LINES = 4;
// A message the person just sent follows to the newest even from higher up: the first draw that shows a new last entry within SEND_FOLLOW_MS of the
// send (`at` = when it was sent, 0 = none) goes to the end once.
const SEND_FOLLOW_MS = 5000;
const sendFollow = (at, now, key, seen) => Number(at) > 0 && now - Number(at) < SEND_FOLLOW_MS && key !== (seen ?? "");
// ScrollHandle.scroll_to_item(i) reveals that row with the smallest scroll, so on a row TALLER than the viewport (an expanded long bubble, #54)
// it lands on the row's top, then on its bottom, then on its top again: every call flips the view. A re-pin call is therefore made only while the
// view is not at its end AND the content grew since the last call (`seen` = the content height at that call): within PIN_SLACK of the end, with
// nothing new to catch up on, a view stays where it is (a call there would flip it just the same).
const pinCall = (o, seen) => !atBottom(o?.y, o?.vh, o?.ch) && (Number(o?.ch) || 0) > (Number(seen) || 0) + 1;
// ---- selection: a drag-selected text must not be rebuilt under the pointer
const SEL_HOLD_MS = 120000, PRESS_HOLD_MS = 8000;
// st = {sel: a selection is settled, selAt, press: the pointer is down in the list, pressAt}. While true, background redraws wait.
const quietNow = (st, now) => Boolean((st?.sel && now - (st.selAt || 0) < SEL_HOLD_MS) || (st?.press && now - (st.pressAt || 0) < PRESS_HOLD_MS));

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

// ---- "PO 새로 시작": the desk asks the PO for a handoff note, then clears it (/clear) and starts it again (/PO). Everything here is pure.
// The note is ~/.herdr-inbox/po/<po id>.handoff.md. Steps (RESTART_STEPS): 노트 요청 -> 노트 작성됨 -> 대화 비움 -> PO 다시 시작. `n` = how many are done.
const RESTART_STEPS = ["노트 요청", "노트 작성됨", "대화 비움", "PO 다시 시작"];
const RESTART_WAIT_MS = 5 * 60 * 1000; // a note that has not appeared by then: 다시 / 취소, nothing is cleared
const RESTART_POLL_MS = 2000; // how often the note file and the PO's state are looked at
const RESTART_CLEAR_MS = 20 * 1000; // how long the PO gets to finish /clear (its turn counter goes up) before /PO is given up on
const RESTART_MARK = "[desk:handoff]"; // first words of the request (the PO's own history shows it; the desk never reads the screen)
// Why the button cannot be pressed ("" when it can): the PO must be idle (not working, not on a prompt), a restart of it must not already run.
function restartBlock({ po = "", status = "", running = false } = {}) {
  const s = String(status ?? "").trim().toLowerCase();
  if (!po) return "PO 터미널을 찾지 못했습니다";
  if (running) return "이 PO를 새로 시작하는 중입니다";
  if (s === "blocked") return "PO가 질문 중입니다 — 먼저 질문에 답하세요";
  if (s === "working") return "PO가 작업 중입니다 — 끝난 뒤에 누르세요";
  return "";
}
// ---- "원격 연결 켜기" (#79): one click sends `/remote-control` to the room's terminal through the same `hc send` path as 새로 시작 (sendLine). The desk cannot
// press it for the person any other way (a skill cannot run the command). Pure part: why it cannot be pressed now ("" when it can).
const REMOTE_CMD = "/remote-control";
function remoteBlock({ po = "", status = "", running = false, sending = false } = {}) {
  if (sending) return "원격 연결 명령을 보내는 중입니다";
  return restartBlock({ po, status, running });
}
const REMOTE_POLLS = 5, REMOTE_POLL_MS = 1000; // after the send: this many screen reads, this far apart (~5 s)
const REMOTE_URL = /https:\/\/claude\.ai\/code\/[^\s)\]>"'`]+/g;
// What the PO's screen says about Remote Control. `menu` = Claude Code's "already connected" menu (Disconnect this session / Show QR code / Continue), `active` = the
// footer says it is on, `url` = the last session link on screen. Text copied from Claude Code's UI and NOT verified against a real terminal (UNVERIFIED).
function remoteScreen(text) {
  const clean = cleanText(text);
  const lines = clean.split("\n").map((l) => l.trimEnd()).filter((l) => l.trim());
  const tail = lines.slice(-14).join("\n");
  // Only the three numbered option lines together count (prose that merely mentions these words is not the menu).
  const opt = (n, re) => new RegExp(`^\\s*(?:[❯>›▶]\\s*)?${n}[.)]\\s*${re}\\s*$`, "im").test(tail);
  const menu = opt(1, "Disconnect this session") && opt(2, "Show QR code") && opt(3, "Continue");
  const active = menu || /Remote Control (is )?(active|connected)/i.test(lines.slice(-8).join("\n"));
  // `seen` = the transcript line Claude Code prints when it turned on ("/remote-control is active · Continue here, on your phone, or at <url>", copied from a real
  // screen) is on screen and no later line says it was turned off. Weaker than `active`: that line scrolls away, and a disconnect line's wording is UNVERIFIED.
  let on = -1, off = -1;
  lines.forEach((l, i) => { if (/\/?remote[- ]control (is )?(active|connected)/i.test(l)) on = i; if (/remote[- ]control (is )?(disconnected|off|stopped|inactive)|disconnected (this )?session/i.test(l)) off = i; });
  const urls = clean.match(REMOTE_URL) ?? [];
  return { menu, active, seen: active || (on >= 0 && on > off), url: urls.length ? urls[urls.length - 1].replace(/[.,;:]+$/, "") : "" };
}
// The one-line system note for the room's chat. kind: on | already | fail | unknown.
function remoteNote(kind, { url = "", why = "" } = {}) {
  const u = url ? ` — ${url}` : "";
  if (kind === "on") return `원격 연결 켜짐${u}`;
  if (kind === "already") return `이미 켜져 있음${u}`;
  if (kind === "unknown") return "원격 연결 명령을 보냈지만 5초 안에 화면에서 결과를 확인하지 못했습니다. 터미널에서 확인하세요";
  return `켜지 못함: ${why || "알 수 없는 이유"}`;
}
// The line pasted into the PO (English: it is read by an agent). `file` is where the note goes (shown with ~).
function handoffAsk(file) {
  return `${RESTART_MARK} The user will restart you with /clear. Before that, write a handoff note to ${file} (overwrite it; create the folder if needed) so that the next session can continue seamlessly: (1) decisions and final checks the user still has to answer, (2) each running leader with its task, issue/PR and state, (3) what you were doing and the next steps, (4) anything that is only in this conversation. Keep it short and in the user's language. Do nothing else; reply "handoff written" when the file is saved.`;
}
// What the confirm line says: what will happen and how many decisions / final checks still wait on the person.
function restartConfirm(decisions = 0, verifies = 0) {
  const d = Math.max(0, Number(decisions) || 0), v = Math.max(0, Number(verifies) || 0);
  const wait = d + v ? `결정 대기 ${d}건 · 확인 대기 ${v}건이 있습니다(새로 시작해도 리더 쪽 대기는 그대로입니다).` : "결정·확인 대기는 없습니다.";
  return `PO에게 인수인계 노트를 쓰게 한 뒤 대화를 비우고(/clear) /PO로 다시 시작합니다. PO 입력칸은 비어 있어야 합니다(남은 글이 있으면 함께 보내집니다). ${wait}`;
}
// The four steps for the room: `n` done, `fail` = the step at index n failed (so it shows as stopped).
function restartSteps(n = 0, fail = false) {
  const k = Math.max(0, Math.min(RESTART_STEPS.length, Number(n) || 0));
  return RESTART_STEPS.map((label, i) => ({ label, state: i < k ? "done" : i === k ? (fail ? "fail" : "active") : "todo" }));
}
// The note may be fetched (text, not an empty file) and was written after the request (mtime in ms, 1 s slack for coarse file clocks).
const restartNoteFresh = (note, since) => Boolean(note && note.exists && Number(note.size) > 0 && Number(note.ms) >= Number(since) - 1000);
// One poll while the note is awaited: "wait" (no fresh note yet), "timeout" (the time is out), "idle-wait" (the note is there, the PO still works:
// let it finish), "go" (the note is there and the PO is idle for two looks in a row: clear it).
function restartPoll({ note, since, now, status, quiet = 0 } = {}) {
  const fresh = restartNoteFresh(note, since);
  const s = String(status ?? "").trim().toLowerCase();
  if (!fresh) return Number(now) - Number(since) >= RESTART_WAIT_MS ? "timeout" : "wait";
  if (s === "working" || s === "blocked") return "idle-wait";
  return Number(quiet) >= 1 ? "go" : "idle-wait";
}

// ---- Sending goes through `hc send` (the path leaders use), never through the screen: the PO pane may be 2 columns wide, where no row of the
// screen can be matched. `hc send <t> <text> --json` pastes the text and presses Enter; it prints {"started":true,"status":"idle|done","turn":N}
// (status and turn as they were BEFORE the send) or {"error":{"kind":"blocked|status_mismatch|...","message":...}}.
// The result of one `hc send`: ok only on exit code 0 and started === true. `why` is the Korean reason shown to the person, `detail` goes to diag.log.
function restartSendResult(r) {
  const code = r && Number.isFinite(Number(r.code)) ? Number(r.code) : -1;
  const out = String(r?.stdout ?? "").trim(), err = String(r?.stderr ?? "").trim();
  let j = null;
  try { j = JSON.parse(out); } catch {}
  const detail = `code ${code}; stdout ${out.slice(0, 160)}; stderr ${err.slice(0, 160)}`.replace(/\s+/g, " ");
  if (code === 0 && j && j.started === true) {
    const turn = Number(j.turn);
    return { ok: true, turn: Number.isFinite(turn) ? turn : null, status: String(j.status ?? ""), why: "", detail };
  }
  const kind = String(j?.error?.kind ?? "");
  // exit 0 and started:false with no error: `hc send` waited and gave up (a person's unfinished draft in the PO's input) — the text may or may not be in the box
  if (code === 0 && j && j.started === false && !j.error) return { ok: false, notStarted: true, turn: null, status: "", why: "PO가 받아 시작하지 않았습니다(입력창에 쓰던 글이 있는지 확인하세요)", detail };
  const why = kind === "blocked" ? "PO가 질문 중이라 받지 않았습니다"
    : kind === "status_mismatch" ? "PO가 일하는 중이라 받지 않았습니다"
    : j?.error?.message ? `PO가 받지 않았습니다(${String(j.error.message).slice(0, 80)})`
    : `hc send가 실패했습니다(종료 코드 ${code})`;
  return { ok: false, turn: null, status: "", why, detail };
}
// `hc get <t> --json` as {live, status, turn}; null when it did not answer. Status and turn do not depend on the pane's size.
function restartTerm(r) {
  if (!r || Number(r.code) !== 0) return null;
  let j = null;
  try { j = JSON.parse(String(r.stdout ?? "")); } catch { return null; }
  if (!j || typeof j !== "object") return null;
  const turn = Number(j.turn);
  return { live: String(j.state ?? "") === "live" && (j.exit_code === null || j.exit_code === undefined), status: String(j?.status?.state ?? "").trim().toLowerCase(), turn: Number.isFinite(turn) ? turn : null };
}
// Why nothing is sent now ("" when it can be): the terminal must be known and running, not on a prompt, not working (idle or done are both fine).
function restartSendBlock(term) {
  if (!term) return "PO 터미널의 상태를 읽지 못했습니다";
  if (!term.live) return "PO 터미널이 실행 중이 아닙니다";
  if (term.status === "blocked") return "PO가 질문 중입니다";
  if (term.status === "working") return "PO가 일하는 중입니다";
  return "";
}
// After `/clear` was sent (`sent` = the turn counter it reported, i.e. from before the command): "wait" while the PO still works or is on a prompt, or the counter
// has not gone up, "done" once the PO is idle/done and the counter is higher (/clear counts as one turn), "gone" when the terminal is not running any more.
// `done` counts too: herdr turns a "done" PO "idle" only once someone looks at its pane. That the line sent was really "/clear" is proven by restartClearCheck.
function restartClearState(sent, term) {
  if (!term || !term.live) return "gone";
  if (term.status === "working" || term.status === "blocked") return "wait";
  return term.turn !== null && sent !== null && term.turn > sent ? "done" : "wait";
}
// `hc send` does not empty the input box: text left there (a draft the person typed, or a chat line the desk only pasted: held / noenter) is sent together with it.
// The desk cannot read the box (no screen reads), so it blocks on its own records: a held / noenter chat line of this room younger than RESTART_DRAFT_MS.
const RESTART_DRAFT_MS = 10 * 60 * 1000;
function restartDraft(mine, room, now) {
  return (mine ?? []).some((m) => m && m.po === room && (m.status === "held" || m.status === "noenter") && Number(now) - (Number(m.at ?? m.ms) || 0) < RESTART_DRAFT_MS)
    ? "먼저 PO 입력칸에 남은 글을 보내거나 지우세요(남아 있으면 함께 보내집니다). 채팅 말풍선의 Enter 버튼으로 보낼 수 있습니다" : "";
}
// What the PO's hook recorded as submitted (UserPromptSubmit -> kind "me" lines of po/<id>.jsonl) is the proof of what `hc send` really sent.
// The step-1 request must come back as exactly itself: a draft left in the input box is sent in front of it ("<draft><request>"), and the run stops.
// recs = [{ms, text}] ("me" lines); since = ms just before the send. "wait" = no record yet, "ok", "mismatch" (something else was submitted).
const RESTART_REC_MS = 12 * 1000; // how long the desk waits for the record of a send (the hook writes it when the prompt is submitted)
const restartNorm = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
function restartSubmitCheck(recs, since, expected) {
  const fresh = (recs ?? []).filter((x) => x && typeof x.text === "string" && Number(x.ms) >= Number(since));
  if (!fresh.length) return "wait";
  const e = restartNorm(expected);
  const same = (x) => { const r = restartNorm(x.text); return r.endsWith("…") ? e.startsWith(r.slice(0, -1).trimEnd()) : r === e; }; // a record longer than the hook's limit ends in "…"
  return fresh.every(same) ? "ok" : "mismatch";
}
// After the `/clear` send: the built-in /clear fires no UserPromptSubmit (verified on a scratch Claude Code: only SessionStart, source "clear"), so ANY new
// "me" record means the line reached the model as text. "text" = fail (no /PO), "clean" = no such record.
function restartClearCheck(recs, since) {
  return (recs ?? []).some((x) => x && Number(x.ms) >= Number(since)) ? "text" : "clean";
}
// chat:end
// A notice says "터미널(<address>)" for a solo room (there is no PO there); every other notice keeps "PO(<address>)".
const soloWords = (text) => { let solo = false; try { solo = soloMode(terminals()); } catch {} return solo ? String(text).replace(/PO\(([^)]*)\)/g, "터미널($1)") : text; };
// The pending-question card: the screen lines scroll inside it (all options stay reachable), the buttons stay under them.
const PROMPT_LINES_H = 240, PROMPT_MAX_H = 340;
const DIAG_FLUSH_MS = 2000; // the diag queue is written out this often (one timer started in init)
const NOTICE_TOP = 44; // just under the 38px header
const NOTICE_MAX_W = 560;
const MSG_MS = 5000; // how long a floating notice stays before it hides itself (a click hides it sooner)
const MSG_TICK_MS = 500; // how often the notice is checked for expiry
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
    this.mained = mode === "main"; // the UI-mode layout's main area (`<layout>-ui`, props {mode: "main"}): the whole desk where the terminal would be
    this.paned = mode === "pane" || this.mained; // a pane of its own; neither is the Dock (no props), which owns the app-icon badge and the slow refresh
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
    this.inputSeen = new Map(); // leader -> last ms its answer box was wanted (a draft is cleared only after DRAFT_GRACE_MS without it)
    this.pickLive = { id: "", at: 0, label: "" }; // the picked room, the last time it was live (a PO missing from one poll keeps its room: #57)
    this.msg = null; // {text, bad}
    this.copied = null; // key of the command whose 복사 button just ran
    this.more = new Set(); // bubble ids the person opened with "더 보기" (#47: long messages start folded)
    this.chat = TextareaState.new({ value: "", rows: 1, placeholder: "PO에게 말하기 — Enter로 보내기, Shift+Enter로 줄바꿈, @로 리더 부르기, 그림은 붙여넣기" });
    try { this.chat.set_auto_grow(1, INPUT_MAX_LINES); } catch {}
    this.menu = null; // the open "@" menu: {start, end, query, items, sel}
    this.changedAt = 0; // the last edit of the box (ms)
    this.roomDrafts = new Map(); // #66: room id -> the unsent chat draft {text, content, range, pics} of a room that is not shown now (see swapDraft)
    this.draftRoom = null; // the room the chat box belongs to now
    this.mirror = new Map(); // #74: box key ("chat" or a leader) -> {text, content, range}: the last text each box held (see keep / guard)
    this.keyAt = 0; // the last key press in a box (ms): an emptied box with no key press just before it was wiped, not edited
    this.sentAt = 0; // the last send (ms)
    this.uid = Math.random().toString(36).slice(2, 8); // this copy of the desk (the badge lease, record ids)
    this.seq = 0;
    this.bangBusy = false; // a '!' command is being checked (screen read) before it is pasted
    this.opening = new Set(); // PO terminals a send is waiting on (their pane is opening): one send per PO at a time
    this.backs = new Map(); // record id -> the pane that had the keyboard before the send (given back after Enter)
    this.prompt = null; // {po, at, text}: the screen tail of the picked room's PO while it waits on a prompt
    this.promptBusy = false;
    this.promptBusyAt = 0;
    this.promptGen = 0;
    this.promptChain = 0; // the newest scheduled re-read of the screen; an older one does nothing
    this.who = new Map(); // room -> the leader the room is narrowed to (#58, "특정 리더만"); like `filt`, not saved
    this.rs = new Map(); // room -> the state of its "PO 새로 시작" (see restartOpen)
    this.rcChecked = new Set(); // PO terminal addresses whose screen was read for the on-state (see remoteRestore)
    this.rc = new Map(); // room -> the state of its "원격 연결 켜기" {phase: send | on | already | unknown | fail, at, url, why, note {text, ms, bad}} (see remoteOn)
    this.rgen = 0; // numbers a restart run: a timer of an older run does nothing
    this.filt = new Map(); // room -> the chat filter chip picked there (전체 when missing); not saved: a restart shows every message again
    this.heldAt = 0; // the last Enter held back as a possible IME confirm (ms)
    this.nlAt = 0; // the last Shift+Enter handled (ms)
    this.core = ""; // the box text without trailing line breaks, as of the last change
    this.lastValue = ""; // #83: the box text as of the last change (a line break the widget put at the cursor is found against it)
    this.enterAt = 0; // #83: the last plain Enter (key or submit event) in the chat box (ms)
    this.brk = null; // #83: {idx, at, core, editAt}: the line break the widget last put in the text, and the edit state before it
    this.editAt = 0; // the last time that text changed (ms); the IME hold reads this, not changedAt
    this.pics = []; // pictures waiting in the box: [{path, w, h}] (saved under the inbox's po/img by the helper)
    this.picBusy = 0; // pictures being read from the clipboard / a file right now FOR THE ROOM SHOWN (picBusyBy: per room)
    this.picBusyBy = new Map();
    this.replyPics = new Map(); // leader -> pictures waiting in that leader's answer box (same shape as this.pics)
    this.replyBusy = new Map(); // leader -> pictures being read for that answer box
    this.imgd = new Map(); // path -> [w, h] of pictures added here (the helper's list covers the others)
    this.ui = { sels: new Map(), sel: false, selAt: 0, press: false, pressAt: 0 }; // a drag-select in the list: redraws wait while it is held
    this.dirty = false; // a redraw was held back
    this.pin = { pinned: true, ct: 0 }; // the timeline's pin to the newest (see pinStep)
    this.jump = false; // #72: the jump-to-newest button is shown (set by pinTick from the scroll position)
    this.pinCh = 0; // the content height at the last re-pin look/call (see pinCall)
    this.reading = null; // {ch, at}: a 더 보기 / 접기 click is waiting for its new layout to land: the 250ms poll must not restore the pin from the old one
    this.sentAt2 = 0; // when the person last sent a chat (the first draw with a new last entry after it goes to the end once, see sendFollow)
    this.lastIdx = 0; // index of the last child of the list
    this.sigData = ""; // what the last load drew (without its clock)
    this.errSig = "";
    this.chat.on("paste_other", (_e, c) => this.pastePic(c)); // Cmd+V found no text: take a picture from the clipboard
    this.chat.on("change", (_e, c) => {
      this.changedAt = Date.now();
      let value = "";
      try { value = this.chat.value(); } catch {}
      if (this.guard("chat", this.chat, value)) return; // the box was emptied behind the person's back: the text is back, nothing else to do
      this.keep("chat", this.chat, value);
      const prev = this.lastValue;
      const brk = strayAt(prev, value); // #83: the widget put a line break at the cursor
      const rep = brk < 0 ? replacedAt(prev, value) : null; // ... or an Enter over a selection swapped the selected text for one
      this.lastValue = value;
      if (brk >= 0 && enterPending(this.enterAt, this.changedAt)) { this.dropAt(value, brk, this.editAt); return; } // the Enter (sent or held) left it: take it out, wherever it is
      if (rep && enterPending(this.enterAt, this.changedAt)) { this.putBack(prev, rep, this.editAt); return; } // the selected text comes back
      this.brk = brk >= 0 ? { idx: brk, at: this.changedAt, core: this.core, editAt: this.editAt } : rep ? { idx: rep.idx, at: this.changedAt, core: this.core, editAt: this.editAt, rep, prev } : null; // (the key may come after this change: see enterBox)
      const core = editCore(value); // an edit is a change of the text itself: the widget's own line break for an Enter is not one
      if (core !== this.core) { this.core = core; this.editAt = this.changedAt; }
      this.heldTick(c);
      if (strayBreak(value, this.sentAt, this.changedAt)) { this.wipe("chat", this.chat); return; } // the Enter that sent left a line break
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
    cx.timer.every(MSG_TICK_MS, (cx) => { if (this.msg && Date.now() - this.msg.at >= MSG_MS) { this.msg = null; this.softNotify(cx); } });
    cx.timer.every(DIAG_FLUSH_MS, () => this.flushDiag());
    this.usage = undefined; // the rows of the usage line: undefined before the first read, null = Unknown, else [{label, percent, resetsAt}]
    this.usageSig = "";
    this.loadUsage(cx);
    cx.timer.every(USAGE_REFRESH_MS, (cx) => this.loadUsage(cx));
    this.diag(`init: ${this.windowed ? "window" : this.mained ? "main" : this.paned ? "pane" : "dock"}`);
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
    this.guardAll();
    if (this.dirty && !quietNow(this.ui, Date.now())) { this.dirty = false; try { cx.notify(); } catch {} }
    if (!this.scroll || !this.drawnAt) return;
    try {
      const o = this.scroll.offset(), vp = this.scroll.viewport_size(), ct = this.scroll.content_size();
      // Just after a 더 보기 / 접기 click the draw has not happened yet: the numbers are the old layout's, so the pin is not restored from them (#54).
      // It holds until the handle shows a different content height (the new layout has landed) or 1.5s passed; then the pin is read afresh from where
      // the view really is, without a go.
      if (this.reading) {
        if (Math.abs(ct.height - this.reading.ch) <= 1 && Date.now() - this.reading.at < 1500) return;
        this.reading = null;
        this.pin = { pinned: o.y + vp.height >= ct.height - PIN_SLACK, ct: ct.height, vh: vp.height };
        return;
      }
      const r = pinStep(this.pin, { y: o.y, vh: vp.height, ch: ct.height });
      // A scroll that is held back (drag / selection) leaves the pin as it was: pinned and the old content height stay, so the next tick after the
      // release still sees the growth and goes to the bottom (storing r.ct now would turn it into "pinned: false").
      if (r.go && quietNow(this.ui, Date.now())) return;
      this.pin = { pinned: r.pinned, ct: r.ct, vh: r.vh };
      // A tick that goes to the bottom is mid-move: o.y is the old offset against the new height, so the button is judged on the next tick (no flash).
      if (!r.go) this.syncJump(cx, jumpShown(o.y, vp.height, ct.height));
      if (r.go) { this.pinCh = ct.height; this.diag(`pin: tick go y=${Math.round(o.y)} vh=${Math.round(vp.height)} ch=${Math.round(ct.height)}`); this.scroll.scroll_to_item(this.lastIdx); }
    } catch {}
  }

  // #72: the jump button follows the scroll position: a redraw only when it has to appear or go away.
  syncJump(cx, on) {
    if (on === Boolean(this.jump)) return;
    this.jump = on;
    this.softNotify(cx);
  }
  // The button: back to the newest bubble, and the view follows again from there (pinned) like at the bottom.
  jumpToEnd(c) {
    try {
      const o = this.scroll.offset(), vp = this.scroll.viewport_size(), ct = this.scroll.content_size();
      this.reading = null;
      this.pinCh = 0;
      this.pin = { pinned: true, ct: ct.height, vh: vp.height };
      this.jump = false;
      this.diag(`pin: jump y=${Math.round(o.y)} vh=${Math.round(vp.height)} ch=${Math.round(ct.height)}`);
      this.scroll.scroll_to_item(this.lastIdx);
    } catch {}
    try { c.timer.after(80, () => { if (!quietNow(this.ui, Date.now())) this.pinGo(this.lastIdx, "jump"); }); } catch {}
    c.notify();
  }

  // One catch-up call after a draw: scroll to the row `last` only while the content grew since the last call and the view is not at its end (see
  // pinCall; the numbers are those of the layout that exists by then). `why` names the caller in diag.log (rate-limited by diag's own queue).
  pinGo(last, why) {
    try {
      const o = this.scroll.offset(), vp = this.scroll.viewport_size(), ct = this.scroll.content_size();
      const m = { y: o.y, vh: vp.height, ch: ct.height };
      const go = pinCall(m, this.pinCh);
      this.pinCh = m.ch; // the height this look saw: a later look with the same height has nothing new to catch up on
      if (!go) return;
      this.diag(`pin: ${why} go y=${Math.round(m.y)} vh=${Math.round(m.vh)} ch=${Math.round(m.ch)}`);
      this.scroll.scroll_to_item(last);
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
  // #74: the draft mirror. keep(): copy what a box holds (text, tokens, cursor) after each change. wipe(): the mod's own clear (send, a stale
  // draft): the mirror is emptied first so the clear is not taken for a loss. guard(): a box that is empty while the mirror holds text and no
  // key of the person's came just before was emptied by something else (a rebuild of the view): the text and the cursor are put back.
  keep(key, st, value) {
    try {
      const text = value ?? st.value();
      if (text === "") { this.mirror.delete(key); return; }
      let content = null, range = null;
      try { content = st.content(); } catch {}
      try { range = st.selected_range(); } catch {}
      this.mirror.set(key, { text, content, range });
    } catch {}
  }
  // #66: the chat box holds the draft of the room shown. When the room changes (a click on a room, or the shown room moving by itself) the box's
  // text, mention chips, cursor and pictures go to that room's slot and the new room's slot comes back (or an empty box). Sending clears only the
  // box of the room shown, so another room's draft is untouched. Idempotent: called with the room already shown it does nothing.
  syncRoom(pick) {
    if (pick == null || pick === this.draftRoom) return;
    const from = this.draftRoom;
    this.draftRoom = pick;
    if (from == null) return; // first look: the box was never anyone else's
    let cur = null;
    try { cur = { text: this.chat.value(), content: this.chat.content(), range: this.chat.selected_range(), pics: this.pics.slice() }; } catch {}
    const r = swapDraft(this.roomDrafts, from, pick, cur);
    this.roomDrafts = r.map;
    this.menu = null;
    this.heldAt = 0;
    this.mirror.delete("chat"); // the swap below is the mod's own write, not a loss
    try {
      if (r.load) {
        try { this.chat.set_value(r.load.content ?? r.load.text); } catch { this.chat.set_value(r.load.text); }
        if (r.load.range) this.chat.set_selected_range(r.load.range);
      } else this.chat.set_value("");
    } catch {}
    this.pics = r.load?.pics ?? [];
    this.picBusy = this.picBusyBy.get(pick) ?? 0;
    try { this.lastValue = this.chat.value(); this.core = editCore(this.lastValue); } catch {}
    this.brk = null;
    this.keep("chat", this.chat);
    this.diag(`draft: room switched, ${r.load ? `restored ${String(r.load.text).length} chars` : "empty box"}`);
  }
  wipe(key, st) {
    this.mirror.delete(key);
    try { st.set_value(""); } catch {}
  }
  guard(key, st, value) {
    const m = this.mirror.get(key);
    let v = value;
    if (v === undefined) { try { v = st.value(); } catch { return false; } }
    if (!draftWiped(m, v, this.keyAt, Date.now())) return false;
    try {
      st.set_value(m.content ?? m.text);
      if (m.range) st.set_selected_range(m.range);
    } catch { try { st.set_value(m.text); } catch {} }
    this.diag(`draft restored in ${key === "chat" ? "chat" : "answer box"} (${m.text.length} chars)`);
    return true;
  }
  // Every box is looked at once per draw and once per poll tick, so a loss that raised no change event is mended within a tick.
  guardAll() {
    this.guard("chat", this.chat);
    for (const [k, st] of this.inputs) this.guard(k, st);
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
  // The PO box's reads are counted per room (`room` = the room the read started in), and only the room shown sees its own count: a read that
  // started in another room never blocks sending or shows "reading…" here.
  bumpBusy(key, n, room = this.draftRoom) {
    if (key == null) {
      const v = Math.max(0, (this.picBusyBy.get(room) ?? 0) + n);
      if (v) this.picBusyBy.set(room, v); else this.picBusyBy.delete(room);
      this.picBusy = this.picBusyBy.get(this.draftRoom) ?? 0;
      return;
    }
    const v = Math.max(0, (this.replyBusy.get(key) ?? 0) + n);
    if (v) this.replyBusy.set(key, v); else this.replyBusy.delete(key);
  }
  // A picture for the PO box goes to the room the read STARTED in: when that room is not shown any more it joins that room's saved draft.
  async addPic(args, c, key = null, room = this.draftRoom) {
    this.bumpBusy(key, 1, room);
    try { c.notify(); } catch {}
    try {
      const r = await exec("node", [HELPER(), ...args], { timeout: 20000 });
      if (r.code !== 0) throw new Error((r.stderr || "").trim().split("\n").pop() || `종료 코드 ${r.code}`);
      const o = JSON.parse(r.stdout);
      if (!o?.path) throw new Error("그림이 없습니다");
      if (o.w > 0 && o.h > 0) this.imgd.set(o.path, [o.w, o.h]);
      const away = key == null && room !== this.draftRoom;
      const slot = away ? this.roomDrafts.get(room) : null;
      const cur = away ? (slot?.pics ?? []) : this.picsOf(key);
      const pic = { path: o.path, w: o.w ?? 0, h: o.h ?? 0 };
      if (cur.length >= MAX_IMGS) this.say(`그림은 한 번에 ${MAX_IMGS}장까지 붙일 수 있습니다.`, true);
      else if (!cur.some((x) => x.path === o.path)) {
        if (away) this.roomDrafts.set(room, { text: "", ...(slot ?? {}), pics: [...cur, pic] });
        else this.setPics(key, [...cur, pic]);
      }
      this.msg = null;
    } catch (e) { this.say(`그림을 붙이지 못했습니다: ${String(e?.message ?? e).slice(0, 140)}`, true); }
    finally { this.bumpBusy(key, -1, room); try { c.notify(); } catch {} }
  }
  pastePic(c, key = null) { return this.addPic(["clipimg"], c, key); }
  async pickPics(c, key = null) {
    const room = this.draftRoom; // the room the file button was pressed in
    let files = null;
    try { files = await pickFiles({ prompt: "그림 붙이기", multiple: true }); } catch (e) { this.say(`파일을 고르지 못했습니다: ${String(e?.message ?? e).slice(0, 120)}`, true); try { c.notify(); } catch {} return; }
    for (const f of (files ?? []).slice(0, MAX_IMGS)) await this.addPic(["addimg", f], c, key, room);
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
    const now = Date.now();
    for (const k of live) this.inputSeen.set(k, now);
    for (const k of staleDrafts(this.inputs.keys(), live, this.inputSeen, now)) { // an old draft must not reappear on the leader's next card (but one missing poll must not wipe it: #57)
      try { const st = this.inputs.get(k); if (String(st.value() ?? "") !== "" || this.mirror.has(k)) this.wipe(k, st); } catch {}
      this.inputSeen.delete(k);
    }
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

  // UI mode -> terminal mode: the layout this `<name>-ui` was made from (the terminals stay alive in the core; only the main area changes).
  toTerminalMode() {
    this.msg = null;
    try {
      const cur = String(shared("layout") ?? "");
      const base = cur.endsWith("-ui") ? cur.slice(0, -3) : "";
      if (!base || !(layouts() ?? []).includes(base)) { this.say("돌아갈 터미널 모드 레이아웃을 찾지 못했습니다.", true); return; }
      run("layout.switch", { name: base });
    } catch (e) { this.say(`터미널 모드로 바꾸지 못했습니다: ${String(e?.message ?? e).slice(0, 120)}`, true); }
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
        adoptNames(d?.names); // the profile of the inbox folder (names, labels, answer line); the defaults when the collector sends none
        // The cost enters the signature as what is drawn (label + tooltip, whole cents), never the raw numbers, so a working PO's tokens do not redraw the desk.
        const shown = {};
        for (const [po, c] of Object.entries(d?.cost ?? {})) shown[po] = [costLabel(c), costTip(c)];
        const sig = JSON.stringify({ ...d, cost: shown, at: 0 });
        const err = d?.profileError ? `프로필을 읽지 못해 기본 이름으로 보여 줍니다: ${String(d.profileError).slice(0, 160)}` : null; // kept shown, but only a change of it redraws
        this.changed = sig !== this.sigData || err !== this.error || !this.data || Date.now() - this.drawnAt > LOAD_REDRAW_MS;
        this.sigData = sig;
        this.data = d;
        this.error = err;
        rememberLeaders();
        this.markSeen();
        this.remoteRestore(cx);
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
      out.push({ s, term, kind, item, po: findPo(list, term.name, term.address), owner: leaderOwner(list, term.name, term.address, s.po), link: labelOf(term, "labelWaitLink") || item?.link || "" });
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
    const solo = soloMode(terms); // #90: no PO and no leader anywhere: the rooms are the plain Claude terminals (no leader parts at all)
    const soloData = solo ? this.data?.solo ?? {} : {};
    const pos = solo ? soloRooms(terms, soloData) : poList(terms);
    const all = this.asks();
    this.pruneReply(all);
    const asks = solo ? [] : all; // (a solo room has no leader asks or reports)
    const reps = solo ? [] : this.reports(all);
    const hasOther = asks.some((a) => a.owner === PO_OTHER) || reps.some((r) => r.owner === PO_OTHER);
    let last = "";
    try { last = shared(PICK_KEY) ?? ""; } catch {}
    if (solo) { try { last = shared(SOLO_PICK_KEY) ?? ""; } catch {} }
    const now = Date.now();
    const settled = settlePick(pos, last, hasOther, this.pickLive.id === last ? this.pickLive.at : 0, now);
    const pick = settled.pick;
    if (!settled.ghost) {
      if (last && (pos.some((p) => p.id === last) || (last === PO_OTHER && hasOther))) this.pickLive = { id: last, at: now, label: last === PO_OTHER ? OTHER_LABEL : pos.find((p) => p.id === last)?.label ?? last };
      if (pick && pick !== last) { try { setShared(solo ? SOLO_PICK_KEY : PICK_KEY, pick); } catch {} } // the room shown is the room kept: an automatic pick no longer floats with the leader counts
    }
    let mine = [], seen = {};
    try { mine = shared(CHAT_KEY) ?? []; } catch {}
    try { seen = shared(SEEN_KEY) ?? {}; } catch {}
    const leaders = solo ? [] : (this.data?.leaders ?? []).map((s) => ({ s, owner: leaderOwner(terms, s.leader, s.terminal, s.po) }));
    const waits = (id) => asks.filter((a) => a.owner === id).map((a) => ({ leader: a.s.leader, ts: a.item?.ts ?? "", kind: a.kind }));
    const room = (id) => timeline(id, leaders, id === PO_OTHER ? [] : (solo ? soloData[id] : this.data?.po?.[id]) ?? [], mine, waits(id), now);
    const busy = solo ? new Set(pos.filter((p) => isWorking(terms.find((x) => x.address === p.address))).map((p) => p.id)) : roomWorking(terms); // #69: the rooms with work going on (a dot beside the name)
    const rooms = pos.map((p) => ({ id: p.id, label: p.label, title: p.title, blocked: this.isBlocked(p.address), working: busy.has(p.id) }));
    if (hasOther) rooms.push({ id: PO_OTHER, label: OTHER_LABEL, title: "", blocked: false, working: busy.has(PO_OTHER) });
    if (settled.ghost && !rooms.some((r) => r.id === pick)) rooms.push({ id: pick, label: this.pickLive.label, title: "", blocked: false, ghost: true }); // held for a moment: the room list does not lose it
    let raw = [];
    const tabs = rooms.map((r) => {
      const entries = room(r.id);
      if (r.id === pick) raw = entries;
      return { ...r, n: asks.filter((a) => a.owner === r.id).length, unread: r.id === pick ? 0 : unreadCount(entries, seen[r.id]) };
    });
    const filter = pick ? this.filt.get(pick) ?? "all" : "all";
    const choices = aliveLeaders(roomLeaders(raw, (n) => shortName(n)), terms, this.data?.leaders); // #58: the live leaders of the picked room (follows the room; a closed session is dropped, its history stays under 전체)
    const who = pick ? settleLeader(choices, this.who.get(pick)) : "";
    const scope = leaderEntries(raw, who); // the 1:1 view of one leader (all of the room when none): the chips work on this
    let snaps = {};
    try { snaps = shared(SNAP_KEY) ?? {}; } catch {}
    const base = snapBase(snaps, pick, seen, now); // opening a room moves `seen` to now: filter by the marker from before (the same one in every copy)
    const shown = filterEntries(scope, filter, base);
    const keep = keepWaiting(scope, shown); // a leader still waiting on the person stays visible under any chip
    const entries = groupTimeline(keep.filter((e, i) => i >= keep.length - MAX_ENTRIES || e.waiting));
    return { terms, solo, tabs, pick, raw, shown, filter, who, choices, counts: filterCounts(scope, base), entries, asks: asks.filter((a) => a.owner === pick), reports: reps.filter((r) => r.owner === pick) };
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
    if (v.solo || !v.pick || !v.raw.length) return null; // #90: no kind chips in a solo room
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
    this.syncRoom(id);
    try { if (soloMode(this.liveTerms())) setShared(SOLO_PICK_KEY, id); else setShared(PICK_KEY, id); } catch {}
    this.menu = null;
    this.markSeen();
    c.notify();
  }

  setWho(room, leader, c) {
    if (!room) return;
    if (leader) this.who.set(room, leader); else this.who.delete(room);
    c.notify();
  }

  // #58: the leader row under the chips — 전체 | one chip per leader of the room. It works together with the chips (the chip filters that leader's
  // entries). Shown while the room has one or more live leaders (#70: with one it still says who is there; none open = no row); a leader that
  // waits on the person is marked.
  leaderBar(t, v) {
    if (!v.pick || (v.choices?.length ?? 0) < 1) return null;
    const chip = (id, label, on, mark, tip) => div().id(`who-${id || "all"}`).flex_none().h(22).px(8).rounded(11).flex().items_center().cursor_pointer().text_size(11).on_mouse_down("left", stop)
      .bg(on ? t.selected : t.raised).border(1).border_color(on ? t.foreground + "40" : t.border).text_color(on ? t.foreground : t.muted)
      .hover((x) => x.bg(t.hover).text_color(t.foreground)).on_click((_e, c) => this.setWho(v.pick, id, c)).tooltip(tip).child(mark ? `${label} ●` : label);
    return h_flex().flex_none().min_w(0).px(10).py(5).gap(5).items_center().flex_wrap().border_b(1).border_color(t.border)
      .child(div().flex_none().text_size(10.5).text_color(t.dim).child("리더"))
      .child(chip("", "전체", !v.who, false, "이 방의 모든 리더"))
      .children(v.choices.map((x) => chip(x.id, x.label, v.who === x.id, x.waiting, `${x.label}와 주고받은 글만(● = 나의 답을 기다림)`)));
  }

  peek(s) {
    const term = this.terminalOf(s);
    if (term?.address) run("terminal.peek", { terminal: term.address });
    else this.say("그 리더 터미널이 지금 없습니다.", true);
  }

  say(text, bad = false) { this.msg = { text, bad, at: Date.now() }; } // drawn as a floating notice over the top of the room (see render), gone after MSG_MS

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
    if (this.mained) return this.deliverByAddress(po, text, c, rec, ok, id); // UI mode: no terminal block is on screen, so there is no pane to focus or paste into
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

  // UI mode (`main`): the PO terminal has no pane, so nothing is focused, kept, pasted from the clipboard or given the keyboard back. The text goes by terminal
  // address with `hc send <po> <text> --json` (paste + Enter in one step; the path the #41 restart already uses). Runs in cx.spawn; returns at once:
  //   "opening"  the send is in flight (the record is "sending"; it turns "sent" and `ok("sent")` runs when `hc send` reports started, else "failed" + the reason)
  //   "failed"   the PO is on a prompt (`hc send` would refuse; --force is never used): nothing sent
  // One send per PO at a time (`opening`, same guard as the pane path). Real-app behavior of a hidden terminal is unverified (see docs/mods/inbox.md).
  deliverByAddress(po, text, c, rec, ok, id) {
    if (this.isBlocked(po)) {
      this.mark(id, "failed");
      this.say(`PO(${po})가 질문에 답을 기다리는 중이라 보내지 않았습니다. 질문에 먼저 답한 뒤 말풍선의 '다시 보내기'를 누르세요.`, true);
      return "failed";
    }
    this.opening.add(po);
    this.mark(id, "sending");
    const fail = (why, cx) => {
      this.opening.delete(po); this.mark(id, "failed");
      this.say(`PO(${po})에 보내지 못했습니다: ${why}. 말풍선의 '다시 보내기'를 누르세요.`, true);
      try { cx.notify(); } catch {}
    };
    try {
      c.spawn(async (cx) => {
        let r = null;
        try { r = await hc(["send", "--json", "--", po, text]); } catch (e) { r = { code: -1, stdout: "", stderr: String(e?.message ?? e) }; }
        const res = restartSendResult(r);
        if (!res.ok) {
          this.diag(`desk send failed: ${res.detail} (po ${po})`);
          if (res.notStarted) { // no turn started: read the PO's screen — the text in its input only needs Enter (no second paste), else it did not arrive
            let rd = null;
            try { rd = await hc(["read", po, "--lines", String(PROMPT_LINES)]); } catch {}
            if (rd && rd.code === 0 && inputHas(String(rd.stdout ?? ""), text) && !this.isBlocked(po)) {
              this.opening.delete(po); this.mark(id, "noenter");
              this.say(`PO(${po})의 입력창에 글은 들어갔지만 시작되지 않았습니다. 말풍선의 'Enter 누르기'를 누르세요.`, true);
              try { cx.notify(); } catch {}
              return;
            }
          }
          fail(res.why, cx);
          return;
        }
        this.opening.delete(po);
        this.mark(id, "sent");
        try { ok?.("sent"); } catch {}
        this.say(`PO(${po})에 보냈습니다.`);
        try { cx.notify(); } catch {}
      });
    } catch (e) { fail(String(e?.message ?? e).slice(0, 80), c); return "failed"; }
    return "opening";
  }

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
    if (!po) { this.say(NO_PO(), true); c.notify(); return; }
    const before = r.status;
    if (bangCommand(r.line || r.text) !== null) { this.resendBang(id, c, po, r, before); return; }
    this.mark(id, "sending");
    try {
      const out = this.deliver(po, r.line || r.text, c, r, (r2) => this.markAsk(r, r2), id);
      if (out === "busy") this.mark(id, before);
      else if (out === "sent" || out === "held") this.markAsk(r, out);
    } catch (e) { this.say(`붙여 넣지 못했습니다: ${String(e?.message ?? e).slice(0, 160)}`, true); }
    c.notify();
  }

  // A '!' bubble's resend goes through the same guard as the first send (PO idle, pane open, input box empty), so a resend never types into a PO that
  // has since started working or has text in its box. A refusal puts the record back as it was and says why.
  resendBang(id, c, po, r, before) {
    const stop = (why, cx = c) => { this.bangBusy = false; this.mark(id, before); this.say(`${why} '!' 명령은 보내지 않았습니다. 상태를 확인한 뒤 '다시 보내기'를 누르세요.`, true); try { cx.notify(); } catch {} };
    if (this.bangBusy) { this.say("앞의 '!' 명령을 확인하는 중입니다. 잠시 뒤에 다시 보내세요.", true); try { c.notify(); } catch {} return; }
    if (this.mained) { this.say("UI 모드에서는 PO 터미널에 글을 그대로 붙여 넣을 수 없어 '!' 명령을 보내지 않았습니다.", true); try { c.notify(); } catch {} return; }
    const gate = this.bangGate(po);
    if (gate) { this.say(`${gate} '!' 명령은 보내지 않았습니다.`, true); try { c.notify(); } catch {} return; }
    this.mark(id, "sending");
    this.bangBusy = true;
    this.bangCheck(c, po, stop, (cx, clip) => {
      this.bangBusy = false;
      try {
        const out = this.deliver(po, r.line || r.text, cx, r, (r2) => this.markAsk(r, r2), id);
        this.bangClipBack(cx, clip, out);
        if (out === "busy") this.mark(id, before);
        else if (out === "sent" || out === "held") this.markAsk(r, out);
      } catch (e) { this.say(`붙여 넣지 못했습니다: ${String(e?.message ?? e).slice(0, 160)}`, true); }
      try { cx.notify(); } catch {}
    });
  }

  // The bubble's "Enter 누르기": the text is in the PO's normal prompt and only Enter is missing. Before the key goes, the PO's screen is read and the
  // pasted line must still be in its input (else "gone": send it again); refused when the PO now waits on a question (at the click and again right before the key).
  enterNow(id, c) {
    const r = this.recordOf(id);
    if (!r) return;
    const po = this.recordPo(r);
    if (!this.recordActs(r, po).includes("enter")) return;
    if (!po) { this.say(NO_PO(), true); c.notify(); return; }
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
    const cur = this.prompt?.po === po ? this.prompt : null;
    if ((this.promptBusy && now - this.promptBusyAt < PROMPT_TIMEOUT_MS) || (cur && now - cur.at < (cur.failed ? PROMPT_RETRY_MS : PROMPT_REFRESH_MS))) return;
    const gen = ++this.promptGen;
    this.promptBusy = true; this.promptBusyAt = now;
    let done = false;
    // Every ending fills this.prompt (the screen, or {failed: true}), so the panel never stays on "reading": a read that fails, comes back empty or
    // takes too long is shown as "could not read" and tried again. After an await only the spawn's / timer's own cx is used (a render's cx is not
    // good any more by then, #92).
    const fin = (text, c2) => {
      if (done || gen !== this.promptGen) return;
      done = true; this.promptBusy = false;
      const failed = !String(text ?? "").trim();
      const same = !failed && cur && !cur.failed && promptSame(cur.text, text);
      this.prompt = same ? { ...cur, at: Date.now() } : { po, at: Date.now(), text: failed ? "" : text, failed };
      const chain = ++this.promptChain;
      if (!same) this.softNotify(c2);
      try { c2.timer.after((failed ? PROMPT_RETRY_MS : PROMPT_REFRESH_MS) + 100, (c3) => { if (chain === this.promptChain && this.isBlocked(po)) this.readPrompt(po, c3); }); } catch {}
    };
    try { cx.timer.after(PROMPT_TIMEOUT_MS, (c2) => fin("", c2)); } catch {}
    const read = async () => { try { const o = await hc(["read", po, "--lines", String(PROMPT_LINES)]); return o && o.code === 0 ? String(o.stdout ?? "") : ""; } catch { return ""; } };
    try { cx.spawn(async (c2) => { fin(await read(), c2); }); } catch { read().then((text) => fin(text, cx)); }
  }
  // A key press from the question panel. Never on a stale panel: the PO must still be blocked, and its screen is read again right before the key
  // and must show the same question the buttons were built from (else the panel is refreshed and no key goes).
  pressPrompt(po, key, c) {
    const say = (text, bad = true) => { this.say(text, bad); try { c.notify(); } catch {} };
    if (!this.isBlocked(po)) { this.prompt = null; say(`PO(${po})가 이제 질문 중이 아니라 ${key}를 누르지 않았습니다.`); return; }
    const shown = this.prompt?.po === po ? this.prompt : null;
    if (!shown) { say(`PO(${po})의 화면을 아직 읽지 못해 ${key}를 누르지 않았습니다. 잠시 뒤 다시 누르세요.`); return; }
    const want = promptSig(shown.text);
    if (shown.failed || !want) { say(`PO(${po})의 화면을 읽지 못해 처음 본 질문이 없어 ${key}를 누르지 않았습니다. 다시 읽기를 누르세요.`); return; } // never a key for a screen the person has not seen
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
    const po = !v.solo && v.pick && v.pick !== PO_OTHER ? chatTarget(v.terms, [], v.pick).po : "";
    if (!po || !this.isBlocked(po)) { this.prompt = null; return null; }
    try { this.readPrompt(po, cx); } catch { this.promptBusy = false; this.prompt = { po, at: Date.now(), text: "", failed: true }; }
    const shown = this.prompt?.po === po ? this.prompt : null;
    const lines = shown ? promptTail(shown.text, 40) : [];
    const parsed = shown ? promptParse(shown.text) : { options: [], head: [], tabs: "" };
    const opts = parsed.options;
    const key = (k, label, tip, primary) => this.button(t, `pp-${k}`, label, (c) => this.pressPrompt(po, k, c), { primary, tip });
    // Never a dead end: whatever the read or the parse gave, the person can open that terminal and answer there (and read the screen as it is).
    const note = !shown ? "화면을 읽는 중…"
      : !lines.length ? "화면을 읽지 못했습니다. '다시 읽기'를 누르거나 '터미널 열기'로 직접 답하세요."
      : !opts.length ? "선택지를 찾지 못했습니다. 아래 화면 그대로를 보고 '터미널 열기'로 직접 답하세요." : "";
    return v_flex().id("po-prompt").flex_none().min_w(0).max_h(PROMPT_MAX_H).mx(10).mb(6).p(10).gap(8).rounded(8).bg(t.blocked + "14").border(1).border_color(t.blocked + "55").on_mouse_down("left", stop)
      .child(div().min_w(0).truncate().text_size(11).font_semibold().text_color(t.blocked).child("PO가 질문 중입니다 — 화면 끝"))
      .when(Boolean(note), (el) => el.child(div().min_w(0).text_size(11).text_color(t.dim).child(note)))
      .child(v_flex().id("po-prompt-lines").min_w(0).min_h(0).max_h(PROMPT_LINES_H).overflow_y_scrollbar().gap(2)
        .children(lines.map((l, i) => div().min_w(0).text_size(11).text_color(t.muted).child(this.text(`pp-l${i}`, chatHtml(l))))))
      .child(h_flex().min_w(0).gap(6).items_center().flex_wrap()
        .children(opts.map((o) => this.button(t, `pp-${o.key}`, `${o.key}. ${o.label.length > 32 ? `${o.label.slice(0, 31)}…` : o.label}`, (c) => this.pressPrompt(po, o.key, c), { primary: o.on, tip: o.label })))
        .when(Boolean(parsed.tabs), (el) => el.child(key("left", "← 이전 질문", `질문 탭을 앞으로(${parsed.tabs})`)).child(key("right", "다음 질문 →", `질문 탭을 뒤로(${parsed.tabs})`)))
        .child(key("enter", "Enter", "화면에서 강조된 선택지를 확정합니다(PO가 질문 중일 때만)"))
        .child(key("esc", "Esc", "질문을 취소합니다(PO가 질문 중일 때만)"))
        .child(this.button(t, "pp-term", "터미널 열기", (c) => { try { run("terminal.peek", { terminal: po }); } catch (e) { this.say(`터미널을 열지 못했습니다: ${String(e?.message ?? e).slice(0, 120)}`, true); } c.notify(); }, { tip: "이 PO의 터미널 화면을 엽니다(키는 누르지 않습니다)" }))
        .child(this.button(t, "pp-reread", "다시 읽기", (c) => { this.prompt = null; this.promptBusy = false; c.notify(); }, { tip: "PO 화면을 다시 읽습니다" })));
  }

  // ---- "PO 새로 시작" (per room): ask the PO for a handoff note, wait for it, /clear, /PO. State per room in this.rs[room] =
  // {phase: confirm | run | timeout | fail | done, n (steps done, see restartSteps), gen, po, id, since (ms the request went in), path, note {text, ms}, quiet, why}.
  // Every step is the person's one click on 새로 시작 (nothing starts by itself); each timer step checks the run is still the same (gen) and the PO is not on a prompt.
  restartAlive(room, g) { const r = this.rs.get(room); return Boolean(r) && r.gen === g; }
  restartSet(room, g, patch, c) {
    const r = this.rs.get(room);
    if (!r || r.gen !== g) return false;
    this.rs.set(room, { ...r, ...patch });
    try { c.notify(); } catch {}
    return true;
  }
  restartFail(room, g, why, c) { this.restartSet(room, g, { phase: "fail", why }, c); this.say(`PO 새로 시작을 멈췄습니다: ${why}`, true); }
  restartOpen(room, c) { if (!this.rs.get(room)) this.rs.set(room, { phase: "confirm", n: 0, gen: ++this.rgen }); try { c.notify(); } catch {} }
  restartClose(room, c) { this.rs.delete(room); this.rgen++; try { c.notify(); } catch {} } // a run in progress stops asking: the timers see a new gen
  // The helper reads the note file (the desk cannot read files itself).
  async handoffRead(id) {
    try {
      const r = await exec("node", [HELPER(), "handoff", id], { timeout: 5000 });
      if (r.code === 0) return JSON.parse(r.stdout);
    } catch {}
    return { path: "", exists: false, ms: 0, size: 0, text: "" };
  }
  // The whole run is ONE async function inside cx.spawn: a click's or a timer's cx is only good during its own call, so after an await
  // only the spawn's cx is used (never the click's c). Waiting is sleepOn (a timer that resolves a promise), never a callback chain.
  sleepOn(cx, ms) { return new Promise((res, rej) => { try { cx.timer.after(ms, () => res()); } catch (e) { rej(e); } }); } // a cx the host closed throws: the run ends (restartRun's catch)
  // The PO's "me" records (what its hook saw submitted), read by the helper; [] when none / unreadable.
  async poMe(id) {
    try {
      const r = await exec("node", [HELPER(), "po-me", id], { timeout: 5000 });
      if (r.code === 0) { const j = JSON.parse(r.stdout); if (Array.isArray(j)) return j; }
    } catch {}
    return [];
  }
  // Waits (bounded) for the record of a send: resolves the check ("ok" | "mismatch" | "wait" = none arrived).
  async poProof(cx, id, since, expected, still) {
    const t0 = Date.now();
    for (;;) {
      const st = restartSubmitCheck(await this.poMe(id), since, expected);
      if (st !== "wait" || !still() || Date.now() - t0 >= RESTART_REC_MS) return st;
      await this.sleepOn(cx, 500);
    }
  }
  // The PO's {live, status, turn} from `hc get` (no screen involved); null when it could not be read.
  async poTerm(po) {
    try { return restartTerm(await hc(["get", po, "--json"])); } catch { return null; }
  }
  // One line to the PO through `hc send` (paste + Enter in one command, the way leaders send). Before it: the PO must be running, not on a prompt, not working
  // (no `--if`: that accepts only "idle", and a PO that just finished is "done"). Resolves {ok, why, turn}: turn = the PO's counter from before the send.
  // On a failure nothing was sent; on success a draft left in the PO's input box would have been sent along (hc send does not empty it), and the trimmed output goes to diag.log.
  async sendLine(po, text, still = () => true, room = "") {
    const no = (why) => ({ ok: false, why, turn: null });
    if (!still()) return no("취소되었습니다");
    let mineNow = []; try { mineNow = shared(CHAT_KEY) ?? []; } catch {}
    const held = room ? restartDraft(mineNow, room, Date.now()) : "";
    if (held) { this.diag(`restart send blocked: held chat line (po ${po})`); return no(`${held} — 아무것도 보내지 않았습니다`); }
    const term = await this.poTerm(po);
    if (!still()) return no("취소되었습니다");
    const block = restartSendBlock(term);
    if (block) { this.diag(`restart send blocked: ${block} (po ${po})`); return no(`${block} — 아무것도 보내지 않았습니다`); }
    let r = null;
    const at = Date.now();
    // hc() has no timeout option and exec() has no kill/abort (herdr.d.ts): a started send cannot be recalled or cut short from here; `hc send` itself waits at most
    // 60 s for a person's unfinished draft (draft_wait), then sends. Closing the restart strip only stops the steps after it (gen check).
    try { r = await hc(["send", "--json", "--", po, text]); } catch (e) { r = { code: -1, stdout: "", stderr: String(e?.message ?? e) }; }
    const res = restartSendResult(r);
    if (!res.ok) { this.diag(`restart send failed: ${res.detail} (po ${po})`); return no(res.why); }
    return { ok: true, why: "", turn: res.turn ?? term.turn, at };
  }
  // 새로 시작 / 다시: the click only checks and records the run; everything after runs in cx.spawn.
  restartRun(room, po, id, c) {
    const st = String(this.liveTerms().find((t) => t.address === po)?.status ?? "");
    const why = restartBlock({ po, status: st });
    if (why) { this.remoteSet(room, { phase: "fail", kind: "fail", why }, c); return; }
    const g = ++this.rgen;
    this.rs.set(room, { phase: "run", n: 0, gen: g, po, id, since: 0, path: "", note: null, quiet: 0, why: "" });
    try { c.notify(); } catch {}
    c.spawn(async (cx) => {
      try { await this.restartFlow(room, g, po, id, cx); }
      catch (e) { this.restartFail(room, g, String(e?.message ?? e).slice(0, 100), cx); }
    });
  }
  // Steps 1-4. Every step checks the run is still the same (gen).
  async restartFlow(room, g, po, id, cx) {
    const alive = () => this.restartAlive(room, g);
    // Step 1: ask for the note.
    const note0 = await this.handoffRead(id);
    if (!alive()) return;
    const path = note0.path || `~/.herdr-inbox/${NAMES.hubDir}/${id}.handoff.md`;
    this.restartSet(room, g, { path, since: Date.now() }, cx);
    const askText = handoffAsk(path);
    const ask = await this.sendLine(po, askText, alive, room);
    if (!alive()) return;
    if (!ask.ok) { this.restartFail(room, g, `노트를 요청하지 못했습니다(${ask.why})`, cx); return; }
    // Proof of what was submitted: the PO's hook record of this send must be exactly the request (a draft in the input box is sent in front of it).
    const proof = await this.poProof(cx, id, ask.at, askText, alive);
    if (!alive()) return;
    if (proof === "mismatch") { this.restartFail(room, g, "PO 입력칸에 남아 있던 글이 요청과 함께 보내졌습니다. 입력칸을 비운 뒤 다시 눌러 주세요", cx); return; }
    if (proof !== "ok") { this.diag(`restart: no hook record of the request (po ${po})`); this.restartFail(room, g, "요청이 그대로 보내졌는지 PO 기록으로 확인하지 못해 /clear를 보내지 않았습니다", cx); return; }
    if (!this.restartSet(room, g, { n: 1 }, cx)) return;
    // Steps 2-3: look for the note every RESTART_POLL_MS; the note is fresh (written after the request) -> show it; the PO idle after it -> /clear.
    for (;;) {
      await this.sleepOn(cx, RESTART_POLL_MS);
      const r = this.rs.get(room);
      if (!r || r.gen !== g || r.phase !== "run") return;
      const note = await this.handoffRead(r.id);
      const cur = this.rs.get(room);
      if (!cur || cur.gen !== g || cur.phase !== "run") return;
      const status = String(this.liveTerms().find((t) => t.address === cur.po)?.status ?? "");
      const act = restartPoll({ note, since: cur.since, now: Date.now(), status, quiet: cur.quiet });
      if (act === "timeout") { this.restartSet(room, g, { phase: "timeout" }, cx); return; }
      if (act === "wait") continue;
      if (!cur.note || cur.note.ms !== note.ms) this.restartSet(room, g, { n: 2, note: { text: note.text, ms: note.ms } }, cx);
      if (act === "go") break;
      const idle = !/^(working|blocked)$/i.test(status.trim());
      this.rs.set(room, { ...this.rs.get(room), quiet: idle ? (cur.quiet ?? 0) + 1 : 0 }); // the PO must look idle twice in a row
    }
    // Step 3: /clear through hc send. Proof that the right history is cleared: the note is fresh (written after our request) and our request's
    // send returned started:true. Proof that /clear ran (no screen): its send returned started:true, and the PO's turn counter went up with the PO idle/done again.
    this.rs.set(room, { ...this.rs.get(room), phase: "clear" });
    const clr = await this.sendLine(po, "/clear", alive, room);
    if (!alive()) return;
    if (!clr.ok) { this.restartFail(room, g, `/clear를 보내지 못했습니다(${clr.why})`, cx); return; }
    const t0 = Date.now();
    for (;;) {
      await this.sleepOn(cx, 800);
      if (!alive()) return;
      const term = await this.poTerm(po);
      if (!alive()) return;
      const st = restartClearState(clr.turn, term);
      if (st === "done") break;
      if (st === "gone") { this.restartFail(room, g, "/clear를 보낸 뒤 PO 터미널이 실행 중이 아니라 /PO를 보내지 않았습니다", cx); return; }
      if (Date.now() - t0 >= RESTART_CLEAR_MS) { this.diag(`restart /clear not confirmed: sent turn ${clr.turn}, now ${JSON.stringify(term)}`); this.restartFail(room, g, "/clear가 끝났는지 확인하지 못해 /PO를 보내지 않았습니다", cx); return; }
    }
    // /clear fires no UserPromptSubmit: any new "me" record since the send means it went to the model as text (a draft glued to it, or no command at all).
    if (restartClearCheck(await this.poMe(id), clr.at) === "text") { this.diag(`restart: /clear reached the model as text (po ${po})`); this.restartFail(room, g, "/clear가 명령이 아니라 글로 PO에게 들어간 것 같아 /PO를 보내지 않았습니다. PO 입력칸을 비운 뒤 다시 눌러 주세요", cx); return; }
    if (!alive()) return;
    this.restartSet(room, g, { n: 3 }, cx);
    const fin = await this.sendLine(po, "/PO", alive, room);
    if (!alive()) return;
    if (!fin.ok) { this.restartFail(room, g, `/PO를 보내지 못했습니다(${fin.why})`, cx); return; }
    // Report only (no step depends on it): did the hook see the /PO line?
    try { await this.sleepOn(cx, 1500); this.diag(`restart /PO record: ${restartSubmitCheck(await this.poMe(id), fin.at, "/PO")}`); } catch {}
    this.restartSet(room, g, { n: 4, phase: "done" }, cx);
    this.say("PO를 새로 시작했습니다.");
  }
  // The strip above the chat box: the button (idle), the confirm line, or the four steps of the run.
  restartRow(t, v, cx) {
    if (v.solo || !v.pick || v.pick === PO_OTHER) return null; // #90: the solo "new start" is a later step
    const room = v.pick;
    const po = chatTarget(v.terms, [], room).po ?? "";
    const r = this.rs.get(room);
    const st = String(v.terms.find((x) => x.address === po)?.status ?? "");
    const running = Boolean(r && (r.phase === "run" || r.phase === "clear"));
    let mineNow = []; try { mineNow = shared(CHAT_KEY) ?? []; } catch {}
    const why = restartBlock({ po, status: st, running }) || (r ? "" : restartDraft(mineNow, room, Date.now()));
    const waiting = (k) => v.asks.filter((a) => a.kind === k).length;
    const box = () => v_flex().id("po-restart").flex_none().min_w(0).mx(10).mb(6).px(10).py(8).gap(6).rounded(8).bg(t.raised).border(1).border_color(t.border).on_mouse_down("left", stop);
    if (!r) {
      return h_flex().id("po-restart").flex_none().min_w(0).mx(10).mb(4).gap(8).items_center().justify_end()
        .when(Boolean(why), (el) => el.child(div().min_w(0).truncate().text_size(10.5).text_color(t.dim).child(why)))
        .child(this.button(t, "rs-open", "PO 새로 시작", (c) => this.restartOpen(room, c), { disabled: why, tip: "PO에게 인수인계 노트를 쓰게 한 뒤 /clear 하고 /PO로 다시 시작합니다" }));
    }
    if (r.phase === "confirm") {
      return box()
        .child(div().min_w(0).text_size(11.5).text_color(t.foreground).child(restartConfirm(waiting("decision"), waiting("verify"))))
        .child(h_flex().min_w(0).gap(6).items_center().flex_wrap()
          .child(this.button(t, "rs-go", "새로 시작", (c) => this.restartRun(room, po, room, c), { primary: true, disabled: why, tip: "노트를 요청하고, 노트가 생기면 /clear 와 /PO 를 차례로 보냅니다" }))
          .child(this.button(t, "rs-cancel", "취소", (c) => this.restartClose(room, c)))
          .when(Boolean(why), (el) => el.child(div().min_w(0).text_size(10.5).text_color(t.blocked).child(why))));
    }
    const failed = r.phase === "timeout" || r.phase === "fail";
    const color = (s) => (s === "done" ? t.working : s === "fail" ? t.blocked : s === "active" ? t.foreground : t.dim);
    const mark = (s) => (s === "done" ? "✓" : s === "fail" ? "✕" : s === "active" ? "…" : "·");
    return box()
      .child(h_flex().min_w(0).gap(10).items_center().flex_wrap()
        .children(restartSteps(r.n, failed).map((s, i) => div().id(`rs-step-${i}`).flex_none().text_size(11).text_color(color(s.state)).child(`${mark(s.state)} ${s.label}`))))
      .when(r.phase === "timeout", (el) => el.child(div().min_w(0).text_size(11).text_color(t.blocked).child("노트가 제때 만들어지지 않았습니다. 아무것도 비우지 않았습니다.")))
      .when(r.phase === "fail", (el) => el.child(div().min_w(0).text_size(11).text_color(t.blocked).child(r.why)))
      .when(r.phase === "done", (el) => el.child(div().min_w(0).text_size(11).text_color(t.working).child("PO를 새로 시작했습니다. 노트는 위에 남겨 두었습니다.")))
      .when(r.phase === "run" || r.phase === "clear", (el) => el.child(div().min_w(0).text_size(10.5).text_color(t.dim).child(r.n < 2 ? "노트가 생길 때까지 기다리는 중입니다(최대 5분)…" : "PO가 끝나기를 기다린 뒤 대화를 비웁니다…")))
      .child(h_flex().min_w(0).gap(6).items_center().flex_wrap()
        .when(r.phase === "timeout", (el) => el.child(this.button(t, "rs-retry", "다시", (c) => this.restartRun(room, po, room, c), { primary: true, disabled: why && !running ? why : "", tip: "노트를 다시 요청합니다" })))
        .child(this.button(t, "rs-close", r.phase === "run" || r.phase === "clear" || r.phase === "timeout" ? "취소" : "닫기", (c) => this.restartClose(room, c), { tip: r.phase === "run" || r.phase === "clear" ? "기다리기를 멈춥니다(이미 보낸 요청은 그대로입니다)" : "" })));
  }

  // ---- "원격 연결 켜기" (#79), per terminal: `room` = the key of the state, `po` = the terminal address, `status` = its hc status. A room of any kind can use it (PO room
  // now, a solo room later): it needs only the terminal's address. The flow: read the screen (already on? the "already connected" menu open? then no send), send the one line
  // /remote-control, read the screen again a few times (~5 s) to see what it did, and close the "already connected" menu with Esc only (never Disconnect, never Enter) after
  // checking it is still on screen. The result is a system note in the room's chat (rc.note) and a small mark by the button. What the screen looks like is UNVERIFIED.
  async remoteRead(po) {
    try {
      const o = await hc(["read", po, "--lines", String(PROMPT_LINES)]);
      return o && o.code === 0 ? String(o.stdout ?? "") : null;
    } catch { return null; }
  }
  // Esc closes the menu, pressed ONCE (a second Esc in a row can rewind the PO's conversation). Right before it the screen must still show the whole menu and the
  // terminal's status is read again (poTerm): not running or working = no press (Esc would stop its turn). After it the screen is read again; true = the menu is gone,
  // false = it is still there (or anything could not be checked) and nothing more is pressed.
  async remoteClose(po, cx) {
    const t = await this.remoteRead(po);
    if (t === null) return false;
    if (!remoteScreen(t).menu) return true;
    const term = await this.poTerm(po);
    if (!term || !term.live || term.status === "working") return false;
    let k = null; try { k = await hc(["keys", po, "esc"]); } catch {}
    if (!(k && k.code === 0)) return false;
    await this.sleepOn(cx, 600);
    const after = await this.remoteRead(po);
    return after !== null && !remoteScreen(after).menu;
  }
  remoteSet(room, patch, c) {
    const r = { ...(this.rc.get(room) ?? {}), at: Date.now(), ...patch };
    if (patch.kind) { const ms = Date.now(); r.note = { text: remoteNote(patch.kind, r), ms, bad: patch.kind === "fail" || patch.kind === "unknown" }; delete r.kind; }
    this.rc.set(room, r);
    if (patch.kind && r.note) this.say(`원격 연결 · ${r.note.text}`, r.note.bad); // the same result also floats over the top of the room for a few seconds (no layout space)
    try { c.notify(); } catch {}
  }
  remoteOn(room, po, c) {
    const st = String(this.liveTerms().find((t) => t.address === po)?.status ?? "");
    const r0 = this.rc.get(room);
    const rs = this.rs.get(room);
    const why = remoteBlock({ po, status: st, running: Boolean(rs && (rs.phase === "run" || rs.phase === "clear")), sending: r0?.phase === "send" });
    if (why) { this.remoteSet(room, { phase: "fail", kind: "fail", why }, c); return; }
    this.remoteSet(room, { phase: "send", why: "" }, c);
    c.spawn(async (cx) => {
      const done = (phase, kind, extra = {}) => this.remoteSet(room, { phase, kind, why: "", url: "", ...extra }, cx);
      try {
        const pre0 = await this.remoteRead(po);
        const pre = pre0 === null ? null : remoteScreen(pre0);
        if (pre && pre.active) { // already on (or its menu is open and the person is stuck in it): no send
          if (pre.menu && !(await this.remoteClose(po, cx))) { done("fail", "fail", { why: "이미 켜져 있고 터미널에 연결 메뉴가 열려 있습니다. 닫지 못했습니다 — 터미널에서 Continue를 고르세요(Disconnect는 고르지 마세요)" }); return; }
          done("already", "already", { url: pre.url });
          return;
        }
        const res = await this.sendLine(po, REMOTE_CMD, () => true, room);
        if (!res.ok) { done("fail", "fail", { why: res.why }); return; }
        if (pre === null) { done("unknown", "unknown"); return; }
        for (let i = 0; i < REMOTE_POLLS; i++) {
          await this.sleepOn(cx, REMOTE_POLL_MS);
          const txt = await this.remoteRead(po);
          if (txt === null) continue;
          const now = remoteScreen(txt);
          if (now.menu) { // it was already connected: the command opened Claude Code's menu
            if (await this.remoteClose(po, cx)) done("already", "already", { url: now.url });
            else done("fail", "fail", { why: "이미 켜져 있어 연결 메뉴가 열렸고 닫지 못했습니다 — 터미널에서 Continue를 고르세요(Disconnect는 고르지 마세요)" });
            return;
          }
          if (now.active || (now.url && now.url !== pre.url)) { done("on", "on", { url: now.url }); return; }
        }
        done("unknown", "unknown");
      } catch (e) { done("fail", "fail", { why: String(e?.message ?? e).slice(0, 100) }); }
    });
  }
  // The button and, beside it, the last known state: once the last screen check saw it on, the button itself reads "● 원격 연결 켜짐" (a click re-checks the screen and only sends if it no longer shows on). Not watched, so a disconnect made in the terminal shows only after the next check.
  remoteButton(t, room, po, status) {
    const r = this.rc.get(room);
    const rs = this.rs.get(room);
    const why = remoteBlock({ po, status, running: Boolean(rs && (rs.phase === "run" || rs.phase === "clear")), sending: r?.phase === "send" });
    const on = r && (r.phase === "on" || r.phase === "already");
    const at = on ? new Date(r.at).toTimeString().slice(0, 5) : "";
    return h_flex().id(`rc-${room}`).flex_none().min_w(0).gap(6).items_center()
      .when(r?.phase === "send", (el) => el.child(div().flex_none().text_size(10.5).text_color(t.dim).child("확인 중…")))
      .child(this.button(t, on ? "rc-on-done" : "rc-on", on ? h_flex().items_center().gap(6).child(div().flex_none().w(8).h(8).rounded(4).bg(t.working)).child("원격 연결 켜짐") : "원격 연결 켜기", (c) => this.remoteOn(room, po, c), { disabled: why, tip: why || (on ? `${at}에 화면으로 확인한 상태입니다. 그 뒤 터미널에서 끊었는지는 보지 않습니다. 누르면 화면을 다시 확인하고, 꺼져 있을 때만 /remote-control을 보냅니다` : "이 PO 터미널에 /remote-control을 보내 원격 연결(Remote Control)을 켭니다. 이미 켜져 있으면 보내지 않습니다") }));
  }
  // The system note of the last 원격 연결 try, as a quiet line at the end of the room's chat.
  remoteNoteRow(t, room) {
    const n = this.rc.get(room)?.note;
    if (!n) return null;
    return h_flex().id(`rc-note-${room}`).flex_none().min_w(0).px(14).py(4).gap(6).justify_center().items_center()
      .child(div().min_w(0).text_size(11).text_color(n.bad ? t.blocked : t.dim).child(this.text(`rc-note-t-${room}`, chatHtml(`원격 연결 · ${new Date(n.ms).toTimeString().slice(0, 5)} · ${n.text}`))));
  }

  // After a start or a reload of the desk the in-memory state is gone, so every PO terminal's screen is read ONCE (read only, nothing is sent or pressed) and a room whose
  // screen still shows Claude Code's "/remote-control is active" line gets the on-state without a chat note. The screen is the only source: when that line has scrolled away
  // it is not seen and the button stays "켜기" (a click then checks again). A state is only ever set here, never cleared. `force` (the refresh button) checks again.
  remoteRestore(cx, force = false) {
    if (force) this.rcChecked.clear();
    const pos = poList(this.liveTerms()).filter((p) => !this.rcChecked.has(p.address));
    for (const p of pos) {
      this.rcChecked.add(p.address);
      cx.spawn(async (c) => {
        const txt = await this.remoteRead(p.address);
        if (txt === null) { this.rcChecked.delete(p.address); return; } // could not read: try again at the next load
        const r = this.rc.get(p.id);
        if (r && r.phase !== "on" && r.phase !== "already") return; // a try of this session (sending, failed, unknown) is newer than the screen
        const sc = remoteScreen(txt);
        if (!sc.seen) return;
        this.rc.set(p.id, { ...(r ?? {}), phase: "on", at: Date.now(), url: sc.url || r?.url || "", why: "" });
        try { c.notify(); } catch {}
      });
    }
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
    if (!po) { this.say(NO_PO(), true); cx.notify(); return; }
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
    if (st && (!sent || String(st.value() ?? "").trim() === sent.text)) this.wipe(leader, st);
    this.setPics(leader, sent ? this.picsOf(leader).filter((x) => !sent.imgs.includes(x.path)) : []);
    if (this.writing === a.s.leader) this.writing = null;
  }

  box(leader, cx) {
    let s = this.inputs.get(leader);
    if (!s) {
      s = InputState.new({ value: "", placeholder: "답을 적고 Enter" });
      s.on("submit", (_e, c) => { const a = this.asks().find((x) => x.s.leader === leader); if (a) this.send(a, s.value(), c); });
      s.on("paste_other", (_e, c) => this.pastePic(c, leader)); // Cmd+V found no text: take a picture from the clipboard, as the PO box does
      s.on("change", () => { let v; try { v = s.value(); } catch { return; } if (!this.guard(leader, s, v)) this.keep(leader, s, v); }); // #74: the draft mirror
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
      const items = q && !soloMode(this.liveTerms()) ? leaderMenu(this.liveTerms(), namesMemo(), q.query, 8, this.view().pick) : []; // #90: no "@" menu in solo mode (no leaders)
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
      this.enterAt = now;
      if (now - this.pickedAt <= 250 || now - this.sentAt <= 250 || now - this.heldAt < 150) return; // (the key and the submit event of one press are one Enter)
      let value = "";
      try { value = this.chat.value(); } catch {}
      let cur = null; // #83: where the cursor was when Enter was pressed (Enter sends from any position; the IME tail rule is for the end)
      try { cur = this.chat.selected_range().end; } catch {}
      const b = this.brk;
      if (b && now - b.at <= 25 && value[b.idx] === "\n") { // the widget's line break at the cursor came before this key: it is not the person's text
        if (b.rep) { // it replaced a selection: the selected text is the person's text and comes back
          value = b.prev;
          cur = b.rep.end;
          this.putBack(b.prev, b.rep, b.editAt);
        } else {
          value = withoutAt(value, b.idx);
          cur = b.idx;
          this.dropAt(this.chat.value(), b.idx, b.editAt);
        }
        this.core = b.core;
      }
      if (value.trim() && imeHold(value, this.editAt, this.heldAt, now, atTextEnd(value, cur))) { // maybe the IME's confirming Enter: only this once
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

  // #83: takes the one line break at `idx` out (the text and the chips around it stay, the cursor goes where the break was); `editAt` is the edit time to keep.
  dropAt(value, idx, editAt) {
    const next = withoutAt(value, idx);
    this.lastValue = next;
    this.core = editCore(next);
    this.editAt = editAt;
    this.brk = null;
    try {
      this.chat.set_selected_range({ start: idx, end: idx + 1 });
      this.chat.replace("");
      if (this.chat.value() !== next) this.chat.set_value(next); // the widget would not replace with nothing: plain text instead
      this.chat.set_selected_range({ start: idx, end: idx });
    } catch {}
  }

  // #83: an Enter over a selection made the widget swap the selected text for a line break: the text of `prev` comes back (chips of the selected span
  // become plain text) with its selection, and the Enter then sends it whole.
  putBack(prev, rep, editAt) {
    this.lastValue = prev;
    this.core = editCore(prev);
    this.editAt = editAt;
    this.brk = null;
    try {
      this.chat.set_selected_range({ start: rep.idx, end: rep.idx + 1 });
      this.chat.replace(prev.slice(rep.idx, rep.end));
      if (this.chat.value() !== prev) this.chat.set_value(prev);
      this.chat.set_selected_range({ start: rep.idx, end: rep.end });
    } catch {}
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
    this.keyAt = Date.now();
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

  // A desk line that starts with "!" goes into the PO's own prompt as the person's raw input (Claude Code's bash mode). `hc send` wraps text in <hc …> and
  // `hc keys` has no "!", so this is the unwrapped paste path (clipboard + terminal.paste + Enter, keyboard given back). Only when nothing else is in play:
  // not UI mode (no pane), no @mention or picture, one line, the PO's pane open, the PO idle (not working, not on a question) and its input box empty.
  // Otherwise nothing is sent, the text stays in the box and the reason is shown. Whether a pasted leading "!" enters bash mode is unverified in the real app.
  sendBang(c, po, p, pics) {
    const cmd = bangCommand(p.text);
    const refuse = (why, cx = c) => { this.bangBusy = false; this.say(`${why} '!' 명령은 보내지 않았고 글은 입력칸에 그대로 있습니다.`, true); try { cx.notify(); } catch {} };
    if (this.bangBusy) { this.say("앞의 '!' 명령을 확인하는 중입니다. 잠시 뒤에 다시 보내세요.", true); try { c.notify(); } catch {} return; }
    if (this.mained) { refuse("UI 모드에서는 PO 터미널에 글을 그대로 붙여 넣을 수 없어(보내기는 글을 <hc …>로 감쌉니다)"); return; }
    if (p.to.length) { refuse("'!' 명령은 PO에게만 보낼 수 있어(@멘션을 빼 주세요)"); return; }
    if (pics.length) { refuse("'!' 명령은 그림과 함께 보낼 수 없어"); return; }
    if (!cmd) { refuse("'!' 뒤에 실행할 명령이 없어"); return; }
    if (/\n/.test(cmd)) { refuse("'!' 명령은 한 줄만 보낼 수 있어"); return; }
    const gate = this.bangGate(po);
    if (gate) { refuse(gate); return; }
    const text = composeChat(this.chat.content());
    const room = this.view().pick; // the room it is sent from: the screen read below can end after another room was picked
    this.bangBusy = true;
    this.bangCheck(c, po, refuse, (cx, clip) => {
      this.bangBusy = false;
      try {
        const res = this.deliver(po, `!${cmd}`, cx, { text: `!${cmd}`, imgs: [], to: "", tos: [], po: room, kind: "chat" });
        this.bangClipBack(cx, clip, res);
        if (res === "sent") {
          this.sentAt2 = Date.now();
          if (composeChat(this.chat.content()) === text) { this.wipe("chat", this.chat); this.menu = null; }
        }
      } catch (e) { this.say(`붙여 넣지 못했습니다: ${String(e?.message ?? e).slice(0, 160)}`, true); }
      try { cx.notify(); } catch {}
    });
  }

  // The checks that need no screen read: the PO's pane is open and the PO is neither working nor on a question. "" when it may go on, else the reason.
  bangGate(po) {
    let hasPane = false;
    try { hasPane = (panes() ?? []).some((x) => x.terminal === po); } catch {}
    if (!hasPane) return `PO(${po})의 터미널 칸이 화면에 열려 있지 않아`;
    const term = this.liveTerms().find((x) => x.address === po);
    if (!term || isBusy(term)) return `PO(${po})가 일하는 중이거나 질문 중이라`;
    return "";
  }

  // Reads the PO's screen (and the clipboard text, to give it back after the paste) and calls `go(cx, clip)` only when the PO is idle at an EMPTY input
  // box; every other outcome calls `fail(why, cx)`. The read is capped at BANG_READ_MS: a stalled `hc read` fails instead of holding the busy flag forever.
  // Used by the first send and by a bubble's resend, so both go through the same guard.
  bangCheck(c, po, fail, go) {
    const spawn = (cx) => (async () => {
      const work = Promise.all([
        Promise.resolve().then(() => hc(["read", po, "--lines", String(PROMPT_LINES)])).catch(() => null),
        this.clipText(),
      ]);
      const limit = new Promise((res) => { try { cx.timer.after(BANG_READ_MS, () => res(null)); } catch {} });
      const got = await Promise.race([work, limit]);
      if (!got) { fail(`PO(${po})의 화면 읽기가 ${Math.round(BANG_READ_MS / 1000)}초 안에 끝나지 않아`, cx); return; }
      const [r, clip] = got;
      if (!(r && r.code === 0)) { fail(`PO(${po})의 화면을 읽지 못해`, cx); return; }
      const inp = promptInput(String(r.stdout ?? ""));
      if (inp === null) { fail(`PO(${po})의 입력창을 화면에서 찾지 못해`, cx); return; }
      if (inp !== "") { fail(`PO(${po})의 입력창이 비어 있지 않아`, cx); return; }
      const t2 = this.liveTerms().find((x) => x.address === po);
      if (!t2 || isBusy(t2)) { fail(`PO(${po})가 그 사이 일하거나 질문 중이 되어`, cx); return; }
      go(cx, clip);
    })().catch((e) => { try { fail(String(e?.message ?? e).slice(0, 80), cx); } catch {} });
    try { c.spawn(spawn); } catch (e) { fail(String(e?.message ?? e).slice(0, 80), c); }
  }

  // The clipboard's TEXT (null when it holds none or cannot be read: a picture is not restored). Never throws.
  async clipText() {
    try {
      const r = await exec("node", [HELPER(), "cliptext"], { timeout: 4000 });
      if (r.code !== 0) return null;
      const o = JSON.parse(r.stdout);
      return typeof o?.text === "string" && o.text !== "" ? o.text : null;
    } catch { return null; }
  }

  // After the '!' line was pasted (the paste itself runs inside deliver), the clipboard gets back what it held before. Not when the delivery is still
  // waiting for a pane ("opening": that paste needs the clipboard later) or failed.
  bangClipBack(cx, clip, res) {
    if (typeof clip !== "string" || clip === "" || (res !== "sent" && res !== "held")) return;
    try { cx.write_to_clipboard(clip); } catch {}
  }

  sendChat(c) {
    this.sentAt = Date.now();
    this.heldAt = 0;
    const v = this.view();
    const terms = v.terms;
    const known = v.pick === PO_OTHER ? [] : terms.filter((t) => isAgentName(t?.name) && leaderOwner(terms, t.name, t.address) === v.pick).map((t) => t.name);
    let p;
    try { p = parseMention(composeChat(this.chat.content()), known); } catch { p = { empty: true }; }
    const pics = this.pics.slice(0, MAX_IMGS);
    if (p.empty && !pics.length) { this.say("PO에게 보낼 글을 먼저 적어 주세요.", true); c.notify(); return; }
    if (this.picBusy) { this.say("그림을 읽는 중입니다. 잠시 뒤에 다시 보내세요.", true); c.notify(); return; }
    if (p.empty) p = { text: "", to: [], empty: false };
    p.to = p.to ?? [];
    const tgt = chatTarget(terms, p.to, v.pick);
    if (!tgt.po) {
      this.say(tgt.why === "many" ? "부른 리더들의 PO가 서로 다릅니다. 한 PO의 리더만 함께 부르세요." : tgt.why === "orphan" ? NO_PO()
        : `받을 PO를 먼저 고르세요(${hubTag()}, ${NAMES.hubIdLabel}=<id> 라벨이 붙은 PO 터미널만 고를 수 있습니다).`, true);
      c.notify();
      return;
    }
    const po = tgt.po;
    if (bangCommand(p.text) !== null) { this.sendBang(c, po, p, pics); return; }
    try {
      // The PO reads a picture from its file: each path goes in the message as a line it can open with the Read tool.
      const line = [p.text, ...pics.map((x) => imgLine(x.path))].filter(Boolean).join("\n");
      const r = this.deliver(po, line, c, { text: p.text, imgs: pics.map((x) => x.path), to: p.to[0] ?? "", tos: p.to, po: v.pick, kind: "chat" });
      if (r === "sent" || r === "held" || r === "opening") { // opening: the bubble holds the text and sends it by itself once the pane opens
        this.sentAt2 = Date.now(); // the draw that shows the new bubble goes to the end once (sendFollow)
        this.wipe("chat", this.chat);
        this.pics = [];
        this.menu = null;
      }
    } catch (e) { this.say(`붙여 넣지 못했습니다: ${String(e?.message ?? e).slice(0, 160)}`, true); }
    c.notify();
  }

  // The chat footer: the "@" menu, the input with mention chips, the send button. The room has no box while it is "PO 모름" (no PO to send to).
  chatBox(t, v) {
    // #74: the box is drawn in every room (the "PO 모름" room too, with a note instead of a target), at the same place in the tree with ids on
    // its parts, so a room switch, a refresh or a hint line coming and going never rebuilds the input the person is typing in.
    const none = v.pick === PO_OTHER;
    const menu = this.menu && v_flex().id("chat-menu").flex_none().p(4).gap(2).rounded(8).bg(t.raised).border(1).border_color(t.border)
      .children(this.menu.items.map((it, i) => h_flex().id(`mn-${it.id}`).h(26).px(8).gap(8).items_center().rounded(6).cursor_pointer()
        .bg(i === this.menu.sel ? t.selected : t.raised).hover((x) => x.bg(t.hover))
        .on_mouse_down("left", stop).on_click((_e, c) => this.pickMenu(i, c))
        .child(div().text_size(12.5).font_semibold().text_color(it.id === "here" ? t.muted : tint(t, it.id)).child(`@${it.label}`))
        .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(it.id === "here" ? "PO에게 그냥 보내기" : it.sub))));
    const ghost = v.tabs.some((x) => x.id === v.pick && x.ghost);
    const target = v.tabs.find((x) => x.id === v.pick && x.id !== PO_OTHER && !x.ghost);
    const chip = (ctx) => div().h(ctx.line_height).px(5).rounded(5).flex().items_center().bg(t.working + "26").text_color(t.working).text_size(12.5).font_semibold()
      .child(ctx.token.label ?? ctx.token.text.trim());
    return v_flex().id("chat-box").flex_none().px(10).pb(10).pt(6).gap(6).border_t(1).border_color(t.border)
      .on_key_down((e, c) => this.inputKey(e, c))
      .when(Boolean(menu), (el) => el.child(menu))
      .when(holdShown(this.changedAt, this.heldAt), (el) => el.child(div().text_size(11).text_color(t.working).child("한 번 더 Enter로 보냅니다")))
      .child(div().id("chat-target").truncate().text_size(10.5).text_color(t.dim).child(none ? "PO를 알 수 없는 방이라 여기서는 보낼 곳이 없습니다 — 왼쪽에서 PO 방을 고르세요(쓰던 글은 그대로 있습니다)" : target ? `${v.solo ? "받는 터미널" : "받는 PO"}: ${target.label}` : ghost ? "PO 터미널을 다시 찾는 중입니다 — 쓰던 글은 그대로 있습니다" : v.solo ? "받는 터미널이 없습니다 — 왼쪽에서 방을 고르세요" : "받는 PO가 없습니다 — PO를 고르세요"))
      .when(this.pics.length > 0 || this.picBusy > 0, (el) => el.child(this.picRow(t, null)))
      .child(h_flex().id("chat-row").gap(6).items_center()
        .on_drop((ev, c) => this.dropPics(ev?.paths, c))
        .child(this.button(t, "chat-attach", "그림", (c) => { this.pickPics(c); }, { tip: "그림 파일을 골라 붙입니다(Cmd+V로 붙여넣거나 파일을 끌어다 놓아도 됩니다). 보내면 PO가 파일을 열어 봅니다" }))
        .child(div().id("chat-input").flex_1().min_w(0).on_mouse_down("left", stop)
          .child(Textarea.new(this.chat).token((ctx) => chip(ctx)).min_h(30).px(10).py(5).rounded(8).border(1).border_color(t.input).bg(t.background).text_size(12.5).text_color(t.foreground)))
        .child(this.button(t, "chat-send", v.solo ? "보내기" : "PO에 보내기", (c) => this.sendChat(c), { primary: true, tip: "고른 PO 터미널에 글을 붙여 넣고 Enter까지 눌러 보냅니다(글은 클립보드를 거칩니다). Shift+Enter는 줄바꿈" })));
  }

  poHint(t, v = null) {
    if (v?.solo) return div().id("po-hint").flex_none().px(this.compact ? 10 : 14).pb(6).text_size(11).text_color(t.muted)
      .child("아직 기록된 Claude 터미널 대화가 없습니다. 혼자 모드가 켜져 있으면 터미널에서 보낸 프롬프트부터 여기에 방으로 나타납니다.");
    return div().id("po-hint").flex_none().px(this.compact ? 10 : 14).pb(6).text_size(11).text_color(t.muted)
      .child(`PO 터미널에 ${hubTag()}, ${NAMES.hubIdLabel}=<id> 라벨을 달면 PO별로 나뉩니다. 지금은 PO가 없어 채팅을 보낼 수 없습니다.`);
  }

  // #69: the "working" dot of a room: a small accent dot, always in the layout (clear when idle) so the name does not move when it comes and goes.
  roomDot(t, x) {
    const d = div().flex_none().size(6).rounded(3);
    return x.working ? d.bg(t.working).tooltip("작업 중") : d;
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
    if (!v.tabs.some((x) => x.id !== PO_OTHER)) return this.poHint(t, v);
    return h_flex().id("po-picker").flex_none().px(this.compact ? 10 : 14).pb(6).gap(5).flex_wrap().items_center()
      .child(div().flex_none().text_size(10.5).font_semibold().text_color(t.dim).child(v.solo ? "터미널" : "PO"))
      .children(v.tabs.map((x) => {
        const on = x.id === v.pick;
        return h_flex().id(`po-${x.id}`).h(24).px(9).gap(5).items_center().rounded(12).cursor_pointer().on_mouse_down("left", stop)
          .bg(on ? t.selected : t.raised).border(1).border_color(on ? t.foreground + "40" : t.border)
          .hover((s) => s.bg(on ? t.selected : t.hover)).on_click((_e, c) => this.pickPo(x.id, c))
          .tooltip(x.id === PO_OTHER ? OTHER_TIP : `po=${x.id}${x.title ? ` · 세션: ${x.title}` : ""}`)
          .child(div().max_w(150).truncate().text_size(11.5).font_semibold().text_color(on ? t.foreground : t.muted).child(x.label))
          .child(this.roomDot(t, x))
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
          .child(h_flex().w(SLIM_W - 10).gap(3).items_center().justify_center()
            .child(div().min_w(0).truncate().text_center().text_size(9.5).text_color(on ? t.foreground : t.dim).child(x.label))
            .child(this.roomDot(t, x)))
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
            .child(div().min_w(0).truncate().text_size(10).text_color(t.dim).child(x.id === PO_OTHER ? "채팅 없음" : v.solo ? "터미널" : "PO")))
          .child(this.roomDot(t, x))
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

  // A message as Markdown (headings, lists, `code`, links; no raw HTML: tags show as text). The wrapper tags are removed first (mdText).
  // Selectable like text(); a link opens only when it is http(s) (openUrl ignores everything else).
  // The person's own bubble and the PO's bubbles both draw through here, so a list, `code` and a bold header read the same in both (#66).
  // The TextView draws **bold** at the normal weight (it ignores bold and the weight around it), so a line that is only **bold** text is its own
  // TextView with font_weight(700) (mdBlocks, #66); a bold run inside a sentence stays at the normal weight. Nothing is painted behind bold.
  md(id, src) {
    const view = (vid, s, bold) => {
      this.tvN = (this.tvN ?? 0) + 1;
      const tv = TextView.markdown(vid, s).raw_html(false).selectable(true).on_link_click((url, c) => openUrl(url, c)).on_selection_change((sel, c) => this.onSel(vid, sel, c));
      return bold ? tv.font_weight(700) : tv;
    };
    const blocks = mdBlocks(mdText(src));
    if (!blocks.length) return view(id, "", false);
    if (blocks.length === 1 && !blocks[0].bold) return view(id, blocks[0].s, false);
    return v_flex().min_w(0).gap(3).children(blocks.map((b, i) => (b.bold ? div().min_w(0).pt(i ? 3 : 0).child(view(`${id}-${i}`, b.s, true)) : view(`${id}-${i}`, b.s, false))));
  }

  // A PO message folded like the person's own (#47): a long one shows its first lines and a "더 보기" under them.
  mdFolded(id, src, t) {
    const lc = clipLong(unwrapTags(src)), open = lc.cut && this.more.has(id);
    if (!lc.cut) return this.md(id, src);
    return v_flex().min_w(0).gap(6).child(this.md(id, open ? src : lc.text)).child(this.moreToggle(t, id, lc, open));
  }

  // "더 보기 · N자 더" / "접기" under a folded bubble. Only this bubble opens; the 복사 chip copies the whole text either way.
  moreToggle(t, id, lc, open) {
    return div().id(`${id}-more`).flex_none().text_size(11).cursor_pointer().text_color(t.working).hover((s) => s.text_color(t.foreground))
      .on_mouse_down("left", stop)
      .on_click((_e, cx) => {
        if (this.more.has(id)) this.more.delete(id); else this.more.add(id);
        // The person is reading this bubble now: let go of the bottom pin so the draw does not drag the view to the end of what just grew (#54).
        this.pin = { pinned: false, ct: Number(this.pin?.ct) || 0 };
        try { const ct = this.scroll?.content_size(); this.reading = { ch: Number(ct?.height) || 0, at: Date.now() }; } catch { this.reading = { ch: 0, at: Date.now() }; }
        try { cx.notify(); } catch {}
      })
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
      return div().min_w(0).text_size(12.5).text_color(t.foreground).child(typeof p.md === "string" && p.md ? this.md(key, p.md) : this.text(key, p.html));
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
    // Without "N안:" lines the card still shows what the report offers (#62): its 추천 / 답 lines and the quoted answers as buttons.
    const hint = kind === "decision" && opts.options.length < 2 ? decisionHints(item?.body) : { lines: [], answers: [], recommended: "" };
    const box = v_flex().min_w(0).gap(6)
      .children(hint.lines.map((x, i) => div().id(`hint-${s.leader}-${i}`).min_w(0).text_size(12).text_color(t.foreground).child(x)))
      .child(h_flex().gap(6).items_center().flex_wrap()
        .when(Boolean(link) && link !== item?.link, (el) => el.child(this.button(t, `link-${s.leader}`, "링크 열기", (c) => openUrl(link, c))))
        .children(kind === "decision" ? opts.options.map((n) => this.button(t, `opt-${s.leader}-${n}`, `${n}안 선택${n === opts.recommended ? " (추천)" : ""}`, (c) => this.send(a, `${n}안 선택`, c, "choice"), { primary: n === opts.recommended, disabled: a.po ? "" : NO_PO(), tip: CLIP })) : [])
        .children(hint.answers.map((w, i) => this.button(t, `ans-${s.leader}-${i}`, w, (c) => this.send(a, w, c, "choice"), { primary: w === hint.recommended, disabled: a.po ? "" : NO_PO(), tip: CLIP })))
        .when(kind === "verify", (el) => el.child(this.button(t, `ok-${s.leader}`, "확인 완료", (c) => this.send(a, "확인 완료", c, "verify"), { primary: true, disabled: a.po ? "" : NO_PO(), tip: CLIP })))
        .child(this.button(t, `write-${s.leader}`, writing ? "닫기" : "답 쓰기", (c) => { this.writing = writing ? null : s.leader; if (!writing) this.box(s.leader, c); this.reveal(this.spot(s, item)); c.notify(); }, { disabled: a.po ? "" : NO_PO() }))
        .child(div().text_size(11).text_color(done === "sent" ? t.working : done === "held" ? t.blocked : t.dim).child(done === "sent" ? "PO에 보냄 — 리더가 받으면 사라집니다" : done === "held" ? (this.isBlocked(a.po) ? "PO에 넣음 — PO가 질문 중입니다. 방의 질문에 먼저 답하세요" : "PO에 넣음 — 말풍선의 'Enter 누르기'로 보내세요") : "누르면 PO에 바로 보내고, 리더가 받으면 사라집니다")));
    if (!a.po) box.child(div().text_size(11).text_color(t.dim).child(NO_PO()));
    if (writing) {
      const input = this.box(s.leader, cx);
      const row = this.picRow(t, s.leader);
      if (row) box.child(row);
      box.child(h_flex().id(`reply-${s.leader}`).gap(6).items_center()
        .on_key_down(() => { this.keyAt = Date.now(); })
        .on_drop((ev, c) => this.dropPics(ev?.paths, c, s.leader))
        .child(this.button(t, `attach-${s.leader}`, "그림", (c) => { this.pickPics(c, s.leader); }, { tip: "그림 파일을 골라 붙입니다(Cmd+V로 붙여넣거나 파일을 끌어다 놓아도 됩니다). 보내면 PO가 파일을 열어 봅니다" }))
        .child(div().flex_1().min_w(0).on_mouse_down("left", stop).child(Input.new(input).h(30).px(10).items_center().rounded(8).border(1).border_color(t.input).bg(t.background).text_size(12.5).text_color(t.foreground)))
        .child(this.button(t, `send-${s.leader}`, "보내기", (c) => this.send(a, input.value(), c), { primary: true, disabled: a.po ? "" : NO_PO(), tip: CLIP })));
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
            .when(Boolean(bp.text), (el) => el.child(this.md(`${id}-t`, words)))
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
      .child(po ? this.circle(t, t.working, x.solo ? String(x.name).slice(0, 1).toUpperCase() : "P") : this.avatar(t, x.who.slice(2)))
      .child(v_flex().min_w(0).gap(3)
        .child(div().min_w(0).truncate().text_size(12).font_semibold().text_color(color).child(po && !x.solo ? "PO" : x.name))
        .child(h_flex().min_w(0).gap(6).items_center()
          .child(div().px(14).py(5).rounded(12).bg(t.raised).border(1).border_color(t.border).text_size(16).text_color(t.dim).child("···"))
          .child(x.label ? div().flex_none().text_size(11).text_color(x.label === LABEL_BLOCKED ? t.blocked : t.dim).child(x.label) : div())));
  }

  render(cx) { return this.full(cx); }

  // The messenger view: rooms (one per PO) beside one room's timeline, and the chat box under it. Narrow: the rooms are a strip on top.
  full(cx) {
    this.tvN = 0;
    this.noteRedraw(cx);
    this.guardAll();
    Promise.resolve().then(() => { // once per draw (only when the count changed or 10s passed, so a busy desk does not flood the file)
      const now = Date.now();
      if (this.tvLast !== this.tvN || now - (this.tvLogAt ?? 0) > 10000) { this.tvLast = this.tvN; this.tvLogAt = now; this.diag(`draw: ${this.tvN} selectable TextView(s)`, cx); }
    });
    const t = theme();
    const v = this.view();
    this.syncRoom(v.pick); // the room can move by itself (a closed PO, the first pick): the box follows it
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
    if (!blocks.length && v.pick && (v.filter !== "all" || v.who) && v.raw.length) {
      blocks.push(h_flex().flex_none().p(14).gap(8).items_center()
        .child(div().text_size(12).text_color(t.dim).child("해당 메시지 없음 —"))
        .child(this.button(t, "flt-reset", "전체 보기", (c) => { this.setWho(v.pick, "", c); this.setFilter(v.pick, "all", c); }, { primary: true })));
    }
    if (!blocks.length) {
      blocks.push(div().flex_none().p(14).text_size(12).text_color(t.dim)
        .child(!this.data ? "불러오는 중…" : v.pick ? "이 방에는 아직 대화가 없습니다." : v.solo ? "기록된 Claude 터미널 대화가 없습니다." : "PO가 없습니다."));
    }
    // The "···" bubbles of whoever is writing now (the room's PO and leaders whose hc status is working): in EVERY filter (a chip hides
    // messages, not what is happening), after the last message, and nothing else reads them (not the unread counts, not `seenNext`, not the
    // follow key, not the spot map).
    const hn = v.pick ? this.rs.get(v.pick)?.note : null; // the handoff note of a restart, as the PO's own bubble
    if (hn?.text) blocks.push(this.entryRow(t, { key: `rs-note-${hn.ms}`, who: "po", head: true, ms: hn.ms, ts: "", text: `**인수인계 노트**\n\n${hn.text}`, to: "" }, v, cx));
    const rn = v.pick ? this.remoteNoteRow(t, v.pick) : null; // the last "원격 연결 켜기" result, a system note
    if (rn) blocks.push(rn);
    for (const x of this.typing(v)) blocks.push(this.typingRow(t, x));
    // The END SENTINEL: an 8px row (the list's bottom padding) as the LAST direct child. Every "go to the newest" is scroll_to_item(this sentinel):
    // the smallest scroll that reveals a thin row at the very end is the exact bottom, whatever the height of the last bubble. scroll_to_item on
    // the last bubble itself landed on its top when it was taller than the viewport (#54).
    blocks.push(div().id("inbox-end").flex_none().h(8));
    // Follow the newest: a new message scrolls to the bottom when the room just opened or the person already was at the bottom;
    // a person who scrolled up keeps their place. The handle's numbers are those of the last layout.
    const key = tlKey(`${v.pick}~${v.filter}~${v.who}`, v.shown); // a new filter scrolls to the newest like a new room
    this.lastIdx = Math.max(0, blocks.length - 1);
    if (this.scroll) {
      let atEnd = true;
      try {
        const o = this.scroll.offset(), vp = this.scroll.viewport_size(), ct = this.scroll.content_size();
        atEnd = atBottom(o.y, vp.height, ct.height);
      } catch {}
      // A message the person just sent follows too (once), from wherever they were reading; a new bubble of someone else does not (only at the end).
      const mine = sendFollow(this.sentAt2, Date.now(), key, this.tlSeen);
      if (mine) { this.sentAt2 = 0; this.reading = null; this.pin = { pinned: true, ct: Number(this.pin?.ct) || 0, vh: Number(this.pin?.vh) || 0 }; }
      if (mine || tlFollow(this.tlSeen, key, atEnd)) {
        const last = blocks.length - 1; // the end sentinel
        this.pinCh = 0; // a new room: the retry below is a fresh catch-up
        try { this.scroll?.scroll_to_item(last); } catch {}
        try { cx.timer.after(80, () => { if (!quietNow(this.ui, Date.now())) this.pinGo(last, "follow"); }); } catch {}
      }
    }
    this.tlSeen = key;
    // Re-pin after this draw: the person was at the bottom (within PIN_SLACK) and the content may have changed height (a row, the dots, a
    // picture); the handle still holds the last layout, so go to the end now and again once the new layout exists.
    if (this.scroll && this.pin.pinned && !quietNow(this.ui, Date.now())) {
      const last = blocks.length - 1;
      const go = () => { if (!quietNow(this.ui, Date.now())) this.pinGo(last, "draw"); };
      try { cx.timer.after(60, () => go()); cx.timer.after(220, () => go()); } catch {}
    }
    const waiting = v.tabs.reduce((n, x) => n + x.n, 0); // leaders waiting on a decision, over every room
    const head = v.pick === PO_OTHER ? OTHER_LABEL : v.tabs.find((x) => x.id === v.pick)?.label ?? "";
    const lines = v_flex().id("inbox-list").flex_1().min_h(0).overflow_y_scrollbar().mode("always")
      .on_mouse_down("left", (e, c) => { this.listDown(e); this.ui.press = true; this.ui.pressAt = Date.now(); this.dropSel(); c.stop_propagation(); })
      .on_mouse_up("left", () => { this.ui.press = false; })
      .on_mouse_down_out((_e, c) => { this.ui.press = false; if (this.ui.sel) this.dropSel(); if (this.dirty) this.softNotify(c); })
      .when(Boolean(this.scroll), (el) => el.track_scroll(this.scroll)).children(blocks);
    // #72: the round jump-to-newest button in the list's bottom-right corner (inside the list's own box: it never reaches the input below), shown only
    // while the view is scrolled up from the end. The list itself is unchanged inside this box.
    const jump = this.jump && blocks.length > 1
      ? h_flex().id("inbox-jump").absolute().bottom(12).right(18).w(32).h(32).rounded(16).items_center().justify_center().cursor_pointer()
        .bg(t.raised).border(1).border_color(t.border).text_color(t.muted).hover((x) => x.bg(t.hover).text_color(t.foreground))
        .on_mouse_down("left", stop).on_click((_e, c) => this.jumpToEnd(c)).tooltip("가장 아래(최신)로")
        .child(div().text_size(15).child("↓"))
      : null;
    const listBox = v_flex().id("inbox-listbox").relative().flex_1().min_h(0).child(lines).when(Boolean(jump), (el) => el.child(jump));
    const bar = this.filterBar(t, v);
    const lbar = this.leaderBar(t, v);
    const rrow = this.restartRow(t, v, cx); // "PO 새로 시작": the button, its confirm line or its steps (null in the other-PO room)
    const rpo = !v.solo && v.pick && v.pick !== PO_OTHER ? chatTarget(v.terms, [], v.pick).po ?? "" : ""; // (no remote button in a solo room yet)
    const rcb = rpo ? this.remoteButton(t, v.pick, rpo, String(v.terms.find((x) => x.address === rpo)?.status ?? "")) : null; // "원격 연결 켜기" (#79): in the room header
    const usage = this.usageLine(t, v.pick); // null before the first read (and when there is no cost to show either)
    const panel = this.promptPanel(t, v, cx); // a blocked PO's screen + its keys (null while the room's PO is not waiting on a prompt)
    const room = v_flex().flex_1().min_w(0).min_h(0).when(!strip, (el) => el.h_full()) // beside the rooms the column must fill the row (h_flex centers children)
      .when(!strip && Boolean(head), (el) => el.child(h_flex().flex_none().h(30).px(14).gap(6).items_center().border_b(1).border_color(t.border)
        .child(div().min_w(0).truncate().text_size(13).font_semibold().text_color(t.foreground).child(head))
        .child(div().flex_none().text_size(10.5).text_color(t.dim).child(v.pick === PO_OTHER ? "채팅 없음" : v.solo ? "터미널" : `리더 ${v.choices?.length ?? 0}명`))
        .when(Boolean(rcb), (el) => el.child(rcb))))
      .when(strip && Boolean(rcb), (el) => el.child(h_flex().flex_none().min_w(0).px(14).pb(4).justify_end().child(rcb))) // the picker layout has no room header
      .when(Boolean(usage), (el) => el.child(usage))
      .when(Boolean(bar), (el) => el.child(bar))
      .when(Boolean(lbar), (el) => el.child(lbar))
      .child(listBox)
      .when(Boolean(panel), (el) => el.child(panel))
      .when(Boolean(rrow), (el) => el.child(rrow))
      .child(this.chatBox(t, v));
    return v_flex().size_full().min_h(0).relative().bg(t.chrome).text_size(13)
      .on_window_mouse_move((e, c) => this.pointer(e, c))
      .on_window_mouse_up("left", (e, c) => this.pointerUp(c, e))
      .on_size_change((size, c) => this.onSize(size.width, c))
      .child(h_flex().h(38).px(this.compact ? 10 : 14).flex_none().items_center().justify_between()
        .child(h_flex().gap(6).items_center()
          .when(!this.paned || this.mained, (el) => el.child(div().text_size(15).font_semibold().text_color(t.foreground).child("UI 모드"))) // a pane's own header already says it
          .when(!this.windowed && waiting > 0, (el) => el.child(this.tag(t, `대기 ${waiting}`, "blocked")))
          .child(div().id("inbox-refresh").p(3).rounded(5).text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground))
            .on_mouse_down("left", stop).on_click((_e, c) => { this.gen++; this.busy = false; this.remoteRestore(c, true); this.load(c); }).tooltip("새로고침")
            .child(this.busy ? svg(ICON("spinner")).size(13).spin(900) : div().text_size(14).child("↻"))))
        .child(h_flex().gap(8).items_center()
          .child(div().text_size(11).text_color(t.dim).child(this.data ? ago(this.data.at) : ""))
          .when(!this.paned, (el) => el.child(this.button(t, "inbox-beside", "옆에 열기", (c) => { this.openBeside(); c.notify(); }, { tip: "리더 옆 창(페인)으로 엽니다. 리더가 없으면 지금 터미널 옆, 이 탭에 이미 있으면 그쪽으로 갑니다" })))
          .when(this.mained, (el) => el.child(this.button(t, "inbox-terminal-mode", "터미널 모드", (c) => { this.toTerminalMode(); c.notify(); }, { tip: "터미널 화면으로 돌아갑니다. 터미널은 꺼지지 않고 그대로 있습니다" })))
          .when(!this.windowed && !this.mained, (el) => el.child(this.button(t, "inbox-open", "창 열기", (c) => { this.openWindow(); c.notify(); }, { tip: "UI 모드 창을 엽니다" })))
          .when(this.windowed, (el) => el.child(div().id("inbox-close").p(4).rounded(5).text_color(t.dim).cursor_pointer().hover((x) => x.bg(t.hover).text_color(t.foreground))
            .on_mouse_down("left", stop).on_click((_e, c) => { try { closeOverlay(safeProps().overlay); } catch {} c.notify(); }).tooltip("닫기")
            .child(svg("mods/pane/close.svg").size(13))))))
      .when(strip, (el) => el.child(this.picker(t, v)))
      .when(!strip && !v.tabs.some((x) => x.id !== PO_OTHER), (el) => el.child(this.poHint(t, v)))
      .when(Boolean(this.error), (el) => el.child(div().px(14).pb(6).text_size(11).text_color(t.blocked).max_h(48).overflow_hidden().child(this.error)))
      .child(strip ? room : h_flex().flex_1().min_h(0).items_stretch().child(this.narrow ? this.slimRooms(t, v) : this.roomList(t, v)).child(room))
      // The notice floats over the top of the room: absolute, so it takes no layout space and the chat never moves when it comes or goes.
      .when(Boolean(this.msg), (el) => el.child(h_flex().id("inbox-msg-layer").absolute().top(NOTICE_TOP).left(0).right(0).px(14).justify_center()
        .child(div().id("inbox-msg").max_w(NOTICE_MAX_W).px(12).py(5).rounded(6).bg(t.chrome).shadow_md().text_size(11.5).cursor_pointer().text_color(this.msg.bad ? t.blocked : t.working)
          .on_mouse_down("left", stop).on_click((_e, c) => { this.msg = null; c.notify(); }).tooltip("눌러서 닫기").child(soloWords(this.msg.text)))));
  }
}
