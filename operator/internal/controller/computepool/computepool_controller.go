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

// Package computepool discovers the compute pools of every downstream cluster
// Rancher manages (never "local", Rancher's own cluster): one ComputePool per
// GPU model and one for the CPU-only nodes, each
// kept up to date with what its nodes have, what is requested of them, and the
// scheduling stack the cluster runs.
package computepool

import (
	"context"
	"errors"
	"time"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"
	controllerruntime "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/builder"
	ctrl "sigs.k8s.io/controller-runtime/pkg/client"
	"k8s.io/client-go/util/workqueue"
	"sigs.k8s.io/controller-runtime/pkg/event"
	"sigs.k8s.io/controller-runtime/pkg/handler"
	"sigs.k8s.io/controller-runtime/pkg/log"
	"sigs.k8s.io/controller-runtime/pkg/predicate"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"

	"github.com/SUSE/aif-operator/api/v1alpha1"
	"github.com/SUSE/aif-operator/internal/infra/rancher"
	"github.com/SUSE/aif-operator/internal/trainchart"
)

// DefaultResync is how often a cluster's pools are refreshed.
const DefaultResync = time.Minute

// pendingRetry is how soon a cluster is tried again while the Rancher
// connection is not known yet (the operator just started).
const pendingRetry = 5 * time.Second

var clusterGVK = schema.GroupVersionKind{Group: "management.cattle.io", Version: "v3", Kind: "Cluster"}

// +kubebuilder:rbac:groups=ai-factory.suse.com,resources=computepools,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=ai-factory.suse.com,resources=computepools/status,verbs=get;update;patch
// +kubebuilder:rbac:groups=management.cattle.io,resources=clusters,verbs=get;list;watch

// Reconciler reconciles one Rancher cluster at a time: it creates the pools
// the cluster's nodes call for and refreshes the status of all its pools.
type Reconciler struct {
	ctrl.Client
	Scheme *runtime.Scheme
	Access Access
	// Resync is how often pools are refreshed; DefaultResync when zero.
	Resync time.Duration
	// Now is the clock; time.Now when nil.
	Now func() time.Time
}

func (r *Reconciler) resync() time.Duration {
	if r.Resync > 0 {
		return r.Resync
	}
	return DefaultResync
}

func (r *Reconciler) now() metav1.Time {
	if r.Now != nil {
		return metav1.NewTime(r.Now())
	}
	return metav1.Now()
}

// Reconcile is keyed by the Rancher cluster ID.
func (r *Reconciler) Reconcile(ctx context.Context, req reconcile.Request) (reconcile.Result, error) {
	id := req.Name
	if id == rancher.LocalClusterID {
		return reconcile.Result{}, nil // Rancher's own cluster runs no AI work
	}
	cluster := &unstructured.Unstructured{}
	cluster.SetGroupVersionKind(clusterGVK)
	if err := r.Get(ctx, types.NamespacedName{Name: id}, cluster); err != nil {
		// A removed cluster's pools go with it: they are owned by the cluster object.
		return reconcile.Result{}, ctrl.IgnoreNotFound(err)
	}

	pools, err := r.poolsOf(ctx, id)
	if err != nil {
		return reconcile.Result{}, err
	}

	reader, err := r.Access.For(ctx, id)
	if errors.Is(err, rancher.ErrConnectionPending) {
		return reconcile.Result{RequeueAfter: pendingRetry}, nil // the pools keep their last figures
	}
	if err != nil {
		return r.disconnected(ctx, pools, err)
	}
	nodes, err := reader.Nodes(ctx)
	if err != nil {
		return r.disconnected(ctx, pools, err)
	}
	pods, err := reader.Pods(ctx)
	if err != nil {
		return r.disconnected(ctx, pools, err)
	}
	groups, err := reader.APIGroups(ctx)
	if err != nil {
		return r.disconnected(ctx, pools, err)
	}

	name, _, _ := unstructured.NestedString(cluster.Object, "spec", "displayName")
	if name == "" {
		name = id
	}
	created, err := r.ensurePools(ctx, cluster, discoverPools(id, name, nodes), pools)
	if err != nil {
		return reconcile.Result{}, err
	}
	pools = append(pools, created...)

	backends, err := trainchart.Backends()
	if err != nil {
		return reconcile.Result{}, err
	}
	st := detectStack(groups, nodes, backends)
	usage := readUsage(ctx, reader, nodes)
	now := r.now()
	for i := range pools {
		p := &pools[i]
		status, err := poolStatus(p.Spec, nodes, pods, st, usage)
		if err != nil {
			status = v1alpha1.ComputePoolStatus{}
			r.setConnected(&status, p, metav1.ConditionFalse, "InvalidSelector", err.Error(), now)
		} else {
			r.setConnected(&status, p, metav1.ConditionTrue, "Read", "Nodes, pods and API groups read from the cluster", now)
		}
		status.ObservedAt = &now
		if err := r.writeStatus(ctx, p, status); err != nil {
			return reconcile.Result{}, err
		}
	}
	return reconcile.Result{RequeueAfter: r.resync()}, nil
}

