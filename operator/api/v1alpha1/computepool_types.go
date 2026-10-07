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

package v1alpha1

import (
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// ComputePoolKind says whether a pool is for GPU work or CPU-only work.
// +kubebuilder:validation:Enum=gpu;cpu
type ComputePoolKind string

const (
	ComputePoolKindGPU ComputePoolKind = "gpu"
	ComputePoolKindCPU ComputePoolKind = "cpu"
)

const (
	// ComputePoolClusterLabel names the Rancher cluster a pool is on, so the
	// pools of one cluster can be listed together.
	ComputePoolClusterLabel = "ai-factory.suse.com/cluster"
	// ComputePoolDiscoveredLabel marks a pool the operator created from what it
	// found on the cluster, as opposed to one an administrator created.
	ComputePoolDiscoveredLabel = "ai-factory.suse.com/discovered"

	// ComputePoolConditionConnected is True when the last refresh could read
	// the cluster.
	ComputePoolConditionConnected = "Connected"
)

// ComputePoolSpec is which nodes of which cluster form the pool.
// +kubebuilder:validation:XValidation:rule="self.clusterId == oldSelf.clusterId",message="spec.clusterId is immutable"
type ComputePoolSpec struct {
	// ClusterID is the Rancher cluster ID (clusters.management.cattle.io name)
	// of a downstream cluster, e.g. "c-m-abc123". Never "local": Rancher's own
	// cluster runs no AI work.
	// +kubebuilder:validation:MinLength=1
	// +kubebuilder:validation:XValidation:rule="self != 'local'",message="Rancher's local cluster has no compute pools"
	ClusterID string `json:"clusterId"`
	// DisplayName is a human-readable name. Informational.
	// +optional
	DisplayName string `json:"displayName,omitempty"`
	// Kind says whether the pool runs GPU work or CPU-only work.
	Kind ComputePoolKind `json:"kind"`
	// NodeSelector picks the pool's nodes on that cluster. Empty selects every
	// node.
	// +optional
	NodeSelector *metav1.LabelSelector `json:"nodeSelector,omitempty"`
	// Disabled keeps the pool out of placement. Its status is still refreshed.
	// +optional
	Disabled bool `json:"disabled,omitempty"`
	// Reclaim frees the pool from runs that hold it without using it, for runs
	// waiting in the queue. Unset: nothing on the pool is reclaimed.
	// +optional
	Reclaim *ComputePoolReclaim `json:"reclaim,omitempty"`
}

// ComputePoolReclaim says when a run on the pool counts as idle and may be
// reclaimed. Durations are a number and a unit: m (minutes), h (hours) or d
// (days), e.g. "30m", "2h", "3d".
type ComputePoolReclaim struct {
	// IdleTimeout is how long a run must stay idle before it is reclaimed, unless
	// the run asks for longer (up to MaxIdleTimeout).
	// +kubebuilder:validation:Pattern=`^[1-9][0-9]*(m|h|d)$`
	IdleTimeout string `json:"idleTimeout"`
	// MaxIdleTimeout is the longest idle timeout a run may ask for. Empty:
	// IdleTimeout is also the ceiling.
	// +kubebuilder:validation:Pattern=`^[1-9][0-9]*(m|h|d)$`
	// +optional
	MaxIdleTimeout string `json:"maxIdleTimeout,omitempty"`
	// IdleThreshold is the utilisation, in percent, under which a run is idle:
	// of its GPUs on a GPU pool, of its CPU request on a CPU pool.
	// +kubebuilder:validation:Minimum=1
	// +kubebuilder:validation:Maximum=100
	// +kubebuilder:default=5
	// +optional
	IdleThreshold int32 `json:"idleThreshold,omitempty"`
	// OnlyWhenContended reclaims an idle run only when a run waiting in the queue
	// would fit in its place. Defaults to true; false reclaims every idle run.
	// +optional
	OnlyWhenContended *bool `json:"onlyWhenContended,omitempty"`
}

// ComputePoolResources is an amount of the resources a pool is placed by.
type ComputePoolResources struct {
	// +optional
	CPU resource.Quantity `json:"cpu,omitempty"`
	// +optional
	Memory resource.Quantity `json:"memory,omitempty"`
	// GPUs counts whole devices (nvidia.com/gpu).
	// +optional
	GPUs int64 `json:"gpus,omitempty"`
}

// MaxPoolConsumers bounds ComputePoolStatus.Consumers.
const MaxPoolConsumers = 12

// ComputePoolConsumer is one thing running on a pool's nodes and what it requests.
type ComputePoolConsumer struct {
	// Kind is run (an AI Factory training run), workload (other pods in a
	// namespace), or rest (everything past the largest MaxPoolConsumers).
	// +kubebuilder:validation:Enum=run;workload;rest
	Kind string `json:"kind"`
	// Namespace on the pool's cluster; empty for rest.
	// +optional
	Namespace string `json:"namespace,omitempty"`
	// Name is the run's job ID (the AIJob's name) for a run; empty otherwise.
	// +optional
	Name string `json:"name,omitempty"`
	// Pods counted.
	Pods      int32                `json:"pods"`
	Requested ComputePoolResources `json:"requested"`
}

// ComputePoolGPU describes the pool's GPUs.
type ComputePoolGPU struct {
	// Models are the GPU products on the pool's nodes (nvidia.com/gpu.product).
	// +optional
	Models []string `json:"models,omitempty"`
	// MemoryMiB is the memory of the smallest GPU in the pool
	// (nvidia.com/gpu.memory), 0 when the nodes do not say.
	// +optional
	MemoryMiB int64 `json:"memoryMiB,omitempty"`
}

// ComputePoolStatus is what the operator last read from the pool's nodes.
type ComputePoolStatus struct {
	// +optional
	Conditions []metav1.Condition `json:"conditions,omitempty"`
	// ObservedAt is when the nodes were last read.
	// +optional
	ObservedAt *metav1.Time `json:"observedAt,omitempty"`
	// Nodes is how many nodes the selector matches.
	// +optional
	Nodes int32 `json:"nodes,omitempty"`
	// Allocatable is the sum of the nodes' allocatable resources.
	// +optional
	Allocatable ComputePoolResources `json:"allocatable,omitempty"`
	// Requested is the sum of the requests of the pods running on those nodes.
	// +optional
	Requested ComputePoolResources `json:"requested,omitempty"`
	// Consumers is what takes that capacity, largest first: each training run
	// (by its job ID), and other workloads grouped by namespace. At most
	// MaxPoolConsumers; the rest are summed in one entry of kind "rest".
	// +optional
	Consumers []ComputePoolConsumer `json:"consumers,omitempty"`
	// +optional
	GPU *ComputePoolGPU `json:"gpu,omitempty"`
	// Schedulers are the scheduler backends installed on the cluster, by their
	// scheduler.type name in the training chart's schedulers.yaml.
	// +optional
	Schedulers []string `json:"schedulers,omitempty"`
	// Sharing are the GPU-sharing modes available (kai-fraction, hami).
	// +optional
	Sharing []string `json:"sharing,omitempty"`
	// Training are the training runtimes installed (training-operator,
	// trainer-v2).
	// +optional
	Training []string `json:"training,omitempty"`
}

// +kubebuilder:object:root=true
// +kubebuilder:subresource:status
// +kubebuilder:resource:scope=Cluster,shortName=cpool
// +kubebuilder:printcolumn:name="Cluster",type=string,JSONPath=`.spec.clusterId`
// +kubebuilder:printcolumn:name="Kind",type=string,JSONPath=`.spec.kind`
// +kubebuilder:printcolumn:name="Nodes",type=integer,JSONPath=`.status.nodes`
// +kubebuilder:printcolumn:name="GPUs",type=integer,JSONPath=`.status.allocatable.gpus`
// +kubebuilder:printcolumn:name="Connected",type=string,JSONPath=`.status.conditions[?(@.type=="Connected")].status`
// +kubebuilder:printcolumn:name="Age",type=date,JSONPath=`.metadata.creationTimestamp`

// ComputePool is a set of nodes on one downstream cluster that AI work can be
// placed on, GPU or CPU-only. The operator creates one per GPU model and one for
// the CPU-only nodes of every downstream cluster it can see, named after the
// cluster, and refreshes what each has.
// Administrators can edit, add or disable pools; the operator never rewrites a
// pool's spec.
type ComputePool struct {
	metav1.TypeMeta   `json:",inline"`
	metav1.ObjectMeta `json:"metadata,omitempty"`
	Spec              ComputePoolSpec `json:"spec"`
	// +optional
	Status ComputePoolStatus `json:"status,omitempty"`
}

// +kubebuilder:object:root=true

// ComputePoolList contains a list of ComputePool.
type ComputePoolList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitempty"`
	Items           []ComputePool `json:"items"`
}

func init() {
	SchemeBuilder.Register(&ComputePool{}, &ComputePoolList{})
}
