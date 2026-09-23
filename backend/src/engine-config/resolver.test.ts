// resolveScenarioConfigForNewSession / resolveScenarioConfigForVersion
// tests, against injectable fakes (no filesystem, no Firestore) — the
// real shipped packages are covered separately in loader.test.ts, and the
// full HTTP-level pinning story (start with v1, activate v2, end still
// uses v1) is covered in routes.test.ts's "Phase 6" describe block.
import { describe, it, expect } from "vitest";
import { resolveScenarioConfigForNewSession, resolveScenarioConfigForVersion } from "./resolver.js";
import type { ConfigVersionRegistry } from "./resolver.js";
import type { ConfigPackageLoader, ConfigPackageResult } from "./loader.js";
import type { ConfigPackage } from "./schema.js";

function pkgFor(organizationId: string, version: string, scenarioIds: string[]): ConfigPackage {
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
      version,
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
      description: `scenario ${id} for ${organizationId}@${version}`,
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

// Keyed by `${organizationId}::${version}` — mirrors the real loader's
// (organizationId, version) contract exactly, so these fakes exercise the
// resolver the same way the real FileConfigPackageLoader would.
function fakeLoader(packages: Record<string, ConfigPackage>): ConfigPackageLoader {
  return {
    async loadPackage(organizationId: string, version: string): Promise<ConfigPackageResult> {
      const pkg = packages[`${organizationId}::${version}`];
      if (!pkg) return { valid: false, errors: [`no package for ${organizationId}@${version}`] };
      return { valid: true, pkg, hash: `fake-hash:${organizationId}:${version}` };
    },
  };
}

// recordedHashesByOrgVersion, keyed `${organizationId}::${version}`: when
// absent for a given (org, version), getVersion returns null and the
// resolver's drift check is a no-op (existing tests don't care about
// hashes) — pass an explicit entry to simulate a real activation-time
// hash, matching or not, per test.
function fakeRegistry(
  activeByOrg: Record<string, string | null>,
  recordedHashesByOrgVersion: Record<string, string> = {}
): ConfigVersionRegistry {
  return {
    async resolveActiveVersion(organizationId: string) {
      return activeByOrg[organizationId] ?? null;
    },
    async getVersion(organizationId: string, version: string) {
      const key = `${organizationId}::${version}`;
      if (!(key in recordedHashesByOrgVersion)) return null;
      return { configHash: recordedHashesByOrgVersion[key] };
    },
  };
}

describe("resolveScenarioConfigForNewSession", () => {
  it("resolves using the ACTIVE version from the registry — never a directory guess", async () => {
    const loader = fakeLoader({ "org-a::v1": pkgFor("org-a", "v1", ["generic"]) });
    const registry = fakeRegistry({ "org-a": "v1" });

    const result = await resolveScenarioConfigForNewSession(
      { organizationId: "org-a", scenarioId: "generic" },
      { loader, registry }
    );

    expect(result.outcome).toBe("resolved");
    if (result.outcome === "resolved") {
      expect(result.config.organizationId).toBe("org-a");
      expect(result.config.configVersion).toBe("v1");
      expect(result.config.configHash).toBeTruthy();
      expect(result.config.scenario.id).toBe("generic");
    }
  });

  it("returns no_config_for_organization when nothing is registered ACTIVE", async () => {
    const loader = fakeLoader({ "org-a::v1": pkgFor("org-a", "v1", ["generic"]) });
    const registry = fakeRegistry({}); // no active version registered

    const result = await resolveScenarioConfigForNewSession(
      { organizationId: "org-a", scenarioId: "generic" },
      { loader, registry }
    );
    expect(result.outcome).toBe("no_config_for_organization");
  });

  it("returns scenario_not_found for a scenarioId not in the ACTIVE version's package", async () => {
    const loader = fakeLoader({ "org-a::v1": pkgFor("org-a", "v1", ["generic"]) });
    const registry = fakeRegistry({ "org-a": "v1" });

    const result = await resolveScenarioConfigForNewSession(
      { organizationId: "org-a", scenarioId: "nope" },
      { loader, registry }
    );
    expect(result.outcome).toBe("scenario_not_found");
  });

  it("two organizations can use the SAME scenarioId, each resolving through the same code without colliding", async () => {
    const loader = fakeLoader({
      "org-a::v1": pkgFor("org-a", "v1", ["generic"]),
      "org-b::v1": pkgFor("org-b", "v1", ["generic"]),
    });
    const registry = fakeRegistry({ "org-a": "v1", "org-b": "v1" });

    const a = await resolveScenarioConfigForNewSession({ organizationId: "org-a", scenarioId: "generic" }, { loader, registry });
    const b = await resolveScenarioConfigForNewSession({ organizationId: "org-b", scenarioId: "generic" }, { loader, registry });

    expect(a.outcome).toBe("resolved");
    expect(b.outcome).toBe("resolved");
    if (a.outcome === "resolved" && b.outcome === "resolved") {
      expect(a.config.scenario.description).toContain("org-a");
      expect(b.config.scenario.description).toContain("org-b");
    }
  });

  it("picks up a newly activated version — the registry, not a cached decision, governs new sessions", async () => {
    const loader = fakeLoader({
      "org-a::v1": pkgFor("org-a", "v1", ["generic"]),
      "org-a::v2": pkgFor("org-a", "v2", ["generic", "press-followup"]),
    });

    const beforeActivation = await resolveScenarioConfigForNewSession(
      { organizationId: "org-a", scenarioId: "generic" },
      { loader, registry: fakeRegistry({ "org-a": "v1" }) }
    );
    const afterActivation = await resolveScenarioConfigForNewSession(
      { organizationId: "org-a", scenarioId: "generic" },
      { loader, registry: fakeRegistry({ "org-a": "v2" }) }
    );

    expect(beforeActivation.outcome === "resolved" && beforeActivation.config.configVersion).toBe("v1");
    expect(afterActivation.outcome === "resolved" && afterActivation.config.configVersion).toBe("v2");
  });

  it("CONFIG_DRIFT_DETECTION: refuses a new session when the active version's files were edited since activation", async () => {
    const loader = fakeLoader({ "org-a::v1": pkgFor("org-a", "v1", ["generic"]) });
    // Registry recorded "AAA" when v1 was activated; the loader (i.e. the
    // files on disk right now) hashes to something else — simulating an
    // in-place edit after activation, without re-activating.
    const registry = fakeRegistry({ "org-a": "v1" }, { "org-a::v1": "AAA-stale-hash-from-activation" });

    const result = await resolveScenarioConfigForNewSession(
      { organizationId: "org-a", scenarioId: "generic" },
      { loader, registry }
    );
    expect(result.outcome).toBe("no_config_for_organization");
  });

  it("no drift: the registry's recorded hash matching the current file hash resolves normally", async () => {
    const loader = fakeLoader({ "org-a::v1": pkgFor("org-a", "v1", ["generic"]) });
    // fakeLoader's hash convention is `fake-hash:${org}:${version}` —
    // recording exactly that simulates "activation and files agree".
    const registry = fakeRegistry({ "org-a": "v1" }, { "org-a::v1": "fake-hash:org-a:v1" });

    const result = await resolveScenarioConfigForNewSession(
      { organizationId: "org-a", scenarioId: "generic" },
      { loader, registry }
    );
    expect(result.outcome).toBe("resolved");
  });
});

describe("resolveScenarioConfigForVersion", () => {
  it("resolves EXACTLY the pinned version, ignoring what the registry would consider active", async () => {
    const loader = fakeLoader({
      "org-a::v1": pkgFor("org-a", "v1", ["generic"]),
      "org-a::v2": pkgFor("org-a", "v2", ["generic", "press-followup"]),
    });

    // No registry dependency at all — this is the point: a pinned session
    // must resolve the same way no matter what's active today.
    const result = await resolveScenarioConfigForVersion(
      { organizationId: "org-a", scenarioId: "generic", configVersion: "v1" },
      { loader }
    );
    expect(result.outcome).toBe("resolved");
    if (result.outcome === "resolved") expect(result.config.configVersion).toBe("v1");
  });

  it("a scenario that exists in v2 but not v1 cannot be reached through a v1 pin", async () => {
    const loader = fakeLoader({
      "org-a::v1": pkgFor("org-a", "v1", ["generic"]),
      "org-a::v2": pkgFor("org-a", "v2", ["generic", "press-followup"]),
    });

    const result = await resolveScenarioConfigForVersion(
      { organizationId: "org-a", scenarioId: "press-followup", configVersion: "v1" },
      { loader }
    );
    expect(result.outcome).toBe("scenario_not_found");
  });

  it("returns unknown_config_version for a version id that doesn't exist — fails closed, never substitutes", async () => {
    const loader = fakeLoader({ "org-a::v1": pkgFor("org-a", "v1", ["generic"]) });

    const result = await resolveScenarioConfigForVersion(
      { organizationId: "org-a", scenarioId: "generic", configVersion: "v-does-not-exist" },
      { loader }
    );
    expect(result.outcome).toBe("unknown_config_version");
  });

  it("still resolves a version even when it's no longer the active one (DEPRECATION_FLOW: historical sessions keep working)", async () => {
    // No registry involved — a deprecated version's FILES are untouched;
    // this function never asks the registry whether the version is still
    // active, so deprecation has zero effect on this path by construction.
    const loader = fakeLoader({ "org-a::v1": pkgFor("org-a", "v1", ["generic"]) });
    const result = await resolveScenarioConfigForVersion(
      { organizationId: "org-a", scenarioId: "generic", configVersion: "v1" },
      { loader }
    );
    expect(result.outcome).toBe("resolved");
  });

  it("a request cannot pick another organization's config by scenarioId alone", async () => {
    const loader = fakeLoader({
      "org-a::v1": pkgFor("org-a", "v1", ["only-in-a"]),
      "org-b::v1": pkgFor("org-b", "v1", ["only-in-b"]),
    });
    const result = await resolveScenarioConfigForVersion(
      { organizationId: "org-a", scenarioId: "only-in-b", configVersion: "v1" },
      { loader }
    );
    expect(result.outcome).toBe("scenario_not_found");
  });
});
