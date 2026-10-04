// Aggregation and terminal rendering.

import { PREMIUM, normalizeModel } from "./pricing.js";

export const day = (d) => d.toISOString().slice(0, 10);

const sumUsage = (a, u) => {
  a.input += u.input;
  a.output += u.output;
  a.cacheRead += u.cacheRead;
  a.cacheWrite += u.cache5m + u.cache1h;
};

function group(records, keyFn) {
  const m = new Map();
  for (const r of records) {
    const k = keyFn(r);
    let g = m.get(k);
    if (!g) m.set(k, (g = { key: k, cost: 0, unpriced: 0, requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, start: r.ts, end: r.ts }));
    if (!r.extra) g.requests++; // session-level extras (background models, fees) are not requests
    if (r.ts < g.start) g.start = r.ts;
    if (r.ts > g.end) g.end = r.ts;
    sumUsage(g, r.usage);
    if (r.cost == null) g.unpriced++;
    else g.cost += r.cost;
  }
  return [...m.values()].sort((a, b) => b.cost - a.cost);
}

/** Everything the renderers and the team export need. */
export function summarize(records, { sessionAlert = 25, dayAlert = 100 } = {}) {
  const total = group(records, () => "total")[0] || { cost: 0, requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, unpriced: 0 };
  const byTool = group(records, (r) => r.tool);
  const byModel = group(records, (r) => normalizeModel(r.model));
  const byProject = group(records, (r) => r.project);
  const byDay = group(records, (r) => day(r.ts)).sort((a, b) => (a.key < b.key ? -1 : 1));
  const sessions = group(records, (r) => `${r.tool}\u0000${r.project}\u0000${r.session}`).map((g) => {
    const [tool, project, session] = g.key.split("\u0000");
    return { ...g, tool, project, session };
  });
  const premiumCost = byModel.filter((m) => PREMIUM.test(m.key)).reduce((s, m) => s + m.cost, 0);
  const unpricedModels = byModel.filter((m) => m.unpriced > 0).map((m) => m.key);
  return {
    total,
    byTool,
    byModel,
    byProject,
    byDay,
    topSessions: sessions.slice(0, 5),
    alerts: {
      sessionAlert,
      dayAlert,
      sessions: sessions.filter((s) => s.cost >= sessionAlert),
      days: byDay.filter((d) => d.cost >= dayAlert),
      premiumShare: total.cost ? premiumCost / total.cost : 0,
    },
    unpricedModels,
  };
}

// ---------- rendering ----------

const usd = (n) => "$" + (n >= 100 ? n.toFixed(0) : n.toFixed(2));
const num = (n) => (n >= 1e9 ? (n / 1e9).toFixed(1) + "B" : n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? (n / 1e3).toFixed(1) + "k" : String(n));

export function table(headers, rows, align) {
  const w = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
  const fmt = (r) => r.map((c, i) => (align[i] === "r" ? String(c).padStart(w[i]) : String(c).padEnd(w[i]))).join("  ");
  return [fmt(headers), w.map((n) => "─".repeat(n)).join("  "), ...rows.map(fmt)].join("\n");
}

const bar = (v, max, width = 24) => "█".repeat(max ? Math.max(v > 0 ? 1 : 0, Math.round((v / max) * width)) : 0);

export function render(s, { since, until, color = true, days = 14, cta }) {
  const b = (t) => (color ? `\x1b[1m${t}\x1b[0m` : t);
  const dim = (t) => (color ? `\x1b[2m${t}\x1b[0m` : t);
  const warn = (t) => (color ? `\x1b[33m${t}\x1b[0m` : t);
  const out = [];
  out.push(b(`AI coding spend  ${day(since)} → ${day(new Date(until - 1))}`) + dim("  (API-equivalent cost at public list prices)"));
  out.push("");
  if (!s.total.requests) {
    out.push("No Claude Code or Codex usage found in this period.");
    return out.join("\n");
  }
  out.push(`${b(usd(s.total.cost))} across ${s.total.requests} requests · ${num(s.total.input + s.total.cacheRead + s.total.cacheWrite)} input tokens (${num(s.total.cacheRead)} cache hits) · ${num(s.total.output)} output tokens`);
  out.push("");
  out.push(b("By tool"));
  out.push(table(["tool", "cost", "requests"], s.byTool.map((g) => [g.key, usd(g.cost), g.requests]), "lrr"));
  out.push("");
  out.push(b("By model"));
  out.push(table(["model", "cost", "share", "requests", "output tok"], s.byModel.map((g) => [g.key + (g.unpriced ? " (unpriced)" : ""), usd(g.cost), pct(g.cost, s.total.cost), g.requests, num(g.output)]), "lrrrr"));
  out.push("");
  out.push(b("By project"));
  out.push(table(["project", "cost", "share", "requests"], s.byProject.slice(0, 10).map((g) => [g.key, usd(g.cost), pct(g.cost, s.total.cost), g.requests]), "lrrr"));
  out.push("");
  const recent = s.byDay.slice(-days);
  const max = Math.max(...recent.map((d) => d.cost));
  out.push(b(`Daily (last ${recent.length} active days)`));
  out.push(table(["day", "cost", ""], recent.map((d) => [d.key, usd(d.cost), bar(d.cost, max)]), "lrl"));
  out.push("");
  out.push(b("Most expensive sessions"));
  out.push(
    table(
      ["started", "tool", "project", "cost", "requests", "duration"],
      s.topSessions.map((x) => [x.start.toISOString().slice(0, 16).replace("T", " "), x.tool, x.project, usd(x.cost), x.requests, dur(x.end - x.start)]),
      "lllrrr",
    ),
  );
  out.push("");
  const a = s.alerts;
  const flags = [];
  if (a.sessions.length) flags.push(`${a.sessions.length} session(s) cost ≥ ${usd(a.sessionAlert)} (top: ${usd(a.sessions[0].cost)})`);
  if (a.days.length) flags.push(`${a.days.length} day(s) cost ≥ ${usd(a.dayAlert)} (top: ${a.days.sort((x, y) => y.cost - x.cost)[0].key})`);
  if (a.premiumShare >= 0.5) flags.push(`${pct(a.premiumShare, 1)} of spend is on top-tier models (Fable/Opus/Astra/Pro)`);
  out.push(b("Alerts") + dim(`  (thresholds: session ${usd(a.sessionAlert)}, day ${usd(a.dayAlert)}; change with --session-alert / --day-alert)`));
  out.push(flags.length ? flags.map((f) => warn("! " + f)).join("\n") : "none");
  if (s.unpricedModels.length) {
    out.push("");
    out.push(dim(`Unpriced models (tokens counted, cost shown as $0): ${s.unpricedModels.join(", ")}`));
  }
  if (cta) {
    out.push("");
    out.push(dim(cta));
  }
  return out.join("\n");
}

const pct = (v, t) => (t ? Math.round((v / t) * 100) + "%" : "–");
function dur(ms) {
  const m = Math.round(ms / 60000);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}
