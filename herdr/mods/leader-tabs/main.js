// Pane header that turns a PO's leader pane into a tab strip. A copy of the app's `pane` header
// (icon, name, folder, status, split/zoom/close on hover) for every pane, except a pane whose own
// terminal is a leader (role=leader) while its PO has two or more live leaders: that pane's header
// lists the PO's live leaders as tabs, with split/zoom on hover but no close button. Clicking a tab shows that leader in this pane
// (`terminal.show {terminal, pane}`, or no terminal for the pane's own leader) and focuses it.
// The other leaders run without a pane; arrange in herdr-team.sh keeps one leader pane per PO.
// When the leader that owns that pane ends, Herdr closes the pane even while it shows another
// leader, and the strip goes with it. The PO pane's header checks every 2 seconds, notices (a leader
// that had a pane in the PO's tab is gone, no live leader of the PO has a pane there now) and runs
// `herdr-team.sh arrange` as the PO,
// which keeps one of the remaining leaders back with terminal.keep; without the script it keeps the
// first remaining leader to the PO's right itself. A seat lost while its leaders stay live for
// 10 seconds counts as the user's own park and is left alone.
// panes() has no "shown" field, so the shown leader comes from focused().shown while this pane has
// focus, and otherwise from the last choice saved per pane. pane.focus {pane} drops a pane's
// terminal.show (checked on Herdr 0.1.16; pane.go, tab/space switches and window refocus keep it),
// so this header focuses first and shows after, and shows the saved leader again if focus dropped it.
// Layout: { "tab": "active", "pane": { "header": { "content": { "mod": "leader-tabs" } } } }.

import { View, div, svg, image } from "gpui-kit";
import { h_flex } from "gpui-base";
import { panes, terminals, focused, props, run, theme, home, layout, exec, checking, shared } from "herdr";

const PANE_ICON = (name) => `mods/pane/${name}.svg`;
const roleOf = (t) => String(t?.labels?.role ?? "").trim().toLowerCase();
const ARRANGE = 'f="$HOME/.claude/skills/leader/herdr-team.sh"; [ -f "$f" ] || exit 127; HC_TERMINAL_ID="$1" exec sh "$f" arrange';
const HEAL_COOLDOWN = 30000;
const SETTLE = 10000;
const HEAL_CHECK = 2000;

// Match the first visible tab frame, including the active child of a stack.
function paneFrame(node) {
  if (!node || node.hidden) return null;
  if (node.content?.tab && node.content.pane) return node.content.pane;
  let children = node.children ?? [];
  if (node.type === "stack") {
    const visible = children.filter(child => !child.hidden);
    children = [visible.find(child => child.id === node.active) ?? visible[0]];
  }
  for (const child of children) {
    const frame = paneFrame(child);
    if (frame) return frame;
  }
  return null;
}

function icon(p, size, color) {
  if (!p?.icon) return null;
  return p.tint ? svg(p.icon).size(size).flex_none().text_color(color) : image(p.icon).w(size).h(size).flex_none();
}

function folder(cwd) {
  if (!cwd) return "";
  const h = home();
  return cwd === h ? "~" : cwd.startsWith(h + "/") ? "~" + cwd.slice(h.length) : cwd;
}

function statusMark(t, st) {
  if (st === "working") return svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900);
  if (st === "blocked") return div().size(7).flex_none().rounded(4).bg(t.blocked);
  if (st === "done") return div().size(7).flex_none().rounded(4).bg(t.done);
  return null;
}

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
const NAMES_KEY = "leader.names"; // written by the inbox / agent-groups; read-only here
const namesMemo = () => { try { return shared(NAMES_KEY) ?? {}; } catch { return {}; } };

// The tab's text is the leader's session name (the shared rule: live title without "리더 · ", the `session` label, the remembered name,
// then the hc name made readable) -- never the raw "lead-x".
function leaderLabel(term) {
  return leaderName(term.name, term, namesMemo());
}

