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
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	apixv1 "k8s.io/apiextensions-apiserver/pkg/apis/apiextensions/v1"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"
	clientgoscheme "k8s.io/client-go/kubernetes/scheme"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"

	"github.com/SUSE/aif-operator/api/v1alpha1"
	helmClient "github.com/SUSE/aif-operator/internal/infra/helm"
	"github.com/SUSE/aif-operator/internal/trainchart"
)

// fakeHelm stands in for the in-process Helm client: it remembers releases by
// name and records every call.
type fakeHelm struct {
	mu        sync.Mutex
	releases  map[string]*helmClient.ReleaseInfo
	ensured   []helmClient.ReleaseSpec
	deleted   []string
	ensureErr error
}

func newFakeHelm() *fakeHelm { return &fakeHelm{releases: map[string]*helmClient.ReleaseInfo{}} }

func (f *fakeHelm) EnsureRelease(_ context.Context, spec helmClient.ReleaseSpec) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.ensured = append(f.ensured, spec)
	if f.ensureErr != nil {
		return f.ensureErr
	}
	f.releases[spec.Name] = &helmClient.ReleaseInfo{ChartName: spec.ChartRef, Version: spec.Version, Values: spec.Values, Status: helmClient.StatusDeployed, Revision: 1}
	return nil
}

func (f *fakeHelm) DeleteRelease(_ context.Context, name string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.deleted = append(f.deleted, name)
	delete(f.releases, name)
	return nil
}

func (f *fakeHelm) LastRelease(_ context.Context, name string) (*helmClient.ReleaseInfo, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.releases[name], nil
}

func (f *fakeHelm) DeployedRelease(ctx context.Context, name string) (*helmClient.ReleaseInfo, error) {
	return f.LastRelease(ctx, name)
}

type harness struct {
	t     *testing.T
	c     client.Client
	helm  *fakeHelm
	r     *AIJobReconciler
	clock time.Time
}

const ns = "aif-submit"

func newHarness(t *testing.T, objs ...client.Object) *harness {
	return newHarnessServing(t, []string{"v1beta1"}, objs...)
}

// newHarnessServing is newHarness on a cluster whose Kueue serves these Workload versions.
func newHarnessServing(t *testing.T, kueueVersions []string, objs ...client.Object) *harness {
	s := runtime.NewScheme()
	require.NoError(t, clientgoscheme.AddToScheme(s))
	require.NoError(t, v1alpha1.AddToScheme(s))
	gvks := []struct{ g, v, k string }{{"catalog.cattle.io", "v1", "ClusterRepo"}, {"kubeflow.org", "v1", "PyTorchJob"}, {"trainer.kubeflow.org", "v1alpha1", "TrainJob"}, {"jobset.x-k8s.io", "v1alpha2", "JobSet"}}
	for _, v := range kueueVersions {
		gvks = append(gvks, struct{ g, v, k string }{"kueue.x-k8s.io", v, "Workload"})
	}
	for _, gvk := range gvks {
		s.AddKnownTypeWithName(metav1GVK(gvk.g, gvk.v, gvk.k), &unstructured.Unstructured{})
		s.AddKnownTypeWithName(metav1GVK(gvk.g, gvk.v, gvk.k+"List"), &unstructured.UnstructuredList{})
	}
	repo := &unstructured.Unstructured{}
	repo.SetGroupVersionKind(clusterRepoGVK)
	repo.SetName("gpu-train-charts")
	_ = unstructured.SetNestedField(repo.Object, "http://charts.example.svc:8080/charts", "spec", "url")
	objs = append(objs, repo)

	c := fake.NewClientBuilder().WithScheme(s).WithStatusSubresource(&v1alpha1.AIJob{}).WithObjects(objs...).Build()
	h := &harness{t: t, c: c, helm: newFakeHelm(), clock: t0}
	h.r = &AIJobReconciler{
		Client: c, Scheme: s, APIReader: c,
		HelmFor: func(string, string) (helmClient.HelmClient, error) { return h.helm, nil },
		Now:     func() time.Time { return h.clock },
		// The fixture installs a custom chart from gpu-train-charts, which has to be allowed.
		AllowedCharts: []string{"gpu-train-charts/*"},
	}
	return h
}

