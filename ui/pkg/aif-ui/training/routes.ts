import {
  PRODUCT_NAME, AIPROJECTS_PAGE, INFERENCE_PROFILE_PAGE, SUBMIT_PAGE, JOBS_PAGE, PROJECTS_PAGE, PROFILES_PAGE, DEPLOY_PAGE, ENDPOINT_PAGE, ENDPOINTS_PAGE
} from './config';

const page = (name: string, component: () => Promise<any>) => ({
  name:      `c-cluster-${ PRODUCT_NAME }-${ name }`,
  path:      `/c/:cluster/${ PRODUCT_NAME }/${ name }`,
  component,
  meta:      { product: PRODUCT_NAME },
});

export const trainingRoutes = [
  // Jobs, Projects and Compute Profiles are entries of the Workloads sub-menu
  page(JOBS_PAGE, () => import('./pages/Workloads.vue')),
  page(PROJECTS_PAGE, () => import('./pages/Projects.vue')),
  page(AIPROJECTS_PAGE, () => import('./pages/AIProjects.vue')),
  page(PROFILES_PAGE, () => import('./pages/Profiles.vue')),
  page(INFERENCE_PROFILE_PAGE, () => import('./pages/InferenceProfile.vue')),
  page(DEPLOY_PAGE, () => import('./pages/Deploy.vue')),
  page(ENDPOINT_PAGE, () => import('./pages/DeployEndpoint.vue')),
  page(SUBMIT_PAGE, () => import('./pages/Submit.vue')),
  // Links to the old combined list land on Deployments for inference, Jobs otherwise
  {
    name:     `c-cluster-${ PRODUCT_NAME }-${ ENDPOINTS_PAGE }`,
    path:     `/c/:cluster/${ PRODUCT_NAME }/${ ENDPOINTS_PAGE }`,
    redirect: (to: any) => (to.query.tab === 'inference' ? { name: `c-cluster-${ PRODUCT_NAME }-workloads`, params: to.params } : { name: `c-cluster-${ PRODUCT_NAME }-${ JOBS_PAGE }`, params: to.params, query: { ...to.query, tab: 'training' } }),
    meta:     { product: PRODUCT_NAME },
  },
];
