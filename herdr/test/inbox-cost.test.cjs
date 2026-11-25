// PO 세션 금액(inbox.cjs 합산·가격표·세션 기록, main.js 배선) 단위 테스트: node --test herdr/test/inbox-cost.test.cjs
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const I = require("../mods/inbox/inbox.cjs");
const hook = require("../mods/inbox/po-hook.cjs");

const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "inbox-cost-"));
const msg = (id, model, usage) => JSON.stringify({ type: "assistant", message: { id, model, usage } }) + "\n";
const fold = (...lines) => I.costFold({ sum: 0, ids: {}, unk: [] }, lines.join(""));

test("금액: 토큰 종류마다 단가를 곱한다 (입력·출력·캐시 읽기·5분/1시간 캐시 쓰기)", () => {
  // claude-fable-5-2: [8, 10, 16, 0.2, 40] USD / MTok
  const v = I.costTokens({ input_tokens: 1e6, output_tokens: 1e6, cache_read_input_tokens: 1e6, cache_creation_input_tokens: 2e6, cache_creation: { ephemeral_5m_input_tokens: 1e6, ephemeral_1h_input_tokens: 1e6 } });
  assert.deepEqual(v, [1e6, 1e6, 1e6, 1e6, 1e6]);
  near(I.costUsd("claude-fable-5-2", v), 8 + 40 + 0.2 + 10 + 16);
});

test("금액: 캐시 쓰기 분해가 없거나 모자라면 남은 만큼을 5분 쓰기로 센다", () => {
  assert.deepEqual(I.costTokens({ cache_creation_input_tokens: 500 }), [0, 0, 0, 500, 0]);
  assert.deepEqual(I.costTokens({ cache_creation_input_tokens: 500, cache_creation: { ephemeral_1h_input_tokens: 200 } }), [0, 0, 0, 300, 200]);
  assert.deepEqual(I.costTokens({ input_tokens: -5, output_tokens: "x", cache_read_input_tokens: NaN }), [0, 0, 0, 0, 0]);
  assert.equal(I.costTokens(null), null);
  assert.equal(I.costTokens("x"), null);
});

test("금액: 모델 id의 날짜·[1m]·-latest 꼬리는 떼고 찾는다", () => {
  assert.equal(I.modelKey("claude-sonnet-4-5-20250929"), "claude-sonnet-4-5");
  assert.equal(I.modelKey("claude-opus-5-5[1m]"), "claude-opus-5-5");
  assert.equal(I.modelKey(" Claude-Opus-4-20250514 "), "claude-opus-4");
  near(I.costUsd("claude-opus-4-1-20250805", [1e6, 0, 0, 0, 0]), 15);
});

test("금액: 캐시 읽기 배수는 모델마다 다르다 (Fable 5.2 0.025x, Opus/Sonnet 5.5 0.05x, 그 밖 0.1x)", () => {
  const read = [0, 0, 1e6, 0, 0];
  near(I.costUsd("claude-fable-5-2", read), 0.2);
  near(I.costUsd("claude-opus-5-5", read), 0.2);
  near(I.costUsd("claude-sonnet-5-5", read), 0.1);
  near(I.costUsd("claude-opus-4-8", read), 0.5);
  near(I.costUsd("claude-fable-5", read), 1);
});

test("금액: Haiku 5.5는 프롬프트가 10만 토큰을 넘으면 높은 단가를 쓴다 (입력+캐시 읽기+캐시 쓰기 기준, 딱 10만은 낮은 단가)", () => {
  near(I.costUsd("claude-haiku-5-5", [100000, 1e6, 0, 0, 0]), 0.1 * 0.1 + 0.5);
  near(I.costUsd("claude-haiku-5-5", [100001, 1e6, 0, 0, 0]), 0.5 * 0.100001 + 2.5);
  near(I.costUsd("claude-haiku-5-5", [50000, 0, 50001, 0, 0]), 0.5 * 0.05 + 0.05 * 0.050001); // 캐시 읽기도 프롬프트 길이에 든다
  near(I.costUsd("claude-haiku-4-5", [1e6, 0, 0, 0, 0]), 1); // 다른 Haiku는 구간이 없다
});

