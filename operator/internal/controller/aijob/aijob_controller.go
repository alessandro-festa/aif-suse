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

// Package aijob reconciles AIJob, the durable record of a finite execution.
//
// The operator installs the execution (a Helm release named after the job) from
// the spec, copies the facts of the objects it created into the status while
// they exist, and uninstalls the release once the job's retention has passed.
// The AIJob outlives all of it. See docs/design/aijob.md.
package aijob

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	resourcev1 "k8s.io/api/resource/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/tools/record"
	"sigs.k8s.io/controller-runtime/pkg/builder"
	ctrl "sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"
	"sigs.k8s.io/controller-runtime/pkg/log"
	"sigs.k8s.io/controller-runtime/pkg/predicate"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"

	controllerruntime "sigs.k8s.io/controller-runtime"

	"helm.sh/helm/v3/pkg/cli"

	"github.com/SUSE/aif-operator/api/v1alpha1"
	helmClient "github.com/SUSE/aif-operator/internal/infra/helm"
	"github.com/SUSE/aif-operator/internal/trainchart"
)

const (
	finalizer = "ai-factory.suse.com/aijob"

	// The chart's own labels, used to find a release's objects when the chart
	// does not (yet) carry the job-id label.
	instanceLabel = "app.kubernetes.io/instance"

	defaultRetention = 168 * time.Hour

	// Polling intervals. The execution objects belong to other controllers and
	// are not watched (that would cache every pod in the cluster); a job that is
	// moving is re-read on this cadence instead.
	activeRequeue  = 10 * time.Second
	waitingRequeue = 30 * time.Second
	// A finished job is re-read at most this often before its cleanup is due, so
	// a retention changed after completion is picked up.
	settledRequeue = time.Hour
)

var (
	clusterRepoGVK = schema.GroupVersionKind{Group: "catalog.cattle.io", Version: "v1", Kind: "ClusterRepo"}
	pytorchJobGVK  = schema.GroupVersionKind{Group: "kubeflow.org", Version: "v1", Kind: "PyTorchJob"}
	workloadGVK    = schema.GroupVersionKind{Group: "kueue.x-k8s.io", Version: "v1beta1", Kind: "WorkloadList"}
)

// +kubebuilder:rbac:groups=ai-factory.suse.com,resources=aijobs,verbs=get;list;watch;update;patch
// +kubebuilder:rbac:groups=ai-factory.suse.com,resources=aijobs/status,verbs=get;update;patch
// +kubebuilder:rbac:groups=ai-factory.suse.com,resources=aijobs/finalizers,verbs=update
// +kubebuilder:rbac:groups=catalog.cattle.io,resources=clusterrepos,verbs=get;list;watch
// +kubebuilder:rbac:groups=batch,resources=jobs,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=kubeflow.org,resources=pytorchjobs,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=kueue.x-k8s.io,resources=workloads,verbs=get;list;watch
// +kubebuilder:rbac:groups="",resources=pods,verbs=get;list;watch
// +kubebuilder:rbac:groups="",resources=pods/log,verbs=get
// +kubebuilder:rbac:groups="",resources=nodes,verbs=get;list;watch
// +kubebuilder:rbac:groups="",resources=services;configmaps;secrets;persistentvolumeclaims,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=resource.k8s.io,resources=resourceclaims,verbs=get;list;watch
// +kubebuilder:rbac:groups=resource.k8s.io,resources=resourceclaimtemplates,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=resource.nvidia.com,resources=computedomains,verbs=get;list;watch;create;update;patch;delete
// A training chart's install-time pre-flight looks these up as the operator: the queue it names
// exists, and the GPUs and DRA devices it asks for are there. Read-only.
// +kubebuilder:rbac:groups="",resources=namespaces,verbs=get;list
// +kubebuilder:rbac:groups=kueue.x-k8s.io,resources=localqueues;clusterqueues,verbs=get;list
// +kubebuilder:rbac:groups=scheduling.run.ai,resources=queues,verbs=get;list
// +kubebuilder:rbac:groups=resource.k8s.io,resources=deviceclasses;resourceslices,verbs=get;list

