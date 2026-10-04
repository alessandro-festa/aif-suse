// Inference profiles: a platform-published SUSE AI Factory blueprint, deployed as an AIWorkload.
//
// A training profile fixes gpu-train-job values; an inference profile names a Blueprint
// (ai-factory.suse.com/v1alpha1) and version, and deploying it creates an AIWorkload that the AI
// Factory operator turns into Fleet HelmOps. The extension installs nothing itself.
//
// On aif-operator 2.2.0 a blueprint installs exactly as written: AIWorkload.spec.componentValues is
// ignored for Blueprint sources (it arrives in 2.3.0). So the user supplies only a project and an
// endpoint name, and everything the card and the checks show (model, GPUs, resources) is read from
// the Blueprint object rather than repeated in the profile.

import {
  gib, kaiShareChecks, MPS_LIMIT_ENV, parseMpsLimit, sharedGpuChecks
} from './gpushare';
import {
  Check, Facts, fmtMem, parseCpu, parseMem
} from './preflight';

// What vLLM allocates beyond --gpu-memory-utilization at start (CUDA graphs, sampler warm-up).
const VLLM_OVERHEAD_MIB = 1536;

export const AIF_GROUP = 'ai-factory.suse.com';
export const AIWORKLOAD_TYPE = 'ai-factory.suse.com.aiworkload';
export const BLUEPRINT_TYPE = 'ai-factory.suse.com.blueprint';
export const BLUEPRINT_NAME_LABEL = 'ai-factory.suse.com/blueprint-name';
export const BLUEPRINT_VERSION_LABEL = 'ai-factory.suse.com/blueprint-version';
// On the AIWorkload, so the Endpoints page can find deployments made from a profile.
export const WORKLOAD_PROFILE_LABEL = 'trainingjobs/profile';

export interface BlueprintRef { name: string; version: string }

/** What one blueprint serves, read from its vLLM component. Empty fields = not a vLLM blueprint. */
export interface BlueprintSummary {
  ref: BlueprintRef;
  displayName: string;
  components: string[]; // chart names, in install order
  releaseNames: string[]; // Helm release per component: releaseName, or the chart name
  model: string;
  gpusPerReplica: number;
  replicas: number;
  cpu: string;
  memory: string;
  storageClass: string;
  cacheSize: string;
  dra: boolean;
  maxModelLen: number;
  dtype: string;
  gpuMemoryUtilization: number;
  // An LiteLLM gateway in front of vLLM (the SUSE Inference Endpoint shape): clients call it, not vLLM.
  gateway: { release: string; port: number } | null;
  sharedClaim: string; // the MPS claim the engine attaches to ('' = a claim per pod)
  mpsLimitMiB: number | null; // the engine's GPU memory cap on a shared GPU
  kaiMemoryMiB: number | null; // the engine's KAI GPU-memory share (its gpu-memory annotation)
  kaiQueue: string; // the KAI queue the engine is labelled for
}

/** The Blueprint object for a name and version: the operator's own lookup is by these labels. */
export function findBlueprint(blueprints: any[], ref: BlueprintRef): any | null {
  return (blueprints || []).find((b) => b?.metadata?.labels?.[BLUEPRINT_NAME_LABEL] === ref.name && (b?.metadata?.labels?.[BLUEPRINT_VERSION_LABEL] || b?.spec?.version) === ref.version) || null;
}

