// 계정 패널: 저장소별 GitHub 계정 도구(herdr/gh-account)의 매핑을 보고 바꾼다.
// - 스페이스: 스페이스 폴더와 그 스페이스 탭의 터미널 폴더에서 찾은 저장소를 owner 별로 묶고, owner 마다 쓸 계정을 고른다(owner/* 규칙).
// - 기본 계정, gh 에 로그인된 계정, 규칙 목록(순서 바꾸기·지우기·더하기).
// 바꾸기는 모두 gh-account CLI(set/unset/move/default/assign)로 하고, 이 패널은 토큰을 다루지 않는다. gh 활성 계정은 바꾸지 않는다.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Popover } from "gpui-base";
import { theme, exec, appHome, checking, spaces, panes } from "herdr";

const APP = () => `${appHome()}/gh-account/gh-account.cjs`;
const ICON = (name) => `mods/workspace-chrome/${name}.svg`;
const TIMEOUT = 30000, REFRESH_MS = 60000;
const NONE = "-none-";
const PATTERN = /^([A-Za-z0-9_-]+)\/(\*|[A-Za-z0-9_.-]+)$/;
const INSTALL_HINT = "gh-account 도구가 설치돼 있지 않습니다. 이 모드 저장소 폴더에서 sh herdr/install.sh --gh-account 를 실행한 뒤 새로고침하세요.";

// gh-account CLI 를 부른다. HERDR_APP_HOME 을 이 Herdr 설정 폴더로 맞춰, 터미널의 gh 래퍼·git 도우미와 같은 매핑 파일을 쓴다.
const cli = (args) => exec("env", [`HERDR_APP_HOME=${appHome()}`, "node", APP(), ...args], { timeout: TIMEOUT });
const missingTool = (r) => r.code !== 0 && /Cannot find module|MODULE_NOT_FOUND/.test(r.stderr || "");
const base = (p) => String(p ?? "").replace(/[\\/]+$/, "").split(/[\\/]/).pop();

// 스페이스마다 볼 폴더: 스페이스 폴더와 그 스페이스 탭에 있는 창들의 지금 폴더.
function spaceDirs() {
  const ps = panes() ?? [];
  return (spaces() ?? []).filter((s) => !s.machine).map((s) => {
    const tabs = new Set((s.tabs ?? []).map((t) => t.id));
    const dirs = [s.folder, ...ps.filter((p) => p.cwd && tabs.has(p.tab)).map((p) => p.cwd)].filter(Boolean);
    return { id: s.id, name: base(s.folder) || s.name || String(s.id), dirs: [...new Set(dirs)] };
  }).filter((s) => s.dirs.length);
}

export default class Accounts extends View {
  init(_props, cx) {
    this.data = null;      // list --json: { accounts, map, error }
    this.rows = [];        // [{ id, name, dirs, owners, error }]
    this.error = null;
    this.missing = false;
    this.busy = false;
    this.queued = false;
    this.saving = false;
    this.note = null;      // { text, bad }
    this.dd = null;        // 열린 드롭다운 id
    this.newAcct = null;
    this.focusKey = null;
    this.ruleInput = InputState.new({ value: "", placeholder: "owner/* 또는 owner/repo" });
    this.ruleInput.on("focus", (_e, cx) => { this.focusKey = this.ruleInput; cx.notify(); });
    this.ruleInput.on("blur", (_e, cx) => { if (this.focusKey === this.ruleInput) this.focusKey = null; cx.notify(); });
    if (checking()) return;
    this.load(cx);
    cx.timer.every(REFRESH_MS, (cx) => { if (!this.saving) this.load(cx); });
  }

  load(cx) {
    if (this.busy) { this.queued = true; return; }
    this.busy = true;
    cx.notify();
    const list = spaceDirs();
    cx.spawn(async (cx) => {
      try {
        const r = await cli(["list", "--json"]);
        if (missingTool(r)) { this.missing = true; this.data = null; this.rows = []; this.error = null; return; }
        this.missing = false;
        const d = JSON.parse(r.stdout);
        const rows = [];
        for (const s of list) {
          const x = await cli(["space", "--json", ...s.dirs]);
          let j = null;
          try { j = JSON.parse(x.stdout); } catch { j = null; }
          rows.push({ ...s, owners: j?.owners ?? [], error: j ? j.error : `저장소를 읽지 못했습니다 ${String(x.stderr || "").trim().slice(0, 120)}` });
        }
        this.data = d;
        this.rows = rows;
        this.error = d.error ?? null;
      } catch (e) { this.error = `불러오기 실패: ${String(e?.message ?? e).slice(0, 180)}`; }
      finally {
        this.busy = false;
        cx.notify();
        if (this.queued) { this.queued = false; this.load(cx); }
      }
    });
  }

