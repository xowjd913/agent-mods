// Clone of Herdr's shipped `tabs` mod. The PRs button shows a count of PRs needing my action (collect.cjs `attention`: my open PRs with failing CI or changes requested, plus open PRs asking me to review). The layout blocks are "work-board" (mod work) and "pr-board" (mod prs); the id "work" is already a layout column. Changed: the right-panel buttons are Files, Changes, then Work and PRs (added after the stock ones).
import { View, div, svg, image } from "gpui-kit";
import { h_flex, ScrollHandle } from "gpui-base";
import { spaces, panes, terminals, focused, run, notify, openOverlay, theme, window, shared, layout, settings, exec, appHome, checking, layouts, nextCommand } from "herdr";

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

// Which terminal is a waiting leader. Copied verbatim from inbox/inbox.cjs (a test keeps them identical).
const waitingKind = (t) => (/^lead-/.test(String(t?.name ?? "")) ? (["decision", "verify"].find((k) => k === String(t.labels?.wait ?? "").trim().toLowerCase()) ?? "") : "");

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
  init(_props, cx) {
    this.attention = 0;
    if (!checking()) {
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
      cx.spawn(async () => { for (;;) { const c = String(await nextCommand()); if (c === "mode") { const m = modeTarget(); if (m) run("layout.switch", { name: m.name }); } } });
    }
    this.pressed = null;
    this.scroll = ScrollHandle.new();
    try { this.panels = JSON.parse(localStorage.getItem("panels") ?? "{}"); } catch { this.panels = {}; }
    if (!this.panels || typeof this.panels !== "object" || Array.isArray(this.panels)) this.panels = {};
    this.swipe = { acc: 0, steps: 0, at: 0, last: 0 };
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
      this.adopting.set(t.address, { at: Date.now(), target, moved, prev: prev ? { space: prev.space, tab: prev.tab } : null, name: String(t.labels?.session ?? "").trim() || null });
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

  // 답을 기다리는 리더 수: 대기 라벨(decision|verify)이 붙은 lead-* 터미널(PO 데스크 요약 칸과 같은 규칙, inbox.cjs의 waitingKind). PO 데스크 칸이 닫혀 있어도 터미널 라벨만 보므로 늘 맞다.
  inboxWaiting() { return (terminals() ?? []).filter((t) => waitingKind(t)).length; }

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
    const listed = shared("workspace.panels") ?? ["files", "changes", "work-board", "pr-board", "schedules-board", "accounts-board", "inbox-board"];
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
          .tooltip("알림 수: PRs는 내 확인이 필요한 PR(내 PR 중 CI 실패·수정 요청, 내게 온 리뷰 요청), PO 데스크는 답을 기다리는 리더").child(String(badge))));
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
      .when(enabled.includes("accounts-board"), el => el.child(panelButton("accounts-board", "계정", "mods/workspace-chrome/git-branch.svg")))
      .when(enabled.includes("inbox-board"), el => el.child(panelButton("inbox-board", "PO 데스크", "mods/workspace-chrome/archive.svg", this.inboxWaiting())))
      .when(Boolean(modeTarget()), el => el.child(h_flex().id("mode-switch").h(26).px(8).flex_none().items_center().rounded(6).text_size(12).bg(t.selected).text_color(t.foreground)
        .hover(s => s.bg(t.hover)).on_mouse_down("left", stop).on_click(() => { const m = modeTarget(); if (m) run("layout.switch", { name: m.name }); })
        .tooltip(modeTarget()?.ui ? "터미널 화면으로 돌아갑니다. 터미널은 꺼지지 않습니다" : "PO 데스크를 메인 화면으로 씁니다. 터미널은 숨겨질 뿐 계속 돕니다")
        .child(modeTarget()?.ui ? "터미널 모드" : "UI 모드")))
      .when(w?.buttons, el => el.child(button("minimize", w.platform === "windows" ? svg("mods/tabs/win-min.svg").size(16) : "−", () => run("window.minimize")))
        .child(button("maximize", w.platform === "windows" ? svg(`mods/tabs/${w.maximized ? "win-restore" : "win-max"}.svg`).size(16) : "□", () => run("window.maximize")))
        .child(button("close-window", w.platform === "windows" ? svg("mods/tabs/win-close.svg").size(16) : svg("mods/pane/close.svg").size(13), () => run("window.close"))));
  }
}
