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
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	"github.com/SUSE/aif-operator/api/v1alpha1"
)

type fakeLogs struct {
	logs  map[string]string
	reads int
}

func (f *fakeLogs) Tail(_ context.Context, _, pod string, _ int64) (string, error) {
	f.reads++
	return f.logs[pod], nil
}

func TestTheLastReportLineIsTheReport(t *testing.T) {
	log := "starting\n" +
		`AIF_RESULT {"test":"old","status":"fail"}` + "\n" +
		"more output\n" +
		`[rank0] AIF_RESULT {"test":"GPU Smoke Test","status":"pass","checks":[{"name":"GPU allocated","ok":true,"detail":"1 GPU"},{"name":"Persistence mode","ok":true,"warn":true}],"metrics":{"GPU memory (MiB)":"1105","bus GB/s":12.5},"env":{"node":"worker-1"}}` + "\n"
	r := parseReport(log)
	require.NotNil(t, r)
	assert.Equal(t, "GPU Smoke Test", r.Test)
	assert.Equal(t, "pass", r.Status)
	require.Len(t, r.Checks, 2)
	assert.True(t, r.Checks[1].Warn)
	assert.Equal(t, "1105", r.Metrics["GPU memory (MiB)"])
	assert.Equal(t, "12.5", r.Metrics["bus GB/s"], "numbers are kept as text")
	assert.Equal(t, "worker-1", r.Env["node"])
}

func TestNoReportOrABrokenOneIsNoReport(t *testing.T) {
	assert.Nil(t, parseReport("just training output\n"))
	assert.Nil(t, parseReport(`AIF_RESULT {"test": oops`))
}

func TestAReportIsBounded(t *testing.T) {
	checks := make([]string, 80)
	for i := range checks {
		checks[i] = `{"name":"c","ok":true}`
	}
	r := parseReport(`AIF_RESULT {"test":"` + strings.Repeat("x", 2000) + `","checks":[` + strings.Join(checks, ",") + `]}`)
	require.NotNil(t, r)
	assert.Len(t, r.Checks, maxReportChecks)
	assert.LessOrEqual(t, len(r.Test), maxReportText)
}

func TestTheFirstWorkerReports(t *testing.T) {
	pod := func(name string, labels map[string]string) corev1.Pod {
		return corev1.Pod{ObjectMeta: metav1.ObjectMeta{Name: name, Labels: labels}}
	}
	assert.Equal(t, "run-0", firstWorker([]corev1.Pod{
		pod("run-1", map[string]string{"batch.kubernetes.io/job-completion-index": "1"}),
		pod("run-0", map[string]string{"batch.kubernetes.io/job-completion-index": "0"}),
	}).Name)
	assert.Equal(t, "run-master-0", firstWorker([]corev1.Pod{
		pod("run-worker-0", map[string]string{"training.kubeflow.org/replica-type": "worker"}),
		pod("run-master-0", map[string]string{"training.kubeflow.org/replica-type": "master"}),
	}).Name)
	assert.Nil(t, firstWorker(nil))
}

