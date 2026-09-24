// Fase 8 — OBSERVABILITY_SUMMARIZER. Pure, offline aggregation over
// JSON-lines structured logs (the exact shape logEvent produces — see
// backend/src/observability/log.ts). No network, no storage, no
// production connection: this reads whatever text it's handed (a file, or
// stdin — see observability-summarize.ts, the thin CLI wrapper around
// this) and returns numbers. Never throws on bad input — a malformed or
// unexpected line is counted and skipped, not fatal, since production
// logs are exactly the kind of input that occasionally has a truncated or
// interleaved line.
export interface LatencyStats {
  count: number;
  p50: number;
  p95: number;
  max: number;
}

export interface SummaryResult {
  total_lines: number;
  malformed_lines: number;
  request_count: number;
  success_count: number;
  error_count: number;
  error_rate: number;
  rate_limited_count: number;
  provider_failure_count: number;
  evaluations: { success: number; failure: number };
  requests_by_endpoint: Record<string, number>;
  organization_traffic: Record<string, number>;
  error_count_by_category: Record<string, number>;
  latency_by_endpoint: Record<string, LatencyStats>;
  latency_by_provider: Record<string, LatencyStats>;
  latency_by_event: Record<string, LatencyStats>;
}

// Nearest-rank percentile over an ALREADY-SORTED ascending array. Same
// technique as a load-test summary: p50/p95 pick the value at the
// corresponding rank, no interpolation — simple and defensible for an
// offline CLI tool, not a claim of statistical rigor.
//
// PASS_WITH_FIXES P1.2: rank = ceil(p * n), 1-indexed, converted to a
// 0-indexed array position (rank - 1). This is the textbook nearest-rank
// definition — the previous `floor(p * (n - 1))` was NOT nearest-rank
// despite the comment claiming it was: for n=10, p95, it picked index 8
// (the 9th of 10 values, i.e. p90) instead of index 9 (the actual
// highest-ranked 95th-percentile value for 10 samples).
function percentile(sorted: number[], p: number): number {
  const n = sorted.length;
  if (n === 0) return 0;
  const rank = Math.ceil(p * n);
  const idx = Math.min(n - 1, Math.max(0, rank - 1));
  return sorted[idx];
}

function statsFrom(durations: number[]): LatencyStats {
  const sorted = [...durations].sort((a, b) => a - b);
  return {
    count: sorted.length,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    max: sorted.length ? sorted[sorted.length - 1] : 0,
  };
}

function addDuration(bucket: Map<string, number[]>, key: string, duration: number): void {
  const arr = bucket.get(key);
  if (arr) arr.push(duration);
  else bucket.set(key, [duration]);
}

function increment(record: Record<string, number>, key: string): void {
  record[key] = (record[key] ?? 0) + 1;
}

export function summarize(lines: string[]): SummaryResult {
  let malformed_lines = 0;
  let request_count = 0;
  let success_count = 0;
  let error_count = 0;
  let rate_limited_count = 0;
  let provider_failure_count = 0;
  const evaluations = { success: 0, failure: 0 };
  const requests_by_endpoint: Record<string, number> = {};
  const organization_traffic: Record<string, number> = {};
  const error_count_by_category: Record<string, number> = {};
  const durationsByEndpoint = new Map<string, number[]>();
  const durationsByProvider = new Map<string, number[]>();
  const durationsByEvent = new Map<string, number[]>();

  let total_lines = 0;
  for (const raw of lines) {
    const trimmed = raw.trim();
    if (trimmed === "") continue; // blank lines are formatting, not data
    total_lines++;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      malformed_lines++;
      continue;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      malformed_lines++;
      continue;
    }

    const rec = parsed as Record<string, unknown>;
    const event = typeof rec.event === "string" ? rec.event : undefined;
    if (!event) {
      malformed_lines++;
      continue;
    }

    const outcome = typeof rec.outcome === "string" ? rec.outcome : undefined;
    const errorCategory = typeof rec.error_category === "string" ? rec.error_category : undefined;
    const durationMs = typeof rec.duration_ms === "number" ? rec.duration_ms : undefined;
    const endpoint = typeof rec.endpoint === "string" ? rec.endpoint : undefined;
    const provider = typeof rec.provider === "string" ? rec.provider : undefined;
    const organizationId = typeof rec.organization_id === "string" ? rec.organization_id : undefined;

    if (durationMs !== undefined) {
      addDuration(durationsByEvent, event, durationMs);
      if (endpoint) addDuration(durationsByEndpoint, endpoint, durationMs);
      if (provider) addDuration(durationsByProvider, provider, durationMs);
    }

    switch (event) {
      case "http_request": {
        request_count++;
        // PASS_WITH_FIXES P2: only an EXPLICIT "success"/"failure"
        // counts — a missing or unrecognized outcome is neither. The old
        // `else success_count++` silently treated absent/malformed data
        // as a success, which would understate a real error rate.
        if (outcome === "failure") error_count++;
        else if (outcome === "success") success_count++;
        if (endpoint) increment(requests_by_endpoint, endpoint);
        if (organizationId) increment(organization_traffic, organizationId);
        break;
      }
      case "rate_limit_rejected": {
        rate_limited_count++;
        break;
      }
      case "evaluation_total": {
        if (outcome === "failure") evaluations.failure++;
        else if (outcome === "success") evaluations.success++;
        if (errorCategory) increment(error_count_by_category, errorCategory);
        break;
      }
      case "openrouter_attempt":
      case "elevenlabs_signed_url": {
        if (outcome === "failure") {
          provider_failure_count++;
          if (errorCategory) increment(error_count_by_category, errorCategory);
        }
        break;
      }
      case "config_integrity_failure":
      case "session_recovery": {
        if (errorCategory) increment(error_count_by_category, errorCategory);
        break;
      }
      default:
        // Unknown/future event: still counted in total_lines and eligible
        // for latency aggregation above, just not folded into any of the
        // named counters — a new event family shouldn't require a code
        // change here before it can be logged safely.
        break;
    }
  }

  const toStatsRecord = (m: Map<string, number[]>): Record<string, LatencyStats> => {
    const out: Record<string, LatencyStats> = {};
    for (const [key, arr] of m) out[key] = statsFrom(arr);
    return out;
  };

  return {
    total_lines,
    malformed_lines,
    request_count,
    success_count,
    error_count,
    error_rate: request_count > 0 ? error_count / request_count : 0,
    rate_limited_count,
    provider_failure_count,
    evaluations,
    requests_by_endpoint,
    organization_traffic,
    error_count_by_category,
    latency_by_endpoint: toStatsRecord(durationsByEndpoint),
    latency_by_provider: toStatsRecord(durationsByProvider),
    latency_by_event: toStatsRecord(durationsByEvent),
  };
}
