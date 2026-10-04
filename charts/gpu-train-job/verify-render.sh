#!/usr/bin/env bash
# Renders the chart across the combinations that matter and asserts the structure of the result.
# No cluster needed: `helm template` skips every `lookup`, so this exercises the templating only.
#
#   ./verify-render.sh
#
# Note for anyone extending this: never pipe `helm template` output through `echo "$var"`. The
# built-in training script is embedded as a double-quoted YAML scalar containing literal \n
# escapes, and some shells' `echo` expands them, corrupting the YAML before the parser sees it.
# Use `printf '%s\n'`.
set -uo pipefail
cd "$(dirname "$0")"
fail=0

render_ok() {
  local desc="$1"; shift
  local out
  if ! out=$(helm template t . "$@" 2>&1); then
    printf '✗ %s — render failed\n' "$desc"; printf '%s\n' "$out" | tail -3; fail=1; return
  fi
  if printf '%s\n' "$out" | python3 -c 'import sys,yaml; list(yaml.safe_load_all(sys.stdin))' 2>/dev/null; then
    printf '✓ %s\n' "$desc"
  else
    printf '✗ %s — invalid YAML\n' "$desc"; fail=1
  fi
}

echo "renders cleanly:"
render_ok "job/smoke/1node/none"     --set job.kind=job --set job.mode=smoke
render_ok "job/torchrun/2node/kueue" --set job.kind=job --set job.mode=torchrun --set job.nodes=2 --set scheduler.type=kueue --set scheduler.queue=lq
render_ok "job/torchrun/2node/kai"   --set job.kind=job --set job.mode=torchrun --set job.nodes=2 --set scheduler.type=kai --set scheduler.queue=training
render_ok "job/custom/1node/dra"     --set job.kind=job --set job.mode=custom --set gpu.mode=dra --set 'job.command={/bin/true}'
render_ok "pt/smoke/1node/none"      --set job.kind=pytorchjob --set job.mode=smoke
render_ok "pt/torchrun/3node/kai"    --set job.kind=pytorchjob --set job.mode=torchrun --set job.nodes=3 --set scheduler.type=kai --set scheduler.queue=training
render_ok "pt/torchrun/3node/kueue"  --set job.kind=pytorchjob --set job.mode=torchrun --set job.nodes=3 --set scheduler.type=kueue --set scheduler.queue=lq
render_ok "pt/dra/2node"             --set job.kind=pytorchjob --set job.nodes=2 --set gpu.mode=dra
render_ok "pt/storage/2node"         --set job.kind=pytorchjob --set job.nodes=2 --set storage.datasetPVC=d --set storage.checkpointPVC=c --set storage.configMap=cm --set storage.scratchSize=10Gi

echo
echo "PyTorchJob structure:"
helm template t . --set job.kind=pytorchjob --set job.mode=torchrun --set job.nodes=3 \
  --set scheduler.type=kai --set scheduler.queue=training --set storage.checkpointPVC=ckpt > /tmp/gtj-pt3.yaml 2>&1
helm template t . --set job.kind=pytorchjob --set job.nodes=1 > /tmp/gtj-pt1.yaml 2>&1

python3 - <<'PY' || fail=1
import sys, yaml
ok = True
def chk(cond, msg):
    global ok
    print(("✓ " if cond else "✗ ") + msg)
    ok = ok and cond

d = [x for x in yaml.safe_load_all(open('/tmp/gtj-pt3.yaml')) if x]
chk(len(d) == 1 and d[0]['kind'] == 'PyTorchJob', "3-node renders one PyTorchJob and no headless Service")
s = d[0]['spec']['pytorchReplicaSpecs']
chk(s['Master']['replicas'] == 1, "Master replicas == 1")
chk(s['Worker']['replicas'] == 2, "Worker replicas == nodes-1")
for role in ('Master', 'Worker'):
    ps = s[role]['template']['spec']
    c = ps['containers'][0]
    env = {e['name']: e.get('value') for e in c['env']}
    cmd = ' '.join(c['command'])
    chk(ps['schedulerName'] == 'kai-scheduler', f"{role}: schedulerName=kai-scheduler")
    chk(s[role]['template']['metadata']['labels']['kai.scheduler/queue'] == 'training', f"{role}: KAI queue label")
    chk(c['resources']['limits']['nvidia.com/gpu'] == '1', f"{role}: requests its GPU")
    chk(env.get('NNODES') == '3', f"{role}: NNODES matches job.nodes")
    chk(any(e['name'] == 'NODE_NAME' and e.get('valueFrom', {}).get('fieldRef', {}).get('fieldPath') == 'spec.nodeName' for e in c['env']),
        f"{role}: NODE_NAME is the node it runs on")
    chk('RDZV_ENDPOINT' not in env, f"{role}: no Job-path rendezvous env")
    chk(env.get('CHECKPOINT_DIR') == '/mnt/checkpoints', f"{role}: CHECKPOINT_DIR exported")
    chk(any(v['name'] == 'checkpoints' for v in ps['volumes']), f"{role}: checkpoint PVC mounted")
    chk('unset RANK WORLD_SIZE' in cmd, f"{role}: clears operator RANK/WORLD_SIZE before torchrun")
    chk('$MASTER_ADDR' in cmd, f"{role}: torchrun points at MASTER_ADDR")
chk(s['Master']['template'] == s['Worker']['template'], "Master and Worker pod templates identical")

d1 = [x for x in yaml.safe_load_all(open('/tmp/gtj-pt1.yaml')) if x]
chk('Worker' not in d1[0]['spec']['pytorchReplicaSpecs'], "1-node omits the Worker replica spec")
sys.exit(0 if ok else 1)
PY

out=$(helm template t . --set job.mode=torchrun --set job.nodes=2 2>&1)
if printf '%s\n' "$out" | grep -q "action: FailIndex" && printf '%s\n' "$out" | grep -q "type: DisruptionTarget"; then
  printf '✓ %s\n' "Job: podFailurePolicy fails fast on exit code 3 and ignores disruptions"
else
  printf '✗ %s\n' "Job: podFailurePolicy missing"; fail=1
fi

echo
[ $fail -eq 0 ] && echo "chart render checks passed" || echo "chart render checks FAILED"
exit $fail
