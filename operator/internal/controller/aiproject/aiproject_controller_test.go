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
	"errors"
	"sort"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	corev1 "k8s.io/api/core/v1"
	rbacv1 "k8s.io/api/rbac/v1"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	clientgoscheme "k8s.io/client-go/kubernetes/scheme"
	ctrl "sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"

	"github.com/SUSE/aif-operator/api/v1alpha1"
)

func scheme(t *testing.T) *runtime.Scheme {
	s := runtime.NewScheme()
	require.NoError(t, clientgoscheme.AddToScheme(s))
	require.NoError(t, v1alpha1.AddToScheme(s))
	for _, k := range []string{"Project", "ProjectRoleTemplateBinding"} {
		s.AddKnownTypeWithName(projectGVK.GroupVersion().WithKind(k), &unstructured.Unstructured{})
		s.AddKnownTypeWithName(projectGVK.GroupVersion().WithKind(k+"List"), &unstructured.UnstructuredList{})
	}
	return s
}

// fakeRancher is Rancher's management API and the downstream clusters.
type fakeRancher struct {
	mgmt     ctrl.Client
	clusters map[string]ctrl.Client
	down     error
}

func (f *fakeRancher) Management(context.Context) (ctrl.Client, error) { return f.mgmt, nil }
func (f *fakeRancher) Cluster(_ context.Context, id string) (ctrl.Client, error) {
	if f.down != nil {
		return nil, f.down
	}
	return f.clusters[id], nil
}

type harness struct {
	t       *testing.T
	local   ctrl.Client
	rancher *fakeRancher
	r       *Reconciler
}

func newHarness(t *testing.T, objs ...ctrl.Object) *harness {
	s := scheme(t)
	local := fake.NewClientBuilder().WithScheme(s).WithStatusSubresource(&v1alpha1.AIProject{}).WithObjects(objs...).Build()
	fr := &fakeRancher{
		mgmt: fake.NewClientBuilder().WithScheme(s).Build(),
		clusters: map[string]ctrl.Client{
			"c-abc": fake.NewClientBuilder().WithScheme(s).Build(),
			"c-xyz": fake.NewClientBuilder().WithScheme(s).Build(),
		},
	}
	return &harness{t: t, local: local, rancher: fr, r: &Reconciler{Client: local, Rancher: fr}}
}

func (h *harness) reconcile(name string) reconcile.Result {
	h.t.Helper()
	res, err := h.r.Reconcile(context.Background(), reconcile.Request{NamespacedName: types.NamespacedName{Name: name}})
	require.NoError(h.t, err)
	return res
}

func user(n string) v1alpha1.AIProjectSubject {
	return v1alpha1.AIProjectSubject{Kind: "User", Name: n}
}

func team(mutate ...func(*v1alpha1.AIProject)) *v1alpha1.AIProject {
	p := &v1alpha1.AIProject{
		ObjectMeta: metav1.ObjectMeta{Name: "team", UID: "uid-team"},
		Spec: v1alpha1.AIProjectSpec{
			DisplayName: "Team Vision",
			Clusters:    []v1alpha1.AIProjectCluster{{ClusterID: "c-abc", Namespace: "team-a"}, {ClusterID: "c-xyz", Namespace: "team-x"}},
			Owners:      []v1alpha1.AIProjectSubject{user("user-alice")},
		},
	}
	for _, m := range mutate {
		m(p)
	}
	return p
}

func (h *harness) project(name string) *v1alpha1.AIProject {
	p := &v1alpha1.AIProject{}
	require.NoError(h.t, h.local.Get(context.Background(), types.NamespacedName{Name: name}, p))
	return p
}

// grants is "<role> <kind>:<name>" for the RoleBindings in a namespace on local.
func (h *harness) grants(ns string) []string {
	l := &rbacv1.RoleBindingList{}
	require.NoError(h.t, h.local.List(context.Background(), l, ctrl.InNamespace(ns)))
	var out []string
	for _, rb := range l.Items {
		out = append(out, rb.RoleRef.Name+" "+rb.Subjects[0].Kind+":"+rb.Subjects[0].Name)
	}
	sort.Strings(out)
	return out
}

// prtbs is "<rancher role> <user or group>" for a Rancher project's role bindings.
func (h *harness) prtbs(clusterID, projectID string) []string {
	l := &unstructured.UnstructuredList{}
	l.SetGroupVersionKind(prtbGVK.GroupVersion().WithKind("ProjectRoleTemplateBindingList"))
	require.NoError(h.t, h.rancher.mgmt.List(context.Background(), l, ctrl.InNamespace(clusterID+"-"+projectID)))
	var out []string
	for _, b := range l.Items {
		who, _, _ := unstructured.NestedString(b.Object, "userName")
		if who == "" {
			who, _, _ = unstructured.NestedString(b.Object, "groupPrincipalName")
		}
		role, _, _ := unstructured.NestedString(b.Object, "roleTemplateName")
		pn, _, _ := unstructured.NestedString(b.Object, "projectName")
		require.Equal(h.t, clusterID+":"+projectID, pn)
		out = append(out, role+" "+who)
	}
	sort.Strings(out)
	return out
}

