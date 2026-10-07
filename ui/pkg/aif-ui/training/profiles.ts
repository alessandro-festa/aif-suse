// Profiles: a platform team's fixed answer to most of the Submit form, published so that a data
// scientist supplies only intent (code, image, scale, data) and the rest is resolved for them.
//
// A profile is a ConfigMap, not a CRD: the extension installs no controllers and owns no API types
// (DESIGN.md §1), and a ConfigMap is something a platform team can write, review and `kubectl apply`
// today. Profiles live in one namespace (PROFILE_NAMESPACE) that every authenticated user can read,
// and carry the PROFILE_LABEL so they can be told apart from ordinary ConfigMaps there.
//
//   metadata.labels[PROFILE_LABEL] = "training"
//   data["profile.yaml"]:
//     displayName, description, framework, gpu, status   -- what the Profiles page shows
//     values:   gpu-train-job Helm values the platform fixes (same shape as the chart's values)
//     editable: Form fields the user may set (EDITABLE_FIELDS)
//     limits:   { nodes: {min, max}, registries: [...] (allowed image registries), maxRuntimeHours }
//
// The limits are checked in the UI, before submit. They are not enforced in the cluster: anyone with
// Helm and the chart can still install whatever values they like. Enforcement belongs to an
// admission policy (the governance layer in docs/concepts/ai-workloads-profiles.md), not here.

import { gpuShort } from './gputypes';
import { Check, DEFAULT_FORM, Form, formFromValues } from './preflight';
import { IDLE_DURATION, RECLAIM_POLICIES, ReclaimPolicy } from './reclaim';

export const PROFILE_NAMESPACE = 'ai-profiles';
export const PROFILE_LABEL = 'trainingjobs/profile';
export const PROFILE_KEY = 'profile.yaml';
// Set on the Helm release so the Workloads page (and anyone reading the App) can see which profile a run
// came from.
export const PROFILE_ANNOTATION = 'trainingjobs/profile';

/**
 * Form fields a profile may hand to the user. namespace and releaseName are always the user's and are
 * not listed. Everything else stays at the profile's value (or the chart default) and is shown
 * read-only under "Resolved configuration".
 */
export const EDITABLE_FIELDS = [
  'image', 'tag', 'command', 'args', 'script', 'configMap', 'env',
  'nodes', 'gpusPerNode', 'gpuProduct', 'gpuShareMiB', 'datasetPVC', 'checkpointPVC', 'secretName',
  'runtimeLimitHours', 'priorityClassName',
] as const;
export type EditableField = typeof EDITABLE_FIELDS[number];

export interface ProfileLimits {
  nodes?: { min: number; max: number };
  // GPUs per worker a user may ask for, when the profile opens gpusPerNode
  gpusPerNode?: { min: number; max: number };
  // Image prefixes the user may pull from, compared against the normalised image reference
  // (docker.io/library/... for bare Docker Hub names). Empty or absent = any registry.
  registries?: string[];
  maxRuntimeHours?: number; // 0 or absent = no limit
}

export type ProfileType = 'training' | 'inference';
export type ProfilePurpose = 'training' | 'test' | 'benchmark';

export interface Profile {
  name: string; // ConfigMap name; what the Deploy route and the release annotation carry
  type: ProfileType; // from the label value; the Profiles page has one tab per type
  displayName: string;
  description: string;
  framework: string;
  gpu: string; // a label for people (e.g. "A100", "T400"); the chart does not select on it
  status: 'ready' | 'beta';
  // What a training profile is for: real training, or checking the environment (a test, or a
  // benchmark that measures). The Catalog groups and labels profiles by it.
  purpose: ProfilePurpose;
  // Inference profiles only: the SUSE AI Factory blueprint and version a deployment installs.
  blueprint: { name: string; version: string } | null;
  // Secrets the user's project must already have (e.g. LiteLLM's credentials). Checked before deploy;
  // `hint` says how to create one, since the profile cannot and should not create credentials.
  requiredSecrets: { name: string; hint: string }[];
  // Runs from this profile are named <prefix>-<something>; '' = any name. The user still picks the name.
  namePrefix: string;
  // Training profiles: what happens to a run that sits idle in a compute pool that reclaims idle
  // runs (AIJob.spec.reclaim). null = the operator's default (Suspend, the pool's timeout).
  reclaim: { policy: ReclaimPolicy | ''; idleTimeout: string } | null;
  form: Form; // DEFAULT_FORM with the profile's values applied
  fixed: (keyof Form)[]; // fields the profile's values set explicitly
  editable: EditableField[];
  limits: ProfileLimits;
  // Problems with the profile itself: values the form cannot hold (they would be dropped at
  // submit), unknown editable fields. A profile with problems is still listed, with a warning.
  problems: string[];
}

