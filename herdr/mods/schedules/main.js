// 예약: Claude·Codex 작업을 정해 둔 시각에 새 세션으로 띄우는 예약(Orca 자동화 수준)의 화면.
// 한 모드가 두 얼굴을 가진다.
//  - 오른쪽 패널(props 없음): 예약 목록·기록. 좁은 화면이라 만들기·편집은 가운데 대화상자로 연다.
//  - 대화상자(props.mode === "dialog"): 예약 만들기·편집. 선택지가 정해진 칸은 전부 드롭다운이다.
// 화면만 맡는다. 시간 계산·저장·실행은 모두 schedules.cjs(도우미)가 하고, 이 모드는 exec로 부른다.
// 30초마다 도는 tick은 항상 화면에 있는 tabs-mine이 부른다(이 패널은 오른쪽 패널이라 안 보일 때가 있다).
// Herdr 앱이 켜져 있을 때만 예약이 돈다.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, TextareaState, Textarea, Popover } from "gpui-base";
import { theme, exec, appHome, checking, run, agents, terminals, spaces, props, openOverlay, closeOverlay, setShared, shared, nextCommand } from "herdr";

const HELPER = () => `${appHome()}/mods/schedules/schedules.cjs`;
const ICON = (name) => `mods/workspace-chrome/${name}.svg`;
const CLOSE_ICON = "mods/pane/close.svg";
const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];
const WEEKDAY_LONG = ["일요일", "월요일", "화요일", "수요일", "목요일", "금요일", "토요일"];
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];
const KINDS = [["hourly", "매시간"], ["daily", "매일"], ["weekdays", "평일"], ["weekly", "매주"], ["cron", "사용자 지정 cron"], ["rrule", "사용자 지정 RRULE"]];
// Herdr 테마의 상태색 뜻 그대로: 일하는 중=working(노랑), 끝남=done(파랑), 막힘·실패=blocked(빨강).
const STATUS_COLOR = { "실행 중": "working", "완료": "done", "입력 대기": "blocked", "실패": "blocked", "검사로 건너뜀": "dim", "놓침": "dim" };
const RETRY_STATUS = new Set(["실패", "입력 대기"]);
const ATTENTION_STATUS = new Set(["실패", "입력 대기", "놓침"]);
const ON_TIME_MS = 2 * 60000; // schedules.cjs와 같은 값: 이보다 늦게 시작하면 "예정 → 실행"을 보여 준다
// Claude CLI가 받는 이름·강도. Codex는 ~/.codex/models_cache.json에서 도우미가 읽어 준다(options).
const CLAUDE_MODELS = ["fable", "opus", "sonnet", "haiku"];
const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const CODEX_EFFORTS = ["low", "medium", "high", "xhigh"];
const ZONES = ["Asia/Seoul", "UTC", "America/Los_Angeles", "America/New_York", "Europe/London", "Europe/Paris", "Europe/Berlin", "Asia/Tokyo", "Asia/Shanghai", "Asia/Singapore", "America/Chicago", "Australia/Sydney"];
const GRACES = [0, 30, 60, 180, 720, 1440, 2880];
const NEW_GRACE = 720;
// 알림 방식(저장 값은 off | problems | all, 없으면 problems).
const NOTIFY_OPTIONS = [{ value: "off", label: "끄기" }, { value: "problems", label: "문제만 (실패·입력 대기·놓침)" }, { value: "all", label: "모두 (완료 포함)" }];
const TOAST_MS = 3000; // 알림 줄은 이만큼 뒤에 저절로 사라진다(오류는 눌러서 닫을 때까지, 화면을 바꾸면 사라짐)
const PRECHECK_SECS = [30, 60, 120, 300, 600];
const MINUTES = Array.from({ length: 12 }, (_, i) => i * 5);
const CUSTOM = "__custom__";
const NUMERIC = new Set(["weekday", "hour12", "minute", "grace", "precheckSec"]);
// 일정과 상관없는 오류(이름·프롬프트 비어 있음 등)는 저장을 눌러 보기 전에는 띄우지 않는다.
const SCHEDULE_ERR = /반복|cron|RRULE|FREQ|INTERVAL|BY|프리셋|시각|요일|시간대|칸/;
const SAVE_NOTE = "Herdr가 켜져 있을 때 저장한 일정대로 실행됩니다.";

// 예약 정보를 base64(UTF-8)로 넘긴다: exec에는 표준 입력이 없고, 프롬프트에는 줄바꿈·따옴표가 들어간다.
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function toBase64(text) {
  const bytes = [];
  const enc = encodeURIComponent(text);
  for (let i = 0; i < enc.length; i++) {
    if (enc[i] === "%") { bytes.push(parseInt(enc.slice(i + 1, i + 3), 16)); i += 2; } else bytes.push(enc.charCodeAt(i));
  }
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const [a, b, c] = [bytes[i], bytes[i + 1], bytes[i + 2]];
    out += B64[a >> 2] + B64[((a & 3) << 4) | ((b ?? 0) >> 4)] + (b === undefined ? "=" : B64[((b & 15) << 2) | ((c ?? 0) >> 6)]) + (c === undefined ? "=" : B64[c & 63]);
  }
  return out;
}

const pad = (n) => String(n).padStart(2, "0");
function when(ms) {
  if (!Number.isFinite(ms)) return "-";
  const d = new Date(ms), now = new Date();
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (d.toDateString() === now.toDateString()) return `오늘 ${hm}`;
  return `${d.getMonth() + 1}/${d.getDate()}(${WEEKDAYS[d.getDay()]}) ${hm}`;
}
function ago(ms) {
  const m = Math.floor((Date.now() - ms) / 60000);
  if (!(m >= 0)) return "";
  if (m < 1) return "방금";
  if (m < 60) return `${m}분 전`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}시간 전` : `${Math.floor(h / 24)}일 전`;
}
// 시계만("14:07"). 기준 시각과 날짜가 다르면 "11/18 14:07".
function clock(ms, ref) {
  if (!Number.isFinite(ms)) return "-";
  const d = new Date(ms);
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (Number.isFinite(ref) && new Date(ref).toDateString() === d.toDateString()) return hm;
  return `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}
// 목록의 "마지막" 줄이 가리키는 시각: 놓침·건너뜀은 예정 시각, 나머지는 끝난(멈춘) 시각, 없으면 시작 시각. 옛 기록도 받는다.
function lastAt(r) {
  if ((r.status === "놓침" || r.status === "검사로 건너뜀") && Number.isFinite(r.scheduledAt)) return r.scheduledAt;
  return [r.finishedAt, r.startedAt, r.scheduledAt].find((v) => Number.isFinite(v));
}
// 기록 한 줄의 둘째 줄: "예정 09:00 → 실행 10:12 · 실패 14:07" 꼴. 없는 시각은 건너뛴다.
function timeLine(r) {
  const ref = Number.isFinite(r.scheduledAt) ? r.scheduledAt : r.startedAt;
  const parts = [];
  if (r.status === "놓침") {
    parts.push(`놓침 (확인 ${clock(r.finishedAt ?? r.startedAt, ref)})`);
    return parts.join(" · ");
  }
  if (Number.isFinite(r.scheduledAt) && Number.isFinite(r.startedAt) && r.startedAt - r.scheduledAt > ON_TIME_MS) parts.push(`예정 ${clock(r.scheduledAt, r.startedAt)} → 실행 ${clock(r.startedAt, r.scheduledAt)}`);
  if (r.status === "실행 중") { if (!parts.length && Number.isFinite(r.startedAt)) parts.push(`시작 ${clock(r.startedAt, ref)}`); }
  else if (r.status !== "검사로 건너뜀" || Number.isFinite(r.finishedAt)) { const end = r.finishedAt; if (Number.isFinite(end)) parts.push(`${r.status} ${clock(end, ref)}`); }
  return parts.join(" · ");
}
// 기록 요약: 최근 24시간·7일의 성공(완료)/실패(실패·입력 대기) 수.
function summarize(hist, now = Date.now()) {
  const out = { d1: { ok: 0, fail: 0 }, d7: { ok: 0, fail: 0 } };
  for (const r of hist ?? []) {
    const at = lastAt(r);
    if (!Number.isFinite(at)) continue;
    const key = r.status === "완료" ? "ok" : r.status === "실패" || r.status === "입력 대기" ? "fail" : null;
    if (!key) continue;
    if (now - at <= 86400000) out.d1[key]++;
    if (now - at <= 7 * 86400000) out.d7[key]++;
  }
  return out;
}
const base = (p) => String(p ?? "").split(/[\\/]/).filter(Boolean).pop() ?? "";
// 드롭다운 힌트는 경로 앞이 아니라 상위 폴더 끝 두 칸(…/disk/projects)만 보인다. 앞부분은 거의 같아서 잘리면 구분이 안 된다.
const parentHint = (p) => {
  const parts = p.split(/[\\/]+/).filter(Boolean).slice(0, -1);
  return parts.length > 2 ? `…/${parts.slice(-2).join("/")}` : `/${parts.join("/")}`;
};
const graceLabel = (m) => (m === 0 ? "유예 없음" : m % 60 === 0 ? `${m / 60}시간` : `${m}분`);
const secLabel = (s) => (s % 60 === 0 ? `${s / 60}분` : `${s}초`);
const hour12Of = (h) => h % 12 || 12;