export default class LeaderTabs extends View {
  init(_props, cx) {
    // Programs started from render() did not run on Herdr 0.1.16, so the heal check uses a timer.
    if (!checking()) cx.timer.every(HEAL_CHECK, () => this.reseat(this.me()));
    this.hovered = false;
    this.healed = {};
    this.lastSeat = {};
    this.lastHeal = {};
    this.lostAt = {};
    try { this.shown = JSON.parse(localStorage.getItem("shown") ?? "{}"); } catch { this.shown = {}; }
  }

  me() {
    return panes().find((p) => p.pane === props()?.pane);
  }

  remember(pane, terminal) {
    if ((this.shown[pane] ?? null) === (terminal ?? null)) return;
    if (terminal) this.shown[pane] = terminal; else delete this.shown[pane];
    try { localStorage.setItem("shown", JSON.stringify(this.shown)); } catch {}
  }

  // The PO's live leaders, when this pane's own terminal is one of two or more; otherwise null.
  leaders(p) {
    if (!p?.terminal) return null;
    const all = terminals();
    const own = all.find((t) => t.address === p.terminal);
    if (!own || roleOf(own) !== "leader" || !own.parent) return null;
    const po = all.find((t) => t.address === own.parent);
    if (!po || roleOf(po) !== "po") return null;
    const list = all.filter((t) => t.parent === po.address && t.state === "live" && roleOf(t) === "leader");
    return list.length >= 2 ? list : null;
  }

  // The saved leader for this pane, if it is still one of the listed leaders (not the pane's own).
  saved(p, list) {
    const saved = this.shown[p.pane];
    return saved && saved !== p.terminal && list.some((t) => t.address === saved) ? saved : null;
  }

  // Focus this pane, then show the chosen leader (focusing drops a shown terminal).
  focusAndShow(pane, leader) {
    run("pane.focus", { pane });
    if (leader) run("terminal.show", { terminal: leader, pane });
  }

  // The leader shown in this pane. While it has focus, focused().shown says so; if focus dropped
  // the saved leader, show it again (at most once a second, so a failing show can't loop).
  current(p, list) {
    const f = focused();
    let saved = this.saved(p, list);
    if (f?.pane === p.pane) {
      if (f.shown && f.shown !== p.terminal) {
        if (list.some((t) => t.address === f.shown)) this.remember(p.pane, f.shown);
        return f.shown;
      }
      if (saved && Date.now() - (this.healed[p.pane] ?? 0) > 1000) {
        this.healed[p.pane] = Date.now();
        run("terminal.show", { terminal: saved, pane: p.pane });
      }
    }
    if (!saved && this.shown[p.pane]) this.remember(p.pane, null);
    return saved ?? p.terminal;
  }

  // On a PO's own pane: if the leader pane closed because its owner ended, seat a remaining leader.
  reseat(p) {
    if (!p?.terminal || checking()) return;
    const all = terminals();
    const po = all.find((t) => t.address === p.terminal);
    if (!po || roleOf(po) !== "po") return;
    const live = all.filter((t) => t.parent === po.address && t.state === "live" && roleOf(t) === "leader");
    const ps = panes();
    const seated = live.filter((t) => ps.some((q) => q.terminal === t.address && q.tab === p.tab)).map((t) => t.address);
    const key = po.address;
    if (seated.length) { this.lastSeat[key] = seated; delete this.lostAt[key]; return; }
    const prev = this.lastSeat[key];
    if (!prev) return;
    // The pane closes a moment before its owner shows as ended, so wait a little for that.
    const now = Date.now();
    if (!this.lostAt[key]) this.lostAt[key] = now;
    if (!live.length || now - this.lostAt[key] > SETTLE) { delete this.lastSeat[key]; return; }
    if (prev.every((a) => live.some((t) => t.address === a))) return;
    if (now - (this.lastHeal[key] ?? 0) < HEAL_COOLDOWN) return;
    delete this.lastSeat[key];
    this.lastHeal[key] = now;
    const keep = () => {
      run("pane.focus", { pane: p.pane });
      run("terminal.keep", { terminal: live[0].address, place: "right" });
    };
    exec("sh", ["-c", ARRANGE, "sh", po.address], { timeout: 120000 })
      .then((r) => { if (r.code === 127) keep(); })
      .catch(keep);
  }

