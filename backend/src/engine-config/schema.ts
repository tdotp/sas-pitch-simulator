// Phase 5 — ENGINE vs CONFIG domain schemas.
//
// These types are the ONLY vocabulary the training engine is allowed to
// know about. Nothing in here, or in backend/src/engine/*, may reference
// a client/company name, a specific scenario id, or branch on
// `organizationId`/`scenarioId` — those only ever flow through as opaque
// strings used to look things up. See PHASE_05_ENGINE_CONFIG_REPORT.md
// for the full model and the reasoning behind each shape.
//
// Runtime-validated with Zod — never a TypeScript cast. A config package
// that doesn't parse (structurally) or doesn't pass the semantic checks
// in loader.ts (cross-references) must fail BEFORE a session can start,
// not silently produce a broken prompt.

import { z } from "zod";

// ── Shared primitives ───────────────────────────────────────────

// kebab-case OR snake_case, lowercase alphanumeric. Snake_case is allowed
// specifically so existing scenario ids ("grupo_aval") can carry over
// byte-for-byte from the pre-Phase-5 TargetMode values — see
// TARGET_MODE_MIGRATION in PHASE_05_ENGINE_CONFIG_REPORT.md.
export const IdSchema = z
  .string()
  .min(1)
  .regex(/^[a-z0-9][a-z0-9_-]*$/, "id debe ser lowercase alfanumérico con guiones o guiones bajos");

// ── ContentSource ───────────────────────────────────────────────
// Prose knowledge injected into the interviewer/evaluator prompts —
// facts, messaging, restrictions, playbook material. Deliberately just
// structured text, not a vector store: see CONTENT_SOURCE_MODEL in the
// report for why RAG is out of scope until there's a real volume need.

export const ContentSourceTypeSchema = z.enum([
  "company_context",
  "key_messages",
  "facts",
  "restrictions",
  "faq",
  "playbook",
]);

export const ContentSourceSchema = z.object({
  id: IdSchema,
  type: ContentSourceTypeSchema,
  title: z.string().min(1),
  body: z.string().min(1),
});
export type ContentSource = z.infer<typeof ContentSourceSchema>;

// ── InterviewerProfile ──────────────────────────────────────────
// How the simulated interviewer behaves. No code, no branching — just
// data the engine's generic prompt builder assembles the same way for
// every client.

export const VoiceSlotSchema = z.enum(["male", "female", "random"]);

export const FollowUpBehaviorSchema = z.object({
  // How many follow-up questions the interviewer must ask, in order,
  // anchored to the caller's previous answer. The ENGINE enforces this
  // count generically (see engine/promptBuilder.ts) — only the number and
  // the candidate question banks are config.
  requiredCount: z.number().int().min(0).max(10).default(2),
  // Questions specific to this profile, asked before falling back to the
  // shared pool.
  specificQuestions: z.array(z.string().min(1)).default([]),
  // Questions shared across this profile's own question bank (NOT shared
  // across the whole engine — each profile owns its pool; two profiles
  // happening to reuse the same wording is a config choice, not an
  // engine assumption).
  sharedQuestions: z.array(z.string().min(1)).default([]),
});

export const InterviewerProfileSchema = z.object({
  id: IdSchema,
  name: z.string().min(1),
  // Full persona description injected verbatim near the top of the
  // system prompt — who the interviewer is, their stance, what they
  // reject. Free text, not parsed by the engine.
  persona: z.string().min(1),
  // Short tone/register guidance (e.g. "ejecutivo, sobrio y directo").
  tone: z.string().min(1),
  // Free-text guidance on how the interviewer questions/pushes back
  // DURING the pitch (before the mandatory follow-ups) — e.g. what to
  // watch for, what to react to.
  questioningBehavior: z.string().min(1),
  followUpBehavior: FollowUpBehaviorSchema,
  voice: z.object({
    slot: VoiceSlotSchema.default("random"),
  }),
});
export type InterviewerProfile = z.infer<typeof InterviewerProfileSchema>;

// ── EvaluationFramework ─────────────────────────────────────────
// Replaces the old rubricas_sas.json import in evaluator.ts. The
// evaluator consumes ONE of these, resolved per scenario — it never
// imports a fixed rubric itself.

export const CriterionSchema = z.object({
  id: IdSchema,
  name: z.string().min(1),
  weight: z.number().positive(),
  description: z.string().min(1),
});

