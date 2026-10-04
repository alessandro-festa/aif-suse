<script lang="ts">
// The detail under a Workloads row (what the Jobs page used to show). Training: the Job, scheduler
// and queue, Kueue admission, completions, image, a badge per rank linking to its pod, and logs.
// Inference: the blueprint, the endpoint URL, and each pod the blueprint installed, by name, linking
// to its pod page, with its logs. Both: YAML and Delete (handled by the page).
import { defineComponent, PropType } from 'vue';
import BadgeState from '@components/BadgeState/BadgeState.vue';
import VolumeFiles from './VolumeFiles.vue';
import { podRank, primaryPod } from '../pods';
import { podRole, Run } from '../runs';
import type { CheckpointVolume } from '../checkpoints';
import { parseResult, reportResult, RunResult } from '../results';
import { readPodLog } from '../podlog';
import { describeLatest, isStarting, podEvents } from '../podevents';

export default defineComponent({
  name:       'RunDetail',
  components: { BadgeState, VolumeFiles },
  props:      {
    run:        { type: Object as PropType<Run>, required: true },
    checkpoint: { type: Object as PropType<CheckpointVolume | null>, default: null },
  },
  emits: ['yaml', 'remove', 'copy', 'remove-checkpoint'],

  data() {
    return {
      rankMenu: false, rankMenuStyle: {} as Record<string, string>, result: null as RunResult | null, browsing: false,
      // what each pod that has not started yet is doing: its newest event
      setup:    {} as Record<string, { text: string; warning: boolean }>,
      setupTimer: null as ReturnType<typeof setInterval> | null,
    };
  },

  computed: {
    t0(): any {
      return this.run.training;
    },

    // Rank 0 prints the run's own output; the others echo it at best.
    logsPod(): any {
      return primaryPod(this.run.pods);
    },
    logsKey(): string {
      return `${ this.logsPod?.metadata?.name || '' }/${ this.logsPod?.status?.phase || '' }/${ this.kept ? 'kept' : '' }`;
    },
    // the pods still being set up (scheduled, pulling, creating); their events say what is happening
    startingPods(): any[] {
      return (this.run.pods || []).filter((p: any) => isStarting(p));
    },
    startingKey(): string {
      return this.startingPods.map((p: any) => p.metadata?.name).join(',');
    },
    // the result the run's AIJob kept when it finished; it outlives the pods
    kept(): RunResult | null {
      return reportResult(this.run.obj); // only an AIJob has status.report
    },
  },

  watch: {
    // a test or benchmark run reports its results in its log; read them when the panel opens,
    // and again when the run moves on (its pod finishes)
    logsKey: { immediate: true, handler() { this.loadResult(); } },
    startingKey: { immediate: true, handler(key: string) { this.watchSetup(!!key); } },
  },

  beforeUnmount() {
    this.watchSetup(false);
  },

  methods: {
    watchSetup(on: boolean) {
      if (this.setupTimer) {
        clearInterval(this.setupTimer);
        this.setupTimer = null;
      }
      if (!on) {
        this.setup = {};

        return;
      }
      this.loadSetup();
      this.setupTimer = setInterval(() => this.loadSetup(), 5000);
    },

    async loadSetup() {
      const cluster = encodeURIComponent(String(this.$route.params.cluster || 'local'));
      const out: Record<string, { text: string; warning: boolean }> = {};

      await Promise.all(this.startingPods.map(async(p: any) => {
        const ns = encodeURIComponent(p.metadata.namespace);
        const sel = encodeURIComponent(`involvedObject.name=${ p.metadata.name }`);

        try {
          const res = await this.$store.dispatch('cluster/request', { url: `/k8s/clusters/${ cluster }/api/v1/namespaces/${ ns }/events?fieldSelector=${ sel }` });
          const line = describeLatest(podEvents(res?.items || res?.data?.items || []));

          if (line) {
            out[p.metadata.name] = line;
          }
        } catch (e) {
          // events not readable here: the badge alone, as before
        }
      }));
      this.setup = out;
    },

    async loadResult() {
      if (this.kept) {
        this.result = this.kept;

        return;
      }
      const pod = this.logsPod;

      if (this.run.type !== 'training' || !pod || !['Running', 'Succeeded', 'Failed'].includes(pod.status?.phase)) {
        return;
      }
      try {
        const log = await readPodLog(this.$store, String(this.$route.params.cluster || 'local'), pod.metadata.namespace, pod.metadata.name, 'tailLines=400');

        this.result = parseResult(log);
      } catch (e) {
        this.result = null; // no log to read (the pod is gone, or logs are not readable here)
      }
    },

    podRank(pod: any): string {
      return podRank(pod);
    },

    podRole(pod: any): string {
      return podRole(pod);
    },

    podPhase(pod: any): string {
      if (pod?.metadata?.deletionTimestamp) {
        return 'Terminating';
      }
      const waiting = (pod?.status?.containerStatuses || []).find((c: any) => c.state?.waiting)?.state?.waiting?.reason;

      if (waiting && waiting !== 'ContainerCreating') {
        return waiting; // CrashLoopBackOff, ImagePullBackOff: the phase alone says Pending/Running
      }
      const ready = (pod?.status?.containerStatuses || []).every((c: any) => c.ready);

      return pod?.status?.phase === 'Running' && !ready ? 'Starting' : pod?.status?.phase || 'Pending';
    },

    phaseClass(p: string): string {
      return ({
        Running: 'bg-info', Succeeded: 'bg-success', Complete: 'bg-success', Failed: 'bg-error', Pending: 'bg-warning', Starting: 'bg-warning', Terminating: 'bg-disabled'
      } as Record<string, string>)[p] || (/BackOff|Err|Error/.test(p) ? 'bg-error' : 'bg-disabled');
    },

    // Rancher's own log viewer (follows, searches, downloads, switches containers), opened on one pod.
    openLogs(pod: any) {
      this.rankMenu = false;
      pod?.openLogs?.();
    },

    toggleRankMenu(ev: MouseEvent) {
      this.rankMenu = !this.rankMenu;
      if (this.rankMenu) {
        // fixed, from the caret's rect, so the table's container cannot clip it
        const rect = (ev.currentTarget as HTMLElement).getBoundingClientRect();
        const height = 8 + this.run.pods.length * 24;
        const below = window.innerHeight - rect.bottom > height + 8;

        this.rankMenuStyle = { top: `${ below ? rect.bottom + 2 : rect.top - height - 2 }px`, left: `${ rect.right - 96 }px` };
        window.setTimeout(() => document.addEventListener('click', () => {
          this.rankMenu = false;
        }, { once: true }), 0);
      }
    },

    shortImage(image: string): string {
      const trimmed = (image || '').split('@')[0];

      return trimmed.split('/').pop() || trimmed;
    },
  },
});
</script>

