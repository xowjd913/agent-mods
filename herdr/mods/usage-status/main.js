// Herdr 0.1.16 기본 workspace-status 모드를 복제하고 오른쪽에 Claude 사용률을 붙였다.
// 사용률은 ~/.claude/usage-limits.json(Claude Code 상태 줄이 기록)만 읽는다. 네트워크 호출과 exec는 없다.
import { View, div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { spaces, agents, theme, run, window, keys, home, readTextFile } from "herdr";

const REFRESH_MS = 60 * 1000; // 1분마다 다시 읽는다.
const STALE_MS = 10 * 60 * 1000; // 10분 넘게 갱신되지 않으면 Unknown으로 본다.
const WARN = 80; // 이 값 이상이면 경고 색으로 보여 준다.
const LABEL = { five_hour: "5h", seven_day: "7d" };
const TRACK_W = 44; // 선 막대 전체 폭(px). 아래 상태 줄이 좁아서 짧게 잡았다.
const TRACK_H = 3; // 선 두께(px)
const MIN_FILL = 2; // 0보다 크면 최소 이만큼은 보이게 한다(px).

// 채운 선의 폭(px). 0 이하·NaN은 0, 0보다 크면 최소 MIN_FILL, 100%를 넘어도 track을 넘치지 않는다.
export function fillWidth(percent, track = TRACK_W) {
  const p = Number.isFinite(percent) ? Math.max(0, percent) : 0;
  if (p === 0) return 0;
  return Math.min(track, Math.max(MIN_FILL, Math.round((p / 100) * track)));
}

// usage-limits.json 내용을 { rows } 또는 { state }로 바꾼다. state는 Unknown일 때 이유다.
//   missing: 파일이 없음(기록기를 켜지 않았거나 아직 한 번도 기록하지 못함), invalid: 깨졌거나 쓸 수 있는 한도가 없음, stale: 10분 넘게 갱신되지 않음(staleMin은 지난 분).
export function usageState(raw, now) {
  if (!raw) return { state: "missing" };
  let data;
  try { data = JSON.parse(raw); } catch { return { state: "invalid" }; }
  const updated = Date.parse(data?.updatedAt ?? "");
  if (!Number.isFinite(updated)) return { state: "invalid" };
  if (now - updated > STALE_MS) return { state: "stale", staleMin: Math.floor((now - updated) / 60000) };
  const rows = (Array.isArray(data.limits) ? data.limits : [])
    .filter((l) => LABEL[l?.kind] && Number.isFinite(l.percentUsed))
    .map((l) => ({ label: LABEL[l.kind], percent: Math.round(l.percentUsed) }));
  return rows.length ? { rows } : { state: "invalid" };
}

// Unknown 옆에 붙이는 짧은 안내. 파일이 없을 때만 기록기를 켜는 방법을 알려 준다.
export function unknownHint(s) {
  if (s?.state === "missing") return "no usage file · install --statusline";
  if (s?.state === "stale") return `stale ${s.staleMin}m`;
  return "";
}

// usage-limits.json 내용을 [{label, percent}] 또는 null(Unknown)로 바꾼다.
export function parseUsage(raw, now) {
  return usageState(raw, now).rows ?? null;
}

export default class UsageStatus extends View {
  init(_props, cx) {
    this.usage = null;
    this.why = { state: "missing" };
    cx.spawn(async (cx) => {
      for (;;) {
        let raw = null;
        try { raw = await readTextFile(`${home()}/.claude/usage-limits.json`); } catch {}
        const u = usageState(raw, Date.now());
        this.usage = u.rows ?? null;
        this.why = u;
        cx.notify();
        await cx.sleep(REFRESH_MS);
      }
    });
  }

  // The palette key as actually bound, not a hardcoded one; without a
  // binding the hint stays useful ("commands") instead of lying.
  hint(t) {
    const mac = window()?.platform === "macos";
    const mod = { cmd: mac ? "⌘" : "Ctrl+", ctrl: mac ? "⌃" : "Ctrl+", shift: mac ? "⇧" : "Shift+", alt: mac ? "⌥" : "Alt+", option: mac ? "⌥" : "Alt+" };
    const b = keys().find((k) => k.section === "global" && k.action === "app.palette");
    const parts = b && b.keys.endsWith("--") ? [...b.keys.slice(0, -2).split("-"), "-"] : b?.keys.split("-");
    const key = parts && parts.map((p) => mod[p.toLowerCase()] ?? p.toUpperCase()).join("");
    return key ? `${key}  commands` : "commands";
  }

  usageView(t) {
    const row = h_flex().gap(8).items_center().child(div().text_color(t.dim).child("Claude"));
    if (!this.usage) {
      const hint = unknownHint(this.why);
      return row.child("Unknown").when(Boolean(hint), (el) => el.child(div().text_color(t.dim).child(`· ${hint}`)));
    }
    return this.usage.reduce((el, u) => {
      const warn = u.percent >= WARN;
      const color = warn ? t.blocked : t.muted; // 라벨·퍼센트 색
      const fill = warn ? t.blocked : t.foreground; // 채운 선은 테마에서 가장 또렷한 글자색(foreground), 빈 선(track)은 훨씬 어두운 t.border
      return el.child(h_flex().gap(5).items_center()
        .child(div().text_color(t.dim).child(u.label))
        .child(div().flex_none().w(TRACK_W).h(TRACK_H).rounded(TRACK_H).bg(t.border)
          .child(div().h(TRACK_H).w(fillWidth(u.percent)).rounded(TRACK_H).bg(fill)))
        .child(div().text_color(color).child(`${u.percent}%`)));
    }, row);
  }

  render() {
    const t = theme();
    const space = spaces().find(s => s.active);
    const list = agents();
    const needs = list.filter(a => a.status === "blocked").length;
    const label = (icon, text) => h_flex().gap(6).items_center().child(svg(`mods/workspace-chrome/${icon}.svg`).size(13)).child(text);
    return h_flex().size_full().px(14).gap(16).items_center().bg(t.chrome).border_t(1).border_color(t.border).text_size(11.8).text_color(t.muted)
      .child(label(space?.machine ? "server" : "monitor", space?.machine ?? "This computer"))
      .when(Boolean(space?.branch), el => el.child(label("branch", space.branch)))
      .child(h_flex().gap(6).items_center().child(div().size(6).rounded(3).bg(t.dim)).child(`${list.length} agents`)
        .when(needs > 0, el => el.child(div().text_color(t.blocked).child(`· ${needs} needs you`))))
      .child(div().flex_1())
      .child(this.usageView(t))
      .child(div().id("palette").text_color(t.dim).on_click(() => run("app.palette")).child(this.hint(t)));
  }
}
