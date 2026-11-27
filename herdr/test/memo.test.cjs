// memo.cjs 단위 테스트: node --test herdr/test/memo.test.cjs
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const M = require("../mods/memo/memo.cjs");
const CLI = path.join(__dirname, "../mods/memo/memo.cjs");
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "memo-test-"));
const b64 = (s) => Buffer.from(s, "utf8").toString("base64");
const cli = (home, ...args) => JSON.parse(execFileSync("node", [CLI, home, ...args], { encoding: "utf8" }).trim().split("\n").pop());

test("titleOf: 첫 # 제목, 없으면 첫 줄", () => {
  assert.equal(M.titleOf("# 장보기\n\n우유"), "장보기");
  assert.equal(M.titleOf("앞줄\n# 나중 제목"), "나중 제목");
  assert.equal(M.titleOf("그냥 첫 줄\n둘째 줄"), "그냥 첫 줄");
  assert.equal(M.titleOf("\n\n  공백 뒤 첫 줄"), "공백 뒤 첫 줄");
  assert.equal(M.titleOf("- 목록 항목\n- 둘째"), "목록 항목");
  assert.equal(M.titleOf("## 소제목만\n본문"), "소제목만");
  assert.equal(M.titleOf("# 닫는 표시 #\n"), "닫는 표시");
  assert.equal(M.titleOf("﻿# BOM 제목"), "BOM 제목");
});

test("titleOf: 코드 블록 안의 #은 제목이 아니다", () => {
  assert.equal(M.titleOf("```sh\n# 주석\n```\n# 진짜 제목"), "진짜 제목");
  assert.equal(M.titleOf("```\n# 주석\n```"), M.UNTITLED);
});

test("titleOf: 빈 글은 제목 없음, 긴 제목은 잘린다", () => {
  assert.equal(M.titleOf(""), M.UNTITLED);
  assert.equal(M.titleOf(null), M.UNTITLED);
  assert.equal(M.titleOf("   \n\n "), M.UNTITLED);
  const t = M.titleOf("# " + "가".repeat(300));
  assert.equal(Array.from(t).length, 120);
  assert.ok(t.endsWith("…"));
});

test("previewOf: 제목 줄을 빼고 본문을 한 줄로", () => {
  assert.equal(M.previewOf("# 제목\n첫째\n둘째", "제목"), "첫째 둘째");
  assert.equal(M.previewOf("# 제목", "제목"), "");
});

test("safeName: 맥/윈도우에서 못 쓰는 글자·이름을 막는다", () => {
  assert.equal(M.safeName('a<b>c:d"e/f\\g|h?i*j'), "a b c d e f g h i j");
  assert.equal(M.safeName("끝에 점..."), "끝에 점");
  assert.equal(M.safeName("  앞뒤 공백  "), "앞뒤 공백");
  assert.equal(M.safeName(".숨김"), "숨김");
  assert.equal(M.safeName(""), M.UNTITLED);
  assert.equal(M.safeName("///"), M.UNTITLED);
  assert.equal(M.safeName("con"), "_con");
  assert.equal(M.safeName("NUL"), "_NUL");
  assert.equal(M.safeName("COM1.txt"), "_COM1.txt");
  assert.equal(M.safeName("console"), "console");
  assert.equal(M.safeName("a\u0000b\u001fc\u007fd"), "a b c d");
  assert.equal(Array.from(M.safeName("가".repeat(300))).length, 80);
  assert.equal(M.safeName("..."), M.UNTITLED);
});

test("safeName: 한글 정규화(NFC)", () => {
  const nfd = "한글".normalize("NFD");
  assert.equal(M.safeName(nfd), "한글".normalize("NFC"));
});

test("fileNameFor: 날짜+시각+제목.md", () => {
  assert.equal(M.fileNameFor("장보기", new Date(2026, 10, 27, 15, 30)), "2026-11-27 1530 장보기.md");
  assert.equal(M.fileNameFor("", new Date(2026, 0, 2, 3, 4)), `2026-01-02 0304 ${M.UNTITLED}.md`);
});

