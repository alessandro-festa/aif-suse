import {
  afterEach, beforeEach, describe, expect, it, vi
} from 'vitest';
// A custom repo's chart icons are read from Rancher itself (same origin, ?link=icon) and inlined;
// nothing else is fetched.
import { inlineRancherIcon, rancherIconUrl } from '../app-collection';

const origin = 'https://rancher.example';
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

beforeEach(() => vi.stubGlobal('window', { location: { origin } }));
afterEach(() => vi.unstubAllGlobals());

describe('rancherIconUrl', () => {
  it('accepts only Rancher\'s own icon link', () => {
    expect(rancherIconUrl(`${ origin }/v1/catalog.cattle.io.clusterrepos/aif-engines?chartName=sglang&link=icon&version=0.1.0`)).toContain('link=icon');
    expect(rancherIconUrl('https://example.com/v1/x?link=icon')).toBeUndefined();
    expect(rancherIconUrl(`${ origin }/v1/x?link=index`)).toBeUndefined();
    expect(rancherIconUrl(undefined)).toBeUndefined();
  });
});

describe('inlineRancherIcon', () => {
  const respond = (type: string, body: Uint8Array, ok = true) => vi.stubGlobal('fetch', vi.fn(async() => ({
    ok, headers: { get: () => type }, arrayBuffer: async() => body.buffer
  })));

  it('inlines a raster icon as a data URL', async() => {
    respond('image/png', PNG);
    expect(await inlineRancherIcon(`${ origin }/x?link=icon`)).toBe('data:image/png;base64,iVBORw==');
  });

  it('drops SVG, errors and oversized icons', async() => {
    respond('image/svg+xml', PNG);
    expect(await inlineRancherIcon(`${ origin }/x?link=icon`)).toBeUndefined();
    respond('image/png', PNG, false);
    expect(await inlineRancherIcon(`${ origin }/x?link=icon`)).toBeUndefined();
    respond('image/png', new Uint8Array(70 * 1024));
    expect(await inlineRancherIcon(`${ origin }/x?link=icon`)).toBeUndefined();
  });
});