export function summarizeBlueprint(bp: any, ref: BlueprintRef): BlueprintSummary {
  const comps: any[] = Array.isArray(bp?.spec?.components) ? bp.spec.components : [];
  const vllm = comps.find((c) => c?.values?.servingEngineSpec?.modelSpec?.length) || {};
  const engine = vllm.values?.servingEngineSpec || {};
  const m = (engine.modelSpec || [])[0] || {};
  const args: string[] = (m.vllmConfig?.extraArgs || []).map(String);
  const util = args.indexOf('--gpu-memory-utilization');
  const gw = comps.find((c) => c?.chartName === 'litellm');

  return {
    ref,
    displayName:          String(bp?.spec?.displayName || ref.name),
    components:           comps.map((c) => String(c.chartName)),
    releaseNames:         comps.map((c) => String(c.releaseName || c.chartName)),
    model:                String(m.modelURL || ''),
    gpusPerReplica:       Number(m.requestGPU) || 0,
    replicas:             Number(m.replicaCount) || 1,
    cpu:                  String(m.requestCPU ?? ''),
    memory:               String(m.requestMemory ?? ''),
    storageClass:         String(m.storageClass || ''),
    cacheSize:            String(m.pvcStorage || ''),
    dra:                  !!engine.dra?.enabled,
    maxModelLen:          Number(m.vllmConfig?.maxModelLen) || 0,
    dtype:                String(m.vllmConfig?.dtype || 'auto'),
    gpuMemoryUtilization: util >= 0 ? Number(args[util + 1]) || 0.9 : 0.9,
    gateway:              gw ? { release: String(gw.releaseName || gw.chartName), port: Number(gw.values?.service?.port) || 4000 } : null,
    sharedClaim:          String(engine.dra?.sharedClaim || ''),
    mpsLimitMiB:          parseMpsLimit((m.env || []).find((e: any) => e?.name === MPS_LIMIT_ENV)?.value),
    kaiMemoryMiB:         Number(m.podAnnotations?.['gpu-memory']) || null,
    kaiQueue:             String(engine.labels?.['kai.scheduler/queue'] || ''),
  };
}

/**
 * Parameters in billions from a model id ("Qwen/Qwen2.5-1.5B-Instruct" -> 1.5, "Llama-3.1-70B" -> 70).
 * null when the id does not say, in which case the fit check reports that rather than guessing.
 */
export function modelParamsB(model: string): number | null {
  const m = String(model).match(/(?:^|[-_/.])(\d+(?:\.\d+)?)\s*([BbMm])(?=$|[-_/.])/);

  if (!m) {
    return null;
  }

  return m[2].toLowerCase() === 'm' ? parseFloat(m[1]) / 1000 : parseFloat(m[1]);
}

const BYTES_PER_PARAM: Record<string, number> = {
  half: 2, float16: 2, bfloat16: 2, auto: 2, float32: 4, float: 4, fp8: 1, int8: 1
};

/** GiB the weights need on the GPU: parameters × bytes per parameter for the dtype, +10% overhead. */
export function weightsGiB(paramsB: number, dtype: string): number {
  return paramsB * 1e9 * (BYTES_PER_PARAM[dtype] || 2) * 1.1 / 2 ** 30;
}

// Model families that are gated on Hugging Face: pulling them needs a token.
const GATED = /^(meta-llama|mistralai|google\/gemma|google\/medgemma)\//i;

export interface InferenceInput { namespace: string; name: string }

export interface InferenceFacts {
  aifInstalled: boolean; // the AIWorkload and Blueprint types exist
  blueprints: any[];
  workloads: { name: string; namespace: string; blueprint: string }[]; // existing AIWorkloads
  gpuDeviceMemory: number; // bytes, the largest GPU device the cluster advertises (DRA capacity.memory); 0 = unknown
}

const NAME = /^[a-z0-9]([-a-z0-9]{0,40}[a-z0-9])?$/;

/**
 * The pre-flight for an inference deployment. Uses the same Check shape and ids as the training
 * pre-flight where the meaning is the same (gpu, capacity, gpu-in-use, headroom), so readiness.ts
 * groups and words them the same way.
 */
