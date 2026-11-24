#!/usr/bin/env node
// 예약(schedules) 모드의 데이터·실행 계층. 의존성 없는 node 한 파일이고 macOS·Windows에서 같은 코드로 돈다.
// 모드(main.js)는 화면과 30초 타이머만 맡고 이 파일을 exec로 부른다. 결과는 항상 stdout에 JSON 한 개다.
//   node schedules.cjs tick                         due 확인·실행 시작·최근 실행 상태 갱신 (모드 타이머가 30초마다 부른다)
//   node schedules.cjs run <id> [--manual] [--wait]  지금 실행 (--manual이면 사전 검사를 건너뛴다. 작업은 따로 떠서 바로 돌아온다)
//   node schedules.cjs next [--id <id> | --b64 <예약 JSON>] [--count N]   다음 실행 시각
//   node schedules.cjs validate --b64 <예약 JSON>   검사 + 다음 3번 미리보기
//   node schedules.cjs list | runs <id> | save --b64 <예약 JSON> | delete <id> | toggle <id> on|off   화면이 쓰는 목록·저장
//   node schedules.cjs options [--path <폴더>]       선택 화면용 목록: Codex 모델·강도, 최근 폴더, 그 폴더 저장소의 기준 브랜치
// 저장 위치: <앱 홈>/schedules/automations.json, runs.json (예약마다 최근 50개). 모드 폴더 밖이라 모드를 다시 설치해도 남는다.
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawnSync, spawn } = require("child_process");

const WIN = process.platform === "win32";
const APP_HOME = process.env.HERDR_APP_HOME || path.join(os.homedir(), ".config", "herdr-app");
const STORE_DIR = process.env.SCHEDULES_HOME || path.join(APP_HOME, "schedules");
const AUTOS_FILE = path.join(STORE_DIR, "automations.json");
const RUNS_FILE = path.join(STORE_DIR, "runs.json");
const SETTINGS_FILE = path.join(STORE_DIR, "settings.json"); // 이 PC 설정(기록 저장소 위치). 저장소 파일에는 넣지 않는다
const LOCK_FILE = path.join(STORE_DIR, "store.lock");
const TICK_LOCK_FILE = path.join(STORE_DIR, "tick.lock");
const KEEP_RUNS = 50;
const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;
// 타이머가 30초라서, 예정 시각을 이만큼 넘긴 실행은 늦은 것이 아니라 정시 실행으로 본다.
const ON_TIME_MS = 2 * MIN;
const DEFAULT_GRACE = 60;
// 알림: off=끔, problems=문제만(실패·입력 대기·놓침), all=완료까지. 필드가 없는 예전 예약은 problems로 본다.
const NOTIFY_MODES = ["off", "problems", "all"];
const DEFAULT_NOTIFY = "problems";
// 이보다 오래전에 끝난 기록은 알리지 않는다(Herdr를 오랜만에 켰을 때 한꺼번에 쏟아지는 것을 막는다).
const NOTIFY_MAX_AGE_MS = 15 * MIN;
const NOTIFY_MAX_PER_TICK = 3;
const DEFAULT_PRECHECK_TIMEOUT = 60;
const WORKER_STALE_MS = 10 * MIN;

const PROGRAMS = ["claude", "codex"];
const PRESETS = ["hourly", "daily", "weekdays", "weekly"];
const WEEKDAY_KO = ["일", "월", "화", "수", "목", "금", "토"];

class ScheduleError extends Error {}

// ---------------------------------------------------------------- 시간대 계산
const dtfCache = new Map();
function dtf(tz) {
  let f = dtfCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" });
    dtfCache.set(tz, f);
  }
  return f;
}
function localZone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; }
}
function validZone(tz) {
  if (typeof tz !== "string" || !tz) return false;
  try { dtf(tz); return true; } catch { return false; }
}
function partsOf(ms, tz) {
  const p = {};
  for (const x of dtf(tz).formatToParts(new Date(ms))) p[x.type] = x.value;
  return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour % 24, mi: +p.minute, s: +p.second };
}
// 기록 문구용 "11/18 16:30"(그 시간대의 벽시계).
function stampOf(ms, tz) {
  const p = partsOf(ms, tz);
  const z = (n) => String(n).padStart(2, "0");
  return `${p.mo}/${p.d} ${z(p.h)}:${z(p.mi)}`;
}
// 알림용 짧은 시각 "11/24(화) 오전 10:05"(그 시간대의 벽시계).
function shortStampOf(ms, tz) {
  const p = partsOf(ms, tz);
  const dow = WEEKDAY_KO[new Date(Date.UTC(p.y, p.mo - 1, p.d)).getUTCDay()];
  return `${p.mo}/${p.d}(${dow}) ${p.h < 12 ? "오전" : "오후"} ${p.h % 12 || 12}:${String(p.mi).padStart(2, "0")}`;
}
// 그 시각의 UTC 대비 오프셋(ms). 초 아래는 버린다.
function offsetMs(ms, tz) {
  const p = partsOf(ms, tz);
  return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1000) * 1000;
}
// 그 시간대의 벽시계 시각 → UTC ms.
// 가을에 같은 시각이 두 번 있으면 먼저 오는 쪽 하나만, 봄에 없는 시각이면 건너뛴 만큼 뒤(갭이 끝나는 시각)로 보낸다.
function zonedToUtc(y, mo, d, h, mi, tz) {
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  const before = offsetMs(wall - DAY, tz);
  const after = offsetMs(wall + DAY, tz);
  const valid = [...new Set([wall - before, wall - after])].filter((c) => {
    const p = partsOf(c, tz);
    return p.y === y && p.mo === mo && p.d === d && p.h === h && p.mi === mi;
  });
  return valid.length ? Math.min(...valid) : wall - before;
}
const floorMod = (a, n) => ((a % n) + n) % n;
const daysInMonth = (y, mo) => new Date(Date.UTC(y, mo, 0)).getUTCDate();
const weekIndex = (dn) => Math.floor((dn + 3) / 7); // 월요일 시작 주. dn = 1970-01-01부터 센 날짜 번호(그날은 목요일)

// ---------------------------------------------------------------- 반복 규칙 → matcher
// matcher = { dayOk(info), times(info) -> [[h, mi]], keep?(utcMs) }, info = { y, mo, d, dow, dn }
const parseTime = (text) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(text ?? "").trim());
  if (!m || +m[1] > 23 || +m[2] > 59) throw new ScheduleError(`시각은 HH:MM 형식이어야 합니다: ${text}`);
  return [+m[1], +m[2]];
};

function presetMatcher(s) {
  const [h, mi] = parseTime(s.time ?? "09:00");
  if (s.preset === "hourly") return { dayOk: () => true, times: () => Array.from({ length: 24 }, (_, i) => [i, mi]) };
  if (s.preset === "daily") return { dayOk: () => true, times: () => [[h, mi]] };
  if (s.preset === "weekdays") return { dayOk: (i) => i.dow >= 1 && i.dow <= 5, times: () => [[h, mi]] };
  if (s.preset === "weekly") {
    const wd = Number(s.weekday ?? 1);
    if (!Number.isInteger(wd) || wd < 0 || wd > 6) throw new ScheduleError("요일은 0(일)~6(토)이어야 합니다.");
    return { dayOk: (i) => i.dow === wd, times: () => [[h, mi]] };
  }
  throw new ScheduleError(`알 수 없는 프리셋입니다: ${s.preset}`);
}

const MONTH_NAMES = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const DOW_NAMES = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
function cronField(text, min, max, names, label) {
  const out = new Set();
  const num = (token) => {
    if (/^\d+$/.test(token)) return Number(token);
    const i = names ? names.indexOf(token.toUpperCase()) : -1;
    if (i < 0) throw new ScheduleError(`cron ${label} 칸을 읽지 못했습니다: ${token}`);
    return i + (names === MONTH_NAMES ? 1 : 0);
  };
  for (const part of text.split(",")) {
    if (!part) throw new ScheduleError(`cron ${label} 칸이 비었습니다.`);
    const [range, stepText] = part.split("/");
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1) throw new ScheduleError(`cron ${label} 칸의 간격이 잘못됐습니다: ${part}`);
    let lo, hi;
    if (range === "*" || range === "?") { lo = min; hi = max; }
    else if (range.includes("-")) { const [a, b] = range.split("-"); lo = num(a); hi = num(b); }
    else { lo = num(range); hi = stepText === undefined ? lo : max; }
    if (lo < min || hi > max || lo > hi) throw new ScheduleError(`cron ${label} 칸 범위가 ${min}~${max}를 벗어났습니다: ${part}`);
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}
function cronMatcher(expr) {
  const f = String(expr ?? "").trim().split(/\s+/);
  if (f.length !== 5) throw new ScheduleError("cron은 공백으로 나눈 5칸(분 시 일 월 요일)이어야 합니다.");
  const minutes = cronField(f[0], 0, 59, null, "분");
  const hours = cronField(f[1], 0, 23, null, "시");
  const doms = cronField(f[2], 1, 31, null, "일");
  const months = cronField(f[3], 1, 12, MONTH_NAMES, "월");
  const dowRaw = cronField(f[4], 0, 7, DOW_NAMES, "요일");
  const dows = new Set([...dowRaw].map((v) => v % 7));
  const domStar = /^[*?]/.test(f[2]), dowStar = /^[*?]/.test(f[4]);
  const times = [];
  for (const h of [...hours].sort((a, b) => a - b)) for (const m of [...minutes].sort((a, b) => a - b)) times.push([h, m]);
  return {
    dayOk: (i) => {
      if (!months.has(i.mo)) return false;
      const d = doms.has(i.d), w = dows.has(i.dow);
      if (domStar && dowStar) return true;
      if (domStar) return w;
      if (dowStar) return d;
      return d || w; // 둘 다 정하면 vixie cron처럼 하나만 맞아도 된다
    },
    times: () => times,
  };
}

