// Integration tests for the auth/membership/RBAC gate on sensitive routes,
// and for tenant isolation + session ownership (Phase 3). External
// providers (ElevenLabs, OpenRouter/evaluator, Firestore) and
// firebase-admin's token verification are mocked so these tests run
// without real credentials or network access.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import request from "supertest";

const verifyIdTokenMock = vi.fn();

vi.mock("firebase-admin", () => ({
  default: {
    auth: () => ({ verifyIdToken: verifyIdTokenMock }),
  },
}));

// Fase 8: generous limits by default so the ~280 existing tests (many of
// which reuse uid-1/org-1 across dozens of `it()` blocks against the SAME
// module-level rate limiter buckets — see resetRateLimitStoresForTests)
// never trip a 429 incidentally. Dedicated rate-limit tests below override
// via resetRateLimitStoresForTests + a tighter per-test config where
// needed, or exercise scopedRateLimit directly (rateLimit.test.ts).
vi.mock("./config.js", () => ({
  config: {
    apiSharedToken: "", // shared-token gate disabled for these tests
    rateLimits: {
      sessionStart: {
        user: { windowMs: 60_000, limit: 1000 },
        organization: { windowMs: 60_000, limit: 1000 },
        global: { windowMs: 60_000, limit: 1000 },
      },
      sessionEnd: {
        user: { windowMs: 60_000, limit: 1000 },
        organization: { windowMs: 60_000, limit: 1000 },
        global: { windowMs: 60_000, limit: 1000 },
      },
      metricsAnalyze: {
        user: { windowMs: 60_000, limit: 1000 },
      },
      // PASS_WITH_FIXES P1.1: this now runs on EVERY request through this
      // router (it replaced the old express-rate-limit mock that used to
      // neutralize the module-level 20/min IP limiter here) — needs to be
      // generous for the same reason the tenant-aware defaults above are.
      ipSafetyCap: { windowMs: 60_000, limit: 1000 },
    },
  },
  assertElevenReady: () => null,
  assertOpenRouterReady: () => null,
}));

// Phase 5: getSignedUrl now takes a ResolvedScenarioConfig. The mock
// reflects organizationId/scenario.id into the overrides it returns so
// tests can assert two different resolved configs actually produce
// different output through the exact same /session/start code path (see
// describe("Phase 5: ENGINE vs CONFIG") below) — not just that the
// function was called.
vi.mock("./services/elevenlabs.js", () => ({
  getSignedUrl: vi.fn(
    async (resolved: { organizationId: string; scenario: { id: string } }) => ({
      agent_id: "agent-1",
      signed_url: "wss://example.test/signed",
      voice_id: "voice-1",
      voice_gender: "male" as const,
      overrides: {
        agent: {
          prompt: { prompt: `PROMPT FOR ${resolved.organizationId}/${resolved.scenario.id}` },
          first_message: "hi",
          language: "es",
        },
        tts: { voice_id: "voice-1" },
      },
    })
  ),
}));

