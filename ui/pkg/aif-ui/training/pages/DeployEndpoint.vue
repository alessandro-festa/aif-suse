<script lang="ts">
/* eslint-disable vue/no-undef-properties -- form, facts, loadFacts and the rest come from Submit via `extends`, which the rule does not follow */
// Deploy an inference profile: create an AIWorkload for the profile's SUSE AI Factory blueprint.
//
// Submit supplies the cluster facts (GPUs, DRA claims, node headroom, storage classes, secrets) and
// the namespace pickers; this page replaces the checks with inference.ts, the Deploy action with an
// AIWorkload create, and the template. The user picks a project and a name; on aif-operator 2.2.0
// the blueprint installs as written, so what gets deployed is shown read-only.
//
// With compute pools, the user picks an AI project and one of its pools: the page moves to the
// pool's cluster (its GPUs and nodes are the facts), and the AIWorkload is recorded on local in the
// project's namespace there, targeting the project's namespace on the pool's cluster. Profiles,
// blueprints and AIWorkloads are always read from local.
import StatusPill from '../components/StatusPill.vue';
import { defineComponent } from 'vue';
import jsyaml from 'js-yaml';
import Submit from './Submit.vue';
import ReadinessPanel from '../components/ReadinessPanel.vue';
import { ENDPOINTS_PAGE, PRODUCT_NAME, PROFILES_PAGE } from '../config';
import { Check } from '../preflight';
import {
  aiWorkloadFor, BlueprintSummary, endpointUrl, findBlueprint, inferenceChecks, InferenceFacts,
  summarizeBlueprint
} from '../inference';
import {
  createAIWorkload, LOCAL_CLUSTER, localAIWorkloads, localBlueprints, localProfileConfigMaps, poolLabel, projectNamespace
} from '../placement';
import { Profile, profilesFrom } from '../profiles';
import { Readiness, readiness } from '../readiness';
import { loadClusterLabel } from '../cluster';