func TestAFinishedRunKeepsItsReportAfterItsPodsAreGone(t *testing.T) {
	h := newHarness(t, aijob("train-1"))
	logs := &fakeLogs{logs: map[string]string{"train-1-0": `AIF_RESULT {"test":"GPU Smoke Test","status":"pass","checks":[{"name":"GPU allocated","ok":true}]}`}}
	h.r.PodLogs = logs
	h.reconcile("train-1")

	p := pod("train-1-0", 0, corev1.PodRunning, 5*time.Minute, nil)
	p.Namespace, p.Labels = ns, map[string]string{v1alpha1.AIJobJobIDLabel: "train-1", "batch.kubernetes.io/job-completion-index": "0"}
	job := &batchv1.Job{ObjectMeta: metav1.ObjectMeta{Name: "train-1", Namespace: ns, UID: "job-uid"}}
	p.OwnerReferences = []metav1.OwnerReference{*metav1.NewControllerRef(job, batchv1.SchemeGroupVersion.WithKind("Job"))}
	require.NoError(t, h.c.Create(context.Background(), job))
	require.NoError(t, h.c.Create(context.Background(), &p))
	h.reconcile("train-1")
	assert.Nil(t, h.get("train-1").Status.Report, "nothing is read while it runs")
	assert.Zero(t, logs.reads)

	job.Status.Conditions = []batchv1.JobCondition{{Type: batchv1.JobComplete, Status: corev1.ConditionTrue, LastTransitionTime: metav1.NewTime(t0.Add(time.Hour))}}
	require.NoError(t, h.c.Status().Update(context.Background(), job))
	p.Status = pod("train-1-0", 0, corev1.PodSucceeded, 5*time.Minute, i32(0)).Status
	require.NoError(t, h.c.Status().Update(context.Background(), &p))
	h.clock = t0.Add(61 * time.Minute)
	h.reconcile("train-1")

	rep := h.get("train-1").Status.Report
	require.NotNil(t, rep)
	assert.Equal(t, "GPU Smoke Test", rep.Test)
	assert.Equal(t, "train-1-0", rep.Pod)
	assert.Equal(t, 1, logs.reads)

	// the pod goes (the Job's ttl); the report stays, and the log is not read again
	require.NoError(t, h.c.Delete(context.Background(), &p))
	h.reconcile("train-1")
	assert.Equal(t, "GPU Smoke Test", h.get("train-1").Status.Report.Test)
	assert.Equal(t, 1, logs.reads)
}

func TestOnlyAPodTheExecutionCreatedReports(t *testing.T) {
	h := newHarness(t, aijob("train-2"))
	logs := &fakeLogs{logs: map[string]string{
		"train-2-0": `AIF_RESULT {"test":"Real","status":"fail","checks":[{"name":"GPU allocated","ok":false}]}`,
		// a look-alike: the run's labels and an earlier name, but not made by its Job
		"a-train-2-0": `AIF_RESULT {"test":"Planted","status":"pass","checks":[{"name":"GPU allocated","ok":true}]}`,
	}}
	h.r.PodLogs = logs
	h.reconcile("train-2")
	job := &batchv1.Job{ObjectMeta: metav1.ObjectMeta{Name: "train-2", Namespace: ns, UID: "job-uid-2"}}
	require.NoError(t, h.c.Create(context.Background(), job))
	labels := map[string]string{v1alpha1.AIJobJobIDLabel: "train-2", "batch.kubernetes.io/job-completion-index": "0"}
	real := pod("train-2-0", 0, corev1.PodSucceeded, 5*time.Minute, i32(0))
	real.Namespace, real.Labels = ns, labels
	real.OwnerReferences = []metav1.OwnerReference{*metav1.NewControllerRef(job, batchv1.SchemeGroupVersion.WithKind("Job"))}
	fake := pod("a-train-2-0", 0, corev1.PodSucceeded, 5*time.Minute, i32(0))
	fake.Namespace, fake.Labels = ns, labels
	require.NoError(t, h.c.Create(context.Background(), &real))
	require.NoError(t, h.c.Create(context.Background(), &fake))
	job.Status.Conditions = []batchv1.JobCondition{{Type: batchv1.JobComplete, Status: corev1.ConditionTrue, LastTransitionTime: metav1.NewTime(t0.Add(time.Hour))}}
	require.NoError(t, h.c.Status().Update(context.Background(), job))
	h.clock = t0.Add(61 * time.Minute)
	h.reconcile("train-2")

	rep := h.get("train-2").Status.Report
	require.NotNil(t, rep)
	assert.Equal(t, "Real", rep.Test)
	assert.Equal(t, "train-2-0", rep.Pod)
}

func TestNoExecutionNoReport(t *testing.T) {
	assert.Nil(t, ownedBy(nil, []corev1.Pod{{ObjectMeta: metav1.ObjectMeta{Name: "x"}}}))
}
