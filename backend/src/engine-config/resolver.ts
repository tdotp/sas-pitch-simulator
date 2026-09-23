// CONFIG_RESOLUTION_FLOW (Phase 5, split in Phase 6): two DISTINCT
// resolution operations, deliberately not one function with an optional
// parameter — see RESOLUTION_API in
// PHASE_06_CONFIG_VERSIONING_PROVENANCE_REPORT.md for why conflating
// them is exactly the bug this phase closes:
//
//   resolveScenarioConfigForNewSession — "what should a BRAND NEW session
//     use right now?" Answer: whatever the registry says is `active` for
//     this organization. Used ONLY by /session/start.
//
//   resolveScenarioConfigForVersion — "what did THIS EXACT version look
//     like?" Answer: exactly that version's files, regardless of what's
//     active today. Used ONLY by /session/end, keyed by the
//     config_version PERSISTED on the session at start time — never by
//     re-deriving "the active version" a second time. This is what makes
//     it impossible for a version activated between /session/start and
//     /session/end to reinterpret an in-flight session (SESSION_PINNING).
//
// organizationId is ALWAYS req.appContext.organizationId (Phase 2-3,
// server-resolved from Membership) — never anything the client sends as
// authority. scenarioId is the one thing a request may legitimately pick
// (from a menu of what that organization's package actually contains),
// exactly like Phase 2/3's ?organization_id selection pattern: requested,
// then verified against the real package, never trusted blindly.

import { FileConfigPackageLoader, type ConfigPackageLoader } from "./loader.js";
import * as configVersionsRepo from "../repositories/configVersions.js";
import type { ResolvedScenarioConfig, ConfigVersionStatus } from "./schema.js";

const defaultLoader = new FileConfigPackageLoader();

// Narrow interface so resolver.ts depends only on the reads it actually
// needs — tests inject a fake in-memory implementation instead of
// touching Firestore (or the module-level in-memory fallback, which
// would leak state across tests sharing the same organizationId).
//
// PASS_WITH_FIXES (config hash as a real precondition): `getVersion` was
// added here — a "coherent additional read", not a redesign — so
// resolveScenarioConfigForNewSession can compare the hash the registry
// recorded at activation time against what's ACTUALLY on disk right now.
// Without this, a version activated with hash AAA whose files are edited
// in place to BBB afterward (a direct violation of IMMUTABILITY_POLICY —
// see the Phase 6 report) would keep silently serving BBB to brand new
// sessions forever, with nothing in the system ever noticing.
//
// PASS_WITH_FIXES (2nd round): the earlier version of this check only
// fired when `activeRecord?.configHash` was truthy — an ABSENT record or
// a record with no `configHash` silently skipped the comparison and let
// the session start anyway. A verifiable version record (one that
// exists, carries a configHash, and — when status is available — is
// actually `active`) is now a REQUIRED precondition, not an optional
// bonus check.
export interface ConfigVersionRegistry {
  resolveActiveVersion(organizationId: string): Promise<string | null>;
  getVersion(
    organizationId: string,
    version: string
  ): Promise<{ configHash?: string; status?: ConfigVersionStatus } | null>;
}
const defaultRegistry: ConfigVersionRegistry = {
  resolveActiveVersion: configVersionsRepo.resolveActiveVersion,
  getVersion: configVersionsRepo.getVersion,
};

// Precise, DISTINCT return types per function — not one shared union —
// so "resolved for a new session" and "resolved for a pinned version"
// each only ever carry the outcomes they can actually produce. Sharing
// one union here would force every caller to handle an outcome that
// literally cannot happen on that path, which defeats the point of
// splitting the two operations in the first place.

export type ResolveForNewSessionResult =
  | { outcome: "resolved"; config: ResolvedScenarioConfig }
  // The organization has no ACTIVE version right now (never registered
  // one, or its active package fails validation) — an operator problem,
  // not a per-request one.
  | { outcome: "no_config_for_organization"; errors: string[] }
  // The organizationId+version are real, but that package doesn't
  // contain this scenarioId. The common "bad request" case.
  | { outcome: "scenario_not_found" };

export type ResolveForVersionResult =
  | { outcome: "resolved"; config: ResolvedScenarioConfig }
  // The PINNED config_version doesn't exist (or no longer validates) on
  // disk. A session must never fall back to "whatever's active" here —
  // that would silently reinterpret it. See LEGACY_SESSION_POLICY and
  // SESSION_END_FLOW in the Phase 6 report.
  | { outcome: "unknown_config_version"; errors: string[] }
  | { outcome: "scenario_not_found" };

