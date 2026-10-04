<script lang="ts">
// The files on a run's kept checkpoint volume, under the volume in the run's detail, each with a
// download. Read by a short-lived Job (see volumefiles.ts), so it takes a few seconds.
import { defineComponent, PropType } from 'vue';
import type { CheckpointVolume } from '../checkpoints';
import {
  MAX_DOWNLOAD_BYTES, VolumeFile, decodeFile, fileScript, formatBytes, listScript, parseListing, runVolumeJob
} from '../volumefiles';

export default defineComponent({
  name:  'VolumeFiles',
  props: { checkpoint: { type: Object as PropType<CheckpointVolume>, required: true } },

  data() {
    return {
      loading: true, error: '', files: [] as VolumeFile[], busy: '' as string, fileError: '' as string,
    };
  },

  computed: {
    cluster(): string {
      return String(this.$route.params.cluster || 'local');
    },
  },

  mounted() {
    this.load();
  },

  methods: {
    async load() {
      this.loading = true;
      this.error = '';
      try {
        this.files = parseListing(await runVolumeJob(this.$store, this.cluster, this.checkpoint.namespace, this.checkpoint.name, listScript()));
      } catch (e: any) {
        this.error = this.explain(e);
      } finally {
        this.loading = false;
      }
    },

    async download(f: VolumeFile) {
      this.busy = f.path;
      this.fileError = '';
      try {
        const d = decodeFile(await runVolumeJob(this.$store, this.cluster, this.checkpoint.namespace, this.checkpoint.name, fileScript(f.path)));

        if (!d.ok) {
          this.fileError = d.reason === 'missing' ? `${ f.path } is no longer on the volume.` : d.reason === 'too-big' ? this.tooBig(f) : `Copying ${ f.path } did not complete; try again.`;

          return;
        }
        const url = URL.createObjectURL(new Blob([d.bytes], { type: 'application/octet-stream' }));
        const a = document.createElement('a');

        a.href = url;
        a.download = f.path.split('/').pop() || 'file';
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 10000);
      } catch (e: any) {
        this.fileError = this.explain(e);
      } finally {
        this.busy = '';
      }
    },

    canDownload(f: VolumeFile): boolean {
      return f.size <= MAX_DOWNLOAD_BYTES;
    },

    tooBig(f: VolumeFile): string {
      return `${ f.path } is ${ formatBytes(f.size) }; downloads here are limited to ${ formatBytes(MAX_DOWNLOAD_BYTES) }. Mount ${ this.checkpoint.name } in a pod and use kubectl cp.`;
    },

    explain(e: any): string {
      const status = e?._status || e?.status || e?.response?.status;
      const msg = e?.message || e?.data?.message || String(e);

      return status === 403 ? `You cannot create Jobs in ${ this.checkpoint.namespace }, which reading the volume needs (AI Job Submitter allows it).` : msg;
    },

    formatBytes(n: number): string {
      return formatBytes(n);
    },

    when(d: Date | null): string {
      return d ? d.toLocaleString() : '—';
    },
  },
});
</script>

<template>
  <div class="vf">
    <div
      v-if="loading"
      class="text-muted"
    >
      <i class="icon icon-spinner icon-spin" /> Reading {{ checkpoint.name }}… (a short-lived pod mounts it read-only)
    </div>
    <div
      v-else-if="error"
      class="text-error"
    >
      {{ error }}
      <button
        class="btn role-tertiary btn-sm"
        type="button"
        @click="load"
      >
        Retry
      </button>
    </div>
    <div
      v-else-if="!files.length"
      class="text-muted"
    >
      No files on the volume.
    </div>
    <table
      v-else
      class="vf-table"
    >
      <tr
        v-for="f in files"
        :key="f.path"
      >
        <td class="vf-path">
          {{ f.path }}
        </td>
        <td class="text-muted">
          {{ formatBytes(f.size) }}
        </td>
        <td class="text-muted">
          {{ when(f.modified) }}
        </td>
        <td class="vf-right">
          <button
            class="btn role-tertiary btn-sm"
            type="button"
            :disabled="!!busy || !canDownload(f)"
            :title="canDownload(f) ? `Download ${ f.path }` : tooBig(f)"
            @click="download(f)"
          >
            <i :class="['icon', busy === f.path ? 'icon-spinner icon-spin' : 'icon-download']" /> Download
          </button>
        </td>
      </tr>
    </table>
    <div
      v-if="fileError"
      class="text-error vf-file-error"
    >
      {{ fileError }}
    </div>
  </div>
</template>

<style lang="scss" scoped>
.vf { margin: 2px 0 2px 0; padding: 8px 10px; border: 1px solid var(--border); border-radius: var(--border-radius); font-size: 13px; }
.vf-table { width: 100%; td { padding: 2px 16px 2px 0; } }
.vf-path { font-family: monospace; font-size: 12px; word-break: break-all; }
.vf-right { text-align: right; padding-right: 0 !important; }
.vf-file-error { margin-top: 6px; }
</style>