// Phase 5/6: /session/start and /session/end resolve scenario config via
// TWO SEPARATE functions (see RESOLUTION_API in
// PHASE_06_CONFIG_VERSIONING_PROVENANCE_REPORT.md) instead of branching
// on a hardcoded TargetMode. Mocked with a generic default (any
// organizationId + a known scenario id resolves to a fixture pinned to
// whichever configVersion the caller asked for — "v1" for new sessions
// unless a test overrides) so the ~30 existing tests using
// target_mode: "generic" keep working unchanged; individual Phase 5/6
// tests override these to exercise scenario_not_found /
// no_config_for_organization / unknown_config_version / per-organization
// distinct configs / per-version distinct configs. The REAL
// loader/resolver (against the actual shipped fixture packages
// backend/config-packages/sas-colombia,/acme-demo) is tested separately
// and without mocks in engine-config/loader.test.ts and
// engine-config/resolver.test.ts.
const KNOWN_SCENARIO_IDS = ["generic", "davivienda", "grupo_aval"];
function fixtureResolvedScenario(organizationId: string, scenarioId: string, configVersion = "v1") {
  return {
    organizationId,
    configVersion,
    configHash: `hash-${organizationId}-${configVersion}`,
    client: { organizationId, defaultLanguage: "es", settings: {} },
    scenario: {
      id: scenarioId,
      name: scenarioId,
      description: `description for ${scenarioId} @ ${organizationId}`,
      interviewerProfileId: "p1",
      evaluationFrameworkId: "f1",
      contentSourceIds: [],
      timing: { idealSeconds: 90, maxSeconds: 180 },
      firstMessage: "hi",
      openingContext: "ctx",
      closingMessage: "bye",
    },
    interviewerProfile: {
      id: "p1",
      name: "P",
      persona: "persona",
      tone: "tone",
      questioningBehavior: "behavior",
      followUpBehavior: { requiredCount: 1, specificQuestions: [], sharedQuestions: [] },
      voice: { slot: "random" },
    },
    evaluationFramework: {
      // Version-scoped id — the concrete signal the "key integration
      // test" (Phase 6 describe block below) checks to prove /session/end
      // evaluated against the PINNED version's framework, not whatever is
      // active at the time /session/end runs.
      id: `f1-${configVersion}`,
      name: `F ${configVersion}`,
      maxScore: 100,
      criteria: [{ id: "a", name: "A", weight: 100, description: "d" }],
      observableRules: [],
      requirements: [],
      mustReward: [],
      mustPenalize: [],
      evaluationInstructions: "instructions",
    },
    contentSources: [],
  };
}
const resolveScenarioConfigForNewSessionMock = vi.fn();
const resolveScenarioConfigForVersionMock = vi.fn();
vi.mock("./engine-config/resolver.js", () => ({
  resolveScenarioConfigForNewSession: (...args: unknown[]) => resolveScenarioConfigForNewSessionMock(...args),
  resolveScenarioConfigForVersion: (...args: unknown[]) => resolveScenarioConfigForVersionMock(...args),
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

// Fase 7: structured logging (observability/log.ts) — mocked so tests
// don't spam real console.log output; a couple of tests below assert on
// what routes.ts actually logs for the critical Firestore writes.
const logEventMock = vi.fn();
vi.mock("./observability/log.js", () => ({
  logEvent: (...args: unknown[]) => logEventMock(...args),
  elapsedMs: (start: number) => Date.now() - start,
}));

const { router } = await import("./routes.js");
const { resetRateLimitStoresForTests } = await import("./middleware/rateLimit.js");
const { config: mockedConfig } = await import("./config.js");

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
  logEventMock.mockClear();
  resetRateLimitStoresForTests();
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
  resolveScenarioConfigForNewSessionMock.mockReset();
  resolveScenarioConfigForNewSessionMock.mockImplementation(
    async ({ organizationId, scenarioId }: { organizationId: string; scenarioId: string }) => {
      if (KNOWN_SCENARIO_IDS.includes(scenarioId)) {
        return { outcome: "resolved", config: fixtureResolvedScenario(organizationId, scenarioId, "v1") };
      }
      return { outcome: "scenario_not_found" };
    }
  );
  resolveScenarioConfigForVersionMock.mockReset();
  resolveScenarioConfigForVersionMock.mockImplementation(
    async ({
      organizationId,
      scenarioId,
      configVersion,
    }: {
      organizationId: string;
      scenarioId: string;
      configVersion: string;
    }) => {
      if (KNOWN_SCENARIO_IDS.includes(scenarioId)) {
        return { outcome: "resolved", config: fixtureResolvedScenario(organizationId, scenarioId, configVersion) };
      }
      return { outcome: "scenario_not_found" };
    }
  );
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

describe("Phase 5: ENGINE vs CONFIG", () => {
  it("POST /session/start resolves scenario config generically — persists scenario_id, no hardcoded TargetMode branch", async () => {
    asSingleOrgUser("uid-1", "org-1", "SPOKESPERSON");
    const res = await request(buildApp())
      .post("/api/session/start")
      .set("Authorization", "Bearer t1")
      .send({ target_mode: "davivienda" }); // wire-compat field, treated as scenarioId

    expect(res.status).toBe(200);
    expect(resolveScenarioConfigForNewSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: "org-1", scenarioId: "davivienda" })
    );
    const stored = sessionsStore.get(res.body.session_id);
    expect(stored?.scenario_id).toBe("davivienda");
    // target_mode is a deprecated mirror of scenario_id, kept for the
    // current frontend's wire contract — see types.ts.
    expect(stored?.target_mode).toBe("davivienda");
    expect(res.body.target_mode).toBe("davivienda");
  });

  it("POST /session/start with an unknown scenario_id -> 400 (rejected, never silently falls back)", async () => {
    asSingleOrgUser("uid-1", "org-1", "SPOKESPERSON");
    const res = await request(buildApp())
      .post("/api/session/start")
      .set("Authorization", "Bearer t1")
      .send({ target_mode: "no-such-scenario" });

    expect(res.status).toBe(400);
  });

  it("POST /session/start when the organization has no valid config package -> 503, no internal details leaked", async () => {
    resolveScenarioConfigForNewSessionMock.mockResolvedValueOnce({
      outcome: "no_config_for_organization",
      errors: ["manifest.json: parse error at line 3", "/secret/internal/path/leaked"],
    });
    asSingleOrgUser("uid-1", "org-without-config", "SPOKESPERSON");
    const res = await request(buildApp())
      .post("/api/session/start")
      .set("Authorization", "Bearer t1")
      .send({ target_mode: "generic" });

    expect(res.status).toBe(503);
    expect(JSON.stringify(res.body)).not.toContain("/secret/internal/path");
    expect(JSON.stringify(res.body)).not.toContain("parse error");
  });

  it("two organizations resolve the SAME scenario_id to their OWN distinct config, through the identical code path — no collision", async () => {
    const app = buildApp();

    asSingleOrgUser("uid-a", "org-alpha", "SPOKESPERSON");
    const resA = await request(app)
      .post("/api/session/start")
      .set("Authorization", "Bearer t1")
      .send({ target_mode: "generic" });
    expect(resA.status).toBe(200);
    expect(resA.body.overrides.agent.prompt.prompt).toBe("PROMPT FOR org-alpha/generic");

    asSingleOrgUser("uid-b", "org-beta", "SPOKESPERSON");
    const resB = await request(app)
      .post("/api/session/start")
      .set("Authorization", "Bearer t2")
      .send({ target_mode: "generic" });
    expect(resB.status).toBe(200);
    expect(resB.body.overrides.agent.prompt.prompt).toBe("PROMPT FOR org-beta/generic");

    // Same scenario_id ("generic") in both, but each session persisted
    // under its own organization — no cross-contamination.
    expect(sessionsStore.get(resA.body.session_id)?.organization_id).toBe("org-alpha");
    expect(sessionsStore.get(resB.body.session_id)?.organization_id).toBe("org-beta");
  });

  it("/session/end re-resolves the evaluation framework from the PERSISTED scenario_id, never from anything in the request body", async () => {
    const app = buildApp();
    asSingleOrgUser("uid-1", "org-1", "SPOKESPERSON");
    const startRes = await request(app)
      .post("/api/session/start")
      .set("Authorization", "Bearer t1")
      .send({ target_mode: "grupo_aval" });
    const sessionId = startRes.body.session_id as string;

    resolveScenarioConfigForVersionMock.mockClear();
    const endRes = await request(app)
      .post("/api/session/end")
      .set("Authorization", "Bearer t1")
      .send({
        session_id: sessionId,
        duration_seconds: 10,
        transcript: [{ role: "user", text: "hola" }],
        // Attempting to smuggle a different scenario in — /session/end
        // doesn't even read this field, but assert it has zero effect.
        target_mode: "davivienda",
      });

    expect(endRes.status).toBe(200);
    // Re-resolved using the session's OWN persisted scenario_id
    // ("grupo_aval") AND its pinned config_version ("v1"), not the
    // body's "davivienda".
    expect(resolveScenarioConfigForVersionMock).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: "org-1", scenarioId: "grupo_aval", configVersion: "v1" })
    );
    expect(endRes.body.target_mode).toBe("grupo_aval");
  });
});

