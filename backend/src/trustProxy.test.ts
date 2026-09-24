// Fase 8 PASS_WITH_FIXES (P1) — verifies the REAL Express `trust proxy`
// setting (TRUSTED_PROXY_HOPS) combined with the REAL ipScopedLimiter
// (not mocked — this is exactly the integration the review flagged: a
// missing trust-proxy policy could make ipScopedLimiter's bucket key
// resolve to the reverse proxy's own address for every client). A
// minimal standalone Express app, not the full routes.ts router — the
// router pulls in Firebase/auth/provider mocking that's irrelevant to
// this specific fix; see index.ts for where TRUSTED_PROXY_HOPS is
// actually wired into the real app.
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

vi.mock("./observability/log.js", () => ({
  logEvent: vi.fn(),
  elapsedMs: (start: number) => Date.now() - start,
}));

const { TRUSTED_PROXY_HOPS } = await import("./trustProxy.js");
const { ipScopedLimiter, resetRateLimitStoresForTests } = await import("./middleware/rateLimit.js");

let counter = 0;
function freshStoreId(): string {
  counter += 1;
  return `trust-proxy-test-${counter}`;
}

function buildAppBehindOneProxy(limit: number) {
  const app = express();
  app.set("trust proxy", TRUSTED_PROXY_HOPS);
  app.use(ipScopedLimiter({ windowMs: 60_000, limit }, freshStoreId()));
  app.get("/probe", (_req, res) => res.json({ ok: true }));
  return app;
}

beforeEach(() => {
  resetRateLimitStoresForTests();
});

describe("TRUSTED_PROXY_HOPS", () => {
  it("is exactly 1 — grounded in docker-compose.yml/Caddyfile: exactly one reverse proxy (Caddy) sits in front of the backend", () => {
    expect(TRUSTED_PROXY_HOPS).toBe(1);
  });
});

describe("PASS_WITH_FIXES P1: client IP resolution through the trusted reverse-proxy hop", () => {
  it("two different clients behind the SAME reverse proxy get INDEPENDENT ip buckets", async () => {
    const app = buildAppBehindOneProxy(1);

    const resA = await request(app).get("/probe").set("X-Forwarded-For", "203.0.113.10");
    expect(resA.status).toBe(200);

    const resB = await request(app).get("/probe").set("X-Forwarded-For", "198.51.100.20");
    expect(resB.status).toBe(200); // NOT blocked by client A's bucket
  });

  it("the SAME client hitting its own limit twice is rejected on the second request", async () => {
    const app = buildAppBehindOneProxy(1);

    const res1 = await request(app).get("/probe").set("X-Forwarded-For", "203.0.113.10");
    expect(res1.status).toBe(200);

    const res2 = await request(app).get("/probe").set("X-Forwarded-For", "203.0.113.10");
    expect(res2.status).toBe(429);
  });

  // TRUST_PROXY_SPOOFING: with trust proxy=1, Express reads ONLY the
  // right-most X-Forwarded-For entry (the one the trusted hop itself
  // appended) — verified empirically before writing this test. A caller
  // prepending extra, self-supplied hops to the LEFT must not change
  // which bucket they land in.
  it("TRUST_PROXY_SPOOFING: a caller prepending fake extra hops to X-Forwarded-For cannot escape its own bucket", async () => {
    const app = buildAppBehindOneProxy(1);

    const res1 = await request(app).get("/probe").set("X-Forwarded-For", "203.0.113.10");
    expect(res1.status).toBe(200);

    // Same real client (as the trusted hop would report it), but now
    // prepending an attacker-chosen fake address to try to pick a fresh
    // bucket.
    const res2 = await request(app).get("/probe").set("X-Forwarded-For", "6.6.6.6, 203.0.113.10");
    expect(res2.status).toBe(429); // still counted against the SAME bucket, not a fresh one
  });

  it("TRUST_PROXY_SPOOFING: prepended fake hops cannot be used to IMPERSONATE a different real client's bucket either", async () => {
    const app = buildAppBehindOneProxy(1);

    // Client A exhausts its own (real) bucket.
    await request(app).get("/probe").set("X-Forwarded-For", "203.0.113.10");
    const resExhausted = await request(app).get("/probe").set("X-Forwarded-For", "203.0.113.10");
    expect(resExhausted.status).toBe(429);

    // An attacker whose real (trusted-hop-observed) address is
    // 198.51.100.20 tries to claim they're "behind" client A by
    // prepending A's address — the trusted hop's own appended entry
    // (198.51.100.20, right-most) is what's actually read, so this must
    // resolve to the ATTACKER's own (fresh) bucket, not client A's
    // exhausted one.
    const resAttacker = await request(app).get("/probe").set("X-Forwarded-For", "203.0.113.10, 198.51.100.20");
    expect(resAttacker.status).toBe(200);
  });

  it("falls back to the raw socket address when no X-Forwarded-For is present at all (direct/local connection)", async () => {
    const app = buildAppBehindOneProxy(1);
    const res = await request(app).get("/probe"); // supertest's own loopback connection, no XFF header
    expect(res.status).toBe(200);
  });
});
