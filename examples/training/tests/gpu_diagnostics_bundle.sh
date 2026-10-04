#!/bin/sh
# GPU Diagnostics Bundle: what NVIDIA support and a platform team ask for first, collected from
# inside a pod on the GPU, as a .tar.gz on the run's kept volume; plus health checks on what was
# collected (ECC, retired pages and remapped rows, throttling, temperature, PCIe link). The host's
# kernel log (XID errors) and its PCI tree need the host: run nvidia-bug-report.sh there for those.
# Prints each check, then one AIF_RESULT line. Exits non-zero if a check fails.
out_dir=${CHECKPOINT_DIR:-/tmp}; stamp=$(date -u +%Y%m%dT%H%M%SZ)
work=/tmp/gpu-diag-$stamp; mkdir -p "$work"
ok=true; checks=""; metrics=""
add() { [ -n "$checks" ] && checks="$checks,"; checks="$checks{\"name\":\"$1\",\"ok\":$2,\"detail\":\"$3\"}"
        if [ "$2" = true ]; then echo "PASS  $1  $3"; else echo "FAIL  $1  $3"; ok=false; fi; }
# worth knowing, not a failure: passes, flagged
warn() { [ -n "$checks" ] && checks="$checks,"; checks="$checks{\"name\":\"$1\",\"ok\":true,\"warn\":true,\"detail\":\"$2\"}"; echo "WARN  $1  $2"; }
metric() { [ -n "$metrics" ] && metrics="$metrics,"; metrics="$metrics\"$1\":\"$2\""; }
q() { nvidia-smi --query-gpu="$1" --format=csv,noheader,nounits 2>/dev/null | head -1 | sed 's/^ *//;s/ *$//'; }
run() { f=$1; shift; { echo "\$ $*"; "$@"; } > "$work/$f" 2>&1 || true; }

if ! nvidia-smi >/dev/null 2>&1; then
  add "NVIDIA driver answers" false "nvidia-smi missing or failed: no GPU attached, or the runtime class is wrong"
