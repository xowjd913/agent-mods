// 계정 패널: 저장소별 GitHub 계정 도구(herdr/gh-account)를 설치하고, 매핑을 보고 바꾸고, 저장소가 어느 계정을 쓰는지 확인한다.
// - 설치: 설치 상태를 보여 주고, 바뀔 것을 먼저 보여 준 뒤 설치·업데이트·원래대로 되돌리기를 한다.
// - 이 저장소는 어느 계정?: 폴더나 owner/repo 하나가 gh, git push, 커밋 신원에 쓸 계정과 접속 시험.
// - 저장소 owner: 모든 스페이스 폴더와 그 탭의 터미널 폴더에서 찾은 저장소를 owner 하나에 한 줄로 묶고, owner 마다 쓸 계정을 고른다(owner/* 규칙).
//   저장소 목록은 접혀 있고 owner 줄을 누르면 펼친다.
// - 기본 계정, gh 에 로그인된 계정과 계정 추가(gh auth login --web), 규칙 목록(순서 바꾸기·지우기·더하기).
// 모든 일은 이 모드에 함께 설치되는 gh-account CLI 로 하고, 이 패널은 토큰을 읽거나 보여 주지 않는다.
// gh 활성 계정은 바꾸지 않는다. 계정 추가만 예외로, gh 가 새 계정을 활성으로 바꾸므로 로그인 직후 원래 계정으로 한 번 되돌린다(CLI 의 login run).

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Popover } from "gpui-base";
import { theme, exec, appHome, checking, spaces, panes, window } from "herdr";

