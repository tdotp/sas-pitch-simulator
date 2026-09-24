// Fase 8 — RATE_LIMIT_KEY_STRATEGY. Unit tests for the scoped in-memory
// rate limiter primitive (server-side, bounded, testable — never
// IP-only). Each test uses a fresh middleware instance (fresh storeId) so
// buckets never leak between tests.
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

const logEvent = vi.fn();
vi.mock("../observability/log.js", () => ({
  logEvent: (...args: unknown[]) => logEvent(...args),
  elapsedMs: (start: number) => Date.now() - start,
}));

const { scopedRateLimit, userScopedLimiter, organizationScopedLimiter, globalScopedLimiter, ipScopedLimiter } =
  await import("./rateLimit.js");

function fakeReq(overrides: Partial<Request> = {}): Request {
  return {
    path: "/session/start",
    ip: "203.0.113.5",
    auth: { uid: "uid-1", email: null },
    appContext: { userId: "uid-1", email: null, organizationId: "org-1", role: "SPOKESPERSON" },
    id: "req-1",
    ...overrides,
  } as unknown as Request;
}

function fakeRes(): Response {
  const headers: Record<string, string> = {};
  const res = {
    statusCode: 200,
    headers,
    setHeader: (name: string, value: string) => {
      headers[name] = value;
    },
    status: vi.fn(function (this: Response, code: number) {
      (this as unknown as { statusCode: number }).statusCode = code;
      return this;
    }),
    json: vi.fn(),
  };
  return res as unknown as Response;
}

let counter = 0;
function freshStoreId(): string {
  counter += 1;
  return `test-store-${counter}`;
}

beforeEach(() => {
  logEvent.mockClear();
});

describe("scopedRateLimit", () => {
  it("allows requests under the limit", () => {
    const mw = scopedRateLimit({
      storeId: freshStoreId(),
      cfg: { windowMs: 60_000, limit: 2 },
      scope: "user",
      endpoint: "/session/start",
      keyOf: (req) => (req.auth ? `user:${req.auth.uid}` : null),
    });
    const next = vi.fn();
    const res = fakeRes();
    mw(fakeReq(), res, next);
    mw(fakeReq(), res, next);

    expect(next).toHaveBeenCalledTimes(2);
    expect(res.status).not.toHaveBeenCalled();
  });

  it("rejects the request once it exceeds the limit within the window, with HTTP 429", () => {
    const mw = scopedRateLimit({
      storeId: freshStoreId(),
      cfg: { windowMs: 60_000, limit: 1 },
      scope: "user",
      endpoint: "/session/start",
      keyOf: (req) => (req.auth ? `user:${req.auth.uid}` : null),
    });
    const next = vi.fn();
    const res1 = fakeRes();
    const res2 = fakeRes();
    mw(fakeReq(), res1, next);
    mw(fakeReq(), res2, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res2.status).toHaveBeenCalledWith(429);
    expect(res2.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.any(String), retry_after_seconds: expect.any(Number) })
    );
  });

  it("sets a Retry-After header on rejection", () => {
    const mw = scopedRateLimit({
      storeId: freshStoreId(),
      cfg: { windowMs: 30_000, limit: 1 },
      scope: "user",
      endpoint: "/session/start",
      keyOf: (req) => (req.auth ? `user:${req.auth.uid}` : null),
    });
    const next = vi.fn();
    mw(fakeReq(), fakeRes(), next);
    const res2 = fakeRes();
    mw(fakeReq(), res2, next);

    expect((res2 as unknown as { headers: Record<string, string> }).headers["Retry-After"]).toBeDefined();
  });

  it("different keys (different users) get independent buckets", () => {
    const mw = scopedRateLimit({
      storeId: freshStoreId(),
      cfg: { windowMs: 60_000, limit: 1 },
      scope: "user",
      endpoint: "/session/start",
      keyOf: (req) => (req.auth ? `user:${req.auth.uid}` : null),
    });
    const next = vi.fn();
    mw(fakeReq({ auth: { uid: "uid-a", email: null } }), fakeRes(), next);
    const resB = fakeRes();
    mw(fakeReq({ auth: { uid: "uid-b", email: null } }), resB, next);

    expect(next).toHaveBeenCalledTimes(2);
    expect(resB.status).not.toHaveBeenCalled();
  });

  it("resets after the window elapses", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const mw = scopedRateLimit({
      storeId: freshStoreId(),
      cfg: { windowMs: 60_000, limit: 1 },
      scope: "user",
      endpoint: "/session/start",
      keyOf: (req) => (req.auth ? `user:${req.auth.uid}` : null),
    });
    const next = vi.fn();
    mw(fakeReq(), fakeRes(), next);

    vi.setSystemTime(new Date("2026-01-01T00:01:01.000Z")); // > 60s later
    const res2 = fakeRes();
    mw(fakeReq(), res2, next);
    vi.useRealTimers();

    expect(next).toHaveBeenCalledTimes(2);
    expect(res2.status).not.toHaveBeenCalled();
  });

  it("skips (calls next) when keyOf returns null (scope not available yet)", () => {
    const mw = scopedRateLimit({
      storeId: freshStoreId(),
      cfg: { windowMs: 60_000, limit: 1 },
      scope: "organization",
      endpoint: "/session/start",
      keyOf: () => null,
    });
    const next = vi.fn();
    mw(fakeReq(), fakeRes(), next);
    mw(fakeReq(), fakeRes(), next);

    expect(next).toHaveBeenCalledTimes(2);
  });

  it("logs a rate_limit_rejected event with request_id, user_id, organization_id, endpoint and scope", () => {
    const mw = scopedRateLimit({
      storeId: freshStoreId(),
      cfg: { windowMs: 60_000, limit: 1 },
      scope: "user",
      endpoint: "/session/start",
      keyOf: (req) => (req.auth ? `user:${req.auth.uid}` : null),
    });
    const next = vi.fn();
    mw(fakeReq(), fakeRes(), next);
    mw(fakeReq(), fakeRes(), next);

    expect(logEvent).toHaveBeenCalledTimes(1);
    expect(logEvent.mock.calls[0][0]).toMatchObject({
      event: "rate_limit_rejected",
      request_id: "req-1",
      user_id: "uid-1",
      organization_id: "org-1",
      endpoint: "/session/start",
      rate_limit_scope: "user",
      outcome: "failure",
    });
  });

  it("never includes the raw rate_limit_key in the logged event", () => {
    const mw = scopedRateLimit({
      storeId: freshStoreId(),
      cfg: { windowMs: 60_000, limit: 1 },
      scope: "user",
      endpoint: "/session/start",
      keyOf: (req) => (req.auth ? `user:${req.auth.uid}` : null),
    });
    const next = vi.fn();
    mw(fakeReq(), fakeRes(), next);
    mw(fakeReq(), fakeRes(), next);

    expect(logEvent.mock.calls[0][0]).not.toHaveProperty("rate_limit_key");
  });
});