export function inferenceChecks(input: InferenceInput, ref: BlueprintRef | null, f: Facts, inf: InferenceFacts, requiredSecrets: { name: string; hint: string }[] = []): Check[] {
  const out: Check[] = [];
  const add = (id: string, severity: Check['severity'], title: string, detail = '') => out.push({
    id, severity, title, detail
  });

  if (!inf.aifInstalled) {
    add('aif', 'fail', 'SUSE AI Factory is not installed in this cluster', 'Inference profiles deploy AI Factory blueprints; the AIWorkload type is missing.');

    return out;
  }
  const bp = ref ? findBlueprint(inf.blueprints, ref) : null;

  if (!ref || !bp) {
    add('blueprint', 'fail', `Blueprint ${ ref ? `${ ref.name } ${ ref.version }` : '(none)' } not found`, 'The profile names a blueprint version this cluster does not have, or your account cannot list blueprints.');

    return out;
  }
  const s = summarizeBlueprint(bp, ref);

  add('blueprint', 'pass', `Blueprint ${ s.displayName } ${ ref.version }`, s.components.join(', '));

  // project and name
  if (!input.namespace) {
    add('namespace', 'fail', 'Pick a project');
  } else {
    add('namespace', 'pass', `Project namespace ${ input.namespace }`);
  }
  if (!NAME.test(input.name || '')) {
    add('name', 'fail', 'Endpoint name must be lowercase letters, numbers and hyphens (max 42)');
  } else if (inf.workloads.some((w) => w.namespace === input.namespace && w.name === input.name)) {
    add('name', 'fail', `An endpoint named ${ input.name } already exists in ${ input.namespace }`);
  } else {
    add('name', 'pass', `Endpoint name ${ input.name }`);
  }
  // Every workload from this blueprint installs its components under the same release names, so two
  // in one namespace would fight over the same Helm release.
  const clash = inf.workloads.find((w) => w.namespace === input.namespace && w.blueprint === ref.name && w.name !== input.name);

  if (clash) {
    add('name', 'fail', `${ clash.name } already runs this profile in ${ input.namespace }`, `Both would install Helm release ${ s.releaseNames.join(', ') }. Use another project, or delete ${ clash.name } first.`);
  }

  // GPUs
  const want = s.gpusPerReplica * s.replicas;

  if (s.kaiMemoryMiB) {
    // a KAI GPU-memory share: queued and placed by KAI, capped by HAMi-core / NvFractions
    kaiShareChecks(s.kaiMemoryMiB, 1, f, 'KAI scheduler').forEach((c) => out.push(c));
    if (!f.kaiInstalled) {
      add('queue', 'fail', 'This profile needs KAI Scheduler', 'Its engine asks for a KAI GPU-memory share; KAI is not installed here (no Queue CRD).');
    } else if (s.kaiQueue && f.namespaceQueue && s.kaiQueue !== f.namespaceQueue) {
      add('queue', 'warn', `The blueprint is fixed to KAI queue ${ s.kaiQueue }`, `${ input.namespace } belongs to queue ${ f.namespaceQueue }; the endpoint is charged to ${ s.kaiQueue }. Blueprints install as written on aif-operator 2.2.0.`);
    } else if (s.kaiQueue) {
      add('queue', 'pass', `Queued in KAI queue ${ s.kaiQueue }`);
    }
  } else if (want > 0 && s.dra && s.sharedClaim) {
    // on a shared GPU the question is memory left on that claim, not a free GPU
    sharedGpuChecks(input.namespace, s.sharedClaim, s.mpsLimitMiB || 0, s.replicas, s.gpusPerReplica, f, 'dra', '').forEach((c) => out.push(c));
    // vLLM sizes its pool as a fraction of the GPU's total, and needs more on top of it (CUDA graphs,
    // a sampler warm-up). Past the MPS cap it fails at start: found on an RTX A2000 with 0.55 under 7 GiB.
    const deviceMiB = inf.gpuDeviceMemory / (1024 * 1024);

    if (s.mpsLimitMiB && deviceMiB > 0) {
      const needMiB = s.gpuMemoryUtilization * deviceMiB + VLLM_OVERHEAD_MIB;

      if (needMiB > s.mpsLimitMiB) {
        out.push({
          id: 'gpu-share', severity: 'fail', title: 'vLLM would not fit under its GPU memory cap', detail: `--gpu-memory-utilization ${ s.gpuMemoryUtilization } is ${ gib(s.gpuMemoryUtilization * deviceMiB) } of this GPU, plus ~${ gib(VLLM_OVERHEAD_MIB) } vLLM needs beyond it, against a cap of ${ gib(s.mpsLimitMiB) }. The engine would run out of memory while starting. The blueprint needs a lower utilization (at most ${ Math.floor(((s.mpsLimitMiB - VLLM_OVERHEAD_MIB) / deviceMiB) * 100) / 100 }).`
        });
      }
    }
  } else if (want > 0) {
    if (s.dra && !f.draClassExists) {
      add('gpu', 'fail', f.gpuReadable ? 'This profile requests GPUs through DRA; the cluster has no DRA GPU class' : 'Cannot see this cluster\'s GPUs', f.gpuReadable ? '' : 'Your account cannot list nodes, DeviceClasses or ResourceSlices. Ask an admin for the AI Scheduler Cluster Read role.');
    } else if (!s.dra && f.devicePluginGpus === 0) {
      add('gpu', 'fail', 'This profile requests nvidia.com/gpu; no node advertises it', f.draClassExists ? 'The cluster exposes GPUs through DRA only. Use a DRA blueprint (vllm-dra).' : '');
    } else {
      const total = s.dra ? f.draDevices : f.devicePluginGpus;
      const free = s.dra ? Math.max(0, f.draDevices - f.draAllocated) : total;

      if (want > total) {
        add('capacity', 'fail', `Needs ${ want } GPU(s); the cluster has ${ total }`);
      } else if (s.dra && want > free) {
        add('gpu-in-use', 'fail', `${ f.draAllocated } of ${ f.draDevices } GPU(s) already allocated to other workloads`, `${ free } free, ${ want } needed. The endpoint would wait until a claim is released.${ f.draAllocatedBy.length ? ` In use by: ${ f.draAllocatedBy.join(', ') }.` : '' }`);
      } else {
        add('capacity', 'pass', `${ want } GPU(s) available${ s.dra ? ' through DRA' : '' }`);
      }
    }
  }

  // Model fits the GPU
  const params = modelParamsB(s.model);

  if (s.model && params === null) {
    add('model-fit', 'info', 'Model size not stated in its name', `${ s.model }: cannot estimate whether it fits in GPU memory.`);
  } else if (params !== null && s.kaiMemoryMiB) {
    // Under HAMi-core / NvFractions the GPU vLLM sees is the share, so its utilization is a fraction
    // of the share. Measured on an RTX A2000: CUDA graphs 0.05 GiB, so what is left after the weights is KV.
    const need = weightsGiB(params, s.dtype);
    const have = (s.kaiMemoryMiB / 1024) * s.gpuMemoryUtilization;

    if (need > have) {
      add('model-fit', 'fail', `${ s.model } does not fit its share`, `About ${ need.toFixed(1) } GiB of weights (${ params }B params, ${ s.dtype }); vLLM may use ${ have.toFixed(1) } GiB (${ Math.round(s.gpuMemoryUtilization * 100) }% of the ${ gib(s.kaiMemoryMiB) } share).`);
    } else {
      add('model-fit', 'pass', `${ s.model } fits: ~${ need.toFixed(1) } of ${ have.toFixed(1) } GiB`, `${ Math.round(s.gpuMemoryUtilization * 100) }% of the ${ gib(s.kaiMemoryMiB) } share; the rest is KV cache for up to ${ s.maxModelLen || '?' } tokens of context.`);
    }
  } else if (params !== null && inf.gpuDeviceMemory > 0) {
    const need = weightsGiB(params, s.dtype) / Math.max(1, s.gpusPerReplica);
    // on a shared GPU, vLLM gets the smaller of its fraction of the device and its MPS cap
    const have = Math.min(inf.gpuDeviceMemory * s.gpuMemoryUtilization / 2 ** 30, s.mpsLimitMiB ? s.mpsLimitMiB / 1024 : Infinity);

    if (need > have) {
      add('model-fit', 'fail', `${ s.model } does not fit the GPU`, `About ${ need.toFixed(1) } GiB of weights per GPU (${ params }B params, ${ s.dtype }); vLLM may use ${ have.toFixed(1) } GiB (${ Math.round(s.gpuMemoryUtilization * 100) }% of ${ fmtMem(inf.gpuDeviceMemory) }).`);
    } else {
      add('model-fit', 'pass', `${ s.model } fits: ~${ need.toFixed(1) } of ${ have.toFixed(1) } GiB`, `The rest is KV cache for up to ${ s.maxModelLen || '?' } tokens of context.`);
    }
  }

  // CPU / memory on a GPU node
  if (f.podsReadable && f.gpuNodes.length && s.cpu && s.memory) {
    const cpu = parseCpu(s.cpu); const mem = parseMem(s.memory) || 0;
    const fits = f.gpuNodes.filter((n) => n.cpuFree >= cpu && n.memFree >= mem);

    if (!fits.length) {
      add('headroom', 'fail', 'No GPU node has enough free CPU/memory for this pod', `Needs ${ s.cpu } CPU / ${ s.memory }; most free: ${ [...f.gpuNodes].sort((a, b) => b.memFree - a.memFree).map((n) => `${ n.name } ${ n.cpuFree.toFixed(1) } CPU / ${ fmtMem(n.memFree) }`)[0] }.`);
    } else {
      add('headroom', 'pass', `${ fits.length } GPU node(s) have room for ${ s.cpu } CPU / ${ s.memory }`);
    }
  }

  // Model cache volume
  if (s.storageClass && f.storageClasses.length && !f.storageClasses.some((c) => c.name === s.storageClass)) {
    add('storage-class', 'fail', `Storage class ${ s.storageClass } does not exist`, `The model cache (${ s.cacheSize }) would stay Pending. Classes here: ${ f.storageClasses.map((c) => c.name).join(', ') }.`);
  }

  // Secrets the profile needs in the project. An empty list usually means "could not list them"
  // (submitters often cannot read Secrets), which is a warning, not a failure.
  if (input.namespace) {
    requiredSecrets.forEach((r) => {
      if (!f.secrets.length) {
        add('required-secret', 'warn', `Cannot check for Secret ${ r.name }`, `This profile needs it in ${ input.namespace }. ${ r.hint }`);
      } else if (!f.secrets.includes(r.name)) {
        add('required-secret', 'fail', `Secret ${ r.name } is missing in ${ input.namespace }`, r.hint);
      } else {
        add('required-secret', 'pass', `Secret ${ r.name } present`);
      }
    });
  }

  // Gated models need a token
  if (GATED.test(s.model) && input.namespace && f.secrets.length && !f.secrets.includes('huggingface-token')) {
    add('hf-token', 'warn', `${ s.model } is gated on Hugging Face`, `Create Secret huggingface-token (key HF_TOKEN) in ${ input.namespace }, or the model download is refused.`);
  }

  return out;
}

