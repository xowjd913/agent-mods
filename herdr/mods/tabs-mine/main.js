// Clone of Herdr's shipped `tabs` mod. The PRs button shows a count of PRs needing my action (collect.cjs `attention`: my open PRs with failing CI or changes requested, plus open PRs asking me to review). The layout blocks are "work-board" (mod work) and "pr-board" (mod prs); the id "work" is already a layout column. Changed: the right-panel buttons are Files, Changes, then Work and PRs (added after the stock ones). A 설정 button opens the settings window (mods/settings); the 계정 panel button moved into it.
import { View, div, svg, image } from "gpui-kit";
import { h_flex, ScrollHandle } from "gpui-base";
import { spaces, panes, terminals, focused, run, notify, openOverlay, theme, window, shared, setShared, layout, settings, exec, appHome, checking, layouts, nextCommand } from "herdr";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// Same as the agents mod: drops a status glyph, keeps a leading bracket or quote.
const clean = (s) => (s ?? "").replace(/^[^\p{L}\p{N}\p{Ps}\p{Pi}]+/u, "").replace(/^\[ [!.] \] /, "").trim();

// A tab Herdr named (unnamed, or after its program) follows its agent's live
// title, as the agents list does; a name the person gave stays.
function label(tab, lead) {
  const prog = lead?.program?.name;
  const base = tab.named ? tab.name : prog ?? "Terminal";
  if (!lead?.program?.agent) return base;
  const live = clean(lead.title);
  // clean() would strip a path's leading ~ or /: test the title with only its status glyph gone.
  const path = /^[~/]|^[A-Za-z]:\\/.test((lead.title ?? "").replace(/^[^\p{L}\p{N}~/]+/u, ""));
  const telling = live && live !== lead.terminal && live !== prog && !path && !live.includes("@") && live.toLowerCase() !== lead.program.key;
  return (tab.name === prog || !tab.named) && telling ? live : base;
}

// settings-window:begin
// 설정 창의 모양. tabs-mine/main.js와 settings/main.js에 이 블록을 그대로 복사해 둔다(모드끼리 파일을 불러올 수 없다. 테스트가 둘이 같은지 본다).
// 칸을 바꾸면 SETTINGS_BODY와 settings/main.js의 SECTIONS를 함께 고친다.
const SETTINGS_SHARED = "settings.section"; // 마지막으로 본 칸. 버튼으로 다시 열면 그 칸으로 연다
const SETTINGS_BODY = { accounts: { mod: "gh-accounts" }, mods: { mod: "settings", props: { part: "mods" } }, rules: { mod: "settings", props: { part: "rules" } }, fontsize: { mod: "settings", props: { part: "fontsize" } } };
const settingsWindow = (section) => {
  const id = SETTINGS_BODY[section] ? section : "accounts"; // 옛 이름(github)이 기억돼 있어도 계정 칸으로 간다
  return { kind: "window", key: "settings", width: 900, height: 720, layout: { id: "settings", type: "column", children: [
    { id: "settings-bar", type: "block", content: { mod: "settings", props: { part: "bar" } }, size: { px: 40 }, window_drag: true },
    { id: "settings-main", type: "row", children: [
      { id: "settings-nav", type: "block", content: { mod: "settings", props: { part: "nav", section: id } }, size: { px: 200 } },
      // 내용 아래에 여백 칸을 둬서 마지막 줄이 창 아래에 붙지 않게 한다(내용 모드는 고치지 않는다).
      { id: "settings-body", type: "column", size: { weight: 1 }, children: [
        { id: "settings-content", type: "block", content: SETTINGS_BODY[id], size: { weight: 1 } },
        { id: "settings-pad", type: "block", content: { mod: "settings", props: { part: "pad" } }, size: { px: 24 } },
      ] },
    ] },
  ] } };
};
// settings-window:end

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
  preset: "po", arrangeScript: "~/.claude/skills/leader/herdr-team.sh", // the profile's preset ("none" = no agent / hub naming rules at all, #124) and the PO arrange script ("" = not there: the features that need it hide)
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

// Which terminal is a waiting leader. Copied verbatim from inbox/inbox.cjs (a test keeps them identical).
const waitingKind = (t) => (isAgentName(t?.name) ? (["decision", "verify"].find((k) => k === labelOf(t, "labelWait").toLowerCase()) ?? "") : "");