func metav1GVK(g, v, k string) schema.GroupVersionKind {
	return schema.GroupVersionKind{Group: g, Version: v, Kind: k}
}

func aijob(name string, mutate ...func(*v1alpha1.AIJob)) *v1alpha1.AIJob {
	j := &v1alpha1.AIJob{
		ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: ns, CreationTimestamp: metav1.NewTime(t0), Generation: 1},
		Spec: v1alpha1.AIJobSpec{
			Category: v1alpha1.WorkloadCategoryTraining,
			Source:   &v1alpha1.AIJobSource{RepoName: "gpu-train-charts", ChartName: "gpu-train-job", Version: "0.1.31"},
			Values:   &apixv1.JSON{Raw: []byte(`{"job":{"nodes":1},"commonLabels":{"team":"a"}}`)},
		},
	}
	for _, m := range mutate {
		m(j)
	}
	return j
}

func (h *harness) reconcile(name string) reconcile.Result {
	h.t.Helper()
	res, err := h.r.Reconcile(context.Background(), reconcile.Request{NamespacedName: types.NamespacedName{Namespace: ns, Name: name}})
	require.NoError(h.t, err)
	return res
}

func (h *harness) get(name string) *v1alpha1.AIJob {
	h.t.Helper()
	j := &v1alpha1.AIJob{}
	require.NoError(h.t, h.c.Get(context.Background(), types.NamespacedName{Namespace: ns, Name: name}, j))
	return j
}

func condStatus(j *v1alpha1.AIJob, t string) metav1.ConditionStatus {
	if c := meta.FindStatusCondition(j.Status.Conditions, t); c != nil {
		return c.Status
	}
	return ""
}

func TestInstallsOnceWithTheJobIDLabelAndNeverUpgrades(t *testing.T) {
	h := newHarness(t, aijob("train-1"))
	h.reconcile("train-1")

	require.Len(t, h.helm.ensured, 1)
	spec := h.helm.ensured[0]
	assert.Equal(t, "train-1", spec.Name)
	assert.Equal(t, ns, spec.Namespace)
	assert.Equal(t, "gpu-train-job", spec.ChartRef)
	assert.Equal(t, "http://charts.example.svc:8080/charts", spec.RepoURL)
	assert.Equal(t, "0.1.31", spec.Version)
	labels := spec.Values["commonLabels"].(map[string]interface{})
	assert.Equal(t, "train-1", labels[v1alpha1.AIJobJobIDLabel])
	assert.Equal(t, "a", labels["team"], "submitted common labels are kept")

	j := h.get("train-1")
	assert.Contains(t, j.Finalizers, finalizer)
	assert.Equal(t, v1alpha1.AIJobPhasePending, j.Status.Phase)
	assert.Equal(t, metav1.ConditionTrue, condStatus(j, v1alpha1.AIJobConditionInstalled))
	assert.Equal(t, "train-1", j.Status.Execution.Release)
	assert.True(t, j.Status.SubmittedAt.Time.Equal(t0))

	h.reconcile("train-1")
	assert.Len(t, h.helm.ensured, 1, "an installed release is never installed or upgraded again")
}

func TestOCIRepositoryBecomesAChartReference(t *testing.T) {
	h := newHarness(t, aijob("train-1"))
	h.r.RepoURLOverrides = map[string]string{"gpu-train-charts": "oci://registry.example.com/charts/"}
	h.reconcile("train-1")
	require.Len(t, h.helm.ensured, 1)
	assert.Equal(t, "oci://registry.example.com/charts/gpu-train-job", h.helm.ensured[0].ChartRef)
	assert.Empty(t, h.helm.ensured[0].RepoURL)
}