// AIJobReconciler reconciles AIJob objects.
type AIJobReconciler struct {
	ctrl.Client
	Scheme *runtime.Scheme
	// APIReader reads the execution objects uncached (see activeRequeue).
	APIReader ctrl.Reader
	Recorder  record.EventRecorder
	// AllowedCharts lists the custom charts (spec.source) an AIJob may install, as
	// "<clusterRepo>/<chart>" entries. The operator installs with its own service
	// account, so this is what stops an AIJob from installing an arbitrary chart.
	// Empty allows none: only the built-in training chart.
	AllowedCharts []string
	// RepoURLOverrides maps a ClusterRepo name to a URL to use instead of its
	// spec.url. For running the operator outside the cluster, where an in-cluster
	// repository Service does not resolve; nil in production.
	RepoURLOverrides map[string]string
	// PodLogs reads the first worker's log for its report when the run
	// finishes; nil is built from the manager's config.
	PodLogs PodLogReader
	// AllowInsecureRegistryTLS lets an AIJob pull from a ClusterRepo that sets
	// insecureSkipTLSVerify, as the operator's other chart pulls; off refuses it.
	AllowInsecureRegistryTLS bool

	// HelmFor builds the Helm client for a namespace; nil uses the real one.
	HelmFor func(namespace string) (helmClient.HelmClient, error)
	// Now is the clock; nil uses time.Now.
	Now func() time.Time

	helmClients sync.Map
}

func (r *AIJobReconciler) now() time.Time {
	if r.Now != nil {
		return r.Now()
	}
	return time.Now()
}

func (r *AIJobReconciler) helm(namespace string) (helmClient.HelmClient, error) {
	if c, ok := r.helmClients.Load(namespace); ok {
		return c.(helmClient.HelmClient), nil
	}
	build := r.HelmFor
	if build == nil {
		build = func(ns string) (helmClient.HelmClient, error) {
			s := cli.New()
			s.SetNamespace(ns)
			return helmClient.New(s)
		}
	}
	c, err := build(namespace)
	if err != nil {
		return nil, err
	}
	actual, _ := r.helmClients.LoadOrStore(namespace, c)
	return actual.(helmClient.HelmClient), nil
}

// Reconcile drives one AIJob towards its spec and refreshes its status.
func (r *AIJobReconciler) Reconcile(ctx context.Context, req reconcile.Request) (reconcile.Result, error) {
	job := &v1alpha1.AIJob{}
	if err := r.Get(ctx, req.NamespacedName, job); err != nil {
		return reconcile.Result{}, ctrl.IgnoreNotFound(err)
	}
	logger := log.FromContext(ctx).WithValues("aijob", req.NamespacedName)
	ctx = log.IntoContext(ctx, logger)

	helm, err := r.helm(job.Namespace)
	if err != nil {
		return reconcile.Result{}, err
	}

	if !job.DeletionTimestamp.IsZero() {
		return reconcile.Result{}, r.finalize(ctx, job, helm)
	}
	if controllerutil.AddFinalizer(job, finalizer) {
		if err := r.Update(ctx, job); err != nil {
			return reconcile.Result{}, err
		}
	}

	before := job.DeepCopy()
	result, rerr := r.reconcileJob(ctx, job, helm)
	if rerr == nil {
		job.Status.ObservedGeneration = job.Generation
	}
	if !statusEqual(&before.Status, &job.Status) {
		// A merge patch, not an update: the operator is the status's only
		// writer, and an update would conflict with the resourceVersion its own
		// finalizer write just bumped.
		if err := r.Status().Patch(ctx, job, ctrl.MergeFrom(before)); err != nil {
			return reconcile.Result{}, err
		}
	}
	return result, rerr
}

