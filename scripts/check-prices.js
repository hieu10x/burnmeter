#!/usr/bin/env node
// Monthly pricing check, run by .github/workflows/price-check.yml.
// Lists model IDs on the vendors' pricing pages that src/pricing.js can't price,
// and flags PRICES_CHECKED when it is older than MAX_AGE_DAYS.
// Prints a Markdown report to stdout, or nothing when all is well.
// A failed fetch, or a page with no model IDs (layout change), exits non-zero.

import { anthropicPrice, openaiPrice, normalizeModel, PRICES_CHECKED } from "../src/pricing.js";

const MAX_AGE_DAYS = 45;

const PAGES = [
  {
    vendor: "Anthropic",
    url: "https://platform.claude.com/docs/en/about-claude/pricing",
    re: /claude-(?:fable|mythos|opus|sonnet|haiku)-\d+(?:-\d+)*/g,
    priced: anthropicPrice,
  },
  {
    vendor: "OpenAI",
    url: "https://developers.openai.com/api/docs/pricing",
    re: /gpt-\d[\w.-]*/g,
    priced: openaiPrice,
  },
];

// On the pages but deliberately unpriced: retired, or not used by Claude Code / Codex CLI.
const IGNORE = [
  /^claude-(?:opus|sonnet|haiku)-3(?:-|$)/,
  /^gpt-(?:3\.5|4)(?:[.-]|o|$)/,
  /(?:transcribe|tts|search-api|realtime|audio|image|instruct)/,
  /-(?:pro|cyber)$/,
];

/** Normalised, de-duplicated model IDs found in a page's HTML. */
export function extractIds(html, re) {
  const ids = new Set();
  for (const [raw] of html.matchAll(re)) {
    const id = normalizeModel(raw.replace(/[.-]+$/, ""))
      .replace(/-\d{4}-\d{2}-\d{2}$/, "") // gpt-4.1-2025-04-14
      .replace(/-\d{4}$/, ""); // gpt-4-0613
    ids.add(id);
  }
  return [...ids].sort();
}

async function main() {
  const out = [];

  for (const p of PAGES) {
    const res = await fetch(p.url, { headers: { "user-agent": "burnmeter-price-check" } });
    if (!res.ok) throw new Error(`${p.vendor}: HTTP ${res.status} from ${p.url}`);
    const ids = extractIds(await res.text(), p.re);
    if (!ids.length) throw new Error(`${p.vendor}: no model IDs found on ${p.url}; has the page layout changed?`);
    const missing = ids.filter((id) => !p.priced(id) && !IGNORE.some((r) => r.test(id)));
    if (missing.length) {
      out.push(`### ${p.vendor}: models with no price`, "", ...missing.map((id) => `- \`${id}\``), "", `Source: ${p.url}`, "");
    }
  }

  const age = Math.floor((Date.now() - Date.parse(PRICES_CHECKED)) / 86_400_000);
  if (age > MAX_AGE_DAYS) {
    out.push(`### Prices last checked ${PRICES_CHECKED} (${age} days ago)`, "", "Re-check both pages for price changes, then bump `PRICES_CHECKED`.", "");
  }

  if (out.length) {
    out.push("---", "After updating `src/pricing.js`: bump `PRICES_CHECKED`, the version, and `npm publish`.");
    console.log(out.join("\n"));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