func TestAnOCIRepositoryOfOneChartIsThatChart(t *testing.T) {
	h := newHarness(t, aijob("train-1"))
	h.r.RepoURLOverrides = map[string]string{"gpu-train-charts": "oci://ghcr.io/suse/chart/gpu-train-job"}
	h.reconcile("train-1")
	require.Len(t, h.helm.ensured, 1)
	assert.Equal(t, "oci://ghcr.io/suse/chart/gpu-train-job", h.helm.ensured[0].ChartRef,
		"a ClusterRepo URL that already names the chart is not given the name twice")
}

func TestOCIChartRef(t *testing.T) {
	for url, want := range map[string]string{
		"oci://host/charts":                  "oci://host/charts/gpu-train-job",
		"oci://host/charts/":                 "oci://host/charts/gpu-train-job",
		"oci://host/charts/gpu-train-job":    "oci://host/charts/gpu-train-job",
		"oci://host/charts/gpu-train-job/":   "oci://host/charts/gpu-train-job",
		"oci://host/charts/my-gpu-train-job": "oci://host/charts/my-gpu-train-job/gpu-train-job",
	} {
		assert.Equal(t, want, ociChartRef(url, "gpu-train-job"), url)
	}
}

func TestRunsToSuccessThenCleansUpAtRetention(t *testing.T) {
	h := newHarness(t, aijob("train-1"))
	h.reconcile("train-1")

	running := pod("train-1-0", 0, corev1.PodRunning, 5*time.Minute, nil)
	running.Namespace, running.Labels = ns, map[string]string{v1alpha1.AIJobJobIDLabel: "train-1"}
	job := &batchv1.Job{ObjectMeta: metav1.ObjectMeta{Name: "train-1", Namespace: ns, UID: "job-uid"}}
	require.NoError(t, h.c.Create(context.Background(), job))
	require.NoError(t, h.c.Create(context.Background(), &running))

	res := h.reconcile("train-1")
	j := h.get("train-1")
	assert.Equal(t, v1alpha1.AIJobPhaseRunning, j.Status.Phase)
	assert.Equal(t, "Job", j.Status.Execution.Kind)
	assert.True(t, j.Status.StartedAt.Time.Equal(t0.Add(5*time.Minute)))
	assert.Equal(t, activeRequeue, res.RequeueAfter)

	// The Job completes and its pod exits 0.
	job.Status.Conditions = []batchv1.JobCondition{{Type: batchv1.JobComplete, Status: corev1.ConditionTrue, LastTransitionTime: metav1.NewTime(t0.Add(time.Hour))}}
	require.NoError(t, h.c.Status().Update(context.Background(), job))
	done := pod("train-1-0", 0, corev1.PodSucceeded, 5*time.Minute, i32(0))
	running.Status = done.Status
	require.NoError(t, h.c.Status().Update(context.Background(), &running))

	h.clock = t0.Add(61 * time.Minute)
	h.reconcile("train-1")
	j = h.get("train-1")
	assert.Equal(t, v1alpha1.AIJobPhaseSucceeded, j.Status.Phase)
	assert.True(t, j.Status.CompletedAt.Time.Equal(t0.Add(time.Hour)), "the Job's own completion time")
	assert.Equal(t, int32(0), *j.Status.Result.ExitCode)
	assert.True(t, j.Status.Cleanup.DueAt.Time.Equal(t0.Add(time.Hour+defaultRetention)))
	assert.Equal(t, metav1.ConditionFalse, condStatus(j, v1alpha1.AIJobConditionExecutionCleaned))
	assert.Empty(t, h.helm.deleted)

	// Retention passes: the release goes, the record stays.
	h.clock = t0.Add(time.Hour + defaultRetention + time.Minute)
	h.reconcile("train-1")
	j = h.get("train-1")
	assert.Equal(t, []string{"train-1"}, h.helm.deleted)
	assert.Equal(t, metav1.ConditionTrue, condStatus(j, v1alpha1.AIJobConditionExecutionCleaned))
	assert.NotNil(t, j.Status.Cleanup.CompletedAt)
	assert.Equal(t, v1alpha1.AIJobPhaseSucceeded, j.Status.Phase)
	require.Len(t, j.Status.Pods, 1)

	h.reconcile("train-1")
	assert.Len(t, h.helm.ensured, 1, "a cleaned job is not reinstalled")
}

