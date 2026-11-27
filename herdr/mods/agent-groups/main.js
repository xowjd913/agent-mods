// Agents in grouped or priority views; parents take their most urgent sub-agent's place.
// Cloned from Herdr's shipped `agents` mod. Added: the "tasks" view, which keeps each
// space's leaders on top, one section per leader: a header, the leader and its team members (found
// through the hc parent chain, not the issue number in their name). Only members whose chain reaches
// no leader are grouped by the issue number in their hc name (dev-271-..., review-271-...), else by
// their lone tab's "리뷰 · #271 ..." name; "#271 <task>" is taken from the dev tab's name.
// Team members start without a tab or pane, so agents() doesn't list them: the task view builds an
// agent-like entry for each from terminals() (name, parent, state, status and the `session` label that
// `herdr-team.sh spawn` sets to the Korean session name). Clicking such a row peeks at the terminal.

import { View, div, image, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { agents, terminals, panes, focused, spaces, run, theme, shared, setShared, setAgentOrder, openOverlay, closeOverlay, props, window, layout } from "herdr";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// The sidebar's rail goes by its width, not a flag: dragging its edge narrows it too.
const narrow = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;

// To the rail (on macOS wide enough for the traffic lights), or back to the width it had.
function toggleSidebar() {
  const width = find(layout(), "sidebar")?.size?.px;
  if (!narrow()) setShared("sidebar.width", width);
  // Mods edited before the rail went by width still read the flag.
  setShared("sidebar.collapsed", !narrow());
  run("layout.resize", { id: "sidebar", px: narrow() ? (shared("sidebar.width") ?? 268) : window()?.platform === "macos" ? 76 : 44 });
}

// Drops what an agent puts before its title: a status glyph or spinner and the separator
// after it ("✦  Working", "⠋ - Thinking"), and Codex's blinking "[ ! ] " / "[ . ] " mark.
// Stops at an opening bracket or quote, so a title that starts with one ("[web] login") keeps it.
const clean = (s) => (s ?? "").replace(/^[^\p{L}\p{N}\p{Ps}\p{Pi}]+/u, "").replace(/^\[ [!.] \] /, "").trim();

function leadPanes(all) {
  const leads = new Map();
  for (const p of all) {
    if (!p.terminal) continue;
    const current = leads.get(p.tab);
    // First agent, else first focused terminal, else first terminal in the tab.
    if (!current || (!current.program?.agent && (p.program?.agent || (!current.focused && p.focused)))) leads.set(p.tab, p);
  }
  return leads;
}

function title(tab, l) {
  const prog = l?.program?.name;
  const live = clean(l?.title);
  // clean() would strip a path's leading ~ or /: test the title with only its status glyph gone.
  const path = /^[~/]|^[A-Za-z]:\\/.test((l?.title ?? "").replace(/^[^\p{L}\p{N}~/]+/u, ""));
  const telling = live && live !== (l?.terminal ?? l?.address) && live !== prog && !path && !live.includes("@") && live.toLowerCase() !== l?.program?.key;
  return (tab.name === prog || !tab.named) && telling ? live : tab.name;
}
const RANK = { blocked: 4, done: 3, working: 2, idle: 1 };
// A sub-agent without a pane isn't in agents(): its raw word, error counting as
// blocked. It's never done: it reports to its parent, and the parent's done is the news.
const kidStatus = (k, listed) => {
  const s = listed.get(k.address) ?? k.status;
  return s === "error" ? "blocked" : s === "done" ? "idle" : s;
};
const SORTS = [
  { id: "tasks", label: "작업별 묶음", icon: "layers" },
  { id: "priority", label: "Priority", icon: "clock" },
  { id: "grouped", label: "Grouped by space", icon: "layers" },
];
// Its own key, so the shipped agents mod's choice doesn't leak in; the task view is the default.
const SORT_KEY = "agent-groups.sort";
const sortOf = () => SORTS.find((s) => s.id === shared(SORT_KEY)) ?? SORTS[0];

// hc names are <role>-<issue>[-<english summary>]; older ones are just dev-269 / review-269.
const MEMBER = /^(dev|review|integration)-(\d+)(?:-(.*))?$/;
// A name that breaks the convention (e.g. rev-302-...) falls back to the tab name "<개발|리뷰|통합>[(Opus 상향)][(교체 N)] · #<issue> ...".
const TAB_MEMBER = /^(개발|리뷰|통합)(?:\([^)]*\))*\s*·\s*#(\d+)(?:\s+(.*))?$/;
const TAB_ROLE = { 개발: "dev", 리뷰: "review", 통합: "integration" };
// With the "none" preset (#124) no naming rule applies: any terminal that has a parent (hc spawn) is a member, grouped under its nearest ancestor
// that has children, with no issue number (issue ""). `term` is the terminal; it is only read for that preset.
function memberOf(name, tabName, term) {
  if (NAMES.preset === "none") return term?.parent ? { role: "dev", issue: "", summary: "" } : null;
  const m = MEMBER.exec(name ?? "");
  if (m) return { role: m[1], issue: m[2], summary: m[3] ?? "" };
  const t = TAB_MEMBER.exec(tabName ?? "");
  return t ? { role: TAB_ROLE[t[1]], issue: t[2], summary: "" } : null;
}
const ROLE_ORDER = { dev: 0, review: 1, integration: 2 };
const OTHER = "기타";
// 예약(schedules 모드)이 띄운 세션은 label schedule=<id>를 달고 부모 없이 뜬다. 작업 보기에서 공간 안에 "예약" 묶음으로 모은다.
const SCHEDULE = "schedule";
const SCHEDULED = "예약";
// The label `herdr-team.sh spawn` puts on a team member is its Korean session name ("개발 · #351 ..."); its label name comes from the profile (labelSession).
// A PO terminal's tab name starts with the hub name in capitals as a word ("PO · repo"), so "POLICY" doesn't count. Both come from the profile.
const poTab = (name) => { const w = String(NAMES.hubRole ?? "").toUpperCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); return Boolean(w) && new RegExp(`^${w}(?:\\s|·|$)`).test(name ?? ""); };
// A leader's tab starts with the first word of the profile's title prefix ("리더").
const leaderTab = (name) => { const w = String(NAMES.titlePrefixText ?? "").trim().split(/\s+/)[0]; return Boolean(w) && String(name ?? "").startsWith(w); };
// Role label (its name and values come from the profile, default `role` = po / leader): the PO start flow sets the hub value on its own terminal and
// `spawn --leader` sets the agent value. It is read first; the tab-name rules below apply only to a terminal without it.
const NAMES_KEY = "leader.names"; // {<hc name>: session name}, shared with the inbox
const namesMemo = () => { try { return shared(NAMES_KEY) ?? {}; } catch { return {}; } };
const roleOf = (t) => labelOf(t, "labelRole").toLowerCase();
const SECTION = { 4: "Needs you", 3: "Done", 2: "Working", 1: "Idle" };
const SECTION_STATUS = { 4: "blocked", 3: "done", 2: "working" };

