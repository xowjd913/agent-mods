// Herdr 0.1.16 기본 workspace-status 모드를 복제하고 오른쪽에 Claude 사용률을 붙였다.
// 사용률은 ~/.claude/usage-limits.json(Claude Code 상태 줄이 기록)만 읽는다. 네트워크 호출과 exec는 없다.
import { View, div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { spaces, agents, theme, run, window, keys, home, readTextFile } from "herdr";

const REFRESH_MS = 60 * 1000; // 1분마다 다시 읽는다.
const STALE_MS = 10 * 60 * 1000; // 10분 넘게 갱신되지 않으면 Unknown으로 본다.
const WARN = 80; // 이 값 이상이면 경고 색으로 보여 준다.
const LABEL = { five_hour: "5h", seven_day: "7d" };
const BAR_WIDTH = 8; // 아래 상태 줄이 좁아서 막대는 8칸으로 줄였다(model-badge는 더 길다).

// 사용률 막대. 채움 ▰·빈칸 ▱는 model-badge 모델 상태 막대와 같은 글자 쌍이다(얇은 선 ━·─는 모양 차이가 작아 구분이 어려웠다). 0보다 크면 최소 1칸, 100%를 넘어도 칸은 넘치지 않는다.
export function barOf(percent, width = BAR_WIDTH) {
  const p = Number.isFinite(percent) ? Math.max(0, percent) : 0;
  const filled = Math.min(width, Math.max(p > 0 ? 1 : 0, Math.round((p / 100) * width)));
  return { filled: "▰".repeat(filled), empty: "▱".repeat(width - filled) };
}

// usage-limits.json 내용을 [{label, percent}] 또는 null(Unknown)로 바꾼다.
export function parseUsage(raw, now) {
  if (!raw) return null;
  let data;
  try { data = JSON.parse(raw); } catch { return null; }
  const updated = Date.parse(data?.updatedAt ?? "");
  if (!Number.isFinite(updated) || now - updated > STALE_MS) return null;
  const rows = (Array.isArray(data.limits) ? data.limits : [])
    .filter((l) => LABEL[l?.kind] && Number.isFinite(l.percentUsed))
    .map((l) => ({ label: LABEL[l.kind], percent: Math.round(l.percentUsed) }));
  return rows.length ? rows : null;
}

export default class UsageStatus extends View {
  init(_props, cx) {
    this.usage = null;
    cx.spawn(async (cx) => {
      for (;;) {
        let raw = null;
        try { raw = await readTextFile(`${home()}/.claude/usage-limits.json`); } catch {}
        this.usage = parseUsage(raw, Date.now());
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
    if (!this.usage) return row.child("Unknown");
    return this.usage.reduce((el, u) => {
      const warn = u.percent >= WARN;
      const color = warn ? t.blocked : t.muted; // 라벨·퍼센트 색
      const fill = warn ? t.blocked : t.foreground; // 채운 칸은 테마에서 가장 또렷한 글자색(foreground), 빈칸은 t.dim
      const bar = barOf(u.percent);
      return el.child(h_flex().gap(5).items_center()
        .child(div().text_color(t.dim).child(u.label))
        .child(h_flex().items_center().child(div().text_color(fill).child(bar.filled)).child(div().text_color(t.dim).child(bar.empty)))
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
