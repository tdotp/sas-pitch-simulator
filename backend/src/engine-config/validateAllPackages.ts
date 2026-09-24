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
