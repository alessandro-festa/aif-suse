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

package computepool

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	ctrl "sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"
	"sigs.k8s.io/controller-runtime/pkg/event"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"

	"github.com/SUSE/aif-operator/api/v1alpha1"
	"github.com/SUSE/aif-operator/internal/infra/rancher"
)

var t0 = time.Date(2026, 10, 7, 12, 0, 0, 0, time.UTC)

// fakeCluster is one cluster as the reconciler reads it.
type fakeCluster struct {
	nodes  []corev1.Node
	pods   []corev1.Pod
	groups []string
}

func (f *fakeCluster) Nodes(context.Context) ([]corev1.Node, error) { return f.nodes, nil }
func (f *fakeCluster) Pods(context.Context) ([]corev1.Pod, error)   { return f.pods, nil }
func (f *fakeCluster) APIGroups(context.Context) ([]string, error)  { return f.groups, nil }

type fakeAccess struct {
	clusters map[string]*fakeCluster
	err      error
}

func (a *fakeAccess) For(_ context.Context, id string) (ClusterReader, error) {
	if a.err != nil {
		return nil, a.err
	}
	c, ok := a.clusters[id]
	if !ok {
		return nil, errors.New("no route to " + id)
	}
	return c, nil
}

func rancherCluster(id, name string) *unstructured.Unstructured {
	c := &unstructured.Unstructured{}
	c.SetGroupVersionKind(clusterGVK)
	c.SetName(id)
	c.SetUID(types.UID("uid-" + id))
	_ = unstructured.SetNestedField(c.Object, name, "spec", "displayName")
	return c
}

type harness struct {
	t      *testing.T
	c      ctrl.Client
	r      *Reconciler
	access *fakeAccess
}

func newHarness(t *testing.T, access *fakeAccess, objs ...ctrl.Object) *harness {
	s := runtime.NewScheme()
	require.NoError(t, v1alpha1.AddToScheme(s))
	s.AddKnownTypeWithName(clusterGVK, &unstructured.Unstructured{})
	s.AddKnownTypeWithName(clusterGVK.GroupVersion().WithKind("ClusterList"), &unstructured.UnstructuredList{})
	c := fake.NewClientBuilder().WithScheme(s).WithStatusSubresource(&v1alpha1.ComputePool{}).WithObjects(objs...).Build()
	return &harness{t: t, c: c, access: access, r: &Reconciler{Client: c, Scheme: s, Access: access, Now: func() time.Time { return t0 }}}
}

func (h *harness) reconcile(id string) reconcile.Result {
	h.t.Helper()
	res, err := h.r.Reconcile(context.Background(), reconcile.Request{NamespacedName: types.NamespacedName{Name: id}})
	require.NoError(h.t, err)
	return res
}

func (h *harness) pool(name string) *v1alpha1.ComputePool {
	h.t.Helper()
	p := &v1alpha1.ComputePool{}
	require.NoError(h.t, h.c.Get(context.Background(), types.NamespacedName{Name: name}, p))
	return p
}

func (h *harness) pools() []v1alpha1.ComputePool {
	l := &v1alpha1.ComputePoolList{}
	require.NoError(h.t, h.c.List(context.Background(), l))
	return l.Items
}

func TestDiscoveryCreatesAPoolPerGPUModelAndOneForCPUAndFillsTheirStatus(t *testing.T) {
	access := &fakeAccess{clusters: map[string]*fakeCluster{"c-abc": {
		nodes:  []corev1.Node{h100("g1"), cpuNode("c1")},
		pods:   []corev1.Pod{pod("g1", corev1.PodRunning, "4", "16Gi", 2)},
		groups: []string{"scheduling.run.ai", "kubeflow.org"},
	}}}
	h := newHarness(t, access, rancherCluster("c-abc", "prod"))

	res := h.reconcile("c-abc")
	assert.Equal(t, DefaultResync, res.RequeueAfter)
	require.Len(t, h.pools(), 2)

	gpu := h.pool("c-abc-gpu-nvidia-h100-80gb-hbm3")
	assert.Equal(t, "c-abc", gpu.Labels[v1alpha1.ComputePoolClusterLabel])
	assert.Equal(t, "true", gpu.Labels[v1alpha1.ComputePoolDiscoveredLabel])
	require.Len(t, gpu.OwnerReferences, 1, "owned by the Rancher cluster, so it goes with it")
	assert.Equal(t, "Cluster", gpu.OwnerReferences[0].Kind)
	assert.Equal(t, types.UID("uid-c-abc"), gpu.OwnerReferences[0].UID)
	assert.Equal(t, int64(8), gpu.Status.Allocatable.GPUs)
	assert.Equal(t, int64(2), gpu.Status.Requested.GPUs)
	assert.Equal(t, []string{"kai"}, gpu.Status.Schedulers)
	assert.Equal(t, []string{"training-operator"}, gpu.Status.Training)
	assert.True(t, meta.IsStatusConditionTrue(gpu.Status.Conditions, v1alpha1.ComputePoolConditionConnected))
	require.NotNil(t, gpu.Status.ObservedAt)
	assert.True(t, gpu.Status.ObservedAt.Time.Equal(t0))

	cpu := h.pool("c-abc-cpu")
	assert.Equal(t, int32(1), cpu.Status.Nodes)
	assert.Equal(t, v1alpha1.ComputePoolKindCPU, cpu.Spec.Kind)
}