const num = (x: any, fallback: number) => (Number.isFinite(Number(x)) ? Number(x) : fallback);

/** The Form keys a values document sets, found by applying it to two different bases. */
function fieldsSetBy(values: any): (keyof Form)[] {
  const a = formFromValues(values, DEFAULT_FORM).form;
  // A base that differs from DEFAULT_FORM in every field, so a value equal to the default is still seen.
  const poisoned = Object.fromEntries(Object.entries(DEFAULT_FORM).map(([k, v]) => [k, typeof v === 'number' ? -1 : typeof v === 'boolean' ? !v : '\u0000'])) as any;
  const b = formFromValues(values, poisoned).form;

  return (Object.keys(DEFAULT_FORM) as (keyof Form)[]).filter((k) => JSON.stringify(a[k]) === JSON.stringify(b[k]));
}

/**
 * A Profile from a ConfigMap, or null when the ConfigMap is not a profile. `parseYaml` is passed in
 * so this module stays free of runtime imports and runs under the test harness unchanged.
 */
export function profileFromConfigMap(cm: any, parseYaml: (s: string) => any): Profile | null {
  if (!cm?.metadata?.labels?.[PROFILE_LABEL]) {
    return null;
  }
  const problems: string[] = [];
  let doc: any = {};

  try {
    doc = parseYaml(cm.data?.[PROFILE_KEY] || '') || {};
  } catch (e: any) {
    problems.push(`${ PROFILE_KEY } is not valid YAML: ${ e?.message || e }`);
  }
  if (typeof doc !== 'object' || Array.isArray(doc)) {
    problems.push(`${ PROFILE_KEY } must be a mapping`);
    doc = {};
  }

  const values = doc.values && typeof doc.values === 'object' ? doc.values : {};
  const { form, unmapped } = formFromValues(values, DEFAULT_FORM);

  unmapped.forEach((u) => problems.push(`values.${ u } has no field in the form and would not be installed`));

  const editable: EditableField[] = [];

  (Array.isArray(doc.editable) ? doc.editable : []).forEach((f: any) => {
    if ((EDITABLE_FIELDS as readonly string[]).includes(String(f))) {
      editable.push(String(f) as EditableField);
    } else {
      problems.push(`editable: "${ f }" is not a field a profile can open to users`);
    }
  });

  const l = doc.limits && typeof doc.limits === 'object' ? doc.limits : {};
  const limits: ProfileLimits = {};

  if (l.nodes && typeof l.nodes === 'object') {
    limits.nodes = { min: Math.max(1, num(l.nodes.min, 1)), max: Math.max(1, num(l.nodes.max, form.nodes)) };
    if (limits.nodes.min > limits.nodes.max) {
      problems.push(`limits.nodes: min ${ limits.nodes.min } is above max ${ limits.nodes.max }`);
    }
  }
  if (l.gpusPerNode && typeof l.gpusPerNode === 'object') {
    limits.gpusPerNode = { min: Math.max(0, num(l.gpusPerNode.min, 1)), max: Math.max(0, num(l.gpusPerNode.max, form.gpusPerNode)) };
    if (limits.gpusPerNode.min > limits.gpusPerNode.max) {
      problems.push(`limits.gpusPerNode: min ${ limits.gpusPerNode.min } is above max ${ limits.gpusPerNode.max }`);
    }
  }
  if (Array.isArray(l.registries)) {
    limits.registries = l.registries.map(String).filter(Boolean);
  }
  if (l.maxRuntimeHours !== undefined) {
    limits.maxRuntimeHours = Math.max(0, num(l.maxRuntimeHours, 0));
  }

  // A profile with a runtime limit and no user-editable runtime runs every job at the limit.
  if (limits.maxRuntimeHours && !form.runtimeLimitHours) {
    form.runtimeLimitHours = limits.maxRuntimeHours;
  }
  if (limits.nodes && (form.nodes < limits.nodes.min || form.nodes > limits.nodes.max)) {
    form.nodes = limits.nodes.min;
  }
  if (limits.gpusPerNode && (form.gpusPerNode < limits.gpusPerNode.min || form.gpusPerNode > limits.gpusPerNode.max)) {
    form.gpusPerNode = limits.gpusPerNode.min;
  }

  const type: ProfileType = cm.metadata.labels[PROFILE_LABEL] === 'inference' ? 'inference' : 'training';
  let blueprint: Profile['blueprint'] = null;

  if (type === 'inference') {
    if (doc.blueprint?.name && doc.blueprint?.version) {
      blueprint = { name: String(doc.blueprint.name), version: String(doc.blueprint.version) };
    } else {
      problems.push('blueprint: an inference profile needs blueprint.name and blueprint.version');
    }
  }

  const requiredSecrets = (Array.isArray(doc.requiredSecrets) ? doc.requiredSecrets : [])
    .filter((r: any) => r && r.name)
    .map((r: any) => ({ name: String(r.name), hint: String(r.hint || '') }));

  const namePrefix = /^[a-z0-9]([-a-z0-9]{0,20}[a-z0-9])?$/.test(String(doc.namePrefix || '')) ? String(doc.namePrefix) : '';

  if (doc.namePrefix && !namePrefix) {
    problems.push(`namePrefix "${ doc.namePrefix }" must be lowercase letters, numbers and hyphens (max 22)`);
  }

  let reclaim: Profile['reclaim'] = null;

  if (doc.reclaim && typeof doc.reclaim === 'object') {
    const policy = (RECLAIM_POLICIES as readonly string[]).includes(doc.reclaim.policy) ? doc.reclaim.policy as ReclaimPolicy : '';
    const idleTimeout = IDLE_DURATION.test(String(doc.reclaim.idleTimeout || '')) ? String(doc.reclaim.idleTimeout) : '';

    if (doc.reclaim.policy && !policy) {
      problems.push(`reclaim.policy "${ doc.reclaim.policy }" must be ${ RECLAIM_POLICIES.join(', ') }`);
    }
    if (doc.reclaim.idleTimeout && !idleTimeout) {
      problems.push(`reclaim.idleTimeout "${ doc.reclaim.idleTimeout }" must be a number and m, h or d`);
    }
    reclaim = policy || idleTimeout ? { policy, idleTimeout } : null;
  }

  return {
    name:        cm.metadata.name,
    type,
    blueprint,
    requiredSecrets,
    namePrefix,
    reclaim,
    displayName: String(doc.displayName || cm.metadata.name),
    description: String(doc.description || ''),
    framework:   String(doc.framework || ''),
    // the card label: the profile's GPU type, else the free-text label older profiles carry
    gpu:         form.gpuProduct ? gpuShort(form.gpuProduct) : String(doc.gpu || ''),
    status:      doc.status === 'beta' ? 'beta' : 'ready',
    purpose:     doc.purpose === 'test' || doc.purpose === 'benchmark' ? doc.purpose : 'training',
    form,
    fixed:       fieldsSetBy(values),
    editable,
    limits,
    problems,
  };
}