function duration(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 1) return "<1m";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

// The agent's icon from the app's program table: a one-color glyph or a picture.
function icon(p, size, color) {
  if (!p?.icon) return null;
  return p.tint ? svg(p.icon).size(size).flex_none().text_color(color) : image(p.icon).w(size).h(size).flex_none();
}

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

// A leader terminal by its role label, else (no label) its agent name (default lead-*).
const isLeader = (t) => isAgentTerm(t) || (!roleOf(t) && isAgentName(t?.name));
// Team members and parked leaders run without a tab or pane, so agents() never lists them. Give each
// live one an agent-like entry (no pane) in the space of the nearest ancestor that is listed (the PO
// or leader above it), so taskPlan can place it. The name comes from the `session` label, else the hc name.
// `listed` maps each listed address to its status.
export function paneless(real, all, listed = new Map(), memo = {}) {
  const byAddr = new Map(real.map((a) => [a.address, a]));
  const term = new Map(all.map((x) => [x.address, x]));
  const seat = (t) => {
    let p = t.parent;
    for (let i = 0; p && i < 8; i++) {
      const a = byAddr.get(p);
      if (a) return a;
      p = term.get(p)?.parent;
    }
    return null;
  };
  const out = [];
  all.forEach((t, i) => {
    if (t.state !== "live" || byAddr.has(t.address)) return;
    const session = String(t.labels?.[NAMES.labelSession] ?? "").trim();
    const leader = isLeader(t);
    if (!leader && !memberOf(t.name, session, t)) return;
    const home = seat(t);
    if (!home) return;
    // A leader's row reads like a real leader's: the full `session` label ("리더 · ..."), else "리더 · " + the
    // hc name without "lead-". Its tab name stays empty so taskPlan builds the section header itself.
    const title = leader ? `${NAMES.titlePrefixText}${leaderName(t.name, t, memo)}` : session;
    out.push({
      address: t.address,
      pane: null,
      ghost: true,
      status: kidStatus(t, listed),
      program: t.program,
      space: home.space,
      space_name: home.space_name,
      tab: null,
      tab_name: leader ? "" : session,
      title: title || t.name || t.address,
      seq: i,
      pinned: false,
      focused: false,
    });
  });
  return out;
}

