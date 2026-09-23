// CONTENT_HASH_DECISION (Phase 6): a deterministic fingerprint of a
// resolved config package's actual content, independent of file
// formatting/whitespace/key order. Lets the system detect "version says
// v1 but the files were edited in place" — see IMMUTABILITY_POLICY in
// PHASE_06_CONFIG_VERSIONING_PROVENANCE_REPORT.md. Never a substitute for
// the version id itself — the version id is the stable, human-facing
// pointer; the hash is a tamper-evidence signal underneath it.

import { createHash } from "node:crypto";
import type { ConfigPackage } from "./schema.js";

// Canonical JSON: object keys sorted recursively (so key order in the
// source file never changes the hash), array order preserved (the loader
// already reads directory entries in a deterministic, filename-sorted
// order — see readJsonDir in loader.ts — so array order is itself stable
// and IS semantically meaningful, e.g. criteria order).
export function canonicalJSON(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJSON).join(",")}]`;
  }
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const body = keys
    .map((k) => `${JSON.stringify(k)}:${canonicalJSON((value as Record<string, unknown>)[k])}`)
    .join(",");
  return `{${body}}`;
}

// MANIFEST_STATUS_EXCLUSION (PASS_WITH_FIXES decision, documented not
// silently done): `manifest.status` is declared non-authoritative/inert
// everywhere else in this system (see CONTENT_PACKAGE_STATUS in the
// Phase 6 report — repositories/configVersions.ts's registry is the sole
// authority on draft/active/deprecated, manifest.status governs
// nothing). A hash meant to detect real CONTENT drift (IMMUTABILITY_POLICY)
// must not fire on a field that has zero effect on what a session
// actually experiences — flipping manifest.status from "active" to
// "deprecated" changes no prompt, no rubric, no content a spokesperson or
// evaluator ever sees. So it's excluded from the canonical hash input.
// Every other manifest field (organizationId, version, the id lists)
// stays in — those DO reflect what's actually shipping. If manifest.status
// ever becomes authoritative for something real, this exclusion must be
// revisited alongside that change, not silently left stale.
function stripInertManifestFields(pkg: ConfigPackage): ConfigPackage {
  const { status: _status, ...manifestWithoutStatus } = pkg.manifest;
  return { ...pkg, manifest: manifestWithoutStatus as ConfigPackage["manifest"] };
}

// Hashes the VALIDATED, PARSED package (post-Zod, with defaults applied)
// — never the raw file bytes — so re-formatting a JSON file (whitespace,
// key order) never changes the hash, only actual content changes do.
export function computeConfigHash(pkg: ConfigPackage): string {
  return createHash("sha256").update(canonicalJSON(stripInertManifestFields(pkg))).digest("hex");
}
