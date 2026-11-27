// PRs panel: open pull requests per repo (CI dot, review badge, draft, author, updated time; stale after STALE_DAYS), the worktrees that have no PR,
// and worktrees whose PR is already closed/merged ("정리 후보"). Repos with no PR are folded into one line at the bottom.
// Also usable as a pane beside a terminal (`pane.split {direction: "right", mod: "prs", props: {docked: true}}`; "옆에 열기" puts it
// beside the tab's leader, see dock()): below COMPACT_PX wide
// (COMPACT_DOCKED_PX when docked) it drops the author; CI dot and review badge show in both. Toggles: "내 PR" and "임시 wt". Read-only: GitHub is only read, via collect.cjs.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { theme, exec, appHome, checking, window, openOverlay, run, panes, props, focused, terminals, readTextFile, writeTextFile, shared, setShared } from "herdr";

const COLLECT = () => `${appHome()}/mods/work/collect.cjs`;
const LOAD_TIMEOUT = 90000, LOAD_STALL_MS = 100000;
const ICON = (name) => `mods/workspace-chrome/${name}.svg`;
const COMPACT_PX = 330, COMPACT_DOCKED_PX = 560, STALE_DAYS = 14;
const CI = { SUCCESS: ["CI 통과", "working"], FAILURE: ["CI 실패", "blocked"], ERROR: ["CI 실패", "blocked"], PENDING: ["CI 진행", "idle"], EXPECTED: ["CI 진행", "idle"] };
const NO_CI = ["CI 없음", "dim"];
const stale = (iso) => Date.now() - Date.parse(iso) > STALE_DAYS * 86400000;
const REVIEW = { APPROVED: ["승인", "working"], CHANGES_REQUESTED: ["수정 요청", "blocked"], REVIEW_REQUIRED: ["리뷰 대기", "dim"] };

function openUrl(url) {
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

// Every PRs pane as {pane, tab}, kept in PANES_FILE for herdr-team.sh arrange: the CLI cannot list mod panes, and
// arrange closes and reopens this pane beside the leader. Written only when the list changed.
const PANES_FILE = () => `${appHome()}/data/prs/panes.json`;
let published = null, writing = false;
function publishPanes(cx) {
  if (writing || checking() || !NAMES.arrangeScript) return; // no arrange script here (the "none" preset, or it is missing): nothing reads the list
  const text = JSON.stringify((panes() ?? []).filter((p) => p.mod === "prs").map((p) => ({ pane: p.pane, tab: p.tab })));
  if (text === published) return;
  writing = true;
  cx.spawn(async () => {
    try {
      const cur = await readTextFile(PANES_FILE());
      if (cur !== text) await writeTextFile(PANES_FILE(), text, cur);
      published = text;
    } catch {} finally { writing = false; }
  });
}

// The leader to open beside: the focused pane if it is a leader, else the newest leader in the tab (created_ms,
// else the higher base-36 address). Leaders carry the role=leader label that `spawn --leader` sets.
function leaderPane(here, f) {
  syncNames();
  const byAddr = new Map((terminals() ?? []).map((t) => [t.address, t]));
  const leaders = here.filter((p) => p.terminal && isAgentTerm(byAddr.get(p.terminal)));
  const age = (p) => { const ms = Number(byAddr.get(p.terminal)?.created_ms); return Number.isFinite(ms) ? ms : parseInt(String(p.terminal).replace(/^t/, ""), 36) || 0; };
  return leaders.find((p) => p.pane === f?.pane) ?? leaders.sort((a, b) => age(b) - age(a))[0];
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

const read = (key, fallback) => { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } };
const write = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch {} };

export default class Prs extends View {
  init(_props, cx) {
    this.data = null;
    this.error = null;
    this.busy = false;
    this.busyAt = 0;
    this.gen = 0;
    this.queued = false;
    this.mine = read("mine", false);
    this.temp = read("temp", false);
    this.compact = false;
    this.openEmpty = false;
    if (checking()) return;
    this.load(cx);
    cx.timer.every(30000, (cx) => { this.load(cx); publishPanes(cx); });
  }

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
        adoptNames(d.names); // the profile the collector loaded; shared with the other mods
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

