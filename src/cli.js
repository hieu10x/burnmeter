#!/usr/bin/env node
// burnmeter: local report of AI coding spend from Claude Code and Codex session logs.
// Reads files on this machine only. Sends nothing anywhere.

import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { readClaude } from "./sources/claude.js";
import { readCodex } from "./sources/codex.js";
import { summarize, render } from "./report.js";
import { buildExport, defaultDeveloperId, readExports, renderMerge } from "./team.js";

const VERSION = "0.1.0";
const CTA = "Rolling this up across a team, with alerts and caps before the bill? Early access: https://burnmeter.pages.dev/?utm_source=cli&utm_medium=terminal";

const HELP = `burnmeter ${VERSION}: what your AI coding tools would cost at API prices

Usage
  npx burnmeter [options]                     report for this machine
  npx burnmeter --export me.json [--as NAME]  write an anonymised team summary
  npx burnmeter merge a.json b.json ...       combine team summaries (for a lead)

Options
  --since YYYY-MM-DD     start date (default: 30 days ago)
  --until YYYY-MM-DD     end date, inclusive (default: today)
  --tool claude|codex    only one tool
  --session-alert USD    flag sessions costing at least this (default 25)
  --day-alert USD        flag days costing at least this (default 100)
  --days N               rows in the daily table (default 14)
  --json                 machine-readable summary on stdout
  --export FILE          write team summary JSON (no prompts, code or paths)
  --as NAME              developer label in the export (default: anonymous hash)
  --include-projects     keep project names in the export (hashed by default)
  --no-color             plain output
  -v, --version / -h, --help

Reads ~/.claude/projects (or $CLAUDE_CONFIG_DIR) and ~/.codex/sessions (or $CODEX_HOME).
Cursor and GitHub Copilot keep no usage data on your machine, so they are not covered.`;

function parseDate(s, name) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new Error(`--${name} must be YYYY-MM-DD`);
  const d = new Date(s + "T00:00:00Z");
  if (isNaN(d)) throw new Error(`--${name}: invalid date`);
  return d;
}

export async function main(argv = process.argv.slice(2), io = { out: console.log, err: console.error }) {
  const { values: o, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      since: { type: "string" },
      until: { type: "string" },
      tool: { type: "string" },
      "session-alert": { type: "string", default: "25" },
      "day-alert": { type: "string", default: "100" },
      days: { type: "string", default: "14" },
      json: { type: "boolean", default: false },
      export: { type: "string" },
      as: { type: "string" },
      "include-projects": { type: "boolean", default: false },
      "no-color": { type: "boolean", default: false },
      version: { type: "boolean", short: "v" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (o.help) return io.out(HELP);
  if (o.version) return io.out(VERSION);
  const color = !o["no-color"] && !process.env.NO_COLOR && process.stdout.isTTY;

  if (positionals[0] === "merge") {
    const files = positionals.slice(1);
    if (!files.length) throw new Error("merge needs at least one export file");
    return io.out(renderMerge(readExports(files), { color }));
  }
  if (positionals.length) throw new Error(`unknown command: ${positionals[0]} (try --help)`);

  const today = new Date(new Date().toISOString().slice(0, 10) + "T00:00:00Z");
  const since = o.since ? parseDate(o.since, "since") : new Date(today - 29 * 864e5);
  const until = new Date((o.until ? parseDate(o.until, "until") : today).getTime() + 864e5); // exclusive
  if (o.tool && !["claude", "codex"].includes(o.tool)) throw new Error("--tool must be claude or codex");
  const num = (k) => {
    const n = Number(o[k]);
    if (!Number.isFinite(n) || n < 0) throw new Error(`--${k} must be a number`);
    return n;
  };

  const records = [];
  if (o.tool !== "codex") records.push(...(await readClaude({ since, until })).records);
  if (o.tool !== "claude") records.push(...readCodex({ since, until, warn: (m) => io.err("note: " + m) }).records);

  const s = summarize(records, { sessionAlert: num("session-alert"), dayAlert: num("day-alert") });

  if (o.export) {
    const exp = buildExport(s, { since, until, developer: o.as || defaultDeveloperId(), includeProjects: o["include-projects"] });
    fs.writeFileSync(o.export, JSON.stringify(exp, null, 2) + "\n");
    io.err(`wrote ${o.export} (${exp.developer}, ${exp.total.requests} requests, $${exp.total.cost}). Share it with your lead; they run: npx burnmeter merge *.json`);
  }
  if (o.json) return io.out(JSON.stringify(buildExport(s, { since, until, developer: o.as || defaultDeveloperId(), includeProjects: true }), null, 2));
  if (!o.export) io.out(render(s, { since, until, color, days: num("days"), cta: CTA }));
}

const isMain = process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
if (isMain) {
  main().catch((e) => {
    console.error("burnmeter: " + e.message);
    process.exit(1);
  });
}
