// Where a training run's code comes from: the user's script inline, a ConfigMap in the project with
// a train.py key, or the chart's built-in demo (an all-reduce check across the workers). The demo
// is a choice, not what an empty script means, so a run of real training cannot start without code.

import type { Check } from './preflight';

export type CodeSource = 'script' | 'configMap' | 'demo';

/** The source a form starts on: what the profile already sets, else the inline script. */
export function initialCodeSource(form: { script?: string; configMap?: string }): CodeSource {
  if ((form.script || '').trim()) {
    return 'script';
  }

  return form.configMap ? 'configMap' : 'script';
}

/** The form's code fields for a source: the other sources' fields cleared. */
export function codeFields(source: CodeSource, form: { script: string; configMap: string }): { script: string; configMap: string } {
  return {
    script:    source === 'script' ? form.script : '',
    configMap: source === 'configMap' ? form.configMap : '',
  };
}

/** Whether the run has the code its source says, as a check the Deploy button waits on. */
export function codeCheck(source: CodeSource, form: { script: string; configMap: string }): Check {
  if (source === 'script' && !form.script.trim()) {
    return {
      id: 'code', severity: 'fail', title: 'No training script', detail: 'Paste your train.py under Code, choose a ConfigMap that holds it, or pick the built-in demo.'
    };
  }
  if (source === 'configMap' && !form.configMap) {
    return {
      id: 'code', severity: 'fail', title: 'No code ConfigMap chosen', detail: 'Choose the ConfigMap in the project whose train.py key holds your code.'
    };
  }

  return {
    id: 'code', severity: 'pass', title: source === 'demo' ? 'Runs the built-in all-reduce demo' : 'Code supplied', detail: ''
  };
}
