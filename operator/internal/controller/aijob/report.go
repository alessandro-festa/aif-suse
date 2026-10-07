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
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strings"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"

	"github.com/SUSE/aif-operator/api/v1alpha1"
)

// reportMarker starts the line a run prints to report its result:
// AIF_RESULT {"test":..., "status":"pass|fail", "checks":[...], "metrics":{...}, "env":{...}}
const reportMarker = "AIF_RESULT "

const (
	reportTailLines = 400
	maxReportChecks = 50
	maxReportFacts  = 50
	maxReportText   = 512
	// reportLogBytes bounds the log read: 400 lines can still be large
	reportLogBytes = 1 << 20
)

// PodLogReader reads the last lines of a pod's log.
type PodLogReader interface {
	Tail(ctx context.Context, namespace, pod string, lines int64) (string, error)
}

type clientsetLogs struct{ cs kubernetes.Interface }

func (l clientsetLogs) Tail(ctx context.Context, namespace, pod string, lines int64) (string, error) {
	limit := int64(reportLogBytes)
	raw, err := l.cs.CoreV1().Pods(namespace).GetLogs(pod, &corev1.PodLogOptions{TailLines: &lines, LimitBytes: &limit}).DoRaw(ctx)
	return string(raw), err
}

// NewPodLogReader reads logs with the operator's own credentials.
func NewPodLogReader(cfg *rest.Config) (PodLogReader, error) {
	cs, err := kubernetes.NewForConfig(cfg)
	if err != nil {
		return nil, err
	}
	return clientsetLogs{cs}, nil
}

// firstWorker is the pod a run reports from: rank 0, which prints the run's own
// output (the Job's completion index 0, or a PyTorchJob's master).
func firstWorker(pods []corev1.Pod) *corev1.Pod {
	if len(pods) == 0 {
		return nil
	}
	sorted := append([]corev1.Pod(nil), pods...)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i].Name < sorted[j].Name })
	for i := range sorted {
		l := sorted[i].Labels
		if l["batch.kubernetes.io/job-completion-index"] == "0" || strings.EqualFold(l["training.kubeflow.org/replica-type"], "master") {
			return &sorted[i]
		}
	}
	return &sorted[0]
}

// parseReport finds the last AIF_RESULT line in a log and turns it into a
// report, bounded so a run cannot grow the record without limit. nil when the
// log has none, or it is not valid JSON.
func parseReport(log string) *v1alpha1.AIJobReport {
	lines := strings.Split(log, "\n")
	for i := len(lines) - 1; i >= 0; i-- {
		at := strings.Index(lines[i], reportMarker)
		if at < 0 {
			continue
		}
		var raw struct {
			Test   string `json:"test"`
			Status string `json:"status"`
			Checks []struct {
				Name   string `json:"name"`
				OK     bool   `json:"ok"`
				Warn   bool   `json:"warn"`
				Detail string `json:"detail"`
			} `json:"checks"`
			Metrics map[string]interface{} `json:"metrics"`
			Env     map[string]interface{} `json:"env"`
		}
		if json.Unmarshal([]byte(strings.TrimSpace(lines[i][at+len(reportMarker):])), &raw) != nil {
			return nil
		}
		r := &v1alpha1.AIJobReport{Test: clip(raw.Test), Status: clip(raw.Status)}
		for _, c := range raw.Checks {
			if len(r.Checks) == maxReportChecks {
				break
			}
			r.Checks = append(r.Checks, v1alpha1.AIJobReportCheck{Name: clip(c.Name), OK: c.OK, Warn: c.Warn, Detail: clip(c.Detail)})
		}
		r.Metrics, r.Env = facts(raw.Metrics), facts(raw.Env)
		return r
	}
	return nil
}

func facts(in map[string]interface{}) map[string]string {
	if len(in) == 0 {
		return nil
	}
	keys := make([]string, 0, len(in))
	for k := range in {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	out := map[string]string{}
	for _, k := range keys {
		if len(out) == maxReportFacts {
			break
		}
		out[clip(k)] = clip(fmt.Sprint(in[k]))
	}
	return out
}

func clip(s string) string {
	if len(s) <= maxReportText {
		return s
	}
	return s[:maxReportText-3] + "..."
}

// ownedBy keeps the pods whose controller is the execution (the Job or
// PyTorchJob). Pods are found by label, and anyone who can create pods in the
// namespace can set a label; only the execution's controller makes its pods.
func ownedBy(execution metav1.Object, pods []corev1.Pod) []corev1.Pod {
	if execution == nil {
		return nil
	}
	var out []corev1.Pod
	for _, p := range pods {
		if ref := metav1.GetControllerOf(&p); ref != nil && ref.UID == execution.GetUID() {
			out = append(out, p)
		}
	}
	return out
}

// captureReport reads the first worker's report into the status. Best effort:
// a run without one, or a log that cannot be read, leaves the report unset.
// Only a pod the execution created reports.
func (r *AIJobReconciler) captureReport(ctx context.Context, job *v1alpha1.AIJob, tg *target, execution metav1.Object, pods []corev1.Pod) {
	pod := firstWorker(ownedBy(execution, pods))
	if tg.logs == nil || pod == nil {
		return
	}
	log, err := tg.logs.Tail(ctx, tg.namespace, pod.Name, reportTailLines)
	if err != nil {
		return
	}
	if rep := parseReport(log); rep != nil {
		rep.Pod = pod.Name
		t := metav1.NewTime(r.now())
		rep.ReportedAt = &t
		job.Status.Report = rep
	}
}
