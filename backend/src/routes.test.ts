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

vi.mock("./services/evaluator.js", () => ({
  evaluatePitch: vi.fn(async () => ({
    session_id: "evaluated",
    overall_score: 5,
  })),
}));

vi.mock("./firebase.js", () => ({
  isAuthReady: vi.fn(() => true),
}));

// Phase 3: sessions are persisted/read through this repository instead of
// an in-memory Map. Mocked so these tests never touch real Firestore —
// each test controls exactly what "exists" via an in-memory fake.
const sessionsStore = new Map<string, Record<string, unknown>>();
vi.mock("./repositories/sessions.js", () => ({
  createSession: vi.fn(async (session: Record<string, unknown>) => {
    sessionsStore.set(session.session_id as string, session);
  }),
  getSessionById: vi.fn(async (id: string) => sessionsStore.get(id) ?? null),
  completeSession: vi.fn(async () => {}),
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