func (r *AIJobReconciler) reconcileJob(ctx context.Context, job *v1alpha1.AIJob, helm helmClient.HelmClient) (reconcile.Result, error) {
	st := &job.Status
	gen := job.Generation
	if st.SubmittedAt == nil {
		t := job.CreationTimestamp
		st.SubmittedAt = &t
	}
	if st.Phase == "" {
		st.Phase = v1alpha1.AIJobPhasePending
	}
	st.Execution.Release = job.Name

	release, err := helm.LastRelease(ctx, job.Name)
	if err != nil {
		return reconcile.Result{}, fmt.Errorf("look up release: %w", err)
	}
	installed := release != nil

	// Cancel: only meaningful before the job ends.
	if job.Spec.Cancel && !st.Phase.IsTerminal() {
		return r.cancel(ctx, job, helm, installed)
	}

	if st.Phase.IsTerminal() {
		return r.afterCompletion(ctx, job, helm, installed)
	}

	if !installed {
		if meta := findCondition(st, v1alpha1.AIJobConditionExecutionCleaned); meta {
			// Cleaned already: nothing to install again.
			return reconcile.Result{}, nil
		}
		if res, done := r.install(ctx, job, helm); done {
			return res, nil
		}
		installed = true
	}
	setCondition(st, gen, v1alpha1.AIJobConditionInstalled, metav1.ConditionTrue, "Installed", "release "+job.Name+" is installed")

	obs, err := r.observe(ctx, job)
	if err != nil {
		return reconcile.Result{}, err
	}
	applyObservation(st, obs)

	if obs.workload != nil {
		if conditionTime(obs.workload, "Admitted", "True") != nil {
			setCondition(st, gen, v1alpha1.AIJobConditionAdmitted, metav1.ConditionTrue, "Admitted", "Kueue admitted the workload")
		} else {
			setCondition(st, gen, v1alpha1.AIJobConditionAdmitted, metav1.ConditionFalse, "Queued", "waiting for Kueue to admit the workload")
		}
	}
	if suspended(obs) && st.Phase != v1alpha1.AIJobPhasePending {
		setCondition(st, gen, v1alpha1.AIJobConditionSuspended, metav1.ConditionTrue, "Suspended", "the execution is suspended")
	} else {
		setCondition(st, gen, v1alpha1.AIJobConditionSuspended, metav1.ConditionFalse, "NotSuspended", "")
	}

	phase := derivePhase(st.Phase, installed, obs)
	if phase.IsTerminal() {
		finishing := !st.Phase.IsTerminal()
		completion(st, obs.execution, obs.pods)
		if st.CompletedAt == nil {
			t := metav1.NewTime(r.now())
			st.CompletedAt = &t
		}
		if finishing && st.Report == nil {
			// once, as it finishes: the pods and their logs are still there
			var execution metav1.Object
			if obs.execution != nil {
				execution = obs.execution
			}
			r.captureReport(ctx, job, execution, obs.pods)
		}
		st.Phase = phase
		setCondition(st, gen, v1alpha1.AIJobConditionCompleted, metav1.ConditionTrue, string(phase), st.Result.Message)
		r.event(job, corev1.EventTypeNormal, string(phase), "the job "+strings.ToLower(string(phase)))
		return r.afterCompletion(ctx, job, helm, true)
	}
	st.Phase = phase

	if obs.execution == nil && st.Execution.Kind != "" {
		// Seen before, gone now, never seen finishing: deleted by hand or by a
		// ttl. The outcome is not known, so the phase is left as it was.
		setCondition(st, gen, v1alpha1.AIJobConditionCompleted, metav1.ConditionUnknown, "ExecutionDeleted",
			fmt.Sprintf("the %s was deleted before its outcome was observed", st.Execution.Kind))
		return reconcile.Result{RequeueAfter: settledRequeue}, nil
	}
	setCondition(st, gen, v1alpha1.AIJobConditionCompleted, metav1.ConditionFalse, "InProgress", "")
	// Only a job Kueue is holding can wait long; anything else installed is about
	// to start, and a short job polled slowly would go from Pending to finished
	// with its Running never seen.
	if phase == v1alpha1.AIJobPhaseQueued {
		return reconcile.Result{RequeueAfter: waitingRequeue}, nil
	}
	return reconcile.Result{RequeueAfter: activeRequeue}, nil
}

