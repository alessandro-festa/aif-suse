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

package aijob

import (
	"fmt"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	corev1 "k8s.io/api/core/v1"
	resourcev1 "k8s.io/api/resource/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"

	"github.com/SUSE/aif-operator/api/v1alpha1"
)

var t0 = time.Date(2026, 10, 2, 9, 0, 0, 0, time.UTC)

func ts(d time.Duration) string { return t0.Add(d).Format(time.RFC3339) }

func execution(kind string, conds ...map[string]interface{}) *unstructured.Unstructured {
	u := &unstructured.Unstructured{Object: map[string]interface{}{"kind": kind, "metadata": map[string]interface{}{"name": "train-1", "uid": "u1"}}}
	if len(conds) > 0 {
		list := make([]interface{}, len(conds))
		for i, c := range conds {
			list[i] = c
		}
		_ = unstructured.SetNestedSlice(u.Object, list, "status", "conditions")
	}
	return u
}

func cond(t, status string, at time.Duration, reason, msg string) map[string]interface{} {
	return map[string]interface{}{"type": t, "status": status, "lastTransitionTime": ts(at), "reason": reason, "message": msg}
}

func workload(admitted bool) *unstructured.Unstructured {
	u := &unstructured.Unstructured{Object: map[string]interface{}{
		"metadata": map[string]interface{}{"name": "job-train-1-abc"},
		"spec":     map[string]interface{}{"queueName": "default-queue"},
	}}
	if admitted {
		_ = unstructured.SetNestedField(u.Object, "gpu-cluster-queue", "status", "admission", "clusterQueue")
		_ = unstructured.SetNestedSlice(u.Object, []interface{}{cond("Admitted", "True", time.Minute, "Admitted", "")}, "status", "conditions")
	}
	return u
}

func pod(name string, idx int, phase corev1.PodPhase, started time.Duration, exit *int32) corev1.Pod {
	p := corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{Name: name, Annotations: map[string]string{completionIndex: fmt.Sprint(idx)}},
		Spec:       corev1.PodSpec{NodeName: "gpu-node-1"},
		Status:     corev1.PodStatus{Phase: phase},
	}
	cs := corev1.ContainerStatus{Name: "trainer", RestartCount: 1}
	switch {
	case exit != nil:
		cs.State.Terminated = &corev1.ContainerStateTerminated{ExitCode: *exit, Reason: "Error", StartedAt: metav1.NewTime(t0.Add(started))}
	case phase == corev1.PodRunning:
		cs.State.Running = &corev1.ContainerStateRunning{StartedAt: metav1.NewTime(t0.Add(started))}
	}
	p.Status.ContainerStatuses = []corev1.ContainerStatus{cs}
	return p
}

func i32(v int32) *int32 { return &v }

// kaiPod is a pod KAI Scheduler has not placed yet (or has, on node).
func kaiPod(name, node string, phase corev1.PodPhase) corev1.Pod {
	return corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{Name: name, Labels: map[string]string{kaiQueueLabel: "team-a"}},
		Spec:       corev1.PodSpec{SchedulerName: kaiScheduler, NodeName: node},
		Status:     corev1.PodStatus{Phase: phase},
	}
}

