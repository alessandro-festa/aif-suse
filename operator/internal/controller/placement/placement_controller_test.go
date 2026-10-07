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

package placement

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	corev1 "k8s.io/api/core/v1"
	apixv1 "k8s.io/apiextensions-apiserver/pkg/apis/apiextensions/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	clientgoscheme "k8s.io/client-go/kubernetes/scheme"
	ctrl "sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"

	"github.com/SUSE/aif-operator/api/v1alpha1"
)

var t0 = time.Date(2026, 10, 7, 12, 0, 0, 0, time.UTC)

func vision() *v1alpha1.AIProject {
	return &v1alpha1.AIProject{
		ObjectMeta: metav1.ObjectMeta{Name: "vision"},
		Spec: v1alpha1.AIProjectSpec{
			Clusters: []v1alpha1.AIProjectCluster{{ClusterID: "c-a", Namespace: "vision"}, {ClusterID: "c-b", Namespace: "vision-b"}},
			Owners:   []v1alpha1.AIProjectSubject{{Kind: "User", Name: "user-alice"}},
		},
	}
}

func ns(name, project string) *corev1.Namespace {
	n := &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: name}}
	if project != "" {
		n.Labels = map[string]string{"ai-factory.suse.com/aiproject": project}
	}
	return n
}

func gpuPool(name, cluster string, gpus int64) *v1alpha1.ComputePool {
	p := pool(name, "gpu", gpus, 0, "64", "L40S")
	p.Spec.ClusterID = cluster
	return p
}

func run(name, namespace string, minute int, values string) *v1alpha1.AIJob {
	j := &v1alpha1.AIJob{ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: namespace, CreationTimestamp: metav1.NewTime(t0.Add(time.Duration(minute) * time.Minute))}}
	if values != "" {
		j.Spec.Values = &apixv1.JSON{Raw: []byte(values)}
	}
	return j
}

func gpus(n int) string { return `{"job":{"gpusPerNode":` + string(rune('0'+n)) + `}}` }

type harness struct {
	t *testing.T
	c ctrl.Client
	r *Reconciler
}

func newHarness(t *testing.T, objs ...ctrl.Object) *harness {
	s := runtime.NewScheme()
	require.NoError(t, clientgoscheme.AddToScheme(s))
	require.NoError(t, v1alpha1.AddToScheme(s))
	c := fake.NewClientBuilder().WithScheme(s).WithStatusSubresource(&v1alpha1.AIJob{}).WithObjects(objs...).Build()
	return &harness{t: t, c: c, r: &Reconciler{Client: c}}
}

func (h *harness) pass() {
	h.t.Helper()
	res, err := h.r.Reconcile(context.Background(), reconcile.Request{NamespacedName: queue})
	require.NoError(h.t, err)
	require.Equal(h.t, DefaultResync, res.RequeueAfter)
}

func (h *harness) job(namespace, name string) *v1alpha1.AIJob {
	j := &v1alpha1.AIJob{}
	require.NoError(h.t, h.c.Get(context.Background(), types.NamespacedName{Namespace: namespace, Name: name}, j))
	return j
}

func TestWaitingRunsArePlacedInOrderAcrossTheProjectsClusters(t *testing.T) {
	h := newHarness(t, vision(), ns("aif-vision", "vision"),
		gpuPool("a-l40s", "c-a", 8), gpuPool("b-l40s", "c-b", 4), gpuPool("z-l40s", "c-z", 8),
		run("first", "aif-vision", 0, gpus(6)), run("second", "aif-vision", 1, gpus(4)), run("third", "aif-vision", 2, gpus(4)))
	h.pass()

	first := h.job("aif-vision", "first").Status.Placement
	require.NotNil(t, first)
	assert.Equal(t, v1alpha1.AIJobPlacement{Pool: "a-l40s", ClusterID: "c-a", Namespace: "vision"}, *first,
		"the pool with most free GPUs among the project's clusters, in the project's namespace there (c-z is not the project's)")
	second := h.job("aif-vision", "second").Status.Placement
	require.NotNil(t, second)
	assert.Equal(t, v1alpha1.AIJobPlacement{Pool: "b-l40s", ClusterID: "c-b", Namespace: "vision-b"}, *second,
		"a-l40s has 2 left after the first, so the second goes to c-b")
	third := h.job("aif-vision", "third")
	assert.Nil(t, third.Status.Placement, "nothing has 4 left: it waits")
	assert.Contains(t, third.Status.PlacementMessage, "a-l40s: 2 GPUs free, 4 needed")
	assert.Equal(t, "c-a/a-l40s", h.job("aif-vision", "first").Annotations[PlacedAnnotation], "the AIJob controller is woken")
}

func TestASmallRunIsNotHeldBehindABigOne(t *testing.T) {
	h := newHarness(t, vision(), ns("aif-vision", "vision"), gpuPool("a-l40s", "c-a", 4),
		run("big", "aif-vision", 0, `{"job":{"nodes":2,"gpusPerNode":4}}`), run("small", "aif-vision", 1, gpus(2)))
	h.pass()
	assert.Nil(t, h.job("aif-vision", "big").Status.Placement)
	assert.NotNil(t, h.job("aif-vision", "small").Status.Placement, "backfilled")
}

func TestAWaitingRunIsPlacedWhenAPoolFreesUp(t *testing.T) {
	busy := gpuPool("a-l40s", "c-a", 4)
	busy.Status.Requested.GPUs = 4
	h := newHarness(t, vision(), ns("aif-vision", "vision"), busy, run("train", "aif-vision", 0, gpus(2)))
	h.pass()
	assert.Nil(t, h.job("aif-vision", "train").Status.Placement)

	p := &v1alpha1.ComputePool{}
	require.NoError(t, h.c.Get(context.Background(), types.NamespacedName{Name: "a-l40s"}, p))
	p.Status.Requested.GPUs = 1
	require.NoError(t, h.c.Update(context.Background(), p))
	h.pass()
	j := h.job("aif-vision", "train")
	require.NotNil(t, j.Status.Placement)
	assert.Empty(t, j.Status.PlacementMessage)
}

func TestOnlyAIProjectRunsWithoutAPoolAreTheQueues(t *testing.T) {
	named := run("named", "aif-vision", 0, "")
	named.Spec.Pool = "a-l40s"
	done := run("done", "aif-vision", 0, "")
	done.Status.Phase = v1alpha1.AIJobPhaseSucceeded
	h := newHarness(t, vision(), ns("aif-vision", "vision"), ns("default", ""), gpuPool("a-l40s", "c-a", 8),
		named, done, run("admin", "default", 0, ""))
	h.pass()
	assert.Nil(t, h.job("aif-vision", "named").Status.Placement, "names its own pool: the AIJob controller places it")
	assert.Nil(t, h.job("aif-vision", "done").Status.Placement)
	assert.Nil(t, h.job("default", "admin").Status.Placement, "not in an AI project")
}
