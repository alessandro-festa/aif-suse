import { describe, expect, it } from 'vitest';
import jsyaml from 'js-yaml';
import {
  inferenceDraftFrom, inferenceProfileDocument, inferenceProfileErrors, profileConfigMap, profileFromConfigMap, PROFILE_KEY
} from '../profiles';

const draft = (over: any = {}) => ({
  meta: {
    name: 'qwen-endpoint', displayName: 'Qwen endpoint', description: 'vLLM behind LiteLLM', framework: 'vLLM', gpu: '', status: 'beta' as const
  },
  blueprint:       { name: 'suse-inference-endpoint', version: '1.0.1' },
  requiredSecrets: [{ name: 'litellm-credentials', hint: 'kubectl create secret …' }],
  ...over,
});

describe('inference profiles', () => {
  it('round-trips through the ConfigMap the Profiles page reads', () => {
    const d = draft();
    const cm = profileConfigMap(d.meta, inferenceProfileDocument(d), (o) => jsyaml.dump(o), 'inference');

    expect(cm.metadata.labels['trainingjobs/profile']).toBe('inference');
    const p = profileFromConfigMap({ metadata: { ...cm.metadata }, data: cm.data }, (s) => jsyaml.load(s))!;

    expect(p.type).toBe('inference');
    expect(p.problems).toEqual([]);
    expect(p.blueprint).toEqual({ name: 'suse-inference-endpoint', version: '1.0.1' });
    expect(p.requiredSecrets).toEqual([{ name: 'litellm-credentials', hint: 'kubectl create secret …' }]);
    expect(p.status).toBe('beta');
    expect(inferenceDraftFrom(p)).toEqual({ ...d, meta: { ...d.meta } });
  });

  it('leaves empty fields out of profile.yaml', () => {
    const doc = inferenceProfileDocument(draft({ requiredSecrets: [] }));

    expect(doc).not.toHaveProperty('requiredSecrets');
    expect(doc).not.toHaveProperty('gpu');
    expect(Object.keys(doc)).toContain(PROFILE_KEY === 'profile.yaml' ? 'blueprint' : '');
  });

  it('refuses a profile without a blueprint, a name, or with a bad secret name', () => {
    expect(inferenceProfileErrors(draft())).toEqual([]);
    expect(inferenceProfileErrors(draft({ blueprint: { name: '', version: '' } }))).toHaveLength(1);
    expect(inferenceProfileErrors(draft({ meta: { ...draft().meta, name: 'Bad Name' } }))[0]).toMatch(/^Name/);
    expect(inferenceProfileErrors(draft({ requiredSecrets: [{ name: 'Not_OK', hint: '' }] }))[0]).toMatch(/Required secret 1/);
  });
});