test("금액: 가격표에 없는 모델은 추정 없이 null이고, 합계에 더하지 않고 unknown에 남는다", () => {
  assert.equal(I.costUsd("claude-future-9", [1e6, 1e6, 0, 0, 0]), null);
  assert.equal(I.costUsd("", [1e6, 0, 0, 0, 0]), null);
  const st = fold(msg("a", "claude-opus-5-5", { input_tokens: 1e6 }), msg("b", "claude-future-9", { input_tokens: 1e6, output_tokens: 1e6 }));
  near(st.sum, 4);
  assert.deepEqual(st.unk, ["claude-future-9"]);
  // 모델이 아예 없는 줄도 모르는 모델이다
  assert.deepEqual(fold(msg("c", undefined, { output_tokens: 10 })).unk, ["?"]);
});

test("합산: 같은 message.id가 여러 줄(스트리밍)이면 한 번만 세고 필드마다 가장 큰 값을 쓴다", () => {
  const st = fold(
    msg("m1", "claude-fable-5-2", { input_tokens: 10, output_tokens: 1 }),
    msg("m1", "claude-fable-5-2", { input_tokens: 10, output_tokens: 500 }),
    msg("m1", "claude-fable-5-2", { input_tokens: 10, output_tokens: 1000000 }),
    msg("m1", "claude-fable-5-2", { input_tokens: 10, output_tokens: 1000000 }),
  );
  near(st.sum, (10 * 8 + 1e6 * 40) / 1e6);
  assert.equal(Object.keys(st.ids).length, 1);
});

test("합산: 서로 다른 id는 더하고, usage 없는 줄·0 토큰 줄·깨진 줄은 비용이 없다", () => {
  const st = fold(
    msg("a", "claude-opus-5-5", { input_tokens: 1e6 }),
    msg("b", "claude-opus-5-5", { output_tokens: 1e6 }),
    msg("z", "<synthetic>", { input_tokens: 0, output_tokens: 0 }),
    JSON.stringify({ type: "user", message: { role: "user", content: "hi" } }) + "\n",
    '{"message":{"usage":{"input_tokens":5\n', // 깨진 줄
    JSON.stringify({ type: "assistant", message: { id: "n", model: "claude-opus-5-5" } }) + "\n",
  );
  near(st.sum, 4 + 20);
  assert.deepEqual(st.unk, []);
});

test("합산: id 없는 줄은 줄마다 따로 센다", () => {
  const st = fold(msg(undefined, "claude-opus-5-5", { input_tokens: 1e6 }), msg(undefined, "claude-opus-5-5", { input_tokens: 1e6 }));
  near(st.sum, 8);
});

test("합산: 기억하는 id는 COST_IDS개까지고 오래된 것부터 버린다 (합계는 그대로)", () => {
  const lines = [];
  for (let i = 0; i < I.COST_IDS + 50; i++) lines.push(msg(`id${i}`, "claude-opus-5-5", { input_tokens: 1e6 }));
  const st = fold(...lines);
  assert.equal(Object.keys(st.ids).length, I.COST_IDS);
  assert.ok(!("id0" in st.ids) && `id${I.COST_IDS + 49}` in st.ids);
  near(st.sum, 4 * (I.COST_IDS + 50));
});

test("증분 읽기: 바이트 위치부터 새 줄만 읽고, 쓰다 만 줄은 완성될 때까지 기다린다", () => {
  const dir = tmp();
  const f = path.join(dir, "s.jsonl");
  fs.writeFileSync(f, msg("a", "claude-opus-5-5", { input_tokens: 1e6 }) + '{"message":{"id":"b","model":"claude-opus-5-5","usage":{"output_to');
  let r = I.costRead(f, null);
  near(r.ent.sum, 4);
  const off = r.ent.off;
  assert.equal(off, Buffer.byteLength(msg("a", "claude-opus-5-5", { input_tokens: 1e6 })));
  assert.equal(r.partial, false);
  // 같은 줄이 완성되고 새 줄이 붙는다: 앞부분은 다시 읽지 않는다 (ent의 합계가 그대로 이어진다)
  fs.writeFileSync(f, msg("a", "claude-opus-5-5", { input_tokens: 1e6 }) + msg("b", "claude-opus-5-5", { output_tokens: 1e6 }) + msg("c", "claude-opus-5-5", { input_tokens: 1e6 }));
  r = I.costRead(f, r.ent);
  near(r.ent.sum, 4 + 20 + 4);
  assert.equal(r.used, fs.statSync(f).size - off);
  // 더 읽을 게 없으면 0바이트를 쓴다
  const again = I.costRead(f, r.ent);
  assert.equal(again.used, 0);
  near(again.ent.sum, 28);
});

