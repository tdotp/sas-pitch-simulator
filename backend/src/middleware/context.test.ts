// Unit tests for the requireMembership middleware, in isolation from
// Express and from real Firestore (the context resolver is injected).
import { describe, it, expect, vi } from "vitest";
import type { Request, Response } from "express";
import { createRequireMembership } from "./context.js";

function mockReqRes(auth?: { uid: string; email: string | null }) {
  const req = { auth } as unknown as Request;
  const json = vi.fn();
  const status = vi.fn().mockReturnValue({ json });
  const res = { status } as unknown as Response;
  const next = vi.fn();
  return { req, res, status, json, next };
}

describe("requireMembership", () => {
  it("401s if req.auth is missing (requireAuth did not run first)", async () => {
    const resolve = vi.fn();
    const middleware = createRequireMembership(resolve);
    const { req, res, status, next } = mockReqRes(undefined);

    await middleware(req, res, next);

    expect(status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
  });

  it("403s (safe rejection) when the resolver finds no valid context", async () => {
    const resolve = vi.fn().mockResolvedValue(null);
    const middleware = createRequireMembership(resolve);
    const { req, res, status, next } = mockReqRes({ uid: "uid-1", email: "a@test.com" });

    await middleware(req, res, next);

    expect(resolve).toHaveBeenCalledWith("uid-1", "a@test.com");
    expect(status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it("attaches req.appContext and calls next() for a known user with a valid Membership", async () => {
    const context = {
      userId: "uid-1",
      email: "a@test.com",
      organizationId: "org-1",
      role: "SPOKESPERSON" as const,
    };
    const resolve = vi.fn().mockResolvedValue(context);
    const middleware = createRequireMembership(resolve);
    const { req, res, status, next } = mockReqRes({ uid: "uid-1", email: "a@test.com" });

    await middleware(req, res, next);

    expect(status).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
    expect(req.appContext).toEqual(context);
  });
});