/** Every profile among `configMaps`, from the profile namespace only, sorted by display name. */
export function profilesFrom(configMaps: any[], parseYaml: (s: string) => any): Profile[] {
  return (configMaps || [])
    .filter((cm) => cm?.metadata?.namespace === PROFILE_NAMESPACE)
    .map((cm) => profileFromConfigMap(cm, parseYaml))
    .filter((p): p is Profile => !!p)
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
}

/**
 * The form a deployment installs: the profile's form, with the user's input applied to the fields
 * the profile opens (plus namespace and releaseName, which are always the user's). Anything else in
 * `input` is ignored rather than trusted.
 */
export function resolveForm(profile: Profile, input: Partial<Form>): Form {
  const form: Form = { ...profile.form, env: { ...profile.form.env } };
  const open = new Set<string>([...profile.editable, 'namespace', 'releaseName']);

  (Object.keys(input) as (keyof Form)[]).forEach((k) => {
    if (open.has(k) && input[k] !== undefined) {
      (form as any)[k] = k === 'env' ? { ...profile.form.env, ...(input.env || {}) } : input[k];
    }
  });

  return form;
}

/** Docker's reading of an image name: registry host first, docker.io/library/ for bare names. */
export function normaliseImage(image: string): string {
  const ref = String(image || '').trim();
  const first = ref.split('/')[0];
  const hasHost = ref.includes('/') && (first.includes('.') || first.includes(':') || first === 'localhost');

  if (hasHost) {
    return ref;
  }

  return ref.includes('/') ? `docker.io/${ ref }` : `docker.io/library/${ ref }`;
}

