#!/bin/sh
# CPU Smoke Test: a CPU-only run is placed, starts and computes. No GPU and no PyTorch needed: busy
# loops in sh for WORK_SECONDS, then one AIF_RESULT line. With HOLD_SECONDS it then sits idle that
# long, which is how to watch idle reclaim in a pool that reclaims idle runs.
ok=true; checks=""
add() { [ -n "$checks" ] && checks="$checks,"; checks="$checks{\"name\":\"$1\",\"ok\":$2,\"detail\":\"$3\"}"; [ "$2" = true ] && echo "PASS  $1  $3" || { echo "FAIL  $1  $3"; ok=false; }; }

if ls /dev/nvidia[0-9]* >/dev/null 2>&1; then
  add "No GPU attached" false "a GPU is visible: the run was given one"
else
  add "No GPU attached" true "CPU only, as asked"
fi

cpus=$(nproc 2>/dev/null || grep -c ^processor /proc/cpuinfo)
limit="none"
if [ -r /sys/fs/cgroup/cpu.max ]; then
  read -r quota period < /sys/fs/cgroup/cpu.max
  [ "$quota" != max ] && limit="$((quota / period)).$((quota * 10 / period % 10)) CPU"
fi
add "CPUs visible" true "$cpus on the node, limit $limit"

mem="unknown"
[ -r /sys/fs/cgroup/memory.max ] && mem=$(cat /sys/fs/cgroup/memory.max)
[ "$mem" != max ] && [ "$mem" != unknown ] && mem="$((mem / 1048576)) MiB"
add "Memory limit" true "$mem"

work=${WORK_SECONDS:-30}
echo "computing for ${work}s..."
end=$(( $(date +%s) + work )); n=0
while [ "$(date +%s)" -lt "$end" ]; do
  i=0; while [ $i -lt 2000 ]; do i=$((i + 1)); done
  n=$((n + 1))
done
rate=$(( n * 2000 / work ))
[ "$rate" -gt 0 ] && add "Computes" true "$rate loop steps/s on one core" || add "Computes" false "no progress"

$ok && st=pass || st=fail
echo "AIF_RESULT {\"test\":\"CPU Smoke Test\",\"status\":\"$st\",\"checks\":[$checks],\"metrics\":{\"loop steps/s\":\"$rate\"},\"env\":{\"node\":\"${NODE_NAME:-$(hostname)}\",\"cpus\":\"$cpus\"}}"

hold=${HOLD_SECONDS:-0}
if [ "$hold" -gt 0 ]; then
  echo "holding idle for ${hold}s (HOLD_SECONDS)"
  sleep "$hold"
fi
$ok