<template>
  <div class="tj-detail">
    <!-- ======== training ======== -->
    <template v-if="run.type === 'training' && t0">
      <div class="tj-facts">
        <div>
          <span class="tj-k">Job</span>
          <router-link
            v-if="t0.job"
            :to="t0.job.detailLocation"
          >
            {{ t0.job.kind || 'Job' }} {{ run.name }}
          </router-link>
          <span
            v-else
            class="text-muted"
            title="The Job was cleaned up after it finished; the Helm release remains"
          >cleaned up</span>
        </div>
        <div>
          <span class="tj-k">Scheduler / queue</span>{{ t0.scheduler }}<span
            v-if="t0.queue"
            class="text-muted"
          > / {{ t0.queue }}</span>
        </div>
        <div>
          <span class="tj-k">Admitted</span>
          <span
            v-if="t0.admitted === true"
            class="text-success"
          >yes</span>
          <span
            v-else-if="t0.admitted === false"
            class="text-warning"
          >waiting</span>
          <span
            v-else
            class="text-muted"
          >—</span>
        </div>
        <div><span class="tj-k">Completions</span>{{ t0.completions }}</div>
        <div v-clean-tooltip="t0.image">
          <span class="tj-k">Image</span>{{ shortImage(t0.image) || '—' }}
        </div>
      </div>
      <div
        v-if="checkpoint"
        class="tj-pods-row"
      >
        <span class="tj-k">Checkpoint volume</span>
        {{ checkpoint.name }} · {{ checkpoint.size }}<template v-if="checkpoint.storageClass">
          · {{ checkpoint.storageClass }}
        </template>
        <span class="text-muted">&nbsp;· kept after the run</span>
        <button
          class="btn role-tertiary btn-sm tj-copy"
          type="button"
          :disabled="checkpoint.inUseBy.length > 0"
          :title="checkpoint.inUseBy.length ? `In use by ${ checkpoint.inUseBy.join(', ') }: look from that pod instead` : 'List the files on the volume, and download them'"
          :aria-expanded="browsing"
          @click="browsing = !browsing"
        >
          <i :class="['icon', browsing ? 'icon-chevron-up' : 'icon-folder']" /> {{ browsing ? 'Hide files' : 'Browse files' }}
        </button>
        <button
          class="btn role-tertiary btn-sm"
          :disabled="checkpoint.runActive || checkpoint.inUseBy.length > 0"
          :title="checkpoint.runActive ? 'The run is still active' : checkpoint.inUseBy.length ? `In use by ${ checkpoint.inUseBy.join(', ') }` : 'Delete the volume and its data'"
          @click="$emit('remove-checkpoint', checkpoint)"
        >
          <i class="icon icon-delete" /> Delete volume
        </button>
      </div>
      <VolumeFiles
        v-if="checkpoint && browsing"
        :checkpoint="checkpoint"
      />
      <div class="tj-pods-row">
        <span class="tj-k">Pods</span>
        <span
          v-if="!run.pods.length"
          class="text-muted"
        >none</span>
        <router-link
          v-for="p in run.pods"
          :key="p.id"
          :to="p.detailLocation"
          class="tj-rank"
          :title="`${ p.metadata.name }: ${ podPhase(p) }`"
        >
          <BadgeState
            :color="phaseClass(podPhase(p))"
            :label="podRank(p)"
          />
        </router-link>
      </div>
      <div
        v-for="p in startingPods"
        v-show="setup[p.metadata.name]"
        :key="`setup-${ p.metadata.name }`"
        :class="['tj-setup', { 'text-warning': setup[p.metadata.name] && setup[p.metadata.name].warning }]"
      >
        <i :class="['icon', setup[p.metadata.name] && setup[p.metadata.name].warning ? 'icon-warning' : 'icon-spinner icon-spin']" />
        <span class="text-muted">{{ podRank(p) }}</span>
        {{ setup[p.metadata.name] && setup[p.metadata.name].text }}
      </div>
    </template>

    <!-- ======== inference ======== -->
    <template v-if="run.type === 'inference' && run.inference">
      <div class="tj-facts">
        <div><span class="tj-k">Blueprint</span>{{ run.inference.blueprint }}</div>
        <div><span class="tj-k">Components</span>{{ run.inference.components.join(', ') || '—' }}</div>
        <div v-if="run.url">
          <span class="tj-k">Endpoint</span><code>{{ run.url }}</code>
          <a
            href="#"
            class="tj-copy"
            @click.prevent="$emit('copy', run.url)"
          >Copy</a>
        </div>
      </div>
      <table class="tj-pods">
        <tr v-if="!run.pods.length">
          <td class="text-muted">
            No pods yet: AI Factory is still rolling the blueprint out.
          </td>
        </tr>
        <tr
          v-for="p in run.pods"
          :key="p.id"
        >
          <td>
            <router-link :to="p.detailLocation">
              {{ p.metadata.name }}
            </router-link>
          </td>
          <td class="text-muted">
            {{ podRole(p) }}
          </td>
          <td>
            <BadgeState
              :color="phaseClass(podPhase(p))"
              :label="podPhase(p)"
            />
          </td>
          <td class="text-muted">
            {{ p.spec && p.spec.nodeName }}
          </td>
          <td class="tj-right">
            <button
              class="btn role-tertiary btn-sm"
              @click="openLogs(p)"
            >
              <i class="icon icon-list-flat" /> Logs
            </button>
          </td>
        </tr>
      </table>
    </template>

    <!-- A test or benchmark's own report: the AIF_RESULT line its script prints last. -->
    <section
      v-if="result"
      :class="['tj-result', result.status]"
    >
      <header>
        <strong>{{ result.test || 'Results' }}</strong>
        <span :class="['tj-result-status', result.status]">{{ result.status === 'pass' ? 'Passed' : 'Failed' }}</span>
      </header>
      <ul class="tj-result-checks">
        <li
          v-for="c in result.checks"
          :key="c.name"
        >
          <i :class="['icon', !c.ok ? 'icon-x text-error' : c.warn ? 'icon-warning text-warning' : 'icon-checkmark text-success']" />
          <span class="tj-result-name">{{ c.name }}</span>
          <span class="text-muted">{{ c.detail }}</span>
        </li>
      </ul>
      <dl
        v-if="Object.keys(result.metrics).length || Object.keys(result.env).length"
        class="tj-result-facts"
      >
        <div
          v-for="(v, k) in { ...result.metrics, ...result.env }"
          :key="k"
        >
          <dt>{{ k }}</dt>
          <dd>{{ v }}</dd>
        </div>
      </dl>
    </section>

    <div class="tj-buttons">
      <div
        v-if="run.type === 'training'"
        class="tj-logs"
      >
        <button
          class="btn role-tertiary btn-sm"
          :disabled="!logsPod"
          :title="logsPod ? `Follow the log of ${ logsPod.metadata.name }` : 'No pod to read logs from yet'"
          @click="openLogs(logsPod)"
        >
          <i class="icon icon-list-flat" /> Logs <span
            v-if="run.pods.length > 1"
            class="text-muted"
          >{{ podRank(logsPod) }}</span>
        </button>
        <button
          v-if="run.pods.length > 1"
          class="btn role-tertiary btn-sm tj-caret"
          title="Read a different rank"
          @click.stop="toggleRankMenu($event)"
        >
          <i class="icon icon-chevron-down" />
        </button>
        <div
          v-if="rankMenu"
          class="tj-rank-menu"
          :style="rankMenuStyle"
        >
          <button
            v-for="p in run.pods"
            :key="p.id"
            class="tj-rank-item"
            :title="p.metadata.name"
            @click="openLogs(p)"
          >
            {{ podRank(p) }}
          </button>
        </div>
      </div>
      <button
        class="btn role-tertiary btn-sm"
        title="The live objects (and, for a training run, the Helm values)"
        @click="$emit('yaml', run)"
      >
        <i class="icon icon-file" /> YAML
      </button>
      <button
        class="btn role-tertiary btn-sm"
        @click="$emit('remove', run)"
      >
        <i class="icon icon-delete" /> Delete
      </button>
    </div>
  </div>
