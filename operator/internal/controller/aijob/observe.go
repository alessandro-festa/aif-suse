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
	"sort"
	"strconv"
	"time"

	corev1 "k8s.io/api/core/v1"
	resourcev1 "k8s.io/api/resource/v1"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"

	"github.com/SUSE/aif-operator/api/v1alpha1"
)

// maxListedPods is how many pods the status lists in full. Above it only failed
// pods are listed and PodCounts carries the totals, so the record stays bounded
// for a large job.
const maxListedPods = 16

const (
	kaiScheduler    = "kai-scheduler"
	kaiQueueLabel   = "kai.scheduler/queue"
	gpuResource     = corev1.ResourceName("nvidia.com/gpu")
	gpuProductLabel = "nvidia.com/gpu.product"
	completionIndex = "batch.kubernetes.io/job-completion-index"
)

// observed is everything one reconcile read about the execution. Each field is
// nil or empty when the object does not exist (yet, or any more); the status is
// only ever filled from what is here, never guessed.
type observed struct {
	// execution is the Job or PyTorchJob, as unstructured so both kinds share one
	// path. nil when neither exists.
	execution *unstructured.Unstructured
	// workload is the Kueue Workload owned by the execution, or nil.
	workload *unstructured.Unstructured
	pods     []corev1.Pod
	// claims are the ResourceClaims the pods use, by name.
	claims map[string]*resourcev1.ResourceClaim
	// nodes are the nodes the pods run on, by name, for the GPU product label.
	nodes map[string]*corev1.Node
}

// applyObservation copies what was observed into the status. Facts already
// recorded are kept when their source is gone: a pod deleted by the Job's ttl
// still shows where it ran and how it exited.
func applyObservation(st *v1alpha1.AIJobStatus, o observed) {
	if o.execution != nil {
		st.Execution.Kind = o.execution.GetKind()
		st.Execution.Name = o.execution.GetName()
	}
	if o.workload != nil {
		q := &v1alpha1.AIJobQueue{Workload: o.workload.GetName()}
		q.LocalQueue, _, _ = unstructured.NestedString(o.workload.Object, "spec", "queueName")
		q.ClusterQueue, _, _ = unstructured.NestedString(o.workload.Object, "status", "admission", "clusterQueue")
		if st.Queue != nil && q.ClusterQueue == "" {
			q.ClusterQueue = st.Queue.ClusterQueue // admission is cleared on finish
		}
		st.Queue = q
		if t := conditionTime(o.workload, "Admitted", "True"); t != nil && st.AdmittedAt == nil {
			st.AdmittedAt = t
		}
	}
	if q := kaiQueue(o.pods); q != "" {
		if st.Queue == nil {
			st.Queue = &v1alpha1.AIJobQueue{}
		}
		st.Queue.KAIQueue = q
	}
	mergePods(st, o.pods)
	if started := earliestStart(o.pods); started != nil && (st.StartedAt == nil || started.Before(st.StartedAt)) {
		st.StartedAt = started
	}
	if gpus := gpuFacts(o.pods, o.claims, o.nodes); len(gpus) > 0 {
		st.Resources = &v1alpha1.AIJobResources{GPUCount: int32(len(gpus)), GPUs: gpus}
	}
}

// derivePhase is the phase the observation supports. installed says whether the
// release exists. It never moves a terminal phase.
func derivePhase(current v1alpha1.AIJobPhase, installed bool, o observed) v1alpha1.AIJobPhase {
	if current.IsTerminal() {
		return current
	}
	if !installed {
		return v1alpha1.AIJobPhasePending
	}
	if o.execution != nil {
		if ok, _ := terminalCondition(o.execution); ok != "" {
			return ok
		}
	}
	for _, p := range o.pods {
		if p.Status.Phase == corev1.PodRunning {
			return v1alpha1.AIJobPhaseRunning
		}
	}
	if o.workload != nil {
		if conditionTime(o.workload, "Admitted", "True") != nil {
			return v1alpha1.AIJobPhaseAdmitted
		}
		return v1alpha1.AIJobPhaseQueued
	}
	if current == v1alpha1.AIJobPhaseRunning {
		return current // between a pod finishing and the Job reporting it
	}
	// KAI holds a pod unplaced until its queue has room: that is a queue too.
	if kaiHeld(o.pods) {
		return v1alpha1.AIJobPhaseQueued
	}
	// Installed, not queued, no pod running yet: the pods are being scheduled or
	// pulled. Kept as Pending rather than inventing a queue state.
	return v1alpha1.AIJobPhasePending
}

