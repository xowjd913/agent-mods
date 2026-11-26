// 설정 창: 탭 줄의 `설정` 버튼이 연다. 창은 하나(key "settings")이고 다시 누르면 그 창으로 간다.
// 창은 블록 셋으로 이뤄진다(제목 줄 · 왼쪽 칸 목록 · 오른쪽 내용). 이 모드가 제목 줄·칸 목록·`모드` 칸을 그리고,
// `GitHub` 칸은 계정 패널(gh-accounts)을 고치지 않고 그대로 블록으로 넣는다. 그래서 계정 패널의 기능은 그대로다.
// `규칙`(#124)·`Claude 계정`(#123)·`UI 모드 글자 크기`(#103)는 그 일이 합쳐진 뒤 칸을 더한다. 지금은 꺼진 채 "준비 중"으로만 보인다.
// 모드 켜기·끄기는 하지 않는다: 설치기(install.cjs)는 모드와 함께 깔리지 않으므로 창에서 돌릴 수 없다. 설치 여부와 설치 명령만 보여 준다.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { theme, props, openOverlay, closeOverlay, setShared, appHome, readTextFile } from "herdr";

// settings-window:begin
// 설정 창의 모양. tabs-mine/main.js와 settings/main.js에 이 블록을 그대로 복사해 둔다(모드끼리 파일을 불러올 수 없다. 테스트가 둘이 같은지 본다).
// 칸을 바꾸면 SETTINGS_BODY와 settings/main.js의 SECTIONS를 함께 고친다.
const SETTINGS_SHARED = "settings.section"; // 마지막으로 본 칸. 버튼으로 다시 열면 그 칸으로 연다
const SETTINGS_BODY = { github: { mod: "gh-accounts" }, mods: { mod: "settings", props: { part: "mods" } } };
const settingsWindow = (section) => {
  const id = SETTINGS_BODY[section] ? section : "github";
  return { kind: "window", key: "settings", width: 900, height: 640, layout: { id: "settings", type: "column", children: [
    { id: "settings-bar", type: "block", content: { mod: "settings", props: { part: "bar" } }, size: { px: 40 }, window_drag: true },
    { id: "settings-main", type: "row", children: [
      { id: "settings-nav", type: "block", content: { mod: "settings", props: { part: "nav", section: id } }, size: { px: 200 } },
      { id: "settings-body", type: "block", content: SETTINGS_BODY[id], size: { weight: 1 } },
    ] },
  ] } };
};
// settings-window:end

// 칸 목록. soon은 아직 없는 칸(켜지 않는다), issue는 그 칸이 기다리는 이슈다.
const SECTIONS = [
  { id: "github", label: "GitHub", hint: "저장소별 GitHub 계정" },
  { id: "mods", label: "모드", hint: "설치된 모드와 설치 명령" },
  { id: "rules", label: "규칙", soon: true, issue: 124 },
  { id: "claude", label: "Claude 계정", soon: true, issue: 123 },
  { id: "fontsize", label: "UI 모드 글자 크기", soon: true, issue: 103 },
];

