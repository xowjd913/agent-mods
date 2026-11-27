// 메모: 메모 하나가 폴더 안의 .md 파일 하나다. 목록·새로 쓰기·고치기·지우기, 폴더 고르기, 그리고 PO에게 보내기(눌러서 확인한 뒤에만).
// 오른쪽 패널(memo-board)이다. 폴더 설정·목록·파일 이름 만들기·삭제는 memo.cjs(도우미)가 하고, 메모 글을 읽고 쓰는 것은 이 모드가 readTextFile/writeTextFile로 직접 한다
// (바깥에서 바뀐 파일을 덮어쓰지 않으려는 검사가 거기 들어 있다).
// 클라우드에는 아무것도 보내지 않는다. Google Drive 등은 그 데스크톱 앱의 동기화 폴더를 메모 폴더로 고르는 방식이다(로그인·업로드 코드 없음).
// 키: `<모드>.<명령>`은 화면에 보이는 모드에만 닿으므로 항상 보이는 tabs-mine이 `tabs-mine.memo`·`tabs-mine.memo-new`를 받아 패널을 열고 shared 표시(memo.want)를 남긴다.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, TextareaState, Textarea } from "gpui-base";
import { theme, exec, appHome, checking, hc, terminals, shared, nextCommand, pickFolder, readTextFile, writeTextFile } from "herdr";

const HELPER = () => `${appHome()}/mods/memo/memo.cjs`;
const ICON = (name) => `mods/workspace-chrome/${name}.svg`;
const WANT_SHARED = "memo.want"; // tabs-mine이 남기는 {new, at}: 키로 열어 달라는 요청
const WANT_FRESH_MS = 5000; // 이보다 오래된 요청은 지난 일이다
const NAMES_SHARED = "inbox.names"; // inbox가 공유하는 PO 이름 규칙(role 라벨 이름·PO 역할 값). 없으면 기본값
const RELOAD_MS = 8000;
const MAX_READ = 1024 * 1024; // readTextFile 한도(1 MiB)
const NAME_HEAD_CHARS = 400; // 새 메모 파일 이름을 만들 때 도우미에 넘기는 글머리

const DRIVE_NOTE = "Google Drive를 쓰려면 Drive 데스크톱 앱에 직접 로그인한 뒤, 그 Drive 폴더 안의 폴더를 메모 폴더로 고르세요. 이 앱은 로그인도 업로드도 하지 않습니다. 동기화는 Drive 앱이 합니다.";

// 글을 base64(UTF-8)로 넘긴다: exec에는 표준 입력이 없고, 글에는 줄바꿈·따옴표가 들어간다.
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
const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];
function when(ms) {
  if (!Number.isFinite(ms)) return "";
  const d = new Date(ms), now = new Date();
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (d.toDateString() === now.toDateString()) return `오늘 ${hm}`;
  const y = d.getFullYear() === now.getFullYear() ? "" : `${d.getFullYear()}/`;
  return `${y}${d.getMonth() + 1}/${d.getDate()}(${WEEKDAYS[d.getDay()]}) ${hm}`;
}
const cut = (s, n) => { const a = Array.from(String(s ?? "")); return a.length > n ? a.slice(0, n).join("") : a.join(""); };
const short = (e) => String(e?.message ?? e ?? "").slice(0, 160);

// 도우미 호출. 실패해도 JSON 한 줄을 stdout에 내므로 종료 코드와 상관없이 마지막 줄을 읽는다.
async function helper(args, timeout = 30000) {
  try {
    const r = await exec("node", [HELPER(), appHome(), ...args], { timeout });
    const line = String(r.stdout ?? "").trim().split("\n").pop();
    try { return JSON.parse(line); } catch { return { ok: false, error: `도우미 응답을 읽지 못했습니다. ${String(r.stderr || line || "").trim().slice(0, 160)}` }; }
  } catch (e) {
    return { ok: false, error: `도우미를 실행하지 못했습니다(node가 설치돼 있나요?): ${short(e)}` };
  }
}

