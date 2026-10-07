import { describe, expect, it } from 'vitest';
import { detectStack } from '../compute-pools';

describe('compute pool stack detection', () => {
  it('reports KAI when only its queue group is served', () => {
    expect(detectStack(['scheduling.run.ai', 'apps'], []).schedulers).toEqual(['kai']);
  });

  it('reports Run:AI, not KAI, when the run.ai group is also served', () => {
    expect(detectStack(['scheduling.run.ai', 'run.ai'], []).schedulers).toEqual(['runai']);
  });

  it('reports every scheduler a cluster runs side by side', () => {
    expect(detectStack(['kueue.x-k8s.io', 'scheduling.volcano.sh'], []).schedulers).toEqual(['kueue', 'volcano']);
  });

  it('reports HAMi from its node registration annotation', () => {
    const stack = detectStack([], [{}, { 'hami.io/node-nvidia-register': 'GPU-0,10,24576,100,NVIDIA-L4,0,true' }]);

    expect(stack.sharing).toEqual(['hami']);
  });

  it('tells the Kubeflow Training Operator from Trainer v2', () => {
    expect(detectStack(['kubeflow.org'], []).training).toEqual(['training-operator']);
    expect(detectStack(['trainer.kubeflow.org'], []).training).toEqual(['trainer-v2']);
  });

  it('reports nothing for a bare cluster', () => {
    expect(detectStack(['apps', 'batch'], [{}])).toEqual({ schedulers: [], sharing: [], training: [] });
  });
});
