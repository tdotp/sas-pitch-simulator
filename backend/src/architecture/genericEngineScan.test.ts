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

  // PASS_WITH_FIXES ronda 1, P1: ENGINE_GENERICITY_NO_LITERAL_TENANT_BRANCH
  // only catches an `=== "org-id"` branch — a bare hardcoded org id with no
  // branch at all (a constant, an array membership check, ...) slipped
  // through undetected. These two are the exact regressions the review
  // called out.
  it("ENGINE_GENERICITY: flags a bare known-organizationId literal with no '===' branch at all", () => {
    const content = `const DEFAULT_ORG = "sas-colombia";\n`;
    const violations = scanContentForViolations("src/engine/fakeFile.ts", content);
    expect(violations.map((v) => v.rule)).toContain("ENGINE_GENERICITY_NO_ORG_ID_LITERAL");
  });

  it("ENGINE_GENERICITY: flags a known-organizationId literal inside an array literal", () => {
    const content = `const supportedOrganizations = ["acme-demo"];\n`;
    const violations = scanContentForViolations("src/engine/fakeFile.ts", content);
    expect(violations.map((v) => v.rule)).toContain("ENGINE_GENERICITY_NO_ORG_ID_LITERAL");
  });

  it("does not flag an unrelated string that merely starts with a known org id", () => {
    // precision guard: "sas-colombia-something-else" is NOT the literal
    // org id and must not be treated as one.
    const content = `const scenarioLabel = "sas-colombia-legacy-import";\n`;
    expect(scanContentForViolations("src/engine/fakeFile.ts", content)).toEqual([]);
  });

  it("does not flag the documented explanatory comment in routes.ts (illustrates genericity, not a hardcode)", () => {
    const content = `// here knows what "davivienda" or "sas-colombia" mean.\n`;
    expect(scanContentForViolations("src/routes.ts", content)).toEqual([]);
  });

  // PASS_WITH_FIXES ronda 1, P2: a bare comparison of ARCHITECTURE_RULES'
  // id list proves nothing about whether each rule can actually fire.
  // This table + loop instead runs a real synthetic snippet through the
  // scanner for every rule and asserts it produces that rule's violation
  // — a rule added later with no entry here fails the coverage test
  // below immediately, and a rule whose snippet stops matching (e.g. a
  // pattern typo) fails its own dedicated test.
  const NEGATIVE_CONTROL_SNIPPETS: Record<string, string> = {
    ENGINE_GENERICITY_CLIENT_LITERALS: `const detected = { mentioned_sas: true };`,
    ENGINE_GENERICITY_NO_APP_USERS: `const APP_USERS = { "a@b.com": "token" };`,
    ENGINE_GENERICITY_NO_SHARED_TOKEN_IDENTITY: `if (req.header("x-app-token") === "whatever") return next();`,
    ENGINE_GENERICITY_NO_LEXICOGRAPHIC_VERSION_PICK: `const latest = versions.sort().reverse()[0];`,
    ENGINE_GENERICITY_NO_LITERAL_TENANT_BRANCH: `if (organizationId === "sas-colombia") { return specialCase(); }`,
    ENGINE_GENERICITY_NO_ORG_ID_LITERAL: `const supportedOrganizations = ["acme-demo"];`,
  };

  it("REGRESSION_GUARD: every rule in ARCHITECTURE_RULES has a registered negative-control snippet", () => {
    const missing = ARCHITECTURE_RULES.map((r) => r.id).filter((id) => !(id in NEGATIVE_CONTROL_SNIPPETS));
    expect(missing).toEqual([]);
  });

  for (const rule of ARCHITECTURE_RULES) {
    const snippet = NEGATIVE_CONTROL_SNIPPETS[rule.id];
    if (!snippet) continue; // caught by REGRESSION_GUARD above, not silently skipped
    it(`NEGATIVE_CONTROL[${rule.id}]: its snippet, run through the real scanner (not just asserted), actually produces this rule's violation`, () => {
      const violations = scanContentForViolations("src/engine/syntheticNegativeControl.ts", snippet);
      expect(violations.map((v) => v.rule)).toContain(rule.id);
    });
  }
});