func (r *Reconciler) poolsOf(ctx context.Context, id string) ([]v1alpha1.ComputePool, error) {
	l := &v1alpha1.ComputePoolList{}
	if err := r.List(ctx, l, ctrl.MatchingLabels{v1alpha1.ComputePoolClusterLabel: id}); err != nil {
		return nil, err
	}
	return l.Items, nil
}

// ensurePools creates the discovered pools that do not exist yet. An existing
// pool of the same name is left alone, spec and all: an administrator may have
// edited or disabled it.
func (r *Reconciler) ensurePools(ctx context.Context, cluster *unstructured.Unstructured, want []desiredPool, have []v1alpha1.ComputePool) ([]v1alpha1.ComputePool, error) {
	exists := map[string]bool{}
	for _, p := range have {
		exists[p.Name] = true
	}
	var created []v1alpha1.ComputePool
	for _, d := range want {
		if exists[d.Name] {
			continue
		}
		p := v1alpha1.ComputePool{
			ObjectMeta: metav1.ObjectMeta{
				Name: d.Name,
				Labels: map[string]string{
					v1alpha1.ComputePoolClusterLabel:    d.Spec.ClusterID,
					v1alpha1.ComputePoolDiscoveredLabel: "true",
				},
				OwnerReferences: []metav1.OwnerReference{{
					APIVersion: clusterGVK.GroupVersion().String(),
					Kind:       clusterGVK.Kind,
					Name:       cluster.GetName(),
					UID:        cluster.GetUID(),
				}},
			},
			Spec: d.Spec,
		}
		if err := r.Create(ctx, &p); err != nil {
			if apierrors.IsAlreadyExists(err) {
				continue // an unlabelled pool of that name: not ours to touch
			}
			return nil, err
		}
		log.FromContext(ctx).Info("Discovered compute pool", "pool", p.Name, "cluster", d.Spec.ClusterID, "kind", d.Spec.Kind)
		created = append(created, p)
	}
	return created, nil
}

// disconnected records on every pool of the cluster that it could not be read,
// and tries again at the next resync. The last good figures are kept.
func (r *Reconciler) disconnected(ctx context.Context, pools []v1alpha1.ComputePool, cause error) (reconcile.Result, error) {
	reason := "Unreachable"
	if errors.Is(cause, rancher.ErrNoConnection) {
		reason = "NoRancherToken"
	}
	// A cluster with no pool yet has nowhere else to say why it is not discovered.
	log.FromContext(ctx).Info("Cannot read cluster for compute pools", "reason", reason, "error", cause.Error(), "pools", len(pools))
	now := r.now()
	for i := range pools {
		p := &pools[i]
		status := *p.Status.DeepCopy()
		r.setConnected(&status, p, metav1.ConditionFalse, reason, cause.Error(), now)
		if err := r.writeStatus(ctx, p, status); err != nil {
			return reconcile.Result{}, err
		}
	}
	return reconcile.Result{RequeueAfter: r.resync()}, nil
}

func (r *Reconciler) setConnected(status *v1alpha1.ComputePoolStatus, p *v1alpha1.ComputePool, s metav1.ConditionStatus, reason, msg string, now metav1.Time) {
	status.Conditions = append([]metav1.Condition(nil), p.Status.Conditions...)
	meta.SetStatusCondition(&status.Conditions, metav1.Condition{
		Type: v1alpha1.ComputePoolConditionConnected, Status: s, Reason: reason, Message: msg,
		ObservedGeneration: p.Generation, LastTransitionTime: now,
	})
}

