/*
Copyright 2025.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

package placement

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	"github.com/SUSE/aif-operator/api/v1alpha1"
)

func runningPod(name, node, cpuRequest string) corev1.Pod {
	p := corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: "vision"},
		Spec:       corev1.PodSpec{NodeName: node, Containers: []corev1.Container{{Name: "c"}}},
		Status:     corev1.PodStatus{Phase: corev1.PodRunning},
	}
	if cpuRequest != "" {
		p.Spec.Containers[0].Resources.Requests = corev1.ResourceList{corev1.ResourceCPU: resource.MustParse(cpuRequest)}
	}
	return p
}

const summary = `{"pods":[
 {"podRef":{"name":"a-0","namespace":"vision"},"cpu":{"usageNanoCores":100000000}},
 {"podRef":{"name":"a-1","namespace":"vision"},"cpu":{"usageNanoCores":300000000}},
 {"podRef":{"name":"other","namespace":"vision"},"cpu":{"usageNanoCores":4000000000}}]}`

func TestCPUUtilisationIsUsageOverRequest(t *testing.T) {
	pods := []corev1.Pod{runningPod("a-0", "n1", "2"), runningPod("a-1", "n1", "2")}
	pct, ok := cpuUtilisation(pods, map[string][]byte{"n1": []byte(summary)})
	require.True(t, ok)
	assert.Equal(t, int32(10), pct, "0.4 cores of the 4 requested; other pods do not count")

	pct, ok = cpuUtilisation([]corev1.Pod{runningPod("a-0", "n1", "")}, map[string][]byte{"n1": []byte(summary)})
	require.True(t, ok)
	assert.Equal(t, int32(10), pct, "no request and no limit: against one core")

	_, ok = cpuUtilisation([]corev1.Pod{runningPod("gone", "n1", "1")}, map[string][]byte{"n1": []byte(summary)})
	assert.False(t, ok, "a pod not in the stats is not a sample")
}

const dcgm = `# HELP DCGM_FI_DEV_GPU_UTIL GPU utilization (in %).
DCGM_FI_DEV_GPU_UTIL{gpu="0",modelName="L40S",namespace="vision",pod="a-0"} 2
DCGM_FI_DEV_GPU_UTIL{gpu="1",modelName="L40S",namespace="vision",pod="a-1"} 4
DCGM_FI_DEV_GPU_UTIL{gpu="2",modelName="L40S",namespace="team",pod="a-0"} 99
DCGM_FI_DEV_GPU_UTIL{gpu="3",modelName="L40S",namespace="",pod=""} 77
DCGM_FI_DEV_MEM_COPY_UTIL{gpu="0",namespace="vision",pod="a-0"} 50
`

func TestGPUUtilisationAveragesTheRunsGPUs(t *testing.T) {
	pct, ok := gpuUtilisation([]byte(dcgm), "vision", []string{"a-0", "a-1"})
	require.True(t, ok)
	assert.Equal(t, int32(3), pct, "its two GPUs; not the same pod name in another namespace, nor unattributed GPUs")

	_, ok = gpuUtilisation([]byte(dcgm), "vision", []string{"b-0"})
	assert.False(t, ok, "an exporter that attributes no GPU to the run")
}

func TestIdleDurations(t *testing.T) {
	for in, want := range map[string]int64{"30m": 30, "2h": 120, "3d": 4320} {
		got, err := parseIdleDuration(in)
		require.NoError(t, err)
		assert.Equal(t, want, got, in)
	}
	for _, bad := range []string{"", "h", "0h", "2w", "-1h"} {
		_, err := parseIdleDuration(bad)
		assert.Error(t, err, bad)
	}

	rc := &v1alpha1.ComputePoolReclaim{IdleTimeout: "2h", MaxIdleTimeout: "1d"}
	d, _ := idleTimeout(rc, nil)
	assert.Equal(t, 2*time.Hour, d, "the pool's")
	d, _ = idleTimeout(rc, &v1alpha1.AIJobReclaim{IdleTimeout: "30m"})
	assert.Equal(t, 30*time.Minute, d, "a run may ask for less")
	d, _ = idleTimeout(rc, &v1alpha1.AIJobReclaim{IdleTimeout: "3d"})
	assert.Equal(t, 24*time.Hour, d, "and for more, up to the pool's ceiling")
	d, _ = idleTimeout(&v1alpha1.ComputePoolReclaim{IdleTimeout: "2h"}, &v1alpha1.AIJobReclaim{IdleTimeout: "3d"})
	assert.Equal(t, 2*time.Hour, d, "no ceiling: the pool's timeout is it")
}

func TestTheIdleClockStartsUnderTheThresholdAndStopsAboveIt(t *testing.T) {
	at := func(m int) metav1.Time { return metav1.NewTime(t0.Add(time.Duration(m) * time.Minute)) }
	a := nextActivity(nil, 30, "cpu", 5, at(0))
	assert.Nil(t, a.IdleSince)
	assert.Equal(t, at(0), *a.LastActiveAt)
	a = nextActivity(a, 1, "cpu", 5, at(1))
	assert.Equal(t, at(1), *a.IdleSince)
	a = nextActivity(a, 2, "cpu", 5, at(2))
	assert.Equal(t, at(1), *a.IdleSince, "still idle since the first idle sample")
	a = nextActivity(a, 5, "cpu", 5, at(3))
	assert.Nil(t, a.IdleSince, "at the threshold counts as active")
	assert.Equal(t, at(3), *a.LastActiveAt)
}

func TestWhenAnIdleRunIsReclaimed(t *testing.T) {
	no := false
	p := gpuPool("a-l40s", "c-a", 8)
	p.Spec.Reclaim = &v1alpha1.ComputePoolReclaim{IdleTimeout: "30m"}
	always := p.DeepCopy()
	always.Spec.Reclaim.OnlyWhenContended = &no
	idleSince := func(m int) *v1alpha1.AIJobActivity {
		t := metav1.NewTime(t0.Add(-time.Duration(m) * time.Minute))
		return &v1alpha1.AIJobActivity{Source: "gpu", IdleSince: &t}
	}
	job := func(policy v1alpha1.AIJobReclaimPolicy, pinned string) *v1alpha1.AIJob {
		j := run("idle", "aif-vision", 0, "")
		j.Spec.Pool = pinned
		if policy != "" {
			j.Spec.Reclaim = &v1alpha1.AIJobReclaim{Policy: policy}
		}
		return j
	}

	for _, c := range []struct {
		name      string
		job       *v1alpha1.AIJob
		pool      *v1alpha1.ComputePool
		act       *v1alpha1.AIJobActivity
		contender string
		reclaim   bool
		policy    v1alpha1.AIJobReclaimPolicy
		why       string
	}{
		{"active", job("", ""), p, &v1alpha1.AIJobActivity{}, "aif-vision/next", false, v1alpha1.AIJobReclaimSuspend, ""},
		{"not idle long enough", job("", ""), p, idleSince(10), "aif-vision/next", false, v1alpha1.AIJobReclaimSuspend, "idle for 10m0s of 30m0s"},
		{"idle, someone waiting: Suspend by default", job("", ""), p, idleSince(31), "aif-vision/next", true, v1alpha1.AIJobReclaimSuspend, "idle for 31m0s (under 5% of its gpu), for aif-vision/next"},
		{"idle, Terminate", job(v1alpha1.AIJobReclaimTerminate, ""), p, idleSince(31), "aif-vision/next", true, v1alpha1.AIJobReclaimTerminate, ""},
		{"idle, nobody waiting", job("", ""), p, idleSince(31), "", false, v1alpha1.AIJobReclaimSuspend, "reclaimed when a waiting run needs the pool"},
		{"idle, nobody waiting, pool reclaims always", job("", ""), always, idleSince(31), "", true, v1alpha1.AIJobReclaimSuspend, ""},
		{"idle, Never", job(v1alpha1.AIJobReclaimNever, ""), p, idleSince(31), "aif-vision/next", false, v1alpha1.AIJobReclaimNever, "its reclaim policy is Never"},
		{"idle, pinned to its pool", job("", "a-l40s"), p, idleSince(31), "aif-vision/next", false, v1alpha1.AIJobReclaimSuspend, "submitted to pool a-l40s"},
	} {
		v := decide(c.job, c.pool, c.act, t0, c.contender)
		assert.Equal(t, c.reclaim, v.reclaim, c.name)
		assert.Equal(t, c.policy, v.policy, c.name)
		assert.Contains(t, v.why, c.why, c.name)
	}
}

type fakeProbe struct {
	pods    map[string][]corev1.Pod // by job name
	stats   []byte
	metrics []byte
}

func (f *fakeProbe) Pods(_ context.Context, _, _, jobID string) ([]corev1.Pod, error) {
	return f.pods[jobID], nil
}
func (f *fakeProbe) NodeStats(context.Context, string, string) ([]byte, error) { return f.stats, nil }
func (f *fakeProbe) GPUMetrics(context.Context, string) ([]byte, error)        { return f.metrics, nil }

// An idle 8-GPU run fills its pool; a 4-GPU run waits. The idle run is asked to
// leave and the waiting one is placed on its pool in the same pass.
func TestAnIdleRunHandsItsPoolToAWaitingOne(t *testing.T) {
	p := gpuPool("a-l40s", "c-a", 8)
	p.Status.Requested.GPUs = 8
	p.Status.ObservedAt = &metav1.Time{Time: t0}
	p.Spec.Reclaim = &v1alpha1.ComputePoolReclaim{IdleTimeout: "30m"}
	idle := run("idle", "aif-vision", 0, gpus(8))
	idle.Status.Phase = v1alpha1.AIJobPhaseRunning
	started := metav1.NewTime(t0.Add(-2 * time.Hour))
	idle.Status.StartedAt = &started
	idle.Status.Placement = &v1alpha1.AIJobPlacement{Pool: "a-l40s", ClusterID: "c-a", Namespace: "vision"}
	since := metav1.NewTime(t0.Add(-40 * time.Minute))
	idle.Status.Activity = &v1alpha1.AIJobActivity{IdleSince: &since}
	next := run("next", "aif-vision", 5, gpus(4))
	next.Status.PlacementMessage = "no compute pool fits now"
	h := newHarness(t, vision(), ns("aif-vision", "vision"), p, idle, next)
	probe := &fakeProbe{
		pods:    map[string][]corev1.Pod{"idle": {runningPod("idle-0", "n1", "1")}},
		metrics: []byte(`DCGM_FI_DEV_GPU_UTIL{gpu="0",namespace="vision",pod="idle-0"} 1` + "\n"),
	}
	rc := &Reclaimer{Client: h.c, Probe: probe, Now: func() time.Time { return t0 }}
	require.NoError(t, rc.Pass(context.Background()))

	got := h.job("aif-vision", "idle")
	assert.Equal(t, "Suspend", got.Annotations[v1alpha1.AIJobReclaimAnnotation], "the AIJob controller is asked to reclaim it")
	assert.Equal(t, int32(1), got.Status.Activity.Utilisation)
	assert.Equal(t, "gpu", got.Status.Activity.Source)
	assert.Equal(t, since.Unix(), got.Status.Activity.IdleSince.Unix(), "the idle clock kept running")
	assert.Contains(t, got.Status.Activity.Message, "for aif-vision/next")
	placed := h.job("aif-vision", "next").Status.Placement
	require.NotNil(t, placed, "the waiting run takes the pool at once")
	assert.Equal(t, v1alpha1.AIJobPlacement{Pool: "a-l40s", ClusterID: "c-a", Namespace: "vision"}, *placed)

	// Next pass: the idle run is not asked twice; the placement pass does not put
	// it back, as the waiting run now holds the pool.
	require.NoError(t, rc.Pass(context.Background()))
	h.pass()
	assert.Equal(t, "a-l40s", h.job("aif-vision", "next").Status.Placement.Pool)
	assert.Equal(t, "Suspend", h.job("aif-vision", "idle").Annotations[v1alpha1.AIJobReclaimAnnotation])
}

func TestAGPURunWithoutAttributedGPUsIsReadFromItsCPU(t *testing.T) {
	p := gpuPool("a-l40s", "c-a", 8)
	j := run("idle", "aif-vision", 0, "")
	j.Status.Placement = &v1alpha1.AIJobPlacement{Pool: "a-l40s", ClusterID: "c-a", Namespace: "vision"}
	probe := &fakeProbe{
		pods:    map[string][]corev1.Pod{"idle": {runningPod("a-0", "n1", "1")}},
		stats:   []byte(summary),
		metrics: []byte(`DCGM_FI_DEV_GPU_UTIL{gpu="0",namespace="",pod=""} 0` + "\n"), // no pod mapping
	}
	pct, source, err := sample(context.Background(), probe, j, p)
	require.NoError(t, err)
	assert.Equal(t, int32(10), pct)
	assert.Contains(t, source, "cpu (the DCGM exporter attributes no GPU")

	probe.metrics = nil
	_, source, err = sample(context.Background(), probe, j, p)
	require.NoError(t, err)
	assert.Equal(t, "cpu (no DCGM exporter on the cluster)", source)
}

func TestARunReclaimedForIdlingDoesNotTakeThePoolBack(t *testing.T) {
	p := gpuPool("a-l40s", "c-a", 8)
	p.Status.Requested.GPUs = 8
	p.Status.ObservedAt = &metav1.Time{Time: t0}
	p.Spec.Reclaim = &v1alpha1.ComputePoolReclaim{IdleTimeout: "30m"}
	idle := run("idle", "aif-vision", 5, gpus(8))
	idle.Status.Phase = v1alpha1.AIJobPhaseRunning
	idle.Status.Placement = &v1alpha1.AIJobPlacement{Pool: "a-l40s", ClusterID: "c-a", Namespace: "vision"}
	started := metav1.NewTime(t0.Add(-2 * time.Hour))
	idle.Status.StartedAt = &started
	since := metav1.NewTime(t0.Add(-40 * time.Minute))
	idle.Status.Activity = &v1alpha1.AIJobActivity{IdleSince: &since}
	before := run("before", "aif-vision", 0, gpus(4))
	before.Status.PlacementMessage = "no compute pool fits now"
	before.Status.Conditions = []metav1.Condition{{Type: v1alpha1.AIJobConditionReclaimed, Status: metav1.ConditionTrue, Reason: "Suspend", LastTransitionTime: since}}
	h := newHarness(t, vision(), ns("aif-vision", "vision"), p, idle, before)
	probe := &fakeProbe{
		pods:    map[string][]corev1.Pod{"idle": {runningPod("idle-0", "n1", "1")}},
		metrics: []byte(`DCGM_FI_DEV_GPU_UTIL{gpu="0",namespace="vision",pod="idle-0"} 0` + "\n"),
	}
	require.NoError(t, (&Reclaimer{Client: h.c, Probe: probe, Now: func() time.Time { return t0 }}).Pass(context.Background()))

	got := h.job("aif-vision", "idle")
	assert.NotContains(t, got.Annotations, v1alpha1.AIJobReclaimAnnotation, "the waiting run was itself reclaimed for idling")
	assert.Contains(t, got.Status.Activity.Message, "reclaimed when a waiting run needs the pool")
	assert.Nil(t, h.job("aif-vision", "before").Status.Placement)
}
