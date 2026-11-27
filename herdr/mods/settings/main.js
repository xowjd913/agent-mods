// 설정 창: 탭 줄의 `설정` 버튼이 연다. 창은 하나(key "settings")이고 다시 누르면 그 창으로 간다.
// 창은 블록 셋으로 이뤄진다(제목 줄 · 왼쪽 칸 목록 · 오른쪽 내용). 이 모드가 제목 줄·칸 목록·`모드` 칸을 그리고,
// `계정` 칸은 계정 패널(gh-accounts)을 고치지 않고 그대로 블록으로 넣는다. 그래서 계정 패널의 기능은 그대로다.
// `UI 모드 글자 크기`(#103)는 그 일이 합쳐진 뒤 칸을 더한다. 지금은 꺼진 채 "준비 중"으로만 보인다. Claude 계정(#123)은 `계정` 칸(gh-accounts)에 들어 있다.
// `규칙` 칸(#126)은 PO 규칙 / 규칙 없음 중 하나를 고르고 이름 규칙 몇 가지를 고친다. 쓰기는 모두 같은 폴더의 rules.cjs(node)가 하고
// (프로필 파일을 inbox의 loadProfile로 검사한 뒤 백업하고 한 번에 바꾼다), 이 창은 herdr `exec`로 부르기만 한다.
// `모드` 칸은 README의 설치 한 줄(curl | sh, Windows는 PowerShell)을 herdr `exec`로 돌려 설치·제거한다(기본 모드는 제거하지 않는다).
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { theme, props, openOverlay, closeOverlay, setShared, appHome, readTextFile, exec, window, shared } from "herdr";

// settings-window:begin
// 설정 창의 모양. tabs-mine/main.js와 settings/main.js에 이 블록을 그대로 복사해 둔다(모드끼리 파일을 불러올 수 없다. 테스트가 둘이 같은지 본다).
// 칸을 바꾸면 SETTINGS_BODY와 settings/main.js의 SECTIONS를 함께 고친다.
const SETTINGS_SHARED = "settings.section"; // 마지막으로 본 칸. 버튼으로 다시 열면 그 칸으로 연다
const SETTINGS_BODY = { accounts: { mod: "gh-accounts" }, mods: { mod: "settings", props: { part: "mods" } }, rules: { mod: "settings", props: { part: "rules" } } };
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

// 칸 목록. soon은 아직 없는 칸(켜지 않는다), issue는 그 칸이 기다리는 이슈다.
const SECTIONS = [
  { id: "accounts", label: "계정", hint: "GitHub 계정(저장소별)과 Claude 계정" },
  { id: "mods", label: "모드", hint: "설치된 모드를 설치·제거" },
  { id: "rules", label: "규칙", hint: "리더·PO 이름 규칙 고르기" },
  { id: "fontsize", label: "UI 모드 글자 크기", soon: true, issue: 103 },
];