// install.cjs의 MODS와 같은 이름·설명·기본 여부(테스트가 install.cjs와 같은지 본다). 모드 폴더에서는 install.cjs를 읽을 수 없어 적어 둔다.
const MODS = [
  { name: "tabs-mine", desc: "탭 줄. 오른쪽 패널 버튼과 설정 버튼을 더하고 예약 실행을 맡는다", core: true },
  { name: "settings", desc: "설정 창: GitHub 계정과 설치된 모드", core: true },
  { name: "gh-accounts", desc: "계정 패널: 스페이스·저장소마다 쓸 GitHub 계정 고르기 (설정 창 GitHub 칸)", core: true },
  { name: "work", desc: "Work 패널: 누가 무엇을 하고 있나", core: true },
  { name: "prs", desc: "PRs 패널: 무엇을 손봐야 하나", core: true },
  { name: "wt-menu", desc: "워크트리 메뉴: Work·PRs에서 워크트리 줄을 누르면 뜨는 팝업", core: true },
  { name: "schedules", desc: "예약 패널: 정해진 시각에 에이전트 돌리기", core: true },
  { name: "usage-status", desc: "아래 상태 줄에 Claude 사용률을 보여 준다" },
  { name: "agent-groups", desc: "왼쪽 사이드바 에이전트 목록을 작업별로 묶는다" },
  { name: "leader-tabs", desc: "칸 머리줄에 리더 탭을 보여 준다" },
  { name: "path-menu", desc: "터미널 경로를 Cmd·Ctrl+클릭하면 폴더 열기·파일 열기·경로 복사 메뉴를 띄운다" },
  { name: "inbox", desc: "UI 모드 패널: 리더 결과 보고를 채팅처럼 보고, 결정을 PO에게 답한다" },
];
// README의 설치 한 줄과 같은 원격 형태라 저장소를 받지 않은 폴더에서도 그대로 돌아간다.
const RAW = "https://raw.githubusercontent.com/xowjd913/agent-mods/main/herdr";
const cmdSh = (flag, mod) => `curl -fsSL ${RAW}/install.sh | sh -s -- ${flag} ${mod}`;
const cmdPs = (flag, mod) => `& ([scriptblock]::Create((irm ${RAW}/install.ps1))) ${flag} ${mod}`;
const cmdAdd = (mod) => cmdSh("--add", mod);
const cmdAddWin = (mod) => cmdPs("-Add", mod);
const cmdRemove = (mod) => cmdSh("--remove", mod);
const cmdRemoveWin = (mod) => cmdPs("-Remove", mod);

const safeProps = () => { try { return props() ?? {}; } catch { return {}; } };
// 창을 끌 때 쓰는 눌림은 모드가 처리하는 컨트롤에서 멈춘다.
const stop = (_e, cx) => cx.stop_propagation();

export default class Settings extends View {
  init(p, cx) {
    this.part = (p ?? safeProps()).part ?? "mods";
    this.section = (p ?? safeProps()).section ?? "github";
    this.installed = null; // { 모드: true|false }, 읽기 전
    this.note = null;
    if (this.part === "mods") this.load(cx);
  }

  // 설치 여부: 모드 폴더의 mod.json이 있으면 설치된 것이다(표시 파일은 빈 파일이라 읽기 결과로 구분하기 어렵다).
  load(cx) {
    const home = String(appHome() ?? "");
    const reads = MODS.map(async (m) => {
      try { return [m.name, (await readTextFile(`${home}/mods/${m.name}/mod.json`)) != null]; } catch { return [m.name, false]; }
    });
    Promise.all(reads).then((rows) => { this.installed = Object.fromEntries(rows); cx.notify(); });
  }

  open(id) {
    const to = SECTIONS.find((s) => s.id === id && !s.soon);
    if (!to) return;
    try { setShared(SETTINGS_SHARED, to.id); } catch {}
    try { openOverlay(settingsWindow(to.id)); } catch {}
  }

  copy(cx, text) {
    try { cx.write_to_clipboard(String(text)); this.note = `복사했습니다: ${text}`; } catch (e) { this.note = `복사하지 못했습니다: ${String(e?.message ?? e).slice(0, 100)}`; }
    cx.notify();
  }

  bar(t) {
    return h_flex().size_full().px(14).items_center().justify_between().bg(t.chrome).border_b(1).border_color(t.border)
      .child(div().text_size(15).font_semibold().text_color(t.foreground).child("설정"))
      .child(div().id("settings-close").p(4).rounded(5).text_color(t.dim).cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_mouse_down("left", stop).on_click((_e, cx) => { try { closeOverlay(safeProps().overlay); } catch {} cx.notify(); }).tooltip("닫기")
        .child(svg("mods/pane/close.svg").size(13)));
  }

