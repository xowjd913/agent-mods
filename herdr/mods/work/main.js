// Work panel: session -> epic progress -> issue (Status) -> worktree (branch / PR / CI) -> last work line.
// Reads everything through collect.cjs (GitHub is only read, never written). Clicking a session focuses its pane.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { agents, run, theme, exec, appHome, checking, window, openOverlay, shared, setShared } from "herdr";

const COLLECT = () => `${appHome()}/mods/work/collect.cjs`;
const LOAD_TIMEOUT = 90000, LOAD_STALL_MS = 100000;
const ICON = (name) => `mods/workspace-chrome/${name}.svg`;

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
const NAMES_KEY = "leader.names"; // written by the inbox / agent-groups; read-only here
const namesMemo = () => { try { return shared(NAMES_KEY) ?? {}; } catch { return {}; } };
// A leader session shows its session name by the shared rule (collect.cjs's label is the `session` label or the raw title, which can carry
// "리더 · " or a status glyph); any other session keeps its label.
const sessionLabel = (s) => isAgentName(s.name) ? leaderName(s.name, { name: s.name, address: s.terminal, title: s.label }, namesMemo()) : (s.label || s.name || s.terminal);

// Opens a URL in the default browser.
function openUrl(url) {
  const p = window()?.platform;
  if (p === "macos") exec("open", [url]);
  else if (p === "windows") exec("powershell.exe", ["-NoProfile", "-Command", `Start-Process '${String(url).replace(/'/g, "''")}'`]);
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

const CI = { SUCCESS: ["CI 통과", "working"], FAILURE: ["CI 실패", "blocked"], ERROR: ["CI 실패", "blocked"], PENDING: ["CI 진행", "dim"], EXPECTED: ["CI 진행", "dim"] };

export default class Work extends View {
  init(_props, cx) {
    this.data = null;
    this.error = null;
    this.busy = false;
    this.busyAt = 0;
    this.gen = 0;
    this.queued = false;
    this.folded = new Set();
    if (checking()) return;
    this.load(cx);
    cx.timer.every(30000, (cx) => this.load(cx));
  }

  // The collector caches locally (30s) and on GitHub (3min), so a short timer is cheap.
  // force: refresh button; the collector skips its local and GitHub caches (--refresh). A click while a load is
  // running is queued and runs forced right after it. A load that never came back (busy older than LOAD_STALL_MS)
  // no longer blocks later loads.
  load(cx, force = false) {
    if (this.busy && Date.now() - this.busyAt < LOAD_STALL_MS) {
      if (force) this.queued = true;
      return;
    }
    const gen = ++this.gen;
    this.busy = true;
    this.busyAt = Date.now();
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const r = await exec("node", force ? [COLLECT(), "--refresh"] : [COLLECT()], { timeout: LOAD_TIMEOUT });
        if (r.code !== 0) throw new Error(`수집기 종료 코드 ${r.code} ${(r.stderr || "").trim()}`);
        const d = JSON.parse(r.stdout);
        if (gen !== this.gen) return;
        this.data = d;
        adoptNames(d.names); // the profile (names, labels) the collector loaded; shared with the other mods
        this.error = [...(d.errors ?? []), ...(d.profileError ? [`프로필을 읽지 못해 기본 이름으로 보여 줍니다: ${d.profileError}`] : [])].join(" / ") || null;
      } catch (e) { if (gen === this.gen) this.error = `새로고침 실패: ${String(e?.message ?? e).slice(0, 180)}`; }
      finally {
        if (gen === this.gen) {
          this.busy = false;
          cx.notify();
          if (this.queued) { this.queued = false; this.load(cx, true); }
        }
      }
    });
  }

  open(session) {
    const a = agents().find((x) => x.address === session.terminal);
    run(a?.pane ? "pane.focus" : "terminal.peek", a?.pane ? { pane: a.pane } : { terminal: session.terminal });
  }

  dot(t, status) {
    if (status === "working") return svg(ICON("spinner")).size(12).mx(1).flex_none().text_color(t.working).spin(900);
    if (status === "blocked" || status === "error") return div().size(7).mx(3).flex_none().rounded(4).bg(t.blocked);
    return div().size(7).mx(3).flex_none().rounded(4).border(1.5).border_color(t.dim);
  }

  tag(t, text, color) {
    return div().flex_none().px(6).h(17).rounded(5).bg((t[color] ?? t.dim) + "26").text_size(10.5).text_color(t[color] ?? t.dim).flex().items_center().child(text);
  }

  progress(t, epic) {
    const ratio = epic.total ? epic.done / epic.total : 0;
    return h_flex().id(`epic-${epic.number}`).h(18).gap(6).items_center().text_size(11).text_color(t.muted)
      .cursor_pointer().hover((s) => s.text_color(t.foreground))
      .on_click(() => openUrl(epic.url))
      .child(svg(ICON("layers")).size(11).flex_none())
      .child(div().flex_1().min_w(0).truncate().child(epic.title.replace(/^\[Epic\]\s*/i, "")))
      .child(div().w(46).h(4).flex_none().rounded(2).bg(t.border).child(div().h(4).rounded(2).bg(t.working).w(46 * ratio)))
      .child(div().flex_none().child(`${epic.done}/${epic.total}`));
  }

  issueRow(t, s, key, repos) {
    const [slug, num] = [key.repo, key.number];
    const info = this.data.issues[key.key];
    const wts = (repos.get(slug)?.worktrees ?? []).filter((w) => w.issue === num && !w.main);
    return v_flex().gap(2).pl(15).py(2)
      .child(h_flex().id(`is-${s.terminal}-${key.key}`).gap(6).items_center().h(20).text_size(12).cursor_pointer()
        .hover((x) => x.text_color(t.foreground))
        .on_click(() => info?.url && openUrl(info.url))
        .child(div().flex_none().text_color(t.dim).child(`#${num}`))
        .child(div().flex_1().min_w(0).truncate().text_color(info?.state === "CLOSED" ? t.dim : t.foreground).child(info?.title ?? slug))
        .when(Boolean(info?.status), (el) => el.child(this.tag(t, info.status, "working")))
        .when(info?.state === "CLOSED", (el) => el.child(this.tag(t, "닫힘", "dim"))))
      .when(Boolean(info?.epic), (el) => el.child(this.progress(t, info.epic)))
      .children(wts.map((w) => this.wtRow(t, w, slug)));
  }

  wtRow(t, w, slug) {
    const pr = w.pr;
    const ci = pr && CI[pr.ci];
    const name = w.branch ?? w.path.split(/[\\/]/).pop();
    return h_flex().id(`wt-${w.path}`).h(20).gap(6).items_center().text_size(11).text_color(t.muted)
      .cursor_pointer().hover((s) => s.bg(t.hover).rounded(5))
      .on_click(() => openOverlay({ mod: "wt-menu", kind: "popup", width: 240, height: 330, props: { path: w.path, branch: w.branch, slug, pr: pr ? { number: pr.number, url: pr.url, state: pr.state } : null } }))
      .child(svg(ICON("git-branch")).size(11).flex_none())
      .child(div().flex_1().min_w(0).truncate().child(name))
      .when(Boolean(pr), (el) => el.child(this.tag(t, pr.state === "MERGED" ? "병합됨" : pr.state === "CLOSED" ? "닫힘" : pr.draft ? "초안 PR" : "PR", pr.state === "MERGED" ? "dim" : "working")))
      .when(Boolean(ci) && pr.state === "OPEN", (el) => el.child(this.tag(t, ci[0], ci[1])))
      .when(!pr, (el) => el.child(div().flex_none().text_color(t.dim).child("PR 없음")));
  }

  sessionBlock(t, s, repos, depth) {
    const label = sessionLabel(s);
    const folded = this.folded.has(s.terminal);
    return v_flex().flex_none().pl(depth * 10).pb(4)
      .child(h_flex().id(`se-${s.terminal}`).h(28).gap(7).px(6).rounded(7).items_center().text_size(12.5).cursor_pointer()
        .hover((x) => x.bg(t.hover))
        .on_click(() => this.open(s))
        .child(this.dot(t, s.status))
        .child(div().flex_1().min_w(0).truncate().text_color(s.status === "done" ? t.muted : t.foreground).child(label))
        .child(div().id(`fold-${s.terminal}`).flex_none().p(2).rounded(4).text_color(t.dim)
          .hover((x) => x.bg(t.hover).text_color(t.foreground))
          .on_click((_e, cx) => { cx.stop_propagation(); folded ? this.folded.delete(s.terminal) : this.folded.add(s.terminal); cx.notify(); })
          .child(svg(ICON(folded ? "chevron-right" : "chevron-down")).size(11))))
      .when(!folded, (el) => el
        .children(s.issues.map((k) => this.issueRow(t, s, k, repos)))
        .when(Boolean(s.last), (e) => e.child(div().pl(21).pr(6).pt(2).text_size(11).text_color(t.dim).max_h(30).overflow_hidden().child(s.last))));
  }

  render(cx) {
    const t = theme();
    const d = this.data;
    const repos = new Map((d?.repos ?? []).map((r) => [r.slug, r]));
    const ids = new Set((d?.sessions ?? []).map((s) => s.terminal));
    const kids = (p) => (d?.sessions ?? []).filter((s) => s.parent === p);
    const tree = (s, depth) => [this.sessionBlock(t, s, repos, depth), ...kids(s.terminal).flatMap((k) => tree(k, depth + 1))];
    const roots = (d?.sessions ?? []).filter((s) => !s.parent || !ids.has(s.parent));
    return v_flex().size_full().min_h(0).bg(t.chrome).text_size(13)
      .child(h_flex().h(36).px(14).flex_none().items_center().justify_between()
        .child(div().text_size(15).font_semibold().text_color(t.foreground).child("작업"))
        .child(h_flex().gap(6).items_center().text_size(11).text_color(t.dim)
          .when(Boolean(d), (el) => el.child(div().child(ago(d.at))))
          .child(div().id("work-refresh").p(3).rounded(5).hover((s) => s.bg(t.hover).text_color(t.foreground))
            .on_click((_e, cx) => this.load(cx, true)).tooltip("새로고침")
            .child(this.busy ? svg(ICON("spinner")).size(13).spin(900) : div().text_size(13).child("\u21bb")))))
      .when(Boolean(this.error), (el) => el.child(div().px(14).pb(6).text_size(11).text_color(t.blocked).max_h(48).overflow_hidden().child(this.error)))
      .when(Boolean(d?.notes?.length), (el) => el.child(div().id("work-note").px(14).pb(6).text_size(11).text_color(t.dim).truncate().tooltip(d.notes.join(" / ")).child(d.notes.join(" / "))))
      .when(!d && !this.error, (el) => el.child(div().px(14).text_size(12).text_color(t.dim).child("불러오는 중…")))
      .child(v_flex().id("work-list").flex_1().min_h(0).px(8).overflow_y_scrollbar().mode("always").children(roots.flatMap((s) => tree(s, 0))));
  }
}