// 목록에 없는 현재 값도 드롭다운에 그대로 보이게 덧붙인다(옛 값·직접 쓴 값을 잃지 않으려고).
function withCurrent(items, value, label, sort = false) {
  if (value === undefined || value === null || value === "" || items.some((i) => i.value === value)) return items;
  const out = [...items, { value, label: label(value) }];
  return sort ? out.sort((a, b) => a.value - b.value) : out;
}

// 도우미 호출. 실패해도 JSON 한 줄을 stdout에 내므로 종료 코드와 상관없이 마지막 줄을 읽는다.
async function helper(args, timeout = 30000) {
  try {
    const r = await exec("node", [HELPER(), ...args], { timeout });
    const line = String(r.stdout ?? "").trim().split("\n").pop();
    try { return JSON.parse(line); } catch { return { ok: false, error: `도우미 응답을 읽지 못했습니다. ${String(r.stderr || line || "").trim().slice(0, 160)}` }; }
  } catch (e) {
    return { ok: false, error: `도우미를 실행하지 못했습니다(node가 설치돼 있나요?): ${String(e?.message ?? e).slice(0, 160)}` };
  }
}

function safeProps() { try { return props() ?? {}; } catch { return {}; } }

export default class Schedules extends View {
  init(_props, cx) {
    const p = safeProps();
    this.dialog = p.mode === "dialog";
    this.dd = null; // 열려 있는 드롭다운의 id(한 번에 하나)
    this.msg = null; // {text, error, id}: 화면 한 곳에서만 보이고 3초 뒤(오류는 화면을 바꿀 때) 사라진다
    this.msgSeq = 0;
    this.localZone = p.localZone ?? "";
    // 패널
    this.screen = "list"; // list | history
    this.items = null;
    this.confirmDelete = null;
    this.repo = null; // 기록 저장소 상태({repo, name, emailOk, emailBlock, emailFix, error}). 없으면 아직 못 읽음
    this.repoCustom = false; // "다른 폴더…"로 직접 쓰는 중
    this.repoInput = null;
    this.syncBusy = false;
    this.syncAsk = null; // 사용자 확인이 필요한 기록·불러오기: {kind: "public"|"import", ...}
    this.histId = null;
    this.hist = [];
    this.busy = false;
    this.rev = null;
    // 대화상자
    this.f = null;
    this.opts = null;
    this.preview = null;
    this.tried = false;
    this.saving = false;
    this.seq = 0;
    this.optSeq = 0;
    this.tick = 0;
    if (checking()) return;
    if (this.dialog) this.initDialog(p, cx);
    else {
      this.repoInput = this.input("", "/path/to/notes-repo");
      this.loadRepo(cx);
      this.reload(cx);
      this.rev = shared("schedules.done")?.at ?? null;
      cx.timer.every(8000, (cx) => this.reload(cx));
      // 대화상자에서 저장하면 setShared로 알린다: 8초를 기다리지 않고 바로 다시 읽는다.
      cx.timer.every(1000, (cx) => {
        // shared()는 부를 때마다 새 객체를 줄 수 있어 객체 자체가 아니라 저장 시각(at)으로 바뀜을 판단한다.
        const d = shared("schedules.done") ?? null;
        const at = d?.at ?? null;
        if (at === this.rev) return;
        this.rev = at;
        if (d?.name) this.setMsg(cx, `"${d.name}"을(를) 저장했습니다.`);
        this.busy = false;
        this.reload(cx);
      });
    }
    this.listen(cx);
  }

  // 키 명령(`<mod>.<command>`)과 화면 확인용 명령. keys.json이나 `herdr-app do schedules.<명령>`으로 보낸다.
  listen(cx) {
    cx.spawn(async (cx) => {
      for (;;) {
        const c = String(await nextCommand());
        try { this.command(c, cx); } catch (e) { console.log(`schedules command ${c}: ${e?.message ?? e}`); }
        cx.notify();
      }
    });
  }

  command(c, cx) {
    const i = c.indexOf(":");
    const name = i < 0 ? c : c.slice(0, i);
    const arg = i < 0 ? "" : c.slice(i + 1);
    if (this.dialog) {
      if (!this.f) return;
      if (name === "dd") this.dd = arg || null;
      else if (name === "set") {
        const j = arg.indexOf(":");
        const key = j < 0 ? arg : arg.slice(0, j);
        const raw = j < 0 ? "" : arg.slice(j + 1);
        this.pick(key, NUMERIC.has(key) ? Number(raw) : raw === "true" ? true : raw === "false" ? false : raw, cx);
      } else if (name === "close") this.close();
      return;
    }
    const find = () => (this.items ?? []).find((x) => x.id === arg || x.name === arg) ?? (this.items ?? [])[Number(arg) || 0];
    if (name === "new") this.openDialog(null, cx);
    else if (name === "edit") { const a = find(); if (a) this.openDialog(a, cx); }
    else if (name === "menu") { const a = arg ? find() : null; this.dd = a ? `more-${a.id}` : null; }
    else if (name === "history") { const a = find(); if (a) this.openHistory(a, cx); }
    else if (name === "list") { this.screen = "list"; this.histId = null; this.dd = null; this.msg = null; }
  }

  // ---- 패널: 읽기·동작
  reload(cx) {
    if (this.busy) return;
    this.busy = true;
    cx.spawn(async (cx) => {
      try {
        const d = await helper(["list"]);
        if (d.ok) { this.items = d.automations; this.localZone = d.timezone; if (this.msg?.stale) this.msg = null; }
        else if (!this.items) this.msg = { text: d.error, error: true, stale: true, id: ++this.msgSeq };
        if (this.screen === "history" && this.histId) {
          const h = await helper(["runs", this.histId]);
          if (h.ok) this.hist = h.runs;
        }
      } finally { this.busy = false; cx.notify(); }
    });
  }

  // 알림 줄을 띄운다. 일반 알림은 3초 뒤 저절로 사라지고, 오류는 눌러 닫거나 화면을 바꿀 때까지 둔다.
  setMsg(cx, text, error = false) {
    const id = ++this.msgSeq;
    this.msg = { text, error, id };
    if (!error) cx.timer.after(TOAST_MS, (cx) => { if (this.msg && this.msg.id === id) { this.msg = null; cx.notify(); } });
  }
  say(cx, text, error = false) { this.setMsg(cx, text, error); cx.notify(); }

  // ---- 패널: 문서 저장소에 기록·불러오기
  loadRepo(cx) {
    cx.spawn(async (cx) => { const d = await helper(["repo"]); this.repo = d.ok ? d : { repo: null, error: d.error }; cx.notify(); });
  }