/**
 * The profile's own checks, shown ahead of the cluster pre-flight. They fail on what the profile
 * forbids; the cluster pre-flight still decides whether the run can actually start.
 */
export function profileChecks(profile: Profile, form: Form): Check[] {
  const out: Check[] = [];
  const add = (id: string, severity: Check['severity'], title: string, detail = '') => out.push({
    id, severity, title, detail
  });

  if (profile.problems.length) {
    add('profile', 'warn', `Profile ${ profile.displayName } has ${ profile.problems.length } problem(s)`, profile.problems.join(' · '));
  } else {
    add('profile', 'pass', `Profile ${ profile.displayName }`, profile.description);
  }

  if (profile.namePrefix && !(form.releaseName === profile.namePrefix || form.releaseName.startsWith(`${ profile.namePrefix }-`))) {
    add('profile-name', 'fail', `Run name must start with ${ profile.namePrefix }-`, 'The profile names its runs with this prefix.');
  }

  const n = profile.limits.nodes;

  if (n && (form.nodes < n.min || form.nodes > n.max)) {
    add('profile-nodes', 'fail', `Workers must be between ${ n.min } and ${ n.max }`, `${ form.nodes } requested. The range is set by the profile.`);
  }

  const g = profile.limits.gpusPerNode;

  if (g && (form.gpusPerNode < g.min || form.gpusPerNode > g.max)) {
    add('profile-gpus', 'fail', `GPUs per worker must be between ${ g.min } and ${ g.max }`, `${ form.gpusPerNode } requested. The range is set by the profile.`);
  }

  const regs = profile.limits.registries || [];

  if (regs.length) {
    const img = normaliseImage(form.image);
    // Normalise both sides, so an allowed prefix of pytorch/ matches an image written docker.io/pytorch/...
    const ok = regs.some((r) => img.startsWith(normaliseImage(r)));

    if (!ok) {
      add('profile-image', 'fail', 'Image is not from a registry this profile allows', `${ img } — allowed image registries: ${ regs.join(', ') }`);
    } else {
      add('profile-image', 'pass', 'Image from an allowed registry', img);
    }
  }

  const max = profile.limits.maxRuntimeHours || 0;

  if (max > 0) {
    const h = Number(form.runtimeLimitHours) || 0;

    if (h <= 0 || h > max) {
      add('profile-runtime', 'fail', `Runtime limit must be set, at most ${ max } h`, h <= 0 ? 'No limit set; the profile requires one.' : `${ h } h requested.`);
    } else {
      add('profile-runtime', 'pass', `Runtime limit ${ h } h`, `The run is stopped after ${ h } h (profile maximum ${ max } h).`);
    }
  }

  // A value the profile fixes, changed anyway. The Deploy page cannot do this; imported YAML can.
  const drift = profile.fixed.filter((k) => !(profile.editable as string[]).includes(k) && JSON.stringify(form[k]) !== JSON.stringify(profile.form[k]));

  if (drift.length) {
    add('profile-fixed', 'fail', 'Changes values the profile fixes', drift.join(', '));
  }

  return out;
}

