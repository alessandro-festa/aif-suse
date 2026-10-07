<script lang="ts">
import { defineComponent } from 'vue';
import Loading from '@shell/components/Loading.vue';
import Banner from '@components/Banner/Banner.vue';
import BadgeState from '@components/BadgeState/BadgeState.vue';
import LabeledInput from '@components/Form/LabeledInput/LabeledInput.vue';
import LabeledSelect from '@shell/components/form/LabeledSelect.vue';
import AsyncButton from '@shell/components/AsyncButton.vue';
import { CapacitySummary, ProjectUsage, capacitySummary, gpuModels } from '../capacity';
import {
  ENDPOINTS_PAGE, GPU_RESOURCE, PRODUCT_NAME, SUBMIT_PAGE, TYPES
} from '../config';
import { loadClusterLabel } from '../cluster';
import {
  ClusterCapacity, QueueIndex, QuotaIssue, auditQuotas, buildQueueIndex, clusterCapacity,
  namespaceQueueMap, usageFromPods, withPodUsage,
} from '../quota';
import {
  AiProject, RunaiProject, RunaiReadiness, applyQuotaToQueue, assembleProjects,
  buildNamespaceManifest, buildProjectBindingPatch, buildQueueManifest, buildRancherProjectManifest,
  committedGpuAfter, defaultNamespaceFor, projectIdFromSaveResult, projectSourceLabel,
  projectWarning, resolveCreatedProject, runaiProjectsFrom, runaiReadinessOf,
  shortProjectId, validateCap,
  validateProjectName, validateQuota,
} from '../projects';
import {
  QuotaBackend, RESOURCE_QUOTA_NAME, applyGpuToResourceQuota, buildIndexFromResourceQuotas,
  buildResourceQuotaManifest, isGpuQuota,
} from '../resourcequota';

const EMPTY_CAPACITY: ClusterCapacity = {
  total: {
    gpu: 0, cpu: 0, memory: 0
  },
  free: {
    gpu: 0, cpu: 0, memory: 0
  },
};

