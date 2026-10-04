import { describe, it, expect } from 'vitest';
import { LOG_ACCEPT, readPodLog } from '../podlog';

describe('readPodLog', () => {
  it('asks for JSON first (text/plain alone is refused with a 406) and keeps the body as text', async () => {
    let opt: any;
    const store = {
      dispatch: async (_: string, o: any) => {
        opt = o;

        return { data: 'line 1\nAIF_RESULT {"status":"pass"}\n' };
      }
    };

    expect(await readPodLog(store, 'local', 'team-a', 'run-0', 'tailLines=400')).toContain('AIF_RESULT');
    expect(opt.url).toBe('/k8s/clusters/local/api/v1/namespaces/team-a/pods/run-0/log?tailLines=400');
    expect(opt.headers.accept).toBe(LOG_ACCEPT);
    expect(LOG_ACCEPT.startsWith('application/json')).toBe(true);
    expect(opt.responseType).toBe('text');
  });

  it('accepts a bare string response', async () => {
    expect(await readPodLog({ dispatch: async () => 'hello' }, 'local', 'ns', 'p')).toBe('hello');
  });
});