  tag(t, text, color) {
    return div().flex_none().px(6).h(17).rounded(5).bg((t[color] ?? t.dim) + "26").text_size(10.5).text_color(t[color] ?? t.dim).flex().items_center().child(text);
  }

  toggle(t, id, label, on, set) {
    return div().id(id).h(22).px(9).rounded(11).flex().items_center().text_size(11.5).cursor_pointer()
      .bg(on ? t.selected : t.chrome).border(1).border_color(on ? t.foreground + "40" : t.border)
      .text_color(on ? t.foreground : t.muted).hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => { set(!on); cx.notify(); }).child(label);
  }

  // Opens this board as a pane to the right of the tab's leader (leaderPane), or of the focused terminal when the tab
  // has no leader; if the tab already has one, focuses it.
  dock() {
    // panes() lists every tab and each tab has its own focused pane: narrow to the tab being shown.
    const f = focused();
    const here = (panes() ?? []).filter((p) => p.tab === f?.tab);
    const beside = leaderPane(here, f) ?? here.find((p) => p.pane === f?.pane) ?? here.find((p) => p.focused && p.terminal) ?? here.find((p) => p.focused);
    const have = beside && here.find((p) => p.mod === "prs");
    if (have) run("pane.focus", { pane: have.pane });
    else run("pane.split", { direction: "right", mod: "prs", props: { docked: true }, ...(beside ? { pane: beside.pane } : {}) });
  }

  menu(w, slug) {
    const pr = w.pr;
    openOverlay({ mod: "wt-menu", kind: "popup", width: 240, height: 330, props: { path: w.path, branch: w.branch, slug, pr: pr ? { number: pr.number, url: pr.url, state: pr.state } : null } });
  }

  // A CI dot for every PR: green passed, red failed, amber running, hollow when the PR has no checks.
  ciDot(t, pr) {
    const ci = CI[pr.ci] ?? NO_CI;
    const dot = div().flex_none().size(8).rounded(4).tooltip(ci[0]);
    return ci === NO_CI ? dot.border(1.5).border_color(t.dim) : dot.bg(t[ci[1]] ?? t.dim);
  }

  // A section title that must read as a heading, not as an item row: bold, bright, spaced, with a rule above.
  heading(t, text, count, first) {
    return h_flex().h(first ? 30 : 38).px(8).pt(first ? 4 : 14).items_center().gap(7).flex_none()
      .when(!first, (el) => el.border_t(1).border_color(t.border).mt(6))
      .child(div().min_w(0).truncate().text_size(13).font_semibold().text_color(t.foreground).child(text))
      .when(count !== undefined, (el) => el.child(div().flex_none().px(6).h(16).rounded(8).bg(t.raised).flex().items_center().text_size(10.5).text_color(t.muted).child(String(count))));
  }

  subheading(t, text, count) {
    return h_flex().px(8).pt(8).pb(3).gap(6).items_center().flex_none()
      .child(div().w(3).h(11).rounded(2).bg(t.dim))
      .child(div().text_size(11).font_semibold().text_color(t.muted).child(text))
      .child(div().text_size(10.5).text_color(t.dim).child(String(count)));
  }

  prRow(t, pr, slug, wt) {
    const rv = REVIEW[pr.review];
    const c = this.compact, old = stale(pr.updated), warn = t.ansi3 ?? t.idle;
    return v_flex().id(`pr-${slug}-${pr.number}`).flex_none().px(8).py(5).gap(3).rounded(7).cursor_pointer().hover((s) => s.bg(t.hover))
      .on_click(() => openUrl(pr.url))
      .child(h_flex().gap(7).items_center().text_size(12.5)
        .child(this.ciDot(t, pr))
        .child(div().flex_1().min_w(0).truncate().text_color(old ? warn : pr.draft ? t.muted : t.foreground).child(pr.title))
        .when(Boolean(wt), (el) => el.child(div().id(`pm-${slug}-${pr.number}`).flex_none().px(4).rounded(4).text_color(t.dim)
          .hover((s) => s.bg(t.raised).text_color(t.foreground))
          .on_click((_e, cx) => { cx.stop_propagation(); this.menu(wt, slug); }).tooltip("워크트리 메뉴").child("⋯"))))
      .child(h_flex().gap(5).items_center().text_size(11).text_color(t.dim).pl(15)
        .child(div().flex_none().child(`#${pr.number}`))
        .child(div().flex_1().min_w(0).truncate().text_color(old ? warn : t.dim).child(`${c ? "" : `${pr.author} · `}${ago(pr.updated)}${old ? " · 오래됨" : ""}`))
        .when(pr.draft, (el) => el.child(this.tag(t, "초안", "dim")))
        .when(pr.asked, (el) => el.child(this.tag(t, "리뷰 요청", "blocked")))
        .when(Boolean(rv), (el) => el.child(this.tag(t, rv[0], rv[1]))));
  }

  // done: the branch's PR is closed or merged, so the worktree is a cleanup candidate (the menu has "경로 복사"; nothing is deleted here).
  // With a PR (or, without one, the issue named by the branch number) the row is two lines: "#number title" with the state and end time
  // on the right, and the branch name small and dim below. Without either it stays a single branch-name line.
  wtRow(t, w, slug, done) {
    const ref = w.ref, name = w.branch ?? w.path.split(/[\\/]/).pop();
    const tags = (el) => el.when(w.temp, (e) => e.child(this.tag(t, "임시", "dim")))
      .when(Boolean(done), (e) => e.child(this.tag(t, "정리 후보", "idle")));
    const row = v_flex().id(`wt-${w.path}`).flex_none().px(8).gap(2).rounded(7).cursor_pointer().hover((s) => s.bg(t.hover)).on_click(() => this.menu(w, slug));
    if (!ref) {
      return row.h(24).flex_row().gap(6).items_center().text_size(12).text_color(done ? t.dim : t.muted)
        .child(svg(ICON("git-branch")).size(12).flex_none())
        .child(div().flex_1().min_w(0).truncate().child(name))
        .child(tags(h_flex().gap(6)));
    }
    const state = ref.state === "MERGED" ? "병합됨" : ref.state === "CLOSED" ? "닫힘" : "열림";
    const when = ref.at && ref.state !== "OPEN" ? ago(ref.at) : "";
    return row.py(5)
      .child(h_flex().gap(6).items_center().text_size(12.5).text_color(done ? t.muted : t.foreground)
        .child(svg(ICON("git-branch")).size(12).flex_none().text_color(t.dim))
        .child(div().flex_1().min_w(0).truncate().child(`#${ref.number} ${ref.title}`))
        .child(div().flex_none().text_size(11).text_color(t.dim).child(when ? `${state} · ${when}` : state)))
      .child(h_flex().gap(6).items_center().pl(18)
        .child(div().flex_1().min_w(0).truncate().text_size(10.5).text_color(t.dim).child(name))
        .child(tags(h_flex().gap(6))));
  }

  repoBlock(t, r, prs, wts, cands, first) {
    const wtOf = (pr) => r.worktrees.find((w) => w.pr?.number === pr.number || (w.branch && w.branch === pr.branch));
    return v_flex().flex_none().pb(6)
      .child(this.heading(t, r.slug, prs.length, first))
      .children(prs.map((p) => this.prRow(t, p, r.slug, wtOf(p))))
      .when(wts.length > 0, (el) => el.child(this.subheading(t, "PR 없는 워크트리", wts.length)).children(wts.map((w) => this.wtRow(t, w, r.slug, false))))
      .when(cands.length > 0, (el) => el.child(this.subheading(t, "정리 후보 워크트리", cands.length)).children(cands.map((w) => this.wtRow(t, w, r.slug, true))));
  }

  render(cx) {
    publishPanes(cx);
    const t = theme();
    const d = this.data;
    // The viewer's own login, or the repo owner's (a personal repo's PRs are the person's too): collect.cjs sets pr.mine.
    const shown = (w) => !w.main && (this.temp || !w.temp);
    const parts = (d?.repos ?? []).map((r) => {
      const prs = r.prs.filter((p) => p.state === "OPEN" && (!this.mine || p.mine));
      const wts = r.worktrees.filter((w) => shown(w) && !w.pr);
      const cands = r.worktrees.filter((w) => shown(w) && w.pr && w.pr.state !== "OPEN");
      return { r, prs, wts, cands };
    }).filter((x) => x.prs.length || x.wts.length || x.cands.length);
    const withPrs = parts.filter((x) => x.prs.length), noPrs = parts.filter((x) => !x.prs.length);
    const blocks = withPrs.map((x, i) => this.repoBlock(t, x.r, x.prs, x.wts, x.cands, i === 0));
    if (noPrs.length) {
      const names = noPrs.map((x) => x.r.slug.split("/").pop()).join(", ");
      blocks.push(h_flex().id("prs-empty-repos").flex_none().min_h(34).mt(withPrs.length ? 10 : 0).px(8).gap(7).items_center().cursor_pointer().text_size(12)
        .when(withPrs.length > 0, (el) => el.border_t(1).border_color(t.border).pt(8))
        .hover((s) => s.bg(t.hover)).on_click((_e, cx) => { this.openEmpty = !this.openEmpty; cx.notify(); })
        .child(svg(ICON(this.openEmpty ? "chevron-down" : "chevron-right")).size(11).flex_none().text_color(t.muted))
        .child(div().flex_none().font_semibold().text_color(t.muted).child(`PR 없는 저장소 ${noPrs.length}개`))
        .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(names)));
      if (this.openEmpty) noPrs.forEach((x, i) => blocks.push(this.repoBlock(t, x.r, x.prs, x.wts, x.cands, false)));
    }
    const docked = Boolean(props()?.docked);
    return v_flex().size_full().min_h(0).bg(t.chrome).text_size(13)
      .on_size_change((size, cx) => { const c = size.width < (props()?.docked ? COMPACT_DOCKED_PX : COMPACT_PX); if (c !== this.compact) { this.compact = c; cx.notify(); } })
      // A docked pane already has its own title bar, so only the panel shows the "PRs" title.
      .child(h_flex().h(38).px(this.compact ? 10 : 14).flex_none().items_center().justify_between()
        .child(h_flex().gap(6).items_center()
          .when(!docked, (el) => el.child(div().text_size(15).font_semibold().text_color(t.foreground).child("PRs")))
          .child(div().id("prs-refresh").p(3).rounded(5).text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground))
            .on_click((_e, cx) => this.load(cx, true)).tooltip("새로고침")
            .child(this.busy ? svg(ICON("spinner")).size(13).spin(900) : div().text_size(14).child("↻"))))
        .child(h_flex().gap(6).items_center().text_size(11).text_color(t.dim)
          .when(Boolean(d), (el) => el.child(div().child(ago(d.at))))
          .when(!docked, (el) => el.child(div().id("prs-dock").px(6).py(2).rounded(5).text_size(11).hover((s) => s.bg(t.hover).text_color(t.foreground))
            .on_click(() => this.dock()).tooltip("리더 옆 창으로 열기 (리더가 없으면 지금 터미널 옆)").child("옆에 열기")))))
      .child(h_flex().px(this.compact ? 8 : 12).pb(6).gap(6).flex_none()
        .child(this.toggle(t, "tg-mine", "내 PR", this.mine, (v) => { this.mine = v; write("mine", v); }))
        .child(this.toggle(t, "tg-temp", "임시 wt", this.temp, (v) => { this.temp = v; write("temp", v); })))
      .when(Boolean(this.error), (el) => el.child(div().px(14).pb(6).text_size(11).text_color(t.blocked).max_h(48).overflow_hidden().child(this.error)))
      .when(!d && !this.error, (el) => el.child(div().px(14).text_size(12).text_color(t.dim).child("불러오는 중…")))
      .when(Boolean(d) && blocks.length === 0, (el) => el.child(div().px(14).text_size(12).text_color(t.dim).child("표시할 PR이 없습니다.")))
      .child(v_flex().id("prs-list").flex_1().min_h(0).px(4).overflow_y_scrollbar().mode("always").children(blocks));
  }
}