export default defineComponent({
  name:       'TrainingJobDeployEndpoint',
  extends:    Submit,
  components: { StatusPill, ReadinessPanel },

  data() {
    return {
      profile:        null as Profile | null,
      profilesLoaded: false,
      inf:            {
        aifInstalled: false, blueprints: [], workloads: [], gpuDeviceMemory: 0
      } as InferenceFacts,
      deployError: '' as string,
      clusterName: '',
    };
  },

  async fetch() {
    loadClusterLabel(this.$store, String(this.$route.params.cluster || 'local')).then((l: string) => {
      this.clusterName = l;
    });
    await this.loadPools();
    const cms = await localProfileConfigMaps(this.$store).catch(() => []);

    this.profile = profilesFrom(cms, (s: string) => jsyaml.load(s)).find((p: Profile) => p.name === this.$route.query.profile && p.type === 'inference') || null;
    this.profilesLoaded = true;
    await this.loadFacts();
    if (this.profile) {
      // endpoint names are per project, so the profile name is a sensible first suggestion
      this.form.releaseName = this.profile.name.slice(0, 42);
    }
  },

  computed: {
    summary(): { fails: number; warns: number; ok: boolean } {
      const fails = this.checks.filter((c: Check) => c.severity === 'fail').length;

      return {
        fails, warns: this.checks.filter((c: Check) => c.severity === 'warn').length, ok: !!this.profile && fails === 0
      };
    },

    checks(): Check[] {
      if (!this.profile) {
        return [];
      }

      const checks = inferenceChecks({ namespace: this.form.namespace, name: this.form.releaseName }, this.profile.blueprint, this.facts, { ...this.inf, gpuDeviceMemory: this.facts.gpuDeviceMemory }, this.profile.requiredSecrets);

      // no placement controller for endpoints: with pools, the user picks one
      if (this.pools.length && !this.poolName) {
        checks.unshift({
          id: 'pool', severity: 'fail', title: this.projectName ? 'Pick a compute pool' : 'Pick an AI project', detail: ''
        });
      }

      return checks;
    },

    /** One of the pools on the clusters the project spans. Endpoints are not placed automatically. */
    poolOptions(): { label: string; value: string }[] {
      const spans = new Set((this.selectedProject?.spec?.clusters || []).map((c: any) => c.clusterId));

      return this.pools.filter((p: any) => spans.has(p.clusterId)).map((p: any) => ({ label: poolLabel(p), value: p.name }));
    },

    bp(): BlueprintSummary | null {
      const ref = this.profile?.blueprint;
      const obj = ref ? findBlueprint(this.inf.blueprints, ref) : null;

      return ref && obj ? summarizeBlueprint(obj, ref) : null;
    },

    ready(): Readiness {
      // readiness words headroom in terms of the per-replica request, which comes from the blueprint
      return readiness(this.checks, {
        ...this.form, cpuRequest: this.bp?.cpu || '', memRequest: this.bp?.memory || ''
      });
    },

    submitDisabled(): boolean {
      return !this.summary.ok;
    },

    profileFacts(): string[] {
      const s = this.bp;

      if (!s) {
        return [];
      }

      return [
        this.profile?.framework || '',
        s.model,
        `${ s.gpusPerReplica } GPU per replica${ s.dra ? ' (DRA)' : '' }`,
        `${ s.replicas } replica${ s.replicas === 1 ? '' : 's' }`,
        s.maxModelLen ? `${ s.maxModelLen }-token context` : '',
      ].filter(Boolean);
    },

    deployedRows(): { label: string; value: string }[] {
      const s = this.bp;

      if (!s || !this.profile?.blueprint) {
        return [];
      }

      return [
        { label: 'Blueprint', value: `${ s.displayName } ${ this.profile.blueprint.version }` },
        { label: 'Components', value: s.components.join(', ') },
        { label: 'Model', value: s.model },
        { label: 'GPU per replica', value: `${ s.gpusPerReplica }${ s.dra ? ' through DRA' : ' (nvidia.com/gpu)' }` },
        { label: 'Replicas', value: String(s.replicas) },
        { label: 'CPU / memory per replica', value: `${ s.cpu } / ${ s.memory }` },
        { label: 'Model cache', value: s.cacheSize ? `${ s.cacheSize } on ${ s.storageClass || 'the default class' }` : 'none' },
        { label: 'Endpoint (in cluster)', value: this.form.namespace ? `${ endpointUrl(s, this.form.namespace) }${ s.gateway ? ' (LiteLLM gateway; needs a LiteLLM key)' : '' }` : '—' },
      ];
    },

    totals(): { label: string; value: string }[] {
      const s = this.bp;

      if (!s) {
        return [];
      }

      return [
        { label: 'GPUs', value: String(s.gpusPerReplica * s.replicas) },
        { label: 'CPU', value: String(+(Number(s.cpu) * s.replicas).toFixed(2) || s.cpu) },
        { label: 'Memory', value: s.replicas === 1 ? s.memory : `${ s.replicas } × ${ s.memory }` },
        { label: 'Model cache', value: s.cacheSize || '—' },
        { label: 'Runtime', value: 'until deleted' },
      ];
    },

    profilesRoute(): any {
      return {
        name: `c-cluster-${ PRODUCT_NAME }-${ PROFILES_PAGE }`, params: { cluster: this.$route.params.cluster }, query: { type: 'inference' }
      };
    },
  },

  methods: {
    async loadFacts() {
      await (Submit as any).methods.loadFacts.call(this);
      const cluster = String(this.$route.params.cluster || LOCAL_CLUSTER);
      let aifInstalled = true;
      const [blueprints, workloads] = await Promise.all([
        localBlueprints(this.$store).catch(() => {
          aifInstalled = false;

          return [];
        }),
        localAIWorkloads(this.$store).catch(() => []),
      ]);

      this.inf = {
        aifInstalled,
        blueprints,
        // the endpoints already installed on this cluster, by the namespace they run in
        workloads: workloads
          .filter((w: any) => (w.spec?.targetClusters?.length ? w.spec.targetClusters.includes(cluster) : cluster === LOCAL_CLUSTER))
          .map((w: any) => ({
            name: w.metadata.name, namespace: w.spec?.targetNamespace || w.metadata.namespace, blueprint: w.spec?.source?.blueprint?.name || ''
          })),
        gpuDeviceMemory: 0,
      };
    },

    async submit(done: (ok: boolean) => void) {
      this.deployError = '';
      if (this.submitDisabled || !this.profile?.blueprint) {
        done(false);

        return;
      }
      try {
        const inPool = !!this.poolName && !!this.projectName;
        const body = aiWorkloadFor(
          { namespace: this.form.namespace, name: this.form.releaseName },
          this.profile.blueprint, this.profile.name, `${ this.profile.displayName } — ${ this.form.releaseName }`,
          String(this.$route.params.cluster), inPool ? projectNamespace(this.projectName) : '',
        );

        if (inPool) {
          await createAIWorkload(this.$store, body);
        } else {
          const model = await this.$store.dispatch('cluster/create', body);

          await model.save();
        }
        done(true);
        this.$router.push({
          name: `c-cluster-${ PRODUCT_NAME }-${ ENDPOINTS_PAGE }`, params: { cluster: inPool ? LOCAL_CLUSTER : this.$route.params.cluster }, query: { tab: 'inference' }
        });
      } catch (e: any) {
        this.deployError = e?.message || e?._statusText || String(e);
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
    class="tj-deploy"
  >
    <p class="tj-crumbs text-muted">
      <router-link :to="profilesRoute">
        Catalog
      </router-link>
      <span> › Inference</span>
      <span v-if="profile"> › {{ profile.displayName }} › Deploy</span>
    </p>

    <Banner
      v-if="profilesLoaded && !profile"
      color="error"
      :label="`No inference profile named ${ $route.query.profile || '(none)' } in this cluster. Pick one from the Catalog.`"
    />

    <template v-if="profile">
      <h1 class="tj-title">
        Deploy {{ profile.displayName }}
        <StatusPill
          v-if="profile.status === 'beta'"
          status="beta"
          size="lg"
        />
      </h1>

      <section class="tj-profile-card">
        <div class="tj-profile-head">
          <div>
            <span class="tj-profile-name">{{ profile.displayName }}</span>
            <span class="text-muted"> · Inference profile</span>
          </div>
          <StatusPill :status="profile.status" />
        </div>
        <div class="tj-profile-facts">
          {{ profileFacts.join(' · ') }}
        </div>
        <div
          v-if="profile.description"
          class="text-muted"
        >
          {{ profile.description }}
        </div>
      </section>

      <Banner
        v-if="deployError"
        color="error"
        :label="deployError"
      />

      <div class="tj-grid">
        <section class="tj-form">
          <div class="tj-section">
            <h3>Basics</h3>
            <div
              v-if="pools.length"
              class="row mb-10"
            >
              <div class="col span-6">
                <LabeledSelect
                  :value="projectName"
                  :options="projectOptions"
                  label="AI project"
                  placeholder="Choose the project this endpoint belongs to"
                  @update:value="chooseProject"
                />
              </div>
              <div
                v-if="projectName"
                class="col span-6"
              >
                <LabeledSelect
                  :value="poolName"
                  :options="poolOptions"
                  label="Compute pool"
                  placeholder="Choose where the endpoint runs"
                  @update:value="choosePool"
                />
              </div>
            </div>
            <div
              v-else
              class="row mb-10"
            >
              <div class="col span-6">
                <LabeledInput
                  :value="clusterName"
                  label="Cluster"
                  mode="view"
                  tooltip="The cluster the endpoint is deployed on. To deploy to other clusters, install the blueprint from the profile menu in the Catalog."
                />
              </div>
            </div>
            <div class="row">
              <div class="col span-6">
                <LabeledInput
                  v-if="pools.length"
                  :value="poolName ? `${ form.namespace } on ${ clusterName }` : '—'"
                  label="Runs in"
                  mode="view"
                  tooltip="The AI project's namespace on the pool's cluster."
                />
                <LabeledSelect
                  v-else
                  v-model:value="form.namespace"
                  label="Project"
                  tooltip="The project namespace the endpoint runs in."
                  :options="namespaceOptions"
                  :searchable="true"
                />
              </div>
              <div class="col span-6">
                <LabeledInput
                  v-model:value="form.releaseName"
                  label="Endpoint name"
                  tooltip="Lowercase letters, numbers and hyphens."
                />
              </div>
            </div>
          </div>

          <div class="tj-section">
            <h3>What gets deployed</h3>
            <p class="text-muted tj-note">
              Set by the profile. Choosing the model, GPUs and replicas per endpoint needs SUSE AI Factory 2.3.
            </p>
            <table class="tj-kv">
              <tr
                v-for="r in deployedRows"
                :key="r.label"
              >
                <th>{{ r.label }}</th>
                <td>{{ r.value }}</td>
              </tr>
            </table>
          </div>

          <div class="tj-form-foot">
            <span />
            <div class="tj-form-actions">
              <router-link
                :to="profilesRoute"
                class="btn role-secondary"
              >
                Cancel
              </router-link>
              <AsyncButton
                mode="create"
                :disabled="submitDisabled"
                action-label="Deploy"
                waiting-label="Deploying…"
                success-label="Deployed"
                @click="submit"
              />
            </div>
          </div>
        </section>

        <aside class="tj-side">
          <ReadinessPanel
            :ready="ready"
            :checks="checks"
            @recheck="loadFacts()"
          />
          <div class="tj-panel">
            <h2>Resource summary</h2>
            <table class="tj-kv">
              <tr
                v-for="r in totals"
                :key="r.label"
              >
                <th>{{ r.label }}</th>
                <td>{{ r.value }}</td>
              </tr>
            </table>
            <p class="text-muted tj-sub">
              Held for as long as the endpoint runs.
            </p>
          </div>
        </aside>
      </div>
    </template>
  </div>
</template>

<style lang="scss" scoped>
.tj-deploy { padding: 0 20px 20px; }
.tj-crumbs { margin: 10px 0 4px; }
.tj-title { margin: 0 0 12px; }
.tj-profile-card { border: 1px solid var(--border); border-left: 4px solid var(--primary); border-radius: var(--border-radius); padding: 12px 16px; margin-bottom: 16px; display: flex; flex-direction: column; gap: 4px; }
.tj-profile-head { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
.tj-profile-name { font-size: 16px; font-weight: 600; }
.tj-profile-facts { font-size: 13px; }
.tj-grid { display: grid; grid-template-columns: minmax(0, 2fr) minmax(300px, 1fr); gap: 24px; align-items: start; }
@media (max-width: 1100px) { .tj-grid { grid-template-columns: 1fr; } }
.tj-grid > * { min-width: 0; }
.tj-section { border-top: 1px solid var(--border); padding: 12px 0 4px; h3 { font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); margin: 0 0 10px; } }
.tj-section:first-child { border-top: none; padding-top: 0; }
.tj-form .row { margin-bottom: 12px; }
.tj-note { font-size: 12px; margin: -4px 0 8px; }
.tj-kv { font-size: 13px; th { text-align: left; font-weight: normal; color: var(--muted); padding: 2px 16px 2px 0; white-space: nowrap; vertical-align: top; } td { padding: 2px 0; overflow-wrap: anywhere; } }
.tj-form-foot { border-top: 1px solid var(--border); margin-top: 12px; padding-top: 12px; display: flex; justify-content: space-between; align-items: center; gap: 12px; }
.tj-form-actions { display: flex; gap: 8px; }
.tj-side { display: flex; flex-direction: column; gap: 16px; position: sticky; top: 10px; }
.tj-panel { border: 1px solid var(--border); border-radius: var(--border-radius); padding: 12px 16px; background: var(--body-bg);
  h2 { font-size: 13px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); margin: 4px 0 8px; } }
.tj-sub { font-size: 12px; margin: 2px 0 0; }
</style>
