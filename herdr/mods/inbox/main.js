// Inbox panel: the leaders' reports (~/.herdr-inbox/<leader>.jsonl, written by `report`) as a chat, in two lanes.
//  - "결정 필요": leaders whose terminal has a wait label (decision|verify): their last decision/verify report, with
//    "링크 열기", "확인 완료" (verify only) and "답 쓰기".
//  - "결과 보고": every other report (done, stop, ...) as per-leader bubbles, newest first.
// A leader's name opens `terminal.peek` on its terminal. An answer is typed into the PO terminal (the claude-code terminal the
// lead-* terminals hang under) with `hc send` run by this app, which has no calling terminal and so no <hc from> tag: the PO sees
// it as the person's own input. Files are read by inbox.cjs; this mod only reads them and types the answer.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { theme, exec, hc, appHome, checking, window, run, terminals, shared, setShared, setBadge, props, openOverlay, closeOverlay } from "herdr";

const HELPER = () => `${appHome()}/mods/inbox/inbox.cjs`;
const ICON = (name) => `mods/workspace-chrome/${name}.svg`;
const LOAD_TIMEOUT = 20000, LOAD_STALL_MS = 30000, REFRESH_MS = 5000, MAX_BUBBLES = 40;
const KIND = { done: ["완료", "working"], decision: ["결정", "blocked"], verify: ["확인", "blocked"], stop: ["중단", "idle"], resume: ["재개", "dim"], other: ["알림", "dim"], start: ["시작", "dim"] };
const WINDOW = { mod: "inbox", kind: "window", key: "inbox", keep: true, width: 480, height: 680, props: { mode: "window" } };
const WAIT = { decision: "결정", verify: "확인" };