// Phase 6: SESSION_PINNING — a config version activated AFTER
// /session/start must have ZERO effect on that session's /session/end.
// See TEST_DE_INTEGRACIÓN_CLAVE in
// PHASE_06_CONFIG_VERSIONING_PROVENANCE_REPORT.md — this describe block
// is that test, plus the surrounding legacy/deprecation/unknown-version
// fail-closed policies.
describe("Phase 6: CONFIG VERSIONING + PROVENANCE", () => {
  it("THE KEY TEST: session pinned to v1 stays on v1 even after v2 is activated before /session/end runs", async () => {
    const app = buildApp();
    asSingleOrgUser("uid-1", "org-1", "SPOKESPERSON");

    // "org-1 v1 ACTIVE" -> /session/start -> Session S, config_version = v1.
    const startRes = await request(app)
      .post("/api/session/start")
      .set("Authorization", "Bearer t1")
      .send({ target_mode: "generic" });
    expect(startRes.status).toBe(200);
    const sessionId = startRes.body.session_id as string;
    expect(sessionsStore.get(sessionId)?.config_provenance).toMatchObject({ config_version: "v1" });

    // "activar v2" — simulated at the resolution layer: from now on the
    // registry/active pointer would say v2, but /session/end never asks
    // it anything; it resolves the PINNED version straight from the
    // session record. Nothing in routes.ts changes to make this true —
    // that's the point.
    const endRes = await request(app)
      .post("/api/session/end")
      .set("Authorization", "Bearer t1")
      .send({ session_id: sessionId, duration_seconds: 30, transcript: [{ role: "user", text: "hola" }] });

    expect(endRes.status).toBe(200);
    // "evaluator recibe framework de v1, NO framework de v2":
    expect(resolveScenarioConfigForVersionMock).toHaveBeenCalledWith(
      expect.objectContaining({ configVersion: "v1" })
    );
    const evaluateCall = evaluatePitchMock.mock.calls[evaluatePitchMock.mock.calls.length - 1][0];
    expect(evaluateCall.resolved.evaluationFramework.id).toBe("f1-v1");
    expect(evaluateCall.resolved.evaluationFramework.id).not.toBe("f1-v2");

    // "/session/start S2" (after v2 is active) -> uses v2.
    resolveScenarioConfigForNewSessionMock.mockImplementationOnce(
      async ({ organizationId, scenarioId }: { organizationId: string; scenarioId: string }) => ({
        outcome: "resolved",
        config: fixtureResolvedScenario(organizationId, scenarioId, "v2"),
      })
    );
    const start2Res = await request(app)
      .post("/api/session/start")
      .set("Authorization", "Bearer t1")
      .send({ target_mode: "generic" });
    expect(start2Res.status).toBe(200);
    expect(sessionsStore.get(start2Res.body.session_id)?.config_provenance).toMatchObject({
      config_version: "v2",
    });
  });

  it("POST /session/start persists config_provenance with version/interviewer/framework/content ids from the resolved config", async () => {
    asSingleOrgUser("uid-1", "org-1", "SPOKESPERSON");
    const res = await request(buildApp())
      .post("/api/session/start")
      .set("Authorization", "Bearer t1")
      .send({ target_mode: "generic" });

    expect(res.status).toBe(200);
    const stored = sessionsStore.get(res.body.session_id);
    expect(stored?.config_provenance).toEqual({
      config_version: "v1",
      interviewer_profile_id: "p1",
      evaluation_framework_id: "f1-v1",
      content_source_ids: [],
      config_hash: "hash-org-1-v1",
    });
  });

  // Fase 7: LATENCY_MEASUREMENT for the one Firestore write on the
  // critical path (createSession) — see the comment above `await
  // createSession(session)` in routes.ts.
  it("POST /session/start logs a firestore_write event with duration_ms for createSession", async () => {
    asSingleOrgUser("uid-1", "org-1", "SPOKESPERSON");
    const res = await request(buildApp())
      .post("/api/session/start")
      .set("Authorization", "Bearer t1")
      .send({ target_mode: "generic" });

    expect(res.status).toBe(200);
    const writeLog = logEventMock.mock.calls
      .map((call) => call[0])
      .find((f) => f.event === "firestore_write" && f.outcome === "success");
    expect(writeLog).toMatchObject({
      provider: "firestore",
      organization_id: "org-1",
      session_id: res.body.session_id,
    });
    expect(typeof writeLog.duration_ms).toBe("number");
  });

  it("LEGACY_SESSION_POLICY: /session/end fails closed for a session with no config_provenance.config_version, never guesses a version", async () => {
    const app = buildApp();
    asSingleOrgUser("uid-1", "org-1", "SPOKESPERSON");
    // A pre-Phase-6 session: has scenario_id/target_mode but no
    // config_provenance at all — simulates a legacy Firestore doc.
    sessionsStore.set("legacy-session-1", {
      session_id: "legacy-session-1",
      user_id: "uid-1",
      organization_id: "org-1",
      owner_uid: "uid-1",
      scenario_id: "generic",
      target_mode: "generic",
      status: "in_progress",
      started_at: "2026-01-01T00:00:00.000Z",
    });

    resolveScenarioConfigForVersionMock.mockClear();
    const res = await request(app)
      .post("/api/session/end")
      .set("Authorization", "Bearer t1")
      .send({ session_id: "legacy-session-1", duration_seconds: 30, transcript: [{ role: "user", text: "hola" }] });

    expect(res.status).toBe(503);
    // Never even attempted to resolve — there is no version to resolve.
    expect(resolveScenarioConfigForVersionMock).not.toHaveBeenCalled();
    expect(sessionsStore.get("legacy-session-1")?.status).toBe("evaluation_failed");
    expect(sessionsStore.get("legacy-session-1")?.failure_reason).toBe("LEGACY_CONFIG_VERSION_UNKNOWN");
  });

  // Fase 7: this best-effort markEvaluationFailed call used to be
  // `.catch(() => {})` — if the write itself also failed, that failure
  // vanished with no trace anywhere. It must now be logged, same pattern
  // already used elsewhere in this file for the equivalent case in
  // /session/end's evaluatePitch failure path.
  it("logs (never silently swallows) when the best-effort markEvaluationFailed for a legacy session itself fails", async () => {
    const app = buildApp();
    asSingleOrgUser("uid-1", "org-1", "SPOKESPERSON");
    sessionsStore.set("legacy-session-2", {
      session_id: "legacy-session-2",
      user_id: "uid-1",
      organization_id: "org-1",
      owner_uid: "uid-1",
      scenario_id: "generic",
      target_mode: "generic",
      status: "in_progress",
      started_at: "2026-01-01T00:00:00.000Z",
    });

    const { markEvaluationFailed } = await import("./repositories/sessions.js");
    (markEvaluationFailed as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("simulated Firestore write failure")
    );
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await request(app)
      .post("/api/session/end")
      .set("Authorization", "Bearer t1")
      .send({ session_id: "legacy-session-2", duration_seconds: 30, transcript: [{ role: "user", text: "hola" }] });

    expect(res.status).toBe(503);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("markEvaluationFailed"),
      expect.stringContaining("simulated Firestore write failure")
    );
    consoleErrorSpy.mockRestore();
  });

  it("config_version desconocida -> /session/end falla cerrado (never substitutes the active version)", async () => {
    const app = buildApp();
    asSingleOrgUser("uid-1", "org-1", "SPOKESPERSON");
    sessionsStore.set("session-unknown-version", {
      session_id: "session-unknown-version",
      user_id: "uid-1",
      organization_id: "org-1",
      owner_uid: "uid-1",
      scenario_id: "generic",
      target_mode: "generic",
      status: "in_progress",
      started_at: "2026-01-01T00:00:00.000Z",
      config_provenance: {
        config_version: "v-deleted",
        interviewer_profile_id: "p1",
        evaluation_framework_id: "f1-v-deleted",
        content_source_ids: [],
        config_hash: "hash-gone",
      },
    });
    resolveScenarioConfigForVersionMock.mockImplementationOnce(async () => ({
      outcome: "unknown_config_version",
      errors: ["No se pudo leer manifest.json: ENOENT"],
    }));

    const res = await request(app)
      .post("/api/session/end")
      .set("Authorization", "Bearer t1")
      .send({
        session_id: "session-unknown-version",
        duration_seconds: 30,
        transcript: [{ role: "user", text: "hola" }],
      });

    expect(res.status).toBe(503);
    expect(sessionsStore.get("session-unknown-version")?.status).toBe("evaluation_failed");
  });

  it("DEPRECATION_FLOW: a version no longer active still resolves for its own historical session (hash matches provenance)", async () => {
    // Resolution never distinguishes active/deprecated at the routes
    // layer — the mock simply keeps answering for "v1" regardless of
    // what's "active" today, exactly like the real resolveScenarioConfigForVersion.
    // The default fixture hash formula is identical for /session/start and
    // /session/end (both `hash-org-1-v1`), so this also exercises the
    // NO-DRIFT case of the hash precondition below: deprecated + hash
    // still matching provenance -> the historical session completes.
    const app = buildApp();
    asSingleOrgUser("uid-1", "org-1", "SPOKESPERSON");
    const startRes = await request(app)
      .post("/api/session/start")
      .set("Authorization", "Bearer t1")
      .send({ target_mode: "generic" });
    const sessionId = startRes.body.session_id as string;

    const endRes = await request(app)
      .post("/api/session/end")
      .set("Authorization", "Bearer t1")
      .send({ session_id: sessionId, duration_seconds: 30, transcript: [{ role: "user", text: "hola" }] });

    expect(endRes.status).toBe(200);
  });

  // PASS_WITH_FIXES (config hash as a real precondition): version NAME
  // resolving successfully is not enough — its CONTENT must still be
  // exactly what the session was pinned to.
  describe("CONFIG HASH AS A REAL PRECONDITION", () => {
    it("1. session starts on v1/hash AAA; v1's files change to hash BBB before /session/end -> 503, evaluator never called, provenance never re-pinned", async () => {
      const app = buildApp();
      asSingleOrgUser("uid-1", "org-1", "SPOKESPERSON");

      const startRes = await request(app)
        .post("/api/session/start")
        .set("Authorization", "Bearer t1")
        .send({ target_mode: "generic" });
      const sessionId = startRes.body.session_id as string;
      expect(sessionsStore.get(sessionId)?.config_provenance).toMatchObject({
        config_version: "v1",
        config_hash: "hash-org-1-v1",
      });

      // Simulates "alguien modifica los archivos de v1 en sitio": the
      // SAME config_version now resolves with a DIFFERENT content hash.
      resolveScenarioConfigForVersionMock.mockImplementationOnce(
        async ({
          organizationId,
          scenarioId,
          configVersion,
        }: {
          organizationId: string;
          scenarioId: string;
          configVersion: string;
        }) => ({
          outcome: "resolved",
          config: { ...fixtureResolvedScenario(organizationId, scenarioId, configVersion), configHash: "hash-BBB-mutated-in-place" },
        })
      );
      evaluatePitchMock.mockClear();

      const endRes = await request(app)
        .post("/api/session/end")
        .set("Authorization", "Bearer t1")
        .send({ session_id: sessionId, duration_seconds: 30, transcript: [{ role: "user", text: "hola" }] });

      expect(endRes.status).toBe(503);
      expect(evaluatePitchMock).not.toHaveBeenCalled();
      const after = sessionsStore.get(sessionId);
      expect(after?.status).toBe("evaluation_failed");
      expect(after?.failure_reason).toBe("CONFIG_PROVENANCE_HASH_MISMATCH");
      // Never silently re-pinned/substituted:
      expect(after?.config_provenance).toMatchObject({ config_hash: "hash-org-1-v1" });

      // Fase 8 — LOG_NORMALIZATION: alongside the console.error, a
      // structured event now exists too.
      const events = logEventMock.mock.calls.map((c) => c[0]).filter((f) => f.event === "config_integrity_failure");
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        error_category: "CONFIG_PROVENANCE_HASH_MISMATCH",
        session_id: sessionId,
        organization_id: "org-1",
      });
    });

    it("2. active registry says v1/hash AAA but the loaded package now hashes to BBB -> new /session/start is rejected (503, generic)", async () => {
      // At the routes layer, this drift check lives INSIDE
      // resolveScenarioConfigForNewSession (see engine-config/
      // resolver.test.ts's CONFIG_DRIFT_DETECTION tests for the real
      // function) — simulated here at the mock boundary by having it
      // return the SAME outcome the real function returns on drift.
      resolveScenarioConfigForNewSessionMock.mockImplementationOnce(async () => ({
        outcome: "no_config_for_organization",
        errors: ["CONFIG_INTEGRITY_DRIFT: registered hash AAA, current hash BBB"],
      }));
      asSingleOrgUser("uid-1", "org-1", "SPOKESPERSON");
      const res = await request(buildApp())
        .post("/api/session/start")
        .set("Authorization", "Bearer t1")
        .send({ target_mode: "generic" });

      expect(res.status).toBe(503);
      expect(JSON.stringify(res.body)).not.toContain("CONFIG_INTEGRITY_DRIFT");
    });

    it("3. active v1 with no drift -> /session/start works normally", async () => {
      asSingleOrgUser("uid-1", "org-1", "SPOKESPERSON");
      const res = await request(buildApp())
        .post("/api/session/start")
        .set("Authorization", "Bearer t1")
        .send({ target_mode: "generic" });
      expect(res.status).toBe(200);
    });

    it("5. same config_version, different hash -> never silently re-pinned or substituted (repeat with a different mismatch amount, same guarantee)", async () => {
      const app = buildApp();
      asSingleOrgUser("uid-1", "org-1", "SPOKESPERSON");
      const startRes = await request(app)
        .post("/api/session/start")
        .set("Authorization", "Bearer t1")
        .send({ target_mode: "generic" });
      const sessionId = startRes.body.session_id as string;
      const provenanceBefore = sessionsStore.get(sessionId)?.config_provenance;

      resolveScenarioConfigForVersionMock.mockImplementationOnce(
        async ({
          organizationId,
          scenarioId,
          configVersion,
        }: {
          organizationId: string;
          scenarioId: string;
          configVersion: string;
        }) => ({
          outcome: "resolved",
          config: { ...fixtureResolvedScenario(organizationId, scenarioId, configVersion), configHash: "yet-another-different-hash" },
        })
      );

      await request(app)
        .post("/api/session/end")
        .set("Authorization", "Bearer t1")
        .send({ session_id: sessionId, duration_seconds: 30, transcript: [{ role: "user", text: "hola" }] });

      // The persisted provenance is the historical authority — a failed
      // hash check must never overwrite it with the (mismatched) newly
      // resolved hash.
      expect(sessionsStore.get(sessionId)?.config_provenance).toEqual(provenanceBefore);
    });
  });
});

