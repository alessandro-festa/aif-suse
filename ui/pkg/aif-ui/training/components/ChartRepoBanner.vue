<script lang="ts">
/**
 * "This cluster cannot install the job chart", and the button that fixes it.
 *
 * This is a component rather than part of one page because the two halves used to live apart: the
 * Submit page is where you find out (preflight fails with "Job template not found") and the
 * Projects page is where the fix was, so all the failure could do was send you somewhere else to
 * read a second explanation of the same thing. The repo is one cluster-scoped object; offering it
 * at the point of failure is the whole point.
 *
 * It reads its own ClusterRepos instead of taking them as a prop so a page can drop it in without
 * extra wiring. findAll is store-cached, so the second page to mount it does not re-fetch.
 */
import { defineComponent } from 'vue';
import Banner from '@components/Banner/Banner.vue';
import LabeledInput from '@components/Form/LabeledInput/LabeledInput.vue';
import { CHART_REPO, CHART_REPO_URL, TYPES } from '../config';
import {
  ABSENT, ChartRepoState, canCreateChartRepo, chartRepoManifest, chartRepoState, urlMismatch,
} from '../chartrepo';

export default defineComponent({
  name:       'ChartRepoBanner',
  components: { Banner, LabeledInput },
  emits:      ['added'],

  data() {
    return {
      state:  { ...ABSENT } as ChartRepoState,
      url:    CHART_REPO_URL,
      canAdd: false,
      busy:   false,
      error:  '',
    };
  },

  computed: {
    /**
     * What to say about the chart in this cluster. Four states, because they need four different
     * actions: fine, missing, pointing somewhere unreachable, and present-but-not-ready.
     */
    issue(): null | { color: string; label: string; offerAdd: boolean } {
      const r = this.state;

      // A repo that has already downloaded proved its URL was reachable, whatever that URL is --
      // including the in-cluster Service address the documented install method uses, which will
      // never equal CHART_REPO_URL's public sample default. Checking the mismatch here would flag
      // every correctly-installed cluster with "might never download" about a chart it already has.
      if (r.ready) {
        return null;
      }
      if (!r.present) {
        return {
          color:    'warning',
          label:    `This cluster has no "${ CHART_REPO }" chart repository, so jobs cannot be submitted from it and preflight will report "Job template not found". Enter where the training chart is published (an OCI or HTTP chart repository). Chart repositories are per-cluster and Rancher does not replicate them, so adding one here affects only this cluster.`,
          offerAdd: true,
        };
      }
      if (urlMismatch(r, CHART_REPO_URL)) {
        // Almost always catalog.yaml's in-cluster Service URL copied into a downstream cluster,
        // where it resolves to nothing. Not something to silently overwrite.
        return {
          color:    'warning',
          label:    `"${ CHART_REPO }" here points at ${ r.url }, not ${ CHART_REPO_URL }. If that address is not reachable from this cluster the chart will never download.`,
          offerAdd: false,
        };
      }

      return {
        color: 'info', label: `"${ CHART_REPO }" is not ready yet: ${ r.message }`, offerAdd: false
      };
    },

    /** The one-liner for someone without permission to create it here. */
    command(): string {
      return `kubectl --context <this cluster> create -f - <<'EOF'\napiVersion: catalog.cattle.io/v1\nkind: ClusterRepo\nmetadata:\n  name: ${ CHART_REPO }\nspec:\n  url: ${ this.url }\nEOF`;
    },
  },

  async mounted() {
    await this.load();
  },

  methods: {
    async load() {
      const schema = this.$store.getters['cluster/schemaFor'](TYPES.CLUSTER_REPO);

      // No schema means no permission to list them. Staying quiet beats claiming the repo is
      // missing when the truth is that this user cannot see it.
      if (!schema) {
        this.state = { ...ABSENT, ready: true };
        this.canAdd = false;

        return;
      }
      try {
        const repos = await this.$store.dispatch('cluster/findAll', { type: TYPES.CLUSTER_REPO });

        this.state = chartRepoState(repos, CHART_REPO);
        this.canAdd = canCreateChartRepo(schema);
      } catch {
        this.state = { ...ABSENT, ready: true };
      }
    },

    /**
     * Create the chart repo in the cluster being viewed. Deliberately scoped to this cluster only:
     * the extension is cluster-scoped, so the clusters that need the chart are exactly the ones
     * someone opened it in. There is no list of clusters to keep correct and no cluster without
     * GPUs quietly acquiring a repo it will never use.
     */
    async add() {
      this.busy = true;
      this.error = '';
      try {
        const repo = await this.$store.dispatch('cluster/create', chartRepoManifest(CHART_REPO, this.url));

        await repo.save();
        // Downloading is asynchronous; load() re-reads the conditions, and the banner keeps saying
        // "not ready yet" with the cluster's own message until it is.
        await this.load();
        this.$emit('added');
      } catch (e: any) {
        this.error = `Could not create the chart repository: ${ e?.message || e }`;
      } finally {
        this.busy = false;
      }
    },
  },
});
</script>

<template>
  <Banner
    v-if="issue"
    :color="issue.color"
    class="tj-chartrepo"
  >
    <div class="tj-chartrepo-body">
      <span>{{ issue.label }}</span>
      <template v-if="issue.offerAdd && canAdd">
        <div class="tj-chartrepo-add">
          <LabeledInput
            v-model:value="url"
            label="Chart repository URL"
            :disabled="busy"
            tooltip="Editable for air-gapped sites: point it at a registry this cluster can reach."
          />
          <button
            class="btn role-primary btn-sm"
            :disabled="busy || !url"
            @click="add()"
          >
            <i class="icon icon-plus" /> Add to this cluster
          </button>
        </div>
      </template>
      <!-- ClusterRepo is cluster-scoped, so a project owner cannot create one. Showing the
           command beats showing a button that 403s. -->
      <pre
        v-else-if="issue.offerAdd"
        class="tj-chartrepo-cmd"
      >{{ command }}</pre>
      <span
        v-if="error"
        class="text-error"
      >{{ error }}</span>
    </div>
  </Banner>
</template>

<style lang="scss" scoped>
.tj-chartrepo-body { display: flex; flex-direction: column; gap: 10px; }
.tj-chartrepo-add { display: flex; gap: 8px; align-items: flex-end; max-width: 720px; > *:first-child { flex: 1; } }
.tj-chartrepo-cmd { margin: 0; font-size: 11px; white-space: pre-wrap; }
</style>
