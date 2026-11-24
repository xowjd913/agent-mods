// Inbox panel: the leaders' reports (~/.herdr-inbox/<leader>.jsonl, written by `report`).
//  - The right pane is ONE list: open decision/verify asks pinned on top, then the latest reports (newest first), one short row each
//    (leader, kind badge, first line). A row opens the floating window at that item; the counts are small badges in the pane header.
//  - The window is the chat view, in two lanes:
//  - "결정 필요": leaders whose terminal has a wait label (decision|verify): their last decision/verify report, with
//    "링크 열기", "확인 완료" (verify only) and "답 쓰기".
//  - "결과 보고": every other report (done, stop, ...) as per-leader bubbles, newest first.
// A leader's name opens `terminal.peek` on its terminal. An answer is delivered as real user input: the line goes on the clipboard,
// the PO pane (the leader terminal's parent, only when it has the label role=po) is focused and the clipboard is pasted into it
// (terminal.paste). Enter is NOT pressed: the person submits it in the PO terminal, which doubles as a last check. Files are read
// by inbox.cjs; this mod only reads them.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, TextView, ScrollHandle } from "gpui-base";
import { theme, exec, appHome, checking, window, run, terminals, panes, setBadge, shared, setShared, props, openOverlay, closeOverlay } from "herdr";

const HELPER = () => `${appHome()}/mods/inbox/inbox.cjs`;
const ICON = (name) => `mods/workspace-chrome/${name}.svg`;
const LOAD_TIMEOUT = 20000, LOAD_STALL_MS = 30000, WINDOW_REFRESH_MS = 5000, PANE_REFRESH_MS = 30000, MAX_BUBBLES = 40;
const KIND = { done: ["완료", "working"], decision: ["결정", "blocked"], verify: ["확인", "blocked"], stop: ["중단", "idle"], resume: ["재개", "dim"], other: ["알림", "dim"], start: ["시작", "dim"] };
const WINDOW = { mod: "inbox", kind: "window", key: "inbox", keep: true, width: 480, height: 680, props: { mode: "window" } };
const SENT_KEY = "inbox.sent";
const OPEN_KEY = "inbox.expanded"; // cards the person opened ("자세히"), shared so they stay open across re-renders and window reopens
const MAX_OPEN = 60;
const FOCUS_KEY = "inbox.focus"; // "<leader>|<report time>" the window should show first and open (set by a pane row), "" for none
const SECT_KEY = "inbox.sections"; // {ask:{c,n}, rep:{c}}: which window sections the person collapsed (c) and, for "결정 필요", at which count (n)
const MAX_ROWS = 20; // pane rows below the pinned asks; the rest is in the window
const NO_PO = "이 리더의 PO 터미널을 찾지 못했습니다(리더 터미널의 부모가 role=po 라벨이어야 합니다).";
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
      out.push({ s, term, kind, item, po: findPo(list, term.name, term.address), link: String(term?.labels?.["wait-link"] ?? "").trim() || item?.link || "" });
    }
    return out.sort((a, b) => (b.item?.ms ?? 0) - (a.item?.ms ?? 0));
  }

  // Everything else, newest first: not start/answered lines, and not the report a lane-1 card already shows.
  reports(asks, cap = MAX_BUBBLES) {
    const shown = new Set(asks.map((a) => `${a.s.leader}|${a.item?.ts}`));
    const out = [];
    for (const s of this.data?.leaders ?? []) {
      for (const it of s.items) {
        if (it.kind === "answered" || it.kind === "start" || shown.has(`${s.leader}|${it.ts}`)) continue;
        out.push({ s, it });
      }
    }
    return out.sort((a, b) => b.it.ms - a.it.ms).slice(0, cap);
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
    const asks = this.asks();
    const all = this.reports(asks, Infinity);
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
        .child(div().text_size(14).font_semibold().text_color(t.foreground).child("받은편지함"))
        .child(badge("결정", asks.length, t.blocked))
        .child(badge("보고", all.length, null))
        .child(div().flex_1())
        .child(div().flex_none().text_size(11).text_color(t.dim).child(this.data ? ago(this.data.at) : "불러오는 중…"))
        .child(this.button(t, "inbox-open", "창 열기", (c) => { this.clearFocus(); this.openWindow(); c.notify(); }, { tip: "받은편지함 창을 엽니다" })))
      .when(Boolean(this.error), (el) => el.child(div().text_size(11).text_color(t.blocked).max_h(48).overflow_hidden().child(this.error)))
      .when(Boolean(this.msg), (el) => el.child(div().text_size(11.5).text_color(this.msg.bad ? t.blocked : t.working).child(this.msg.text)))
      .child(v_flex().id("inbox-rows").flex_1().min_h(0).gap(4).overflow_y_scrollbar().mode("always").when(Boolean(this.rowsScroll), (el) => el.track_scroll(this.rowsScroll)).children(list));
  }

  // The full chat view (pane or window): both lanes.
  full(cx) {
    const t = theme();
    const asks = this.asks();
    let reports = this.reports(asks);
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
          .child(div().text_size(15).font_semibold().text_color(t.foreground).child("받은편지함"))
          .child(div().id("inbox-refresh").p(3).rounded(5).text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground))
            .on_mouse_down("left", stop).on_click((_e, c) => { this.gen++; this.busy = false; this.load(c); }).tooltip("새로고침")
            .child(this.busy ? svg(ICON("spinner")).size(13).spin(900) : div().text_size(14).child("↻"))))
        .child(h_flex().gap(8).items_center()
          .child(div().text_size(11).text_color(t.dim).child(this.data ? ago(this.data.at) : ""))
          .when(this.windowed, (el) => el.child(div().id("inbox-close").p(4).rounded(5).text_color(t.dim).cursor_pointer().hover((x) => x.bg(t.hover).text_color(t.foreground))
            .on_mouse_down("left", stop).on_click((_e, c) => { this.clearFocus(); try { closeOverlay(safeProps().overlay); } catch {} c.notify(); }).tooltip("닫기")
            .child(svg("mods/pane/close.svg").size(13))))))
      .when(Boolean(this.error), (el) => el.child(div().px(14).pb(6).text_size(11).text_color(t.blocked).max_h(48).overflow_hidden().child(this.error)))
      .when(Boolean(this.msg), (el) => el.child(div().id("inbox-msg").px(14).pb(6).text_size(11.5).cursor_pointer().text_color(this.msg.bad ? t.blocked : t.working)
        .on_mouse_down("left", stop).on_click((_e, c) => { this.msg = null; c.notify(); }).child(this.msg.text)))
      .child(v_flex().id("inbox-list").on_mouse_down("left", stop).flex_1().min_h(0).px(4).overflow_y_scrollbar().mode("always").when(Boolean(this.scroll), (el) => el.track_scroll(this.scroll)).children(blocks));
  }
}