  button(t, id, name, command, args) {
    return div()
      .id(id)
      .p(3)
      .rounded(4)
      .text_color(t.dim)
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click((_e, cx) => {
        cx.stop_propagation();
        run(command, args);
      })
      .child(svg(PANE_ICON(name)).size(14));
  }

  tab(t, p, term, active) {
    const pane = p.pane;
    const mark = statusMark(t, term.status);
    return h_flex()
      .id(`lt-${pane}-${term.address}`)
      .flex_none()
      .max_w(220)
      .h(22)
      .px(8)
      .gap(6)
      .items_center()
      .rounded(5)
      .when(active, (el) => el.bg(t.hover).text_color(t.foreground).font_medium())
      .when(!active, (el) => el.text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground)))
      .on_click((_e, cx) => {
        cx.stop_propagation();
        const leader = term.address === p.terminal ? null : term.address;
        this.remember(pane, leader);
        this.focusAndShow(pane, leader);
        cx.notify();
      })
      .child(div().truncate().child(leaderLabel(term)))
      .when(Boolean(mark), (el) => el.child(mark));
  }

  header(t, p, onClick) {
    const bottom = paneFrame(layout())?.header?.position === "bottom";
    return h_flex()
      .id(`pane-head-${p.pane}`)
      .size_full()
      .px(10)
      .gap(8)
      .items_center()
      .bg(t.background)
      .when(bottom, el => el.border_t(1))
      .when(!bottom, el => el.border_b(1))
      .border_color(t.border)
      .text_size(12)
      .on_hover((hovered, cx) => { this.hovered = hovered; cx.notify(); })
      .on_click(onClick ?? (() => run("pane.focus", { pane: p.pane })));
  }

  // closable is false on the tab strip: pane.close ends the pane's own leader, which may be hidden
  // behind the shown one. Leaders end through the PO's `herdr-team.sh close --name lead-*`.
  hoverButtons(el, t, p, closable = true) {
    const pane = p.pane;
    return el.when(this.hovered, el => el
      .child(this.button(t, `ph-r-${pane}`, "split-right", "pane.split", { direction: "right", pane }))
      .child(this.button(t, `ph-d-${pane}`, "split-down", "pane.split", { direction: "down", pane }))
      .child(this.button(t, `ph-z-${pane}`, p.zoomed ? "unzoom" : "zoom", "pane.zoom", { pane }))
      .when(closable, el => el.child(this.button(t, `ph-x-${pane}`, "close", "pane.close", { pane }))));
  }

  render(cx) {
    const t = theme();
    const p = this.me();
    if (!p) return div();
    const list = this.leaders(p);
    if (list) {
      const active = this.current(p, list);
      const strip = h_flex().id(`lt-strip-${p.pane}`).flex_1().min_w(0).gap(2).items_center().overflow_x_scroll()
        .children(list.map((term) => this.tab(t, p, term, term.address === active)));
      const refocus = () => this.focusAndShow(p.pane, this.saved(p, list));
      return this.hoverButtons(this.header(t, p, refocus).px(6).gap(4).child(strip), t, p, false);
    }
    const name = ((p.program?.agent || p.program?.shell) && p.program.name) || p.title || p.program?.name || "shell";
    const pic = icon(p.program, 14, t.dim);
    const st = p.status;
    return this.hoverButtons(this.header(t, p)
      .when(Boolean(pic), (el) => el.child(pic))
      .child(div().flex_none().truncate().max_w(260).font_medium().text_color(t.foreground).child(name))
      .child(div().flex_1().truncate().text_color(t.dim).child(folder(p.cwd)))
      .when(st === "working", el => el.child(svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900)))
      .when(st === "blocked", el => el.child(div().flex_none().px(6).h(18).flex().items_center().rounded(5).bg(t.blocked + "26").text_size(10.5).font_semibold().text_color(t.blocked).child("Needs you")))
      .when(st === "done", el => el.child(div().size(7).flex_none().rounded(4).bg(t.done))), t, p);
  }
}
