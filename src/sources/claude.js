// Claude Code session logs: <config>/projects/<project>/<session>.jsonl
// Each assistant response can appear on several lines (one per content block) and
// again in other files when a session is resumed, so responses are de-duplicated
// by (message.id, requestId) across all files, keeping the largest usage seen.
//
// Some usage never appears as an assistant line: background calls on other models
// (e.g. Haiku for web search / summaries) and web-search fees. Claude Code records
// those in per-session "cost-state" lines (cumulative); we add, per session, the
// models it lists that no assistant line covers, plus $0.01 per web search on the
// models that are covered.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { claudeCost, normalizeModel } from "../pricing.js";

export function claudeDirs(env = process.env) {
  // CLAUDE_CONFIG_DIR replaces the default locations (comma-separated for several)
  const dirs = env.CLAUDE_CONFIG_DIR
    ? env.CLAUDE_CONFIG_DIR.split(",").map((d) => d.trim())
    : [path.join(os.homedir(), ".claude"), path.join(os.homedir(), ".config", "claude")];
  return [...new Set(dirs)].map((d) => path.join(d, "projects")).filter((d) => fs.existsSync(d));
}

function* walk(dir, ext) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p, ext);
    else if (e.name.endsWith(ext)) yield p;
  }
}

function usageOf(u) {
  const cc = u.cache_creation && typeof u.cache_creation === "object" ? u.cache_creation : null;
  const total5m = cc ? cc.ephemeral_5m_input_tokens || 0 : u.cache_creation_input_tokens || 0;
  return {
    input: u.input_tokens || 0,
    output: u.output_tokens || 0,
    cacheRead: u.cache_read_input_tokens || 0,
    cache5m: total5m,
    cache1h: cc ? cc.ephemeral_1h_input_tokens || 0 : 0,
  };
}

const WEB_SEARCH_USD = 0.01;

/** Read all Claude Code responses in [since, until). Returns { records, files }. */
export async function readClaude({ dirs = claudeDirs(), since, until } = {}) {
  const byKey = new Map();
  const costState = new Map(); // sessionId -> latest cost-state line
  let files = 0;
  for (const root of dirs) {
    for (const file of walk(root, ".jsonl")) {
      files++;
      const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
      for await (const line of rl) {
        if (line.includes('"cost-state"')) {
          try {
            const c = JSON.parse(line);
            const prev = costState.get(c.sessionId);
            if (c.type === "cost-state" && (!prev || c.totalCostUSD >= prev.c.totalCostUSD)) costState.set(c.sessionId, { c, file });
          } catch {}
          continue;
        }
        if (!line.includes('"usage"')) continue;
        let d;
        try {
          d = JSON.parse(line);
        } catch {
          continue;
        }
        const m = d.message;
        if (d.type !== "assistant" || !m || !m.usage || !m.model || m.model === "<synthetic>") continue;
        const ts = d.timestamp ? new Date(d.timestamp) : null;
        if (!ts || isNaN(ts) || (since && ts < since) || (until && ts >= until)) continue;
        const key = m.id && d.requestId ? `${m.id}:${d.requestId}` : `${file}:${d.uuid}`;
        const usage = usageOf(m.usage);
        const prev = byKey.get(key);
        if (prev && prev.usage.output >= usage.output) continue;
        byKey.set(key, {
          tool: "claude-code",
          model: m.model,
          ts,
          project: d.cwd ? path.basename(d.cwd) : path.basename(path.dirname(file)),
          session: d.sessionId || path.basename(file, ".jsonl"),
          usage,
          speed: m.usage.speed,
          geo: m.usage.inference_geo,
        });
      }
    }
  }
  const records = [...byKey.values()].map((r) => ({ ...r, cost: claudeCost(r.model, r.usage, r) }));
  records.push(...extrasFromCostState(costState, records, since, until));
  return { records, files };
}

function extrasFromCostState(costState, records, since, until) {
  const seen = new Map(); // session -> {models, last record}
  for (const r of records) {
    let s = seen.get(r.session);
    if (!s) seen.set(r.session, (s = { models: new Set(), last: r }));
    s.models.add(normalizeModel(r.model));
    if (r.ts > s.last.ts) s.last = r;
  }
  const extras = [];
  for (const [session, { c, file }] of costState) {
    const s = seen.get(session);
    const ts = s ? s.last.ts : c.startTime ? new Date(c.startTime) : null;
    if (!ts || (since && ts < since) || (until && ts >= until)) continue;
    const project = s ? s.last.project : path.basename(path.dirname(file));
    for (const [model, u] of Object.entries(c.modelUsage || {})) {
      const covered = s && s.models.has(normalizeModel(model));
      const usage = covered
        ? { input: 0, output: 0, cacheRead: 0, cache5m: 0, cache1h: 0 }
        : { input: u.inputTokens || 0, output: u.outputTokens || 0, cacheRead: u.cacheReadInputTokens || 0, cache5m: u.cacheCreationInputTokens || 0, cache1h: 0 };
      // uncovered models: Claude Code's own costUSD already includes their web-search fees
      const cost = covered ? (u.webSearchRequests || 0) * WEB_SEARCH_USD : typeof u.costUSD === "number" ? u.costUSD : claudeCost(model, usage);
      if (!cost && !usage.input && !usage.output) continue;
      extras.push({ tool: "claude-code", model, ts, project, session, usage, cost, extra: true });
    }
  }
  return extras;
}
