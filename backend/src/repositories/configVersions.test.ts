// Unit tests for the config version registry. Uses the in-memory
// fallback (isPersistenceEnabled mocked to false) — same approach as
// repositories/sessions.test.ts. Each test uses a unique organizationId
// since the in-memory store is module-level and not reset between tests.
import { describe, it, expect, vi } from "vitest";

vi.mock("../firebase.js", () => ({ isPersistenceEnabled: () => false }));

import {
  registerDraftVersion,
  activateConfigVersion,
  resolveActiveVersion,
  getVersion,
} from "./configVersions.js";
import type { ConfigPackageLoader, ConfigPackageResult } from "../engine-config/loader.js";

let counter = 0;
function uniqueOrg(): string {
  counter += 1;
  return `org-cv-${counter}`;
}

function fakeLoader(valid: boolean, hash = "hash-1", errors: string[] = ["invalid"]): ConfigPackageLoader {
  return {
    async loadPackage(): Promise<ConfigPackageResult> {
      if (!valid) return { valid: false, errors };
      return {
        valid: true,
        hash,
        pkg: {
          manifest: {
            organizationId: "x",
            version: "v1",
            status: "active",
            interviewerProfiles: [],
            scenarios: [],
            evaluationFrameworks: [],
            contentSources: [],
          },
          client: { organizationId: "x", defaultLanguage: "es", settings: {} },
          interviewerProfiles: [],
          scenarios: [],
          evaluationFrameworks: [],
          contentSources: [],
        },
      };
    },
  };
}

describe("registerDraftVersion", () => {
  it("creates a new entry with status draft", async () => {
    const org = uniqueOrg();
    const { created, record } = await registerDraftVersion(org, "v1");
    expect(created).toBe(true);
    expect(record.status).toBe("draft");
    expect(record.organizationId).toBe(org);
    expect(record.version).toBe("v1");
  });

  it("is idempotent — a second call returns the EXISTING record unchanged, never downgrades it", async () => {
    const org = uniqueOrg();
    await registerDraftVersion(org, "v1");
    await activateConfigVersion(org, "v1", fakeLoader(true));

    const second = await registerDraftVersion(org, "v1");
    expect(second.created).toBe(false);
    expect(second.record.status).toBe("active"); // NOT reset back to draft
  });
});

describe("resolveActiveVersion / getVersion", () => {
  it("returns null when nothing has ever been registered", async () => {
    const org = uniqueOrg();
    expect(await resolveActiveVersion(org)).toBeNull();
    expect(await getVersion(org, "v1")).toBeNull();
  });

  it("draft → no puede iniciar sesiones: a draft version is never returned as active", async () => {
    const org = uniqueOrg();
    await registerDraftVersion(org, "v1");
    expect(await resolveActiveVersion(org)).toBeNull();
  });
});

describe("activateConfigVersion", () => {
  it("NO ACTIVAR CONFIG INVÁLIDA: refuses to activate a package that fails validation", async () => {
    const org = uniqueOrg();
    const result = await activateConfigVersion(org, "v1", fakeLoader(false, "n/a", ["bad weights"]));
    expect(result.outcome).toBe("invalid_package");
    expect(await resolveActiveVersion(org)).toBeNull();
  });

  it("activates a fresh (never-registered) version directly — draft + activate in one call", async () => {
    const org = uniqueOrg();
    const result = await activateConfigVersion(org, "v1", fakeLoader(true));
    expect(result.outcome).toBe("activated");
    expect(await resolveActiveVersion(org)).toBe("v1");
    const record = await getVersion(org, "v1");
    expect(record?.status).toBe("active");
    expect(record?.activatedAt).toBeTruthy();
    expect(record?.configHash).toBe("hash-1");
  });

  it("UNA SOLA ACTIVE VERSION: activating v2 deprecates v1 without deleting it", async () => {
    const org = uniqueOrg();
    await activateConfigVersion(org, "v1", fakeLoader(true, "hash-v1"));
    const result = await activateConfigVersion(org, "v2", fakeLoader(true, "hash-v2"));

    expect(result.outcome).toBe("activated");
    if (result.outcome === "activated") expect(result.previousActiveVersion).toBe("v1");

    expect(await resolveActiveVersion(org)).toBe("v2");
    const v1 = await getVersion(org, "v1");
    expect(v1?.status).toBe("deprecated");
    expect(v1?.deprecatedAt).toBeTruthy();
    // Not deleted — still fully readable.
    expect(v1?.version).toBe("v1");
  });

  it("DEPRECATION_FLOW: a deprecated version can be re-activated (rollback) if its content is unchanged", async () => {
    const org = uniqueOrg();
    await activateConfigVersion(org, "v1", fakeLoader(true, "hash-v1"));
    await activateConfigVersion(org, "v2", fakeLoader(true, "hash-v2")); // v1 now deprecated

    const rollback = await activateConfigVersion(org, "v1", fakeLoader(true, "hash-v1"));
    expect(rollback.outcome).toBe("activated");
    expect(await resolveActiveVersion(org)).toBe("v1");
    const v2 = await getVersion(org, "v2");
    expect(v2?.status).toBe("deprecated");
  });

  it("IMMUTABILITY_POLICY: refuses to re-activate a version whose content hash changed since it was first activated", async () => {
    const org = uniqueOrg();
    await activateConfigVersion(org, "v1", fakeLoader(true, "hash-original"));

    // Same version id, but the loader now reports DIFFERENT content — as
    // if the files under v1/ were edited in place after being used.
    const result = await activateConfigVersion(org, "v1", fakeLoader(true, "hash-mutated"));
    expect(result.outcome).toBe("immutability_violation");
    if (result.outcome === "immutability_violation") {
      expect(result.recordedHash).toBe("hash-original");
      expect(result.currentHash).toBe("hash-mutated");
    }
    // The registry's recorded state must be untouched by the refused call.
    const record = await getVersion(org, "v1");
    expect(record?.configHash).toBe("hash-original");
  });

  it("re-activating the SAME version with the SAME content is a harmless no-op (idempotent)", async () => {
    const org = uniqueOrg();
    await activateConfigVersion(org, "v1", fakeLoader(true, "hash-1"));
    const result = await activateConfigVersion(org, "v1", fakeLoader(true, "hash-1"));
    expect(result.outcome).toBe("activated");
    expect(await resolveActiveVersion(org)).toBe("v1");
  });

  it("two organizations activating v1 do not collide", async () => {
    const orgA = uniqueOrg();
    const orgB = uniqueOrg();
    await activateConfigVersion(orgA, "v1", fakeLoader(true, "hash-a"));
    await activateConfigVersion(orgB, "v1", fakeLoader(true, "hash-b"));

    expect(await resolveActiveVersion(orgA)).toBe("v1");
    expect(await resolveActiveVersion(orgB)).toBe("v1");
    expect((await getVersion(orgA, "v1"))?.configHash).toBe("hash-a");
    expect((await getVersion(orgB, "v1"))?.configHash).toBe("hash-b");
  });
});