test("증분 읽기: 호출마다 읽는 양에 상한이 있고, 남은 건 partial로 알리며 다음 호출이 이어받는다", () => {
  const dir = tmp();
  const f = path.join(dir, "s.jsonl");
  const one = msg("m00", "claude-opus-5-5", { input_tokens: 1e6 });
  const n = 20;
  fs.writeFileSync(f, Array.from({ length: n }, (_, i) => msg(`m${String(i).padStart(2, "0")}`, "claude-opus-5-5", { input_tokens: 1e6 })).join(""));
  const budget = one.length * 5 + 3; // 다섯 줄과 여섯 번째 줄의 일부
  let r = I.costRead(f, null, budget);
  assert.equal(r.partial, true);
  assert.ok(r.used <= budget);
  near(r.ent.sum, 4 * 5);
  for (let i = 0; i < 20 && r.partial; i++) r = I.costRead(f, r.ent, budget);
  assert.equal(r.partial, false);
  near(r.ent.sum, 4 * n);
});

test("증분 읽기: 파일이 줄어들면(새 파일) 처음부터 다시 읽고, 없는 파일은 null이다", () => {
  const dir = tmp();
  const f = path.join(dir, "s.jsonl");
  fs.writeFileSync(f, msg("a", "claude-opus-5-5", { input_tokens: 1e6 }) + msg("b", "claude-opus-5-5", { input_tokens: 1e6 }));
  const r = I.costRead(f, null);
  fs.writeFileSync(f, msg("c", "claude-opus-5-5", { input_tokens: 1e6 }));
  near(I.costRead(f, r.ent).ent.sum, 4);
  assert.equal(I.costRead(path.join(dir, "nope.jsonl"), null), null);
});

test("세션 기록: 훅이 transcript 경로를 po-session/<po>.json에 쓰고, 같으면 다시 쓰지 않으며, 잘못된 값은 쓰지 않는다", () => {
  const dir = tmp();
  const tp = path.join(dir, "sess", "abc.jsonl");
  assert.equal(I.writePoSession(dir, "po-a", { session_id: "abc", transcript_path: tp }), true);
  const file = I.poSessionFile(dir, "po-a");
  assert.deepEqual(I.readPoSession(dir, "po-a"), { sid: "abc", path: tp });
  if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(I.writePoSession(dir, "po-a", { session_id: "abc", transcript_path: tp }), false); // 같은 세션
  assert.equal(I.writePoSession(dir, "po-a", { session_id: "def", transcript_path: path.join(dir, "sess", "def.jsonl") }), true); // /clear 뒤 새 세션
  assert.equal(I.readPoSession(dir, "po-a").sid, "def");
  for (const bad of [{}, { transcript_path: "relative/x.jsonl" }, { transcript_path: path.join(dir, "x.txt") }, { transcript_path: 5 }, { transcript_path: "/a\0b.jsonl" }]) {
    assert.equal(I.writePoSession(dir, "po-b", bad), false);
  }
  assert.equal(I.readPoSession(dir, "po-b"), null);
  assert.equal(I.writePoSession(dir, "../evil", { transcript_path: tp }), false); // 폴더 밖으로 못 나간다
  assert.equal(I.poSessionFile(dir, "../evil"), null);
});

function session(dir, po, sid, main, subs = {}) {
  const tp = path.join(dir, "proj", `${sid}.jsonl`);
  fs.mkdirSync(path.dirname(tp), { recursive: true });
  fs.writeFileSync(tp, main);
  if (Object.keys(subs).length) {
    fs.mkdirSync(path.join(dir, "proj", sid, "subagents"), { recursive: true });
    for (const [n, t] of Object.entries(subs)) fs.writeFileSync(path.join(dir, "proj", sid, "subagents", n), t);
  }
  I.writePoSession(dir, po, { session_id: sid, transcript_path: tp });
  return tp;
}

