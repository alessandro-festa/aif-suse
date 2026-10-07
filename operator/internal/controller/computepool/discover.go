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
	"regexp"
	"sort"
	"strconv"
	"strings"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/labels"

	"github.com/SUSE/aif-operator/api/v1alpha1"
	"github.com/SUSE/aif-operator/internal/trainchart"
)

// Node labels GPU Feature Discovery (NVIDIA GPU Operator) sets.
const (
	gpuProductLabel = "nvidia.com/gpu.product"
	gpuPresentLabel = "nvidia.com/gpu.present"
	gpuMemoryLabel  = "nvidia.com/gpu.memory" // MiB per GPU
	gpuResource     = corev1.ResourceName("nvidia.com/gpu")
	// HAMi has no CRD; its device plugin registers each node's GPUs here.
	hamiNodeAnnotation = "hami.io/node-nvidia-register"
)

// desiredPool is a pool discovery would create if no pool of that name exists.
type desiredPool struct {
	Name string
	Spec v1alpha1.ComputePoolSpec
}

// isGPUNode says whether a node has NVIDIA GPUs, by the labels GPU Feature
// Discovery puts on it. A GPU node without GFD is not recognised; it lands in
// the CPU-only pool, whose selector excludes only labelled GPU nodes.
func isGPUNode(n corev1.Node) bool {
	return n.Labels[gpuProductLabel] != "" || n.Labels[gpuPresentLabel] == "true"
}

var nonName = regexp.MustCompile(`[^a-z0-9]+`)

// slug turns a GPU product such as "NVIDIA-H100-80GB-HBM3" into a name part.
func slug(s string) string {
	s = strings.Trim(nonName.ReplaceAllString(strings.ToLower(s), "-"), "-")
	if len(s) > 40 {
		s = strings.TrimRight(s[:40], "-")
	}
	return s
}

// discoverPools is the pools a cluster's nodes call for: one per GPU product,
// one for GPU nodes that do not name their product, and one for the CPU-only
// nodes. Pools are only proposed for kinds of node the cluster has. Every pool
// is named after its cluster: its kind and GPU model tell them apart.
// takesRuns says whether a training run can land on the node: it is not
// cordoned, and every NoSchedule/NoExecute taint on it is one the training chart
// tolerates (nvidia.com/gpu). A control-plane node is tainted, so it is not
// capacity.
func takesRuns(n corev1.Node) bool {
	if n.Spec.Unschedulable {
		return false
	}
	for _, t := range n.Spec.Taints {
		if (t.Effect == corev1.TaintEffectNoSchedule || t.Effect == corev1.TaintEffectNoExecute) && t.Key != gpuResource.String() {
			return false
		}
	}
	return true
}

func discoverPools(clusterID, clusterName string, nodes []corev1.Node) []desiredPool {
	products := map[string]bool{}
	unnamedGPU, cpu := false, false
	for _, n := range nodes {
		if !takesRuns(n) {
			continue
		}
		switch p := n.Labels[gpuProductLabel]; {
		case p != "":
			products[p] = true
		case isGPUNode(n):
			unnamedGPU = true
		default:
			cpu = true
		}
	}

	var out []desiredPool
	names := make([]string, 0, len(products))
	for p := range products {
		names = append(names, p)
	}
	sort.Strings(names)
	for _, p := range names {
		out = append(out, desiredPool{
			Name: clusterID + "-gpu-" + slug(p),
			Spec: v1alpha1.ComputePoolSpec{
				ClusterID:    clusterID,
				DisplayName:  clusterName,
				Kind:         v1alpha1.ComputePoolKindGPU,
				NodeSelector: &metav1.LabelSelector{MatchLabels: map[string]string{gpuProductLabel: p}},
			},
		})
	}
	if unnamedGPU {
		out = append(out, desiredPool{
			Name: clusterID + "-gpu",
			Spec: v1alpha1.ComputePoolSpec{
				ClusterID:   clusterID,
				DisplayName: clusterName,
				Kind:        v1alpha1.ComputePoolKindGPU,
				NodeSelector: &metav1.LabelSelector{MatchExpressions: []metav1.LabelSelectorRequirement{
					{Key: gpuPresentLabel, Operator: metav1.LabelSelectorOpIn, Values: []string{"true"}},
					{Key: gpuProductLabel, Operator: metav1.LabelSelectorOpDoesNotExist},
				}},
			},
		})
	}
	if cpu {
		out = append(out, desiredPool{
			Name: clusterID + "-cpu",
			Spec: v1alpha1.ComputePoolSpec{
				ClusterID:   clusterID,
				DisplayName: clusterName,
				Kind:        v1alpha1.ComputePoolKindCPU,
				NodeSelector: &metav1.LabelSelector{MatchExpressions: []metav1.LabelSelectorRequirement{
					{Key: gpuProductLabel, Operator: metav1.LabelSelectorOpDoesNotExist},
					{Key: gpuPresentLabel, Operator: metav1.LabelSelectorOpNotIn, Values: []string{"true"}},
				}},
			},
		})
	}
	return out
}

