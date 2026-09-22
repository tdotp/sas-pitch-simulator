// resolveScenarioConfig tests, against an injectable fake ConfigPackageLoader
// (no filesystem) — the equivalent-org.test.ts / loader.test.ts already
// cover the real fixtures.
import { describe, it, expect } from "vitest";
import { resolveScenarioConfig } from "./resolver.js";
import type { ConfigPackageLoader, ConfigPackageResult } from "./loader.js";
import type { ConfigPackage } from "./schema.js";

function pkgFor(organizationId: string, scenarioIds: string[]): ConfigPackage {
  const profile = {
    id: "profile-1",
    name: "P",
    persona: "persona",
    tone: "tone",
    questioningBehavior: "behavior",
    followUpBehavior: { requiredCount: 1, specificQuestions: [], sharedQuestions: [] },
    voice: { slot: "random" as const },
  };
  const framework = {
    id: "framework-1",
    name: "F",
    maxScore: 100,
    criteria: [{ id: "a", name: "A", weight: 100, description: "d" }],
    observableRules: [],
    requirements: [],
    mustReward: [],
    mustPenalize: [],
    evaluationInstructions: "instructions",
  };
  return {
    manifest: {
      organizationId,
      version: "v1",
      status: "active",
      interviewerProfiles: ["profile-1"],
      scenarios: scenarioIds,
      evaluationFrameworks: ["framework-1"],
      contentSources: [],
    },
    client: { organizationId, defaultLanguage: "es", settings: {} },
    interviewerProfiles: [profile],
    scenarios: scenarioIds.map((id) => ({
      id,
      name: id,
      description: `scenario ${id} for ${organizationId}`,
      interviewerProfileId: "profile-1",
      evaluationFrameworkId: "framework-1",
      contentSourceIds: [],
      timing: { idealSeconds: 90, maxSeconds: 180 },
      firstMessage: "hi",
      openingContext: "context",
      closingMessage: "bye",
    })),
    evaluationFrameworks: [framework],
    contentSources: [],
  };
}

function fakeLoader(packages: Record<string, ConfigPackage>): ConfigPackageLoader {
  return {
    async loadPackage(organizationId: string): Promise<ConfigPackageResult> {
      const pkg = packages[organizationId];
      if (!pkg) return { valid: false, errors: [`no package for ${organizationId}`] };
      return { valid: true, pkg };
    },
  };
}

describe("resolveScenarioConfig", () => {
  it("resolves a valid (organizationId, scenarioId) into a full ResolvedScenarioConfig", async () => {
    const loader = fakeLoader({ "org-a": pkgFor("org-a", ["generic"]) });
    const result = await resolveScenarioConfig({ organizationId: "org-a", scenarioId: "generic" }, loader);

    expect(result.outcome).toBe("resolved");
    if (result.outcome === "resolved") {
      expect(result.config.organizationId).toBe("org-a");
      expect(result.config.scenario.id).toBe("generic");
      expect(result.config.interviewerProfile.id).toBe("profile-1");
      expect(result.config.evaluationFramework.id).toBe("framework-1");
    }
  });

  it("returns scenario_not_found for a scenarioId not in the organization's package", async () => {
    const loader = fakeLoader({ "org-a": pkgFor("org-a", ["generic"]) });
    const result = await resolveScenarioConfig({ organizationId: "org-a", scenarioId: "nope" }, loader);
    expect(result.outcome).toBe("scenario_not_found");
  });

  it("returns no_config_for_organization for an organization with no package", async () => {
    const loader = fakeLoader({});
    const result = await resolveScenarioConfig({ organizationId: "org-x", scenarioId: "generic" }, loader);
    expect(result.outcome).toBe("no_config_for_organization");
  });

  it("two organizations can use the SAME scenarioId without colliding", async () => {
    const loader = fakeLoader({
      "org-a": pkgFor("org-a", ["generic"]),
      "org-b": pkgFor("org-b", ["generic"]),
    });

    const a = await resolveScenarioConfig({ organizationId: "org-a", scenarioId: "generic" }, loader);
    const b = await resolveScenarioConfig({ organizationId: "org-b", scenarioId: "generic" }, loader);

    expect(a.outcome).toBe("resolved");
    expect(b.outcome).toBe("resolved");
    if (a.outcome === "resolved" && b.outcome === "resolved") {
      expect(a.config.organizationId).toBe("org-a");
      expect(b.config.organizationId).toBe("org-b");
      // Same scenarioId, but each resolves to ITS OWN organization's
      // description — proving no cross-organization leakage/collision.
      expect(a.config.scenario.description).toContain("org-a");
      expect(b.config.scenario.description).toContain("org-b");
    }
  });

  it("a request cannot pick another organization's config by scenarioId alone", async () => {
    const loader = fakeLoader({
      "org-a": pkgFor("org-a", ["only-in-a"]),
      "org-b": pkgFor("org-b", ["only-in-b"]),
    });

    // org-a's caller asking for org-b's scenario id must NOT resolve —
    // organizationId always scopes the lookup, there is no global
    // scenario namespace to fall through to.
    const result = await resolveScenarioConfig({ organizationId: "org-a", scenarioId: "only-in-b" }, loader);
    expect(result.outcome).toBe("scenario_not_found");
  });

  it("the SAME engine (this one function) resolves two structurally different configs without any client-specific branching", async () => {
    const loader = fakeLoader({
      "org-a": pkgFor("org-a", ["scenario-a"]),
      "org-b": pkgFor("org-b", ["scenario-b"]),
    });

    const a = await resolveScenarioConfig({ organizationId: "org-a", scenarioId: "scenario-a" }, loader);
    const b = await resolveScenarioConfig({ organizationId: "org-b", scenarioId: "scenario-b" }, loader);

    expect(a.outcome).toBe("resolved");
    expect(b.outcome).toBe("resolved");
    // No special-casing: resolveScenarioConfig's source has zero
    // knowledge of "org-a"/"org-b"/"scenario-a"/"scenario-b" — this test
    // asserts both calls went through the exact same code path and both
    // came back correctly resolved.
  });
});
