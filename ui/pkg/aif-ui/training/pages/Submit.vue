<script lang="ts">
import { defineComponent } from 'vue';
import LabeledInput from '@components/Form/LabeledInput/LabeledInput.vue';
import LabeledSelect from '@shell/components/form/LabeledSelect.vue';
import RadioGroup from '@components/Form/Radio/RadioGroup.vue';
import Banner from '@components/Banner/Banner.vue';
import AsyncButton from '@shell/components/AsyncButton.vue';
import Loading from '@shell/components/Loading.vue';
import KeyValue from '@shell/components/form/KeyValue.vue';
import Checkbox from '@components/Form/Checkbox/Checkbox.vue';
import YamlEditor from '@shell/components/YamlEditor.vue';
import Tabbed from '@shell/components/Tabbed/index.vue';
import Tab from '@shell/components/Tabbed/Tab.vue';
import ProfilePanel from '../components/ProfilePanel.vue';
import StatusPill from '../components/StatusPill.vue';
import TabProblems from '../components/TabProblems.vue';
import jsyaml from 'js-yaml';
import { saferDump } from '@shell/utils/create-yaml';
import {
  CD_CHANNEL_DEVICE_CLASS, CHART_NAME, GPU_DEVICE_CLASS, GPU_RESOURCE,
  ENDPOINTS_PAGE, JOB_LABEL, JOB_LABEL_VALUE, PRODUCT_NAME, PROFILES_PAGE, TYPES
} from '../config';
import {
  chartValuesFor, Check, DEFAULT_FORM, Facts, Form, estimateScratch, formFromManifest, formFromValues, GpuNode,
  automaticPlacementChecks, checksFor, parseCpu, parseMem, PvcInfo, resolveGpuMode, runPreflight,
  StorageClassInfo, summarize
} from '../preflight';
import {
  availability, buildQueueIndex, clusterCapacity, namespaceQueueMap, usageFromPods, withPodUsage
} from '../quota';
import { pvcRole } from '../checkpoints';
import { Profile, PROFILE_NAMESPACE, profilesFrom } from '../profiles';
import { aiJobFor, AIJOB_TYPE } from '../aijob';
import {
  createAIJob, fetchPools, fetchProjects, LOCAL_CLUSTER, localProfileConfigMaps, poolLabel, projectClusterNamespace, projectNamespace
} from '../placement';
import { IDLE_DURATION, RECLAIM_POLICIES, RECLAIM_POLICY_HELP } from '../reclaim';
import { getAllClusters } from '../../services/rancher-apps';
import { backendOf, placesGpuMemoryShares, usesQueueTree } from '../schedulers';
import { groupOf, readiness } from '../readiness';
import { gpuInventory, gpuShort, hasGfdLabels } from '../gputypes';
import { gib, pickSharedClaim, sharedGpus } from '../gpushare';

// Profile mode is a wizard. One list, so the order is decided here and nowhere else.
const WIZARD_STEPS: { key: 'profile' | 'configure' | 'guardrails' | 'preflight'; label: string }[] = [
  { key: 'profile', label: 'Profile' },
  { key: 'configure', label: 'Configure' },
  { key: 'guardrails', label: 'Guardrails' },
  { key: 'preflight', label: 'Pre-flight' },
];

const EMPTY_FACTS: Facts = {
  loaded:                   false,
  namespaces:               [],
  kueueInstalled:           false,
  kaiInstalled:             false,
  runaiInstalled:           false,
  runaiProjectNamespaces:   [],
  pytorchOperatorInstalled: false,
  jobApi:                   false,
  localQueues:              [],
  clusterQueues:            [],
  kaiQueues:                [],
  devicePluginGpus:         0,
  draDevices:               0,
  gpuDeviceMemory:          0,
  gpuTypes:                 [],
  gfdLabels:                false,
  gpuNodeMemoryMiB:         0,
  sharedGpus:               [],
  draAllocated:             0,
  draAllocatedBy:           [],
  claimsClusterWide:        false,
  draClassExists:           false,
  gpuReadable:              true,
  computeDomainAvailable:   false,
  gpuNodes:                 [],
  podsReadable:             false,
  existingJobs:             [],
  configMaps:               [],
  secrets:                  [],
  pvcs:                     [],
  storageClasses:           [],
  chart:                    null,
  fetchErrors:              [],
  queueIndex:               {},
  capacity:                 {
    total: {
      gpu: 0, cpu: 0, memory: 0
    },
    free: {
      gpu: 0, cpu: 0, memory: 0
    }
  },
  namespaceQueue: null,
};