// The task view's plan: for each space (in list order) one section per leader (the leader and the
// team members whose parent chain reaches it), under its PO when the leader's parent chain reaches
// one. Members with no leader in their chain stay in issue-number groups (`loose`), then `others`.
// `order` is the on-screen order. Pure: reads only the snapshot (agents, terminals, tab names).
export function taskPlan(agentList, all, tabNames = new Map(), memo = {}) {
  const term = new Map(all.map((x) => [x.address, x]));
  const parents = new Set(all.filter((x) => x.state === "live" && x.parent).map((x) => x.parent));
  // Nearest ancestor (up to 8 steps) that is in `set`.
  const ancestorIn = (addr, set) => {
    let p = term.get(addr)?.parent;
    for (let i = 0; p && i < 8; i++) {
      if (set.has(p)) return p;
      p = term.get(p)?.parent;
    }
    return null;
  };
  const bySpace = new Map();
  for (const a of agentList) {
    if (!bySpace.has(a.space)) bySpace.set(a.space, []);
    bySpace.get(a.space).push(a);
  }
  const plan = [];
  for (const [space, members] of bySpace) {
    const leaders = [];
    const others = [];
    const scheduled = [];
    const pos = [];
    const team = [];
    for (const a of members) {
      const t = term.get(a.address);
      const m = memberOf(t?.name, tabNames.get(a.address), t);
      if (t?.labels?.[SCHEDULE]) scheduled.push(a);
      // A labelled terminal is classified by its label, never by the tab it sits in; then the lead- name;
      // only then the team-member name and the tab name / "has child terminals".
      else if (isHubTerm(t)) pos.push(a);
      else if (isLeader(t)) leaders.push(a);
      else if (m) team.push({ a, ...m });
      else if (poTab(a.tab_name)) pos.push(a);
      else if (parents.has(a.address) || leaderTab(a.tab_name)) leaders.push(a);
      else others.push(a);
    }
    const leaderSet = new Set(leaders.map((a) => a.address));
    const byLeader = new Map(leaders.map((a) => [a.address, []]));
    const orphans = [];
    for (const x of team) {
      const owner = ancestorIn(x.a.address, leaderSet);
      (owner ? byLeader.get(owner) : orphans).push(x);
    }
    const byRole = (x, y) => ROLE_ORDER[x.role] - ROLE_ORDER[y.role] || x.a.seq - y.a.seq;
    // Header title: the leader's tab name (not just a number, not the PO's own tab), else its session name
    // (leaderName: live title, `session` label, remembered name, hc name).
    const titleOf = (leader) => {
      const t = term.get(leader.address);
      const po = pos.find((p) => p.tab === leader.tab);
      const tab = String(leader.tab_name ?? "").trim();
      if (tab && !/^\d+$/.test(tab) && !po) return tab;
      return leaderName(t?.name, t, memo);
    };
    const sectionOf = (leader) => ({ leader, title: titleOf(leader), members: byLeader.get(leader.address).sort(byRole).map((x) => x.a) });
    const sections = leaders.map(sectionOf);
    const poSet = new Set(pos.map((a) => a.address));
    const poOf = (s) => ancestorIn(s.leader.address, poSet);
    const poTiers = pos.map((po) => ({ po, sections: sections.filter((s) => poOf(s) === po.address) }));
    const top = sections.filter((s) => !poOf(s));
    // Members with no leader: one group per issue number (ascending), as before.
    const issues = new Map();
    for (const x of orphans) {
      if (!x.issue) { others.push(x.a); continue; } // no issue number (the "none" preset): there is no group to name, so it is just another agent
      if (!issues.has(x.issue)) issues.set(x.issue, []);
      issues.get(x.issue).push(x);
    }
    const loose = [...issues.entries()]
      .sort((x, y) => Number(x[0]) - Number(y[0]))
      .map(([issue, items]) => {
        items.sort(byRole);
        // "#271 <task>" comes from the dev tab's name ("개발 · #271 <task>"), else any member's tab.
        const re = new RegExp(`#${issue}\\s+(\\S.*)$`);
        const named = items.map((x) => re.exec(x.a.tab_name ?? "")).find(Boolean);
        const fallback = items.find((x) => x.summary)?.summary.replace(/-/g, " ");
        const task = named?.[1].trim() ?? fallback;
        return { issue, title: task ? `#${issue} ${task}` : `#${issue}`, members: items.map((x) => x.a) };
      });
    const inSection = (s) => [s.leader, ...s.members];
    plan.push({
      space,
      label: members[0].space_name || "",
      members,
      leaders,
      poTiers,
      sections: top,
      loose,
      others,
      scheduled,
      order: [...poTiers.flatMap((p) => [p.po, ...p.sections.flatMap(inSection)]), ...top.flatMap(inSection), ...loose.flatMap((g) => g.members), ...others, ...scheduled],
    });
  }
  return plan;
}

