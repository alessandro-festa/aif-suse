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
	apixv1 "k8s.io/apiextensions-apiserver/pkg/apis/apiextensions/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// AIJobJobIDLabel is set on every object an AIJob's release creates. Its value
// is the AIJob's name, which is also the release name; logs and metrics are
// keyed by it after the objects are gone.
const AIJobJobIDLabel = "ai-factory.suse.com/job-id"

// AIJobPhase is where a finite execution is in its life. Succeeded, Failed,
// Cancelled and Reclaimed are terminal and never change afterwards.
// +kubebuilder:validation:Enum=Pending;Queued;Admitted;Running;Succeeded;Failed;Cancelled;Reclaimed
type AIJobPhase string

const (
	AIJobPhasePending   AIJobPhase = "Pending"
	AIJobPhaseQueued    AIJobPhase = "Queued"
	AIJobPhaseAdmitted  AIJobPhase = "Admitted"
	AIJobPhaseRunning   AIJobPhase = "Running"
	AIJobPhaseSucceeded AIJobPhase = "Succeeded"
	AIJobPhaseFailed    AIJobPhase = "Failed"
	AIJobPhaseCancelled AIJobPhase = "Cancelled"
	// AIJobPhaseReclaimed: idle, and uninstalled to free its pool (reclaim
	// policy Terminate).
	AIJobPhaseReclaimed AIJobPhase = "Reclaimed"
)

// IsTerminal reports whether the phase is final.
func (p AIJobPhase) IsTerminal() bool {
	return p == AIJobPhaseSucceeded || p == AIJobPhaseFailed || p == AIJobPhaseCancelled || p == AIJobPhaseReclaimed
}

// AIJob condition types.
const (
	AIJobConditionInstalled        = "Installed"
	AIJobConditionAdmitted         = "Admitted"
	AIJobConditionSuspended        = "Suspended"
	AIJobConditionCompleted        = "Completed"
	AIJobConditionExecutionCleaned = "ExecutionCleaned"
	// AIJobConditionReclaimed is True after the job was uninstalled for being idle.
	AIJobConditionReclaimed = "Reclaimed"
)

// AIJobReclaimAnnotation asks the AIJob controller to reclaim the job: set by
// the placement controller to the policy to apply, removed once it is done.
const AIJobReclaimAnnotation = "ai-factory.suse.com/reclaim"

// AIJobReclaimPolicy is what happens to a run reclaimed for being idle.
// +kubebuilder:validation:Enum=Suspend;Terminate;Never
type AIJobReclaimPolicy string

const (
	// AIJobReclaimSuspend uninstalls the run and puts it back in the queue, in
	// its original submission order. Its checkpoint volume is kept.
	AIJobReclaimSuspend AIJobReclaimPolicy = "Suspend"
	// AIJobReclaimTerminate uninstalls the run; it ends Reclaimed.
	AIJobReclaimTerminate AIJobReclaimPolicy = "Terminate"
	// AIJobReclaimNever leaves the run alone; it is still reported idle.
	AIJobReclaimNever AIJobReclaimPolicy = "Never"
)

// AIJobReclaim is what the run asks for when it is idle. Its compute pool's
// reclaim settings decide whether reclaim happens at all.
type AIJobReclaim struct {
	// +kubebuilder:default=Suspend
	// +optional
	Policy AIJobReclaimPolicy `json:"policy,omitempty"`
	// IdleTimeout replaces the pool's, up to the pool's maxIdleTimeout. A number
	// and m, h or d, e.g. "4h".
	// +kubebuilder:validation:Pattern=`^[1-9][0-9]*(m|h|d)$`
	// +optional
	IdleTimeout string `json:"idleTimeout,omitempty"`
}

// AIJobActivity is how much of what it holds the run uses, sampled about every
// minute while it runs in a pool that reclaims.
type AIJobActivity struct {
	// Source is what the utilisation is read from: gpu (DCGM exporter) or cpu
	// (kubelet), with why when a GPU run is read from its CPU.
	// +optional
	Source string `json:"source,omitempty"`
	// Utilisation is the last sample, in percent.
	// +optional
	Utilisation int32 `json:"utilisation"`
	// SampledAt is when it was taken.
	// +optional
	SampledAt *metav1.Time `json:"sampledAt,omitempty"`
	// LastActiveAt is the last sample at or above the pool's idle threshold.
	// +optional
	LastActiveAt *metav1.Time `json:"lastActiveAt,omitempty"`
	// IdleSince is when the run went under the threshold; empty while active.
	// +optional
	IdleSince *metav1.Time `json:"idleSince,omitempty"`
	// Message says why the run is not sampled, or what reclaim is waiting for.
	// +optional
	Message string `json:"message,omitempty"`
}