func (h *harness) setMembers(members ...v1alpha1.AIProjectMember) {
	m := &v1alpha1.AIProjectMembers{}
	require.NoError(h.t, h.local.Get(context.Background(), types.NamespacedName{Namespace: "aif-team", Name: MembersName}, m))
	m.Spec.Members = members
	require.NoError(h.t, h.local.Update(context.Background(), m))
}

func member(n string, role v1alpha1.AIProjectRole) v1alpha1.AIProjectMember {
	return v1alpha1.AIProjectMember{AIProjectSubject: user(n), Role: role}
}

func TestAnAIProjectIsPutInPlaceOnLocalAndOnEveryClusterItSpans(t *testing.T) {
	h := newHarness(t, team())
	assert.Equal(t, reconcile.Result{}, h.reconcile("team"))

	ns := &corev1.Namespace{}
	require.NoError(t, h.local.Get(context.Background(), types.NamespacedName{Name: "aif-team"}, ns))
	assert.Equal(t, "team", ns.Labels[ProjectLabel])
	require.Len(t, ns.OwnerReferences, 1, "owned by the project: it goes with it")
	assert.NoError(t, h.local.Get(context.Background(), types.NamespacedName{Namespace: "aif-team", Name: MembersName}, &v1alpha1.AIProjectMembers{}),
		"an empty members object for the owners to edit")
	assert.Equal(t, []string{"aif-aijob-editor User:user-alice", "aif-aiproject-members-editor User:user-alice"}, h.grants("aif-team"))

	p := h.project("team")
	assert.Equal(t, "aif-team", p.Status.Namespace)
	assert.True(t, meta.IsStatusConditionTrue(p.Status.Conditions, conditionReady))
	require.Len(t, p.Status.Clusters, 2)
	for _, cs := range p.Status.Clusters {
		assert.True(t, cs.Ready, cs.Message)
		require.NotEmpty(t, cs.ProjectID, "a Rancher project was made")
		down := &corev1.Namespace{}
		require.NoError(t, h.rancher.clusters[cs.ClusterID].Get(context.Background(), types.NamespacedName{Name: cs.Namespace}, down))
		assert.Equal(t, cs.ClusterID+":"+cs.ProjectID, down.Annotations[rancherProjectAnnotation], "the namespace is in that Rancher project")
		assert.Equal(t, []string{"project-owner user-alice"}, h.prtbs(cs.ClusterID, cs.ProjectID))
	}

	// A second reconcile finds the same Rancher projects instead of making new ones.
	first := p.Status.Clusters[0].ProjectID
	h.reconcile("team")
	assert.Equal(t, first, h.project("team").Status.Clusters[0].ProjectID)
	l := &unstructured.UnstructuredList{}
	l.SetGroupVersionKind(projectGVK.GroupVersion().WithKind("ProjectList"))
	require.NoError(t, h.rancher.mgmt.List(context.Background(), l, ctrl.InNamespace("c-abc")))
	assert.Len(t, l.Items, 1)
}

func TestOwnersMembersAndRolesFollowTheMembersObject(t *testing.T) {
	h := newHarness(t, team())
	h.reconcile("team")
	h.setMembers(member("user-bob", v1alpha1.AIProjectRoleMember), member("user-carol", v1alpha1.AIProjectRoleReadOnly),
		member("user-alice", v1alpha1.AIProjectRoleReadOnly)) // an owner stays an owner
	h.reconcile("team")

	assert.Equal(t, []string{
		"aif-aijob-editor User:user-alice", "aif-aijob-editor User:user-bob",
		"aif-aijob-viewer User:user-carol", "aif-aiproject-members-editor User:user-alice",
	}, h.grants("aif-team"))
	cs := h.project("team").Status.Clusters[1]
	assert.Equal(t, []string{"project-member user-bob", "project-owner user-alice", "read-only user-carol"}, h.prtbs(cs.ClusterID, cs.ProjectID))

	// Bob leaves; Carol becomes a member.
	h.setMembers(member("user-carol", v1alpha1.AIProjectRoleMember))
	h.reconcile("team")
	assert.Equal(t, []string{"project-member user-carol", "project-owner user-alice"}, h.prtbs(cs.ClusterID, cs.ProjectID))
	assert.Equal(t, []string{"aif-aijob-editor User:user-alice", "aif-aijob-editor User:user-carol", "aif-aiproject-members-editor User:user-alice"}, h.grants("aif-team"))
}

