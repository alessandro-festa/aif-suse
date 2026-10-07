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
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	"github.com/SUSE/aif-operator/api/v1alpha1"
	helmClient "github.com/SUSE/aif-operator/internal/infra/helm"
	"github.com/SUSE/aif-operator/internal/infra/rancher"
)

const downstream = "c-abc"

func l40sPool(mutate ...func(*v1alpha1.ComputePool)) *v1alpha1.ComputePool {
	p := &v1alpha1.ComputePool{
		ObjectMeta: metav1.ObjectMeta{Name: "c-abc-gpu-l40s"},
		Spec: v1alpha1.ComputePoolSpec{
			ClusterID: downstream, Kind: v1alpha1.ComputePoolKindGPU,
			NodeSelector: &metav1.LabelSelector{MatchLabels: map[string]string{"nvidia.com/gpu.product": "L40S"}},
		},
	}
	for _, m := range mutate {
		m(p)
	}
	return p
}

func inPool(j *v1alpha1.AIJob) {
	j.Spec.Source = nil
	j.Spec.Pool = "c-abc-gpu-l40s"
	j.Spec.TargetNamespace = "team-a"
}

// poolHarness is a harness whose Rancher reaches one downstream cluster,
// with its own API objects, and records which cluster each Helm client was for.
type poolHarness struct {
	*harness
	remote     client.Client
	helmCalls  [][2]string
	connection *rancher.ConnectionHolder
}

func newPoolHarness(t *testing.T, objs ...client.Object) *poolHarness {
	h := &poolHarness{harness: newHarness(t, objs...), connection: rancher.NewConnectionHolder()}
	h.connection.Set(&rancher.Connection{URL: "https://rancher", Token: "t"})
	h.remote = fake.NewClientBuilder().WithScheme(h.c.Scheme()).Build()
	h.r.Connection = h.connection
	h.r.HelmFor = func(cluster, namespace string) (helmClient.HelmClient, error) {
		h.helmCalls = append(h.helmCalls, [2]string{cluster, namespace})
		return h.helm, nil
	}
	h.r.RemoteFor = func(cluster string) (client.Reader, PodLogReader, error) {
		return h.remote, nil, nil
	}
	return h
}

func (h *poolHarness) installedCondition(name string) *metav1.Condition {
	return meta.FindStatusCondition(h.get(name).Status.Conditions, v1alpha1.AIJobConditionInstalled)
}

func TestAJobInAPoolIsInstalledOnThePoolsClusterAndKeptToItsNodes(t *testing.T) {
	h := newPoolHarness(t, aijob("train-1", inPool), l40sPool())
	h.reconcile("train-1")

	require.Len(t, h.helm.ensured, 1)
	spec := h.helm.ensured[0]
	assert.Equal(t, "team-a", spec.Namespace, "the target namespace, not the AIJob's own")
	assert.Equal(t, map[string]interface{}{"matchLabels": map[string]interface{}{"nvidia.com/gpu.product": "L40S"}}, spec.Values["poolSelector"])
	assert.Contains(t, h.helmCalls, [2]string{downstream, "team-a"}, "a Helm client for the downstream cluster")

	j := h.get("train-1")
	require.NotNil(t, j.Status.Placement)
	assert.Equal(t, v1alpha1.AIJobPlacement{Pool: "c-abc-gpu-l40s", ClusterID: downstream, Namespace: "team-a"}, *j.Status.Placement)
}

func TestAPlacedJobIsObservedOnItsCluster(t *testing.T) {
	h := newPoolHarness(t, aijob("train-1", inPool), l40sPool())
	h.reconcile("train-1")

	exec := &batchv1.Job{ObjectMeta: metav1.ObjectMeta{Name: "train-1", Namespace: "team-a"}}
	exec.Status.Conditions = []batchv1.JobCondition{{Type: batchv1.JobComplete, Status: corev1.ConditionTrue}}
	require.NoError(t, h.remote.Create(context.Background(), exec))
	h.reconcile("train-1")

	j := h.get("train-1")
	assert.Equal(t, "Job", j.Status.Execution.Kind, "read from the downstream cluster")
	assert.Equal(t, v1alpha1.AIJobPhaseSucceeded, j.Status.Phase)
}

func TestAJobWaitsWhileItsPoolCannotBeUsed(t *testing.T) {
	cases := []struct {
		name   string
		pool   *v1alpha1.ComputePool
		noConn bool
		reason string
	}{
		{"pool missing", nil, false, "PoolNotFound"},
		{"pool disabled", l40sPool(func(p *v1alpha1.ComputePool) { p.Spec.Disabled = true }), false, "PoolDisabled"},
		{"no Rancher token", l40sPool(), true, "NoRancherToken"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			objs := []client.Object{aijob("train-1", inPool)}
			if c.pool != nil {
				objs = append(objs, c.pool)
			}
			h := newPoolHarness(t, objs...)
			if c.noConn {
				h.connection.Set(nil)
			}
			res := h.reconcile("train-1")
			assert.Equal(t, waitingRequeue, res.RequeueAfter, "tried again")
			assert.Empty(t, h.helm.ensured, "nothing installed")
			assert.Equal(t, v1alpha1.AIJobPhasePending, h.get("train-1").Status.Phase)
			cond := h.installedCondition("train-1")
			require.NotNil(t, cond)
			assert.Equal(t, c.reason, cond.Reason)
		})
	}
}

