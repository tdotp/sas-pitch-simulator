// Config version REGISTRY — Phase 6: the ONE authority for which config
// version is `active` for an organization. See VERSION_MODEL and
// ACTIVE_VERSION_MODEL in PHASE_06_CONFIG_VERSIONING_PROVENANCE_REPORT.md.
//
// Mirrors repositories/sessions.ts's established shape: Firestore-backed
// when persistence is enabled, an in-memory fallback otherwise (local dev
// without credentials — same PERSISTENCE_DISABLED escape hatch, same
// non-atomic-but-single-process caveat).
//
// STORAGE_DECISION (Phase 6): package CONTENT (manifest/client/scenarios/
// interviewer-profiles/evaluation-frameworks/content) stays on the
// filesystem, git-versioned (see engine-config/loader.ts) — simple,
// auditable, PR history, easy rollback. Only the ACTIVE-VERSION POINTER
// and per-version status/provenance live here, in Firestore — so
// activating a new version is a data change, not a deploy. This is
// exactly the hybrid the Phase 6 spec suggested and explicitly permitted
// ("content/package files → Git/storage, active version pointer →
// Firestore") — not a move of the whole system to Firestore.
//
// Firestore layout:
//   config_versions/{organizationId}                       — org pointer doc: { activeVersion }
//   config_versions/{organizationId}/versions/{version}     — one ConfigPackageVersion per version

import admin from "firebase-admin";
import { isPersistenceEnabled } from "../firebase.js";
import type { ConfigPackageVersion, ConfigVersionStatus } from "../engine-config/schema.js";
import { FileConfigPackageLoader, type ConfigPackageLoader } from "../engine-config/loader.js";
import { computeConfigHash } from "../engine-config/configHash.js";

const COLLECTION = "config_versions";

function nowIso(): string {
  return new Date().toISOString();
}

function orgDoc(organizationId: string) {
  return admin.firestore().collection(COLLECTION).doc(organizationId);
}

function versionDoc(organizationId: string, version: string) {
  return orgDoc(organizationId).collection("versions").doc(version);
}

// ── In-memory fallback (PERSISTENCE_DISABLED) ──────────────────────
// Keyed exactly like the Firestore layout: one pointer per org, one
// record per (org, version). Module-level, like sessions.ts's
// memoryStore — fine for local dev / a single test process.
const memoryPointers = new Map<string, string>(); // organizationId -> activeVersion
const memoryVersions = new Map<string, ConfigPackageVersion>(); // `${org}::${version}` -> record

function memKey(organizationId: string, version: string): string {
  return `${organizationId}::${version}`;
}

// ── Reads ────────────────────────────────────────────────────────

export async function resolveActiveVersion(organizationId: string): Promise<string | null> {
  if (!isPersistenceEnabled()) {
    return memoryPointers.get(organizationId) ?? null;
  }
  const snap = await orgDoc(organizationId).get();
  return (snap.data()?.activeVersion as string | undefined) ?? null;
}

export async function getVersion(organizationId: string, version: string): Promise<ConfigPackageVersion | null> {
  if (!isPersistenceEnabled()) {
    return memoryVersions.get(memKey(organizationId, version)) ?? null;
  }
  const snap = await versionDoc(organizationId, version).get();
  if (!snap.exists) return null;
  return snap.data() as ConfigPackageVersion;
}

// Enumeration for tooling/reporting only (e.g. a future `config:list`),
// not consulted by any resolution path.
export async function listVersions(organizationId: string): Promise<ConfigPackageVersion[]> {
  if (!isPersistenceEnabled()) {
    return [...memoryVersions.entries()]
      .filter(([key]) => key.startsWith(`${organizationId}::`))
      .map(([, v]) => v);
  }
  const snap = await orgDoc(organizationId).collection("versions").get();
  return snap.docs.map((d) => d.data() as ConfigPackageVersion);
}

// ── Writes ───────────────────────────────────────────────────────