const RRULE_ALLOWED = ["FREQ", "INTERVAL", "BYDAY", "BYHOUR", "BYMINUTE", "BYMONTHDAY"];
const RRULE_DAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
function rruleMatcher(text, tz, anchor) {
  const parts = {};
  const body = String(text ?? "").trim().replace(/^RRULE:/i, "");
  if (!body) throw new ScheduleError("RRULE이 비었습니다.");
  for (const seg of body.split(";")) {
    if (!seg.trim()) continue;
    const eq = seg.indexOf("=");
    if (eq < 1) throw new ScheduleError(`RRULE 항목을 읽지 못했습니다: ${seg}`);
    const key = seg.slice(0, eq).trim().toUpperCase();
    if (!RRULE_ALLOWED.includes(key)) throw new ScheduleError(`지원하지 않는 RRULE 항목입니다: ${key} (지원: ${RRULE_ALLOWED.join(", ")})`);
    if (key in parts) throw new ScheduleError(`RRULE 항목이 두 번 나왔습니다: ${key}`);
    parts[key] = seg.slice(eq + 1).trim().toUpperCase();
  }
  const freq = parts.FREQ;
  if (!["HOURLY", "DAILY", "WEEKLY", "MONTHLY"].includes(freq)) throw new ScheduleError("FREQ는 HOURLY, DAILY, WEEKLY, MONTHLY 중 하나여야 합니다.");
  const interval = parts.INTERVAL === undefined ? 1 : Number(parts.INTERVAL);
  if (!Number.isInteger(interval) || interval < 1 || interval > 999) throw new ScheduleError("INTERVAL은 1 이상의 정수여야 합니다.");
  const ints = (key, lo, hi, allowNegative) => {
    if (parts[key] === undefined) return null;
    const list = parts[key].split(",").map((v) => (/^-?\d+$/.test(v) ? Number(v) : NaN));
    for (const v of list) {
      const ok = Number.isInteger(v) && ((v >= lo && v <= hi) || (allowNegative && v <= -1 && v >= -hi)) && v !== 0 || (lo === 0 && v === 0);
      if (!ok) throw new ScheduleError(`${key} 값이 범위를 벗어났습니다: ${parts[key]}`);
    }
    return list;
  };
  const byHour = ints("BYHOUR", 0, 23, false);
  const byMinute = ints("BYMINUTE", 0, 59, false);
  const byMonthDay = ints("BYMONTHDAY", 1, 31, true);
  let byDay = null;
  if (parts.BYDAY !== undefined) {
    byDay = parts.BYDAY.split(",").map((v) => {
      const i = RRULE_DAYS.indexOf(v);
      if (i < 0) throw new ScheduleError(`BYDAY는 MO,TU,WE,TH,FR,SA,SU만 쓸 수 있습니다: ${v}`);
      return i;
    });
  }
  if (freq === "WEEKLY" && byMonthDay) throw new ScheduleError("FREQ=WEEKLY에는 BYMONTHDAY를 쓸 수 없습니다.");
  const a = partsOf(anchor, tz);
  const aDn = Date.UTC(a.y, a.mo - 1, a.d) / DAY;
  const aDow = new Date(Date.UTC(a.y, a.mo - 1, a.d)).getUTCDay();
  const hours = byHour ?? (freq === "HOURLY" ? Array.from({ length: 24 }, (_, i) => i) : [a.h]);
  const minutes = byMinute ?? [freq === "HOURLY" ? 0 : a.mi];
  const times = [];
  for (const h of [...hours].sort((x, y) => x - y)) for (const m of [...minutes].sort((x, y) => x - y)) times.push([h, m]);
  const monthDayOk = (i) => byMonthDay.some((v) => (v > 0 ? v === i.d : daysInMonth(i.y, i.mo) + v + 1 === i.d));
  const filters = (i) => (!byDay || byDay.includes(i.dow)) && (!byMonthDay || monthDayOk(i));
  const m = { times: () => times };
  if (freq === "HOURLY") {
    const hourStart = Math.floor(anchor / 3600000);
    m.dayOk = filters;
    m.keep = (utc) => floorMod(Math.floor(utc / 3600000) - hourStart, interval) === 0;
  } else if (freq === "DAILY") {
    m.dayOk = (i) => filters(i) && floorMod(i.dn - aDn, interval) === 0;
  } else if (freq === "WEEKLY") {
    const days = byDay ?? [aDow];
    m.dayOk = (i) => days.includes(i.dow) && floorMod(weekIndex(i.dn) - weekIndex(aDn), interval) === 0;
  } else {
    const aMonth = a.y * 12 + a.mo - 1;
    m.dayOk = (i) => {
      if (floorMod(i.y * 12 + i.mo - 1 - aMonth, interval) !== 0) return false;
      if (byMonthDay) return monthDayOk(i) && (!byDay || byDay.includes(i.dow));
      if (byDay) return byDay.includes(i.dow);
      return i.d === a.d;
    };
  }
  return m;
}

// 예약 하나의 반복 정의를 matcher로 만든다. 틀리면 ScheduleError.
function compile(schedule, tz, anchor) {
  if (!schedule || typeof schedule !== "object") throw new ScheduleError("반복 정의가 없습니다.");
  if (!validZone(tz)) throw new ScheduleError(`알 수 없는 시간대입니다: ${tz}`);
  if (schedule.kind === "preset") return presetMatcher(schedule);
  if (schedule.kind === "cron") return cronMatcher(schedule.cron);
  if (schedule.kind === "rrule") return rruleMatcher(schedule.rrule, tz, anchor);
  throw new ScheduleError(`알 수 없는 반복 종류입니다: ${schedule.kind}`);
}

const MAX_DAYS = 3000;
// afterMs 다음(그 시각 자체는 제외)에 처음 오는 실행 시각. 없으면 null.
function nextAfter(matcher, tz, afterMs) {
  const p = partsOf(afterMs, tz);
  const dn0 = Date.UTC(p.y, p.mo - 1, p.d) / DAY;
  for (let k = 0; k < MAX_DAYS; k++) {
    const dn = dn0 + k;
    const date = new Date(dn * DAY);
    const info = { y: date.getUTCFullYear(), mo: date.getUTCMonth() + 1, d: date.getUTCDate(), dow: date.getUTCDay(), dn };
    if (!matcher.dayOk(info)) continue;
    let best = null;
    for (const [h, mi] of matcher.times(info)) {
      const utc = zonedToUtc(info.y, info.mo, info.d, h, mi, tz);
      if (matcher.keep && !matcher.keep(utc)) continue;
      if (utc > afterMs && (best === null || utc < best)) best = utc;
    }
    if (best !== null) return best;
  }
  return null;
}
function nextTimes(matcher, tz, fromMs, count) {
  const out = [];
  let t = fromMs;
  while (out.length < count) {
    t = nextAfter(matcher, tz, t);
    if (t === null) break;
    out.push(t);
  }
  return out;
}
// (from, to] 안의 가장 최근 실행 시각. 빽빽한 규칙은 가까운 3일, 성긴 규칙은 45일까지 거슬러 찾는다.
function latestIn(matcher, tz, from, to) {
  const scan = (lo) => {
    let last = null;
    let t = nextAfter(matcher, tz, lo);
    for (let n = 0; t !== null && t <= to && n < 6000; n++) { last = t; t = nextAfter(matcher, tz, t); }
    return last;
  };
  for (const span of [3 * DAY, 45 * DAY]) {
    const lo = Math.max(from, to - span);
    const hit = scan(lo);
    if (hit !== null) return hit;
    if (lo === from) return null;
  }
  return null;
}

function describe(a) {
  const s = a.schedule ?? {}, tz = a.timezone || localZone();
  let text;
  if (s.kind === "preset") {
    const t = s.time ?? "09:00";
    if (s.preset === "hourly") text = `매시간 ${String(t).split(":")[1] ?? "00"}분`;
    else if (s.preset === "daily") text = `매일 ${t}`;
    else if (s.preset === "weekdays") text = `평일 ${t}`;
    else text = `매주 ${WEEKDAY_KO[Number(s.weekday ?? 1)] ?? "?"} ${t}`;
  } else if (s.kind === "cron") text = `cron ${String(s.cron ?? "").trim()}`;
  else if (s.kind === "rrule") text = `RRULE ${String(s.rrule ?? "").trim().replace(/^RRULE:/i, "")}`;
  else text = "알 수 없음";
  return `${text} · ${tz}`;
}

