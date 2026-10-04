# burnmeter

See what your AI coding tools cost, per day, model, project and session, from the logs already on your machine.

```
npx burnmeter
```

```
AI coding spend  2026-09-20 → 2026-10-04  (API-equivalent cost at public list prices)

$258 across 3981 requests · 628.4M input tokens (618.0M cache hits) · 3.1M output tokens

By model
model              cost  share  requests  output tok
────────────────  ─────  ─────  ────────  ──────────
claude-opus-5-5    $255    99%      3980        3.0M
claude-haiku-4-5  $2.85     1%         0       63.1k

Most expensive sessions
started           tool         project        cost  requests  duration
────────────────  ───────────  ───────────  ──────  ────────  ────────
2026-09-28 08:12  claude-code  api-server   $48.04       614     7h34m
...

Alerts  (thresholds: session $25.00, day $100)
! 1 session(s) cost ≥ $25.00 (top: $48.04)
```

## What it covers

| Tool | Covered | How |
|---|---|---|
| Claude Code | ✅ | `~/.claude/projects/**/*.jsonl` (or `$CLAUDE_CONFIG_DIR`) |
| OpenAI Codex CLI | ✅ | `~/.codex/sessions/**` (or `$CODEX_HOME`), including `.jsonl.zst` on Node 22.15+ |
| Cursor | ❌ | Cursor keeps no usage data locally. Use its Admin API |
| GitHub Copilot | ❌ | Nothing local. Use the org usage-metrics API |

## How costs are calculated

- **API-equivalent cost**: tokens × public list prices ([Anthropic](https://platform.claude.com/docs/en/about-claude/pricing), [OpenAI](https://developers.openai.com/api/docs/pricing); checked 2026-10-04). On a Claude Pro/Max/Team or ChatGPT seat plan you don't pay this per token. It shows what the usage is *worth*, and what it would cost on usage billing.
- Includes model-specific cache-read rates, both 5-minute and 1-hour cache writes, fast mode, US-only inference (1.1×) and OpenAI's long-context (>272K) surcharge.
- Claude Code writes each response several times (once per content block, and again when a session is resumed). Responses are de-duplicated by message and request ID, which matters: without it, totals roughly double.
- Background calls on other models (e.g. Haiku for web search) and web-search fees come from Claude Code's per-session `cost-state` records.
- Unknown models are listed as "unpriced", and their tokens are still counted.

## Team roll-up (no server, no account)

Each developer:

```
npx burnmeter --export alice.json --as alice
```

The export holds daily totals, per-model totals and alert counts. It contains **no prompts, code, file paths or raw logs**, and project names are hashed unless you pass `--include-projects`.

The lead:

```
npx burnmeter merge *.json
```

## Options

```
--since / --until YYYY-MM-DD   period (default: last 30 days)
--tool claude|codex            one tool only
--session-alert USD            flag sessions at or above this cost (default 25)
--day-alert USD                flag days at or above this cost (default 100)
--json                         machine-readable output
--export FILE [--as NAME]      anonymised team summary
--no-color
```

## Privacy

Runs entirely on your machine. No network calls, no telemetry. Read the source in `src/`: it's ~700 lines with zero dependencies.

## Want this for a whole team, with alerts and caps *before* the bill?

That's what we're building: a per-developer view across Cursor, Claude Code, Copilot and API keys, on non-Enterprise plans. [Join early access](https://burnmeter.pages.dev/?utm_source=github&utm_medium=readme).

MIT licensed.