// stack is what a cluster runs, the same for every pool on it.
type stack struct {
	Schedulers []string
	Sharing    []string
	Training   []string
}

// detectStack reads the scheduler backends from the cluster's API groups using
// the training chart's schedulers.yaml (the table the chart and the UI use),
// HAMi from node annotations, and the Kubeflow training runtimes from their
// API groups.
func detectStack(groups []string, nodes []corev1.Node, backends map[string]trainchart.Backend) stack {
	served := map[string]bool{}
	for _, g := range groups {
		served[g] = true
	}
	var st stack
	sharing := map[string]bool{}
	for name, b := range backends {
		if b.Detect == nil || !served[b.Detect.Group] || (b.Detect.Unless != "" && served[b.Detect.Unless]) {
			continue
		}
		st.Schedulers = append(st.Schedulers, name)
		for _, s := range b.Sharing {
			sharing[s] = true
		}
	}
	for _, n := range nodes {
		if _, ok := n.Annotations[hamiNodeAnnotation]; ok {
			sharing["hami"] = true
			break
		}
	}
	for s := range sharing {
		st.Sharing = append(st.Sharing, s)
	}
	if served["kubeflow.org"] {
		st.Training = append(st.Training, "training-operator")
	}
	if served["trainer.kubeflow.org"] {
		st.Training = append(st.Training, "trainer-v2")
	}
	sort.Strings(st.Schedulers)
	sort.Strings(st.Sharing)
	return st
}

// poolStatus is what a pool's selector finds on the cluster: its schedulable
// nodes, what they can allocate and what the pods on them request. Conditions
// and ObservedAt are the caller's.
func poolStatus(spec v1alpha1.ComputePoolSpec, nodes []corev1.Node, pods []corev1.Pod, st stack) (v1alpha1.ComputePoolStatus, error) {
	sel := labels.Everything()
	if spec.NodeSelector != nil {
		s, err := metav1.LabelSelectorAsSelector(spec.NodeSelector)
		if err != nil {
			return v1alpha1.ComputePoolStatus{}, err
		}
		sel = s
	}

	out := v1alpha1.ComputePoolStatus{Schedulers: st.Schedulers, Sharing: st.Sharing, Training: st.Training}
	in := map[string]bool{}
	cpu, mem := resource.Quantity{}, resource.Quantity{}
	models := map[string]bool{}
	var minMemMiB int64
	for _, n := range nodes {
		// A cordoned or tainted node takes no run, so it is not capacity a run can be placed on.
		if !takesRuns(n) || !sel.Matches(labels.Set(n.Labels)) {
			continue
		}
		in[n.Name] = true
		out.Nodes++
		cpu.Add(n.Status.Allocatable[corev1.ResourceCPU])
		mem.Add(n.Status.Allocatable[corev1.ResourceMemory])
		if q, ok := n.Status.Allocatable[gpuResource]; ok {
			out.Allocatable.GPUs += q.Value()
		}
		if p := n.Labels[gpuProductLabel]; p != "" {
			models[p] = true
		}
		if m, err := strconv.ParseInt(n.Labels[gpuMemoryLabel], 10, 64); err == nil && m > 0 && (minMemMiB == 0 || m < minMemMiB) {
			minMemMiB = m
		}
	}
	out.Allocatable.CPU, out.Allocatable.Memory = cpu, mem

	rcpu, rmem := resource.Quantity{}, resource.Quantity{}
	for _, p := range pods {
		if !in[p.Spec.NodeName] || p.Status.Phase == corev1.PodSucceeded || p.Status.Phase == corev1.PodFailed {
			continue
		}
		for _, c := range p.Spec.Containers {
			rcpu.Add(c.Resources.Requests[corev1.ResourceCPU])
			rmem.Add(c.Resources.Requests[corev1.ResourceMemory])
			// An extended resource's request always equals its limit; either may be set.
			if q, ok := c.Resources.Limits[gpuResource]; ok {
				out.Requested.GPUs += q.Value()
			} else if q, ok := c.Resources.Requests[gpuResource]; ok {
				out.Requested.GPUs += q.Value()
			}
		}
	}
	out.Requested.CPU, out.Requested.Memory = rcpu, rmem

	if spec.Kind == v1alpha1.ComputePoolKindGPU {
		g := &v1alpha1.ComputePoolGPU{MemoryMiB: minMemMiB}
		for m := range models {
			g.Models = append(g.Models, m)
		}
		sort.Strings(g.Models)
		out.GPU = g
	}
	return out, nil
}