else
  add "NVIDIA driver answers" true "$(q driver_version)"
  echo "collecting..."
  run nvidia-smi.txt nvidia-smi
  run nvidia-smi-q.txt nvidia-smi -q
  run nvidia-smi-q.xml nvidia-smi -q -x
  run health.txt nvidia-smi -q -d ECC,PAGE_RETIREMENT,ROW_REMAPPER,PERFORMANCE,TEMPERATURE,POWER,CLOCK
  run topology.txt nvidia-smi topo -m
  run nvlink.txt nvidia-smi nvlink -s
  run gpus.csv nvidia-smi --query-gpu=index,name,uuid,serial,pci.bus_id,driver_version,vbios_version,memory.total,memory.used,temperature.gpu,power.draw,power.limit,pcie.link.gen.current,pcie.link.gen.max,pcie.link.width.current,pcie.link.width.max --format=csv
  run driver.txt sh -c 'cat /proc/driver/nvidia/version /proc/driver/nvidia/gpus/*/information 2>/dev/null'
  run libraries.txt sh -c 'ldconfig -p | grep -E "libcuda|libnvidia-ml|libnvidia" ; ls -l /dev/nvidia* 2>/dev/null'
  run environment.txt sh -c 'uname -a; cat /etc/os-release; echo; env | grep -E "^(NVIDIA|CUDA|HAMI|GPU|LD_PRELOAD|KUBERNETES_SERVICE_HOST|NODE_NAME)" | sort; echo; cat /proc/self/cgroup; echo; ulimit -a'

  name=$(q name); mem=$(q memory.total)
  metric "GPU" "$name"; metric "GPU memory (MiB, as this pod sees it: a share shows its share)" "$mem"; metric "Driver" "$(q driver_version)"; metric "VBIOS" "$(q vbios_version)"

  ecc=$(q ecc.errors.uncorrected.volatile.total)
  case "$ecc" in ''|*N/A*|*Not*) add "No uncorrected ECC errors" true "ECC not reported by this GPU";;
    0) add "No uncorrected ECC errors" true "0 since the driver loaded";;
    *) add "No uncorrected ECC errors" false "$ecc uncorrected ECC error(s) since the driver loaded";; esac
  pend=$(q remapped_rows.pending); [ -z "$pend" ] && pend=$(q retired_pages.pending)
  case "$pend" in ''|*N/A*|*Not*) add "No memory repair pending" true "not reported by this GPU";;
    No|no|0) add "No memory repair pending" true "no remapped rows or retired pages pending";;
    *) add "No memory repair pending" false "memory repair pending ($pend): reset the GPU or reboot the node";; esac
  # bits of clocks_event_reasons: 0x1 idle and 0x4 app clocks setting are normal; the rest slow the GPU
  thr=$(q clocks_event_reasons.active); [ -z "$thr" ] && thr=$(q clocks_throttle_reasons.active)
  case "$thr" in ''|*N/A*) add "Not throttled" true "not reported";;
    0x0000000000000000|0x0000000000000001|0x0000000000000004|0x0000000000000005) add "Not throttled" true "clock reasons $thr (idle or settings only)";;
    *) add "Not throttled" false "clock reasons $thr: power, thermal or hardware slowdown; see health.txt";; esac
  # off: each job re-initialises the driver (slower starts), and DCGM diagnostics expect it on
  pm=$(q persistence_mode)
  case "$pm" in Enabled) add "Persistence mode" true "enabled";;
    Disabled) warn "Persistence mode" "disabled: each job re-initialises the driver; enable the nvidia-persistenced service on the node";;
    *) add "Persistence mode" true "not reported";; esac
  t=$(q temperature.gpu); metric "Temperature (C)" "$t"
  if [ -n "$t" ] && [ "$t" -lt 85 ] 2>/dev/null; then add "Temperature" true "${t} C"; else add "Temperature" false "${t:-unknown} C"; fi
  wc=$(q pcie.link.width.current); wm=$(q pcie.link.width.max); gc=$(q pcie.link.gen.current); gm=$(q pcie.link.gen.max)
  metric "PCIe link" "gen $gc of $gm, x$wc of x$wm"
  # The GPU's own maximum is not the target: a root port wired x8 (lanes shared with NVMe slots)
  # gives every x16 card x8, and that is the best the slot can do. Compare with the port above the
  # GPU instead. In a VM that port is the hypervisor's virtual one, whose widths say nothing about
  # the physical slot. Speed is not checked: an idle GPU drops its link to 2.5 GT/s.
  b=$(q pci.bus_id | tr 'A-F' 'a-f'); b=${b#0000}
  dev=$(readlink -f "/sys/bus/pci/devices/$b" 2>/dev/null); up=${dev%/*}
  pm=""; pv=""
  if [ -n "$dev" ] && [ -r "$up/max_link_width" ]; then
    pm=$(cat "$up/max_link_width"); pv=$(cat "$up/vendor")
    { echo "GPU   $b: max x$(cat "$dev/max_link_width") $(cat "$dev/max_link_speed"), now x$(cat "$dev/current_link_width") $(cat "$dev/current_link_speed")"
      echo "port  ${up##*/} ($pv:$(cat "$up/device")): max x$pm $(cat "$up/max_link_speed"), now x$(cat "$up/current_link_width") $(cat "$up/current_link_speed")"
    } > "$work/pcie.txt"
  fi
  case "$pv" in
    # QEMU/Red Hat, VMware, Microsoft (Hyper-V), Xen
    0x1b36|0x15ad|0x1414|0x5853)
      add "PCIe link width" true "x$wc of the GPU's x$wm, behind a virtual PCIe port: the physical slot cannot be seen from a VM; check lspci -vv on the host for the root port's width" ;;
    *)
      best=$wm; [ -n "$pm" ] && [ "$pm" -lt "$wm" ] 2>/dev/null && best=$pm
      if [ -z "$wc" ]; then add "PCIe link width" true "not reported"
      elif [ "$wc" = "$wm" ]; then add "PCIe link width" true "x$wc"
      elif [ "$wc" = "$best" ]; then add "PCIe link width" true "x$wc: the most this slot's port offers (the GPU supports x$wm)"
      elif [ -n "$pm" ]; then warn "PCIe link width" "x$wc where GPU and port both support x$best: check the card is seated, the riser, and the slot's lane sharing in the BIOS"
      else warn "PCIe link width" "x$wc of x$wm, and the port above the GPU could not be read: check lspci -vv on the host"; fi ;;
  esac
fi

bundle="$out_dir/gpu-diagnostics-$stamp.tar.gz"
if tar -C /tmp -czf "$bundle" "gpu-diag-$stamp" 2>/dev/null; then
  add "Bundle written" true "$bundle ($(du -h "$bundle" | cut -f1))"; metric "Bundle" "$bundle"
else
  add "Bundle written" false "could not write to $out_dir"
fi
$ok && st=pass || st=fail
echo "AIF_RESULT {\"test\":\"GPU Diagnostics Bundle\",\"status\":\"$st\",\"checks\":[$checks],\"metrics\":{$metrics},\"env\":{\"node\":\"${NODE_NAME:-$(hostname)}\",\"host-level\":\"run nvidia-bug-report.sh on the node for the kernel log and PCI tree\"}}"
$ok