// The PO terminal: the parent the lead-* terminals share (a leader's own parent first). Same rule as inbox.cjs findPo; kept here
// because the mod cannot require a .cjs file.
function findPo(terms, leaderName) {
  const list = terms ?? [];
  const byAddr = new Map(list.map((t) => [t.address, t]));
  const own = list.find((t) => leaderName && t.name === leaderName)?.parent;
  if (own && byAddr.has(own)) return own;
  const count = new Map();
  for (const t of list) {
    if (!/^lead-/.test(String(t.name ?? "")) || !t.parent || !byAddr.has(t.parent)) continue;
    count.set(t.parent, (count.get(t.parent) ?? 0) + 1);
  }
  return [...count.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

function answerLine(kind, leader, text, link) {
  const body = String(text ?? "").replace(/\s*\n\s*/g, " ").trim();
  return `Panel answer (${kind}) for ${leader}: "${body}".${link ? ` Target: ${link}` : ""}`;
}

function openUrl(url) {
  if (!/^https?:\/\//i.test(url)) return;
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

const shortName = (leader) => String(leader).replace(/^lead-/, "");

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
    this.sent = new Map(); // leader -> ts of the ask that got an answer from this panel
    this.msg = null; // {text, bad}
    if (checking()) return;
    this.load(cx);
    cx.timer.every(REFRESH_MS, (cx) => { this.load(cx); this.badge(); });
  }

  // The number of leaders that wait on a decision: on the panel button (shared with tabs-mine) and the app icon badge.
  badge() {
    const n = this.asks().length;
    if (shared("inbox.waiting") !== n) setShared("inbox.waiting", n);
    const text = n > 0 ? String(n) : "";
    if (text !== this.badged) { this.badged = text; try { setBadge(text || null); } catch {} }
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
      } catch (e) { if (gen === this.gen) this.error = `불러오기 실패: ${String(e?.message ?? e).slice(0, 180)}`; }
      finally { if (gen === this.gen) { this.busy = false; this.badge(); cx.notify(); } }
    });
  }

  // The live terminal of a leader: by name first, else by the address its reports carry.
  terminalOf(s) {
    const list = terminals() ?? [];
    return list.find((t) => t.name === s.leader) ?? list.find((t) => t.address === s.terminal) ?? null;
  }

  // Leaders whose terminal carries a wait label: [{s, term, kind, link, item}]. The text is the leader's last decision/verify report.
  asks() {
    const out = [];
    for (const s of this.data?.leaders ?? []) {
      const term = this.terminalOf(s);
      const kind = String(term?.labels?.wait ?? "").trim().toLowerCase();
      if (kind !== "decision" && kind !== "verify") continue;
      const item = s.ask ?? s.open;
      out.push({ s, term, kind, item, link: String(term?.labels?.["wait-link"] ?? "").trim() || item?.link || "" });
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

  // Types the answer into the PO terminal. hc runs without a terminal of its own, so nothing marks it as a message from an agent.
  send(a, text, cx) {
    const body = String(text ?? "").trim();
    if (!body) { this.say("답을 먼저 적어 주세요.", true); cx.notify(); return; }
    const po = findPo(terminals(), a.s.leader);
    if (!po) { this.say("PO 터미널을 찾지 못했습니다(lead-* 터미널의 부모).", true); cx.notify(); return; }
    const line = answerLine(a.kind, a.s.leader, body, a.link);
    cx.spawn(async (cx) => {
      try {
        const r = await hc(["send", po, line, "--json"]);
        if (r.code !== 0) throw new Error((r.stderr || r.stdout || `종료 코드 ${r.code}`).trim().slice(0, 160));
        this.sent.set(a.s.leader, a.item?.ts ?? "");
        this.inputs.get(a.s.leader)?.set_value("");
        if (this.writing === a.s.leader) this.writing = null;
        this.say(`${shortName(a.s.leader)} 건 답을 PO(${po})에 입력했습니다.`);
      } catch (e) { this.say(`보내지 못했습니다: ${String(e?.message ?? e).slice(0, 160)}`, true); }
      cx.notify();
    });
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
    return div().id(id).flex_none().h(24).px(10).rounded(12).flex().items_center().text_size(11.5).cursor_pointer()
      .on_mouse_down("left", stop).bg(o.primary ? t.selected : t.raised).border(1).border_color(o.primary ? t.foreground + "40" : t.border)
      .text_color(o.primary ? t.foreground : t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click((_e, cx) => onClick(cx)).child(label);
  }

  tag(t, text, color) {
    return div().flex_none().px(6).h(17).rounded(5).bg((t[color] ?? t.dim) + "26").text_size(10.5).text_color(t[color] ?? t.dim).flex().items_center().child(text);
  }

  heading(t, text, count, first) {
    return h_flex().h(first ? 30 : 38).px(8).pt(first ? 4 : 14).items_center().gap(7).flex_none()
      .when(!first, (el) => el.border_t(1).border_color(t.border).mt(6))
      .child(div().min_w(0).truncate().text_size(13).font_semibold().text_color(t.foreground).child(text))
      .child(div().flex_none().px(6).h(16).rounded(8).bg(t.raised).flex().items_center().text_size(10.5).text_color(t.muted).child(String(count)));
  }

  avatar(t, leader) {
    const c = tint(t, leader);
    return div().flex_none().size(28).rounded(14).bg(c + "33").flex().items_center().justify_center().text_size(12).font_semibold().text_color(c)
      .child(shortName(leader).slice(0, 1).toUpperCase());
  }

  // A speech bubble: the report's text, one line per paragraph, long lines wrapped.
  bubble(t, it, accent) {
    const lines = String(it.body || it.title).split("\n").filter((l) => l.trim());
    return v_flex().min_w(0).px(10).py(7).gap(3).rounded(10).bg(accent ? accent + "1f" : t.raised).border(1).border_color(accent ? accent + "55" : t.border)
      .text_size(12.5).text_color(t.foreground)
      .children(lines.map((l) => div().min_w(0).child(l)));
  }

  nameRow(t, s, it, extra) {
    return h_flex().gap(6).items_center().min_w(0)
      .child(div().id(`peek-${s.leader}-${it?.ts ?? ""}`).min_w(0).truncate().text_size(12).font_semibold().text_color(tint(t, s.leader)).cursor_pointer()
        .hover((x) => x.text_color(t.foreground)).on_mouse_down("left", stop).on_click(() => this.peek(s)).tooltip("그 리더 터미널 들여다보기").child(shortName(s.leader)))
      .when(Boolean(it), (el) => { const k = KIND[it.kind] ?? KIND.other; return el.child(this.tag(t, k[0], k[1])); })
      .child(div().flex_1())
      .when(Boolean(it?.ts), (el) => el.child(div().flex_none().text_size(10.5).text_color(t.dim).child(ago(it.ts))))
      .when(Boolean(extra), (el) => el.child(extra));
  }

  askCard(t, a, cx) {
    const { s, kind, item, link } = a;
    const done = this.sent.get(s.leader) === (item?.ts ?? "");
    const writing = this.writing === s.leader;
    const card = v_flex().id(`ask-${s.leader}`).flex_none().mx(4).mb(8).p(8).gap(6).rounded(10).bg(t.raised).border(1).border_color(t.blocked + "66");
    const head = h_flex().gap(8).items_start()
      .child(this.avatar(t, s.leader))
      .child(v_flex().flex_1().min_w(0).gap(4)
        .child(this.nameRow(t, s, item ? { ...item, kind } : null))
        .child(item ? this.bubble(t, item, t.blocked) : div().text_size(12).text_color(t.dim).child("이 리더의 보고 내용을 찾지 못했습니다. 터미널을 들여다보세요.")));
    const actions = h_flex().gap(6).pl(this.compact ? 0 : 36).items_center().flex_wrap()
      .when(Boolean(link), (el) => el.child(this.button(t, `link-${s.leader}`, "링크 열기", () => openUrl(link))))
      .when(kind === "verify", (el) => el.child(this.button(t, `ok-${s.leader}`, "확인 완료", (c) => this.send(a, "확인 완료", c), { primary: true })))
      .child(this.button(t, `write-${s.leader}`, writing ? "닫기" : "답 쓰기", (c) => { this.writing = writing ? null : s.leader; if (!writing) this.box(s.leader, c); c.notify(); }))
      .when(done, (el) => el.child(div().text_size(11).text_color(t.working).child("답을 PO에 입력함 · 리더가 받으면 사라집니다")));
    card.child(head).child(actions);
    if (writing) {
      const input = this.box(s.leader, cx);
      card.child(h_flex().gap(6).pl(this.compact ? 0 : 36).items_center()
        .child(div().flex_1().min_w(0).on_mouse_down("left", stop).child(Input.new(input).h(30).px(10).items_center().rounded(8).border(1).border_color(t.input).bg(t.background).text_size(12.5).text_color(t.foreground)))
        .child(this.button(t, `send-${s.leader}`, "보내기", (c) => this.send(a, input.value(), c), { primary: true })));
    }
    return card;
  }

  chatRow(t, r) {
    const { s, it } = r;
    return h_flex().flex_none().px(8).py(4).gap(8).items_start()
      .child(this.avatar(t, s.leader))
      .child(v_flex().flex_1().min_w(0).gap(4).child(this.nameRow(t, s, it)).child(this.bubble(t, it)))
      .when(Boolean(it.link), (el) => el.child(div().id(`open-${s.leader}-${it.ts}`).flex_none().mt(2).px(6).py(2).rounded(5).text_size(11).text_color(t.dim)
        .hover((x) => x.bg(t.hover).text_color(t.foreground)).cursor_pointer().on_mouse_down("left", stop).on_click(() => openUrl(it.link)).tooltip(it.link).child("링크")));
  }

  render(cx) { return this.windowed ? this.full(cx) : this.summary(cx); }

  // The small pane: how many wait on a decision and how many reports came in; a click opens the chat view in a floating window.
  summary(cx) {
    const t = theme();
    const asks = this.asks();
    const reports = this.reports(asks, Infinity);
    const row = (id, label, n, color) => h_flex().id(id).h(34).px(10).gap(8).items_center().rounded(8).bg(t.raised).border(1).border_color(n > 0 && color ? color + "66" : t.border)
      .child(div().flex_1().min_w(0).truncate().text_size(12.5).text_color(t.foreground).child(label))
      .child(div().flex_none().px(8).h(18).rounded(9).bg(n > 0 && color ? color + "26" : t.hover).flex().items_center().text_size(11.5).font_semibold().text_color(n > 0 && color ? color : t.muted).child(String(n)));
    return v_flex().id("inbox-summary").size_full().min_h(0).bg(t.chrome).p(12).gap(8).cursor_pointer()
      .on_click((_e, c) => this.openWindow()).tooltip("누르면 받은편지함 창을 엽니다")
      .child(h_flex().items_center().justify_between()
        .child(div().text_size(14).font_semibold().text_color(t.foreground).child("받은편지함"))
        .child(div().text_size(11).text_color(t.dim).child(this.data ? ago(this.data.at) : "불러오는 중…")))
      .when(Boolean(this.error), (el) => el.child(div().text_size(11).text_color(t.blocked).max_h(48).overflow_hidden().child(this.error)))
      .child(row("sum-asks", "결정 필요", asks.length, t.blocked))
      .child(row("sum-reports", "결과 보고", reports.length, null))
      .when(Boolean(this.msg), (el) => el.child(div().text_size(11.5).text_color(this.msg.bad ? t.blocked : t.working).child(this.msg.text)))
      .child(div().text_size(11).text_color(t.dim).child("눌러서 채팅 창 열기"));
  }

  // The full chat view (pane or window): both lanes.
  full(cx) {
    const t = theme();
    const asks = this.asks();
    const reports = this.reports(asks);
    const blocks = [];
    blocks.push(this.heading(t, "결정 필요", asks.length, true));
    if (asks.length) asks.forEach((a) => blocks.push(this.askCard(t, a, cx)));
    else blocks.push(div().flex_none().px(10).pb(8).text_size(12).text_color(t.dim).child(this.data ? "기다리는 결정·확인이 없습니다." : "불러오는 중…"));
    blocks.push(this.heading(t, "결과 보고", reports.length, false));
    if (reports.length) reports.forEach((r) => blocks.push(this.chatRow(t, r)));
    else blocks.push(div().flex_none().px(10).text_size(12).text_color(t.dim).child(this.data ? "받은 보고가 없습니다." : ""));
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
            .on_mouse_down("left", stop).on_click((_e, c) => { try { closeOverlay(safeProps().overlay); } catch {} c.notify(); }).tooltip("닫기")
            .child(svg("mods/pane/close.svg").size(13))))))
      .when(Boolean(this.error), (el) => el.child(div().px(14).pb(6).text_size(11).text_color(t.blocked).max_h(48).overflow_hidden().child(this.error)))
      .when(Boolean(this.msg), (el) => el.child(div().id("inbox-msg").px(14).pb(6).text_size(11.5).cursor_pointer().text_color(this.msg.bad ? t.blocked : t.working)
        .on_mouse_down("left", stop).on_click((_e, c) => { this.msg = null; c.notify(); }).child(this.msg.text)))
      .child(v_flex().id("inbox-list").on_mouse_down("left", stop).flex_1().min_h(0).px(4).overflow_y_scrollbar().mode("always").children(blocks));
  }
}