// AIJobReclaimRecord is one reclaim of the run.
type AIJobReclaimRecord struct {
	At     metav1.Time        `json:"at"`
	Pool   string             `json:"pool"`
	Policy AIJobReclaimPolicy `json:"policy"`
	// Reason is why: how long it was idle, and for which waiting run.
	Reason string `json:"reason"`
}

// AIJobSource is a custom chart the execution is installed from: a chart in a
// Rancher ClusterRepo, the same reference an App-sourced AIWorkload uses. Without
// one, the job installs the training chart built into the operator.
type AIJobSource struct {
	// RepoName is the Rancher ClusterRepo name.
	// +kubebuilder:validation:MinLength=1
	RepoName string `json:"repoName"`
	// ChartName is the Helm chart name in that repository.
	// +kubebuilder:validation:MinLength=1
	ChartName string `json:"chartName"`
	// Version is the exact chart version.
	// +kubebuilder:validation:MinLength=1
	Version string `json:"version"`
}

// AIJobRetention says how long the execution outlives its completion.
type AIJobRetention struct {
	// ExecutionObjects is how long the release and everything it created (Job,
	// pods, Kueue Workload, claims, ephemeral PVCs) stay after the job completes.
	// The AIJob itself is kept.
	// +kubebuilder:default="168h"
	// +optional
	ExecutionObjects *metav1.Duration `json:"executionObjects,omitempty"`
}

// AIJobSpec is the whole statement of intent. Source and values are fixed at
// creation: a change of intent is a new job.
// +kubebuilder:validation:XValidation:rule="has(self.source) == has(oldSelf.source) && (!has(self.source) || self.source == oldSelf.source)",message="spec.source is immutable; submit a new AIJob"
// +kubebuilder:validation:XValidation:rule="(has(self.pool) ? self.pool : '') == (has(oldSelf.pool) ? oldSelf.pool : '')",message="spec.pool is immutable; submit a new AIJob"
// +kubebuilder:validation:XValidation:rule="(has(self.targetNamespace) ? self.targetNamespace : '') == (has(oldSelf.targetNamespace) ? oldSelf.targetNamespace : '')",message="spec.targetNamespace is immutable; submit a new AIJob"
// +kubebuilder:validation:XValidation:rule="has(self.values) == has(oldSelf.values) && (!has(self.values) || self.values == oldSelf.values)",message="spec.values is immutable; submit a new AIJob"
// +kubebuilder:validation:XValidation:rule="!has(oldSelf.cancel) || !oldSelf.cancel || (has(self.cancel) && self.cancel)",message="spec.cancel cannot be undone"
// +kubebuilder:validation:XValidation:rule="has(self.reclaim) == has(oldSelf.reclaim) && (!has(self.reclaim) || self.reclaim == oldSelf.reclaim)",message="spec.reclaim is immutable; submit a new AIJob"
type AIJobSpec struct {
	// DisplayName is a human-readable name. Informational.
	// +optional
	DisplayName string `json:"displayName,omitempty"`
	// Category says what the job is for. Informational.
	// +optional
	Category WorkloadCategory `json:"category,omitempty"`
	// Profile names the profile that chose the values. Informational.
	// +optional
	Profile string `json:"profile,omitempty"`
	// Source is a custom chart to install. Omit it to install the training chart
	// built into the operator (charts/gpu-train-job at the operator's version),
	// which needs no chart repository.
	// +optional
	Source *AIJobSource `json:"source,omitempty"`
	// Pool names the ComputePool the job runs in: it is installed on that pool's
	// cluster, through Rancher, and its pods are kept to the pool's nodes. Empty:
	// the operator's own cluster.
	// +optional
	Pool string `json:"pool,omitempty"`
	// TargetNamespace is the namespace the job runs in on the pool's cluster.
	// Empty: the AIJob's own namespace.
	// +optional
	TargetNamespace string `json:"targetNamespace,omitempty"`
	// Values are the chart values as submitted.
	// Typed as an object so the immutability rule on the spec can compare it.
	// +kubebuilder:validation:Type=object
	// +kubebuilder:pruning:PreserveUnknownFields
	// +optional
	Values *apixv1.JSON `json:"values,omitempty"`
	// Retention bounds how long the execution objects are kept.
	// +optional
	Retention AIJobRetention `json:"retention,omitempty"`
	// Cancel stops a job that has not finished: the operator uninstalls the
	// release and the job ends Cancelled. It cannot be set back to false.
	// +optional
	Cancel bool `json:"cancel,omitempty"`
	// Reclaim is what happens when the run sits idle in a pool that reclaims.
	// Set from the run's profile.
	// +optional
	Reclaim *AIJobReclaim `json:"reclaim,omitempty"`
}

