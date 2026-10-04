import { describe, expect, it } from 'vitest';
// A profile is the platform team's contract with the person deploying: which values are fixed,
// which are theirs, and the limits on the ones that are theirs. These pin that a fixed value cannot
// be overridden through the form, and that the limits are reported before submit.

import { chartValuesFor, DEFAULT_FORM, Form } from '../preflight';
import {
  EditableField, filterOptions, filterProfiles, namespacedFixed, NO_FILTER, profileConfigMap, profileDocument, ProfileMeta, profileSaveErrors, registryPrefixOf,
  normaliseImage, Profile, PROFILE_LABEL, PROFILE_NAMESPACE, profileChecks, profileFromConfigMap, profilesFrom, resolveForm
} from '../profiles';

// JSON is YAML, so the tests need no YAML library.
const parse = (s: string) => (s ? JSON.parse(s) : {});

function cm(name: string, doc: any, over: any = {}): any {
  return {
    metadata: {
      name, namespace: PROFILE_NAMESPACE, labels: { [PROFILE_LABEL]: 'training' }, ...over
    },
    data: { 'profile.yaml': JSON.stringify(doc) },
  };
}

const DISTRIBUTED = {
  displayName: 'PyTorch Distributed',
  framework:   'PyTorch',
  gpu:         'T400',
  values:      {
    image: { repository: 'nvcr.io/nvidia/pytorch', tag: '24.10-py3' },
    job:   {
      kind: 'job', mode: 'torchrun', gpusPerNode: 1
    },
    scheduler: { type: 'kai' },
    resources: { requests: { cpu: '2', memory: '8Gi' } },
    storage:   { scratchSize: '20Gi' },
  },
  editable: ['image', 'tag', 'script', 'nodes', 'datasetPVC', 'runtimeLimitHours'],
  limits:   {
    nodes: { min: 1, max: 4 }, registries: ['nvcr.io/nvidia/', 'pytorch/'], maxRuntimeHours: 8
  },
};

function profile(doc: any = DISTRIBUTED): Profile {
  const p = profileFromConfigMap(cm('pytorch-distributed', doc), parse);

  if (!p) {
    throw new Error('not a profile');
  }

  return p;
}

const failIds = (p: Profile, f: Form) => profileChecks(p, f).filter((c) => c.severity === 'fail').map((c) => c.id);

describe('reading a profile from its ConfigMap', () => {
  it('applies the values over the form defaults', () => {
    const p = profile();

    expect(p.form.image).toBe('nvcr.io/nvidia/pytorch');
    expect(p.form.scratchSize).toBe('20Gi');
    expect(p.form.scheduler).toBe('kai');
    expect(p.form.memRequest).toBe('8Gi');
    expect(p.problems).toEqual([]);
  });

  it('records which fields the values fix, including ones equal to the default', () => {
    const p = profile();

    // job.kind "job" is also DEFAULT_FORM.kind; it is still fixed because the profile says so
    expect(p.fixed).toContain('kind');
    expect(p.fixed).toContain('scratchSize');
    expect(p.fixed).not.toContain('datasetPVC');
  });

  it('runs every job at the runtime maximum unless the profile sets a lower one', () => {
    expect(profile().form.runtimeLimitHours).toBe(8);
  });

  it('ignores ConfigMaps without the label, and ones outside the profile namespace', () => {
    expect(profileFromConfigMap({ metadata: { name: 'x', labels: {} }, data: {} }, parse)).toBeNull();
    expect(profilesFrom([
      cm('a', DISTRIBUTED),
      cm('b', DISTRIBUTED, { namespace: 'team-a' }),
    ], parse).map((p) => p.name)).toEqual(['a']);
  });

  it('reports values the form cannot hold instead of silently dropping them at submit', () => {
    const p = profile({ ...DISTRIBUTED, values: { ...DISTRIBUTED.values, tolerations: [{ key: 'gpu' }] } });

    expect(p.problems).toHaveLength(1);
    expect(p.problems[0]).toMatch(/tolerations/);
  });

  it('reports editable fields it does not know, and keeps the rest', () => {
    const p = profile({ ...DISTRIBUTED, editable: ['image', 'hostNetwork'] });

    expect(p.editable).toEqual(['image']);
    expect(p.problems[0]).toMatch(/hostNetwork/);
  });

  it('lists a profile with broken YAML rather than hiding it', () => {
    const p = profileFromConfigMap({
      metadata: {
        name: 'broken', namespace: PROFILE_NAMESPACE, labels: { [PROFILE_LABEL]: 'training' }
      },
      data: { 'profile.yaml': '{not json' },
    }, parse);

    expect(p?.name).toBe('broken');
    expect(p?.problems[0]).toMatch(/not valid YAML/);
  });
});

