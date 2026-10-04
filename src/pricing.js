// Public API list prices, USD per million tokens.
// Anthropic: https://platform.claude.com/docs/en/about-claude/pricing (checked 2026-10-04)
// OpenAI:    https://developers.openai.com/api/docs/pricing         (checked 2026-10-04)
//
// Costs are "API-equivalent": what the same tokens would cost at list price.
// Seat plans (Claude Pro/Max/Team, ChatGPT plans) bill differently.

export const PRICES_CHECKED = "2026-10-04";

// in, out, cache5m (5-minute cache write), cache1h (1-hour cache write), read (cache hit)
const claude = (inp, out, read) => ({ in: inp, out, cache5m: inp * 1.25, cache1h: inp * 2, read });

export const ANTHROPIC = {
  "claude-fable-5-1": claude(10, 50, 0.25),
  "claude-mythos-5-1": claude(10, 50, 0.25),
  "claude-fable-5": claude(10, 50, 1),
  "claude-mythos-5": claude(10, 50, 1),
  "claude-opus-5-5": claude(4, 20, 0.2),
  "claude-opus-5": claude(5, 25, 0.5),
  "claude-opus-4-8": claude(5, 25, 0.5),
  "claude-opus-4-7": claude(5, 25, 0.5),
  "claude-opus-4-6": claude(5, 25, 0.5),
  "claude-opus-4-5": claude(5, 25, 0.5),
  "claude-opus-4-1": claude(15, 75, 1.5),
  "claude-opus-4": claude(15, 75, 1.5),
  "claude-sonnet-5-5": claude(2, 10, 0.2),
  "claude-sonnet-5": claude(2, 10, 0.2),
  "claude-sonnet-4-6": claude(3, 15, 0.3),
  "claude-sonnet-4-5": claude(3, 15, 0.3),
  "claude-sonnet-4": claude(3, 15, 0.3),
  "claude-haiku-4-5": claude(1, 5, 0.1),
  "claude-3-5-haiku": claude(0.8, 4, 0.08),
};

// Fast mode replaces base input/output; cache multipliers apply on top of the fast input price.
export const ANTHROPIC_FAST = {
  "claude-opus-5-5": { in: 8, out: 40 },
  "claude-opus-5": { in: 10, out: 50 },
  "claude-opus-4-8": { in: 10, out: 50 },
};

// Cache-read multiplier relative to input (needed to re-derive read price under fast mode).
const READ_MULT = { "claude-fable-5-1": 0.025, "claude-mythos-5-1": 0.025, "claude-opus-5-5": 0.05 };

export const US_GEO_MULT = 1.1; // inference_geo "us" on Claude 4.6+ models

// in, cached (cached input), out. Long-context (>272K input) doubles input-side prices.
export const OPENAI = {
  "gpt-6-astra": { in: 10, cached: 1, out: 50 },
  "gpt-6.1-sol": { in: 2, cached: 0.1, out: 10 },
  "gpt-6-sol": { in: 2, cached: 0.2, out: 10 },
  "gpt-6-luna": { in: 0.1, cached: 0.01, out: 0.5 },
  "gpt-5.6-sol": { in: 4, cached: 0.4, out: 20 },
  "gpt-5.6-terra": { in: 2, cached: 0.2, out: 12 },
  "gpt-5.6-luna": { in: 0.2, cached: 0.02, out: 1.2 },
  "gpt-5.5": { in: 5, cached: 0.5, out: 30 },
  "gpt-5.4": { in: 2.5, cached: 0.25, out: 15 },
  "gpt-5.4-mini": { in: 0.75, cached: 0.075, out: 4.5 },
  "gpt-5.4-nano": { in: 0.2, cached: 0.02, out: 1.25 },
  "gpt-5.3-codex": { in: 1.75, cached: 0.175, out: 14 },
  "gpt-5.2": { in: 1.75, cached: 0.175, out: 14 },
  "gpt-5.1": { in: 1.25, cached: 0.125, out: 10 },
  "gpt-5": { in: 1.25, cached: 0.125, out: 10 },
  "gpt-5-mini": { in: 0.25, cached: 0.025, out: 2 },
  "gpt-5-nano": { in: 0.05, cached: 0.005, out: 0.4 },
};
export const OPENAI_LONG_CONTEXT = 272_000;

// Models billed at the top tier; used for the "expensive model share" flag.
export const PREMIUM = /fable|mythos|opus|astra|-pro\b/;

/** Normalise vendor model ids: drop provider prefixes and date / version suffixes. */
export function normalizeModel(id) {
  if (!id) return "";
  let m = String(id).toLowerCase().trim();
  m = m.replace(/^(anthropic\.|us\.anthropic\.|openai\/|anthropic\/)/, "");
  m = m.replace(/@\d{8}$/, "").replace(/-\d{8}$/, "").replace(/-v\d+(:\d+)?$/, "");
  m = m.replace(/\[1m\]$/, "");
  return m;
}

/** Price row for an Anthropic model, or null when unknown. */
export function anthropicPrice(model) {
  const m = normalizeModel(model);
  return ANTHROPIC[m] || null;
}

/** Price row for an OpenAI model, or null. Codex variants fall back to their base model. */
export function openaiPrice(model) {
  const m = normalizeModel(model);
  if (OPENAI[m]) return OPENAI[m];
  const base = m.replace(/-codex(-max|-mini)?$/, "");
  return OPENAI[base] || null;
}

/**
 * Cost of one Claude response.
 * u: {input, output, cacheRead, cache5m, cache1h}; opts: {speed, geo}
 * Returns null when the model is unpriced.
 */
export function claudeCost(model, u, { speed, geo } = {}) {
  const p = anthropicPrice(model);
  if (!p) return null;
  const m = normalizeModel(model);
  let row = p;
  if (speed === "fast" && ANTHROPIC_FAST[m]) {
    const f = ANTHROPIC_FAST[m];
    row = { in: f.in, out: f.out, cache5m: f.in * 1.25, cache1h: f.in * 2, read: f.in * (READ_MULT[m] ?? 0.1) };
  }
  const usd =
    (u.input * row.in + u.output * row.out + u.cacheRead * row.read + u.cache5m * row.cache5m + u.cache1h * row.cache1h) / 1e6;
  return geo === "us" ? usd * US_GEO_MULT : usd;
}

/**
 * Cost of one OpenAI response. OpenAI's input_tokens include cached tokens,
 * and output_tokens include reasoning tokens.
 * u: {input, cachedInput, output}
 */
export function openaiCost(model, u) {
  const p = openaiPrice(model);
  if (!p) return null;
  const long = u.input > OPENAI_LONG_CONTEXT ? 2 : 1;
  const uncached = Math.max(0, u.input - u.cachedInput);
  return (uncached * p.in * long + u.cachedInput * p.cached * long + u.output * p.out) / 1e6;
}