// kaiQueue is the KAI queue the job's pods were submitted to, or "".
func kaiQueue(pods []corev1.Pod) string {
	for _, p := range pods {
		if p.Spec.SchedulerName == kaiScheduler && p.Labels[kaiQueueLabel] != "" {
			return p.Labels[kaiQueueLabel]
		}
	}
	return ""
}

// kaiHeld says whether KAI is holding every pod of the job unplaced.
func kaiHeld(pods []corev1.Pod) bool {
	if len(pods) == 0 {
		return false
	}
	for _, p := range pods {
		if p.Spec.SchedulerName != kaiScheduler || p.Spec.NodeName != "" || p.Status.Phase != corev1.PodPending {
			return false
		}
	}
	return true
}

// terminalCondition reads the execution's own verdict: Job Complete/Failed,
// PyTorchJob Succeeded/Failed. Returns the phase and the condition, or "".
func terminalCondition(ex *unstructured.Unstructured) (v1alpha1.AIJobPhase, map[string]interface{}) {
	conds, _, _ := unstructured.NestedSlice(ex.Object, "status", "conditions")
	for _, c := range conds {
		m, ok := c.(map[string]interface{})
		if !ok || m["status"] != "True" {
			continue
		}
		switch m["type"] {
		case "Complete", "Succeeded":
			return v1alpha1.AIJobPhaseSucceeded, m
		case "Failed":
			return v1alpha1.AIJobPhaseFailed, m
		}
	}
	return "", nil
}

// completion fills completedAt and result once the execution reports how it
// ended. Called only on the transition into a terminal phase.
func completion(st *v1alpha1.AIJobStatus, ex *unstructured.Unstructured, pods []corev1.Pod) {
	_, cond := terminalCondition(ex)
	res := &v1alpha1.AIJobResult{}
	if cond != nil {
		res.Reason, _ = cond["reason"].(string)
		res.Message, _ = cond["message"].(string)
		if s, _ := cond["lastTransitionTime"].(string); s != "" {
			if t, ok := parseTime(s); ok {
				st.CompletedAt = &t
			}
		}
	}
	if st.CompletedAt == nil {
		if s, found, _ := unstructured.NestedString(ex.Object, "status", "completionTime"); found {
			if t, ok := parseTime(s); ok {
				st.CompletedAt = &t
			}
		}
	}
	res.ExitCode = exitCode(pods)
	st.Result = res
}

// exitCode is the exit code that explains the outcome: the first failing
// container, rank 0 first, else rank 0's.
func exitCode(pods []corev1.Pod) *int32 {
	sorted := append([]corev1.Pod(nil), pods...)
	sort.SliceStable(sorted, func(i, j int) bool { return rank(sorted[i]) < rank(sorted[j]) })
	var first *int32
	for _, p := range sorted {
		for _, cs := range p.Status.ContainerStatuses {
			t := cs.State.Terminated
			if t == nil {
				continue
			}
			code := t.ExitCode
			if code != 0 {
				return &code
			}
			if first == nil {
				first = &code
			}
		}
	}
	return first
}

