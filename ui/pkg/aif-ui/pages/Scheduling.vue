<script>
import Tabbed from '@shell/components/Tabbed';
import Tab from '@shell/components/Tabbed/Tab';
import LabeledSelect from '@shell/components/form/LabeledSelect';
import { listClusters } from '../services/scheduling/api';
import ReadinessTab from '../components/scheduling/ReadinessTab.vue';
import QueuesTab from '../components/scheduling/QueuesTab.vue';
import ProjectsTab from '../components/scheduling/ProjectsTab.vue';
import RuntimesTab from '../components/scheduling/RuntimesTab.vue';
import JobsTab from '../components/scheduling/JobsTab.vue';

// Workloads > Scheduling: administer Kubeflow Trainer jobs that KAI schedules. Data scientists
// submit from notebooks (Kubeflow SDK + aif-training); this page is for the admin.
export default {
  name:       'SchedulingPage',
  components: {
    Tabbed, Tab, LabeledSelect, ReadinessTab, QueuesTab, ProjectsTab, RuntimesTab, JobsTab
  },

  data() {
    return { clusters: [], cluster: 'local' };
  },

  async mounted() {
    this.clusters = await listClusters(this.$store);
  },

  computed: {
    clusterOptions() {
      return this.clusters.map((c) => ({ label: c.label, value: c.id }));
    }
  }
};
</script>

<template>
  <div class="scheduling">
    <header class="head">
      <div>
        <h1>Scheduling</h1>
        <p class="sub">
          Training runs are Kubeflow TrainJobs, submitted from notebooks with the Kubeflow SDK and
          scheduled by KAI in each project's queue. Here you set the queues and quotas, decide which
          namespaces may train, who may train there, and follow the runs.
        </p>
      </div>
      <LabeledSelect
        v-model:value="cluster"
        class="cluster"
        label="Cluster"
        :options="clusterOptions"
      />
    </header>

    <Tabbed
      :key="cluster"
      default-tab="readiness"
      :use-hash="false"
      :show-extension-tabs="false"
    >
      <Tab
        name="readiness"
        label="Readiness"
        :weight="5"
      >
        <ReadinessTab :cluster="cluster" />
      </Tab>
      <Tab
        name="queues"
        label="Queues & Quotas"
        :weight="4"
      >
        <QueuesTab :cluster="cluster" />
      </Tab>
      <Tab
        name="projects"
        label="Projects"
        :weight="3"
      >
        <ProjectsTab :cluster="cluster" />
      </Tab>
      <Tab
        name="runtimes"
        label="Runtimes"
        :weight="2"
      >
        <RuntimesTab :cluster="cluster" />
      </Tab>
      <Tab
        name="jobs"
        label="Training Jobs"
        :weight="1"
      >
        <JobsTab :cluster="cluster" />
      </Tab>
    </Tabbed>
  </div>
</template>

<style lang="scss" scoped>
.scheduling { padding: 0 0 24px; }
.head { display: flex; justify-content: space-between; align-items: flex-start; gap: 24px; margin-bottom: 16px; }
.sub { color: var(--muted); max-width: 820px; margin-top: 4px; }
.cluster { width: 260px; flex: none; }
</style>
