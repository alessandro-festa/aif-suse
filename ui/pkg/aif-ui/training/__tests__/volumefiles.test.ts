import { describe, it, expect } from 'vitest';
import {
  BEGIN, END, MAX_DOWNLOAD_BYTES, decodeFile, fileScript, formatBytes, jobManifest, parseListing, runVolumeJob, shellQuote
} from '../volumefiles';

describe('parseListing', () => {
  it('reads size|mtime|./path lines, sorted by path, ignoring anything else', () => {
    const files = parseListing('warning: something\n10052|1791078516|./gpu-diagnostics.tar.gz\n12|1791078000|./adapter/config.json\n');

    expect(files.map((f) => f.path)).toEqual(['adapter/config.json', 'gpu-diagnostics.tar.gz']);
    expect(files[1].size).toBe(10052);
    expect(files[1].modified?.getTime()).toBe(1791078516000);
  });

  it('keeps names with spaces and bars', () => {
    expect(parseListing('5|1|./my run|v2.txt')[0].path).toBe('my run|v2.txt');
  });
});

describe('decodeFile', () => {
  it('decodes the base64 between BEGIN and END', () => {
    const d = decodeFile(`SIZE 5\n${ BEGIN }\n${ btoa('hello') }\n${ END }\n`);

    expect(d.ok && new TextDecoder().decode(d.bytes)).toBe('hello');
  });

  it('says why when there is no file', () => {
    expect(decodeFile('NOFILE\n')).toEqual({ ok: false, reason: 'missing' });
    expect(decodeFile('SIZE 9000000\nTOOBIG\n')).toEqual({ ok: false, reason: 'too-big', size: 9000000 });
    expect(decodeFile(`SIZE 5\n${ BEGIN }\naGVs`)).toEqual({ ok: false, reason: 'incomplete' });
  });
});

describe('decodeFile and base64 that spells END', () => {
  it('reads a line of the encoding that starts with END as data, not as the end', () => {
    // ENDAENDA is valid base64: a file can encode to a line that begins with the letters END
    const d = decodeFile(`${ BEGIN }\nENDAENDA\n${ END }\n`);

    expect(d.ok && Array.from(d.bytes)).toEqual(Array.from(atob('ENDAENDA'), (c) => c.charCodeAt(0)));
  });
});

describe('scripts and the Job', () => {
  it('quotes paths for the shell', () => {
    expect(shellQuote(`it's`)).toBe(`'it'\\''s'`);
    expect(fileScript('/a b.txt')).toContain(`'/ckpt/a b.txt'`);
    expect(fileScript('x')).toContain(`-le ${ MAX_DOWNLOAD_BYTES }`);
  });

  it('mounts the claim read-only in a one-pod Job that cleans itself up', () => {
    const j = jobManifest('team-a', 'run-1-checkpoints', 'ckpt-files-abc', 'ls');
    const pod = j.spec.template.spec;

    expect(j.spec.backoffLimit).toBe(0);
    expect(j.spec.ttlSecondsAfterFinished).toBe(300);
    expect(pod.volumes[0].persistentVolumeClaim).toEqual({ claimName: 'run-1-checkpoints', readOnly: true });
    expect(pod.containers[0].volumeMounts[0].readOnly).toBe(true);
  });

  it('formats sizes', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(10052)).toBe('9.8 KiB');
    expect(formatBytes(30 * 1024 * 1024)).toBe('30 MiB');
  });
});

describe('runVolumeJob', () => {
  it('creates the Job as JSON, reads its pod log, then deletes it', async () => {
    const calls: { action: string; opt: any }[] = [];
    const store = {
      dispatch: async (action: string, opt: any) => {
        calls.push({ action, opt });
        if (opt.method === 'POST' || opt.method === 'DELETE') {
          return {};
        }
        if (opt.url.includes('/jobs/')) {
          return { status: { succeeded: 1 } };
        }
        if (opt.url.includes('/pods?')) {
          return { items: [{ metadata: { name: 'p1' } }] };
        }

        return 'listing';
      }
    };

    expect(await runVolumeJob(store, 'local', 'team-a', 'run-1-checkpoints', 'ls')).toBe('listing');
    const create = calls.find((c) => c.opt.method === 'POST')!;

    expect(create.action).toBe('rancher/request');
    expect(create.opt.headers['Content-Type']).toBe('application/json');
    expect(create.opt.url).toBe('/k8s/clusters/local/apis/batch/v1/namespaces/team-a/jobs');
    expect(calls.some((c) => c.opt.method === 'DELETE' && c.opt.url.includes('propagationPolicy=Background'))).toBe(true);
  });
});