export default defineComponent({
  name:       'AiProjects',
  // Set when the page is the Projects & Quotas tab of Settings: the tab strip carries the title.
  props:      { embedded: { type: Boolean, default: false } },
  components: {
    Loading, Banner, BadgeState, LabeledInput, LabeledSelect, AsyncButton
  },

  data() {
    return {
      clusterName: '',
      // project rows opened to show namespaces, members and the scheduler's queue
      openDetails: {} as Record<string, boolean>,
      // queues without a project, and the scheduler default: plumbing, closed by default
      showAdvanced: false,
      projects:            [] as AiProject[],
      /** Every Rancher project id already in use on this cluster, so a new one cannot collide. */
      rancherProjectNames: [] as string[],
      issues:              [] as QuotaIssue[],
      queueIndex:          {} as QueueIndex,
      capacity:            { ...EMPTY_CAPACITY } as ClusterCapacity,
      unqueuedGpu:         0,
      summary:             null as CapacitySummary | null,
      assignTo:            {} as Record<string, string>,
      confirmDelete:       '' as string,
      busy:                '' as string,
      kaiInstalled:        false,
      /** commercial Run:AI, which owns projects and namespaces on this cluster — see projects.ts */
      runaiInstalled:      false,
      runaiProjects:       [] as RunaiProject[],
      /** which quota mechanism this cluster can actually offer — see resourcequota.ts */
      backend:             'resourcequota' as QuotaBackend,
      error:               '',
      notice:              '',
      fetchErrors:         [] as string[],
      canCreate:           false,
      canAdopt:            false,
      canEditQuota:        false,
      showCreate:          false,
      timer:               null as any,
      refreshing:          false,
      form:                {
        name:                 '',
        displayName:          '',
        department:           '',
        gpuQuota:             1,
        gpuLimit:             1,
        overQuotaWeight:      1,
        createRancherProject: true,
        // ResourceQuota backend only: the hard cap, or '' meaning do not create a quota at all
        gpuCap:               1 as number | string | null,
        // Run:AI clusters only: adopt a project Run:AI already owns instead of creating one here.
        runaiManaged:         true,
        runaiProject:         '',
      },
      // the queue currently open for a quota edit, with the values as they were when it opened
      editing:  null as null | { queue: string; displayName: string; was: { gpuQuota: number; gpuLimit: number; overQuotaWeight: number } },
      editForm: {
        gpuQuota: 1, gpuLimit: 1, overQuotaWeight: 1
      },
    };
  },

  async fetch() {
    loadClusterLabel(this.$store, String(this.$route.params.cluster || 'local')).then((l: string) => {
      this.clusterName = l;
    });
    await this.load();
  },

  mounted() {
    this.timer = setInterval(() => this.load(), 30000);
  },

  beforeUnmount() {
    if (this.timer) {
      clearInterval(this.timer);
    }
  },

  computed: {
    clusterId(): string {
      return String(this.$route.params.cluster);
    },
    /** Projects proper: a queue nobody's namespace points at is not one (see unassignedQueues). */
    projectRows(): AiProject[] {
      return this.projects.filter((p) => p.source !== 'queue-only');
    },
    /** Projects without a queue yet (GPU scheduling not configured): what a spare queue can go to. */
    assignableProjects(): { label: string; value: string }[] {
      return this.projectRows
        .filter((p) => p.source === 'no-queue' && p.namespaces.length)
        .map((p) => ({ label: `${ p.displayName } (${ p.namespaces.join(', ') })`, value: p.id }));
    },
    /** KAI queues no project uses. Only KAI has queues of its own; ResourceQuotas are per namespace. */
    unassignedQueues(): AiProject[] {
      return this.backend === 'kai' ? this.projects.filter((p) => p.source === 'queue-only') : [];
    },
    gpuInUse(): number {
      return Math.max(0, this.capacity.total.gpu - this.capacity.free.gpu);
    },
    /** Every queue reduced to what the overcommit arithmetic needs. */
    leafQuotas(): { name: string; isLeaf: boolean; gpuQuota: number }[] {
      return Object.values(this.queueIndex).map((q) => ({
        name: q.name, isLeaf: q.isLeaf, gpuQuota: q.quota.gpu
      }));
    },
    /** Total GPU guaranteed by every leaf queue — the number to compare against the hardware. */
    committedGpu(): number {
      return committedGpuAfter(this.leafQuotas, null, 0);
    },
    hasUnlimitedLeaf(): boolean {
      return Object.values(this.queueIndex).some((q) => q.isLeaf && q.quota.gpu === -1);
    },
    departmentOptions(): { label: string; value: string }[] {
      const parents = Object.values(this.queueIndex).filter((q) => !q.isLeaf || !q.parent);

      return [{ label: 'None (top-level queue)', value: '' }]
        .concat(parents.map((q) => ({ label: `${ q.displayName } (${ q.name })`, value: q.name })));
    },
    nameError(): string {
      if (!this.form.name) {
        return '';
      }
      const v = validateProjectName(this.form.name);

      if (v) {
        return v;
      }
      // The index is keyed by whatever holds the quota, which is the queue under KAI but the
      // namespace under ResourceQuota — and the namespace is derived from the name, not equal to it.
      if (this.hasGuarantees && this.queueIndex[this.form.name]) {
        return `A queue named "${ this.form.name }" already exists.`;
      }
      if (!this.hasGuarantees && this.queueIndex[defaultNamespaceFor(this.form.name)]) {
        return `Namespace "${ defaultNamespaceFor(this.form.name) }" already exists and has a GPU quota.`;
      }

      return '';
    },
    /** True where quota means a guaranteed floor that can be borrowed against, not just a ceiling. */
    hasGuarantees(): boolean {
      return this.backend === 'kai';
    },
    /** The column header and form wording differ: a Queue guarantees, a ResourceQuota only caps. */
    quotaNoun(): string {
      return this.hasGuarantees ? 'Guaranteed' : 'Limit';
    },
    /**
     * Column tooltip rather than a standing banner: it is context for the badges beside it, and a
     * paragraph across the top of the page pushes the tables down on every visit to say it once.
     */
    runaiSummary(): string {
      const ready = this.runaiProjects.filter((p) => p.namespace && p.ready).length;
      const usable = this.projects.filter((p) => this.runaiFor(p).state === 'ready').length;

      return `${ usable } of ${ this.projects.length } project(s) can run a Run:AI job; ${ ready } of ${ this.runaiProjects.length } Run:AI project(s) have a namespace.` +
        '<br><br>Run:AI creates projects in its control plane. This page adopts them and adds the Rancher membership they lack.';
    },
    runaiManagedHelp(): string {
      return 'Leave this checked on a Run:AI cluster.<br><br>Run:AI creates projects in its control plane ' +
        'and syncs them down; its admission webhook rejects a <code>projects.run.ai</code> written from ' +
        'here. Its controller also writes the RoleBindings that let the scheduler bind a pod, which is ' +
        'why a namespace made without one never runs anything.<br><br>Checked: adopt a project Run:AI ' +
        'already owns and add the Rancher project for membership.<br>Unchecked: the ordinary path, for ' +
        'workloads that use the default scheduler.';
    },
    /**
     * Tooltip body for the Rancher project checkbox. v-clean-tooltip sanitises HTML, so the markup
     * here is safe, but keep it to <b>/<br> so it stays readable if the sanitiser ever tightens.
     */
    rancherProjectHelp(): string {
      return 'Recommended.<br><br>Groups the namespace under a Rancher project, so members and roles ' +
        'are managed from Cluster &rarr; Projects/Namespaces using Rancher&rsquo;s existing RBAC.' +
        '<br><br>Leave unchecked to create a bare namespace instead.';
    },
    quotaError(): string {
      if (!this.hasGuarantees) {
        return this.form.gpuCap === null || this.form.gpuCap === '' ? '' : validateCap(Number(this.form.gpuCap));
      }

      return validateQuota({
        quota: this.form.gpuQuota, limit: this.form.gpuLimit, overQuotaWeight: this.form.overQuotaWeight
      });
    },
    /** Warn before creating a guarantee the cluster cannot back. */
    overcommitWarning(): string {
      if (!this.hasGuarantees) {
        return this.form.gpuCap === null || this.form.gpuCap === '' ? '' : this.overcommitFor(null, Number(this.form.gpuCap));
      }

      return this.overcommitFor(null, this.form.gpuQuota);
    },
    editQuotaError(): string {
      if (!this.hasGuarantees) {
        return validateCap(this.editForm.gpuLimit);
      }

      return validateQuota({
        quota: this.editForm.gpuQuota, limit: this.editForm.gpuLimit, overQuotaWeight: this.editForm.overQuotaWeight
      });
    },
    editOvercommitWarning(): string {
      if (!this.editing) {
        return '';
      }

      return this.overcommitFor(this.editing.queue, this.hasGuarantees ? this.editForm.gpuQuota : this.editForm.gpuLimit);
    },
    /**
     * Shrinking a quota below what the project is already running does not evict anything, but the
     * scheduler will stop topping it up, so say so rather than letting it look like nothing changed.
     */
    editShrinkWarning(): string {
      if (!this.editing) {
        return '';
      }
      const running = this.queueIndex[this.editing.queue]?.allocated?.gpu || 0;
      const q = this.hasGuarantees ? this.editForm.gpuQuota : this.editForm.gpuLimit;

      if (q >= 0 && running > q) {
        return this.hasGuarantees ? `${ running } GPU(s) are allocated to this queue right now, above the new guarantee of ${ q }. Nothing is evicted, but the excess becomes over-quota usage that can be preempted.` : `${ running } GPU(s) are in use right now, above the new limit of ${ q }. Running pods keep their GPUs — Kubernetes does not evict to satisfy a quota — but no new GPU pod is admitted until usage drops below the limit.`;
      }

      return '';
    },
    editDirty(): boolean {
      const w = this.editing?.was;

      return !!w && (w.gpuQuota !== this.editForm.gpuQuota || w.gpuLimit !== this.editForm.gpuLimit || w.overQuotaWeight !== this.editForm.overQuotaWeight);
    },
    /**
     * True when this page must adopt rather than create. Run:AI's admission webhook refuses a
     * Project written into the cluster ("operation not allowed"), and a namespace made here without
     * one gets pods that are scheduled and then refused at bind time — so the default on a Run:AI
     * cluster is to take a project Run:AI already owns and add only the Rancher binding it lacks.
     */
    runaiMode(): boolean {
      return this.runaiInstalled && this.form.runaiManaged;
    },
    /** Run:AI projects offered for adoption: provisioned, and not already in a Rancher project. */
    runaiProjectOptions(): { label: string; value: string; disabled?: boolean }[] {
      const bound = new Set(this.projects.flatMap((p: AiProject) => (p.rancherProjectId ? p.namespaces : [])));

      return this.runaiProjects
        .filter((p) => !!p.namespace)
        .map((p) => ({
          label:    `${ p.name } → ${ p.namespace }${ p.ready ? '' : ' (provisioning)' }${ bound.has(p.namespace) ? ' — already in a Rancher project' : '' }`,
          value:    p.name,
          disabled: bound.has(p.namespace),
        }));
    },
    selectedRunaiProject(): RunaiProject | null {
      return this.runaiProjects.find((p) => p.name === this.form.runaiProject) || null;
    },
    runaiAdoptError(): string {
      if (!this.runaiMode || !this.form.runaiProject) {
        return '';
      }
      const p = this.selectedRunaiProject;

      if (!p) {
        return `No Run:AI project named "${ this.form.runaiProject }" on this cluster.`;
      }

      return p.namespace ? '' : `Run:AI project "${ p.name }" has no namespace yet. Wait for its controller to provision one.`;
    },
    createDisabled(): boolean {
      // The Rancher project is not optional here: it is the only thing adoption creates, so the
      // checkbox for it is not shown and the button does not gate on it.
      if (this.runaiMode) {
        return !this.form.runaiProject || !!this.runaiAdoptError;
      }

      return !this.form.name || !!this.nameError || !!this.quotaError;
    },
    namespacePreview(): string {
      return this.form.name ? defaultNamespaceFor(this.form.name) : '';
    },
    submitRoute() {
      return { name: `c-cluster-${ PRODUCT_NAME }-${ SUBMIT_PAGE }`, params: { cluster: this.clusterId } };
    },

    /**
     * What the committed-GPU number means, which depends on the scheduler.
     *
     * Without a queueing scheduler a project's quota is a ceiling, not a reservation, so the total
     * can exceed the cluster and that is not an error. Saying so here, rather than in a banner,
     * keeps the explanation attached to the number it explains — and reads as an upgrade path
     * rather than a missing prerequisite, since quota admission is part of Kubernetes already.
     */
    quotaMeaning(): string {
      if (this.hasGuarantees) {
        return 'GPUs reserved for projects by their queues. A project is guaranteed its share, ' +
          'can borrow what other projects are not using, and gives it back through preemption.';
      }

      return 'Every project\'s cap added together. A cap is a ceiling, not a reservation, so this ' +
        'can exceed the GPUs in the cluster — projects compete first-come, first-served up to it. ' +
        'Kubernetes ResourceQuota enforces each cap on the default scheduler, with nothing extra ' +
        'to install. To make shares guaranteed, and to add borrowing, gang scheduling and ' +
        'preemption, install the KAI Scheduler (NVIDIA, Apache-2.0) or Kueue.';
    },

    /** Cluster Explorer's Projects/Namespaces page — where membership and namespaces are managed. */
    projectsNamespacesRoute() {
      return { name: 'c-cluster-product-projectsnamespaces', params: { cluster: this.clusterId, product: 'explorer' } };
    },
  },

  methods: {
    async safeFindAll(store: string, type: string, label: string): Promise<any[]> {
      if (!this.$store.getters[`${ store }/schemaFor`](type)) {
        return [];
      }
      try {
        return await this.$store.dispatch(`${ store }/findAll`, { type, opt: { force: true } });
      } catch (e: any) {
        this.fetchErrors.push(`${ label }: ${ e?.message || e }`);

        return [];
      }
    },

    async canI(verb: string, resource: string, group = ''): Promise<boolean> {
      try {
        const res = await this.$store.dispatch('cluster/request', {
          url:    `/k8s/clusters/${ encodeURIComponent(this.clusterId) }/apis/authorization.k8s.io/v1/selfsubjectaccessreviews`,
          method: 'POST',
          data:   {
            apiVersion: 'authorization.k8s.io/v1',
            kind:       'SelfSubjectAccessReview',
            spec:       {
              resourceAttributes: {
                verb, resource, group
              }
            },
          },
        });

        return !!res?.status?.allowed;
      } catch (e) {
        return false;
      }
    },

    async load() {
      if (this.refreshing) {
        return;
      }
      this.refreshing = true;
      try {
        this.fetchErrors = [];
        this.kaiInstalled = !!this.$store.getters['cluster/schemaFor'](TYPES.KAI_QUEUE);
        // KAI when its CRD is present, otherwise plain ResourceQuota — which needs nothing
        // installed, so there is no third "no quota available" state to fall through to.
        this.backend = this.kaiInstalled ? 'kai' : 'resourcequota';
        // Run:AI ships the same Queue CRD as KAI, so the backend above cannot tell them apart. The
        // run.ai API group only exists under the commercial product, and its presence changes what
        // this page may do: Run:AI owns projects and namespaces, and refuses ones written here.
        this.runaiInstalled = !!this.$store.getters['cluster/schemaFor'](TYPES.RUNAI_CLUSTER);

        const podsReadable = await this.canI('list', 'pods');

        const [queues, namespaces, nodes, pods, rancherProjects, prtbs,
          resourceQuotas, runaiProjects] = await Promise.all([
          this.kaiInstalled ? this.safeFindAll('cluster', TYPES.KAI_QUEUE, 'queues') : Promise.resolve([]),
          this.safeFindAll('cluster', TYPES.NAMESPACE, 'namespaces'),
          this.safeFindAll('cluster', TYPES.NODE, 'nodes'),
          podsReadable ? this.safeFindAll('cluster', TYPES.POD, 'pods') : Promise.resolve([]),
          this.safeFindAll('management', TYPES.RANCHER_PROJECT, 'rancher projects'),
          this.safeFindAll('management', TYPES.PRTB, 'project role bindings'),
          this.kaiInstalled ? Promise.resolve([]) : this.safeFindAll('cluster', TYPES.RESOURCE_QUOTA, 'resource quotas'),
          this.runaiInstalled ? this.safeFindAll('cluster', TYPES.RUNAI_PROJECT, 'run.ai projects') : Promise.resolve([]),
        ]);

        this.runaiProjects = runaiProjectsFrom(runaiProjects);

        let index: QueueIndex;
        let usage;

        if (this.backend === 'kai') {
          // Queue.status is the documented source for live usage, but Run:AI leaves it empty in
          // practice, so pod-derived usage backfills any queue the scheduler has not reported.
          index = buildQueueIndex(queues);
          usage = usageFromPods(pods, namespaceQueueMap(namespaces), index);
          index = withPodUsage(index, usage);
        } else {
          index = buildIndexFromResourceQuotas(
            resourceQuotas.filter((rq: any) => isGpuQuota(rq, GPU_RESOURCE)),
            GPU_RESOURCE,
          );
          // Here the scope *is* the namespace, so the namespace->scope map is the identity over
          // whatever the index holds. status.used already reflects reality, but usageFromPods still
          // runs: it is what computes `unqueued`, the GPUs held by pods under no quota at all.
          usage = usageFromPods(pods, Object.fromEntries(Object.keys(index).map((n) => [n, n])), index);
        }

        // MiB per GPU (GPU Feature Discovery), so a KAI gpu-memory share is charged as a fraction
        const gpuMiB = Math.max(0, ...gpuModels(nodes).map((m) => m.memoryMiB));
        const nsQueueMap = this.backend === 'kai' ? namespaceQueueMap(namespaces) : Object.fromEntries(Object.keys(index).map((n) => [n, n]));

        if (this.backend === 'kai') {
          usage = usageFromPods(pods, nsQueueMap, buildQueueIndex(queues), GPU_RESOURCE, gpuMiB);
          index = withPodUsage(buildQueueIndex(queues), usage);
        }
        this.summary = capacitySummary(nodes, pods, nsQueueMap, new Set(Object.keys(index)));

        const capacity = clusterCapacity({
          nodes: nodes.map((n: any) => ({
            allocatable:   n.status?.allocatable,
            unschedulable: n.spec?.unschedulable,
          })),
          gpuInUse:        usage.total,
          gpuResourceName: GPU_RESOURCE,
        });

        this.queueIndex = index;
        this.capacity = capacity;
        this.unqueuedGpu = usage.unqueued;
        this.issues = auditQuotas(index, capacity);
        // Not scoped to this cluster: project ids are unique across Rancher, and a name taken on
        // another cluster is still a name we must not reuse.
        this.rancherProjectNames = rancherProjects.map((p: any) => p.metadata?.name).filter(Boolean);
        this.projects = assembleProjects(
          rancherProjects.filter((p: any) => p.metadata?.namespace === this.clusterId),
          namespaces,
          index,
          // Not filtered by namespace: a PRTB lives in "<clusterId>-<projectId>", not "<clusterId>",
          // so filtering on the cluster id here would drop every binding. membersOf already scopes
          // them by the fully-qualified projectName.
          prtbs,
          capacity,
          this.clusterId,
          this.backend,
        );

        if (!podsReadable) {
          this.fetchErrors.push('cannot list pods cluster-wide, so GPU usage is taken from queue status only and may read low');
        }
        // Permission is asked for whatever this backend actually writes, so the create button is
        // not offered on the strength of a permission the create path never uses.
        // On Run:AI the only write this page makes is the Rancher binding on a namespace Run:AI
        // already owns, so that is the permission the button is offered on.
        this.canAdopt = this.runaiInstalled && await this.canI('update', 'namespaces');
        [this.canCreate, this.canEditQuota] = this.backend === 'kai' ? await Promise.all([
          this.canI('create', 'queues', 'scheduling.run.ai'),
          this.canI('update', 'queues', 'scheduling.run.ai'),
        ]) : await Promise.all([
          Promise.all([this.canI('create', 'namespaces'), this.canI('create', 'resourcequotas')])
            .then(([ns, rq]) => ns && rq),
          this.canI('update', 'resourcequotas'),
        ]);
      } finally {
        this.refreshing = false;
      }
    },

    /** The quota editor opens above the projects; bring it into view from a row below them. */
    scrollToEditor() {
      this.$nextTick(() => (this.$el as HTMLElement)?.querySelector?.('.ap-edit-quota')?.scrollIntoView({ behavior: 'smooth', block: 'center' }));
    },
    /** KAI's own queues from its install: the fallback for pods without a queue label. */
    isSchedulerDefault(queue: string | null): boolean {
      return queue === 'default-queue' || queue === 'default-parent-queue';
    },
    usageOf(p: AiProject): ProjectUsage {
      return (p.queue && this.summary?.byQueue[p.queue]) || {
        gpus: p.gpu?.allocated || 0, memoryMiB: 0, running: 0, queued: 0
      };
    },
    gib(mib: number): string {
      const g = mib / 1024;

      return `${ g >= 10 || Number.isInteger(g) ? Math.round(g) : g.toFixed(1) } GiB`;
    },
    allocationText(p: AiProject): string {
      const g = p.gpu?.guaranteed;
      const cap = p.gpu?.cap;

      if (!this.hasGuarantees) {
        return cap === undefined || cap === Infinity ? 'No limit' : `Up to ${ this.fmt(cap) } GPU`;
      }
      const base = g === undefined || g === 0 ? 'No guarantee' : g === Infinity ? 'Unlimited' : `${ this.fmt(g) } GPU guaranteed`;
      const upTo = cap === undefined ? '' : cap === Infinity ? ' · can borrow' : cap !== g ? ` · up to ${ this.fmt(cap) }` : '';

      return base + upTo;
    },
    usageBar(p: AiProject): string {
      const cap = p.gpu?.cap;
      const denom = cap && cap !== Infinity ? cap : (this.capacity.total.gpu || 1);

      return `${ Math.min(100, (this.usageOf(p).gpus / denom) * 100) }%`;
    },
    workloadsRoute(p: AiProject, state = '') {
      return {
        name:   `c-cluster-${ PRODUCT_NAME }-${ ENDPOINTS_PAGE }`,
        params: { cluster: this.clusterId },
        query:  { ...(p.namespaces[0] ? { project: p.namespaces[0] } : {}), ...(state ? { state } : {}) },
      };
    },
    /** Configure GPU scheduling for a project that has none: a leaf queue, and its namespaces bound to it. */
    async configureScheduling(p: AiProject) {
      this.error = '';
      this.busy = p.id;
      try {
        const base = (p.displayName || p.namespaces[0] || 'project').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'project';
        const name = this.queueIndex[base] ? `${ base }-${ Math.random().toString(36).slice(2, 6) }` : base;
        const parents = Object.values(this.queueIndex).filter((q) => !q.isLeaf && q.name !== 'default-parent-queue');
        const parent = parents.length === 1 ? parents[0].name : null;
        const q = await this.$store.dispatch('cluster/create', {
          type: TYPES.KAI_QUEUE,
          ...buildQueueManifest(name, {
            quota: 0, limit: -1, overQuotaWeight: 1
          }, parent, p.displayName),
        });

        await q.save();
        for (const ns of p.namespaces) {
          await this.labelNamespace(ns, name);
        }
        this.notice = `GPU scheduling configured for ${ p.displayName }: queue ${ name }${ parent ? ` under ${ parent }` : '' }, no guarantee yet. Set its GPU allocation with Edit quota.`;
        await this.load();
      } catch (e: any) {
        this.error = `Could not configure GPU scheduling: ${ e?.message || e }`;
      } finally {
        this.busy = '';
      }
    },
    async labelNamespace(ns: string, queue: string) {
      const model = await this.$store.dispatch('cluster/find', { type: TYPES.NAMESPACE, id: ns });

      model.metadata.labels = { ...(model.metadata.labels || {}), 'kai.scheduler/queue': queue };
      await model.save();
    },
    /** Bind every namespace of the chosen project to a queue nobody uses. */
    async assignQueue(queue: string) {
      const project = this.projectRows.find((p) => p.id === this.assignTo[queue]);

      if (!project) {
        return;
      }
      this.error = '';
      this.busy = queue;
      try {
        for (const ns of project.namespaces) {
          await this.labelNamespace(ns, queue);
        }
        this.notice = `${ project.displayName } now schedules through queue ${ queue } (${ project.namespaces.join(', ') }).`;
        await this.load();
      } catch (e: any) {
        this.error = `Could not assign ${ queue }: ${ e?.message || e }`;
      } finally {
        this.busy = '';
      }
    },
    async deleteQueue(queue: string) {
      if (this.confirmDelete !== queue) {
        this.confirmDelete = queue;

        return;
      }
      this.error = '';
      this.busy = queue;
      try {
        const model = await this.$store.dispatch('cluster/find', { type: TYPES.KAI_QUEUE, id: queue });

        await model.remove();
        this.notice = `Queue ${ queue } deleted.`;
        this.confirmDelete = '';
        await this.load();
      } catch (e: any) {
        this.error = `Could not delete ${ queue }: ${ e?.message || e }`;
      } finally {
        this.busy = '';
      }
    },
    gpuBarWidth(p: AiProject, which: 'used' | 'quota'): string {
      const denom = this.capacity.total.gpu || 1;
      const v = which === 'used' ? (p.gpu?.allocated || 0) : Math.min(this.finiteQuota(p), denom);

      return `${ Math.min(100, (v / denom) * 100) }%`;
    },
    finiteQuota(p: AiProject): number {
      const g = p.gpu?.guaranteed;

      return g === undefined || g === Infinity ? 0 : g;
    },
    fmt(n: number | undefined): string {
      if (n === undefined) {
        return '—';
      }

      return n === Infinity ? '∞' : String(Math.round(n * 100) / 100);
    },
    limitReason(p: AiProject): string {
      const a = p.gpu;

      if (!a) {
        return '';
      }
      switch (a.limitedBy) {
      case 'quota':
        return 'at its own quota';
      case 'ancestor':
        return `capped by parent "${ a.capBoundBy }"`;
      case 'cluster':
        return 'waiting on free GPUs';
      case 'unschedulable':
        return 'parent queue — not schedulable';
      default:
        return 'has room';
      }
    },
    warningFor(p: AiProject): string {
      return projectWarning(p.source, this.backend);
    },
    sourceLabelFor(p: AiProject): string {
      return projectSourceLabel(p.source, this.backend);
    },
    stateColor(p: AiProject): string {
      if (p.source !== 'complete') {
        return 'warning';
      }

      return (p.gpu?.schedulableNow || 0) > 0 ? 'success' : 'info';
    },
    projectRoute(p: AiProject) {
      if (!p.rancherProjectId) {
        return null;
      }

      return {
        name:   'c-cluster-product-namespaces',
        params: { cluster: this.clusterId, product: 'explorer' },
      };
    },

    resetForm() {
      this.form = {
        name: '', displayName: '', department: '', gpuQuota: 1, gpuLimit: 1, overQuotaWeight: 1, createRancherProject: true, gpuCap: 1, runaiManaged: true, runaiProject: '',
      };
    },

    /** Committed GPUs across all projects once `queue` is set to `newQuota`, vs the hardware. */
    overcommitFor(queue: string | null, newQuota: number): string {
      const after = committedGpuAfter(this.leafQuotas, queue, newQuota);

      if (this.capacity.total.gpu > 0 && after > this.capacity.total.gpu) {
        return this.hasGuarantees ? `Guarantees would total ${ after } GPUs on a ${ this.capacity.total.gpu }-GPU cluster. Scheduling still honours priority and preemption, but not every guarantee can be met at once.` : `Limits would total ${ after } GPUs on a ${ this.capacity.total.gpu }-GPU cluster. Each cap still holds, but with no queueing scheduler the ordering is first-come, first-served.`;
      }

      return '';
    },

    /**
     * What the quota edit would write to. Under KAI that is an existing queue and nothing else will
     * do. Under ResourceQuota it is the namespace, which lets a project created with no cap be
     * given one later — the quota object simply does not exist yet.
     */
    quotaTargetOf(p: AiProject): string | null {
      if (p.queue) {
        return p.queue;
      }

      return this.hasGuarantees ? null : (p.namespaces[0] || null);
    },

    startEditQuota(p: AiProject) {
      const target = this.quotaTargetOf(p);

      if (!target) {
        return;
      }
      const q = this.queueIndex[target];
      const was = {
        gpuQuota:        q?.quota.gpu ?? 0,
        // No quota object yet means no cap; 0 is the safe number to open the form on, and -1 is
        // not a value ResourceQuota understands.
        gpuLimit:        q?.limit.gpu ?? (this.hasGuarantees ? -1 : 0),
        overQuotaWeight: q?.overQuotaWeight.gpu ?? 1,
      };

      this.error = '';
      this.notice = '';
      this.showCreate = false;
      this.editing = {
        queue: target, displayName: p.displayName, was
      };
      this.editForm = { ...was };
    },

    cancelEditQuota() {
      this.editing = null;
    },

    /**
     * Change the quota on an existing queue. The live object is re-read first and only its gpu
     * block is rewritten: a queue may carry cpu/memory limits or a parent an admin set by hand,
     * and a blind PUT of a locally-built manifest would drop them.
     */
    async saveQuota(done: (ok: boolean) => void) {
      this.error = '';
      this.notice = '';
      const editing = this.editing;

      if (!editing || this.editQuotaError) {
        done(false);

        return;
      }
      try {
        if (this.backend === 'kai') {
          const queue = await this.$store.dispatch('cluster/find', {
            type: TYPES.KAI_QUEUE, id: editing.queue, opt: { force: true }
          });

          queue.spec = applyQuotaToQueue(queue.spec, {
            quota: this.editForm.gpuQuota, limit: this.editForm.gpuLimit, overQuotaWeight: this.editForm.overQuotaWeight
          });
          await queue.save();
        } else {
          // editing.queue is the namespace under this backend. The quota may not exist yet: a
          // project created with no cap, now being given one.
          const id = `${ editing.queue }/${ RESOURCE_QUOTA_NAME }`;
          let rq = null;

          try {
            rq = await this.$store.dispatch('cluster/find', {
              type: TYPES.RESOURCE_QUOTA, id, opt: { force: true }
            });
          } catch {
            rq = null;
          }

          if (rq) {
            rq.spec = applyGpuToResourceQuota(rq.spec, this.editForm.gpuLimit, GPU_RESOURCE);
            await rq.save();
          } else {
            const manifest = buildResourceQuotaManifest(editing.queue, this.editForm.gpuLimit, GPU_RESOURCE);
            const created = await this.$store.dispatch('cluster/create', { type: TYPES.RESOURCE_QUOTA, ...manifest });

            await created.save();
          }
        }

        this.notice = this.backend === 'kai' ? `Quota for "${ editing.displayName }" updated: guarantee ${ this.fmtQuota(this.editForm.gpuQuota) }, limit ${ this.fmtQuota(this.editForm.gpuLimit) } GPU. Running workloads are not restarted; the change applies to the next scheduling decision.` : `GPU limit for "${ editing.displayName }" set to ${ this.editForm.gpuLimit }. Pods already running are not evicted — the cap applies to the next pod admitted.`;
        this.editing = null;
        done(true);
        await this.load();
      } catch (e: any) {
        this.error = e?.message || String(e);
        done(false);
      }
    },

    /** -1/0 are sentinels in the Queue API, not counts. */
    fmtQuota(n: number): string {
      if (n === -1) {
        return 'unlimited';
      }

      return n === 0 ? 'none' : String(n);
    },

    /** Whether a Run:AI job can bind in this project, per row. Cheap enough to call from the table. */
    runaiFor(p: AiProject): RunaiReadiness {
      return runaiReadinessOf(p.namespaces, this.runaiProjects);
    },
    runaiBadgeColor(state: string): string {
      return state === 'ready' ? 'bg-success' : state === 'provisioning' ? 'bg-warning' : 'bg-error';
    },

    /**
     * Create a Rancher project and register its rollback. Shared by both paths: creating a project
     * outright and adopting one Run:AI already owns, which differ only in what carries the quota.
     */
    async createRancherProject(displayName: string, undo: { what: string; fn: () => Promise<any> }[]): Promise<string> {
      const manifest = buildRancherProjectManifest(this.clusterId, displayName);
      const created = await this.$store.dispatch('management/create', { type: TYPES.RANCHER_PROJECT, ...manifest });

      const saved = await created.save();

      // Never roll back through `created`. Its `norman` getter branches on having an id, and
      // without one it returns normanNewProject — so created.remove() would *create* a second
      // project and delete that, leaving the real one behind. `saved` is the Norman project and
      // has a working id. Registered before the read-back so a failure there still cleans up.
      let project: any = null;

      undo.push({
        what: 'Rancher project',
        fn:   () => {
          const target = project ?? saved;

          if (!target?.remove) {
            throw new Error('no handle on the created project');
          }

          return target.remove();
        },
      });

      // save() returns the Norman project, whose id is already "<cluster>:<project>". When it
      // does, there is nothing to wait for. Polling the list is the fallback for when it does
      // not — see projectIdFromSaveResult and resolveCreatedProject.
      const fromSave = projectIdFromSaveResult(saved, this.clusterId);

      if (fromSave) {
        return fromSave;
      }
      project = await resolveCreatedProject({
        list:      () => this.$store.dispatch('management/findAll', { type: TYPES.RANCHER_PROJECT, opt: { force: true } }),
        clusterId: this.clusterId,
        displayName,
        known:     this.rancherProjectNames,
      });

      return `${ this.clusterId }:${ project.metadata.name }`;
    },

    /**
     * Adopt a project Run:AI owns: create the Rancher project for membership and point the existing
     * namespace at it. Nothing else is written — the namespace, its RoleBindings and its quota all
     * belong to Run:AI's controller, and a second writer would only fight it.
     *
     * Deliberately not "create": Run:AI's webhook rejects a projects.run.ai written from here, and
     * a namespace created without one is the failure this page exists to prevent.
     */
    async adoptRunaiProject(done: (ok: boolean) => void) {
      const project = this.selectedRunaiProject;

      if (!project?.namespace) {
        this.error = 'Pick a Run:AI project with a provisioned namespace.';
        done(false);

        return;
      }
      const undo: { what: string; fn: () => Promise<any> }[] = [];

      try {
        const displayName = this.form.displayName || project.name;
        const rancherProjectId = await this.createRancherProject(displayName, undo);
        const patch = buildProjectBindingPatch(project.namespace, this.clusterId, rancherProjectId);

        // Re-read and merge rather than PUT a manifest: Run:AI's controller owns the rest of this
        // namespace's labels (runai/queue, the namespace version) and a blind write would drop them.
        const ns = await this.$store.dispatch('cluster/find', {
          type: TYPES.NAMESPACE, id: project.namespace, opt: { force: true }
        });

        ns.metadata.labels = { ...(ns.metadata.labels || {}), ...patch.labels };
        ns.metadata.annotations = { ...(ns.metadata.annotations || {}), ...patch.annotations };
        await ns.save();

        this.notice = `Run:AI project "${ project.name }" adopted: namespace ${ project.namespace } is now in Rancher project ${ shortProjectId(rancherProjectId) }. Quota stays with Run:AI; add members from Cluster → Projects/Namespaces.`;
        this.showCreate = false;
        this.resetForm();
        done(true);
        await this.load();
      } catch (e: any) {
        for (const step of undo.reverse()) {
          try {
            await step.fn();
          } catch {
            // reported through the error below; nothing further to try
          }
        }
        this.error = `${ e?.message || String(e) }. The namespace was left as Run:AI had it.`;
        done(false);
      }
    },

    /**
     * Create the objects that make up a project: a Rancher project for membership, a quota, and a
     * namespace joining them. Which quota object depends on the backend — a Queue under KAI, a
     * ResourceQuota inside the namespace otherwise.
     *
     * Every created object is pushed onto an undo list and rolled back if a later step fails.
     * Without that, a failure partway through leaves debris the user did not ask for and cannot see
     * from this page: an earlier version created the Rancher project first and then attempted the
     * Queue unconditionally, so on a cluster with no Queue API every attempt left an orphan project
     * behind and reported only the Queue error.
     */
    async createProject(done: (ok: boolean) => void) {
      this.error = '';
      this.notice = '';
      if (this.createDisabled) {
        done(false);

        return;
      }
      if (this.runaiMode) {
        return this.adoptRunaiProject(done);
      }
      const name = this.form.name;
      const namespace = defaultNamespaceFor(name);
      const undo: { what: string; fn: () => Promise<any> }[] = [];

      try {
        const rancherProjectId = this.form.createRancherProject ? await this.createRancherProject(this.form.displayName || name, undo) : null;

        if (this.backend === 'kai') {
          const queueManifest = buildQueueManifest(
            name,
            {
              quota: this.form.gpuQuota, limit: this.form.gpuLimit, overQuotaWeight: this.form.overQuotaWeight
            },
            this.form.department || null,
            this.form.displayName || name,
          );
          const queue = await this.$store.dispatch('cluster/create', { type: TYPES.KAI_QUEUE, ...queueManifest });

          await queue.save();
          undo.push({ what: 'queue', fn: () => queue.remove() });
        }

        const nsManifest = buildNamespaceManifest(namespace, name, this.clusterId, rancherProjectId, this.backend);
        const ns = await this.$store.dispatch('cluster/create', { type: TYPES.NAMESPACE, ...nsManifest });

        await ns.save();
        undo.push({ what: 'namespace', fn: () => ns.remove() });

        // The ResourceQuota has to follow the namespace it lives in. Leaving the cap empty is a
        // deliberate choice for "no limit": there is no sentinel for unlimited, only the absence
        // of a quota object.
        let quotaNote = '';

        if (this.backend === 'resourcequota') {
          if (this.form.gpuCap === null || this.form.gpuCap === '') {
            quotaNote = ', no GPU limit';
          } else {
            const rqManifest = buildResourceQuotaManifest(namespace, Number(this.form.gpuCap), GPU_RESOURCE);
            const rq = await this.$store.dispatch('cluster/create', { type: TYPES.RESOURCE_QUOTA, ...rqManifest });

            await rq.save();
            quotaNote = `, GPU limit ${ this.form.gpuCap }`;
          }
        } else {
          quotaNote = `, queue ${ name }`;
        }

        this.notice = `Project "${ name }" created: namespace ${ namespace }${ quotaNote }${ rancherProjectId ? `, Rancher project ${ shortProjectId(rancherProjectId) }` : '' }. Add members from Cluster → Projects/Namespaces.`;
        this.showCreate = false;
        this.resetForm();
        done(true);
        await this.load();
      } catch (e: any) {
        const failure = e?.message || String(e);
        const rolledBack: string[] = [];
        const stuck: string[] = [];

        for (const step of undo.reverse()) {
          try {
            await step.fn();
            rolledBack.push(step.what);
          } catch {
            stuck.push(step.what);
          }
        }

        this.error = [
          failure,
          rolledBack.length ? `Rolled back: ${ rolledBack.join(', ') }.` : '',
          stuck.length ? `Could not roll back: ${ stuck.join(', ') } — remove by hand.` : '',
        ].filter(Boolean).join(' ');
        done(false);
        await this.load();
      }
    },
  },
});
</script>