describe('resolving the form a deployment installs', () => {
  it('takes the user value for an editable field', () => {
    expect(resolveForm(profile(), { image: 'pytorch/pytorch', nodes: 3 }).nodes).toBe(3);
  });

  it('keeps the profile value for a fixed field, whatever the input says', () => {
    const f = resolveForm(profile(), {
      scratchSize: '1Ti', scheduler: 'none', hostNetwork: true
    });

    expect(f.scratchSize).toBe('20Gi');
    expect(f.scheduler).toBe('kai');
    expect(f.hostNetwork).toBe(false);
  });

  it('always takes namespace and release name from the user', () => {
    const f = resolveForm(profile(), { namespace: 'ai-team', releaseName: 'run-1' });

    expect(f.namespace).toBe('ai-team');
    expect(f.releaseName).toBe('run-1');
  });

  it('does not share env with the profile, so editing one run cannot change the next', () => {
    const p = profile({
      ...DISTRIBUTED, values: { ...DISTRIBUTED.values, env: [{ name: 'A', value: '1' }] }, editable: ['env']
    });
    const f = resolveForm(p, { env: { B: '2' } });

    expect(f.env).toEqual({ A: '1', B: '2' });
    expect(p.form.env).toEqual({ A: '1' });
  });
});

describe('profile checks', () => {
  const p = profile();
  const ok = resolveForm(p, { nodes: 2 });

  it('passes a form inside every limit', () => {
    expect(failIds(p, ok)).toEqual([]);
  });

  it('fails workers outside the profile range', () => {
    expect(failIds(p, { ...ok, nodes: 5 })).toContain('profile-nodes');
  });

  it('fails an image from a registry the profile does not allow', () => {
    expect(failIds(p, { ...ok, image: 'ghcr.io/someone/trainer' })).toContain('profile-image');
  });

  it('matches Docker Hub names however they are written', () => {
    expect(failIds(p, { ...ok, image: 'pytorch/pytorch' })).not.toContain('profile-image');
    expect(failIds(p, { ...ok, image: 'docker.io/pytorch/pytorch' })).not.toContain('profile-image');
  });

  it('fails a runtime above the maximum, or none at all', () => {
    expect(failIds(p, { ...ok, runtimeLimitHours: 12 })).toContain('profile-runtime');
    expect(failIds(p, { ...ok, runtimeLimitHours: 0 })).toContain('profile-runtime');
  });

  it('fails a fixed value changed behind the form, e.g. by imported YAML', () => {
    expect(failIds(p, { ...ok, scratchSize: '1Ti' })).toContain('profile-fixed');
  });

  it('does not treat values the page derives (scheduler queue) as drift', () => {
    expect(failIds(p, {
      ...ok, queue: 'team-a', namespace: 'ai-team'
    })).toEqual([]);
  });
});

describe('image normalisation', () => {
  it('reads names the way Docker does', () => {
    expect(normaliseImage('ubuntu')).toBe('docker.io/library/ubuntu');
    expect(normaliseImage('pytorch/pytorch')).toBe('docker.io/pytorch/pytorch');
    expect(normaliseImage('nvcr.io/nvidia/pytorch')).toBe('nvcr.io/nvidia/pytorch');
    expect(normaliseImage('localhost:5000/x')).toBe('localhost:5000/x');
  });

  it('leaves DEFAULT_FORM image allowed by the sample profiles (the Application Collection)', () => {
    expect(normaliseImage(DEFAULT_FORM.image).startsWith('dp.apps.rancher.io/containers/')).toBe(true);
  });
});

