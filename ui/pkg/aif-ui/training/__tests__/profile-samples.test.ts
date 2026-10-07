import { describe, expect, it } from 'vitest';
// The sample profiles in examples/training/profiles/ are what a platform team copies.
// A sample with a value the form cannot hold, or an editable field that does not exist, would show
// its problems as a warning on the Profiles page; these keep the samples free of them.
import { existsSync, readdirSync, readFileSync } from 'fs';
import { join, resolve } from 'path';

import jsyaml from 'js-yaml';

import { profileChecks, profilesFrom, resolveForm } from '../profiles';

const SAMPLES = (() => {
  const rel = 'examples/training/profiles';

  for (let dir = process.cwd(), i = 0; i < 6; i++, dir = resolve(dir, '..')) {
    if (existsSync(join(dir, rel))) {
      return join(dir, rel);
    }
  }
  throw new Error(`cannot find ${ rel } above ${ process.cwd() }`);
})();

const docs = readdirSync(SAMPLES).filter((f) => f.endsWith('.yaml'))
  .flatMap((f) => jsyaml.loadAll(readFileSync(join(SAMPLES, f), 'utf8')) as any[]);
const profiles = profilesFrom(docs.filter((d) => d?.kind === 'ConfigMap'), (s: string) => jsyaml.load(s));

describe('sample profiles', () => {
  it('are all found', () => {
    expect(profiles.map((p) => p.name).sort()).toEqual(['engine-llamacpp', 'engine-ollama', 'engine-sglang', 'engine-vllm', 'gpu-diagnostics-bundle', 'gpu-diagnostics-bundle-shared', 'gpu-health-check', 'gpu-smoke', 'gpu-smoke-shared', 'nccl-fabric-benchmark', 'pytorch-distributed', 'pytorch-distributed-test', 'pytorch-gpu-test', 'pytorch-gpu-test-shared', 'shared-gpu-dev', 'single-gpu-dev', 'suse-inference-endpoint-qwen', 'suse-inference-endpoint-qwen-shared', 'training-storage-test']);
  });

  it('have no problems', () => {
    profiles.forEach((p) => expect(p.problems).toEqual([]));
  });

  it('pass their own checks as shipped, before the user changes anything', () => {
    profiles.forEach((p) => {
      const fails = profileChecks(p, resolveForm(p, { releaseName: p.namePrefix ? `${ p.namePrefix }-a1b2c` : 'run-a1b2c' })).filter((c) => c.severity === 'fail').map((c) => `${ p.name }:${ c.id }`);

      expect(fails).toEqual([]);
    });
  });

  it('mark the environment checks as tests or benchmarks', () => {
    const purpose = Object.fromEntries(profiles.map((p) => [p.name, p.purpose]));

    expect(purpose['gpu-smoke']).toBe('test');
    expect(purpose['nccl-fabric-benchmark']).toBe('benchmark');
    expect(purpose['pytorch-distributed']).toBe('training');
  });
});
