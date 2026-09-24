// Fase 9 (Quality Gate) — the real filesystem side of the ENGINE_GENERICITY
// check. Walks backend/src (never config-packages/, fixtures, or dist),
// reading every .ts file (excluding *.test.ts) and feeding it through the
// pure scanContentForViolations. See genericEngineScan.ts for the rules.

import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { scanContentForViolations, type ArchitectureViolation } from "./genericEngineScan.js";

const EXCLUDED_DIRS = new Set(["node_modules", "dist", "config-packages"]);

async function collectTsFiles(dir: string, files: string[] = []): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRS.has(entry.name)) continue;
      await collectTsFiles(join(dir, entry.name), files);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      files.push(join(dir, entry.name));
    }
  }
  return files;
}

export async function runGenericEngineScan(
  srcRootPath: string,
  repoRelativeBasePath: string
): Promise<ArchitectureViolation[]> {
  const files = await collectTsFiles(srcRootPath);
  const violations: ArchitectureViolation[] = [];
  for (const absPath of files) {
    const content = await readFile(absPath, "utf-8");
    const relPath = relative(repoRelativeBasePath, absPath);
    violations.push(...scanContentForViolations(relPath, content));
  }
  return violations;
}