/** The resolved configuration, grouped for the read-only drawer on the Deploy page. */
export function resolvedSections(form: Form, resolvedGpuMode: string): { title: string; rows: { label: string; value: string }[] }[] {
  const network = form.hostNetwork ? 'host network' : form.multusNetwork ? `Multus ${ form.multusNetwork }` : 'pod network';

  return [
    {
      title: 'Runtime',
      rows:  [
        { label: 'Workload', value: form.kind === 'pytorchjob' ? 'PyTorchJob (Training Operator)' : 'Indexed Job' },
        { label: 'Image', value: `${ form.image }:${ form.tag }` },
        { label: 'Run mode', value: form.mode },
        { label: 'Rendezvous', value: form.nodes > 1 ? form.rendezvous : '— (single worker)' },
      ],
    },
    {
      title: 'Compute',
      rows:  [
        { label: 'Workers', value: String(form.nodes) },
        { label: 'GPU per worker', value: `${ form.gpusPerNode } (${ resolvedGpuMode })` },
        { label: 'GPU type', value: form.gpuProduct ? gpuShort(form.gpuProduct) : 'any' },
        { label: 'GPU allocation', value: form.gpuShareMiB > 0 ? `shared, ${ (form.gpuShareMiB / 1024).toFixed(1).replace(/\.0$/, '') } GiB per worker${ form.gpuSharedClaim ? ` on ${ form.gpuSharedClaim }` : '' }` : 'exclusive' },
        { label: 'CPU per worker', value: form.cpuRequest },
        { label: 'Memory per worker', value: form.memRequest },
        { label: 'Ephemeral per worker', value: form.ephemeralRequest },
      ],
    },
    {
      title: 'Scheduling',
      rows:  [
        { label: 'Scheduler', value: form.scheduler === 'none' ? 'default scheduler' : form.scheduler },
        { label: 'Queue', value: form.queue || '—' },
        { label: 'Priority class', value: form.priorityClassName || '—' },
        { label: 'Network', value: network },
      ],
    },
    {
      title: 'Storage',
      rows:  [
        { label: 'Scratch', value: form.scratchSize ? `${ form.scratchSize } at /scratch` : 'node disk' },
        { label: 'Dataset', value: form.datasetPVC ? `${ form.datasetPVC } at /mnt/dataset` : '—' },
        { label: 'Checkpoints', value: form.checkpointPVC ? `${ form.checkpointPVC } at /mnt/checkpoints` : '—' },
        { label: 'Code ConfigMap', value: form.configMap || '—' },
      ],
    },
    {
      title: 'Policy',
      rows:  [{ label: 'Runtime limit', value: form.runtimeLimitHours ? `${ form.runtimeLimitHours } h` : 'none' }],
    },
  ];
}

// ---- authoring: the Submit form saved as a profile ----

export interface ProfileMeta {
  name: string;
  namePrefix?: string;
  displayName: string;
  description: string;
  framework: string;
  gpu: string;
  status: 'ready' | 'beta';
  purpose?: ProfilePurpose;
}

/**
 * Fields whose value names something inside one namespace. Fixed in a profile, they only work in
 * the namespace the profile was written from, so the author is told before saving.
 */
export const NAMESPACED_FIELDS: (keyof Form)[] = ['configMap', 'datasetPVC', 'checkpointPVC', 'secretName'];

/** Namespaced fields the profile would fix to a value, e.g. a dataset claim from the author's namespace. */
export function namespacedFixed(form: Form, editable: EditableField[]): (keyof Form)[] {
  return NAMESPACED_FIELDS.filter((k) => !!form[k] && !(editable as string[]).includes(k));
}

/**
 * The profile.yaml document for a form. `chartValues` is what the Submit page would install
 * (chartValuesFor). With `followProjectScheduler`, scheduler type and queue are left out, so each
 * deployment takes them from its own project namespace, as the Submit page does; otherwise the
 * author's queue would be fixed for everyone.
 */