function assembleConfig(
  organizationId: string,
  configVersion: string,
  configHash: string,
  pkg: import("./schema.js").ConfigPackage,
  scenarioId: string
): { outcome: "resolved"; config: ResolvedScenarioConfig } | { outcome: "scenario_not_found" } {
  const scenario = pkg.scenarios.find((s) => s.id === scenarioId);
  if (!scenario) {
    return { outcome: "scenario_not_found" };
  }
  // These lookups cannot fail — validatePackageReferences (loader.ts)
  // already guaranteed every scenario's references resolve within the
  // same package before this package was ever returned as `valid: true`.
  const interviewerProfile = pkg.interviewerProfiles.find((p) => p.id === scenario.interviewerProfileId)!;
  const evaluationFramework = pkg.evaluationFrameworks.find((f) => f.id === scenario.evaluationFrameworkId)!;
  const contentSources = pkg.contentSources.filter((c) => scenario.contentSourceIds.includes(c.id));

  return {
    outcome: "resolved",
    config: {
      organizationId,
      configVersion,
      configHash,
      client: pkg.client,
      scenario,
      interviewerProfile,
      evaluationFramework,
      contentSources,
    },
  };
}

// /session/start: resolve whatever is ACTIVE for this organization right
// now. This is the ONLY resolution path allowed to consult the version
// registry's "active" pointer.
export async function resolveScenarioConfigForNewSession(
  params: { organizationId: string; scenarioId: string },
  deps: { loader?: ConfigPackageLoader; registry?: ConfigVersionRegistry } = {}
): Promise<ResolveForNewSessionResult> {
  const loader = deps.loader ?? defaultLoader;
  const registry = deps.registry ?? defaultRegistry;

  const activeVersion = await registry.resolveActiveVersion(params.organizationId);
  if (!activeVersion) {
    return {
      outcome: "no_config_for_organization",
      errors: [`No hay ninguna versión ACTIVE registrada para organizationId="${params.organizationId}"`],
    };
  }

  const result = await loader.loadPackage(params.organizationId, activeVersion);
  if (!result.valid) {
    return { outcome: "no_config_for_organization", errors: result.errors };
  }

  // CONFIG_DRIFT_DETECTION: a NEW session may only start against a
  // VERIFIABLE active version record — one that exists, carries a
  // configHash, and (when status is available) is genuinely `active`.
  // Any absence or inconsistency fails closed with the SAME generic
  // outcome/errors[] shape as every other config problem here — the
  // client only ever sees "no config available"; the specific integrity
  // reason stays server-side (see routes.ts's console.error for this
  // outcome).
  const activeRecord = await registry.getVersion(params.organizationId, activeVersion);
  const integrityDrift = (reason: string) => ({
    outcome: "no_config_for_organization" as const,
    errors: [
      `CONFIG_INTEGRITY_DRIFT: ${reason} — organizationId="${params.organizationId}" activeVersion="${activeVersion}".`,
    ],
  });

  if (!activeRecord) {
    // The pointer says this version is active, but the registry has no
    // record for it at all — cannot verify anything about it. Never
    // treat "unverifiable" as "presumably fine".
    return integrityDrift("el pointer active no tiene un version record verificable");
  }
  if (!activeRecord.configHash) {
    return integrityDrift("el version record active no tiene configHash registrado");
  }
  if (activeRecord.status !== undefined && activeRecord.status !== "active") {
    return integrityDrift(
      `el version record correspondiente al pointer tiene status="${activeRecord.status}", no "active"`
    );
  }
  if (activeRecord.configHash !== result.hash) {
    // A mismatch means the files for the ACTIVE version were edited in
    // place after activation — exactly the IMMUTABILITY_POLICY violation
    // activateConfigVersion() refuses on re-activation, caught here too
    // so it can't silently start serving NEW sessions between
    // activations.
    return integrityDrift(
      `hash registrado ("${activeRecord.configHash}") no coincide con el hash actual de los archivos ("${result.hash}") ` +
        `— contenido modificado en sitio sin re-activar (viola IMMUTABILITY_POLICY)`
    );
  }

  return assembleConfig(params.organizationId, activeVersion, result.hash, result.pkg, params.scenarioId);
}

// /session/end: resolve EXACTLY the version pinned on the session
// (SessionRecord.config_provenance.config_version) — never "whatever is
// active today". Deliberately does NOT consult the version registry: the
// files for a version that was ever active still exist on disk
// regardless of its CURRENT registry status (active or deprecated —
// deprecated versions must still resolve for their historical sessions,
// see DEPRECATION_FLOW). If the pinned version's files are gone or no
// longer validate, that is exactly `unknown_config_version` — fail
// closed, never substitute the active version.
export async function resolveScenarioConfigForVersion(
  params: { organizationId: string; scenarioId: string; configVersion: string },
  deps: { loader?: ConfigPackageLoader } = {}
): Promise<ResolveForVersionResult> {
  const loader = deps.loader ?? defaultLoader;

  const result = await loader.loadPackage(params.organizationId, params.configVersion);
  if (!result.valid) {
    return { outcome: "unknown_config_version", errors: result.errors };
  }
  return assembleConfig(params.organizationId, params.configVersion, result.hash, result.pkg, params.scenarioId);
}
