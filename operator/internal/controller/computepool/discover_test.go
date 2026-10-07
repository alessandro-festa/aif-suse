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

package computepool

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	"github.com/SUSE/aif-operator/api/v1alpha1"
	"github.com/SUSE/aif-operator/internal/trainchart"
)

func node(name string, labels map[string]string, cpu, mem string, gpus int64) corev1.Node {
	alloc := corev1.ResourceList{
		corev1.ResourceCPU:    resource.MustParse(cpu),
		corev1.ResourceMemory: resource.MustParse(mem),
	}
	if gpus > 0 {
		alloc[gpuResource] = *resource.NewQuantity(gpus, resource.DecimalSI)
	}
	return corev1.Node{ObjectMeta: metav1.ObjectMeta{Name: name, Labels: labels}, Status: corev1.NodeStatus{Allocatable: alloc}}
}

func h100(name string) corev1.Node {
	return node(name, map[string]string{gpuProductLabel: "NVIDIA-H100-80GB-HBM3", gpuPresentLabel: "true", gpuMemoryLabel: "81559"}, "64", "512Gi", 8)
}

func l4(name string) corev1.Node {
	return node(name, map[string]string{gpuProductLabel: "NVIDIA-L4", gpuPresentLabel: "true", gpuMemoryLabel: "23034"}, "32", "128Gi", 2)
}

func cpuNode(name string) corev1.Node { return node(name, nil, "16", "64Gi", 0) }

func pod(nodeName string, phase corev1.PodPhase, cpu, mem string, gpus int64) corev1.Pod {
	c := corev1.Container{Resources: corev1.ResourceRequirements{Requests: corev1.ResourceList{
		corev1.ResourceCPU: resource.MustParse(cpu), corev1.ResourceMemory: resource.MustParse(mem),
	}}}
	if gpus > 0 {
		c.Resources.Limits = corev1.ResourceList{gpuResource: *resource.NewQuantity(gpus, resource.DecimalSI)}
	}
	return corev1.Pod{Spec: corev1.PodSpec{NodeName: nodeName, Containers: []corev1.Container{c}}, Status: corev1.PodStatus{Phase: phase}}
}

func TestDiscoverPoolsOnePerGPUModelAndOneForCPU(t *testing.T) {
	got := discoverPools("c-abc", "prod", []corev1.Node{h100("g1"), h100("g2"), l4("g3"), cpuNode("c1")})
	require.Len(t, got, 3)
	assert.Equal(t, "c-abc-gpu-nvidia-h100-80gb-hbm3", got[0].Name)
	assert.Equal(t, v1alpha1.ComputePoolKindGPU, got[0].Spec.Kind)
	for _, p := range got {
		assert.Equal(t, "prod", p.Spec.DisplayName, "every pool is named after its cluster; kind and model tell them apart")
	}
	assert.Equal(t, "c-abc-gpu-nvidia-l4", got[1].Name)
	assert.Equal(t, "c-abc-cpu", got[2].Name)
	assert.Equal(t, v1alpha1.ComputePoolKindCPU, got[2].Spec.Kind)
}

func TestDiscoverPoolsOnlyForKindsOfNodeTheClusterHas(t *testing.T) {
	got := discoverPools("c-ops", "ops", []corev1.Node{cpuNode("c1")})
	require.Len(t, got, 1, "a GPU-less cluster is one CPU pool")
	assert.Equal(t, "c-ops-cpu", got[0].Name)

	got = discoverPools("c-x", "x", []corev1.Node{node("g", map[string]string{gpuPresentLabel: "true"}, "8", "32Gi", 1)})
	require.Len(t, got, 1)
	assert.Equal(t, "c-x-gpu", got[0].Name, "GPUs that do not name their product")
}