// The admin writes a profile by filling in the Submit form and saving it. What the user then gets
// on the Deploy page has to be that same form, or the profile is not what its author tested.
describe('saving the Submit form as a profile', () => {
  const META: ProfileMeta = {
    name: 'team-lora', displayName: 'Team LoRA', description: 'd', framework: 'PyTorch', gpu: 'T400', status: 'ready'
  };
  const authored: Form = {
    ...DEFAULT_FORM,
    namespace:         'team-a',
    releaseName:       'train-abc12',
    image:             'pytorch/pytorch',
    tag:               '2.5.1-cuda12.1-cudnn9-runtime',
    nodes:             2,
    scratchSize:       '20Gi',
    env:               { HF_HOME: '/scratch/hf' },
    scheduler:         'kueue',
    queue:             'default-queue',
    priorityClassName: 'low',
    runtimeLimitHours: 4,
  };
  const editable: EditableField[] = ['image', 'tag', 'nodes', 'env', 'runtimeLimitHours'];
  const limits = {
    nodes: { min: 1, max: 4 }, registries: ['pytorch/'], maxRuntimeHours: 8
  };

  function roundTrip(follow: boolean) {
    const doc = profileDocument(META, chartValuesFor(authored, true), editable, limits, follow);
    const cm = profileConfigMap(META, doc, (o) => JSON.stringify(o));
    const p = profileFromConfigMap(cm, parse);

    if (!p) {
      throw new Error('not a profile');
    }

    return { p, cm };
  }

  it('reads back with no problems, as the same form', () => {
    const { p } = roundTrip(false);

    expect(p.problems).toEqual([]);
    expect(resolveForm(p, { namespace: 'team-a', releaseName: 'train-abc12' })).toEqual(authored);
  });

  it('leaves scheduler and queue to each project when following the project', () => {
    const { p } = roundTrip(true);
    const f = resolveForm(p, {});

    expect(p.fixed).not.toContain('scheduler');
    expect(p.fixed).not.toContain('queue');
    expect(f.queue).toBe('');
    expect(f.priorityClassName).toBe('low'); // not a per-project fact, so it stays
  });

  it('is stored where and how the Profiles page looks for it', () => {
    const { cm } = roundTrip(true);

    expect(cm.metadata.namespace).toBe(PROFILE_NAMESPACE);
    expect(cm.metadata.labels[PROFILE_LABEL]).toBe('training');
    expect(cm.metadata.name).toBe('team-lora');
  });

  it('does not store the per-user headroom switch', () => {
    expect(profileDocument(META, chartValuesFor(authored, true), editable, limits, true).values).not.toHaveProperty('preflight');
  });

  it('refuses a name that cannot be a ConfigMap name', () => {
    expect(profileSaveErrors({ ...META, name: 'Team LoRA' }, limits, authored)[0]).toMatch(/lowercase/);
  });

  it('refuses a default that would fail the profile\'s own limits', () => {
    expect(profileSaveErrors(META, { ...limits, nodes: { min: 3, max: 4 } }, authored)[0]).toMatch(/outside the range/);
    expect(profileSaveErrors(META, { ...limits, maxRuntimeHours: 2 }, authored)[0]).toMatch(/above the maximum/);
    expect(profileSaveErrors(META, limits, authored)).toEqual([]);
  });

  it('warns about fixing a claim that exists only in the author\'s namespace', () => {
    expect(namespacedFixed({ ...authored, datasetPVC: 'dolly' }, editable)).toEqual(['datasetPVC']);
    expect(namespacedFixed({ ...authored, datasetPVC: 'dolly' }, [...editable, 'datasetPVC'])).toEqual([]);
  });

  it('suggests the image\'s registry and organisation as the allowed prefix', () => {
    expect(registryPrefixOf('nvcr.io/nvidia/pytorch')).toBe('nvcr.io/nvidia/');
    expect(registryPrefixOf('pytorch/pytorch')).toBe('docker.io/pytorch/');
    expect(registryPrefixOf('ubuntu')).toBe('docker.io/library/');
  });
});

