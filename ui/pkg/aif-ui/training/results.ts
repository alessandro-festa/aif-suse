// What a test or benchmark run reports. Its script ends by printing one line,
//   AIF_RESULT {"test": ..., "status": "pass"|"fail", "checks": [...], "metrics": {...}, "env": {...}}
// which the run's detail reads from the first worker's log and shows as a results card.

export const RESULT_MARKER = 'AIF_RESULT ';

export interface ResultCheck { name: string; ok: boolean; warn?: boolean; detail?: string }

export interface RunResult {
  test: string;
  status: 'pass' | 'fail';
  checks: ResultCheck[];
  metrics: Record<string, string | number>;
  env: Record<string, string | number>;
}

/** The last result a log carries, or null. Lines may carry a log prefix (a timestamp, a rank). */
export function parseResult(log: string): RunResult | null {
  const lines = (log || '').split('\n');

  for (let i = lines.length - 1; i >= 0; i--) {
    const at = lines[i].indexOf(RESULT_MARKER);

    if (at < 0) {
      continue;
    }
    try {
      return toResult(JSON.parse(lines[i].slice(at + RESULT_MARKER.length).trim()));
    } catch (e) {
      return null; // a malformed result is no result
    }
  }

  return null;
}

/**
 * The result an AIJob kept (status.report): the same line, captured by the operator when the run
 * finished, so it outlives the pods and their logs. null when there is none.
 */
export function reportResult(aiJob: any): RunResult | null {
  const report = aiJob?.status?.report;

  return report && typeof report === 'object' && (report.test || report.status || report.checks) ? toResult(report) : null;
}

function toResult(r: any): RunResult {
  // warn: passed, but worth knowing (a narrow PCIe link): flagged, not a failure
  const checks: ResultCheck[] = Array.isArray(r.checks) ? r.checks.filter((c: any) => c && c.name).map((c: any) => ({
    name: String(c.name), ok: !!c.ok, ...(c.warn ? { warn: true } : {}), detail: c.detail ? String(c.detail) : ''
  })) : [];
  const failed = checks.some((c) => !c.ok);

  return {
    test:    String(r.test || ''),
    status:  r.status === 'fail' || failed ? 'fail' : 'pass',
    checks,
    metrics: r.metrics && typeof r.metrics === 'object' ? r.metrics : {},
    env:     r.env && typeof r.env === 'object' ? r.env : {},
  };
}
