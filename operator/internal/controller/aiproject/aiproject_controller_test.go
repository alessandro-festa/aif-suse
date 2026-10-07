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

package aiproject

import (
	"context"
	"sort"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	corev1 "k8s.io/api/core/v1"
	rbacv1 "k8s.io/api/rbac/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	clientgoscheme "k8s.io/client-go/kubernetes/scheme"
	ctrl "sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"
)

func rancherProject(cluster, id, display string, ai bool) *unstructured.Unstructured {
	p := &unstructured.Unstructured{}
	p.SetGroupVersionKind(projectGVK)
	p.SetNamespace(cluster)
	p.SetName(id)
	if ai {
		p.SetLabels(map[string]string{AIProjectLabel: "true"})
	}
	_ = unstructured.SetNestedField(p.Object, display, "spec", "displayName")
	return p
}

func prtb(name, project, role, user, group string) *unstructured.Unstructured {
	b := &unstructured.Unstructured{}
	b.SetGroupVersionKind(prtbGVK)
	b.SetNamespace("c-abc-p-team")
	b.SetName(name)
	b.SetUID(types.UID("uid-" + name))
	b.Object["projectName"] = project
	b.Object["roleTemplateName"] = role
	if user != "" {
		b.Object["userName"] = user
	}
	if group != "" {
		b.Object["groupPrincipalName"] = group
	}
	return b
}

type harness struct {
	t *testing.T
	c ctrl.Client
	r *Reconciler
}

func newHarness(t *testing.T, objs ...ctrl.Object) *harness {
	s := runtime.NewScheme()
	require.NoError(t, clientgoscheme.AddToScheme(s))
	for _, gvk := range []struct{ g, k string }{{"management.cattle.io", "Project"}, {"management.cattle.io", "ProjectRoleTemplateBinding"}} {
		s.AddKnownTypeWithName(projectGVK.GroupVersion().WithKind(gvk.k), &unstructured.Unstructured{})
		s.AddKnownTypeWithName(projectGVK.GroupVersion().WithKind(gvk.k+"List"), &unstructured.UnstructuredList{})
	}
	c := fake.NewClientBuilder().WithScheme(s).WithObjects(objs...).Build()
	return &harness{t: t, c: c, r: &Reconciler{Client: c}}
}

func (h *harness) reconcile(cluster, id string) {
	h.t.Helper()
	_, err := h.r.Reconcile(context.Background(), reconcile.Request{NamespacedName: types.NamespacedName{Namespace: cluster, Name: id}})
	require.NoError(h.t, err)
}

// grants is "<role> <kind>:<name>" for every managed RoleBinding in the namespace.
func (h *harness) grants(ns string) []string {
	l := &rbacv1.RoleBindingList{}
	require.NoError(h.t, h.c.List(context.Background(), l, ctrl.InNamespace(ns)))
	var out []string
	for _, rb := range l.Items {
		for _, s := range rb.Subjects {
			out = append(out, rb.RoleRef.Name+" "+s.Kind+":"+s.Name)
		}
	}
	sort.Strings(out)
	return out
}

func (h *harness) namespace(name string) *corev1.Namespace {
	ns := &corev1.Namespace{}
	if err := h.c.Get(context.Background(), types.NamespacedName{Name: name}, ns); err != nil {
		return nil
	}
	return ns
}

func TestAnAIProjectGetsANamespaceAndItsMembersRoles(t *testing.T) {
	h := newHarness(t,
		rancherProject("c-abc", "p-team", "Team Vision", true),
		prtb("owner", "c-abc:p-team", "project-owner", "user-alice", ""),
		prtb("member", "c-abc:p-team", "project-member", "", "github_team://42"),
		prtb("viewer", "c-abc:p-team", "read-only", "user-carol", ""),
		prtb("custom", "c-abc:p-team", "my-custom-role", "user-dave", ""),
		prtb("elsewhere", "c-abc:p-other", "project-owner", "user-eve", ""),
	)
	h.reconcile("c-abc", "p-team")

	ns := h.namespace("aif-c-abc-p-team")
	require.NotNil(t, ns)
	assert.Equal(t, "c-abc", ns.Labels[ClusterLabel])
	assert.Equal(t, "p-team", ns.Labels[ProjectLabel])
	assert.Equal(t, "Team Vision", ns.Annotations["ai-factory.suse.com/project-display-name"])
	assert.Equal(t, []string{
		"aif-aijob-editor Group:github_team://42",
		"aif-aijob-editor User:user-alice",
		"aif-aijob-viewer User:user-carol",
	}, h.grants("aif-c-abc-p-team"), "owners and members submit, read-only views; other roles and projects grant nothing")
}