// Phase 5 fix (PASS_WITH_FIXES): a named, evidence-checkable requirement
// this framework wants the evaluator to look for in the transcript (e.g.
// "mentioned the brand", "cited a specific policy"). Purely config data —
// the engine never hardcodes which requirements exist, only the generic
// {id, detected, evidence} shape it asks the LLM to fill in per requirement
// (see EvaluationResult.detected_requirements in types.ts and
// evaluatorPromptBuilder.ts). Additive to the EvaluationFramework shape
// that already existed in Phase 5 — optional/defaulted so no existing
// framework file needs to change unless it wants this mechanism.
export const RequirementSchema = z.object({
  id: IdSchema,
  description: z.string().min(1),
});
export type Requirement = z.infer<typeof RequirementSchema>;

export const DurationPolicySchema = z.object({
  idealSeconds: z.number().positive(),
  maxSeconds: z.number().positive(),
  // Named scoring bands, e.g. { lte_90: 100, lte_120: 80, ... }. Free-form
  // because the exact bands are a client's evaluation choice, not an
  // engine concept.
  scoring: z.record(z.string(), z.number()).optional(),
});

export const EvaluationFrameworkSchema = z
  .object({
    id: IdSchema,
    name: z.string().min(1),
    maxScore: z.number().positive().default(100),
    criteria: z.array(CriterionSchema).min(1),
    observableRules: z.array(z.string()).default([]),
    // Optional: named requirements the evaluator must explicitly detect,
    // see RequirementSchema above. Empty by default — a framework that
    // only needs criteria/observableRules/mustReward/mustPenalize/
    // evaluationInstructions (davivienda-v1, grupo-aval-v1) doesn't need
    // this.
    requirements: z.array(RequirementSchema).default([]),
    durationPolicy: DurationPolicySchema.optional(),
    mustReward: z.array(z.string()).default([]),
    mustPenalize: z.array(z.string()).default([]),
    // Extra free-text instructions specific to this framework (e.g. "no
    // atribuyas opiniones privadas a Javier Suárez") — appended to the
    // engine's universal evaluator instructions, never replacing them.
    evaluationInstructions: z.string().min(1),
  })
  .superRefine((fw, ctx) => {
    const ids = fw.criteria.map((c) => c.id);
    const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
    if (dupes.length > 0) {
      ctx.addIssue({
        code: "custom",
        message: `criterion ids duplicados: ${[...new Set(dupes)].join(", ")}`,
        path: ["criteria"],
      });
    }
    const reqIds = fw.requirements.map((r) => r.id);
    const reqDupes = reqIds.filter((id, i) => reqIds.indexOf(id) !== i);
    if (reqDupes.length > 0) {
      ctx.addIssue({
        code: "custom",
        message: `requirement ids duplicados: ${[...new Set(reqDupes)].join(", ")}`,
        path: ["requirements"],
      });
    }
    // WEIGHTS_SUM_RULE (documented explicitly, not invented): every
    // rubric this product has ever used (generic, Davivienda, Grupo
    // Aval) sums its criteria to exactly `maxScore` (100) — that's how
    // the real evaluation model already worked before this phase, not a
    // new constraint introduced here. See EVALUATION_FRAMEWORK_MODEL in
    // PHASE_05_ENGINE_CONFIG_REPORT.md.
    const sum = fw.criteria.reduce((acc, c) => acc + c.weight, 0);
    if (Math.round(sum * 100) !== Math.round(fw.maxScore * 100)) {
      ctx.addIssue({
        code: "custom",
        message: `los pesos de los criterios suman ${sum}, se esperaba ${fw.maxScore} (WEIGHTS_SUM_RULE)`,
        path: ["criteria"],
      });
    }
  });
export type EvaluationFramework = z.infer<typeof EvaluationFrameworkSchema>;

// ── Scenario ─────────────────────────────────────────────────────
// A concrete training experience. Composition by reference ONLY — no
// duplicated prompt/rubric text lives here.

export const ScenarioSchema = z.object({
  id: IdSchema,
  name: z.string().min(1),
  description: z.string().min(1),
  interviewerProfileId: IdSchema,
  evaluationFrameworkId: IdSchema,
  contentSourceIds: z.array(IdSchema).default([]),
  timing: z.object({
    idealSeconds: z.number().positive(),
    maxSeconds: z.number().positive(),
  }),
  // The agent's opening line (ElevenLabs `first_message`).
  firstMessage: z.string().min(1),
  // Scenario-specific narrative appended to the interviewer's system
  // prompt: what the spokesperson needs to demonstrate for THIS scenario,
  // and any scenario-specific reactive guidance. Free text — the engine
  // doesn't parse it.
  openingContext: z.string().min(1),
  // What the agent says to close the conversation after the mandatory
  // follow-ups.
  closingMessage: z.string().min(1),
});
export type Scenario = z.infer<typeof ScenarioSchema>;