<template>
  <Loading v-if="$fetchState.pending" />
  <div
    v-else
    class="ai-projects"
  >
    <header class="ap-header">
      <div class="ap-title">
        <!-- literal, not t(): the ampersand would be escaped twice -->
        <h1 v-if="!embedded">
          Projects &amp; Quotas
        </h1>
        <p class="text-muted ap-lede">
          {{ t('trainingjobs.projects.lede') }}
          <i
            v-clean-tooltip.bottom="t('trainingjobs.projects.subtitle')"
            class="icon icon-info ap-info"
            tabindex="0"
            role="img"
            aria-label="What a project is"
          />
        </p>
        <p
          v-if="clusterName"
          class="text-muted ap-cluster"
        >
          Projects and quotas on <strong>{{ clusterName }}</strong>
        </p>
      </div>
      <div class="ap-header-actions">
        <button
          v-if="canCreate || canAdopt"
          class="btn role-primary"
          @click="showCreate = !showCreate"
        >
          <i class="icon icon-plus mr-5" /> {{ runaiInstalled ? 'Add project' : 'New project' }}
        </button>
        <button
          class="btn role-secondary"
          @click="load()"
        >
          <i class="icon icon-refresh mr-5" /> Refresh
        </button>
      </div>
    </header>

    <!-- Whether this cluster can install the chart at all. Above the quota tables because a
         cluster that cannot run a job is a more basic fact than how its GPUs are divided up. -->

    <Banner
      v-if="error"
      color="error"
      :label="error"
    />
    <Banner
      v-if="notice"
      color="success"
      :label="notice"
    />

    <!-- ===================== outside project accounting ===================== -->
    <section
      v-if="summary && summary.outside.gpus > 0"
      class="ap-card ap-card-warn"
    >
      <h2 class="ap-card-title">
        <i class="icon icon-warning text-warning" /> Resources outside project accounting
      </h2>
      <p>
        {{ fmt(summary.outside.gpus) }} GPU{{ summary.outside.gpus === 1 ? ' is' : 's are' }} held by
        {{ summary.outside.workloads.length }} workload{{ summary.outside.workloads.length === 1 ? '' : 's' }}
        outside any AI project. Project quotas cannot see this, and it is unavailable to project workloads.
      </p>
      <ul class="ap-outside">
        <li
          v-for="w in summary.outside.workloads"
          :key="w.namespace + '/' + w.name"
        >
          <code>{{ w.namespace }}/{{ w.name }}</code>
        </li>
      </ul>
    </section>

    <!-- ===================== quota audit ===================== -->
    <section
      v-if="issues.length"
      class="ap-issues"
    >
      <h2>Quota configuration</h2>
      <ul>
        <li
          v-for="i in issues"
          :key="i.id"
          :class="['ap-issue', i.severity]"
        >
          <i :class="['icon', i.severity === 'fail' ? 'icon-x text-error' : i.severity === 'warn' ? 'icon-warning text-warning' : 'icon-info text-info']" />
          <div>
            <div class="ap-issue-title">
              {{ i.title }}
            </div>
            <div class="ap-issue-detail text-muted">
              {{ i.detail }}
            </div>
          </div>
        </li>
      </ul>
    </section>

    <!-- ===================== create ===================== -->
    <section
      v-if="showCreate"
      class="ap-create"
    >
      <h2>{{ runaiMode ? 'Adopt a Run:AI project' : 'New project' }}</h2>
      <!-- The one decision that changes everything else on a Run:AI cluster, so it comes first. -->
      <div
        v-if="runaiInstalled"
        class="ap-runai-toggle"
      >
        <label>
          <input
            v-model="form.runaiManaged"
            type="checkbox"
          >
          Run:AI manages this project
        </label>
        <i
          v-clean-tooltip="runaiManagedHelp"
          class="icon icon-info ap-info"
          tabindex="0"
          role="img"
          aria-label="About Run:AI projects"
        />
      </div>
      <Banner
        v-if="runaiInstalled && !form.runaiManaged"
        color="error"
        label="Run:AI is installed on this cluster and owns projects. A project created here gets a namespace with no run.ai Project behind it: Run:AI will schedule its pods and then refuse to bind them. Only uncheck this for workloads submitted with the default scheduler."
      />
      <p
        v-if="runaiMode"
        class="text-muted"
      >
        Run:AI creates projects in its own control plane and its admission webhook rejects any
        written here, so this page does not create one. It takes a project Run:AI already owns and
        adds the one thing Run:AI does not: the Rancher project that carries membership and roles.
        The namespace, its RoleBindings and its GPU quota stay with Run:AI.
      </p>
      <div
        v-if="runaiMode"
        class="row"
      >
        <div class="col span-6">
          <LabeledSelect
            v-model:value="form.runaiProject"
            label="Run:AI project"
            :options="runaiProjectOptions"
          />
          <p
            v-if="runaiAdoptError"
            class="text-error ap-field-error"
          >
            {{ runaiAdoptError }}
          </p>
          <p
            v-else-if="selectedRunaiProject"
            class="text-muted ap-field-hint"
          >
            Namespace: {{ selectedRunaiProject.namespace }} · queue
            {{ selectedRunaiProject.name }} · GPU {{ fmtQuota(selectedRunaiProject.gpuDeserved ?? -1) }}
            guaranteed, {{ fmtQuota(selectedRunaiProject.gpuLimit ?? -1) }} limit
            <template v-if="selectedRunaiProject.department">
              · dept {{ selectedRunaiProject.department }}
            </template>
          </p>
          <p
            v-else-if="!runaiProjectOptions.length"
            class="text-muted ap-field-hint"
          >
            No Run:AI project on this cluster has a namespace to adopt. Create the project in Run:AI
            first; it appears here once its controller provisions the namespace.
          </p>
        </div>
        <div class="col span-6">
          <LabeledInput
            v-model:value="form.displayName"
            label="Rancher project name (optional)"
            :placeholder="form.runaiProject || 'same as the Run:AI project'"
          />
        </div>
      </div>
      <p
        v-if="!runaiMode"
        class="text-muted"
      >
        <template v-if="hasGuarantees">
          Creates a Rancher project (for membership and roles), a scheduler queue (for GPU quota), and a
          namespace joining the two.
        </template>
        <template v-else>
          Creates a Rancher project (for membership and roles), a namespace, and a ResourceQuota in it
          capping GPUs. No scheduler required.
        </template>
        Members are then managed in the normal Rancher Members tab.
      </p>
      <div
        v-if="!runaiMode"
        class="row"
      >
        <div class="col span-4">
          <LabeledInput
            v-model:value="form.name"
            label="Project name"
            placeholder="team-vision"
          />
          <p
            v-if="nameError"
            class="text-error ap-field-error"
          >
            {{ nameError }}
          </p>
          <p
            v-else-if="namespacePreview"
            class="text-muted ap-field-hint"
          >
            Namespace: {{ namespacePreview }}<template v-if="hasGuarantees">
              · Queue: {{ form.name }}
            </template>
          </p>
        </div>
        <div class="col span-4">
          <LabeledInput
            v-model:value="form.displayName"
            label="Display name (optional)"
          />
        </div>
        <div
          v-if="hasGuarantees"
          class="col span-4"
        >
          <LabeledSelect
            v-model:value="form.department"
            label="Department (parent queue)"
            :options="departmentOptions"
          />
        </div>
      </div>
      <div
        v-if="!runaiMode"
        class="row"
      >
        <!-- Queue backend: a floor, a ceiling, and a borrowing weight. -->
        <template v-if="hasGuarantees">
          <div class="col span-3">
            <LabeledInput
              v-model:value.number="form.gpuQuota"
              type="number"
              min="-1"
              label="GPU guarantee (quota)"
            />
            <p class="text-muted ap-field-hint">
              -1 = unlimited, 0 = none
            </p>
          </div>
          <div class="col span-3">
            <LabeledInput
              v-model:value.number="form.gpuLimit"
              type="number"
              min="-1"
              label="GPU hard limit"
            />
            <p class="text-muted ap-field-hint">
              -1 = uncapped, 0 = never exceed the guarantee
            </p>
          </div>
          <div class="col span-3">
            <LabeledInput
              v-model:value.number="form.overQuotaWeight"
              type="number"
              min="0"
              label="Over-quota weight"
            />
            <p class="text-muted ap-field-hint">
              Share of spare GPUs vs other projects
            </p>
          </div>
        </template>
        <!-- ResourceQuota backend: one number, and no number at all means no quota object. -->
        <div
          v-else
          class="col span-3"
        >
          <LabeledInput
            v-model:value="form.gpuCap"
            type="number"
            min="0"
            label="GPU limit"
          />
          <p class="text-muted ap-field-hint">
            Most GPUs this project may hold at once. Leave empty for no limit; 0 blocks GPU workloads.
          </p>
        </div>
        <div class="col span-3 ap-checkbox">
          <label>
            <input
              v-model="form.createRancherProject"
              type="checkbox"
            >
            Create Rancher Project
          </label>
          <!-- outside the label on purpose: inside it, hovering to read the help would also arm a click that toggles the box -->
          <i
            v-clean-tooltip="rancherProjectHelp"
            class="icon icon-info ap-info"
            tabindex="0"
            role="img"
            aria-label="About Rancher projects"
          />
        </div>
      </div>
      <Banner
        v-if="!runaiMode && quotaError"
        color="error"
        :label="quotaError"
      />
      <Banner
        v-if="!runaiMode && overcommitWarning"
        color="warning"
        :label="overcommitWarning"
      />
      <div class="ap-create-actions">
        <button
          class="btn role-secondary btn-sm"
          @click="showCreate = false; resetForm()"
        >
          Cancel
        </button>
        <AsyncButton
          mode="create"
          :disabled="createDisabled"
          :action-label="runaiMode ? 'Adopt project' : 'Create project'"
          :waiting-label="runaiMode ? 'Adopting…' : 'Creating…'"
          :success-label="runaiMode ? 'Adopted' : 'Created'"
          @click="createProject"
        />
      </div>
    </section>

    <!-- ===================== edit quota ===================== -->
    <section
      v-if="editing"
      class="ap-create ap-edit-quota"
    >
      <h2>Quota for {{ editing.displayName }}</h2>
      <p
        v-if="isSchedulerDefault(editing.queue)"
        class="text-muted"
      >
        The scheduler's fallback queue: pods sent to it without a queue label land here, outside every
        project. A GPU hard limit of 0 makes them wait instead of using idle GPUs; -1 lets them borrow.
      </p>
      <p class="text-muted">
        <template v-if="hasGuarantees">
          Edits queue <code>{{ editing.queue }}</code> in place. Membership, namespaces and the parent
          queue are unchanged, and nothing already running is restarted.
        </template>
        <template v-else>
          Edits the ResourceQuota in namespace <code>{{ editing.queue }}</code>. Membership is
          unchanged, and pods already holding GPUs keep them.
        </template>
      </p>
      <div class="row">
        <template v-if="hasGuarantees">
          <div class="col span-4">
            <LabeledInput
              v-model:value.number="editForm.gpuQuota"
              type="number"
              min="-1"
              label="GPU guarantee (quota)"
            />
            <p class="text-muted ap-field-hint">
              -1 = unlimited, 0 = none · was {{ fmtQuota(editing.was.gpuQuota) }}
            </p>
          </div>
          <div class="col span-4">
            <LabeledInput
              v-model:value.number="editForm.gpuLimit"
              type="number"
              min="-1"
              label="GPU hard limit"
            />
            <p class="text-muted ap-field-hint">
              -1 = uncapped, 0 = never exceed the guarantee · was {{ fmtQuota(editing.was.gpuLimit) }}
            </p>
          </div>
          <div class="col span-4">
            <LabeledInput
              v-model:value.number="editForm.overQuotaWeight"
              type="number"
              min="0"
              label="Over-quota weight"
            />
            <p class="text-muted ap-field-hint">
              Share of spare GPUs vs other projects · was {{ editing.was.overQuotaWeight }}
            </p>
          </div>
        </template>
        <div
          v-else
          class="col span-4"
        >
          <LabeledInput
            v-model:value.number="editForm.gpuLimit"
            type="number"
            min="0"
            label="GPU limit"
          />
          <p class="text-muted ap-field-hint">
            Most GPUs this project may hold at once · was {{ editing.was.gpuLimit }}
          </p>
        </div>
      </div>
      <Banner
        v-if="editQuotaError"
        color="error"
        :label="editQuotaError"
      />
      <Banner
        v-if="editShrinkWarning"
        color="warning"
        :label="editShrinkWarning"
      />
      <Banner
        v-if="editOvercommitWarning"
        color="warning"
        :label="editOvercommitWarning"
      />
      <div class="ap-create-actions">
        <button
          class="btn role-secondary btn-sm"
          @click="cancelEditQuota"
        >
          Cancel
        </button>
        <AsyncButton
          mode="apply"
          :disabled="!!editQuotaError || !editDirty"
          action-label="Save quota"
          waiting-label="Saving…"
          success-label="Saved"
          @click="saveQuota"
        />
      </div>
    </section>

    <!-- ===================== projects ===================== -->
    <!-- Organised around the Rancher project: the queue that implements its allocation is a detail
         under its name, not a column of its own. -->
    <section class="ap-list">
      <h2 class="ap-list-title">
        Projects
        <span
          v-if="projectRows.length"
          class="ap-count"
        >{{ projectRows.length }}</span>
        <span
          v-if="projectRows.length"
          class="ap-quota-total text-muted"
        >
          {{ fmt(committedGpu) }}<span v-if="hasUnlimitedLeaf"> + ∞</span> GPU
          {{ hasGuarantees ? 'guaranteed' : 'in limits' }} in total
          <i
            v-clean-tooltip.bottom="quotaMeaning"
            class="icon icon-info ap-info"
            tabindex="0"
            role="img"
            aria-label="What this number means"
          />
        </span>
      </h2>
      <table
        v-if="projectRows.length"
        class="ap-table"
      >
        <thead>
          <tr>
            <th>Project</th>
            <th v-if="runaiInstalled">
              Run:AI
              <i
                v-clean-tooltip.bottom="runaiSummary"
                class="icon icon-info ap-info"
                tabindex="0"
                role="img"
                aria-label="What this column means"
              />
            </th>
            <th>GPU entitlement</th>
            <th>Current usage</th>
            <th>Deployments</th>
            <th />
          </tr>
        </thead>
        <tbody>
          <template
            v-for="p in projectRows"
            :key="p.id"
          >
            <tr>
              <td>
                <button
                  type="button"
                  class="ap-name ap-name-toggle"
                  :aria-expanded="!!openDetails[p.id]"
                  @click="openDetails[p.id] = !openDetails[p.id]"
                >
                  <i :class="['icon', openDetails[p.id] ? 'icon-chevron-down' : 'icon-chevron-right']" />
                  {{ p.displayName }}
                </button>
                <BadgeState
                  v-if="p.source === 'no-rancher-project'"
                  color="bg-warning"
                  :label="sourceLabelFor(p)"
                  class="ap-badge"
                />
              </td>
              <td v-if="runaiInstalled">
                <BadgeState
                  :color="runaiBadgeColor(runaiFor(p).state)"
                  :label="runaiFor(p).label"
                  class="ap-badge"
                />
              </td>
              <td>
                <template v-if="p.source === 'no-queue'">
                  <div>GPU scheduling not configured</div>
                  <div class="text-muted ap-sub">
                    Workloads use the cluster's default scheduling.
                  </div>
                </template>
                <template v-else>
                  <div>{{ allocationText(p) }}</div>
                </template>
              </td>
              <td class="ap-barcell">
                <template v-if="p.source !== 'no-queue'">
                  <div>
                    {{ fmt(usageOf(p).gpus) }} GPU<template v-if="usageOf(p).memoryMiB">
                      · {{ gib(usageOf(p).memoryMiB) }}
                    </template>
                  </div>
                  <div class="ap-bar">
                    <div
                      class="ap-bar-used"
                      :style="{ width: usageBar(p) }"
                    />
                  </div>
                </template>
                <span
                  v-else
                  class="text-muted"
                >—</span>
              </td>
              <td>
                <template v-if="p.source !== 'no-queue'">
                  <router-link :to="workloadsRoute(p, 'Running')">
                    {{ usageOf(p).running }} running
                  </router-link>
                  ·
                  <router-link
                    :to="workloadsRoute(p, 'Queued')"
                    :class="{ 'text-warning': usageOf(p).queued > 0 }"
                  >
                    {{ usageOf(p).queued }} queued
                  </router-link>
                  <div
                    v-if="usageOf(p).queued > 0"
                    class="text-muted ap-sub"
                  >
                    {{ usageOf(p).queued }} waiting for GPU capacity
                  </div>
                </template>
                <span
                  v-else
                  class="text-muted"
                >—</span>
              </td>
              <td class="ap-actions">
                <button
                  v-if="p.source === 'no-queue' && hasGuarantees && canCreate"
                  class="btn role-secondary btn-sm"
                  :disabled="busy === p.id"
                  @click="configureScheduling(p)"
                >
                  Configure GPU scheduling
                </button>
                <button
                  v-else-if="canEditQuota && quotaTargetOf(p)"
                  class="btn role-primary btn-sm"
                  :disabled="editing && editing.queue === quotaTargetOf(p)"
                  @click="startEditQuota(p)"
                >
                  Edit
                </button>
              </td>
            </tr>
            <tr
              v-if="openDetails[p.id]"
              class="ap-details-row"
            >
              <td :colspan="runaiInstalled ? 6 : 5">
                <dl class="ap-details">
                  <div>
                    <dt>Namespaces</dt>
                    <dd>{{ p.namespaces.join(', ') || '—' }}</dd>
                  </div>
                  <div>
                    <dt>Members</dt>
                    <dd>{{ p.members.length ? p.members.map(m => `${ m.name } (${ m.role })`).join(', ') : '—' }}</dd>
                  </div>
                  <div v-if="p.queue">
                    <dt>Advanced scheduling</dt>
                    <dd>
                      Queue {{ p.queue }}<template v-if="p.department">
                        · parent {{ p.department }}
                      </template>
                    </dd>
                  </div>
                </dl>
              </td>
            </tr>
          </template>
        </tbody>
      </table>
      <Banner
        v-else
        color="info"
        label="No AI projects yet. Create one to give a team a namespace, Rancher RBAC and a GPU quota."
      />
    </section>

    <!-- ===================== unassigned scheduler resources ===================== -->
    <!-- A queue no project's namespace points at (KAI's default-queue, or one left behind) is not a
         project; listed apart, with what can be done about it. -->
    <section
      v-if="unassignedQueues.length"
      class="ap-list ap-list-secondary"
    >
      <button
        type="button"
        class="ap-advanced-toggle"
        :aria-expanded="showAdvanced"
        @click="showAdvanced = !showAdvanced"
      >
        <i :class="['icon', showAdvanced ? 'icon-chevron-down' : 'icon-chevron-right']" />
        Advanced scheduling
        <span class="text-muted">· {{ unassignedQueues.length }} queue{{ unassignedQueues.length === 1 ? '' : 's' }} without a project</span>
      </button>
      <template v-if="showAdvanced">
        <h3 class="ap-list-title">
          Queues without a project
        </h3>
        <div
          v-for="q in unassignedQueues"
          :key="q.id"
          class="ap-unassigned"
        >
          <div>
            <div class="ap-name">
              {{ q.queue }}
            </div>
            <div
              v-if="isSchedulerDefault(q.queue)"
              class="text-muted ap-sub"
            >
              The scheduler's fallback: pods sent to it with no queue label run here. Part of its install;
              not a project. {{ allocationText(q) }}.
            </div>
            <div
              v-else
              class="text-muted ap-sub"
            >
              No project's namespace is assigned to this queue. {{ allocationText(q) }}.
            </div>
          </div>
          <div class="ap-unassigned-actions">
            <button
              v-if="canEditQuota && isSchedulerDefault(q.queue)"
              class="btn role-primary btn-sm"
              :disabled="editing && editing.queue === q.queue"
              @click="startEditQuota(q); scrollToEditor()"
            >
              Edit limit
            </button>
            <template v-if="canEditQuota && !isSchedulerDefault(q.queue)">
              <template v-if="assignableProjects.length">
                <LabeledSelect
                  v-model:value="assignTo[q.queue]"
                  class="ap-assign-select"
                  label="Project"
                  placeholder="Choose a project"
                  :options="assignableProjects"
                />
                <button
                  class="btn role-secondary btn-sm"
                  :disabled="!assignTo[q.queue] || busy === q.queue"
                  @click="assignQueue(q.queue)"
                >
                  Assign project
                </button>
              </template>
              <span
                v-else
                class="text-muted ap-sub"
              >Every project already has GPU scheduling.</span>
            </template>
            <button
              v-if="canEditQuota && !isSchedulerDefault(q.queue)"
              class="btn btn-sm"
              :class="confirmDelete === q.queue ? 'bg-error' : 'role-tertiary'"
              :disabled="busy === q.queue"
              @click="deleteQueue(q.queue)"
            >
              {{ confirmDelete === q.queue ? 'Confirm delete' : 'Delete queue' }}
            </button>
          </div>
        </div>
      </template>
    </section>

    <Banner
      v-if="fetchErrors.length"
      color="warning"
      :label="'Some data could not be read: ' + fetchErrors.join('; ')"
    />

    <p class="text-muted ap-footer">
      <router-link :to="submitRoute">
        Submit a job
      </router-link>
      into a project. Projects and Namespaces are managed in
      <router-link :to="projectsNamespacesRoute">
        Cluster → Projects/Namespaces → Members
      </router-link>.
    </p>
  </div>