// Registers a version as `draft` if it isn't registered yet. Idempotent:
// an existing entry (whatever its status) is returned UNCHANGED — this
// must never downgrade an active/deprecated version back to draft just
// because someone re-ran the import tool against the same version.
export async function registerDraftVersion(
  organizationId: string,
  version: string
): Promise<{ created: boolean; record: ConfigPackageVersion }> {
  const existing = await getVersion(organizationId, version);
  if (existing) return { created: false, record: existing };

  const record: ConfigPackageVersion = {
    organizationId,
    version,
    status: "draft",
    createdAt: nowIso(),
  };

  if (!isPersistenceEnabled()) {
    memoryVersions.set(memKey(organizationId, version), record);
    return { created: true, record };
  }
  await versionDoc(organizationId, version).set(record);
  return { created: true, record };
}

export type ActivationResult =
  | { outcome: "activated"; record: ConfigPackageVersion; previousActiveVersion: string | null }
  | { outcome: "invalid_package"; errors: string[] }
  // IMMUTABILITY_POLICY: this version was already activated once before,
  // with a DIFFERENT recorded content hash — the files were edited in
  // place after use. Refused; a real content change must ship as a new
  // version. See CONTENT_HASH_DECISION in the Phase 6 report.
  | { outcome: "immutability_violation"; version: string; recordedHash: string; currentHash: string };

// NO ACTIVAR CONFIG INVÁLIDA: always re-validates the package's actual
// files (never trusts a stale registry entry) before touching any
// status. Auto-registers a draft entry first if this version was never
// registered — one call can go from "nothing" to "active" (the
// config:import --activate convenience path), while `registerDraftVersion`
// on its own remains the safer two-step flow (draft, then a separate
// activation once QA'd).
export async function activateConfigVersion(
  organizationId: string,
  version: string,
  loader: ConfigPackageLoader = new FileConfigPackageLoader()
): Promise<ActivationResult> {
  const result = await loader.loadPackage(organizationId, version);
  if (!result.valid) {
    return { outcome: "invalid_package", errors: result.errors };
  }

  const existing = await getVersion(organizationId, version);
  if (existing?.configHash && existing.configHash !== result.hash) {
    return {
      outcome: "immutability_violation",
      version,
      recordedHash: existing.configHash,
      currentHash: result.hash,
    };
  }

  if (!isPersistenceEnabled()) {
    const previousActiveVersion = memoryPointers.get(organizationId) ?? null;
    const now = nowIso();
    if (previousActiveVersion && previousActiveVersion !== version) {
      const prevKey = memKey(organizationId, previousActiveVersion);
      const prev = memoryVersions.get(prevKey);
      if (prev) memoryVersions.set(prevKey, { ...prev, status: "deprecated", deprecatedAt: now });
    }
    const record: ConfigPackageVersion = {
      organizationId,
      version,
      status: "active",
      createdAt: existing?.createdAt ?? now,
      activatedAt: now,
      configHash: result.hash,
    };
    memoryVersions.set(memKey(organizationId, version), record);
    memoryPointers.set(organizationId, version);
    return { outcome: "activated", record, previousActiveVersion };
  }

  const orgRef = orgDoc(organizationId);
  const targetRef = versionDoc(organizationId, version);
  return admin.firestore().runTransaction(async (tx): Promise<ActivationResult> => {
    // All reads before any writes — Firestore transaction requirement.
    const orgSnap = await tx.get(orgRef);
    const previousActiveVersion = (orgSnap.data()?.activeVersion as string | undefined) ?? null;
    const previousRef =
      previousActiveVersion && previousActiveVersion !== version
        ? versionDoc(organizationId, previousActiveVersion)
        : null;
    const previousSnap = previousRef ? await tx.get(previousRef) : null;
    const targetSnap = await tx.get(targetRef);

    const now = nowIso();
    const record: ConfigPackageVersion = {
      organizationId,
      version,
      status: "active",
      createdAt: (targetSnap.data()?.createdAt as string | undefined) ?? now,
      activatedAt: now,
      configHash: result.hash,
    };
    tx.set(targetRef, record);
    if (previousRef && previousSnap?.exists) {
      tx.set(previousRef, { status: "deprecated" as ConfigVersionStatus, deprecatedAt: now }, { merge: true });
    }
    tx.set(orgRef, { organizationId, activeVersion: version }, { merge: true });

    return { outcome: "activated", record, previousActiveVersion };
  });
}