// UI 모드/터미널 모드: 설치기가 터미널 모드 레이아웃(<이름>)에서 만든 `<이름>-ui`와 서로 바꾼다. 짝이 없으면 null.
function modeTarget() {
  try {
    const cur = String(shared("layout") ?? "");
    const ui = cur.endsWith("-ui");
    const name = ui ? cur.slice(0, -3) : `${cur}-ui`;
    return cur && (layouts() ?? []).includes(name) ? { ui, name } : null;
  } catch { return null; }
}

export default class Tabs extends View {
  // 이름 규칙(#126): 이 모드는 항상 떠 있어서, 아무도 아직 `inbox.names`를 올리지 않았으면(inbox 모드 없이 설치했거나 설정 창을 아직 안 열었을 때) 프로필 규칙을
  // 한 번 읽어 올린다. 그러면 NAMES 기본값(po) 대신 pickPreset 순서(프로필 파일 → PO 배치 스크립트 유무)가 같이 적용된다. 도우미가 없거나 실패하면 기본값이 그대로다.
  publishNames(cx) {
    cx.spawn(async () => {
      try {
        const cur = shared(NAMES_SHARED);
        if (cur && Object.keys(cur).length) return;
        const r = await exec("node", [`${String(appHome() ?? "")}/mods/settings/rules.cjs`, "show"], { timeout: 20000 });
        const names = JSON.parse(String(r?.stdout ?? "").trim().split("\n").pop())?.names;
        if (names && typeof names === "object") adoptNames(names);
      } catch {}
    });
  }

  init(_props, cx) {
    this.attention = 0;
    if (!checking()) {
      this.publishNames(cx);
      this.refresh(cx);
      // collect.cjs caches GitHub for 3 minutes, so asking once a minute is cheap. Without node or gh the badge just stays hidden.
      cx.timer.every(60000, (cx) => this.refresh(cx));
      // 예약(schedules 모드): 이 탭 줄은 항상 화면에 있어서 30초마다 도우미의 tick을 여기서 부른다. 모드가 없으면 조용히 넘어간다.
      this.tickSchedules(cx);
      cx.timer.every(30000, (cx) => this.tickSchedules(cx));
      // 예약 세션은 `hc run --bg --no-parent`로 떠서 탭이 없다. 살아 있는 것을 찾아 탭으로 붙인다(메모리 값만 보는 가벼운 검사).
      this.adopting = new Map();
      this.adopted = new Set();
      cx.timer.every(2000, () => this.adoptSchedules());
      cx.timer.every(150, () => this.restoreAdopted());
      // keys.json의 "tabs-mine.mode"(예: "cmd-shift-u": "tabs-mine.mode")로도 같은 전환을 한다.
      // "tabs-mine.memo" / "tabs-mine.memo-new"(메모 모드): 키는 화면에 보이는 모드에만 닿는데 메모 패널은 닫혀 있으면 안 보이므로 늘 보이는 이 탭 줄이 받는다. 패널을 열고, 메모 모드가 읽을 깃발을 남긴다.
      cx.spawn(async () => {
        for (;;) {
          const c = String(await nextCommand());
          if (c === "mode") { const m = modeTarget(); if (m) run("layout.switch", { name: m.name }); }
          else if (c === "memo" || c === "memo-new") this.openMemo(c === "memo-new");
        }
      });
    }
    this.pressed = null;
    this.scroll = ScrollHandle.new();
    try { this.panels = JSON.parse(localStorage.getItem("panels") ?? "{}"); } catch { this.panels = {}; }
    if (!this.panels || typeof this.panels !== "object" || Array.isArray(this.panels)) this.panels = {};
    this.swipe = { acc: 0, steps: 0, at: 0, last: 0 };
  }

  // 오른쪽 패널의 메모 칸을 열고 메모 모드에 깃발을 남긴다(new: 새 메모 화면으로). 메모 모드(또는 그 칸)가 없으면 조용히 넘어간다.
  openMemo(isNew) {
    try {
      const body = find(layout(), "panel-body");
      if (!(body?.children ?? []).some(c => c.id === "memo-board")) return;
      run("layout.select", { stack: "panel-body", child: "memo-board" });
      run("layout.show", { id: "panel" });
      setShared("memo.want", { new: Boolean(isNew), at: Date.now() });
    } catch {}
  }

  // schedules.cjs tick은 실행할 때가 된 예약을 잠금 아래에서 골라 따로 띄우고 바로 끝난다. 이전 tick이 안 끝났으면 건너뛴다.
  tickSchedules(cx) {
    if (this.ticking) return;
    this.ticking = true;
    cx.spawn(async () => {
      try {
        const r = await exec("node", [`${appHome()}/mods/schedules/schedules.cjs`, "tick"], { timeout: 60000 });
        this.showScheduleNotices(r);
      } catch {}
      finally { this.ticking = false; }
    });
  }

