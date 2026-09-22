// CONFIG_RESOLUTION_FLOW (Phase 5): the ONE function anything in routes.ts
// calls to go from (organizationId, scenarioId) to everything the engine
// needs. Nothing downstream of this function's return value ever needs to
// know which client or which scenario it's running — see
// ResolvedScenarioConfig in schema.ts.
//
// organizationId is ALWAYS req.appContext.organizationId (Phase 2-3,
// server-resolved from Membership) — never anything the client sends as
// authority. scenarioId is the one thing a request may legitimately pick
// (from a menu of what that organization's package actually contains),
// exactly like Phase 2/3's ?organization_id selection pattern: requested,
// then verified against the real package, never trusted blindly.

import { FileConfigPackageLoader, type ConfigPackageLoader } from "./loader.js";
import type { ResolvedScenarioConfig } from "./schema.js";

const defaultLoader = new FileConfigPackageLoader();

export type ResolveScenarioResult =
  | { outcome: "resolved"; config: ResolvedScenarioConfig }
  // The organization has no config package at all, or the package itself
  // fails validation (structural or semantic) — an operator problem, not
  // a per-request one.
  | { outcome: "no_config_for_organization"; errors: string[] }
  // The organizationId is real and has a valid package, but that package
  // doesn't contain this scenarioId. This is the common "bad request"
  // case (typo, stale client, or an org genuinely without that scenario).
  | { outcome: "scenario_not_found" };

export async function resolveScenarioConfig(
  params: { organizationId: string; scenarioId: string },
  loader: ConfigPackageLoader = defaultLoader
): Promise<ResolveScenarioResult> {
  const result = await loader.loadPackage(params.organizationId);
  if (!result.valid) {
    return { outcome: "no_config_for_organization", errors: result.errors };
  }
  const { pkg } = result;

  const scenario = pkg.scenarios.find((s) => s.id === params.scenarioId);
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
      organizationId: params.organizationId,
      client: pkg.client,
      scenario,
      interviewerProfile,
      evaluationFramework,
      contentSources,
    },
  };
}

// Convenience for callers (e.g. /session/end) that only have a
// session's persisted organization_id/scenario_id and need the SAME
// resolution the original /session/start used — no separate code path.
export async function listScenarioIds(
  organizationId: string,
  loader: ConfigPackageLoader = defaultLoader
): Promise<string[]> {
  const result = await loader.loadPackage(organizationId);
  if (!result.valid) return [];
  return result.pkg.scenarios.map((s) => s.id);
}
