// Unit tests for the requireAuth middleware, in isolation from Express and
// from real Firebase (the ID-token verifier is injected). Covers identity
// verification only: Bearer -> verifyIdToken -> uid/email. Authorization
// (allowlist through Phase 2, Membership/RBAC from Phase 3) is NOT this
// middleware's job anymore — see auth.ts's history comment and
// middleware/context.test.ts / middleware/roles.test.ts for that.
import { describe, it, expect, vi } from "vitest";
import type { Request, Response } from "express";
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

  it("calls next() and attaches req.auth for any valid token, regardless of email", async () => {
    const verify = vi.fn().mockResolvedValue({ uid: "uid-1", email: "anyone@test.com" });
    const middleware = createRequireAuth(verify);
    const { req, res, status, next } = mockReqRes({ authorization: "Bearer good-token" });

    await middleware(req, res, next);

    expect(status).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
    expect(req.auth).toEqual({ uid: "uid-1", email: "anyone@test.com" });
  });

  it("calls next() and attaches req.auth for a valid token with no email at all", async () => {
    const verify = vi.fn().mockResolvedValue({ uid: "uid-1", email: null });
    const middleware = createRequireAuth(verify);
    const { req, res, status, next } = mockReqRes({ authorization: "Bearer good-token" });

    await middleware(req, res, next);

    expect(status).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
    expect(req.auth).toEqual({ uid: "uid-1", email: null });
  });
});
