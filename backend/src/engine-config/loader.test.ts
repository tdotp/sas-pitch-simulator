// Semantic validation tests (cross-references) — the layer beyond plain
// Zod structural checks. Built against hand-crafted ConfigPackage
// fixtures, not the real filesystem, so these stay fast and isolated
// from what's actually shipped in backend/config-packages/.
import { describe, it, expect } from "vitest";
import { validatePackageReferences, FileConfigPackageLoader } from "./loader.js";
import type { ConfigPackage } from "./schema.js";

function baseFramework(id = "framework-1") {
  return {
    id,
    name: "F",
    maxScore: 100,
    criteria: [{ id: "a", name: "A", weight: 100, description: "d" }],
    observableRules: [],
    mustReward: [],
    mustPenalize: [],
    evaluationInstructions: "instructions",
  };
}

function baseProfile(id = "profile-1") {
  return {
    id,
    name: "P",
    persona: "persona",
    tone: "tone",
    questioningBehavior: "behavior",
    followUpBehavior: { requiredCount: 1, specificQuestions: [], sharedQuestions: [] },
    voice: { slot: "random" as const },
  };
}

function baseScenario(overrides: Partial<ConfigPackage["scenarios"][number]> = {}) {
  return {
    id: "scenario-1",
    name: "S",
    description: "d",
    interviewerProfileId: "profile-1",
    evaluationFrameworkId: "framework-1",
    contentSourceIds: [] as string[],
    timing: { idealSeconds: 90, maxSeconds: 180 },
    firstMessage: "hi",
    openingContext: "context",
    closingMessage: "bye",
    ...overrides,
  };
}

function basePackage(overrides: Partial<ConfigPackage> = {}): ConfigPackage {
  return {
    manifest: {
      organizationId: "org-1",
      version: "v1",
      status: "active",
      interviewerProfiles: ["profile-1"],
      scenarios: ["scenario-1"],
      evaluationFrameworks: ["framework-1"],
      contentSources: [],
    },
    client: { organizationId: "org-1", defaultLanguage: "es", settings: {} },
    interviewerProfiles: [baseProfile()],
    scenarios: [baseScenario()],
    evaluationFrameworks: [baseFramework()],
    contentSources: [],
    ...overrides,
  };
}

describe("validatePackageReferences", () => {
  it("returns no errors for an internally-consistent package", () => {
    expect(validatePackageReferences(basePackage())).toEqual([]);
  });

  it("rejects a scenario referencing a nonexistent interviewerProfileId", () => {
    const pkg = basePackage({ scenarios: [baseScenario({ interviewerProfileId: "does-not-exist" })] });
    const errors = validatePackageReferences(pkg);
    expect(errors.some((e) => e.includes("interviewerProfileId"))).toBe(true);
  });

  it("rejects a scenario referencing a nonexistent evaluationFrameworkId", () => {
    const pkg = basePackage({ scenarios: [baseScenario({ evaluationFrameworkId: "does-not-exist" })] });
    const errors = validatePackageReferences(pkg);
    expect(errors.some((e) => e.includes("evaluationFrameworkId"))).toBe(true);
  });

  it("rejects a scenario referencing a nonexistent contentSourceId", () => {
    const pkg = basePackage({ scenarios: [baseScenario({ contentSourceIds: ["missing-content"] })] });
    const errors = validatePackageReferences(pkg);
    expect(errors.some((e) => e.includes("contentSourceId"))).toBe(true);
  });

  it("rejects duplicate scenario ids", () => {
    const pkg = basePackage({
      scenarios: [baseScenario(), baseScenario()],
      manifest: {
        ...basePackage().manifest,
        scenarios: ["scenario-1"], // manifest only lists it once; the dupe is the point
      },
    });
    const errors = validatePackageReferences(pkg);
    expect(errors.some((e) => e.includes("duplicados") && e.includes("scenarios"))).toBe(true);
  });

  it("rejects duplicate interviewer profile ids", () => {
    const pkg = basePackage({ interviewerProfiles: [baseProfile(), baseProfile()] });
    const errors = validatePackageReferences(pkg);
    expect(errors.some((e) => e.includes("duplicados") && e.includes("interviewer-profiles"))).toBe(true);
  });

  it("rejects an invalid client.defaultScenarioId", () => {
    const pkg = basePackage();
    pkg.client = { ...pkg.client, defaultScenarioId: "not-a-real-scenario" };
    const errors = validatePackageReferences(pkg);
    expect(errors.some((e) => e.includes("defaultScenarioId"))).toBe(true);
  });

  it("rejects a manifest that declares an id not actually present on disk", () => {
    const pkg = basePackage();
    pkg.manifest = { ...pkg.manifest, scenarios: ["scenario-1", "ghost-scenario"] };
    const errors = validatePackageReferences(pkg);
    expect(errors.some((e) => e.includes("ghost-scenario"))).toBe(true);
  });

  it("rejects an entity present on disk but missing from the manifest", () => {
    const pkg = basePackage();
    pkg.manifest = { ...pkg.manifest, scenarios: [] };
    const errors = validatePackageReferences(pkg);
    expect(errors.some((e) => e.includes("scenario-1") && e.includes("no está declarado"))).toBe(true);
  });
});

// Against the REAL fixture packages shipped in backend/config-packages/ —
// proves the actual content migrated from the old hardcoded modules
// passes both structural and semantic validation, not just hand-built
// test fixtures.
describe("FileConfigPackageLoader against the real shipped packages", () => {
  const loader = new FileConfigPackageLoader();

  it("loads and validates the sas-colombia package (3 scenarios, migrated content)", async () => {
    const result = await loader.loadPackage("sas-colombia");
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.pkg.scenarios.map((s) => s.id).sort()).toEqual(
        ["davivienda", "generic", "grupo_aval"].sort()
      );
    }
  });

  it("loads and validates the acme-demo package (second organization)", async () => {
    const result = await loader.loadPackage("acme-demo");
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.pkg.scenarios.map((s) => s.id)).toEqual(["generic"]);
    }
  });

  it("returns valid:false with errors for an organization with no package", async () => {
    const result = await loader.loadPackage("does-not-exist-org");
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.length).toBeGreaterThan(0);
    }
  });
});