func rank(p corev1.Pod) int {
	if v, ok := p.Annotations[completionIndex]; ok {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return 1 << 30
}

func conditionTime(u *unstructured.Unstructured, condType, status string) *metav1.Time {
	conds, _, _ := unstructured.NestedSlice(u.Object, "status", "conditions")
	for _, c := range conds {
		m, ok := c.(map[string]interface{})
		if !ok || m["type"] != condType || m["status"] != status {
			continue
		}
		if s, _ := m["lastTransitionTime"].(string); s != "" {
			if t, ok := parseTime(s); ok {
				return &t
			}
		}
		now := metav1.Now()
		return &now
	}
	return nil
}

// suspended reports whether the execution is suspended (Kueue holding it, or
// someone suspending it by hand), for the Suspended condition.
func suspended(o observed) bool {
	if o.execution == nil {
		return false
	}
	if s, found, _ := unstructured.NestedBool(o.execution.Object, "spec", "suspend"); found && s {
		return true
	}
	if s, found, _ := unstructured.NestedBool(o.execution.Object, "spec", "runPolicy", "suspend"); found && s {
		return true
	}
	return false
}

func earliestStart(pods []corev1.Pod) *metav1.Time {
	var out *metav1.Time
	for _, p := range pods {
		for _, cs := range p.Status.ContainerStatuses {
			var t *metav1.Time
			switch {
			case cs.State.Running != nil:
				t = &cs.State.Running.StartedAt
			case cs.State.Terminated != nil:
				t = &cs.State.Terminated.StartedAt
			}
			if t != nil && !t.IsZero() && (out == nil || t.Before(out)) {
				tt := *t
				out = &tt
			}
		}
	}
	return out
}

func podFact(p corev1.Pod) v1alpha1.AIJobPod {
	f := v1alpha1.AIJobPod{Name: p.Name, Node: p.Spec.NodeName, Phase: string(p.Status.Phase), Reason: p.Status.Reason, Message: p.Status.Message}
	for _, cs := range p.Status.ContainerStatuses {
		f.Restarts += cs.RestartCount
		if t := cs.State.Terminated; t != nil {
			code := t.ExitCode
			f.ExitCode = &code
			if f.Reason == "" {
				f.Reason = t.Reason
			}
			if f.Message == "" {
				f.Message = truncate(t.Message, 256)
			}
		} else if w := cs.State.Waiting; w != nil && f.Reason == "" {
			f.Reason = w.Reason
		}
	}
	return f
}

// mergePods updates the recorded pods with what is observed, keeping entries
// for pods that are gone. Over maxListedPods, only failed pods stay listed.
func mergePods(st *v1alpha1.AIJobStatus, pods []corev1.Pod) {
	byName := map[string]v1alpha1.AIJobPod{}
	order := []string{}
	for _, p := range st.Pods {
		byName[p.Name] = p
		order = append(order, p.Name)
	}
	for _, p := range pods {
		if _, seen := byName[p.Name]; !seen {
			order = append(order, p.Name)
		}
		byName[p.Name] = podFact(p)
	}
	all := make([]v1alpha1.AIJobPod, 0, len(order))
	for _, n := range order {
		all = append(all, byName[n])
	}
	sort.SliceStable(all, func(i, j int) bool { return all[i].Name < all[j].Name })
	if len(all) <= maxListedPods && st.PodCounts == nil {
		st.Pods = all
		return
	}
	counts := &v1alpha1.AIJobPodCounts{}
	failed := []v1alpha1.AIJobPod{}
	for _, p := range all {
		switch corev1.PodPhase(p.Phase) {
		case corev1.PodRunning:
			counts.Running++
		case corev1.PodSucceeded:
			counts.Succeeded++
		case corev1.PodFailed:
			counts.Failed++
			failed = append(failed, p)
		default:
			counts.Pending++
		}
	}
	st.PodCounts = counts
	st.Pods = failed
}

// gpuFacts lists the GPUs the pods were given: DRA allocations from their
// claims, or device-plugin requests, with the node's GPU product.
func gpuFacts(pods []corev1.Pod, claims map[string]*resourcev1.ResourceClaim, nodes map[string]*corev1.Node) []v1alpha1.AIJobGPU {
	var out []v1alpha1.AIJobGPU
	for _, p := range pods {
		product := ""
		if n := nodes[p.Spec.NodeName]; n != nil {
			product = n.Labels[gpuProductLabel]
		}
		dra := false
		for _, name := range podClaimNames(p) {
			c := claims[name]
			if c == nil || c.Status.Allocation == nil {
				continue
			}
			for _, r := range c.Status.Allocation.Devices.Results {
				dra = true
				out = append(out, v1alpha1.AIJobGPU{Pod: p.Name, Mode: "dra", Device: r.Device, Pool: r.Pool, Claim: name, Product: product})
			}
		}
		if dra {
			continue
		}
		var n int64
		for _, c := range p.Spec.Containers {
			if q, ok := c.Resources.Limits[gpuResource]; ok {
				n += q.Value()
			}
		}
		for i := int64(0); i < n; i++ {
			out = append(out, v1alpha1.AIJobGPU{Pod: p.Name, Mode: "device-plugin", Product: product})
		}
	}
	return out
}

// podClaimNames is the ResourceClaim names a pod uses: a claim it names
// directly (a shared claim), or the one generated from its template.
func podClaimNames(p corev1.Pod) []string {
	var out []string
	generated := map[string]string{}
	for _, s := range p.Status.ResourceClaimStatuses {
		if s.ResourceClaimName != nil {
			generated[s.Name] = *s.ResourceClaimName
		}
	}
	for _, rc := range p.Spec.ResourceClaims {
		switch {
		case rc.ResourceClaimName != nil:
			out = append(out, *rc.ResourceClaimName)
		case generated[rc.Name] != "":
			out = append(out, generated[rc.Name])
		}
	}
	return out
}

func parseTime(s string) (metav1.Time, bool) {
	t, err := time.Parse(time.RFC3339, s)
	if err != nil {
		return metav1.Time{}, false
	}
	return metav1.NewTime(t), true
}

func setCondition(st *v1alpha1.AIJobStatus, gen int64, t string, s metav1.ConditionStatus, reason, msg string) {
	meta.SetStatusCondition(&st.Conditions, metav1.Condition{Type: t, Status: s, Reason: reason, Message: truncate(msg, 1024), ObservedGeneration: gen})
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}