describe('the Profiles page filters', () => {
  const mk = (name: string, over: any, type = 'training') => profileFromConfigMap({
    metadata: {
      name, namespace: PROFILE_NAMESPACE, labels: { [PROFILE_LABEL]: type }
    },
    data: { 'profile.yaml': JSON.stringify({ displayName: name, ...over }) },
  }, parse) as Profile;
  const all = [
    mk('pytorch-a100', {
      framework: 'PyTorch', gpu: 'A100', description: 'distributed training'
    }),
    mk('tf-h100', {
      framework: 'TensorFlow', gpu: 'H100', status: 'beta'
    }),
    mk('single-dev', {
      framework: 'PyTorch', gpu: 'L40S', description: 'small experiments'
    }),
    mk('vllm', { framework: 'vLLM', gpu: 'L40S' }, 'inference'),
  ];
  const names = (type: 'training' | 'inference', f: any) => filterProfiles(all, type, { ...NO_FILTER, ...f }).map((p) => p.name);

  it('splits by the label value', () => {
    expect(names('training', {})).toEqual(['pytorch-a100', 'tf-h100', 'single-dev']);
    expect(names('inference', {})).toEqual(['vllm']);
  });

  it('filters by framework, GPU and status together', () => {
    expect(names('training', { framework: 'PyTorch' })).toEqual(['pytorch-a100', 'single-dev']);
    expect(names('training', { framework: 'PyTorch', gpu: 'L40S' })).toEqual(['single-dev']);
    expect(names('training', { status: 'beta' })).toEqual(['tf-h100']);
  });

  it('matches every search word anywhere in the card text, ignoring case', () => {
    expect(names('training', { text: 'Distributed a100' })).toEqual(['pytorch-a100']);
    expect(names('training', { text: 'experiments pytorch' })).toEqual(['single-dev']);
    expect(names('training', { text: 'nothing-matches' })).toEqual([]);
  });

  it('offers only the values profiles of that type use', () => {
    expect(filterOptions(all, 'training', 'gpu')).toEqual(['A100', 'H100', 'L40S']);
    expect(filterOptions(all, 'inference', 'framework')).toEqual(['vLLM']);
  });
});

describe('run name prefix', () => {
  const p = (doc: any) => profileFromConfigMap(cm('lora', { ...DISTRIBUTED, ...doc }), parse) as Profile;

  it('is read from the profile, and a bad one is reported rather than used', () => {
    expect(p({ namePrefix: 'team-lora' }).namePrefix).toBe('team-lora');
    expect(p({ namePrefix: 'Team Lora' }).namePrefix).toBe('');
    expect(p({ namePrefix: 'Team Lora' }).problems[0]).toMatch(/namePrefix/);
  });

  it('fails a run name without it, and passes one with it', () => {
    const prof = p({ namePrefix: 'team-lora' });
    const f = resolveForm(prof, { nodes: 2 });

    expect(failIds(prof, { ...f, releaseName: 'other-run' })).toContain('profile-name');
    expect(failIds(prof, { ...f, releaseName: 'team-lora-a1b2c' })).not.toContain('profile-name');
  });

  it('is saved with the profile, and refused when malformed', () => {
    const META: ProfileMeta = {
      name: 'lora', namePrefix: 'team-lora', displayName: 'x', description: '', framework: '', gpu: '', status: 'ready'
    };

    expect(profileDocument(META, {}, [], {}, true).namePrefix).toBe('team-lora');
    expect(profileDocument({ ...META, namePrefix: '' }, {}, [], {}, true)).not.toHaveProperty('namePrefix');
    expect(profileSaveErrors({ ...META, namePrefix: 'Bad_Prefix' }, {}, DEFAULT_FORM)[0]).toMatch(/prefix/);
  });
});

describe('GPUs per worker limits', () => {
  const cm = (limits: any, editable: string[]) => ({
    metadata: { name: 'gpu-range', namespace: 'ai-profiles', labels: { 'trainingjobs/profile': 'training' } },
    data:     { 'profile.yaml': JSON.stringify({ displayName: 'Range', values: { job: { gpusPerNode: 1 } }, editable, limits }) },
  });

  it('checks a deploy against the range', () => {
    const p = profileFromConfigMap(cm({ gpusPerNode: { min: 1, max: 2 } }, ['gpusPerNode']), parse)!;

    expect(p.problems).toEqual([]);
    const over = resolveForm(p, { gpusPerNode: 4 } as any);

    expect(profileChecks(p, over).find((c) => c.id === 'profile-gpus')?.severity).toBe('fail');
    expect(profileChecks(p, resolveForm(p, { gpusPerNode: 2 } as any)).find((c) => c.id === 'profile-gpus')).toBeUndefined();
  });
});