  setRepo(dir, cx) {
    if (!dir) return;
    cx.spawn(async (cx) => {
      const d = await helper(["repo-set", dir]);
      if (d.ok) { this.repo = d; this.repoCustom = false; this.syncAsk = null; this.say(cx, `기록 저장소를 "${d.name}"(으)로 정했습니다.${d.emailBlock ? " 이 저장소의 커밋 이메일이 noreply가 아니라 기록하려면 먼저 바꿔야 합니다." : ""}`, Boolean(d.emailBlock)); }
      else this.say(cx, d.error || "저장소를 정하지 못했습니다.", true);
    });
  }

  // 기록 저장소 후보: 열려 있는 작업 공간 폴더와 예약에 쓰는 폴더(모두 이 PC에 실제로 있는 폴더).
  knownFolders() {
    const out = [];
    for (const s of spaces() ?? []) if (!s.machine && s.folder) out.push(s.folder);
    for (const a of this.items ?? []) if (a.folder?.path) out.push(a.folder.path);
    return [...new Set(out)];
  }

  repoItems() {
    const list = this.knownFolders();
    if (this.repo?.repo && !list.includes(this.repo.repo)) list.unshift(this.repo.repo);
    return [...list.map((p) => ({ value: p, label: base(p) || p, hint: parentHint(p) })), { sep: true }, { value: CUSTOM, label: "다른 폴더…" }];
  }

  // 한 개(id) 또는 전부(--all)를 기록한다. 공개·확인 못 한 저장소는 한 번 더 묻고, push가 막히면 이유를 그대로 보여 준다.
  record(args, cx, confirmPublic = false) {
    if (this.syncBusy) return;
    this.syncBusy = true;
    this.syncAsk = null;
    cx.notify();
    cx.spawn(async (cx) => {
      const d = await helper(["record", ...args, ...(confirmPublic ? ["--confirm-public"] : [])], 180000);
      this.syncBusy = false;
      if (d.needsConfirm) this.syncAsk = { kind: "public", args, text: d.error };
      else if (d.ok) this.setMsg(cx, d.changed === false ? "저장소의 기록과 같아서 바뀐 것이 없습니다." : `${d.count}개를 저장소에 기록하고 push했습니다.`);
      else this.setMsg(cx, d.error || "기록하지 못했습니다.", true);
      cx.notify();
    });
  }

  // 새 PC 복원: 아직 없는 예약만 꺼진 채 추가한다. 사전 확인 명령이 있으면 명령을 보여 주고 확인을 받는다(가져올 때 실행하지 않는다).
  importRepo(cx, ack = false) {
    if (this.syncBusy) return;
    this.syncBusy = true;
    this.syncAsk = null;
    cx.notify();
    cx.spawn(async (cx) => {
      const d = await helper(["import", "--folders", toBase64(JSON.stringify(this.knownFolders())), ...(ack ? ["--ack"] : [])], 60000);
      this.syncBusy = false;
      if (d.needsConfirm) this.syncAsk = { kind: "import", commands: d.needsConfirm };
      else if (d.ok) {
        const extra = [d.unlinked?.length ? `작업 폴더를 다시 골라야 켤 수 있습니다: ${d.unlinked.join(", ")}` : "", d.skipped?.length ? `건너뜀 ${d.skipped.length}개(${d.skipped[0].reason})` : ""].filter(Boolean).join(" · ");
        this.setMsg(cx, d.added ? `${d.added}개를 꺼진 상태로 불러왔습니다.${extra ? ` ${extra}` : ""}` : `새로 불러올 예약이 없습니다(이미 ${d.existing}개 있음).${extra ? ` ${extra}` : ""}`, Boolean(d.skipped?.length) && !d.added);
        this.busy = false;
        this.reload(cx);
      } else this.setMsg(cx, d.error || "불러오지 못했습니다.", true);
      cx.notify();
    });
  }

  runNow(a, cx) {
    cx.spawn(async (cx) => {
      const d = await helper(["run", a.id, "--manual"]);
      this.say(cx, d.ok ? `"${a.name}" 실행을 시작했습니다.` : d.error || "실행하지 못했습니다.", !d.ok);
      cx.timer.after(1500, (cx) => this.reload(cx));
    });
  }

  setEnabled(a, on, cx) {
    cx.spawn(async (cx) => {
      const d = await helper(["toggle", a.id, on ? "on" : "off"]);
      if (!d.ok) this.say(cx, d.error || "바꾸지 못했습니다.", true);
      this.busy = false;
      this.reload(cx);
    });
  }

  remove(a, cx) {
    this.confirmDelete = null;
    cx.spawn(async (cx) => {
      const d = await helper(["delete", a.id]);
      this.say(cx, d.ok ? `"${a.name}"을(를) 삭제했습니다.` : d.error || "삭제하지 못했습니다.", !d.ok);
      this.busy = false;
      this.reload(cx);
    });
  }

  openHistory(a, cx) {
    this.msg = null;
    this.screen = "history";
    this.histId = a.id;
    this.hist = [];
    this.busy = false;
    cx.notify();
    this.reload(cx);
  }

  // 기록의 터미널: 화면에 칸이 있으면 그 칸으로, 없으면 터미널을 위에 띄워 본다.
  openTerminal(r) {
    if (!r.terminal) return;
    const a = (agents() ?? []).find((x) => x.address === r.terminal);
    try { run(a?.pane ? "pane.focus" : "terminal.peek", a?.pane ? { pane: a.pane } : { terminal: r.terminal }); } catch {}
  }
  alive(r) { return Boolean(r.terminal) && (terminals() ?? []).some((t) => t.address === r.terminal); }

  // 만들기·편집은 가운데 대화상자로 연다(오른쪽 패널은 좁다).
  openDialog(a, cx) {
    const now = Date.now();
    if (now - (this.openedAt ?? 0) < 700) return; // 더블클릭으로 두 개 뜨는 것을 막는다
    this.openedAt = now;
    this.dd = null;
    try {
      openOverlay({ mod: "schedules", kind: "dialog", modal: true, width: 940, height: 0.9, props: { mode: "dialog", edit: a ?? null, localZone: this.localZone } });
    } catch (e) { this.say(cx, `대화상자를 열지 못했습니다: ${String(e?.message ?? e).slice(0, 120)}`, true); }
  }

  // ---- 대화상자: 상태
  input(value, placeholder, onChange) {
    const s = InputState.new({ value: value ?? "", placeholder });
    s.on("focus", (_e, cx) => { this.focusKey = s; cx.notify(); });
    s.on("blur", (_e, cx) => { if (this.focusKey === s) this.focusKey = null; cx.notify(); });
    if (onChange) s.on("change", (_e, cx) => onChange(cx));
    return s;
  }

  defaultFolder() {
    const list = (spaces() ?? []).filter((s) => !s.machine && s.folder);
    return (list.find((s) => s.active) ?? list[0])?.folder ?? "";
  }

  initDialog(p, cx) {
    const a = p.edit ?? null;
    this.editing = a;
    const s = a?.schedule ?? { kind: "preset", preset: "daily", time: "09:00" };
    const [hh, mm] = String(s.time ?? "09:00").split(":").map((x) => Number.parseInt(x, 10));
    const live = (c) => this.later(c);
    const lateIfTried = (c) => { if (this.tried) this.later(c); };
    this.f = {
      program: a?.program ?? "claude",
      model: a?.model ?? "",
      effort: a?.effort ?? "",
      kind: s.kind === "preset" ? s.preset : s.kind,
      weekday: Number(s.weekday ?? 1),
      hour: Number.isFinite(hh) ? hh : 9,
      minute: Number.isFinite(mm) ? mm : 0,
      tz: a?.timezone && a.timezone !== this.localZone ? a.timezone : "", // 비어 있으면 이 PC
      grace: a ? a.graceMinutes ?? 60 : NEW_GRACE,
      notify: a?.notify ?? "problems",
      precheckSec: a?.precheck?.timeoutSec ?? 60,
      folderMode: a?.folder?.mode ?? "existing",
      path: a?.folder?.path ?? this.defaultFolder(),
      pathMode: "pick", // pick | custom
      base: a?.folder?.base ?? "",
      reuse: Boolean(a?.reuseSession),
      enabled: a ? a.enabled : true,
      name: this.input(a?.name, "예약 이름 (예: 금요일 주간 보고)", lateIfTried),
      prompt: TextareaState.new({ value: a?.prompt ?? "", placeholder: "에이전트에게 보낼 프롬프트를 적으세요.", rows: 10 }),
      precheck: TextareaState.new({ value: a?.precheck?.command ?? "", placeholder: "예정 실행 전에 돌릴 명령 (선택)", rows: 3 }),
      cron: this.input(s.cron ?? "", "분 시 일 월 요일 (예: 0 17 * * 5)", live),
      rrule: this.input(s.rrule ?? "", "FREQ=WEEKLY;BYDAY=FR;BYHOUR=17;BYMINUTE=0", live),
      pathInput: this.input("", "/path/to/project", live),
    };
    this.f.prompt.on("change", (_e, c) => lateIfTried(c));
    this.f.precheck.on("change", (_e, c) => lateIfTried(c));
    this.f.pathInput.on("blur", (_e, c) => { this.f.path = this.f.pathInput.value().trim(); this.loadOptions(c); });
    this.loadOptions(cx);
    this.check(cx);
  }

