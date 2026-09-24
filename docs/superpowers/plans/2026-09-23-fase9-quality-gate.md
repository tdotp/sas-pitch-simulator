# Fase 9 — Tests / Quality Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the existing, already-passing Fases 1–8 test/build baseline into one reproducible `npm run quality:gate` command that answers "does this commit preserve every invariant from Fases 1–8?" with a single exit code — without adding product features or chasing coverage percentages.

**Architecture:** A pure orchestrator (`backend/scripts/qualityGate.ts`) runs an ordered, hardcoded list of steps in AGGREGATE mode (never fail-fast) and is unit-tested with fake steps (no subprocesses). A thin CLI wrapper (`backend/scripts/run-quality-gate.ts`) defines the real steps, each of which shells out to an EXISTING or newly-added `npm run <script>` in `backend/` or `frontend/`. Two brand-new gate steps close real gaps found by inventory: (1) a "validate every config package on disk" step built on the existing `FileConfigPackageLoader`, and (2) a static "generic engine architecture scan" that greps generic engine source for literal regressions of the Fase 5 engine/config separation, with an explicit, documented allowlist for the two known legitimate matches. Both new checks are pure-function-first so their negative controls are unit tests against synthetic strings/fakes, never against real committed files.

**Tech Stack:** Node 20, TypeScript (ESM, `"type": "module"`), Vitest, tsx, existing npm workspaces (`backend`, `frontend`). No new dependencies.

**Spec:** The Fase 9 spec is the user's own 28-point message in this conversation (SAS VOCERIA, repo `tdotp/sas-pitch-simulator`) — there is no separate spec file; this plan's "Global Constraints" section copies its binding constraints verbatim.

## Inventory findings this plan is built on (verified in this session, not assumed)

- Baseline reproduced live: backend 24 test files / 335 tests PASS, frontend 2 test files / 8 tests PASS, backend build PASS, frontend build PASS. HEAD == `origin/master` == `416d19c1c8...`.
- Every domain in the spec's audit checklist (auth, membership, RBAC, tenant isolation, session lifecycle — including concurrent `/session/end`, idempotent retry, ambiguous ack, stale recovery, invalid transitions —, config loader/resolver split, config version registry, provenance/hash including all 3 fail-closed sub-cases in `resolver.test.ts` L194/205/219, evaluator runtime+semantic validation, OpenRouter/ElevenLabs reliability, structured logging redaction, rate limiting incl. tenant-trust-boundary, trust proxy, observability summarizer, frontend) is **already covered** by existing tests. No new regression tests for these domains are needed or should be added (avoids "tests just to raise a number").
- Real gaps found, and the only things this plan builds:
  1. No command validates **every** config package on disk in one pass (`config:validate` takes one path at a time).
  2. No static "generic engine has zero client-specific contamination" check exists at all — only behavioral proxies.
  3. No `quality:gate` command exists. No CI exists (`.github/workflows/` absent).
  4. `backend/tsconfig.json`'s `include` is `src/**/*` only — `backend/scripts/*.ts` (several of which call `initFirebase()`) are never typechecked by `npm run build`.
- Known, accepted test debt this plan does **not** attempt to close (documented in the Fase 9 report, not silently ignored): the Firestore SDK client itself is never mocked anywhere (repositories are tested via the `isPersistenceEnabled: () => false` in-memory fallback, never against a real/mocked `firebase-admin` Firestore client), and the operational scripts' `main()` I/O (`mark-stale-evaluating-sessions.ts`, `mark-abandoned-sessions.ts`, `config-import.ts`, `config-activate.ts`) is untested beyond their pure argument-parsing helpers. Building a Firestore SDK mock is infrastructure work orthogonal to "build the reproducible gate over what already exists" and is explicitly out of scope per the spec's "no quiero simplemente más tests."

## Global Constraints