// ---- PO 찾기. inbox와 같은 규칙: role 라벨이 PO 역할인 터미널. 이름 규칙은 inbox가 공유한 것을 따르고 없으면 기본값.
function poTargets() {
  let n = null;
  try { n = shared(NAMES_SHARED); } catch {}
  const labelRole = typeof n?.labelRole === "string" && n.labelRole ? n.labelRole : "role";
  const hubRole = typeof n?.hubRole === "string" && n.hubRole ? n.hubRole : "po";
  let list = [];
  try { list = terminals() ?? []; } catch {}
  return list.filter((t) => String(t?.labels?.[labelRole] ?? "").trim().toLowerCase() === hubRole.toLowerCase());
}
// 보낼 수 있는 PO 하나. {term} 아니면 {why}.
function pickPo() {
  const found = poTargets();
  if (found.length === 0) return { why: "PO 터미널을 찾지 못했습니다" };
  if (found.length > 1) return { why: `PO 터미널이 ${found.length}개라 보낼 곳을 정할 수 없습니다` };
  const t = found[0];
  const status = String(t.status ?? "").toLowerCase();
  if (status === "working") return { why: "PO가 일하는 중입니다. 끝난 뒤에 다시 보내세요" };
  if (status === "blocked") return { why: "PO가 질문 중입니다. 답한 뒤에 다시 보내세요" };
  const addr = String(t.address ?? t.name ?? "").trim();
  if (!addr) return { why: "PO 터미널의 주소를 알 수 없습니다" };
  return { term: t, addr, label: String(t.name ?? "") && t.name !== addr ? `${t.name} (${addr})` : addr };
}
// `hc send --json` 결과: 종료 코드 0이고 started:true일 때만 받은 것이다.
function sendResult(r) {
  const code = r && Number.isFinite(Number(r.code)) ? Number(r.code) : -1;
  let j = null;
  try { j = JSON.parse(String(r?.stdout ?? "").trim()); } catch {}
  if (code === 0 && j && j.started === true) return { ok: true };
  const kind = String(j?.error?.kind ?? "");
  if (code === 0 && j && j.started === false && !j.error) return { ok: false, why: "PO가 받아 시작하지 않았습니다(PO 입력창에 쓰던 글이 있는지 확인하세요)" };
  if (kind === "blocked") return { ok: false, why: "PO가 질문 중이라 받지 않았습니다" };
  if (kind === "status_mismatch") return { ok: false, why: "PO가 일하는 중이라 받지 않았습니다" };
  if (j?.error?.message) return { ok: false, why: `PO가 받지 않았습니다(${cut(j.error.message, 80)})` };
  return { ok: false, why: `hc send가 실패했습니다(종료 코드 ${code})` };
}

export default class Memo extends View {
  init(_props, cx) {
    this.screen = "list"; // list | edit
    this.cfg = null; // {dir, defaultDir, custom}
    this.items = null; // 목록. null = 아직 못 읽음
    this.exists = true;
    this.truncated = false;
    this.msg = null; // {text, error, id}
    this.msgSeq = 0;
    this.ask = null; // 확인 줄: {kind: "delete" | "po" | "discard" | "overwrite", ...}
    this.busy = false; // 목록 읽는 중
    this.working = false; // 저장·삭제·보내기 중
    this.e = null; // 편집 중인 메모: {file, path, orig, isNew, conflict}
    this.ta = null;
    this.wantAt = null;
    if (checking()) return;
    this.ta = TextareaState.new({ value: "", placeholder: "여기에 메모를 쓰세요. 첫 줄(또는 # 제목)이 메모 이름이 됩니다.", rows: 12 });
    this.ta.on("change", (_e, c) => c.notify());
    this.reload(cx);
    cx.timer.every(RELOAD_MS, (cx) => { if (this.screen === "list") this.reload(cx); });
    // 키로 열어 달라는 요청(tabs-mine이 남긴다)을 400ms마다 본다. 패널이 막 열렸을 때도 한 번 본다.
    this.checkWant(cx);
    cx.timer.every(400, (cx) => this.checkWant(cx));
    cx.spawn(async (cx) => {
      for (;;) {
        const c = String(await nextCommand());
        try { this.command(c, cx); } catch (e) { console.log(`memo command ${c}: ${short(e)}`); }
        cx.notify();
      }
    });
  }

  // 키 명령 `memo.new`·`memo.open`과 화면 확인용 명령(`herdr-app do memo.list`).
  command(c, cx) {
    if (c === "new") this.newMemo(cx);
    else if (c === "open" || c === "list") this.toList(cx, true);
  }

  checkWant(cx) {
    let w = null;
    try { w = shared(WANT_SHARED); } catch {}
    const at = Number.isFinite(Number(w?.at)) ? Number(w.at) : null;
    if (at === null || at === this.wantAt) return;
    this.wantAt = at;
    if (Date.now() - at > WANT_FRESH_MS) return;
    if (w.new) this.newMemo(cx); else this.toList(cx, true);
    cx.notify();
  }

