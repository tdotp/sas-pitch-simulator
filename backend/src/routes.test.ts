// Integration tests for the auth/membership/RBAC gate on sensitive routes,
// and for tenant isolation + session ownership (Phase 3). External
// providers (ElevenLabs, OpenRouter/evaluator, Firestore) and
// firebase-admin's token verification are mocked so these tests run
// without real credentials or network access.
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

// This file's route coverage now sends well over 20 requests through the
// SAME router (and therefore the same rate-limiter instance/store) — the
// module-level 20-req/min limiter in routes.ts isn't what these tests are
// about, so it's neutralized here to avoid spurious 429s unrelated to
// auth/RBAC/tenant-isolation behavior.
vi.mock("express-rate-limit", () => ({
  default: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

const verifyIdTokenMock = vi.fn();

vi.mock("firebase-admin", () => ({
  default: {
    auth: () => ({ verifyIdToken: verifyIdTokenMock }),
  },
}));

vi.mock("./config.js", () => ({
  config: {
    apiSharedToken: "", // shared-token gate disabled for these tests
  },
  assertElevenReady: () => null,
  assertOpenRouterReady: () => null,
}));

vi.mock("./services/elevenlabs.js", () => ({
  getSignedUrl: vi.fn(async () => ({
    agent_id: "agent-1",
    signed_url: "wss://example.test/signed",
    voice_id: "voice-1",
    voice_gender: "male" as const,
    overrides: {},
  })),
}));

const evaluatePitchMock = vi.fn(async () => ({
  session_id: "evaluated",
  target_mode: "generic",
  overall_score: 5,
}));
class EvaluationErrorMock extends Error {
  transient: boolean;
  category: string;
  constructor(message: string, transient: boolean, category: string) {
    super(message);
    this.name = "EvaluationError";
    this.transient = transient;
    this.category = category;
  }
}

vi.mock("./services/evaluator.js", () => ({
  evaluatePitch: (...args: unknown[]) => evaluatePitchMock(...args),
  EvaluationError: EvaluationErrorMock,
}));

vi.mock("./firebase.js", () => ({
  isAuthReady: vi.fn(() => true),
}));

// Phase 4: a small, purpose-built in-memory fake of the session lifecycle
// repository. Its state-machine LOGIC (claim/concurrency/idempotency) is
// verified thoroughly against the real repository in
// repositories/sessions.test.ts — this fake exists so routes.test.ts can
// test /session/end's ORCHESTRATION (which repository calls happen, in
// what order, mapped to which HTTP status) with full control over each
// outcome, including injecting a persistence failure on demand.
const sessionsStore = new Map<string, Record<string, unknown>>();
let persistCompletedResultShouldFail = false;
// When true alongside persistCompletedResultShouldFail, simulates the
// "ambiguous ack" case: the Firestore write actually lands (status
// becomes completed) before persistCompletedResult still throws.
let persistCompletedResultSecretlySucceeds = false;

vi.mock("./repositories/sessions.js", () => ({
  createSession: vi.fn(async (session: Record<string, unknown>) => {
    sessionsStore.set(session.session_id as string, { ...session, updated_at: new Date().toISOString() });
  }),
  claimSessionForEvaluation: vi.fn(
    async (params: { sessionId: string; ownerUid: string; organizationId: string }) => {
      const session = sessionsStore.get(params.sessionId);
      if (!session || session.owner_uid !== params.ownerUid || session.organization_id !== params.organizationId) {
        return { outcome: "not_found" as const };
      }
      if (session.status === "completed") return { outcome: "already_completed" as const, session };
      if (session.status === "evaluating") return { outcome: "in_progress_elsewhere" as const };
      if (
        session.status === "in_progress" ||
        session.status === "evaluation_failed" ||
        session.status === "persistence_failed"
      ) {
        const claimed = { ...session, status: "evaluating" as const };
        sessionsStore.set(params.sessionId, claimed);
        return { outcome: "claimed" as const, session: claimed };
      }
      return { outcome: "wrong_state" as const, status: session.status };
    }
  ),
  // Guarded exactly like the real repository (PASS_WITH_FIXES round):
  // only applies from "evaluating"; any other current status is
  // preserved and reported back via currentStatus, never overwritten.
  markEvaluationFailed: vi.fn(async (sessionId: string, reason: string) => {
    const s = sessionsStore.get(sessionId);
    if (!s) return { applied: false, currentStatus: null };
    if (s.status !== "evaluating") return { applied: false, currentStatus: s.status };
    sessionsStore.set(sessionId, { ...s, status: "evaluation_failed", failure_reason: reason });
    return { applied: true };
  }),
  markPersistenceFailed: vi.fn(async (sessionId: string, reason: string) => {
    const s = sessionsStore.get(sessionId);
    if (!s) return { applied: false, currentStatus: null };
    if (s.status !== "evaluating") return { applied: false, currentStatus: s.status };
    sessionsStore.set(sessionId, { ...s, status: "persistence_failed", failure_reason: reason });
    return { applied: true };
  }),
  persistCompletedResult: vi.fn(
    async (
      sessionId: string,
      params: { duration_seconds: number; transcript: unknown; metrics: unknown; evaluation: unknown }
    ) => {
      const s = sessionsStore.get(sessionId);
      if (persistCompletedResultShouldFail) {
        if (persistCompletedResultSecretlySucceeds && s) {
          // Simulates the "ambiguous ack" case: the write actually lands
          // before the throw.
          sessionsStore.set(sessionId, {
            ...s,
            status: "completed",
            duration_seconds: params.duration_seconds,
            metrics: params.metrics,
            evaluation: params.evaluation,
            transcript: { full: "...", user_only: "...", agent_only: "..." },
            ended_at: new Date().toISOString(),
          });
        }
        throw new Error("simulated Firestore write failure");
      }
      if (!s) return { applied: false, currentStatus: null };
      if (s.status !== "evaluating") return { applied: false, currentStatus: s.status };
      sessionsStore.set(sessionId, {
        ...s,
        status: "completed",
        duration_seconds: params.duration_seconds,
        metrics: params.metrics,
        evaluation: params.evaluation,
        transcript: { full: "...", user_only: "...", agent_only: "..." },
        ended_at: new Date().toISOString(),
      });
      return { applied: true };
    }
  ),
  getSessionById: vi.fn(async (sessionId: string) => sessionsStore.get(sessionId) ?? null),
  listSessionsByOrganization: vi.fn(async (organizationId: string) =>
    [...sessionsStore.values()].filter((s) => s.organization_id === organizationId)
  ),
}));

// Phase 2: GET /me (and, from Phase 3, every other Membership-gated route)
// resolves its context through requireMembership -> resolveAppContext ->
// these repositories. Mocked so these tests never touch real Firestore;
// each test controls exactly what "exists". Defaults (an active user, and
// every organization active) mean a test only has to override what it
// actually cares about.
const listMembershipsByUserMock = vi.fn();
vi.mock("./repositories/memberships.js", () => ({
  listMembershipsByUser: (userId: string) => listMembershipsByUserMock(userId),
}));

const getUserMock = vi.fn();
vi.mock("./repositories/users.js", () => ({
  getUser: (uid: string) => getUserMock(uid),
}));

const getOrganizationMock = vi.fn();
vi.mock("./repositories/organizations.js", () => ({
  getOrganization: (id: string) => getOrganizationMock(id),
}));

const { router } = await import("./routes.js");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api", router);
  return app;
}

beforeEach(() => {
  verifyIdTokenMock.mockReset();
  listMembershipsByUserMock.mockReset();
  getUserMock.mockReset();
  getOrganizationMock.mockReset();
  sessionsStore.clear();
  persistCompletedResultShouldFail = false;
  persistCompletedResultSecretlySucceeds = false;
  evaluatePitchMock.mockReset();
  evaluatePitchMock.mockResolvedValue({
    session_id: "evaluated",
    target_mode: "generic",
    overall_score: 5,
  });
  // Sane defaults: an active AppUser, and any organization looked up
  // comes back active. Individual tests override these to exercise the
  // inactive-user/inactive-org paths.
  getUserMock.mockResolvedValue({
    uid: "uid-1",
    email: "user@test.com",
    display_name: null,
    status: "active",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  });
  getOrganizationMock.mockImplementation(async (id: string) => ({
    id,
    name: id,
    slug: id,
    status: "active",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  }));
});

function membership(overrides: Record<string, unknown> = {}) {
  return {
    id: "m1",
    user_id: "uid-1",
    organization_id: "org-1",
    role: "SPOKESPERSON",
    status: "active",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

// Auths as `uid` with a single active membership in `organizationId` with
// `role`. Covers the common case used by most tests below.
function asSingleOrgUser(
  uid: string,
  organizationId: string,
  role: string,
  email = `${uid}@test.com`
) {
  verifyIdTokenMock.mockResolvedValue({ uid, email });
  getUserMock.mockResolvedValue({
    uid,
    email,
    display_name: null,
    status: "active",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  });
  listMembershipsByUserMock.mockResolvedValue([
    membership({ user_id: uid, organization_id: organizationId, role }),
  ]);
}

describe("sensitive routes require a valid, allowlisted token", () => {
  it("POST /session/start -> 401 without Authorization header", async () => {
    const res = await request(buildApp())
      .post("/api/session/start")
      .send({ target_mode: "generic" });
    expect(res.status).toBe(401);
  });

  it("POST /session/start -> 401 with an invalid token", async () => {
    verifyIdTokenMock.mockRejectedValue(new Error("bad token"));
    const res = await request(buildApp())
      .post("/api/session/start")
      .set("Authorization", "Bearer bad")
      .send({ target_mode: "generic" });
    expect(res.status).toBe(401);
  });

  it("POST /session/start -> 403 with a valid token but no Membership (allowlist retired, Membership enforces this now)", async () => {
    verifyIdTokenMock.mockResolvedValue({ uid: "uid-x", email: "stranger@test.com" });
    getUserMock.mockResolvedValue(null); // no AppUser record either
    listMembershipsByUserMock.mockResolvedValue([]);
    const res = await request(buildApp())
      .post("/api/session/start")
      .set("Authorization", "Bearer good")
      .send({ target_mode: "generic" });
    expect(res.status).toBe(403);
  });

  it("POST /session/start -> 200 with a valid token and an active Membership", async () => {
    asSingleOrgUser("uid-1", "org-1", "SPOKESPERSON");
    const res = await request(buildApp())
      .post("/api/session/start")
      .set("Authorization", "Bearer good")
      .send({ target_mode: "generic" });
    expect(res.status).toBe(200);
    expect(res.body.session_id).toBeTruthy();
  });

  it("GET /admin/sessions -> 401 without a token", async () => {
    const res = await request(buildApp()).get("/api/admin/sessions");
    expect(res.status).toBe(401);
  });
});

describe("Phase 3: session tenant ownership", () => {
  it("persists organization_id from req.appContext, never from the body", async () => {
    asSingleOrgUser("uid-1", "org-real", "SPOKESPERSON");
    const startRes = await request(buildApp())
      .post("/api/session/start")
      .set("Authorization", "Bearer t1")
      .send({ target_mode: "generic", organization_id: "org-attacker-supplied" });

    expect(startRes.status).toBe(200);
    const sessionId = startRes.body.session_id as string;
    expect(sessionsStore.get(sessionId)?.organization_id).toBe("org-real");
  });

  it("ignores a client-supplied user_id and rejects /session/end from a different uid", async () => {
    const app = buildApp();

    // Started by the real, token-verified uid "owner-uid" — the body tries
    // to claim a different identity ("spoofed-uid"), which must be ignored.
    asSingleOrgUser("owner-uid", "org-1", "SPOKESPERSON");
    const startRes = await request(app)
      .post("/api/session/start")
      .set("Authorization", "Bearer t1")
      .send({ target_mode: "generic", user_id: "spoofed-uid", user_name: "Spoofed Name" });
    expect(startRes.status).toBe(200);
    const sessionId = startRes.body.session_id as string;

    // Ending the same session as the uid that was spoofed in the body
    // (not the real starter) must be rejected. If the server had trusted
    // body.user_id as the owner, this would incorrectly succeed.
    asSingleOrgUser("spoofed-uid", "org-1", "SPOKESPERSON");
    const endRes = await request(app)
      .post("/api/session/end")
      .set("Authorization", "Bearer t2")
      .send({
        session_id: sessionId,
        duration_seconds: 42,
        transcript: [{ role: "user", text: "hola" }],
      });
    expect(endRes.status).toBe(404); // uniform not-found, see routes.ts
  });

  it("allows /session/end from the real starter uid", async () => {
    const app = buildApp();

    asSingleOrgUser("owner-uid", "org-1", "SPOKESPERSON");
    const startRes = await request(app)
      .post("/api/session/start")
      .set("Authorization", "Bearer t1")
      .send({ target_mode: "generic" });
    const sessionId = startRes.body.session_id as string;

    asSingleOrgUser("owner-uid", "org-1", "SPOKESPERSON");
    const endRes = await request(app)
      .post("/api/session/end")
      .set("Authorization", "Bearer t2")
      .send({
        session_id: sessionId,
        duration_seconds: 42,
        transcript: [{ role: "user", text: "hola" }],
      });
    expect(endRes.status).toBe(200);
  });

  it("/session/end for an unknown session_id -> 404 (never distinguishes from 'not yours')", async () => {
    asSingleOrgUser("uid-1", "org-1", "SPOKESPERSON");
    const res = await request(buildApp())
      .post("/api/session/end")
      .set("Authorization", "Bearer t1")
      .send({
        session_id: "does-not-exist",
        duration_seconds: 10,
        transcript: [{ role: "user", text: "hola" }],
      });
    expect(res.status).toBe(404);
  });

  it("/session/end without session_id -> 400", async () => {
    asSingleOrgUser("uid-1", "org-1", "SPOKESPERSON");
    const res = await request(buildApp())
      .post("/api/session/end")
      .set("Authorization", "Bearer t1")
      .send({ duration_seconds: 10, transcript: [{ role: "user", text: "hola" }] });
    expect(res.status).toBe(400);
  });

  it("CLIENT_ADMIN cannot end a SPOKESPERSON's session just by knowing its id (no ownership bypass by role)", async () => {
    const app = buildApp();

    asSingleOrgUser("spokesperson-uid", "org-1", "SPOKESPERSON");
    const startRes = await request(app)
      .post("/api/session/start")
      .set("Authorization", "Bearer t1")
      .send({ target_mode: "generic" });
    const sessionId = startRes.body.session_id as string;

    asSingleOrgUser("admin-uid", "org-1", "CLIENT_ADMIN");
    const endRes = await request(app)
      .post("/api/session/end")
      .set("Authorization", "Bearer t2")
      .send({
        session_id: sessionId,
        duration_seconds: 10,
        transcript: [{ role: "user", text: "hola" }],
      });
    expect(endRes.status).toBe(404);
  });

  it("same uid with Membership in A and B: a session started under context A cannot be ended under context B (404)", async () => {
    const app = buildApp();

    // Started under context A.
    verifyIdTokenMock.mockResolvedValue({ uid: "multi-org-uid", email: "multi@test.com" });
    listMembershipsByUserMock.mockResolvedValue([
      membership({ id: "m-a", user_id: "multi-org-uid", organization_id: "org-a", role: "AGENCY_ADMIN" }),
      membership({ id: "m-b", user_id: "multi-org-uid", organization_id: "org-b", role: "AGENCY_ADMIN" }),
    ]);
    const startRes = await request(app)
      .post("/api/session/start?organization_id=org-a")
      .set("Authorization", "Bearer t1")
      .send({ target_mode: "generic" });
    expect(startRes.status).toBe(200);
    const sessionId = startRes.body.session_id as string;
    expect(sessionsStore.get(sessionId)?.organization_id).toBe("org-a");

    // Same uid, same real ownership — but this request's authorized
    // context is B, not the session's actual organization (A). The uid
    // check alone would pass; the organization check must still reject.
    const endRes = await request(app)
      .post("/api/session/end?organization_id=org-b")
      .set("Authorization", "Bearer t2")
      .send({
        session_id: sessionId,
        duration_seconds: 10,
        transcript: [{ role: "user", text: "hola" }],
      });
    expect(endRes.status).toBe(404);
  });

  it("same uid with Membership in A and B: ending the same session under its real context A succeeds (200)", async () => {
    const app = buildApp();

    verifyIdTokenMock.mockResolvedValue({ uid: "multi-org-uid", email: "multi@test.com" });
    listMembershipsByUserMock.mockResolvedValue([
      membership({ id: "m-a", user_id: "multi-org-uid", organization_id: "org-a", role: "AGENCY_ADMIN" }),
      membership({ id: "m-b", user_id: "multi-org-uid", organization_id: "org-b", role: "AGENCY_ADMIN" }),
    ]);
    const startRes = await request(app)
      .post("/api/session/start?organization_id=org-a")
      .set("Authorization", "Bearer t1")
      .send({ target_mode: "generic" });
    const sessionId = startRes.body.session_id as string;

    const endRes = await request(app)
      .post("/api/session/end?organization_id=org-a")
      .set("Authorization", "Bearer t2")
      .send({
        session_id: sessionId,
        duration_seconds: 10,
        transcript: [{ role: "user", text: "hola" }],
      });
    expect(endRes.status).toBe(200);
  });
});

describe("Phase 4: session lifecycle", () => {
  it("/session/start creates the session in the correct initial state", async () => {
    asSingleOrgUser("uid-1", "org-1", "SPOKESPERSON");
    const res = await request(buildApp())
      .post("/api/session/start")
      .set("Authorization", "Bearer t1")
      .send({ target_mode: "generic" });

    expect(res.status).toBe(200);
    const stored = sessionsStore.get(res.body.session_id);
    expect(stored?.status).toBe("in_progress");
    expect(stored?.organization_id).toBe("org-1");
    expect(stored?.owner_uid).toBe("uid-1");
  });

  it("/session/end takes a session from in_progress -> evaluating -> completed, with transcript+metrics+evaluation persisted", async () => {
    const app = buildApp();
    asSingleOrgUser("uid-1", "org-1", "SPOKESPERSON");
    const startRes = await request(app)
      .post("/api/session/start")
      .set("Authorization", "Bearer t1")
      .send({ target_mode: "generic" });
    const sessionId = startRes.body.session_id as string;
    expect(sessionsStore.get(sessionId)?.status).toBe("in_progress");

    const endRes = await request(app)
      .post("/api/session/end")
      .set("Authorization", "Bearer t1")
      .send({
        session_id: sessionId,
        duration_seconds: 42,
        transcript: [{ role: "user", text: "hola" }],
      });

    expect(endRes.status).toBe(200);
    const stored = sessionsStore.get(sessionId);
    expect(stored?.status).toBe("completed");
    expect(stored?.metrics).toBeTruthy();
    expect(stored?.evaluation).toBeTruthy();
    expect(stored?.transcript).toBeTruthy();
  });

  it("two concurrent /session/end calls for the same session: only one evaluation runs", async () => {
    const app = buildApp();
    asSingleOrgUser("uid-1", "org-1", "SPOKESPERSON");
    const startRes = await request(app)
      .post("/api/session/start")
      .set("Authorization", "Bearer t1")
      .send({ target_mode: "generic" });
    const sessionId = startRes.body.session_id as string;

    // The evaluator normally resolves near-instantly when mocked, which
    // leaves no real window for a second request to arrive while the
    // first is still "evaluating" — a genuinely concurrent HTTP race
    // needs a small artificial delay here to be reliably exercised at
    // all (without it, request A can fully finish — claim, evaluate,
    // persist, respond — before request B's handler even starts, and
    // B would hit the idempotent "already_completed" path instead of the
    // concurrency guard this test is actually about).
    evaluatePitchMock.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return { session_id: "evaluated", target_mode: "generic", overall_score: 5 };
    });

    const body = {
      session_id: sessionId,
      duration_seconds: 10,
      transcript: [{ role: "user", text: "hola" }],
    };
    const [res1, res2] = await Promise.all([
      request(app).post("/api/session/end").set("Authorization", "Bearer t1").send(body),
      request(app).post("/api/session/end").set("Authorization", "Bearer t1").send(body),
    ]);

    const statuses = [res1.status, res2.status].sort();
    // One succeeds (200); the other sees it already claimed (409). Either
    // order is fine — which request "wins" the race is not deterministic.
    expect(statuses).toEqual([200, 409]);
    expect(evaluatePitchMock).toHaveBeenCalledTimes(1);
  });

  it("/session/end repeated after completed does NOT re-evaluate — returns the persisted result", async () => {
    const app = buildApp();
    asSingleOrgUser("uid-1", "org-1", "SPOKESPERSON");
    const startRes = await request(app)
      .post("/api/session/start")
      .set("Authorization", "Bearer t1")
      .send({ target_mode: "generic" });
    const sessionId = startRes.body.session_id as string;
    const body = {
      session_id: sessionId,
      duration_seconds: 10,
      transcript: [{ role: "user", text: "hola" }],
    };

    const first = await request(app).post("/api/session/end").set("Authorization", "Bearer t1").send(body);
    expect(first.status).toBe(200);
    expect(evaluatePitchMock).toHaveBeenCalledTimes(1);

    const second = await request(app).post("/api/session/end").set("Authorization", "Bearer t1").send(body);
    expect(second.status).toBe(200);
    expect(second.body.evaluation).toEqual(first.body.evaluation);
    expect(second.body.metrics).toEqual(first.body.metrics);
    // The key assertion: no second call to the evaluator.
    expect(evaluatePitchMock).toHaveBeenCalledTimes(1);
  });

  it("OpenRouter/evaluator failure leaves the session evaluation_failed, not silently in_progress", async () => {
    const app = buildApp();
    asSingleOrgUser("uid-1", "org-1", "SPOKESPERSON");
    const startRes = await request(app)
      .post("/api/session/start")
      .set("Authorization", "Bearer t1")
      .send({ target_mode: "generic" });
    const sessionId = startRes.body.session_id as string;

    evaluatePitchMock.mockRejectedValueOnce(new Error("OpenRouter evaluation failed (503): down"));
    const endRes = await request(app)
      .post("/api/session/end")
      .set("Authorization", "Bearer t1")
      .send({ session_id: sessionId, duration_seconds: 10, transcript: [{ role: "user", text: "hola" }] });

    expect(endRes.status).toBe(502);
    const stored = sessionsStore.get(sessionId);
    expect(stored?.status).toBe("evaluation_failed");
    expect(stored?.status).not.toBe("in_progress");
  });

  it("a persistence failure after a successful evaluation is never reported as completed", async () => {
    const app = buildApp();
    asSingleOrgUser("uid-1", "org-1", "SPOKESPERSON");
    const startRes = await request(app)
      .post("/api/session/start")
      .set("Authorization", "Bearer t1")
      .send({ target_mode: "generic" });
    const sessionId = startRes.body.session_id as string;

    persistCompletedResultShouldFail = true;
    const endRes = await request(app)
      .post("/api/session/end")
      .set("Authorization", "Bearer t1")
      .send({ session_id: sessionId, duration_seconds: 10, transcript: [{ role: "user", text: "hola" }] });

    expect(endRes.status).toBe(503);
    expect(endRes.body).not.toHaveProperty("evaluation");
    const stored = sessionsStore.get(sessionId);
    expect(stored?.status).toBe("persistence_failed");
    expect(stored?.status).not.toBe("completed");
  });

  it("PASS_WITH_FIXES: an ambiguous persistence ack (write actually succeeded) recovers and returns the real persisted result instead of a false failure", async () => {
    const app = buildApp();
    asSingleOrgUser("uid-1", "org-1", "SPOKESPERSON");
    const startRes = await request(app)
      .post("/api/session/start")
      .set("Authorization", "Bearer t1")
      .send({ target_mode: "generic" });
    const sessionId = startRes.body.session_id as string;

    // persistCompletedResult's write actually lands (status -> completed)
    // but the call still throws (e.g. the ack was lost to a network
    // blip). markPersistenceFailed's guard must refuse to downgrade
    // completed -> persistence_failed, and routes.ts must recover and
    // return the real result instead of reporting a false failure.
    persistCompletedResultShouldFail = true;
    persistCompletedResultSecretlySucceeds = true;

    const endRes = await request(app)
      .post("/api/session/end")
      .set("Authorization", "Bearer t1")
      .send({ session_id: sessionId, duration_seconds: 10, transcript: [{ role: "user", text: "hola" }] });

    expect(endRes.status).toBe(200);
    expect(endRes.body.evaluation).toBeTruthy();
    const stored = sessionsStore.get(sessionId);
    expect(stored?.status).toBe("completed");
  });

  it("an invalid transition (claiming an abandoned session) is rejected with 409", async () => {
    const app = buildApp();
    asSingleOrgUser("uid-1", "org-1", "SPOKESPERSON");
    const startRes = await request(app)
      .post("/api/session/start")
      .set("Authorization", "Bearer t1")
      .send({ target_mode: "generic" });
    const sessionId = startRes.body.session_id as string;

    // Simulate the abandonment sweep having marked it.
    const s = sessionsStore.get(sessionId)!;
    sessionsStore.set(sessionId, { ...s, status: "abandoned" });

    const endRes = await request(app)
      .post("/api/session/end")
      .set("Authorization", "Bearer t1")
      .send({ session_id: sessionId, duration_seconds: 10, transcript: [{ role: "user", text: "hola" }] });

    expect(endRes.status).toBe(409);
    // Abandoned cannot be completed through the normal flow.
    expect(sessionsStore.get(sessionId)?.status).toBe("abandoned");
  });

  it("fails closed (503) when the repository throws during the claim transition", async () => {
    const app = buildApp();
    asSingleOrgUser("uid-1", "org-1", "SPOKESPERSON");
    const startRes = await request(app)
      .post("/api/session/start")
      .set("Authorization", "Bearer t1")
      .send({ target_mode: "generic" });
    const sessionId = startRes.body.session_id as string;

    const { claimSessionForEvaluation } = await import("./repositories/sessions.js");
    (claimSessionForEvaluation as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("Firestore transaction failed")
    );

    const endRes = await request(app)
      .post("/api/session/end")
      .set("Authorization", "Bearer t1")
      .send({ session_id: sessionId, duration_seconds: 10, transcript: [{ role: "user", text: "hola" }] });

    expect(endRes.status).toBe(503);
  });
});

describe("Phase 3: GET /admin/sessions — RBAC + tenant scoping", () => {
  it("SPOKESPERSON -> 403", async () => {
    asSingleOrgUser("uid-1", "org-1", "SPOKESPERSON");
    const res = await request(buildApp())
      .get("/api/admin/sessions")
      .set("Authorization", "Bearer t1");
    expect(res.status).toBe(403);
  });

  it("CLIENT_ADMIN lists only sessions from their own organization", async () => {
    sessionsStore.set("s-a", { session_id: "s-a", organization_id: "org-a" });
    sessionsStore.set("s-b", { session_id: "s-b", organization_id: "org-b" });

    asSingleOrgUser("admin-a", "org-a", "CLIENT_ADMIN");
    const res = await request(buildApp())
      .get("/api/admin/sessions")
      .set("Authorization", "Bearer t1");

    expect(res.status).toBe(200);
    expect(res.body.organization_id).toBe("org-a");
    expect(res.body.sessions).toEqual([{ session_id: "s-a", organization_id: "org-a" }]);
  });

  it("COACH can read their organization's sessions (V1 policy: org-scoped, not per-assignment)", async () => {
    sessionsStore.set("s-a", { session_id: "s-a", organization_id: "org-a" });
    asSingleOrgUser("coach-a", "org-a", "COACH");
    const res = await request(buildApp())
      .get("/api/admin/sessions")
      .set("Authorization", "Bearer t1");
    expect(res.status).toBe(200);
    expect(res.body.sessions).toHaveLength(1);
  });

  it("AGENCY_ADMIN with Membership in A and B can query both, one at a time", async () => {
    sessionsStore.set("s-a", { session_id: "s-a", organization_id: "org-a" });
    sessionsStore.set("s-b", { session_id: "s-b", organization_id: "org-b" });

    verifyIdTokenMock.mockResolvedValue({ uid: "agency-uid", email: "agency@test.com" });
    listMembershipsByUserMock.mockResolvedValue([
      membership({ id: "m-a", user_id: "agency-uid", organization_id: "org-a", role: "AGENCY_ADMIN" }),
      membership({ id: "m-b", user_id: "agency-uid", organization_id: "org-b", role: "AGENCY_ADMIN" }),
    ]);

    const app = buildApp();
    const resA = await request(app)
      .get("/api/admin/sessions?organization_id=org-a")
      .set("Authorization", "Bearer t1");
    expect(resA.status).toBe(200);
    expect(resA.body.sessions).toEqual([{ session_id: "s-a", organization_id: "org-a" }]);

    const resB = await request(app)
      .get("/api/admin/sessions?organization_id=org-b")
      .set("Authorization", "Bearer t1");
    expect(resB.status).toBe(200);
    expect(resB.body.sessions).toEqual([{ session_id: "s-b", organization_id: "org-b" }]);
  });

  it("AGENCY_ADMIN with Membership in A and B, no ?organization_id -> 409 (never assumes 'all organizations')", async () => {
    verifyIdTokenMock.mockResolvedValue({ uid: "agency-uid", email: "agency@test.com" });
    listMembershipsByUserMock.mockResolvedValue([
      membership({ id: "m-a", user_id: "agency-uid", organization_id: "org-a", role: "AGENCY_ADMIN" }),
      membership({ id: "m-b", user_id: "agency-uid", organization_id: "org-b", role: "AGENCY_ADMIN" }),
    ]);

    const res = await request(buildApp())
      .get("/api/admin/sessions")
      .set("Authorization", "Bearer t1");
    expect(res.status).toBe(409);
  });

  it("AGENCY_ADMIN WITHOUT Membership in C cannot query org C", async () => {
    verifyIdTokenMock.mockResolvedValue({ uid: "agency-uid", email: "agency@test.com" });
    listMembershipsByUserMock.mockResolvedValue([
      membership({ id: "m-a", user_id: "agency-uid", organization_id: "org-a", role: "AGENCY_ADMIN" }),
    ]);

    const res = await request(buildApp())
      .get("/api/admin/sessions?organization_id=org-c")
      .set("Authorization", "Bearer t1");
    expect(res.status).toBe(403);
  });

  it("a user sending organization_id for an org they don't belong to is rejected, never elevated", async () => {
    asSingleOrgUser("uid-1", "org-a", "CLIENT_ADMIN");
    const res = await request(buildApp())
      .get("/api/admin/sessions?organization_id=org-b")
      .set("Authorization", "Bearer t1");
    expect(res.status).toBe(403);
  });

  it("Membership inactive -> no access to /admin/sessions", async () => {
    verifyIdTokenMock.mockResolvedValue({ uid: "uid-1", email: "user@test.com" });
    listMembershipsByUserMock.mockResolvedValue([
      membership({ organization_id: "org-1", role: "CLIENT_ADMIN", status: "inactive" }),
    ]);
    const res = await request(buildApp())
      .get("/api/admin/sessions")
      .set("Authorization", "Bearer t1");
    expect(res.status).toBe(403);
  });

  it("Organization inactive -> no access to /admin/sessions", async () => {
    verifyIdTokenMock.mockResolvedValue({ uid: "uid-1", email: "user@test.com" });
    listMembershipsByUserMock.mockResolvedValue([
      membership({ organization_id: "org-deactivated", role: "CLIENT_ADMIN" }),
    ]);
    getOrganizationMock.mockResolvedValue({
      id: "org-deactivated",
      name: "x",
      slug: "org-deactivated",
      status: "inactive",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    });
    const res = await request(buildApp())
      .get("/api/admin/sessions")
      .set("Authorization", "Bearer t1");
    expect(res.status).toBe(403);
  });

  it("AppUser inactive -> no access to /admin/sessions", async () => {
    verifyIdTokenMock.mockResolvedValue({ uid: "uid-1", email: "user@test.com" });
    getUserMock.mockResolvedValue({
      uid: "uid-1",
      email: "user@test.com",
      display_name: null,
      status: "inactive",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    });
    listMembershipsByUserMock.mockResolvedValue([membership({ organization_id: "org-1", role: "CLIENT_ADMIN" })]);
    const res = await request(buildApp())
      .get("/api/admin/sessions")
      .set("Authorization", "Bearer t1");
    expect(res.status).toBe(403);
  });
});

describe("POST /metrics/analyze — requires Membership", () => {
  it("401s without a token", async () => {
    const res = await request(buildApp())
      .post("/api/metrics/analyze")
      .send({ transcript: [] });
    expect(res.status).toBe(401);
  });

  it("403s a valid token with no Membership", async () => {
    verifyIdTokenMock.mockResolvedValue({ uid: "uid-x", email: "stranger@test.com" });
    listMembershipsByUserMock.mockResolvedValue([]);
    const res = await request(buildApp())
      .post("/api/metrics/analyze")
      .set("Authorization", "Bearer good")
      .send({ transcript: [] });
    expect(res.status).toBe(403);
  });

  it("200s for any role with a valid Membership", async () => {
    asSingleOrgUser("uid-1", "org-1", "SPOKESPERSON");
    const res = await request(buildApp())
      .post("/api/metrics/analyze")
      .set("Authorization", "Bearer good")
      .send({ transcript: [{ role: "user", text: "hola" }], duration_seconds: 5 });
    expect(res.status).toBe(200);
  });
});

describe("GET /me — Phase 2 server-resolved organization/role context", () => {
  it("401s without a token", async () => {
    const res = await request(buildApp()).get("/api/me");
    expect(res.status).toBe(401);
  });

  it("403s a valid token with no active Membership", async () => {
    verifyIdTokenMock.mockResolvedValue({ uid: "uid-1", email: "allowed@test.com" });
    listMembershipsByUserMock.mockResolvedValue([]);

    const res = await request(buildApp())
      .get("/api/me")
      .set("Authorization", "Bearer good");

    expect(res.status).toBe(403);
  });

  it("403s when the only Membership is inactive", async () => {
    verifyIdTokenMock.mockResolvedValue({ uid: "uid-1", email: "allowed@test.com" });
    listMembershipsByUserMock.mockResolvedValue([membership({ status: "inactive" })]);

    const res = await request(buildApp())
      .get("/api/me")
      .set("Authorization", "Bearer good");

    expect(res.status).toBe(403);
  });

  it("200s with the real organization/role for a known user with exactly one eligible Membership", async () => {
    asSingleOrgUser("uid-1", "org-real", "CLIENT_ADMIN", "allowed@test.com");

    const res = await request(buildApp())
      .get("/api/me")
      .set("Authorization", "Bearer good");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      userId: "uid-1",
      email: "allowed@test.com",
      organizationId: "org-real",
      role: "CLIENT_ADMIN",
    });
  });

  it("ignores organization_id/role sent in the request body — the real Firestore values win", async () => {
    asSingleOrgUser("uid-1", "org-real", "SPOKESPERSON", "allowed@test.com");

    // A GET normally carries no body, but nothing stops a client from
    // sending one — prove the handler never reads it for identity/context.
    const res = await request(buildApp())
      .get("/api/me")
      .set("Authorization", "Bearer good")
      .send({ organization_id: "org-attacker-supplied", role: "AGENCY_ADMIN" });

    expect(res.status).toBe(200);
    expect(res.body.organizationId).toBe("org-real");
    expect(res.body.role).toBe("SPOKESPERSON");
  });

  it("with several active memberships and no ?organization_id, does NOT pick one arbitrarily", async () => {
    verifyIdTokenMock.mockResolvedValue({ uid: "uid-1", email: "allowed@test.com" });
    listMembershipsByUserMock.mockResolvedValue([
      membership({ id: "m-a", organization_id: "org-a", role: "COACH" }),
      membership({ id: "m-b", organization_id: "org-b", role: "AGENCY_ADMIN" }),
    ]);

    const res = await request(buildApp())
      .get("/api/me")
      .set("Authorization", "Bearer good");

    expect(res.status).toBe(409);
    expect(new Set(res.body.organization_ids)).toEqual(new Set(["org-a", "org-b"]));
  });

  it("with several active memberships, ?organization_id for one it belongs to resolves that context", async () => {
    verifyIdTokenMock.mockResolvedValue({ uid: "uid-1", email: "allowed@test.com" });
    listMembershipsByUserMock.mockResolvedValue([
      membership({ id: "m-a", organization_id: "org-a", role: "COACH" }),
      membership({ id: "m-b", organization_id: "org-b", role: "AGENCY_ADMIN" }),
    ]);

    const res = await request(buildApp())
      .get("/api/me?organization_id=org-b")
      .set("Authorization", "Bearer good");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      userId: "uid-1",
      email: "allowed@test.com",
      organizationId: "org-b",
      role: "AGENCY_ADMIN",
    });
  });

  it("rejects ?organization_id for an organization the caller does not belong to", async () => {
    verifyIdTokenMock.mockResolvedValue({ uid: "uid-1", email: "allowed@test.com" });
    listMembershipsByUserMock.mockResolvedValue([
      membership({ id: "m-a", organization_id: "org-a", role: "COACH" }),
    ]);

    const res = await request(buildApp())
      .get("/api/me?organization_id=org-attacker-supplied")
      .set("Authorization", "Bearer good");

    expect(res.status).toBe(403);
  });

  it("403s when the AppUser record is inactive, even with an active Membership", async () => {
    verifyIdTokenMock.mockResolvedValue({ uid: "uid-1", email: "allowed@test.com" });
    getUserMock.mockResolvedValue({
      uid: "uid-1",
      email: "allowed@test.com",
      display_name: null,
      status: "inactive",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    });
    listMembershipsByUserMock.mockResolvedValue([membership()]);

    const res = await request(buildApp())
      .get("/api/me")
      .set("Authorization", "Bearer good");

    expect(res.status).toBe(403);
  });

  it("403s when the Membership's Organization is inactive", async () => {
    verifyIdTokenMock.mockResolvedValue({ uid: "uid-1", email: "allowed@test.com" });
    listMembershipsByUserMock.mockResolvedValue([membership({ organization_id: "org-deactivated" })]);
    getOrganizationMock.mockResolvedValue({
      id: "org-deactivated",
      name: "Deactivated",
      slug: "org-deactivated",
      status: "inactive",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    });

    const res = await request(buildApp())
      .get("/api/me")
      .set("Authorization", "Bearer good");

    expect(res.status).toBe(403);
  });

  it("fails closed (503) when the membership repository throws", async () => {
    verifyIdTokenMock.mockResolvedValue({ uid: "uid-1", email: "allowed@test.com" });
    listMembershipsByUserMock.mockRejectedValue(new Error("Firestore is down"));

    const res = await request(buildApp())
      .get("/api/me")
      .set("Authorization", "Bearer good");

    expect(res.status).toBe(503);
  });
});
