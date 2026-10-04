// Per-browser preferences of the AI Factory pages. Rancher's own user preferences only accept keys
// the dashboard defines, so these live in local storage; every access is guarded, and a blocked or
// empty store gives the default.
import { ref, Ref } from 'vue';

const PREFIX = 'aif.pref.';
const cache: Record<string, Ref<boolean>> = {};

function pref(key: string, def: boolean): Ref<boolean> {
  if (!cache[key]) {
    let v = def;

    try {
      const raw = window.localStorage.getItem(PREFIX + key);

      v = raw === null ? def : raw === 'true';
    } catch (e) { /* storage unavailable: the default */ }
    cache[key] = ref(v);
  }

  return cache[key];
}

/** A preference's value, shared by every component that reads it. */
export function getPref(key: string, def: boolean): boolean {
  return pref(key, def).value;
}

export function setPref(key: string, def: boolean, value: boolean): void {
  pref(key, def).value = value;
  try {
    window.localStorage.setItem(PREFIX + key, String(value));
  } catch (e) { /* storage unavailable: kept for this page load only */ }
}

/** List the blueprints that inference profiles wrap in the Catalog as well as their profiles. */
export const CATALOG_SHOW_WRAPPED = { key: 'catalog-show-wrapped-blueprints', def: false };

/** List apps from the app catalog on the Catalog's All and Applications tabs. */
export const CATALOG_SHOW_APPS = { key: 'catalog-show-apps', def: true };
