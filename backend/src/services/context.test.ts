// Unit tests for resolveAppContext, in isolation from Firestore (all
// dependencies are injected). Covers the required Phase 2 scenarios,
// updated for the PASS_WITH_FIXES round: no arbitrary pick among multiple
// active memberships, explicit organization_id selection (verified
// server-side, never trusted as authority), resolver failure handling
// lives in the middleware test, and User/Organization status now gate
// eligibility alongside Membership status.
import { describe, it, expect } from "vitest";
import type { ContextResolutionDeps } from "./context.js";
import type { AppUser, Membership, Organization } from "../types.js";
import { resolveAppContext } from "./context.js";

function user(overrides: Partial<AppUser> = {}): AppUser {
  return {
    uid: "uid-1",
    email: "user@test.com",
    display_name: null,
    status: "active",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function membership(overrides: Partial<Membership> = {}): Membership {
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

function organization(overrides: Partial<Organization> = {}): Organization {
  return {
    id: "org-1",
    name: "Org 1",
    slug: "org-1",
    status: "active",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

// Builds a deps object where getOrganization returns an active org for
// every membership by default (id derived from the membership's
// organization_id), so tests only need to override what they care about.
function makeDeps(overrides: Partial<ContextResolutionDeps> = {}): ContextResolutionDeps {
  return {
    getUser: async () => user(),
    listMembershipsByUser: async () => [],
    getOrganization: async (id: string) => organization({ id, slug: id }),
    ...overrides,
  };
}

describe("resolveAppContext", () => {
  it("returns ok with the correct context for a known user with exactly one eligible Membership", async () => {
    const m = membership({ organization_id: "org-acme", role: "CLIENT_ADMIN" });
    const deps = makeDeps({ listMembershipsByUser: async () => [m] });

    const result = await resolveAppContext("uid-1", "user@test.com", null, deps);

    expect(result).toEqual({
      type: "ok",
      context: {
        userId: "uid-1",
        email: "user@test.com",
        organizationId: "org-acme",
        role: "CLIENT_ADMIN",
      },
    });
  });

  it("returns no_membership when the user has no Membership at all", async () => {
    const deps = makeDeps({ listMembershipsByUser: async () => [] });
    const result = await resolveAppContext("uid-1", "user@test.com", null, deps);
    expect(result).toEqual({ type: "no_membership" });
  });

  it("treats an inactive Membership as not eligible", async () => {
    const m = membership({ status: "inactive" });
    const deps = makeDeps({ listMembershipsByUser: async () => [m] });
    const result = await resolveAppContext("uid-1", "user@test.com", null, deps);
    expect(result).toEqual({ type: "no_membership" });
  });

  it("does NOT pick arbitrarily among several active memberships — requires selection", async () => {
    const m1 = membership({ id: "m1", organization_id: "org-a", role: "AGENCY_ADMIN" });
    const m2 = membership({ id: "m2", organization_id: "org-b", role: "COACH" });
    const deps = makeDeps({ listMembershipsByUser: async () => [m1, m2] });

    const result = await resolveAppContext("uid-1", "user@test.com", null, deps);

    expect(result.type).toBe("selection_required");
    if (result.type === "selection_required") {
      expect(new Set(result.organizationIds)).toEqual(new Set(["org-a", "org-b"]));
    }
  });

  it("resolves ok when the caller selects an organization it actually belongs to", async () => {
    const m1 = membership({ id: "m1", organization_id: "org-a", role: "AGENCY_ADMIN" });
    const m2 = membership({ id: "m2", organization_id: "org-b", role: "COACH" });
    const deps = makeDeps({ listMembershipsByUser: async () => [m1, m2] });

    const result = await resolveAppContext("uid-1", "user@test.com", "org-b", deps);

    expect(result).toEqual({
      type: "ok",
      context: { userId: "uid-1", email: "user@test.com", organizationId: "org-b", role: "COACH" },
    });
  });

  it("rejects a selection of an organization the caller does not belong to", async () => {
    const m1 = membership({ id: "m1", organization_id: "org-a" });
    const deps = makeDeps({ listMembershipsByUser: async () => [m1] });

    const result = await resolveAppContext("uid-1", "user@test.com", "org-not-mine", deps);

    expect(result).toEqual({ type: "forbidden_organization" });
  });

  it("rejects a selection that matches an INACTIVE membership when the caller has no eligible memberships at all", async () => {
    const m1 = membership({ id: "m1", organization_id: "org-a", status: "inactive" });
    const deps = makeDeps({ listMembershipsByUser: async () => [m1] });

    const result = await resolveAppContext("uid-1", "user@test.com", "org-a", deps);

    // With zero ELIGIBLE memberships total, the response is the broader
    // "no_membership" rather than "forbidden_organization" — the caller
    // has nothing, regardless of what they asked for.
    expect(result).toEqual({ type: "no_membership" });
  });

  it("rejects a selection of an INACTIVE membership even when the caller has a different eligible one", async () => {
    const inactive = membership({ id: "m1", organization_id: "org-inactive", status: "inactive" });
    const active = membership({ id: "m2", organization_id: "org-active", status: "active" });
    const deps = makeDeps({ listMembershipsByUser: async () => [inactive, active] });

    // Caller has org-active available, but explicitly asks for
    // org-inactive (where their membership is inactive) — must be
    // rejected, never silently swapped for org-active either.
    const result = await resolveAppContext("uid-1", "user@test.com", "org-inactive", deps);

    expect(result).toEqual({ type: "forbidden_organization" });
  });

  it("does not break with more than two active memberships — still requires selection", async () => {
    const memberships = [
      membership({ id: "m1", organization_id: "org-a" }),
      membership({ id: "m2", organization_id: "org-b" }),
      membership({ id: "m3", organization_id: "org-c" }),
    ];
    const deps = makeDeps({ listMembershipsByUser: async () => memberships });

    const result = await resolveAppContext("uid-1", "user@test.com", null, deps);

    expect(result.type).toBe("selection_required");
    if (result.type === "selection_required") {
      expect(result.organizationIds).toHaveLength(3);
    }
  });

  // ── User/Organization status now gate eligibility too (PASS_WITH_FIXES) ──

  it("rejects when the AppUser is inactive, even with an active Membership", async () => {
    const deps = makeDeps({
      getUser: async () => user({ status: "inactive" }),
      listMembershipsByUser: async () => [membership()],
    });

    const result = await resolveAppContext("uid-1", "user@test.com", null, deps);
    expect(result).toEqual({ type: "no_membership" });
  });

  it("rejects when there is no AppUser record at all", async () => {
    const deps = makeDeps({
      getUser: async () => null,
      listMembershipsByUser: async () => [membership()],
    });

    const result = await resolveAppContext("uid-1", "user@test.com", null, deps);
    expect(result).toEqual({ type: "no_membership" });
  });

  it("excludes a Membership whose Organization is inactive", async () => {
    const m = membership({ organization_id: "org-inactive" });
    const deps = makeDeps({
      listMembershipsByUser: async () => [m],
      getOrganization: async () => organization({ id: "org-inactive", status: "inactive" }),
    });

    const result = await resolveAppContext("uid-1", "user@test.com", null, deps);
    expect(result).toEqual({ type: "no_membership" });
  });

  it("with two memberships where only one org is active, resolves that one automatically (not ambiguous)", async () => {
    const active = membership({ id: "m-active", organization_id: "org-active" });
    const inactiveOrg = membership({ id: "m-inactive-org", organization_id: "org-deactivated" });
    const deps = makeDeps({
      listMembershipsByUser: async () => [active, inactiveOrg],
      getOrganization: async (id: string) =>
        id === "org-deactivated"
          ? organization({ id, status: "inactive" })
          : organization({ id, status: "active" }),
    });

    const result = await resolveAppContext("uid-1", "user@test.com", null, deps);

    expect(result).toEqual({
      type: "ok",
      context: {
        userId: "uid-1",
        email: "user@test.com",
        organizationId: "org-active",
        role: "SPOKESPERSON",
      },
    });
  });
});