// Fase 8: REQUEST_ID_POLICY + HTTP_REQUEST_LOGGING.
describe("Fase 8: HTTP request observability", () => {
  function httpRequestLogs() {
    return logEventMock.mock.calls.map((call) => call[0]).filter((f) => f.event === "http_request");
  }

  it("GET /health gets a request_id and logs an http_request event with method/endpoint/status_code/duration_ms", async () => {
    const res = await request(buildApp()).get("/api/health");
    expect(res.status).toBe(200);

    const logs = httpRequestLogs();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ method: "GET", endpoint: "/health", status_code: 200 });
    expect(typeof logs[0].request_id).toBe("string");
    expect(logs[0].request_id.length).toBeGreaterThan(0);
    expect(typeof logs[0].duration_ms).toBe("number");
  });

  it("each request gets a DIFFERENT request_id", async () => {
    const app = buildApp();
    await request(app).get("/api/health");
    await request(app).get("/api/health");

    const [first, second] = httpRequestLogs();
    expect(first.request_id).not.toBe(second.request_id);
  });

  it("GET /me logs organization_id, user_id and role once auth/membership resolve", async () => {
    asSingleOrgUser("uid-1", "org-1", "COACH");
    const res = await request(buildApp()).get("/api/me").set("Authorization", "Bearer t1");
    expect(res.status).toBe(200);

    const logs = httpRequestLogs();
    expect(logs[0]).toMatchObject({
      method: "GET",
      endpoint: "/me",
      status_code: 200,
      user_id: "uid-1",
      organization_id: "org-1",
      role: "COACH",
      outcome: "success",
    });
  });

  it("a failed request (400) is logged with status_code 400 and outcome failure, no organization_id/user_id when auth never resolved", async () => {
    const res = await request(buildApp())
      .post("/api/session/start")
      .set("Authorization", "Bearer t1")
      .send({});
    expect(res.status).toBe(401); // no verifyIdTokenMock stub -> requireAuth rejects first

    const logs = httpRequestLogs();
    expect(logs[0]).toMatchObject({ status_code: 401, outcome: "failure" });
    expect(logs[0].user_id).toBeUndefined();
    expect(logs[0].organization_id).toBeUndefined();
  });

  it("never logs the Authorization header, the request body, or a transcript", async () => {
    asSingleOrgUser("uid-1", "org-1", "SPOKESPERSON");
    await request(buildApp())
      .post("/api/session/end")
      .set("Authorization", "Bearer super-secret-token-value")
      .send({ session_id: "does-not-exist", duration_seconds: 1, transcript: [{ role: "user", text: "muy secreto" }] });

    const logs = httpRequestLogs();
    const serialized = JSON.stringify(logs[0]);
    expect(serialized).not.toContain("super-secret-token-value");
    expect(serialized).not.toContain("muy secreto");
    // Only whitelisted LogFields keys — no accidental `body`/`headers`/`authorization` key.
    const allowedKeys = new Set([
      "event",
      "ts",
      "session_id",
      "organization_id",
      "config_version",
      "scenario_id",
      "provider",
      "attempt",
      "duration_ms",
      "outcome",
      "error_category",
      "request_id",
      "user_id",
      "role",
      "method",
      "endpoint",
      "status_code",
      "rate_limit_scope",
    ]);
    for (const key of Object.keys(logs[0])) {
      expect(allowedKeys.has(key)).toBe(true);
    }
  });
});

