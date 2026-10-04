import { describe, expect, it } from 'vitest';
import { parseResult, reportResult } from '../results';

describe('parseResult', () => {
  const line = (r: any) => `AIF_RESULT ${ JSON.stringify(r) }`;

  it('reads the last result line, whatever precedes it', () => {
    const log = ['step 1', line({ test: 'old', status: 'pass' }), '[rank0]: ' + line({
      test: 'PyTorch GPU Test', status: 'pass', checks: [{ name: 'CUDA available', ok: true, detail: '1 device' }], metrics: { 'FP16 matmul': '12.1 TFLOPS' }, env: { torch: '2.5.1' }
    })].join('\n');
    const r = parseResult(log)!;

    expect(r.test).toBe('PyTorch GPU Test');
    expect(r.checks).toEqual([{ name: 'CUDA available', ok: true, detail: '1 device' }]);
    expect(r.metrics['FP16 matmul']).toBe('12.1 TFLOPS');
  });

  it('fails a result with a failed check, whatever its status says', () => {
    expect(parseResult(line({ status: 'pass', checks: [{ name: 'x', ok: false }] }))!.status).toBe('fail');
  });

  it('is null without a result or with a malformed one', () => {
    expect(parseResult('training… done')).toBeNull();
    expect(parseResult('AIF_RESULT {not json')).toBeNull();
  });
});

describe('warnings', () => {
  it('flag a check without failing the result', () => {
    const r = parseResult('AIF_RESULT ' + JSON.stringify({ status: 'pass', checks: [{ name: 'PCIe link width', ok: true, warn: true, detail: 'x8 of x16' }] }))!;

    expect(r.status).toBe('pass');
    expect(r.checks[0]).toEqual({ name: 'PCIe link width', ok: true, warn: true, detail: 'x8 of x16' });
  });
});

describe('reportResult', () => {
  it('reads the result an AIJob kept, with the same verdict rules as a log line', () => {
    const aiJob = {
      status: {
        report: {
          test: 'GPU Smoke Test', status: 'pass', checks: [{ name: 'GPU allocated', ok: true }, { name: 'Persistence mode', ok: true, warn: true }], metrics: { 'GPU memory (MiB)': '1105' }, env: { node: 'worker-1' }
        }
      }
    };
    const r = reportResult(aiJob)!;

    expect(r.test).toBe('GPU Smoke Test');
    expect(r.status).toBe('pass');
    expect(r.checks[1].warn).toBe(true);
    expect(r.env.node).toBe('worker-1');
    expect(reportResult({ status: { report: { test: 'x', status: 'pass', checks: [{ name: 'a', ok: false }] } } })!.status).toBe('fail');
  });

  it('is nothing for a run without one, or something that is not an AIJob', () => {
    expect(reportResult({ status: {} })).toBeNull();
    expect(reportResult({ spec: { chart: {} } })).toBeNull();
    expect(reportResult(null)).toBeNull();
  });
});