// Fase 8 — TENANT_TRUST_BOUNDARY (mandatory regression test per the
// review's item 26): a body claiming a different organization must NEVER
// influence which bucket a request counts against.
describe("organizationScopedLimiter — tenant trust boundary", () => {
  it("keys on req.appContext.organizationId (server-resolved), never on a spoofed body.organization_id", () => {
    const mw = organizationScopedLimiter(`/session/start#${freshStoreId()}`, { windowMs: 60_000, limit: 1 });
    const next = vi.fn();

    // Real, server-resolved context is org-A. The request body CLAIMS
    // org-B (as if a caller tried to pass organization_id in the body to
    // dodge/attack another tenant's bucket) — that claim must be ignored.
    const reqWithSpoofedBody = {
      ...fakeReq(),
      appContext: { userId: "uid-1", email: null, organizationId: "org-A", role: "SPOKESPERSON" },
      body: { organization_id: "org-B" },
    } as unknown as Request;

    mw(reqWithSpoofedBody, fakeRes(), next);
    const res2 = fakeRes();
    // A second request genuinely FROM org-B (different real context) must
    // NOT be blocked by org-A's bucket — proves org-B's spoofed claim in
    // the first request never actually touched org-B's real bucket.
    mw(
      {
        ...fakeReq(),
        appContext: { userId: "uid-2", email: null, organizationId: "org-B", role: "SPOKESPERSON" },
      } as unknown as Request,
      res2,
      next
    );

    expect(next).toHaveBeenCalledTimes(2);
    expect(res2.status).not.toHaveBeenCalled();
  });
});

describe("userScopedLimiter / globalScopedLimiter — factory wiring", () => {
  it("userScopedLimiter rejects the same user's second request within the window", () => {
    const mw = userScopedLimiter(`/session/end#${freshStoreId()}`, { windowMs: 60_000, limit: 1 });
    const next = vi.fn();
    mw(fakeReq(), fakeRes(), next);
    const res2 = fakeRes();
    mw(fakeReq(), res2, next);
    expect(res2.status).toHaveBeenCalledWith(429);
  });

  it("globalScopedLimiter shares one bucket across different users", () => {
    const mw = globalScopedLimiter(`/session/end#${freshStoreId()}`, { windowMs: 60_000, limit: 1 });
    const next = vi.fn();
    mw(fakeReq({ auth: { uid: "uid-a", email: null } }), fakeRes(), next);
    const res2 = fakeRes();
    mw(fakeReq({ auth: { uid: "uid-b", email: null } }), res2, next);
    expect(res2.status).toHaveBeenCalledWith(429);
  });
});

