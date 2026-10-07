/**
 * Main SUSE AI Product Configuration
 * Following standard patterns for product configuration
 * Centralizes product-specific constants and configurations
 */

import { PRODUCT_NAME, PRODUCT_SLUG, EXTENSION_VERSION } from '../utils/constants';

// === Product Constants ===
export const PRODUCT = PRODUCT_SLUG;
export const MANAGEMENT_CLUSTER = 'local';
export const BLANK_CLUSTER = '_';

// === Product Definition ===
export interface ProductConfig {
  name: string;
  slug: string;
  version: string;
  category: string;
  weight: number;
  icon: string;
  svg?: string;
  inStore: string;
  supportRoute?: string;
  docsRoute?: string;
}

export const SUSEAI_PRODUCT: ProductConfig = {
  name: PRODUCT_NAME,
  slug: PRODUCT_SLUG,
  version: EXTENSION_VERSION,
  category: 'global',
  weight: 80,
  icon: 'extension',
  inStore: 'management',
  supportRoute: 'https://www.suse.com/support/',
  docsRoute: 'https://documentation.suse.com/suse-ai-factory/latest/'
};

// === Navigation Configuration ===
export interface NavItem {
  name: string;
  label: string;
  route: {
    name: string;
    params: Record<string, string>;
    meta: Record<string, string>;
  };
  exact?: boolean;
  icon?: string;
}

// === Page Definitions ===
export const PAGE_TYPES = {
  OVERVIEW:     'overview',
  APPS:         'apps',
  INSTALL:      'install',
  MANAGE:       'manage',
  REPOSITORIES: 'repositories',
  BLUEPRINTS:   'blueprints',
  WORKLOADS:    'workloads',
  // Workloads group: the training pages keep their route names (training/config.ts); the virtual
  // types are prefixed so Rancher's nav never mistakes one for a resource type of the same name.
  TRAINING_JOBS: 'training-jobs',
  PROJECTS:      'ai-projects',
  PROFILES:      'compute-profiles',
  POOLS:         'compute-pools',
  SETTINGS:     'settings',
  ABOUT:        'about',
} as const;

// === Virtual Type Configuration ===
export interface VirtualTypeConfig {
  name: string;
  label: string;
  route: NavItem['route'];
}

export const VIRTUAL_TYPES: VirtualTypeConfig[] = [
  {
    name:  PAGE_TYPES.OVERVIEW,
    label: 'Overview',
    route: {
      name:   `c-cluster-${PRODUCT}-${PAGE_TYPES.OVERVIEW}`,
      params: { product: PRODUCT, cluster: BLANK_CLUSTER },
      meta:   { product: PRODUCT }
    }
  },
  {
    name:  PAGE_TYPES.APPS,
    label: 'Apps',
    route: {
      name:   `c-cluster-${PRODUCT}-${PAGE_TYPES.APPS}`,
      params: { product: PRODUCT, cluster: BLANK_CLUSTER },
      meta:   { product: PRODUCT }
    }
  },
  {
    name:  PAGE_TYPES.BLUEPRINTS,
    label: 'Blueprints',
    route: {
      name:   `c-cluster-${ PRODUCT }-${ PAGE_TYPES.BLUEPRINTS }`,
      params: { product: PRODUCT, cluster: BLANK_CLUSTER },
      meta:   { product: PRODUCT }
    }
  },
  {
    name:  PAGE_TYPES.WORKLOADS,
    label: 'Deployments',
    route: {
      name:   `c-cluster-${ PRODUCT }-${ PAGE_TYPES.WORKLOADS }`,
      params: { product: PRODUCT, cluster: BLANK_CLUSTER },
      meta:   { product: PRODUCT }
    }
  },
  {
    name:  PAGE_TYPES.TRAINING_JOBS,
    label: 'Training Jobs',
    route: {
      name:   `c-cluster-${ PRODUCT }-jobs`,
      params: { product: PRODUCT, cluster: MANAGEMENT_CLUSTER },
      meta:   { product: PRODUCT }
    }
  },
  {
    name:  PAGE_TYPES.PROJECTS,
    label: 'Projects',
    route: {
      name:   `c-cluster-${ PRODUCT }-projects`,
      params: { product: PRODUCT, cluster: MANAGEMENT_CLUSTER },
      meta:   { product: PRODUCT }
    }
  },
  {
    name:  PAGE_TYPES.PROFILES,
    label: 'Compute Profiles',
    route: {
      name:   `c-cluster-${ PRODUCT }-profiles`,
      params: { product: PRODUCT, cluster: MANAGEMENT_CLUSTER },
      meta:   { product: PRODUCT }
    }
  },
  {
    name:  PAGE_TYPES.POOLS,
    label: 'Compute Pools',
    route: {
      name:   `c-cluster-${ PRODUCT }-${ PAGE_TYPES.POOLS }`,
      params: { product: PRODUCT, cluster: MANAGEMENT_CLUSTER },
      meta:   { product: PRODUCT }
    }
  },
  {
    name:  PAGE_TYPES.SETTINGS,
    label: 'Settings',
    route: {
      name:   `c-cluster-${ PRODUCT }-${ PAGE_TYPES.SETTINGS }`,
      params: { product: PRODUCT, cluster: MANAGEMENT_CLUSTER },
      meta:   { product: PRODUCT, cluster: MANAGEMENT_CLUSTER }
    }
  },
  {
    name:  PAGE_TYPES.ABOUT,
    label: 'About',
    route: {
      name:   `c-cluster-${ PRODUCT }-${ PAGE_TYPES.ABOUT }`,
      params: { product: PRODUCT, cluster: BLANK_CLUSTER },
      meta:   { product: PRODUCT }
    }
  }
];

// Explicit sidebar ordering: higher weight = higher in the list.
export const NAV_WEIGHTS: Record<string, number> = {
  [PAGE_TYPES.OVERVIEW]:   50,
  [PAGE_TYPES.APPS]:       40,
  [PAGE_TYPES.BLUEPRINTS]: 30,
  [PAGE_TYPES.SETTINGS]:   10,
  // Order inside the Workloads group
  [PAGE_TYPES.WORKLOADS]:     5,
  [PAGE_TYPES.TRAINING_JOBS]: 4,
  [PAGE_TYPES.PROJECTS]:      3,
  [PAGE_TYPES.PROFILES]:      2,
  [PAGE_TYPES.POOLS]:         1,
  [PAGE_TYPES.ABOUT]:      5,
};

// === Basic Types Configuration ===
export const BASIC_TYPES = [PAGE_TYPES.OVERVIEW, PAGE_TYPES.APPS, PAGE_TYPES.BLUEPRINTS, PAGE_TYPES.SETTINGS, PAGE_TYPES.ABOUT];

// Workloads is a sub-menu: inference deployments plus the training/scheduling pages.
// The label comes from l10n nav.group.aifWorkloads.
export const WORKLOADS_GROUP = 'aifWorkloads';
export const WORKLOADS_GROUP_WEIGHT = 20;
export const WORKLOADS_GROUP_TYPES = [PAGE_TYPES.WORKLOADS, PAGE_TYPES.TRAINING_JOBS, PAGE_TYPES.PROJECTS, PAGE_TYPES.PROFILES, PAGE_TYPES.POOLS];

// === Export defaults ===
export default SUSEAI_PRODUCT;