test("uniqueName: 같은 이름이 있으면 (2), (3)… 대소문자도 같게 본다", () => {
  const d = tmp();
  assert.equal(M.uniqueName(d, "a.md"), "a.md");
  fs.writeFileSync(path.join(d, "a.md"), "x");
  assert.equal(M.uniqueName(d, "a.md"), "a (2).md");
  fs.writeFileSync(path.join(d, "a (2).md"), "x");
  assert.equal(M.uniqueName(d, "a.md"), "a (3).md");
  assert.equal(M.uniqueName(d, "A.MD"), "A (3).md");
  assert.equal(M.uniqueName(path.join(d, "없는폴더"), "b.md"), "b.md");
});

test("uniqueName: 기존 파일을 덮어쓰지 않는다 (name 명령을 거듭 실행)", () => {
  const home = tmp(), dir = tmp();
  M.setDir(home, dir);
  const seen = new Set();
  for (let i = 0; i < 4; i++) {
    const r = cli(home, "name", b64("같은 제목"));
    assert.equal(r.ok, true);
    assert.ok(!seen.has(r.file.toLowerCase()), "이미 쓴 이름 " + r.file);
    seen.add(r.file.toLowerCase());
    fs.writeFileSync(path.join(dir, r.file), "# 같은 제목\n", { flag: "wx" });
  }
  assert.equal(fs.readdirSync(dir).length, 4);
});

test("isMemoFile / pathOf: 폴더 밖·잘못된 이름을 막는다", () => {
  for (const f of ["a.md", "a b.MD", "한글.md", "x (2).md"]) assert.equal(M.isMemoFile(f), true, f);
  for (const f of ["", ".md", "a.txt", "../a.md", "a/b.md", "a\\b.md", ".hidden.md", "..", "a.md\u0000", null, undefined, "a".repeat(260) + ".md"]) assert.equal(M.isMemoFile(f), false, String(f));
  assert.equal(M.pathOf("/x", "a.md"), path.join("/x", "a.md"));
  assert.throws(() => M.pathOf("/x", "../etc/passwd.md"));
  assert.throws(() => M.pathOf("/x", "a/../../b.md"));
});

test("memoDir / setDir: 기본 폴더, 저장, 되돌리기, 잘못된 값", () => {
  const home = tmp();
  assert.equal(M.memoDir(home), path.join(os.homedir(), "Documents", "Herdr Memos"));
  assert.equal(M.configInfo(home).custom, false);
  const dir = path.join(tmp(), "새 폴더", "안쪽");
  const r = M.setDir(home, dir);
  assert.equal(r.dir, dir);
  assert.equal(r.custom, true);
  assert.ok(fs.statSync(dir).isDirectory(), "없는 폴더는 만든다");
  assert.equal(M.memoDir(home), dir);
  assert.equal(M.setDir(home, "").custom, false);
  assert.equal(M.memoDir(home), M.defaultDir());
  assert.throws(() => M.setDir(home, "상대/경로"), /절대 경로/);
  const file = path.join(tmp(), "f.txt");
  fs.writeFileSync(file, "x");
  assert.throws(() => M.setDir(home, file), /폴더/);
  assert.equal(M.memoDir(home), M.defaultDir(), "실패한 저장은 설정을 바꾸지 않는다");
});

test("memoDir: 깨진/이상한 config는 기본 폴더로", () => {
  const home = tmp();
  fs.mkdirSync(path.join(home, "memo"));
  fs.writeFileSync(path.join(home, "memo", "config.json"), "{깨진");
  assert.equal(M.memoDir(home), M.defaultDir());
  fs.writeFileSync(path.join(home, "memo", "config.json"), JSON.stringify({ dir: "상대경로" }));
  assert.equal(M.memoDir(home), M.defaultDir());
  fs.writeFileSync(path.join(home, "memo", "config.json"), JSON.stringify({ dir: "~/MemoHome" }));
  assert.equal(M.memoDir(home), path.join(os.homedir(), "MemoHome"));
});

