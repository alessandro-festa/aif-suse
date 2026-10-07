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

// Package placement is AI Factory's meta-scheduler: it decides where a training
// run goes. A run in an AI project that names no compute pool waits in one queue
// across clusters until a pool of its project fits it; then it is placed, and
// the AIJob controller installs it there. The cluster's own scheduler (KAI,
// Kueue, Volcano, Run:AI) still decides when it starts.
package placement

import (
	"context"
	"fmt"
	"sort"
	"time"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	controllerruntime "sigs.k8s.io/controller-runtime"
	ctrl "sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/handler"
	"sigs.k8s.io/controller-runtime/pkg/log"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"

	"github.com/SUSE/aif-operator/api/v1alpha1"
	"github.com/SUSE/aif-operator/internal/controller/aiproject"
)

// DefaultResync is how often waiting runs are looked at again when nothing
// changed.
const DefaultResync = 30 * time.Second

// PlacedAnnotation is set on an AIJob when it is placed, so the AIJob
// controller (which reacts to annotation changes) picks it up at once.
const PlacedAnnotation = "ai-factory.suse.com/placed-in"

var queue = types.NamespacedName{Name: "queue"}

// +kubebuilder:rbac:groups=ai-factory.suse.com,resources=aijobs,verbs=get;list;watch;patch
// +kubebuilder:rbac:groups=ai-factory.suse.com,resources=aijobs/status,verbs=get;patch
// +kubebuilder:rbac:groups=ai-factory.suse.com,resources=computepools;aiprojects,verbs=get;list;watch
// +kubebuilder:rbac:groups="",resources=namespaces,verbs=get;list;watch

// Reconciler places every waiting run in one pass, in submission order, so an
// earlier run gets free capacity first; a run that does not fit does not hold
// back a smaller one behind it.
type Reconciler struct {
	ctrl.Client
	// Resync is how often the queue is looked at with nothing changed;
	// DefaultResync when zero.
	Resync time.Duration
}

func (r *Reconciler) Reconcile(ctx context.Context, _ reconcile.Request) (reconcile.Result, error) {
	resync := r.Resync
	if resync <= 0 {
		resync = DefaultResync
	}
	jobs := &v1alpha1.AIJobList{}
	if err := r.List(ctx, jobs); err != nil {
		return reconcile.Result{}, err
	}
	poolList := &v1alpha1.ComputePoolList{}
	if err := r.List(ctx, poolList); err != nil {
		return reconcile.Result{}, err
	}

	waiting, inflight := queueState(jobs.Items, poolList.Items)

	projects := map[string]*v1alpha1.AIProject{}
	for _, j := range waiting {
		project, err := r.projectOf(ctx, j.Namespace, projects)
		if err != nil {
			return reconcile.Result{}, err
		}
		if project == nil {
			continue // not in an AI project: runs where the AIJob controller puts it
		}
		n, err := needsOf(j)
		if err != nil {
			if err := r.say(ctx, j, "cannot read what it needs: "+err.Error()); err != nil {
				return reconcile.Result{}, err
			}
			continue
		}
		spans := map[string]string{}
		for _, c := range project.Spec.Clusters {
			spans[c.ClusterID] = c.Namespace
		}
		var candidates []*v1alpha1.ComputePool
		for i := range poolList.Items {
			if _, ok := spans[poolList.Items[i].Spec.ClusterID]; ok {
				candidates = append(candidates, &poolList.Items[i])
			}
		}
		pool, why := choose(n, candidates, inflight)
		if pool == nil {
			if err := r.say(ctx, j, why); err != nil {
				return reconcile.Result{}, err
			}
			continue
		}
		if err := r.place(ctx, j, pool, spans[pool.Spec.ClusterID]); err != nil {
			return reconcile.Result{}, err
		}
		inflight[pool.Name] = append(inflight[pool.Name], n)
	}
	return reconcile.Result{RequeueAfter: resync}, nil
}

