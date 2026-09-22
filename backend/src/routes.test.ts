// Integration tests for the auth gate on sensitive routes, and for the
// Phase-1 identity/ownership rules: identity comes from the verified token,
// never the request body, and /session/end rejects a different uid than
// the one that started the session (temporary, in-memory ownership check).
//
// External providers (ElevenLabs, OpenRouter/evaluator, Firestore) and
// firebase-admin's token verification are mocked so these tests run
// without real credentials or network access.
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const verifyIdTokenMock = vi.fn();

vi.mock("firebase-admin", () => ({
  default: {
    auth: () => ({ verifyIdToken: verifyIdTokenMock }),
  },
}));

vi.mock("./config.js", () => ({
  config: {
    apiSharedToken: "", // shared-token gate disabled for these tests
    authAllowedEmails: ["allowed@test.com", "other-allowed@test.com"],
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
  saveSessionStart: vi.fn(async () => {}),
  saveSessionResult: vi.fn(async () => {}),
  listSessions: vi.fn(async () => []),
  isAuthReady: vi.fn(() => true),
}));

// Phase 2: GET /me resolves its context through requireMembership ->
// resolveAppContext -> these repositories. Mocked so these tests never
// touch real Firestore; each /me test controls exactly what "exists".
// Defaults (an active user, and every organization active) mean a test
// only has to override what it actually cares about.
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
  // Sane defaults for the GET /me tests below: an active AppUser, and any
  // organization looked up comes back active. Individual tests override
  // these to exercise the inactive-user/inactive-org paths.
  getUserMock.mockResolvedValue({
    uid: "uid-1",
    email: "allowed@test.com",
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

  it("POST /session/start -> 403 with a valid token outside the allowlist", async () => {
    verifyIdTokenMock.mockResolvedValue({ uid: "uid-x", email: "stranger@test.com" });
    const res = await request(buildApp())
      .post("/api/session/start")
      .set("Authorization", "Bearer good")
      .send({ target_mode: "generic" });
    expect(res.status).toBe(403);
  });

  it("POST /session/start -> 200 with a valid, allowlisted token", async () => {
    verifyIdTokenMock.mockResolvedValue({ uid: "uid-1", email: "allowed@test.com" });
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

describe("identity is derived from the verified token, never the body", () => {
  it("ignores a client-supplied user_id and rejects /session/end from a different uid", async () => {
    const app = buildApp();

    // Started by the real, token-verified uid "owner-uid" — the body tries
    // to claim a different identity ("spoofed-uid"), which must be ignored.
    verifyIdTokenMock.mockResolvedValueOnce({ uid: "owner-uid", email: "allowed@test.com" });
    const startRes = await request(app)
      .post("/api/session/start")
      .set("Authorization", "Bearer t1")
      .send({
        target_mode: "generic",
        user_id: "spoofed-uid",
        user_name: "Spoofed Name",
      });
    expect(startRes.status).toBe(200);
    const sessionId = startRes.body.session_id as string;

    // Ending the same session as the uid that was spoofed in the body
    // (not the real starter) must be rejected. If the server had trusted
    // body.user_id as the owner, this would incorrectly succeed.
    verifyIdTokenMock.mockResolvedValueOnce({
      uid: "spoofed-uid",
      email: "other-allowed@test.com",
    });
    const endRes = await request(app)
      .post("/api/session/end")
      .set("Authorization", "Bearer t2")
      .send({
        session_id: sessionId,
        target_mode: "generic",
        duration_seconds: 42,
        transcript: [{ role: "user", text: "hola" }],
      });
    expect(endRes.status).toBe(403);
  });

  it("allows /session/end from the real starter uid", async () => {
    const app = buildApp();

    verifyIdTokenMock.mockResolvedValueOnce({ uid: "owner-uid", email: "allowed@test.com" });
    const startRes = await request(app)
      .post("/api/session/start")
      .set("Authorization", "Bearer t1")
      .send({ target_mode: "generic" });
    const sessionId = startRes.body.session_id as string;

    verifyIdTokenMock.mockResolvedValueOnce({ uid: "owner-uid", email: "allowed@test.com" });
    const endRes = await request(app)
      .post("/api/session/end")
      .set("Authorization", "Bearer t2")
      .send({
        session_id: sessionId,
        target_mode: "generic",
        duration_seconds: 42,
        transcript: [{ role: "user", text: "hola" }],
      });
    expect(endRes.status).toBe(200);
  });
});

describe("GET /me — Phase 2 server-resolved organization/role context", () => {
  it("401s without a token", async () => {
    const res = await request(buildApp()).get("/api/me");
    expect(res.status).toBe(401);
  });

  it("403s a valid, allowlisted token with no active Membership", async () => {
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
    verifyIdTokenMock.mockResolvedValue({ uid: "uid-1", email: "allowed@test.com" });
    listMembershipsByUserMock.mockResolvedValue([
      membership({ organization_id: "org-real", role: "CLIENT_ADMIN" }),
    ]);

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
    verifyIdTokenMock.mockResolvedValue({ uid: "uid-1", email: "allowed@test.com" });
    listMembershipsByUserMock.mockResolvedValue([
      membership({ organization_id: "org-real", role: "SPOKESPERSON" }),
    ]);

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