// ---------------------------------------------------------------- 예약 검사
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const safeToken = /^[A-Za-z0-9._:\-\/\[\]]{1,80}$/;
// git 브랜치 이름 중 안전한 부분집합만 받는다(인자로 넘기므로 -로 시작·공백·제어문자 금지).
const validBranchName = (b) => b.length <= 100 && /^[A-Za-z0-9._\/-]+$/.test(b) && !/^[-\/.]|[\/.]$|\.\.|\/\/|\.lock$|\.lock\//.test(b);
function validateAutomation(a, { checkFolder = true } = {}) {
  const errors = [];
  if (!a || typeof a !== "object") return ["예약 정보가 없습니다."];
  if (typeof a.name !== "string" || !a.name.trim()) errors.push("이름을 입력하세요.");
  else if (a.name.trim().length > 60) errors.push("이름은 60자 이하여야 합니다.");
  if (!PROGRAMS.includes(a.program)) errors.push("프로그램은 claude 또는 codex여야 합니다.");
  if (typeof a.prompt !== "string" || !a.prompt.trim()) errors.push("프롬프트를 입력하세요.");
  for (const key of ["model", "effort"]) {
    if (a[key] !== undefined && a[key] !== null && a[key] !== "" && !safeToken.test(String(a[key]))) errors.push(`${key === "model" ? "모델" : "강도"} 값에 쓸 수 없는 글자가 있습니다.`);
  }
  const tz = a.timezone || localZone();
  if (!validZone(tz)) errors.push(`알 수 없는 시간대입니다: ${tz}`);
  else {
    try { compile(a.schedule, tz, a.createdAt ?? Date.now()); } catch (e) { if (e instanceof ScheduleError) errors.push(e.message); else throw e; }
  }
  if (a.notify !== undefined && a.notify !== null && !NOTIFY_MODES.includes(a.notify)) errors.push("알림은 끄기·문제만·모두 중 하나여야 합니다.");
  const grace = a.graceMinutes ?? DEFAULT_GRACE;
  if (!Number.isInteger(grace) || grace < 0 || grace > 10080) errors.push("놓친 실행 허용 시간은 0~10080분 정수여야 합니다.");
  if (a.precheck && a.precheck.command !== undefined && String(a.precheck.command).trim()) {
    const t = a.precheck.timeoutSec ?? DEFAULT_PRECHECK_TIMEOUT;
    if (!Number.isInteger(t) || t < 1 || t > 600) errors.push("사전 검사 제한 시간은 1~600초 정수여야 합니다.");
  }
  const folder = a.folder;
  if (!folder || !["existing", "worktree"].includes(folder.mode)) errors.push("작업 폴더 방식을 고르세요.");
  else if (typeof folder.path !== "string" || !folder.path.trim()) errors.push("작업 폴더 경로를 입력하세요.");
  else if (checkFolder && !isDir(folder.path)) errors.push(`폴더를 찾지 못했습니다: ${folder.path}`);
  if (folder && folder.mode === "worktree" && folder.base !== undefined && folder.base !== null && String(folder.base).trim() && !validBranchName(String(folder.base).trim())) errors.push("기준 브랜치 이름이 올바르지 않습니다. 영문·숫자·. _ - /만 쓰고 공백, .., -로 시작은 안 됩니다.");
  if (folder && folder.mode === "existing" && folder.base) errors.push("기준 브랜치는 새 워크트리 방식에서만 쓸 수 있습니다.");
  if (folder && folder.mode === "worktree" && a.reuseSession) errors.push("세션 재사용은 기존 폴더 방식에서만 쓸 수 있습니다.");
  return errors;
}

// ---------------------------------------------------------------- 저장소(파일 잠금 + 원자 쓰기)
function sleepSync(ms) { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch {} }
function acquire(file, { waitMs, staleMs }) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const until = Date.now() + waitMs;
  for (;;) {
    try {
      const fd = fs.openSync(file, "wx");
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return true;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      try { if (Date.now() - fs.statSync(file).mtimeMs > staleMs) { fs.unlinkSync(file); continue; } } catch {}
      if (Date.now() >= until) return false;
      sleepSync(25);
    }
  }
}
const release = (file) => { try { fs.unlinkSync(file); } catch {} };
function withLock(fn) {
  if (!acquire(LOCK_FILE, { waitMs: 10000, staleMs: 30000 })) throw new Error("저장소 잠금을 얻지 못했습니다.");
  try { return fn(); } finally { release(LOCK_FILE); }
}
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2));
  fs.renameSync(temp, file);
}
const loadAutos = () => {
  const d = readJson(AUTOS_FILE, null);
  return d && Array.isArray(d.automations) ? d : { version: 1, automations: [] };
};
const loadRuns = () => {
  const d = readJson(RUNS_FILE, null);
  return d && d.runs && typeof d.runs === "object" && !Array.isArray(d.runs) ? d : { version: 1, runs: {} };
};
const newId = () => crypto.randomBytes(4).toString("hex");

// 실행 기록 하나를 만든다(잠금 안에서 부른다). (예약 id, 예정 시각)이 이미 있으면 null이라 같은 회차는 두 번 만들어지지 않는다.
function claimRun(runs, automation, { trigger, scheduledAt, status = "실행 중", now, error }) {
  const list = (runs.runs[automation.id] ??= []);
  if (list.some((r) => r.scheduledAt === scheduledAt && r.trigger !== "수동")) return null;
  const run = { id: newId(), automationId: automation.id, trigger, scheduledAt, startedAt: now, status };
  if (status !== "실행 중") run.finishedAt = now;
  if (error) run.error = error;
  list.unshift(run);
  list.length = Math.min(list.length, KEEP_RUNS);
  return run;
}
function patchRun(runId, patch) {
  return withLock(() => {
    const runs = loadRuns();
    for (const list of Object.values(runs.runs)) {
      const run = list.find((r) => r.id === runId);
      if (run) { Object.assign(run, patch); writeJson(RUNS_FILE, runs); return run; }
    }
    return null;
  });
}

