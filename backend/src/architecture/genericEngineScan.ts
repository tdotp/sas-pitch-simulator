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

// This module IS the rules definition — it necessarily contains each
// pattern's literal source text and rule id as DATA (inside a RegExp
// literal or a description string), never as contaminated application
// code. Every rule allowlists its own defining file for this reason;
// this is the one allowlist entry that applies uniformly, so it is
// factored out instead of repeated five times.
const SELF: { file: string; reason: string } = {
  file: "src/architecture/genericEngineScan.ts",
  reason:
    "This file defines the ENGINE_GENERICITY rules themselves — the pattern source and rule id/description strings are data describing what to detect, not application code exhibiting the violation.",
};

// PASS_WITH_FIXES ronda 1, P1: the real organizationIds actually
// committed under backend/config-packages/ today. Kept as an explicit,
// static, reviewable list (not derived from the filesystem at rule
// definition time) — "sin AST complejo", per the review. Extend this
// list, with a comment saying why, the day a new client org is onboarded
// and its id needs the same protection.
const KNOWN_CLIENT_ORG_IDS = ["sas-colombia", "acme-demo"];

export const ARCHITECTURE_RULES: ArchitectureRule[] = [
  {
    id: "ENGINE_GENERICITY_CLIENT_LITERALS",
    description: "No hardcoded client-specific literals in generic engine source (Fase 5 regression).",
    pattern: /mentioned_sas|mentioned_novo|aligned_to_playbook|SAS_RE|SANDRA/,
    allow: [
      SELF,
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
    allow: [SELF],
  },
  {
    id: "ENGINE_GENERICITY_NO_SHARED_TOKEN_IDENTITY",
    description:
      "The x-app-token anti-abuse gate (Fase 1) may exist in exactly one place and must never become an identity/role source.",
    pattern: /x-app-token/,
    allow: [
      SELF,
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
    allow: [SELF],
  },
  {
    id: "ENGINE_GENERICITY_NO_LITERAL_TENANT_BRANCH",
    description: "No branching on a hardcoded client/org/organizationId string literal.",
    pattern: /\b(client|org|organization|organizationId)\s*===\s*["']/,
    allow: [SELF],
  },
  // PASS_WITH_FIXES ronda 1, P1: ENGINE_GENERICITY_NO_LITERAL_TENANT_BRANCH
  // only ever fires on an `=== "org-id"` COMPARISON. A hardcoded org id
  // used any other way (a constant, an array of "supported" ids, a map
  // key, ...) carries the exact same contamination with no branch at
  // all, and passed through undetected. This rule matches the KNOWN,
  // real organizationIds actually committed under config-packages/ —
  // wherever they appear as a quoted literal in generic source — instead
  // of trying to infer "looks like an org id" generically (which would
  // need real parsing to avoid false positives on unrelated strings).
  {
    id: "ENGINE_GENERICITY_NO_ORG_ID_LITERAL",
    description:
      "No hardcoded literal of a known client organizationId (sas-colombia, acme-demo) anywhere in generic engine source, even outside a '===' branch.",
    pattern: new RegExp(`["'](?:${KNOWN_CLIENT_ORG_IDS.join("|")})["']`),
    allow: [
      SELF,
      {
        file: "src/routes.ts",
        reason:
          'Explanatory comment (line ~125) illustrating that generic code does NOT know client names ("nothing here knows what "davivienda" or "sas-colombia" mean") — documentation, not a hardcoded reference.',
      },
    ],
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