  // ---- 메시지
  setMsg(cx, text, error = false) {
    const id = ++this.msgSeq;
    this.msg = { text, error, id };
    if (!error) cx.timer.after(3000, (cx) => { if (this.msg && this.msg.id === id) { this.msg = null; cx.notify(); } });
  }
  say(cx, text, error = false) { this.setMsg(cx, text, error); cx.notify(); }

  // ---- 목록
  reload(cx) {
    if (this.busy) return;
    this.busy = true;
    cx.spawn(async (cx) => {
      try {
        const c = await helper(["config"]);
        if (c.ok) this.cfg = { dir: c.dir, defaultDir: c.defaultDir, custom: c.custom };
        const d = await helper(["list"]);
        if (d.ok) {
          this.items = d.items; this.exists = d.exists !== false; this.truncated = Boolean(d.truncated);
          if (this.msg?.stale) this.msg = null;
        } else if (!this.items) this.msg = { text: d.error, error: true, stale: true, id: ++this.msgSeq };
      } finally { this.busy = false; cx.notify(); }
    });
  }

  toList(cx, force = false) {
    if (this.screen === "edit" && this.dirty() && !force) { this.ask = { kind: "discard" }; cx.notify(); return; }
    if (this.screen === "edit" && this.dirty() && force) { this.say(cx, "고치던 메모가 저장되지 않았습니다. 저장하거나 ‘목록으로’로 나가세요.", true); return; }
    this.screen = "list"; this.e = null; this.ask = null; this.msg = null;
    this.reload(cx);
  }

  chooseFolder(cx) {
    cx.spawn(async (cx) => {
      let dir = null;
      try { dir = await pickFolder({ prompt: "이 폴더를 메모 폴더로" }); } catch (e) { this.say(cx, `폴더 선택 창을 열지 못했습니다: ${short(e)}`, true); return; }
      if (!dir) return;
      await this.applyDir(dir, cx);
    });
  }
  resetFolder(cx) { cx.spawn(async (cx) => { await this.applyDir("", cx); }); }
  async applyDir(dir, cx) {
    const r = await helper(["setdir", toBase64(dir)]);
    if (!r.ok) { this.say(cx, `메모 폴더를 바꾸지 못했습니다: ${r.error}`, true); return; }
    this.cfg = { dir: r.dir, defaultDir: r.defaultDir, custom: r.custom };
    this.items = null;
    this.say(cx, `메모 폴더: ${r.dir}`);
    this.busy = false;
    this.reload(cx);
  }

  // ---- 편집
  dirty() {
    if (!this.e || !this.ta) return false;
    const v = this.ta.value();
    return this.e.isNew ? v.trim() !== "" : v !== this.e.orig;
  }

  newMemo(cx) {
    if (this.screen === "edit" && this.dirty()) { this.say(cx, "고치던 메모를 먼저 저장하거나 나가세요.", true); return; }
    this.e = { file: null, path: null, orig: null, isNew: true, conflict: false };
    this.ta.set_value("");
    this.screen = "edit"; this.ask = null; this.msg = null;
    cx.notify();
  }

  openMemo(item, cx) {
    if (item.size > MAX_READ) { this.say(cx, "1 MiB보다 큰 파일은 이 화면에서 열 수 없습니다. 편집기로 여세요.", true); return; }
    cx.spawn(async (cx) => {
      let text = null;
      try { text = await readTextFile(item.path); } catch (e) { this.say(cx, `메모를 읽지 못했습니다: ${short(e)}`, true); return; }
      if (text === null) { this.say(cx, "메모 파일이 없어졌습니다. 목록을 새로 읽습니다.", true); this.reload(cx); return; }
      this.e = { file: item.file, path: item.path, orig: text, isNew: false, conflict: false };
      this.ta.set_value(text);
      this.screen = "edit"; this.ask = null; this.msg = null;
      cx.notify();
    });
  }