test("poCosts: 메인 + 서브에이전트 transcript를 합치고, 서브에이전트 수를 알려 준다", () => {
  const dir = tmp();
  session(dir, "po-a", "s1", msg("a", "claude-opus-5-5", { input_tokens: 1e6 }), {
    "agent-1.jsonl": msg("b", "claude-opus-5-5", { output_tokens: 1e6 }),
    "agent-2.jsonl": msg("c", "claude-sonnet-5-5", { output_tokens: 1e6 }),
    "notes.txt": "무시",
  });
  const c = I.poCosts(dir)["po-a"];
  near(c.usd, 4 + 20 + 10);
  assert.equal(c.sub, 2);
  assert.deepEqual(c.unknown, []);
  assert.equal(c.partial, false);
});

test("poCosts: 서브에이전트가 없으면 메인만(sub 0), 모르는 모델은 unknown으로 알린다", () => {
  const dir = tmp();
  session(dir, "po-a", "s1", msg("a", "claude-opus-5-5", { input_tokens: 1e6 }) + msg("b", "claude-new-1", { input_tokens: 1 }));
  const c = I.poCosts(dir)["po-a"];
  assert.equal(c.sub, 0);
  assert.deepEqual(c.unknown, ["claude-new-1"]);
  assert.equal(I.costLabel(c), "$?");
});

test("poCosts: 훅 기록이 없거나 transcript를 읽을 수 없는 PO는 결과에 없다 (화면엔 아무것도 안 나온다)", () => {
  const dir = tmp();
  assert.deepEqual(I.poCosts(dir), {});
  assert.deepEqual(I.poCosts(path.join(dir, "nope")), {});
  I.writePoSession(dir, "po-gone", { session_id: "x", transcript_path: path.join(dir, "gone.jsonl") });
  assert.deepEqual(I.poCosts(dir), {});
  assert.equal(I.costLabel(undefined), "");
  assert.equal(I.costTip(undefined), "");
});

test("poCosts: PO마다 자기 세션만 센다 (/clear 뒤에는 새 세션의 금액이 0부터)", () => {
  const dir = tmp();
  session(dir, "po-a", "s1", msg("a", "claude-opus-5-5", { input_tokens: 1e6 }));
  session(dir, "po-b", "s2", msg("b", "claude-opus-5-5", { output_tokens: 1e6 }));
  let c = I.poCosts(dir);
  near(c["po-a"].usd, 4);
  near(c["po-b"].usd, 20);
  session(dir, "po-a", "s3", msg("z", "claude-opus-5-5", { input_tokens: 5e5 })); // po-a가 /clear 하고 새 세션
  c = I.poCosts(dir);
  near(c["po-a"].usd, 2);
  near(c["po-b"].usd, 20);
});

test("poCosts: 캐시 파일로 이어 읽는다 — 두 번째 호출은 새로 붙은 줄만 읽고, 쓰는 파일은 0600이며 안 쓰는 transcript는 캐시에서 빠진다", () => {
  const dir = tmp();
  const tp = session(dir, "po-a", "s1", msg("a", "claude-opus-5-5", { input_tokens: 1e6 }));
  near(I.poCosts(dir)["po-a"].usd, 4);
  const cacheFile = path.join(dir, I.COST_CACHE);
  if (process.platform !== "win32") assert.equal(fs.statSync(cacheFile).mode & 0o777, 0o600);
  const cached = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
  assert.equal(cached.files[tp].off, fs.statSync(tp).size);
  // 캐시가 있으면 앞부분을 다시 읽지 않는다: 캐시의 합계를 바꿔 두면 새 줄만 더해진다
  cached.files[tp].sum = 100;
  fs.writeFileSync(cacheFile, JSON.stringify(cached));
  fs.appendFileSync(tp, msg("b", "claude-opus-5-5", { input_tokens: 1e6 }));
  near(I.poCosts(dir)["po-a"].usd, 104);
  // po-a가 다른 세션으로 옮기면 옛 transcript는 캐시에서 빠진다
  const tp2 = session(dir, "po-a", "s2", msg("c", "claude-opus-5-5", { input_tokens: 1e6 }));
  I.poCosts(dir);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(cacheFile, "utf8")).files), [tp2]);
});

test("poCosts: 깨진 캐시 파일은 처음부터 다시 읽는다", () => {
  const dir = tmp();
  session(dir, "po-a", "s1", msg("a", "claude-opus-5-5", { input_tokens: 1e6 }));
  fs.writeFileSync(path.join(dir, I.COST_CACHE), "{not json");
  near(I.poCosts(dir)["po-a"].usd, 4);
});