// AIJobExecution names what the release created to run the job.
type AIJobExecution struct {
	// Release is the Helm release name (the AIJob name).
	Release string `json:"release,omitempty"`
	// Kind is Job or PyTorchJob.
	// +optional
	Kind string `json:"kind,omitempty"`
	// Name of the Job or PyTorchJob.
	// +optional
	Name string `json:"name,omitempty"`
}

// AIJobQueue records the Kueue Workload that queued the job.
type AIJobQueue struct {
	Workload     string `json:"workload,omitempty"`
	LocalQueue   string `json:"localQueue,omitempty"`
	ClusterQueue string `json:"clusterQueue,omitempty"`
	// KAIQueue is the scheduling.run.ai queue the pods were submitted to, for a
	// job KAI or Run:AI queues rather than Kueue (their kai.scheduler/queue or
	// project label, per the chart's schedulers.yaml).
	KAIQueue string `json:"kaiQueue,omitempty"`
}

// AIJobPod is the facts about one pod, copied while it exists.
type AIJobPod struct {
	Name     string `json:"name"`
	Node     string `json:"node,omitempty"`
	Phase    string `json:"phase,omitempty"`
	Restarts int32  `json:"restarts,omitempty"`
	// +optional
	ExitCode *int32 `json:"exitCode,omitempty"`
	Reason   string `json:"reason,omitempty"`
	Message  string `json:"message,omitempty"`
}

// AIJobPodCounts summarises pods by phase when there are too many to list.
type AIJobPodCounts struct {
	Pending   int32 `json:"pending,omitempty"`
	Running   int32 `json:"running,omitempty"`
	Succeeded int32 `json:"succeeded,omitempty"`
	Failed    int32 `json:"failed,omitempty"`
}

// AIJobGPU is one GPU a pod was given.
type AIJobGPU struct {
	Pod string `json:"pod"`
	// Mode is dra, device-plugin, or a sharing layer (hami) for a share of one GPU.
	Mode string `json:"mode"`
	// Device is the DRA device name (DRA only).
	// +optional
	Device string `json:"device,omitempty"`
	// Pool is the DRA pool, usually the node (DRA only).
	// +optional
	Pool string `json:"pool,omitempty"`
	// Claim is the ResourceClaim the device was allocated through (DRA only).
	// +optional
	Claim string `json:"claim,omitempty"`
	// Product is the GPU model, from the node's nvidia.com/gpu.product label.
	// +optional
	Product string `json:"product,omitempty"`
}

// AIJobResources records what the job was given.
type AIJobResources struct {
	GPUCount int32      `json:"gpuCount,omitempty"`
	GPUs     []AIJobGPU `json:"gpus,omitempty"`
}

// AIJobResult is how the job ended. Final once the phase is terminal.
type AIJobResult struct {
	// +optional
	ExitCode *int32 `json:"exitCode,omitempty"`
	Reason   string `json:"reason,omitempty"`
	Message  string `json:"message,omitempty"`
}

// AIJobReport is what a run reported about itself: the last AIF_RESULT line
// its first worker printed. Test and benchmark profiles end with one. Captured
// when the run finishes, so it outlives the pods and their logs.
type AIJobReport struct {
	// Test names what reported, e.g. "GPU Smoke Test".
	// +optional
	Test string `json:"test,omitempty"`
	// Status is the run's own verdict: pass or fail.
	// +optional
	Status string `json:"status,omitempty"`
	// +optional
	// +kubebuilder:validation:MaxItems=50
	Checks []AIJobReportCheck `json:"checks,omitempty"`
	// Metrics are the measurements, e.g. bus bandwidth, as text.
	// +optional
	Metrics map[string]string `json:"metrics,omitempty"`
	// Env describes where it ran: driver, GPU, node.
	// +optional
	Env map[string]string `json:"env,omitempty"`
	// Pod is the pod whose log the report was read from.
	// +optional
	Pod string `json:"pod,omitempty"`
	// +optional
	ReportedAt *metav1.Time `json:"reportedAt,omitempty"`
}