// PASS_WITH_FIXES P1.1: the pre-auth, IP-scoped safety cap. Unlike
// user/organization/global limiters, this one is a SINGLE middleware
// instance shared across every route (mounted before requireAuth even
// runs), so its `endpoint` for logging purposes must be resolved PER
// REQUEST (req.path), not fixed at creation time like the other
// factories' single-literal `endpoint` argument.
describe("ipScopedLimiter", () => {
  it("keys on req.ip, never on req.auth.uid or req.appContext — works identically pre-auth", () => {
    const storeId = freshStoreId();
    const mw = ipScopedLimiter({ windowMs: 60_000, limit: 1 }, storeId);
    const next = vi.fn();
    // No auth/appContext at all — this limiter must still function
    // (pre-auth is exactly where it's meant to run).
    mw({ path: "/session/start", ip: "203.0.113.5", id: "req-1" } as unknown as Request, fakeRes(), next);
    const res2 = fakeRes();
    mw({ path: "/session/start", ip: "203.0.113.5", id: "req-2" } as unknown as Request, res2, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res2.status).toHaveBeenCalledWith(429);
  });

  it("different source IPs get independent buckets", () => {
    const storeId = freshStoreId();
    const mw = ipScopedLimiter({ windowMs: 60_000, limit: 1 }, storeId);
    const next = vi.fn();
    mw({ path: "/session/start", ip: "203.0.113.5", id: "req-1" } as unknown as Request, fakeRes(), next);
    const res2 = fakeRes();
    mw({ path: "/session/start", ip: "198.51.100.9", id: "req-2" } as unknown as Request, res2, next);

    expect(next).toHaveBeenCalledTimes(2);
    expect(res2.status).not.toHaveBeenCalled();
  });

  it("many DIFFERENT users sharing the SAME IP are not blocked prematurely by a low per-user identity — they share the IP bucket, but each still gets counted fairly against the SAME cap, not a lower one per identity", () => {
    const storeId = freshStoreId();
    const mw = ipScopedLimiter({ windowMs: 60_000, limit: 3 }, storeId);
    const next = vi.fn();
    for (const uid of ["uid-a", "uid-b", "uid-c"]) {
      mw(fakeReq({ ip: "203.0.113.5", auth: { uid, email: null } }), fakeRes(), next);
    }
    expect(next).toHaveBeenCalledTimes(3); // exactly at the cap, none rejected
  });

  it("logs rate_limit_scope: 'ip' on rejection, with the request's actual path as endpoint, and never the raw IP", () => {
    const storeId = freshStoreId();
    const mw = ipScopedLimiter({ windowMs: 60_000, limit: 1 }, storeId);
    const next = vi.fn();
    mw({ path: "/metrics/analyze", ip: "203.0.113.5", id: "req-1" } as unknown as Request, fakeRes(), next);
    mw({ path: "/metrics/analyze", ip: "203.0.113.5", id: "req-2" } as unknown as Request, fakeRes(), next);

    expect(logEvent).toHaveBeenCalledTimes(1);
    const logged = logEvent.mock.calls[0][0];
    expect(logged).toMatchObject({
      event: "rate_limit_rejected",
      request_id: "req-2",
      endpoint: "/metrics/analyze",
      rate_limit_scope: "ip",
      outcome: "failure",
    });
    expect(JSON.stringify(logged)).not.toContain("203.0.113.5");
  });

  it("omits user_id/organization_id when rejecting a genuinely pre-auth request", () => {
    const storeId = freshStoreId();
    const mw = ipScopedLimiter({ windowMs: 60_000, limit: 1 }, storeId);
    const next = vi.fn();
    mw({ path: "/session/start", ip: "203.0.113.5", id: "req-1" } as unknown as Request, fakeRes(), next);
    mw({ path: "/session/start", ip: "203.0.113.5", id: "req-2" } as unknown as Request, fakeRes(), next);

    const logged = logEvent.mock.calls[0][0];
    expect("user_id" in logged).toBe(false);
    expect("organization_id" in logged).toBe(false);
  });
});