</template>

<style lang="scss" scoped>
.ap-card { border: 1px solid var(--border); border-radius: 6px; padding: 14px 18px; margin-bottom: 16px; background: var(--body-bg); }
.ap-card-warn { border-color: var(--warning); }
.ap-card-title { font-size: 16px; margin: 0 0 10px; }
.ap-stats { display: flex; flex-wrap: wrap; gap: 32px; margin-bottom: 10px; }
.ap-model { display: flex; align-items: center; gap: 12px; margin: 6px 0; }
.ap-model-name { min-width: 220px; }
.ap-bar-wide { flex: 1; max-width: 420px; }
.ap-card-foot { margin-top: 8px; font-size: 13px; }
.ap-outside { margin: 6px 0 0 18px; }
.ap-list-secondary { margin-top: 28px; }
.ap-list-title + .ap-unassigned { border-top: 0; }
.ap-unassigned { display: flex; justify-content: space-between; align-items: center; gap: 16px; padding: 10px 0; border-top: 1px solid var(--border); }
.ap-unassigned-actions { display: flex; gap: 8px; align-items: center; }
.ap-assign-select { min-width: 280px; }

.ai-projects { padding: 0 20px 20px; }
.ap-header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 12px; h1 { margin-bottom: 0; } }
.ap-title { display: flex; align-items: center; gap: 8px; }
.ap-version { font-size: 11px; color: var(--muted); border: 1px solid var(--border); border-radius: 10px; padding: 1px 7px; cursor: help; }
.ap-header-actions { display: flex; gap: 8px; align-items: center; }
.ap-capacity { display: flex; gap: 28px; padding: 14px 18px; border: 1px solid var(--border); border-radius: var(--border-radius); margin-bottom: 8px; flex-wrap: wrap; align-items: center; }
// Next to the last stat rather than flush with the page edge: the strip is full width, so
// margin-left:auto stranded the label a long way from the numbers it names.
.ap-capacity-title { padding-left: 28px; border-left: 1px solid var(--border); font-size: 22px; font-weight: 600; color: var(--muted); align-self: stretch; display: flex; align-items: center; }
.ap-stat-value { font-size: 26px; font-weight: 600; line-height: 1.1; }
.ap-stat-label { font-size: 12px; color: var(--muted); }
.ap-note { font-size: 12px; margin: 0 0 12px; }
.ap-issues { margin-bottom: 16px; h2 { font-size: 16px; margin: 12px 0 8px; } ul { list-style: none; margin: 0; padding: 0; } }
.ap-issue { display: flex; gap: 10px; padding: 7px 0; border-bottom: 1px solid var(--border); align-items: flex-start; .icon { margin-top: 2px; font-size: 16px; } }
.ap-issue:last-child { border-bottom: none; }
.ap-issue-title { font-weight: 600; }
.ap-issue-detail { font-size: 12px; }
// The create/edit forms are transient panels stacked above a persistent list. A hairline border is
// not enough separation in either theme: give them a raised surface and an accent edge so it reads
// as "a thing you are doing", distinct from "the things that exist".
.ap-create {
  background: var(--box-bg);
  border: 1px solid var(--border);
  border-left: 3px solid var(--primary);
  border-radius: var(--border-radius);
  padding: 16px 18px;
  margin-bottom: 28px;
  h2 { font-size: 16px; margin: 0 0 4px; }
  .row { margin-bottom: 12px; }
}
.ap-create-actions { display: flex; gap: 10px; justify-content: flex-end; }
.ap-list-title {
  font-size: 16px;
  margin: 0 0 10px;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--border);
}
.ap-count {
  display: inline-block;
  margin-left: 8px;
  padding: 0 7px;
  border-radius: 10px;
  background: var(--primary);
  color: var(--primary-text, #fff);
  font-size: 12px;
  line-height: 18px;
  min-width: 18px;
  text-align: center;
  font-weight: normal;
}
.ap-field-hint, .ap-field-error { font-size: 11px; margin: 4px 0 0; }
.ap-checkbox { display: flex; align-items: center; gap: 6px; label { display: flex; gap: 8px; align-items: center; cursor: pointer; } }
.ap-runai-toggle { display: flex; align-items: center; gap: 6px; margin: 0 0 8px; label { display: flex; gap: 8px; align-items: center; cursor: pointer; font-weight: 600; } }
// Next to the checkbox this sits outside the <label>, so it must not look clickable-to-toggle.
.ap-info { color: var(--muted); cursor: help; font-size: 14px; }
.ap-info:hover { color: var(--primary); }
.ap-title .ap-info { font-size: 16px; }
.ap-table { width: 100%; border-collapse: collapse; th, td { text-align: left; padding: 9px 10px; border-bottom: 1px solid var(--border); vertical-align: top; } th { font-size: 12px; text-transform: uppercase; color: var(--muted); } }
.ap-num { text-align: right; }
.ap-actions { text-align: right; white-space: nowrap; }
.ap-name { font-weight: 600; }
.ap-sub { font-size: 11px; }
.ap-badge { margin-top: 3px; }
.ap-barcell { min-width: 140px; }
.ap-bar { position: relative; height: 8px; background: var(--border); border-radius: 4px; overflow: hidden; }
.ap-bar-quota { position: absolute; inset: 0 auto 0 0; background: var(--primary); opacity: 0.25; }
.ap-bar-used { position: absolute; inset: 0 auto 0 0; background: var(--primary); }
.ap-footer { margin-top: 18px; font-size: 12px; }
.ap-lede { margin: 4px 0 0; }
.ap-cluster { margin: 2px 0 0; font-size: 13px; }
.ap-name-toggle {
  background: none;
  border: 0;
  padding: 0;
  color: var(--body-text);
  font: inherit;
  font-weight: 600;
  cursor: pointer;

  .icon { font-size: 12px; color: var(--muted); }
}
.ap-details-row td { background: var(--sortable-table-accent-bg, var(--body-bg)); }
.ap-details {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 8px 24px;
  margin: 0;
  padding: 4px 0 4px 18px;

  dt { color: var(--muted); font-size: 12px; }
  dd { margin: 0; }
}
.ap-advanced-toggle {
  background: none;
  border: 0;
  padding: 0;
  font: inherit;
  font-size: 16px;
  font-weight: 600;
  color: var(--body-text);
  cursor: pointer;
  margin-bottom: 8px;

  .icon { font-size: 12px; color: var(--muted); }
}
.ap-table td { vertical-align: top; }
.ap-quota-total { font-size: 13px; font-weight: 400; margin-left: 12px; }
.ap-name-toggle, .ap-advanced-toggle {
  &:focus:not(:focus-visible) { outline: none; box-shadow: none; }
}
.ap-advanced-toggle .text-muted { font-weight: 400; font-size: 13px; margin-left: 4px; }
</style>
