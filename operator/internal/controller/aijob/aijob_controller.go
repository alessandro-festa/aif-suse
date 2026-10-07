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
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/tools/record"
	"sigs.k8s.io/controller-runtime/pkg/builder"
	ctrl "sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"
	"sigs.k8s.io/controller-runtime/pkg/log"
	"sigs.k8s.io/controller-runtime/pkg/predicate"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"

	controllerruntime "sigs.k8s.io/controller-runtime"

	"github.com/SUSE/aif-operator/api/v1alpha1"
	helmClient "github.com/SUSE/aif-operator/internal/infra/helm"
	"github.com/SUSE/aif-operator/internal/infra/rancher"
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
	// A TrainJob refused only because Trainer had not seen its runtime yet is
	// retried at once.
	runtimeRequeue = 2 * time.Second
	// A finished job is re-read at most this often before its cleanup is due, so
	// a retention changed after completion is picked up.
	settledRequeue = time.Hour
)

var (
	clusterRepoGVK = schema.GroupVersionKind{Group: "catalog.cattle.io", Version: "v1", Kind: "ClusterRepo"}
	pytorchJobGVK  = schema.GroupVersionKind{Group: "kubeflow.org", Version: "v1", Kind: "PyTorchJob"}
	rayJobGVK      = schema.GroupVersionKind{Group: "ray.io", Version: "v1", Kind: "RayJob"}
	trainJobGVK    = schema.GroupVersionKind{Group: "trainer.kubeflow.org", Version: "v1alpha1", Kind: "TrainJob"}
	jobSetGVK      = schema.GroupVersionKind{Group: "jobset.x-k8s.io", Version: "v1alpha2", Kind: "JobSet"}
	// Kueue Workloads, newest API version first: Kueue serves v1beta2 from 0.15
	// and still serves v1beta1, which older releases have alone.
	workloadGVKs = []schema.GroupVersionKind{
		{Group: "kueue.x-k8s.io", Version: "v1beta2", Kind: "WorkloadList"},
		{Group: "kueue.x-k8s.io", Version: "v1beta1", Kind: "WorkloadList"},
	}
)

// +kubebuilder:rbac:groups=ai-factory.suse.com,resources=aijobs,verbs=get;list;watch;update;patch
// +kubebuilder:rbac:groups=ai-factory.suse.com,resources=aijobs/status,verbs=get;update;patch
// +kubebuilder:rbac:groups=ai-factory.suse.com,resources=aijobs/finalizers,verbs=update
// +kubebuilder:rbac:groups=catalog.cattle.io,resources=clusterrepos,verbs=get;list;watch
// +kubebuilder:rbac:groups=batch,resources=jobs,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=kubeflow.org,resources=pytorchjobs,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=ray.io,resources=rayjobs,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=trainer.kubeflow.org,resources=trainjobs;trainingruntimes,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=jobset.x-k8s.io,resources=jobsets,verbs=get;list;watch
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
// The pool a job runs in.
// +kubebuilder:rbac:groups=ai-factory.suse.com,resources=computepools,verbs=get;list;watch

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

	// Connection is how downstream clusters are reached, through Rancher's
	// proxy with the Settings token; a job in a pool on one waits for it.
	Connection *rancher.ConnectionHolder

	// HelmFor builds the Helm client for a namespace of a cluster; nil uses the
	// real one.
	HelmFor func(clusterID, namespace string) (helmClient.HelmClient, error)
	// RemoteFor builds the reader and log reader for a downstream cluster; nil
	// uses Rancher's proxy.
	RemoteFor func(clusterID string) (ctrl.Reader, PodLogReader, error)
	// Now is the clock; nil uses time.Now.
	Now func() time.Time

	helmClients sync.Map
	remotes     sync.Map
}

func (r *AIJobReconciler) now() time.Time {
	if r.Now != nil {
		return r.Now()
	}
	return time.Now()
}

