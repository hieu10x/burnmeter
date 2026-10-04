// Codex CLI rollout files: $CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl[.zst]
// Lines: {timestamp, type: "session_meta"|"turn_context"|"event_msg"|..., payload}.
// Usage comes from event_msg payloads of type "token_count", whose
// info.total_token_usage is cumulative for the thread. Token counts are taken as
// the delta between consecutive totals, so repeated events are not double-counted.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { openaiCost } from "../pricing.js";

export function codexDirs(env = process.env) {
  const home = env.CODEX_HOME || path.join(os.homedir(), ".codex");
  const d = path.join(home, "sessions");
  return fs.existsSync(d) ? [d] : [];
}

function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.name.endsWith(".jsonl") || e.name.endsWith(".jsonl.zst")) yield p;
  }
}

function readText(file, warn) {
  const buf = fs.readFileSync(file);
  if (!file.endsWith(".zst")) return buf.toString("utf8");
  if (typeof zlib.zstdDecompressSync !== "function") {
    warn(`skipping compressed Codex logs: Node ${process.version} has no zstd (needs Node 22.15+)`);
    return null;
  }
  return zlib.zstdDecompressSync(buf).toString("utf8");
}

const tok = (t = {}) => ({
  input: t.input_tokens || 0,
  cachedInput: t.cached_input_tokens || 0,
  output: t.output_tokens || 0,
  total: t.total_tokens || 0,
});

/** Read all Codex usage in [since, until). Returns { records, files }. */
export function readCodex({ dirs = codexDirs(), since, until, warn = () => {} } = {}) {
  const records = [];
  let files = 0;
  let warnedZst = false;
  const onceWarn = (m) => {
    if (!warnedZst) warn(m);
    warnedZst = true;
  };
  for (const root of dirs) {
    for (const file of walk(root)) {
      const text = readText(file, onceWarn);
      if (text === null) continue;
      files++;
      let model = "";
      let project = "";
      let session = path.basename(file).replace(/\.jsonl(\.zst)?$/, "");
      let prev = null;
      for (const line of text.split("\n")) {
        if (!line) continue;
        let d;
        try {
          d = JSON.parse(line);
        } catch {
          continue;
        }
        const p = d.payload || {};
        if (d.type === "session_meta") {
          session = p.id || session;
          if (p.cwd) project = path.basename(p.cwd);
        } else if (d.type === "turn_context") {
          if (p.model) model = p.model;
          if (p.cwd) project = path.basename(p.cwd);
        } else if (d.type === "event_msg" && p.type === "token_count" && p.info) {
          const total = tok(p.info.total_token_usage);
          let u;
          if (prev && total.total >= prev.total) {
            u = {
              input: total.input - prev.input,
              cachedInput: total.cachedInput - prev.cachedInput,
              output: total.output - prev.output,
            };
          } else {
            // first event, or totals reset (fork / compaction): use the per-response figure
            u = tok(p.info.last_token_usage);
          }
          prev = total;
          if (u.input + u.output === 0) continue;
          const ts = d.timestamp ? new Date(d.timestamp) : null;
          if (!ts || isNaN(ts) || (since && ts < since) || (until && ts >= until)) continue;
          records.push({
            tool: "codex",
            model: model || "unknown",
            ts,
            project: project || "unknown",
            session,
            // report input like Anthropic does: uncached input only, cache hits separately
            usage: { input: Math.max(0, u.input - u.cachedInput), output: u.output, cacheRead: u.cachedInput, cache5m: 0, cache1h: 0 },
            cost: openaiCost(model, u),
          });
        }
      }
    }
  }
  return { records, files };
}
