// Unit tests for resolveAppContext, in isolation from Firestore (the
// membership lister is injected). Covers the required Phase 2 scenarios:
// known Membership -> correct context, no Membership -> safe rejection,
// inactive Membership -> not valid, multiple Memberships -> model doesn't
// break (deterministic selection).
import { describe, it, expect } from "vitest";
import type { Membership } from "../types.js";
import { resolveAppContext } from "./context.js";

function membership(overrides: Partial<Membership>): Membership {
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

describe("resolveAppContext", () => {
  it("returns the correct context for a known user with an active Membership", async () => {
    const m = membership({ organization_id: "org-acme", role: "CLIENT_ADMIN" });
    const context = await resolveAppContext("uid-1", "user@test.com", async () => [m]);

    expect(context).toEqual({
      userId: "uid-1",
      email: "user@test.com",
      organizationId: "org-acme",
      role: "CLIENT_ADMIN",
    });
  });

  it("rejects safely (returns null) when the user has no Membership at all", async () => {
    const context = await resolveAppContext("uid-1", "user@test.com", async () => []);
    expect(context).toBeNull();
  });

  it("treats an inactive Membership as not valid", async () => {
    const m = membership({ status: "inactive" });
    const context = await resolveAppContext("uid-1", "user@test.com", async () => [m]);
    expect(context).toBeNull();
  });

  it("does not break when a user has more than one Membership — picks deterministically", async () => {
    const older = membership({
      id: "m-older",
      organization_id: "org-older",
      role: "AGENCY_ADMIN",
      created_at: "2026-01-01T00:00:00.000Z",
    });
    const newer = membership({
      id: "m-newer",
      organization_id: "org-newer",
      role: "COACH",
      created_at: "2026-06-01T00:00:00.000Z",
    });

    // Order in the array must not matter — the lister could return them in
    // any order (Firestore query results aren't guaranteed ordered here).
    const context = await resolveAppContext("uid-1", "user@test.com", async () => [
      newer,
      older,
    ]);

    expect(context).toEqual({
      userId: "uid-1",
      email: "user@test.com",
      organizationId: "org-older",
      role: "AGENCY_ADMIN",
    });
  });

  it("ignores inactive memberships when picking among several", async () => {
    const inactive = membership({
      id: "m-inactive",
      organization_id: "org-inactive",
      status: "inactive",
      created_at: "2025-01-01T00:00:00.000Z", // older, but inactive
    });
    const active = membership({
      id: "m-active",
      organization_id: "org-active",
      status: "active",
      created_at: "2026-01-01T00:00:00.000Z",
    });

    const context = await resolveAppContext("uid-1", "user@test.com", async () => [
      inactive,
      active,
    ]);

    expect(context?.organizationId).toBe("org-active");
  });
});