// Reconcile drives one AIJob towards its spec and refreshes its status.
func (r *AIJobReconciler) Reconcile(ctx context.Context, req reconcile.Request) (reconcile.Result, error) {
	job := &v1alpha1.AIJob{}
	if err := r.Get(ctx, req.NamespacedName, job); err != nil {
		return reconcile.Result{}, ctrl.IgnoreNotFound(err)
	}
	logger := log.FromContext(ctx).WithValues("aijob", req.NamespacedName)
	ctx = log.IntoContext(ctx, logger)

	t, err := r.targetFor(ctx, job)
	var wait unplaced
	var deny notInProject
	if (errors.As(err, &wait) || errors.As(err, &deny)) && !job.DeletionTimestamp.IsZero() && job.Status.Placement == nil {
		// Never installed anywhere: nothing to clean up.
		controllerutil.RemoveFinalizer(job, finalizer)
		return reconcile.Result{}, r.Update(ctx, job)
	}
	if errors.As(err, &deny) {
		if job.Status.Phase.IsTerminal() {
			return reconcile.Result{}, nil
		}
		before := job.DeepCopy()
		r.fail(job, "NotInProject", deny.msg)
		return reconcile.Result{}, r.Status().Patch(ctx, job, ctrl.MergeFrom(before))
	}
	if errors.As(err, &wait) {
		before := job.DeepCopy()
		if job.Status.Phase == "" {
			job.Status.Phase = v1alpha1.AIJobPhasePending
		}
		setCondition(&job.Status, job.Generation, v1alpha1.AIJobConditionInstalled, metav1.ConditionFalse, wait.reason, wait.msg)
		if !statusEqual(&before.Status, &job.Status) {
			if err := r.Status().Patch(ctx, job, ctrl.MergeFrom(before)); err != nil {
				return reconcile.Result{}, err
			}
		}
		return reconcile.Result{RequeueAfter: waitingRequeue}, nil
	}
	if err != nil {
		return reconcile.Result{}, err
	}

	if !job.DeletionTimestamp.IsZero() {
		return reconcile.Result{}, r.finalize(ctx, job, t)
	}
	if controllerutil.AddFinalizer(job, finalizer) {
		if err := r.Update(ctx, job); err != nil {
			return reconcile.Result{}, err
		}
	}

	before := job.DeepCopy()
	result, rerr := r.reconcileJob(ctx, job, t)
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

func (r *AIJobReconciler) reconcileJob(ctx context.Context, job *v1alpha1.AIJob, t *target) (reconcile.Result, error) {
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

	release, err := t.helm.LastRelease(ctx, job.Name)
	if err != nil {
		return reconcile.Result{}, fmt.Errorf("look up release: %w", err)
	}
	installed := release != nil

	// Cancel: only meaningful before the job ends.
	if job.Spec.Cancel && !st.Phase.IsTerminal() {
		return r.cancel(ctx, job, t, installed)
	}

	// Reclaim: asked by the placement controller for a run idle in its pool.
	if policy, asked := job.Annotations[v1alpha1.AIJobReclaimAnnotation]; asked {
		return r.reclaim(ctx, job, t, installed, v1alpha1.AIJobReclaimPolicy(policy))
	}

	if st.Phase.IsTerminal() {
		return r.afterCompletion(ctx, job, t, installed)
	}

	// A release whose last revision failed (an install refused part-way, such as a
	// TrainJob before Trainer saw its runtime) is installed again: EnsureRelease
	// upgrades it. Cleanup above still uninstalls it as it is.
	if installed && release.Status == helmClient.StatusFailed {
		installed = false
	}
	if !installed {
		if meta := findCondition(st, v1alpha1.AIJobConditionExecutionCleaned); meta {
			// Cleaned already: nothing to install again.
			return reconcile.Result{}, nil
		}
		if res, done := r.install(ctx, job, t); done {
			return res, nil
		}
		installed = true
	}
	setCondition(st, gen, v1alpha1.AIJobConditionInstalled, metav1.ConditionTrue, "Installed", "release "+job.Name+" is installed")
	if meta.IsStatusConditionTrue(st.Conditions, v1alpha1.AIJobConditionReclaimed) {
		setCondition(st, gen, v1alpha1.AIJobConditionReclaimed, metav1.ConditionFalse, "Resumed", "installed again after a reclaim")
	}

	obs, err := r.observe(ctx, job, t)
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
			r.captureReport(ctx, job, t, obs)
		}
		st.Phase = phase
		setCondition(st, gen, v1alpha1.AIJobConditionCompleted, metav1.ConditionTrue, string(phase), st.Result.Message)
		r.event(job, corev1.EventTypeNormal, string(phase), "the job "+strings.ToLower(string(phase)))
		return r.afterCompletion(ctx, job, t, true)
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
func (r *AIJobReconciler) install(ctx context.Context, job *v1alpha1.AIJob, t *target) (reconcile.Result, bool) {
	st, gen := &job.Status, job.Generation
	spec, err := r.releaseSpec(ctx, job, t)
	if err != nil {
		var perm permanentError
		if errors.As(err, &perm) {
			r.fail(job, "InvalidSource", err.Error())
			return reconcile.Result{}, true
		}
		setCondition(st, gen, v1alpha1.AIJobConditionInstalled, metav1.ConditionFalse, "SourceUnavailable", err.Error())
		return reconcile.Result{RequeueAfter: waitingRequeue}, true
	}
	if t.pool != nil {
		// Recorded before the install, so a half-done install is still found and cleaned up there.
		st.Placement = &v1alpha1.AIJobPlacement{Pool: t.pool.Name, ClusterID: t.clusterID, Namespace: t.namespace}
	}
	if err := t.helm.EnsureRelease(ctx, spec); err != nil {
		if runtimeNotSeenYet(err) {
			// Helm creates a TrainJob before its TrainingRuntime (it orders unknown kinds by
			// name), and Trainer refuses a TrainJob whose runtime it has not seen. The runtime
			// was created all the same: the retry, an upgrade of the failed release, adds the TrainJob.
			setCondition(st, gen, v1alpha1.AIJobConditionInstalled, metav1.ConditionFalse, "InstallRetrying", "waiting for Kubeflow Trainer to see the run's TrainingRuntime")
			return reconcile.Result{RequeueAfter: runtimeRequeue}, true
		}
		if transient(err) {
			setCondition(st, gen, v1alpha1.AIJobConditionInstalled, metav1.ConditionFalse, "InstallRetrying", err.Error())
			return reconcile.Result{RequeueAfter: waitingRequeue}, true
		}
		// A chart that refuses to render (its own pre-flight `fail`, a required
		// value missing) fails the same way every time: the job failed.
		r.fail(job, "InstallFailed", err.Error())
		return reconcile.Result{}, true
	}
	where := ""
	if t.pool != nil {
		where = fmt.Sprintf(" in pool %s (cluster %s, namespace %s)", t.pool.Name, t.clusterID, t.namespace)
	}
	r.event(job, corev1.EventTypeNormal, "Installed", "installed release "+job.Name+where)
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

func (r *AIJobReconciler) cancel(ctx context.Context, job *v1alpha1.AIJob, t *target, installed bool) (reconcile.Result, error) {
	st, gen := &job.Status, job.Generation
	if installed {
		// Facts first: once the release is gone so are the pods.
		if obs, err := r.observe(ctx, job, t); err == nil {
			applyObservation(st, obs)
		}
		if err := t.helm.DeleteRelease(ctx, job.Name); err != nil {
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

// reclaim uninstalls an idle run to free its pool. Suspend puts it back in the
// queue, in its original submission order (its checkpoint volume is kept on the
// cluster); Terminate ends it Reclaimed. The status is saved before the request
// is dropped, so a crash in between repeats the reclaim rather than losing it.
func (r *AIJobReconciler) reclaim(ctx context.Context, job *v1alpha1.AIJob, t *target, installed bool, policy v1alpha1.AIJobReclaimPolicy) (reconcile.Result, error) {
	st, gen := &job.Status, job.Generation
	before := job.DeepCopy()
	if !st.Phase.IsTerminal() && st.Placement != nil && job.Spec.Pool == "" &&
		(policy == v1alpha1.AIJobReclaimSuspend || policy == v1alpha1.AIJobReclaimTerminate) {
		if installed {
			if err := t.helm.DeleteRelease(ctx, job.Name); err != nil {
				return reconcile.Result{}, fmt.Errorf("uninstall on reclaim: %w", err)
			}
		}
		now := metav1.NewTime(r.now())
		reason := "idle"
		if st.Activity != nil && st.Activity.Message != "" {
			reason = st.Activity.Message
		}
		st.ReclaimHistory = append(st.ReclaimHistory, v1alpha1.AIJobReclaimRecord{At: now, Pool: st.Placement.Pool, Policy: policy, Reason: reason})
		if n := len(st.ReclaimHistory); n > 10 {
			st.ReclaimHistory = st.ReclaimHistory[n-10:]
		}
		pool := st.Placement.Pool
		if policy == v1alpha1.AIJobReclaimTerminate {
			st.Phase = v1alpha1.AIJobPhaseReclaimed
			st.CompletedAt = &now
			st.Result = &v1alpha1.AIJobResult{Reason: "Reclaimed", Message: truncate("reclaimed while idle: "+reason, 1024)}
			st.Cleanup.CompletedAt = &now
			setCondition(st, gen, v1alpha1.AIJobConditionCompleted, metav1.ConditionTrue, string(v1alpha1.AIJobPhaseReclaimed), st.Result.Message)
			setCondition(st, gen, v1alpha1.AIJobConditionExecutionCleaned, metav1.ConditionTrue, "Reclaimed", "release uninstalled on reclaim")
		} else {
			// back in the queue: forget where it ran and what it ran as
			st.Phase = v1alpha1.AIJobPhasePending
			st.Placement = nil
			st.PlacementMessage = "reclaimed while idle; waiting for a compute pool"
			st.Execution = v1alpha1.AIJobExecution{Release: job.Name}
			st.Queue, st.Pods, st.PodCounts, st.Resources = nil, nil, nil, nil
			st.AdmittedAt, st.StartedAt = nil, nil
			setCondition(st, gen, v1alpha1.AIJobConditionInstalled, metav1.ConditionFalse, "Reclaimed", "uninstalled while idle; waiting for a compute pool")
		}
		st.Activity = nil
		setCondition(st, gen, v1alpha1.AIJobConditionReclaimed, metav1.ConditionTrue, string(policy), reason)
		r.event(job, corev1.EventTypeNormal, "Reclaimed", fmt.Sprintf("uninstalled from pool %s (%s): %s", pool, policy, reason))
		if err := r.Status().Patch(ctx, job, ctrl.MergeFrom(before)); err != nil {
			return reconcile.Result{}, err
		}
	}
	// Done, or not applicable (finished meanwhile, pinned to a pool, Never): drop the request.
	beforeMeta := job.DeepCopy()
	delete(job.Annotations, v1alpha1.AIJobReclaimAnnotation)
	if err := r.Patch(ctx, job, ctrl.MergeFrom(beforeMeta)); err != nil {
		return reconcile.Result{}, err
	}
	return reconcile.Result{Requeue: true}, nil
}

// afterCompletion keeps the record final and removes the execution once its
// retention has passed.
func (r *AIJobReconciler) afterCompletion(ctx context.Context, job *v1alpha1.AIJob, t *target, installed bool) (reconcile.Result, error) {
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
		if obs, err := r.observe(ctx, job, t); err == nil {
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
		if err := t.helm.DeleteRelease(ctx, job.Name); err != nil {
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
func (r *AIJobReconciler) finalize(ctx context.Context, job *v1alpha1.AIJob, t *target) error {
	if !controllerutil.ContainsFinalizer(job, finalizer) {
		return nil
	}
	if rel, err := t.helm.LastRelease(ctx, job.Name); err != nil {
		return err
	} else if rel != nil {
		if err := t.helm.DeleteRelease(ctx, job.Name); err != nil {
			return fmt.Errorf("uninstall on delete: %w", err)
		}
	}
	controllerutil.RemoveFinalizer(job, finalizer)
	return r.Update(ctx, job)
}

// toValues turns a typed object into the generic form chart values take.
func toValues(v any) (map[string]interface{}, error) {
	raw, err := json.Marshal(v)
	if err != nil {
		return nil, err
	}
	out := map[string]interface{}{}
	return out, json.Unmarshal(raw, &out)
}

// permanentError marks a source problem that retrying cannot fix.
type permanentError struct{ error }

// releaseSpec builds the install: the built-in training chart, or a custom chart
// resolved from its ClusterRepo, with the submitted values and the job-id label
// added as a common label.
func (r *AIJobReconciler) releaseSpec(ctx context.Context, job *v1alpha1.AIJob, t *target) (helmClient.ReleaseSpec, error) {
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
	if t.pool != nil && t.pool.Spec.NodeSelector != nil {
		// The pool decides the nodes, whatever the submitted values said.
		sel, err := toValues(t.pool.Spec.NodeSelector)
		if err != nil {
			return helmClient.ReleaseSpec{}, err
		}
		values["poolSelector"] = sel
	}

	if src == nil {
		return helmClient.ReleaseSpec{Name: job.Name, Namespace: t.namespace, Values: values, ChartArchive: trainchart.Archive()}, nil
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
	spec := helmClient.ReleaseSpec{Name: job.Name, Namespace: t.namespace, Version: src.Version, Values: values, TLSConfig: repoTLS}
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
// runtimeNotSeenYet is a webhook refusing a TrainJob created before its
// TrainingRuntime was visible to it: Trainer's, or Kueue's TrainJob webhook
// (vtrainjob.kb.io, "runtime '<name>' not found") where Kueue manages TrainJobs.
func runtimeNotSeenYet(err error) bool {
	msg := strings.ToLower(err.Error())
	return strings.Contains(msg, "trainingruntime must be created before the trainjob") ||
		(strings.Contains(msg, "vtrainjob.kb.io") && strings.Contains(msg, "runtime") && strings.Contains(msg, "not found"))
}

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

// observe reads the execution: the Job, PyTorchJob, RayJob or TrainJob, its
// Kueue Workload, its pods with their claims and nodes. Uncached; see
// activeRequeue.
func (r *AIJobReconciler) observe(ctx context.Context, job *v1alpha1.AIJob, t *target) (observed, error) {
	o := observed{claims: map[string]*resourcev1.ResourceClaim{}, nodes: map[string]*corev1.Node{}}
	ns := t.namespace
	reader := t.reader
	name := executionName(job.Name)

	k8sJob := &batchv1.Job{}
	switch err := reader.Get(ctx, ctrl.ObjectKey{Namespace: ns, Name: name}, k8sJob); {
	case err == nil && ownedByRayJob(k8sJob):
		// KubeRay names its submitter Job after the RayJob: the run is the RayJob, found below
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
		if err := reader.Get(ctx, ctrl.ObjectKey{Namespace: ns, Name: name}, ptj); err == nil {
			o.execution = ptj
		} else if !apierrors.IsNotFound(err) && !isNoMatch(err) {
			return o, err
		}
	}
	if o.execution == nil {
		rj := &unstructured.Unstructured{}
		rj.SetGroupVersionKind(rayJobGVK)
		if err := reader.Get(ctx, ctrl.ObjectKey{Namespace: ns, Name: name}, rj); err == nil {
			o.execution = rj
		} else if !apierrors.IsNotFound(err) && !isNoMatch(err) {
			return o, err
		}
	}
	if o.execution == nil {
		tj := &unstructured.Unstructured{}
		tj.SetGroupVersionKind(trainJobGVK)
		if err := reader.Get(ctx, ctrl.ObjectKey{Namespace: ns, Name: name}, tj); err == nil {
			o.execution = tj
		} else if !apierrors.IsNotFound(err) && !isNoMatch(err) {
			return o, err
		}
	}
	if o.execution != nil {
		owners, err := podOwners(ctx, reader, o.execution)
		if err != nil {
			return o, err
		}
		o.podOwners = owners
	}

	if o.execution != nil {
		// Each version in turn until the Workload turns up: one that is not served
		// is skipped, and so is one that is served but does not have it.
		for _, gvk := range workloadGVKs {
			wls := &unstructured.UnstructuredList{}
			wls.SetGroupVersionKind(gvk)
			err := reader.List(ctx, wls, ctrl.InNamespace(ns))
			if isNoMatch(err) || apierrors.IsNotFound(err) {
				continue
			}
			if err != nil {
				return o, err
			}
			for i := range wls.Items {
				for _, ref := range wls.Items[i].GetOwnerReferences() {
					if ref.UID == o.execution.GetUID() {
						o.workload = &wls.Items[i]
					}
				}
			}
			if o.workload != nil {
				break
			}
		}
	}

	pods := &corev1.PodList{}
	if err := reader.List(ctx, pods, ctrl.InNamespace(ns), ctrl.MatchingLabels{v1alpha1.AIJobJobIDLabel: job.Name}); err != nil {
		return o, err
	}
	if len(pods.Items) == 0 {
		if err := reader.List(ctx, pods, ctrl.InNamespace(ns), ctrl.MatchingLabels{instanceLabel: job.Name}); err != nil {
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
			if err := reader.Get(ctx, ctrl.ObjectKey{Namespace: ns, Name: c}, claim); err == nil {
				o.claims[c] = claim
			}
		}
		if n := p.Spec.NodeName; n != "" && o.nodes[n] == nil {
			node := &corev1.Node{}
			if err := reader.Get(ctx, ctrl.ObjectKey{Name: n}, node); err == nil {
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

// podOwners are the controllers of the run's own pods. A TrainJob's pods belong
// to the Jobs of the JobSet it made, followed down by controller reference so a
// pod labelled for the run by anyone else is not counted.
func podOwners(ctx context.Context, reader ctrl.Reader, ex *unstructured.Unstructured) (map[types.UID]bool, error) {
	if ex.GetKind() != "TrainJob" {
		return map[types.UID]bool{ex.GetUID(): true}, nil
	}
	owners := map[types.UID]bool{}
	js := &unstructured.Unstructured{}
	js.SetGroupVersionKind(jobSetGVK)
	err := reader.Get(ctx, ctrl.ObjectKey{Namespace: ex.GetNamespace(), Name: ex.GetName()}, js)
	if apierrors.IsNotFound(err) || isNoMatch(err) {
		return owners, nil
	}
	if err != nil {
		return nil, err
	}
	if ref := metav1.GetControllerOf(js); ref == nil || ref.UID != ex.GetUID() {
		return owners, nil
	}
	jobs := &batchv1.JobList{}
	if err := reader.List(ctx, jobs, ctrl.InNamespace(ex.GetNamespace()), ctrl.MatchingLabels{jobSetNameLabel: js.GetName()}); err != nil {
		return nil, err
	}
	for i := range jobs.Items {
		if ref := metav1.GetControllerOf(&jobs.Items[i]); ref != nil && ref.UID == js.GetUID() {
			owners[jobs.Items[i].UID] = true
		}
	}
	return owners, nil
}

// jobSetNameLabel is the label JobSet puts on the Jobs it makes.
const jobSetNameLabel = "jobset.sigs.k8s.io/jobset-name"

// ownedByRayJob says whether a Job is a RayJob's submitter.
func ownedByRayJob(j *batchv1.Job) bool {
	for _, ref := range j.OwnerReferences {
		if ref.Kind == "RayJob" {
			return true
		}
	}
	return false
}