// install.cjs의 MODS와 같은 이름·설명·기본 여부(테스트가 install.cjs와 같은지 본다). 모드 폴더에서는 install.cjs를 읽을 수 없어 적어 둔다.
const MODS = [
  { name: "tabs-mine", desc: "탭 줄. 오른쪽 패널 버튼과 설정 버튼을 더하고 예약 실행을 맡는다", core: true },
  { name: "settings", desc: "설정 창: 계정·규칙·설치된 모드", core: true },
  { name: "gh-accounts", desc: "계정 패널: 스페이스·저장소마다 쓸 GitHub 계정과 Claude 계정 고르기 (설정 창 계정 칸)", core: true },
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
// 설치기 출처. install.cjs가 설치할 때 settings 모드 폴더의 .source.json에 남긴다.
//   원격(curl|sh, irm): { kind: "remote", ref }  /  저장소 복제본: { kind: "local", dir }  /  기록 없음: 직접 돌리지 않는다(명령 복사만).
const REPO_RAW = "https://raw.githubusercontent.com/xowjd913/agent-mods";
const REF_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/;
const isWin = () => { try { return window()?.platform === "windows"; } catch { return false; } };
const shq = (x) => `'${String(x).replace(/'/g, `'\\''`)}'`;
const psq = (x) => `'${String(x).replace(/'/g, "''")}'`;
const rawOf = (ref) => `${REPO_RAW}/${ref}/herdr`;
const joinDir = (dir, file) => `${String(dir).replace(/[\\/]+$/, "")}${isWin() ? "\\" : "/"}${file}`;
const readSource = async (home) => {
  try {
    const rec = JSON.parse(await readTextFile(`${home}/mods/settings/.source.json`));
    if (rec?.kind === "remote" && REF_RE.test(String(rec.ref))) return { kind: "remote", ref: String(rec.ref) };
    if (rec?.kind === "local" && typeof rec.dir === "string" && rec.dir) {
      const script = joinDir(rec.dir, isWin() ? "install.ps1" : "install.sh");
      return (await readTextFile(script)) != null ? { kind: "local", dir: rec.dir, script } : { kind: "gone", dir: rec.dir };
    }
  } catch {}
  return null;
};
const canRun = (src) => src?.kind === "local" || src?.kind === "remote";
const sourceText = (src) => (src?.kind === "local" ? `로컬 ${src.dir}` : src?.kind === "remote" ? `원격 ${src.ref}` : "알 수 없음");
// 터미널에서 직접 돌릴 한 줄. 출처를 모르면 README의 main 한 줄이다(어느 버전이 깔릴지 모르는 줄이라 직접 돌리지 않는다).
const copyCmd = (src, action, mod) => {
  const flag = (action === "remove" ? "Remove" : "Add");
  if (src?.kind === "local") return isWin() ? `& ${psq(src.script)} -${flag} ${mod}` : `sh ${shq(src.script)} --${action} ${mod}`;
  const ref = src?.kind === "remote" ? src.ref : "main";
  const raw = rawOf(ref);
  if (isWin()) return `${src?.kind === "remote" ? `$env:AGENT_MODS_REF=${psq(ref)}; ` : ""}& ([scriptblock]::Create((irm ${raw}/install.ps1))) -${flag} ${mod}`;
  return `curl -fsSL ${raw}/install.sh | ${src?.kind === "remote" ? `AGENT_MODS_REF=${ref} ` : ""}sh -s -- --${action} ${mod}`;
};
// 설치기를 이 컴퓨터에서 돌린다. 설치한 출처 그대로(복제본이면 그 스크립트, 원격이면 기록된 브랜치의 한 줄)이고, HERDR_APP_HOME을 이 Herdr 설정 폴더로 맞춰 같은 곳을 고친다.
const runInstaller = (src, action, mod, home) => {
  const flag = action === "remove" ? "Remove" : "Add";
  if (isWin()) {
    const pre = `$env:HERDR_APP_HOME=${psq(home)}; `;
    if (src.kind === "local") return exec("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", `${pre}& ${psq(src.script)} -${flag} ${mod}`], { timeout: 600000 });
    return exec("powershell.exe", ["-NoProfile", "-Command", `${pre}$env:AGENT_MODS_REF=${psq(src.ref)}; & ([scriptblock]::Create((irm ${rawOf(src.ref)}/install.ps1))) -${flag} ${mod}`], { timeout: 600000 });
  }
  if (src.kind === "local") return exec("env", [`HERDR_APP_HOME=${home}`, "sh", src.script, `--${action}`, mod], { timeout: 600000 });
  return exec("env", [`HERDR_APP_HOME=${home}`, `AGENT_MODS_REF=${src.ref}`, "sh", "-c", `curl -fsSL ${rawOf(src.ref)}/install.sh | sh -s -- --${action} ${mod}`], { timeout: 600000 });
};
// 도는 중 표시는 창을 닫았다 열어도 남도록 공유 값에 둔다. 10분이 지난 표시는 죽은 것으로 보고 무시한다.
const BUSY_KEY = "settings.busy";
const BUSY_TTL = 600000;
const busyNow = () => {
  try {
    const b = shared(BUSY_KEY);
    if (b && typeof b === "object" && Date.now() - Number(b.at) < BUSY_TTL) return b;
  } catch {}
  return null;
};
const setBusy = (v) => { try { setShared(BUSY_KEY, v); } catch {} };
const BUSY_VERB = { remove: "제거", save: "저장", reset: "되돌리기" }; // 그 밖의 action(add)은 설치다
const busyText = (b) => `${b.name} ${BUSY_VERB[b.action] ?? "설치"} 중이라 기다립니다`;
// 규칙 칸: 프로필 파일의 키 중 이 창이 고치는 것(rules.cjs FIELDS와 같은 id). 테스트가 둘이 같은지 본다.
const RULE_FIELDS = [
  { id: "agent.name", label: "리더 이름 패턴", hint: "정규식. 이 이름의 터미널을 결과를 보고하는 리더로 봅니다" },
  { id: "agent.role", label: "리더 role 값", hint: "터미널 role 라벨이 이 값이면 리더로 봅니다" },
  { id: "agent.titlePrefix", label: "제목 접두어", hint: "탭·카드 제목 앞에서 잘라내는 글자(예: 리더 · )" },
  { id: "agent.strip", label: "이름 접두어 패턴", hint: "정규식. 리더 이름에서 잘라내 보여 줍니다(예: ^lead-)" },
  { id: "hub.role", label: "PO role 값", hint: "답을 받는 터미널(PO)의 role 값. 규칙 없음에서는 비웁니다" },
  { id: "hub.id", label: "PO id 패턴", hint: "정규식. PO 하나를 가리키는 이름의 모양입니다" },
  { id: "arrangeScript", label: "배치 스크립트", hint: "PO 칸을 다시 앉히는 스크립트 경로. 비우면 이 기능이 꺼집니다" },
];
const RULE_PRESETS = [
  { id: "none", label: "규칙 없음", hint: "이름 규칙을 쓰지 않습니다. 부모 링크와 wait 라벨만으로 보여 줍니다" },
  { id: "po", label: "PO 규칙", hint: "lead-* 리더와 role=po 허브라는 이름 규칙을 씁니다" },
];
const RULE_WHY = {
  file: "프로필 파일의 preset 값입니다",
  "file-default": "프로필 파일에 preset이 없어 PO 규칙으로 봅니다",
  script: "프로필 파일이 없고 PO 배치 스크립트가 있어 PO 규칙으로 봅니다",
  "no-script": "프로필 파일이 없고 PO 배치 스크립트도 없어 규칙 없음으로 봅니다",
};
const NAMES_SHARED = "inbox.names"; // 모드들이 따르는 이름 규칙(NAMES 블록의 공유 값). 저장하면 여기에 바로 올려 열린 패널이 다음 갱신에 따른다
const lastLine = (r) => [...String(r.stderr || "").split("\n"), ...String(r.stdout || "").split("\n")].map((l) => l.trim()).filter(Boolean).pop() ?? "";