export function profileDocument(meta: ProfileMeta, chartValues: any, editable: EditableField[], limits: ProfileLimits, followProjectScheduler: boolean): any {
  const values = JSON.parse(JSON.stringify(chartValues || {}));

  delete values.preflight; // a per-user fact (can they list pods), not something to fix
  delete values.profile; // the profile a run came from is stamped at deploy time
  // the shared claim is per namespace; the Deploy page attaches each run to its own project's
  delete values.gpu?.sharedClaim;
  if (followProjectScheduler) {
    const pc = values.scheduler?.priorityClassName;

    delete values.scheduler;
    if (pc) {
      values.scheduler = { priorityClassName: pc };
    }
  }

  const l: any = {};

  if (limits.nodes) {
    l.nodes = { min: limits.nodes.min, max: limits.nodes.max };
  }
  if (limits.gpusPerNode && editable.includes('gpusPerNode')) {
    l.gpusPerNode = { min: limits.gpusPerNode.min, max: limits.gpusPerNode.max };
  }
  if (limits.registries?.length) {
    l.registries = limits.registries;
  }
  if (limits.maxRuntimeHours) {
    l.maxRuntimeHours = limits.maxRuntimeHours;
  }

  return {
    displayName: meta.displayName || meta.name,
    description: meta.description,
    framework:   meta.framework,
    gpu:         meta.gpu,
    status:      meta.status,
    ...(meta.purpose && meta.purpose !== 'training' ? { purpose: meta.purpose } : {}),
    ...(meta.namePrefix ? { namePrefix: meta.namePrefix } : {}),
    values,
    editable:    [...editable],
    limits:      l,
  };
}

const PROFILE_NAME = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/;

/** Problems that stop a profile being saved. Empty means it can be written. */
export function profileSaveErrors(meta: ProfileMeta, limits: ProfileLimits, form: Form): string[] {
  const out: string[] = [];

  if (!PROFILE_NAME.test(meta.name || '')) {
    out.push('Name must be lowercase letters, numbers and hyphens (it becomes the ConfigMap name)');
  }
  if (meta.namePrefix && !/^[a-z0-9]([-a-z0-9]{0,20}[a-z0-9])?$/.test(meta.namePrefix)) {
    out.push('Name prefix must be lowercase letters, numbers and hyphens, at most 22 characters');
  }
  if (limits.nodes) {
    if (limits.nodes.min < 1 || limits.nodes.min > limits.nodes.max) {
      out.push(`Worker range ${ limits.nodes.min }–${ limits.nodes.max } is not a range`);
    } else if (form.nodes < limits.nodes.min || form.nodes > limits.nodes.max) {
      out.push(`The form's ${ form.nodes } worker(s) is outside the range ${ limits.nodes.min }–${ limits.nodes.max }, so the profile's default would fail its own check`);
    }
  }
  if (limits.gpusPerNode) {
    if (limits.gpusPerNode.min < 0 || limits.gpusPerNode.min > limits.gpusPerNode.max) {
      out.push(`GPU range ${ limits.gpusPerNode.min }–${ limits.gpusPerNode.max } is not a range`);
    } else if (form.gpusPerNode < limits.gpusPerNode.min || form.gpusPerNode > limits.gpusPerNode.max) {
      out.push(`The form's ${ form.gpusPerNode } GPU(s) per worker is outside the range ${ limits.gpusPerNode.min }–${ limits.gpusPerNode.max }`);
    }
  }
  if (limits.maxRuntimeHours && form.runtimeLimitHours > limits.maxRuntimeHours) {
    out.push(`The form's runtime limit (${ form.runtimeLimitHours } h) is above the maximum (${ limits.maxRuntimeHours } h)`);
  }

  return out;
}

/** The ConfigMap a profile is stored in. `dump` renders profile.yaml (js-yaml's dump in the page). */
export function profileConfigMap(meta: ProfileMeta, doc: any, dump: (o: any) => string, type: ProfileType = 'training'): any {
  return {
    type:     'configmap',
    metadata: {
      name:      meta.name,
      namespace: PROFILE_NAMESPACE,
      labels:    { [PROFILE_LABEL]: type },
    },
    data: { [PROFILE_KEY]: dump(doc) },
  };
}