  // tick이 알려 준 새 결과(실패·입력 대기·놓침·완료)를 Herdr 알림으로 띄운다. OS 알림은 schedules.cjs가 따로 보낸다.
  // 누르면 그 세션으로 간다: 칸이 있으면 그 칸으로, 없으면 살아 있는 터미널을 위에 띄운다. 이미 닫혔으면 누를 곳이 없다.
  showScheduleNotices(result) {
    let out = null;
    try { out = JSON.parse(String(result?.stdout ?? "").trim().split("\n").pop()); } catch { return; }
    for (const n of out?.notices ?? []) {
      try {
        let action;
        if (n.terminal) {
          const pane = (panes() ?? []).find((p) => p.terminal === n.terminal);
          if (pane) action = { name: "pane.focus", args: { pane: pane.id ?? pane.pane } };
          else if ((terminals() ?? []).some((t) => t.address === n.terminal)) action = { name: "terminal.peek", args: { terminal: n.terminal } };
        }
        notify({ title: n.title, body: n.body, level: n.level, ...(action ? { action } : {}) });
      } catch {}
    }
  }

  // 예약 세션(label schedule=<id>)이 살아 있는데 칸이 없으면 탭을 붙인다.
  //  - 어느 공간: 그 세션의 폴더와 같거나 안팎으로 겹치는 폴더에서 일하는 칸이 있는 공간, 없으면 공간 폴더가 맞는 공간, 그래도 없으면 지금 보는 공간.
  //  - terminal.keep은 선택된 공간에 탭을 만들고 포커스를 가져가므로, 맞는 공간으로 잠깐 옮겼다가 붙은 뒤 원래 탭으로 되돌린다.
  //  - 탭 이름은 세션 이름 label(예약 · <이름>)이다. 같은 터미널은 한 번만 붙인다(재사용 세션도 같은 탭 그대로).
  adoptSchedules() {
    try {
      if (this.adopting.size) return; // 포커스를 옮기는 작업은 한 번에 하나씩(되돌리기는 restoreAdopted가 150ms마다 처리)
      const list = terminals() ?? [];
      const paned = new Map((panes() ?? []).filter((p) => p.terminal).map((p) => [p.terminal, p]));
      const t = list.find((x) => x.labels?.schedule && x.state === "live" && !x.parent && !paned.has(x.address) && !this.adopted.has(x.address));
      if (!t) return;
      const prev = focused();
      const target = this.scheduleSpace(t.cwd);
      const moved = !!(target && prev && target !== prev.space);
      if (moved) run("space.select", { id: target });
      this.adopting.set(t.address, { at: Date.now(), target, moved, prev: prev ? { space: prev.space, tab: prev.tab } : null, name: labelOf(t, "labelSession") || null });
      run("terminal.keep", { terminal: t.address, place: "tab" });
      this.restoreAdopted(); // 칸이 바로 생겼으면 기다리지 않고 곧장 되돌린다
    } catch {}
  }

  // 붙이는 중인 터미널만 짧은 간격으로 본다. 칸이 생기면 탭 이름을 바꾸고 가져간 포커스를 바로 원래 공간·탭으로 돌려놓는다.
  // 2초를 기다리면 그 사이 사람이 치는 글이 아직 프롬프트를 못 받은 예약 세션으로 들어가기 때문이다.
  restoreAdopted() {
    try {
      if (!this.adopting.size) return;
      const list = terminals() ?? [];
      const paned = new Map((panes() ?? []).filter((p) => p.terminal).map((p) => [p.terminal, p]));
      const now = Date.now();
      for (const [addr, job] of this.adopting) {
        const pane = paned.get(addr);
        const gone = !list.some((t) => t.address === addr);
        if (!pane && !gone && now - job.at <= 15000) continue;
        const f = focused();
        if (pane) {
          if (job.name && pane.tab) run("tab.rename", { id: pane.tab, name: job.name });
          // 그 사이 사람이 다른 곳을 눌렀다면 건드리지 않는다(붙은 탭에 포커스가 있을 때만 되돌린다).
          if (job.prev?.tab && f && f.tab === pane.tab) {
            if (job.prev.space && f.space !== job.prev.space) run("space.select", { id: job.prev.space });
            run("tab.select", { id: job.prev.tab });
          }
        } else if (job.moved && job.prev?.tab && f && f.space === job.target) {
          // 붙이기에 실패했거나 시간이 지났다: 옮겨 둔 공간을 원래대로 돌려준다.
          run("space.select", { id: job.prev.space });
          run("tab.select", { id: job.prev.tab });
        }
        this.adopting.delete(addr);
        this.adopted.add(addr);
      }
    } catch {}
  }

