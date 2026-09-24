import { describe, it, expect } from "vitest";
import { discoverConfigPackageVersions, validateAllConfigPackages } from "./validateAllPackages.js";
import type { ConfigPackageLoader, ConfigPackageResult } from "./loader.js";

describe("discoverConfigPackageVersions", () => {
  it("finds every organization/version directory actually committed under config-packages/", async () => {
    const discovered = await discoverConfigPackageVersions();
    const keys = discovered.map((d) => `${d.organizationId}/${d.version}`).sort();
    expect(keys).toEqual(["acme-demo/v1", "acme-demo/v2", "sas-colombia/v1"]);
  });

  it("returns an empty list for a root directory that doesn't exist, instead of throwing", async () => {
    const discovered = await discoverConfigPackageVersions(new URL("file:///definitely-not-a-real-path/"));
    expect(discovered).toEqual([]);
  });
});

describe("validateAllConfigPackages", () => {
  const versions = [
    { organizationId: "org-a", version: "v1" },
    { organizationId: "org-b", version: "v1" },
  ];

  it("reports every package valid when the loader validates all of them", async () => {
    const allValidLoader: ConfigPackageLoader = {
      async loadPackage(): Promise<ConfigPackageResult> {
        return { valid: true, pkg: {} as any, hash: "deadbeef" };
      },
    };
    const results = await validateAllConfigPackages(versions, allValidLoader);
    expect(results.every((r) => r.valid)).toBe(true);
    expect(results).toHaveLength(2);
  });

  it("CONFIG_VALIDATION_NEGATIVE_CONTROL: surfaces a broken package as invalid without touching real packages", async () => {
    const oneBrokenLoader: ConfigPackageLoader = {
      async loadPackage(organizationId: string): Promise<ConfigPackageResult> {
        if (organizationId === "org-b") {
          return { valid: false, errors: ["scenario 'x' referencia interviewerProfileId inexistente 'ghost'"] };
        }
        return { valid: true, pkg: {} as any, hash: "deadbeef" };
      },
    };
    const results = await validateAllConfigPackages(versions, oneBrokenLoader);
    const broken = results.find((r) => r.organizationId === "org-b");
    expect(broken?.valid).toBe(false);
    expect(broken?.errors).toContain("scenario 'x' referencia interviewerProfileId inexistente 'ghost'");
    expect(results.some((r) => !r.valid)).toBe(true);
  });
});
