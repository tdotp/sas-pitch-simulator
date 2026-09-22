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
});

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