export default defineComponent({
  name:       'TrainingJobSubmit',
  components: {
    LabeledInput,
    LabeledSelect,
    Banner,
    AsyncButton,
    Loading,
    KeyValue,
    Checkbox,
    YamlEditor,
    Tabbed,
    Tab,
    ProfilePanel,
    TabProblems,
    StatusPill,
    RadioGroup,
  },

  data() {
    return {
      form:            { ...DEFAULT_FORM } as Form,
      facts:           { ...EMPTY_FACTS } as Facts,
      submitted:       false,
      // Advanced: install a chart of your own instead of the one built into AI Factory.
      customChart:     {
        enabled: false, repoName: '', chartName: '', version: ''
      },
      allConfigMaps:   [] as any[],
      // AI projects and compute pools, read from local whatever cluster this page is on.
      projects:        [] as any[],
      pools:           [] as any[],
      // what happens when the run sits idle in a pool that reclaims (AIJob.spec.reclaim); '' = the default
      reclaim:         { policy: '', idleTimeout: '' } as { policy: string; idleTimeout: string },
      allSecrets:      [] as any[],
      allPvcs:         [] as any[],
      namespaceQueues: {} as Record<string, string>,
      error:           '' as string,

      // ---- YAML entry ----
      // 'form' drives the YAML, never the other way round: parsing arbitrary YAML back into the form
      // would silently drop anything the form cannot express. Once edited, the YAML wins on submit.
      entryMode:        'form' as 'form' | 'yaml',
      yamlSource:       'values' as 'values' | 'manifest',
      valuesYaml:       '' as string,
      manifestYaml:     '' as string,
      valuesEdited:     false,
      // YamlEditor copies its prop into local state on create and never watches it, so replacing the
      // text from outside means remounting the editor. Bumping this key is how Regenerate takes hold.
      yamlNonce:        0,
      // Result of the last "Apply to form", shown until the next one. Kept out of the YAML buffer
      // so reading values into the form never changes what would be installed.
      formFillNotice:   '' as string,
      formFillUnmapped: [] as string[],

      // ---- profile authoring (?authorProfile=new|<name>) ----
      // The admin fills the form in as for a run, and saves it as a profile instead of submitting.
      editingProfile:   null as Profile | null,
      canWriteProfiles: false,
      wizardStep:       WIZARD_STEPS[0].key as string,
      // from ProfilePanel: what stops the profile being saved, by the step it belongs to
      profileBlockers:  { details: [] as string[], guardrails: [] as string[] },
      profilePrefix:    '' as string, // the profile's run name prefix, for the disabled Job name field
    };
  },

  async fetch() {
    await this.loadPools();
    await this.loadFacts();
    if (this.profileMode) {
      await this.startProfileAuthoring(String(this.$route.query.authorProfile));
    }
  },

  computed: {
    checks(): Check[] {
      const checks = checksFor(runPreflight(this.form, this.facts), { profile: !!this.$route.query.authorProfile, scheduler: this.form.scheduler });

      return this.automatic ? automaticPlacementChecks(checks, this.projectName) : checks;
    },
    profileMode(): boolean {
      return !!this.$route.query.authorProfile;
    },
    wizardSteps: () => WIZARD_STEPS,
    allBlockers(): string[] {
      return [...this.profileBlockers.details, ...this.profileBlockers.guardrails];
    },
    /** The number on a step: pre-flight failures and warnings, or that step's save blockers. */
    stepBadge(): Record<string, number> {
      return {
        profile: this.profileBlockers.details.length, guardrails: this.profileBlockers.guardrails.length, configure: 0, preflight: this.preflightIssues
      };
    },
    wizardIndex(): number {
      return WIZARD_STEPS.findIndex((s) => s.key === this.wizardStep);
    },
    /** Failures and warnings, the number on the Pre-flight step. */
    preflightIssues(): number {
      return this.checks.filter((c: Check) => c.severity === 'fail' || c.severity === 'warn').length;
    },
    /** Every check, in the Readiness panel's categories and order, for the Pre-flight step. */
    preflightGroups(): { key: string; label: string; severity: string; checks: Check[] }[] {
      return readiness(this.checks, this.form).groups.map((g) => ({ ...g, checks: this.checks.filter((c: Check) => groupOf(c.id).key === g.key) }));
    },
    summary(): { fails: number; warns: number; ok: boolean } {
      return summarize(this.checks);
    },
    resolvedGpuMode(): string {
      return resolveGpuMode(this.form, this.facts);
    },
    namespaceOptions(): string[] {
      return this.facts.namespaces;
    },
    schedulerOptions(): { label: string; value: string }[] {
      // "no queue" is not the same as "no quota": a namespace ResourceQuota still caps this job,
      // it is just enforced at admission rather than by a scheduler that can queue and preempt.
      const out = [{ label: 'Default scheduler (ResourceQuota cap only)', value: 'none' }];

      if (this.facts.kueueInstalled) {
        out.push({ label: 'Kueue (queue admission)', value: 'kueue' });
      }
      if (this.facts.kaiInstalled) {
        // One entry, not two: the cluster runs one of them, and offering the other only invites
        // the choice that leaves every pod Pending.
        const value = this.facts.runaiInstalled ? 'runai' : 'kai';

        out.push({ label: `${ backendOf(value).display } (gang + fair share)`, value });
      }

      return out;
    },
    // KAI and Run:AI are the same scheduler under two names, so every UI branch that is really
    // "are its queues a scheduling.run.ai tree?" asks this rather than listing both literals.
    isQueueSched(): boolean {
      return usesQueueTree(this.form.scheduler);
    },
    queueOptions(): { label: string; value: string }[] {
      if (this.form.scheduler === 'kueue') {
        return this.facts.localQueues
          .filter((q) => q.namespace === this.form.namespace)
          .map((q) => ({ label: `${ q.name }  →  ${ q.clusterQueue }`, value: q.name }));
      }
      if (usesQueueTree(this.form.scheduler)) {
        // Only leaf queues can run workloads, so parents are not offered. Each option carries its
        // live headroom, which is the number that decides whether the job starts or waits.
        return Object.values(this.facts.queueIndex)
          .filter((q) => q.isLeaf)
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((q) => {
            const a = availability(q.name, this.facts.queueIndex, this.facts.capacity, 'gpu');
            const cap = Number.isFinite(a.cap) ? a.cap : '∞';

            return { label: `${ q.name }  ·  ${ a.allocated }/${ cap } GPU used  ·  ${ a.schedulableNow } free now`, value: q.name };
          });
      }

      return [];
    },
    /**
     * The GPU models the cluster has, with how many are free where that is known (DRA). A value the
     * cluster does not have (a profile written elsewhere) stays in the list so it is not lost.
     */
    gpuTypeOptions(): { label: string; value: string }[] {
      const opts = [{ label: 'Any GPU', value: '' }, ...this.facts.gpuTypes.map((t: any) => ({
        label: `${ gpuShort(t.product) } — ${ t.free === null ? `${ t.total } on ${ t.nodes.length } node(s)` : `${ t.free } of ${ t.total } free` } (${ t.source === 'dra' ? 'DRA' : 'GPU Feature Discovery' })`,
        value: t.product,
      }))];

      if (this.form.gpuProduct && !opts.some((o) => o.value === this.form.gpuProduct)) {
        opts.push({ label: `${ gpuShort(this.form.gpuProduct) } (not in this cluster)`, value: this.form.gpuProduct });
      }

      return opts;
    },
    /** Exclusive, or one of this namespace's shared GPUs, with what is left on each. */
    gpuAllocationOptions(): { label: string; value: string }[] {
      // Under KAI a share is a memory amount, queued and placed by the scheduler: no claim to pick.
      if (placesGpuMemoryShares(this.form.scheduler)) {
        return [
          { label: 'Exclusive — a GPU of its own', value: '' },
          { label: `Shared — part of a GPU, queued by ${ backendOf(this.form.scheduler).display }`, value: '__kai__' },
        ];
      }
      const shared = this.facts.sharedGpus.filter((g: any) => g.namespace === this.form.namespace).map((g: any) => ({
        label: `Shared: ${ g.name } — ${ g.product ? gpuShort(g.product) : 'not allocated yet' }${ g.totalMiB ? `, ${ gib(g.usedMiB) } of ${ gib(g.totalMiB) } in use by ${ g.users.length }` : '' } (${ g.strategy })`,
        value: g.name,
      }));

      return [
        { label: 'Exclusive — a GPU of its own', value: '' },
        ...shared,
        ...(shared.length ? [] : [{ label: 'Shared — this project has no shared GPU yet', value: '__none__' }]),
      ];
    },
    gpuAllocation: {
      get(): string {
        if (this.form.gpuShareMiB > 0 && placesGpuMemoryShares(this.form.scheduler)) {
          return '__kai__';
        }

        return this.form.gpuShareMiB > 0 ? (this.form.gpuSharedClaim || '__none__') : '';
      },
      set(v: string) {
        if (!v) {
          this.form.gpuShareMiB = 0;
          this.form.gpuSharedClaim = '';
        } else {
          this.form.gpuSharedClaim = v === '__none__' || v === '__kai__' ? '' : v;
          if (!this.form.gpuShareMiB) {
            this.form.gpuShareMiB = 4096;
          }
          this.form.gpusPerNode = 1;
        }
      },
    },
    /** Scratch as one choice: none (no size), or a size on the node disk or a volume. */
    scratchMode: {
      get(): 'none' | 'node' | 'volume' {
        return this.form.scratchSize ? this.form.scratchMedium : 'none';
      },
      set(v: 'none' | 'node' | 'volume') {
        if (v === 'none') {
          this.form.scratchSize = '';
        } else {
          this.form.scratchMedium = v;
          if (!this.form.scratchSize) {
            this.form.scratchSize = '20Gi';
          }
        }
      },
    },
    /** A GPU-memory share under KAI: placed by memory, so the GPU request mode does not apply. */
    kaiShare(): boolean {
      return this.form.gpuShareMiB > 0 && placesGpuMemoryShares(this.form.scheduler);
    },
    /** What KAI charges per pod for this share: its fraction of the node's GPU memory, rounded up. */
    shareFraction(): number | null {
      const mem = this.facts.gpuNodeMemoryMiB;

      return mem ? Math.ceil((this.form.gpuShareMiB / mem) * 100) / 100 : null;
    },
    gpuShareGiB: {
      get(): number {
        return Math.round((this.form.gpuShareMiB / 1024) * 10) / 10;
      },
      set(v: number) {
        this.form.gpuShareMiB = Math.max(0, Math.round((Number(v) || 0) * 1024));
      },
    },
    gpuModeOptions() {
      return [
        { label: `Auto (detected: ${ this.resolvedGpuMode })`, value: 'auto' },
        { label: 'Device plugin (nvidia.com/gpu)', value: 'device-plugin' },
        { label: 'DRA (ResourceClaim)', value: 'dra' },
      ];
    },
    modeOptions() {
      return [
        // torchrun first: it is the default and the thing people came here to run. Smoke stays
        // one click away as the fallback for when the cluster, not the code, is what is suspect.
        { label: 'torchrun (distributed PyTorch)', value: 'torchrun' },
        { label: 'Smoke test (nvidia-smi, no torch needed)', value: 'smoke' },
        { label: 'Custom command', value: 'custom' },
      ];
    },
    kindOptions(): { label: string; value: string; disabled?: boolean }[] {
      return [
        { label: 'Indexed Job (torchrun, no operator)', value: 'job' },
        {
          label:    this.facts.pytorchOperatorInstalled ? 'Kubeflow PyTorchJob (Master + Workers)' : 'Kubeflow PyTorchJob — Training Operator not installed',
          value:    'pytorchjob',
          disabled: !this.facts.pytorchOperatorInstalled,
        },
      ];
    },
    pvcOptions(): { label: string; value: string }[] {
      // Data volumes only: a run's checkpoints and scratch, and volumes other apps own (a
      // database's disk, a model cache), are not datasets. The one already chosen stays listed.
      return [
        { label: '(none)', value: '' },
        ...this.facts.pvcs.filter((p) => !p.role || p.role === 'data' || p.name === this.form.datasetPVC).map((p) => ({ label: this.pvcLabel(p), value: p.name })),
      ];
    },
    /** Checkpoint volumes to choose from: a previous run's, to resume from, then plain data volumes. */
    checkpointVolumeOptions(): any[] {
      const kept = this.facts.pvcs.filter((p) => p.role === 'checkpoint');
      const other = this.facts.pvcs.filter((p) => (!p.role || p.role === 'data') || (p.name === this.form.checkpointPVC && p.role !== 'checkpoint'));

      return [
        ...(kept.length ? [{ label: 'Resume from a previous run', value: '__resume__', kind: 'group', disabled: true }] : []),
        ...kept.map((p) => ({ label: `${ p.run }  ·  ${ p.size || '?' }`, value: p.name })),
        ...(other.length ? [{ label: 'Other volumes', value: '__other__', kind: 'group', disabled: true }] : []),
        ...other.map((p) => ({ label: this.pvcLabel(p), value: p.name })),
      ];
    },
    /**
     * Storage classes for the scratch volume, default first and marked.
     *
     * Scratch is one RWO PVC per pod, never shared, so access mode is not a constraint here the way
     * it is for the dataset and checkpoint claims — any class the cluster can provision will do.
     */
    storageClassOptions(): { label: string; value: string }[] {
      const byDefault = this.facts.storageClasses.find((c) => c.isDefault);

      return [
        { label: byDefault ? `Cluster default (${ byDefault.name })` : 'Cluster default — none is marked default', value: '' },
        ...this.facts.storageClasses.map((c) => ({ label: `${ c.name }  ·  ${ c.provisioner }`, value: c.name })),
      ];
    },
    secretOptions(): { label: string; value: string }[] {
      return [
        { label: '(none)', value: '' },
        ...this.facts.secrets.map((s) => ({ label: s, value: s })),
      ];
    },
    totalGpus(): number {
      return this.form.nodes * this.form.gpusPerNode;
    },
    scratchEstimate() {
      return estimateScratch(this.form);
    },

    // ================= collapsible sections =================
    //
    // Only Job and GPUs are open by default; the rest fold away with a one-line summary of what is
    // set inside them. A section opens itself when it holds something — a value the user set, or a
    // check that fails — because a fold that hides the reason submit is disabled is worse than the
    // clutter it saves.

    /** Check ids, grouped by the section whose fields produce them. */
    /** The failing and warning checks for each tab, in check order. */
    sectionChecks(): Record<string, Check[]> {
      const of: Record<string, string> = {
        chart:               'job',
        namespace:           'job',
        name:                'job',
        image:               'job',
        'image-torch':       'job',
        command:             'job',
        kind:                'job',
        gpu:                 'gpu',
        cd:                  'gpu',
        capacity:            'gpu',
        headroom:            'gpu',
        ephemeral:           'gpu',
        disk:                'gpu',
        'gpu-in-use':        'gpu',
        'gpu-type':          'gpu',
        'image-pull':        'job',
        'gpu-share':         'gpu',
        'image-cache':       'job',
        'kind-gang':         'job',
        ckpt:                'storage',
        'queue-ns-mismatch': 'scheduling',
        hostnet:             'fabric',
        configmap:           'storage',
        scratch:             'storage',
        secret:              'storage',
        scheduler:           'scheduling',
        queue:               'scheduling',
        'queue-ns-label':    'scheduling',
        'runai-project':     'scheduling',
        rdzv:                'network',
        nccl:                'network',
        rdma:                'fabric',
      };
      const out: Record<string, Check[]> = {};

      for (const c of this.checks) {
        if ((c.severity === 'fail' || c.severity === 'warn') && of[c.id]) {
          (out[of[c.id]] = out[of[c.id]] || []).push(c);
        }
      }

      return out;
    },
    /** Tabs with a failing check: what the error marker on each tab means. */
    sectionFails(): Record<string, boolean> {
      const out: Record<string, boolean> = {};

      Object.entries(this.sectionChecks).forEach(([tab, list]) => {
        if ((list as Check[]).some((c) => c.severity === 'fail')) {
          out[tab] = true;
        }
      });

      return out;
    },
    /**
     * Which tab opens first. Picks the first one with a failing check, in the same top-to-bottom
     * order the tabs render in, so a submission that already has a problem lands on it instead of
     * silently starting on Job.
     */
    defaultSubmitTab(): string {
      const order = ['job', 'gpu', 'storage', 'scheduling', 'network', 'fabric'];

      return order.find((id) => this.sectionFails[id]) || 'job';
    },
    /**
     * Section-level prose, on the header's info bubble rather than as a paragraph under the fields.
     * v-clean-tooltip sanitises, so the markup here is safe.
     */
    storageInfo(): string {
      return 'The mounts are exported to your script as <code>$DATASET_DIR</code>, <code>$CHECKPOINT_DIR</code> and <code>$SCRATCH_DIR</code>.<br><br>' +
        'A run on more than one node needs RWX claims (CephFS/NFS) — every pod mounts the same volume at once.<br><br>' +
        'Scratch is <i>ephemeral</i> in lifetime, not in kind: it is a real PVC, created with the pod and deleted with it, so the cluster needs a default StorageClass. ' +
        'Leave it empty to write to the node disk instead, bounded by the ephemeral-storage request.<br><br>' +
        'A mounted Secret is how a run reaches an object store: its keys become files under the mount path (an <code>.s3cfg</code>, a token), and the chart never creates it.';
    },
    fabricInfo(): string {
      return 'For clusters with a RoCE / InfiniBand rail that the pod network does not reach.<br><br>' +
        'The pods join the host network namespace, <code>/dev/infiniband</code> is mounted and the trainer runs privileged — which is what libibverbs needs to open the HCA — and NCCL\'s IB transport is enabled.<br><br>' +
        'Set the HCA ports: without them NCCL picks a single device and a dual-rail fabric runs at half its width.';
    },
    storageSummary(): string {
      const f = this.form;
      const parts = [
        f.datasetPVC && `dataset ${ f.datasetPVC }`,
        f.checkpointPVC && `checkpoints ${ f.checkpointPVC }`,
        f.scratchSize && `scratch ${ f.scratchSize }`,
        f.configMap && `config ${ f.configMap }`,
        f.secretName && `secret ${ f.secretName }`,
      ].filter(Boolean);

      return parts.length ? parts.join(' · ') : 'node disk only';
    },
    storageOpen(): boolean {
      const f = this.form;

      return !!(f.datasetPVC || f.checkpointPVC || f.scratchSize || f.configMap || f.secretName || this.sectionFails.storage);
    },
    schedulingSummary(): string {
      if (this.form.scheduler === 'none') {
        return 'default scheduler';
      }
      const name = backendOf(this.form.scheduler).display;

      return `${ name }${ this.form.queue ? ` · queue ${ this.form.queue }` : '' }`;
    },
    schedulingOpen(): boolean {
      return this.form.scheduler !== 'none' || !!this.sectionFails.scheduling;
    },
    networkSummary(): string {
      const f = this.form;
      const parts = [
        f.rendezvous === 'etcd-v2' ? `etcd rendezvous` : '',
        f.multusNetwork && `on ${ f.multusNetwork }`,
        f.ncclSocketIfname && `NCCL via ${ f.ncclSocketIfname }`,
      ].filter(Boolean);

      return parts.length ? parts.join(' · ') : 'pod network, c10d rendezvous';
    },
    networkOpen(): boolean {
      const f = this.form;

      return !!(f.multusNetwork || f.ncclSocketIfname || f.rendezvous !== 'c10d' || this.sectionFails.network);
    },
    fabricSummary(): string {
      const f = this.form;

      if (!f.rdma && !f.hostNetwork) {
        return 'off — NCCL over TCP';
      }
      const parts = [
        f.hostNetwork && 'host network',
        f.rdma && `RoCE${ f.ncclIbHca ? ` ${ f.ncclIbHca }` : '' }`,
      ].filter(Boolean);

      return parts.join(' · ');
    },
    fabricOpen(): boolean {
      return this.form.rdma || this.form.hostNetwork || !!this.sectionFails.fabric;
    },
    chartValues(): any {
      return chartValuesFor(this.form, this.facts.podsReadable);
    },

    // ================= YAML entry =================

    // module constants are not in template scope
    chartName:     () => CHART_NAME,
    productName:   () => PRODUCT_NAME,
    profilesPage:  () => PROFILES_PAGE,
    jobLabel:      () => JOB_LABEL,
    jobLabelValue: () => JOB_LABEL_VALUE,

    /**
     * Every submission installs the chart as the user (Helm through Rancher). The manifest tab is
     * import-only: raw YAML never goes to the cluster from here, so runs are always Helm releases
     * the chart preflight has seen and the Workloads page can delete.
     */
    installsChart(): boolean {
      return true;
    },

    /** What actually gets installed: the form's values, or the user's edited YAML if they changed it. */
    effectiveValues(): any {
      if (this.entryMode === 'yaml' && this.yamlSource === 'values' && this.valuesEdited) {
        return this.parsedValues.doc;
      }

      return this.chartValues;
    },

    parsedValues(): { doc: any; error: string } {
      try {
        const doc = jsyaml.load(this.valuesYaml || '');

        if (doc !== null && doc !== undefined && (typeof doc !== 'object' || Array.isArray(doc))) {
          return { doc: null, error: 'Helm values must be a YAML mapping at the top level.' };
        }

        return { doc: doc || {}, error: '' };
      } catch (e: any) {
        return { doc: null, error: e?.message || String(e) };
      }
    },

    parsedManifest(): { docs: any[]; error: string } {
      try {
        // loadAll, not load: a training run is usually a ConfigMap plus a Job, and refusing multi-doc
        // input would send people back to kubectl for the one case the YAML tab exists to cover.
        const docs = jsyaml.loadAll(this.manifestYaml || '').filter((d: any) => d !== null && d !== undefined);

        if (!docs.length) {
          return { docs: [], error: 'No YAML documents found.' };
        }
        const bad = docs.find((d: any) => typeof d !== 'object' || Array.isArray(d) || !d.kind || !d.apiVersion);

        if (bad) {
          return { docs: [], error: 'Every document needs an apiVersion and a kind.' };
        }

        return { docs, error: '' };
      } catch (e: any) {
        return { docs: [], error: e?.message || String(e) };
      }
    },

    yamlError(): string {
      if (this.entryMode !== 'yaml') {
        return '';
      }

      return this.yamlSource === 'values' ? this.parsedValues.error : this.parsedManifest.error;
    },

    /** Namespaces named in the pasted manifest that disagree with the selected default. */
    manifestNamespaces(): string[] {
      return [...new Set(this.parsedManifest.docs.map((d: any) => d.metadata?.namespace).filter(Boolean))] as string[];
    },


    /** The AI project the run belongs to, from the page's query. */
    projectName(): string {
      return String(this.$route.query.project || '');
    },
    selectedProject(): any {
      return this.projects.find((p: any) => p.metadata.name === this.projectName) || null;
    },
    projectOptions(): { label: string; value: string }[] {
      return this.projects.map((p: any) => ({ label: p.spec?.displayName || p.metadata.name, value: p.metadata.name }));
    },
    /** The pool the run goes to, from the page's query: choosing one moves the page to its cluster. */
    poolName(): string {
      return String(this.$route.query.pool || '');
    },
    /** A project and no pool: AI Factory places the run on the project's best-fitting pool. */
    automatic(): boolean {
      return !!this.projectName && !this.poolName;
    },
    reclaimOptions(): { label: string; value: string }[] {
      return [
        { label: 'Default (Suspend)', value: '' },
        ...RECLAIM_POLICIES.map((p) => ({ label: `${ p } — ${ RECLAIM_POLICY_HELP[p] }`, value: p })),
      ];
    },
    reclaimTimeoutError(): string {
      return this.reclaim.idleTimeout && !IDLE_DURATION.test(this.reclaim.idleTimeout) ? 'A number and m, h or d, e.g. 30m, 2h, 3d' : '';
    },
    /** Automatic, or one of the pools on the clusters the project spans. */
    poolOptions(): { label: string; value: string }[] {
      const spans = new Set((this.selectedProject?.spec?.clusters || []).map((c: any) => c.clusterId));

      return [
        { label: 'Automatic — the best fit across the project\'s clusters', value: '' },
        ...this.pools.filter((p: any) => spans.has(p.clusterId)).map((p: any) => ({ label: poolLabel(p), value: p.name })),
      ];
    },

    submitDisabled(): boolean {
      if (this.reclaimTimeoutError) {
        return true;
      }
      if (this.entryMode === 'yaml') {
        if (this.yamlError) {
          return true;
        }

        // manifest tab: read it into the form, then submit from Form or Helm values
        return this.yamlSource === 'values' ? !this.facts.jobApi : true;
      }

      return !this.summary.ok || !this.facts.jobApi;
    },

    /**
     * A starting point for the manifest tab, not a rendering of the chart: the chart's real output
     * has defaults and helpers this cannot reproduce. To copy a real one, run a job from the form
     * and use the YAML button on the Jobs page.
     */
    manifestSkeleton(): string {
      const f = this.form;
      const gpu = String(f.gpusPerNode || 1);
      const obj: any = {
        apiVersion: 'batch/v1',
        kind:       'Job',
        metadata:   {
          name:      f.releaseName || 'train-example',
          namespace: f.namespace || 'default',
          // without this label the Jobs page will not list the run
          labels:    { [JOB_LABEL]: JOB_LABEL_VALUE },
        },
        spec: {
          backoffLimit: 0,
          template:     {
            metadata: { labels: { [JOB_LABEL]: JOB_LABEL_VALUE } },
            spec:     {
              restartPolicy: 'Never',
              containers:    [{
                name:      'train',
                image:     `${ f.image }:${ f.tag }`,
                command:   ['bash', '-lc', 'nvidia-smi'],
                resources: { limits: { [GPU_RESOURCE]: gpu } },
              }],
            },
          },
        },
      };

      // Bound the way the chart binds it (schedulers.ts / schedulers.yaml).
      const backend = backendOf(f.scheduler);

      if (backend.queue && f.queue) {
        if (backend.schedulerName) {
          obj.spec.template.spec.schedulerName = backend.schedulerName;
        }
        if (backend.admission === 'suspend') {
          obj.spec.suspend = true;
        }
        (backend.queue.target === 'pod' ? obj.spec.template.metadata.labels : obj.metadata.labels)[backend.queue.label] = f.queue;
      }

      return saferDump(obj);
    },
  },

  watch: {
    // Choosing a pool moves the page to the pool's cluster: read everything again from there.
    '$route.params.cluster'() {
      (this as any).$fetch();
    },
    'form.scheduler'() {
      // pick the first visible queue automatically
      this.form.queue = this.queueOptions[0]?.value || '';
    },
    'form.namespace'(ns: string) {
      if (this.form.scheduler === 'kueue') {
        this.form.queue = this.queueOptions[0]?.value || '';
      }
      // A namespace bound to a queue decides the quota the job is charged to, so follow it rather
      // than leaving a stale selection that the scheduler would silently override.
      this.facts.namespaceQueue = this.namespaceQueues[ns] || null;
      // A project bound to a KAI queue is scheduled by KAI: switch to it rather than leave Kueue or
      // none selected, which would bypass the project's queue (and offer DRA-only GPU sharing).
      if (this.facts.namespaceQueue && this.facts.kaiInstalled && !usesQueueTree(this.form.scheduler)) {
        this.form.scheduler = this.facts.runaiInstalled ? 'runai' : 'kai';
        this.$nextTick(() => {
          this.form.queue = this.facts.namespaceQueue || this.form.queue;
        });
      }
      if (usesQueueTree(this.form.scheduler) && this.facts.namespaceQueue) {
        this.form.queue = this.facts.namespaceQueue;
      }
      // a shared GPU is per project: follow the namespace to its own shared claim
      if (this.form.gpuShareMiB > 0) {
        this.form.gpuSharedClaim = placesGpuMemoryShares(this.form.scheduler) ? '' : pickSharedClaim({ ...this.form, namespace: ns }, this.facts);
      }
      this.facts.configMaps = this.configMapsFor(ns);
      this.facts.configMapCode = this.configMapCodeFor(ns);
      if (this.form.configMap && !this.facts.configMaps.includes(this.form.configMap)) {
        this.form.configMap = '';
      }
      this.facts.secrets = this.secretsFor(ns);
      if (this.form.secretName && !this.facts.secrets.includes(this.form.secretName)) {
        this.form.secretName = '';
      }
      // PVCs are namespace-scoped, so a claim picked in the old namespace cannot be mounted here.
      this.facts.pvcs = this.pvcsFor(ns);
      const names = this.facts.pvcs.map((p) => p.name);

      if (this.form.datasetPVC && !names.includes(this.form.datasetPVC)) {
        this.form.datasetPVC = '';
      }
      if (this.form.checkpointPVC && !names.includes(this.form.checkpointPVC)) {
        this.form.checkpointPVC = '';
      }
    },
    'facts.pytorchOperatorInstalled'(installed: boolean) {
      if (!installed && this.form.kind === 'pytorchjob') {
        this.form.kind = 'job';
      }
    },
  },

  methods: {
    /** The train.py of each ConfigMap in the namespace: what torchrun would run from it. */
    configMapCodeFor(ns: string): Record<string, string> {
      return Object.fromEntries(this.allConfigMaps
        .filter((c: any) => c.metadata.namespace === (ns || '') && c.data?.['train.py'])
        .map((c: any) => [c.metadata.name, c.data['train.py']]));
    },
    configMapsFor(ns: string): string[] {
      return this.allConfigMaps.filter((c: any) => c.metadata.namespace === (ns || '')).map((c: any) => c.metadata.name).sort();
    },
    secretsFor(ns: string): string[] {
      // Service-account tokens and Helm's own release blobs are noise in a credentials picker.
      return this.allSecrets
        .filter((s: any) => s.metadata.namespace === (ns || '') &&
          !['kubernetes.io/service-account-token', 'helm.sh/release.v1'].includes(s._type || s.type))
        .map((s: any) => s.metadata.name).sort();
    },
    // accessModes is in the label because it, not the size, decides whether a multi-node run can
    // mount the volume at all
    pvcLabel(p: PvcInfo): string {
      return `${ p.name }  ·  ${ p.accessModes.join('/') || 'unknown' }${ p.size ? `  ·  ${ p.size }` : '' }${ p.phase && p.phase !== 'Bound' ? `  ·  ${ p.phase }` : '' }`;
    },
    pvcsFor(ns: string): PvcInfo[] {
      return this.allPvcs
        .filter((p: any) => p.metadata.namespace === (ns || ''))
        .map((p: any): PvcInfo => ({
          name:        p.metadata.name,
          accessModes: p.spec?.accessModes || [],
          phase:       p.status?.phase || '',
          ...pvcRole(p),
          size:        p.status?.capacity?.storage || p.spec?.resources?.requests?.storage || '',
        }))
        .sort((a: PvcInfo, b: PvcInfo) => a.name.localeCompare(b.name));
    },

    async safeFindAll(type: string, label: string): Promise<any[]> {
      const schema = this.$store.getters['cluster/schemaFor'](type);

      if (!schema) {
        return [];
      }
      try {
        return await this.$store.dispatch('cluster/findAll', { type, opt: { force: true } });
      } catch (e: any) {
        this.facts.fetchErrors.push(`${ label }: ${ e?.message || e }`);

        return [];
      }
    },

    async canI(verb: string, resource: string, group = '', namespace = ''): Promise<boolean> {
      try {
        const cluster = this.$route.params.cluster;
        const res = await this.$store.dispatch('cluster/request', {
          url:    `/k8s/clusters/${ encodeURIComponent(String(cluster)) }/apis/authorization.k8s.io/v1/selfsubjectaccessreviews`,
          method: 'POST',
          data:   {
            apiVersion: 'authorization.k8s.io/v1',
            kind:       'SelfSubjectAccessReview',
            spec:       {
              resourceAttributes: {
                verb, resource, group, ...(namespace ? { namespace } : {})
              }
            },
          },
        });

        return !!res?.status?.allowed;
      } catch (e) {
        return false;
      }
    },

    /** Profile mode: check the right to publish, and load the profile being edited into the form. */
    async startProfileAuthoring(name: string) {
      this.canWriteProfiles = await this.canI('create', 'configmaps', '', PROFILE_NAMESPACE);
      if (name === 'new') {
        return;
      }
      const p = profilesFrom(await localProfileConfigMaps(this.$store), (s: string) => jsyaml.load(s)).find((x) => x.name === name);

      if (!p) {
        this.error = `No profile named ${ name } in ${ PROFILE_NAMESPACE }.`;

        return;
      }
      const keep = p.fixed.includes('scheduler') ? {} : { scheduler: this.form.scheduler, queue: this.form.queue };

      this.form = {
        ...p.form, namespace: this.form.namespace, releaseName: this.form.releaseName, ...keep
      };
      this.editingProfile = p;
    },

    wizardGo(delta: number) {
      const i = Math.min(WIZARD_STEPS.length - 1, Math.max(0, this.wizardIndex + delta));

      this.wizardStep = WIZARD_STEPS[i].key;
    },

    saveProfile(done: (ok: boolean) => void) {
      const panel: any = this.$refs.profilePanel;

      if (!panel) {
        done(false);

        return;
      }
      panel.save(done);
    },

    onProfileSaved() {
      this.$router.push({ name: `c-cluster-${ PRODUCT_NAME }-${ PROFILES_PAGE }`, params: { cluster: this.$route.params.cluster } });
    },

    /** The custom chart, once all three fields are filled in; null = the built-in chart. */
    customChartSource(): { repoName: string; chartName: string; version: string } | null {
      const c = this.customChart;
      const [repoName, chartName, version] = [c.repoName.trim(), c.chartName.trim(), c.version.trim()];

      return c.enabled && repoName && chartName && version ? { repoName, chartName, version } : null;
    },

    onCustomChart() {
      this.facts = { ...this.facts, chart: this.customChartSource() };
    },

    async loadPools() {
      try {
        const clusters = await getAllClusters(this.$store);
        const [projects, pools] = await Promise.all([
          fetchProjects(this.$store).catch(() => []),
          fetchPools(this.$store, Object.fromEntries(clusters.map((c: any) => [c.id, c.name]))),
        ]);

        this.projects = projects;
        this.pools = pools;
      } catch {
        this.pools = []; // an operator without ComputePool: runs stay on this cluster, as before
      }
    },

    /** A run belongs to an AI project: choosing one starts over on local, placed automatically. */
    chooseProject(name: string) {
      const query: Record<string, any> = { ...this.$route.query, project: name };

      delete query.pool;
      this.$router.push({ name: this.$route.name, params: { ...this.$route.params, cluster: LOCAL_CLUSTER }, query });
    },

    /**
     * Run in a pool: the page moves to the pool's cluster, so every fact below is read there.
     * Automatic ('') stays on local: the placement controller chooses the cluster.
     */
    choosePool(name: string) {
      const pool = this.pools.find((p: any) => p.name === name);
      const query: Record<string, any> = { ...this.$route.query };

      if (pool) {
        query.pool = name;
      } else {
        delete query.pool;
      }
      this.$router.push({ name: this.$route.name, params: { ...this.$route.params, cluster: pool?.clusterId || LOCAL_CLUSTER }, query });
    },

    /** Where the run is recorded, and, in a pool, the project's namespace on the pool's cluster. */
    refreshAiProject() {
      if (!this.pools.length) {
        return;
      }
      this.facts = { ...this.facts, aiProjectNamespace: this.projectName ? projectNamespace(this.projectName) : null };
      if (this.poolName && this.selectedProject) {
        this.form.namespace = projectClusterNamespace(this.selectedProject, String(this.$route.params.cluster)) || this.form.namespace;
      }
    },

    async loadFacts() {
      const facts: Facts = { ...EMPTY_FACTS, fetchErrors: [] };

      // The operator installs the run from the chart built into it: no repository to look up. A run
      // in a pool is recorded on local, where the operator serves AIJobs whenever it serves pools.
      facts.pool = this.poolName;
      facts.poolsAvailable = this.pools.length;
      facts.jobApi = !!this.projectName || !!this.$store.getters['cluster/schemaFor'](AIJOB_TYPE);
      facts.chart = this.customChartSource();

      facts.kueueInstalled = !!this.$store.getters['cluster/schemaFor'](TYPES.LOCAL_QUEUE);
      facts.kaiInstalled = !!this.$store.getters['cluster/schemaFor'](TYPES.KAI_QUEUE);
      // Same CRD under both products, so the queue type cannot distinguish them. The run.ai API
      // group only exists under commercial Run:AI, and it is what decides schedulerName below.
      facts.runaiInstalled = !!this.$store.getters['cluster/schemaFor'](TYPES.RUNAI_CLUSTER);
      // Schema presence is the CRD check: without the Training Operator's CRD there is no
      // PyTorchJob type in the API at all, so the option is not offered.
      facts.pytorchOperatorInstalled = !!this.$store.getters['cluster/schemaFor'](TYPES.PYTORCH_JOB);
      // Which namespaces Run:AI actually provisioned. A Project is what causes its controller to
      // write the RoleBindings the scheduler needs to bind pods; the namespace label alone does
      // not. Left empty when the Projects cannot be read, and the check that uses it then skips.
      if (facts.runaiInstalled) {
        const projects = await this.safeFindAll(TYPES.RUNAI_PROJECT, 'run.ai projects');

        facts.runaiProjectNamespaces = projects
          .map((p: any) => p?.status?.namespace)
          .filter((n: any): n is string => !!n);
      }
      facts.draClassExists = false;

      facts.podsReadable = await this.canI('list', 'pods');
      facts.claimsClusterWide = await this.canI('list', 'resourceclaims', 'resource.k8s.io');
      // An unreadable type comes back from safeFindAll as an empty list, which would read as "no GPUs".
      facts.gpuReadable = (await Promise.all([
        this.canI('list', 'nodes'),
        this.canI('list', 'deviceclasses', 'resource.k8s.io'),
        this.canI('list', 'resourceslices', 'resource.k8s.io'),
      ])).every(Boolean);

      const [namespaces, nodes, jobs, pytorchJobs, localQueues, clusterQueues, kaiQueues, deviceClasses, slices, pods, allConfigMaps, allSecrets, allPvcs, storageClasses, claims] = await Promise.all([
        this.safeFindAll(TYPES.NAMESPACE, 'namespaces'),
        this.safeFindAll(TYPES.NODE, 'nodes'),
        this.safeFindAll(TYPES.JOB, 'jobs'),
        facts.pytorchOperatorInstalled ? this.safeFindAll(TYPES.PYTORCH_JOB, 'pytorch jobs') : Promise.resolve([]),
        this.safeFindAll(TYPES.LOCAL_QUEUE, 'kueue local queues'),
        this.safeFindAll(TYPES.CLUSTER_QUEUE, 'kueue cluster queues'),
        this.safeFindAll(TYPES.KAI_QUEUE, 'kai queues'),
        this.safeFindAll(TYPES.DEVICE_CLASS, 'device classes'),
        this.safeFindAll(TYPES.RESOURCE_SLICE, 'resource slices'),
        facts.podsReadable ? this.safeFindAll(TYPES.POD, 'pods') : Promise.resolve([]),
        this.safeFindAll('configmap', 'configmaps'),
        // Listing secrets is a privilege plenty of submitters do not have. safeFindAll turns the
        // refusal into an empty list, and the check reads empty as "cannot tell", not as "absent".
        this.safeFindAll('secret', 'secrets'),
        this.safeFindAll(TYPES.PVC, 'persistent volume claims'),
        this.safeFindAll(TYPES.STORAGE_CLASS, 'storage classes'),
        this.safeFindAll(TYPES.RESOURCE_CLAIM, 'resource claims'),
      ]);

      this.allConfigMaps = allConfigMaps;
      this.allSecrets = allSecrets;
      this.allPvcs = allPvcs;

      facts.namespaces = namespaces.map((n: any) => n.metadata.name).filter((n: string) => !n.startsWith('kube-') && !n.startsWith('cattle-')).sort();
      facts.devicePluginGpus = nodes.reduce((sum: number, n: any) => sum + parseInt(n.status?.allocatable?.[GPU_RESOURCE] || '0', 10), 0);
      facts.draClassExists = deviceClasses.some((d: any) => d.metadata.name === GPU_DEVICE_CLASS);
      facts.computeDomainAvailable = !!this.$store.getters['cluster/schemaFor'](TYPES.COMPUTE_DOMAIN) && deviceClasses.some((d: any) => d.metadata.name === CD_CHANNEL_DEVICE_CLASS);
      // allocated GPU devices: every ResourceClaim whose allocation results name the GPU driver
      const allocByNs: Record<string, number> = {};

      claims.forEach((c: any) => {
        const n = (c.status?.allocation?.devices?.results || []).filter((r: any) => r.driver === GPU_DEVICE_CLASS).length;

        if (n) {
          allocByNs[c.metadata.namespace] = (allocByNs[c.metadata.namespace] || 0) + n;
        }
      });
      facts.draAllocated = Object.values(allocByNs).reduce((a, b) => a + b, 0);
      facts.draAllocatedBy = Object.keys(allocByNs).sort();
      facts.gpuTypes = gpuInventory(slices, claims, nodes);
      facts.sharedGpus = sharedGpus(claims, pods, slices);
      facts.gfdLabels = hasGfdLabels(nodes);
      facts.gpuNodeMemoryMiB = Math.max(0, ...nodes.map((n: any) => parseInt(n.metadata?.labels?.['nvidia.com/gpu.memory'] || '0', 10) || 0));
      facts.gpuDeviceMemory = Math.max(0, ...slices.filter((s: any) => s.spec?.driver === GPU_DEVICE_CLASS)
        .flatMap((s: any) => (s.spec?.devices || []).map((d: any) => parseMem(d.capacity?.memory?.value) || 0)));
      facts.draDevices = slices.filter((s: any) => s.spec?.driver === GPU_DEVICE_CLASS).reduce((sum: number, s: any) => sum + (s.spec?.devices?.length || 0), 0);
      // GPU nodes + remaining schedulable CPU/memory (allocatable minus requests of non-terminal pods)
      const gpuNodeNames = new Set<string>();

      nodes.forEach((n: any) => {
        if (parseInt(n.status?.allocatable?.[GPU_RESOURCE] || '0', 10) > 0) {
          gpuNodeNames.add(n.metadata.name);
        }
      });
      slices.filter((s: any) => s.spec?.driver === GPU_DEVICE_CLASS && s.spec?.nodeName).forEach((s: any) => gpuNodeNames.add(s.spec.nodeName));
      facts.gpuNodes = nodes.filter((n: any) => gpuNodeNames.has(n.metadata.name)).map((n: any): GpuNode => {
        let cpuUsed = 0; let memUsed = 0; let ephUsed = 0;

        pods.filter((p: any) => p.spec?.nodeName === n.metadata.name && !['Succeeded', 'Failed'].includes(p.status?.phase)).forEach((p: any) => {
          // same rule the scheduler uses: sum(containers) + sum(sidecar inits with restartPolicy Always), at least max(regular init)
          let pc = 0; let pm = 0; let ic = 0; let im = 0;

          (p.spec?.containers || []).forEach((c: any) => {
            pc += parseCpu(c.resources?.requests?.cpu); pm += parseMem(c.resources?.requests?.memory) || 0;
            ephUsed += parseMem(c.resources?.requests?.['ephemeral-storage']) || 0;
          });
          (p.spec?.initContainers || []).forEach((c: any) => {
            const cc = parseCpu(c.resources?.requests?.cpu); const cm = parseMem(c.resources?.requests?.memory) || 0;

            if (c.restartPolicy === 'Always') {
              pc += cc; pm += cm;
            } else {
              ic = Math.max(ic, cc); im = Math.max(im, cm);
            }
          });
          cpuUsed += Math.max(pc, ic); memUsed += Math.max(pm, im);
        });
        const gpus = parseInt(n.status?.allocatable?.[GPU_RESOURCE] || '0', 10) || slices.filter((s: any) => s.spec?.nodeName === n.metadata.name && s.spec?.driver === GPU_DEVICE_CLASS).reduce((a: number, s: any) => a + (s.spec?.devices?.length || 0), 0);

        return {
          name:          n.metadata.name,
          gpus,
          cpuFree:       Math.max(0, parseCpu(n.status?.allocatable?.cpu) - cpuUsed),
          memFree:       Math.max(0, parseMem(n.status?.allocatable?.memory) - memUsed),
          diskPressure:  (n.status?.conditions || []).some((c: any) => c.type === 'DiskPressure' && c.status === 'True'),
          ephemeralFree:  Math.max(0, (parseMem(n.status?.allocatable?.['ephemeral-storage']) || 0) - ephUsed),
          ephemeralTotal: parseMem(n.status?.allocatable?.['ephemeral-storage']) || 0,
          images:        (n.status?.images || []).flatMap((i: any) => i.names || []),
        };
      });
      facts.configMaps = this.configMapsFor(this.form.namespace);
      facts.configMapCode = this.configMapCodeFor(this.form.namespace);
      facts.secrets = this.secretsFor(this.form.namespace);
      facts.pvcs = this.pvcsFor(this.form.namespace);
      // The default is an annotation, and both spellings are still in the wild: the beta one is
      // what older clusters (and some CSI charts) still write.
      facts.storageClasses = storageClasses.map((c: any): StorageClassInfo => ({
        name:        c.metadata.name,
        provisioner: c.provisioner || '',
        isDefault:   ['storageclass.kubernetes.io/is-default-class', 'storageclass.beta.kubernetes.io/is-default-class']
          .some((k) => c.metadata?.annotations?.[k] === 'true'),
        bindingMode: c.volumeBindingMode || 'Immediate',
      })).sort((a: StorageClassInfo, b: StorageClassInfo) => a.name.localeCompare(b.name));
      // A PyTorchJob and a Job cannot share a name in one namespace either: the release name is
      // what collides, so both kinds feed the same collision check.
      facts.existingJobs = [...jobs, ...pytorchJobs].map((j: any) => ({ name: j.metadata.name, namespace: j.metadata.namespace }));
      facts.localQueues = localQueues.map((q: any) => ({
        name: q.metadata.name, namespace: q.metadata.namespace, clusterQueue: q.spec?.clusterQueue
      }));
      facts.clusterQueues = clusterQueues.map((c: any) => {
        // two independent Kueue pools that may both describe the same physical GPUs
        const byMode: { 'device-plugin'?: number | null; dra?: number | null } = {};
        const covered: string[] = [];

        for (const rg of c.spec?.resourceGroups || []) {
          covered.push(...(rg.coveredResources || []));
          for (const fl of rg.flavors || []) {
            for (const r of fl.resources || []) {
              if (r.name === GPU_RESOURCE) {
                byMode['device-plugin'] = (byMode['device-plugin'] || 0) + parseInt(r.nominalQuota, 10);
              } else if (r.name === 'gpu') {
                byMode.dra = (byMode.dra || 0) + parseInt(r.nominalQuota, 10);
              }
            }
          }
        }

        return {
          name: c.metadata.name, gpuQuotaByMode: byMode, covered
        };
      });
      facts.kaiQueues = kaiQueues.map((q: any) => ({ name: q.metadata.name, gpuQuota: q.spec?.resources?.gpu?.quota ?? null }));

      // Queue hierarchy + live usage. Run:AI leaves Queue.status empty in practice, so usage is
      // backfilled from pod requests for any queue the scheduler has not reported on.
      const nsQueue = namespaceQueueMap(namespaces);
      let queueIndex = buildQueueIndex(kaiQueues);
      const usage = usageFromPods(pods, nsQueue, queueIndex);

      queueIndex = withPodUsage(queueIndex, usage);
      facts.queueIndex = queueIndex;
      facts.capacity = clusterCapacity({
        nodes:           nodes.map((n: any) => ({ allocatable: n.status?.allocatable, unschedulable: n.spec?.unschedulable })),
        gpuInUse:        usage.total,
        gpuResourceName: GPU_RESOURCE,
      });
      this.namespaceQueues = nsQueue;
      facts.namespaceQueue = nsQueue[this.form.namespace] || null;
      facts.loaded = true;

      this.facts = facts;
      if (this.form.gpuShareMiB > 0) {
        this.form.gpuSharedClaim = placesGpuMemoryShares(this.form.scheduler) ? '' : pickSharedClaim(this.form, facts);
      }

      if (!this.form.namespace) {
        // prefer a namespace that already belongs to an AI project (it carries the GPU quota),
        // then one that owns a Kueue LocalQueue, then whatever is visible
        const aiNs = facts.namespaces.find((n) => !!nsQueue[n]);
        const withQueue = facts.localQueues.find((q) => facts.namespaces.includes(q.namespace || ''));

        this.form.namespace = aiNs || withQueue?.namespace || facts.namespaces[0] || '';
        facts.namespaceQueue = nsQueue[this.form.namespace] || null;
      }
      if (!this.form.releaseName) {
        this.form.releaseName = `train-${ Math.random().toString(36).slice(2, 7) }`;
      }
      if (this.form.scheduler === 'kueue' && facts.kaiInstalled && facts.namespaceQueue) {
        // the project is bound to a KAI queue: it, not a Kueue LocalQueue, schedules this namespace
        this.form.scheduler = facts.runaiInstalled ? 'runai' : 'kai';
        this.$nextTick(() => {
          this.form.queue = facts.namespaceQueue || '';
        });
      } else if (this.form.scheduler === 'none') {
        // Prefer the queueing scheduler that actually has a queue reachable from this namespace.
        const queueSched = facts.runaiInstalled ? 'runai' : 'kai';

        if (facts.kaiInstalled && facts.namespaceQueue) {
          this.form.scheduler = queueSched;
          this.form.queue = facts.namespaceQueue;
        } else if (facts.kueueInstalled && this.queueOptionsFor('kueue').length) {
          this.form.scheduler = 'kueue';
        } else if (facts.kaiInstalled && Object.keys(facts.queueIndex).length) {
          this.form.scheduler = queueSched;
        }
      }
      this.refreshAiProject();
    },

    useSuggestedScratch() {
      this.form.scratchSize = `${ this.scratchEstimate.totalGiB }Gi`;
    },
    queueOptionsFor(type: string) {
      if (type === 'kueue') {
        return this.facts.localQueues.filter((q) => q.namespace === this.form.namespace);
      }

      return this.facts.kaiQueues;
    },

    severityIcon(s: string) {
      return {
        pass: 'icon-checkmark text-success', fail: 'icon-x text-error', warn: 'icon-warning text-warning', info: 'icon-info text-info'
      }[s] || 'icon-info';
    },

    /**
     * Refill the YAML tabs from the current form. Called when entering YAML mode and by the
     * Regenerate button; the guard keeps an edited buffer from being wiped by a tab switch.
     */
    syncYamlFromForm(force = false) {
      if (force || !this.valuesEdited) {
        this.valuesYaml = saferDump(this.chartValues);
        this.valuesEdited = false;
      }
      if (force || !this.manifestYaml.trim()) {
        this.manifestYaml = this.manifestSkeleton;
      }
      this.yamlNonce++;
    },

    setEntryMode(mode: 'form' | 'yaml') {
      this.entryMode = mode;
      if (mode === 'yaml') {
        this.syncYamlFromForm();
      }
    },

    onValuesInput(v: string) {
      this.valuesYaml = v;
      this.valuesEdited = true;
    },

    /**
     * Read the values YAML back into the form — the reverse of syncYamlFromForm.
     *
     * The form cannot hold everything the chart accepts, so this names what it could not place
     * rather than dropping it quietly, and leaves the YAML buffer alone: the values tab stays the
     * thing that gets installed until Regenerate is pressed, so nothing is lost by looking.
     */
    applyYamlToForm() {
      if (this.yamlError) {
        return;
      }
      const values = this.yamlSource === 'values';
      const { form, unmapped } = values ? formFromValues(this.parsedValues.doc, this.form) : formFromManifest(this.parsedManifest.docs, this.form);
      // A manifest describes objects the chart does not produce one-for-one. Filling the form from
      // one is therefore a starting point, not a conversion, and the wording says which rather than
      // leaving "Form updated" to imply the two now produce the same object.
      const noun = values ? 'value' : 'thing';

      this.form = form;
      this.formFillUnmapped = unmapped;
      this.formFillNotice = unmapped.length ? `Form updated. ${ unmapped.length } ${ noun }(s) have no field in the form and stay only in the YAML: ${ unmapped.join(', ') }. Submitting from the Form tab would drop them.` : `Form updated from the YAML. Every ${ noun } mapped to a field.`;
    },

    async submit(done: (ok: boolean) => void) {
      this.error = '';
      if (this.submitDisabled) {
        done(false);

        return;
      }
      try {
        if (this.projectName) {
          // Recorded on local in the AI project's namespace. In a pool the operator runs it there;
          // without one the placement controller chooses the pool.
          await createAIJob(this.$store, aiJobFor({
            name:            this.form.releaseName,
            namespace:       projectNamespace(this.projectName),
            pool:            this.poolName || undefined,
            targetNamespace: this.poolName ? this.form.namespace : undefined,
            source:          this.facts.chart,
            values:          this.effectiveValues,
            reclaim:         this.reclaim,
          }));
        } else {
          await this.$store.dispatch('cluster/create', aiJobFor({
            name: this.form.releaseName, namespace: this.form.namespace, source: this.facts.chart, values: this.effectiveValues
          })).then((job: any) => job.save());
        }
        this.submitted = true;
        done(true);
        setTimeout(() => {
          this.$router.push({
            name: `c-cluster-${ PRODUCT_NAME }-${ ENDPOINTS_PAGE }`, params: { cluster: this.projectName ? LOCAL_CLUSTER : this.$route.params.cluster }, query: { tab: 'training' }
          });
        }, 1200);
      } catch (e: any) {
        this.error = e?.message || String(e);
        done(false);
      }
    },
  },
});
</script>

