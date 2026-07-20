/**
 * adaptive-limiter.mjs — per-host-family adaptive concurrency for ATS scans.
 *
 * WHY (evidence, 2026-07-20): a live `scan-ats-full.mjs --ats workday --limit 400`
 * run produced 11+ "HTTP 429 Too Many Requests" truncations, losing real jobs
 * (e.g. amcor: 60 of 761 postings fetched, amat: 200 of 1815). The providers
 * already retry each PAGE with exponential backoff + jitter + Retry-After
 * (providers/workday.mjs fetchPageWithRetry), so why did it still happen?
 *
 * Because backoff is per-request but the pressure is global. scan-ats-full.mjs
 * runs CONCURRENCY=20 tenants at once, and every `*.myworkdayjobs.com` tenant
 * sits behind the SAME Workday edge. Tenant A politely backing off is invisible
 * to the 19 other workers still hammering the same infrastructure. Per-request
 * backoff cannot fix a fleet-level overload — you need a shared signal.
 *
 * DESIGN: AIMD (additive-increase / multiplicative-decrease), the same control
 * law TCP congestion control uses, keyed by HOST FAMILY (the ATS), not hostname:
 *   - success        → slowly widen the window (+1 every `successesPerStep`)
 *   - 429 / 503      → immediately halve it, and open a cool-down gate that
 *                      every in-flight worker for that family must wait behind
 *   - repeated 429s  → circuit-break: stop issuing new requests to that family
 *                      for `breakerMs`, so a scan degrades gracefully instead
 *                      of burning its whole budget on retries
 *
 * The window self-tunes: an ATS that tolerates 20 concurrent callers converges
 * back up to the cap, while one that starts throttling settles at whatever it
 * actually allows. No hand-tuned per-provider constants to keep in sync.
 *
 * Pure in-memory and dependency-free; one instance per scan run.
 */