  curPath() {
    const f = this.f;
    return (f.pathMode === "custom" ? f.pathInput.value() : f.path).trim();
  }

  // 모델 목록(Codex)·저장소 브랜치·최근 폴더를 도우미에서 읽는다.
  loadOptions(cx) {
    if (!this.f) return;
    const path = this.curPath();
    const seq = ++this.optSeq;
    cx.spawn(async (cx) => {
      const d = await helper(["options", ...(path ? ["--path", path] : [])], 20000);
      if (seq !== this.optSeq || !this.f) return;
      if (d.ok) this.opts = d;
      cx.notify();
    });
  }

  // 입력이 멈춘 뒤에 한 번만 검사한다.
  later(cx) {
    const n = ++this.tick;
    cx.timer.after(500, (cx) => { if (n === this.tick && this.f) this.check(cx); });
  }

  close() {
    const f = this.f;
    this.f = null;
    try { closeOverlay(safeProps().overlay); } catch {}
    if (f) for (const v of Object.values(f)) { try { if (v && typeof v === "object" && typeof v.release === "function") v.release(); } catch {} }
  }

  // ---- 대화상자: 선택지
  modelItems() {
    const f = this.f;
    const def = { value: "", label: "기본값" };
    if (f.program === "claude") return withCurrent([def, ...CLAUDE_MODELS.map((m) => ({ value: m, label: m }))], f.model, (m) => m);
    const models = this.opts?.codex?.models ?? [];
    return withCurrent([def, ...models.map((m) => ({ value: m.slug, label: m.name || m.slug, hint: m.name && m.name !== m.slug ? m.slug : undefined }))], f.model, (m) => m);
  }

  effortList() {
    const f = this.f;
    if (f.program === "claude") return CLAUDE_EFFORTS;
    const m = (this.opts?.codex?.models ?? []).find((x) => x.slug === f.model);
    return m?.efforts?.length ? m.efforts : this.opts?.codex?.efforts ?? CODEX_EFFORTS;
  }

  effortItems() {
    return withCurrent([{ value: "", label: "기본값" }, ...this.effortList().map((e) => ({ value: e, label: e }))], this.f.effort, (e) => e);
  }

  folderItems() {
    const f = this.f;
    const seen = new Set();
    const items = [];
    const add = (path, label) => { if (path && !seen.has(path)) { seen.add(path); items.push({ value: path, label: label || base(path) || path, hint: parentHint(path) }); } };
    for (const s of spaces() ?? []) if (!s.machine) add(s.folder, base(s.folder) || s.name);
    for (const p of this.opts?.folders ?? []) add(p);
    add(f.path); // 목록에 없는 현재 폴더도 그대로 보인다
    items.push({ sep: true });
    items.push({ value: CUSTOM, label: "다른 폴더…" });
    return items;
  }

  branchItems() {
    const f = this.f, o = this.opts;
    const def = o?.defaultBranch ? `저장소 기본 브랜치 (${o.defaultBranch})` : "저장소 기본 브랜치";
    return withCurrent([{ value: "", label: def }, ...(o?.branches ?? []).map((b) => ({ value: b, label: b }))], f.base, (b) => b);
  }

  zoneItems() {
    const f = this.f;
    const zones = ZONES.filter((z) => z !== this.localZone);
    return withCurrent([{ value: "", label: `이 PC (${this.localZone || "시스템"})` }, ...zones.map((z) => ({ value: z, label: z }))], f.tz, (z) => z);
  }

  // 값을 바꾸는 단 하나의 길: 드롭다운·분할 버튼·화면 확인 명령이 모두 여기를 지난다.
  pick(k, v, cx) {
    const f = this.f;
    if (!f) return;
    if (k === "program") { if (f.program !== v) { f.program = v; f.model = ""; f.effort = ""; } }
    else if (k === "model") { f.model = v; if (f.effort && !this.effortList().includes(f.effort)) f.effort = ""; } // 못 쓰는 강도는 기본값으로 (withCurrent가 현재 값을 되살리므로 원본 목록으로 비교)
    else if (k === "folderMode") { f.folderMode = v; if (v === "worktree") f.reuse = false; }
    else if (k === "path") {
      if (v === CUSTOM) { f.pathMode = "custom"; f.pathInput.set_value(f.path); }
      else { f.pathMode = "pick"; f.path = v; f.base = ""; }
      this.opts = this.opts ? { ...this.opts, branches: [], defaultBranch: "" } : this.opts;
      this.loadOptions(cx);
    }
    else if (k === "hour12") f.hour = (Number(v) % 12) + (f.hour >= 12 ? 12 : 0);
    else if (k === "ampm") f.hour = (f.hour % 12) + (v === "pm" ? 12 : 0);
    else if (f[k] && typeof f[k] === "object" && typeof f[k].set_value === "function") f[k].set_value(String(v));
    else f[k] = v;
    this.dd = null;
    this.check(cx);
    cx.notify();
  }

  spec() {
    const f = this.f;
    let schedule;
    if (f.kind === "cron") schedule = { kind: "cron", cron: f.cron.value().trim() };
    else if (f.kind === "rrule") schedule = { kind: "rrule", rrule: f.rrule.value().trim() };
    else {
      schedule = { kind: "preset", preset: f.kind, time: `${pad(f.hour)}:${pad(f.minute)}` };
      if (f.kind === "weekly") schedule.weekday = f.weekday;
    }
    const path = this.curPath();
    const command = f.precheck.value().trim();
    const spec = {
      name: f.name.value().trim(), enabled: f.enabled, program: f.program, prompt: f.prompt.value(),
      model: f.model, effort: f.effort, schedule, timezone: f.tz || undefined,
      graceMinutes: f.grace,
      notify: f.notify,
      precheck: command ? { command, timeoutSec: f.precheckSec } : null,
      folder: f.folderMode === "worktree" && f.base ? { mode: f.folderMode, path, base: f.base } : { mode: f.folderMode, path },
      reuseSession: f.folderMode === "existing" && f.reuse,
    };
    if (this.editing) { spec.id = this.editing.id; spec.createdAt = this.editing.createdAt; }
    return spec;
  }

  check(cx) {
    if (!this.f) return;
    const seq = ++this.seq;
    const spec = this.spec();
    cx.spawn(async (cx) => {
      const d = await helper(["validate", "--b64", toBase64(JSON.stringify(spec))], 15000);
      if (seq !== this.seq || !this.f) return;
      this.preview = d.ok === undefined ? { errors: [d.error || "검사하지 못했습니다."], next: [] } : { errors: d.errors ?? [], next: d.next ?? [], summary: d.summary };
      cx.notify();
    });
  }

  save(cx) {
    if (!this.f || this.saving) return;
    this.saving = true;
    this.tried = true;
    const spec = this.spec();
    cx.spawn(async (cx) => {
      const d = await helper(["save", "--b64", toBase64(JSON.stringify(spec))]);
      this.saving = false;
      if (!this.f) return;
      if (!d.ok) { this.seq++; this.preview = { errors: d.errors ?? [d.error || "저장하지 못했습니다."], next: [] }; cx.notify(); return; }
      setShared("schedules.done", { at: Date.now(), name: d.automation.name });
      this.close();
    });
  }