// install installs the release once. It returns done=true when the reconcile
// should stop here (a failure recorded, or a retry scheduled).
func (r *AIJobReconciler) install(ctx context.Context, job *v1alpha1.AIJob, helm helmClient.HelmClient) (reconcile.Result, bool) {
	st, gen := &job.Status, job.Generation
	spec, err := r.releaseSpec(ctx, job)
	if err != nil {
		var perm permanentError
		if errors.As(err, &perm) {
			r.fail(job, "InvalidSource", err.Error())
			return reconcile.Result{}, true
		}
		setCondition(st, gen, v1alpha1.AIJobConditionInstalled, metav1.ConditionFalse, "SourceUnavailable", err.Error())
		return reconcile.Result{RequeueAfter: waitingRequeue}, true
	}
	if err := helm.EnsureRelease(ctx, spec); err != nil {
		if transient(err) {
			setCondition(st, gen, v1alpha1.AIJobConditionInstalled, metav1.ConditionFalse, "InstallRetrying", err.Error())
			return reconcile.Result{RequeueAfter: waitingRequeue}, true
		}
		// A chart that refuses to render (its own pre-flight `fail`, a required
		// value missing) fails the same way every time: the job failed.
		r.fail(job, "InstallFailed", err.Error())
		return reconcile.Result{}, true
	}
	r.event(job, corev1.EventTypeNormal, "Installed", "installed release "+job.Name)
	return reconcile.Result{}, false
}

func (r *AIJobReconciler) fail(job *v1alpha1.AIJob, reason, msg string) {
	st, gen := &job.Status, job.Generation
	now := metav1.NewTime(r.now())
	st.Phase = v1alpha1.AIJobPhaseFailed
	st.CompletedAt = &now
	st.Result = &v1alpha1.AIJobResult{Reason: reason, Message: truncate(msg, 1024)}
	setCondition(st, gen, v1alpha1.AIJobConditionInstalled, metav1.ConditionFalse, reason, msg)
	setCondition(st, gen, v1alpha1.AIJobConditionCompleted, metav1.ConditionTrue, string(v1alpha1.AIJobPhaseFailed), msg)
	r.event(job, corev1.EventTypeWarning, reason, msg)
}

func (r *AIJobReconciler) cancel(ctx context.Context, job *v1alpha1.AIJob, helm helmClient.HelmClient, installed bool) (reconcile.Result, error) {
	st, gen := &job.Status, job.Generation
	if installed {
		// Facts first: once the release is gone so are the pods.
		if obs, err := r.observe(ctx, job); err == nil {
			applyObservation(st, obs)
		}
		if err := helm.DeleteRelease(ctx, job.Name); err != nil {
			return reconcile.Result{}, fmt.Errorf("uninstall on cancel: %w", err)
		}
	}
	now := metav1.NewTime(r.now())
	st.Phase = v1alpha1.AIJobPhaseCancelled
	st.CompletedAt = &now
	st.Result = &v1alpha1.AIJobResult{Reason: "Cancelled", Message: "cancelled by spec.cancel"}
	st.Cleanup.CompletedAt = &now
	setCondition(st, gen, v1alpha1.AIJobConditionCompleted, metav1.ConditionTrue, "Cancelled", "cancelled by spec.cancel")
	setCondition(st, gen, v1alpha1.AIJobConditionExecutionCleaned, metav1.ConditionTrue, "Cancelled", "release uninstalled on cancel")
	r.event(job, corev1.EventTypeNormal, "Cancelled", "uninstalled release "+job.Name)
	return reconcile.Result{}, nil
}

// afterCompletion keeps the record final and removes the execution once its
// retention has passed.
func (r *AIJobReconciler) afterCompletion(ctx context.Context, job *v1alpha1.AIJob, helm helmClient.HelmClient, installed bool) (reconcile.Result, error) {
	st, gen := &job.Status, job.Generation
	if st.Cleanup.CompletedAt != nil {
		return reconcile.Result{}, nil
	}
	retention := defaultRetention
	if d := job.Spec.Retention.ExecutionObjects; d != nil {
		retention = d.Duration
	}
	completed := r.now()
	if st.CompletedAt != nil {
		completed = st.CompletedAt.Time
	}
	due := metav1.NewTime(completed.Add(retention))
	st.Cleanup.DueAt = &due

	if installed {
		// Keep copying facts until the objects go: a pod's final state can land
		// after the Job reports completion.
		if obs, err := r.observe(ctx, job); err == nil {
			applyObservation(st, obs)
		}
	}
	wait := due.Sub(r.now())
	if wait > 0 {
		setCondition(st, gen, v1alpha1.AIJobConditionExecutionCleaned, metav1.ConditionFalse, "Retained",
			"execution objects are kept until "+due.UTC().Format(time.RFC3339))
		if wait > settledRequeue {
			wait = settledRequeue
		}
		return reconcile.Result{RequeueAfter: wait}, nil
	}
	if installed {
		if err := helm.DeleteRelease(ctx, job.Name); err != nil {
			return reconcile.Result{}, fmt.Errorf("uninstall at retention: %w", err)
		}
		r.event(job, corev1.EventTypeNormal, "ExecutionCleaned", "uninstalled release "+job.Name+" after retention")
	}
	now := metav1.NewTime(r.now())
	st.Cleanup.CompletedAt = &now
	setCondition(st, gen, v1alpha1.AIJobConditionExecutionCleaned, metav1.ConditionTrue, "RetentionPassed", "release uninstalled")
	return reconcile.Result{}, nil
}