func TestAnAdministratorsEditsAndOwnPoolsAreKept(t *testing.T) {
	access := &fakeAccess{clusters: map[string]*fakeCluster{"c-ops": {nodes: []corev1.Node{cpuNode("c1"), cpuNode("c2")}}}}
	h := newHarness(t, access, rancherCluster("c-ops", "ops"))
	h.reconcile("c-ops")

	// The admin disables the discovered pool and adds one of their own for a single node.
	p := h.pool("c-ops-cpu")
	p.Spec.Disabled = true
	p.Spec.DisplayName = "keep out"
	require.NoError(t, h.c.Update(context.Background(), p))
	mine := &v1alpha1.ComputePool{
		ObjectMeta: metav1.ObjectMeta{Name: "big-cpu", Labels: map[string]string{v1alpha1.ComputePoolClusterLabel: "c-ops"}},
		Spec: v1alpha1.ComputePoolSpec{
			ClusterID: "c-ops", Kind: v1alpha1.ComputePoolKindCPU,
			NodeSelector: &metav1.LabelSelector{MatchLabels: map[string]string{"kubernetes.io/hostname": "c2"}},
		},
	}
	require.NoError(t, h.c.Create(context.Background(), mine))
	access.clusters["c-ops"].nodes[1].Labels = map[string]string{"kubernetes.io/hostname": "c2"}

	h.reconcile("c-ops")
	p = h.pool("c-ops-cpu")
	assert.True(t, p.Spec.Disabled, "discovery never rewrites a pool's spec")
	assert.Equal(t, "keep out", p.Spec.DisplayName)
	assert.Equal(t, int32(2), p.Status.Nodes, "a disabled pool is still refreshed")
	got := h.pool("big-cpu")
	assert.Equal(t, int32(1), got.Status.Nodes, "an administrator's pool gets a status too")
	assert.Len(t, h.pools(), 2, "and discovery does not add a pool for nodes it already covers by name")
}

func TestWithoutARancherTokenPoolsSayWhyAndKeepTheirLastFigures(t *testing.T) {
	access := &fakeAccess{clusters: map[string]*fakeCluster{"c-abc": {nodes: []corev1.Node{h100("g1")}}}}
	h := newHarness(t, access, rancherCluster("c-abc", "prod"))
	h.reconcile("c-abc")

	access.err = rancher.ErrNoConnection
	res := h.reconcile("c-abc")
	assert.Equal(t, DefaultResync, res.RequeueAfter, "tried again later")
	p := h.pool("c-abc-gpu-nvidia-h100-80gb-hbm3")
	c := meta.FindStatusCondition(p.Status.Conditions, v1alpha1.ComputePoolConditionConnected)
	require.NotNil(t, c)
	assert.Equal(t, metav1.ConditionFalse, c.Status)
	assert.Equal(t, "NoRancherToken", c.Reason)
	assert.Equal(t, int64(8), p.Status.Allocatable.GPUs, "last good figures kept")

	access.err = errors.New("dial tcp: connection refused")
	h.reconcile("c-abc")
	assert.Equal(t, "Unreachable", meta.FindStatusCondition(h.pool("c-abc-gpu-nvidia-h100-80gb-hbm3").Status.Conditions, v1alpha1.ComputePoolConditionConnected).Reason)
}

func TestAClusterThatCannotBeReadYetGetsNoPools(t *testing.T) {
	h := newHarness(t, &fakeAccess{err: rancher.ErrNoConnection}, rancherCluster("c-new", "new"))
	h.reconcile("c-new")
	assert.Empty(t, h.pools(), "nothing to discover from without reading the nodes")
}

func TestRanchersLocalClusterHasNoPools(t *testing.T) {
	access := &fakeAccess{clusters: map[string]*fakeCluster{"local": {nodes: []corev1.Node{cpuNode("c1")}}}}
	h := newHarness(t, access, rancherCluster("local", "local"))
	assert.Equal(t, reconcile.Result{}, h.reconcile("local"), "not even refreshed later")
	assert.Empty(t, h.pools())
	assert.False(t, notLocal.Create(event.CreateEvent{Object: rancherCluster("local", "local")}), "its events are not even queued")
	assert.True(t, notLocal.Create(event.CreateEvent{Object: rancherCluster("c-abc", "prod")}))
}

func TestARemovedClusterIsNotAnError(t *testing.T) {
	h := newHarness(t, &fakeAccess{})
	assert.Equal(t, reconcile.Result{}, h.reconcile("c-gone"))
}

// Right after the operator starts, controllers run before Settings is read: that is not "no token",
// and must not mark every downstream pool unreachable (placement would avoid them).
func TestPoolsKeepTheirFiguresWhileTheRancherConnectionIsNotKnownYet(t *testing.T) {
	access := &fakeAccess{clusters: map[string]*fakeCluster{"c-abc": {nodes: []corev1.Node{h100("g1")}}}}
	h := newHarness(t, access, rancherCluster("c-abc", "prod"))
	h.reconcile("c-abc")

	access.err = rancher.ErrConnectionPending
	res := h.reconcile("c-abc")
	assert.Equal(t, pendingRetry, res.RequeueAfter, "tried again soon")
	p := h.pool("c-abc-gpu-nvidia-h100-80gb-hbm3")
	assert.True(t, meta.IsStatusConditionTrue(p.Status.Conditions, v1alpha1.ComputePoolConditionConnected), "still connected")
}
