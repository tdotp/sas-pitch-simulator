import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { runGenericEngineScan } from "./runGenericEngineScan.js";

const SRC_ROOT = fileURLToPath(new URL("../", import.meta.url));
const BACKEND_ROOT = fileURLToPath(new URL("../../", import.meta.url));

describe("runGenericEngineScan against the real backend/src tree", () => {
  it("ENGINE_GENERICITY_REGRESSION_GUARD: the real generic engine source has zero architecture violations right now", async () => {
    const violations = await runGenericEngineScan(SRC_ROOT, BACKEND_ROOT);
    if (violations.length > 0) {
      console.error("Architecture violations found:", JSON.stringify(violations, null, 2));
    }
    expect(violations).toEqual([]);
  });
});