// finalize removes a still-installed release so a running job cannot outlive
// its record, then lets the AIJob go.
func (r *AIJobReconciler) finalize(ctx context.Context, job *v1alpha1.AIJob, helm helmClient.HelmClient) error {
	if !controllerutil.ContainsFinalizer(job, finalizer) {
		return nil
	}
	if rel, err := helm.LastRelease(ctx, job.Name); err != nil {
		return err
	} else if rel != nil {
		if err := helm.DeleteRelease(ctx, job.Name); err != nil {
			return fmt.Errorf("uninstall on delete: %w", err)
		}
	}
	controllerutil.RemoveFinalizer(job, finalizer)
	return r.Update(ctx, job)
}

// permanentError marks a source problem that retrying cannot fix.
type permanentError struct{ error }

// releaseSpec builds the install: the built-in training chart, or a custom chart
// resolved from its ClusterRepo, with the submitted values and the job-id label
// added as a common label.
func (r *AIJobReconciler) releaseSpec(ctx context.Context, job *v1alpha1.AIJob) (helmClient.ReleaseSpec, error) {
	src := job.Spec.Source
	if src != nil && !r.chartAllowed(*src) {
		return helmClient.ReleaseSpec{}, permanentError{fmt.Errorf("chart %s/%s is not allowed for AIJobs (operator --aijob-allowed-charts)", src.RepoName, src.ChartName)}
	}
	values := map[string]interface{}{}
	if job.Spec.Values != nil && len(job.Spec.Values.Raw) > 0 {
		if err := json.Unmarshal(job.Spec.Values.Raw, &values); err != nil {
			return helmClient.ReleaseSpec{}, permanentError{fmt.Errorf("spec.values: %w", err)}
		}
	}
	common, _ := values["commonLabels"].(map[string]interface{})
	if common == nil {
		common = map[string]interface{}{}
	}
	common[v1alpha1.AIJobJobIDLabel] = job.Name
	values["commonLabels"] = common

	if src == nil {
		return helmClient.ReleaseSpec{Name: job.Name, Namespace: job.Namespace, Values: values, ChartArchive: trainchart.Archive()}, nil
	}

	url := r.RepoURLOverrides[src.RepoName]
	var repoTLS *tls.Config
	if url == "" {
		repo := &unstructured.Unstructured{}
		repo.SetGroupVersionKind(clusterRepoGVK)
		if err := r.Get(ctx, ctrl.ObjectKey{Name: src.RepoName}, repo); err != nil {
			if apierrors.IsNotFound(err) {
				return helmClient.ReleaseSpec{}, fmt.Errorf("ClusterRepo %s not found", src.RepoName)
			}
			return helmClient.ReleaseSpec{}, err
		}
		url, _, _ = unstructured.NestedString(repo.Object, "spec", "url")
		if git, _, _ := unstructured.NestedString(repo.Object, "spec", "gitRepo"); git != "" && url == "" {
			return helmClient.ReleaseSpec{}, permanentError{fmt.Errorf("ClusterRepo %s is git-backed; AIJob supports HTTP and OCI repositories", src.RepoName)}
		}
		var err error
		if repoTLS, err = r.clusterRepoTLS(repo); err != nil {
			return helmClient.ReleaseSpec{}, permanentError{err}
		}
	}
	if url == "" {
		return helmClient.ReleaseSpec{}, permanentError{fmt.Errorf("ClusterRepo %s has no URL", src.RepoName)}
	}
	spec := helmClient.ReleaseSpec{Name: job.Name, Namespace: job.Namespace, Version: src.Version, Values: values, TLSConfig: repoTLS}
	if strings.HasPrefix(url, "oci://") {
		spec.ChartRef = ociChartRef(url, src.ChartName)
	} else {
		spec.ChartRef, spec.RepoURL = src.ChartName, url
	}
	return spec, nil
}