- No product changes: no new routes, no UI changes, no scoring/role/session-lifecycle/config-semantics changes (spec item 25).
- No deploy, no real Firestore, no real OpenRouter/ElevenLabs calls, anywhere in the gate (spec items 11–12).
- The gate must be fully offline/hermetic — if any existing test secretly needs a local credential, that is a bug to fix with a mock, not a coverage cut (spec item 12).
- The gate must NEVER invoke `config:activate`, `config:import` (non-dry-run), `sessions:mark-abandoned`, or `sessions:mark-stale-evaluating` — these are live, Firestore-writing operator commands, not gate steps (spec item 13). The CLI wrapper's step list is the single source of truth for what the gate runs; every step gets documented in `PHASE_09_TESTS_QUALITY_GATE_REPORT.md`.
- AGGREGATE, not fail-fast: every gate step always runs even if an earlier one failed (documented decision, spec item 11).
- New checks must minimize false positives; every legitimate exception must be an explicit, documented allowlist entry, never a silent skip (spec item 14).
- Client names (e.g. `sas-colombia`, `davivienda`, `acme-demo`) are valid inside `backend/config-packages/`, fixtures, and docs — the architecture scan only ever walks `backend/src/`, so this is satisfied structurally, not by a client-name exclusion list (spec item 15).
- Negative controls for both new checks must prove the check can fail, without ever touching or contaminating real committed files (spec items 22–23): the config-validation negative control uses a fake `ConfigPackageLoader` injected via the existing dependency-injection pattern (`resolver.ts`'s `ConfigVersionRegistry` is the precedent); the architecture-scan negative control passes a synthetic string directly to the pure scan function.
- New test/check names communicate the invariant they protect (e.g. `ENGINE_GENERICITY_*`, `CONFIG_VALIDATION_NEGATIVE_CONTROL`, `QUALITY_GATE_SELF_TEST`) — spec item 16.
- Every new backend file follows the existing ESM conventions already in this codebase: `.js` extensions on relative imports, `import.meta.url`-based path resolution (never `__dirname`), dependency-injected collaborators for anything that needs a fake in tests (the pattern already used in `resolver.ts` and `routes.test.ts`).

---

### Task 1: Config package validation gate step (validate every package on disk)

**Files:**
- Create: `backend/src/engine-config/validateAllPackages.ts`
- Create: `backend/src/engine-config/validateAllPackages.test.ts`
- Create: `backend/scripts/config-validate-all.ts`
- Modify: `backend/package.json` (add `"config:validate-all"` script)

**Interfaces:**
- Consumes: `FileConfigPackageLoader`, `ConfigPackageLoader`, `ConfigPackageResult`, `listVersionDirs` — all already exported from `backend/src/engine-config/loader.ts`.
- Produces: `discoverConfigPackageVersions(root?: URL): Promise<DiscoveredPackageVersion[]>` and `validateAllConfigPackages(versions: DiscoveredPackageVersion[], loader: ConfigPackageLoader): Promise<PackageValidationResult[]>`, both exported from `validateAllPackages.ts`. Task 5's CLI wrapper step calls `npm run config:validate-all` in `backend/`.

- [ ] **Step 1: Write the failing tests**

Create `backend/src/engine-config/validateAllPackages.test.ts`:

```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && npx vitest run src/engine-config/validateAllPackages.test.ts`
Expected: FAIL — `Cannot find module './validateAllPackages.js'`

- [ ] **Step 3: Write the implementation**

Create `backend/src/engine-config/validateAllPackages.ts`:

```ts
// Fase 9 (Quality Gate): the request-time loader validates ONE package at
// ONE version (see loader.ts's STORAGE_STRATEGY). Nothing before this
// file ever validated EVERY package version actually committed to the
// repo in one pass — config:validate takes a single path per invocation.
// This is the "config package validation gate" step: discover every
// <organizationId>/<version> directory under config-packages/, and
// validate each one through the exact same FileConfigPackageLoader used
// in production.

import { readdir } from "node:fs/promises";
import { listVersionDirs, type ConfigPackageLoader, type ConfigPackageResult } from "./loader.js";

const DEFAULT_ROOT = new URL("../../config-packages/", import.meta.url);

export interface DiscoveredPackageVersion {
  organizationId: string;
  version: string;
}

export async function discoverConfigPackageVersions(root: URL = DEFAULT_ROOT): Promise<DiscoveredPackageVersion[]> {
  let orgDirents;
  try {
    orgDirents = await readdir(root.pathname, { withFileTypes: true });
  } catch {
    return [];
  }
  const organizationIds = orgDirents.filter((e) => e.isDirectory()).map((e) => e.name).sort();

  const discovered: DiscoveredPackageVersion[] = [];
  for (const organizationId of organizationIds) {
    const versions = await listVersionDirs(organizationId, root);
    for (const version of versions) {
      discovered.push({ organizationId, version });
    }
  }
  return discovered;
}

export interface PackageValidationResult extends DiscoveredPackageVersion {
  valid: boolean;
  errors: string[];
}

// Dependency-injected loader (same pattern as engine-config/resolver.ts's
// ConfigVersionRegistry) so this aggregation logic is unit-testable with
// a fake that returns one deliberately invalid result — the config
// validation gate's negative control (Fase 9 spec item 22) — without
// ever touching a real committed package.
export async function validateAllConfigPackages(
  versions: DiscoveredPackageVersion[],
  loader: ConfigPackageLoader
): Promise<PackageValidationResult[]> {
  const results: PackageValidationResult[] = [];
  for (const { organizationId, version } of versions) {
    const result: ConfigPackageResult = await loader.loadPackage(organizationId, version);
    results.push({
      organizationId,
      version,
      valid: result.valid,
      errors: result.valid ? [] : result.errors,
    });
  }
  return results;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && npx vitest run src/engine-config/validateAllPackages.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Write the CLI wrapper**

Create `backend/scripts/config-validate-all.ts`:

```ts
// Fase 9 (Quality Gate) — config package validation gate step: validates
// EVERY <organizationId>/<version> package actually committed under
// backend/config-packages/, not just one path at a time like
// config:validate. Same two-pass validation (structural + semantic) via
// the same FileConfigPackageLoader used in production. Pure read-only —
// no initFirebase(), no network, no writes. Safe for CI / offline runs.
//
//   npm run config:validate-all

import { FileConfigPackageLoader } from "../src/engine-config/loader.js";
import { discoverConfigPackageVersions, validateAllConfigPackages } from "../src/engine-config/validateAllPackages.js";

async function main() {
  const loader = new FileConfigPackageLoader();
  const versions = await discoverConfigPackageVersions();

  if (versions.length === 0) {
    console.error("[config:validate-all] No se encontró ningún paquete bajo config-packages/.");
    process.exit(1);
  }

  const results = await validateAllConfigPackages(versions, loader);
  let failures = 0;

  for (const r of results) {
    if (r.valid) {
      console.log(`[PASS] ${r.organizationId}/${r.version}`);
    } else {
      failures += 1;
      console.error(`[FAIL] ${r.organizationId}/${r.version}`);
      for (const err of r.errors) console.error(`   - ${err}`);
    }
  }

  console.log(`\n${results.length - failures}/${results.length} paquetes válidos.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("[config:validate-all] Error inesperado:", err);
  process.exit(1);
});
```

- [ ] **Step 6: Wire the npm script and run it for real**

Modify `backend/package.json` — add to `"scripts"`:

```json
"config:validate-all": "tsx scripts/config-validate-all.ts"
```

Run: `cd backend && npm run config:validate-all`
Expected: exit 0, prints `[PASS] acme-demo/v1`, `[PASS] acme-demo/v2`, `[PASS] sas-colombia/v1`, and `3/3 paquetes válidos.`

- [ ] **Step 7: Commit**

```bash
git add backend/src/engine-config/validateAllPackages.ts backend/src/engine-config/validateAllPackages.test.ts backend/scripts/config-validate-all.ts backend/package.json
git commit -m "Fase 9: config package validation gate (validate every package on disk)"
```

---

### Task 2: Generic engine architecture scan — rules and pure scan function

**Files:**
- Create: `backend/src/architecture/genericEngineScan.ts`
- Create: `backend/src/architecture/genericEngineScan.test.ts`

**Interfaces:**
- Produces: `ARCHITECTURE_RULES: ArchitectureRule[]`, `scanContentForViolations(filePath: string, content: string, rules?: ArchitectureRule[]): ArchitectureViolation[]`, and the `ArchitectureRule`/`ArchitectureViolation` types — consumed by Task 3's `runGenericEngineScan.ts`.

- [ ] **Step 1: Write the failing tests**

Create `backend/src/architecture/genericEngineScan.test.ts`:

```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && npx vitest run src/architecture/genericEngineScan.test.ts`
Expected: FAIL — `Cannot find module './genericEngineScan.js'`

- [ ] **Step 3: Write the implementation**

Create `backend/src/architecture/genericEngineScan.ts`:

```ts
// Fase 9 (Quality Gate) — ENGINE_GENERICITY static check. Protects the
// invariant closed in Fase 5 (engine != client-specific logic) against
// silent regression: a literal/regex scan over GENERIC engine source
// only (never backend/config-packages/, where a client's own name is
// legitimate content, not contamination — see Fase 9 spec item 15).
//
// Pure by design (item 23): scanContentForViolations takes a file path
// and its content as plain strings, so a unit test can feed it a
// synthetic string containing a violation without ever writing a real
// file into engine source. The real filesystem walk lives in
// runGenericEngineScan.ts.

export interface ArchitectureRule {
  id: string;
  description: string;
  pattern: RegExp;
  // Documented, explicit exceptions — never silent. Each entry names the
  // exact file where the pattern is expected to match legitimately, plus
  // why (spec item 14: minimize false positives, document exceptions).
  allow: Array<{ file: string; reason: string }>;
}

export interface ArchitectureViolation {
  rule: string;
  file: string;
  line: number;
  snippet: string;
}

export const ARCHITECTURE_RULES: ArchitectureRule[] = [
  {
    id: "ENGINE_GENERICITY_CLIENT_LITERALS",
    description: "No hardcoded client-specific literals in generic engine source (Fase 5 regression).",
    pattern: /mentioned_sas|mentioned_novo|aligned_to_playbook|SAS_RE|SANDRA/,
    allow: [
      {
        file: "src/types.ts",
        reason:
          "Historical explanatory comment describing the removed Fase 5 hardcode (mentioned_sas/aligned_to_playbook) — documentation, not code.",
      },
    ],
  },
  {
    id: "ENGINE_GENERICITY_NO_APP_USERS",
    description: "No resurrection of the flat APP_USERS credential map removed in Fase 1.",
    pattern: /APP_USERS/,
    allow: [],
  },
  {
    id: "ENGINE_GENERICITY_NO_SHARED_TOKEN_IDENTITY",
    description:
      "The x-app-token anti-abuse gate (Fase 1) may exist in exactly one place and must never become an identity/role source.",
    pattern: /x-app-token/,
    allow: [
      {
        file: "src/routes.ts",
        reason:
          "The single documented anti-abuse gate (requireToken) — a public, non-secret token that never derives identity or role. See Fase 1 report.",
      },
    ],
  },
  {
    id: "ENGINE_GENERICITY_NO_LEXICOGRAPHIC_VERSION_PICK",
    description: "No '.sort().reverse()' version auto-selection (the exact anti-pattern removed in Fase 6).",
    pattern: /\.sort\(\s*\)\s*\.reverse\(\s*\)/,
    allow: [],
  },
  {
    id: "ENGINE_GENERICITY_NO_LITERAL_TENANT_BRANCH",
    description: "No branching on a hardcoded client/org/organizationId string literal.",
    pattern: /\b(client|org|organization|organizationId)\s*===\s*["']/,
    allow: [],
  },
];

export function scanContentForViolations(
  filePath: string,
  content: string,
  rules: ArchitectureRule[] = ARCHITECTURE_RULES
): ArchitectureViolation[] {
  const violations: ArchitectureViolation[] = [];
  const lines = content.split("\n");

  for (const rule of rules) {
    lines.forEach((lineText, idx) => {
      if (!rule.pattern.test(lineText)) return;
      const allowed = rule.allow.some((a) => filePath.endsWith(a.file));
      if (allowed) return;
      violations.push({ rule: rule.id, file: filePath, line: idx + 1, snippet: lineText.trim() });
    });
  }
  return violations;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && npx vitest run src/architecture/genericEngineScan.test.ts`
Expected: PASS (8 tests)

- [ ] **Step 5: Commit**

```bash
git add backend/src/architecture/genericEngineScan.ts backend/src/architecture/genericEngineScan.test.ts
git commit -m "Fase 9: ENGINE_GENERICITY static architecture rules (pure scan + negative controls)"
```

---

### Task 3: Generic engine architecture scan — real filesystem walk, regression guard, CLI wrapper

**Files:**
- Create: `backend/src/architecture/runGenericEngineScan.ts`
- Create: `backend/src/architecture/runGenericEngineScan.test.ts`
- Create: `backend/scripts/architecture-scan.ts`
- Modify: `backend/package.json` (add `"architecture:scan"` script)

**Interfaces:**
- Consumes: `scanContentForViolations`, `ArchitectureViolation` from Task 2's `genericEngineScan.ts`.
- Produces: `runGenericEngineScan(srcRootPath: string, repoRelativeBasePath: string): Promise<ArchitectureViolation[]>`, consumed by Task 5's CLI wrapper step (`npm run architecture:scan`).

- [ ] **Step 1: Write the failing test**

Create `backend/src/architecture/runGenericEngineScan.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx vitest run src/architecture/runGenericEngineScan.test.ts`
Expected: FAIL — `Cannot find module './runGenericEngineScan.js'`

- [ ] **Step 3: Write the implementation**

Create `backend/src/architecture/runGenericEngineScan.ts`:

```ts
// Fase 9 (Quality Gate) — the real filesystem side of the ENGINE_GENERICITY
// check. Walks backend/src (never config-packages/, fixtures, or dist),
// reading every .ts file (excluding *.test.ts) and feeding it through the
// pure scanContentForViolations. See genericEngineScan.ts for the rules.

import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { scanContentForViolations, type ArchitectureViolation } from "./genericEngineScan.js";

const EXCLUDED_DIRS = new Set(["node_modules", "dist", "config-packages"]);

async function collectTsFiles(dir: string, files: string[] = []): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRS.has(entry.name)) continue;
      await collectTsFiles(join(dir, entry.name), files);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      files.push(join(dir, entry.name));
    }
  }
  return files;
}

export async function runGenericEngineScan(
  srcRootPath: string,
  repoRelativeBasePath: string
): Promise<ArchitectureViolation[]> {
  const files = await collectTsFiles(srcRootPath);
  const violations: ArchitectureViolation[] = [];
  for (const absPath of files) {
    const content = await readFile(absPath, "utf-8");
    const relPath = relative(repoRelativeBasePath, absPath);
    violations.push(...scanContentForViolations(relPath, content));
  }
  return violations;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npx vitest run src/architecture/runGenericEngineScan.test.ts`
Expected: PASS (1 test). If it FAILS with real violations listed, inspect them — do not add an allowlist entry to hide a real regression; only add one for a genuinely legitimate, documented case (see Global Constraints).

- [ ] **Step 5: Write the CLI wrapper**

Create `backend/scripts/architecture-scan.ts`:

```ts
// Fase 9 (Quality Gate) — ENGINE_GENERICITY static check, CLI entry.
// Pure read-only, no Firestore/network. Fails (non-zero exit) if any
// architecture violation is found in generic engine source.
//
//   npm run architecture:scan

import { fileURLToPath } from "node:url";
import { runGenericEngineScan } from "../src/architecture/runGenericEngineScan.js";

async function main() {
  const srcRoot = fileURLToPath(new URL("../src/", import.meta.url));
  const backendRoot = fileURLToPath(new URL("../", import.meta.url));

  const violations = await runGenericEngineScan(srcRoot, backendRoot);

  if (violations.length === 0) {
    console.log("[PASS] architecture:scan — 0 violaciones de ENGINE_GENERICITY.");
    process.exit(0);
  }

  console.error(`[FAIL] architecture:scan — ${violations.length} violación(es):\n`);
  for (const v of violations) {
    console.error(`  ${v.rule}  ${v.file}:${v.line}\n    ${v.snippet}`);
  }
  process.exit(1);
}

main().catch((err) => {
  console.error("[architecture:scan] Error inesperado:", err);
  process.exit(1);
});
```

- [ ] **Step 6: Wire the npm script and run it for real**

Modify `backend/package.json` — add to `"scripts"`:

```json
"architecture:scan": "tsx scripts/architecture-scan.ts"
```

Run: `cd backend && npm run architecture:scan`
Expected: exit 0, `[PASS] architecture:scan — 0 violaciones de ENGINE_GENERICITY.`

- [ ] **Step 7: Commit**

```bash
git add backend/src/architecture/runGenericEngineScan.ts backend/src/architecture/runGenericEngineScan.test.ts backend/scripts/architecture-scan.ts backend/package.json
git commit -m "Fase 9: ENGINE_GENERICITY real filesystem scan + regression guard + CLI"
```

---

### Task 4: Quality gate pure orchestrator + self-test

**Files:**
- Create: `backend/scripts/qualityGate.ts`
- Create: `backend/scripts/qualityGate.test.ts`

**Interfaces:**
- Produces: `QualityGateStep`, `StepResult`, `QualityGateRun` types; `runQualityGateSteps(steps: QualityGateStep[]): Promise<QualityGateRun>`; `formatReport(run: QualityGateRun): string`; `computeExitCode(run: QualityGateRun): number`. Consumed by Task 5's `run-quality-gate.ts`.

- [ ] **Step 1: Write the failing tests**

Create `backend/scripts/qualityGate.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { runQualityGateSteps, formatReport, computeExitCode, type QualityGateStep } from "./qualityGate.js";

function passingStep(name: string): QualityGateStep {
  return { name, run: async () => ({ ok: true, output: "ok" }) };
}
function failingStep(name: string): QualityGateStep {
  return { name, run: async () => ({ ok: false, output: "boom" }) };
}
function throwingStep(name: string): QualityGateStep {
  return {
    name,
    run: async () => {
      throw new Error("step definition bug");
    },
  };
}

describe("runQualityGateSteps", () => {
  it("QUALITY_GATE_SELF_TEST: all steps passing -> allPassed true, exit 0", async () => {
    const run = await runQualityGateSteps([passingStep("a"), passingStep("b")]);
    expect(run.allPassed).toBe(true);
    expect(computeExitCode(run)).toBe(0);
  });

  it("QUALITY_GATE_SELF_TEST: one failing step -> allPassed false, exit 1", async () => {
    const run = await runQualityGateSteps([passingStep("a"), failingStep("b")]);
    expect(run.allPassed).toBe(false);
    expect(computeExitCode(run)).toBe(1);
  });

  it("AGGREGATE_NOT_FAIL_FAST: a failing step never prevents later steps from running", async () => {
    const run = await runQualityGateSteps([failingStep("a"), passingStep("b")]);
    expect(run.results.map((r) => r.name)).toEqual(["a", "b"]);
    expect(run.results[1].ok).toBe(true);
  });

  it("a step that throws is reported as a failure, not an uncaught exception", async () => {
    const run = await runQualityGateSteps([throwingStep("a"), passingStep("b")]);
    expect(run.allPassed).toBe(false);
    expect(run.results[0].ok).toBe(false);
    expect(run.results[0].error).toContain("step definition bug");
    expect(run.results[1].ok).toBe(true);
  });
});

describe("formatReport", () => {
  it("labels each step [PASS] or [FAIL] and includes an overall summary line", async () => {
    const run = await runQualityGateSteps([passingStep("backend tests"), failingStep("architecture scan")]);
    const report = formatReport(run);
    expect(report).toContain("[PASS] backend tests");
    expect(report).toContain("[FAIL] architecture scan");
    expect(report).toContain("QUALITY GATE: FAIL (1/2 steps passed)");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && npx vitest run scripts/qualityGate.test.ts`
Expected: FAIL — `Cannot find module './qualityGate.js'`

- [ ] **Step 3: Write the implementation**

Create `backend/scripts/qualityGate.ts`:

```ts
// Fase 9 (Quality Gate) — pure orchestration logic, deliberately
// separated from the CLI wrapper (run-quality-gate.ts) that defines the
// REAL steps (which spawn subprocesses). This split exists so the
// orchestrator's own aggregation/exit-code logic has a fast, hermetic
// self-test (Fase 9 spec item 24) that never spawns a real subprocess —
// mirrors the existing split between staleEvaluatingArgs.ts (pure,
// tested) and mark-stale-evaluating-sessions.ts (CLI wrapper, untested
// by design, see Fase 9 report TEST_ENVIRONMENT_SAFETY).
//
// DECISION (documented per Fase 9 spec item 11): AGGREGATE, not
// fail-fast. Every step always runs, even if an earlier one failed — an
// operator fixing a red gate wants to see every failing block in one
// run, not one at a time across repeated invocations.

export interface QualityGateStep {
  name: string;
  run: () => Promise<{ ok: boolean; output?: string }>;
}

export interface StepResult {
  name: string;
  ok: boolean;
  durationMs: number;
  output?: string;
  error?: string;
}

export interface QualityGateRun {
  results: StepResult[];
  allPassed: boolean;
}

export async function runQualityGateSteps(steps: QualityGateStep[]): Promise<QualityGateRun> {
  const results: StepResult[] = [];

  for (const step of steps) {
    const startedAt = Date.now();
    try {
      const { ok, output } = await step.run();
      results.push({ name: step.name, ok, durationMs: Date.now() - startedAt, output });
    } catch (err) {
      results.push({
        name: step.name,
        ok: false,
        durationMs: Date.now() - startedAt,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { results, allPassed: results.every((r) => r.ok) };
}

export function formatReport(run: QualityGateRun): string {
  const lines = run.results.map((r) => {
    const label = r.ok ? "[PASS]" : "[FAIL]";
    const errorSuffix = r.error ? ` — ${r.error}` : "";
    return `${label} ${r.name} (${r.durationMs}ms)${errorSuffix}`;
  });
  const summary = run.allPassed
    ? `\nQUALITY GATE: PASS (${run.results.length}/${run.results.length} steps)`
    : `\nQUALITY GATE: FAIL (${run.results.filter((r) => r.ok).length}/${run.results.length} steps passed)`;
  return [...lines, summary].join("\n");
}

export function computeExitCode(run: QualityGateRun): number {
  return run.allPassed ? 0 : 1;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && npx vitest run scripts/qualityGate.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add backend/scripts/qualityGate.ts backend/scripts/qualityGate.test.ts
git commit -m "Fase 9: pure quality-gate orchestrator with self-test (aggregate mode)"
```

---

### Task 5: Quality gate CLI wrapper + scripts typecheck + npm wiring

**Files:**
- Create: `backend/scripts/run-quality-gate.ts`
- Create: `backend/tsconfig.quality-gate.json`
- Modify: `backend/package.json` (add `"typecheck:scripts"` and `"quality:gate"` scripts)
- Modify: `package.json` (root — add `"quality:gate"` script)

**Interfaces:**
- Consumes: `runQualityGateSteps`, `formatReport`, `computeExitCode`, `QualityGateStep` from Task 4's `qualityGate.ts`.
- Produces: the `npm run quality:gate` command at both backend and repo root.

- [ ] **Step 1: Create the scripts-typecheck tsconfig**

Create `backend/tsconfig.quality-gate.json`:

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "noEmit": true
  },
  "include": ["src/**/*", "scripts/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

- [ ] **Step 2: Add the typecheck:scripts npm script and run it**

Modify `backend/package.json` — add to `"scripts"`:

```json
"typecheck:scripts": "tsc --noEmit -p tsconfig.quality-gate.json"
```

Run: `cd backend && npm run typecheck:scripts`
Expected: exit 0. If it fails, read the actual errors: fix them only if they are real type bugs (spec item 25 — "si un test revela un bug real, corrige únicamente ese bug y documenta"); if a pre-existing test file has a type looseness that isn't a real bug, narrow `"include"` to exclude `**/*.test.ts` instead of suppressing the error, and note the narrowing + reason in `PHASE_09_TESTS_QUALITY_GATE_REPORT.md`'s `KNOWN_LIMITATIONS`.

- [ ] **Step 3: Write the CLI wrapper**

Create `backend/scripts/run-quality-gate.ts`:

```ts
// Fase 9 (Quality Gate) — CLI entry. The ONLY file that spawns real
// subprocesses. Deterministic order (documented per spec item 11):
// backend tests -> backend build -> backend scripts typecheck ->
// frontend tests -> frontend build -> config package validation (all) ->
// generic engine architecture scan. AGGREGATE mode — every step always
// runs (see qualityGate.ts).
//
// TEST_ENVIRONMENT_SAFETY (Fase 9 spec item 13): this is the exhaustive,
// explicit list of every command this gate runs. It NEVER runs
// config:activate, config:import, sessions:mark-abandoned, or
// sessions:mark-stale-evaluating — those are live, Firestore-writing
// operator scripts, not gate steps. Adding a new step means adding it
// here AND to PHASE_09_TESTS_QUALITY_GATE_REPORT.md's
// TEST_ENVIRONMENT_SAFETY section, never silently.

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runQualityGateSteps, formatReport, computeExitCode, type QualityGateStep } from "./qualityGate.js";

const BACKEND_DIR = fileURLToPath(new URL("../", import.meta.url));
const FRONTEND_DIR = fileURLToPath(new URL("../../frontend/", import.meta.url));

function npmRunStep(name: string, script: string, cwd: string): QualityGateStep {
  return {
    name,
    run: async () => {
      const result = spawnSync("npm", ["run", script], { cwd, stdio: "inherit" });
      return { ok: result.status === 0 };
    },
  };
}

function npmTestStep(name: string, cwd: string): QualityGateStep {
  return {
    name,
    run: async () => {
      const result = spawnSync("npm", ["test"], { cwd, stdio: "inherit" });
      return { ok: result.status === 0 };
    },
  };
}

const STEPS: QualityGateStep[] = [
  npmTestStep("backend tests", BACKEND_DIR),
  npmRunStep("backend build", "build", BACKEND_DIR),
  npmRunStep("backend scripts typecheck", "typecheck:scripts", BACKEND_DIR),
  npmTestStep("frontend tests", FRONTEND_DIR),
  npmRunStep("frontend build", "build", FRONTEND_DIR),
  npmRunStep("config package validation (all)", "config:validate-all", BACKEND_DIR),
  npmRunStep("generic engine architecture scan", "architecture:scan", BACKEND_DIR),
];

async function main() {
  const run = await runQualityGateSteps(STEPS);
  console.log("\n" + formatReport(run) + "\n");
  process.exit(computeExitCode(run));
}

main();
```

- [ ] **Step 4: Wire the npm scripts**

Modify `backend/package.json` — add to `"scripts"`:

```json
"quality:gate": "tsx scripts/run-quality-gate.ts"
```

Modify root `package.json` — add to `"scripts"`:

```json
"quality:gate": "npm run quality:gate --workspace=backend"
```

- [ ] **Step 5: Run the full gate for real and verify operator-friendly output**

Run: `npm run quality:gate` (from repo root)
Expected: exit 0, output shows one `[PASS] <step name> (<ms>ms)` line per step in the documented order, ending with `QUALITY GATE: PASS (7/7 steps)`.

- [ ] **Step 6: Commit**

```bash
git add backend/scripts/run-quality-gate.ts backend/tsconfig.quality-gate.json backend/package.json package.json
git commit -m "Fase 9: wire npm run quality:gate (backend+frontend tests/build, config validation, architecture scan)"
```

---

### Task 6: CI decision — minimal GitHub Actions workflow

**Files:**
- Create: `.github/workflows/quality-gate.yml`

**Interfaces:**
- Consumes: `npm run quality:gate` from Task 5. No other interface — this is the CI decision required by spec item 20 (no CI existed before this plan).

- [ ] **Step 1: Create the workflow**

Create `.github/workflows/quality-gate.yml`:

```yaml
name: Quality Gate

on:
  pull_request:
  push:
    branches: [master]

jobs:
  quality-gate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "20"
          cache: "npm"
      - run: npm ci
      - run: npm run quality:gate
```

- [ ] **Step 2: Sanity-check no secrets/deploy are involved**

Confirm by reading the file back: no `secrets.` reference, no deploy step, no Firestore/OpenRouter/ElevenLabs credentials referenced — the job only runs `npm ci` and `npm run quality:gate`, both fully offline per Task 5.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/quality-gate.yml
git commit -m "Fase 9: minimal CI workflow running quality:gate on pull_request and push to master"
```

---

### Task 7: Full verification, PHASE_09 report, push

**Files:**
- Create: `PHASE_09_TESTS_QUALITY_GATE_REPORT.md` (repo root, alongside the existing `PHASE_0N_*_REPORT.md` files)

**Interfaces:** None — this task only runs and documents; it does not add code.

- [ ] **Step 1: Run the full gate one final time from a clean state**

Run: `npm run quality:gate` (repo root)
Record the exact output (step names, timings, final PASS/FAIL line) — this goes verbatim into the report's `QUALITY_GATE_STEPS`/`TEST_RESULTS` sections.

- [ ] **Step 2: Run backend and frontend test counts explicitly for the report**

Run: `cd backend && npx vitest run` (record exact file/test counts)
Run: `cd frontend && npx vitest run` (record exact file/test counts)
Confirm both match or exceed the Fase 8 baseline (24/335 backend, 2/8 frontend) — new test files from Tasks 1–4 add to these counts; no existing test should have been modified or removed.

- [ ] **Step 3: Write `PHASE_09_TESTS_QUALITY_GATE_REPORT.md`**

Sections (per spec item 26), filled with real evidence gathered during this plan's execution — not placeholders:
`WHAT_CHANGED`, `TEST_INVENTORY` (the domain table from this plan's inventory findings), `CRITICAL_INVARIANT_MATRIX`, `AUTH_COVERAGE` through `TRUST_PROXY_COVERAGE` (one line each, citing exact existing test file/line evidence — no new tests needed, already covered), `STATIC_ARCHITECTURE_CHECKS` (the 5 rules, their allowlist entries, and why), `QUALITY_GATE_COMMAND` (`npm run quality:gate`), `QUALITY_GATE_STEPS` (the 7 ordered steps and the explicit "never runs" list from `run-quality-gate.ts`'s header comment), `OFFLINE_SAFETY` (no step touches Firestore/OpenRouter/ElevenLabs — cite each mocking pattern from the inventory), `CI_DECISION` (created `.github/workflows/quality-gate.yml`, no secrets, why), `NEGATIVE_CONTROLS` (both, with the exact test names), `FILES_CHANGED`/`TESTS_ADDED` (the full list from Tasks 1–6), `TEST_RESULTS`/`BUILD_RESULTS`/`QUALITY_GATE_RESULT` (from Steps 1–2 above), `SECURITY_IMPACT`/`MULTITENANT_IMPACT` ("none — no product code changed, only tests/tooling"), `KNOWN_LIMITATIONS`/`TEST_DEBT` (Firestore SDK never mocked; operational scripts' `main()` I/O untested; any `tsconfig.quality-gate.json` narrowing from Task 5 Step 2), `DEFERRED_TO_PHASE_10`/`OPEN_ITEMS` (Firestore SDK mock, script I/O tests — explicitly named as candidates, not silently dropped).

- [ ] **Step 4: Commit and push**

```bash
git add PHASE_09_TESTS_QUALITY_GATE_REPORT.md
git commit -m "Doc: PHASE_09_TESTS_QUALITY_GATE_REPORT"
git push origin master
```

(Per this repo's standing instruction: push to `origin/master` right after every commit in this repo — do this after each of Tasks 1–7's commits, not only the last one.)
