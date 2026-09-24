// Fase 8 — OBSERVABILITY_SUMMARIZER CLI. Thin wrapper: read JSON-lines
// (a file arg, or stdin if piped), aggregate with summarize(), print the
// result as JSON. Pure/offline — never connects to production, never
// writes anywhere. See observabilitySummarize.ts for the actual logic
// and its tests.
//
//   npm run observability:summarize -- app.log
//   cat app.log | npm run observability:summarize --
import { readFileSync } from "node:fs";
import { summarize } from "./observabilitySummarize.js";

function readInput(): string {
  const fileArg = process.argv[2];
  if (fileArg) return readFileSync(fileArg, "utf8");
  try {
    return readFileSync(0, "utf8"); // fd 0 = stdin
  } catch {
    console.error(
      "[observability-summarize] No se dio un archivo y no hay stdin disponible.\n" +
        "Uso: observability-summarize.ts <archivo.log>  (o pipear por stdin)"
    );
    process.exit(1);
  }
}

function main() {
  const raw = readInput();
  const lines = raw.split("\n");
  const summary = summarize(lines);
  console.log(JSON.stringify(summary, null, 2));
}

main();