// queueState is the runs waiting for a pool, in submission order, and what was
// placed in each pool that its figures do not show yet: runs that have not
// started, and runs that started after the pool's nodes were last read.
func queueState(jobs []v1alpha1.AIJob, pools []v1alpha1.ComputePool) ([]*v1alpha1.AIJob, map[string][]Needs) {
	observed := map[string]*metav1.Time{}
	for i := range pools {
		observed[pools[i].Name] = pools[i].Status.ObservedAt
	}
	inflight := map[string][]Needs{}
	var waiting []*v1alpha1.AIJob
	for i := range jobs {
		j := &jobs[i]
		if j.Status.Phase.IsTerminal() || j.Spec.Cancel || !j.DeletionTimestamp.IsZero() {
			continue
		}
		switch {
		case j.Status.Placement != nil:
			seen := observed[j.Status.Placement.Pool]
			unseen := j.Status.StartedAt == nil || seen == nil || !seen.After(j.Status.StartedAt.Time)
			if j.Status.Phase == "" || j.Status.Phase == v1alpha1.AIJobPhasePending || j.Status.Phase == v1alpha1.AIJobPhaseQueued || j.Status.Phase == v1alpha1.AIJobPhaseAdmitted ||
				(j.Status.Phase == v1alpha1.AIJobPhaseRunning && unseen) {
				if n, err := needsOf(j); err == nil {
					inflight[j.Status.Placement.Pool] = append(inflight[j.Status.Placement.Pool], n)
				}
			}
		case j.Spec.Pool == "":
			waiting = append(waiting, j)
		}
	}
	sort.SliceStable(waiting, func(a, b int) bool {
		ta, tb := waiting[a].CreationTimestamp, waiting[b].CreationTimestamp
		if !ta.Equal(&tb) {
			return ta.Before(&tb)
		}
		return waiting[a].Namespace+"/"+waiting[a].Name < waiting[b].Namespace+"/"+waiting[b].Name
	})
	return waiting, inflight
}

func needsOf(j *v1alpha1.AIJob) (Needs, error) {
	var raw []byte
	if j.Spec.Values != nil {
		raw = j.Spec.Values.Raw
	}
	return NeedsOf(raw)
}

// projectOf is the AIProject whose namespace on local this is, or nil.
func (r *Reconciler) projectOf(ctx context.Context, namespace string, cache map[string]*v1alpha1.AIProject) (*v1alpha1.AIProject, error) {
	if p, ok := cache[namespace]; ok {
		return p, nil
	}
	ns := &corev1.Namespace{}
	if err := r.Get(ctx, types.NamespacedName{Name: namespace}, ns); err != nil {
		return nil, ctrl.IgnoreNotFound(err)
	}
	name := ns.Labels[aiproject.ProjectLabel]
	var project *v1alpha1.AIProject
	if name != "" {
		project = &v1alpha1.AIProject{}
		if err := r.Get(ctx, types.NamespacedName{Name: name}, project); err != nil {
			if !apierrors.IsNotFound(err) {
				return nil, err
			}
			project = nil
		}
	}
	cache[namespace] = project
	return project, nil
}

// place records where the run goes; the AIJob controller installs it there.
func (r *Reconciler) place(ctx context.Context, j *v1alpha1.AIJob, pool *v1alpha1.ComputePool, namespace string) error {
	before := j.DeepCopy()
	j.Status.Placement = &v1alpha1.AIJobPlacement{Pool: pool.Name, ClusterID: pool.Spec.ClusterID, Namespace: namespace}
	j.Status.PlacementMessage = ""
	if err := r.Status().Patch(ctx, j, ctrl.MergeFrom(before)); err != nil {
		return err
	}
	log.FromContext(ctx).Info("Placed training run", "aijob", j.Namespace+"/"+j.Name, "pool", pool.Name, "cluster", pool.Spec.ClusterID, "namespace", namespace)
	before = j.DeepCopy()
	if j.Annotations == nil {
		j.Annotations = map[string]string{}
	}
	j.Annotations[PlacedAnnotation] = fmt.Sprintf("%s/%s", pool.Spec.ClusterID, pool.Name)
	return r.Patch(ctx, j, ctrl.MergeFrom(before))
}

// say records why a run is still waiting, when that changed.
func (r *Reconciler) say(ctx context.Context, j *v1alpha1.AIJob, why string) error {
	if j.Status.PlacementMessage == why {
		return nil
	}
	before := j.DeepCopy()
	j.Status.PlacementMessage = why
	return r.Status().Patch(ctx, j, ctrl.MergeFrom(before))
}

// SetupWithManager looks at the queue when any AIJob or compute pool changes,
// and every Resync.
func (r *Reconciler) SetupWithManager(mgr controllerruntime.Manager) error {
	toQueue := handler.EnqueueRequestsFromMapFunc(func(context.Context, ctrl.Object) []reconcile.Request {
		return []reconcile.Request{{NamespacedName: queue}}
	})
	return controllerruntime.NewControllerManagedBy(mgr).
		Named("placement").
		Watches(&v1alpha1.AIJob{}, toQueue).
		Watches(&v1alpha1.ComputePool{}, toQueue).
		Complete(r)
}