// writeStatus records the refresh. It writes every time, so observedAt says
// when the pool was last read; status writes do not trigger a reconcile.
func (r *Reconciler) writeStatus(ctx context.Context, p *v1alpha1.ComputePool, status v1alpha1.ComputePoolStatus) error {
	p.Status = status
	return r.Status().Update(ctx, p)
}

// notLocal leaves out Rancher's own cluster: it hosts Rancher and AI Factory,
// not AI work, so it has no compute pools.
var notLocal = predicate.NewPredicateFuncs(func(o ctrl.Object) bool { return o.GetName() != rancher.LocalClusterID })

// SetupWithManager reconciles on cluster creation and deletion, on pool
// creation and spec changes (so an administrator's new pool gets a status at
// once), and every Resync. Status updates do not trigger a reconcile.
// runSettleDelay is how long after a run's change its cluster is read a second
// time: long enough for an uninstalled run's pods to have gone.
const runSettleDelay = 10 * time.Second

func (r *Reconciler) SetupWithManager(mgr controllerruntime.Manager) error {
	cluster := &unstructured.Unstructured{}
	cluster.SetGroupVersionKind(clusterGVK)
	toCluster := handler.EnqueueRequestsFromMapFunc(func(_ context.Context, o ctrl.Object) []reconcile.Request {
		p, ok := o.(*v1alpha1.ComputePool)
		if !ok || p.Spec.ClusterID == "" || p.Spec.ClusterID == rancher.LocalClusterID {
			return nil
		}
		return []reconcile.Request{{NamespacedName: types.NamespacedName{Name: p.Spec.ClusterID}}}
	})
	// A run placed on a cluster that is deleted, or changes phase, changes what its pools hold:
	// read the cluster again now, and once more shortly after, when its pods have gone.
	clusterOf := func(o ctrl.Object) (reconcile.Request, bool) {
		j, ok := o.(*v1alpha1.AIJob)
		if !ok || j.Status.Placement == nil || j.Status.Placement.ClusterID == "" || j.Status.Placement.ClusterID == rancher.LocalClusterID {
			return reconcile.Request{}, false
		}
		return reconcile.Request{NamespacedName: types.NamespacedName{Name: j.Status.Placement.ClusterID}}, true
	}
	readTwice := func(q workqueue.TypedRateLimitingInterface[reconcile.Request], o ctrl.Object) {
		if req, ok := clusterOf(o); ok {
			q.Add(req)
			q.AddAfter(req, runSettleDelay)
		}
	}
	runCluster := handler.TypedFuncs[ctrl.Object, reconcile.Request]{
		UpdateFunc: func(_ context.Context, e event.UpdateEvent, q workqueue.TypedRateLimitingInterface[reconcile.Request]) {
			readTwice(q, e.ObjectNew)
		},
		DeleteFunc: func(_ context.Context, e event.DeleteEvent, q workqueue.TypedRateLimitingInterface[reconcile.Request]) {
			readTwice(q, e.Object)
		},
	}
	runMoved := predicate.Funcs{
		CreateFunc:  func(event.CreateEvent) bool { return false },
		DeleteFunc:  func(event.DeleteEvent) bool { return true },
		GenericFunc: func(event.GenericEvent) bool { return false },
		UpdateFunc: func(e event.UpdateEvent) bool {
			o, ok1 := e.ObjectOld.(*v1alpha1.AIJob)
			n, ok2 := e.ObjectNew.(*v1alpha1.AIJob)
			return ok1 && ok2 && (o.Status.Phase != n.Status.Phase || o.DeletionTimestamp.IsZero() != n.DeletionTimestamp.IsZero())
		},
	}
	return controllerruntime.NewControllerManagedBy(mgr).
		Named("computepool").
		For(cluster, builder.WithPredicates(predicate.GenerationChangedPredicate{}, notLocal)).
		Watches(&v1alpha1.ComputePool{}, toCluster, builder.WithPredicates(predicate.GenerationChangedPredicate{})).
		Watches(&v1alpha1.AIJob{}, runCluster, builder.WithPredicates(runMoved)).
		Complete(r)
}