  // ---- 그리기 공통
  tag(t, text, color) {
    return div().flex_none().px(6).h(17).rounded(5).bg((t[color] ?? t.dim) + "26").text_size(10.5).text_color(t[color] ?? t.dim).flex().items_center().child(text);
  }

  button(t, id, label, onClick, { primary = false, danger = false, disabled = false, big = false } = {}) {
    const el = div().id(id).flex_none().h(big ? 32 : 24).px(big ? 16 : 9).rounded(6).flex().items_center().justify_center().text_size(big ? 13 : 11.5).cursor_pointer()
      .when(primary, (e) => e.bg(t.solid).text_color(t.solid_foreground).hover((s) => s.opacity(0.88)))
      .when(!primary, (e) => e.border(1).border_color(t.border).text_color(danger ? t.blocked : t.muted).hover((s) => s.bg(t.hover).text_color(danger ? t.blocked : t.foreground)))
      .on_click((_e, cx) => { if (!disabled) onClick(cx); });
    return el.when(disabled, (e) => e.opacity(0.4)).child(label);
  }

  // 켜짐 스위치(목록·대화상자 공용).
  toggle(t, id, on, onToggle, tip) {
    return div().id(id).flex_none().w(30).h(18).rounded(9).cursor_pointer().bg(on ? t.working : t.raised).border(1).border_color(on ? t.working : t.border)
      .flex().items_center().when(on, (el) => el.justify_end()).px(2)
      .on_click((_e, cx) => onToggle(!on, cx))
      .tooltip(tip ?? (on ? "켜짐 (눌러서 끄기)" : "꺼짐 (눌러서 켜기)"))
      .child(div().size(12).rounded(6).bg(on ? t.solid_foreground ?? "#fff" : t.dim));
  }

  // 모든 선택칸이 쓰는 드롭다운 하나: 트리거(현재 값 + 쉐브론) → 눌러 목록 → 고르면 닫힘. 바깥 클릭·Esc는 Popover가 닫는다.
  dropdown(t, id, { items, value, onPick, menuW = 240, placeholder = "", anchor = "top_left", disabled = false }) {
    const open = this.dd === id && !disabled;
    const cur = items.find((i) => !i.sep && i.value === value);
    const trigger = h_flex().id(`${id}-btn`).h(30).px(9).gap(6).items_center().rounded(6).border(1)
      .border_color(open ? t.accent : t.input).bg(t.background).text_size(12.5).text_color(t.foreground).cursor_pointer()
      .when(disabled, (e) => e.opacity(0.45))
      .child(div().flex_1().min_w(0).truncate().text_color(cur ? t.foreground : t.dim).child(cur ? cur.label : placeholder))
      .child(svg(ICON("chevron-down")).size(12).flex_none().text_color(t.dim));
    const rows = items.map((it, i) => {
      if (it.sep) return div().flex_none().h(1).my(4).bg(t.border);
      const on = it.value === value;
      return h_flex().id(`${id}-i${i}`).flex_none().min_h(28).px(8).gap(8).items_center().rounded(5).cursor_pointer()
        .text_size(12.5).text_color(t.foreground).hover((s) => s.bg(t.hover)).when(on, (e) => e.bg(t.selected))
        .on_click((_e, cx) => onPick(it.value, cx))
        .child(div().w(14).flex_none().flex().items_center().when(on, (e) => e.child(svg(ICON("check")).size(12))))
        .child(div().flex_1().min_w(0).truncate().child(it.label))
        .when(Boolean(it.hint), (e) => e.child(div().flex_none().max_w(menuW * 0.5).truncate().text_size(11).text_color(t.dim).child(it.hint)));
    });
    const content = v_flex().id(`${id}-menu`).w(menuW).max_h(368).overflow_y_scrollbar().p(4).gap(1).rounded(8).border(1).border_color(t.border)
      .bg(t.popover ?? t.raised).shadow_lg().children(rows);
    return Popover.new(`${id}-pop`).anchor(anchor).open(open)
      .on_open_change((o, cx) => { if (disabled) return; this.dd = o ? id : this.dd === id ? null : this.dd; cx.notify(); })
      .trigger(trigger).content(content);
  }

  // 두세 개 중 하나를 고르는 분할 버튼.
  segmented(t, id, options, value, onPick) {
    return h_flex().flex_none().p(2).gap(2).rounded(7).bg(t.raised).border(1).border_color(t.border)
      .children(options.map((o, i) => {
        const on = o.value === value;
        return div().id(`${id}-${i}`).flex_1().h(26).rounded(5).flex().items_center().justify_center().text_size(12)
          .when(on, (e) => e.bg(t.selected).text_color(t.foreground).font_semibold())
          .when(!on, (e) => e.text_color(t.muted))
          .when(o.disabled, (e) => e.opacity(0.4))
          .when(!o.disabled, (e) => e.cursor_pointer().when(!on, (x) => x.hover((s) => s.bg(t.hover))).on_click((_e, cx) => onPick(o.value, cx)))
          .child(o.label);
      }));
  }

  field(t, label, ...els) {
    return v_flex().flex_none().gap(5)
      .child(div().text_size(11.5).font_semibold().text_color(t.muted).child(label))
      .children(els.filter(Boolean));
  }

  note(t, text, color) {
    return div().flex_none().text_size(11).text_color(color ?? t.dim).child(text);
  }

  // ---- 대화상자: 화면
  scheduleControls(t) {
    const f = this.f;
    const dd = (id, items, value, k, menuW) => this.dropdown(t, id, { items, value, menuW, onPick: (v, cx) => this.pick(k, v, cx) });
    const minutes = withCurrent(MINUTES.map((m) => ({ value: m, label: pad(m) })), f.minute, pad, true);
    const hours = Array.from({ length: 12 }, (_, i) => ({ value: i + 1, label: String(i + 1) }));
    const pm = f.hour >= 12;
    const out = [];
    if (f.kind === "hourly") {
      out.push(h_flex().flex_none().gap(8).items_center()
        .child(div().flex_none().text_size(12).text_color(t.muted).child("매시간"))
        .child(div().w(90).flex_none().child(dd("minute", minutes, f.minute, "minute", 90)))
        .child(div().flex_none().text_size(12).text_color(t.muted).child("분에")));
    } else if (f.kind === "cron") {
      const parts = f.cron.value().trim().split(/\s+/).filter(Boolean);
      out.push(Input.new(f.cron).h(30).px(8).items_center().rounded(6).border(1).border_color(this.focusKey === f.cron ? t.accent : t.input).bg(t.background).text_size(12).text_color(t.foreground));
      out.push(parts.length === 5
        ? h_flex().flex_none().gap(4).children(["분", "시간", "일", "월", "요일"].map((l, i) => v_flex().flex_1().min_w(0).items_center().py(4).rounded(5).bg(t.raised)
          .child(div().text_size(10).text_color(t.dim).child(l))
          .child(div().max_w_full().truncate().text_size(12).text_color(t.foreground).child(parts[i]))))
        : this.note(t, "분 시 일 월 요일, 5칸을 띄어 씁니다. 예: 0 17 * * 5"));
    } else if (f.kind === "rrule") {
      out.push(Input.new(f.rrule).h(30).px(8).items_center().rounded(6).border(1).border_color(this.focusKey === f.rrule ? t.accent : t.input).bg(t.background).text_size(12).text_color(t.foreground));
      out.push(this.note(t, "FREQ=HOURLY·DAILY·WEEKLY·MONTHLY, INTERVAL, BYDAY, BYHOUR, BYMINUTE, BYMONTHDAY만 지원합니다."));
    } else {
      if (f.kind === "weekly") {
        out.push(dd("weekday", WEEK_ORDER.map((d) => ({ value: d, label: WEEKDAY_LONG[d] })), f.weekday, "weekday", 140));
      }
      out.push(h_flex().flex_none().gap(6).items_center()
        .child(div().flex_1().min_w(0).child(dd("hour12", hours, hour12Of(f.hour), "hour12", 80)))
        .child(div().text_size(12).text_color(t.muted).child(":"))
        .child(div().flex_1().min_w(0).child(dd("minute", minutes, f.minute, "minute", 80)))
        .child(div().w(84).flex_none().child(dd("ampm", [{ value: "am", label: "오전" }, { value: "pm", label: "오후" }], pm ? "pm" : "am", "ampm", 84))));
    }
    return out;
  }