func TestDerivePhase(t *testing.T) {
	cases := []struct {
		name      string
		current   v1alpha1.AIJobPhase
		installed bool
		o         observed
		want      v1alpha1.AIJobPhase
	}{
		{"not installed", v1alpha1.AIJobPhasePending, false, observed{}, v1alpha1.AIJobPhasePending},
		{"queued in Kueue", v1alpha1.AIJobPhasePending, true, observed{execution: execution("Job"), workload: workload(false)}, v1alpha1.AIJobPhaseQueued},
		{"admitted, no pod yet", v1alpha1.AIJobPhaseQueued, true, observed{execution: execution("Job"), workload: workload(true)}, v1alpha1.AIJobPhaseAdmitted},
		{"a pod runs", v1alpha1.AIJobPhaseAdmitted, true, observed{execution: execution("Job"), workload: workload(true), pods: []corev1.Pod{pod("p0", 0, corev1.PodRunning, 2*time.Minute, nil)}}, v1alpha1.AIJobPhaseRunning},
		{"no Kueue, scheduling", v1alpha1.AIJobPhasePending, true, observed{execution: execution("Job")}, v1alpha1.AIJobPhasePending},
		{"held by KAI", v1alpha1.AIJobPhasePending, true, observed{execution: execution("Job"), pods: []corev1.Pod{kaiPod("p0", "", corev1.PodPending)}}, v1alpha1.AIJobPhaseQueued},
		{"placed by KAI, starting", v1alpha1.AIJobPhaseQueued, true, observed{execution: execution("Job"), pods: []corev1.Pod{kaiPod("p0", "gpu-node-1", corev1.PodPending)}}, v1alpha1.AIJobPhasePending},
		{"KAI pod runs", v1alpha1.AIJobPhaseQueued, true, observed{execution: execution("Job"), pods: []corev1.Pod{kaiPod("p0", "gpu-node-1", corev1.PodRunning)}}, v1alpha1.AIJobPhaseRunning},
		{"Job Complete", v1alpha1.AIJobPhaseRunning, true, observed{execution: execution("Job", cond("Complete", "True", time.Hour, "", ""))}, v1alpha1.AIJobPhaseSucceeded},
		{"Job Failed", v1alpha1.AIJobPhaseRunning, true, observed{execution: execution("Job", cond("Failed", "True", time.Hour, "BackoffLimitExceeded", "x"))}, v1alpha1.AIJobPhaseFailed},
		{"PyTorchJob Succeeded", v1alpha1.AIJobPhaseRunning, true, observed{execution: execution("PyTorchJob", cond("Running", "False", 0, "", ""), cond("Succeeded", "True", time.Hour, "", ""))}, v1alpha1.AIJobPhaseSucceeded},
		{"terminal never moves", v1alpha1.AIJobPhaseCancelled, true, observed{execution: execution("Job"), pods: []corev1.Pod{pod("p0", 0, corev1.PodRunning, 0, nil)}}, v1alpha1.AIJobPhaseCancelled},
		{"running stays running between pod end and Job verdict", v1alpha1.AIJobPhaseRunning, true, observed{execution: execution("Job")}, v1alpha1.AIJobPhaseRunning},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			assert.Equal(t, c.want, derivePhase(c.current, c.installed, c.o))
		})
	}
}

func TestApplyObservationRecordsFactsAndKeepsThemWhenObjectsGo(t *testing.T) {
	st := &v1alpha1.AIJobStatus{}
	applyObservation(st, observed{
		execution: execution("Job"),
		workload:  workload(true),
		pods:      []corev1.Pod{pod("train-1-0", 0, corev1.PodRunning, 3*time.Minute, nil), pod("train-1-1", 1, corev1.PodRunning, 2*time.Minute, nil)},
	})
	assert.Equal(t, "Job", st.Execution.Kind)
	assert.Equal(t, "default-queue", st.Queue.LocalQueue)
	assert.Equal(t, "gpu-cluster-queue", st.Queue.ClusterQueue)
	require.NotNil(t, st.AdmittedAt)
	assert.True(t, st.AdmittedAt.Time.Equal(t0.Add(time.Minute)))
	require.NotNil(t, st.StartedAt)
	assert.True(t, st.StartedAt.Time.Equal(t0.Add(2*time.Minute)), "earliest container start")
	require.Len(t, st.Pods, 2)
	assert.Equal(t, "gpu-node-1", st.Pods[0].Node)

	// The Job's ttl removed everything: the record keeps what it saw.
	applyObservation(st, observed{})
	assert.Len(t, st.Pods, 2)
	assert.Equal(t, "Job", st.Execution.Kind)
	assert.Equal(t, "gpu-cluster-queue", st.Queue.ClusterQueue)
}

func TestApplyObservationRecordsTheKAIQueue(t *testing.T) {
	st := &v1alpha1.AIJobStatus{}
	applyObservation(st, observed{execution: execution("Job"), pods: []corev1.Pod{kaiPod("p0", "", corev1.PodPending)}})
	require.NotNil(t, st.Queue)
	assert.Equal(t, "team-a", st.Queue.KAIQueue)
	assert.Empty(t, st.Queue.Workload, "no Kueue Workload")
}