  nav(t) {
    return v_flex().size_full().p(8).gap(2).bg(t.chrome).border_r(1).border_color(t.border)
      .children(SECTIONS.map((s) => {
        const on = s.id === this.section;
        const row = h_flex().id(`settings-nav-${s.id}`).h(30).px(10).gap(6).items_center().rounded(6).text_size(13)
          .bg(on ? t.selected : t.chrome).on_mouse_down("left", stop);
        if (s.soon) {
          return row.text_color(t.dim).tooltip(`준비 중: #${s.issue}이 합쳐진 뒤 이 칸이 생깁니다`)
            .child(div().flex_1().min_w(0).truncate().child(s.label))
            .child(div().flex_none().text_size(10.5).child("준비 중"));
        }
        return row.cursor_pointer().text_color(on ? t.foreground : t.muted).hover((x) => x.bg(t.hover))
          .on_click((_e, cx) => { this.open(s.id); cx.notify(); }).tooltip(s.hint)
          .child(div().flex_1().min_w(0).truncate().child(s.label));
      }));
  }

  // 이 컴퓨터에서 터미널에 붙여 넣을 명령. 설치기는 저장소를 받은 폴더에서 돌리거나, 받지 않고 curl로 돌린다.
  modRow(t, m) {
    const on = this.installed ? this.installed[m.name] : null;
    const cmd = on ? cmdRemove(m.name) : cmdAdd(m.name);
    const copy = (id, label, text) => div().id(`${id}-${m.name}`).flex_none().h(22).px(8).rounded(5).flex().items_center().cursor_pointer().text_size(11)
      .bg(t.raised).text_color(t.muted).hover((x) => x.bg(t.hover).text_color(t.foreground)).on_mouse_down("left", stop)
      .on_click((_e, cx) => this.copy(cx, text)).tooltip(text).child(label);
    return v_flex().id(`mod-${m.name}`).px(10).py(7).gap(4).rounded(6).bg(t.chrome).border_1().border_color(t.border)
      .child(h_flex().gap(8).items_center()
        .child(div().flex_none().size(8).rounded(4).bg(on == null ? t.dim : on ? t.working : t.border))
        .child(div().text_size(13).font_semibold().text_color(t.foreground).child(m.name))
        .child(div().text_size(11).text_color(t.dim).child(on == null ? "확인 중" : on ? "설치됨" : "설치 안 됨"))
        .child(div().text_size(11).text_color(t.dim).child(m.core ? "기본" : "추가")))
      .child(div().text_size(12).text_color(t.muted).child(m.desc))
      .child(h_flex().gap(6).items_center().flex_wrap()
        .child(copy("mod-copy", on ? "제거 명령 복사" : "설치 명령 복사", cmd))
        .child(copy("mod-copy-win", "Windows 명령 복사", on ? cmdRemoveWin(m.name) : cmdAddWin(m.name))));
  }

  modsBody(t) {
    return v_flex().size_full().min_h(0).bg(t.chrome).text_size(13)
      .child(h_flex().h(38).px(14).flex_none().items_center().gap(8)
        .child(div().text_size(15).font_semibold().text_color(t.foreground).child("모드"))
        .child(div().id("mods-refresh").p(3).rounded(5).text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground)).on_mouse_down("left", stop)
          .on_click((_e, cx) => { this.installed = null; this.load(cx); cx.notify(); }).tooltip("새로고침").child(div().text_size(14).child("↻"))))
      .child(div().px(14).pb(8).text_size(12).text_color(t.dim)
        .child("모드는 설치기로 켜고 끕니다. 설치기는 모드와 함께 깔리지 않아 이 창에서 돌리지 않고, 터미널에 붙여 넣을 명령을 복사해 줍니다. 모드를 바꾼 뒤에는 Herdr를 다시 시작하세요."))
      .when(Boolean(this.note), (el) => el.child(div().px(14).pb(6).text_size(11).text_color(t.muted).max_h(40).overflow_hidden().child(this.note)))
      .child(v_flex().id("mods-list").flex_1().min_h(0).px(10).pb(10).gap(6).overflow_y_scrollbar().mode("always").children(MODS.map((m) => this.modRow(t, m))));
  }

  render(_cx) {
    const t = theme();
    if (this.part === "bar") return this.bar(t);
    if (this.part === "nav") return this.nav(t);
    return this.modsBody(t);
  }
}
