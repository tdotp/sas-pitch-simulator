// Fase 8 — RATE_LIMIT_STORAGE_DECISION + RATE_LIMIT_KEY_STRATEGY.
//
// In-memory, per-process token-bucket-by-window limiter. Deliberately NOT
// Redis: backend/src/index.ts runs a single `app.listen(...)` process, no
// cluster/worker fork, no multi-instance deployment today — an in-memory
// Map is exactly as consistent as the deployment needs. If a future phase
// moves to multiple instances, this decision needs revisiting (see
// KNOWN_LIMITATIONS in PHASE_08_OBSERVABILITY_RATE_LIMITS_REPORT.md) —
// not introduced speculatively now.
//
// Scoped, never IP-only: `keyOf` derives the bucket key from
// server-verified request state (req.auth.uid, req.appContext.organizationId
// — set by requireAuth/requireMembership, NEVER req.body) so a shared
// corporate NAT can't collapse many real users into one bucket, and a
// forged `organization_id` in a request body can never substitute for the
// tenant the server itself resolved. See MULTITENANT_SAFETY.
import type { NextFunction, Request, Response } from "express";
import { logEvent } from "../observability/log.js";

interface Bucket {
  count: number;
  resetAt: number;
}

// One Map per storeId so independently-configured limiters (e.g. the
// user-scoped and organization-scoped limiter on the SAME endpoint) never
// share a bucket namespace by accident.
const stores = new Map<string, Map<string, Bucket>>();

// Periodic sweep so a long-lived process doesn't accumulate one bucket
// per distinct user/org forever — expired buckets are harmless (the next
// hit on that key just creates a fresh one) but otherwise never freed.
// Cheap: O(total distinct keys seen this window) every 5 minutes.
const SWEEP_INTERVAL_MS = 5 * 60_000;
let sweepTimer: NodeJS.Timeout | null = null;
function ensureSweepScheduled(): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => {
    const now = Date.now();
    for (const store of stores.values()) {
      for (const [key, bucket] of store) {
        if (bucket.resetAt <= now) store.delete(key);
      }
    }
  }, SWEEP_INTERVAL_MS);
  sweepTimer.unref?.();
}

export type RateLimitScope = "user" | "organization" | "global" | "ip";

export interface RateLimitWindow {
  windowMs: number;
  limit: number;
}

export interface ScopedRateLimitOptions {
  // Unique per limiter instance — see the stores comment above.
  storeId: string;
  scope: RateLimitScope;
  // For logging only (which route this limiter guards). Every
  // user/organization/global call site passes a fixed literal (cardinality
  // stays bounded — see NO_HIGH_CARDINALITY in the Fase 8 report). The
  // `ip` scope is the one exception: PASS_WITH_FIXES P1.1 replaced the
  // single-endpoint-per-instance legacy limiter with ONE shared
  // pre-auth middleware mounted across every route, so its endpoint for
  // logging must be resolved PER REQUEST (req.path) rather than fixed at
  // creation time — still bounded cardinality, since the actual set of
  // routes is small and static, just not knowable at limiter-creation
  // time the way a single-route limiter's is.
  endpoint: string | ((req: Request) => string);
  // Returns the bucket key, or null to skip this limiter entirely (e.g. a
  // route where the relevant scope — user, org — isn't resolved yet).
  keyOf: (req: Request) => string | null;
  // The SAME object reference `config.rateLimits.*` holds — read live on
  // every request rather than copied at middleware-creation time. This is
  // what lets tests mutate `.limit` on an already-built middleware
  // (routes.test.ts does exactly this to exercise routes.ts's real wiring
  // without needing 1000+ requests or module-reset gymnastics); in
  // production the values are simply constant for the process lifetime.
  cfg: RateLimitWindow;
}

