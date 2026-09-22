// Loads and validates a client's config package.
//
// STORAGE_STRATEGY (Phase 5): reads from local JSON fixture files under
// backend/config-packages/<organizationId>/<version>/ — but every caller
// depends only on the `ConfigPackageLoader` interface below, never on the
// filesystem directly. Swapping this for a Firestore-backed loader later
// (Phase 6/12) means writing one new class that implements the same
// interface; nothing in engine-config/resolver.ts or backend/src/engine/*
// changes. See STORAGE_STRATEGY in PHASE_05_ENGINE_CONFIG_REPORT.md.
//
// Two validation passes, both required before a package is usable:
//   1. STRUCTURAL (Zod): does each JSON file match its schema?
//   2. SEMANTIC (this file): do cross-references resolve? Any duplicate
//      ids? Does the manifest match what's actually on disk?
// A package failing either pass is unusable — resolveScenarioConfig()
// (resolver.ts) never returns a partially-valid result.

import { readFile, readdir } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { join } from "node:path";
import {
  ManifestSchema,
  ClientConfigSchema,
  InterviewerProfileSchema,
  ScenarioSchema,
  EvaluationFrameworkSchema,
  ContentSourceSchema,
  type ConfigPackage,
} from "./schema.js";

export type ConfigPackageResult =
  | { valid: true; pkg: ConfigPackage }
  | { valid: false; errors: string[] };

export interface ConfigPackageLoader {
  /**
   * Loads and fully validates (structural + semantic) the config package
   * for one organization. Returns `valid: false` with human-readable
   * errors instead of throwing — a missing/invalid package is an
   * ordinary, expected outcome (e.g. an org with no config yet), not a
   * crash.
   */
  loadPackage(organizationId: string): Promise<ConfigPackageResult>;
}

const DEFAULT_ROOT = new URL("../../config-packages/", import.meta.url);

async function readJson(path: string): Promise<unknown> {
  const raw = await readFile(path, "utf-8");
  return JSON.parse(raw);
}

async function readJsonDir(dir: string): Promise<Array<{ file: string; data: unknown }>> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const jsonFiles = entries.filter((f) => f.endsWith(".json")).sort();
  return Promise.all(
    jsonFiles.map(async (file) => ({ file, data: await readJson(join(dir, file)) }))
  );
}

// Picks the package version to load for an organization. Phase 5 keeps
// this deliberately trivial (the only "active" version directory found) —
// real version selection (pinning, provenance per session) is Phase 6.
async function pickVersionDir(orgDir: string): Promise<string | null> {
  let entries: string[];
  try {
    const dirents: Dirent[] = await readdir(orgDir, { withFileTypes: true });
    entries = dirents.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return null;
  }
  // Prefer a directory literally named by semantic-ish version, sorted
  // descending so "v2" beats "v1" if both exist. Phase 5 fixtures only
  // ever have one.
  entries.sort().reverse();
  return entries[0] ?? null;
}

export class FileConfigPackageLoader implements ConfigPackageLoader {
  constructor(private readonly root: URL = DEFAULT_ROOT) {}

  async loadPackage(organizationId: string): Promise<ConfigPackageResult> {
    const errors: string[] = [];
    const orgDir = new URL(`${organizationId}/`, this.root);

    const version = await pickVersionDir(orgDir.pathname);
    if (!version) {
      return { valid: false, errors: [`No existe config package para organizationId="${organizationId}"`] };
    }
    const versionDir = new URL(`${version}/`, orgDir).pathname;

    // ── manifest.json (structural) ──
    let manifestRaw: unknown;
    try {
      manifestRaw = await readJson(join(versionDir, "manifest.json"));
    } catch (err) {
      return { valid: false, errors: [`No se pudo leer manifest.json: ${(err as Error).message}`] };
    }
    const manifestParsed = ManifestSchema.safeParse(manifestRaw);
    if (!manifestParsed.success) {
      return { valid: false, errors: manifestParsed.error.issues.map((i) => `manifest: ${i.path.join(".")}: ${i.message}`) };
    }
    const manifest = manifestParsed.data;

    if (manifest.organizationId !== organizationId) {
      errors.push(
        `manifest.organizationId ("${manifest.organizationId}") no coincide con la carpeta ("${organizationId}")`
      );
    }

    // ── client.json (structural) ──
    let client;
    try {
      const clientRaw = await readJson(join(versionDir, "client.json"));
      const parsed = ClientConfigSchema.safeParse(clientRaw);
      if (!parsed.success) {
        errors.push(...parsed.error.issues.map((i) => `client.json: ${i.path.join(".")}: ${i.message}`));
      } else {
        client = parsed.data;
        if (client.organizationId !== organizationId) {
          errors.push(`client.organizationId ("${client.organizationId}") no coincide con "${organizationId}"`);
        }
      }
    } catch (err) {
      errors.push(`No se pudo leer client.json: ${(err as Error).message}`);
    }

    // ── each entity directory (structural per file) ──
    const interviewerProfiles = (await readJsonDir(join(versionDir, "interviewer-profiles"))).flatMap(
      ({ file, data }) => {
        const parsed = InterviewerProfileSchema.safeParse(data);
        if (!parsed.success) {
          errors.push(...parsed.error.issues.map((i) => `interviewer-profiles/${file}: ${i.path.join(".")}: ${i.message}`));
          return [];
        }
        return [parsed.data];
      }
    );

    const scenarios = (await readJsonDir(join(versionDir, "scenarios"))).flatMap(({ file, data }) => {
      const parsed = ScenarioSchema.safeParse(data);
      if (!parsed.success) {
        errors.push(...parsed.error.issues.map((i) => `scenarios/${file}: ${i.path.join(".")}: ${i.message}`));
        return [];
      }
      return [parsed.data];
    });

    const evaluationFrameworks = (await readJsonDir(join(versionDir, "evaluation-frameworks"))).flatMap(
      ({ file, data }) => {
        const parsed = EvaluationFrameworkSchema.safeParse(data);
        if (!parsed.success) {
          errors.push(...parsed.error.issues.map((i) => `evaluation-frameworks/${file}: ${i.path.join(".")}: ${i.message}`));
          return [];
        }
        return [parsed.data];
      }
    );

    const contentSources = (await readJsonDir(join(versionDir, "content"))).flatMap(({ file, data }) => {
      const parsed = ContentSourceSchema.safeParse(data);
      if (!parsed.success) {
        errors.push(...parsed.error.issues.map((i) => `content/${file}: ${i.path.join(".")}: ${i.message}`));
        return [];
      }
      return [parsed.data];
    });

    if (errors.length > 0 || !client) {
      return { valid: false, errors };
    }

    // ── SEMANTIC VALIDATION (cross-references) ──
    const semanticErrors = validatePackageReferences({
      manifest,
      client,
      interviewerProfiles,
      scenarios,
      evaluationFrameworks,
      contentSources,
    });
    if (semanticErrors.length > 0) {
      return { valid: false, errors: semanticErrors };
    }

    return {
      valid: true,
      pkg: { manifest, client, interviewerProfiles, scenarios, evaluationFrameworks, contentSources },
    };
  }
}