  save(cx) {
    if (this.working || !this.e) return;
    const text = this.ta.value();
    const e = this.e;
    if (e.isNew && !text.trim()) { this.say(cx, "빈 메모는 저장하지 않습니다.", true); return; }
    this.working = true;
    cx.spawn(async (cx) => {
      try {
        if (e.isNew) {
          const n = await helper(["name", toBase64(cut(text, NAME_HEAD_CHARS))]);
          if (!n.ok) { this.say(cx, `파일 이름을 만들지 못했습니다: ${n.error}`, true); return; }
          await writeTextFile(n.path, text, null); // null = 새 파일. 이미 있으면 거절된다(덮어쓰지 않는다)
          if (this.e === e) { e.isNew = false; e.file = n.file; e.path = n.path; e.orig = text; e.conflict = false; }
          this.say(cx, `저장했습니다: ${n.file}`);
        } else {
          try { await writeTextFile(e.path, text, e.orig); } catch (err) {
            // 파일이 바깥에서 바뀌었거나 없어졌다: 덮어쓰지 않고 고르게 한다.
            if (this.e === e) { e.conflict = true; this.say(cx, "파일이 바깥에서 바뀌었습니다. 아래에서 고르세요.", true); }
            return;
          }
          if (this.e === e) { e.orig = text; e.conflict = false; }
          this.say(cx, "저장했습니다.");
        }
      } catch (err) {
        this.say(cx, `저장하지 못했습니다: ${short(err)}`, true);
      } finally { this.working = false; cx.notify(); }
    });
  }

  // 충돌: 바깥 글을 불러오거나(내 글 버림), 바깥 글을 기준으로 내 글을 덮어쓴다.
  resolve(how, cx) {
    const e = this.e;
    if (!e || this.working) return;
    this.working = true;
    cx.spawn(async (cx) => {
      try {
        const cur = await readTextFile(e.path);
        if (cur === null) { // 파일이 지워졌다: 내 글을 새 파일로 다시 만들 수 있게 새 메모로 돌린다
          if (this.e === e) { e.isNew = true; e.file = null; e.path = null; e.orig = null; e.conflict = false; }
          this.say(cx, "파일이 지워졌습니다. 저장하면 새 메모로 만듭니다.", true);
          return;
        }
        if (how === "load") { this.ta.set_value(cur); e.orig = cur; e.conflict = false; this.say(cx, "바깥에서 바뀐 글을 불러왔습니다."); }
        else { await writeTextFile(e.path, this.ta.value(), cur); e.orig = this.ta.value(); e.conflict = false; this.say(cx, "내 글로 덮어썼습니다."); }
      } catch (err) { this.say(cx, `처리하지 못했습니다: ${short(err)}`, true); }
      finally { this.working = false; cx.notify(); }
    });
  }

  remove(cx) {
    const e = this.e;
    if (!e || e.isNew || this.working) return;
    this.working = true;
    cx.spawn(async (cx) => {
      try {
        const r = await helper(["delete", e.file]);
        if (!r.ok) { this.say(cx, `지우지 못했습니다: ${r.error}`, true); return; }
        this.screen = "list"; this.e = null; this.ask = null;
        this.say(cx, "메모를 지웠습니다.");
        this.busy = false; this.reload(cx);
      } finally { this.working = false; cx.notify(); }
    });
  }

  // PO에게 보내기: 먼저 확인 줄(받는 터미널 주소를 보여 준다)을 띄우고, 보내기를 눌러야 `hc send`가 나간다.
  askPo(cx) {
    if (!this.e || this.e.isNew || this.dirty()) { this.say(cx, "먼저 저장하세요. 저장된 파일 내용이 PO에게 갑니다.", true); return; }
    const p = pickPo();
    if (!p.term) { this.say(cx, `보내지 못합니다: ${p.why}`, true); return; }
    this.ask = { kind: "po", label: p.label };
    cx.notify();
  }
  sendPo(cx) {
    const e = this.e;
    if (!e || e.isNew || this.working) return;
    const p = pickPo(); // 확인 뒤에 상태가 바뀌었을 수 있어 다시 본다
    if (!p.term) { this.ask = null; this.say(cx, `보내지 못합니다: ${p.why}`, true); return; }
    this.working = true;
    cx.spawn(async (cx) => {
      try {
        const m = await helper(["po", e.file]);
        if (!m.ok) { this.say(cx, `보낼 글을 만들지 못했습니다: ${m.error}`, true); return; }
        let r = null;
        try { r = await hc(["send", "--json", "--", p.addr, m.text]); } catch (err) { r = { code: -1, stdout: "", stderr: short(err) }; }
        const res = sendResult(r);
        this.ask = null;
        if (res.ok) this.say(cx, `PO(${p.label})에게 보냈습니다.`);
        else this.say(cx, `PO에게 보내지 못했습니다: ${res.why}`, true);
      } finally { this.working = false; cx.notify(); }
    });
  }