func TestPoolStatusCountsTheSelectedSchedulableNodesAndWhatRunsOnThem(t *testing.T) {
	nodes := []corev1.Node{h100("g1"), h100("g2"), l4("g3"), cpuNode("c1")}
	cordoned := h100("g4")
	cordoned.Spec.Unschedulable = true
	nodes = append(nodes, cordoned)
	pods := []corev1.Pod{
		pod("g1", corev1.PodRunning, "8", "64Gi", 4),
		pod("g2", corev1.PodPending, "2", "8Gi", 1),
		pod("g2", corev1.PodSucceeded, "30", "100Gi", 8), // finished: requests nothing
		pod("g3", corev1.PodRunning, "1", "1Gi", 1),      // another pool's node
	}
	pools := discoverPools("c-abc", "prod", nodes)

	st, err := poolStatus(pools[0].Spec, nodes, pods, stack{Schedulers: []string{"kai"}})
	require.NoError(t, err)
	assert.Equal(t, int32(2), st.Nodes, "the cordoned H100 is not capacity")
	assert.Equal(t, int64(16), st.Allocatable.GPUs)
	assert.Equal(t, "128", st.Allocatable.CPU.String())
	assert.Equal(t, int64(5), st.Requested.GPUs)
	assert.Equal(t, "10", st.Requested.CPU.String())
	require.NotNil(t, st.GPU)
	assert.Equal(t, []string{"NVIDIA-H100-80GB-HBM3"}, st.GPU.Models)
	assert.Equal(t, int64(81559), st.GPU.MemoryMiB)
	assert.Equal(t, []string{"kai"}, st.Schedulers)

	cpu, err := poolStatus(pools[2].Spec, nodes, pods, stack{})
	require.NoError(t, err)
	assert.Equal(t, int32(1), cpu.Nodes, "the CPU pool excludes every labelled GPU node")
	assert.Zero(t, cpu.Allocatable.GPUs)
	assert.Nil(t, cpu.GPU)
}

func TestPoolStatusWithoutSelectorTakesEveryNode(t *testing.T) {
	st, err := poolStatus(v1alpha1.ComputePoolSpec{Kind: v1alpha1.ComputePoolKindGPU}, []corev1.Node{h100("g1"), l4("g2")}, nil, stack{})
	require.NoError(t, err)
	assert.Equal(t, int32(2), st.Nodes)
	assert.Equal(t, []string{"NVIDIA-H100-80GB-HBM3", "NVIDIA-L4"}, st.GPU.Models)
	assert.Equal(t, int64(23034), st.GPU.MemoryMiB, "the smallest GPU")
}

func TestDetectStackReadsTheChartsSchedulerTable(t *testing.T) {
	backends, err := trainchart.Backends()
	require.NoError(t, err)

	assert.Equal(t, []string{"kai"}, detectStack([]string{"scheduling.run.ai", "apps"}, nil, backends).Schedulers)
	runai := detectStack([]string{"scheduling.run.ai", "run.ai"}, nil, backends)
	assert.Equal(t, []string{"runai"}, runai.Schedulers, "Run:AI ships KAI's queue CRD; it is not KAI")
	assert.Empty(t, runai.Sharing)

	kai := detectStack([]string{"scheduling.run.ai", "kueue.x-k8s.io"}, nil, backends)
	assert.Equal(t, []string{"kai", "kueue"}, kai.Schedulers)
	assert.Equal(t, []string{"kai-fraction"}, kai.Sharing)

	hami := corev1.Node{ObjectMeta: metav1.ObjectMeta{Annotations: map[string]string{hamiNodeAnnotation: "GPU-0,10,24576,100,NVIDIA-L4,0,true"}}}
	assert.Equal(t, []string{"hami"}, detectStack(nil, []corev1.Node{hami}, backends).Sharing)

	assert.Equal(t, []string{"training-operator", "trainer-v2"}, detectStack([]string{"kubeflow.org", "trainer.kubeflow.org"}, nil, backends).Training)
	assert.Equal(t, stack{}, detectStack([]string{"apps", "batch"}, nil, backends))
}