const safeProps = () => { try { return props() ?? {}; } catch { return {}; } };
// 창을 끌 때 쓰는 눌림은 모드가 처리하는 컨트롤에서 멈춘다.
const stop = (_e, cx) => cx.stop_propagation();

export default class Settings extends View {
  init(p, cx) {
    this.part = (p ?? safeProps()).part ?? "mods";
    this.section = (p ?? safeProps()).section ?? "accounts";
    this.wasBusy = false; // 도는 중이던 표시가 사라지면(다른 창이 끝냄) 목록을 다시 읽는다
    this.confirm = null; // 확인을 기다리는 { name, action }
    this.source = undefined; // 설치 출처(읽기 전 undefined, 기록 없음 null)
    this.result = {}; // 모드별 마지막 결과 { ok, text }
    this.installed = null; // { 모드: true|false }, 읽기 전
    this.note = null;
    this.rules = null; // rules.cjs가 알려 준 상태(읽기 전 null)
    this.rulesNote = null; // { ok, text }
    this.rulesAsk = false; // 기본값으로 되돌리기 확인 카드
    this.rulesRunning = false; // 이 창이 규칙 도우미를 돌리는 중
    this.preset = null; // 고른 preset(저장 전)
    this.focusKey = null;
    this.ruleInputs = {};
    if (this.part === "rules") {
      for (const f of RULE_FIELDS) this.ruleInputs[f.id] = this.input(f.id);
      this.loadRules(cx);
    }
    if (this.part === "mods") this.load(cx);
  }

  input(placeholder) {
    const s = InputState.new({ value: "", placeholder });
    s.on("focus", (_e, cx) => { this.focusKey = s; cx.notify(); });
    s.on("blur", (_e, cx) => { if (this.focusKey === s) this.focusKey = null; cx.notify(); });
    return s;
  }