func TestShorterRetentionCleansSooner(t *testing.T) {
	h := newHarness(t, aijob("train-1", func(j *v1alpha1.AIJob) {
		j.Spec.Retention.ExecutionObjects = &metav1.Duration{Duration: time.Hour}
	}))
	h.reconcile("train-1")
	require.NoError(t, h.c.Create(context.Background(), &batchv1.Job{
		ObjectMeta: metav1.ObjectMeta{Name: "train-1", Namespace: ns},
		Status:     batchv1.JobStatus{Conditions: []batchv1.JobCondition{{Type: batchv1.JobFailed, Status: corev1.ConditionTrue, Reason: "BackoffLimitExceeded", LastTransitionTime: metav1.NewTime(t0)}}},
	}))
	h.reconcile("train-1")
	assert.Equal(t, v1alpha1.AIJobPhaseFailed, h.get("train-1").Status.Phase)
	assert.Equal(t, "BackoffLimitExceeded", h.get("train-1").Status.Result.Reason)

	h.clock = t0.Add(2 * time.Hour)
	h.reconcile("train-1")
	assert.Equal(t, []string{"train-1"}, h.helm.deleted)
}

func TestCancelUninstallsAndEndsCancelled(t *testing.T) {
	h := newHarness(t, aijob("train-1"))
	h.reconcile("train-1")
	j := h.get("train-1")
	j.Spec.Cancel = true
	require.NoError(t, h.c.Update(context.Background(), j))

	h.reconcile("train-1")
	j = h.get("train-1")
	assert.Equal(t, []string{"train-1"}, h.helm.deleted)
	assert.Equal(t, v1alpha1.AIJobPhaseCancelled, j.Status.Phase)
	assert.Equal(t, "Cancelled", j.Status.Result.Reason)
	assert.Equal(t, metav1.ConditionTrue, condStatus(j, v1alpha1.AIJobConditionExecutionCleaned))
}

func TestDeletingTheRecordUninstallsARunningRelease(t *testing.T) {
	h := newHarness(t, aijob("train-1"))
	h.reconcile("train-1")
	require.NoError(t, h.c.Delete(context.Background(), h.get("train-1")))
	h.reconcile("train-1")
	assert.Equal(t, []string{"train-1"}, h.helm.deleted)
	err := h.c.Get(context.Background(), types.NamespacedName{Namespace: ns, Name: "train-1"}, &v1alpha1.AIJob{})
	assert.True(t, client.IgnoreNotFound(err) == nil && err != nil, "the AIJob is gone once the finalizer is removed")
}

func TestAChartOutsideTheAllowListFailsWithoutInstalling(t *testing.T) {
	h := newHarness(t, aijob("train-1"))
	h.r.AllowedCharts = []string{"gpu-train-charts/other-chart"}
	h.reconcile("train-1")
	j := h.get("train-1")
	assert.Empty(t, h.helm.ensured)
	assert.Equal(t, v1alpha1.AIJobPhaseFailed, j.Status.Phase)
	assert.Equal(t, "InvalidSource", j.Status.Result.Reason)

	h2 := newHarness(t, aijob("train-2"))
	h2.r.AllowedCharts = []string{"gpu-train-charts/*"}
	h2.reconcile("train-2")
	assert.Len(t, h2.helm.ensured, 1)
}

func TestAJobWithoutASourceInstallsTheBuiltInChart(t *testing.T) {
	h := newHarness(t, aijob("train-1", func(j *v1alpha1.AIJob) { j.Spec.Source = nil }))
	h.r.AllowedCharts = nil
	h.reconcile("train-1")
	require.Len(t, h.helm.ensured, 1)
	spec := h.helm.ensured[0]
	assert.Equal(t, trainchart.Archive(), spec.ChartArchive)
	assert.Empty(t, spec.ChartRef, "nothing to pull")
	assert.Empty(t, spec.RepoURL)
	assert.Equal(t, "train-1", spec.Values["commonLabels"].(map[string]interface{})[v1alpha1.AIJobJobIDLabel])
}

