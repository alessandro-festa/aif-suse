import { PRODUCT_SLUG } from '../utils/constants';
// Generic sample configuration. Point these at whatever chart/repo hosts the job template.
export { EXTENSION_VERSION } from '../utils/constants';

// The training pages are part of the AI Factory product: their routes are c-cluster-<product>-<page>.
export const PRODUCT_NAME = PRODUCT_SLUG;
export const SUBMIT_PAGE = 'submit';
export const JOBS_PAGE = 'jobs';
export const PROJECTS_PAGE = 'projects';
export const PROFILES_PAGE = 'profiles';
export const INFERENCE_PROFILE_PAGE = 'inference-profile'; // create or edit an inference profile
export const DEPLOY_PAGE = 'deploy'; // reached from a profile's Deploy button, not the nav
export const ENDPOINT_PAGE = 'endpoint'; // deploy an inference profile; reached from its card
// Not 'endpoints': Rancher's side nav treats a virtual type named like a resource type as that type
// and shows its count, so the page showed how many core Endpoints objects the cluster has.
export const ENDPOINTS_PAGE = 'ai-workloads';

// Helm chart that renders one training run (Indexed Job + torchrun). The extension finds it
// in whichever Rancher ClusterRepo publishes it, so only the chart name is fixed here.
export const CHART_NAME = 'gpu-train-job';
// Repository the chart must come from. Charts are matched by name across all repos a user can see,
// so without pinning, a second repo publishing a chart of the same name could be picked up.
// '' = accept any single repo but refuse when more than one publishes the chart.
export const CHART_REPO = 'gpu-train-charts';
export const CHART_REPO_TYPE = 'cluster';
// Where the training chart (charts/gpu-train-job) is published, with the operator at the same
// version. The operator chart creates the gpu-train-charts ClusterRepo pointing here; the banner
// offers it, in an editable field (a mirror, an air-gapped registry), where that repository is missing.
export const CHART_REPO_URL = 'oci://ghcr.io/suse/chart/gpu-train-job';
export const JOB_LABEL = 'app.kubernetes.io/name';
export const JOB_LABEL_VALUE = CHART_NAME;

// Resource types the pre-flight inspects (Steve/Rancher API type names)
export const TYPES = {
  NAMESPACE:               'namespace',
  NODE:                    'node',
  JOB:                     'batch.job',
  APP:                     'catalog.cattle.io.app',
  CLUSTER_REPO:            'catalog.cattle.io.clusterrepo',
  LOCAL_QUEUE:             'kueue.x-k8s.io.localqueue',
  CLUSTER_QUEUE:           'kueue.x-k8s.io.clusterqueue',
  WORKLOAD:                'kueue.x-k8s.io.workload',
  KAI_QUEUE:               'scheduling.run.ai.queue',
  // Run:AI is built on KAI and ships the same queue CRD, so KAI_QUEUE cannot tell them apart. The
  // commercial product additionally installs the run.ai API group; KAI on its own does not. This
  // is the only difference the dashboard can see, and it decides schedulerName -- pick wrong and
  // every pod sits Pending with nothing written to it to say why.
  RUNAI_CLUSTER:           'run.ai.cluster',
  // A Run:AI Project is what provisions a namespace: its controller writes the ~26 RoleBindings
  // that let the scheduler create a BindRequest there. `status.namespace` says which namespace the
  // Project claims, and a namespace no Project claims cannot run a Run:AI workload no matter how
  // it is labelled.
  RUNAI_PROJECT:           'run.ai.project',
  DEVICE_CLASS:            'resource.k8s.io.deviceclass',
  RESOURCE_SLICE:          'resource.k8s.io.resourceslice',
  RESOURCE_CLAIM:          'resource.k8s.io.resourceclaim',
  RESOURCE_CLAIM_TEMPLATE: 'resource.k8s.io.resourceclaimtemplate',
  COMPUTE_DOMAIN:          'resource.nvidia.com.computedomain',
  POD:                     'pod',
  PVC:                     'persistentvolumeclaim',
  STORAGE_CLASS:           'storage.k8s.io.storageclass',
  // Tier-1 GPU quota on clusters with no queueing scheduler installed
  RESOURCE_QUOTA:          'resourcequota',
  // Kubeflow distributed training. KAI's PodGrouper gang-schedules these without extra config.
  PYTORCH_JOB:             'kubeflow.org.pytorchjob',
  // Rancher management types live in the 'management' store, not 'cluster'
  RANCHER_PROJECT:         'management.cattle.io.project',
  PRTB:                    'management.cattle.io.projectroletemplatebinding',
};
export const CD_CHANNEL_DEVICE_CLASS = 'compute-domain-default-channel.nvidia.com';
export const CD_KUEUE_RESOURCE = 'compute-domain-channel'; // Kueue deviceClassMappings name for the channel class

export const GPU_RESOURCE = 'nvidia.com/gpu';
export const GPU_DEVICE_CLASS = 'gpu.nvidia.com';