export default class Agents extends View {
  init(_props, cx) {
    if (props()?.sortMenu) return;
    this.folded = new Set();
    // Paneless team members the task view builds entries for (address -> entry), refreshed on each render.
    this.ghosts = new Map();
    // Each agent's last state and when it changed (ms), kept across restarts.
    try { this.changed = JSON.parse(localStorage.getItem("changed") ?? "{}"); } catch { this.changed = {}; }
    if (!this.changed || typeof this.changed !== "object" || Array.isArray(this.changed)) this.changed = {};
    try { this.pendingPins = JSON.parse(localStorage.getItem("pins") ?? "[]"); } catch { this.pendingPins = []; }
    if (!Array.isArray(this.pendingPins)) this.pendingPins = [];
    if (!this.pendingPins.length) localStorage.removeItem("pins");
    this.migratingPins = new Set();
    cx.timer.every(30000, (cx) => cx.notify());
  }

  // Stamps agents whose state changed. Done and idle count as one: looking at a
  // finished agent turns done into idle, and looking isn't the agent doing anything.
  track(list, now) {
    let dirty = false;
    for (const a of list) {
      const s = a.status === "done" ? "idle" : a.status;
      if (this.changed[a.address]?.s === s) continue;
      this.changed[a.address] = { s, at: now };
      dirty = true;
    }
    if (!dirty) return;
    // Gone and old: the list alone is empty right after a start.
    const listed = new Set(list.map((a) => a.address));
    for (const [k, c] of Object.entries(this.changed)) if (!listed.has(k) && now - c.at > 30 * 86400000) delete this.changed[k];
    localStorage.setItem("changed", JSON.stringify(this.changed));
  }

  // Remember the live leaders' session names so a closed leader keeps a readable name (shared with the inbox).
  rememberLeaders(all) {
    try {
      const next = rememberNames(namesMemo(), all);
      if (next) setShared(NAMES_KEY, next);
    } catch {}
  }

  // Keep offline pins until their terminal returns, and keep each pending until
  // core echoes the label so a failed write doesn't erase the old pin.
  migratePins(all) {
    const listed = new Map(all.filter((t) => t.state === "live").map((t) => [t.address, t]));
    const pending = this.pendingPins.filter((address) => {
      const terminal = listed.get(address);
      if (!terminal) return true;
      if (terminal.labels?.["herdr.pinned"]) return false;
      if (!this.migratingPins.has(address)) {
        this.migratingPins.add(address);
        run("terminal.pin", { terminal: address, pinned: true });
      }
      return true;
    });
    if (pending.length === this.pendingPins.length) return;
    this.pendingPins = pending;
    if (pending.length) localStorage.setItem("pins", JSON.stringify(pending));
    else localStorage.removeItem("pins");
  }

  since(a) {
    return this.changed[a.address]?.at ?? 0;
  }

  rank(a) {
    return RANK[a.status] ?? 0;
  }

  sortMenu(t) {
    const on = sortOf().id;
    return v_flex()
      .w_full()
      .p(5)
      .bg(t.popover)
      .text_size(12.8)
      .child(div().px(8).pt(4).pb(6).text_size(11).text_color(t.dim).child("Sort agents"))
      .children(SORTS.map((s) => h_flex()
        .id(`sort-${s.id}`)
        .h(31)
        .px(8)
        .gap(9)
        .rounded(7)
        .items_center()
        .text_color(t.foreground)
        .hover((el) => el.bg(t.hover))
        .on_click(() => {
          setShared(SORT_KEY, s.id);
          closeOverlay(props().overlay);
        })
        .child(svg(`mods/workspace-chrome/${s.icon}.svg`).size(14).flex_none().text_color(t.muted))
        .child(div().flex_1().child(s.label))
        .when(s.id === on, (el) => el.child(svg("mods/workspace-chrome/check.svg").size(14).flex_none().text_color(t.foreground)))));
  }

  peek(addr) {
    run("terminal.peek", { terminal: addr });
  }

  // Live sub-agents of `addr`, depth first, each with the tree lines in front of it.
  tree(all, addr, lead = []) {
    // In the task view the leader's listed team members sit in their own groups, not under the leader.
    // A paneless member has an entry of its own (this.ghosts) and a group row too. Any other one not in
    // agents() (no pane, no status report) has no group row, so it stays a sub-row.
    const kids = all.filter((k) => k.parent === addr && k.state === "live" && !(this.tasks && (this.listed.has(k.address) || this.ghosts.has(k.address)) && (memberOf(k.name, this.tabNames.get(k.address), k) || isLeader(k))));
    return kids.flatMap((k, i) => {
      const last = i === kids.length - 1;
      return [
        { t: k, lines: [...lead, last ? "└" : "├"] },
        ...this.tree(all, k.address, [...lead, last ? "" : "│"]),
      ];
    });
  }

