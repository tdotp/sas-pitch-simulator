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
// resolveAppContext -> this repository. Mocked so these tests never touch
// real Firestore; each /me test controls exactly what memberships "exist".
const listMembershipsByUserMock = vi.fn();
vi.mock("./repositories/memberships.js", () => ({
  listMembershipsByUser: (userId: string) => listMembershipsByUserMock(userId),
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

  it("200s with the real organization/role for a known user with an active Membership", async () => {
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

  it("ignores organization_id/role sent by the client — the real Firestore values win", async () => {
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

  it("does not break with more than one active Membership — resolves deterministically", async () => {
    verifyIdTokenMock.mockResolvedValue({ uid: "uid-1", email: "allowed@test.com" });
    listMembershipsByUserMock.mockResolvedValue([
      membership({
        id: "m-newer",
        organization_id: "org-newer",
        role: "COACH",
        created_at: "2026-06-01T00:00:00.000Z",
      }),
      membership({
        id: "m-older",
        organization_id: "org-older",
        role: "AGENCY_ADMIN",
        created_at: "2026-01-01T00:00:00.000Z",
      }),
    ]);

    const res = await request(buildApp())
      .get("/api/me")
      .set("Authorization", "Bearer good");

    expect(res.status).toBe(200);
    // Deterministic selection strategy: oldest active Membership wins (see
    // MULTI_MEMBERSHIP_SELECTION_STRATEGY in services/context.ts).
    expect(res.body.organizationId).toBe("org-older");
    expect(res.body.role).toBe("AGENCY_ADMIN");
  });
});
