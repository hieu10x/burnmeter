// Team roll-up: each developer exports a small anonymised summary; a lead merges them.
// No prompts, code, file paths or raw logs ever leave the machine. Project names are
// replaced by keyed hashes (random key per export, never stored) unless --include-projects
// is passed, so they can't be recovered by hashing guessed names.

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import { PRICES_CHECKED } from "./pricing.js";
import { day, table } from "./report.js";

export const SCHEMA = "burnmeter.team/1";

const short = (s) => crypto.createHash("sha256").update(s).digest("hex").slice(0, 8);

export function defaultDeveloperId() {
  return "dev-" + short(`${os.userInfo().username}@${os.hostname()}`);
}

const round = (n) => Math.round(n * 100) / 100;
const totals = (g) => ({ cost: round(g.cost), requests: g.requests, input: g.input, output: g.output, cache_read: g.cacheRead, cache_write: g.cacheWrite });

export function buildExport(summary, { since, until, developer, includeProjects }) {
  const key = crypto.randomBytes(32);
  const anon = (name) => "p-" + crypto.createHmac("sha256", key).update(name).digest("hex").slice(0, 8);
  return {
    schema: SCHEMA,
    generated: new Date().toISOString(),
    prices_checked: PRICES_CHECKED,
    period: { since: day(since), until: day(new Date(until - 1)) },
    developer,
    tools: summary.byTool.map((t) => t.key),
    total: totals(summary.total),
    by_day: summary.byDay.map((d) => ({ day: d.key, cost: round(d.cost) })),
    by_model: summary.byModel.map((m) => ({ model: m.key, ...totals(m) })),
    by_project: summary.byProject.map((p) => ({ project: includeProjects ? p.key : anon(p.key), cost: round(p.cost) })),
    alerts: {
      session_threshold: summary.alerts.sessionAlert,
      sessions_over: summary.alerts.sessions.length,
      max_session_cost: round(summary.topSessions[0]?.cost || 0),
      day_threshold: summary.alerts.dayAlert,
      days_over: summary.alerts.days.length,
      premium_share: round(summary.alerts.premiumShare),
    },
  };
}

export function readExports(files) {
  return files.map((f) => {
    const d = JSON.parse(fs.readFileSync(f, "utf8"));
    if (d.schema !== SCHEMA) throw new Error(`${f}: not a burnmeter team export (schema ${d.schema})`);
    return d;
  });
}

export function renderMerge(exps, { color = true } = {}) {
  const b = (t) => (color ? `\x1b[1m${t}\x1b[0m` : t);
  const usd = (n) => "$" + (n >= 100 ? n.toFixed(0) : n.toFixed(2));
  const team = exps.reduce((s, e) => s + e.total.cost, 0);
  const since = exps.map((e) => e.period.since).sort()[0];
  const until = exps.map((e) => e.period.until).sort().at(-1);
  const out = [b(`Team AI coding spend  ${since} → ${until}`) + `  ·  ${exps.length} developers  ·  ${b(usd(team))}`, ""];

  const rows = [...exps]
    .sort((a, b) => b.total.cost - a.total.cost)
    .map((e) => {
      const peak = [...e.by_day].sort((a, b) => b.cost - a.cost)[0];
      return [
        e.developer,
        usd(e.total.cost),
        team ? Math.round((e.total.cost / team) * 100) + "%" : "–",
        e.by_model[0]?.model || "–",
        Math.round(e.alerts.premium_share * 100) + "%",
        peak ? `${usd(peak.cost)} (${peak.day})` : "–",
        e.alerts.sessions_over,
      ];
    });
  out.push(b("By developer"));
  out.push(table(["developer", "cost", "share", "top model", "premium", "peak day", "big sessions"], rows, "lrrlrll"));
  out.push("");

  const models = new Map();
  for (const e of exps) for (const m of e.by_model) models.set(m.model, (models.get(m.model) || 0) + m.cost);
  out.push(b("By model (team)"));
  out.push(table(["model", "cost", "share"], [...models].sort((a, b) => b[1] - a[1]).map(([m, c]) => [m, usd(c), team ? Math.round((c / team) * 100) + "%" : "–"]), "lrr"));

  const top = rows.slice(0, Math.max(1, Math.ceil(rows.length * 0.1)));
  const topCost = exps.sort((a, b) => b.total.cost - a.total.cost).slice(0, top.length).reduce((s, e) => s + e.total.cost, 0);
  out.push("");
  out.push(`Top ${top.length} developer(s) account for ${team ? Math.round((topCost / team) * 100) : 0}% of team spend.`);
  return out.join("\n");
}