  subRow(t, s, shown, compact, indent = 0) {
    const k = s.t;
    const st = kidStatus(k, this.listed);
    const pic = icon(k.program, 14, t.foreground);
    const on = k.address === shown;
    return h_flex()
      .id(`sub-${k.address}`)
      .pl(39 + indent)
      .pr(8)
      .rounded(8)
      .h(26)
      .flex_none()
      .gap(0)
      .items_center()
      .text_size(12.5)
      .when(on, (el) => el.bg(t.raised))
      .hover((s) => s.bg(t.hover))
      .on_click(() => (this.listed.has(k.address) ? run("pane.focus", { terminal: k.address }) : this.peek(k.address)))
      .children(s.lines.map(l => div().self_start().mt(-4).w(9).h(17).mr(4).flex_none()
        .when(Boolean(l), el => el.border_l(1.5).border_color(t.input))
        .when(l === "└" || l === "├", el => el.border_b(1.5).rounded_bl(6))))
      .when(Boolean(pic), el => el.child(div().mr(8).child(pic)))
      .child(div().flex_1().truncate().text_color(on ? t.foreground : t.muted).child(this.kidLabel?.(k) || k.name || k.template || k.program?.name || k.address))
      .child(this.status(t, { status: st }, compact));
  }

  paneless(real, all) {
    return paneless(real, all, this.listed, namesMemo());
  }

  taskPlan(agentList, all) {
    return taskPlan(agentList, all, this.tabNames, namesMemo());
  }

  // compact: a ! for blocked where a header already says "Needs you".
  status(t, a, compact = false) {
    const color = t[a.status] ?? t.dim;
    if (a.status === "working") return svg("mods/workspace-chrome/spinner.svg").size(12).mx(1).flex_none().text_color(t.working).spin(900);
    if (a.status === "blocked" && compact) return div().size(14).flex_none().rounded(4).bg(t.blocked + "26").text_size(10.5).font_bold().text_color(t.blocked).flex().items_center().justify_center().child("!");
    if (a.status === "blocked") return div().flex_none().px(6).h(18).rounded(5).bg(t.blocked + "26").text_size(10.5).font_semibold().text_color(t.blocked).flex().items_center().child("Needs you");
    // Idle: a ring; done: a dot.
    if (a.status === "idle") return div().size(7).mx(3).flex_none().rounded(4).border(1.5).border_color(t.idle ?? t.dim);
    return div().size(7).mx(3).flex_none().rounded(4).bg(a.status === "done" ? color : t.dim + "00");
  }