  // 설치 여부: 모드 폴더의 mod.json이 있으면 설치된 것이다(표시 파일은 빈 파일이라 읽기 결과로 구분하기 어렵다).
  load(cx) {
    const home = String(appHome() ?? "");
    const reads = MODS.map(async (m) => {
      try { return [m.name, (await readTextFile(`${home}/mods/${m.name}/mod.json`)) != null]; } catch { return [m.name, false]; }
    });
    Promise.all(reads).then((rows) => { this.installed = Object.fromEntries(rows); cx.notify(); });
    readSource(home).then((src) => { this.source = src; cx.notify(); });
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

  // 설치기를 돌린다. 끝나면 설치 여부를 다시 읽고, 모드를 바꿨으니 Herdr를 다시 시작하라고 알린다.
  run(cx, action, name) {
    const src = this.source;
    if (busyNow() || !canRun(src)) return;
    setBusy({ name, action, at: Date.now() });
    this.confirm = null;
    delete this.result[name];
    cx.notify();
    const home = String(appHome() ?? "");
    let started;
    try { started = Promise.resolve(runInstaller(src, action, name, home)); } catch (e) { started = Promise.reject(e); }
    started.then((r) => {
      const ok = r.code === 0;
      const out = lastLine(r);
      this.result[name] = ok
        ? { ok, text: `${action === "remove" ? "제거했습니다" : "설치했습니다"}. 적용하려면 Herdr를 다시 시작하세요.${out ? ` (${out.slice(0, 90)})` : ""}` }
        : { ok, text: `실패했습니다(${r.code}): ${out.slice(0, 140) || "출력 없음"}` };
    }, (e) => {
      this.result[name] = { ok: false, text: `설치기를 시작하지 못했습니다: ${String(e?.message ?? e).slice(0, 140)}` };
    }).finally(() => { setBusy(null); this.load(cx); cx.notify(); });
  }

  modRow(t, m) {
    const on = this.installed ? this.installed[m.name] : null;
    const busy = busyNow();
    const busyHere = busy?.name === m.name;
    const run = canRun(this.source);
    const locked = Boolean(busy) || on == null || this.source === undefined;
    const ask = this.confirm?.name === m.name ? this.confirm.action : null;
    const res = this.result[m.name];
    const btn = (id, label, fn, tone) => {
      const el = div().id(`${id}-${m.name}`).flex_none().h(22).px(8).rounded(5).flex().items_center().text_size(11)
        .bg(tone === "danger" ? t.blocked : t.raised).text_color(tone === "danger" ? t.foreground : t.muted).on_mouse_down("left", stop);
      if (locked) return el.opacity(0.5).child(label);
      return el.cursor_pointer().hover((x) => x.bg(t.hover).text_color(t.foreground)).on_click((_e, cx) => fn(cx)).child(label);
    };
    const actions = h_flex().gap(6).items_center().flex_wrap();
    const src = sourceText(this.source);
    if (busyHere) actions.child(div().text_size(11).text_color(t.muted).child(busy.action === "remove" ? "제거하는 중…" : "설치하는 중…"));
    else if (busy) actions.child(div().text_size(11).text_color(t.dim).child(busyText(busy)));
    else if (on && m.core && !ask) actions.child(div().text_size(11).text_color(t.dim).child("기본 모드라 제거하지 않습니다"));
    if (!busy && run) {
      if (ask === "add") {
        actions.child(div().text_size(11).text_color(t.muted).child(`${m.name}을(를) 설치할까요? 설치된 모드 전체를 ${src}에서 다시 복사합니다.`))
          .child(btn("mod-add-yes", "설치", (cx) => this.run(cx, "add", m.name)))
          .child(btn("mod-add-no", "취소", (cx) => { this.confirm = null; cx.notify(); }));
      } else if (ask === "remove") {
        actions.child(div().text_size(11).text_color(t.muted).child(`${m.name}을(를) 제거할까요? (설치기 출처: ${src})`))
          .child(btn("mod-remove-yes", "제거", (cx) => this.run(cx, "remove", m.name), "danger"))
          .child(btn("mod-remove-no", "취소", (cx) => { this.confirm = null; cx.notify(); }));
      } else if (on === false) actions.child(btn("mod-add", "설치", (cx) => { this.confirm = { name: m.name, action: "add" }; cx.notify(); }));
      else if (on && !m.core) actions.child(btn("mod-remove", "제거", (cx) => { this.confirm = { name: m.name, action: "remove" }; cx.notify(); }));
    }
    // 직접 돌리지 못하거나(출처 기록 없음) 돌렸는데 실패했으면 터미널에서 돌릴 한 줄을 복사한다.
    if (on != null && this.source !== undefined && !busy && (!run || (res && !res.ok))) {
      actions.child(btn("mod-copy", "명령 복사", (cx) => this.copy(cx, copyCmd(this.source, on ? "remove" : "add", m.name))));
    }
    return v_flex().id(`mod-${m.name}`).px(10).py(7).gap(4).rounded(6).bg(t.chrome).border_1().border_color(t.border)
      .child(h_flex().gap(8).items_center()
        .child(div().flex_none().size(8).rounded(4).bg(on == null ? t.dim : on ? t.working : t.border))
        .child(div().text_size(13).font_semibold().text_color(t.foreground).child(m.name))
        .child(div().text_size(11).text_color(t.dim).child(on == null ? "확인 중" : on ? "설치됨" : "설치 안 됨"))
        .child(div().text_size(11).text_color(t.dim).child(m.core ? "기본" : "추가")))
      .child(div().text_size(12).text_color(t.muted).child(m.desc))
      .child(actions)
      .when(Boolean(res), (el) => el.child(div().text_size(11).text_color(res.ok ? t.working : t.blocked).child(res.text)));
  }

  // 설치기 출처를 한 줄로. 설치(--add)는 설치된 모드 전체를 이 출처에서 다시 복사한다.
  sourceLine() {
    const src = this.source;
    if (src === undefined) return "설치 출처 확인 중…";
    if (src?.kind === "local") return `설치 출처: 로컬 ${src.dir}. 설치는 설치된 모드 전체를 여기서 다시 복사합니다.`;
    if (src?.kind === "remote") return `설치 출처: 원격 ${src.ref} 브랜치. 설치는 설치된 모드 전체를 그 브랜치에서 다시 복사합니다.`;
    if (src?.kind === "gone") return `설치 출처(${src.dir})의 설치 스크립트가 없어 직접 돌리지 않습니다. 아래 명령 복사로 터미널에서 돌리세요(main 기준 한 줄입니다).`;
    return "설치 출처 기록(.source.json)이 없어 직접 돌리지 않습니다. 아래 명령 복사로 터미널에서 돌리면 기록이 남습니다(main 기준 한 줄입니다).";
  }

  modsBody(t) {
    return v_flex().size_full().min_h(0).bg(t.chrome).text_size(13)
      .child(h_flex().h(38).px(14).flex_none().items_center().gap(8)
        .child(div().text_size(15).font_semibold().text_color(t.foreground).child("모드"))
        .child(div().id("mods-refresh").p(3).rounded(5).text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground)).on_mouse_down("left", stop)
          .on_click((_e, cx) => { this.installed = null; this.load(cx); cx.notify(); }).tooltip("새로고침").child(div().text_size(14).child("↻"))))
      .child(div().px(14).pb(8).text_size(12).text_color(t.dim)
        .child("모드를 여기서 바로 설치·제거합니다(README의 설치 한 줄과 같은 설치기를 돌립니다). 바꾼 뒤에는 Herdr를 다시 시작하세요."))
      .child(div().id("mods-source").px(14).pb(8).text_size(11).text_color(t.muted).child(this.sourceLine()))
      .when(Boolean(this.note), (el) => el.child(div().px(14).pb(6).text_size(11).text_color(t.muted).max_h(40).overflow_hidden().child(this.note)))
      .child(v_flex().id("mods-list").flex_1().min_h(0).px(10).pb(10).gap(6).overflow_y_scrollbar().mode("always").children(MODS.map((m) => this.modRow(t, m))));
  }

  // ---- 규칙 칸 ----
  // rules.cjs(show|set|reset)를 돌려 마지막 줄의 JSON을 돌려준다. 못 돌리면 { ok:false, error }.
  async runRules(args) {
    try {
      const r = await exec("node", [`${String(appHome() ?? "")}/mods/settings/rules.cjs`, ...args], { timeout: 30000 });
      const line = String(r?.stdout ?? "").trim().split("\n").pop();
      const out = JSON.parse(line);
      if (out && typeof out === "object") return out;
    } catch (e) { return { ok: false, error: `규칙 도우미(rules.cjs)를 돌리지 못했습니다(node와 settings 모드 설치를 확인하세요): ${String(e?.message ?? e).slice(0, 120)}` }; }
    return { ok: false, error: "규칙 도우미가 알아볼 수 없는 답을 냈습니다" };
  }

  // 도우미의 상태를 받아 입력 칸과 공유 이름 규칙에 반영한다. 고른 preset이 바뀌었으면 입력 칸을 그 preset의 값으로 채운다.
  applyRules(state, cx, fresh) {
    if (!state || typeof state !== "object") return;
    const prev = this.rules;
    this.rules = state;
    if (state.fields && (fresh || !prev?.fields)) {
      this.preset = state.preset;
      this.fillInputs(state.preset, state.fileValues ?? {}, cx);
    }
    if (state.names && typeof state.names === "object") { try { setShared(NAMES_SHARED, state.names); } catch {} }
  }

  // 입력 칸 = 파일이 정한 값 ?? 고른 preset의 기본값.
  fillInputs(preset, fileValues, cx) {
    const d = this.rules?.defaults?.[preset] ?? {};
    for (const f of RULE_FIELDS) {
      const st = this.ruleInputs[f.id];
      if (!st) continue;
      const v = fileValues[f.id] ?? d[f.id] ?? "";
      try { st.set_value(String(v)); } catch {}
    }
    cx?.notify();
  }

  loadRules(cx) {
    this.runRules(["show"]).then((s) => { if (s.ok === false && !s.file) { this.rulesNote = { ok: false, text: s.error }; } else this.applyRules(s, cx, true); cx.notify(); });
  }

  pickPreset(id, cx) {
    if (this.preset === id) return;
    this.preset = id;
    this.fillInputs(id, this.rules?.fileValues ?? {}, cx); // 바꾼 preset의 기본값으로(파일이 직접 정한 값은 그대로 둔다)
    this.rulesNote = null;
    cx.notify();
  }

  saveRules(cx) {
    if (busyNow() || this.rulesRunning || !this.rules || this.rules.broken) return;
    const fields = {};
    for (const f of RULE_FIELDS) fields[f.id] = String(this.ruleInputs[f.id]?.value?.() ?? "");
    this.rulesRunning = true;
    this.rulesNote = null;
    setBusy({ name: "규칙", action: "save", at: Date.now() });
    cx.notify();
    this.runRules(["set", encodeURIComponent(JSON.stringify({ preset: this.preset, fields }))]).then((s) => {
      this.applyRules(s, cx, s.saved === true);
      this.rulesNote = s.saved
        ? { ok: true, text: `저장했습니다(이전 파일은 ${s.file}.bak). 이미 도는 Work·PRs·리더 탭·에이전트 묶음 같은 패널은 다음 새로고침에 새 규칙을 따릅니다. 바뀌지 않는 패널이 있으면 Herdr를 다시 시작하세요. PO 보고를 쓰는 터미널의 훅은 다음 실행부터 새 규칙을 읽습니다.` }
        : { ok: false, text: `저장하지 못했습니다(파일은 그대로입니다): ${String(s.error ?? "").slice(0, 200)}` };
    }).finally(() => { this.rulesRunning = false; setBusy(null); cx.notify(); });
  }

  resetRules(cx) {
    if (busyNow() || this.rulesRunning) return;
    this.rulesAsk = false;
    this.rulesRunning = true;
    this.rulesNote = null;
    setBusy({ name: "규칙", action: "reset", at: Date.now() });
    cx.notify();
    this.runRules(["reset"]).then((s) => {
      this.applyRules(s, cx, s.reset === true);
      this.rulesNote = s.reset
        ? { ok: true, text: `기본값으로 되돌렸습니다(프로필 파일은 ${s.file}.bak 으로 옮겼습니다). 파일이 없을 때의 규칙을 따릅니다.` }
        : { ok: false, text: `되돌리지 못했습니다: ${String(s.error ?? "").slice(0, 200)}` };
    }).finally(() => { this.rulesRunning = false; setBusy(null); cx.notify(); });
  }

  textInput(t, state) {
    return Input.new(state).h(26).px(8).items_center().rounded(6).border(1)
      .border_color(this.focusKey === state ? t.accent : t.input).bg(t.background).text_size(12).text_color(t.foreground);
  }

  rulesBody(t) {
    const r = this.rules;
    const busy = busyNow();
    const locked = Boolean(busy) || this.rulesRunning;
    const btn = (id, label, fn, tone) => {
      const el = div().id(id).flex_none().h(24).px(10).rounded(5).flex().items_center().text_size(12)
        .bg(tone === "danger" ? t.blocked : tone === "primary" ? t.accent : t.raised).text_color(tone ? t.foreground : t.muted).on_mouse_down("left", stop);
      if (locked) return el.opacity(0.5).child(label);
      return el.cursor_pointer().hover((x) => x.bg(t.hover).text_color(t.foreground)).on_click((_e, cx) => fn(cx)).child(label);
    };
    const head = h_flex().h(38).px(14).flex_none().items_center().gap(8)
      .child(div().text_size(15).font_semibold().text_color(t.foreground).child("규칙"))
      .child(div().id("rules-refresh").p(3).rounded(5).text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground)).on_mouse_down("left", stop)
        .on_click((_e, cx) => { this.rules = null; this.loadRules(cx); cx.notify(); }).tooltip("새로고침").child(div().text_size(14).child("↻")));
    const intro = div().px(14).pb(8).text_size(12).text_color(t.dim)
      .child("리더·PO 보고를 알아보는 이름 규칙입니다. PO 규칙이 없는 사람은 \"규칙 없음\"으로 두고, 자기 규칙이 있으면 아래에서 맞추세요. 프로필 파일(profile.json)에 저장합니다.");
    if (!r) {
      return v_flex().size_full().min_h(0).bg(t.chrome).text_size(13).child(head).child(intro)
        .child(div().px(14).text_size(12).text_color(this.rulesNote ? t.blocked : t.muted).child(this.rulesNote?.text ?? "프로필을 읽는 중…"));
    }
    const status = v_flex().id("rules-status").mx(14).mb(8).px(10).py(8).gap(3).rounded(6).bg(t.chrome).border_1().border_color(t.border)
      .child(div().text_size(12).text_color(t.foreground).child(r.broken ? "프로필 파일을 읽을 수 없습니다" : `지금 쓰는 규칙: ${r.preset === "none" ? "규칙 없음" : "PO 규칙"}`))
      .child(div().text_size(11).text_color(t.muted).child(`프로필 파일: ${r.file}${r.source === "env" ? " (HERDR_INBOX_PROFILE)" : ""} · ${r.exists ? "있음" : "없음"}${r.backup ? " · 백업(.bak) 있음" : ""}`))
      .when(Boolean(r.why) && !r.broken, (el) => el.child(div().text_size(11).text_color(t.muted).child(`이유: ${RULE_WHY[r.why] ?? r.why}`)))
      .when(Boolean(r.error), (el) => el.child(div().text_size(11).text_color(t.blocked).child(r.error)));
    const note = this.rulesNote ? div().px(14).pb(8).text_size(11).text_color(this.rulesNote.ok ? t.working : t.blocked).child(this.rulesNote.text) : null;
    const busyLine = busy && !this.rulesRunning ? div().px(14).pb(8).text_size(11).text_color(t.dim).child(busyText(busy)) : null;
    if (r.broken) { // 읽을 수 없는 파일은 되돌리기만 된다(덮어써서 망가뜨리지 않는다)
      return v_flex().size_full().min_h(0).bg(t.chrome).text_size(13).child(head).child(intro).child(status)
        .child(h_flex().px(14).pb(8).gap(8).items_center().flex_wrap()
          .child(div().text_size(11).text_color(t.muted).child("파일을 고친 뒤 새로고침하거나, 기본값으로 되돌리면 이 파일을 .bak 으로 옮깁니다."))
          .child(this.rulesAsk
            ? h_flex().gap(6).items_center().child(div().text_size(11).text_color(t.muted).child("되돌릴까요?"))
              .child(btn("rules-reset-yes", "되돌리기", (cx) => this.resetRules(cx), "danger"))
              .child(btn("rules-reset-no", "취소", (cx) => { this.rulesAsk = false; cx.notify(); }))
            : btn("rules-reset", "기본값으로 되돌리기", (cx) => { this.rulesAsk = true; cx.notify(); })))
        .when(Boolean(note), (el) => el.child(note)).when(Boolean(busyLine), (el) => el.child(busyLine));
    }
    const presetRow = h_flex().id("rules-presets").px(14).pb(8).gap(8).items_center().flex_wrap()
      .children(RULE_PRESETS.map((p) => {
        const on = this.preset === p.id;
        const el = div().id(`rules-preset-${p.id}`).h(26).px(10).rounded(6).flex().items_center().text_size(12).border_1()
          .border_color(on ? t.accent : t.border).bg(on ? t.selected : t.raised).text_color(on ? t.foreground : t.muted).on_mouse_down("left", stop).tooltip(p.hint);
        if (locked) return el.opacity(0.6).child(p.label);
        return el.cursor_pointer().hover((x) => x.bg(t.hover)).on_click((_e, cx) => this.pickPreset(p.id, cx)).child(p.label);
      }));
    const presetHint = RULE_PRESETS.find((p) => p.id === this.preset)?.hint ?? "";
    const form = v_flex().id("rules-form").flex_1().min_h(0).px(14).pb(10).gap(8).overflow_y_scrollbar().mode("always")
      .children(RULE_FIELDS.map((f) => v_flex().id(`rules-field-${f.id}`).gap(3)
        .child(div().text_size(12).text_color(t.foreground).child(f.label))
        .child(this.textInput(t, this.ruleInputs[f.id]))
        .child(div().text_size(11).text_color(t.dim).child(f.id === "arrangeScript" && r.fields?.arrangeScript !== undefined && this.ruleInputs[f.id]?.value?.().trim()
          ? `${f.hint}. ${r.arrangeScriptExists ? "지금 이 경로의 파일이 있습니다" : "지금 이 경로의 파일은 없습니다"}` : f.hint))));
    return v_flex().size_full().min_h(0).bg(t.chrome).text_size(13).child(head).child(intro).child(status)
      .child(div().px(14).pb(4).text_size(12).text_color(t.foreground).child("규칙 고르기"))
      .child(presetRow)
      .child(div().px(14).pb(8).text_size(11).text_color(t.dim).child(`${presetHint}. 바꾸면 아래 칸이 그 규칙의 기본값으로 채워집니다. 기본값과 같은 칸은 파일에 적지 않습니다.`))
      .child(form)
      .child(h_flex().px(14).py(8).gap(8).items_center().flex_wrap().flex_none()
        .child(btn("rules-save", this.rulesRunning ? "저장하는 중…" : "저장", (cx) => this.saveRules(cx), "primary"))
        .child(this.rulesAsk
          ? h_flex().gap(6).items_center().child(div().text_size(11).text_color(t.muted).child("프로필 파일을 .bak 으로 옮길까요?"))
            .child(btn("rules-reset-yes", "되돌리기", (cx) => this.resetRules(cx), "danger"))
            .child(btn("rules-reset-no", "취소", (cx) => { this.rulesAsk = false; cx.notify(); }))
          : r.exists ? btn("rules-reset", "기본값으로 되돌리기", (cx) => { this.rulesAsk = true; cx.notify(); }) : div())
        .when(Boolean(busyLine), (el) => el.child(busyLine)))
      .when(Boolean(note), (el) => el.child(note));
  }

  render(cx) {
    const t = theme();
    if (this.part === "mods") { // 다른 창이 돌리던 설치기가 끝나면 목록을 다시 읽는다
      const b = busyNow();
      if (this.wasBusy && !b && cx) this.load(cx);
      this.wasBusy = Boolean(b);
    }
    if (this.part === "bar") return this.bar(t);
    if (this.part === "nav") return this.nav(t);
    if (this.part === "pad") return div().size_full().bg(t.chrome);
    if (this.part === "rules") return this.rulesBody(t);
    return this.modsBody(t);
  }
}