test("collect: cost 필드로 PO별 금액이 실리고, 비용 읽기가 실패해도 데스크 데이터는 그대로다", () => {
  const dir = tmp(), home = tmp();
  const old = process.env.HERDR_APP_HOME;
  process.env.HERDR_APP_HOME = home;
  try {
    session(dir, "po-a", "s1", msg("a", "claude-opus-5-5", { input_tokens: 1e6 }));
    near(I.collect(dir).cost["po-a"].usd, 4);
    assert.deepEqual(I.collect(path.join(dir, "nope")).cost, {});
    // The read-position cache is NOT written into the watched inbox folder (its writes would reload the desk again and again while a PO works).
    assert.equal(fs.existsSync(path.join(dir, I.COST_CACHE)), false);
    assert.equal(fs.existsSync(path.join(home, "data", "inbox", I.COST_CACHE)), true);
  } finally {
    if (old === undefined) delete process.env.HERDR_APP_HOME; else process.env.HERDR_APP_HOME = old;
  }
});

test("poCosts: cacheDir를 주면 캐시는 거기에만 쓰고 감시하는 inbox 폴더에는 아무것도 더하지 않는다", () => {
  const dir = tmp(), cdir = path.join(tmp(), "c");
  session(dir, "po-a", "s1", msg("a", "claude-opus-5-5", { input_tokens: 1e6 }));
  const before = fs.readdirSync(dir).sort();
  near(I.poCosts(dir, cdir)["po-a"].usd, 4);
  assert.deepEqual(fs.readdirSync(dir).sort(), before);
  assert.ok(fs.existsSync(path.join(cdir, I.COST_CACHE)));
});

test("main.js load: 다시 그리기 서명에는 금액의 원시 숫자가 아니라 화면에 나가는 글(라벨·툴팁)만 들어간다", () => {
  const src = mainSrc();
  const at = src.indexOf("const sig = JSON.stringify({ ...d, cost: shown, at: 0 });");
  assert.ok(at > 0);
  const head = src.slice(src.lastIndexOf("const shown = {};", at), at);
  assert.match(head, /shown\[po\] = \[costLabel\(c\), costTip\(c\)\]/);
  assert.doesNotMatch(src, /JSON\.stringify\(\{ \.\.\.d, at: 0 \}\)/);
  // 같은 규칙을 직접 돌려 본다: 센트가 안 바뀌는 사용량 증가는 서명이 같고, 센트가 바뀌면 다르다.
  const sigOf = (cost) => JSON.stringify({ cost: Object.fromEntries(Object.entries(cost).map(([po, c]) => [po, [I.costLabel(c), I.costTip(c)]])) });
  const base = { usd: 3.2001, unknown: [], sub: 1, partial: false };
  assert.equal(sigOf({ a: base }), sigOf({ a: { ...base, usd: 3.2049 } }));
  assert.notEqual(sigOf({ a: base }), sigOf({ a: { ...base, usd: 3.21 } }));
});

test("라벨·툴팁: $ 두 자리, 큰 금액은 천 단위, 모르는 모델은 $?, 툴팁은 한국어로 추정치임과 범위를 밝힌다", () => {
  assert.equal(I.costLabel({ usd: 3.2, unknown: [] }), "$3.20");
  assert.equal(I.costLabel({ usd: 0, unknown: [] }), "$0.00");
  assert.equal(I.costLabel({ usd: 1234.5, unknown: [] }), "$1,235");
  assert.equal(I.costLabel({ usd: 3.2, unknown: ["claude-x"] }), "$?");
  assert.equal(I.costLabel({ usd: NaN, unknown: [] }), "");
  const tip = I.costTip({ usd: 3.2, unknown: [], sub: 0, partial: false });
  assert.match(tip, /API 기준 추정 금액, 구독 청구액 아님/);
  assert.match(tip, /메인 세션만/);
  assert.match(I.costTip({ usd: 3.2, unknown: [], sub: 2, partial: false }), /서브에이전트 포함/);
  assert.match(I.costTip({ usd: 3.2, unknown: ["claude-x"], sub: 0, partial: false }), /가격표에 없는 모델.*claude-x/);
  assert.match(I.costTip({ usd: 3.2, unknown: [], sub: 0, partial: true }), /더 늘 수 있습니다/);
  assert.match(tip, /빠른 모드·미국 데이터 거주 가격·웹 검색.*계산하지 않아 실제보다 적을 수 있습니다/);
});