  // ---- 그리기 공통
  button(t, id, label, onClick, { primary = false, danger = false, disabled = false } = {}) {
    const el = div().id(id).flex_none().h(24).px(9).rounded(6).flex().items_center().justify_center().text_size(11.5).cursor_pointer()
      .when(primary, (e) => e.bg(t.solid).text_color(t.solid_foreground).hover((s) => s.opacity(0.88)))
      .when(!primary, (e) => e.border(1).border_color(t.border).text_color(danger ? t.blocked : t.muted).hover((s) => s.bg(t.hover).text_color(danger ? t.blocked : t.foreground)))
      .on_click((_e, cx) => { if (!disabled) onClick(cx); });
    return el.when(disabled, (e) => e.opacity(0.4)).child(label);
  }

  header(t, title, left, right) {
    return h_flex().h(38).px(12).flex_none().items_center().justify_between().gap(8)
      .child(h_flex().gap(6).items_center().min_w(0)
        .when(Boolean(left), (el) => el.child(left))
        .child(div().min_w(0).truncate().text_size(15).font_semibold().text_color(t.foreground).child(title)))
      .child(h_flex().gap(6).items_center().children(right ?? []));
  }

  banner(t) {
    if (!this.msg) return null;
    return div().id("mm-msg").flex_none().mx(12).mb(6).px(8).py(5).rounded(6).bg((this.msg.error ? t.blocked : t.working) + "1f")
      .text_size(11.5).text_color(this.msg.error ? t.blocked : t.foreground).cursor_pointer()
      .on_click((_e, cx) => { this.msg = null; cx.notify(); }).child(this.msg.text);
  }

  note(t, text) { return div().text_size(11).text_color(t.dim).child(text); }