/** A default allowed-registry prefix for an image: its registry and first path segment. */
export function registryPrefixOf(image: string): string {
  const parts = normaliseImage(image).split('/');

  return parts.length > 2 ? `${ parts.slice(0, -1).join('/') }/` : `${ parts[0] }/`;
}

// ---- the Profiles page filters ----

export interface ProfileFilter {
  text: string; // matched against name, display name, description, framework and GPU
  framework: string; // '' = all
  gpu: string;
  status: '' | 'ready' | 'beta';
}

export const NO_FILTER: ProfileFilter = {
  text: '', framework: '', gpu: '', status: ''
};

export function filterProfiles(profiles: Profile[], type: ProfileType, f: ProfileFilter): Profile[] {
  const words = f.text.toLowerCase().split(/\s+/).filter(Boolean);

  return profiles.filter((p) => {
    if (p.type !== type) {
      return false;
    }
    if ((f.framework && p.framework !== f.framework) || (f.gpu && p.gpu !== f.gpu) || (f.status && p.status !== f.status)) {
      return false;
    }
    const hay = [p.name, p.displayName, p.description, p.framework, p.gpu].join(' ').toLowerCase();

    return words.every((w) => hay.includes(w));
  });
}

/** The values a filter dropdown offers: what the profiles of this type actually use, sorted. */
export function filterOptions(profiles: Profile[], type: ProfileType, key: 'framework' | 'gpu'): string[] {
  return [...new Set(profiles.filter((p) => p.type === type).map((p) => p[key]).filter(Boolean))].sort();
}

// ---------------------------------------------------------------- inference profiles

/** What an inference profile holds: a blueprint and version to deploy, and what the project needs first. */
export interface InferenceProfileDraft {
  meta: ProfileMeta;
  blueprint: { name: string; version: string };
  requiredSecrets: { name: string; hint: string }[];
}

const SECRET_NAME = /^[a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?$/;

/** Everything that stops an inference profile from being saved. */
export function inferenceProfileErrors(d: InferenceProfileDraft): string[] {
  const out: string[] = [];

  if (!PROFILE_NAME.test(d.meta.name || '')) {
    out.push('Name must be lowercase letters, numbers and hyphens (it becomes the ConfigMap name)');
  }
  if (!d.meta.displayName.trim()) {
    out.push('Display name is required');
  }
  if (!d.blueprint.name || !d.blueprint.version) {
    out.push('Choose the blueprint and version this profile deploys');
  }
  d.requiredSecrets.forEach((s, i) => {
    if (!SECRET_NAME.test(s.name)) {
      out.push(`Required secret ${ i + 1 }: "${ s.name }" is not a valid Secret name`);
    }
  });

  return out;
}

/** profile.yaml of an inference profile: what profileFromConfigMap reads back. Empty fields are left out. */
export function inferenceProfileDocument(d: InferenceProfileDraft): any {
  const doc: any = { displayName: d.meta.displayName.trim() };

  if (d.meta.description.trim()) {
    doc.description = d.meta.description.trim();
  }
  if (d.meta.framework.trim()) {
    doc.framework = d.meta.framework.trim();
  }
  if (d.meta.gpu.trim()) {
    doc.gpu = d.meta.gpu.trim();
  }
  doc.status = d.meta.status;
  doc.blueprint = { name: d.blueprint.name, version: d.blueprint.version };
  const secrets = d.requiredSecrets.filter((s) => s.name).map((s) => (s.hint.trim() ? { name: s.name, hint: s.hint.trim() } : { name: s.name }));

  if (secrets.length) {
    doc.requiredSecrets = secrets;
  }

  return doc;
}

/** The draft an existing inference profile opens as in the editor. */
export function inferenceDraftFrom(p: Profile): InferenceProfileDraft {
  return {
    meta: {
      name: p.name, displayName: p.displayName, description: p.description, framework: p.framework, gpu: p.gpu, status: p.status
    },
    blueprint:       { name: p.blueprint?.name || '', version: p.blueprint?.version || '' },
    requiredSecrets: p.requiredSecrets.map((s) => ({ ...s })),
  };
}
