// AI Limits: plan usage for your AI subscriptions, one row per provider, under the Agents list.
// Data comes from `quota-axi --json` (kunchenguid/quota-axi), which reads the sign-ins already on
// this computer and asks each provider's own endpoint. Asked at start, every 2 minutes and from
// the refresh button.
//
// Layout props: { "providers": ["claude", "agy", "grok"] } — any quota-axi provider id, in order.
//
// The panel's look (rows, two slots, 10% colour bands) is adapted from herdr-agent-limits
// (mchlkim/herdr-agent-limits, MIT).

import { View, div, image, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { agents, exec, theme, layout } from "herdr";

const EVERY = 2 * 60 * 1000;
const CELL = 78;
const DEFAULT_PROVIDERS = ["claude", "agy", "grok"];

// Known quota-axi providers: display name, Herdr's shipped icon, and the window ids that fill the
// short (under a day) and long (week or month) slots. Unknown ids get a generic row.
// `tint` draws one-colour icons with svg() so they stay visible on dark themes.
const KNOWN = {
  claude: { name: "Claude", icon: "claude", short: ["five_hour"], long: ["seven_day"] },
  codex: { name: "Codex", icon: "codex", short: ["five_hour"], long: ["weekly"] },
  agy: { name: "Gemini", icon: "gemini", tint: "#8ab4f8", short: ["gemini_5h"], long: ["gemini_weekly"] },
  grok: { name: "Grok", icon: "grok", tint: "foreground" },
  cursor: { name: "Cursor", icon: "cursor", tint: "foreground" },
  copilot: { name: "Copilot", icon: "copilot", tint: "foreground" },
  kimi: { name: "Kimi", icon: "kimi" },
  "opencode-go": { name: "OpenCode Go", icon: "opencode", tint: "foreground" },
  muse: { name: "Muse", icon: "muse", tint: "foreground" },
};
const generic = (id) => ({ name: id[0].toUpperCase() + id.slice(1), icon: "agent", tint: "foreground" });

// Herdr's agent names → provider id, so rows of agents running now are drawn in full.
const RUNNING = {
  "claude-code": "claude", claude: "claude", codex: "codex", antigravity: "agy", agy: "agy",
  grok: "grok", cursor: "cursor", "cursor-agent": "cursor", copilot: "copilot", kimi: "kimi",
  "kimi-code": "kimi", opencode: "opencode-go",
};

// Stepped gradient: one colour per 10% band, green -> yellow -> red.
const band = (pct) => {
  const p = Math.max(0, Math.min(100, Math.floor(pct / 10) * 10));
  const h = Math.round(120 * (1 - p / 100));
  const f = (n) => {
    const k = (n + h / 30) % 12;
    const v = 0.65 - 0.35 * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(255 * v).toString(16).padStart(2, "0");
  };
  return `#${f(0)}${f(8)}${f(4)}`;
};

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const pad = (n) => String(n).padStart(2, "0");

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}
// Same rule as the agents mod: the sidebar is a rail below 160 px.
const narrow = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;

// A quota-axi window → { label, pct used, resets (epoch s), short }.
function slot(w) {
  if (!w) return null;
  const short = w.kind === "session";
  const days = w.windowSeconds ? Math.round(w.windowSeconds / 86400) : null;
  const label = short ? "5h"
    : days ? `${days}d`
    : w.kind === "monthly" ? "30d"
    : w.kind === "weekly" ? "7d"
    : (w.label ?? "").slice(0, 3);
  const resets = w.resetsAt ? Math.floor(Date.parse(w.resetsAt) / 1000) : null;
  return { label, pct: 100 - (w.percentRemaining ?? 100), resets, short };
}

function resetText(s) {
  if (s.resets == null) return "";
  const d = new Date(s.resets * 1000);
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (s.short) return time;
  if (s.label === "30d") return `${d.getMonth() + 1}/${d.getDate()} ${time}`;
  return `${DAYS[d.getDay()]} ${time}`;
}