  scheduleSpace(cwd) {
    if (!cwd) return null;
    const list = (spaces() ?? []).filter((s) => !s.machine);
    // 같으면 가장 가깝고, 한쪽이 다른 쪽의 상위 폴더면 상위 폴더가 길수록(더 구체적일수록) 가깝다.
    const norm = (x) => String(x).replace(/\\/g, "/").replace(/\/+$/, "");
    const rel = (a, b) => (a = norm(a), b = norm(b), a === b ? 1e9 : b.startsWith(a + "/") ? a.length : a.startsWith(b + "/") ? b.length : 0);
    let best = null, score = 0;
    for (const s of list) {
      const tabs = new Set(s.tabs.map((t) => t.id));
      for (const p of panes() ?? []) {
        if (!p.cwd || !tabs.has(p.tab)) continue;
        const v = rel(cwd, p.cwd);
        if (v > score) { score = v; best = s.id; }
      }
    }
    if (best) return best;
    return list.find((s) => s.folder && rel(cwd, s.folder) > 1)?.id ?? null;
  }

  refresh(cx) {
    if (this.counting) return;
    this.counting = true;
    cx.spawn(async (cx) => {
      try {
        const r = await exec("node", [`${appHome()}/mods/work/collect.cjs`], { timeout: 120000 });
        const n = Number(JSON.parse(r.stdout).attention);
        const next = Number.isFinite(n) ? n : 0;
        if (next !== this.attention) { this.attention = next; cx.notify(); }
      } catch {}
      finally { this.counting = false; }
    });
  }

  // 답을 기다리는 리더 수: 대기 라벨(decision|verify)이 붙은 에이전트 이름(기본 lead-*)의 터미널(UI 모드 요약 칸과 같은 규칙, inbox.cjs의 waitingKind). UI 모드 칸이 닫혀 있어도 터미널 라벨만 보므로 늘 맞다.
  // syncNames: the profile the desk published. With the "none" preset (#124) no name marks a leader, so any terminal carrying the wait label counts.
  inboxWaiting() { syncNames(); const any = NAMES.preset === "none"; return (terminals() ?? []).filter((t) => (any ? ["decision", "verify"].includes(labelOf(t, "labelWait").toLowerCase()) : waitingKind(t))).length; }

  // One tab per wheel notch. A touchpad or smooth-scrolling mouse sends many
  // small events per gesture: a short swipe or one smoothed notch (about
  // 25 px) switches one tab, a longer swipe keeps going a tab per 60 px, at
  // most one every 100 ms so each shows.
  wheel(e) {
    if (e.delta_lines) {
      if (e.delta_lines.y) run(e.delta_lines.y > 0 ? "tab.prev" : "tab.next");
      return;
    }
    const s = this.swipe, now = Date.now();
    // Phases often arrive only as moves (a macOS touchpad included): a pause
    // or a turn starts a new gesture.
    if (e.touch_phase === "started" || now - s.at > 250 || e.delta.y * s.acc < 0) Object.assign(s, { acc: 0, steps: 0 });
    s.at = now;
    s.acc += e.delta.y;
    const need = s.steps ? 60 : 20;
    if (Math.abs(s.acc) < need || now - s.last < 100) return;
    s.acc -= Math.sign(s.acc) * need;
    s.steps++;
    s.last = now;
    run(e.delta.y > 0 ? "tab.prev" : "tab.next");
  }

  // The side panel is remembered per space: switching shows that space's choice
  // (closed if it never had one), and opening or closing it records it.
  syncPanel(space, panel, body, enabled) {
    if (!space || !panel) return;
    const now = panel.hidden ? null : body?.active ?? null;
    if (space.id !== this.space) {
      const first = this.space === undefined;
      this.space = space.id; this.pending = null;
      if (!(first && !(space.id in this.panels))) {
        const stored = this.panels[space.id] ?? null, want = enabled.includes(stored) ? stored : null;
        if (want !== now) {
          this.pending = { want, until: Date.now() + 1000 };
          if (want) { run("layout.select", { stack: "panel-body", child: want }); run("layout.show", { id: "panel" }); }
          else run("layout.hide", { id: "panel" });
          return;
        }
      }
    }
    // Until the restore lands (or something else won), the old state isn't a choice.
    if (this.pending) {
      if (this.pending.want !== now && Date.now() < this.pending.until) return;
      this.pending = null;
    }
    if (this.panels[space.id] === now) return;
    this.panels[space.id] = now;
    localStorage.setItem("panels", JSON.stringify(this.panels));
  }