</template>

<style lang="scss" scoped>
.tj-detail { padding: 10px 14px 12px; background: var(--box-bg, var(--body-bg)); border-left: 3px solid var(--primary); display: flex; flex-direction: column; gap: 10px; }
.tj-facts { display: flex; flex-wrap: wrap; gap: 6px 28px; font-size: 13px; code { font-size: 12px; } }
.tj-k { color: var(--muted); margin-right: 8px; }
.tj-copy { margin-left: 8px; font-size: 12px; }
.tj-pods-row { display: flex; align-items: center; flex-wrap: wrap; gap: 4px; font-size: 13px; }
.tj-rank { margin-right: 2px; }
.tj-setup { display: flex; align-items: baseline; gap: 6px; font-size: 12px; word-break: break-word; }
.tj-pods { font-size: 13px; td { padding: 3px 18px 3px 0; } }
.tj-right { text-align: right; }
.tj-buttons { display: flex; gap: 6px; align-items: center; }
.tj-logs { display: inline-flex; position: relative;
  .btn:first-child { border-top-right-radius: 0; border-bottom-right-radius: 0; }
  .tj-caret { border-top-left-radius: 0; border-bottom-left-radius: 0; padding: 0 6px; } }
.tj-rank-menu { position: fixed; z-index: 100; min-width: 96px; background: var(--dropdown-bg, var(--body-bg)); border: 1px solid var(--border); border-radius: 4px; box-shadow: 0 2px 8px rgba(0, 0, 0, 0.25); padding: 3px 0; }
.tj-rank-item { display: block; width: 100%; background: none; border: none; text-align: left; padding: 3px 10px; font-size: 12px; cursor: pointer;
  &:hover { background: var(--dropdown-hover-bg, var(--accent-btn)); } }
.tj-result {
  border: 1px solid var(--border);
  border-left: 4px solid var(--success);
  border-radius: var(--border-radius);
  padding: 10px 14px;
  &.fail { border-left-color: var(--error); }
  header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; }
}
.tj-result-status {
  font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; padding: 1px 9px; border-radius: 999px;
  background: #2f9e5b; color: #fff;
  &.fail { background: #d64545; }
}
.tj-result-checks { list-style: none; margin: 0 0 8px; padding: 0; li { display: flex; gap: 8px; align-items: baseline; padding: 2px 0; } }
.tj-result-name { font-weight: 500; }
.tj-result-facts {
  display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 4px 20px; margin: 0;
  div { display: flex; justify-content: space-between; gap: 8px; border-bottom: 1px dotted var(--border); }
  dt { color: var(--muted); }
  dd { margin: 0; font-weight: 500; }
}
</style>