// clusterRepoTLS is the TLS trust a ClusterRepo asks for, as Rancher applies it to its own pulls:
// spec.caBundle (base64 PEM) for a registry signed by a private CA, or spec.insecureSkipTLSVerify,
// honoured only when the operator was deployed allowing insecure registry TLS. nil for neither.
func (r *AIJobReconciler) clusterRepoTLS(repo *unstructured.Unstructured) (*tls.Config, error) {
	insecure, _, _ := unstructured.NestedBool(repo.Object, "spec", "insecureSkipTLSVerify")
	bundle, _, _ := unstructured.NestedString(repo.Object, "spec", "caBundle")
	if !insecure && bundle == "" {
		return nil, nil
	}
	if insecure && !r.AllowInsecureRegistryTLS {
		return nil, fmt.Errorf("ClusterRepo %s skips TLS verification, but the operator was not deployed with "+
			"insecure registry TLS enabled (manager.allowInsecureRegistryTLS); set its caBundle instead", repo.GetName())
	}
	cfg := &tls.Config{MinVersion: tls.VersionTLS12, InsecureSkipVerify: insecure} //nolint:gosec // opted into, and gated above
	if bundle != "" {
		pem, err := base64.StdEncoding.DecodeString(bundle)
		if err != nil {
			pem = []byte(bundle) // Rancher stores it base64-encoded; accept plain PEM too
		}
		pool := x509.NewCertPool()
		if !pool.AppendCertsFromPEM(pem) {
			return nil, fmt.Errorf("ClusterRepo %s has a caBundle with no PEM certificates", repo.GetName())
		}
		cfg.RootCAs = pool
	}
	return cfg, nil
}

// ociChartRef is the chart's OCI reference in a repository at url. Rancher takes an OCI ClusterRepo
// URL either as a registry namespace (oci://host/charts, holding several charts) or as one chart's
// own repository (oci://host/charts/gpu-train-job); in the second the URL already names the chart.
func ociChartRef(url, chart string) string {
	url = strings.TrimSuffix(url, "/")
	if url == "oci://"+chart || strings.HasSuffix(url, "/"+chart) {
		return url
	}
	return url + "/" + chart
}

func (r *AIJobReconciler) chartAllowed(src v1alpha1.AIJobSource) bool {
	for _, a := range r.AllowedCharts {
		if a == src.RepoName+"/"+src.ChartName || a == src.RepoName+"/*" {
			return true
		}
	}
	return false
}

// transient reports whether an install error is worth retrying: the network or
// the API server, not the chart.
func transient(err error) bool {
	if apierrors.IsServerTimeout(err) || apierrors.IsTimeout(err) || apierrors.IsTooManyRequests(err) || apierrors.IsServiceUnavailable(err) {
		return true
	}
	msg := strings.ToLower(err.Error())
	for _, s := range []string{"connection refused", "i/o timeout", "no such host", "tls handshake", "context deadline", "eof", "pending operation"} {
		if strings.Contains(msg, s) {
			return true
		}
	}
	return false
}