// Fase 8 — LOG_NORMALIZATION: the config-integrity fail-closed paths in
// /session/end (Fase 6) already logged a human console.error, but never a
// structured event — making them invisible to the observability
// summarizer. Each now ALSO emits a `config_integrity_failure` event.
describe("Fase 8: config_integrity_failure structured event", () => {
  it("LEGACY_CONFIG_VERSION_UNKNOWN emits a config_integrity_failure event", async () => {
    asSingleOrgUser("uid-1", "org-1", "SPOKESPERSON");
    sessionsStore.set("legacy-session-log", {
      session_id: "legacy-session-log",
      user_id: "uid-1",
      organization_id: "org-1",
      owner_uid: "uid-1",
      scenario_id: "generic",
      target_mode: "generic",
      status: "in_progress",
      started_at: "2026-01-01T00:00:00.000Z",
    });

    await request(buildApp())
      .post("/api/session/end")
      .set("Authorization", "Bearer t1")
      .send({ session_id: "legacy-session-log", duration_seconds: 30, transcript: [{ role: "user", text: "hola" }] });

    const events = logEventMock.mock.calls.map((c) => c[0]).filter((f) => f.event === "config_integrity_failure");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      error_category: "LEGACY_CONFIG_VERSION_UNKNOWN",
      session_id: "legacy-session-log",
      organization_id: "org-1",
      outcome: "failure",
    });
  });

  it("CONFIG_VERSION_RESOLUTION_FAILED emits a config_integrity_failure event", async () => {
    asSingleOrgUser("uid-1", "org-1", "SPOKESPERSON");
    sessionsStore.set("unknown-version-log", {
      session_id: "unknown-version-log",
      user_id: "uid-1",
      organization_id: "org-1",
      owner_uid: "uid-1",
      scenario_id: "not-a-known-scenario", // outside KNOWN_SCENARIO_IDS -> mock resolves "scenario_not_found"
      target_mode: "not-a-known-scenario",
      status: "in_progress",
      started_at: "2026-01-01T00:00:00.000Z",
      config_provenance: {
        config_version: "v-does-not-exist",
        interviewer_profile_id: "p1",
        evaluation_framework_id: "f1",
        content_source_ids: [],
        config_hash: "irrelevant",
      },
    });

    await request(buildApp())
      .post("/api/session/end")
      .set("Authorization", "Bearer t1")
      .send({ session_id: "unknown-version-log", duration_seconds: 30, transcript: [{ role: "user", text: "hola" }] });

    const events = logEventMock.mock.calls.map((c) => c[0]).filter((f) => f.event === "config_integrity_failure");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      error_category: "CONFIG_VERSION_RESOLUTION_FAILED",
      session_id: "unknown-version-log",
      organization_id: "org-1",
    });
  });
});

