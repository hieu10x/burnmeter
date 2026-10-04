import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { readClaude } from "../src/sources/claude.js";
import { readCodex } from "../src/sources/codex.js";
import { claudeCost, normalizeModel, openaiCost, openaiPrice } from "../src/pricing.js";
import { summarize } from "../src/report.js";
import { buildExport, renderMerge } from "../src/team.js";
import { main } from "../src/cli.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "burnmeter-test-"));
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);
const jsonl = (rows) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";

function claudeLine({ id = "msg_1", req = "req_1", model = "claude-opus-5-5", ts = "2026-10-01T10:00:00Z", session = "s1", cwd = "/work/app", usage }) {
  return { type: "assistant", timestamp: ts, sessionId: session, cwd, requestId: req, uuid: id + req, message: { id, model, usage } };
}
const u = (o) => ({ input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 }, speed: "standard", ...o });

// ---------- pricing ----------

test("normalizeModel strips dates and provider prefixes", () => {
  assert.equal(normalizeModel("claude-haiku-4-5-20251001"), "claude-haiku-4-5");
  assert.equal(normalizeModel("anthropic.claude-opus-5-5"), "claude-opus-5-5");
  assert.equal(normalizeModel("claude-opus-4-5@20251101"), "claude-opus-4-5");
});

test("claude cost uses per-model cache-read rate, both cache-write tiers, fast mode and US geo", () => {
  const usage = { input: 1e6, output: 1e6, cacheRead: 1e6, cache5m: 1e6, cache1h: 1e6 };
  // Opus 5.5: 4 + 20 + 0.20 + 5 + 8
  near(claudeCost("claude-opus-5-5", usage), 37.2);
  // Fast: input 8, output 40, read 0.05*8, writes 1.25*8 and 2*8
  near(claudeCost("claude-opus-5-5", usage, { speed: "fast" }), 8 + 40 + 0.4 + 10 + 16);
  near(claudeCost("claude-sonnet-5-5", usage, { geo: "us" }), (2 + 10 + 0.2 + 2.5 + 4) * 1.1);
  near(claudeCost("claude-fable-5-1", { ...usage, input: 0, output: 0, cache5m: 0, cache1h: 0 }), 0.25);
  assert.equal(claudeCost("claude-unknown-9", usage), null);
});

test("openai cost: input includes cached, codex variants fall back, long context doubles input", () => {
  near(openaiCost("gpt-5.3-codex", { input: 200_000, cachedInput: 80_000, output: 1e6 }), (120_000 * 1.75 + 80_000 * 0.175) / 1e6 + 14);
  assert.deepEqual(openaiPrice("gpt-5.1-codex-max"), openaiPrice("gpt-5.1"));
  near(openaiCost("gpt-6-sol", { input: 300_000, cachedInput: 0, output: 0 }), 0.3 * 2 * 2);
});

// ---------- Claude Code parsing ----------

test("claude: de-duplicates repeated and cross-file lines, keeps the largest output", async () => {
  const root = tmp();
  const proj = path.join(root, "-work-app");
  fs.mkdirSync(proj);
  const partial = claudeLine({ usage: u({ input_tokens: 10, output_tokens: 5 }) });
  const full = claudeLine({ usage: u({ input_tokens: 10, output_tokens: 500 }) });
  const other = claudeLine({ id: "msg_2", req: "req_2", ts: "2026-10-02T10:00:00Z", usage: u({ output_tokens: 1000 }) });
  fs.writeFileSync(path.join(proj, "s1.jsonl"), jsonl([partial, full, full, other]));
  fs.writeFileSync(path.join(proj, "s1-resumed.jsonl"), jsonl([full, other])); // resumed session copies history
  const { records } = await readClaude({ dirs: [root] });
  assert.equal(records.length, 2);
  assert.equal(records.find((r) => r.ts.toISOString().startsWith("2026-10-01")).usage.output, 500);
  assert.equal(records[0].project, "app");
});

test("claude: skips synthetic, respects date range, prices cache tiers", async () => {
  const root = tmp();
  fs.mkdirSync(path.join(root, "p"));
  fs.writeFileSync(
    path.join(root, "p", "s.jsonl"),
    jsonl([
      claudeLine({ model: "<synthetic>", usage: u({ output_tokens: 99 }) }),
      claudeLine({ id: "old", ts: "2026-08-01T00:00:00Z", usage: u({ output_tokens: 1e6 }) }),
      claudeLine({ id: "in", usage: u({ input_tokens: 1e6, cache_creation: { ephemeral_5m_input_tokens: 1e6, ephemeral_1h_input_tokens: 1e6 } }) }),
    ]),
  );
  const { records } = await readClaude({ dirs: [root], since: new Date("2026-09-01"), until: new Date("2026-11-01") });
  assert.equal(records.length, 1);
  near(records[0].cost, 4 + 5 + 8);
});

test("claude: adds background-model cost and web-search fees from cost-state, once", async () => {
  const root = tmp();
  fs.mkdirSync(path.join(root, "p"));
  const cs = (total) => ({
    type: "cost-state",
    sessionId: "s1",
    totalCostUSD: total,
    startTime: Date.parse("2026-10-01T09:00:00Z"),
    modelUsage: {
      "claude-opus-5-5": { inputTokens: 1, outputTokens: 1, costUSD: 1, webSearchRequests: 3 },
      "claude-haiku-4-5-20251001": { inputTokens: 1000, outputTokens: 100, costUSD: 0.5, webSearchRequests: 2 },
    },
  });
  fs.writeFileSync(path.join(root, "p", "s1.jsonl"), jsonl([claudeLine({ usage: u({ output_tokens: 10 }) }), cs(0.9), cs(1.5), cs(1.5)]));
  const { records } = await readClaude({ dirs: [root] });
  const extras = records.filter((r) => r.extra);
  assert.equal(extras.length, 2);
  near(extras.find((r) => r.model.includes("haiku")).cost, 0.5); // uncovered model: Claude Code's own cost
  near(extras.find((r) => r.model === "claude-opus-5-5").cost, 0.03); // covered model: only search fees
  const s = summarize(records);
  assert.equal(s.total.requests, 1); // extras are not requests
});