func TestMembershipChangesFollowRancher(t *testing.T) {
	member := prtb("member", "c-abc:p-team", "project-member", "user-bob", "")
	h := newHarness(t, rancherProject("c-abc", "p-team", "Team", true), prtb("owner", "c-abc:p-team", "project-owner", "user-alice", ""), member)
	h.reconcile("c-abc", "p-team")
	require.Len(t, h.grants("aif-c-abc-p-team"), 2)

	// Bob is demoted to read-only: the editor binding is replaced by a viewer one.
	cur := &unstructured.Unstructured{}
	cur.SetGroupVersionKind(prtbGVK)
	require.NoError(t, h.c.Get(context.Background(), types.NamespacedName{Namespace: member.GetNamespace(), Name: "member"}, cur))
	cur.Object["roleTemplateName"] = "read-only"
	require.NoError(t, h.c.Update(context.Background(), cur))
	h.reconcile("c-abc", "p-team")
	assert.Equal(t, []string{"aif-aijob-editor User:user-alice", "aif-aijob-viewer User:user-bob"}, h.grants("aif-c-abc-p-team"))

	// Bob leaves the project.
	require.NoError(t, h.c.Delete(context.Background(), cur))
	h.reconcile("c-abc", "p-team")
	assert.Equal(t, []string{"aif-aijob-editor User:user-alice"}, h.grants("aif-c-abc-p-team"))
}

func TestOnlyMarkedDownstreamProjectsGetANamespace(t *testing.T) {
	h := newHarness(t,
		rancherProject("c-abc", "p-default", "Default", false),
		rancherProject("local", "p-ops", "Ops", true),
	)
	h.reconcile("c-abc", "p-default")
	h.reconcile("local", "p-ops")
	assert.Nil(t, h.namespace("aif-c-abc-p-default"), "not an AI project")
	assert.Nil(t, h.namespace("aif-local-p-ops"), "Rancher's local cluster runs no AI work")
}

func TestUnmarkingKeepsTheNamespaceButDeletingTheProjectRemovesIt(t *testing.T) {
	p := rancherProject("c-abc", "p-team", "Team", true)
	h := newHarness(t, p)
	h.reconcile("c-abc", "p-team")
	require.NotNil(t, h.namespace("aif-c-abc-p-team"))

	cur := &unstructured.Unstructured{}
	cur.SetGroupVersionKind(projectGVK)
	require.NoError(t, h.c.Get(context.Background(), types.NamespacedName{Namespace: "c-abc", Name: "p-team"}, cur))
	cur.SetLabels(nil)
	require.NoError(t, h.c.Update(context.Background(), cur))
	h.reconcile("c-abc", "p-team")
	assert.NotNil(t, h.namespace("aif-c-abc-p-team"), "unmarking must not delete the project's jobs")

	require.NoError(t, h.c.Delete(context.Background(), cur))
	h.reconcile("c-abc", "p-team")
	assert.Nil(t, h.namespace("aif-c-abc-p-team"), "the project is gone, so is its namespace")
}

func TestANamespaceOfTheSameNameNotOursIsNotDeleted(t *testing.T) {
	foreign := &corev1.Namespace{}
	foreign.Name = "aif-c-abc-p-team"
	h := newHarness(t, foreign)
	h.reconcile("c-abc", "p-team") // no such project
	assert.NotNil(t, h.namespace("aif-c-abc-p-team"))
}

func (h *harness) poolViewers() []string {
	crb := &rbacv1.ClusterRoleBinding{}
	if err := h.c.Get(context.Background(), types.NamespacedName{Name: PoolViewers}, crb); err != nil {
		return nil
	}
	require.Equal(h.t, PoolViewerRole, crb.RoleRef.Name)
	var out []string
	for _, s := range crb.Subjects {
		out = append(out, s.Kind+":"+s.Name)
	}
	return out
}

func TestEveryAIProjectMemberCanReadComputePools(t *testing.T) {
	h := newHarness(t,
		rancherProject("c-abc", "p-team", "Team", true),
		rancherProject("c-xyz", "p-lab", "Lab", true),
		rancherProject("c-abc", "p-default", "Default", false),
		prtb("a", "c-abc:p-team", "project-owner", "user-alice", ""),
		prtb("b", "c-xyz:p-lab", "read-only", "user-bob", ""),
		prtb("b2", "c-abc:p-team", "project-member", "user-bob", ""), // in two projects: listed once
		prtb("c", "c-abc:p-default", "project-owner", "user-carol", ""),
		prtb("d", "c-abc:p-team", "my-custom-role", "user-dave", ""),
	)
	h.reconcile("c-abc", "p-team")
	assert.Equal(t, []string{"User:user-alice", "User:user-bob"}, h.poolViewers(),
		"members of AI projects only, each once; another project's owner and a custom role are not")

	// Team stops being an AI project: Alice leaves the list, Bob stays through Lab.
	cur := &unstructured.Unstructured{}
	cur.SetGroupVersionKind(projectGVK)
	require.NoError(t, h.c.Get(context.Background(), types.NamespacedName{Namespace: "c-abc", Name: "p-team"}, cur))
	cur.SetLabels(nil)
	require.NoError(t, h.c.Update(context.Background(), cur))
	h.reconcile("c-abc", "p-team")
	assert.Equal(t, []string{"User:user-bob"}, h.poolViewers(), "Team is no longer an AI project; Bob reads pools through Lab")
}