// observe reads the execution: the Job or PyTorchJob, its Kueue Workload, its
// pods with their claims and nodes. Uncached; see activeRequeue.
func (r *AIJobReconciler) observe(ctx context.Context, job *v1alpha1.AIJob) (observed, error) {
	o := observed{claims: map[string]*resourcev1.ResourceClaim{}, nodes: map[string]*corev1.Node{}}
	ns := job.Namespace
	name := executionName(job.Name)

	k8sJob := &batchv1.Job{}
	switch err := r.APIReader.Get(ctx, ctrl.ObjectKey{Namespace: ns, Name: name}, k8sJob); {
	case err == nil:
		u, err := runtime.DefaultUnstructuredConverter.ToUnstructured(k8sJob)
		if err != nil {
			return o, err
		}
		o.execution = &unstructured.Unstructured{Object: u}
		o.execution.SetKind("Job")
	case !apierrors.IsNotFound(err):
		return o, err
	}
	if o.execution == nil {
		ptj := &unstructured.Unstructured{}
		ptj.SetGroupVersionKind(pytorchJobGVK)
		if err := r.APIReader.Get(ctx, ctrl.ObjectKey{Namespace: ns, Name: name}, ptj); err == nil {
			o.execution = ptj
		} else if !apierrors.IsNotFound(err) && !isNoMatch(err) {
			return o, err
		}
	}

	if o.execution != nil {
		wls := &unstructured.UnstructuredList{}
		wls.SetGroupVersionKind(workloadGVK)
		if err := r.APIReader.List(ctx, wls, ctrl.InNamespace(ns)); err == nil {
			for i := range wls.Items {
				for _, ref := range wls.Items[i].GetOwnerReferences() {
					if ref.UID == o.execution.GetUID() {
						o.workload = &wls.Items[i]
					}
				}
			}
		} else if !isNoMatch(err) && !apierrors.IsNotFound(err) {
			return o, err
		}
	}

	pods := &corev1.PodList{}
	if err := r.APIReader.List(ctx, pods, ctrl.InNamespace(ns), ctrl.MatchingLabels{v1alpha1.AIJobJobIDLabel: job.Name}); err != nil {
		return o, err
	}
	if len(pods.Items) == 0 {
		if err := r.APIReader.List(ctx, pods, ctrl.InNamespace(ns), ctrl.MatchingLabels{instanceLabel: job.Name}); err != nil {
			return o, err
		}
	}
	o.pods = pods.Items

	for _, p := range o.pods {
		for _, c := range podClaimNames(p) {
			if _, done := o.claims[c]; done {
				continue
			}
			claim := &resourcev1.ResourceClaim{}
			if err := r.APIReader.Get(ctx, ctrl.ObjectKey{Namespace: ns, Name: c}, claim); err == nil {
				o.claims[c] = claim
			}
		}
		if n := p.Spec.NodeName; n != "" && o.nodes[n] == nil {
			node := &corev1.Node{}
			if err := r.APIReader.Get(ctx, ctrl.ObjectKey{Name: n}, node); err == nil {
				o.nodes[n] = node
			}
		}
	}
	return o, nil
}

// executionName is the Job or PyTorchJob name the gpu-train-job chart gives a
// release (its fullname: the release name, cut to 52 characters).
func executionName(release string) string {
	if len(release) > 52 {
		release = strings.TrimSuffix(release[:52], "-")
	}
	return release
}

func isNoMatch(err error) bool {
	return err != nil && (strings.Contains(err.Error(), "no matches for kind") || strings.Contains(err.Error(), "the server could not find the requested resource"))
}

func findCondition(st *v1alpha1.AIJobStatus, t string) bool {
	for _, c := range st.Conditions {
		if c.Type == t && c.Status == metav1.ConditionTrue {
			return true
		}
	}
	return false
}

func statusEqual(a, b *v1alpha1.AIJobStatus) bool {
	ja, _ := json.Marshal(a)
	jb, _ := json.Marshal(b)
	return string(ja) == string(jb)
}

func (r *AIJobReconciler) event(job *v1alpha1.AIJob, typ, reason, msg string) {
	if r.Recorder != nil {
		r.Recorder.Event(job, typ, reason, msg)
	}
}

// SetupWithManager registers the controller. Only spec changes (generation)
// trigger a reconcile from the AIJob itself; the status the controller writes
// does not, and the execution is polled (see activeRequeue).
func (r *AIJobReconciler) SetupWithManager(mgr controllerruntime.Manager) error {
	if r.APIReader == nil {
		r.APIReader = mgr.GetAPIReader()
	}
	if r.PodLogs == nil {
		logs, err := NewPodLogReader(mgr.GetConfig())
		if err != nil {
			return err
		}
		r.PodLogs = logs
	}
	return controllerruntime.NewControllerManagedBy(mgr).
		For(&v1alpha1.AIJob{}, builder.WithPredicates(predicate.Or(predicate.GenerationChangedPredicate{}, predicate.AnnotationChangedPredicate{}))).
		Named("aijob").
		Complete(r)
}