<template>
  <Loading v-if="$fetchState.pending" />
  <div
    v-else
    class="tj-submit"
  >
    <div class="tj-header">
      <h1 v-if="profileMode">
        {{ editingProfile ? `Edit profile ${ editingProfile.displayName }` : 'Create a profile' }}
        <StatusPill
          v-if="editingProfile && editingProfile.status === 'beta'"
          status="beta"
          size="lg"
        />
      </h1>
      <h1 v-else>
        {{ t('trainingjobs.submit.title') }}
      </h1>
      <p class="text-muted">
        {{ profileMode ? t('trainingjobs.submit.profileSubtitle') : t('trainingjobs.submit.subtitle') }}
      </p>
    </div>

    <Banner
      v-if="error"
      color="error"
      :label="error"
    />
    <Banner
      v-if="submitted"
      color="success"
      :label="`Submitted job ${form.releaseName}. Redirecting to Jobs…`"
    />

    <div
      v-if="!profileMode && pools.length"
      class="tj-pool"
    >
      <LabeledSelect
        :value="projectName"
        :options="projectOptions"
        label="AI project"
        placeholder="Choose the project this run belongs to"
        @update:value="chooseProject"
      />
      <LabeledSelect
        v-if="projectName"
        :value="poolName"
        :options="poolOptions"
        label="Compute pool"
        @update:value="choosePool"
      />
      <div
        v-if="projectName && !poolName"
        class="tj-reclaim-row"
      >
        <LabeledSelect
          v-model:value="reclaim.policy"
          :options="reclaimOptions"
          label="When idle"
          tooltip="In a pool that reclaims idle runs: what happens to this run once it has been idle past its timeout and another run is waiting for the pool."
        />
        <LabeledInput
          v-model:value="reclaim.idleTimeout"
          label="Idle timeout"
          placeholder="the pool's"
          :sub-label="reclaimTimeoutError || 'A number and m, h or d, up to the pool\'s ceiling'"
          :status="reclaimTimeoutError ? 'error' : null"
        />
      </div>
      <Banner
        v-if="!projects.length"
        color="info"
        label="There is no AI project yet. An administrator creates one on the Projects page."
      />
    </div>

    <!-- The operator installs the training chart built into it. A chart of your own is an escape
         hatch, kept out of the way: it must take the same values, and an administrator has to
         allow it (operator manager.aijobAllowedCharts). -->
    <details class="tj-custom-chart">
      <summary>Advanced: custom job chart</summary>
      <Checkbox
        v-model:value="customChart.enabled"
        label="Install a chart from a repository instead of the one built into AI Factory"
        @update:value="onCustomChart"
      />
      <div
        v-if="customChart.enabled"
        class="row mt-10"
      >
        <div class="col span-4">
          <LabeledInput
            v-model:value="customChart.repoName"
            label="ClusterRepo"
            @update:value="onCustomChart"
          />
        </div>
        <div class="col span-4">
          <LabeledInput
            v-model:value="customChart.chartName"
            label="Chart"
            @update:value="onCustomChart"
          />
        </div>
        <div class="col span-4">
          <LabeledInput
            v-model:value="customChart.version"
            label="Version"
            @update:value="onCustomChart"
          />
        </div>
      </div>
    </details>

    <!-- Profile mode: a wizard (Configure, Profile, Pre-flight); Form/YAML belongs to Configure. -->
    <div
      v-if="profileMode"
      class="tj-steps"
    >
      <button
        v-for="(s, i) in wizardSteps"
        :key="s.key"
        :class="['tj-step', { active: wizardStep === s.key, done: i < wizardIndex }]"
        @click="wizardStep = s.key"
      >
        <span class="tj-step-n">{{ i + 1 }}</span> {{ s.label }}
        <span
          v-if="stepBadge[s.key]"
          :class="['tj-step-badge', { error: s.key !== 'preflight' }]"
        >{{ stepBadge[s.key] }}</span>
      </button>
      <div
        v-if="wizardStep === 'configure'"
        class="tj-modes tj-modes-inline"
      >
        <button
          :class="['tj-mode', { active: entryMode === 'form' }]"
          @click="setEntryMode('form')"
        >
          Form
        </button>
        <button
          :class="['tj-mode', { active: entryMode === 'yaml' }]"
          @click="setEntryMode('yaml')"
        >
          YAML
        </button>
      </div>
    </div>

    <div
      v-else
      class="tj-modes"
    >
      <button
        :class="['tj-mode', { active: entryMode === 'form' }]"
        @click="setEntryMode('form')"
      >
        Form
      </button>
      <button
        :class="['tj-mode', { active: entryMode === 'yaml' }]"
        @click="setEntryMode('yaml')"
      >
        YAML
      </button>
    </div>

    <div :class="['tj-grid', { 'tj-grid-wizard': profileMode }]">
      <!-- ================= form ================= -->
      <section
        v-show="entryMode === 'form' && (!profileMode || wizardStep === 'configure')"
        class="tj-form"
      >
        <Tabbed
          :default-tab="defaultSubmitTab"
          :side-tabs="true"
          class="tj-tabs"
        >
          <Tab
            name="job"
            label="Job"
            :weight="6"
            :error="!!sectionFails.job"
          >
            <TabProblems :checks="sectionChecks.job" />
            <div class="row">
              <div class="col span-6">
                <LabeledSelect
                  v-model:value="form.namespace"
                  :label="profileMode ? 'Namespace (pre-flight only; users deploy into their own project)' : 'Namespace'"
                  :options="namespaceOptions"
                  :searchable="true"
                />
              </div>
              <div class="col span-6">
                <!-- A profile does not name runs: the user does, when they deploy it. -->
                <LabeledInput
                  v-if="profileMode"
                  :value="profilePrefix ? `${ profilePrefix }-… (rest set by the user at deploy time)` : 'Set by the user at deploy time'"
                  label="Job name"
                  tooltip="Profiles do not fix the run name. Set an optional prefix on the Profile step."
                  :disabled="true"
                />
                <LabeledInput
                  v-else
                  v-model:value="form.releaseName"
                  label="Job name"
                  placeholder="lowercase-dashes"
                />
              </div>
            </div>
            <div class="row">
              <div class="col span-8">
                <LabeledInput
                  v-model:value="form.image"
                  label="Container image"
                />
              </div>
              <div class="col span-4">
                <LabeledInput
                  v-model:value="form.tag"
                  label="Tag"
                />
              </div>
            </div>
            <div class="row">
              <div class="col span-6">
                <LabeledInput
                  v-model:value="form.pullSecret"
                  label="Image pull secret (optional)"
                  placeholder="e.g. suse-ai-pull-combined"
                  tooltip="A Secret in the namespace to pull the image with. Empty = the namespace default ServiceAccount's; AI Factory adds suse-ai-pull-combined there in the namespaces it deploys into."
                />
              </div>
            </div>
            <div class="row">
              <div class="col span-6">
                <LabeledSelect
                  v-model:value="form.kind"
                  label="Workload kind"
                  :options="kindOptions"
                />
              </div>
              <div class="col span-6">
                <LabeledSelect
                  v-model:value="form.mode"
                  label="Run mode"
                  :options="modeOptions"
                />
              </div>
            </div>
            <p
              v-if="form.kind === 'pytorchjob'"
              class="text-muted tj-hint"
            >
              The Training Operator owns rank assignment and rendezvous, so RANK / WORLD_SIZE / MASTER_ADDR come from it rather than from the chart.
            </p>
            <div
              v-if="form.mode === 'torchrun' && !form.configMap"
              class="row"
            >
              <div class="col span-12">
                <LabeledInput
                  v-model:value="form.script"
                  type="multiline"
                  label="Training script (train.py)"
                  tooltip="Written to a ConfigMap and run by torchrun on every rank. Leave it empty for the chart's built-in all-reduce demo, which proves the fabric without needing your code."
                  placeholder="# leave empty for the built-in all-reduce demo"
                  :min-height="340"
                />
              </div>
            </div>
            <Banner
              v-if="form.mode === 'torchrun' && form.configMap"
              color="info"
              :label="`torchrun runs train.py from ConfigMap ${form.configMap}, mounted at /mnt/config; the inline script is ignored. Parameters go in Environment variables — torchrun mode passes no arguments.`"
            />
            <div
              v-if="form.mode === 'custom'"
              class="row"
            >
              <div class="col span-8">
                <LabeledInput
                  v-model:value="form.command"
                  label="Command"
                  placeholder="python /mnt/config/train.py"
                />
              </div>
              <div class="col span-4">
                <LabeledInput
                  v-model:value="form.args"
                  label="Arguments"
                  placeholder="--epochs 5"
                />
              </div>
            </div>
            <div
              v-if="form.mode !== 'smoke'"
              class="row"
            >
              <div class="col span-12">
                <KeyValue
                  v-model:value="form.env"
                  :as-map="true"
                  mode="edit"
                  title="Environment variables"
                  :read-allowed="false"
                  add-label="Add variable"
                />
              </div>
            </div>
          </Tab>

          <Tab
            name="gpu"
            label="GPU & resources"
            :tooltip="`${ totalGpus } GPU`"
            :weight="5"
            :error="!!sectionFails.gpu"
          >
            <TabProblems :checks="sectionChecks.gpu" />
            <div class="row">
              <div class="col span-4">
                <LabeledInput
                  v-model:value.number="form.nodes"
                  type="number"
                  min="1"
                  label="Nodes"
                />
              </div>
              <div class="col span-4">
                <LabeledInput
                  v-model:value.number="form.gpusPerNode"
                  type="number"
                  min="1"
                  label="GPUs per node"
                  :disabled="form.gpuShareMiB > 0"
                  :tooltip="form.gpuShareMiB > 0 ? 'A shared GPU gives each pod part of one GPU, so this is 1. Choose exclusive allocation for more.' : undefined"
                />
              </div>
              <div class="col span-4">
                <LabeledInput
                  v-if="kaiShare"
                  value="Not used: KAI GPU-memory share"
                  label="GPU request mode"
                  tooltip="A KAI share asks for GPU memory (gpu-memory annotation), not a whole nvidia.com/gpu or a DRA claim, so the request mode does not apply."
                  :disabled="true"
                />
                <LabeledSelect
                  v-else
                  v-model:value="form.gpuMode"
                  label="GPU request mode"
                  :options="gpuModeOptions"
                />
              </div>
            </div>
            <div class="row">
              <div class="col span-8">
                <LabeledSelect
                  v-model:value="gpuAllocation"
                  label="GPU allocation"
                  tooltip="Exclusive: the run gets whole GPUs. Shared: each pod gets part of one GPU, capped at the GPU memory below, beside other workloads. Under KAI the run waits in its queue until that much is free; under DRA it attaches to the project's shared GPU (an MPS ResourceClaim)."
                  :options="gpuAllocationOptions"
                />
              </div>
              <div
                v-if="form.gpuShareMiB > 0"
                class="col span-4"
              >
                <LabeledInput
                  v-model:value.number="gpuShareGiB"
                  type="number"
                  label="GPU memory per pod (GiB)"
                  tooltip="A hard cap: the run cannot allocate more (HAMi-core or NvFractions under KAI, MPS on a DRA shared claim)."
                />
              </div>
            </div>
            <div class="row">
              <div class="col span-8">
                <LabeledSelect
                  v-model:value="form.gpuProduct"
                  label="GPU type"
                  tooltip="The GPU model the run must get. Under DRA a device selector on the claim; under the device plugin a node selector on nvidia.com/gpu.product (GPU Feature Discovery)."
                  :options="gpuTypeOptions"
                />
              </div>
            </div>
            <div
              v-if="resolvedGpuMode === 'dra'"
              class="row"
            >
              <div class="col span-12">
                <Checkbox
                  v-model:value="form.computeDomain"
                  label="Multi-node NVLink domain (ComputeDomain / IMEX)"
                  :disabled="!facts.computeDomainAvailable"
                  :tooltip="facts.computeDomainAvailable ? 'For systems whose NVLink fabric spans nodes (rack-scale NVL systems). Creates a ComputeDomain sized to Nodes; each pod gets a GPU claim and an IMEX channel claim.' : 'ComputeDomain CRD / channel DeviceClass not present on this cluster'"
                />
              </div>
            </div>
            <div class="row">
              <div class="col span-4">
                <LabeledInput
                  v-model:value="form.cpuRequest"
                  label="CPU (per pod)"
                  placeholder="500m"
                  tooltip="CPU request for each pod, in cores or millicores."
                />
              </div>
              <div class="col span-4">
                <LabeledInput
                  v-model:value="form.memRequest"
                  label="Memory (per pod)"
                  placeholder="1Gi"
                  tooltip="Memory request for each pod."
                />
              </div>
              <div class="col span-4">
                <LabeledInput
                  v-model:value="form.ephemeralRequest"
                  label="Ephemeral storage"
                  placeholder="2Gi"
                  tooltip="Ephemeral storage request for each pod, for scratch files outside any volume."
                />
              </div>
            </div>
            <p
              v-if="kaiShare"
              class="text-muted tj-hint"
            >
              This run: <b>{{ gpuShareGiB }} GiB of one GPU</b> per pod{{ shareFraction ? ` (${ shareFraction } GPU each, ${ Math.round(shareFraction * form.nodes * 100) / 100 } charged to queue ${ form.queue || '?' })` : '' }}, queued by KAI until it fits · cluster: {{ facts.devicePluginGpus }} GPU(s){{ facts.gpuNodeMemoryMiB ? ` of ${ Math.round(facts.gpuNodeMemoryMiB / 1024) } GiB` : '' }} via device plugin · GPU nodes: {{ facts.gpuNodes.map(n => n.name + (facts.podsReadable ? ' (' + n.cpuFree.toFixed(1) + ' CPU free)' : '')).join(', ') || 'none' }}
            </p>
            <p
              v-else
              class="text-muted tj-hint"
            >
              Total GPUs: <b>{{ totalGpus }}</b> · cluster: {{ facts.devicePluginGpus }} via device plugin, {{ facts.draDevices }} via DRA · GPU nodes: {{ facts.gpuNodes.map(n => n.name + (facts.podsReadable ? ' (' + n.cpuFree.toFixed(1) + ' CPU free)' : '')).join(', ') || 'none' }}
            </p>
          </Tab>

          <Tab
            name="storage"
            label="Storage"
            :tooltip="storageSummary ? `${ storageInfo ? storageInfo + ' — ' : '' }${ storageSummary }` : storageInfo"
            :weight="4"
            :error="!!sectionFails.storage"
          >
            <TabProblems :checks="sectionChecks.storage" />
            <!-- Three lifecycles: the dataset usually exists before the run (pick it); checkpoints are
                 made by the run and outlive it (a new volume from a StorageClass, or an existing one);
                 scratch lives and dies with the pod (on the node's disk, or a volume from a class). -->
            <h3>Dataset</h3>
            <div class="row">
              <div class="col span-6">
                <LabeledSelect
                  v-model:value="form.datasetPVC"
                  label="Existing PVC"
                  tooltip="An existing claim, mounted read-only and exported as $DATASET_DIR. For a multi-node run it must be ReadWriteMany."
                  :options="pvcOptions"
                  :searchable="true"
                />
                <p class="text-muted tj-hint">
                  {{ form.datasetPVC ? 'Mounted read-only at /mnt/dataset ($DATASET_DIR)' : 'None: the run brings or downloads its own data' }}
                </p>
              </div>
            </div>

            <h3>Checkpoints / output</h3>
            <RadioGroup
              v-model:value="form.checkpointMode"
              name="checkpointMode"
              :options="['none', 'create', 'existing']"
              :labels="['None', 'Create a volume for this run', 'Existing PVC']"
              :row="true"
            />
            <div
              v-if="form.checkpointMode === 'create'"
              class="row tj-storage-row"
            >
              <div class="col span-4">
                <LabeledSelect
                  v-model:value="form.checkpointStorageClass"
                  label="Storage class"
                  :options="storageClassOptions"
                />
              </div>
              <div class="col span-3">
                <LabeledInput
                  v-model:value="form.checkpointSize"
                  label="Size"
                  placeholder="20Gi"
                />
              </div>
              <div class="col span-5 tj-checkbox">
                <Checkbox
                  v-model:value="form.checkpointKeep"
                  label="Keep after the run"
                  tooltip="Kept: the volume survives the run and its cleanup, so outputs stay (delete it by hand). Off: it is deleted with the run."
                />
              </div>
            </div>
            <div
              v-else-if="form.checkpointMode === 'existing'"
              class="row tj-storage-row"
            >
              <div class="col span-6">
                <LabeledSelect
                  v-model:value="form.checkpointPVC"
                  label="Existing PVC"
                  :options="[{ label: '(none)', value: '' }, ...checkpointVolumeOptions]"
                  :searchable="true"
                />
              </div>
            </div>
            <p
              v-if="form.checkpointMode !== 'none'"
              class="text-muted tj-hint"
            >
              Mounted read-write at /mnt/checkpoints ($CHECKPOINT_DIR)<template v-if="form.checkpointMode === 'create'">
                as {{ form.releaseName || '<run>' }}-checkpoints, provisioned when the run starts<template v-if="form.nodes > 1">
                  (ReadWriteMany: {{ form.nodes }} pods write to it)
                </template>
              </template>.
            </p>

            <h3>Scratch</h3>
            <RadioGroup
              v-model:value="scratchMode"
              name="scratchMode"
              :options="['none', 'node', 'volume']"
              :labels="['None', 'Node-local (node disk)', 'Persistent volume']"
              :row="true"
            />
            <div
              v-if="scratchMode !== 'none'"
              class="row tj-storage-row"
            >
              <div
                v-if="scratchMode === 'volume'"
                class="col span-4"
              >
                <LabeledSelect
                  v-model:value="form.scratchStorageClass"
                  label="Storage class"
                  :options="storageClassOptions"
                />
              </div>
              <div class="col span-3">
                <LabeledInput
                  v-model:value="form.scratchSize"
                  label="Size per pod"
                  placeholder="e.g. 20Gi"
                />
              </div>
            </div>
            <p class="text-muted tj-hint">
              <template v-if="scratchMode === 'none'">
                None: files written inside the container land in its writable layer on the node's disk.
              </template>
              <template v-else-if="scratchMode === 'node'">
                An emptyDir on the node's disk at /scratch ($SCRATCH_DIR): fast and simple, deleted with the pod.
              </template>
              <template v-else>
                A volume from the storage class at /scratch ($SCRATCH_DIR), created with each pod and deleted with it.
              </template>
            </p>
            <template v-if="form.mode !== 'smoke'">
              <h3>Scratch sizing (per pod)</h3>
              <div class="row">
                <div class="col span-3">
                  <LabeledInput
                    v-model:value.number="form.modelParamsB"
                    type="number"
                    min="0"
                    step="0.1"
                    label="Model size (B params)"
                  />
                </div>
                <div class="col span-3">
                  <LabeledSelect
                    v-model:value="form.weightsSource"
                    label="Weights come from"
                    :options="[{label:'mounted PVC / image', value:'mounted'},{label:'downloaded into the pod', value:'download'}]"
                  />
                </div>
                <div class="col span-3">
                  <LabeledSelect
                    v-model:value="form.datasetSource"
                    label="Dataset is"
                    :options="[{label:'streamed (PVC / S3)', value:'streamed'},{label:'cached locally', value:'local'}]"
                  />
                </div>
                <div
                  v-if="form.datasetSource === 'local'"
                  class="col span-3"
                >
                  <LabeledInput
                    v-model:value.number="form.datasetCacheGB"
                    type="number"
                    min="0"
                    label="Local dataset copy (GB)"
                  />
                </div>
              </div>
              <div class="row">
                <div class="col span-3">
                  <LabeledSelect
                    v-model:value="form.checkpointTarget"
                    label="Checkpoints go to"
                    :options="[{label:'checkpoint PVC (durable)', value:'pvc'},{label:'scratch (lost with the pod)', value:'scratch'}]"
                  />
                </div>
                <div
                  v-if="form.checkpointTarget === 'scratch'"
                  class="col span-3"
                >
                  <LabeledInput
                    v-model:value.number="form.checkpointCopies"
                    type="number"
                    min="1"
                    label="Copies kept"
                  />
                </div>
              </div>
              <p class="text-muted tj-hint">
                Estimate: <b>{{ scratchEstimate.totalGiB }} Gi</b>
                <button
                  class="btn role-tertiary btn-sm"
                  @click="useSuggestedScratch()"
                >
                  Use estimate
                </button>
                <span class="tj-est">{{ scratchEstimate.lines.map(l => l.label.split(' (')[0] + ' ' + l.gib.toFixed(0) + ' Gi').join(' · ') }}</span>
              </p>
            </template>
            <div
              v-if="form.mode !== 'smoke'"
              class="row"
            >
              <div class="col span-6">
                <LabeledSelect
                  v-model:value="form.configMap"
                  label="ConfigMap"
                  tooltip="Existing ConfigMap, mounted read-only at /mnt/config. Use it for hyper-parameters or code the image does not carry."
                  :options="['', ...facts.configMaps]"
                  :searchable="true"
                />
              </div>
            </div>
            <div class="row">
              <div class="col span-6">
                <LabeledSelect
                  v-model:value="form.secretName"
                  label="Mount a Secret"
                  tooltip="Existing Secret in this namespace, mounted read-only. Each key becomes a file — an .s3cfg for s3cmd, a Hugging Face token. Service-account tokens and Helm release data are not listed."
                  :options="secretOptions"
                  :searchable="true"
                />
              </div>
              <div
                v-if="form.secretName"
                class="col span-6"
              >
                <LabeledInput
                  v-model:value="form.secretMountPath"
                  label="Secret mount path"
                  placeholder="/secrets"
                />
              </div>
            </div>
          </Tab>

          <Tab
            name="scheduling"
            label="Scheduling"
            :tooltip="schedulingSummary"
            :weight="3"
            :error="!!sectionFails.scheduling"
          >
            <TabProblems :checks="sectionChecks.scheduling" />
            <div class="row">
              <div class="col span-6">
                <LabeledSelect
                  v-model:value="form.scheduler"
                  label="Scheduler"
                  :options="schedulerOptions"
                />
              </div>
              <div
                v-if="form.scheduler !== 'none'"
                class="col span-6"
              >
                <LabeledSelect
                  v-model:value="form.queue"
                  label="Queue"
                  :options="queueOptions"
                  :taggable="true"
                  :searchable="true"
                />
              </div>
            </div>
            <div
              v-if="isQueueSched"
              class="row"
            >
              <div class="col span-6">
                <LabeledInput
                  v-model:value="form.priorityClassName"
                  label="Priority class"
                  placeholder="train / build / inference"
                />
              </div>
            </div>
          </Tab>

          <!-- Not torchrun-only: a custom launcher still needs the secondary network and the NCCL
               interface, and only the smoke test has no distributed traffic at all. -->
          <Tab
            v-if="form.mode !== 'smoke'"
            name="network"
            label="Networking"
            :tooltip="networkSummary"
            :weight="2"
            :error="!!sectionFails.network"
          >
            <TabProblems :checks="sectionChecks.network" />
            <!-- A PyTorchJob rendezvouses through the operator's master Service, so these do nothing there. -->
            <p
              v-if="form.mode === 'custom'"
              class="text-muted tj-hint"
            >
              Custom command: your launcher owns rendezvous. Each pod still gets a stable DNS name <code>{{ form.releaseName || '<job>' }}-&lt;index&gt;.{{ form.releaseName || '<job>' }}.{{ form.namespace || '<ns>' }}.svc</code> and the env vars JOB_NAME, NNODES, NPROC_PER_NODE, JOB_COMPLETION_INDEX and RDZV_ENDPOINT (pod 0, port 29400) to build one.
            </p>
            <div
              v-if="form.kind === 'job' && form.mode === 'torchrun'"
              class="row"
            >
              <div class="col span-6">
                <LabeledSelect
                  v-model:value="form.rendezvous"
                  label="Rendezvous (torchrun launcher)"
                  :options="[{label:'c10d on rank 0', value:'c10d'},{label:'etcd (elastic)', value:'etcd-v2'}]"
                />
              </div>
              <div
                v-if="form.rendezvous === 'etcd-v2'"
                class="col span-6"
              >
                <LabeledInput
                  v-model:value="form.rendezvousEndpoint"
                  label="etcd endpoint (host:port)"
                />
              </div>
            </div>
            <div class="row">
              <div class="col span-6">
                <LabeledInput
                  v-model:value="form.multusNetwork"
                  label="Secondary network"
                  tooltip="Name of a NetworkAttachmentDefinition (Multus) to attach as net1, e.g. nccl-macvlan. Empty = pod network only."
                  placeholder="e.g. nccl-macvlan"
                />
              </div>
              <div class="col span-6">
                <LabeledInput
                  v-model:value="form.ncclSocketIfname"
                  label="NCCL_SOCKET_IFNAME"
                  tooltip="Interface NCCL binds to — net1 when a secondary network is attached. Empty lets NCCL choose, which usually means the pod network."
                  placeholder="net1"
                />
              </div>
            </div>
          </Tab>

          <Tab
            v-if="form.mode !== 'smoke'"
            name="fabric"
            label="RDMA fabric"
            :tooltip="fabricSummary ? `${ fabricInfo ? fabricInfo + ' — ' : '' }${ fabricSummary }` : fabricInfo"
            :weight="1"
            :error="!!sectionFails.fabric"
          >
            <TabProblems :checks="sectionChecks.fabric" />
            <div class="row">
              <div class="col span-6">
                <Checkbox
                  v-model:value="form.hostNetwork"
                  label="Host network"
                  tooltip="Pods share the node's network namespace and see its NICs. Costs the pod its own IP, and two runs on one node collide on ports."
                />
              </div>
              <div class="col span-6">
                <Checkbox
                  v-model:value="form.rdma"
                  label="RDMA / RoCE fabric"
                  tooltip="Mount /dev/infiniband, run the trainer privileged, and set NCCL_IB_DISABLE=0. Needs host network as well."
                />
              </div>
            </div>
            <div
              v-if="form.rdma"
              class="row"
            >
              <div class="col span-6">
                <LabeledInput
                  v-model:value="form.ncclIbHca"
                  label="NCCL_IB_HCA"
                  tooltip="HCA ports NCCL may use. List both rails to stripe across them; ibv_devinfo on the node names the devices."
                  placeholder="mlx5_0:1,mlx5_1:1"
                />
              </div>
              <div class="col span-6">
                <LabeledInput
                  v-model:value="form.ncclIbGidIndex"
                  label="NCCL_IB_GID_INDEX"
                  tooltip="RoCEv2 GID index, usually 3. show_gids on the node lists them."
                  placeholder="3"
                />
              </div>
            </div>
            <div
              v-if="form.rdma"
              class="row"
            >
              <div class="col span-12">
                <LabeledInput
                  v-model:value="form.rdmaHostLibPath"
                  label="Host RDMA library path"
                  tooltip="Node directory holding libibverbs / librdmacm / libmlx5, prepended to LD_LIBRARY_PATH. Leave empty for images that ship them (NGC PyTorch does); set it for a bare CUDA image, e.g. /usr/lib/aarch64-linux-gnu."
                  placeholder="empty unless the image lacks libibverbs"
                />
              </div>
            </div>
          </Tab>
        </Tabbed>
      </section>

      <!-- ================= yaml ================= -->
      <section
        v-if="entryMode === 'yaml' && (!profileMode || wizardStep === 'configure')"
        class="tj-form"
      >
        <div class="tj-yaml-head">
          <div class="tj-modes tj-modes-sub">
            <button
              :class="['tj-mode', { active: yamlSource === 'values' }]"
              @click="yamlSource = 'values'"
            >
              Helm values
            </button>
            <button
              :class="['tj-mode', { active: yamlSource === 'manifest' }]"
              @click="yamlSource = 'manifest'"
            >
              Kubernetes manifest
            </button>
          </div>
          <div class="tj-yaml-actions">
            <button
              class="btn role-tertiary btn-sm"
              :disabled="!!yamlError"
              :title="yamlSource === 'values' ? 'Read these values back into the Form tab' : 'Read this manifest back into the Form tab'"
              @click="applyYamlToForm()"
            >
              <i class="icon icon-upload" /> Apply to form
            </button>
            <button
              class="btn role-tertiary btn-sm"
              title="Discard edits and regenerate from the Form tab"
              @click="syncYamlFromForm(true)"
            >
              <i class="icon icon-refresh" /> Regenerate from form
            </button>
          </div>
        </div>
        <Banner
          v-if="formFillNotice"
          :color="formFillUnmapped.length ? 'warning' : 'success'"
          class="tj-fill-notice"
        >
          {{ formFillNotice }}
        </Banner>

        <template v-if="yamlSource === 'values'">
          <p class="text-muted tj-hint">
            Values for chart <code>{{ chartName }}</code>, generated from the Form tab. Editing them
            here overrides the form; everything else about the install is unchanged, so the run still
            appears on the Jobs page as a Helm release.
          </p>
          <Banner
            v-if="!facts.jobApi"
            color="error"
          >
            This cluster has no AI Factory job API, so these values cannot be installed from here.
            Submit training jobs from the cluster where AI Factory runs.
          </Banner>
          <YamlEditor
            :key="`values-${yamlNonce}`"
            :value="valuesYaml"
            editor-mode="EDIT_CODE"
            class="tj-editor"
            @onInput="onValuesInput"
          />
        </template>

        <template v-else>
          <p class="text-muted tj-hint">
            Import only. Paste a Job or PyTorchJob you already have (multiple documents are fine) and
            use <b>Apply to form</b>: the fields the form understands are read back, the rest are
            listed as unmapped. Nothing here is applied to the cluster directly — every run is
            installed from the chart, as you, so it is a Helm release the pre-flight has checked and
            the Jobs page can delete.
          </p>
          <Banner
            v-if="manifestNamespaces.length"
            color="info"
            :label="`Documents name their own namespace (${manifestNamespaces.join(', ')}); the form's namespace is what the run will use.`"
          />
          <YamlEditor
            :key="`manifest-${yamlNonce}`"
            :value="manifestYaml"
            editor-mode="EDIT_CODE"
            class="tj-editor"
            @onInput="(v) => manifestYaml = v"
          />
        </template>

        <Banner
          v-if="yamlError"
          color="error"
          :label="yamlError"
        />
      </section>

      <!-- ================= wizard: profile ================= -->
      <!-- v-show, not v-if: the panel holds what the admin typed, and must keep it between steps. -->
      <section
        v-if="profileMode && !$fetchState.pending"
        v-show="wizardStep === 'profile' || wizardStep === 'guardrails'"
        class="tj-wizard-panel"
      >
        <ProfilePanel
          ref="profilePanel"
          :key="editingProfile ? editingProfile.name : 'new'"
          :form="form"
          :chart-values="effectiveValues"
          :existing="editingProfile"
          :can-write="canWriteProfiles"
          :show-save="false"
          :section="wizardStep === 'guardrails' ? 'guardrails' : 'details'"
          :gpu-type-options="gpuTypeOptions"
          @gpu-product="form.gpuProduct = $event"
          @prefix="profilePrefix = $event"
          @errors="profileBlockers = $event"
          @saved="onProfileSaved"
        />
      </section>

      <!-- ================= wizard: pre-flight ================= -->
      <section
        v-if="profileMode && wizardStep === 'preflight'"
        class="tj-wizard-panel"
      >
        <div class="tj-preflight-head">
          <h2>Pre-flight</h2>
          <button
            class="btn role-tertiary btn-sm"
            @click="loadFacts()"
          >
            <i class="icon icon-refresh" /> Re-check
          </button>
        </div>
        <p class="text-muted">
          Whether this configuration runs in <b>{{ form.namespace || 'the selected namespace' }}</b> today.
          A failure here does not stop the profile being saved: users deploy it into their own projects.
        </p>
        <div
          v-for="g in preflightGroups"
          :key="g.key"
          class="tj-pf-group"
        >
          <h3>{{ g.label }}</h3>
          <ul class="tj-checks">
            <li
              v-for="c in g.checks"
              :key="c.id + c.severity + c.title"
              :class="['tj-check', c.severity]"
            >
              <i :class="['icon', severityIcon(c.severity)]" />
              <div>
                <div class="tj-check-title">
                  {{ c.title }}
                </div>
                <div
                  v-if="c.detail"
                  class="tj-check-detail text-muted"
                >
                  {{ c.detail }}
                </div>
              </div>
            </li>
          </ul>
        </div>
        <div class="tj-pf-group">
          <h3>Profile</h3>
          <ul class="tj-checks">
            <li
              v-if="!allBlockers.length"
              class="tj-check pass"
            >
              <i class="icon icon-checkmark text-success" />
              <div class="tj-check-title">
                Ready to save profile
              </div>
            </li>
            <li
              v-for="b in allBlockers"
              :key="b"
              class="tj-check fail"
            >
              <i class="icon icon-x text-error" />
              <div class="tj-check-title">
                {{ b }}
              </div>
            </li>
          </ul>
        </div>
      </section>

      <!-- ================= pre-flight (Submit) ================= -->
      <aside
        v-if="!profileMode"
        class="tj-preflight"
      >
        <div class="tj-preflight-head">
          <h2>{{ t('trainingjobs.submit.preflight') }}</h2>
          <button
            class="btn role-tertiary btn-sm"
            @click="loadFacts()"
          >
            <i class="icon icon-refresh" /> Re-check
          </button>
        </div>
        <ul class="tj-checks">
          <li
            v-for="c in checks"
            :key="c.id + c.severity + c.title"
            :class="['tj-check', c.severity]"
          >
            <i :class="['icon', severityIcon(c.severity)]" />
            <div>
              <div class="tj-check-title">
                {{ c.title }}
              </div>
              <div
                v-if="c.detail"
                class="tj-check-detail text-muted"
              >
                {{ c.detail }}
              </div>
            </div>
          </li>
        </ul>
        <Banner
          v-if="entryMode === 'yaml' && yamlSource === 'values'"
          color="info"
          label="Checks describe the Form tab. They cannot see your YAML edits, so they no longer gate submission."
        />
        <Banner
          v-if="entryMode === 'yaml' && yamlSource === 'manifest'"
          color="info"
          label="The manifest tab is import-only. Use Apply to form, then submit from the Form tab or the Helm values tab."
        />
        <div
          v-if="!profileMode"
          class="tj-actions"
        >
          <div class="text-muted tj-summary">
            <span v-if="summary.ok && summary.warns === 0">All checks passed.</span>
            <span v-else-if="summary.ok">{{ summary.warns }} warning(s), nothing blocking.</span>
            <span v-else>{{ summary.fails }} blocking issue(s).</span>
          </div>
          <AsyncButton
            mode="create"
            :disabled="submitDisabled"
            action-label="Submit job"
            waiting-label="Submitting…"
            success-label="Submitted"
            @click="submit"
          />
        </div>
        <details
          v-if="installsChart"
          class="tj-values"
        >
          <summary class="text-muted">
            Values that will be sent to Helm
          </summary>
          <pre>{{ JSON.stringify(effectiveValues, null, 2) }}</pre>
        </details>
      </aside>
    </div>

    <div
      v-if="profileMode"
      class="tj-wizard-foot"
    >
      <router-link
        :to="{ name: `c-cluster-${ productName }-${ profilesPage }`, params: { cluster: $route.params.cluster } }"
        class="btn role-secondary"
      >
        Cancel
      </router-link>
      <div class="tj-wizard-nav">
        <button
          class="btn role-secondary"
          :disabled="wizardIndex === 0"
          @click="wizardGo(-1)"
        >
          Back
        </button>
        <button
          v-if="wizardIndex < wizardSteps.length - 1"
          class="btn role-primary"
          @click="wizardGo(1)"
        >
          Next: {{ wizardSteps[wizardIndex + 1].label }} <i class="icon icon-chevron-right" />
        </button>
        <AsyncButton
          v-else
          mode="edit"
          :disabled="allBlockers.length > 0"
          action-label="Save profile"
          waiting-label="Saving…"
          success-label="Saved"
          @click="saveProfile"
        />
      </div>
    </div>
  </div>
</template>

<style lang="scss" scoped>
.tj-storage-row { margin-top: 8px; }
.tj-checkbox { display: flex; align-items: center; }

.tj-submit { padding: 0 20px 20px; }
.tj-header { margin-bottom: 10px; h1 { margin-bottom: 4px; } }
.tj-pool { max-width: 520px; margin-bottom: 12px; display: flex; flex-direction: column; gap: 8px; }
.tj-reclaim-row { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.tj-custom-chart { margin-bottom: 12px; summary { cursor: pointer; color: var(--muted); } }
.tj-grid { display: grid; grid-template-columns: minmax(0, 3fr) minmax(320px, 2fr); gap: 24px; align-items: start; }
@media (max-width: 1100px) { .tj-grid { grid-template-columns: 1fr; } }
// Profile mode: one column; each wizard step takes the full width.
.tj-grid.tj-grid-wizard { grid-template-columns: minmax(0, 1fr); }
.tj-steps { display: flex; align-items: flex-end; gap: 4px; border-bottom: 1px solid var(--border); margin-bottom: 16px; }
.tj-step { background: none; border: none; border-bottom: 2px solid transparent; padding: 10px 18px; cursor: pointer; color: var(--body-text); font-size: 14px; display: inline-flex; align-items: center; gap: 8px;
  &.active { border-bottom-color: var(--primary); color: var(--primary); font-weight: 600; }
  &.done .tj-step-n { background: var(--primary); color: var(--primary-text, #fff); } }
.tj-step-n { width: 22px; height: 22px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; font-size: 12px; border: 1px solid currentColor; }
.tj-step-badge { font-size: 11px; font-weight: 700; min-width: 18px; text-align: center; padding: 1px 7px; border-radius: 999px; line-height: 1.4;
  // solid, as the status pills: a pale tint is unreadable on the tab strip
  background: #f6c453; border: 1px solid #e0a92e; color: #3b2a00;
  &.error { background: #d64545; border-color: #b83737; color: #ffffff; } }
.tj-modes-inline { margin: 0 0 0 auto; border-bottom: none; }
.tj-wizard-panel { max-width: 1100px; }
.tj-pf-group { margin-top: 14px; h3 { font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); margin: 0 0 4px; } }
.tj-wizard-foot { display: flex; justify-content: space-between; align-items: center; margin-top: 18px; padding-top: 14px; border-top: 1px solid var(--border); }
.tj-wizard-nav { display: flex; gap: 8px; }
.tj-form h2, .tj-preflight h2 { font-size: 16px; margin: 18px 0 10px; }
.tj-form .row { margin-bottom: 10px; }
.tj-est { font-size: 12px; }
.tj-form h3 { font-size: 14px; margin: 12px 0 8px; }
.tj-hint { margin: -2px 0 8px; }
.tj-preflight { border: 1px solid var(--border); border-radius: var(--border-radius); padding: 12px 16px 16px; position: sticky; top: 10px; background: var(--body-bg); }
.tj-preflight-head { display: flex; justify-content: space-between; align-items: center; }
.tj-checks { list-style: none; margin: 0 0 12px; padding: 0; }
.tj-check { display: flex; gap: 10px; padding: 7px 0; border-bottom: 1px solid var(--border); align-items: flex-start; .icon { margin-top: 2px; font-size: 16px; } }
.tj-check:last-child { border-bottom: none; }
.tj-check-title { font-weight: 600; }
.tj-check-detail { font-size: 12px; }
.tj-actions { display: flex; justify-content: space-between; align-items: center; gap: 10px; }
.tj-values { margin-top: 12px; pre { font-size: 11px; max-height: 240px; overflow: auto; } }

.tj-modes { display: flex; gap: 4px; border-bottom: 1px solid var(--border); margin-bottom: 16px; }
.tj-modes-sub { margin-bottom: 0; border-bottom: none; }
.tj-mode {
  background: none; border: none; border-bottom: 2px solid transparent; cursor: pointer;
  padding: 8px 16px; color: var(--body-text); font-size: 14px;
  &.active { border-bottom-color: var(--primary); color: var(--primary); font-weight: 600; }
}
.tj-yaml-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; }
// CodeMirror collapses to nothing without an explicit height
.tj-editor { height: 60vh; min-height: 360px; }
.tj-yaml-actions { display: flex; gap: 8px; }
.tj-fill-notice { margin-bottom: 12px; }
</style>