// ---------------------------------------------------------------- 바깥 프로그램 호출(테스트에서 deps로 바꾼다)
function whichHc() {
  if (process.env.SCHEDULES_HC) return process.env.SCHEDULES_HC;
  const probe = spawnSync("hc", ["--version"], { encoding: "utf8", windowsHide: true });
  if (!probe.error) return "hc";
  const local = path.join(os.homedir(), ".local", "bin", WIN ? "hc.exe" : "hc");
  return fs.existsSync(local) ? local : "hc";
}
function defaultDeps() {
  const hcBin = whichHc();
  return {
    now: () => Date.now(),
    hc: (args, timeout = 30000) => {
      const r = spawnSync(hcBin, args, { encoding: "utf8", timeout, windowsHide: true, maxBuffer: 16 << 20 });
      return { code: r.error ? 127 : r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr || (r.error ? String(r.error.message) : "") };
    },
    git: (dir, args, timeout = 60000) => {
      const r = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8", timeout, windowsHide: true });
      return { code: r.error ? 127 : r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr || (r.error ? String(r.error.message) : "") };
    },
    gh: (args, timeout = 30000) => {
      const r = spawnSync("gh", args, { encoding: "utf8", timeout, windowsHide: true });
      return { code: r.error ? 127 : r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr || (r.error ? String(r.error.message) : "") };
    },
    shell: (command, cwd, timeoutMs) => {
      const r = spawnSync(command, { shell: true, cwd, timeout: timeoutMs, encoding: "utf8", windowsHide: true, maxBuffer: 4 << 20 });
      const timedOut = !!(r.error && r.error.code === "ETIMEDOUT") || r.signal === "SIGTERM";
      return { code: r.status, timedOut, error: r.error && !timedOut ? String(r.error.message) : "", stderr: (r.stderr || "").trim() };
    },
    sleep: (ms) => sleepSync(ms),
    spawnWorker: (runId) => {
      const child = spawn(process.execPath, [__filename, "_worker", runId], { detached: true, stdio: "ignore", windowsHide: true, env: process.env });
      child.unref();
      return child.pid;
    },
    pidAlive: (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } },
    osNotify: (title, body) => osNotify(title, body),
  };
}
// OS 알림을 띄운다(기다리지 않고 떼어 낸다). 실패해도 tick은 계속된다.
// macOS는 osascript, Windows는 PowerShell의 WinRT 토스트(BurntToast 없이), 그 밖은 notify-send.
// 제목·본문은 인자나 환경 변수로만 넘겨 명령 문자열에 끼워 넣지 않는다. 어느 쪽도 알림을 눌러 세션을 여는 것은 못 한다.
const WIN_TOAST_SCRIPT = [
  "$ErrorActionPreference='Stop'",
  "[Windows.UI.Notifications.ToastNotificationManager,Windows.UI.Notifications,ContentType=WindowsRuntime]|Out-Null",
  "[Windows.Data.Xml.Dom.XmlDocument,Windows.Data.Xml.Dom.XmlDocument,ContentType=WindowsRuntime]|Out-Null",
  "$t=[Security.SecurityElement]::Escape($env:SCHED_TITLE)",
  "$b=[Security.SecurityElement]::Escape($env:SCHED_BODY)",
  "$x=New-Object Windows.Data.Xml.Dom.XmlDocument",
  "$x.LoadXml(\"<toast><visual><binding template='ToastGeneric'><text>$t</text><text>$b</text></binding></visual></toast>\")",
  "$id='{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'",
  "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($id).Show([Windows.UI.Notifications.ToastNotification]::new($x))",
].join(";");
// macOS는 보낸 앱 이름·아이콘을 osascript가 정하므로(스크립트 편집기로 보일 수 있음) 바꿀 수 없다. 대신 subtitle에 "Herdr 예약"을 붙여 출처를 밝힌다.
const NOTIFY_SOURCE = "Herdr 예약";
function osNotifyCommand(title, body, platform = process.platform) {
  if (platform === "darwin") return { cmd: "osascript", args: ["-e", "on run argv", "-e", "display notification (item 2 of argv) with title (item 1 of argv) subtitle (item 3 of argv)", "-e", "end run", title, body, NOTIFY_SOURCE], env: {} };
  if (platform === "win32") return { cmd: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", WIN_TOAST_SCRIPT], env: { SCHED_TITLE: title, SCHED_BODY: body } };
  return { cmd: "notify-send", args: ["-a", NOTIFY_SOURCE, title, body], env: {} };
}
function osNotify(title, body) {
  if (process.env.SCHEDULES_NO_OS_NOTIFY === "1") return false;
  const c = osNotifyCommand(title, body);
  try {
    const child = spawn(c.cmd, c.args, { detached: true, stdio: "ignore", windowsHide: true, env: { ...process.env, ...c.env } });
    child.on("error", () => {});
    child.unref();
    return true;
  } catch { return false; }
}
const oneLine = (text, max = 200) => String(text ?? "").replace(/\s+/g, " ").trim().slice(0, max);
function hcJson(deps, args) {
  const r = deps.hc(args);
  if (r.code !== 0) return null;
  try { return JSON.parse(r.stdout); } catch { return null; }
}
// `hc get --json`의 status는 {app, kind, msg, state} 객체이고 `hc ls`는 문자열이다. 둘 다 문자열 상태로 맞춘다.
// 없는 터미널(not_found)은 null, 시간 초과 같은 일시 실패는 { transient: true }로 구분한다. 일시 실패를 닫힌 것으로 보면 안 된다.
function getTerminal(deps, address) {
  const r = deps.hc(["get", address, "--json"]);
  if (r.code !== 0) {
    const text = `${r.stdout ?? ""} ${r.stderr ?? ""}`;
    return /not_found|no terminal/i.test(text) ? null : { transient: true };
  }
  let t = null;
  try { t = JSON.parse(r.stdout); } catch { return { transient: true }; }
  if (t && t.status && typeof t.status === "object") t.status = t.status.state;
  return t;
}

// ---------------------------------------------------------------- 실행 상태 갱신
// 최근 실행의 터미널을 hc get으로 다시 보고 상태를 맞춘다.
// 보낸 뒤 turn이 올라가고 status가 idle·done이면 끝난 것이다. 일하는 중(working)을 본 적 없이 idle이면 아직 시작 전일 수 있어 60초는 더 기다린다.
function refreshRun(run, automation, deps, now) {
  if (!run.terminal) {
    if (run.status === "실행 중" && run.workerPid && !deps.pidAlive(run.workerPid) && now - run.startedAt > MIN) return { status: "실패", finishedAt: now, error: run.error || "실행 작업이 터미널을 열기 전에 끝났습니다." };
    if (run.status === "실행 중" && now - run.startedAt > WORKER_STALE_MS) return { status: "실패", finishedAt: now, error: "실행 작업이 끝나지 않아 멈췄다고 봅니다." };
    return null;
  }
  // 작업 프로세스가 아직 시작을 기다리는 중(프롬프트 전)이면 tick이 건드리지 않는다. 결과는 작업 프로세스가 쓴다.
  if (!run.promptSent && run.workerPid && deps.pidAlive(run.workerPid) && now - run.startedAt <= WORKER_STALE_MS) return null;
  const t = getTerminal(deps, run.terminal);
  if (t && t.transient) return null;
  const mine = t && t.labels && t.labels.schedule === run.automationId;
  if (!t || !mine || t.state !== "live") {
    if (t && mine && t.exit_code && t.exit_code !== 0) return { status: "실패", finishedAt: now, error: `프로그램이 종료 코드 ${t.exit_code}로 끝났습니다.` };
    if (run.status === "실행 중" || run.status === "입력 대기") {
      if (run.promptSent === false || (!run.sawWorking && !run.promptSent)) return { status: "실패", finishedAt: now, error: run.error || "프롬프트를 보내기 전에 터미널이 닫혔습니다." };
      return { status: "완료", finishedAt: now, terminalClosed: true };
    }
    return null;
  }
  const patch = {};
  if (t.status === "working" && !run.sawWorking) patch.sawWorking = true;
  const sawWorking = run.sawWorking || patch.sawWorking;
  const advanced = typeof run.turnBefore === "number" ? t.turn > run.turnBefore : true;
  let status = run.status;
  if (t.status === "blocked") status = "입력 대기";
  else if (t.status === "error") status = "실패";
  else if (t.status === "working") status = "실행 중";
  else if ((t.status === "idle" || t.status === "done") && run.promptSent) {
    const settled = sawWorking || advanced || now - (run.sentAt ?? run.startedAt) > MIN;
    if (settled && (run.status === "실행 중" || run.status === "입력 대기")) status = "완료";
    else if (run.status === "입력 대기") status = "실행 중";
  }
  if (status !== run.status) {
    patch.status = status;
    if (status === "완료" || status === "실패") { patch.finishedAt = now; if (status === "실패" && !run.error) patch.error = "프로그램이 오류를 알렸습니다."; }
    if (status === "입력 대기") { patch.finishedAt = now; patch.error = "권한·신뢰·질문 화면에서 멈췄습니다. 터미널에서 직접 답해야 합니다."; } // 멈춘 시각(화면에 "입력 대기 14:03"으로 보인다)
    if (status === "실행 중") { delete run.error; patch.error = null; patch.finishedAt = null; patch.notified = null; }
  }
  return Object.keys(patch).length ? patch : null;
}

// ---------------------------------------------------------------- 알림
const notifyOf = (a) => (NOTIFY_MODES.includes(a && a.notify) ? a.notify : DEFAULT_NOTIFY);
const NOTICE_KIND = {
  "실패": { word: "실패", level: "error", problem: true },
  "입력 대기": { word: "입력 대기", level: "warning", problem: true },
  "놓침": { word: "놓침", level: "warning", problem: true },
  "완료": { word: "완료", level: "success", problem: false },
};
// 알림 글자 길이. 제목은 이름이 길어도 결과 낱말이 끝에 남도록 이름만 줄이고, 본문은 macOS 배너가 자르기 전에 먼저 줄인다.
const NOTICE_NAME_MAX = 20;
const NOTICE_REASON_MAX = 60;
function clip(text, max) {
  const chars = Array.from(String(text ?? "").replace(/\s+/g, " ").trim());
  return chars.length > max ? `${chars.slice(0, max - 1).join("").trimEnd()}…` : chars.join("");
}
// 작업 폴더의 마지막 경로 이름("/a/b/my-app/" → "my-app"). / 와 \ 둘 다 구분자로 본다.
function folderShortName(folderPath) {
  const parts = String(folderPath ?? "").split(/[\\/]+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : "";
}
// 알림 제목 "예약 · 점검 — 완료": 이름이 먼저, 결과가 뒤. 본문 첫 줄은 "11/24(화) 오전 10:05 · my-app", 문제일 때만 둘째 줄에 이유.
function noticeTitle(name, word) { return `예약 · ${clip(name, NOTICE_NAME_MAX) || "(이름 없음)"} — ${word}`; }
function noticeBody(a, run, at, tz) {
  const head = [shortStampOf(at, tz), folderShortName(a.folder && a.folder.path)].filter(Boolean).join(" · ");
  const reason = run.status === "완료" ? "" : clip(run.error, NOTICE_REASON_MAX);
  return reason ? `${head}\n${reason}` : head;
}
// 끝났거나 멈춘 기록 중 아직 알리지 않은 것을 모아 한 번씩만 알린다.
// 기록에 notified=<상태>를 먼저 남기고 보내므로, 같은 결과는 tick이 몇 번 돌아도 한 번만 나간다(최대 한 번).
// 다시 실행 중으로 돌아가면 notified를 지워서(refreshRun) 다음 결과를 또 알린다.
function collectNotices(deps, now) {
  const store = loadAutos(), runsNow = loadRuns();
  const found = [];
  for (const a of store.automations) {
    const mode = notifyOf(a);
    if (mode === "off") continue;
    for (const run of runsNow.runs[a.id] ?? []) {
      const kind = NOTICE_KIND[run.status];
      if (!kind || run.notified === run.status) continue;
      if (kind.problem === false && mode !== "all") continue;
      const at = run.finishedAt ?? run.startedAt ?? 0;
      if (now - at > NOTIFY_MAX_AGE_MS) continue;
      found.push({ a, run, kind, at });
    }
  }
  // 한 번에 다 못 보내면 가장 새 알림 NOTIFY_MAX_PER_TICK건을 보내고, 오래된 것은 "N건 더" 하나로 접는다. 접힌 것도 알린 것으로 표시한다.
  found.sort((x, y) => y.at - x.at);
  const notices = [];
  for (const { a, run, kind, at } of found) {
    patchRun(run.id, { notified: run.status });
    if (notices.length >= NOTIFY_MAX_PER_TICK) continue;
    const tz = a.timezone || localZone();
    notices.unshift({ runId: run.id, automationId: a.id, name: a.name, status: run.status, title: noticeTitle(a.name, kind.word), body: noticeBody(a, run, at, tz), level: kind.level, terminal: run.terminal ?? null });
  }
  const more = found.length - notices.length;
  if (more > 0) notices.push({ runId: null, automationId: null, name: "", status: "요약", title: `예약 · 알림 ${more}건 더`, body: "예약 화면의 기록에서 확인하세요.", level: "info", terminal: null });
  for (const n of notices) {
    try { if (typeof deps.osNotify === "function") deps.osNotify(n.title, n.body); } catch {}
  }
  return notices;
}

// ---------------------------------------------------------------- tick
function tick(deps = defaultDeps()) {
  if (!acquire(TICK_LOCK_FILE, { waitMs: 0, staleMs: 3 * MIN })) return { ok: true, skipped: "다른 tick이 돌고 있습니다." };
  try {
    const now = deps.now();
    const started = [], recorded = [];
    withLock(() => {
      const store = loadAutos();
      const runs = loadRuns();
      let changed = false;
      for (const a of store.automations) {
        const cursor = typeof a.cursor === "number" ? a.cursor : a.createdAt ?? now;
        if (!a.enabled) { if (a.cursor !== now) { a.cursor = now; changed = true; } continue; }
        let occ = null;
        try {
          const tz = a.timezone || localZone();
          occ = latestIn(compile(a.schedule, tz, a.createdAt ?? now), tz, cursor, now);
        } catch { occ = null; }
        a.cursor = now;
        changed = true;
        if (occ === null) continue;
        const grace = Math.max((a.graceMinutes ?? DEFAULT_GRACE) * MIN, ON_TIME_MS);
        const late = now - occ;
        if (late <= grace) {
          const run = claimRun(runs, a, { trigger: late <= ON_TIME_MS ? "예약" : "놓친 실행", scheduledAt: occ, now });
          if (run) { started.push(run.id); recorded.push(run); }
        } else {
          const tz = a.timezone || localZone();
          claimRun(runs, a, { trigger: "예약", scheduledAt: occ, status: "놓침", now, error: `예정 ${stampOf(occ, tz)} 실행을 앱이 꺼져 있어 ${Math.round(late / MIN)}분 늦게 확인했고, 허용 시간(${a.graceMinutes ?? DEFAULT_GRACE}분)이 지나 실행하지 않았습니다.` });
        }
      }
      if (changed) writeJson(AUTOS_FILE, store);
      writeJson(RUNS_FILE, runs);
    });
    for (const id of started) {
      const pid = deps.spawnWorker(id);
      patchRun(id, { workerPid: pid });
    }
    // 실행 중·입력 대기인 기록의 터미널 상태를 갱신한다.
    let refreshed = 0;
    const store = loadAutos(), runsNow = loadRuns();
    for (const a of store.automations) {
      for (const run of runsNow.runs[a.id] ?? []) {
        if (run.status !== "실행 중" && run.status !== "입력 대기") continue;
        if (started.includes(run.id)) continue;
        const patch = refreshRun(run, a, deps, now);
        if (patch) { patchRun(run.id, patch); refreshed++; }
      }
    }
    const notices = collectNotices(deps, now);
    return { ok: true, started, refreshed, notices };
  } finally {
    release(TICK_LOCK_FILE);
  }
}

// ---------------------------------------------------------------- 실행(작업 프로세스)
const stamp = (ms) => {
  const d = new Date(ms), p = (n, w = 2) => String(n).padStart(w, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
};
const slugOf = (name) => String(name).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 30) || "run";

// 저장소 본 폴더(작업 폴더가 워크트리여도 본 폴더)와 기본 브랜치 참조를 찾는다.
function repoInfo(deps, dir) {
  const top = deps.git(dir, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (top.code !== 0) return null;
  let common = top.stdout.trim();
  if (!common) return null;
  const main = path.basename(common) === ".git" ? path.dirname(common) : common;
  return { main, common };
}
function baseRef(deps, main) {
  const head = deps.git(main, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  if (head.code === 0 && head.stdout.trim()) return head.stdout.trim();
  for (const name of ["origin/main", "origin/master"]) if (deps.git(main, ["rev-parse", "--verify", "--quiet", name]).code === 0) return name;
  return "HEAD";
}
// 기준 브랜치를 지정했으면 origin/<기준>, 없으면 로컬 <기준>. 둘 다 없으면 실패. 비우면 저장소의 기본 브랜치.
function pickBase(deps, main, name) {
  const want = typeof name === "string" ? name.trim() : "";
  if (!want) return baseRef(deps, main);
  if (!validBranchName(want)) throw new Error(`기준 브랜치 이름이 올바르지 않습니다: ${want}`);
  for (const ref of [`refs/remotes/origin/${want}`, `refs/heads/${want}`]) {
    if (deps.git(main, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).code === 0) return ref;
  }
  throw new Error(`기준 브랜치를 찾지 못했습니다: ${want}`);
}
function ensureExclude(common) {
  const file = path.join(common, "info", "exclude");
  let text = "";
  try { text = fs.readFileSync(file, "utf8"); } catch {}
  if (text.split(/\r?\n/).includes("/auto-*/")) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${text && !text.endsWith("\n") ? "\n" : ""}/auto-*/\n`);
}
function makeWorktree(deps, a, now) {
  const repo = repoInfo(deps, a.folder.path);
  if (!repo) throw new Error(`git 저장소가 아닙니다: ${a.folder.path}`);
  const fetched = deps.git(repo.main, ["fetch", "origin"], 120000);
  const warning = fetched.code === 0 ? "" : `git fetch origin 실패(${oneLine(fetched.stderr, 120)}), 가지고 있던 origin 기준으로 만들었습니다.`;
  const base = pickBase(deps, repo.main, a.folder.base);
  ensureExclude(repo.common);
  const slug = slugOf(a.name), time = stamp(now);
  for (let n = 0; n < 20; n++) {
    const suffix = n ? `-${n + 1}` : "";
    const folder = path.join(repo.main, `auto-${slug}-${time}${suffix}`);
    const branch = `auto/${slug}-${time}${suffix}`;
    if (fs.existsSync(folder) || deps.git(repo.main, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]).code === 0) continue;
    const r = deps.git(repo.main, ["worktree", "add", "--no-track", "-b", branch, folder, base], 120000);
    if (r.code !== 0) throw new Error(`워크트리를 만들지 못했습니다: ${oneLine(r.stderr, 200)}`);
    return { folder, branch, warning };
  }
  throw new Error("워크트리 이름을 정하지 못했습니다.");
}

function launchArgs(a, name, cwd) {
  const argv = [];
  if (!WIN) argv.push("env", `PATH=${process.env.PATH ?? ""}`);
  if (a.program === "claude") {
    argv.push("claude", "--permission-mode", "auto");
    if (a.model) argv.push("--model", String(a.model));
    if (a.effort) argv.push("--effort", String(a.effort));
  } else {
    argv.push("codex", "--approve-for-me");
    if (a.model) argv.push("--model", String(a.model));
    if (a.effort) argv.push("-c", `model_reasoning_effort="${a.effort}"`);
  }
  return ["run", "--bg", "--json", "--no-parent", "--name", name, "--cwd", cwd, "--label", `schedule=${a.id}`, "--label", `session=예약 · ${a.name}`, "--", ...argv];
}

// 일부 프로그램(예: Codex 업데이트 안내)은 선택 화면에서 status를 알리지 않는다. 시간이 다 된 뒤 화면에 선택 안내가 보이면 입력 대기로 본다.
function looksLikePrompt(deps, terminal) {
  const r = deps.hc(["read", terminal]);
  if (r.code !== 0) return false;
  return /enter (to )?(continue|confirm)|esc (to )?(skip|cancel)|\(y\/n\)|\[y\/n\]|^\s*[›>❯]\s*1\./im.test(r.stdout || "");
}
// 프롬프트를 보낼 수 있게 될 때까지 기다린다. 'idle' 이면 보낸다, 'blocked'·종료는 그대로 알린다.
function waitIdle(deps, terminal, { timeoutMs = 90000 } = {}) {
  const until = deps.now() + timeoutMs;
  for (;;) {
    const t = getTerminal(deps, terminal);
    if (t && t.transient) {
      if (deps.now() >= until) return { state: "timeout" };
      deps.sleep(1000);
      continue;
    }
    if (!t || t.state !== "live") return { state: "gone" };
    if (t.status === "blocked") return { state: "blocked", turn: t.turn };
    if (t.status === "error") return { state: "error", turn: t.turn };
    if (t.status === "idle" || t.status === "done") return { state: "idle", turn: t.turn };
    if (deps.now() >= until) return { state: looksLikePrompt(deps, terminal) ? "blocked" : "timeout", turn: t.turn };
    deps.sleep(1000);
  }
}
function sendPrompt(deps, terminal, prompt) {
  const r = deps.hc(["send", "--json", "--", terminal, prompt], 90000);
  return r.code === 0 ? null : oneLine(r.stderr || r.stdout, 200) || "hc send 실패";
}

// 한 번의 실행을 끝까지 진행한다. 결과는 run 기록에 쓴다.
function execute(runId, deps = defaultDeps()) {
  const store = loadAutos(), runs = loadRuns();
  let run = null;
  for (const list of Object.values(runs.runs)) run = run || list.find((r) => r.id === runId);
  if (!run) return { ok: false, error: `실행 기록을 찾지 못했습니다: ${runId}` };
  const a = store.automations.find((x) => x.id === run.automationId);
  const finish = (patch) => patchRun(runId, { finishedAt: deps.now(), ...patch });
  if (!a) return finish({ status: "실패", error: "예약이 삭제됐습니다." });
  const now = deps.now();
  try {
    const runBase = a.folder.mode === "worktree" ? (repoInfo(deps, a.folder.path) ?? { main: a.folder.path }).main : a.folder.path;
    if (!isDir(runBase)) return finish({ status: "실패", error: `폴더를 찾지 못했습니다: ${a.folder.path}` });
    // 사전 검사는 예약된 실행에서만 돈다. 지금 실행(수동)은 건너뛴다.
    if (run.trigger !== "수동" && a.precheck && String(a.precheck.command ?? "").trim()) {
      const timeoutSec = a.precheck.timeoutSec ?? DEFAULT_PRECHECK_TIMEOUT;
      const r = deps.shell(a.precheck.command, runBase, timeoutSec * 1000);
      if (r.timedOut) return finish({ status: "검사로 건너뜀", error: `사전 검사가 ${timeoutSec}초 안에 끝나지 않았습니다.` });
      if (r.error) return finish({ status: "검사로 건너뜀", error: `사전 검사를 실행하지 못했습니다: ${oneLine(r.error, 120)}` });
      if (r.code !== 0) return finish({ status: "검사로 건너뜀", error: `사전 검사 종료 코드 ${r.code}${r.stderr ? `: ${oneLine(r.stderr, 120)}` : ""}` });
    }
    let cwd = a.folder.path;
    const patch = {};
    if (a.folder.mode === "worktree") {
      const wt = makeWorktree(deps, a, now);
      cwd = wt.folder;
      patch.worktree = wt.folder;
      patch.branch = wt.branch;
      if (wt.warning) patch.note = wt.warning;
      patchRun(runId, patch);
    }
    // 세션 재사용: 기존 폴더 방식이고, 지난 실행의 터미널이 살아 있으면 거기로 보낸다.
    if (a.folder.mode === "existing" && a.reuseSession) {
      const prev = (loadRuns().runs[a.id] ?? []).find((r) => r.id !== runId && r.terminal);
      const t = prev && getTerminal(deps, prev.terminal);
      if (t && !t.transient && t.state === "live" && t.labels && t.labels.schedule === a.id) {
        if (t.status === "blocked") return finish({ status: "입력 대기", terminal: prev.terminal, reused: true, error: "이전 세션이 권한·질문 화면에서 멈춰 있어 보내지 않았습니다." });
        if (t.status === "working") return finish({ status: "실패", terminal: prev.terminal, reused: true, error: "이전 세션이 아직 일하는 중이라 보내지 않았습니다. 끝난 뒤 다시 보내기를 누르세요." });
        const err = sendPrompt(deps, prev.terminal, a.prompt);
        if (err) return finish({ status: "실패", terminal: prev.terminal, reused: true, error: err });
        return patchRun(runId, { terminal: prev.terminal, terminalName: t.name ?? null, reused: true, promptSent: true, sentAt: deps.now(), turnBefore: t.turn, status: "실행 중" });
      }
    }
    const name = `sched-${a.id.slice(0, 6)}-${stamp(now).replace("-", "")}${run.id.slice(0, 2)}`.slice(0, 32);
    const launched = deps.hc(launchArgs(a, name, cwd));
    if (launched.code !== 0) return finish({ status: "실패", error: oneLine(launched.stderr || launched.stdout, 200) || "hc run 실패" });
    let info = null;
    try { info = JSON.parse(launched.stdout); } catch {}
    const address = info && (info.address || (info.terminal && info.terminal.address));
    const terminal = address || name;
    patchRun(runId, { terminal, terminalName: name });
    // 첫 프롬프트는 인자로 넘기지 않는다(멈춘 적이 있다). 입력창이 열리면(idle) 보낸다.
    const ready = waitIdle(deps, terminal);
    if (ready.state === "blocked") return finish({ status: "입력 대기", error: "시작 화면(폴더 신뢰·권한·질문)에서 멈췄습니다. 터미널에서 직접 답해야 합니다." });
    if (ready.state === "gone") return finish({ status: "실패", error: "프로그램이 시작하자마자 끝났습니다. 설치와 로그인을 확인하세요." });
    if (ready.state !== "idle") return finish({ status: "실패", error: ready.state === "error" ? "프로그램이 시작 중 오류를 알렸습니다." : "시작 후 90초가 지나도 입력 준비 상태가 되지 않았습니다." });
    const err = sendPrompt(deps, terminal, a.prompt);
    if (err) return finish({ status: "실패", error: err });
    return patchRun(runId, { promptSent: true, sentAt: deps.now(), turnBefore: ready.turn, status: "실행 중" });
  } catch (e) {
    return finish({ status: "실패", error: oneLine(e.message, 200) });
  }
}

// 지금 실행: 기록을 만들고 작업을 따로 띄운 뒤 바로 돌아온다. wait이면 이 프로세스에서 끝까지 진행한다.
function runNow(id, { manual = true, wait = false } = {}, deps = defaultDeps()) {
  const now = deps.now();
  const result = withLock(() => {
    const store = loadAutos();
    const a = store.automations.find((x) => x.id === id);
    if (!a) return { error: `예약을 찾지 못했습니다: ${id}` };
    const errors = validateAutomation(a);
    if (errors.length) return { error: errors[0] };
    const runs = loadRuns();
    const run = claimRun(runs, a, { trigger: manual ? "수동" : "예약", scheduledAt: now, now });
    if (!run) return { error: "같은 회차가 이미 기록돼 있습니다." };
    writeJson(RUNS_FILE, runs);
    return { run };
  });
  if (result.error) return { ok: false, error: result.error };
  if (wait) return { ok: true, runId: result.run.id, run: execute(result.run.id, deps) };
  const pid = deps.spawnWorker(result.run.id);
  patchRun(result.run.id, { workerPid: pid });
  return { ok: true, runId: result.run.id };
}

// ---------------------------------------------------------------- 화면용 명령
function view(a, runs, now) {
  const tz = a.timezone || localZone();
  let next = null;
  try { if (a.enabled) next = nextAfter(compile(a.schedule, tz, a.createdAt ?? now), tz, now); } catch {}
  const list = runs.runs[a.id] ?? [];
  return { ...a, timezone: tz, summary: describe(a), nextRun: next, last: list[0] ?? null };
}
function list(deps = defaultDeps()) {
  const now = deps.now();
  const store = loadAutos(), runs = loadRuns();
  return { ok: true, now, timezone: localZone(), automations: store.automations.map((a) => view(a, runs, now)) };
}
function validate(input, deps = defaultDeps()) {
  const now = deps.now();
  const errors = validateAutomation(input);
  let next = [];
  if (!errors.some((e) => /반복|cron|RRULE|FREQ|INTERVAL|BY|프리셋|시각|요일|시간대|칸/.test(e))) {
    try {
      const tz = input.timezone || localZone();
      next = nextTimes(compile(input.schedule, tz, input.createdAt ?? now), tz, now, 3);
    } catch {}
  }
  return { ok: errors.length === 0, errors, next, summary: input && input.schedule ? describe({ ...input, timezone: input.timezone || localZone() }) : "" };
}
function save(input, deps = defaultDeps()) {
  const now = deps.now();
  const errors = validateAutomation(input);
  if (errors.length) return { ok: false, errors, error: errors[0] };
  return withLock(() => {
    const store = loadAutos();
    const tz = input.timezone || localZone();
    const clean = {
      name: input.name.trim(),
      enabled: input.enabled !== false,
      program: input.program,
      prompt: input.prompt,
      model: input.model ? String(input.model) : "",
      effort: input.effort ? String(input.effort) : "",
      schedule: input.schedule,
      timezone: tz,
      graceMinutes: input.graceMinutes ?? DEFAULT_GRACE,
      notify: input.notify || DEFAULT_NOTIFY,
      precheck: input.precheck && String(input.precheck.command ?? "").trim() ? { command: String(input.precheck.command), timeoutSec: input.precheck.timeoutSec ?? DEFAULT_PRECHECK_TIMEOUT } : null,
      folder: { mode: input.folder.mode, path: input.folder.path, ...(input.folder.mode === "worktree" && input.folder.base && String(input.folder.base).trim() ? { base: String(input.folder.base).trim() } : {}) },
      reuseSession: input.folder.mode === "existing" && !!input.reuseSession,
    };
    const old = input.id ? store.automations.find((x) => x.id === input.id) : null;
    let saved;
    if (old) {
      // 반복·시간대·켜기 상태가 바뀌면 지금부터 센다(지난 시각을 뒤늦게 실행하지 않는다).
      const same = JSON.stringify(old.schedule) === JSON.stringify(clean.schedule) && old.timezone === clean.timezone && old.enabled === clean.enabled;
      saved = Object.assign(old, clean, { cursor: same ? old.cursor : now });
    } else {
      saved = { id: newId(), createdAt: now, cursor: now, ...clean };
      store.automations.push(saved);
    }
    writeJson(AUTOS_FILE, store);
    return { ok: true, automation: view(saved, loadRuns(), now) };
  });
}
function remove(id) {
  return withLock(() => {
    const store = loadAutos();
    const n = store.automations.length;
    store.automations = store.automations.filter((x) => x.id !== id);
    if (store.automations.length === n) return { ok: false, error: `예약을 찾지 못했습니다: ${id}` };
    writeJson(AUTOS_FILE, store);
    const runs = loadRuns();
    delete runs.runs[id];
    writeJson(RUNS_FILE, runs);
    return { ok: true };
  });
}
function toggle(id, on, deps = defaultDeps()) {
  const now = deps.now();
  return withLock(() => {
    const store = loadAutos();
    const a = store.automations.find((x) => x.id === id);
    if (!a) return { ok: false, error: `예약을 찾지 못했습니다: ${id}` };
    if (on && !a.folder.path) return { ok: false, error: "작업 폴더를 먼저 고르세요. 편집에서 폴더를 지정해야 켤 수 있습니다." };
    if (a.enabled !== on) { a.enabled = on; a.cursor = now; writeJson(AUTOS_FILE, store); }
    return { ok: true, enabled: a.enabled };
  });
}
function nextCmd({ id, spec, count }, deps = defaultDeps()) {
  const now = deps.now();
  let a = spec;
  if (id) a = loadAutos().automations.find((x) => x.id === id);
  if (!a) return { ok: false, error: id ? `예약을 찾지 못했습니다: ${id}` : "예약 정보가 없습니다." };
  try {
    const tz = a.timezone || localZone();
    return { ok: true, next: nextTimes(compile(a.schedule, tz, a.createdAt ?? now), tz, now, count) };
  } catch (e) {
    if (e instanceof ScheduleError) return { ok: false, error: e.message };
    throw e;
  }
}

// ---------------------------------------------------------------- 문서 저장소에 기록·불러오기
// 사용자가 고른 git 저장소의 herdr-schedules/에 예약 하나당 JSON 하나를 둔다(PC를 옮겨도 복원). 실행 기록·토큰·절대경로는 쓰지 않는다.
const SYNC_DIR = "herdr-schedules";
const NOREPLY = /@users\.noreply\.github\.com$/i;
const readSettings = () => readJson(SETTINGS_FILE, {});
// 비교용 정규화(계정 정보·.git·scp/ssh 표기 차이 제거)와 저장용 정리(URL의 계정:토큰 제거).
function normRemote(url) {
  let u = String(url ?? "").trim();
  const m = u.match(/^[\w.-]+@([^:\/]+):(.+)$/);
  u = m ? `${m[1]}/${m[2]}` : u.replace(/^[a-z+]+:\/\//i, "").replace(/^[^@\/]*@/, "");
  return u.replace(/\.git$/i, "").replace(/\/+$/, "").toLowerCase();
}
const cleanRemote = (url) => String(url ?? "").trim().replace(/^([a-z+]+:\/\/)[^@\/]*@/i, "$1");
// remote.origin.url 원문(insteadOf 치환 전)을 쓴다.
const originUrl = (deps, dir) => { const r = deps.git(dir, ["config", "--get", "remote.origin.url"]); return r.code === 0 ? cleanRemote(r.stdout) : ""; };

function syncRoot(deps) {
  const saved = readSettings().syncRepo;
  if (!saved) return { error: "기록 저장소를 먼저 고르세요." };
  const top = deps.git(saved, ["rev-parse", "--show-toplevel"]);
  if (top.code !== 0 || !top.stdout.trim()) return { error: `기록 저장소를 열지 못했습니다(git 저장소가 맞나요?): ${saved}` };
  return { root: top.stdout.trim() };
}
function syncStatus(deps = defaultDeps()) {
  const r = syncRoot(deps);
  if (r.error) return { ok: true, repo: null, error: readSettings().syncRepo ? r.error : "" };
  const email = deps.git(r.root, ["config", "user.email"]).stdout.trim();
  return { ok: true, repo: r.root, name: path.basename(r.root), emailOk: NOREPLY.test(email) };
}
function setSyncRepo(dir, deps = defaultDeps()) {
  const want = String(dir ?? "").trim();
  if (!want || !isDir(want)) return { ok: false, error: `폴더를 찾지 못했습니다: ${want}` };
  const top = deps.git(want, ["rev-parse", "--show-toplevel"]);
  if (top.code !== 0 || !top.stdout.trim()) return { ok: false, error: "git 저장소 폴더가 아닙니다." };
  withLock(() => writeJson(SETTINGS_FILE, { ...readSettings(), syncRepo: top.stdout.trim() }));
  return syncStatus(deps);
}
// 공개 여부: private | public | local(원격 없음) | unknown(GitHub가 아니거나 gh로 확인 못 함)
function repoVisibility(deps, root) {
  const url = originUrl(deps, root);
  if (!url) return "local";
  const m = normRemote(url).match(/^github\.com\/([^\/]+\/[^\/]+)$/);
  if (!m) return "unknown";
  const g = deps.gh(["repo", "view", m[1], "--json", "isPrivate", "--jq", ".isPrivate"]);
  const t = g.code === 0 ? g.stdout.trim() : "";
  return t === "true" ? "private" : t === "false" ? "public" : "unknown";
}

// 저장소 파일 한 개의 내용. 작업 폴더는 "폴더 이름 + 원격 URL"로만 적는다.
function recordOf(a, deps) {
  const f = a.folder;
  const where = f.path ? { name: f.path.split(/[\\/]/).filter(Boolean).pop() ?? "", remote: originUrl(deps, f.path) } : { name: f.hint?.name ?? "", remote: f.hint?.remote ?? "" };
  return {
    version: 1, id: a.id, name: a.name, program: a.program, model: a.model || "", effort: a.effort || "", prompt: a.prompt,
    schedule: a.schedule, timezone: a.timezone || localZone(), createdAt: a.createdAt, graceMinutes: a.graceMinutes ?? DEFAULT_GRACE,
    notify: a.notify || DEFAULT_NOTIFY, precheck: a.precheck ?? null,
    folder: { mode: f.mode, ...where, ...(f.base ? { base: f.base } : {}) }, reuseSession: !!a.reuseSession,
  };
}

// 예약 하나(id) 또는 전부를 기록 → 커밋 → 일반 push. push가 막히면 커밋은 남기고 이유를 돌려준다.
function record({ id, all = false, confirmPublic = false } = {}, deps = defaultDeps()) {
  const r = syncRoot(deps);
  if (r.error) return { ok: false, error: r.error };
  const email = deps.git(r.root, ["config", "user.email"]).stdout.trim();
  if (!NOREPLY.test(email)) return { ok: false, code: "email", error: `기록 저장소의 커밋 이메일이 GitHub noreply 주소가 아니라 기록하지 않았습니다(${email || "설정 없음"}). 그 저장소에서 git config user.email을 noreply 주소로 바꾸세요.` };
  const autos = loadAutos().automations;
  const picks = all ? autos : autos.filter((x) => x.id === id);
  if (!picks.length) return { ok: false, error: all ? "기록할 예약이 없습니다." : `예약을 찾지 못했습니다: ${id}` };
  const visibility = repoVisibility(deps, r.root);
  if (!confirmPublic && visibility !== "private" && visibility !== "local") {
    return { ok: false, needsConfirm: "public", visibility, error: visibility === "public" ? "공개 저장소입니다. 프롬프트가 누구에게나 보입니다. 비공개 저장소를 권장합니다." : "저장소의 공개 여부를 확인하지 못했습니다. 공개 저장소면 프롬프트가 누구에게나 보입니다." };
  }
  const dir = path.join(r.root, SYNC_DIR);
  fs.mkdirSync(dir, { recursive: true });
  for (const a of picks) {
    const file = `${slugOf(a.name)}-${a.id}.json`;
    for (const old of fs.readdirSync(dir)) if (old !== file && old.endsWith(`-${a.id}.json`)) fs.unlinkSync(path.join(dir, old)); // 이름을 바꿨으면 옛 파일은 지운다
    fs.writeFileSync(path.join(dir, file), `${JSON.stringify(recordOf(a, deps), null, 2)}\n`);
  }
  const added = deps.git(r.root, ["add", "-A", "--", SYNC_DIR]);
  if (added.code !== 0) return { ok: false, error: `git add 실패: ${oneLine(added.stderr, 200)}` };
  if (deps.git(r.root, ["diff", "--cached", "--quiet", "--", SYNC_DIR]).code === 0) return { ok: true, count: picks.length, changed: false };
  const msg = picks.length === 1 ? `📝[Docs]: 예약 기록 — ${picks[0].name}` : `📝[Docs]: 예약 ${picks.length}개 기록`;
  const committed = deps.git(r.root, ["commit", "-m", msg, "--", SYNC_DIR]);
  if (committed.code !== 0) return { ok: false, error: `git commit 실패: ${oneLine(committed.stderr || committed.stdout, 200)}` };
  const pushed = deps.git(r.root, ["push", "origin", "HEAD"], 120000);
  if (pushed.code !== 0) return { ok: false, committed: true, pushed: false, count: picks.length, error: `커밋은 남겼지만 push하지 못했습니다: ${oneLine(pushed.stderr, 200)}` };
  return { ok: true, committed: true, pushed: true, changed: true, count: picks.length };
}

// 저장소 파일 → 예약. 항상 꺼진 채로 만들고, 작업 폴더는 같은 원격 URL을 가진 이 PC 폴더에 연결한다(없으면 path를 비우고 hint만 둔다).
function fromRecord(rec, now, findFolder) {
  if (!rec || typeof rec !== "object" || !/^[0-9a-f]{8}$/.test(String(rec.id)) || !Number.isFinite(rec.createdAt)) return { error: "id·createdAt이 올바르지 않습니다." };
  const f = rec.folder && typeof rec.folder === "object" ? rec.folder : {};
  const hint = { name: String(f.name ?? ""), remote: cleanRemote(f.remote) };
  const linked = findFolder(hint);
  const auto = {
    id: rec.id, createdAt: rec.createdAt, cursor: now, name: String(rec.name ?? "").trim(), enabled: false, program: rec.program, prompt: rec.prompt,
    model: rec.model ? String(rec.model) : "", effort: rec.effort ? String(rec.effort) : "", schedule: rec.schedule, timezone: rec.timezone || localZone(),
    graceMinutes: rec.graceMinutes ?? DEFAULT_GRACE, notify: rec.notify || DEFAULT_NOTIFY,
    precheck: rec.precheck && String(rec.precheck.command ?? "").trim() ? { command: String(rec.precheck.command), timeoutSec: rec.precheck.timeoutSec ?? DEFAULT_PRECHECK_TIMEOUT } : null,
    folder: { mode: f.mode, path: linked || "", ...(f.mode === "worktree" && f.base ? { base: String(f.base) } : {}), ...(linked ? {} : { hint }) },
    reuseSession: f.mode === "existing" && !!rec.reuseSession,
  };
  const errors = validateAutomation({ ...auto, folder: { ...auto.folder, path: auto.folder.path || "-" } }, { checkFolder: false });
  return errors.length ? { error: errors[0] } : { auto, linked: Boolean(linked) };
}

// 아직 없는 예약만 추가한다. 사전 확인 명령이 있으면 ack 없이는 아무것도 추가하지 않고 명령을 돌려준다(가져올 때 실행하지 않는다).
function importFromRepo({ ack = false, folders = [] } = {}, deps = defaultDeps()) {
  const r = syncRoot(deps);
  if (r.error) return { ok: false, error: r.error };
  const dir = path.join(r.root, SYNC_DIR);
  let files = [];
  try { files = fs.readdirSync(dir).filter((x) => x.endsWith(".json")).sort(); } catch {}
  if (!files.length) return { ok: false, error: `저장소에 ${SYNC_DIR}/ 기록이 없습니다.` };
  const now = deps.now();
  const known = new Set(loadAutos().automations.map((x) => x.id));
  const candidates = [...new Set([...loadAutos().automations.map((x) => x.folder && x.folder.path), ...folders])].filter((p) => typeof p === "string" && p && isDir(p));
  const remotes = new Map(candidates.map((p) => [p, normRemote(originUrl(deps, p))]));
  const findFolder = (hint) => {
    const want = normRemote(hint.remote);
    return candidates.find((p) => (want ? remotes.get(p) === want : hint.name && path.basename(p) === hint.name));
  };
  const items = [], skipped = [];
  let existing = 0;
  for (const file of files) {
    let rec = null;
    try { rec = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")); } catch { skipped.push({ file, reason: "JSON을 읽지 못했습니다." }); continue; }
    if (known.has(rec && rec.id)) { existing++; continue; }
    const one = fromRecord(rec, now, findFolder);
    if (one.error) skipped.push({ file, reason: one.error });
    else items.push(one);
  }
  const needsConfirm = items.filter((x) => x.auto.precheck).map((x) => ({ id: x.auto.id, name: x.auto.name, command: x.auto.precheck.command }));
  if (needsConfirm.length && !ack) return { ok: false, needsConfirm, error: "사전 확인 명령이 들어 있습니다. 명령을 확인한 뒤 불러오세요." };
  const added = withLock(() => {
    const store = loadAutos();
    const fresh = items.filter((x) => !store.automations.some((y) => y.id === x.auto.id));
    store.automations.push(...fresh.map((x) => x.auto));
    if (fresh.length) writeJson(AUTOS_FILE, store);
    return fresh;
  });
  return { ok: true, added: added.length, existing, skipped, unlinked: added.filter((x) => !x.linked).map((x) => x.auto.name) };
}

// ---------------------------------------------------------------- CLI
// ---------------------------------------------------------------- 선택 화면용 목록
// Codex 모델·강도는 Codex가 받아 둔 ~/.codex/models_cache.json에서 읽는다(숨김 모델 제외). 읽지 못하면 모델은 비워 두고 강도만 기본 목록을 쓴다.
const CODEX_FALLBACK_EFFORTS = ["low", "medium", "high", "xhigh"];
const codexCachePath = () => process.env.SCHEDULES_CODEX_CACHE || path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "models_cache.json");
function codexModels() {
  const d = readJson(codexCachePath(), null);
  const list = d && Array.isArray(d.models) ? d.models : null;
  if (!list) return { fromCache: false, models: [], efforts: CODEX_FALLBACK_EFFORTS };
  const models = list
    .filter((m) => m && typeof m.slug === "string" && safeToken.test(m.slug) && m.visibility !== "hide")
    .sort((a, b) => (Number(a.priority) || 0) - (Number(b.priority) || 0))
    .map((m) => {
      const efforts = (Array.isArray(m.supported_reasoning_levels) ? m.supported_reasoning_levels : [])
        .map((x) => (typeof x === "string" ? x : x && x.effort))
        .filter((x) => typeof x === "string" && safeToken.test(x));
      return { slug: m.slug, name: typeof m.display_name === "string" && m.display_name ? m.display_name : m.slug, efforts: efforts.length ? efforts : CODEX_FALLBACK_EFFORTS, defaultEffort: typeof m.default_reasoning_level === "string" ? m.default_reasoning_level : "" };
    });
  return { fromCache: true, models, efforts: CODEX_FALLBACK_EFFORTS };
}
// 기준 브랜치 선택지: origin의 브랜치(저장소 기본 브랜치가 맨 앞), 원격에 없는 로컬 브랜치는 뒤에.
function branchOptions(deps, dir) {
  const info = repoInfo(deps, dir);
  if (!info) return { isRepo: false, branches: [], defaultBranch: "" };
  const lines = (r) => (r.code === 0 ? r.stdout.split(/\r?\n/).map((x) => x.trim()).filter(Boolean) : []);
  const remote = lines(deps.git(info.main, ["for-each-ref", "--format=%(refname:short)", "refs/remotes/origin"]))
    .map((x) => x.replace(/^origin\//, "")).filter((x) => x !== "HEAD" && x !== "origin");
  const local = lines(deps.git(info.main, ["for-each-ref", "--format=%(refname:short)", "refs/heads"]));
  const ref = baseRef(deps, info.main);
  const defaultBranch = ref.startsWith("origin/") ? ref.slice("origin/".length) : "";
  const seen = new Set();
  const branches = [];
  for (const b of [defaultBranch, ...remote.sort(), ...local.sort()]) {
    if (!b || seen.has(b) || !validBranchName(b)) continue;
    seen.add(b);
    branches.push(b);
    if (branches.length >= 200) break;
  }
  return { isRepo: true, branches, defaultBranch };
}
function options({ path: dir } = {}, deps = defaultDeps()) {
  const folders = [];
  for (const a of loadAutos().automations) {
    const p = a && a.folder && typeof a.folder.path === "string" ? a.folder.path : "";
    if (p && !folders.includes(p) && isDir(p)) folders.push(p);
  }
  const out = { ok: true, codex: codexModels(), folders, isRepo: false, branches: [], defaultBranch: "" };
  if (typeof dir === "string" && dir.trim() && isDir(dir.trim())) Object.assign(out, branchOptions(deps, dir.trim()));
  return out;
}

function parseArgs(argv) {
  const flags = {}, rest = [];
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v.startsWith("--")) {
      const key = v.slice(2);
      if (["manual", "wait", "all", "confirm-public", "ack"].includes(key)) flags[key] = true;
      else flags[key] = argv[++i];
    } else rest.push(v);
  }
  return { flags, rest };
}
const decodeSpec = (b64) => {
  try { return JSON.parse(Buffer.from(String(b64 ?? ""), "base64").toString("utf8")); } catch { throw new ScheduleError("예약 정보(--b64)를 읽지 못했습니다."); }
};
function main(argv) {
  const [cmd, ...args] = argv;
  const { flags, rest } = parseArgs(args);
  try {
    let out;
    if (cmd === "tick") out = tick();
    else if (cmd === "run") out = runNow(rest[0], { manual: !!flags.manual, wait: !!flags.wait });
    else if (cmd === "next") out = nextCmd({ id: flags.id, spec: flags.b64 ? decodeSpec(flags.b64) : null, count: Math.max(1, Math.min(20, Number(flags.count) || 3)) });
    else if (cmd === "validate") out = validate(decodeSpec(flags.b64));
    else if (cmd === "list") out = list();
    else if (cmd === "runs") out = { ok: true, runs: loadRuns().runs[rest[0]] ?? [] };
    else if (cmd === "save") out = save(decodeSpec(flags.b64));
    else if (cmd === "delete") out = remove(rest[0]);
    else if (cmd === "toggle") out = toggle(rest[0], rest[1] === "on");
    else if (cmd === "options") out = options({ path: flags.path });
    else if (cmd === "repo") out = syncStatus();
    else if (cmd === "repo-set") out = setSyncRepo(rest[0]);
    else if (cmd === "record") { process.env.GIT_TERMINAL_PROMPT = "0"; out = record({ id: rest[0], all: !!flags.all, confirmPublic: !!flags["confirm-public"] }); }
    else if (cmd === "import") { process.env.GIT_TERMINAL_PROMPT = "0"; out = importFromRepo({ ack: !!flags.ack, folders: flags.folders ? decodeSpec(flags.folders) : [] }); }
    else if (cmd === "_worker") { execute(rest[0]); out = { ok: true }; }
    else out = { ok: false, error: "사용법: schedules.cjs tick | run <id> [--manual] | next | validate | list | runs <id> | save | delete <id> | toggle <id> on|off | options [--path <폴더>] | repo | repo-set <폴더> | record <id>|--all [--confirm-public] | import [--ack] [--folders <b64>]" };
    process.stdout.write(`${JSON.stringify(out)}\n`);
    process.exitCode = out && out.ok === false ? 1 : 0;
  } catch (e) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: oneLine(e.message, 300) })}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  ScheduleError, compile, nextAfter, nextTimes, latestIn, describe, validateAutomation, zonedToUtc, partsOf, localZone,
  tick, collectNotices, osNotifyCommand, execute, runNow, refreshRun, launchArgs, slugOf, stamp, claimRun, list, validate, save, remove, toggle, nextCmd, options, codexModels, branchOptions,
  defaultDeps, syncStatus, setSyncRepo, record, importFromRepo, normRemote,
  paths: { STORE_DIR, AUTOS_FILE, RUNS_FILE, SETTINGS_FILE },
};
if (require.main === module) main(process.argv.slice(2));
