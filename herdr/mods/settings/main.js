// 설정 창: 탭 줄의 `설정` 버튼이 연다. 창은 하나(key "settings")이고 다시 누르면 그 창으로 간다.
// 창은 블록 셋으로 이뤄진다(제목 줄 · 왼쪽 칸 목록 · 오른쪽 내용). 이 모드가 제목 줄·칸 목록·`모드` 칸을 그리고,
// `계정` 칸은 계정 패널(gh-accounts)을 고치지 않고 그대로 블록으로 넣는다. 그래서 계정 패널의 기능은 그대로다.
// `규칙`(#124)·`Claude 계정`(#123)·`UI 모드 글자 크기`(#103)는 그 일이 합쳐진 뒤 칸을 더한다. 지금은 꺼진 채 "준비 중"으로만 보인다.
// `모드` 칸은 README의 설치 한 줄(curl | sh, Windows는 PowerShell)을 herdr `exec`로 돌려 설치·제거한다(기본 모드는 제거하지 않는다).
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { theme, props, openOverlay, closeOverlay, setShared, appHome, readTextFile, exec, window, shared } from "herdr";

// settings-window:begin
// 설정 창의 모양. tabs-mine/main.js와 settings/main.js에 이 블록을 그대로 복사해 둔다(모드끼리 파일을 불러올 수 없다. 테스트가 둘이 같은지 본다).
// 칸을 바꾸면 SETTINGS_BODY와 settings/main.js의 SECTIONS를 함께 고친다.
const SETTINGS_SHARED = "settings.section"; // 마지막으로 본 칸. 버튼으로 다시 열면 그 칸으로 연다
const SETTINGS_BODY = { accounts: { mod: "gh-accounts" }, mods: { mod: "settings", props: { part: "mods" } } };
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
  { id: "accounts", label: "계정", hint: "저장소별 GitHub 계정" },
  { id: "mods", label: "모드", hint: "설치된 모드를 설치·제거" },
  { id: "rules", label: "규칙", soon: true, issue: 124 },
  { id: "claude", label: "Claude 계정", soon: true, issue: 123 },
  { id: "fontsize", label: "UI 모드 글자 크기", soon: true, issue: 103 },
];

// install.cjs의 MODS와 같은 이름·설명·기본 여부(테스트가 install.cjs와 같은지 본다). 모드 폴더에서는 install.cjs를 읽을 수 없어 적어 둔다.
const MODS = [
  { name: "tabs-mine", desc: "탭 줄. 오른쪽 패널 버튼과 설정 버튼을 더하고 예약 실행을 맡는다", core: true },
  { name: "settings", desc: "설정 창: 계정과 설치된 모드", core: true },
  { name: "gh-accounts", desc: "계정 패널: 스페이스·저장소마다 쓸 GitHub 계정 고르기 (설정 창 계정 칸)", core: true },
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
// install.cjs의 MODS[이름].deps 중 비어 있지 않은 것(테스트가 install.cjs와 같은지 본다). 설치기는 남는 모드가 지우려는 모드를 쓰면 아무것도 지우지 않으므로, 누르기 전에 미리 알린다.
const DEPS = {
  "tabs-mine": ["settings"],
  settings: ["gh-accounts"],
  work: ["tabs-mine", "wt-menu"],
  prs: ["work", "tabs-mine", "wt-menu"],
  schedules: ["tabs-mine"],
  inbox: ["tabs-mine"],
};
// 지울 수 없는 모드와 그 까닭. 설치기는 막지 않지만 지우면 설정 창이나 계정 칸이 깨진다.
const KEEP = {
  "tabs-mine": "설정 창을 여는 버튼이 여기 있어서, 지우면 설정 창을 다시 열 길이 없습니다",
  settings: "지우면 설정 창을 다시 열 길이 없습니다",
  "gh-accounts": "설정 창의 계정 칸이 쓰는 모드입니다",
};
// name이 설치돼 있을 때 그것을 쓰고 있는(함께 설치된 것까지 따라가서) 설치된 모드들. 설치기의 withDeps와 같은 규칙이다.
const usersOf = (name, installed) => {
  const need = (m, seen = new Set()) => {
    for (const d of DEPS[m] ?? []) if (!seen.has(d)) { seen.add(d); need(d, seen); }
    return seen;
  };
  return MODS.map((m) => m.name).filter((m) => m !== name && installed?.[m] === true && need(m).has(name));
};
// 설치기가 막았을 때 남기는 "A 이(가) B 을(를) 씁니다." 줄에서 막은 모드 이름들을 꺼낸다(Windows는 막아도 종료 코드가 0이라 출력으로 본다).
const blockedBy = (r) => [...new Set(`${r.stdout ?? ""}\n${r.stderr ?? ""}`.split("\n").map((l) => l.trim().match(/^(\S+) 이\(가\) .+ 을\(를\) 씁니다\.$/)?.[1]).filter(Boolean))];
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
    if (this.part === "mods") this.load(cx);
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
    started.then(async (r) => {
      const stuck = action === "remove" ? blockedBy(r) : [];
      // Windows 설치기는 막혀도 종료 코드 0이고 한국어 줄이 깨져 올 수 있어, 제거가 성공으로 보이면 mod.json이 정말 없어졌는지 본다.
      let left = false;
      if (action === "remove" && r.code === 0 && !stuck.length) {
        try { left = (await readTextFile(`${home}/mods/${name}/mod.json`)) != null; } catch { left = false; }
      }
      const ok = r.code === 0 && !stuck.length && !left;
      const out = lastLine(r);
      this.result[name] = stuck.length
        ? { ok: false, text: `이 모드를 쓰는 모드가 있어 아무것도 지우지 않았습니다. ${stuck.join(", ")} 모드를 먼저 지우세요.` }
        : left
        ? { ok: false, text: `제거되지 않았습니다. 이 모드를 쓰는 모드가 설치돼 있을 수 있습니다${lastLine(r) ? `: ${lastLine(r).slice(0, 100)}` : ""}` }
        : ok
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
    const keep = KEEP[m.name];
    const users = on && !keep ? usersOf(m.name, this.installed) : [];
    if (busyHere) actions.child(div().text_size(11).text_color(t.muted).child(busy.action === "remove" ? "제거하는 중…" : "설치하는 중…"));
    else if (busy) actions.child(div().text_size(11).text_color(t.dim).child(`${busy.name} ${busy.action === "remove" ? "제거" : "설치"} 중이라 기다립니다`));
    else if (on && !ask && keep) actions.child(div().text_size(11).text_color(t.dim).child(`제거할 수 없습니다: ${keep}`));
    else if (on && !ask && users.length) actions.child(div().text_size(11).text_color(t.dim).child(`${users.join(", ")} 모드를 먼저 지우세요(그 모드가 이 모드를 씁니다)`));
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
      else if (on && !keep && !users.length) actions.child(btn("mod-remove", "제거", (cx) => { this.confirm = { name: m.name, action: "remove" }; cx.notify(); }));
    }
    // 직접 돌리지 못하거나(출처 기록 없음) 돌렸는데 실패했으면 터미널에서 돌릴 한 줄을 복사한다.
    // 제거할 수 없거나 다른 모드가 쓰는 모드는 제거 명령을 복사해 주지 않는다.
    const noRemove = on && (keep || users.length);
    if (on != null && this.source !== undefined && !busy && !noRemove && (!run || (res && !res.ok))) {
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
    return this.modsBody(t);
  }
}