export function scopedRateLimit(opts: ScopedRateLimitOptions) {
  ensureSweepScheduled();
  let store = stores.get(opts.storeId);
  if (!store) {
    store = new Map();
    stores.set(opts.storeId, store);
  }
  const bucketsByKey = store;

  return function rateLimitMiddleware(req: Request, res: Response, next: NextFunction): void {
    const key = opts.keyOf(req);
    if (key === null) {
      next();
      return;
    }

    const now = Date.now();
    let bucket = bucketsByKey.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + opts.cfg.windowMs };
      bucketsByKey.set(key, bucket);
    }
    bucket.count += 1;

    if (bucket.count > opts.cfg.limit) {
      const retryAfterSeconds = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
      logEvent({
        event: "rate_limit_rejected",
        request_id: req.id,
        // Fase 8 P1.1: only spread when actually resolved — a bare
        // `user_id: req.auth?.uid` would still put the key on the object
        // (with value undefined) even for a genuinely pre-auth request
        // (the ip scope's whole point). JSON.stringify would drop it in
        // the real logEvent either way, but this keeps the in-memory
        // object itself honest too, and is what the ipScopedLimiter
        // tests assert on directly.
        ...(req.auth?.uid ? { user_id: req.auth.uid } : {}),
        ...(req.appContext?.organizationId ? { organization_id: req.appContext.organizationId } : {}),
        endpoint: typeof opts.endpoint === "function" ? opts.endpoint(req) : opts.endpoint,
        rate_limit_scope: opts.scope,
        outcome: "failure",
      });
      res.setHeader("Retry-After", String(retryAfterSeconds));
      res.status(429).json({
        error: "Demasiadas solicitudes. Intenta de nuevo más tarde.",
        retry_after_seconds: retryAfterSeconds,
      });
      return;
    }

    next();
  };
}

// USER_LIMITS: keyed on the server-verified Firebase uid (req.auth.uid) —
// never req.body. `req.auth` is only set once requireAuth succeeds, so a
// route mounting this BEFORE requireAuth would always skip it (keyOf
// returns null) — every call site in routes.ts mounts these AFTER
// requireAuth/requireMembership.
export function userScopedLimiter(endpoint: string, cfg: RateLimitWindow) {
  return scopedRateLimit({
    storeId: `user:${endpoint}`,
    cfg,
    scope: "user",
    endpoint,
    keyOf: (req) => (req.auth ? `user:${req.auth.uid}` : null),
  });
}

// ORGANIZATION_LIMITS: keyed on req.appContext.organizationId — resolved
// server-side by requireMembership from the caller's real Membership
// record, never the request body. See MULTITENANT_SAFETY /
// TENANT_TRUST_BOUNDARY tests.
export function organizationScopedLimiter(endpoint: string, cfg: RateLimitWindow) {
  return scopedRateLimit({
    storeId: `org:${endpoint}`,
    cfg,
    scope: "organization",
    endpoint,
    keyOf: (req) => (req.appContext ? `org:${req.appContext.organizationId}` : null),
  });
}

// GLOBAL_LIMITS: a single shared bucket per endpoint, independent of
// who's calling — a circuit-breaker-like safety ceiling (NOT a circuit
// breaker: it never trips based on provider health, only request volume),
// see GLOBAL_SAFETY_CAP in the Fase 8 report.
export function globalScopedLimiter(endpoint: string, cfg: RateLimitWindow) {
  return scopedRateLimit({
    storeId: `global:${endpoint}`,
    cfg,
    scope: "global",
    endpoint,
    keyOf: () => "global",
  });
}

// PASS_WITH_FIXES P1.1 — pre-auth IP safety cap. Replaces the old
// express-rate-limit `limiter` in routes.ts: same PURPOSE (a basic
// defense for routes where no uid/organization exists yet — see
// AUTH_ROUTES/PRE-AUTH_LIMITING in the Fase 8 report), but now built on
// the same primitive as the tenant-aware limiters, so a rejection gets
// the SAME structured rate_limit_rejected logging instead of
// express-rate-limit's own response shape. Deliberately generous (see
// config.rateLimits.ipSafetyCap's default and comment) — this must be a
// safety ceiling, never the layer that actually enforces per-tenant
// fairness; the user/organization limiters do that job. `storeId` is
// overridable (tests only) since production mounts exactly ONE instance
// of this at the router root, but tests need fresh, isolated instances.
export function ipScopedLimiter(cfg: RateLimitWindow, storeId = "ip:global") {
  return scopedRateLimit({
    storeId,
    cfg,
    scope: "ip",
    endpoint: (req) => req.path,
    keyOf: (req) => (req.ip ? `ip:${req.ip}` : null),
  });
}

// Test-only: the module-level `stores` Map persists for the lifetime of
// the process (by design — that's what makes the limiter work across
// requests), which means it ALSO persists across every `it()` block in a
// test file that imports routes.ts once. Without this, one test's
// requests would count against a later, unrelated test's bucket. Not used
// by production code.
//
// Clears each inner bucket Map IN PLACE rather than `stores.clear()`ing
// the outer registry — a middleware built by scopedRateLimit() closes
// over the specific inner Map instance at creation time (see
// `bucketsByKey` above), so replacing the outer registry's entries would
// leave every already-built middleware still reading its OLD, unreset
// Map. `.clear()` on each inner Map mutates the object those closures
// already hold, which is what actually resets them.
export function resetRateLimitStoresForTests(): void {
  for (const store of stores.values()) {
    store.clear();
  }
}