  sidebar(t) {
    const f = this.f, o = this.opts;
    const dd = (id, items, value, k, menuW = 240) => this.dropdown(t, id, { items, value, menuW, onPick: (v, cx) => this.pick(k, v, cx) });
    const worktree = f.folderMode === "worktree";
    const path = this.curPath();
    const kinds = KINDS.map(([value, label]) => ({ value, label }));
    return v_flex().id("sc-side").w(320).flex_none().h_full().min_h(0).overflow_y_scrollbar().border_l(1).border_color(t.border).bg(t.chrome)
      .child(v_flex().flex_none().p(16).gap(14)
        .child(this.field(t, "프로그램", dd("program", [{ value: "claude", label: "Claude" }, { value: "codex", label: "Codex" }], f.program, "program")))
        .child(h_flex().flex_none().gap(8)
          .child(div().flex_1().min_w(0).child(this.field(t, "모델", dd("model", this.modelItems(), f.model, "model", 240))))
          .child(div().flex_1().min_w(0).child(this.field(t, "에포트", dd("effort", this.effortItems(), f.effort, "effort", 160)))))
        .child(this.field(t, "폴더",
          dd("path", this.folderItems(), f.pathMode === "custom" ? CUSTOM : f.path, "path", 300),
          f.pathMode === "custom"
            ? Input.new(f.pathInput).h(30).px(8).items_center().rounded(6).border(1).border_color(this.focusKey === f.pathInput ? t.accent : t.input).bg(t.background).text_size(12).text_color(t.foreground)
            : path ? div().flex_none().min_w(0).truncate().text_size(11).text_color(t.dim).child(path) : null))
        .child(this.field(t, "작업 공간",
          this.segmented(t, "ws", [{ value: "existing", label: "기존 폴더" }, { value: "worktree", label: "실행마다 새 워크트리" }], f.folderMode, (v, cx) => this.pick("folderMode", v, cx)),
          worktree ? v_flex().flex_none().gap(5).pt(4)
            .child(div().text_size(11).text_color(t.dim).child("기준 브랜치"))
            .child(dd("base", this.branchItems(), f.base, "base", 280))
            .child(o && !o.isRepo && path ? this.note(t, "저장소 폴더가 아니라 새 워크트리를 만들 수 없습니다.", t.blocked) : this.note(t, "origin/<이름>을 먼저, 없으면 로컬 <이름>에서 만듭니다."))
            : null))
        .child(this.field(t, "세션",
          this.segmented(t, "ses", [{ value: false, label: "새로 시작" }, { value: true, label: "재사용", disabled: worktree }], f.reuse, (v, cx) => this.pick("reuse", v, cx)),
          this.note(t, worktree ? "새 워크트리에서는 항상 새 세션으로 시작합니다." : f.reuse ? "지난 실행 세션이 살아 있으면 거기에 보냅니다." : "실행할 때마다 새 세션을 띄웁니다.")))
        .child(this.field(t, "일정", dd("kind", kinds, f.kind, "kind", 220), ...this.scheduleControls(t)))
        .child(this.field(t, "시간대", dd("tz", this.zoneItems(), f.tz, "tz", 260)))
        .child(this.field(t, "유예 시간",
          dd("grace", withCurrent(GRACES.map((m) => ({ value: m, label: graceLabel(m) })), f.grace, graceLabel, true), f.grace, "grace", 180),
          this.note(t, "앱이 꺼져 있다가 켜졌을 때 이 시간 안이면 가장 최근 1회만 실행합니다.")))
        .child(this.field(t, "알림",
          dd("notify", NOTIFY_OPTIONS, f.notify, "notify", 260),
          this.note(t, f.notify === "off" ? "이 예약은 알림을 보내지 않습니다." : f.notify === "all" ? "실패·입력 대기·놓침·완료를 Herdr와 OS 알림으로 알립니다." : "실패·입력 대기·놓침일 때만 Herdr와 OS 알림으로 알립니다.")))
        .child(h_flex().flex_none().items_center().justify_between()
          .child(div().text_size(11.5).font_semibold().text_color(t.muted).child("켜짐"))
          .child(this.toggle(t, "sc-enabled", f.enabled, (on, cx) => { f.enabled = on; cx.notify(); }, f.enabled ? "저장하면 바로 켜집니다" : "꺼진 채로 저장합니다"))));
  }

  previewBlock(t) {
    const p = this.preview;
    if (!p) return div().flex_none().text_size(11.5).text_color(t.dim).child("일정을 확인하는 중…");
    const errors = this.tried ? p.errors : p.errors.filter((e) => SCHEDULE_ERR.test(e));
    return v_flex().flex_none().gap(3).px(10).py(8).rounded(8).bg(errors.length ? t.blocked + "1f" : t.raised)
      .when(errors.length > 0, (el) => el.children(errors.map((e) => div().text_size(12).text_color(t.blocked).child(e))))
      .when(errors.length === 0 && (p.next ?? []).length > 0, (el) => el
        .child(div().text_size(12).font_semibold().text_color(t.foreground).child(`다음 실행${p.summary ? ` · ${p.summary}` : ""}`))
        .child(div().text_size(12).text_color(t.muted).child((p.next ?? []).map(when).join("  ·  "))));
  }