/** The AIWorkload a deployment creates. Its namespace is the project namespace it installs into. */
export function aiWorkloadFor(input: InferenceInput, ref: BlueprintRef, profileName: string, displayName: string, clusterId: string): any {
  return {
    type:     AIWORKLOAD_TYPE,
    metadata: {
      name:      input.name,
      namespace: input.namespace,
      labels:    { [WORKLOAD_PROFILE_LABEL]: profileName },
    },
    spec: {
      displayName,
      deployStrategy:  'FleetBundle',
      source:          { sourceType: 'Blueprint', blueprint: { name: ref.name, version: ref.version } },
      targetClusters:  [clusterId],
      targetNamespace: input.namespace,
    },
  };
}

/**
 * In-cluster OpenAI-compatible base URL clients should use: the LiteLLM gateway when the blueprint
 * has one (its Service is named after the release), otherwise the vLLM router.
 */
export function endpointUrl(s: BlueprintSummary, namespace: string): string {
  if (s.gateway) {
    return `http://${ s.gateway.release }.${ namespace }.svc:${ s.gateway.port }/v1`;
  }
  const i = s.components.findIndex((c) => /vllm/.test(c));

  return i < 0 ? '' : `http://${ s.releaseNames[i] }-router-service.${ namespace }.svc/v1`;
}