const APP = () => `${appHome()}/mods/gh-accounts/gh-account.cjs`;
const ICON = (name) => `mods/workspace-chrome/${name}.svg`;
const TIMEOUT = 30000, TEST_TIMEOUT = 60000, REFRESH_MS = 60000, LOGIN_POLL_MS = 2000;
const NONE = "-none-";
const PATTERN = /^([A-Za-z0-9_-]+)\/(\*|[A-Za-z0-9_.-]+)$/;
const REPO = /^[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+$/;
const RUNNING = new Set(["starting", "waiting"]);
const DEVICE_URL = "https://github.com/login/device";
const MISSING_HINT = "패널에 함께 설치되는 gh-account.cjs 를 찾지 못했습니다. 이 모드 저장소 폴더에서 sh herdr/install.sh --add gh-accounts 로 다시 설치한 뒤 새로고침하세요.";

// 로그인 셸에서 읽은 PATH. GUI 앱은 PATH 가 짧아 터미널과 다른 gh·node 를 찾을 수 있어 한 번 읽어 모든 호출에 넘긴다.
let shellPath = null;

// gh-account CLI 를 부른다. HERDR_APP_HOME 을 이 Herdr 설정 폴더로 맞춰, 터미널의 gh 래퍼·git 도우미와 같은 매핑 파일을 쓴다.
const cli = (args, timeout = TIMEOUT) => exec("env",
  [`HERDR_APP_HOME=${appHome()}`, ...(shellPath ? [`PATH=${shellPath}`] : []), "node", APP(), ...args], { timeout });
const missingTool = (r) => r.code !== 0 && /Cannot find module|MODULE_NOT_FOUND/.test(r.stderr || "");
const base = (p) => String(p ?? "").replace(/[\\/]+$/, "").split(/[\\/]/).pop();
const lines = (r) => [...String(r.stdout || "").split("\n"), ...String(r.stderr || "").split("\n")].map((l) => l.trim()).filter(Boolean);
const parse = (s) => { try { return JSON.parse(s); } catch { return null; } };

function openUrl(url) {
  const p = window()?.platform;
  if (p === "macos") return exec("open", [url]);
  return exec("xdg-open", [url]);
}
function copyText(text) {
  if (window()?.platform === "macos") return exec("sh", ["-c", 'printf %s "$1" | pbcopy', "sh", text]);
  return exec("sh", ["-c", 'printf %s "$1" | { xclip -selection clipboard 2>/dev/null || wl-copy; }', "sh", text]);
}

// 볼 폴더: 모든 스페이스(기계 스페이스 빼고)의 폴더와 그 스페이스 탭에 있는 창들의 지금 폴더. 같은 폴더는 한 번만.
// folders 는 "이 저장소는 어느 계정?" 목록에 쓸 스페이스 폴더들이다. 폴더가 같은 스페이스는 하나로 친다.
function scanDirs() {
  const ps = panes() ?? [];
  const folders = [], dirs = [];
  for (const s of (spaces() ?? []).filter((x) => !x.machine)) {
    const tabs = new Set((s.tabs ?? []).map((t) => t.id));
    if (s.folder && !folders.includes(s.folder)) folders.push(s.folder);
    for (const d of [s.folder, ...ps.filter((p) => p.cwd && tabs.has(p.tab)).map((p) => p.cwd)]) if (d && !dirs.includes(d)) dirs.push(d);
  }
  return { folders, dirs };
}

export default class Accounts extends View {
  init(_props, cx) {
    this.data = null;      // list --json: { accounts, map, error }
    this.status = null;    // status --json
    this.owners = [];      // space --json 의 owners: [{ owner, personal, rule, repos }]
    this.folders = [];     // 스페이스 폴더들(같은 폴더는 한 번)
    this.scanError = null;
    this.expanded = new Set(); // 저장소 목록을 펼친 owner(소문자)
    this.defaultAsk = null;    // 기본 계정 바꾸기 확인 카드: { account, uses, keeps }
    this.error = null;
    this.missing = false;
    this.busy = false;
    this.queued = false;
    this.saving = false;
    this.note = null;      // { text, bad }
    this.dd = null;        // 열린 드롭다운 id
    this.newAcct = null;
    this.focusKey = null;
    this.plan = null;      // { kind: "install" | "uninstall", data }
    this.target = null;    // 이 저장소는 어느 계정?: { key, label, repo?, dir? }
    this.result = null;    // check --json
    this.probing = false;
    this.loginAsk = false; // 계정 추가 확인 카드
    this.login = null;     // login status --json (진행 중일 때만)
    this.polling = false;
    this.ruleInput = this.input("owner/* 또는 owner/repo");
    this.targetInput = this.input("폴더 경로 또는 owner/repo");
    if (checking()) return;
    this.load(cx);
    cx.timer.every(REFRESH_MS, (cx) => { if (!this.saving) this.load(cx); });
    cx.timer.every(LOGIN_POLL_MS, (cx) => this.poll(cx));
  }

  input(placeholder) {
    const s = InputState.new({ value: "", placeholder });
    s.on("focus", (_e, cx) => { this.focusKey = s; cx.notify(); });
    s.on("blur", (_e, cx) => { if (this.focusKey === s) this.focusKey = null; cx.notify(); });
    return s;
  }

  load(cx) {
    if (this.busy) { this.queued = true; return; }
    this.busy = true;
    cx.notify();
    const scan = scanDirs();
    cx.spawn(async (cx) => {
      try {
        if (shellPath === null) {
          const p = await cli(["shell-path"]);
          if (missingTool(p)) { this.missing = true; this.data = null; this.status = null; this.owners = []; this.error = null; return; }
          const v = String(p.stdout || "").trim();
          shellPath = p.code === 0 && v && !v.includes("\n") ? v : "";
        }
        const r = await cli(["list", "--json"]);
        if (missingTool(r)) { this.missing = true; this.data = null; this.status = null; this.owners = []; this.error = null; return; }
        this.missing = false;
        const d = JSON.parse(r.stdout);
        this.status = parse((await cli(["status", "--json"])).stdout);
        const lg = parse((await cli(["login", "status", "--json"])).stdout);
        if (lg && RUNNING.has(lg.state)) { this.login = lg; this.loginAsk = false; }
        let owners = [], scanError = null;
        if (scan.dirs.length) {
          const x = await cli(["space", "--json", ...scan.dirs]);
          const j = parse(x.stdout);
          owners = j?.owners ?? [];
          scanError = j ? j.error : `저장소를 읽지 못했습니다 ${String(x.stderr || "").trim().slice(0, 120)}`;
        }
        this.data = d;
        this.owners = owners;
        this.folders = scan.folders;
        this.scanError = scanError;
        this.error = d.error ?? null;
      } catch (e) { this.error = `불러오기 실패: ${String(e?.message ?? e).slice(0, 180)}`; }
      finally {
        this.busy = false;
        cx.notify();
        if (this.queued) { this.queued = false; this.load(cx); }
      }
    });
  }

  // 무언가 바꾸는 명령을 하나 돌리고, 결과 줄을 보여 준 뒤 다시 읽는다. 한 번에 하나만.
  run(cx, args, { ok = "바꿨습니다.", after } = {}) {
    this.dd = null;
    if (this.saving) return;
    this.saving = true;
    this.note = null;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const r = await cli(args);
        const text = lines(r).join(" · ").slice(0, 600);
        this.note = { text: text || (r.code === 0 ? ok : `실패했습니다(코드 ${r.code}).`), bad: r.code !== 0 || /주의:/.test(text) };
        if (after) after(r);
      } catch (e) { this.note = { text: `실행하지 못했습니다: ${String(e?.message ?? e).slice(0, 180)}`, bad: true }; }
      finally { this.saving = false; cx.notify(); this.load(cx); }
    });
  }
  change(cx, args) { this.run(cx, args); }

  // ---- 설치 ----

  // 바뀔 것을 먼저 읽어 확인 카드로 보여 준다. 실제 설치·되돌리기는 카드의 단추로만 한다.
  askPlan(cx, kind) {
    if (this.saving) return;
    this.saving = true;
    this.note = null;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const r = await cli([kind, "--dry-run", "--json"]);
        const data = parse(r.stdout);
        if (!data) this.note = { text: `바뀔 것을 읽지 못했습니다. ${lines(r).join(" · ").slice(0, 300)}`, bad: true };
        else this.plan = { kind, data };
      } catch (e) { this.note = { text: `바뀔 것을 읽지 못했습니다: ${String(e?.message ?? e).slice(0, 180)}`, bad: true }; }
      finally { this.saving = false; cx.notify(); }
    });
  }

  doPlan(cx) {
    const p = this.plan;
    if (!p || (p.kind === "install" && (p.data.blocked?.length || p.data.supported === false))) return;
    this.plan = null;
    this.run(cx, [p.kind], { ok: p.kind === "install" ? "설치했습니다." : "원래대로 되돌렸습니다.", after: () => { this.result = null; } });
  }

  installBlock(t) {
    const s = this.status;
    const out = [];
    if (!s) {
      out.push(div().px(8).text_size(11.5).text_color(t.blocked).child("설치 상태를 읽지 못했습니다."));
      return out;
    }
    const issues = [];
    if (s.installed) {
      if (!s.filesOk) issues.push("설치한 파일 일부가 없거나 바뀌었습니다. 업데이트하세요.");
      if (s.appCurrent === false) issues.push("설치된 도구가 이 패널과 버전이 다릅니다. 업데이트하세요.");
      if (!s.block) issues.push("git 전역 설정에 gh-account 블록이 없습니다. 업데이트하세요.");
      if (!s.wrapperFirst) issues.push(`터미널의 gh 명령은 매핑을 따르지 않습니다(${s.inPath ? `${s.firstGh} 의 gh 가 먼저 찾힘` : `${s.binDir} 가 PATH 에 없음`}). 셸 설정에 export PATH="${s.binDir}:$PATH" 를 더하세요. git push 와 커밋 신원은 따릅니다.`);
    }
    if (!s.identity) issues.push(`git ${s.git || "(버전 모름)"} 은(는) 커밋 신원을 바꿀 수 없습니다(2.36 이상 필요). 인증은 됩니다.`);
    if (s.map && !s.map.ok) issues.push(`매핑 파일이 깨져 있습니다: ${s.map.error}`);
    const ok = s.installed && !issues.length;
    out.push(h_flex().px(8).h(24).gap(7).items_center().text_size(12.5)
      .child(div().flex_none().size(7).rounded(4).bg(!s.installed ? t.dim : ok ? t.working : t.idle ?? t.blocked))
      .child(div().flex_1().min_w(0).truncate().text_color(t.foreground)
        .child(s.installed ? `설치됨 · ${s.binDir}` : "설치 안 됨 · 규칙을 정해도 gh·git 이 쓰지 않습니다")));
    for (const i of issues) out.push(div().px(8).pl(22).text_size(11).text_color(t.idle ?? t.blocked).child(i));
    if (this.plan) out.push(this.planCard(t));
    else {
      out.push(h_flex().px(8).pt(4).pb(4).gap(6)
        .child(this.button(t, "inst-install", s.installed ? (ok ? "다시 설치…" : "업데이트…") : "설치…", (cx) => this.askPlan(cx, "install"), { primary: !ok }))
        .when(s.installed || s.block, (el) => el.child(this.button(t, "inst-uninstall", "원래대로 되돌리기…", (cx) => this.askPlan(cx, "uninstall")))));
    }
    return out;
  }

  planCard(t) {
    const p = this.plan, d = p.data;
    const install = p.kind === "install";
    const stop = install && (d.blocked?.length || d.supported === false);
    return v_flex().mx(8).my(4).p(8).gap(4).rounded(8).border(1).border_color(stop ? t.blocked : t.accent).bg(t.background)
      .child(div().text_size(12.5).font_semibold().text_color(t.foreground).child(install ? "설치하면 이렇게 바뀝니다" : "되돌리면 이렇게 바뀝니다"))
      .children((d.lines ?? []).map((l) => div().text_size(11).text_color(/^\s*(주의|다른 파일)/.test(l) || /멈춤/.test(l) ? t.blocked : t.muted).child(l)))
      .when(Boolean(stop), (el) => el.child(div().text_size(11).text_color(t.blocked)
        .child(d.supported === false ? "이 OS 는 아직 지원하지 않습니다." : "이 도구가 만들지 않은 파일이 있어 설치할 수 없습니다. 그 파일을 옮긴 뒤 다시 여세요.")))
      .when(!install, (el) => el.child(div().text_size(11).text_color(t.muted).child("되돌린 뒤에는 모든 저장소가 설치 전처럼 gh 활성 계정과 원래 자격 증명을 씁니다.")))
      .child(h_flex().pt(4).gap(6)
        .child(this.button(t, "plan-go", install ? "설치하기" : "되돌리기", (cx) => this.doPlan(cx), { primary: true, disabled: Boolean(stop) }))
        .child(this.button(t, "plan-cancel", "취소", (cx) => { this.plan = null; cx.notify(); })));
  }

  // ---- 이 저장소는 어느 계정? ----

  targetItems() {
    const items = this.folders.map((f) => ({ value: `dir:${f}`, label: `${base(f) || f} (스페이스 폴더)`, dir: f }));
    for (const o of this.owners) for (const r of o.repos) {
      const key = r.dir ? `dir:${r.dir}` : `repo:${r.repo}`;
      if (!items.some((i) => i.value === key)) items.push({ value: key, label: r.repo, hint: r.dir ? base(r.dir) : "", ...(r.dir ? { dir: r.dir } : { repo: r.repo }) });
    }
    return items;
  }

  pickTarget(cx, it) {
    this.target = { key: it.value, label: it.label, dir: it.dir, repo: it.repo };
    this.result = null;
    this.probe(cx, false);
  }

  typedTarget(cx) {
    const v = this.targetInput.value().trim();
    if (!v) { this.note = { text: "폴더 경로나 owner/repo 를 적으세요.", bad: true }; cx.notify(); return; }
    const repo = REPO.test(v) && !/^[.~]/.test(v);
    this.target = { key: `typed:${v}`, label: v, ...(repo ? { repo: v } : { dir: v }) };
    this.result = null;
    this.probe(cx, false);
  }

  probe(cx, test) {
    const tg = this.target;
    if (!tg || this.probing) return;
    this.probing = true;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const args = ["check", ...(tg.repo ? ["-R", tg.repo] : [tg.dir]), "--json", ...(test ? ["--test"] : [])];
        const r = await cli(args, test ? TEST_TIMEOUT : TIMEOUT);
        const c = parse(r.stdout);
        if (this.target !== tg) return;
        this.result = c ?? { failed: lines(r).join(" · ").slice(0, 300) || `확인하지 못했습니다(코드 ${r.code}).` };
      } catch (e) { if (this.target === tg) this.result = { failed: `확인하지 못했습니다: ${String(e?.message ?? e).slice(0, 180)}` }; }
      finally { this.probing = false; cx.notify(); }
    });
  }

  fact(t, label, value, sub) {
    return h_flex().px(8).pl(16).gap(8).items_start().text_size(11.5)
      .child(div().w(64).flex_none().text_color(t.dim).child(label))
      .child(v_flex().flex_1().min_w(0)
        .child(div().text_color(t.foreground).child(value))
        .when(Boolean(sub), (el) => el.child(div().text_size(10.5).text_color(t.dim).child(sub))));
  }

  resultBlock(t) {
    const c = this.result;
    if (!c) return [];
    if (c.failed) return [div().px(8).pl(16).text_size(11.5).text_color(t.blocked).child(c.failed)];
    const out = [];
    if (!c.repo) out.push(div().px(8).pl(16).text_size(11.5).text_color(t.dim).child("github.com 원격을 찾지 못했습니다. 이 폴더의 gh·git 은 원래 계정을 씁니다."));
    else {
      out.push(div().px(8).pl(16).pt(2).text_size(12).font_semibold().text_color(t.foreground).child(c.repo));
      out.push(this.fact(t, "매핑", c.account ?? "없음", c.account ? (c.by === "rule" ? `규칙 ${c.match}` : "기본 계정") : "규칙도 기본 계정도 없음"));
      const gh = c.gh ?? {};
      out.push(this.fact(t, "gh 명령", gh.account ?? "(활성 계정 없음)", gh.how === "mapped" ? "매핑 계정" : gh.how === "path" ? "래퍼가 쓰이지 않아 gh 활성 계정" : "gh 활성 계정"));
      const push = c.push ?? {};
      out.push(this.fact(t, "git push", push.how === "ssh" ? "SSH 키" : push.how === "prior" ? "원래 자격 증명" : push.account,
        push.how === "ssh" ? "SSH 원격은 이 도구가 인증하지 않습니다" : push.how === "prior" ? "키체인 등 설치 전과 같은 방법" : "매핑 계정 토큰"));
      const id = c.identity;
      out.push(this.fact(t, "커밋 신원", !id || id.how === "none" ? "정해지지 않음" : `${id.name ?? "?"} <${id.email ?? "?"}>`,
        !id || id.how === "none" ? "" : id.how === "mapped" ? `${id.account ? `${id.account} 계정` : "매핑 계정"}의 신원` : id.how === "env" ? "환경 변수" : `직접 정한 값${id.origin ? ` · ${id.origin}` : ""}`));
    }
    for (const w of c.warn ?? []) out.push(div().px(8).pl(16).text_size(11).text_color(t.blocked).child(`주의: ${w}`));
    if (c.test) {
      const x = c.test;
      const access = { admin: "관리자", push: "push 가능", pull: "읽기만", none: "권한 없음", notfound: "저장소를 찾지 못함(권한 없음)", error: "권한을 읽지 못함" }[x.access] ?? "";
      out.push(div().px(8).pl(16).pt(2).text_size(11.5).text_color(x.ok ? t.working : t.blocked)
        .child(`접속 시험 ${x.ok ? "성공" : "실패"}${x.login ? ` · ${x.login} 계정으로 접속` : ""}${access ? ` · ${access}` : ""}${x.message ? ` · ${x.message}` : ""}`));
    }
    if (c.repo) out.push(h_flex().px(8).pl(16).pt(4).pb(2)
      .child(this.button(t, "chk-test", this.probing ? "시험 중…" : "접속 시험", (cx) => this.probe(cx, true), { disabled: this.probing || !c.gh?.account })));
    return out;
  }

  // ---- 계정 추가 ----

  startLogin(cx) {
    if (this.saving) return;
    this.loginAsk = false;
    this.saving = true;
    this.note = null;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const r = await cli(["login", "start", "--json"]);
        const j = parse(r.stdout);
        if (j?.ok) this.login = j.login ?? { state: "starting" };
        else this.note = { text: j?.message ?? (lines(r).join(" · ").slice(0, 300) || "계정 추가를 시작하지 못했습니다."), bad: true };
      } catch (e) { this.note = { text: `계정 추가를 시작하지 못했습니다: ${String(e?.message ?? e).slice(0, 180)}`, bad: true }; }
      finally { this.saving = false; cx.notify(); }
    });
  }

  poll(cx) {
    if (!this.login || !RUNNING.has(this.login.state) || this.polling) return;
    this.polling = true;
    cx.spawn(async (cx) => {
      try {
        const j = parse((await cli(["login", "status", "--json"])).stdout);
        if (!j) return;
        if (RUNNING.has(j.state)) { this.login = j; return; }
        this.login = null;
        if (j.state === "done") {
          const kept = j.prev ? ` gh 활성 계정은 ${j.prev} 그대로입니다.` : "";
          this.note = j.restored === false ? { text: `${j.added ?? "새"} 계정을 더했습니다. ${j.message ?? ""}`, bad: true }
            : { text: `${j.added ?? "새"} 계정을 더했습니다.${kept}`, bad: false };
        } else this.note = { text: j.message ?? "계정 추가가 끝나지 않았습니다.", bad: j.state !== "cancelled" };
        this.load(cx);
      } catch { /* 다음에 다시 읽는다 */ }
      finally { this.polling = false; cx.notify(); }
    });
  }

  cancelLogin(cx) { this.run(cx, ["login", "cancel"], { ok: "계정 추가를 그만두는 중입니다." }); }

  loginBlock(t) {
    const out = [];
    const prev = (this.data?.accounts ?? []).find((a) => a.active)?.login;
    if (this.login) {
      const l = this.login;
      const url = l.url || DEVICE_URL;
      const card = v_flex().mx(8).my(4).p(8).gap(6).rounded(8).border(1).border_color(t.accent).bg(t.background)
        .child(div().text_size(12.5).font_semibold().text_color(t.foreground).child("계정 추가 중"));
      if (!l.code) card.child(div().text_size(11.5).text_color(t.dim).child("gh 를 시작하는 중입니다…"));
      else {
        card.child(div().text_size(11.5).text_color(t.muted).child("1. 일회용 코드를 복사합니다. 2. 브라우저 열기를 눌러 GitHub 에 더할 계정으로 로그인하고 코드를 넣습니다. 3. 승인하면 여기가 저절로 끝납니다."))
          .child(h_flex().gap(8).items_center()
            .child(div().text_size(20).font_semibold().text_color(t.foreground).child(l.code))
            .child(this.button(t, "login-copy", "코드 복사", (cx) => { copyText(l.code); this.note = { text: "코드를 복사했습니다.", bad: false }; cx.notify(); })))
          .child(div().text_size(11).text_color(t.dim).child(url));
      }
      card.child(h_flex().gap(6)
        .child(this.button(t, "login-open", "브라우저 열기", () => { openUrl(url); }, { primary: true, disabled: !l.code }))
        .child(this.button(t, "login-cancel", "그만두기", (cx) => this.cancelLogin(cx))));
      out.push(card);
    } else if (this.loginAsk) {
      out.push(v_flex().mx(8).my(4).p(8).gap(4).rounded(8).border(1).border_color(t.idle ?? t.accent).bg(t.background)
        .child(div().text_size(12.5).font_semibold().text_color(t.foreground).child("계정 추가"))
        .child(div().text_size(11).text_color(t.muted).child("브라우저로 GitHub 에 로그인해 gh 에 계정을 더합니다. 토큰은 gh 가 보관하고 이 패널은 보지 않습니다."))
        .child(div().text_size(11).text_color(t.muted).child(`gh 는 로그인이 끝나면 새 계정을 활성 계정으로 바꿉니다. 이 패널은 그 직후 원래 활성 계정${prev ? `(${prev})` : ""}으로 한 번 되돌립니다.`))
        .child(div().text_size(11).text_color(t.blocked).child("다른 세션이 gh 명령이나 git push 를 하는 중이면 누르지 마세요. 되돌리기 전 잠깐 동안 그 세션들이 새 계정을 쓸 수 있습니다."))
        .child(h_flex().pt(4).gap(6)
          .child(this.button(t, "login-go", "시작", (cx) => this.startLogin(cx), { primary: true }))
          .child(this.button(t, "login-no", "취소", (cx) => { this.loginAsk = false; cx.notify(); }))));
    }
    return out;
  }

  // ---- 공통 그리기 ----

  button(t, id, label, onClick, { primary = false, disabled = false } = {}) {
    const off = disabled || this.saving;
    return div().id(id).flex_none().h(26).px(10).rounded(6).flex().items_center().text_size(12)
      .when(primary, (e) => e.bg(t.solid).text_color(t.solid_foreground))
      .when(!primary, (e) => e.border(1).border_color(t.input).bg(t.background).text_color(t.foreground))
      .when(off, (e) => e.opacity(0.5))
      .when(!off, (e) => e.cursor_pointer().hover((s) => s.opacity(0.88)))
      .on_click((_e, cx) => { if (!disabled && !this.saving) onClick(cx); }).child(label);
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

  heading(t, text, first, hint, action) {
    return v_flex().flex_none().px(8).pt(first ? 4 : 14).pb(4).gap(2)
      .when(!first, (el) => el.border_t(1).border_color(t.border).mt(6))
      .child(h_flex().items_center().justify_between()
        .child(div().text_size(13).font_semibold().text_color(t.foreground).child(text))
        .when(Boolean(action), (el) => el.child(action)))
      .when(Boolean(hint), (el) => el.child(div().text_size(11).text_color(t.dim).child(hint)));
  }

  textInput(t, state) {
    return Input.new(state).h(26).px(8).items_center().rounded(6).border(1)
      .border_color(this.focusKey === state ? t.accent : t.input).bg(t.background).text_size(12).text_color(t.foreground);
  }

  // 저장소 한 줄의 계정 설명.
  repoNote(r, owner) {
    if (!r.account) return "매핑 없음 · gh 활성 계정";
    if (r.by === "default") return `${r.account} · 기본 계정`;
    if (r.by === "owner") return `${r.account} · 로그인된 계정의 저장소`;
    if (r.match && r.match.toLowerCase() !== `${owner}/*`.toLowerCase()) return `${r.account} · 규칙 ${r.match}`;
    return r.account;
  }

  // owner 한 줄: 누르면 저장소 목록을 펼치거나 접는다. 드롭다운은 owner/* 규칙을 만들거나 바꾸거나 지운다.
  ownerBlock(t, o) {
    const key = o.owner.toLowerCase();
    const open = this.expanded.has(key);
    const id = `own-${o.owner}`;
    const other = this.personalOther(o);
    return v_flex().flex_none().px(8).py(3).gap(2)
      .child(h_flex().gap(8).items_center()
        .child(h_flex().id(`own-fold-${o.owner}`).flex_1().min_w(0).gap(5).items_center().cursor_pointer()
          .on_click((_e, cx) => { if (open) this.expanded.delete(key); else this.expanded.add(key); cx.notify(); })
          .child(div().w(10).flex_none().text_size(10).text_color(t.dim).child(open ? "▾" : "▸"))
          .child(div().flex_1().min_w(0).truncate().text_size(12.5).text_color(t.foreground).child(`${o.owner}/*`))
          .child(div().flex_none().text_size(11).text_color(t.dim).child(`저장소 ${o.repos.length}`)))
        .child(this.dropdown(t, id, {
          items: this.accountItems("규칙 없음", o.rule), value: o.rule ?? NONE,
          onPick: (v, cx) => this.change(cx, v === NONE ? ["unset", `${o.owner}/*`] : ["set", `${o.owner}/*`, v]),
        })))
      .when(Boolean(other), (el) => el.child(div().pl(15).text_size(11).text_color(t.blocked)
        .child(`주의: ${o.owner} 은(는) 로그인된 계정인데 ${other} 계정을 씁니다. 개인 저장소라면 ${o.owner} 로 고르세요.`)))
      .when(open, (el) => el.children(o.repos.map((r) => h_flex().pl(15).gap(6).items_center().text_size(11)
        .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(r.repo.split("/").pop()))
        .child(div().flex_none().max_w(200).truncate().text_color(r.account ? t.dim : t.idle ?? t.dim).child(this.repoNote(r, o.owner))))));
  }

  // 로그인된 계정과 같은 owner 의 저장소가 다른 계정을 쓰면 그 계정 이름들. 없으면 "".
  personalOther(o) {
    if (!o.personal) return "";
    const own = o.owner.toLowerCase();
    return [...new Set(o.repos.map((r) => r.account).filter((a) => a && a.toLowerCase() !== own))].join(", ");
  }

  // ---- 기본 계정 ----

  // 기본 계정을 account 로 바꾸면: 규칙에 없는 저장소(uses)는 그 계정을 쓰고,
  // 로그인된 다른 계정의 저장소(keeps)는 gh-account 가 default 대신 그 계정을 쓴다. 찾은 저장소로만 계산한다.
  defaultPreview(account) {
    const uses = [], keeps = [];
    const acct = account.toLowerCase();
    for (const o of this.owners) for (const r of o.repos) {
      if (r.by === "rule") continue;
      if (o.personal && o.owner.toLowerCase() !== acct) keeps.push(r.repo);
      else uses.push(r.repo);
    }
    return { account, uses, keeps };
  }

  pickDefault(cx, v) {
    if (v === NONE) { this.defaultAsk = null; this.change(cx, ["default", "none"]); return; }
    this.defaultAsk = this.defaultPreview(v);
    cx.notify();
  }

  defaultCard(t) {
    const a = this.defaultAsk;
    const list = (xs) => xs.length > 6 ? `${xs.slice(0, 6).join(", ")} 외 ${xs.length - 6}개` : xs.join(", ");
    return v_flex().mx(8).my(4).p(8).gap(4).rounded(8).border(1).border_color(t.accent).bg(t.background)
      .child(div().text_size(12.5).font_semibold().text_color(t.foreground).child(`기본 계정을 ${a.account} 로 바꿀까요?`))
      .child(div().text_size(11).text_color(t.muted).child(a.uses.length ? `${a.account} 를 쓰게 될 저장소: ${list(a.uses)}` : "찾은 저장소 중 이 계정을 새로 쓸 저장소는 없습니다."))
      .when(a.keeps.length > 0, (el) => el.child(div().text_size(11).text_color(t.muted).child(`로그인된 계정의 저장소라 그 계정을 그대로 씀: ${list(a.keeps)}`)))
      .child(div().text_size(11).text_color(t.dim).child("규칙에 없는 다른 저장소도 이 계정을 씁니다."))
      .child(h_flex().pt(4).gap(6)
        .child(this.button(t, "default-go", "바꾸기", (cx) => { const v = a.account; this.defaultAsk = null; this.change(cx, ["default", v]); }, { primary: true }))
        .child(this.button(t, "default-cancel", "취소", (cx) => { this.defaultAsk = null; cx.notify(); })));
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
      body.push(this.heading(t, "설치", true, "gh 래퍼, git 자격 증명 도우미, 커밋 신원 설정입니다. 설치해야 아래 규칙이 gh·git 에 쓰입니다."));
      body.push(...this.installBlock(t));

      const items = this.targetItems();
      body.push(this.heading(t, "이 저장소는 어느 계정?", false, "고른 저장소의 gh 명령, git push, 커밋 신원이 쓸 계정을 보여 줍니다."));
      body.push(h_flex().px(8).pb(2).gap(6).items_center()
        .child(this.dropdown(t, "chk-target", { items, value: this.target?.key ?? null, placeholder: items.length ? "스페이스·저장소 고르기" : "열린 저장소 없음", w: 260, menuW: 300,
          onPick: (v, cx) => { const it = items.find((i) => i.value === v); if (it) this.pickTarget(cx, it); } })));
      body.push(h_flex().px(8).pb(4).gap(6).items_center()
        .child(div().flex_1().min_w(0).child(this.textInput(t, this.targetInput)))
        .child(this.button(t, "chk-typed", "확인", (cx) => this.typedTarget(cx), { disabled: this.probing })));
      if (this.probing && !this.result) body.push(div().px(8).pl(16).text_size(11.5).text_color(t.dim).child("확인하는 중…"));
      body.push(...this.resultBlock(t));

      body.push(this.heading(t, "저장소 owner", false, "모든 스페이스 폴더와 그 탭의 터미널 폴더에서 찾은 저장소입니다. owner 마다 쓸 계정을 고르세요. owner 를 누르면 저장소를 펼칩니다."));
      if (this.scanError) body.push(div().px(8).text_size(11).text_color(t.blocked).child(this.scanError));
      else if (!this.owners.length) body.push(div().px(8).text_size(12).text_color(t.dim).child(this.folders.length ? "github.com 원격이 있는 저장소가 없습니다." : "열린 스페이스가 없습니다."));
      for (const o of this.owners) body.push(this.ownerBlock(t, o));

      body.push(this.heading(t, "기본 계정", false, "규칙에 없는 저장소에 씁니다. 없음이면 gh 활성 계정을 그대로 씁니다."));
      body.push(h_flex().px(8).pb(4).child(this.dropdown(t, "default", {
        items: this.accountItems("없음", map?.default), value: map?.default ?? NONE, w: 200,
        onPick: (v, cx) => this.pickDefault(cx, v),
      })));
      if (this.defaultAsk) body.push(this.defaultCard(t));

      const canAdd = !this.login && !this.loginAsk && Boolean(accounts);
      body.push(this.heading(t, "로그인된 계정", false, "gh 활성 계정은 이 패널이 바꾸지 않습니다. 계정 추가만 로그인 직후 원래 계정으로 되돌립니다.",
        this.button(t, "login-add", "계정 추가…", (cx) => { this.loginAsk = true; cx.notify(); }, { disabled: !canAdd })));
      if (!accounts) body.push(div().px(8).text_size(11.5).text_color(t.idle ?? t.dim).child("gh auth status --json 을 읽지 못했습니다(gh 2.60 이상 필요). 터미널에서 gh auth status 로 확인하세요."));
      else if (!accounts.length) body.push(div().px(8).text_size(12).text_color(t.dim).child("gh 에 로그인된 github.com 계정이 없습니다."));
      else for (const a of accounts) {
        body.push(h_flex().px(8).h(24).gap(7).items_center().text_size(12.5)
          .child(div().flex_none().size(7).rounded(4).bg(a.state && a.state !== "success" ? t.blocked : t.working))
          .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(a.login))
          .when(a.active, (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child("gh 활성"))));
      }
      body.push(...this.loginBlock(t));

      const rules = map?.rules ?? [];
      body.push(this.heading(t, "규칙", false, "위에서부터 먼저 맞는 규칙이 이깁니다. owner/repo 규칙은 owner/* 보다 위에 두세요."));
      if (!map) body.push(div().px(8).text_size(11.5).text_color(t.blocked).child("매핑 파일을 읽지 못해 규칙을 보여 줄 수 없습니다."));
      else if (!rules.length) body.push(div().px(8).text_size(12).text_color(t.dim).child("규칙이 없습니다."));
      rules.forEach((r, i) => body.push(this.ruleRow(t, r, i, rules.length)));
      if (map) {
        body.push(h_flex().px(8).pt(6).pb(10).gap(6).items_center()
          .child(div().flex_1().min_w(0).child(this.textInput(t, this.ruleInput)))
          .child(this.dropdown(t, "new-acct", { items: this.accountItems("").slice(2), value: this.newAcct, placeholder: "계정", w: 110,
            onPick: (v, cx) => { this.newAcct = v; cx.notify(); } }))
          .child(this.button(t, "rule-add", "추가", (cx) => this.addRule(cx), { primary: true })));
      }
    }
    return v_flex().size_full().min_h(0).bg(t.chrome).text_size(13)
      .child(h_flex().h(38).px(14).flex_none().items_center().justify_between()
        .child(h_flex().gap(6).items_center()
          .child(div().text_size(15).font_semibold().text_color(t.foreground).child("계정"))
          .child(div().id("acct-refresh").p(3).rounded(5).text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground))
            .on_click((_e, cx) => this.load(cx)).tooltip("새로고침")
            .child(this.busy || this.saving ? svg(ICON("spinner")).size(13).spin(900) : div().text_size(14).child("↻")))))
      .when(this.missing, (el) => el.child(div().px(14).pb(6).text_size(12).text_color(t.idle ?? t.foreground).child(MISSING_HINT)))
      .when(Boolean(this.error), (el) => el.child(div().px(14).pb(6).text_size(11).text_color(t.blocked).max_h(48).overflow_hidden().child(this.error)))
      .when(Boolean(this.note), (el) => el.child(div().px(14).pb(6).text_size(11).text_color(this.note.bad ? t.blocked : t.muted).max_h(64).overflow_hidden().child(this.note.text)))
      .when(!d && !this.error && !this.missing, (el) => el.child(div().px(14).text_size(12).text_color(t.dim).child("불러오는 중…")))
      .child(v_flex().id("acct-list").flex_1().min_h(0).px(4).overflow_y_scrollbar().mode("always").children(body));
  }
}