// AIJobReportCheck is one check in a report: passed, passed with a warning, or failed.
type AIJobReportCheck struct {
	Name string `json:"name"`
	OK   bool   `json:"ok"`
	// +optional
	Warn bool `json:"warn,omitempty"`
	// +optional
	Detail string `json:"detail,omitempty"`
}

// AIJobCleanup tracks removal of the execution objects.
type AIJobCleanup struct {
	// +optional
	DueAt *metav1.Time `json:"dueAt,omitempty"`
	// +optional
	CompletedAt *metav1.Time `json:"completedAt,omitempty"`
}

// AIJobPlacement is where a job's execution lives.
type AIJobPlacement struct {
	Pool      string `json:"pool"`
	ClusterID string `json:"clusterId"`
	Namespace string `json:"namespace"`
}

// AIJobStatus is written by the operator only. Timestamps are observed facts;
// durations are computed by readers.
type AIJobStatus struct {
	// +optional
	Phase AIJobPhase `json:"phase,omitempty"`
	// Placement is where the job was installed, recorded at install so it can be
	// cleaned up there even if its pool goes away.
	// +optional
	Placement *AIJobPlacement `json:"placement,omitempty"`
	// PlacementMessage says why a job waiting for a compute pool has none yet.
	// Written only by the placement controller.
	// +optional
	PlacementMessage string `json:"placementMessage,omitempty"`
	// +optional
	ObservedGeneration int64 `json:"observedGeneration,omitempty"`
	// +optional
	SubmittedAt *metav1.Time `json:"submittedAt,omitempty"`
	// +optional
	AdmittedAt *metav1.Time `json:"admittedAt,omitempty"`
	// +optional
	StartedAt *metav1.Time `json:"startedAt,omitempty"`
	// +optional
	CompletedAt *metav1.Time `json:"completedAt,omitempty"`
	// +optional
	Execution AIJobExecution `json:"execution,omitempty"`
	// +optional
	Queue *AIJobQueue `json:"queue,omitempty"`
	// Pods lists every pod up to 16; above that only failed pods, with
	// PodCounts holding the totals.
	// +optional
	Pods []AIJobPod `json:"pods,omitempty"`
	// +optional
	PodCounts *AIJobPodCounts `json:"podCounts,omitempty"`
	// +optional
	Resources *AIJobResources `json:"resources,omitempty"`
	// +optional
	Result *AIJobResult `json:"result,omitempty"`
	// Report is what the run reported about itself, for a run that prints one.
	// +optional
	Report *AIJobReport `json:"report,omitempty"`
	// +optional
	Cleanup AIJobCleanup `json:"cleanup,omitempty"`
	// Activity is the run's utilisation, in a pool that reclaims idle runs.
	// +optional
	Activity *AIJobActivity `json:"activity,omitempty"`
	// ReclaimHistory lists the run's reclaims, oldest first, the last 10.
	// +kubebuilder:validation:MaxItems=10
	// +optional
	ReclaimHistory []AIJobReclaimRecord `json:"reclaimHistory,omitempty"`
	// +listType=map
	// +listMapKey=type
	// +optional
	Conditions []metav1.Condition `json:"conditions,omitempty"`
}

// +kubebuilder:object:root=true
// +kubebuilder:subresource:status
// +kubebuilder:resource:scope=Namespaced,shortName=aijob
// +kubebuilder:printcolumn:name="Display Name",type=string,JSONPath=`.spec.displayName`
// +kubebuilder:printcolumn:name="Category",type=string,JSONPath=`.spec.category`
// +kubebuilder:printcolumn:name="Phase",type=string,JSONPath=`.status.phase`
// +kubebuilder:printcolumn:name="Started",type=date,JSONPath=`.status.startedAt`,priority=1
// +kubebuilder:printcolumn:name="Completed",type=date,JSONPath=`.status.completedAt`,priority=1
// +kubebuilder:printcolumn:name="Age",type=date,JSONPath=`.metadata.creationTimestamp`

// AIJob is the durable record of one finite execution: what was submitted,
// where it ran, how it ended. The operator installs the execution from the
// spec, copies its facts into the status, and removes the execution objects
// when their retention passes; the record stays.
type AIJob struct {
	metav1.TypeMeta   `json:",inline"`
	metav1.ObjectMeta `json:"metadata,omitempty"`
	Spec              AIJobSpec `json:"spec"`
	// +optional
	Status AIJobStatus `json:"status,omitempty"`
}

// +kubebuilder:object:root=true

// AIJobList contains a list of AIJob.
type AIJobList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitempty"`
	Items           []AIJob `json:"items"`
}

func init() {
	SchemeBuilder.Register(&AIJob{}, &AIJobList{})
}
