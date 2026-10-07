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
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	"github.com/SUSE/aif-operator/api/v1alpha1"
)

// placedRun is a project run the placement controller put in the L40S pool, installed there.
func placedRun(t *testing.T, mutate ...func(*v1alpha1.AIJob)) *poolHarness {
	h := newPoolHarness(t, aijob("train-1", append([]func(*v1alpha1.AIJob){func(j *v1alpha1.AIJob) { j.Spec.Source = nil }}, mutate...)...), l40sPool(), projectNS(), teamProject())
	require.NoError(t, h.remote.Create(context.Background(), downstreamNS("team-a")))
	j := h.get("train-1")
	j.Status.Placement = &v1alpha1.AIJobPlacement{Pool: "c-abc-gpu-l40s", ClusterID: downstream, Namespace: "team-a"}
	require.NoError(t, h.c.Status().Update(context.Background(), j))
	h.reconcile("train-1")
	require.Len(t, h.helm.ensured, 1)
	return h
}

// askReclaim is what the placement controller does for an idle run.
func askReclaim(t *testing.T, h *poolHarness, policy v1alpha1.AIJobReclaimPolicy) {
	j := h.get("train-1")
	j.Status.Activity = &v1alpha1.AIJobActivity{Message: "idle for 31m0s (under 5% of its gpu), for team/next"}
	require.NoError(t, h.c.Status().Update(context.Background(), j))
	j = h.get("train-1")
	j.Annotations = map[string]string{v1alpha1.AIJobReclaimAnnotation: string(policy)}
	require.NoError(t, h.c.Update(context.Background(), j))
	h.reconcile("train-1")
}

func TestSuspendUninstallsTheIdleRunAndPutsItBackInTheQueue(t *testing.T) {
	h := placedRun(t)
	askReclaim(t, h, v1alpha1.AIJobReclaimSuspend)

	j := h.get("train-1")
	assert.Empty(t, h.helm.releases, "uninstalled from the pool's cluster")
	assert.Nil(t, j.Status.Placement, "back in the queue")
	assert.Equal(t, v1alpha1.AIJobPhasePending, j.Status.Phase)
	assert.NotContains(t, j.Annotations, v1alpha1.AIJobReclaimAnnotation, "the request is done")
	assert.Equal(t, metav1.ConditionTrue, condStatus(j, v1alpha1.AIJobConditionReclaimed))
	require.Len(t, j.Status.ReclaimHistory, 1)
	assert.Equal(t, v1alpha1.AIJobReclaimRecord{At: j.Status.ReclaimHistory[0].At, Pool: "c-abc-gpu-l40s", Policy: v1alpha1.AIJobReclaimSuspend,
		Reason: "idle for 31m0s (under 5% of its gpu), for team/next"}, j.Status.ReclaimHistory[0])
	assert.Nil(t, j.Status.Activity)

	h.reconcile("train-1")
	assert.Equal(t, "WaitingForPlacement", h.installedCondition("train-1").Reason, "waits for a pool, not reinstalled")
	assert.Len(t, h.helm.ensured, 1)

	// placed again: installed again
	j = h.get("train-1")
	j.Status.Placement = &v1alpha1.AIJobPlacement{Pool: "c-abc-gpu-l40s", ClusterID: downstream, Namespace: "team-a"}
	require.NoError(t, h.c.Status().Update(context.Background(), j))
	h.reconcile("train-1")
	assert.Len(t, h.helm.ensured, 2)
	assert.Equal(t, metav1.ConditionTrue, condStatus(h.get("train-1"), v1alpha1.AIJobConditionInstalled))
	assert.Equal(t, metav1.ConditionFalse, condStatus(h.get("train-1"), v1alpha1.AIJobConditionReclaimed), "resumed: it may contend for a pool again")
}

func TestTerminateEndsTheIdleRunReclaimed(t *testing.T) {
	h := placedRun(t)
	askReclaim(t, h, v1alpha1.AIJobReclaimTerminate)

	j := h.get("train-1")
	assert.Empty(t, h.helm.releases)
	assert.Equal(t, v1alpha1.AIJobPhaseReclaimed, j.Status.Phase)
	assert.True(t, j.Status.Phase.IsTerminal())
	assert.Equal(t, "Reclaimed", j.Status.Result.Reason)
	h.reconcile("train-1")
	assert.Len(t, h.helm.ensured, 1, "never installed again")
}

func TestARunSubmittedToAPoolIsNotReclaimed(t *testing.T) {
	h := newPoolHarness(t, aijob("train-1", inPool), l40sPool())
	h.reconcile("train-1")
	j := h.get("train-1")
	j.Annotations = map[string]string{v1alpha1.AIJobReclaimAnnotation: "Suspend"}
	require.NoError(t, h.c.Update(context.Background(), j))
	h.reconcile("train-1")

	j = h.get("train-1")
	assert.NotEmpty(t, h.helm.releases, "left installed: it has no queue to go back to")
	assert.NotNil(t, j.Status.Placement)
	assert.NotContains(t, j.Annotations, v1alpha1.AIJobReclaimAnnotation, "the request is dropped")
	assert.Empty(t, j.Status.ReclaimHistory)
}