  dialogScreen(t) {
    const f = this.f;
    if (!f) return div();
    const field = (state, w) => Input.new(state).h(w).px(12).items_center().rounded(8).border(1).border_color(this.focusKey === state ? t.accent : t.input).bg(t.background).text_color(t.foreground);
    const left = v_flex().flex_1().min_w(0).h_full().min_h(0).p(16).gap(12)
      .child(field(f.name, 44).text_size(18).font_semibold())
      .child(Textarea.new(f.prompt).flex_1().min_h(150).px(12).py(10).rounded(8).border(1).border_color(t.input).bg(t.background).text_size(13.5).text_color(t.foreground))
      .child(v_flex().flex_none().gap(6)
        .child(h_flex().items_center().justify_between()
          .child(div().text_size(11.5).font_semibold().text_color(t.muted).child("사전 확인"))
          .child(h_flex().gap(6).items_center()
            .child(div().text_size(11.5).text_color(t.dim).child("시간 초과"))
            .child(div().w(96).child(this.dropdown(t, "psec", {
              items: withCurrent(PRECHECK_SECS.map((s) => ({ value: s, label: secLabel(s) })), f.precheckSec, secLabel, true),
              value: f.precheckSec, menuW: 96, anchor: "top_right", onPick: (v, cx) => this.pick("precheckSec", v, cx),
            })))))
        .child(Textarea.new(f.precheck).h(64).px(12).py(8).rounded(8).border(1).border_color(t.input).bg(t.background).text_size(12.5).text_color(t.foreground))
        .child(this.note(t, "예약 실행에서만 돌고, 종료 코드가 0이 아니면 건너뜁니다. 지금 실행은 건너뛰지 않습니다.")))
      .child(this.previewBlock(t));
    const header = h_flex().h(48).flex_none().px(16).items_center().justify_between().border_b(1).border_color(t.border)
      .child(div().text_size(15).font_semibold().text_color(t.foreground).child(this.editing ? "예약 편집" : "예약 만들기"))
      .child(div().id("sc-x").p(6).rounded(6).cursor_pointer().text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_click(() => this.close()).tooltip("닫기").child(svg(CLOSE_ICON).size(14)));
    const footer = h_flex().h(56).flex_none().px(16).gap(10).items_center().justify_between().border_t(1).border_color(t.border)
      .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.dim).child(SAVE_NOTE))
      .child(h_flex().gap(8).items_center()
        .child(this.button(t, "sc-cancel", "취소", () => this.close(), { big: true }))
        .child(this.button(t, "sc-save", this.editing ? "저장" : "만들기", (cx) => this.save(cx), { primary: true, big: true, disabled: this.saving })));
    return v_flex().size_full().min_h(0).bg(t.chrome).text_size(13)
      .child(header)
      .child(h_flex().flex_1().min_h(0).child(left).child(this.sidebar(t)))
      .child(footer);
  }

  // ---- 패널: 목록
  header(t, title, left, right) {
    return h_flex().h(38).px(12).flex_none().items_center().justify_between().gap(8)
      .child(h_flex().gap(6).items_center().min_w(0)
        .when(Boolean(left), (el) => el.child(left))
        .child(div().min_w(0).truncate().text_size(15).font_semibold().text_color(t.foreground).child(title)))
      .child(h_flex().gap(6).items_center().children(right ?? []));
  }

  banner(t) {
    if (!this.msg) return null;
    return div().id("sc-msg").flex_none().mx(12).mb(6).px(8).py(5).rounded(6).bg((this.msg.error ? t.blocked : t.working) + "1f")
      .text_size(11.5).text_color(this.msg.error ? t.blocked : t.foreground).cursor_pointer()
      .on_click((_e, cx) => { this.msg = null; cx.notify(); }).child(this.msg.text);
  }

  // 행의 ⋯ 메뉴: 지금 실행·편집·기록·삭제.
  moreMenu(t, a) {
    const id = `more-${a.id}`;
    const open = this.dd === id;
    const item = (key, label, fn, danger = false) => div().id(`${id}-${key}`).flex_none().h(28).px(10).rounded(5).flex().items_center().cursor_pointer()
      .text_size(12.5).text_color(danger ? t.blocked : t.foreground).hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => { this.dd = null; fn(cx); cx.notify(); }).child(label);
    const trigger = div().id(`${id}-btn`).flex_none().w(24).h(24).rounded(6).flex().items_center().justify_center().cursor_pointer()
      .text_size(15).text_color(open ? t.foreground : t.dim).when(open, (e) => e.bg(t.hover)).hover((s) => s.bg(t.hover).text_color(t.foreground)).child("⋯");
    const content = v_flex().w(150).p(4).gap(1).rounded(8).border(1).border_color(t.border).bg(t.popover ?? t.raised).shadow_lg()
      .child(item("run", "지금 실행", (cx) => this.runNow(a, cx)))
      .child(item("edit", "편집", (cx) => this.openDialog(a, cx)))
      .child(item("hist", "기록", (cx) => this.openHistory(a, cx)))
      .child(item("repo", "저장소에 기록", (cx) => this.record([a.id], cx)))
      .child(div().flex_none().h(1).my(3).bg(t.border))
      .child(item("del", "삭제", () => { this.confirmDelete = a.id; }, true));
    return Popover.new(`${id}-pop`).anchor("top_right").open(open)
      .on_open_change((o, cx) => { this.dd = o ? id : this.dd === id ? null : this.dd; cx.notify(); })
      .trigger(trigger).content(content);
  }

  row(t, a) {
    const last = a.last;
    const color = last ? t[STATUS_COLOR[last.status] ?? "dim"] ?? t.dim : t.dim;
    const confirming = this.confirmDelete === a.id;
    const unlinked = !a.folder.path;
    const folder = unlinked ? `작업 폴더를 다시 고르세요(편집)${a.folder.hint?.name ? ` · 원래 ${a.folder.hint.name}` : ""}` : `${a.folder.mode === "worktree" ? "새 워크트리 · " : ""}${base(a.folder.path)}`;
    return v_flex().flex_none().px(12).py(9).gap(4).border_b(1).border_color(t.border)
      .child(h_flex().gap(8).items_center()
        .child(div().flex_none().size(8).rounded(4).bg(color))
        .child(div().flex_1().min_w(0).truncate().text_size(13).font_semibold().text_color(a.enabled ? t.foreground : t.muted).child(a.name))
        .child(this.tag(t, a.program, "dim"))
        .child(this.toggle(t, `sw-${a.id}`, a.enabled, (on, cx) => { a.enabled = on; this.setEnabled(a, on, cx); cx.notify(); }))
        .child(this.moreMenu(t, a)))
      .child(div().pl(16).min_w(0).truncate().text_size(11.5).text_color(t.muted).child(a.summary))
      .child(h_flex().pl(16).gap(6).items_center().text_size(11).text_color(t.dim)
        .child(svg(ICON("folder")).size(11).flex_none())
        .child(div().flex_1().min_w(0).truncate().text_color(unlinked ? t.blocked : t.dim).child(folder)))
      .child(h_flex().pl(16).gap(8).items_center().text_size(11).text_color(t.dim)
        .child(div().flex_none().child(a.enabled ? `다음 ${when(a.nextRun)}` : "꺼져 있음"))
        .child(div().id(`last-${a.id}`).flex_1().min_w(0).truncate().text_color(color)
          .when(Boolean(last), (e) => e.tooltip(`${last.status} · ${when(lastAt(last))}`))
          .child(last ? `${last.status} · ${ago(lastAt(last)) || when(lastAt(last))}` : "마지막 실행 없음")))
      .when(confirming, (el) => el.child(h_flex().pl(16).gap(6).items_center()
        .child(div().text_size(11.5).text_color(t.blocked).child("삭제할까요? 기록도 함께 사라집니다."))
        .child(this.button(t, `del-yes-${a.id}`, "삭제", (cx) => this.remove(a, cx), { danger: true }))
        .child(this.button(t, `del-no-${a.id}`, "취소", (cx) => { this.confirmDelete = null; cx.notify(); }))));
  }

  groupHead(t, label, n, color) {
    return div().flex_none().px(12).pt(10).pb(4).text_size(11).font_semibold().text_color(color ?? t.dim).child(`${label} ${n}`);
  }

  // 기록 저장소 칸: 저장소 고르기 + 모두 기록·불러오기 + 확인 줄.
  syncBar(t) {
    const ready = Boolean(this.repo?.repo);
    const ask = this.syncAsk;
    return v_flex().flex_none().mx(12).mb(8).p(8).gap(6).rounded(8).border(1).border_color(t.border)
      .child(div().text_size(11.5).font_semibold().text_color(t.muted).child("기록 저장소"))
      .child(this.dropdown(t, "sync-repo", { items: this.repoItems(), value: this.repoCustom ? CUSTOM : this.repo?.repo ?? "", placeholder: "git 저장소를 고르세요", menuW: 280,
        onPick: (v, cx) => { this.dd = null; if (v === CUSTOM) { this.repoCustom = true; this.repoInput.set_value(this.repo?.repo ?? ""); } else { this.repoCustom = false; this.setRepo(v, cx); } cx.notify(); } }))
      .when(this.repoCustom, (el) => el.child(h_flex().gap(6).items_center()
        .child(div().flex_1().min_w(0).child(Input.new(this.repoInput).h(28).px(8).items_center().rounded(6).border(1).border_color(this.focusKey === this.repoInput ? t.accent : t.input).bg(t.background).text_size(12).text_color(t.foreground)))
        .child(this.button(t, "sync-set", "정하기", (cx) => this.setRepo(this.repoInput.value().trim(), cx)))))
      .when(!this.repoCustom && ready, (el) => el.child(div().min_w(0).truncate().text_size(11).text_color(t.dim).child(this.repo.repo)))
      .when(Boolean(this.repo?.error) && !ready, (el) => el.child(this.note(t, this.repo.error, t.blocked)))
      .when(ready && this.repo.emailBlock, (el) => el.child(this.note(t, `이 저장소의 커밋 이메일이 GitHub noreply 주소가 아니고 공개 저장소이거나 공개 여부를 몰라 기록할 수 없습니다. 해결: ${this.repo.emailFix}`, t.blocked)))
      .when(ready && !this.repo.emailOk && !this.repo.emailBlock, (el) => el.child(this.note(t, "비공개 저장소(또는 원격 없음)라 커밋 이메일을 바꾸지 않아도 기록할 수 있습니다.")))
      .when(!ready && !this.repo?.error, (el) => el.child(this.note(t, "저장소를 고르면 예약을 그 저장소의 herdr-schedules/에 기록할 수 있습니다. 비공개 저장소를 권장합니다.")))
      .child(h_flex().gap(6).items_center().flex_wrap()
        .child(this.button(t, "sync-all", "모두 기록", (cx) => this.record(["--all"], cx), { disabled: !ready || this.repo.emailBlock || this.syncBusy || !(this.items ?? []).length }))
        .child(this.button(t, "sync-import", "저장소에서 불러오기", (cx) => this.importRepo(cx), { disabled: !ready || this.syncBusy }))
        .when(this.syncBusy, (el) => el.child(div().text_size(11).text_color(t.dim).child("처리 중…"))))
      .when(Boolean(ask), (el) => el.child(v_flex().gap(5).pt(2)
        .child(div().text_size(11.5).text_color(t.blocked).child(ask.kind === "public" ? `${ask.text} 그래도 기록할까요?` : "아래 사전 확인 명령이 들어 있습니다. 불러올 때 실행하지는 않지만, 켜면 이 PC에서 실행됩니다. 믿을 수 있는 명령인지 확인하세요."))
        .when(ask.kind === "import", (e) => e.children(ask.commands.map((c) => div().flex_none().px(6).py(3).rounded(5).bg(t.raised).text_size(11).text_color(t.foreground).child(`${c.name}: ${c.command}`))))
        .child(h_flex().gap(6).items_center()
          .child(this.button(t, "sync-ask-yes", ask.kind === "public" ? "기록" : "불러오기", (cx) => (ask.kind === "public" ? this.record(ask.args, cx, true) : this.importRepo(cx, true)), { danger: true }))
          .child(this.button(t, "sync-ask-no", "취소", (cx) => { this.syncAsk = null; cx.notify(); })))));
  }

  listScreen(t) {
    const items = this.items;
    const attention = (items ?? []).filter((a) => a.last && ATTENTION_STATUS.has(a.last.status));
    const rest = (items ?? []).filter((a) => !attention.includes(a));
    const groups = [["주의 필요", attention, t.blocked], ["활성", rest.filter((a) => a.enabled)], ["꺼짐", rest.filter((a) => !a.enabled)]].filter((g) => g[1].length);
    return v_flex().size_full().min_h(0).bg(t.chrome).text_size(13)
      .child(this.header(t, "예약", null, [this.button(t, "sc-new", "+ 새 예약", (cx) => this.openDialog(null, cx), { primary: true })]))
      .child(div().px(12).pb(6).flex_none().text_size(11).text_color(t.dim).child("Herdr 앱이 켜져 있을 때만 실행됩니다."))
      .child(this.syncBar(t))
      .when(Boolean(this.banner(t)), (el) => el.child(this.banner(t)))
      .when(!items && !this.msg, (el) => el.child(div().px(12).text_size(12).text_color(t.dim).child("불러오는 중…")))
      .when(Boolean(items) && items.length === 0, (el) => el.child(div().px(12).py(8).text_size(12).text_color(t.dim).child("예약이 없습니다. 오른쪽 위 \"새 예약\"으로 만드세요.")))
      .child(v_flex().id("sc-list").flex_1().min_h(0).overflow_y_scrollbar().mode("always")
        .children(groups.flatMap(([label, list, color]) => [this.groupHead(t, label, list.length, color), ...list.map((a) => this.row(t, a))])));
  }

  // ---- 패널: 기록
  histRow(t, a, r) {
    const color = STATUS_COLOR[r.status] ?? "dim";
    const alive = this.alive(r);
    const first = [r.scheduledAt, r.startedAt, r.finishedAt].find((v) => Number.isFinite(v));
    const detail = timeLine(r);
    return v_flex().flex_none().px(10).py(7).gap(4).border_b(1).border_color(t.border)
      .child(h_flex().gap(6).items_center()
        .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.foreground).child(`${when(first)}${ago(first) ? ` (${ago(first)})` : ""}`))
        .child(this.tag(t, r.trigger, r.trigger === "놓친 실행" ? "idle" : "dim"))
        .child(this.tag(t, r.status, color)))
      .when(Boolean(detail), (el) => el.child(div().text_size(11).text_color(t.muted).truncate().child(detail)))
      .when(Boolean(r.terminal), (el) => el.child(h_flex().gap(6).items_center().text_size(11).text_color(t.dim)
        .child(svg(ICON("terminal")).size(11).flex_none())
        .child(div().id(`ht-${r.id}`).flex_1().min_w(0).truncate()
          .when(alive, (e) => e.cursor_pointer().text_color(t.muted).hover((s) => s.text_color(t.foreground)).on_click(() => this.openTerminal(r)).tooltip("터미널 열기"))
          .child(`${r.terminalName ?? r.terminal}${alive ? "" : " (종료됨)"}`))))
      .when(Boolean(r.worktree), (el) => el.child(h_flex().gap(6).items_center().text_size(11).text_color(t.dim)
        .child(svg(ICON("git-branch")).size(11).flex_none())
        .child(div().flex_1().min_w(0).truncate().child(r.branch ? `${r.branch} · ${base(r.worktree)}` : base(r.worktree)))))
      .when(Boolean(r.error || r.note), (el) => el.child(div().text_size(11).text_color(r.error ? t.blocked : t.dim).max_h(32).overflow_hidden().child(r.error || r.note)))
      .when(alive || RETRY_STATUS.has(r.status) || r.status === "놓침", (el) => el.child(h_flex().gap(6)
        .when(alive, (e) => e.child(this.button(t, `open-${r.id}`, "세션 열기", () => this.openTerminal(r))))
        .when(RETRY_STATUS.has(r.status) || r.status === "놓침", (e) => e.child(this.button(t, `resend-${r.id}`, r.status === "놓침" ? "지금 실행" : "다시 보내기", (cx) => this.runNow(a, cx))))));
  }

  counters(t) {
    const s = summarize(this.hist);
    const cell = (label, c) => h_flex().gap(6).items_center().text_size(11.5)
      .child(div().text_color(t.dim).child(label))
      .child(div().text_color(t.done).child(`성공 ${c.ok}`))
      .child(div().text_color(c.fail ? t.blocked : t.dim).child(`실패 ${c.fail}`));
    return h_flex().flex_none().px(12).pb(6).gap(14).items_center().flex_wrap()
      .child(cell("24시간", s.d1)).child(cell("7일", s.d7));
  }

  historyScreen(t) {
    const a = (this.items ?? []).find((x) => x.id === this.histId);
    const back = div().id("sc-back").p(3).rounded(5).text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground)).cursor_pointer()
      .on_click((_e, cx) => { this.screen = "list"; this.histId = null; this.msg = null; cx.notify(); }).tooltip("목록으로")
      .child(svg(ICON("chevron-left")).size(14));
    return v_flex().size_full().min_h(0).bg(t.chrome).text_size(13)
      .child(this.header(t, a ? `${a.name} · 기록` : "기록", back, a ? [this.button(t, "sc-hist-run", "지금 실행", (cx) => this.runNow(a, cx))] : []))
      .when(Boolean(this.banner(t)), (el) => el.child(this.banner(t)))
      .when(!a, (el) => el.child(div().px(12).text_size(12).text_color(t.dim).child("예약을 찾지 못했습니다.")))
      .when(Boolean(a) && this.hist.length > 0, (el) => el.child(this.counters(t)))
      .when(Boolean(a) && this.hist.length === 0, (el) => el.child(div().px(12).py(8).text_size(12).text_color(t.dim).child("아직 실행 기록이 없습니다.")))
      .child(v_flex().id("sc-hist").flex_1().min_h(0).overflow_y_scrollbar().mode("always").children(a ? this.hist.map((r) => this.histRow(t, a, r)) : []));
  }

  render() {
    const t = theme();
    if (this.dialog) return this.dialogScreen(t);
    if (this.screen === "history") return this.historyScreen(t);
    return this.listScreen(t);
  }
}