func TestAnExistingRancherProjectIsAdoptedAndAnotherProjectsNamespaceIsNotTaken(t *testing.T) {
	h := newHarness(t, team(func(p *v1alpha1.AIProject) {
		p.Spec.Clusters = []v1alpha1.AIProjectCluster{{ClusterID: "c-abc", Namespace: "team-a", ProjectID: "p-exist"}, {ClusterID: "c-xyz", Namespace: "shared"}}
	}))
	existing := &unstructured.Unstructured{}
	existing.SetGroupVersionKind(projectGVK)
	existing.SetNamespace("c-abc")
	existing.SetName("p-exist")
	require.NoError(t, h.rancher.mgmt.Create(context.Background(), existing))
	taken := &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: "shared", Annotations: map[string]string{rancherProjectAnnotation: "c-xyz:p-other"}}}
	require.NoError(t, h.rancher.clusters["c-xyz"].Create(context.Background(), taken))

	res := h.reconcile("team")
	p := h.project("team")
	assert.Equal(t, "p-exist", p.Status.Clusters[0].ProjectID, "adopted, not created")
	assert.True(t, p.Status.Clusters[0].Ready)
	assert.False(t, p.Status.Clusters[1].Ready)
	assert.Contains(t, p.Status.Clusters[1].Message, "is in Rancher project c-xyz:p-other")
	assert.False(t, meta.IsStatusConditionTrue(p.Status.Conditions, conditionReady))
	assert.Equal(t, retryAfter, res.RequeueAfter, "tried again later")
	got := &corev1.Namespace{}
	require.NoError(t, h.rancher.clusters["c-xyz"].Get(context.Background(), types.NamespacedName{Name: "shared"}, got))
	assert.Equal(t, "c-xyz:p-other", got.Annotations[rancherProjectAnnotation], "left where it was")
}

func TestAClusterThatCannotBeReachedIsReportedAndRetried(t *testing.T) {
	h := newHarness(t, team())
	h.rancher.down = errors.New("no route")
	res := h.reconcile("team")
	assert.Equal(t, retryAfter, res.RequeueAfter)
	for _, cs := range h.project("team").Status.Clusters {
		assert.False(t, cs.Ready)
		assert.Contains(t, cs.Message, "cannot reach cluster")
	}
	assert.NotEmpty(t, h.grants("aif-team"), "the namespace on local does not wait for the clusters")
}

func TestEveryMemberOfEveryProjectCanReadComputePools(t *testing.T) {
	other := team(func(p *v1alpha1.AIProject) {
		p.Name, p.UID = "lab", "uid-lab"
		p.Spec.Owners = []v1alpha1.AIProjectSubject{user("user-bob"), {Kind: "Group", Name: "github_team://42"}}
	})
	h := newHarness(t, team(), other)
	h.reconcile("team")
	h.reconcile("lab")
	h.setMembers(member("user-bob", v1alpha1.AIProjectRoleReadOnly)) // in both: listed once
	h.reconcile("team")

	subjects := func() []string {
		crb := &rbacv1.ClusterRoleBinding{}
		require.NoError(t, h.local.Get(context.Background(), types.NamespacedName{Name: PoolViewers}, crb))
		require.Equal(t, PoolViewerRole, crb.RoleRef.Name)
		var got []string
		for _, s := range crb.Subjects {
			got = append(got, s.Kind+":"+s.Name)
		}
		return got
	}
	assert.Equal(t, []string{"Group:github_team://42", "User:user-alice", "User:user-bob"}, subjects())

	// The lab project goes: its owners' access to pools goes with it, unless they are elsewhere.
	require.NoError(t, h.local.Delete(context.Background(), other))
	h.reconcile("lab")
	assert.Equal(t, []string{"User:user-alice", "User:user-bob"}, subjects(), "Bob is still in Team")
}

// Rancher refuses a second binding of the same role to the same user in a project, and gives the
// creator of a project its owner role itself.
func TestARoleSomeoneElseAlreadyGaveIsNotDuplicated(t *testing.T) {
	h := newHarness(t, team(func(p *v1alpha1.AIProject) {
		p.Spec.Clusters = []v1alpha1.AIProjectCluster{{ClusterID: "c-abc", Namespace: "team-a", ProjectID: "p-exist"}}
	}))
	existing := &unstructured.Unstructured{}
	existing.SetGroupVersionKind(projectGVK)
	existing.SetNamespace("c-abc")
	existing.SetName("p-exist")
	require.NoError(t, h.rancher.mgmt.Create(context.Background(), existing))
	creator := &unstructured.Unstructured{}
	creator.SetGroupVersionKind(prtbGVK)
	creator.SetNamespace("c-abc-p-exist")
	creator.SetName("creator-project-owner")
	creator.Object["projectName"] = "c-abc:p-exist"
	creator.Object["roleTemplateName"] = "project-owner"
	creator.Object["userName"] = "user-alice"
	require.NoError(t, h.rancher.mgmt.Create(context.Background(), creator))

	h.reconcile("team")
	assert.True(t, h.project("team").Status.Clusters[0].Ready)
	assert.Equal(t, []string{"project-owner user-alice"}, h.prtbs("c-abc", "p-exist"), "the creator's binding stands; no duplicate")

	// Bob joins: his binding is the operator's, and only that one is managed.
	h.setMembers(member("user-bob", v1alpha1.AIProjectRoleMember))
	h.reconcile("team")
	assert.Equal(t, []string{"project-member user-bob", "project-owner user-alice"}, h.prtbs("c-abc", "p-exist"))
	h.setMembers()
	h.reconcile("team")
	assert.Equal(t, []string{"project-owner user-alice"}, h.prtbs("c-abc", "p-exist"), "Bob's goes; the creator's is not the operator's to remove")
}
