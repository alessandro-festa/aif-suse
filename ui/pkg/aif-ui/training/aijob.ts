// A training run submitted as an AIJob: the durable record the operator installs the chart from and
// keeps after the Job is gone. The form's chart values are the job's values; the operator adds the
// job-id label. Where the cluster has no AIJob API the form installs the chart directly instead.

export const AIJOB_TYPE = 'ai-factory.suse.com.aijob';

export interface AIJobInput {
  name: string;
  namespace: string;
  repoName: string;
  chartName: string;
  version: string;
  values: any;
  displayName?: string;
}

/**
 * The AIJob for a submitted run. A chart's capacity check at install time is advice, not a gate,
 * under an operator: the job should wait for the scheduler, not fail because a node is busy right
 * now. So it is turned off; the chart's configuration checks stay on.
 */
export function aiJobFor(i: AIJobInput): any {
  const values = { ...(i.values || {}) };

  values.preflight = { ...(values.preflight || {}), checkHeadroom: false };

  const profile = typeof values.profile === 'string' ? values.profile : '';

  return {
    type:       AIJOB_TYPE,
    apiVersion: 'ai-factory.suse.com/v1alpha1',
    kind:       'AIJob',
    metadata:   { name: i.name, namespace: i.namespace },
    spec:       {
      ...(i.displayName ? { displayName: i.displayName } : {}),
      category: 'training',
      ...(profile ? { profile } : {}),
      source:   {
        repoName: i.repoName, chartName: i.chartName, version: i.version
      },
      values,
    },
  };
}
