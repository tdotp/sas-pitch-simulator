// Unit tests for requireAnyRole, in isolation from Express.
import { describe, it, expect, vi } from "vitest";
import type { Request, Response } from "express";
import { requireAnyRole } from "./roles.js";
import type { AppContext } from "../types.js";

function mockReqRes(appContext?: AppContext) {
  const req = { appContext } as unknown as Request;
  const json = vi.fn();
  const status = vi.fn().mockReturnValue({ json });
  const res = { status } as unknown as Response;
  const next = vi.fn();
  return { req, res, status, json, next };
}

function context(overrides: Partial<AppContext> = {}): AppContext {
  return {
    userId: "uid-1",
    email: "a@test.com",
    organizationId: "org-1",
    role: "SPOKESPERSON",
    ...overrides,
  };
}

describe("requireAnyRole", () => {
  it("401s if req.appContext is missing (requireMembership did not run first)", () => {
    const middleware = requireAnyRole("AGENCY_ADMIN");
    const { req, res, status, next } = mockReqRes(undefined);

    middleware(req, res, next);

    expect(status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("403s when the context's role is not in the allowed list", () => {
    const middleware = requireAnyRole("AGENCY_ADMIN", "CLIENT_ADMIN");
    const { req, res, status, next } = mockReqRes(context({ role: "SPOKESPERSON" }));

    middleware(req, res, next);

    expect(status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it("calls next() when the context's role is in the allowed list", () => {
    const middleware = requireAnyRole("AGENCY_ADMIN", "CLIENT_ADMIN", "COACH");
    const { req, res, status, next } = mockReqRes(context({ role: "COACH" }));

    middleware(req, res, next);

    expect(status).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("SPOKESPERSON is rejected by an admin-only allowlist", () => {
    const middleware = requireAnyRole("AGENCY_ADMIN", "CLIENT_ADMIN", "COACH");
    const { req, res, status, next } = mockReqRes(context({ role: "SPOKESPERSON" }));

    middleware(req, res, next);

    expect(status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });
});
