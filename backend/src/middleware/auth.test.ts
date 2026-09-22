// Unit tests for the requireAuth middleware, in isolation from Express and
// from real Firebase (the ID-token verifier is injected). Covers the order
// specified for Phase 1: Bearer -> verifyIdToken -> uid/email -> allowlist.
import { describe, it, expect, vi } from "vitest";
import type { Request, Response } from "express";

vi.mock("../config.js", () => ({
  config: {
    apiSharedToken: "",
    authAllowedEmails: ["allowed@test.com"],
  },
}));

import { createRequireAuth } from "./auth.js";

function mockReqRes(headers: Record<string, string> = {}) {
  const req = {
    header: (name: string) => headers[name.toLowerCase()] ?? headers[name],
  } as unknown as Request;
  const json = vi.fn();
  const status = vi.fn().mockReturnValue({ json });
  const res = { status } as unknown as Response;
  const next = vi.fn();
  return { req, res, status, json, next };
}

describe("requireAuth", () => {
  it("401s when Authorization header is missing", async () => {
    const verify = vi.fn();
    const middleware = createRequireAuth(verify);
    const { req, res, status, next } = mockReqRes();

    await middleware(req, res, next);

    expect(status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
    expect(verify).not.toHaveBeenCalled();
  });

  it("401s when the header is not a well-formed Bearer token", async () => {
    const verify = vi.fn();
    const middleware = createRequireAuth(verify);
    const { req, res, status, next } = mockReqRes({ authorization: "Token abc123" });

    await middleware(req, res, next);

    expect(status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
    expect(verify).not.toHaveBeenCalled();
  });

  it("401s when verifyIdToken rejects (invalid/expired token)", async () => {
    const verify = vi.fn().mockRejectedValue(new Error("invalid token"));
    const middleware = createRequireAuth(verify);
    const { req, res, status, next } = mockReqRes({ authorization: "Bearer bad-token" });

    await middleware(req, res, next);

    expect(verify).toHaveBeenCalledWith("bad-token");
    expect(status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("403s a valid token whose email is not in the allowlist", async () => {
    const verify = vi.fn().mockResolvedValue({ uid: "uid-1", email: "stranger@test.com" });
    const middleware = createRequireAuth(verify);
    const { req, res, status, next } = mockReqRes({ authorization: "Bearer good-token" });

    await middleware(req, res, next);

    expect(status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it("403s a valid token with no email at all", async () => {
    const verify = vi.fn().mockResolvedValue({ uid: "uid-1", email: null });
    const middleware = createRequireAuth(verify);
    const { req, res, status, next } = mockReqRes({ authorization: "Bearer good-token" });

    await middleware(req, res, next);

    expect(status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it("calls next() and attaches req.auth for a valid, allowlisted token", async () => {
    const verify = vi.fn().mockResolvedValue({ uid: "uid-1", email: "allowed@test.com" });
    const middleware = createRequireAuth(verify);
    const { req, res, status, next } = mockReqRes({ authorization: "Bearer good-token" });

    await middleware(req, res, next);

    expect(status).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
    expect(req.auth).toEqual({ uid: "uid-1", email: "allowed@test.com" });
  });

  it("allowlist match is case-insensitive on the email", async () => {
    const verify = vi.fn().mockResolvedValue({ uid: "uid-1", email: "ALLOWED@test.com" });
    const middleware = createRequireAuth(verify);
    const { req, res, status, next } = mockReqRes({ authorization: "Bearer good-token" });

    await middleware(req, res, next);

    expect(status).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
  });
});