test("costLine: main.js와 inbox.cjs가 같은 블록을 쓴다", () => {
  const block = (f) => {
    const src = fs.readFileSync(path.join(__dirname, f), "utf8").replace(/\r\n/g, "\n");
    const a = src.indexOf("// costLine:begin"), b = src.indexOf("// costLine:end");
    assert.ok(a >= 0 && b > a, f);
    return src.slice(a, b);
  };
  assert.equal(block("../mods/inbox/main.js"), block("../mods/inbox/inbox.cjs"));
});

test("가격표: 한 곳에만 있고, 출처 주소와 확인한 날짜가 같이 적혀 있다 (main.js에는 가격이 없다)", () => {
  const cjs = fs.readFileSync(path.join(__dirname, "../mods/inbox/inbox.cjs"), "utf8");
  assert.match(cjs, /https:\/\/platform\.claude\.com\/docs\/en\/about-claude\/pricing\s+\(checked 2026-11-25\)/);
  assert.equal((cjs.match(/const COST_PRICES = /g) ?? []).length, 1);
  assert.doesNotMatch(fs.readFileSync(path.join(__dirname, "../mods/inbox/main.js"), "utf8"), /COST_PRICES|claude-fable-5-2/);
  for (const [k, p] of Object.entries(I.COST_PRICES)) assert.ok(p.length === 5 && p.every((x) => x > 0), k);
});

test("main.js 배선: 고른 PO의 금액만 usage 줄 끝에 '이 세션 $…'로, 툴팁 달고, 'PO 모름'·기록 없음이면 아무것도 안 그린다; 훅이 세션을 기록한다", () => {
  const src = mainSrc();
  const line = src.slice(src.indexOf('  usageLine(t, pick = "") {'), src.indexOf("  // ---- redraw gating"));
  assert.match(line, /pick && pick !== PO_OTHER \? this\.data\?\.cost\?\.\[pick\] : null/);
  assert.match(line, /costTip\(c\)/);
  assert.match(line, /이 세션 \$\{cost\}/);
  assert.match(src, /this\.usageLine\(t, v\.pick\)/);
  // 가격 계산은 헬퍼에서만: main.js는 읽은 결과를 그리기만 한다
  assert.doesNotMatch(src, /costUsd\(|costFold\(|poCosts\(/);
  const hookSrc = fs.readFileSync(path.join(__dirname, "../mods/inbox/po-hook.cjs"), "utf8");
  assert.match(hookSrc, /I\.writePoSession\(I\.inboxDir\(\), po, payload, now\)/);
});

test("훅: PO 터미널이면 줄을 쓴 뒤 세션 기록도 남기고, 기록이 실패해도 줄은 남는다", () => {
  const dir = tmp();
  const old = process.env.HERDR_INBOX_DIR;
  process.env.HERDR_INBOX_DIR = dir;
  try {
    const tp = path.join(dir, "s.jsonl");
    const payload = { hook_event_name: "UserPromptSubmit", prompt: "안녕", session_id: "sid1", transcript_path: tp };
    const get = () => ({ name: "claude", labels: { role: "po", po: "po-a" } });
    const r = hook.run({ HC_TERMINAL_ID: "t1" }, payload, I, get, 1700000000000, null);
    assert.ok(r && fs.existsSync(r.file));
    assert.deepEqual(I.readPoSession(dir, "po-a"), { sid: "sid1", path: tp });
    const broken = { ...I, writePoSession() { throw new Error("boom"); } };
    const r2 = hook.run({ HC_TERMINAL_ID: "t1" }, { ...payload, prompt: "또" }, broken, get, 1700000001000, null);
    assert.ok(r2 && r2.line.text === "또");
    // PO가 아닌 터미널은 아무것도 기록하지 않는다
    const dir2 = tmp();
    process.env.HERDR_INBOX_DIR = dir2;
    assert.equal(hook.run({ HC_TERMINAL_ID: "t2" }, payload, I, () => ({ name: "lead-x", labels: {} }), 1700000002000, null), null);
    assert.equal(fs.existsSync(path.join(dir2, I.PO_SESSION_DIR)), false);
  } finally {
    if (old === undefined) delete process.env.HERDR_INBOX_DIR; else process.env.HERDR_INBOX_DIR = old;
  }
});

function mainSrc() { return fs.readFileSync(path.join(__dirname, "../mods/inbox/main.js"), "utf8").replace(/\r\n/g, "\n"); }