const DEFAULTS = {
  max: 20,              // ceiling; also the starting window
  min: 2,               // never throttle below this — a scan must still finish
  successesPerStep: 12, // successes needed before widening the window by 1
  cooldownMs: 2_000,    // gate every worker waits behind after a throttle
  maxCooldownMs: 60_000,
  breakerThreshold: 8,  // consecutive throttles before the circuit opens
  breakerMs: 120_000,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Which ATS family a URL belongs to. Tenants share edge infrastructure, so
// they must share a limiter: every *.myworkdayjobs.com is one family.
export function hostFamily(url) {
  let h;
  try { h = new URL(url).hostname.toLowerCase(); } catch { return 'unknown'; }
  if (h.endsWith('.myworkdayjobs.com')) return 'workday';
  if (h.endsWith('greenhouse.io')) return 'greenhouse';
  if (h.endsWith('lever.co')) return 'lever';
  if (h.endsWith('ashbyhq.com')) return 'ashby';
  if (h.endsWith('smartrecruiters.com')) return 'smartrecruiters';
  if (h.endsWith('workable.com')) return 'workable';
  if (h.endsWith('icims.com')) return 'icims';
  if (h.endsWith('jibeapply.com')) return 'jibeapply';
  // Everything else is throttled per-hostname: unrelated company sites must
  // not share a budget just because neither is a known ATS.
  return h;
}

const isThrottle = (err) => err?.status === 429 || err?.status === 503;

function parseRetryAfterMs(v) {
  if (!v) return null;
  const secs = Number(v);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const at = Date.parse(v);
  return Number.isNaN(at) ? null : Math.max(0, at - Date.now());
}

class FamilyState {
  constructor(cfg) {
    this.cfg = cfg;
    this.window = cfg.max;      // current allowed concurrency
    this.inFlight = 0;
    this.successStreak = 0;
    this.throttleStreak = 0;
    this.cooldownMs = cfg.cooldownMs;
    this.gateUntil = 0;         // epoch ms; all workers wait behind this
    this.breakerUntil = 0;
    this.waiters = [];
    this.stats = { requests: 0, throttled: 0, brokenOpen: 0, waitedMs: 0 };
  }

  get isOpen() { return Date.now() < this.breakerUntil; }

  release() {
    this.inFlight--;
    const next = this.waiters.shift();
    if (next) next();
  }

  onSuccess() {
    this.throttleStreak = 0;
    if (++this.successStreak >= this.cfg.successesPerStep) {
      this.successStreak = 0;
      if (this.window < this.cfg.max) this.window++;
      // Decay the penalty too, so one bad patch doesn't punish the whole run.
      this.cooldownMs = Math.max(this.cfg.cooldownMs, Math.floor(this.cooldownMs / 2));
    }
  }

  onThrottle(retryAfterMs) {
    this.successStreak = 0;
    this.stats.throttled++;
    this.window = Math.max(this.cfg.min, Math.floor(this.window / 2));
    this.cooldownMs = Math.min(this.cfg.maxCooldownMs, this.cooldownMs * 2);
    // Honor Retry-After but clamp it: a hostile or misconfigured
    // "Retry-After: 86400" must not park the scan for a day.
    const wait = retryAfterMs !== null
      ? Math.min(retryAfterMs, this.cfg.maxCooldownMs)
      : this.cooldownMs + Math.random() * 500; // jitter: avoid lockstep retry
    this.gateUntil = Math.max(this.gateUntil, Date.now() + wait);
    if (++this.throttleStreak >= this.cfg.breakerThreshold) {
      this.breakerUntil = Date.now() + this.cfg.breakerMs;
      this.throttleStreak = 0;
      this.stats.brokenOpen++;
    }
  }
}

export class AdaptiveLimiter {
  constructor(cfg = {}) {
    this.cfg = { ...DEFAULTS, ...cfg };
    this.families = new Map();
  }

  family(key) {
    let f = this.families.get(key);
    if (!f) this.families.set(key, f = new FamilyState(this.cfg));
    return f;
  }

  /**
   * Run `fn` under the limiter for `url`'s host family.
   * Throws CircuitOpenError if the family is currently circuit-broken, so the
   * caller can skip cheaply instead of queueing work that will just fail.
   */
  async run(url, fn) {
    const f = this.family(hostFamily(url));

    if (f.isOpen) {
      const err = new Error(`circuit open for ${hostFamily(url)} — too many 429s; skipping`);
      err.circuitOpen = true;
      throw err;
    }

    // Wait for a concurrency slot.
    if (f.inFlight >= f.window) {
      await new Promise((resolve) => f.waiters.push(resolve));
    }
    f.inFlight++;

    try {
      // Wait behind the shared cool-down gate. This is the piece per-request
      // backoff cannot do: EVERY worker in the family pauses after a 429, not
      // just the one that got throttled.
      const wait = f.gateUntil - Date.now();
      if (wait > 0) { f.stats.waitedMs += wait; await sleep(wait); }

      f.stats.requests++;
      const out = await fn();
      f.onSuccess();
      return out;
    } catch (err) {
      if (isThrottle(err)) f.onThrottle(parseRetryAfterMs(err?.retryAfter));
      throw err;
    } finally {
      f.release();
    }
  }

  /** Per-family telemetry for the end-of-scan summary. */
  report() {
    return [...this.families.entries()].map(([family, f]) => ({
      family,
      requests: f.stats.requests,
      throttled: f.stats.throttled,
      throttlePct: f.stats.requests ? Math.round((100 * f.stats.throttled) / f.stats.requests) : 0,
      finalWindow: f.window,
      circuitTrips: f.stats.brokenOpen,
      waitedSec: Math.round(f.stats.waitedMs / 1000),
    })).filter((r) => r.requests > 0).sort((a, b) => b.throttled - a.throttled);
  }
}

/**
 * Wraps an httpCtx (providers/_http.mjs makeHttpCtx) so every provider call
 * routes through the limiter without any provider needing to know it exists.
 */
export function limitHttpCtx(ctx, limiter) {
  return {
    ...ctx,
    fetchJson: (url, opts) => limiter.run(url, () => ctx.fetchJson(url, opts)),
    fetchText: (url, opts) => limiter.run(url, () => ctx.fetchText(url, opts)),
  };
}