// ── ClientConfig ─────────────────────────────────────────────────
// Per-organization defaults. Deliberately minimal — no prompt text, no
// rubric, no scenario content lives here; just what an Organization
// needs to pick a starting point.

export const ClientConfigSchema = z.object({
  organizationId: IdSchema,
  defaultLanguage: z.string().min(2).default("es"),
  defaultScenarioId: IdSchema.optional(),
  settings: z.record(z.string(), z.unknown()).default({}),
});
export type ClientConfig = z.infer<typeof ClientConfigSchema>;

// ── Manifest ─────────────────────────────────────────────────────
// The package's entry point — what version this is and what it claims
// to contain. The loader cross-checks this against what it actually
// found on disk (see MANIFEST_COMPLETENESS in loader.ts).
//
// CONTENT_PACKAGE_STATUS (Phase 6): `status` below is kept for backward
// structural compatibility and as human-readable intent inside the
// package itself, but it is NOT the authority for which version serves
// live traffic — that's `repositories/configVersions.ts`'s registry
// (Firestore, or its in-memory dev fallback), the ONE place
// draft/active/deprecated is decided. See CONTENT_PACKAGE_STATUS in
// PHASE_06_CONFIG_VERSIONING_PROVENANCE_REPORT.md for why two
// independent "active" flags would be a contradiction waiting to happen.

export const ManifestSchema = z.object({
  organizationId: IdSchema,
  version: z.string().min(1),
  status: z.enum(["active", "deprecated"]).default("active"),
  interviewerProfiles: z.array(IdSchema).min(1),
  scenarios: z.array(IdSchema).min(1),
  evaluationFrameworks: z.array(IdSchema).min(1),
  contentSources: z.array(IdSchema).default([]),
});
export type Manifest = z.infer<typeof ManifestSchema>;

// ── Assembled package + resolved scenario ──────────────────────

export interface ConfigPackage {
  manifest: Manifest;
  client: ClientConfig;
  interviewerProfiles: InterviewerProfile[];
  scenarios: Scenario[];
  evaluationFrameworks: EvaluationFramework[];
  contentSources: ContentSource[];
}

// What resolveScenarioConfigForNewSession/ForVersion() (resolver.ts)
// return — the ONLY shape the engine (elevenlabs.ts, evaluator.ts) is
// allowed to consume. Everything the engine needs for one training
// session, already looked up and cross-referenced; no further lookups, no
// client name, no scenario branching required downstream.
//
// Phase 6: gains `configVersion`/`configHash` so nothing downstream needs
// a SEPARATE lookup to know which exact version/content it's running —
// routes.ts reads these straight off the resolved config to build
// SessionRecord.config_provenance (see PROVENANCE_MODEL in
// PHASE_06_CONFIG_VERSIONING_PROVENANCE_REPORT.md).
export interface ResolvedScenarioConfig {
  organizationId: string;
  configVersion: string;
  configHash: string;
  client: ClientConfig;
  scenario: Scenario;
  interviewerProfile: InterviewerProfile;
  evaluationFramework: EvaluationFramework;
  contentSources: ContentSource[];
}

// ── ConfigPackageVersion (Phase 6) ─────────────────────────────────
// The version REGISTRY's record shape — repositories/configVersions.ts
// is the sole authority that reads/writes this; nothing infers it from
// directory listings, file mtimes, or manifest.status (see
// CONTENT_PACKAGE_STATUS above).

export const ConfigVersionStatusSchema = z.enum(["draft", "active", "deprecated"]);
export type ConfigVersionStatus = z.infer<typeof ConfigVersionStatusSchema>;

export interface ConfigPackageVersion {
  organizationId: string;
  version: string;
  status: ConfigVersionStatus;
  createdAt: string;
  activatedAt?: string;
  deprecatedAt?: string;
  // Recorded on first activation (see configHash.ts) — a later activation
  // of the SAME version whose freshly computed hash doesn't match this is
  // rejected as an IMMUTABILITY_POLICY violation (repositories/
  // configVersions.ts's activateConfigVersion).
  configHash?: string;
}
