import { describe, it, expect } from "vitest";
import { scanContentForViolations, ARCHITECTURE_RULES } from "./genericEngineScan.js";

describe("scanContentForViolations", () => {
  it("returns no violations for ordinary generic engine code", () => {
    const content = `export function computeMetrics(input: Input): Metrics {\n  return { total: input.total };\n}\n`;
    expect(scanContentForViolations("src/services/metrics.ts", content)).toEqual([]);
  });

  it("ENGINE_GENERICITY: flags a hardcoded client-specific literal in a synthetic string", () => {
    const content = `const detected = { mentioned_sas: true };\n`;
    const violations = scanContentForViolations("src/engine/fakeFile.ts", content);
    expect(violations).toHaveLength(1);
    expect(violations[0].rule).toBe("ENGINE_GENERICITY_CLIENT_LITERALS");
    expect(violations[0].line).toBe(1);
  });

  it("ENGINE_GENERICITY: flags resurrection of APP_USERS anywhere outside the allowlist", () => {
    const content = `const APP_USERS = { "a@b.com": "token" };\n`;
    const violations = scanContentForViolations("src/middleware/auth.ts", content);
    expect(violations.map((v) => v.rule)).toContain("ENGINE_GENERICITY_NO_APP_USERS");
  });

  it("ENGINE_GENERICITY: flags a hardcoded organizationId branch", () => {
    const content = `if (organizationId === "sas-colombia") { return specialCase(); }\n`;
    const violations = scanContentForViolations("src/routes.ts", content);
    expect(violations.map((v) => v.rule)).toContain("ENGINE_GENERICITY_NO_LITERAL_TENANT_BRANCH");
  });

  it("ENGINE_GENERICITY: flags lexicographic version auto-selection", () => {
    const content = `const latest = versions.sort().reverse()[0];\n`;
    const violations = scanContentForViolations("src/engine-config/resolver.ts", content);
    expect(violations.map((v) => v.rule)).toContain("ENGINE_GENERICITY_NO_LEXICOGRAPHIC_VERSION_PICK");
  });

  it("does not flag the documented historical comment in types.ts", () => {
    const content = `// used to be a fixed object with client-specific keys (mentioned_sas, aligned_to_playbook)\n`;
    expect(scanContentForViolations("src/types.ts", content)).toEqual([]);
  });

  it("does not flag the single documented x-app-token gate in routes.ts", () => {
    const content = `if (req.header("x-app-token") === config.apiSharedToken) return next();\n`;
    expect(scanContentForViolations("src/routes.ts", content)).toEqual([]);
  });

  it("every rule has at least one test exercising it (no dead rules)", () => {
    expect(ARCHITECTURE_RULES.map((r) => r.id).sort()).toEqual(
      [
        "ENGINE_GENERICITY_CLIENT_LITERALS",
        "ENGINE_GENERICITY_NO_APP_USERS",
        "ENGINE_GENERICITY_NO_LEXICOGRAPHIC_VERSION_PICK",
        "ENGINE_GENERICITY_NO_LITERAL_TENANT_BRANCH",
        "ENGINE_GENERICITY_NO_SHARED_TOKEN_IDENTITY",
      ].sort()
    );
  });
});