func TestAPlacedJobIsCleanedUpWhereItRanAfterItsPoolIsGone(t *testing.T) {
	h := newPoolHarness(t, aijob("train-1", inPool), l40sPool())
	h.reconcile("train-1")
	require.NoError(t, h.c.Delete(context.Background(), l40sPool()))

	require.NoError(t, h.c.Delete(context.Background(), h.get("train-1")))
	h.reconcile("train-1")
	assert.Equal(t, []string{"train-1"}, h.helm.deleted, "uninstalled")
	assert.Equal(t, [][2]string{{downstream, "team-a"}}, h.helmCalls, "only ever on the cluster in its placement, never locally")
	err := h.c.Get(context.Background(), types.NamespacedName{Namespace: ns, Name: "train-1"}, &v1alpha1.AIJob{})
	assert.True(t, client.IgnoreNotFound(err) == nil && err != nil, "and the record goes")
}

func TestAJobNeverPlacedIsDeletedWithoutReachingAnyCluster(t *testing.T) {
	h := newPoolHarness(t, aijob("train-1", inPool))
	h.reconcile("train-1") // waits: no such pool
	require.NoError(t, h.c.Delete(context.Background(), h.get("train-1")))
	h.reconcile("train-1")
	assert.Empty(t, h.helm.deleted)
	err := h.c.Get(context.Background(), types.NamespacedName{Namespace: ns, Name: "train-1"}, &v1alpha1.AIJob{})
	assert.True(t, client.IgnoreNotFound(err) == nil && err != nil)
}

// projectNS makes the job's own namespace on local the namespace of AI project
// c-abc:p-team, as internal/controller/aiproject labels it.
func projectNS() *corev1.Namespace {
	n := &corev1.Namespace{}
	n.Name = ns
	n.Labels = map[string]string{"ai-factory.suse.com/cluster": downstream, "ai-factory.suse.com/project": "p-team"}
	return n
}

func downstreamNS(name, project string) *corev1.Namespace {
	n := &corev1.Namespace{}
	n.Name = name
	if project != "" {
		n.Annotations = map[string]string{rancherProjectAnnotation: project}
	}
	return n
}

func TestAProjectsJobRunsOnlyInsideTheProject(t *testing.T) {
	otherCluster := l40sPool(func(p *v1alpha1.ComputePool) { p.Name, p.Spec.ClusterID = "c-xyz-gpu", "c-xyz" })
	cases := []struct {
		name     string
		pool     string
		targetNS *corev1.Namespace
		phase    v1alpha1.AIJobPhase
		reason   string
		install  bool
	}{
		{"its own namespace on its own cluster", "c-abc-gpu-l40s", downstreamNS("team-a", "c-abc:p-team"), v1alpha1.AIJobPhasePending, "", true},
		{"another project's namespace", "c-abc-gpu-l40s", downstreamNS("team-a", "c-abc:p-other"), v1alpha1.AIJobPhaseFailed, "NotInProject", false},
		{"a namespace in no project", "c-abc-gpu-l40s", downstreamNS("team-a", ""), v1alpha1.AIJobPhaseFailed, "NotInProject", false},
		{"a pool on another cluster", "c-xyz-gpu", downstreamNS("team-a", "c-abc:p-team"), v1alpha1.AIJobPhaseFailed, "NotInProject", false},
		{"a namespace that does not exist yet", "c-abc-gpu-l40s", nil, v1alpha1.AIJobPhasePending, "TargetNamespaceNotFound", false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			h := newPoolHarness(t, aijob("train-1", inPool, func(j *v1alpha1.AIJob) { j.Spec.Pool = c.pool }), l40sPool(), otherCluster, projectNS())
			if c.targetNS != nil {
				require.NoError(t, h.remote.Create(context.Background(), c.targetNS))
			}
			h.reconcile("train-1")
			j := h.get("train-1")
			assert.Equal(t, c.install, len(h.helm.ensured) == 1, "installed?")
			if !c.install {
				assert.Nil(t, j.Status.Placement)
				cond := h.installedCondition("train-1")
				require.NotNil(t, cond)
				assert.Equal(t, c.reason, cond.Reason)
				assert.Equal(t, c.phase, j.Status.Phase)
			}
		})
	}
}

func TestAJobOutsideAnyProjectIsNotRestricted(t *testing.T) {
	// The job's namespace on local is not an AI project's: whoever could create it there is an
	// administrator, and the target namespace's project is not checked.
	h := newPoolHarness(t, aijob("train-1", inPool), l40sPool())
	require.NoError(t, h.remote.Create(context.Background(), downstreamNS("team-a", "c-abc:p-anything")))
	h.reconcile("train-1")
	assert.Len(t, h.helm.ensured, 1)
}
