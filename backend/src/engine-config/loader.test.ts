// Semantic validation tests (cross-references) — the layer beyond plain
// Zod structural checks. Built against hand-crafted ConfigPackage
// fixtures, not the real filesystem, so these stay fast and isolated
// from what's actually shipped in backend/config-packages/.
import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { validatePackageReferences, FileConfigPackageLoader } from "./loader.js";
import type { ConfigPackage } from "./schema.js";

function baseFramework(id = "framework-1") {
  return {
    id,
    name: "F",
    maxScore: 100,
    criteria: [{ id: "a", name: "A", weight: 100, description: "d" }],
    observableRules: [],
    requirements: [],
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
// test fixtures. Phase 6: `loadPackage` takes the version EXPLICITLY —
// no more "pick one for me".
describe("FileConfigPackageLoader against the real shipped packages", () => {
  const loader = new FileConfigPackageLoader();

  it("loads and validates the sas-colombia v1 package (3 scenarios, migrated content)", async () => {
    const result = await loader.loadPackage("sas-colombia", "v1");
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.pkg.scenarios.map((s) => s.id).sort()).toEqual(
        ["davivienda", "generic", "grupo_aval"].sort()
      );
      expect(result.hash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("loads and validates the acme-demo v1 package (second organization)", async () => {
    const result = await loader.loadPackage("acme-demo", "v1");
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.pkg.scenarios.map((s) => s.id)).toEqual(["generic"]);
    }
  });

  it("loads and validates the acme-demo v2 package — a real second version of the same org", async () => {
    const result = await loader.loadPackage("acme-demo", "v2");
    expect(result.valid).toBe(true);
    if (result.valid) {
      // v2 adds a scenario that v1 never had — the concrete proof for
      // "scenario existe en v2 pero no en v1 → sesión v1 NO puede usarlo".
      expect(result.pkg.scenarios.map((s) => s.id).sort()).toEqual(["generic", "press-followup"].sort());
    }
  });

  it("returns valid:false with errors for an organization with no package", async () => {
    const result = await loader.loadPackage("does-not-exist-org", "v1");
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.length).toBeGreaterThan(0);
    }
  });

  it("returns valid:false for a version id that doesn't exist under a real organization", async () => {
    const result = await loader.loadPackage("acme-demo", "v999-does-not-exist");
    expect(result.valid).toBe(false);
  });

  it("CONTENT_HASH_DECISION: same content -> same hash, deterministic across repeated loads", async () => {
    const a = await loader.loadPackage("acme-demo", "v1");
    const b = await loader.loadPackage("acme-demo", "v1");
    expect(a.valid && b.valid).toBe(true);
    if (a.valid && b.valid) expect(a.hash).toBe(b.hash);
  });

  it("CONTENT_HASH_DECISION: different versions of the same org produce different hashes", async () => {
    const v1 = await loader.loadPackage("acme-demo", "v1");
    const v2 = await loader.loadPackage("acme-demo", "v2");
    expect(v1.valid && v2.valid).toBe(true);
    if (v1.valid && v2.valid) expect(v1.hash).not.toBe(v2.hash);
  });
});

describe("FileConfigPackageLoader — manifest.version cross-check (Phase 6)", () => {
  async function writeMinimalPackage(root: string, organizationId: string, manifestVersion: string, dirName: string) {
    const base = join(root, organizationId, dirName);
    await mkdir(join(base, "interviewer-profiles"), { recursive: true });
    await mkdir(join(base, "scenarios"), { recursive: true });
    await mkdir(join(base, "evaluation-frameworks"), { recursive: true });
    await mkdir(join(base, "content"), { recursive: true });
    await writeFile(
      join(base, "manifest.json"),
      JSON.stringify({
        organizationId,
        version: manifestVersion,
        status: "active",
        interviewerProfiles: ["p1"],
        scenarios: ["s1"],
        evaluationFrameworks: ["f1"],
        contentSources: [],
      })
    );
    await writeFile(join(base, "client.json"), JSON.stringify({ organizationId, defaultLanguage: "es", settings: {} }));
    await writeFile(
      join(base, "interviewer-profiles", "p1.json"),
      JSON.stringify({
        id: "p1",
        name: "P",
        persona: "p",
        tone: "t",
        questioningBehavior: "q",
        followUpBehavior: { requiredCount: 1, specificQuestions: [], sharedQuestions: [] },
        voice: { slot: "random" },
      })
    );
    await writeFile(
      join(base, "evaluation-frameworks", "f1.json"),
      JSON.stringify({
        id: "f1",
        name: "F",
        maxScore: 100,
        criteria: [{ id: "a", name: "A", weight: 100, description: "d" }],
        observableRules: [],
        requirements: [],
        mustReward: [],
        mustPenalize: [],
        evaluationInstructions: "i",
      })
    );
    await writeFile(
      join(base, "scenarios", "s1.json"),
      JSON.stringify({
        id: "s1",
        name: "S",
        description: "d",
        interviewerProfileId: "p1",
        evaluationFrameworkId: "f1",
        contentSourceIds: [],
        timing: { idealSeconds: 90, maxSeconds: 180 },
        firstMessage: "hi",
        openingContext: "ctx",
        closingMessage: "bye",
      })
    );
  }

  it("accepts a package whose manifest.version matches the requested/directory version", async () => {
    const dir = await mkdtemp(join(tmpdir(), "loader-version-test-"));
    try {
      await writeMinimalPackage(dir, "temp-org", "v1", "v1");
      const loader = new FileConfigPackageLoader(pathToFileURL(dir + "/"));
      const result = await loader.loadPackage("temp-org", "v1");
      expect(result.valid).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects a package whose manifest.version doesn't match the requested/directory version", async () => {
    const dir = await mkdtemp(join(tmpdir(), "loader-version-test-"));
    try {
      // Directory is named "v2" but the manifest inside still says "v1" —
      // exactly the drift this cross-check exists to catch.
      await writeMinimalPackage(dir, "temp-org", "v1", "v2");
      const loader = new FileConfigPackageLoader(pathToFileURL(dir + "/"));
      const result = await loader.loadPackage("temp-org", "v2");
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.errors.some((e) => e.includes("manifest.version"))).toBe(true);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