// Exported separately so it can be unit-tested against hand-built
// fixtures without touching the filesystem.
export function validatePackageReferences(pkg: ConfigPackage): string[] {
  const errors: string[] = [];

  const dupes = (ids: string[], label: string) => {
    const seen = ids.filter((id, i) => ids.indexOf(id) !== i);
    if (seen.length > 0) errors.push(`ids duplicados en ${label}: ${[...new Set(seen)].join(", ")}`);
  };

  dupes(pkg.interviewerProfiles.map((p) => p.id), "interviewer-profiles");
  dupes(pkg.scenarios.map((s) => s.id), "scenarios");
  dupes(pkg.evaluationFrameworks.map((f) => f.id), "evaluation-frameworks");
  dupes(pkg.contentSources.map((c) => c.id), "content-sources");

  const profileIds = new Set(pkg.interviewerProfiles.map((p) => p.id));
  const frameworkIds = new Set(pkg.evaluationFrameworks.map((f) => f.id));
  const contentIds = new Set(pkg.contentSources.map((c) => c.id));

  for (const scenario of pkg.scenarios) {
    if (!profileIds.has(scenario.interviewerProfileId)) {
      errors.push(
        `scenario "${scenario.id}" referencia interviewerProfileId "${scenario.interviewerProfileId}" que no existe`
      );
    }
    if (!frameworkIds.has(scenario.evaluationFrameworkId)) {
      errors.push(
        `scenario "${scenario.id}" referencia evaluationFrameworkId "${scenario.evaluationFrameworkId}" que no existe`
      );
    }
    for (const contentId of scenario.contentSourceIds) {
      if (!contentIds.has(contentId)) {
        errors.push(`scenario "${scenario.id}" referencia contentSourceId "${contentId}" que no existe`);
      }
    }
  }

  if (pkg.client.defaultScenarioId) {
    const scenarioIds = new Set(pkg.scenarios.map((s) => s.id));
    if (!scenarioIds.has(pkg.client.defaultScenarioId)) {
      errors.push(`client.defaultScenarioId "${pkg.client.defaultScenarioId}" no existe entre los scenarios`);
    }
  }

  // MANIFEST_COMPLETENESS: the manifest is a human-facing table of
  // contents — if it lists an id that isn't actually on disk (or omits
  // one that is), that's a real authoring error, not a cosmetic one; a
  // reviewer trusting the manifest could miss what's really shipping.
  const checkManifestList = (declared: string[], actualIds: string[], label: string) => {
    const actual = new Set(actualIds);
    for (const id of declared) {
      if (!actual.has(id)) errors.push(`manifest declara "${id}" en ${label} pero no se encontró el archivo`);
    }
    for (const id of actualIds) {
      if (!declared.includes(id)) errors.push(`${label}/${id} existe pero no está declarado en manifest`);
    }
  };
  checkManifestList(pkg.manifest.interviewerProfiles, pkg.interviewerProfiles.map((p) => p.id), "interviewer-profiles");
  checkManifestList(pkg.manifest.scenarios, pkg.scenarios.map((s) => s.id), "scenarios");
  checkManifestList(pkg.manifest.evaluationFrameworks, pkg.evaluationFrameworks.map((f) => f.id), "evaluation-frameworks");
  checkManifestList(pkg.manifest.contentSources, pkg.contentSources.map((c) => c.id), "content-sources");

  return errors;
}