func TestPodsAreBoundedToFailedOnesAboveSixteen(t *testing.T) {
	st := &v1alpha1.AIJobStatus{}
	var pods []corev1.Pod
	for i := 0; i < 20; i++ {
		var exit *int32
		phase := corev1.PodSucceeded
		if i == 7 {
			exit, phase = i32(137), corev1.PodFailed
		}
		pods = append(pods, pod(fmt.Sprintf("w-%02d", i), i, phase, 0, exit))
	}
	mergePods(st, pods)
	require.NotNil(t, st.PodCounts)
	assert.Equal(t, int32(19), st.PodCounts.Succeeded)
	assert.Equal(t, int32(1), st.PodCounts.Failed)
	require.Len(t, st.Pods, 1)
	assert.Equal(t, "w-07", st.Pods[0].Name)
	assert.Equal(t, int32(137), *st.Pods[0].ExitCode)
}

func TestCompletionTakesTheExecutionsVerdictAndTheFailingExitCode(t *testing.T) {
	st := &v1alpha1.AIJobStatus{}
	completion(st, execution("Job", cond("Failed", "True", 90*time.Minute, "BackoffLimitExceeded", "Job has reached the specified backoff limit")),
		[]corev1.Pod{pod("p1", 1, corev1.PodFailed, 0, i32(1)), pod("p0", 0, corev1.PodSucceeded, 0, i32(0))})
	require.NotNil(t, st.CompletedAt)
	assert.True(t, st.CompletedAt.Time.Equal(t0.Add(90*time.Minute)))
	assert.Equal(t, "BackoffLimitExceeded", st.Result.Reason)
	assert.Equal(t, int32(1), *st.Result.ExitCode, "the failing rank's code, not rank 0's success")
}

func TestGPUFactsFromDRAClaimsAndFromTheDevicePlugin(t *testing.T) {
	claimName := "train-1-0-gpu-x7"
	draPod := pod("train-1-0", 0, corev1.PodRunning, 0, nil)
	draPod.Spec.ResourceClaims = []corev1.PodResourceClaim{{Name: "gpu", ResourceClaimTemplateName: strPtr("train-1-gpu")}}
	draPod.Status.ResourceClaimStatuses = []corev1.PodResourceClaimStatus{{Name: "gpu", ResourceClaimName: &claimName}}
	claim := &resourcev1.ResourceClaim{Status: resourcev1.ResourceClaimStatus{Allocation: &resourcev1.AllocationResult{
		Devices: resourcev1.DeviceAllocationResult{Results: []resourcev1.DeviceRequestAllocationResult{{Request: "gpu", Driver: "gpu.nvidia.com", Pool: "gpu-node-1", Device: "gpu-0"}}},
	}}}

	dpPod := pod("other-0", 0, corev1.PodRunning, 0, nil)
	dpPod.Spec.NodeName = "gpu-node-2"
	dpPod.Spec.Containers = []corev1.Container{{Name: "c", Resources: corev1.ResourceRequirements{Limits: corev1.ResourceList{gpuResource: resource.MustParse("2")}}}}

	nodes := map[string]*corev1.Node{
		"gpu-node-1": {ObjectMeta: metav1.ObjectMeta{Labels: map[string]string{gpuProductLabel: "NVIDIA-RTX-A2000-12GB"}}},
		"gpu-node-2": {ObjectMeta: metav1.ObjectMeta{Labels: map[string]string{gpuProductLabel: "NVIDIA-L40S"}}},
	}
	gpus := gpuFacts([]corev1.Pod{draPod, dpPod}, map[string]*resourcev1.ResourceClaim{claimName: claim}, nodes)
	require.Len(t, gpus, 3)
	assert.Equal(t, v1alpha1.AIJobGPU{Pod: "train-1-0", Mode: "dra", Device: "gpu-0", Pool: "gpu-node-1", Claim: claimName, Product: "NVIDIA-RTX-A2000-12GB"}, gpus[0])
	assert.Equal(t, "device-plugin", gpus[1].Mode)
	assert.Equal(t, "NVIDIA-L40S", gpus[2].Product)
}

func TestSharedClaimIsReadFromThePodSpec(t *testing.T) {
	p := pod("dev-1-0", 0, corev1.PodRunning, 0, nil)
	p.Spec.ResourceClaims = []corev1.PodResourceClaim{{Name: "gpu", ResourceClaimName: strPtr("gpu-shared")}}
	assert.Equal(t, []string{"gpu-shared"}, podClaimNames(p))
}

func TestExecutionNameFollowsTheChartFullname(t *testing.T) {
	assert.Equal(t, "train-20261002-8f29a", executionName("train-20261002-8f29a"))
	long := "a-very-long-job-name-that-goes-past-the-fifty-two-char-limit"
	assert.Len(t, executionName(long), 52)
}

func strPtr(s string) *string { return &s }