  // 매핑을 바꾸고 결과 한 줄을 보여 준 뒤 다시 읽는다. 한 번에 하나만.
  change(cx, args) {
    this.dd = null;
    if (this.saving) return;
    this.saving = true;
    this.note = null;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const r = await cli(args);
        const lines = [...String(r.stdout || "").split("\n"), ...String(r.stderr || "").split("\n")].map((l) => l.trim()).filter(Boolean);
        const text = lines.join(" · ").slice(0, 400);
        this.note = { text: text || (r.code === 0 ? "바꿨습니다." : `실패했습니다(코드 ${r.code}).`), bad: r.code !== 0 || /주의:/.test(text) };
      } catch (e) { this.note = { text: `바꾸지 못했습니다: ${String(e?.message ?? e).slice(0, 180)}`, bad: true }; }
      finally { this.saving = false; cx.notify(); this.load(cx); }
    });
  }

  accountItems(noneLabel, extra) {
    const accts = this.data?.accounts ?? [];
    const items = [{ value: NONE, label: noneLabel }, { sep: true },
      ...accts.map((a) => ({ value: a.login, label: a.login, hint: a.active ? "gh 활성" : a.state && a.state !== "success" ? "로그인 문제" : "" }))];
    if (extra && !accts.some((a) => a.login === extra)) items.push({ value: extra, label: extra, hint: "로그인 안 됨" });
    return items;
  }

  // schedules 패널과 같은 드롭다운: 트리거(현재 값 + 쉐브론) → 눌러 목록 → 고르면 닫힘.
  dropdown(t, id, { items, value, onPick, menuW = 220, placeholder = "", w = 150 }) {
    const open = this.dd === id && !this.saving;
    const cur = items.find((i) => !i.sep && i.value === value);
    const trigger = h_flex().id(`${id}-btn`).w(w).flex_none().h(26).px(8).gap(6).items_center().rounded(6).border(1)
      .border_color(open ? t.accent : t.input).bg(t.background).text_size(12).cursor_pointer()
      .when(this.saving, (e) => e.opacity(0.5))
      .child(div().flex_1().min_w(0).truncate().text_color(cur ? t.foreground : t.dim).child(cur ? cur.label : placeholder))
      .child(svg(ICON("chevron-down")).size(11).flex_none().text_color(t.dim));
    const rows = items.map((it, i) => {
      if (it.sep) return div().flex_none().h(1).my(4).bg(t.border);
      const on = it.value === value;
      return h_flex().id(`${id}-i${i}`).flex_none().min_h(28).px(8).gap(8).items_center().rounded(5).cursor_pointer()
        .text_size(12.5).text_color(t.foreground).hover((s) => s.bg(t.hover)).when(on, (e) => e.bg(t.selected))
        .on_click((_e, cx) => { this.dd = null; if (it.value !== value) onPick(it.value, cx); else cx.notify(); })
        .child(div().w(14).flex_none().flex().items_center().when(on, (e) => e.child(svg(ICON("check")).size(12))))
        .child(div().flex_1().min_w(0).truncate().child(it.label))
        .when(Boolean(it.hint), (e) => e.child(div().flex_none().text_size(11).text_color(t.dim).child(it.hint)));
    });
    const content = v_flex().id(`${id}-menu`).w(menuW).max_h(320).overflow_y_scrollbar().p(4).gap(1).rounded(8).border(1).border_color(t.border)
      .bg(t.popover ?? t.raised).shadow_lg().children(rows);
    return Popover.new(`${id}-pop`).anchor("top_right").open(open)
      .on_open_change((o, cx) => { if (this.saving) return; this.dd = o ? id : this.dd === id ? null : this.dd; cx.notify(); })
      .trigger(trigger).content(content);
  }

  iconButton(t, id, label, tip, onClick, disabled = false) {
    return div().id(id).flex_none().w(20).h(20).rounded(4).flex().items_center().justify_center().text_size(12)
      .text_color(disabled ? t.border : t.dim)
      .when(!disabled, (e) => e.cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click((_e, cx) => { if (!this.saving) onClick(cx); }))
      .tooltip(tip).child(label);
  }

  heading(t, text, first, hint) {
    return v_flex().flex_none().px(8).pt(first ? 4 : 14).pb(4).gap(2)
      .when(!first, (el) => el.border_t(1).border_color(t.border).mt(6))
      .child(div().text_size(13).font_semibold().text_color(t.foreground).child(text))
      .when(Boolean(hint), (el) => el.child(div().text_size(11).text_color(t.dim).child(hint)));
  }

  // 저장소 한 줄의 계정 설명.
  repoNote(r, owner) {
    if (!r.account) return "매핑 없음 · gh 활성 계정";
    if (r.by === "default") return `${r.account} · 기본 계정`;
    if (r.match && r.match.toLowerCase() !== `${owner}/*`.toLowerCase()) return `${r.account} · 규칙 ${r.match}`;
    return r.account;
  }

  ownerBlock(t, s, o) {
    const id = `own-${s.id}-${o.owner}`;
    return v_flex().flex_none().px(8).py(4).gap(2)
      .child(h_flex().gap(8).items_center()
        .child(div().flex_1().min_w(0).truncate().text_size(12.5).text_color(t.foreground).child(`${o.owner}/*`))
        .child(this.dropdown(t, id, {
          items: this.accountItems("규칙 없음", o.rule), value: o.rule ?? NONE,
          onPick: (v, cx) => this.change(cx, v === NONE ? ["unset", `${o.owner}/*`] : ["set", `${o.owner}/*`, v]),
        })))
      .children(o.repos.map((r) => h_flex().pl(10).gap(6).items_center().text_size(11)
        .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(r.repo.split("/").pop()))
        .child(div().flex_none().max_w(200).truncate().text_color(r.account ? t.dim : t.idle ?? t.dim).child(this.repoNote(r, o.owner)))));
  }

  spaceBlock(t, s) {
    const rules = [...new Set(s.owners.map((o) => o.rule ?? NONE))];
    return v_flex().flex_none().pb(4)
      .child(h_flex().px(8).pt(6).pb(2).gap(8).items_center()
        .child(svg(ICON("layers")).size(12).flex_none().text_color(t.dim))
        .child(div().flex_1().min_w(0).truncate().text_size(12.5).font_semibold().text_color(t.foreground).child(s.name))
        .when(s.owners.length > 1, (el) => el.child(this.dropdown(t, `sp-${s.id}`, {
          items: this.accountItems("모두 규칙 없음", rules.length === 1 && rules[0] !== NONE ? rules[0] : undefined), value: rules.length === 1 ? rules[0] : null, placeholder: "여러 계정",
          onPick: (v, cx) => this.change(cx, ["assign", v === NONE ? "none" : v, ...s.dirs]),
        }))))
      .when(Boolean(s.error), (el) => el.child(div().px(8).text_size(11).text_color(t.blocked).child(s.error)))
      .when(!s.error && !s.owners.length, (el) => el.child(div().px(8).pl(28).text_size(11).text_color(t.dim).child("github.com 원격이 있는 저장소가 없습니다.")))
      .children(s.owners.map((o) => this.ownerBlock(t, s, o)));
  }

  ruleRow(t, r, i, n) {
    return h_flex().id(`rule-${i}`).flex_none().px(8).h(32).gap(4).items_center().rounded(6).hover((s) => s.bg(t.hover))
      .child(div().w(16).flex_none().text_size(11).text_color(t.dim).child(String(i + 1)))
      .child(div().flex_1().min_w(0).truncate().text_size(12.5).text_color(t.foreground).child(r.match))
      .child(this.dropdown(t, `rule-acct-${i}`, { items: this.accountItems("(지우기)", r.account).slice(2), value: r.account, w: 120,
        onPick: (v, cx) => this.change(cx, ["set", r.match, v]) }))
      .child(this.iconButton(t, `rule-up-${i}`, "↑", "위로(먼저 맞게)", (cx) => this.change(cx, ["move", r.match, "up"]), i === 0))
      .child(this.iconButton(t, `rule-down-${i}`, "↓", "아래로", (cx) => this.change(cx, ["move", r.match, "down"]), i === n - 1))
      .child(this.iconButton(t, `rule-del-${i}`, "✕", "규칙 지우기", (cx) => this.change(cx, ["unset", r.match])));
  }

  addRule(cx) {
    const pattern = this.ruleInput.value().trim();
    if (!PATTERN.test(pattern)) { this.note = { text: "규칙은 owner/* 나 owner/repo 모양으로 적으세요.", bad: true }; cx.notify(); return; }
    if (!this.newAcct) { this.note = { text: "쓸 계정을 고르세요.", bad: true }; cx.notify(); return; }
    this.ruleInput.set_value("");
    this.change(cx, ["set", pattern, this.newAcct]);
  }

  render(cx) {
    const t = theme();
    const d = this.data, map = d?.map;
    const accounts = d?.accounts;
    const body = [];
    if (d) {
      body.push(this.heading(t, "스페이스", true, "스페이스 폴더와 그 탭의 터미널 폴더에서 찾은 저장소입니다. owner 마다 쓸 계정을 고르세요."));
      if (!this.rows.length) body.push(div().px(8).text_size(12).text_color(t.dim).child("열린 스페이스가 없습니다."));
      for (const s of this.rows) body.push(this.spaceBlock(t, s));

      body.push(this.heading(t, "기본 계정", false, "규칙에 없는 저장소에 씁니다. 없음이면 gh 활성 계정을 그대로 씁니다."));
      body.push(h_flex().px(8).pb(4).child(this.dropdown(t, "default", {
        items: this.accountItems("없음", map?.default), value: map?.default ?? NONE, w: 200,
        onPick: (v, cx) => this.change(cx, ["default", v === NONE ? "none" : v]),
      })));

      body.push(this.heading(t, "로그인된 계정", false, "계정 더하기: 터미널에서 gh auth login. 이 패널은 gh 활성 계정을 바꾸지 않습니다."));
      if (!accounts) body.push(div().px(8).text_size(11.5).text_color(t.idle ?? t.dim).child("gh auth status --json 을 읽지 못했습니다(gh 2.60 이상 필요). 터미널에서 gh auth status 로 확인하세요."));
      else if (!accounts.length) body.push(div().px(8).text_size(12).text_color(t.dim).child("gh 에 로그인된 github.com 계정이 없습니다."));
      else for (const a of accounts) {
        body.push(h_flex().px(8).h(24).gap(7).items_center().text_size(12.5)
          .child(div().flex_none().size(7).rounded(4).bg(a.state && a.state !== "success" ? t.blocked : t.working))
          .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(a.login))
          .when(a.active, (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child("gh 활성"))));
      }

      const rules = map?.rules ?? [];
      body.push(this.heading(t, "규칙", false, "위에서부터 먼저 맞는 규칙이 이깁니다. owner/repo 규칙은 owner/* 보다 위에 두세요."));
      if (!map) body.push(div().px(8).text_size(11.5).text_color(t.blocked).child("매핑 파일을 읽지 못해 규칙을 보여 줄 수 없습니다."));
      else if (!rules.length) body.push(div().px(8).text_size(12).text_color(t.dim).child("규칙이 없습니다."));
      rules.forEach((r, i) => body.push(this.ruleRow(t, r, i, rules.length)));
      if (map) {
        body.push(h_flex().px(8).pt(6).pb(10).gap(6).items_center()
          .child(div().flex_1().min_w(0).child(Input.new(this.ruleInput).h(26).px(8).items_center().rounded(6).border(1)
            .border_color(this.focusKey === this.ruleInput ? t.accent : t.input).bg(t.background).text_size(12).text_color(t.foreground)))
          .child(this.dropdown(t, "new-acct", { items: this.accountItems("").slice(2), value: this.newAcct, placeholder: "계정", w: 110,
            onPick: (v, cx) => { this.newAcct = v; cx.notify(); } }))
          .child(div().id("rule-add").flex_none().h(26).px(10).rounded(6).flex().items_center().text_size(12).cursor_pointer()
            .bg(t.solid).text_color(t.solid_foreground).hover((s) => s.opacity(0.88))
            .on_click((_e, cx) => { if (!this.saving) this.addRule(cx); }).child("추가")));
      }
    }
    return v_flex().size_full().min_h(0).bg(t.chrome).text_size(13)
      .child(h_flex().h(38).px(14).flex_none().items_center().justify_between()
        .child(h_flex().gap(6).items_center()
          .child(div().text_size(15).font_semibold().text_color(t.foreground).child("계정"))
          .child(div().id("acct-refresh").p(3).rounded(5).text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground))
            .on_click((_e, cx) => this.load(cx)).tooltip("새로고침")
            .child(this.busy || this.saving ? svg(ICON("spinner")).size(13).spin(900) : div().text_size(14).child("↻")))))
      .when(this.missing, (el) => el.child(div().px(14).pb(6).text_size(12).text_color(t.idle ?? t.foreground).child(INSTALL_HINT)))
      .when(Boolean(this.error), (el) => el.child(div().px(14).pb(6).text_size(11).text_color(t.blocked).max_h(48).overflow_hidden().child(this.error)))
      .when(Boolean(this.note), (el) => el.child(div().px(14).pb(6).text_size(11).text_color(this.note.bad ? t.blocked : t.muted).max_h(64).overflow_hidden().child(this.note.text)))
      .when(!d && !this.error && !this.missing, (el) => el.child(div().px(14).text_size(12).text_color(t.dim).child("불러오는 중…")))
      .child(v_flex().id("acct-list").flex_1().min_h(0).px(4).overflow_y_scrollbar().mode("always").children(body));
  }
}
