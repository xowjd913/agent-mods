// node --test herdr/test/usage-status.test.mjs
// main.js는 Herdr 전용 모듈(gpui-kit·herdr 등)을 불러오므로, 같은 이름의 빈 모듈로 바꿔서 순수 함수만 시험한다.
import { register } from "node:module";
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const stub = "export const View = class {}; export const div = () => ({}); export const svg = div; export const h_flex = div;" +
  "export const spaces = () => []; export const agents = () => []; export const theme = () => ({}); export const run = () => {};" +
  "export const window = () => ({}); export const keys = () => []; export const home = () => ''; export const readTextFile = async () => '';";
const hooks = `data:text/javascript,${encodeURIComponent(`
export async function resolve(s, c, n) { return ["gpui-kit","gpui-base","herdr"].includes(s) ? { url: "stub:" + s, shortCircuit: true } : n(s, c); }
export async function load(u, c, n) { return u.startsWith("stub:") ? { format: "module", source: ${JSON.stringify(stub)}, shortCircuit: true } : n(u, c); }
`)}`;
register(hooks);
const { parseUsage, usageState, unknownHint, fillWidth } = await import("../mods/usage-status/main.js");

const NOW = Date.parse("2026-11-17T05:10:00Z");
const file = (limits, updatedAt = "2026-11-17T05:05:00Z") => JSON.stringify({ updatedAt, limits });

test("fillWidth: 비율만큼 폭을 채운다", () => {
  assert.equal(fillWidth(50, 40), 20);
  assert.equal(fillWidth(100, 40), 40);
  assert.equal(fillWidth(0, 40), 0);
});

test("fillWidth: 0보다 크면 최소 폭, 100 초과·음수·NaN은 track을 넘지 않는다", () => {
  assert.equal(fillWidth(1, 40), 2);
  assert.equal(fillWidth(250, 40), 40);
  assert.equal(fillWidth(-5, 40), 0);
  assert.equal(fillWidth(NaN, 40), 0);
  assert.ok(fillWidth(30) > 0 && fillWidth(30) < fillWidth(100));
});

test("parseUsage: 5h·7d 행을 반올림해서 돌려준다", () => {
  const rows = parseUsage(file([{ kind: "five_hour", percentUsed: 7.4 }, { kind: "seven_day", percentUsed: 19.6 }, { kind: "spend_limit", percentUsed: 3 }]), NOW);
  assert.deepEqual(rows, [{ label: "5h", percent: 7 }, { label: "7d", percent: 20 }]);
});

test("parseUsage: 없음·깨진 JSON·오래됨·빈 한도는 null(Unknown)", () => {
  assert.equal(parseUsage(null, NOW), null);
  assert.equal(parseUsage("{oops", NOW), null);
  assert.equal(parseUsage(file([{ kind: "five_hour", percentUsed: 7 }], "2026-11-17T04:50:00Z"), NOW), null);
  assert.equal(parseUsage(file([]), NOW), null);
  assert.equal(parseUsage(file([{ kind: "five_hour", percentUsed: "x" }]), NOW), null);
});

// 받은편지함(UI 모드) 머리줄이 같은 파일을 읽는 복사본은 이 모드의 parseUsage와 같은 행을 돌려줘야 한다(리셋 시각 resetsAt만 더 있다).
test("parseUsage: 받은편지함 복사본과 같은 행을 돌려준다", () => {
  const inbox = createRequire(import.meta.url)("../mods/inbox/inbox.cjs");
  const strip = (rows) => rows && rows.map(({ label, percent }) => ({ label, percent }));
  const cases = [
    file([{ kind: "five_hour", percentUsed: 7.4, resetsAt: "2026-11-17T09:00:00Z" }, { kind: "seven_day", percentUsed: 19.6 }, { kind: "spend_limit", percentUsed: 3 }]),
    file([{ kind: "five_hour", percentUsed: 7 }], "2026-11-17T04:50:00Z"),
    file([]), file([{ kind: "five_hour", percentUsed: "x" }]), "{oops", null, "",
  ];
  for (const raw of cases) assert.deepEqual(strip(inbox.parseUsage(raw, NOW)), parseUsage(raw, NOW));
});

test("usageState: Unknown의 이유를 missing·invalid·stale로 가른다", () => {
  assert.deepEqual(usageState(null, NOW), { state: "missing" });
  assert.deepEqual(usageState("", NOW), { state: "missing" });
  assert.deepEqual(usageState("{oops", NOW), { state: "invalid" });
  assert.deepEqual(usageState(file([]), NOW), { state: "invalid" });
  assert.deepEqual(usageState(JSON.stringify({ limits: [] }), NOW), { state: "invalid" });
  assert.deepEqual(usageState(file([{ kind: "five_hour", percentUsed: 7 }], "2026-11-17T04:50:00Z"), NOW), { state: "stale", staleMin: 20 });
  assert.deepEqual(usageState(file([{ kind: "five_hour", percentUsed: 7.4 }]), NOW), { rows: [{ label: "5h", percent: 7 }] });
});

test("unknownHint: 파일이 없으면 기록기를 켜는 법을, 오래됐으면 지난 분을 알려 주고, 나머지는 비워 둔다", () => {
  assert.match(unknownHint({ state: "missing" }), /--statusline/);
  assert.equal(unknownHint({ state: "stale", staleMin: 20 }), "stale 20m");
  assert.equal(unknownHint({ state: "invalid" }), "");
  assert.equal(unknownHint({ rows: [] }), "");
});