test("listMemos: .md만, 최신 수정순, 제목·미리보기, 바깥 수정 반영", () => {
  const d = tmp();
  assert.deepEqual(M.listMemos(path.join(d, "없음")), { exists: false, items: [], truncated: false });
  const w = (f, t, sec) => { fs.writeFileSync(path.join(d, f), t); fs.utimesSync(path.join(d, f), sec, sec); };
  w("old.md", "# 오래된\n본문 하나", 1000);
  w("new.md", "첫 줄이 제목\n둘째", 3000);
  w("mid.MD", "# 중간", 2000);
  w("note.txt", "무시", 4000);
  w(".hidden.md", "무시", 4000);
  fs.mkdirSync(path.join(d, "dir.md"));
  const r = M.listMemos(d);
  assert.equal(r.exists, true);
  assert.deepEqual(r.items.map((i) => i.file), ["new.md", "mid.MD", "old.md"]);
  assert.deepEqual(r.items.map((i) => i.title), ["첫 줄이 제목", "중간", "오래된"]);
  assert.equal(r.items[2].preview, "본문 하나");
  // 바깥에서 고치면 다음 목록에 보인다
  w("old.md", "# 바뀐 제목", 5000);
  const r2 = M.listMemos(d);
  assert.equal(r2.items[0].file, "old.md");
  assert.equal(r2.items[0].title, "바뀐 제목");
  // 바깥에서 지우면 사라진다
  fs.unlinkSync(path.join(d, "new.md"));
  assert.equal(M.listMemos(d).items.length, 2);
});

test("listMemos: 아주 큰 파일도 앞부분만 읽는다", () => {
  const d = tmp();
  fs.writeFileSync(path.join(d, "big.md"), "# 큰 메모\n" + "가나다".repeat(400000));
  const r = M.listMemos(d);
  assert.equal(r.items[0].title, "큰 메모");
  assert.ok(r.items[0].size > 1000000);
});

test("poMessage: 한 줄, 제목·본문·파일 경로, 길면 자름", () => {
  const m = M.poMessage("장보기", "# 장보기\n우유\n\n계란", "/m/a.md");
  assert.ok(m.startsWith("메모 요청: 장보기"));
  assert.ok(!/[\r\n]/.test(m), "한 줄이어야 한다");
  assert.ok(m.includes("우유 ⏎ 계란"));
  assert.ok(m.endsWith("(파일: /m/a.md)"));
  const long = M.poMessage("t", "가".repeat(5000), "/m/b.md");
  assert.ok(long.includes("이하 생략"));
  assert.ok(long.endsWith("(파일: /m/b.md)"));
  assert.ok(Array.from(long).length < M.MAX_BODY_IN_PO + 100);
  assert.equal(M.poMessage("빈", "", "/m/c.md"), "메모 요청: 빈 (파일: /m/c.md)");
  // 제어 문자·방향 제어 문자는 공백으로
  const bad = M.poMessage("t", "a\u0007b‮c⁦d", "/m/d.md");
  assert.ok(!/[\u0007‮⁦]/.test(bad));
});

test("CLI: config / setdir / list / delete / po", () => {
  const home = tmp(), dir = path.join(tmp(), "m");
  assert.deepEqual(Object.keys(cli(home, "config")).sort(), ["custom", "defaultDir", "dir", "ok"]);
  assert.equal(cli(home, "setdir", b64(dir)).dir, dir);
  fs.writeFileSync(path.join(dir, "a.md"), "# 첫 메모\n내용");
  const l = cli(home, "list");
  assert.equal(l.ok, true);
  assert.equal(l.items[0].title, "첫 메모");
  const po = cli(home, "po", "a.md");
  assert.equal(po.ok, true);
  assert.equal(po.title, "첫 메모");
  assert.equal(po.path, path.join(dir, "a.md"));
  assert.ok(po.text.startsWith("메모 요청: 첫 메모"));
  // 폴더 밖 경로·없는 파일은 거절
  assert.equal(cli(home, "delete", "../x.md").ok, false);
  assert.equal(cli(home, "po", "../a.md").ok, false);
  assert.equal(cli(home, "delete", "없음.md").ok, false);
  assert.equal(cli(home, "delete", "a.md").ok, true);
  assert.equal(fs.existsSync(path.join(dir, "a.md")), false);
  assert.equal(cli(home, "nope").ok, false);
  assert.equal(cli(home, "setdir", b64("상대")).ok, false);
});
