#!/bin/sh
# TensorFlow Distributed Test: N workers, one per pod, form a MultiWorkerMirroredStrategy
# cluster from TF_CONFIG built off the chart's stable pod names (<job>-<index>.<job>.<namespace>.svc)
# and fit a tiny Keras model with gradients all-reduced across workers. CPU by default, DEVICE=gpu
# for one GPU per pod (tensorflow[and-cuda], NCCL all-reduce). No TFJob operator:
# the Indexed Job gives each pod its index (JOB_COMPLETION_INDEX) and the world size (NNODES).
set -e
AIF_TEST="TensorFlow Distributed Test"
DEVICE="${DEVICE:-cpu}"
# DEVICE=gpu: the run asked for a GPU; without an NVIDIA device in the pod nothing below can use one
if [ "$DEVICE" = gpu ] && ! ls /dev/nvidia[0-9]* >/dev/null 2>&1; then
  echo "FAIL  DEVICE=gpu but no NVIDIA device in the pod (/dev/nvidia*): no driver on the node, or a simulated GPU"
  [ "${JOB_COMPLETION_INDEX:-0}" = 0 ] && echo "AIF_RESULT {\"test\":\"$AIF_TEST\",\"status\":\"fail\",\"checks\":[{\"name\":\"GPU visible\",\"ok\":false,\"detail\":\"no /dev/nvidia* in the pod\"}]}"
  exit 3
fi
PKG=tensorflow; [ "$DEVICE" = gpu ] && PKG="tensorflow[and-cuda]"
pip install --quiet --no-cache-dir --disable-pip-version-check "$PKG==${TF_VERSION:-2.20.0}" >/tmp/pip.log 2>&1 || { tail -20 /tmp/pip.log; exit 3; }
cat > /tmp/test.py <<'PY'
import json, os, sys, time
rank, world = int(os.environ["JOB_COMPLETION_INDEX"]), int(os.environ["NNODES"])
job = os.environ["JOB_NAME"]
# RDZV_ENDPOINT is <job>-0.<job>.<namespace>.svc.cluster.local:<port>: the namespace is its third label
ns = os.environ["RDZV_ENDPOINT"].split(".")[2]
port = os.environ.get("TF_PORT", "2222")
workers = [f"{job}-{i}.{job}.{ns}.svc.cluster.local:{port}" for i in range(world)]
os.environ["TF_CONFIG"] = json.dumps({"cluster": {"worker": workers}, "task": {"type": "worker", "index": rank}})
os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "2")
import numpy as np
import tensorflow as tf

checks = []
def add(name, ok, detail):
    checks.append({"name": name, "ok": bool(ok), "detail": detail})
    print(("PASS " if ok else "FAIL ") + f" {name}  {detail}", flush=True)

t0 = time.time()
gpu = os.environ.get("DEVICE", "cpu") == "gpu"
if gpu:
    gpus = tf.config.list_physical_devices("GPU")
    add("GPU visible to TensorFlow", len(gpus) == 1, f"{len(gpus)} GPU(s); a CUDA build of TensorFlow is published for x86_64")
    if not gpus:
        print("AIF_RESULT " + json.dumps({"test": "TensorFlow Distributed Test", "status": "fail", "checks": checks}) if rank == 0 else "", flush=True)
        sys.exit(3)
opts = tf.distribute.experimental.CommunicationOptions(implementation=tf.distribute.experimental.CommunicationImplementation.NCCL if gpu else tf.distribute.experimental.CommunicationImplementation.AUTO)
strategy = tf.distribute.MultiWorkerMirroredStrategy(communication_options=opts)
add("Workers joined", strategy.num_replicas_in_sync == world, f"{strategy.num_replicas_in_sync} of {world} replicas in sync")

# every worker sees the same seeded data; the strategy shards it and all-reduces the gradients.
# A custom loop (strategy.run): Keras 3's model.fit does not support MultiWorkerMirroredStrategy.
rng = np.random.default_rng(0)
x = rng.normal(size=(2048, 4)).astype("float32")
y = (x @ np.array([1.0, -2.0, 0.5, 3.0], dtype="float32")).reshape(-1, 1)
batch = 64 * world
data = strategy.experimental_distribute_dataset(tf.data.Dataset.from_tensor_slices((x, y)).batch(batch))
with strategy.scope():
    w = tf.Variable(tf.zeros((4, 1)))
    opt = tf.keras.optimizers.SGD(0.1)

@tf.function
def step(xb, yb):
    def replica(xr, yr):
        with tf.GradientTape() as tape:
            loss = tf.reduce_sum(tf.square(xr @ w - yr)) / batch
        opt.apply_gradients([(tape.gradient(loss, w), w)])
        return loss
    return strategy.reduce(tf.distribute.ReduceOp.SUM, strategy.run(replica, args=(xb, yb)), axis=None)

losses = []
for _ in range(5):
    total = 0.0
    for xb, yb in data:
        total += float(step(xb, yb))
    losses.append(total)
first, last = losses[0], losses[-1]
add("Trains with all-reduced gradients", last < first * 0.05, f"loss {first:.3f} -> {last:.5f}")

ok = all(c["ok"] for c in checks)
if rank == 0:
    print("AIF_RESULT " + json.dumps({"test": "TensorFlow Distributed Test", "status": "pass" if ok else "fail", "checks": checks,
          "metrics": {"workers": str(world), "seconds": f"{time.time() - t0:.1f}"},
          "env": {"tensorflow": tf.__version__, "node": os.environ.get("NODE_NAME", "")}}), flush=True)
sys.exit(0 if ok else 1)
PY
exec python3 /tmp/test.py
