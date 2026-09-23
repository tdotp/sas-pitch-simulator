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

// Hashes the VALIDATED, PARSED package (post-Zod, with defaults applied)
// — never the raw file bytes — so re-formatting a JSON file (whitespace,
// key order) never changes the hash, only actual content changes do.
export function computeConfigHash(pkg: ConfigPackage): string {
  return createHash("sha256").update(canonicalJSON(pkg)).digest("hex");
}
