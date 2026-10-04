import {
  PRODUCT_NAME, INFERENCE_PROFILE_PAGE, SUBMIT_PAGE, JOBS_PAGE, PROJECTS_PAGE, PROFILES_PAGE, DEPLOY_PAGE, ENDPOINT_PAGE, ENDPOINTS_PAGE
} from './config';

const page = (name: string, component: () => Promise<any>) => ({
  name:      `c-cluster-${ PRODUCT_NAME }-${ name }`,
  path:      `/c/:cluster/${ PRODUCT_NAME }/${ name }`,
  component,
  meta:      { product: PRODUCT_NAME },
});

export const trainingRoutes = [
  // Projects & Quotas is a tab of Settings: an administrator's page, not a daily one
  {
    name:     `c-cluster-${ PRODUCT_NAME }-${ PROJECTS_PAGE }`,
    path:     `/c/:cluster/${ PRODUCT_NAME }/${ PROJECTS_PAGE }`,
    redirect: (to: any) => ({ name: `c-cluster-${ PRODUCT_NAME }-settings`, params: to.params, query: { tab: 'projects' } }),
    meta:     { product: PRODUCT_NAME },
  },
  // Profiles are managed under Settings > Compute Profiles; users find them in the Catalog
  {
    name:     `c-cluster-${ PRODUCT_NAME }-${ PROFILES_PAGE }`,
    path:     `/c/:cluster/${ PRODUCT_NAME }/${ PROFILES_PAGE }`,
    redirect: (to: any) => ({ name: `c-cluster-${ PRODUCT_NAME }-settings`, params: to.params, query: { ...to.query, tab: 'profiles' } }),
    meta:     { product: PRODUCT_NAME },
  },
  page(INFERENCE_PROFILE_PAGE, () => import('./pages/InferenceProfile.vue')),
  page(DEPLOY_PAGE, () => import('./pages/Deploy.vue')),
  page(ENDPOINT_PAGE, () => import('./pages/DeployEndpoint.vue')),
  page(SUBMIT_PAGE, () => import('./pages/Submit.vue')),
  // The training list is the Training tab of the Workloads page; links to the old list pages land
  // there (inference endpoints are on the Deployments tab).
  ...[ENDPOINTS_PAGE, JOBS_PAGE].map((name) => ({
    name:     `c-cluster-${ PRODUCT_NAME }-${ name }`,
    path:     `/c/:cluster/${ PRODUCT_NAME }/${ name }`,
    redirect: (to: any) => ({
      name:   `c-cluster-${ PRODUCT_NAME }-workloads`,
      params: to.params,
      query:  to.query.tab === 'inference' ? {} : { tab: 'training' },
    }),
    meta: { product: PRODUCT_NAME },
  })),
];
