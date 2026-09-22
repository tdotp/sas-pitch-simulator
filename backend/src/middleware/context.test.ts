// Unit tests for the requireMembership middleware, in isolation from
// Express and from real Firestore (the context resolver is injected).
// Updated for the PASS_WITH_FIXES round: covers every ContextResolution
// outcome (ok / no_membership / selection_required / forbidden_organization)
// and — the main fix in this round — that a throwing/rejecting resolver is
// caught, fails closed, and never calls next().
import { describe, it, expect, vi } from "vitest";
import type { Request, Response } from "express";
import { createRequireMembership } from "./context.js";

function mockReqRes(
  auth?: { uid: string; email: string | null },
  query: Record<string, unknown> = {}
) {
  const req = { auth, query } as unknown as Request;
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

  it("403s (safe rejection) on no_membership", async () => {
    const resolve = vi.fn().mockResolvedValue({ type: "no_membership" });
    const middleware = createRequireMembership(resolve);
    const { req, res, status, next } = mockReqRes({ uid: "uid-1", email: "a@test.com" });

    await middleware(req, res, next);

    expect(resolve).toHaveBeenCalledWith("uid-1", "a@test.com", null);
    expect(status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it("409s on selection_required and never calls next()", async () => {
    const resolve = vi
      .fn()
      .mockResolvedValue({ type: "selection_required", organizationIds: ["org-a", "org-b"] });
    const middleware = createRequireMembership(resolve);
    const { req, res, status, json, next } = mockReqRes({ uid: "uid-1", email: "a@test.com" });

    await middleware(req, res, next);

    expect(status).toHaveBeenCalledWith(409);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ organization_ids: ["org-a", "org-b"] })
    );
    expect(next).not.toHaveBeenCalled();
  });

  it("403s on forbidden_organization (requested org the caller doesn't belong to)", async () => {
    const resolve = vi.fn().mockResolvedValue({ type: "forbidden_organization" });
    const middleware = createRequireMembership(resolve);
    const { req, res, status, next } = mockReqRes(
      { uid: "uid-1", email: "a@test.com" },
      { organization_id: "org-not-mine" }
    );

    await middleware(req, res, next);

    expect(resolve).toHaveBeenCalledWith("uid-1", "a@test.com", "org-not-mine");
    expect(status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it("attaches req.appContext and calls next() on ok", async () => {
    const context = {
      userId: "uid-1",
      email: "a@test.com",
      organizationId: "org-1",
      role: "SPOKESPERSON" as const,
    };
    const resolve = vi.fn().mockResolvedValue({ type: "ok", context });
    const middleware = createRequireMembership(resolve);
    const { req, res, status, next } = mockReqRes({ uid: "uid-1", email: "a@test.com" });

    await middleware(req, res, next);

    expect(status).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
    expect(req.appContext).toEqual(context);
  });

  it("reads ?organization_id from the query and passes it to the resolver as a selection", async () => {
    const resolve = vi.fn().mockResolvedValue({
      type: "ok",
      context: { userId: "uid-1", email: "a@test.com", organizationId: "org-x", role: "COACH" },
    });
    const middleware = createRequireMembership(resolve);
    const { req, res, next } = mockReqRes(
      { uid: "uid-1", email: "a@test.com" },
      { organization_id: "org-x" }
    );

    await middleware(req, res, next);

    expect(resolve).toHaveBeenCalledWith("uid-1", "a@test.com", "org-x");
    expect(next).toHaveBeenCalledTimes(1);
  });

  // ── Main fix in this round: a failing resolver must fail closed ──

  it("fails closed (503) and never calls next() when the resolver rejects", async () => {
    const resolve = vi.fn().mockRejectedValue(new Error("Firestore is down"));
    const middleware = createRequireMembership(resolve);
    const { req, res, status, next } = mockReqRes({ uid: "uid-1", email: "a@test.com" });

    await middleware(req, res, next);

    expect(status).toHaveBeenCalledWith(503);
    expect(next).not.toHaveBeenCalled();
    expect(req.appContext).toBeUndefined();
  });

  it("fails closed (503) and never calls next() when the resolver throws synchronously", async () => {
    const resolve = vi.fn(() => {
      throw new Error("boom");
    }) as unknown as Parameters<typeof createRequireMembership>[0];
    const middleware = createRequireMembership(resolve);
    const { req, res, status, next } = mockReqRes({ uid: "uid-1", email: "a@test.com" });

    await middleware(req, res, next);

    expect(status).toHaveBeenCalledWith(503);
    expect(next).not.toHaveBeenCalled();
  });

  it("never leaks the raw error message to the client on resolver failure", async () => {
    const resolve = vi.fn().mockRejectedValue(new Error("service_account.json contents: ..."));
    const middleware = createRequireMembership(resolve);
    const { req, res, json, next } = mockReqRes({ uid: "uid-1", email: "a@test.com" });

    await middleware(req, res, next);

    const body = json.mock.calls[0][0] as { error: string };
    expect(body.error).not.toContain("service_account.json");
    expect(next).not.toHaveBeenCalled();
  });
});
