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
	"fmt"
	"sort"
	"strings"

	"k8s.io/apimachinery/pkg/api/meta"
	"k8s.io/apimachinery/pkg/api/resource"

	"github.com/SUSE/aif-operator/api/v1alpha1"
)

// free is what a pool has left: its allocatable minus what runs on it and what
// was placed there and has not started yet.
type free struct {
	GPUs   int64
	CPU    resource.Quantity
	Memory resource.Quantity
}

func freeOf(p *v1alpha1.ComputePool, inflight []Needs) free {
	f := free{GPUs: p.Status.Allocatable.GPUs - p.Status.Requested.GPUs}
	f.CPU = p.Status.Allocatable.CPU.DeepCopy()
	f.CPU.Sub(p.Status.Requested.CPU)
	f.Memory = p.Status.Allocatable.Memory.DeepCopy()
	f.Memory.Sub(p.Status.Requested.Memory)
	for _, n := range inflight {
		f.GPUs -= n.GPUs()
		f.CPU.Sub(n.CPU)
		f.Memory.Sub(n.Memory)
	}
	return f
}

// choose picks the pool a run goes to among the candidates: one of the right
// kind, with the GPU model it asks for, that has room for it now; of those, the
// one with the most free GPUs (or CPU, for a CPU run), which spreads load.
// Without one it says why each candidate was refused.
func choose(n Needs, pools []*v1alpha1.ComputePool, inflight map[string][]Needs) (*v1alpha1.ComputePool, string) {
	type fit struct {
		pool *v1alpha1.ComputePool
		f    free
	}
	var fits []fit
	var why []string
	for _, p := range pools {
		if reason := refuse(n, p, freeOf(p, inflight[p.Name])); reason != "" {
			why = append(why, p.Name+": "+reason)
			continue
		}
		fits = append(fits, fit{p, freeOf(p, inflight[p.Name])})
	}
	if len(fits) == 0 {
		if len(why) == 0 {
			return nil, "the project's clusters have no compute pools"
		}
		sort.Strings(why)
		return nil, "no compute pool fits now (" + strings.Join(why, "; ") + ")"
	}
	sort.SliceStable(fits, func(i, j int) bool {
		a, b := fits[i], fits[j]
		if n.WantsGPU() && a.f.GPUs != b.f.GPUs {
			return a.f.GPUs > b.f.GPUs
		}
		if c := a.f.CPU.Cmp(b.f.CPU); c != 0 {
			return c > 0
		}
		return a.pool.Name < b.pool.Name
	})
	return fits[0].pool, ""
}

// refuse says why a pool cannot take the run now, or "" when it can.
func refuse(n Needs, p *v1alpha1.ComputePool, f free) string {
	switch {
	case p.Spec.Disabled:
		return "disabled"
	case !meta.IsStatusConditionTrue(p.Status.Conditions, v1alpha1.ComputePoolConditionConnected):
		return "its cluster cannot be read"
	case n.WantsGPU() && p.Spec.Kind != v1alpha1.ComputePoolKindGPU:
		return "no GPUs"
	case !n.WantsGPU() && p.Spec.Kind != v1alpha1.ComputePoolKindCPU:
		return "a GPU pool; CPU runs go to CPU pools"
	case n.Runtime != "" && !contains(p.Status.Training, n.Runtime):
		return "no " + n.Runtime + " on its cluster"
	case n.Model != "" && (p.Status.GPU == nil || !contains(p.Status.GPU.Models, n.Model)):
		return "not " + n.Model
	case n.GPUs() > f.GPUs:
		return fmt.Sprintf("%d GPUs free, %d needed", max(f.GPUs, 0), n.GPUs())
	case n.ShareMiB > 0 && p.Status.Allocatable.GPUs == 0:
		return "no GPUs to share"
	case f.CPU.Cmp(n.CPU) < 0:
		return fmt.Sprintf("%s CPU free, %s needed", f.CPU.String(), n.CPU.String())
	case f.Memory.Cmp(n.Memory) < 0:
		return fmt.Sprintf("%s memory free, %s needed", f.Memory.String(), n.Memory.String())
	}
	return ""
}

func contains(xs []string, x string) bool {
	for _, s := range xs {
		if s == x {
			return true
		}
	}
	return false
}
