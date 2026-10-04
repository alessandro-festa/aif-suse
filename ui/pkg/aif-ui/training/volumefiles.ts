// What is on a run's kept checkpoint volume, and a copy of one file, from the browser. A volume can
// only be read from a pod that mounts it, so each request runs a short-lived Job (BCI busybox,
// the volume read-only) and reads its log, the way the SDK's checkpoints ls/get do. A Job rather than a
// bare Pod: AI Job Submitter may create Jobs and read their pods' logs, not create Pods.
import { readPodLog } from './podlog';

// SUSE's BCI busybox: maintained by SUSE, pullable without an account, mirrored like the other BCI images
export const TOOLS_IMAGE = 'registry.suse.com/bci/bci-busybox:15.7';
// a file travels base64-encoded (a third larger) through the log, which the kubelet rotates at 10 MiB
export const MAX_DOWNLOAD_BYTES = 7 * 1024 * 1024;
const MAX_FILES = 500;

export interface VolumeFile {
  path: string; // relative to the volume's root
  size: number; // bytes
  modified: Date | null;
}

/** A shell word for `s`, single-quoted. */
export function shellQuote(s: string): string {
  return `'${ s.replace(/'/g, `'\\''`) }'`;
}

/** Every file on the volume as size|mtime|./path, lost+found skipped, at most MAX_FILES. */
export function listScript(): string {
  return `cd /ckpt && find . -path ./lost+found -prune -o -type f -exec stat -c '%s|%Y|%n' {} + | head -n ${ MAX_FILES }`;
}

// The file travels base64-encoded between these lines. "@" is not in the base64 alphabet, so no line
// of the encoding can be mistaken for them (a bare END can: base64 contains those letters).
export const BEGIN = '@@AIF-BEGIN@@';
export const END = '@@AIF-END@@';

/** One file, base64 between BEGIN and END; NOFILE or TOOBIG (with its SIZE) instead when it cannot be. */
export function fileScript(path: string): string {
  const src = shellQuote(`/ckpt/${ path.replace(/^\/+/, '') }`);

  return `test -f ${ src } || { echo NOFILE; exit 3; }; n=$(wc -c < ${ src }); echo SIZE $n; ` +
    `[ $n -le ${ MAX_DOWNLOAD_BYTES } ] || { echo TOOBIG; exit 4; }; echo ${ BEGIN }; base64 ${ src }; echo ${ END }`;
}

export function parseListing(log: string): VolumeFile[] {
  const out: VolumeFile[] = [];

  for (const line of (log || '').split('\n')) {
    const m = line.trim().match(/^(\d+)\|(\d+)\|\.\/(.+)$/);

    if (m) {
      out.push({ path: m[3], size: Number(m[1]), modified: new Date(Number(m[2]) * 1000) });
    }
  }

  return out.sort((a, b) => a.path.localeCompare(b.path));
}

export type Decoded = { ok: true; bytes: Uint8Array } | { ok: false; reason: 'missing' | 'too-big' | 'incomplete'; size?: number };

export function decodeFile(log: string): Decoded {
  const text = log || '';

  if (/^NOFILE$/m.test(text)) {
    return { ok: false, reason: 'missing' };
  }
  if (/^TOOBIG$/m.test(text)) {
    const size = Number((text.match(/^SIZE (\d+)$/m) || [])[1]);

    return { ok: false, reason: 'too-big', size: Number.isFinite(size) ? size : undefined };
  }
  const lines = text.split('\n').map((l) => l.trim());
  const at = lines.indexOf(BEGIN);
  const end = at >= 0 ? lines.indexOf(END, at + 1) : -1;

  if (at < 0 || end < 0) {
    return { ok: false, reason: 'incomplete' };
  }
  const bin = atob(lines.slice(at + 1, end).join(''));
  const bytes = new Uint8Array(bin.length);

  for (let i = 0; i < bin.length; i++) {
    bytes[i] = bin.charCodeAt(i);
  }

  return { ok: true, bytes };
}

export function jobManifest(namespace: string, claim: string, name: string, script: string): any {
  const labels = { 'app.kubernetes.io/managed-by': 'aif-ui', 'aif-ui/volume-files': claim.slice(0, 63) };

  return {
    apiVersion: 'batch/v1',
    kind:       'Job',
    metadata:   { name, namespace, labels },
    spec:       {
      backoffLimit:            0,
      ttlSecondsAfterFinished: 300,
      template:                {
        metadata: { labels },
        spec:     {
          restartPolicy: 'Never',
          containers:    [{
            name:         'files',
            image:        TOOLS_IMAGE,
            command:      ['sh', '-c', script],
            volumeMounts: [{ name: 'ckpt', mountPath: '/ckpt', readOnly: true }],
            resources:    { requests: { cpu: '20m', memory: '16Mi' }, limits: { memory: '64Mi' } },
          }],
          volumes: [{ name: 'ckpt', persistentVolumeClaim: { claimName: claim, readOnly: true } }],
        },
      },
    },
  };
}

export function formatBytes(n: number): string {
  if (n < 1024) {
    return `${ n } B`;
  }
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let v = n / 1024;
  let i = 0;

  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }

  return `${ v < 10 ? v.toFixed(1) : Math.round(v) } ${ units[i] }`;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run `script` against the volume in a one-pod Job and return its log. The Job is deleted
 * afterwards (its pods with it); its ttl cleans up after a closed tab.
 */
export async function runVolumeJob(store: any, cluster: string, namespace: string, claim: string, script: string, timeoutMs = 120000): Promise<string> {
  const base = `/k8s/clusters/${ encodeURIComponent(cluster) }`;
  const ns = encodeURIComponent(namespace);
  const name = `ckpt-files-${ Math.random().toString(36).slice(2, 7) }`;
  const req = (opt: any) => store.dispatch('cluster/request', opt);
  // writes go through rancher/request with an explicit JSON body, as the extension's other creates
  // through this proxy do
  const write = (opt: any) => store.dispatch('rancher/request', { ...opt, headers: { 'Content-Type': 'application/json', ...(opt.headers || {}) } });

  await write({
    url: `${ base }/apis/batch/v1/namespaces/${ ns }/jobs`, method: 'POST', data: jobManifest(namespace, claim, name, script)
  });
  try {
    const deadline = Date.now() + timeoutMs;

    for (;;) {
      const job = await req({ url: `${ base }/apis/batch/v1/namespaces/${ ns }/jobs/${ name }` });
      const st = job?.status || job?.data?.status || {};

      if (st.succeeded || st.failed) {
        break;
      }
      if (Date.now() > deadline) {
        throw new Error(`reading ${ claim } took longer than ${ Math.round(timeoutMs / 1000) }s (Job ${ name })`);
      }
      await sleep(2000);
    }
    const pods = await req({ url: `${ base }/api/v1/namespaces/${ ns }/pods?labelSelector=${ encodeURIComponent(`job-name=${ name }`) }` });
    const pod = (pods?.items || pods?.data?.items || [])[0];

    if (!pod) {
      throw new Error(`the Job ${ name } finished without a pod`);
    }
    return await readPodLog(store, cluster, namespace, pod.metadata.name);
  } finally {
    write({ url: `${ base }/apis/batch/v1/namespaces/${ ns }/jobs/${ name }?propagationPolicy=Background`, method: 'DELETE' }).catch(() => undefined);
  }
}