  render() {
    const t = theme();
    const space = spaces().find(p => p.active);
    const shown = space?.tabs ?? [];
    const active = shown.findIndex(tab => tab.active);
    const selected = shown[active]?.id;
    if (selected !== this.selected || active !== this.selectedIndex) {
      this.selected = selected;
      this.selectedIndex = active;
      if (active >= 0) this.scroll.scroll_to_item(active);
    }
    const stop = (_e, cx) => cx.stop_propagation();
    const button = (id, label, action) => div().id(id).size(26).flex_none().flex().items_center().justify_center().rounded(6).text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", stop).on_click(action).child(label);
    const item = (c, i) => {
      const lead = panes().find(p => p.tab === c.id && p.program?.agent) ?? panes().find(p => p.tab === c.id);
      const program = lead?.program;
      const name = label(c, lead);
      return h_flex().id(`tab-${c.id}`).h(29).px(10).gap(7).rounded(7).items_center().flex_none().text_size(12.8)
        // A rename or status dot on this or an earlier tab can push the active one out.
        .when(i <= active, el => el.on_size_change((_size, cx) => { this.scroll.scroll_to_item(active); cx.notify(); }))
        .border(1).border_color(c.active ? t.border : t.chrome).bg(c.active ? t.raised : t.chrome).text_color(c.active ? t.foreground : t.muted)
        .hover(s => s.bg(t.hover))
        .on_mouse_down("left", (e, cx) => { cx.stop_propagation(); this.pressed = i; if (e.click_count === 2) run("tab.rename", { id: c.id }); })
        .on_mouse_up("left", () => {
          const from = this.pressed; this.pressed = null;
          if (from !== null && from !== i) run("tab.move", { id: shown[from].id, index: space.tabs.findIndex(x => x.id === c.id) + 1 });
          else run("tab.select", { id: c.id });
        })
        .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); openOverlay({ mod: "menu", kind: "popup", width: 200, props: { tab: "tab", target: { id: c.id, space: space.id } } }); })
        .when(Boolean(program?.icon), el => el.child(program.tint ? svg(program.icon).size(14).text_color(t.muted) : image(program.icon).size(14)))
        .child(div().max_w(170).truncate().child(c.zoomed ? `${name} Z` : name))
        .when(c.status === "working", el => el.child(svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900)))
        .when(c.status === "blocked" || c.status === "done", el => el.child(div().size(6).rounded(3).bg(t[c.status])))
        .when(c.active, el => el.child(div().id(`close-${c.id}`).text_color(t.dim).on_mouse_down("left", stop).on_click((_e, cx) => { cx.stop_propagation(); run("tab.close", { id: c.id }); }).child(svg("mods/pane/close.svg").size(12))));
    };
    const root = layout(), sidebar = find(root, "sidebar"), w = window();
    // Old saved rails and a dragged-narrow sidebar can be smaller than the window buttons.
    const lightsPadding = w?.platform === "macos" && w.titlebar === "none" && !w.fullscreen && root?.traffic_lights
      ? Math.max(10, (root.traffic_lights[0] + 64) / settings().zoom - (sidebar?.hidden ? 0 : sidebar?.size?.px ?? 0))
      : 10;
    const panel = find(root, "panel"), body = find(root, "panel-body");
    // Another mod may set workspace.panels without our ids: always offer the panels this layout actually has,
    // and drop the ones it doesn't (the stock list names Files, which this layout replaced).
    const have = (body?.children ?? []).map(c => c.id);
    const listed = shared("workspace.panels") ?? ["files", "changes", "work-board", "pr-board", "schedules-board", "inbox-board", "memo-board"];
    const enabled = [...new Set([...listed.filter(id => !have.length || have.includes(id)), ...have])];
    this.syncPanel(space, panel, body, enabled);
    const panelButton = (id, label, icon, badge) => {
      const on = panel && !panel.hidden && body?.active === id;
      return h_flex().id(`panel-${id}`).h(26).px(8).gap(5).flex_none().items_center().rounded(6)
        .text_size(12).bg(on ? t.selected : t.chrome).text_color(on ? t.foreground : t.muted)
        .hover(s => s.bg(t.hover)).on_mouse_down("left", stop)
        .on_click(() => {
          if (on) run("layout.hide", { id: "panel" });
          else { run("layout.select", { stack: "panel-body", child: id }); run("layout.show", { id: "panel" }); }
        }).child(svg(icon).size(14)).child(label)
        .when(badge > 0, (el) => el.child(div().flex_none().min_w(16).h(16).px(4).rounded(8).bg(t.blocked).flex().items_center().justify_center().text_size(10.5).font_semibold().text_color("#ffffff")
          .tooltip("알림 수: PRs는 내 확인이 필요한 PR(내 PR 중 CI 실패·수정 요청, 내게 온 리뷰 요청), UI 모드는 답을 기다리는 리더").child(String(badge))));
    };
    return h_flex().size_full().min_w(0).px(10).pl(lightsPadding).gap(3).items_center().bg(t.chrome).border_b(1).border_color(t.border)
      .on_mouse_up("left", () => { this.pressed = null; })
      .on_scroll_wheel(e => this.wheel(e))
      .child(h_flex().id("tab-scroll").flex_1().min_w(0).h_full().items_center().gap(3).overflow_x_scrollbar().track_scroll(this.scroll)
        .on_size_change((_size, cx) => { if (active >= 0) { this.scroll.scroll_to_item(active); cx.notify(); } })
        .children(shown.map(item)))
      .child(button("tab-new", "+", () => openOverlay({ mod: "new-menu", kind: "popup", width: 250, height: 512 })))
      .when(enabled.includes("files"), el => el.child(panelButton("files", "Files", "mods/files/file.svg")))
      .when(enabled.includes("changes"), el => el.child(panelButton("changes", "Changes", "mods/changes/changes.svg")))
      .when(enabled.includes("work-board"), el => el.child(panelButton("work-board", "Work", "mods/workspace-chrome/layers.svg")))
      .when(enabled.includes("pr-board"), el => el.child(panelButton("pr-board", "PRs", "mods/workspace-chrome/git-compare.svg", this.attention)))
      .when(enabled.includes("schedules-board"), el => el.child(panelButton("schedules-board", "예약", "mods/workspace-chrome/clock.svg")))
      .when(enabled.includes("memo-board"), el => el.child(panelButton("memo-board", "메모", "mods/workspace-chrome/file-text.svg")))
      .when(enabled.includes("inbox-board"), el => el.child(panelButton("inbox-board", "UI 모드", "mods/workspace-chrome/archive.svg", this.inboxWaiting())))
      .child(h_flex().id("settings-open").h(26).px(8).gap(5).flex_none().items_center().rounded(6).text_size(12).bg(t.chrome).text_color(t.muted)
        .hover(s => s.bg(t.hover)).on_mouse_down("left", stop).tooltip("설정 창: GitHub 계정, 설치된 모드")
        .on_click(() => { try { openOverlay(settingsWindow(shared(SETTINGS_SHARED))); } catch {} }).child(svg("mods/workspace-chrome/settings.svg").size(14)).child("설정"))
      .when(Boolean(modeTarget()), el => el.child(h_flex().id("mode-switch").h(26).px(8).flex_none().items_center().rounded(6).text_size(12).bg(t.selected).text_color(t.foreground)
        .hover(s => s.bg(t.hover)).on_mouse_down("left", stop).on_click(() => { const m = modeTarget(); if (m) run("layout.switch", { name: m.name }); })
        .tooltip(modeTarget()?.ui ? "터미널 화면으로 돌아갑니다. 터미널은 꺼지지 않습니다" : "UI 모드를 전체 화면으로 씁니다. 터미널은 숨겨질 뿐 계속 돕니다")
        .child(modeTarget()?.ui ? "터미널 모드" : "전체 화면")))
      .when(w?.buttons, el => el.child(button("minimize", w.platform === "windows" ? svg("mods/tabs/win-min.svg").size(16) : "−", () => run("window.minimize")))
        .child(button("maximize", w.platform === "windows" ? svg(`mods/tabs/${w.maximized ? "win-restore" : "win-max"}.svg`).size(16) : "□", () => run("window.maximize")))
        .child(button("close-window", w.platform === "windows" ? svg("mods/tabs/win-close.svg").size(16) : svg("mods/pane/close.svg").size(13), () => run("window.close"))));
  }
}