function ago(seconds) {
  const m = Math.floor(seconds / 60);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`;
}

export default class AiLimits extends View {
  init(props, cx) {
    // Only plain provider ids: they end up on a command line.
    const asked = Array.isArray(props?.providers) ? props.providers.filter((id) => /^[a-z0-9-]+$/.test(id)) : [];
    this.ids = asked.length ? asked : DEFAULT_PROVIDERS;
    this.providers = {};
    this.updated = null;
    this.error = null;
    this.fetching = false;
    this.refresh(cx);
    cx.timer.every(EVERY, (cx) => this.refresh(cx));
  }

  refresh(cx) {
    if (this.fetching) return;
    this.fetching = true;
    cx.notify();
    cx.spawn(async (cx) => {
      const args = ["--json", "--allow-keychain-prompt", "--provider", this.ids.join(",")];
      try {
        let r = await exec("quota-axi", args).catch(() => null);
        // Apps opened from the Finder may miss Homebrew's or npm's PATH: retry through the login shell.
        if (!r || r.code !== 0) {
          r = await exec("sh", ["-c", `exec "\${SHELL:-/bin/sh}" -lic 'quota-axi ${args.join(" ")}' </dev/null`]);
        }
        if (r.code === 127) throw new Error("quota-axi not found: npm install -g quota-axi");
        if (r.code !== 0) throw new Error(r.stderr.trim() || `quota-axi exited ${r.code}`);
        const data = JSON.parse(r.stdout);
        const next = {};
        for (const p of data.providers ?? []) next[p.provider] = p;
        this.providers = next;
        this.updated = Date.now() / 1000;
        this.error = null;
      } catch (e) {
        this.error = String(e?.message ?? e);
      }
      this.fetching = false;
      cx.notify();
    });
  }

  // One row: its two slots, or a short note when there are no numbers.
  rowData(id) {
    const def = KNOWN[id] ?? generic(id);
    const p = this.providers[id];
    const wins = (p?.windows ?? []).filter((w) => w.kind !== "model");
    const pick = (ids, test) => slot(ids ? wins.find((w) => ids.includes(w.id)) : wins.find(test));
    const short = pick(def.short, (w) => w.kind === "session");
    const long = pick(def.long, (w) => w.kind !== "session");
    const status = p?.state?.status;
    let note = null;
    if (!p) note = this.fetching ? "…" : "–";
    else if (!short && !long) note = status === "auth_required" ? "sign in" : status === "unavailable" ? "n/a" : "–";
    return { id, ...def, short, long, note, err: p?.state?.error ?? null, plan: p?.plan ?? null };
  }

  render() {
    const t = theme();
    const now = Date.now() / 1000;
    const running = new Set(agents().map((a) => RUNNING[a.app] ?? RUNNING[a.program?.key]).filter(Boolean));
    const rows = this.ids.map((id) => ({ ...this.rowData(id), on: running.has(id) }));
    // A window whose reset time has passed starts again from zero.
    const live = (s) => (s && s.resets != null && s.resets <= now ? { ...s, pct: 0 } : s);
    const pic = (r) => (r.tint
      ? svg(`icons/${r.icon}.svg`).size(14).flex_none().text_color(t[r.tint] ?? r.tint)
      : image(`icons/${r.icon}.svg`).w(14).h(14).flex_none()).when(!r.on, (el) => el.opacity(0.6));

    if (narrow()) {
      return v_flex().size_full().bg(t.chrome).border_t(1).border_color(t.border).pt(10).gap(8).items_center().children(
        rows.map((r) => {
          const top = [live(r.short), live(r.long)].filter(Boolean).reduce((m, s) => Math.max(m, s.pct), -1);
          return v_flex().id(`ail-${r.id}`).items_center().gap(2)
            .child(pic(r))
            .child(div().text_size(10).text_color(top < 0 ? t.dim : band(top)).child(top < 0 ? "–" : `${Math.floor(top)}%`));
        }),
      );
    }

    const cell = (s, on) => {
      if (!s) return div().w(CELL).flex_none();
      const c = band(s.pct);
      const fill = Math.max(0, Math.min(100, s.pct));
      return h_flex().w(CELL).flex_none().gap(4).items_center()
        .child(div().w(22).whitespace_nowrap().text_size(11).text_color(t.dim).child(s.label))
        .child(div().w(20).h(4).rounded(2).bg(t.border)
          .child(div().h_full().w(Math.max(fill > 0 ? 2 : 0, (20 * fill) / 100)).rounded(2).bg(c)))
        .child(div().w(28).whitespace_nowrap().text_right().text_size(11.5).font_semibold()
          .text_color(c).when(!on, (el) => el.opacity(0.8))
          .child(`${Math.floor(s.pct)}%`));
    };

    const row = (r) => {
      const short = live(r.short), long = live(r.long);
      const resets = [short, long].filter((s) => s && s.resets != null).map((s) => `${s.label} resets ${resetText(s)}`);
      const tip = [r.name + (r.plan ? ` (${r.plan})` : ""), ...resets, r.err, this.updated ? `updated ${ago(now - this.updated)}` : null]
        .filter(Boolean).join(" · ");
      return h_flex().id(`ail-${r.id}`).px(8).h(28).flex_none().rounded(8).items_center().gap(6)
        .hover((s) => s.bg(t.hover))
        .tooltip(tip)
        .child(pic(r))
        .child(div().flex_1().min_w(0).truncate().text_color(r.on ? t.foreground : t.muted).child(r.name))
        .when(r.note != null, (el) => el.child(div().flex_none().text_size(11.5).text_color(t.dim).child(r.note)))
        .when(r.note == null, (el) => el.child(h_flex().flex_none().gap(8).child(cell(short, r.on)).child(cell(long, r.on))));
    };

    return v_flex().size_full().min_h(0).bg(t.chrome).border_t(1).border_color(t.border).text_size(12.5)
      .child(h_flex().px(16).h(41).pt(14).pb(5).flex_none().items_center().justify_between()
        .child(div().text_size(11.5).font_medium().text_color(t.dim).child("Limits"))
        .child(h_flex().gap(8).items_center()
          .when(Boolean(this.error), (el) => el.child(div().id("ail-error").text_size(11).font_semibold()
            .text_color(t.blocked).tooltip(this.error ?? "").child("Err")))
          .child(div()
            .id("ail-refresh")
            .text_color(this.fetching ? t.accent : t.dim)
            .hover((s) => s.text_color(t.foreground))
            .on_click((_e, cx) => this.refresh(cx))
            .tooltip("Refresh now")
            .child(svg("mods/ai-limits/refresh.svg").size(14)))))
      .child(v_flex().px(8).children(rows.map(row)));
  }
}
