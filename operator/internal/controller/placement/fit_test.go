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
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	"github.com/SUSE/aif-operator/api/v1alpha1"
)

func TestNeedsAreTheValuesOverTheChartsDefaults(t *testing.T) {
	n, err := NeedsOf(nil)
	require.NoError(t, err)
	assert.Equal(t, int64(1), n.Nodes)
	assert.Equal(t, int64(1), n.GPUs(), "the chart asks for one GPU by default")
	assert.Equal(t, "1", n.CPU.String())
	assert.Equal(t, "2Gi", n.Memory.String())

	n, err = NeedsOf([]byte(`{"job":{"nodes":2,"gpusPerNode":4},"gpu":{"productName":"NVIDIA H100 80GB HBM3"},"resources":{"requests":{"cpu":"8"}}}`))
	require.NoError(t, err)
	assert.Equal(t, int64(8), n.GPUs())
	assert.Equal(t, "NVIDIA-H100-80GB-HBM3", n.Model, "spelled as the node label spells it")
	assert.Equal(t, "16", n.CPU.String(), "per node, times the nodes")

	n, err = NeedsOf([]byte(`{"gpu":{"sharedMemoryMiB":4096}}`))
	require.NoError(t, err)
	assert.Zero(t, n.GPUs(), "a share takes no whole GPU")
	assert.True(t, n.WantsGPU())

	n, err = NeedsOf([]byte(`{"job":{"gpusPerNode":0}}`))
	require.NoError(t, err)
	assert.False(t, n.WantsGPU(), "a CPU run")
}

func pool(name, kind string, gpus, usedGPUs int64, cpu string, models ...string) *v1alpha1.ComputePool {
	p := &v1alpha1.ComputePool{
		ObjectMeta: metav1.ObjectMeta{Name: name},
		Spec:       v1alpha1.ComputePoolSpec{ClusterID: "c-" + name, Kind: v1alpha1.ComputePoolKind(kind)},
		Status: v1alpha1.ComputePoolStatus{
			Allocatable: v1alpha1.ComputePoolResources{GPUs: gpus, CPU: resource.MustParse(cpu), Memory: resource.MustParse("256Gi")},
			Requested:   v1alpha1.ComputePoolResources{GPUs: usedGPUs},
			Conditions:  []metav1.Condition{{Type: v1alpha1.ComputePoolConditionConnected, Status: metav1.ConditionTrue}},
		},
	}
	if kind == "gpu" {
		p.Status.GPU = &v1alpha1.ComputePoolGPU{Models: models}
	}
	return p
}

func gpuRun(gpus int64, model string) Needs {
	return Needs{Nodes: 1, GPUsPerNode: gpus, Model: model, CPU: resource.MustParse("1"), Memory: resource.MustParse("2Gi")}
}

func TestTheFittingPoolWithTheMostFreeGPUsWins(t *testing.T) {
	a := pool("a", "gpu", 8, 6, "64", "L40S")
	b := pool("b", "gpu", 8, 1, "64", "L40S")
	h := pool("h", "gpu", 8, 0, "64", "H100")
	got, _ := choose(gpuRun(2, ""), []*v1alpha1.ComputePool{a, b, h}, nil)
	assert.Equal(t, "h", got.Name, "8 free beats 7 and 2")

	got, _ = choose(gpuRun(2, "L40S"), []*v1alpha1.ComputePool{a, b, h}, nil)
	assert.Equal(t, "b", got.Name, "only L40S pools, and b has more free")
}

func TestRunsPlacedButNotStartedTakeRoom(t *testing.T) {
	b := pool("b", "gpu", 8, 0, "64", "L40S")
	got, why := choose(gpuRun(4, ""), []*v1alpha1.ComputePool{b}, map[string][]Needs{"b": {gpuRun(6, "")}})
	assert.Nil(t, got)
	assert.Contains(t, why, "b: 2 GPUs free, 4 needed")
}

func TestWhyNothingFits(t *testing.T) {
	disabled := pool("d", "gpu", 8, 0, "64")
	disabled.Spec.Disabled = true
	lost := pool("l", "gpu", 8, 0, "64")
	lost.Status.Conditions[0].Status = metav1.ConditionFalse
	cpuOnly := pool("c", "cpu", 0, 0, "64")
	_, why := choose(gpuRun(1, "H100"), []*v1alpha1.ComputePool{disabled, lost, cpuOnly, pool("g", "gpu", 8, 0, "64", "L40S")}, nil)
	for _, want := range []string{"c: no GPUs", "d: disabled", "g: not H100", "l: its cluster cannot be read"} {
		assert.Contains(t, why, want)
	}
	_, why = choose(gpuRun(1, ""), nil, nil)
	assert.Equal(t, "the project's clusters have no compute pools", why)
}

func TestACPURunGoesToACPUPool(t *testing.T) {
	cpuRun := Needs{Nodes: 1, CPU: resource.MustParse("32"), Memory: resource.MustParse("8Gi")}
	small := pool("small", "cpu", 0, 0, "16")
	big := pool("big", "cpu", 0, 0, "96")
	got, _ := choose(cpuRun, []*v1alpha1.ComputePool{pool("g", "gpu", 8, 0, "128"), small, big}, nil)
	assert.Equal(t, "big", got.Name)
	_, why := choose(cpuRun, []*v1alpha1.ComputePool{small}, nil)
	assert.Contains(t, why, "small: 16 CPU free, 32 needed")
}

func TestARayRunNeedsItsHeadAndSubmitterToo(t *testing.T) {
	n, err := NeedsOf([]byte(`{"job":{"kind":"rayjob","nodes":2,"gpusPerNode":1},"resources":{"requests":{"cpu":"4","memory":"8Gi"}}}`))
	require.NoError(t, err)
	assert.Equal(t, int64(2), n.GPUs(), "the workers' GPUs; the head has none")
	assert.Equal(t, "9100m", n.CPU.String(), "2 workers × 4 CPU, the head's 1, the submitter's 100m")
}