func TestACustomChartIsRefusedUnlessAllowed(t *testing.T) {
	h := newHarness(t, aijob("train-1"))
	h.r.AllowedCharts = nil
	h.reconcile("train-1")
	assert.Empty(t, h.helm.ensured)
	assert.Equal(t, "InvalidSource", h.get("train-1").Status.Result.Reason)
}

func TestARenderFailureFailsTheJobButANetworkErrorRetries(t *testing.T) {
	h := newHarness(t, aijob("train-1"))
	h.helm.ensureErr = errors.New(`execution error at (gpu-train-job/templates/preflight.yaml:12:5): preflight: no GPU node has 1 free nvidia.com/gpu`)
	h.reconcile("train-1")
	j := h.get("train-1")
	assert.Equal(t, v1alpha1.AIJobPhaseFailed, j.Status.Phase)
	assert.Equal(t, "InstallFailed", j.Status.Result.Reason)
	assert.Contains(t, j.Status.Result.Message, "preflight")

	h2 := newHarness(t, aijob("train-2"))
	h2.helm.ensureErr = errors.New(`Get "http://charts.example.svc:8080/charts/index.yaml": dial tcp: lookup charts.example.svc: no such host`)
	res := h2.reconcile("train-2")
	j = h2.get("train-2")
	assert.Equal(t, v1alpha1.AIJobPhasePending, j.Status.Phase)
	assert.Equal(t, "InstallRetrying", meta.FindStatusCondition(j.Status.Conditions, v1alpha1.AIJobConditionInstalled).Reason)
	assert.Equal(t, waitingRequeue, res.RequeueAfter)
}

func TestAJobDeletedUnderTheRecordIsNotGivenAnOutcome(t *testing.T) {
	h := newHarness(t, aijob("train-1"))
	h.reconcile("train-1")
	job := &batchv1.Job{ObjectMeta: metav1.ObjectMeta{Name: "train-1", Namespace: ns}}
	require.NoError(t, h.c.Create(context.Background(), job))
	h.reconcile("train-1")
	require.NoError(t, h.c.Delete(context.Background(), job))
	h.reconcile("train-1")
	j := h.get("train-1")
	assert.False(t, j.Status.Phase.IsTerminal())
	c := meta.FindStatusCondition(j.Status.Conditions, v1alpha1.AIJobConditionCompleted)
	require.NotNil(t, c)
	assert.Equal(t, metav1.ConditionUnknown, c.Status)
	assert.Equal(t, "ExecutionDeleted", c.Reason)
}

// The Kueue Workload is found whichever version the cluster serves: v1beta2 on
// current Kueue, v1beta1 on releases before 0.15.
func TestTheKueueWorkloadIsFoundInEitherAPIVersion(t *testing.T) {
	for _, served := range []string{"v1beta1", "v1beta2"} {
		t.Run(served, func(t *testing.T) {
			exec := &batchv1.Job{ObjectMeta: metav1.ObjectMeta{Name: "train-1", Namespace: ns, UID: "job-uid"}}
			wl := &unstructured.Unstructured{}
			wl.SetGroupVersionKind(metav1GVK("kueue.x-k8s.io", served, "Workload"))
			wl.SetName("job-train-1")
			wl.SetNamespace(ns)
			wl.SetOwnerReferences([]metav1.OwnerReference{{APIVersion: "batch/v1", Kind: "Job", Name: "train-1", UID: "job-uid"}})
			h := newHarnessServing(t, []string{served}, aijob("train-1"), exec, wl)
			j := h.get("train-1")
			o, err := h.r.observe(context.Background(), j, &target{namespace: j.Namespace, reader: h.c})
			require.NoError(t, err)
			require.NotNil(t, o.workload)
			assert.Equal(t, "job-train-1", o.workload.GetName())
		})
	}
}