  render(cx) {
    const t = theme();
    syncNames(); // the profile the desk published
    if (props()?.sortMenu) return this.sortMenu(t);
    const collapsed = narrow();
    const sort = sortOf();
    this.tasks = sort.id === "tasks";
    let list = agents();
    const everyone = list;
    this.listed = new Map(list.map((a) => [a.address, a.status]));
    // Tab-name fallback only for an agent alone in its tab: a tab name says nothing about a split-pane neighbour.
    const tabSize = new Map();
    for (const a of everyone) tabSize.set(a.tab, (tabSize.get(a.tab) ?? 0) + 1);
    this.tabNames = new Map(list.filter((a) => tabSize.get(a.tab) === 1).map((a) => [a.address, a.tab_name]));
    const all = terminals();
    // Paneless team members, only where the task view groups them; the other views keep them as sub-rows.
    const ghosts = this.tasks ? this.paneless(everyone, all) : [];
    this.ghosts = new Map(ghosts.map((g) => [g.address, g]));
    for (const g of ghosts) this.tabNames.set(g.address, g.tab_name);
    this.migratePins(all);
    this.rememberLeaders(all);
    const shown = focused()?.agent;
    const now = Date.now();
    this.track([...list, ...ghosts], now);
    // A kept sub-agent (one with a pane) is in agents() too: where a tree shows
    // it, it gets no row of its own, unless it's pinned.
    const nested = new Set(collapsed ? [] : list.flatMap((a) => this.tree(all, a.address).map((s) => s.t.address)));
    list = list.filter((a) => a.pinned || !nested.has(a.address));
    const tabCounts = new Map();
    for (const a of list) tabCounts.set(a.tab, (tabCounts.get(a.tab) ?? 0) + 1);
    const byPriority = sort.id === "priority";
    const urgency = new Map(list.map((a) => [a.address, Math.max(this.rank(a), ...this.tree(all, a.address).map((s) => RANK[kidStatus(s.t, this.listed)] ?? 0))]));
    const rankOf = (a) => urgency.get(a.address);
    if (byPriority) list = [...list].sort((x, y) => rankOf(y) - rankOf(x) || this.since(y) - this.since(x) || y.seq - x.seq);
    const pinned = list.filter((a) => a.pinned);
    const rest = list.filter((a) => !a.pinned);
    list = [...pinned, ...rest];

    // Task view: per space, the leader(s) first, then one group per issue number, then the rest.
    // Everything is decided from names and parents already in the snapshot: no commands run.
    const plan = this.tasks ? this.taskPlan([...rest, ...ghosts], all) : null;
    if (plan) list = [...pinned, ...plan.flatMap((sp) => sp.order)];
    // The order is for pane navigation: a paneless member has no pane to go to.
    setAgentOrder(list.filter((a) => !a.ghost).map((a) => a.address));

    const withKids = (a, i, indent = 0) => {
      const subs = collapsed ? [] : this.tree(all, a.address);
      const r = row(a, i, subs, indent);
      if (this.folded.has(a.address)) return [r];
      return [r, ...subs.map((s) => this.subRow(t, s, shown, byPriority, indent))];
    };

    // The fold chevron; folded, the count too, colored by the most urgent one.
    const fold = (a, subs) => {
      const sts = subs.map((s) => kidStatus(s.t, this.listed));
      const top = sts.reduce((m, s) => ((RANK[s] ?? 0) > (RANK[m] ?? 0) ? s : m), null);
      const open = !this.folded.has(a.address);
      return div()
        .id(`fold-${a.address}`)
        .h(18)
        .px(3)
        .gap(3)
        .flex()
        .items_center()
        .rounded(4)
        .text_size(11)
        .text_color(open ? t.dim : (t[top] ?? t.dim))
        .cursor_pointer()
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_click((_e, cx) => {
          cx.stop_propagation();
          open ? this.folded.add(a.address) : this.folded.delete(a.address);
          cx.notify();
        })
        .child(svg(`mods/workspace-chrome/chevron-${open ? "down" : "right"}.svg`).size(11).flex_none())
        .when(!open, (el) => el.child(String(subs.length)));
    };

    // A row reads "space \u00b7 detail": the detail is a tab someone named or the
    // agent's own title, never an automatic tab number unless two rows would
    // otherwise read the same.
    // Read the pane snapshot once: every host read copies the whole list into JS.
    const leads = leadPanes(panes());
    const tabs = new Map(spaces().flatMap(s => s.tabs).map(tab => [tab.id, tab]));
    // A sub-agent row reads like a top-level one: the tab someone named (its own tab, alone in
    // it), else its hc name. A child sharing a tab with others keeps the name: the tab isn't its.
    const everyCounts = new Map();
    for (const a of everyone) everyCounts.set(a.tab, (everyCounts.get(a.tab) ?? 0) + 1);
    const byAddress = new Map(everyone.map((a) => [a.address, a]));
    this.kidLabel = (k) => {
      const a = byAddress.get(k.address);
      const tab = a && tabs.get(a.tab);
      if (!tab || !tab.named || everyCounts.get(a.tab) !== 1) return null;
      const name = title(tab, leads.get(a.tab));
      return name && !/^\d+$/.test(name) ? name : null;
    };
    const termByAddress = new Map(all.map((x) => [x.address, x]));
    const labels = new Map(list.map(a => {
      const tab = tabs.get(a.tab);
      const many = tabCounts.get(a.tab) > 1;
      // A PO row keeps the PO tab's name even when a leader shares the tab; the PO's own session title is not used.
      const poRow = isHubTerm(termByAddress.get(a.address)) && tab?.named;
      return [a.address, poRow ? tab.name : tab ? title(many ? { ...tab, named: false } : tab, many ? a : leads.get(a.tab)) : (a.title || a.program?.name || "")];
    }));
    const label = (a) => labels.get(a.address);
    const detail = new Map(list.map(a => [a.address, /^\d+$/.test(label(a)) ? null : label(a)]));
    const seen = {};
    for (const a of list) { const k = `${a.space_name}\u0000${detail.get(a.address) ?? ""}`; seen[k] = (seen[k] ?? 0) + 1; }
    for (const a of list) {
      if (detail.get(a.address) == null && seen[`${a.space_name}\u0000`] > 1) detail.set(a.address, label(a));
    }

    // A row with a pane focuses it; a paneless team member shows its terminal in a peek.
    const open = (a) => (a.ghost ? this.peek(a.address) : run("pane.focus", { pane: a.pane }));
    const row = (a, i, subs = [], indent = 0) => {
      const pic = icon(a.program, 16, t.foreground);
      const more = detail.get(a.address);
      // An agent on another machine (`vps/t7`) says which.
      const machine = a.address.includes("/") ? a.address.split("/")[0] : null;
      if (collapsed) {
        return h_flex()
          .id(`ag-${a.address}`)
          .h(26)
          .px(8)
          .flex_none()
          .items_center()
          .gap(4)
          .hover((s) => s.bg(t.hover))
          .on_click(() => open(a))
          .child(div().flex_1().min_w(0).whitespace_nowrap().text_right().text_color(t.muted).child(String(i + 1)))
          .child(h_flex().w(14).flex_none().items_center().justify_center().child(this.status(t, a, true)));
      }
      const when = this.since(a);
      const idle = a.status === "idle" && !a.focused;
      const isPinned = a.pinned;
      const pin = div()
        .id(`pin-${a.address}`)
        .flex_none()
        .p(2)
        .rounded(4)
        .text_color(t.dim)
        .cursor_pointer()
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .tooltip(isPinned ? "Unpin" : "Pin to the top")
        .on_click((_e, cx) => {
          cx.stop_propagation();
          run("terminal.pin", { terminal: a.address, pinned: !isPinned });
          // The row moves away from under the pointer, and no hover-out comes.
          this.hovered = null;
          cx.notify();
        })
        .child(svg(`mods/workspace-chrome/${isPinned ? "pin-off" : "pin"}.svg`).size(13));
      // Under a space header the space goes without saying; an automatic tab number says nothing.
      // Without a space header above (priority, pinned) the row names its space.
      const full = byPriority || isPinned;
      const name = full ? a.space_name || label(a) : more ?? (/^\d+$/.test(label(a)) ? a.program?.name || label(a) : label(a));
      return h_flex()
        .id(`ag-${a.address}`)
        .pl(8 + indent)
        .pr(8)
        .h(30)
        .flex_none()
        .rounded(8)
        .items_center()
        .gap(9)
        .when(a.focused, (el) => el.bg(t.selected))
        .cursor_pointer()
        .hover((s) => s.bg(t.hover))
        .on_hover((on, cx) => {
          if (on) this.hovered = a.address;
          else if (this.hovered === a.address) this.hovered = null;
          cx.notify();
        })
        .on_click(() => open(a))
        .when(Boolean(pic), el => el.child(div().id(`agent-fold-${a.address}`)
          .when(subs.length > 0, el => el.on_click((_e, cx) => {
            cx.stop_propagation();
            this.folded.has(a.address) ? this.folded.delete(a.address) : this.folded.add(a.address);
            cx.notify();
          })).child(pic)))
        .child(h_flex().flex_1().min_w(0).gap(5).items_center()
          .child(div().min_w(0).max_w(full && more ? 120 : 200).truncate().text_color(idle ? t.muted : t.foreground).child(name))
          .when(full && Boolean(more), el => el.child(div().flex_1().min_w(0).truncate().text_color(t.dim).child(`\u00b7 ${more}`))))
        .when(Boolean(machine), el => el.child(div().text_size(10).text_color(t.dim).child(machine)))
        .when(subs.length > 0, el => el.child(fold(a, subs)))
        .when(this.hovered === a.address && !a.ghost, el => el.child(pin))
        .when((this.hovered !== a.address || a.ghost) && Boolean(when), el => el.child(div().flex_none().text_size(11).text_color(t.dim).child(duration(now - when))))
        .child(this.status(t, a, byPriority && !isPinned));
    };

    // Groups in list order: spaces (grouped) or priority sections. Agents of a
    // space are next to each other in agents(), so neighbours make a group.
    const groups = pinned.length ? [{ id: "pinned", label: "Pinned", status: null, members: pinned }] : [];
    for (const a of rest) {
      const r = rankOf(a) || RANK.idle;
      const id = byPriority ? `sec-${r}` : `sp-${a.space}`;
      if (groups.at(-1)?.id === id) groups.at(-1).members.push(a);
      else groups.push({ id, label: byPriority ? SECTION[r] : a.space_name || "", status: byPriority ? SECTION_STATUS[r] : null, members: [a] });
    }

    // A group's header; it folds the group. Folded, it says how many and the most urgent state.
    const header = (g) => {
      const open = !this.folded.has(g.id);
      const top = (g.watch ?? g.members).reduce((m, a) => ((RANK[a.status] ?? 0) > (RANK[m] ?? 0) ? a.status : m), null);
      return h_flex()
        .id(g.id)
        .pl(8 + (g.indent ?? 0))
        .pr(8)
        .pt(8)
        .h(30)
        .flex_none()
        .gap(6)
        .items_center()
        .text_size(11)
        .font_medium()
        .cursor_pointer()
        .hover((s) => s.text_color(t.foreground))
        .on_click((_e, cx) => {
          open ? this.folded.add(g.id) : this.folded.delete(g.id);
          cx.notify();
        })
        .child(div().truncate().text_color(t[g.status] ?? (g.indent ? t.muted : t.dim)).child(g.label))
        .when(byPriority || g.count || !open, (el) => el.child(div().text_color(t.dim).child(String(g.members.length))))
        .child(div().flex_1())
        .when(!open, (el) => el
          .when(!byPriority && top && top !== "idle", (el) => el.child(this.status(t, { status: top }, true)))
          .child(svg("mods/workspace-chrome/chevron-right.svg").size(11).flex_none().text_color(t.dim)));
    };
    // Task view bodies. Each leader is one section: a header (the leader's task title), the leader
    // row, then its team members (dev, review, integration), one step further in. Members whose
    // parent chain reaches no leader fall back to one group per issue number (`loose`), then "기타".
    const groupRows = (sp, g, base) => {
      const id = `task-${sp.space}-${g.issue}`;
      const out = [header({ id, label: g.title, status: null, members: g.members, indent: 8 + base, count: true })];
      if (!this.folded.has(id)) out.push(...g.members.flatMap((a) => withKids(a, 0, 14 + base)));
      return out;
    };
    const sectionRows = (sp, s) => {
      const id = `task-${sp.space}-${s.leader.address}`;
      const out = [header({ id, label: s.title, status: null, members: [s.leader, ...s.members], indent: 8, count: true })];
      if (!this.folded.has(id)) out.push(...withKids(s.leader, 0, 14), ...s.members.flatMap((a) => withKids(a, 0, 22)));
      return out;
    };
    const poRows = (sp) => sp.poTiers.flatMap((p) => [...withKids(p.po, 0), ...p.sections.flatMap((s) => sectionRows(sp, s))]);
    const planRows = (sp) => {
      const out = [...poRows(sp), ...sp.sections.flatMap((s) => sectionRows(sp, s)), ...sp.loose.flatMap((g) => groupRows(sp, g, 0))];
      if (!sp.loose.length) out.push(...sp.others.flatMap((a) => withKids(a, 0)));
      else if (sp.others.length) {
        const id = `misc-${sp.space}`;
        out.push(header({ id, label: OTHER, status: null, members: sp.others, indent: 8, count: true }));
        if (!this.folded.has(id)) out.push(...sp.others.flatMap((a) => withKids(a, 0, 14)));
      }
      if (sp.scheduled.length) {
        const id = `sched-${sp.space}`;
        out.push(header({ id, label: SCHEDULED, status: null, members: sp.scheduled, indent: 8, count: true }));
        if (!this.folded.has(id)) out.push(...sp.scheduled.flatMap((a) => withKids(a, 0, 14)));
      }
      return out;
    };
    const pinnedRows = pinned.length ? [header(groups[0]), ...(this.folded.has("pinned") ? [] : pinned.flatMap((a, i) => withKids(a, i)))] : [];
    const rows = collapsed
      ? list.flatMap((a, i) => withKids(a, i))
      : plan
        ? [...pinnedRows, ...plan.flatMap((sp) => {
          const id = `sp-${sp.space}`;
          return [header({ id, label: sp.label, status: null, members: sp.members }), ...(this.folded.has(id) ? [] : planRows(sp))];
        })]
        : groups.flatMap((g) => [header(g), ...(this.folded.has(g.id) ? [] : g.members.flatMap((a, i) => withKids(a, i)))]);

    return v_flex()
      .size_full()
      .min_h(0)
      .bg(t.chrome)
      .border_t(1)
      .border_color(t.border)
      .text_size(13)
      .when(!collapsed, (el) =>
        el.child(
          h_flex()
            .px(16)
            .h(41)
            .pt(14)
            .pb(5)
            .flex_none()
            .items_center()
            .justify_between()
            .child(div().text_size(11.5).font_medium().text_color(t.dim).child("Agents"))
            .child(
              div()
                .id("ag-sort")
                .text_size(11)
                .text_color(t.dim)
                .hover((s) => s.text_color(t.foreground))
                .on_click(() => openOverlay({ mod: "agent-groups", kind: "popup", width: 200, height: 170, props: { sortMenu: true } }))
                .tooltip(`Sort agents: ${sort.label}`)
                .child(svg(`mods/workspace-chrome/${sort.icon}.svg`).size(14)),
            ),
        ),
      )
      .when(list.length === 0 && !collapsed, (el) =>
        el.child(div().px(12).text_size(12).text_color(t.dim).child("No agent status yet. Agents show up here when they report their status. Older versions and agents inside tmux may not.")),
      )
      .child(v_flex().id("ag-list").flex_1().min_h(0).px(collapsed ? 0 : 8).overflow_y_scrollbar().mode("always").children(rows))
      .when(collapsed, (el) =>
        el.child(
          h_flex()
            .h(28)
            .items_center()
            .justify_center()
            .child(
              div()
                .id("collapse")
                .text_size(13)
                .text_color(t.dim)
                .hover((s) => s.text_color(t.foreground))
                .on_click(toggleSidebar)
                .child("»"),
            ),
        ),
      );
  }
}
