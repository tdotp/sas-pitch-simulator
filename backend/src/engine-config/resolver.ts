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
import type { ResolvedScenarioConfig } from "./schema.js";

const defaultLoader = new FileConfigPackageLoader();

// Narrow interface so resolver.ts depends only on the two reads it
// actually needs — tests inject a fake in-memory implementation instead
// of touching Firestore (or the module-level in-memory fallback, which
// would leak state across tests sharing the same organizationId).
export interface ConfigVersionRegistry {
  resolveActiveVersion(organizationId: string): Promise<string | null>;
}
const defaultRegistry: ConfigVersionRegistry = {
  resolveActiveVersion: configVersionsRepo.resolveActiveVersion,
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