// ---------- Codex parsing ----------

function codexFile(dir, name, lines, zst = false) {
  const day = path.join(dir, "2026", "10", "01");
  fs.mkdirSync(day, { recursive: true });
  const text = jsonl(lines);
  const p = path.join(day, name + (zst ? ".jsonl.zst" : ".jsonl"));
  fs.writeFileSync(p, zst ? zlib.zstdCompressSync(Buffer.from(text)) : text);
}
const tc = (ts, total, last) => ({ timestamp: ts, type: "event_msg", payload: { type: "token_count", info: { total_token_usage: total, last_token_usage: last } } });
const T = (input, cached, output) => ({ input_tokens: input, cached_input_tokens: cached, output_tokens: output, reasoning_output_tokens: 0, total_tokens: input + output });

test("codex: cumulative totals, repeated events not double counted, model from turn_context", () => {
  const root = tmp();
  const lines = [
    { timestamp: "2026-10-01T10:00:00Z", type: "session_meta", payload: { id: "thread-1", cwd: "/work/api" } },
    { timestamp: "2026-10-01T10:00:01Z", type: "turn_context", payload: { cwd: "/work/api", model: "gpt-5.3-codex" } },
    tc("2026-10-01T10:00:05Z", T(1000, 400, 100), T(1000, 400, 100)),
    tc("2026-10-01T10:00:06Z", T(1000, 400, 100), T(1000, 400, 100)), // duplicate (rate-limit refresh)
    tc("2026-10-01T10:01:00Z", T(3000, 1400, 300), T(2000, 1000, 200)),
  ];
  codexFile(root, "rollout-a", lines);
  if (typeof zlib.zstdCompressSync === "function") codexFile(root, "rollout-b", lines, true);
  const { records } = readCodex({ dirs: [root] });
  const perFile = typeof zlib.zstdCompressSync === "function" ? 2 : 1;
  assert.equal(records.length, 2 * perFile);
  const out = records.reduce((s, r) => s + r.usage.output, 0);
  assert.equal(out, 300 * perFile);
  assert.equal(records[0].model, "gpt-5.3-codex");
  assert.equal(records[0].project, "api");
  assert.equal(records[0].usage.input, 600); // uncached only
  near(records[0].cost, (600 * 1.75 + 400 * 0.175 + 100 * 14) / 1e6);
});

// ---------- team export / merge ----------

test("export hashes project names by default and merge totals developers", async () => {
  const root = tmp();
  fs.mkdirSync(path.join(root, "p"));
  fs.writeFileSync(path.join(root, "p", "s.jsonl"), jsonl([claudeLine({ cwd: "/secret/client-project", usage: u({ output_tokens: 1e6 }) })]));
  const { records } = await readClaude({ dirs: [root] });
  const s = summarize(records);
  const range = { since: new Date("2026-10-01"), until: new Date("2026-10-02") };
  const a = buildExport(s, { ...range, developer: "alice" });
  assert.ok(!JSON.stringify(a).includes("client-project"));
  assert.match(a.by_project[0].project, /^p-[0-9a-f]{8}$/);
  const b = { ...a, developer: "bob", total: { ...a.total, cost: a.total.cost * 3 } };
  const text = renderMerge([a, b], { color: false });
  assert.match(text, /2 developers/);
  assert.match(text, /bob\s+\$60\.00\s+75%/);
});

test("cli: --json works and bad dates are rejected", async () => {
  const lines = [];
  process.env.CLAUDE_CONFIG_DIR = tmp(); // empty: no data, but must not crash
  process.env.CODEX_HOME = tmp();
  await main(["--json", "--since", "2026-10-01", "--until", "2026-10-01"], { out: (s) => lines.push(s), err: () => {} });
  const j = JSON.parse(lines.join("\n"));
  assert.equal(j.schema, "burnmeter.team/1");
  await assert.rejects(main(["--since", "01/10/2026"], { out() {}, err() {} }), /YYYY-MM-DD/);
});

test("cli: early-access line shows by default and --no-cta hides it", async () => {
  const cfg = tmp();
  fs.mkdirSync(path.join(cfg, "projects", "p"), { recursive: true });
  fs.writeFileSync(path.join(cfg, "projects", "p", "s.jsonl"), jsonl([claudeLine({ usage: u({ output_tokens: 1e3 }) })]));
  process.env.CLAUDE_CONFIG_DIR = cfg;
  process.env.CODEX_HOME = tmp();
  const run = async (extra) => {
    const out = [];
    await main(["--no-color", "--since", "2026-10-01", "--until", "2026-10-01", ...extra], { out: (s) => out.push(s), err: () => {} });
    return out.join("\n");
  };
  assert.match(await run([]), /burnmeter\.pages\.dev/);
  assert.doesNotMatch(await run(["--no-cta"]), /burnmeter\.pages\.dev/);
});

test("export project hashes are keyed per export, so guessed names can't be matched", async () => {
  const s = summarize([]);
  s.byProject = [{ key: "api-server", cost: 1 }];
  const range = { since: new Date("2026-10-01"), until: new Date("2026-10-02") };
  const a = buildExport(s, { ...range, developer: "a" }), b = buildExport(s, { ...range, developer: "b" });
  assert.notEqual(a.by_project[0].project, b.by_project[0].project);
});
