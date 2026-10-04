// The Catalog: everything a user can deploy, as one list of cards. Training and inference profiles
// (governed, into a project on this cluster) and blueprints (Fleet can deploy them to other
// clusters). A blueprint an inference profile wraps is shown through that profile unless the user
// has asked to see wrapped blueprints too; the profile's card still offers the blueprint's own
// multi-cluster install. Apps, from the operator's curated catalog, are applications too, when the
// user shows them.

import type { Profile } from './profiles';

export type CatalogKind = 'training' | 'inference' | 'application';

export interface CatalogBlueprint {
  family: string; // the operator's blueprint name, what profiles refer to
  displayName: string;
  version: string; // newest non-deprecated
  versions: string[]; // every non-deprecated version, newest first
  description: string;
  category: string; // the Blueprint's category, '' when unset
  components: number;
  source: string; // SUSE, NVIDIA, Custom, ...: the vendor badge
  icon?: string; // a partner logo, browser-safe
}

export interface CatalogApp {
  slug: string;
  name: string;
  description: string;
  logo: string;
  library: string;
  repositoryName: string;
  repositoryUrl: string;
}

export interface CatalogItem {
  key: string;
  kind: CatalogKind;
  from: 'profile' | 'blueprint' | 'app';
  title: string;
  status: 'ready' | 'beta';
  description: string;
  meta: string[]; // the grey line under the title
  profile: Profile | null;
  blueprint: CatalogBlueprint | null;
  /** a training profile's purpose: what its Catalog section and button say */
  purpose?: 'training' | 'test' | 'benchmark';
  /** for a profile that deploys a blueprint: that blueprint, for its multi-cluster install */
  wraps: CatalogBlueprint | null;
  app?: CatalogApp | null;
}

const kindOfBlueprint = (b: CatalogBlueprint): CatalogKind => (b.category === 'inference' ? 'inference' : b.category === 'training' ? 'training' : 'application');

export function catalogItems(profiles: Profile[], blueprints: CatalogBlueprint[], showWrapped: boolean, apps: CatalogApp[] = []): CatalogItem[] {
  const byFamily = new Map(blueprints.map((b) => [b.family, b]));
  const wrapped = new Set(profiles.filter((p) => p.type === 'inference' && p.blueprint).map((p) => p.blueprint!.name));
  const items: CatalogItem[] = profiles.map((p) => ({
    key:         `profile/${ p.name }`,
    kind:        p.type,
    from:        'profile',
    title:       p.displayName,
    status:      p.status,
    description: p.description,
    meta:        [p.framework, p.gpu].filter(Boolean),
    profile:     p,
    blueprint:   null,
    wraps:       p.blueprint ? byFamily.get(p.blueprint.name) || null : null,
    purpose:     p.type === 'training' ? p.purpose || 'training' : undefined,
  }));

  for (const b of blueprints) {
    if (wrapped.has(b.family) && !showWrapped) {
      continue;
    }
    items.push({
      key:         `blueprint/${ b.family }`,
      kind:        kindOfBlueprint(b),
      from:        'blueprint',
      title:       b.displayName,
      status:      'ready',
      description: b.description,
      // the vendor and the version are shown by the card itself (badge, version picker)
      meta:        [`${ b.components } ${ b.components === 1 ? 'app' : 'apps' }`],
      profile:     null,
      blueprint:   b,
      wraps:       null,
    });
  }

  for (const a of apps) {
    items.push({
      key:         `app/${ a.slug }`,
      kind:        'application',
      from:        'app',
      title:       a.name,
      status:      'ready',
      description: a.description,
      meta:        ['App', a.library].filter(Boolean),
      profile:     null,
      blueprint:   null,
      wraps:       null,
      app:         a,
    });
  }

  const order: Record<CatalogKind, number> = { training: 0, inference: 1, application: 2 };
  const fromOrder: Record<CatalogItem['from'], number> = { profile: 0, blueprint: 1, app: 2 };

  // within training: training proper, then tests and benchmarks (validating the environment)
  const purposeOrder = (i: CatalogItem) => (i.purpose === 'test' ? 1 : i.purpose === 'benchmark' ? 2 : 0);

  return items.sort((a, b) => order[a.kind] - order[b.kind] || fromOrder[a.from] - fromOrder[b.from] || purposeOrder(a) - purposeOrder(b) || a.title.localeCompare(b.title));
}

export interface CatalogFilter { text: string; status: '' | 'ready' | 'beta' }

export function filterCatalog(items: CatalogItem[], kind: '' | CatalogKind, f: CatalogFilter): CatalogItem[] {
  const q = f.text.trim().toLowerCase();

  return items.filter((i) => (!kind || i.kind === kind) &&
    (!f.status || i.status === f.status) &&
    (!q || `${ i.title } ${ i.description } ${ i.meta.join(' ') }`.toLowerCase().includes(q)));
}

/**
 * The Catalog's sections for a list: what users deploy first, then the tests and benchmarks that
 * validate the environment, which are occasional and collapsible.
 */
export function catalogSections(items: CatalogItem[]): { key: string; title: string; collapsible: boolean; items: CatalogItem[] }[] {
  const validate = items.filter((i) => i.purpose === 'test' || i.purpose === 'benchmark');
  const rest = items.filter((i) => !validate.includes(i));

  return [
    { key: 'run', title: validate.length ? 'Deploy' : '', collapsible: false, items: rest },
    { key: 'validate', title: 'Validate your environment', collapsible: true, items: validate },
  ].filter((s) => s.items.length);
}

/** What a card's main button says. */
export function deployLabel(i: CatalogItem): string {
  return i.purpose === 'test' ? 'Run test' : i.purpose === 'benchmark' ? 'Run benchmark' : 'Deploy';
}