  // ---- 목록 화면
  folderBar(t) {
    const dir = this.cfg?.dir ?? "…";
    return v_flex().flex_none().mx(12).mb(8).p(8).gap(6).rounded(8).bg(t.raised).border(1).border_color(t.border)
      .child(h_flex().gap(6).items_center()
        .child(svg(ICON("folder")).size(13).flex_none().text_color(t.dim))
        .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.foreground).tooltip(dir).child(dir)))
      .child(h_flex().gap(6).items_center()
        .child(this.button(t, "mm-pick", "폴더 바꾸기", (cx) => this.chooseFolder(cx)))
        .when(Boolean(this.cfg?.custom), (el) => el.child(this.button(t, "mm-reset", "기본 폴더로", (cx) => this.resetFolder(cx)))))
      .child(this.note(t, DRIVE_NOTE));
  }

  row(t, it, i) {
    return v_flex().id(`mm-row-${i}`).flex_none().mx(12).mb(6).px(10).py(7).gap(2).rounded(8).border(1).border_color(t.border).cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => this.openMemo(it, cx))
      .child(h_flex().gap(8).items_center().justify_between()
        .child(div().flex_1().min_w(0).truncate().text_size(13).font_semibold().text_color(t.foreground).child(it.title))
        .child(div().flex_none().text_size(10.5).text_color(t.dim).child(when(it.mtime))))
      .when(Boolean(it.preview), (el) => el.child(div().min_w(0).truncate().text_size(11.5).text_color(t.muted).child(it.preview)));
  }

  listScreen(t) {
    const items = this.items ?? [];
    const right = [
      this.button(t, "mm-new", "+ 새 메모", (cx) => this.newMemo(cx), { primary: true }),
      this.button(t, "mm-refresh", "새로고침", (cx) => { this.busy = false; this.reload(cx); }),
    ];
    return v_flex().size_full().min_h(0).bg(t.chrome).text_size(13)
      .child(this.header(t, "메모", null, right))
      .when(Boolean(this.banner(t)), (el) => el.child(this.banner(t)))
      .child(this.folderBar(t))
      .when(this.items === null && !this.msg, (el) => el.child(div().px(12).text_size(12).text_color(t.dim).child("불러오는 중…")))
      .when(this.items !== null && !this.exists, (el) => el.child(div().px(12).py(4).text_size(12).text_color(t.dim).child("메모 폴더가 아직 없습니다. 새 메모를 저장하면 만들어집니다.")))
      .when(this.items !== null && this.exists && items.length === 0, (el) => el.child(div().px(12).py(4).text_size(12).text_color(t.dim).child("메모가 없습니다. ‘+ 새 메모’로 시작하세요.")))
      .child(v_flex().id("mm-list").flex_1().min_h(0).overflow_y_scrollbar().mode("always")
        .children(items.map((it, i) => this.row(t, it, i)))
        .when(this.truncated, (el) => el.child(div().px(12).pb(8).text_size(11).text_color(t.dim).child("최근 500개만 보입니다."))));
  }

  // ---- 편집 화면
  askBar(t) {
    const a = this.ask;
    if (!a) return null;
    const text = a.kind === "delete" ? `‘${this.e?.file ?? ""}’ 파일을 지웁니다. 되돌릴 수 없습니다.`
      : a.kind === "discard" ? "저장하지 않은 변경이 있습니다. 버리고 목록으로 갈까요?"
      : `PO(${a.label})에게 이 메모를 보냅니다. 메모 제목·본문·파일 경로가 그 터미널에 입력되어 전송됩니다.`;
    const ok = a.kind === "delete" ? this.button(t, "mm-ask-ok", "지우기", (cx) => this.remove(cx), { danger: true, disabled: this.working })
      : a.kind === "discard" ? this.button(t, "mm-ask-ok", "버리고 나가기", (cx) => { this.e = null; this.screen = "list"; this.ask = null; this.reload(cx); }, { danger: true })
      : this.button(t, "mm-ask-ok", "보내기", (cx) => this.sendPo(cx), { primary: true, disabled: this.working });
    return v_flex().flex_none().mx(12).mb(6).p(8).gap(6).rounded(8).bg(t.blocked + "1f").border(1).border_color(t.blocked + "66")
      .child(div().text_size(12).text_color(t.foreground).child(text))
      .child(h_flex().gap(6).child(ok).child(this.button(t, "mm-ask-no", "취소", (cx) => { this.ask = null; cx.notify(); })));
  }

  conflictBar(t) {
    if (!this.e?.conflict) return null;
    return v_flex().flex_none().mx(12).mb(6).p(8).gap(6).rounded(8).bg(t.blocked + "1f").border(1).border_color(t.blocked + "66")
      .child(div().text_size(12).text_color(t.foreground).child("이 파일이 다른 곳에서 바뀌었습니다. 어느 쪽을 남길까요?"))
      .child(h_flex().gap(6)
        .child(this.button(t, "mm-cf-mine", "내 글로 덮어쓰기", (cx) => this.resolve("overwrite", cx), { danger: true, disabled: this.working }))
        .child(this.button(t, "mm-cf-theirs", "바깥 글 불러오기", (cx) => this.resolve("load", cx), { disabled: this.working })));
  }

  editScreen(t) {
    const e = this.e;
    const dirty = this.dirty();
    const back = div().id("mm-back").p(3).rounded(5).text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground)).cursor_pointer()
      .on_click((_e, cx) => this.toList(cx)).tooltip("목록으로").child(svg(ICON("chevron-left")).size(14));
    const title = e?.isNew ? "새 메모" : (e?.file ?? "메모");
    const canSave = dirty && !this.working;
    return v_flex().size_full().min_h(0).bg(t.chrome).text_size(13)
      .child(this.header(t, title, back, [this.button(t, "mm-save", dirty ? "저장" : "저장됨", (cx) => this.save(cx), { primary: dirty, disabled: !canSave })]))
      .when(Boolean(this.banner(t)), (el) => el.child(this.banner(t)))
      .when(Boolean(this.conflictBar(t)), (el) => el.child(this.conflictBar(t)))
      .when(Boolean(this.askBar(t)), (el) => el.child(this.askBar(t)))
      .child(h_flex().flex_none().px(12).pb(6).gap(6).items_center()
        .when(Boolean(e) && !e.isNew, (el) => el
          .child(this.button(t, "mm-po", "PO에게 보내기", (cx) => this.askPo(cx), { disabled: this.working }))
          .child(this.button(t, "mm-del", "삭제", (cx) => { this.ask = { kind: "delete" }; cx.notify(); }, { danger: true, disabled: this.working })))
        .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(dirty ? "저장하지 않은 변경" : "")))
      .child(div().flex_1().min_h(0).px(12).pb(12)
        .child(Textarea.new(this.ta).size_full().px(12).py(8).rounded(8).border(1).border_color(t.input).bg(t.background).text_size(12.5).text_color(t.foreground)));
  }

  render() {
    const t = theme();
    if (!this.ta) return v_flex().size_full().bg(t.chrome);
    return this.screen === "edit" ? this.editScreen(t) : this.listScreen(t);
  }
}