// Fase 8: USER_LIMITS / ORGANIZATION_LIMITS / MULTITENANT_SAFETY, exercised
// through the real routes.ts wiring (not just the rateLimit.ts unit tests).
// scopedRateLimit reads `cfg.limit`/`cfg.windowMs` live on every request
// (see rateLimit.ts), so mutating the mocked config's rateLimits values
// here actually changes the already-built middleware's behavior without
// needing to fire 1000+ requests or reset modules.
describe("Fase 8: rate limiting wiring", () => {
  const defaultRateLimits = JSON.parse(JSON.stringify(mockedConfig.rateLimits));

  afterEach(() => {
    // Deep-restore so a test that lowers a limit never bleeds into a
    // later, unrelated test elsewhere in this file.
    mockedConfig.rateLimits.sessionStart.user.limit = defaultRateLimits.sessionStart.user.limit;
    mockedConfig.rateLimits.sessionStart.organization.limit = defaultRateLimits.sessionStart.organization.limit;
    mockedConfig.rateLimits.sessionStart.global.limit = defaultRateLimits.sessionStart.global.limit;
    mockedConfig.rateLimits.sessionEnd.user.limit = defaultRateLimits.sessionEnd.user.limit;
    mockedConfig.rateLimits.sessionEnd.organization.limit = defaultRateLimits.sessionEnd.organization.limit;
    mockedConfig.rateLimits.sessionEnd.global.limit = defaultRateLimits.sessionEnd.global.limit;
    mockedConfig.rateLimits.metricsAnalyze.user.limit = defaultRateLimits.metricsAnalyze.user.limit;
    mockedConfig.rateLimits.ipSafetyCap.limit = defaultRateLimits.ipSafetyCap.limit;
  });

  it("the same user exceeding the user limit on /session/start gets 429 with Retry-After", async () => {
    mockedConfig.rateLimits.sessionStart.user.limit = 1;
    asSingleOrgUser("uid-1", "org-1", "SPOKESPERSON");
    const app = buildApp();

    const res1 = await request(app).post("/api/session/start").set("Authorization", "Bearer t1").send({ target_mode: "generic" });
    expect(res1.status).toBe(200);

    const res2 = await request(app).post("/api/session/start").set("Authorization", "Bearer t1").send({ target_mode: "generic" });
    expect(res2.status).toBe(429);
    expect(res2.body).toMatchObject({ retry_after_seconds: expect.any(Number) });
    expect(res2.headers["retry-after"]).toBeDefined();
  });

  it("a 429 emits a structured rate_limit_rejected event", async () => {
    mockedConfig.rateLimits.sessionStart.user.limit = 1;
    asSingleOrgUser("uid-1", "org-1", "SPOKESPERSON");
    const app = buildApp();
    await request(app).post("/api/session/start").set("Authorization", "Bearer t1").send({ target_mode: "generic" });
    await request(app).post("/api/session/start").set("Authorization", "Bearer t1").send({ target_mode: "generic" });

    const rejections = logEventMock.mock.calls.map((c) => c[0]).filter((f) => f.event === "rate_limit_rejected");
    expect(rejections).toHaveLength(1);
    expect(rejections[0]).toMatchObject({
      user_id: "uid-1",
      organization_id: "org-1",
      endpoint: "/session/start",
      rate_limit_scope: "user",
    });
  });

  it("a DIFFERENT user is unaffected by another user's exhausted user-limit bucket", async () => {
    mockedConfig.rateLimits.sessionStart.user.limit = 1;
    const app = buildApp();

    asSingleOrgUser("uid-a", "org-1", "SPOKESPERSON");
    await request(app).post("/api/session/start").set("Authorization", "Bearer t1").send({ target_mode: "generic" });
    await request(app).post("/api/session/start").set("Authorization", "Bearer t1").send({ target_mode: "generic" }); // exhausts uid-a

    asSingleOrgUser("uid-b", "org-1", "SPOKESPERSON");
    const resB = await request(app).post("/api/session/start").set("Authorization", "Bearer t1").send({ target_mode: "generic" });
    expect(resB.status).toBe(200);
  });

  it("/session/start and /session/end enforce independent user limits (different endpoints, different buckets)", async () => {
    mockedConfig.rateLimits.sessionStart.user.limit = 1;
    asSingleOrgUser("uid-1", "org-1", "SPOKESPERSON");
    const app = buildApp();

    const startRes1 = await request(app).post("/api/session/start").set("Authorization", "Bearer t1").send({ target_mode: "generic" });
    expect(startRes1.status).toBe(200);
    const startRes2 = await request(app).post("/api/session/start").set("Authorization", "Bearer t1").send({ target_mode: "generic" });
    expect(startRes2.status).toBe(429); // /session/start user-limit exhausted

    // /session/end must be unaffected — same user, different endpoint bucket.
    const endRes = await request(app)
      .post("/api/session/end")
      .set("Authorization", "Bearer t1")
      .send({ session_id: "does-not-exist", duration_seconds: 1, transcript: [{ role: "user", text: "hola" }] });
    expect(endRes.status).not.toBe(429);
  });

  it("organization limit blocks a second user in the SAME org once the org bucket is exhausted, independent of the user limit", async () => {
    mockedConfig.rateLimits.sessionStart.organization.limit = 1;
    const app = buildApp();

    asSingleOrgUser("uid-a", "org-1", "SPOKESPERSON");
    const resA = await request(app).post("/api/session/start").set("Authorization", "Bearer t1").send({ target_mode: "generic" });
    expect(resA.status).toBe(200);

    asSingleOrgUser("uid-b", "org-1", "SPOKESPERSON"); // different user, SAME org
    const resB = await request(app).post("/api/session/start").set("Authorization", "Bearer t1").send({ target_mode: "generic" });
    expect(resB.status).toBe(429);
  });

  it("TENANT_TRUST_BOUNDARY: a spoofed body.organization_id never affects which org bucket is charged", async () => {
    mockedConfig.rateLimits.sessionStart.organization.limit = 1;
    const app = buildApp();

    // Real org is org-A (from Membership); body claims org-B.
    asSingleOrgUser("uid-1", "org-A", "SPOKESPERSON");
    getOrganizationMock.mockImplementation(async (id: string) => ({
      id,
      name: id,
      slug: id,
      status: "active",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    }));
    await request(app)
      .post("/api/session/start")
      .set("Authorization", "Bearer t1")
      .send({ target_mode: "generic", organization_id: "org-B" });

    // A genuine org-B caller must be unaffected — proves the spoofed body
    // field in the previous request never touched org-B's real bucket.
    listMembershipsByUserMock.mockReset();
    listMembershipsByUserMock.mockResolvedValue([membership({ user_id: "uid-2", organization_id: "org-B" })]);
    verifyIdTokenMock.mockResolvedValue({ uid: "uid-2", email: "uid-2@test.com" });
    getUserMock.mockResolvedValue({
      uid: "uid-2",
      email: "uid-2@test.com",
      display_name: null,
      status: "active",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    });
    const resGenuineOrgB = await request(app)
      .post("/api/session/start")
      .set("Authorization", "Bearer t1")
      .send({ target_mode: "generic" });
    expect(resGenuineOrgB.status).toBe(200);
  });

  it("global limit caps total traffic to an endpoint across ALL users/orgs", async () => {
    mockedConfig.rateLimits.sessionStart.global.limit = 1;
    const app = buildApp();

    asSingleOrgUser("uid-a", "org-a", "SPOKESPERSON");
    const resA = await request(app).post("/api/session/start").set("Authorization", "Bearer t1").send({ target_mode: "generic" });
    expect(resA.status).toBe(200);

    asSingleOrgUser("uid-b", "org-b", "SPOKESPERSON"); // different user AND org
    const resB = await request(app).post("/api/session/start").set("Authorization", "Bearer t1").send({ target_mode: "generic" });
    expect(resB.status).toBe(429); // global safety cap, independent of user/org
  });

  // PASS_WITH_FIXES P1.1: real shared-NAT evidence — several distinct
  // users (different uid, different org — supertest requests from this
  // process all share the SAME source IP, exactly like a real shared
  // NAT) must NOT be blocked by the pre-auth IP layer before reaching
  // their own user/organization limits. User and organization limits are
  // set tight (1) here specifically so IF the IP layer were still the
  // dominant, lower bound (the old bug), these requests would already be
  // failing for the WRONG reason before this test could even isolate
  // user/org behavior.
  it("SHARED_NAT_EVIDENCE: several distinct users behind the same IP each reach their OWN user/organization limit, unblocked by the IP layer", async () => {
    mockedConfig.rateLimits.sessionStart.user.limit = 1;
    mockedConfig.rateLimits.sessionStart.organization.limit = 1;
    const app = buildApp();
    for (const [uid, org] of [
      ["uid-nat-a", "org-nat-a"],
      ["uid-nat-b", "org-nat-b"],
      ["uid-nat-c", "org-nat-c"],
      ["uid-nat-d", "org-nat-d"],
      ["uid-nat-e", "org-nat-e"],
    ]) {
      asSingleOrgUser(uid, org, "SPOKESPERSON");
      const res = await request(app).post("/api/session/start").set("Authorization", "Bearer t1").send({ target_mode: "generic" });
      expect(res.status).toBe(200); // none blocked by a shared IP bucket
    }
  });

  it("PRE_AUTH IP layer: once its own (deliberately low, test-only) cap is exceeded, rejects with 429, a rate_limit_rejected event, and rate_limit_scope 'ip'", async () => {
    mockedConfig.rateLimits.ipSafetyCap.limit = 2;
    const app = buildApp();

    // Three DIFFERENT users, so user/organization limits (generous here)
    // never come close — isolates the IP layer specifically.
    for (const [uid, org] of [
      ["uid-ip-a", "org-ip-a"],
      ["uid-ip-b", "org-ip-b"],
    ]) {
      asSingleOrgUser(uid, org, "SPOKESPERSON");
      const res = await request(app).post("/api/session/start").set("Authorization", "Bearer t1").send({ target_mode: "generic" });
      expect(res.status).toBe(200);
    }

    asSingleOrgUser("uid-ip-c", "org-ip-c", "SPOKESPERSON");
    const res3 = await request(app).post("/api/session/start").set("Authorization", "Bearer t1").send({ target_mode: "generic" });
    expect(res3.status).toBe(429);
    expect(res3.body).toMatchObject({ retry_after_seconds: expect.any(Number) });

    const rejections = logEventMock.mock.calls.map((c) => c[0]).filter((f) => f.event === "rate_limit_rejected");
    const ipRejection = rejections.find((r) => r.rate_limit_scope === "ip");
    expect(ipRejection).toBeDefined();
    expect(ipRejection).toMatchObject({ rate_limit_scope: "ip", outcome: "failure", endpoint: "/session/start" });
    expect(typeof ipRejection.request_id).toBe("string");
  });
});
