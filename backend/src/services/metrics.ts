// Deterministic speech-metrics engine (Spanish/Colombia). Runs before the LLM
// evaluator so scores can rely on hard signals: WPM, fillers, repetitions,
// numbers, SAS mention, CTA. Only Sandra's turns are analyzed.

import type { SpeechMetrics, TranscriptTurn } from "../types.js";

// Common Colombian/LatAm spoken filler words and hesitation markers.
const FILLER_PATTERNS: Array<{ label: string; re: RegExp }> = [
  { label: "eh", re: /\b(eh+|ehm+|em+)\b/gi },
  { label: "este", re: /\beste\b(?=\s*(,|\.|\s))/gi },
  { label: "o sea", re: /\bo sea\b/gi },
  { label: "digamos", re: /\bdigamos\b/gi },
  { label: "pues", re: /\bpues\b/gi },
  { label: "como que", re: /\bcomo que\b/gi },
  { label: "entonces", re: /\bentonces\b/gi },
  { label: "básicamente", re: /\bb[áa]sicamente\b/gi },
  { label: "digo", re: /\bdigo\b/gi },
  { label: "verdad", re: /\b(¿?verdad\?|no cierto)\b/gi },
  { label: "mmm", re: /\bmm+\b/gi },
];

// Words we ignore when counting content-word repetitions.
const STOPWORDS = new Set([
  "el","la","los","las","un","una","unos","unas","de","del","al","a","en","y",
  "o","que","se","su","sus","lo","le","les","con","por","para","como","más",
  "pero","este","esta","estos","estas","es","son","ser","fue","ha","han","hay",
  "no","sí","si","me","mi","te","tu","nos","muy","ya","también","porque","cuando",
  "donde","cual","cada","entre","sin","sobre","desde","hasta","ese","esa","eso",
  "yo","él","ella","ellos","nosotros","usted","ustedes","the","of","and",
]);

// SAS mention: word-boundary "SAS" but not "sas" inside other words.
const SAS_RE = /\bSAS\b/g;

// A CTA is a forward-looking proposal / next step. Heuristic lexicon.
const CTA_PATTERNS: RegExp[] = [
  /\bpropon(g|)o\b/i,
  /\bpropuesta\b/i,
  /\bsiguiente paso\b/i,
  /\bpr[óo]ximo paso\b/i,
  /\bagend(a|emos|ar)\b/i,
  /\b(sesi[óo]n|mesa) (de )?(diagn[óo]stico|t[ée]cnica|trabajo)\b/i,
  /\bpiloto\b/i,
  /\bprueba de concepto\b|\bpoc\b/i,
  /\bpodr[íi]amos (empezar|arrancar|comenzar|explorar)\b/i,
  /\blos invito a\b|\bte invito a\b/i,
  /\bhagamos\b|\barranquemos\b|\bempecemos\b/i,
  /\bme gustar[íi]a proponer\b/i,
];

// Number detection: percentages, currency, magnitudes, plain figures, spelled.
const NUMBER_RE =
  /(\d+[.,]?\d*\s*%|\$?\s?\d[\d.,]*\s*(billones|mil millones|millones|mil|k|m|b)?|\bCOP\s?\d[\d.,]*|\bUSD\s?\d[\d.,]*|\b\d{2,}\b)/gi;
const SPELLED_NUMBERS =
  /\b(uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|veinte|treinta|cuarenta|cincuenta|sesenta|setenta|ochenta|noventa|cien|ciento|mil|mill[óo]n|millones|billones)\b/gi;

function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function tokenize(text: string): string[] {
  return normalize(text)
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function countFillers(text: string): {
  total: number;
  items: Record<string, number>;
} {
  const items: Record<string, number> = {};
  let total = 0;
  for (const { label, re } of FILLER_PATTERNS) {
    const matches = text.match(re);
    if (matches && matches.length > 0) {
      items[label] = (items[label] ?? 0) + matches.length;
      total += matches.length;
    }
  }
  return { total, items };
}

// Content-word repetitions: words (len>=4, non-stopword) used 3+ times.
function detectRepetitions(tokens: string[]): {
  count: number;
  items: string[];
} {
  const freq = new Map<string, number>();
  for (const tok of tokens) {
    if (tok.length < 4 || STOPWORDS.has(tok)) continue;
    freq.set(tok, (freq.get(tok) ?? 0) + 1);
  }
  const repeated = [...freq.entries()]
    .filter(([, n]) => n >= 3)
    .sort((a, b) => b[1] - a[1])
    .map(([w, n]) => `${w} (${n})`);
  return { count: repeated.length, items: repeated.slice(0, 8) };
}

function detectNumbers(text: string): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(NUMBER_RE)) {
    const val = m[0].trim();
    // Skip standalone years-only noise? keep — years can be valid evidence.
    if (val.replace(/[^\d]/g, "").length > 0) found.add(val);
  }
  for (const m of text.matchAll(SPELLED_NUMBERS)) {
    found.add(m[0].toLowerCase());
  }
  return [...found].slice(0, 20);
}

function hasCTA(text: string): boolean {
  return CTA_PATTERNS.some((re) => re.test(text));
}

export function computeMetrics(
  transcript: TranscriptTurn[],
  durationSeconds: number
): SpeechMetrics {
  const userText = transcript
    .filter((t) => t.role === "user")
    .map((t) => t.text)
    .join(" ");

  const tokens = tokenize(userText);
  const wordCount = tokens.length;
  const minutes = durationSeconds > 0 ? durationSeconds / 60 : 0;
  const wpm = minutes > 0 ? Math.round(wordCount / minutes) : 0;

  const fillers = countFillers(userText);
  const reps = detectRepetitions(tokens);
  const numbers = detectNumbers(userText);

  return {
    word_count: wordCount,
    words_per_minute: wpm,
    filler_words_total: fillers.total,
    filler_words_items: fillers.items,
    repetition_count: reps.count,
    repetition_items: reps.items,
    long_pauses_count: 0, // populated from client-side pause telemetry if available
    mentioned_sas: SAS_RE.test(userText),
    used_numbers: numbers.length > 0,
    numbers_detected: numbers,
    has_cta: hasCTA(userText),
  };
}
